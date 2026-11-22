"use strict";
// The Phase 1 example payloads are valid, and each validator rejects a broken copy (so the validators are not vacuous).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../../api/shapes/phase1");

const dir = path.join(__dirname, "..", "fixtures", "phase1");
const load = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));

const CASES = [
  ["health.ok.json", "validateHealth", (x) => { x.services.auth.state = "paused"; }],
  ["health.paused.json", "validateHealth", (x) => { x.message = null; x.ok = true; }],
  ["board.json", "validateBoard", (x) => { x.waiting[0].step = "bogus"; }],
  ["review.json", "validateReview", (x) => { x.items[1].id = "r5"; }],
  ["review.json", "validateReview", (x) => { x.gates.blockers = [{ reason: "checks_failed", message: "x" }]; }],
  ["approvers.json", "validateApprovers", (x) => { x.approvers[0].notify = "email"; }],
  ["submit.github.json", "validateSubmitResponse", (x) => { x.notified.reason = "no_github_login"; }],
  ["submit.manual.json", "validateSubmitResponse", (x) => { x.notified.reason = null; }],
  ["ai-estimate.json", "validateAiEstimate", (x) => { x.estimate.pctOfDay = 120; }],
  ["ai-recent.json", "validateAiRecent", (x) => { x.items[0].prUrl = 5; }],
  ["ai-meter.json", "validateAiMeter", (x) => { delete x.counted; }],
  ["rule-report.json", "validateRuleReport", (x) => { x.counts.warn = 4; }],
  ["rule-report.json", "validateRuleReport", (x) => { x.findings.push(structuredClone(x.findings[0])); x.counts.block = 2; }],
];

for (const [file, fn, breakIt] of CASES) {
  test(file + " is valid for " + fn, () => assert.deepEqual(S[fn](load(file)), []));
  test(file + " is rejected by " + fn + " once broken", () => {
    const x = load(file);
    breakIt(x);
    assert.ok(S[fn](x).length > 0, "expected a problem");
  });
}
test("an unknown key is a problem (exact shapes)", () => {
  const x = load("board.json");
  x.extra = 1;
  assert.ok(S.validateBoard(x).some((p) => /extra/.test(p)));
});
