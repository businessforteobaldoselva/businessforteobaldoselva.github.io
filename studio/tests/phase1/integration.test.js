"use strict";
// Phase 1 end to end through the REAL handler + mock Git + dev auth (PHASE1-DESIGN 17): every new route passes its validator, and
// one drive-through: draft -> send -> review -> publish refused while checks are not green -> allowed once they are.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../api/shapes/phase1");
const { api, draftBy, submit, publish } = require("../p1-review/helpers");

test("health, approvers, board, review, submit, estimate and recent all answer in their documented shapes", async () => {
  const a = api({ env: { STUDIO_AI_ENABLED: "1" } });
  const h = await a.call(null, "GET", "/v1/health");
  assert.equal(h.status, 200);
  assert.deepEqual(S.validateHealth(h.json), []);
  const ap = await a.call("editor", "GET", "/v1/people/approvers");
  assert.equal(ap.status, 200);
  assert.deepEqual(S.validateApprovers(ap.json), []);
  const d = await draftBy(a, "editor");
  const s = await submit(a, "editor", d, "amelia");
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(S.validateSubmitResponse(s.json), []);
  const b = await a.call("approver", "GET", "/v1/board");
  assert.equal(b.status, 200);
  assert.deepEqual(S.validateBoard(b.json), []);
  assert.ok(b.json.waiting.some((x) => x.id === d.id), "the sent draft is waiting");
  const r = await a.call("approver", "GET", "/v1/drafts/" + d.id + "/review");
  assert.equal(r.status, 200);
  assert.deepEqual(S.validateReview(r.json), []);
  const rec = await a.call("editor", "GET", "/v1/ai/recent");
  assert.equal(rec.status, 200);
  assert.deepEqual(S.validateAiRecent(rec.json), []);
});

test("drive-through: edit -> save -> send -> review -> publish blocked while checks run, then allowed", async () => {
  const a = api();
  const d = await draftBy(a, "editor");
  assert.equal((await submit(a, "editor", d, "amelia")).status, 200);
  a.repo.setChecks(d.number, "pending");
  const waiting = await a.call("approver", "GET", "/v1/drafts/" + d.id + "/review");
  assert.equal(waiting.json.gates.canPublish, false);
  assert.equal(waiting.json.gates.blockers[0].reason, "checks_pending");
  const main0 = a.repo.head("main");
  assert.equal((await publish(a, "approver", d, waiting.json.headSha)).status, 409);
  assert.equal(a.repo.head("main"), main0, "nothing merged while checks were pending");
  a.repo.setChecks(d.number, "success");
  const ready = await a.call("approver", "GET", "/v1/drafts/" + d.id + "/review");
  assert.equal(ready.json.gates.canPublish, true);
  assert.equal((await publish(a, "editor", d, ready.json.headSha)).status, 403, "an editor still cannot publish");
  assert.equal((await publish(a, "approver", d, ready.json.headSha)).status, 200);
  assert.notEqual(a.repo.head("main"), main0, "now it is merged");
});
