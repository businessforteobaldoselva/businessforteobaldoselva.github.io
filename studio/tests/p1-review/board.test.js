"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../api/shapes/phase1");
const { api, draftBy, submit, publish, heroOp, uuid } = require("./helpers");

const get = async (a, who) => { const r = await a.call(who, "GET", "/v1/board"); assert.equal(r.status, 200, r.text); assert.deepEqual(S.validateBoard(r.json), []); return r.json; };

test("an empty site: nothing live, nothing waiting, the shape is valid", async () => {
  const a = api();
  const b = await get(a, "editor");
  assert.deepEqual([b.live, b.waiting, b.restored, b.mine, b.othersWaiting], [null, [], [], [], 0]);
});

test("steps follow the table: editing, checks running, checks failed, waiting for approval, ready to publish", async () => {
  const a = api();
  const d = await draftBy(a, "editor");
  assert.equal((await get(a, "editor")).mine[0].step, "editing");
  assert.equal((await get(a, "editor")).mine[0].stepLabel, "Still being edited");
  await submit(a, "editor", d);
  a.advance(20000);
  // the editor sees it as waiting for approval (they cannot publish it), the approver as ready to publish
  const e = await get(a, "editor");
  assert.equal(e.waiting[0].step, "waiting_for_approval");
  assert.equal(e.waiting[0].stepLabel, "Waiting for approval");
  assert.equal(e.waiting[0].canPublish, false);
  const p = await get(a, "approver");
  assert.equal(p.waiting[0].step, "ready_to_publish");
  assert.equal(p.waiting[0].stepLabel, "Ready for you to approve");
  assert.equal(p.waiting[0].canPublish, true);
  assert.equal(p.waiting[0].mine, false);
  assert.equal(p.waiting[0].author.name, "Molly");
  assert.equal(p.waiting[0].changeCount, 1);
  assert.match(p.waiting[0].reviewLink, /^http:\/\/localhost:8080\/\?studio=1#review=u[a-z2-7]{7}--review-me$/);

  a.repo.setChecks(d.number, "pending");
  a.advance(20000);
  assert.equal((await get(a, "approver")).waiting[0].step, "waiting_for_checks");
  a.repo.setChecks(d.number, "failure");
  a.advance(20000);
  const f = await get(a, "approver");
  assert.equal(f.waiting[0].step, "checks_failed");
  assert.equal(f.waiting[0].stepLabel, "Safety checks need attention");
});

test("visibility: an editor sees only their own drafts in Waiting and just a COUNT of other people's", async () => {
  const a = api();
  const mine = await draftBy(a, "editor", [heroOp("Molly's")], "Mollys draft");
  const theirs = await draftBy(a, "approver", [{ op: "replace", file: "src/_data/hero.json", path: "/badge", value: "Amelia's badge" }], "Amelias draft");
  await submit(a, "editor", mine);
  await submit(a, "approver", theirs);
  const e = await get(a, "editor");
  assert.deepEqual(e.waiting.map((x) => x.title), ["Mollys draft"]);
  assert.equal(e.othersWaiting, 1);
  assert.equal(JSON.stringify(e).includes("Amelias draft"), false, "an editor never learns the title of someone else's draft");
  assert.deepEqual(e.mine.map((x) => x.title), ["Mollys draft"]);
  const p = await get(a, "approver");
  assert.deepEqual(p.waiting.map((x) => x.title).sort(), ["Amelias draft", "Mollys draft"]);
  assert.equal(p.othersWaiting, 0);
  assert.deepEqual(p.mine.map((x) => x.title), ["Amelias draft"]);
  assert.equal(p.waiting.find((x) => x.title === "Amelias draft").mine, true);
  assert.equal(p.waiting.find((x) => x.title === "Amelias draft").step, "waiting_for_approval", "your own draft is never ready for YOU to publish");
});

test("unsubmitted drafts are not waiting for anyone", async () => {
  const a = api();
  await draftBy(a, "editor");
  assert.deepEqual((await get(a, "approver")).waiting, []);
});

test("live: the newest published change, 'settling' for STUDIO_SETTLING_MINUTES, then plain 'live'", async () => {
  const a = api({ env: { STUDIO_SETTLING_MINUTES: "5" } });
  const d = await draftBy(a, "editor");
  await submit(a, "editor", d);
  assert.equal((await publish(a, "approver", d)).status, 200);
  a.advance(16000);
  let b = await get(a, "editor");
  assert.equal(b.live.title, "Review me");
  assert.equal(b.live.settling, true);
  assert.equal(b.live.by.name, "Molly");
  assert.match(b.live.sha, /^[0-9a-f]{40}$/);
  a.advance(6 * 60 * 1000);
  b = await get(a, "editor");
  assert.equal(b.live.settling, false);
  assert.deepEqual(b.waiting, [], "a published draft leaves the waiting list");
});

test("restored: a merged revert draft shows in Restored recently, newest first", async () => {
  const a = api();
  const d = await draftBy(a, "editor");
  await submit(a, "editor", d);
  assert.equal((await publish(a, "approver", d)).status, 200);
  const n = (await a.call("editor", "GET", "/v1/history")).json.items[0].number;
  const rs = await a.call("editor", "POST", "/v1/history/" + n + "/restore", { onConflict: "abort", idempotencyKey: uuid() });
  assert.equal(rs.status, 201, rs.text);
  await submit(a, "editor", rs.json.draft);
  assert.equal((await publish(a, "approver", rs.json.draft)).status, 200);
  a.advance(20000);
  const b = await get(a, "approver");
  assert.equal(b.restored.length, 1);
  assert.equal(b.restored[0].step, "restored");
  assert.equal(b.restored[0].stepLabel, "Restored");
  assert.match(b.restored[0].title, /^Restore: undo/);
  assert.equal(b.live.title, b.restored[0].title, "the restore is also the newest live change");
});

test("cached for 15 seconds per role and person; a write shows after the cache expires", async () => {
  const a = api();
  let lists = 0;
  const orig = a.deps.git.listPrs.bind(a.deps.git);
  a.deps.git.listPrs = async (x) => { lists += 1; return orig(x); };
  await get(a, "editor");
  const once = lists;
  await get(a, "editor");
  assert.equal(lists, once, "second call within 15 s is served from the cache");
  await get(a, "approver");
  assert.ok(lists > once, "another role has its own entry");
  const d = await draftBy(a, "editor");
  assert.equal((await get(a, "editor")).mine.length, 0, "still the cached picture");
  a.advance(16000);
  assert.equal((await get(a, "editor")).mine.length, 1);
  assert.ok(d);
});

test("any upstream failure is a 502, never a partial board", async () => {
  const a = api();
  a.deps.git.listMerged = async () => { throw new Error("GitHub is down"); };
  const r = await a.call("editor", "GET", "/v1/board");
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "upstream_error");
  assert.equal(JSON.stringify(r.json).includes("GitHub is down"), false);
  assert.equal(r.json.live, undefined);
});

test("board needs a signed-in person and never writes", async () => {
  const a = api();
  assert.equal((await a.call(null, "GET", "/v1/board")).status, 401);
  const writes = [];
  for (const m of ["commitFiles", "createBranch", "resetBranch", "openPr", "updatePr", "markReady", "closePr", "deleteBranch", "merge"]) {
    const o = a.deps.git[m].bind(a.deps.git);
    a.deps.git[m] = (...x) => { writes.push(m); return o(...x); };
  }
  await get(a, "editor");
  await get(a, "approver");
  assert.deepEqual(writes, []);
});
