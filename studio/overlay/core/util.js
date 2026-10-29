/* COVERED Studio overlay - core/util.js
   Small pure helpers shared by every module: refs and pointers, tagged cloning, deep equality,
   safe storage, safe links, and the ONE place that fetches the page's own content.json.
   No DOM is touched at load time, so this file also runs under node for the unit tests. */
(function (S) {
  "use strict";

  var TAG = typeof Symbol === "function" ? Symbol("covered.studio.origIndex") : "__origIndex";

  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function isArr(v) { return Array.isArray(v); }

  // Deep clone that also tags every object/array that sits in a list with its ORIGINAL index (TAG), so a
  // reordered or trimmed list can still be compared with the base. Tags never reach JSON (Symbol keys).
  function cloneTagged(v) {
    if (isArr(v)) {
      return v.map(function (item, i) {
        var c = cloneTagged(item);
        if (c !== null && typeof c === "object") Object.defineProperty(c, TAG, { value: i, enumerable: false, writable: true, configurable: true });
        return c;
      });
    }
    if (isObj(v)) {
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = cloneTagged(v[k]); });
      return o;
    }
    return v;
  }
  function plain(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
    if (isArr(a) !== isArr(b)) return false;
    if (isArr(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j += 1) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[j]) || !deepEqual(a[ka[j]], b[ka[j]])) return false;
    }
    return true;
  }

  // ---- refs (DESIGN 2.1) ----
  var REF_RE = /^(pages:[a-z0-9-]+|[a-z][a-z0-9-]*)(\.[A-Za-z0-9_-]+)+$/;
  function parseRef(str) {
    if (typeof str !== "string" || str.length > 160 || !REF_RE.test(str)) return null;
    var cut = str.indexOf(".");
    return { file: str.slice(0, cut), segs: str.slice(cut + 1).split(".") };
  }
  function formatRef(file, segs) { return file + "." + segs.join("."); }
  function filePathOf(file) {
    return file.indexOf("pages:") === 0 ? "src/pages/" + file.slice(6) + ".md" : "src/_data/" + file + ".json";
  }
  function pointerOf(segs) { return "/" + segs.map(function (s) { return String(s).replace(/~/g, "~0").replace(/\//g, "~1"); }).join("/"); }
  function segsOfPointer(ptr) {
    if (ptr === "" || ptr === "/") return [];
    return ptr.slice(1).split("/").map(function (s) { return s.replace(/~1/g, "/").replace(/~0/g, "~"); });
  }
  function fileKeyOfPath(p) {
    var m = /^src\/_data\/([a-z0-9-]+)\.json$/.exec(p);
    if (m) return m[1];
    m = /^src\/pages\/([a-z0-9-]+)\.md$/.exec(p);
    return m ? "pages:" + m[1] : null;
  }

  // ---- links: same rule as the site's safeUrl, plus blob: for local previews ----
  function safeHref(v, allowBlob) {
    var s = typeof v === "string" ? v.trim() : "";
    if (!s) return null;
    if (/^\/(?!\/)/.test(s) || s.charAt(0) === "#") return s;
    if (/^(https?|mailto):/i.test(s)) return s;
    if (allowBlob && /^blob:/i.test(s)) return s;
    return null;
  }

  // ---- storage (always try/catch; the UI works without it) ----
  function store(kind) {
    return {
      get: function (k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { window[kind].setItem(k, v); return true; } catch (e) { return false; } },
      del: function (k) { try { window[kind].removeItem(k); } catch (e) { /* ignore */ } },
      keys: function () {
        try { var o = []; for (var i = 0; i < window[kind].length; i += 1) o.push(window[kind].key(i)); return o; } catch (e) { return []; }
      },
    };
  }

  function debounce(fn, ms) {
    var t = null;
    var d = function () {
      var args = arguments;
      var self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
    d.cancel = function () { clearTimeout(t); };
    return d;
  }
  function uuid() {
    var c = typeof crypto !== "undefined" ? crypto : null;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (var i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function truncate(s, n) {
    s = String(s == null ? "" : s);
    n = n || 80;
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  // Text shown to people: control characters and bidi overrides are made visible/harmless (defence in depth;
  // the text still only ever reaches the DOM through textContent).
  function visible(s) {
    return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "·");
  }

  // The only fetch outside the API client: the preview build's own content snapshot (same origin).
  function fetchOwnJson(url) {
    return fetch(url, { credentials: "omit", cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  var pending = [];
  S.ready = S.ready || function (fn) { if (S.studio) fn(S.studio); else pending.push(fn); };
  S._flushReady = function (studio) {
    S.studio = studio;
    var q = pending.splice(0).concat(S._q || []);
    if (S._q) S._q.length = 0;
    q.forEach(function (fn) { try { fn(studio); } catch (e) { if (typeof console !== "undefined") console.error("[studio] ready hook failed", e); } });
  };

  S.TAG = TAG;
  S.util = {
    isObj: isObj, isArr: isArr, cloneTagged: cloneTagged, plain: plain, deepEqual: deepEqual,
    parseRef: parseRef, formatRef: formatRef, filePathOf: filePathOf, pointerOf: pointerOf, segsOfPointer: segsOfPointer, fileKeyOfPath: fileKeyOfPath,
    safeHref: safeHref, local: store("localStorage"), session: store("sessionStorage"),
    debounce: debounce, uuid: uuid, truncate: truncate, visible: visible, fetchOwnJson: fetchOwnJson,
  };
})(window.__CoveredStudioBoot);
