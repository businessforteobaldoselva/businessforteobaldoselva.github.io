"use strict";
// Selftest scenarios of Studio unit D (studio/DESIGN.md 9): break one thing at a time in a throwaway copy and check that
// check-history.js notices, for the right reason. No site build is needed (build: false), so these are quick.
//   module.exports = (h) => [ { name, mutate(ws), build, run(ws, siteDir) } ]
const path = require("path");

module.exports = (h) => {
  const guard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-history.js"), ws.dir, []);
  const HIST = "studio/overlay/ext/history.js";
  const PAL = "studio/overlay/ext/palette.js";
  const TOUR = "studio/overlay/ext/tour.js";
  const SVC = "studio/api/services/history.js";
  const DIFF = "studio/api/services/history-diff.js";
  const RUNBOOK = "docs/STUDIO-RUNBOOK.md";

  const scenario = (name, rel, change, has) => ({
    name: "studio D: " + name,
    build: false,
    mutate: (ws) => h.edit(ws, rel, change),
    run: (ws) => h.expectRun(name, guard(ws), { code: 1, has }),
  });

  return [
    {
      name: "studio D: control (untouched copy passes check-history)",
      build: false,
      run: (ws) => h.expectRun("check-history passes on the untouched copy", guard(ws), { code: 0, has: ["check-history: OK"] }),
    },
    scenario("History panel starts using innerHTML", HIST, h.replaceOnce('var root = el("div", { class: "csx-history" });', 'var root = el("div", { class: "csx-history" }); root.innerHTML = state.error;'), ["innerHTML"]),
    scenario("palette makes its own network call", PAL, h.replaceOnce("function can(name)", 'function can(name) { fetch("/x"); return false; }\n    function can2(name)'), ["references fetch"]),
    scenario("palette pulls a script from a CDN", PAL, h.replaceOnce("var MAX = 8;", 'var MAX = 8; var cdn = "https://cdn.example.com/x.js";'), ["URL literal to another host"]),
    scenario("tour builds an element with createElement", TOUR, h.replaceOnce("function reducedMotion()", 'function sneaky() { return document.createElement("div"); }\n    function reducedMotion()'), ["createElement"]),
    scenario("tour asks h() for a script element", TOUR, h.replaceOnce('var spot = el("div", { class: "csx-spot", "aria-hidden": "true" });', 'var spot = el("script", { class: "csx-spot", "aria-hidden": "true" });'), ["tag is not a literal from the allowed list"]),
    scenario("tour sets an inline style prop through h()", TOUR, h.replaceOnce('var count = el("p", { class: "csx-tour-count" });', 'var count = el("p", { class: "csx-tour-count", style: "color:red" });'), ["prop not allowed by h(): style"]),
    scenario("tour touches localStorage outside try/catch", TOUR, h.replaceOnce("function reducedMotion()", 'function leak() { return window.localStorage.getItem("x"); }\n    function reducedMotion()'), ["localStorage used outside try/catch"]),
    scenario("restore writes to Git itself", SVC, h.replaceOnce("const res = await drafts.createFromOps({", 'await git.commitFiles({ branch: "main", files: [] });\n    const res = await drafts.createFromOps({'), ["calls a Git write method (commitFiles)"]),
    scenario("restore stops going through createFromOps", SVC, (t) => t.replace(/drafts\.createFromOps\(/g, "drafts.somethingElse("), ["restore must call drafts.createFromOps"]),
    scenario("inverse operations lose their expect", DIFF, h.replaceOnce('out.push({ op: "replace", file, path, value: clone(a), expect: clone(b) });', 'out.push({ op: "replace", file, path, value: clone(a) });'), ["has no matching expect"]),
    scenario("the runbook forgets an environment variable", RUNBOOK, (t) => t.split("GITHUB_APP_PRIVATE_KEY").join("GITHUB_APP_KEY"), ["does not mention environment variable GITHUB_APP_PRIVATE_KEY"]),
  ];
};
