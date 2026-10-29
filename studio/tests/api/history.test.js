"use strict";
// History lists merged data changes; Restore opens a REVERT DRAFT (never touches main) through the same validation.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeApi, patch, heroOp, uuid } = require("../fixtures/harness");
const { invertDiff } = require("../../api/services/history-diff");
const text = require("../../api/services/pr-text");

const dec = new TextDecoder();
const read = (api, ref, p) => dec.decode(api.repo.fileAt(ref, p));

async function publishHero(api, value) {
  const a = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp(value)], { title: "Hero " + value }));
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const s = await api.call("editor", "POST", "/v1/drafts/" + a.json.draft.id + "/submit", { idempotencyKey: uuid() });
  const p = await api.call("approver", "POST", "/v1/drafts/" + a.json.draft.id + "/publish", { expectedHeadSha: s.json.draft.headSha, idempotencyKey: uuid() });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  return a.json.draft;
}

test("history lists Studio, Decap and plain GitHub merges with their authors; non-content PRs are left out", async () => {
  const api = makeApi();
  await publishHero(api, "From Studio");
  const hero = read(api, "main", "src/_data/hero.json");
  api.repo.seedMergedPr({ title: "Content update from Decap", headRef: "cms/hero-edit", authorLogin: "amelia-gh", files: [{ path: "src/_data/hero.json", text: hero.replace("From Studio", "From Decap") }] });
  api.repo.seedMergedPr({ title: "Touch a script", headRef: "feature/x", authorLogin: "dev", files: [{ path: "scripts/x.js", text: "1" }] });
  const r = await api.call("editor", "GET", "/v1/history?limit=10");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const items = r.json.items;
  assert.equal(items.length, 2);
  assert.equal(items[0].author.via, "decap");
  assert.equal(items[0].author.name, "amelia-gh");
  assert.equal(items[1].author.via, "studio");
  assert.equal(items[1].author.name, "Molly");
  assert.ok(items[1].changes.length >= 1);
  assert.ok(items[1].restorable);
  assert.ok(items.every((i) => i.files.every((f) => /^(src\/_data|src\/pages|images)\//.test(f))));
});

test("restore opens a revert draft with the old value; main is untouched until an approver publishes it", async () => {
  const api = makeApi();
  const original = JSON.parse(read(api, "main", "src/_data/hero.json")).headlineMain;
  await publishHero(api, "Changed once");
  const mainAfter = api.mainSha();
  const h = (await api.call("editor", "GET", "/v1/history")).json.items[0];
  const r = await api.call("editor", "POST", "/v1/history/" + h.number + "/restore", { onConflict: "abort", idempotencyKey: uuid() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(api.mainSha(), mainAfter);
  assert.equal(JSON.parse(read(api, r.json.draft.branch, "src/_data/hero.json")).headlineMain, original);
  const pr = api.repo.prs.get(r.json.draft.number);
  assert.ok(pr.labels.has("studio-revert") && pr.labels.has("studio-draft"));
  assert.equal(text.parseMarker(pr.body).revertOf, h.number);
  // the revert goes live like any draft; History then shows it as a revert of the first
  const s = await api.call("editor", "POST", "/v1/drafts/" + r.json.draft.id + "/submit", { idempotencyKey: uuid() });
  assert.equal((await api.call("approver", "POST", "/v1/drafts/" + r.json.draft.id + "/publish", { expectedHeadSha: s.json.draft.headSha, idempotencyKey: uuid() })).status, 200);
  assert.equal(JSON.parse(read(api, "main", "src/_data/hero.json")).headlineMain, original);
  const again = (await api.call("editor", "GET", "/v1/history")).json.items[0];
  assert.equal(again.revertOf, h.number);
});

test("restore after the value changed again: abort is a 409 conflict, skip leaves it and says so", async () => {
  const api = makeApi();
  await publishHero(api, "First");
  await publishHero(api, "Second");
  const items = (await api.call("editor", "GET", "/v1/history")).json.items;
  const first = items.find((i) => /First/.test(i.title));
  const abort = await api.call("editor", "POST", "/v1/history/" + first.number + "/restore", { onConflict: "abort", idempotencyKey: uuid() });
  assert.equal(abort.status, 409);
  assert.equal(abort.json.error.code, "conflict");
  assert.equal(api.repo.prs.size, 2);
  const skip = await api.call("editor", "POST", "/v1/history/" + first.number + "/restore", { onConflict: "skip", idempotencyKey: uuid() });
  assert.equal(skip.status, 409); // nothing left to undo
});

test("restore: validation of the request, unknown PRs, non-content PRs and the replay", async () => {
  const api = makeApi();
  await publishHero(api, "Again");
  const n = (await api.call("editor", "GET", "/v1/history")).json.items[0].number;
  const bad = (b) => api.call("editor", "POST", "/v1/history/" + n + "/restore", b);
  assert.equal((await bad({ onConflict: "overwrite", idempotencyKey: uuid() })).status, 400);
  assert.equal((await bad({ onConflict: "abort" })).status, 400);
  assert.equal((await bad({ onConflict: "abort", idempotencyKey: uuid(), extra: 1 })).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/history/9999/restore", { onConflict: "abort", idempotencyKey: uuid() })).status, 404);
  const code = api.repo.seedMergedPr({ title: "code", files: [{ path: "scripts/x.js", text: "1" }] });
  assert.equal((await api.call("editor", "POST", "/v1/history/" + code + "/restore", { onConflict: "abort", idempotencyKey: uuid() })).status, 404);
  const key = uuid();
  const a = await bad({ onConflict: "abort", idempotencyKey: key });
  const b = await bad({ onConflict: "abort", idempotencyKey: key });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.json.draft.id, b.json.draft.id);
});

test("invertDiff: reorders, hides, item add/remove and scalar changes invert to ops with expect", () => {
  const before = { sections: [{ type: "a", enabled: true }, { type: "b", enabled: true }, { type: "c", enabled: true }], title: "T", items: [{ q: "1" }] };
  const after = { sections: [{ type: "b", enabled: true }, { type: "a", enabled: false }, { type: "c", enabled: true }], title: "T2", items: [{ q: "1" }, { q: "2" }] };
  const ops = invertDiff("src/_data/x.json", before, after);
  assert.ok(ops.length > 0);
  for (const o of ops) assert.ok(o.file === "src/_data/x.json" && typeof o.path === "string");
  assert.ok(ops.some((o) => o.path === "/title" && o.value === "T" && o.expect === "T2"));
  assert.ok(ops.every((o) => o.op === "remove" || o.op === "move" || "value" in o));
});

test("roles: an unknown person has no access to history", async () => {
  const api = makeApi();
  assert.equal((await api.call("dev:editor:nobody@covered.test", "GET", "/v1/history")).status, 403);
  assert.equal((await api.call(null, "GET", "/v1/history")).status, 401);
});
