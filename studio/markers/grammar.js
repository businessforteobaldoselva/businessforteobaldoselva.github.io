"use strict";
// Marker reference grammar (studio/DESIGN.md section 2.1). UMD: used by the Eleventy shortcode,
// the schema build, the validator (Node) and the overlay (browser). No dependencies.
//
//   ref   := file ("." seg)+
//   file  := dataStem | "pages:" pageSlug
//   seg   := [A-Za-z0-9_-]+      (object key, array index, or the reserved seg "_body")
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CoveredStudioGrammar = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var MAX_REF = 160;
  var REF_RE = /^(?:[a-z][a-z0-9-]*|pages:[a-z0-9-]+)(?:\.[A-Za-z0-9_-]+)+$/;
  var SEG_RE = /^[A-Za-z0-9_-]+$/;
  var DATA_RE = /^[a-z][a-z0-9-]*$/;
  var PAGE_RE = /^[a-z0-9-]+$/;

  function parseRef(str) {
    if (typeof str !== "string" || str.length > MAX_REF || !REF_RE.test(str)) return null;
    var parts = str.split(".");
    return { file: parts[0], segs: parts.slice(1) };
  }

  function validFile(file) {
    if (typeof file !== "string") return false;
    if (file.indexOf("pages:") === 0) return PAGE_RE.test(file.slice(6));
    return DATA_RE.test(file);
  }

  function formatRef(file, segs) {
    if (!validFile(file) || !Array.isArray(segs) || !segs.length) throw new Error("formatRef: invalid file or segments");
    var out = segs.map(function (s) {
      s = String(s);
      if (!SEG_RE.test(s)) throw new Error("formatRef: invalid segment " + JSON.stringify(s));
      return s;
    });
    var ref = file + "." + out.join(".");
    if (ref.length > MAX_REF) throw new Error("formatRef: reference too long");
    return ref;
  }

  function locate(ref) {
    var p = typeof ref === "string" ? parseRef(ref) : ref;
    if (!p) return null;
    var page = p.file.indexOf("pages:") === 0;
    return {
      filePath: page ? "src/pages/" + p.file.slice(6) + ".md" : "src/_data/" + p.file + ".json",
      kind: page ? "page" : "data",
      pointer: "/" + p.segs.join("/"),
    };
  }

  return { parseRef: parseRef, formatRef: formatRef, locate: locate, REF_RE: REF_RE, MAX_REF: MAX_REF };
});
