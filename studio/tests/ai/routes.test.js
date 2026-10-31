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

test("alt text sends the picture from the repository (never from the browser) unless vision is off", async () => {
  const seen = [];
  const spy = { id: "replay", model: "spy", async complete(req) { seen.push(req); return { toolInputs: [{ kind: "clarify", summary: "s", question: "q?" }], text: "", usage: { inTok: 1, outTok: 1 }, stopReason: "tool_use", model: "spy" }; } };
  const { snapshot } = require("../fixtures/repo");
  const files = snapshot();
  files.set("images/story-1-spot.jpg", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
  const ask = (env) => {
    const api = makeApi({ files: new Map(files), env: Object.assign({}, AI_ENV, env || {}), depsOverrides: { aiProvider: spy } });
    return api.call("editor", "POST", "/v1/ai/propose", { idempotencyKey: uuid(), mode: "alt_text", context: { refs: ["how.story.0.src"] } });
  };
  const r = await ask();
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(seen[0].images.length, 1);
  assert.equal(seen[0].images[0].mediaType, "image/jpeg");
  assert.equal(Buffer.from(seen[0].images[0].dataBase64, "base64").length, 11);
  assert.match(seen[0].user, /"pictures":\[\{"n":1,"ref":"how\.story\.0\.alt"/);
  assert.equal(seen[0].tool.name, "submit_result");
  assert.equal(seen[0].tool.inputSchema.properties.kind.enum.indexOf("needs_code"), -1, "alt text mode cannot ask for code");
  await ask({ STUDIO_AI_VISION: "0" });
  assert.equal(seen[1].images.length, 0);
  assert.ok(seen[1].deadlineAtMs > Date.now() && seen[1].deadlineAtMs <= Date.now() + 25000, "a total deadline is passed to the provider");
  assert.equal(seen[1].maxTokens, 6000);
});

test("a refusal's wait reaches the panel: the real 429 shape carries the seconds and the browser may read them", async () => {
  globalThis.window = globalThis.window || {};
  const V = require("../../overlay/ext/ai-view.js");
  const api = await replayApi(REQ, GOOD, { env: { STUDIO_AI_USER_PER_10MIN: "1" } });
  await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(r.status, 429);
  const sec = r.json.error.details.retryAfterSec;
  assert.ok(sec > 120, "a 10 minute window leaves minutes to wait, not the 30 second default");
  assert.equal(Number(r.headers.get("retry-after")), sec);
  assert.match(r.headers.get("access-control-expose-headers") || "", /Retry-After/i, "without this the browser hides the header from the overlay");
  // the overlay's client builds its error from the body (details) and, when it may read it, the header
  const asClient = { code: r.json.error.code, details: r.json.error.details, retryAfter: 0 };
  assert.match(V.errorInfo(asClient).message, new RegExp("Try again in " + Math.ceil(sec / 60) + " minutes"));
});

test("a double submit while the first call is still running makes ONE model call and uses ONE slot", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  const key = await require("../../api/ai/proposal").replayKey("edit", REQ.instruction, "", [], false, "default");
  const inner = { id: "replay", model: "claude-sonnet-5-5", async complete() { calls += 1; await gate; return GOOD; } };
  const api = makeApi({ env: AI_ENV, depsOverrides: { aiProvider: inner, aiRecordings: { [key]: GOOD } } });
  const b = body(REQ);
  const first = api.call("editor", "POST", "/v1/ai/propose", b);
  const rest = [1, 2, 3, 4].map(() => api.call("editor", "POST", "/v1/ai/propose", b));
  await new Promise((r) => setTimeout(r, 30));
  release();
  const all = await Promise.all([first].concat(rest));
  assert.deepEqual(all.map((x) => x.status), [200, 200, 200, 200, 200]);
  assert.equal(calls, 1, "five identical submits, one model call");
  assert.equal(new Set(all.map((x) => x.json.proposal.id)).size, 1);
  assert.equal(api.deps.ai._budget.snapshot(api.deps.now().toISOString().slice(0, 10)).requests, 1, "one slot of the daily allowance");
  // the same key with another draft or selection is another request, not a replay of the first
  const other = await api.call("editor", "POST", "/v1/ai/propose", Object.assign({}, b, { context: { refs: ["hero.headlineMain"] } }));
  assert.equal(other.status, 200);
  assert.equal(calls, 2, "a different selection with the same key must not be served the first answer");
});
