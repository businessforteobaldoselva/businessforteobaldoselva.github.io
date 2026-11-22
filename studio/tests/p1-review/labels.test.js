"use strict";
// When GitHub refuses to write labels (PHASE1-DESIGN 4.3) a Studio draft must still be listed, reviewed and published by Studio
// itself; a pull request that only LOOKS like one must not.
const test = require("node:test");
const assert = require("node:assert/strict");
const { api, draftBy, submit } = require("./helpers");

test("a draft whose label never landed is still listed, on the board and reviewable", async () => {
  const a = api();
  const d = await draftBy(a, "editor");
  await submit(a, "editor", d);
  a.repo.prs.get(d.number).labels.clear();
  const list = await a.call("approver", "GET", "/v1/drafts?scope=all");
  assert.deepEqual(list.json.drafts.map((x) => x.id), [d.id]);
  assert.equal((await a.call("approver", "GET", "/v1/drafts/" + d.id + "/review")).status, 200);
  a.advance(20000);
  assert.equal((await a.call("approver", "GET", "/v1/board")).json.waiting.length, 1);
});

test("a look-alike is not a Studio draft: wrong branch, wrong marker, or a fork", async () => {
  const a = api();
  const d = await draftBy(a, "editor");
  await submit(a, "editor", d);
  const real = a.repo.prs.get(d.number);
  const head = a.repo.head(real.headRef);
  // 1. the same body on a branch that is not studio/<user>/<slug>
  a.repo.refs.set("refs/heads/feature/copycat", head);
  a.repo.createPr({ head: "feature/copycat", base: "main", title: "Studio: copy", body: real.body, draft: false, labels: [] });
  // 2. a studio/ branch whose id does not match the marker in the body
  a.repo.refs.set("refs/heads/studio/uzzzzzzz/other", head);
  a.repo.createPr({ head: "studio/uzzzzzzz/other", base: "main", title: "Studio: other", body: real.body, draft: false, labels: [] });
  // 3. the right branch and marker, but from a fork
  a.repo.refs.set("refs/heads/studio/ubbbbbbb/forked", head);
  const fork = a.repo.createPr({ head: "studio/ubbbbbbb/forked", base: "main", title: "Studio: fork", body: real.body, draft: false, labels: [] });
  fork.fromFork = true;
  const list = await a.call("approver", "GET", "/v1/drafts?scope=all");
  assert.deepEqual(list.json.drafts.map((x) => x.id), [d.id]);
  a.advance(20000);
  assert.deepEqual((await a.call("approver", "GET", "/v1/board")).json.waiting.map((x) => x.id), [d.id]);
});

test("a label-less draft has no blockers in the review (the provider merge() fallback is BACKEND's, PHASE1-DESIGN 4.3)", async () => {
  const a = api();
  const d = await draftBy(a, "editor");
  await submit(a, "editor", d);
  a.repo.prs.get(d.number).labels.clear();
  const r = await a.call("approver", "GET", "/v1/drafts/" + d.id + "/review");
  assert.deepEqual(r.json.gates.blockers, []);
  assert.equal(r.json.gates.canPublish, true);
});
