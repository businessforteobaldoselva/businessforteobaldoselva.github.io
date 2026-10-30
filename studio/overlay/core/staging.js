/* COVERED Studio overlay - core/staging.js
   Staged edits, kept in the browser until Save.

   Model. The unit of truth is a LOG of what the person did (set / move / remove). Every entry names its
   target by the ref the page markers carry, i.e. in BASE coordinates (list indexes as they were when the
   page was built), so a headline edit stays attached to its element even after the sections around it were
   reordered. The "working" documents are the base documents with the log replayed on top (items of lists are
   tagged with their original index, so a reordered list can be compared with the base). Undo/redo/discard just
   change the log and replay; the patch is the DIFF of base and working (patch-builder.js), so editing a value
   back to what it was leaves nothing to send.

   Persistence: the log in localStorage under covered.studio.v1:<apiHost>:<userId>:<draftKey>, picture bytes
   in IndexedDB (best effort). Every storage access is try/catch; nothing depends on it.
   Pure logic: runs under node (the tests pass stand-ins for storage and image processing). */
(function (S) {
  "use strict";
  var U = S.util;
  var TAG = S.TAG;

  function create(opts) {
    opts = opts || {};
    var sc = opts.schemaClient;
    var limits = (sc && sc.limits) || { string: 20000, markdown: 60000, listItems: 200 };
    var emit = opts.emit || function () {};
    var base = {}; // fileKey -> plain data as the page was built (what the DOM shows)
    var head = {}; // fileKey -> tagged data the server holds for this draft (= base until the first save)
    var working = {}; // fileKey -> tagged clone with the log applied
    var log = [];
    var redoStack = [];
    var uploads = new Map(); // id -> { id, name, contentType, size, blob, url }
    var storeKey = opts.storeKey || null;
    var groupCounter = 0;
    var saveTimer = null;
    var dropped = [];

    Object.keys(opts.files || {}).forEach(function (k) {
      base[k] = U.plain(opts.files[k].data);
      working[k] = U.cloneTagged(base[k]);
      head[k] = U.cloneTagged(base[k]);
    });
    var paths = {};
    Object.keys(opts.files || {}).forEach(function (k) { paths[k] = opts.files[k].path || U.filePathOf(k); });

    // ---------------------------------------------------------------- walking in base coordinates
    // -> { parent, key, value, found } where `key` is the real key/index inside `parent` of the working doc.
    function walk(file, segs) {
      var cur = working[file];
      var parent = null;
      var key = null;
      if (cur === undefined) return { found: false };
      for (var i = 0; i < segs.length; i += 1) {
        var seg = segs[i];
        var next;
        if (Array.isArray(cur)) {
          var idx = -1;
          var n = Number(seg);
          if (!/^\d+$/.test(seg)) return { found: false };
          for (var j = 0; j < cur.length; j += 1) {
            if (cur[j] !== null && typeof cur[j] === "object" && cur[j][TAG] === n) { idx = j; break; }
          }
          if (idx < 0 && n < cur.length && (cur[n] === null || typeof cur[n] !== "object")) idx = n;
          if (idx < 0) return { found: false };
          parent = cur; key = idx; next = cur[idx];
        } else if (cur !== null && typeof cur === "object") {
          parent = cur; key = seg; next = cur[seg];
          if (next === undefined && i < segs.length - 1) return { found: false };
        } else return { found: false };
        cur = next;
      }
      return { found: cur !== undefined, parent: parent, key: key, value: cur };
    }
    function baseAt(file, segs) {
      var cur = base[file];
      for (var i = 0; i < segs.length; i += 1) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = cur[segs[i]];
      }
      return cur;
    }
    function refParts(ref) {
      var p = U.parseRef(ref);
      return p && working[p.file] !== undefined ? p : null;
    }

    function apply(entry) {
      var p = refParts(entry.ref);
      if (!p) return false;
      if (entry.t === "set") {
        var w = walk(p.file, p.segs);
        if (w.parent && (w.found || !Array.isArray(w.parent))) {
          w.parent[w.key] = U.cloneTagged(entry.value);
          return true;
        }
        return false;
      }
      if (entry.t === "move") {
        var l = walk(p.file, p.segs);
        if (!l.found || !Array.isArray(l.value)) return false;
        var n = l.value.length;
        if (entry.from < 0 || entry.to < 0 || entry.from >= n || entry.to >= n) return false;
        var it = l.value.splice(entry.from, 1)[0];
        l.value.splice(entry.to, 0, it);
        return true;
      }
      if (entry.t === "remove") {
        var r = walk(p.file, p.segs);
        if (!r.found || !Array.isArray(r.parent)) return false;
        r.parent.splice(r.key, 1);
        return true;
      }
      return false;
    }
    function replay() {
      Object.keys(base).forEach(function (k) { working[k] = U.cloneTagged(base[k]); });
      log.forEach(function (e) { e.failed = !apply(e); });
    }

    function get(ref) {
      var p = refParts(ref);
      if (!p) return undefined;
      var w = walk(p.file, p.segs);
      return w.found ? w.value : undefined;
    }
    function getBase(ref) {
      var p = U.parseRef(ref);
      return p ? baseAt(p.file, p.segs) : undefined;
    }

    // ---------------------------------------------------------------- persistence
    function persistSoon() {
      if (!storeKey || !opts.storage) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persistNow, 250);
    }
    function ops0() { return log.filter(function (e) { return !e.saved; }); }
    // Did the browser actually keep the edits? (private windows and full or blocked storage say no, silently.)
    var keepFailed = false;
    function setKept(ok) {
      if (ok === !keepFailed) return;
      keepFailed = !ok;
      emit("storage:state", { kept: ok });
    }
    function persistNow() {
      if (!storeKey || !opts.storage) return;
      if (!ops0().length) { opts.storage.del(storeKey); setKept(true); return; }
      var ops = log.filter(function (e) { return !e.saved; }).map(function (e) { return U.plain(Object.assign({}, e, { failed: undefined })); });
      setKept(opts.storage.set(storeKey, JSON.stringify({ v: 1, t: Date.now(), ops: ops })) !== false);
    }
    function idb() {
      return new Promise(function (resolve) {
        try {
          var rq = indexedDB.open("covered-studio", 1);
          rq.addEventListener("upgradeneeded", function () { rq.result.createObjectStore("blobs"); });
          rq.addEventListener("success", function () { resolve(rq.result); });
          rq.addEventListener("error", function () { resolve(null); });
        } catch (e) { resolve(null); }
      });
    }
    function idbPut(id, blob) {
      if (!storeKey || typeof indexedDB === "undefined") return Promise.resolve();
      return idb().then(function (db) {
        if (!db) return;
        return new Promise(function (res) {
          try { var tx = db.transaction("blobs", "readwrite"); tx.objectStore("blobs").put(blob, storeKey + ":" + id); tx.addEventListener("complete", res); tx.addEventListener("error", res); tx.addEventListener("abort", res); } catch (e) { res(); }
        });
      });
    }
    function idbGet(id) {
      if (!storeKey || typeof indexedDB === "undefined") return Promise.resolve(null);
      return idb().then(function (db) {
        if (!db) return null;
        return new Promise(function (res) {
          try { var rq = db.transaction("blobs").objectStore("blobs").get(storeKey + ":" + id); rq.addEventListener("success", function () { res(rq.result || null); }); rq.addEventListener("error", function () { res(null); }); } catch (e) { res(null); }
        });
      });
    }

    // Reads the saved log, reconciles with the (possibly newer) base. Resolves with { restored, dropped, stale }.
    function load() {
      var raw = storeKey && opts.storage ? opts.storage.get(storeKey) : null;
      var saved = null;
      try { saved = raw ? JSON.parse(raw) : null; } catch (e) { saved = null; }
      if (!saved || saved.v !== 1 || !Array.isArray(saved.ops)) return Promise.resolve({ restored: 0, dropped: [], stale: 0 });
      var ops = saved.ops.filter(function (e) { return e && (e.t === "set" || e.t === "move" || e.t === "remove") && U.parseRef(e.ref); });
      var needBlobs = ops.filter(function (e) { return e.upload && e.upload.id; });
      return Promise.all(needBlobs.map(function (e) {
        return idbGet(e.upload.id).then(function (blob) { return { e: e, blob: blob }; });
      })).then(function (res) {
        var lost = {};
        res.forEach(function (r) {
          if (r.blob) registerUpload(r.e.upload, r.blob);
          else lost[r.e.g || r.e.upload.id] = true;
        });
        dropped = [];
        log = ops.filter(function (e) {
          var gone = (e.g && lost[e.g]) || (e.upload && lost[e.upload.id]);
          if (gone) dropped.push(e);
          return !gone;
        });
        log.forEach(function (e) {
          if (e.g && e.g > groupCounter) groupCounter = e.g;
          if (e.t === "set") e.stale = !U.deepEqual(e.was, getBase(e.ref));
        });
        replay();
        emit("staged:change", { count: count() });
        return { restored: log.length, dropped: dropped, stale: log.filter(function (e) { return e.stale; }).length };
      });
    }

    function registerUpload(meta, blob) {
      var url = null;
      try { url = URL.createObjectURL(blob); } catch (e) { url = null; }
      uploads.set(meta.id, { id: meta.id, name: meta.name, contentType: meta.contentType, size: meta.size, blob: blob, url: url });
    }

    // ---------------------------------------------------------------- mutations
    function changed() {
      redoStack = [];
      persistSoon();
      emit("staged:change", { count: count() });
    }
    function push(entry) {
      if (!apply(entry)) return false;
      log.push(entry);
      return true;
    }
    function tooBig(value) {
      return typeof value === "string" && value.length > Math.max(limits.string, limits.markdown) * 2;
    }

    function set(ref, value, meta) {
      var p = refParts(ref);
      if (!p) return { ok: false, message: "That part of the site can't be edited here." };
      if (tooBig(value)) return { ok: false, message: "That is far too long to keep. Shorten it first." };
      var cur = get(ref);
      if (U.deepEqual(cur, value)) return { ok: true, noop: true };
      meta = meta || {};
      var last = log[log.length - 1];
      if (last && last.t === "set" && last.ref === ref && !last.upload && !meta.group && !last.g && !last.saved) {
        // typing in the same field: one undo step
        last.value = U.plain(value);
        replay();
      } else if (!push({ t: "set", ref: ref, value: U.plain(value), was: U.plain(getBase(ref)), g: meta.group || undefined, upload: meta.upload || undefined })) {
        return { ok: false, message: "That part of the page has changed and can't be edited any more. Reload the page." };
      }
      changed();
      return { ok: true };
    }
    function toggle(ref) {
      return set(ref, get(ref) === false ? true : !get(ref));
    }
    function move(listRef, from, to) {
      var v = get(listRef);
      if (!Array.isArray(v) || from === to) return { ok: false, message: "Nothing to move." };
      if (from < 0 || to < 0 || from >= v.length || to >= v.length) return { ok: false, message: "It can't go further that way." };
      if (!push({ t: "move", ref: listRef, from: from, to: to })) return { ok: false, message: "That can't be moved." };
      changed();
      return { ok: true };
    }
    function remove(itemRef) {
      var p = refParts(itemRef);
      var w = p ? walk(p.file, p.segs) : null;
      if (!w || !w.found || !Array.isArray(w.parent)) return { ok: false, message: "That can't be removed." };
      if (!push({ t: "remove", ref: itemRef })) return { ok: false, message: "That can't be removed." };
      changed();
      return { ok: true };
    }
    function add() {
      return { ok: false, message: "Adding new items is not available in Studio yet. Use the full editor for that." };
    }

    // blobOrFile -> staged picture. meta: { alt, altRef, decorative, decorativeRef, processed, aspect }
    function setImage(ref, input, meta) {
      meta = meta || {};
      var field = null;
      var p = refParts(ref);
      if (p && sc) { var r = sc.resolve(p.file, p.segs, working[p.file]); field = r && r.field; }
      var prep = meta.processed ? Promise.resolve({ blob: input, name: meta.name, contentType: input.type || "image/jpeg", size: input.size }) : opts.processImage(input, { aspect: meta.aspect });
      return prep.then(function (img) {
        var id = U.uuid();
        var name = img.name || id.slice(0, 8) + ".jpg";
        var up = { id: id, name: name, contentType: img.contentType, size: img.size };
        registerUpload(up, img.blob);
        idbPut(id, img.blob);
        var style = sc ? sc.imageStyle(field) : "bare-name";
        var value = style === "public-path" ? "/images/" + name : name;
        var g = ++groupCounter;
        var res = set(ref, value, { upload: up, group: g });
        if (!res.ok) throw new Error(res.message);
        if (meta.decorativeRef) set(meta.decorativeRef, !!meta.decorative, { group: g });
        if (meta.altRef && typeof meta.alt === "string") set(meta.altRef, meta.decorative ? "" : meta.alt, { group: g });
        persistSoon();
        emit("staged:change", { count: count() });
      });
    }
    function uploadFor(value) {
      var out = null;
      uploads.forEach(function (u) {
        if (typeof value === "string" && (value === u.name || value === "/images/" + u.name)) out = u;
      });
      return out;
    }

    // ---------------------------------------------------------------- undo / redo / discard / clear
    function popGroup() {
      var last = log[log.length - 1];
      if (!last || last.saved) return [];
      var out = [log.pop()];
      if (last.g) while (log.length && log[log.length - 1].g === last.g && !log[log.length - 1].saved) out.unshift(log.pop());
      return out;
    }
    function undo() {
      var g = popGroup();
      if (!g.length) return false;
      redoStack.push(g);
      replay(); persistSoon();
      emit("staged:change", { count: count() });
      return true;
    }
    function redo() {
      var g = redoStack.pop();
      if (!g) return false;
      g.forEach(function (e) { log.push(e); });
      replay(); persistSoon();
      emit("staged:change", { count: count() });
      return true;
    }
    // Drops every staged entry that touches this ref (a leaf) or this list (moves/removes inside it).
    function discard(ref) {
      var before = log.length;
      var groups = {};
      log.forEach(function (e) { if (e.ref === ref && e.g && !e.saved) groups[e.g] = true; });
      log = log.filter(function (e) { return e.saved || !(e.ref === ref || (e.g && groups[e.g]) || e.ref.indexOf(ref + ".") === 0); });
      if (log.length === before) return false;
      redoStack = [];
      replay(); persistSoon();
      emit("staged:change", { count: count() });
      return true;
    }
    // Throws away everything not saved to the draft yet.
    function clear() {
      log = log.filter(function (e) { return e.saved; });
      redoStack = [];
      if (!log.length) {
        uploads.forEach(function (u) { try { if (u.url) URL.revokeObjectURL(u.url); } catch (e) { /* ignore */ } });
        uploads = new Map();
      }
      replay();
      if (storeKey && opts.storage) opts.storage.del(storeKey);
      emit("staged:change", { count: 0 });
    }

    // ---------------------------------------------------------------- views
    var builder = function () { return S.patchBuilder; };
    function diff() { return builder().diffFiles(head, working, paths); }
    function list() {
      return builder().describeChanges(diff(), { base: head, working: working, paths: paths, sc: sc, uploadFor: uploadFor, problemsFor: problems });
    }
    function count() { return log.length ? diff().length : 0; }
    function problems() {
      var out = [];
      if (!sc) return out;
      diff().forEach(function (op) {
        if (op.op === "move" || op.op === "remove") return;
        var segs = U.segsOfPointer(op.path);
        var file = U.fileKeyOfPath(op.file);
        var r = file ? sc.resolve(file, segs, base[file]) : null;
        if (!r) return;
        var msgs = S.validateClient.validate(r.field, op.value, { limits: limits, reservedIds: (sc.raw && sc.raw.reservedIds) || [] });
        if (msgs.length) out.push({ ref: U.formatRef(file, segs), messages: msgs.map(function (m) { return m.message; }), codes: msgs.map(function (m) { return m.code; }) });
      });
      return out;
    }
    function orderOf(listRef) {
      var v = get(listRef);
      if (!Array.isArray(v)) return [];
      return v.map(function (item, i) { return { index: i, tag: item !== null && typeof item === "object" && item[TAG] !== undefined ? item[TAG] : i, value: item }; });
    }
    // true if the value at this base ref differs from the base (for DOM sync)
    function isDirty(ref) {
      var p = U.parseRef(ref);
      if (!p) return false;
      return !U.deepEqual(get(ref), baseAt(p.file, p.segs));
    }
    function removedItem(itemRef) {
      var p = refParts(itemRef);
      if (!p) return false;
      return !walk(p.file, p.segs).found;
    }


    // ---------------------------------------------------------------- after a save / conflicts
    function cloneKeepTags(v) {
      if (Array.isArray(v)) {
        return v.map(function (x) {
          var c = cloneKeepTags(x);
          if (x !== null && typeof x === "object" && x[TAG] !== undefined) Object.defineProperty(c, TAG, { value: x[TAG], enumerable: false, writable: true, configurable: true });
          return c;
        });
      }
      if (v !== null && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = cloneKeepTags(v[k]); }); return o; }
      return v;
    }
    // The draft now holds what is on screen: the server's copy becomes the diff reference.
    function markSaved() {
      Object.keys(working).forEach(function (k) { head[k] = cloneKeepTags(working[k]); });
      log.forEach(function (e) { e.saved = true; });
      redoStack = [];
      persistNow();
      emit("staged:change", { count: 0 });
    }
    // A pointer into the head (before the patch) or into the working copy (what the server validated) -> a page-coordinate ref.
    function refFromPointer(fileKey, pointer, which) {
      var cur = (which === "working" ? working : head)[fileKey];
      var segs = U.segsOfPointer(pointer);
      var out = [];
      for (var i = 0; i < segs.length; i += 1) {
        if (cur === undefined || cur === null) { out.push(segs[i]); continue; }
        if (Array.isArray(cur)) {
          var item = cur[Number(segs[i])];
          out.push(item !== null && typeof item === "object" && item[TAG] !== undefined ? String(item[TAG]) : segs[i]);
          cur = item;
        } else { out.push(segs[i]); cur = cur[segs[i]]; }
      }
      return out.length ? U.formatRef(fileKey, out) : null;
    }
    // Someone else changed this value in the draft: treat their value as the starting point from now on.
    function adoptRemote(fileKey, pointer, actual) {
      var segs = U.segsOfPointer(pointer);
      var cur = head[fileKey];
      for (var i = 0; i < segs.length - 1; i += 1) { if (cur === undefined || cur === null) return false; cur = cur[segs[i]]; }
      if (cur === undefined || cur === null || !segs.length) return false;
      cur[segs[segs.length - 1]] = U.cloneTagged(actual);
      return true;
    }

    return {
      set: set, toggle: toggle, move: move, add: add, remove: remove, setImage: setImage,
      list: list, count: count, discard: discard, clear: clear, undo: undo, redo: redo,
      canUndo: function () { var l = log[log.length - 1]; return !!l && !l.saved; }, canRedo: function () { return redoStack.length > 0; },
      get: get, base: getBase, files: function () { return Object.keys(base); }, orderOf: orderOf, isDirty: isDirty, removedItem: removedItem,
      problems: problems, diff: diff, uploadFor: uploadFor, uploads: function () { return Array.from(uploads.values()); },
      setStoreKey: function (k) { storeKey = k; }, load: load, markSaved: markSaved, refFromPointer: refFromPointer, adoptRemote: adoptRemote, head: function () { return head; }, flush: persistNow, unsafeToLeave: function () { return keepFailed && ops0().length > 0; }, _log: function () { return log; }, _working: function () { return working; }, _base: function () { return base; }, paths: paths,
      droppedOnLoad: function () { return dropped; },
      staleCount: function () { return log.filter(function (e) { return e.stale; }).length; },
    };
  }

  S.stagingLib = { create: create };
})(window.__CoveredStudioBoot);
