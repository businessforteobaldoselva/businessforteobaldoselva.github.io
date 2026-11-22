"use strict";
// Selftest scenarios of Studio Phase 1 REVIEW (PHASE1-DESIGN 15): break one promise at a time in a throwaway copy and check that
// check-review.js notices, for the right reason. No site build is needed (build: false). The copy runs the real API in memory,
// so a scenario takes a second or two.
//   module.exports = (h) => [ { name, mutate(ws), build, run(ws, siteDir) } ]
const path = require("path");

module.exports = (h) => {
  const guard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-review.js"), ws.dir, []);
  const BOARD = "studio/api/services/board.js";
  const REVIEW = "studio/api/services/review.js";
  const DRAFTS = "studio/api/services/drafts.js";
  const DESCRIBE = "studio/validate/describe.js";
  const UI_REVIEW = "studio/overlay/ext/review.js";
  const UI_STATUS = "studio/overlay/ext/status.js";

  const scenario = (name, rel, change, has) => ({
    name: "p1 review: " + name,
    build: false,
    mutate: (ws) => h.edit(ws, rel, change),
    run: (ws) => h.expectRun(name, guard(ws), { code: 1, has }),
  });

  return [
    { name: "p1 review: control (untouched copy passes check-review)", build: false, run: (ws) => h.expectRun("check-review passes on the untouched copy", guard(ws), { code: 0, has: ["check-review: OK"] }) },
    scenario("the board shows other people's drafts to an editor", BOARD, h.replaceOnce("const waitingRows = approver ? ready : ready.filter((r) => r.draft.isMine);", "const waitingRows = ready;"), ["an editor must never see another person's draft title"]),
    scenario("the review route stops reading publishBlockers", REVIEW, h.replaceOnce("const blockers = drafts.publishBlockers(deps, ctx, pr, parsed.userKey);", "const blockers = [];"), ["must take its blockers from drafts.publishBlockers", "an unsent draft must be blocked"]),
    scenario("publishDraft stops deciding through publishBlockers", DRAFTS, h.replaceOnce("const b = publishBlockers(deps, ctx, pr, ownerKey);", "const b = [];"), ["publishDraft must decide through publishBlockers"]),
    scenario("a GitHub error fails the submit again", DRAFTS, h.replaceOnce("notified = { via: \"none\", reviewer: who, reason: e instanceof GitError", "throw e; notified = { via: \"none\", reviewer: who, reason: e instanceof GitError"), ["a GitHub conflict while asking for a review must still submit the draft"]),
    scenario("describe returns an empty line for move", DESCRIBE, h.replaceOnce("else line = \"Moves an item in \" + at + \" from position \" + (Number(a.from) + 1) + \" to position \" + (Number(a.to) + 1) + \".\";", "else line = \"\";"), ["describe must return a plain-English line for a move operation"]),
    scenario("the approvers route leaks the GitHub login", REVIEW, h.replaceOnce("notify: r.github ? \"github\" : \"manual\" }", "notify: r.github ? \"github\" : \"manual\", github: r.github }"), ["must not carry a GitHub login"]),
    scenario("side by side is on without the flag", REVIEW, h.replaceOnce("if (cfg.previewEmbed && draft.previewUrl && cfg.siteUrl) {", "if (draft.previewUrl && cfg.siteUrl) {"), ["side by side must stay off unless STUDIO_PREVIEW_EMBED=1"]),
    scenario("the board writes to Git", BOARD, h.replaceOnce("const rows = await drafts.openDrafts(ctx);", "const rows = await drafts.openDrafts(ctx);\n  await deps.git.updatePr(1, {});"), ["calls a Git write method (updatePr)"]),
    scenario("the review service saves a draft", REVIEW, h.replaceOnce("const items = await itemsOf(deps, pr);", "const items = await itemsOf(deps, pr);\n  void drafts.saveDraft;"), ["reaches a write or publish path (saveDraft)"]),
    scenario("the reviewer list is read somewhere else", REVIEW, h.replaceOnce("const MAX_ITEMS = 200;", "const MAX_ITEMS = 200;\nconst LIST = \"STUDIO_REVIEWERS\";"), ["reads STUDIO_REVIEWERS: it is parsed only in api/review-config.js"]),
    scenario("the review screen starts using innerHTML", UI_REVIEW, h.replaceOnce("title.textContent = vm.title;", "title.innerHTML = vm.title;"), ["uses .innerHTML"]),
    scenario("the review screen asks h() for a script element", UI_REVIEW, h.replaceOnce('var summary = el("p", { class: "csx-rv-summary"', 'var summary = el("script", { class: "csx-rv-summary"'), ["el() tag is not a literal from the allowed list: script"]),
    scenario("the status board gets its own network call", UI_STATUS, h.replaceOnce("function openReview(id)", "function leak() { return fetch(\"/x\"); }\n    function openReview(id)"), ["references fetch"]),
    scenario("the status board gains a publish path", UI_STATUS, h.replaceOnce("var latest = null;", "var latest = null; var sneaky = \"/v1/drafts/x/publish\";"), ["the status board must not publish"]),
    scenario("a second Approve and publish button appears", UI_REVIEW, h.replaceOnce('vm.url ? el("a", {', 'el("button", { type: "button", "data-approve": "2", on: { click: approve } }, "Approve and publish"), vm.url ? el("a", {'), ["there must be exactly ONE Approve and publish button"]),
    scenario("the review screen stops announcing its summary", UI_REVIEW, (t) => t.split("aria-live").join("aria-hint"), ["must announce its summary (aria-live)"]),
  ];
};
