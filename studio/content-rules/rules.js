/* COVERED Studio - the content rules themselves (Phase 1). Registered into the engine; the same file is bundled into the
   overlay and required by Node. PLACEHOLDER: the EDIT unit writes the rules listed in studio/PHASE1-DESIGN.md 8.4. */
(function (root, factory) {
  var engine = (typeof module === "object" && module && module.exports) ? require("./engine.js") : root.CoveredContentRules;
  factory(engine);
})(typeof self !== "undefined" ? self : this, function (engine) {
  "use strict";
  void engine;
});
