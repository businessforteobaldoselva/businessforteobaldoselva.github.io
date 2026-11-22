"use strict";
// Selftest scenarios for check-phase1.js (PHASE1-DESIGN 15): break one promise at a time, expect the guard to say so.
const path = require("path");

module.exports = (h) => {
  const guard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-phase1.js"), ws.dir, []);
  const scenario = (name, rel, change, has) => ({
    name: "phase 1: " + name,
    build: false,
    mutate: (ws) => h.edit(ws, rel, change),
    run: (ws) => h.expectRun(name, guard(ws), { code: 1, has }),
  });
  return [
    { name: "phase 1: control (untouched copy passes check-phase1)", build: false, run: (ws) => h.expectRun("check-phase1 passes on the untouched copy", guard(ws), { code: 0, has: ["check-phase1: OK"] }) },
    scenario("the runbook forgets a Phase 1 variable", "docs/STUDIO-RUNBOOK.md", (t) => t.split("STUDIO_HEALTH_TTL_SECONDS").join("STUDIO_HEALTH_TTL"), ["does not mention environment variable STUDIO_HEALTH_TTL_SECONDS"]),
    scenario("the overlay manifest drops a pre-registered file", "studio/overlay/manifest.json", h.replaceOnce('    "ext/status.js",\n', ""), ["must list ext/status.js"]),
    scenario("the overlay manifest lists a file that is gone", "studio/overlay/manifest.json", h.replaceOnce('"ext/review.js"', '"ext/review-gone.js"'), ["ext/review-gone.js"]),
    scenario("someone raises the overlay budget again", "studio/guards/check-overlay.js", h.replaceOnce("scriptsKiB: 460", "scriptsKiB: 600"), ["overlay budget is 600/64"]),
    scenario("the handler stops requiring the board routes", "studio/api/handler.js", h.replaceOnce('    require("./routes/board").routes,\n', ""), ["allRoutes() must require routes/board"]),
  ];
};
