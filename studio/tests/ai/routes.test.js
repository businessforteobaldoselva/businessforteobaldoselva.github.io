"use strict";
// The three AI routes through the real handler: roles, CSRF, bodies, limits, budget, idempotency, the audit trail.
const test = require("node:test");
const assert = require("node:assert/strict");
const { replayApi, body, rec, patchOf, ch, rep, HERO, uuid, strip, makeApi, AI_ENV } = require("./helpers");
const { createMemoryBudget } = require("../../api/ai/budget");
const shapes = require("../../api/ai/shapes");

const REQ = { mode: "edit", instruction: "make the hero shorter and warmer" };
const GOOD = rec(patchOf("Shorter.", ch("Shorter headline", rep(HERO, "/headlineMain", "Free period products."))));

test("status: editors see it, anonymous callers do not; the shape is the contract", async () => {
  const api = await replayApi(REQ, GOOD);
  const anon = await api.call(null, "GET", "/v1/ai/status");
  assert.equal(anon.status, 401);
  const r = await api.call("editor", "GET", "/v1/ai/status");
  assert.equal(r.status, 200);
  assert.deepEqual(shapes.validateStatus(r.json), []);
  assert.deepEqual([r.json.enabled, r.json.provider, r.json.model, r.json.vision], [true, "replay", "claude-sonnet-5-5", true]);
  assert.equal(r.json.usage.requestsLimit, 150);
});

test("propose and accept: roles, CSRF, content type, body caps, unknown fields", async () => {
  const api = await replayApi(REQ, GOOD);
  const ok = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.deepEqual(shapes.validateProposal(ok.json.proposal), []);
  assert.equal(api.repo.prs.size, 0, "propose writes nothing");
  assert.equal((await api.call(null, "POST", "/v1/ai/propose", body(REQ))).status, 401);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ), { origin: "https://evil.example" })).status, 403);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", JSON.stringify(body(REQ)), { "content-type": "text/plain" })).status, 415);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", "{nope")).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { surprise: 1 }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { context: { refs: [], evil: 1 } }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { idempotencyKey: "nope" }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { mode: "chat" }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { instruction: "x".repeat(1001) }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { instruction: "" }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { instruction: "a\u0000b" }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { context: { refs: ["a.b", "a.b", "a.b", "a.b", "a.b", "a.b"] } }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { context: { page: "../x" } }))).status, 400);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { retryOf: "nope" }))).status, 400);
  const big = await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { feedback: "y".repeat(40000) }));
  assert.equal(big.status, 413);
  const get = await api.call("editor", "GET", "/v1/ai/propose");
  assert.equal(get.status, 400);
});

test("propose: a ref the schema does not know is dropped with a warning, never an error", async () => {
  const api = await replayApi(Object.assign({ context: { refs: ["hero.nothere"] } }, REQ), GOOD);
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { context: { refs: ["hero.nothere", "notAFile.x", "<script>"] } }));
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const w = r.json.proposal.warnings.find((x) => x.code === "ref_ignored");
  assert.ok(w, "a warning says some selections were ignored");
  assert.deepEqual(w.refs, ["notAFile.x", "<script>"]);
});

test("propose: someone else's draft cannot be built on", async () => {
  const api = await replayApi(REQ, GOOD);
  const d = await api.call("approver", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: api.mainSha(), title: "Mine", ops: [rep(HERO, "/badge", "Theirs")], uploads: [] });
  assert.equal(d.status, 201, d.text);
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { draftId: d.json.draft.id }));
  assert.equal(r.status, 404);
});

test("propose repeats are cached per person and key; a different key calls the model again", async () => {
  const api = await replayApi(REQ, GOOD);
  const b = body(REQ);
  const a = await api.call("editor", "POST", "/v1/ai/propose", b);
  const again = await api.call("editor", "POST", "/v1/ai/propose", b);
  assert.deepEqual(again.json, a.json);
  assert.equal(api.deps.ai._budget.snapshot(api.deps.now().toISOString().slice(0, 10)).requests, 1);
  await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(api.deps.ai._budget.snapshot(api.deps.now().toISOString().slice(0, 10)).requests, 2);
  const other = await api.call("approver", "POST", "/v1/ai/propose", b);
  assert.equal(other.status, 200);
  assert.equal(api.deps.ai._budget.snapshot(api.deps.now().toISOString().slice(0, 10)).requests, 3, "another person's request with the same key is not a repeat");
});

