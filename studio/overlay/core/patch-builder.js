/* COVERED Studio overlay - core/patch-builder.js
   Turns "base documents vs working documents" into the ONE patch the API takes (DESIGN section 5), and into
   plain-English lines for the Review panel.

   Order of the ops (this is what makes `expect` meaningful, because the server compares every `expect`
   with the draft head BEFORE it applies anything):
     1. replace / add / remove-key  on values - pointers and expects are in HEAD coordinates;
     2. remove list items           - highest index first, expect = the item as it is at the head;
     3. move                        - sequential (pointers are valid after the previous op);
     4. add list items              - appended with "-".
   Pure logic: runs under node. */
(function (S) {
  "use strict";
  var U = S.util;
  var TAG = S.TAG;

  function esc(seg) { return String(seg).replace(/~/g, "~0").replace(/\//g, "~1"); }
  function ptr(segs) { return segs.length ? "/" + segs.map(esc).join("/") : ""; }

  function diffFiles(base, working, paths) {
    var leaf = [];
    var removes = [];
    var moves = [];
    var adds = [];

    function node(fileKey, segs, a, b) {
      if (Array.isArray(a) && Array.isArray(b)) return list(fileKey, segs, a, b);
      if (U.isObj(a) && U.isObj(b)) {
        Object.keys(b).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(a, k)) leaf.push(mk("add", fileKey, segs.concat(k), { value: U.plain(b[k]) }));
          else node(fileKey, segs.concat(k), a[k], b[k]);
        });
        Object.keys(a).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(b, k)) leaf.push(mk("remove", fileKey, segs.concat(k), { expect: U.plain(a[k]) }));
        });
        return;
      }
      if (!U.deepEqual(a, b)) leaf.push(mk("replace", fileKey, segs, { value: U.plain(b), expect: U.plain(a) }));
    }
    function mk(op, fileKey, segs, extra, meta) {
      var o = { op: op, file: paths[fileKey], path: ptr(segs) };
      Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
      Object.defineProperty(o, "_m", { value: Object.assign({ fileKey: fileKey, segs: segs }, meta || {}), enumerable: false });
      return o;
    }
    function list(fileKey, segs, a, b) {
      var primitive = a.some(function (x) { return x === null || typeof x !== "object"; });
      if (primitive) {
        if (a.length === b.length) a.forEach(function (x, i) { node(fileKey, segs.concat(String(i)), x, b[i]); });
        else if (!U.deepEqual(a, b)) leaf.push(mk("replace", fileKey, segs, { value: U.plain(b), expect: U.plain(a) }));
        return;
      }
      // `a` is the head (indexes = what the server has); `b` the working copy; items are matched by their tag
      var byTag = {};
      a.forEach(function (x, n) { byTag[x !== null && typeof x === "object" && x[TAG] !== undefined ? x[TAG] : n] = n; });
      var survivors = []; // head indexes, in the working order
      var pairs = [];
      b.forEach(function (item) {
        var t = item !== null && typeof item === "object" ? item[TAG] : undefined;
        if (t === undefined || byTag[t] === undefined) adds.push(mk("add", fileKey, segs.concat("-"), { value: U.plain(item) }, { listSegs: segs }));
        else { survivors.push(byTag[t]); pairs.push([byTag[t], item]); }
      });
      pairs.forEach(function (pr) { node(fileKey, segs.concat(String(pr[0])), a[pr[0]], pr[1]); });
      var gone = [];
      for (var i = 0; i < a.length; i += 1) if (survivors.indexOf(i) < 0) gone.push(i);
      gone.sort(function (x, y) { return y - x; }).forEach(function (i) {
        removes.push(mk("remove", fileKey, segs.concat(String(i)), { expect: U.plain(a[i]) }, { itemSegs: segs.concat(String(i)), listSegs: segs, removedItem: true }));
      });
      var current = [];
      for (var k = 0; k < a.length; k += 1) if (survivors.indexOf(k) >= 0) current.push(k);
      survivors.forEach(function (want, idx) {
        var j = current.indexOf(want);
        if (j !== idx) {
          var o = mk("move", fileKey, segs, {}, { itemSegs: segs.concat(String(want)), listSegs: segs, from: j, to: idx });
          o.from = ptr(segs.concat(String(j)));
          o.path = ptr(segs.concat(String(idx)));
          moves.push(o);
          current.splice(j, 1);
          current.splice(idx, 0, want);
        }
      });
    }

    Object.keys(base).forEach(function (k) { node(k, [], base[k], working[k]); });
    return leaf.concat(removes, moves, adds);
  }

  function strip(o) {
    var out = { op: o.op, file: o.file };
    if (o.op === "move") out.from = o.from;
    out.path = o.path;
    if (o.op === "replace" || o.op === "add") out.value = o.value;
    if (Object.prototype.hasOwnProperty.call(o, "expect")) out.expect = o.expect;
    return out;
  }

  // ---------------------------------------------------------------- plain-English lines
  function q(v) { return "“" + U.truncate(U.visible(typeof v === "string" ? v.replace(/\s+/g, " ") : JSON.stringify(v)), 80) + "”"; }

  function describeChanges(ops, ctx) {
    var sc = ctx.sc;
    return ops.map(function (op, n) {
      var m = op._m;
      var fileKey = m.fileKey;
      var segs = m.segs;
      var doc = ctx.base[fileKey];
      var field = null;
      if (sc) {
        var r = sc.resolve(fileKey, segs, doc);
        field = r && r.field;
      }
      var widget = field ? sc.widgetOf(field) : "string";
      var rule = field && field.x && field.x.rule;
      var itemName = m.itemSegs && sc ? sc.itemName(fileKey, m.itemSegs, doc) : null;
      var label = sc ? sc.labelFor(fileKey, segs, doc) : fileKey + "." + segs.join(".");
      var lastSeg = segs[segs.length - 1];
      var kind = "text";
      var summary;
      var ref = U.formatRef(fileKey, segs.length ? segs : ["_"]);
      if (op.op === "move") {
        var from = m.from;
        var to = m.to;
        kind = /^sections$/.test(String(segs[segs.length - 1])) && fileKey === "homepage" ? "section" : "list";
        summary = "Moved " + q(itemName) + " " + (to < from ? "up" : "down") + " to position " + (to + 1);
        label = itemName || label;
        ref = U.formatRef(fileKey, segs.length ? segs : ["_"]);
      } else if (op.op === "remove" && m.removedItem) {
        kind = "list";
        summary = "Removed " + q(itemName);
        label = itemName || label;
        ref = U.formatRef(fileKey, m.itemSegs);
      } else if (op.op === "remove") {
        summary = "Cleared " + q(label);
      } else if (op.op === "add" && m.listSegs) {
        kind = "list";
        summary = "Added a new item";
        ref = U.formatRef(fileKey, m.listSegs);
        label = sc ? sc.labelFor(fileKey, m.listSegs, doc) : label;
      } else {
        var before = op.expect;
        var after = op.value;
        if (widget === "boolean") {
          kind = fileKey === "homepage" && lastSeg === "enabled" ? "section" : "toggle";
          if (kind === "section") {
            var secName = sc ? sc.itemName(fileKey, segs.slice(0, -1), doc) : "";
            summary = (after === false ? "Hid " : "Showed ") + q(secName) + " on the live site";
          } else summary = (after ? "Turned on" : "Turned off") + " “" + (field && field.label ? sc.stripEmoji(field.label) : label) + "”";
        } else if (widget === "color") {
          kind = "color";
          summary = "Changed the colour from " + before + " to " + after;
        } else if (widget === "image") {
          kind = "image";
          var up = ctx.uploadFor ? ctx.uploadFor(after) : null;
          summary = (up ? "Uploaded a new picture (" + U.truncate(U.visible(up.name), 40) + ") replacing " : "Switched the picture from ") + q(before) + (up ? "" : " to " + q(after));
        } else if (rule === "url") {
          kind = "link";
          summary = "Changed the link from " + q(before) + " to " + q(after);
        } else if (fileKey.indexOf("pages:") === 0 && lastSeg === "_body") {
          kind = "page";
          summary = "Rewrote the page text";
        } else if (typeof after === "number") {
          summary = "Changed the number from " + before + " to " + after;
        } else if (op.op === "add") {
          summary = "Set the text to " + q(after);
        } else {
          summary = "Changed the text from " + q(before) + " to " + q(after);
        }
      }
      var probs = ctx.problemsFor ? ctx.problemsFor().filter(function (p) { return p.ref === ref; }) : [];
      return {
        id: n + ":" + op.op + ":" + op.file + op.path + (op.from || ""),
        ref: ref, file: op.file, path: op.path, op: op.op, label: label, summary: summary, kind: kind,
        before: op.expect, after: op.value, problems: probs.length ? probs[0].messages : [],
      };
    });
  }

  // ---------------------------------------------------------------- the patch
  function bytesToBase64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function blobToBase64(blob) {
    return blob.arrayBuffer().then(function (buf) { return bytesToBase64(new Uint8Array(buf)); });
  }

  // opts: { staging, key, title, draft: { id, headSha } | null, baseSha }
  function build(opts) {
    var st = opts.staging;
    var ops = st.diff();
    var used = [];
    ops.forEach(function (o) {
      if (typeof o.value === "string") {
        var u = st.uploadFor(o.value);
        if (u && used.indexOf(u) < 0) used.push(u);
      }
    });
    return Promise.all(used.map(function (u, i) {
      return blobToBase64(u.blob).then(function (b64) { return { id: "u" + (i + 1), name: u.name, contentType: u.contentType, size: u.blob.size, dataBase64: b64 }; });
    })).then(function (uploads) {
      var patch = { idempotencyKey: opts.key, ops: ops.map(strip), uploads: uploads };
      if (opts.draft && opts.draft.id) { patch.draftId = opts.draft.id; patch.expectedHeadSha = opts.draft.headSha; }
      else patch.baseSha = opts.baseSha;
      if (opts.title) patch.title = String(opts.title).slice(0, 80);
      return patch;
    });
  }

  S.patchBuilder = { diffFiles: diffFiles, describeChanges: describeChanges, build: build, strip: strip, ptr: ptr };
})(window.__CoveredStudioBoot);
