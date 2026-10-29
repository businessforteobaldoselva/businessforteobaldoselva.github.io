"use strict";
// Publish needs: approver role, a ready (non-draft) Studio PR, the head sha the approver saw, green checks, four-eyes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeApi, patch, heroOp, uuid } = require("../fixtures/harness");

async function ready(api, who) {
  const a = await api.call(who || "editor", "POST", "/v1/drafts", patch(api, [heroOp("Gate test")]));
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const s = await api.call(who || "editor", "POST", "/v1/drafts/" + a.json.draft.id + "/submit", { idempotencyKey: uuid() });
  assert.equal(s.status, 200);
  return s.json.draft;
}
const pub = (api, who, d, sha) => api.call(who, "POST", "/v1/drafts/" + d.id + "/publish", { expectedHeadSha: sha || d.headSha, idempotencyKey: uuid() });

test("an approver publishes a ready draft with green checks: squash merge lands on main", async () => {
  const api = makeApi();
  const d = await ready(api);
  assert.equal(d.canPublish, false); // the editor who wrote it cannot publish it
  const before = api.mainSha();
  const r = await pub(api, "approver", d);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.draft.state, "merged");
  assert.notEqual(api.mainSha(), before);
  assert.match(new TextDecoder().decode(api.repo.fileAt("main", "src/_data/hero.json")), /Gate test/);
});

test("editors cannot publish", async () => {
  const api = makeApi();
  const d = await ready(api);
  const r = await pub(api, "editor", d);
  assert.equal(r.status, 403);
});

test("four eyes: nobody publishes their own draft (unless the flag is on)", async () => {
  const api = makeApi();
  const d = await ready(api, "approver");
  const r = await pub(api, "approver", d);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "not_ready");
  assert.equal(r.json.error.details.reason, "self_publish");
  const api2 = makeApi({ env: { STUDIO_ALLOW_SELF_PUBLISH: "1" } });
  const d2 = await ready(api2, "approver");
  assert.equal((await pub(api2, "approver", d2)).status, 200);
});

test("still a draft PR (not submitted): refused", async () => {
  const api = makeApi();
  const a = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("x1")]));
  const r = await pub(api, "approver", a.json.draft);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.reason, "draft_state");
});

test("checks pending / failed / missing block the merge, green allows it", async () => {
  for (const [state, reason] of [["pending", "checks_pending"], ["failure", "checks_failed"], ["none", "checks_pending"]]) {
    const api = makeApi({ autoChecks: state });
    const d = await ready(api);
    const r = await pub(api, "approver", d);
    assert.equal(r.status, 409, state);
    assert.equal(r.json.error.details.reason, reason, state);
    assert.equal(api.repo.head("main"), api.mainSha());
  }
  const api = makeApi({ autoChecks: "pending" });
  const d = await ready(api);
  api.repo.setChecks(d.number, "success");
  assert.equal((await pub(api, "approver", d)).status, 200);
});

test("a push between looking and publishing is refused (head_changed), and so is a stale sha", async () => {
  const api = makeApi();
  const d = await ready(api);
  const stale = "0".repeat(40);
  const r = await pub(api, "approver", d, stale);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.reason, "head_changed");
  // the owner pushes again: the sha the approver saw is now old
  const upd = await api.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), draftId: d.id, expectedHeadSha: d.headSha, ops: [heroOp("Pushed later")], uploads: [] });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  const r2 = await pub(api, "approver", d);
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error.details.reason, "head_changed");
});

test("a clash with a newer main is not_mergeable; nothing is merged", async () => {
  const api = makeApi();
  const d = await ready(api);
  // someone else (outside Studio) changes the same line on main
  const head = api.mainSha();
  const cur = new TextDecoder().decode(api.repo.fileAt("main", "src/_data/hero.json"));
  const changed = cur.replace(/("headlineMain":\s*")[^"]*(")/, "$1Main moved$2");
  const sha = api.repo.commitOn(head, [{ path: "src/_data/hero.json", bytes: new TextEncoder().encode(changed) }], "direct", "someone");
  api.repo.refs.set("refs/heads/main", sha);
  const r = await pub(api, "approver", d);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.reason, "not_mergeable");
  assert.equal(api.mainSha(), sha);
});

test("only Studio PRs can be published: a Decap PR id or forged id is a 404", async () => {
  const api = makeApi();
  const n = api.repo.seedMergedPr({ title: "x", files: [{ path: "src/_data/hero.json", text: "{}" }] });
  assert.ok(n);
  const r = await api.call("admin", "POST", "/v1/drafts/cms--anything/publish", { expectedHeadSha: "a".repeat(40), idempotencyKey: uuid() });
  assert.equal(r.status, 404);
});

test("anyone discarding or publishing without a token gets 401", async () => {
  const api = makeApi();
  const d = await ready(api);
  assert.equal((await pub(api, null, d)).status, 401);
});