test("limits: per person per 10 minutes, per person per day, for everybody per hour; each refusal says when to retry", async () => {
  const mk = (env) => replayApi(REQ, GOOD, { env });
  let api = await mk({ STUDIO_AI_USER_PER_10MIN: "1" });
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ))).status, 200);
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "rate_limited");
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.equal((await api.call("approver", "POST", "/v1/ai/propose", body(REQ))).status, 200);
  api = await mk({ STUDIO_AI_USER_PER_DAY: "1" });
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ))).status, 200);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ))).status, 429);
  api = await mk({ STUDIO_AI_GLOBAL_PER_HOUR: "2" });
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ))).status, 200);
  assert.equal((await api.call("approver", "POST", "/v1/ai/propose", body(REQ))).status, 200);
  assert.equal((await api.call("admin", "POST", "/v1/ai/propose", body(REQ))).status, 429);
  api.advance(3600001);
  assert.equal((await api.call("admin", "POST", "/v1/ai/propose", body(REQ))).status, 200);
});

test("budget: requests and estimated tokens are reserved before the call and settled after; status shows it", async () => {
  const api = await replayApi(REQ, Object.assign({}, GOOD, { usage: { inTok: 300, outTok: 50 } }), { env: { STUDIO_AI_DAILY_REQUESTS: "2" } });
  const day = api.deps.now().toISOString().slice(0, 10);
  await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(api.deps.ai._budget.snapshot(day).tokens, 350, "the estimate was replaced by the real usage");
  await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  const third = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, "ai_budget_exhausted");
  assert.ok(third.json.error.details.resetsAt.endsWith("T00:00:00.000Z"));
  const st = await api.call("editor", "GET", "/v1/ai/status");
  assert.deepEqual([st.json.enabled, st.json.reason, st.json.usage.requestsToday], [false, "budget_exhausted", 2]);
  api.advance(24 * 3600 * 1000);
  assert.equal((await api.call("editor", "POST", "/v1/ai/propose", body(REQ))).status, 200, "a new UTC day starts a new allowance");
});

test("budget store: reserve, settle, release, snapshot", () => {
  const b = createMemoryBudget({ dailyRequests: 2, dailyTokens: 1000 });
  assert.equal(b.reserve("d", 600).ok, true);
  assert.equal(b.reserve("d", 600).ok, false, "tokens over the cap");
  b.settle("d", 600, 100);
  assert.equal(b.snapshot("d").tokens, 100);
  assert.equal(b.reserve("d", 600).ok, true);
  assert.equal(b.reserve("d", 1).ok, false, "requests over the cap");
  b.release("d", 600);
  assert.deepEqual([b.snapshot("d").requests, b.snapshot("d").tokens], [1, 100]);
  assert.equal(b.reserve("e", 1).ok, true, "days are separate");
});

test("a provider failure releases the budget, costs nothing and says so in plain words", async () => {
  const api = await replayApi(REQ, { throw: { code: "unavailable", status: 503 } });
  const day = api.deps.now().toISOString().slice(0, 10);
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "ai_unavailable");
  assert.match(r.json.error.message, /did not answer/);
  assert.equal(api.deps.ai._budget.snapshot(day).requests, 0);
  assert.equal(api.deps.ai._budget.snapshot(day).tokens, 0);
  const e = api.audit.entries.find((x) => x.action === "ai.propose");
  assert.equal(e.outcome, "error");
});

test("an answer with nothing usable is a clear error with the reasons, not an empty proposal", async () => {
  const api = await replayApi(REQ, rec(patchOf("s", ch("Too long", rep(HERO, "/badge", "x".repeat(4000))))));
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "ai_bad_output");
  assert.equal(r.json.error.details.skipped[0].code, "too_long");
  assert.match(r.json.error.details.skipped[0].reason, /limit/);
  assert.equal(api.repo.prs.size, 0);
});

test("alt text with no picture to describe answers without calling the model", async () => {
  let calls = 0;
  const spy = { id: "replay", model: "spy", async complete() { calls += 1; throw new Error("no"); } };
  const api = makeApi({ env: AI_ENV, depsOverrides: { aiProvider: spy } });
  const r = await api.call("editor", "POST", "/v1/ai/propose", { idempotencyKey: uuid(), mode: "alt_text", context: { refs: [], scope: "missing" } });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.json.proposal.kind, "clarify");
  assert.equal(calls, 0);
});

test("retry and feedback: a second try carries the person's note as data", async () => {
  const api = await replayApi(Object.assign({}, REQ, { feedback: "shorter please" }), GOOD);
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { feedback: "shorter please", retryOf: "p_abcdefghijkl" }));
  assert.equal(r.status, 200, r.text.slice(0, 300));
});
