"use strict";
// AI usage through the real handler (PHASE1-DESIGN 10): counting rules, the meter, estimate, recent, status, and the shared store
// wired into the AI service. No network: the replay provider and a fake PostgREST.
const test = require("node:test");
const assert = require("node:assert/strict");
const { replayApi, body, rec, patchOf, ch, rep, HERO, uuid, strip, makeApi, AI_ENV } = require("../ai/helpers");
const shapes = require("../../api/ai/shapes");
const p1 = require("../../api/shapes/phase1");
const { labelFor } = require("../../api/services/ai-usage");
const { createFakePostgrest } = require("./fake-postgrest");

const REQ = { mode: "edit", instruction: "make the hero shorter and warmer" };
const GOOD = rec(patchOf("Shorter.", ch("Shorter headline", rep(HERO, "/headlineMain", "Free period products."))), { usage: { inTok: 300, outTok: 50 } });
const MARKUP = rec(patchOf("s", ch("Bold", rep(HERO, "/badge", "<b>bold</b>"))), { usage: { inTok: 1000, outTok: 100 } });
const TOO_LONG = rec(patchOf("s", ch("Too long", rep(HERO, "/badge", "x".repeat(4000)))), { usage: { inTok: 1000, outTok: 100 } });
const CLARIFY = { toolInputs: [{ kind: "clarify", summary: "ok", question: "Which part?" }], usage: { inTok: 200, outTok: 20 }, stopReason: "tool_use" };
const DAY = (api) => api.deps.now().toISOString().slice(0, 10);
const snap = async (api, who) => api.deps.ai._budget.snapshot({ day: DAY(api), userId: who || "" });

test("status: the Phase 1 usage keys are there, valid, and the store is named", async () => {
  const api = await replayApi(REQ, GOOD);
  await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  const st = await api.call("editor", "GET", "/v1/ai/status");
  assert.deepEqual(shapes.validateStatus(st.json), []);
  const u = st.json.usage;
  assert.deepEqual([u.tokensToday, u.tokensLimit, u.store, u.requestsToday, u.yourRequestsToday], [350, 3000000, "memory", 1, 1]);
  assert.equal(typeof u.pctOfDay, "number");
  assert.equal((await api.call("approver", "GET", "/v1/ai/status")).json.usage.yourRequestsToday, 0, "the person's own count is their own");
  assert.equal((await api.call("approver", "GET", "/v1/ai/status")).json.usage.requestsToday, 1);
});

test("an answer the person can use carries the meter, counts one request and the real tokens; a repeat is free", async () => {
  const api = await replayApi(REQ, GOOD);
  const b = body(REQ);
  const r = await api.call("editor", "POST", "/v1/ai/propose", b);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(shapes.validateProposal(r.json.proposal), []);
  assert.deepEqual(p1.validateAiMeter(r.json.proposal.meter), []);
  assert.deepEqual([r.json.proposal.meter.usedTokens, r.json.proposal.meter.counted, r.json.proposal.meter.requestsLeftToday], [350, true, 149]);
  const again = await api.call("editor", "POST", "/v1/ai/propose", b);
  assert.deepEqual(again.json.proposal.meter, r.json.proposal.meter, "a retry with the same key is the same answer");
  const s = (await snap(api)).global;
  assert.deepEqual([s.requests, s.tokens], [1, 350]);
});

test("a clarifying question is a usable answer and counts", async () => {
  const api = await replayApi(REQ, CLARIFY);
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(r.json.proposal.kind, "clarify");
  assert.equal(r.json.proposal.meter.counted, true);
  assert.equal((await snap(api)).global.requests, 1);
});

for (const [label, recorded, code] of [["markup in a value (Gate 1)", MARKUP, "markup_in_value"], ["nothing usable (too long)", TOO_LONG, "none_usable"]]) {
  test("rejected proposal - " + label + ": the REQUEST is given back, the real tokens stay counted, the error carries the meter", async () => {
    const api = await replayApi(REQ, recorded);
    const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, "ai_bad_output");
    const meter = r.json.error.details.meter;
    assert.deepEqual(p1.validateAiMeter(meter), []);
    assert.deepEqual([meter.counted, meter.usedTokens], [false, 1100]);
    assert.equal(meter.requestsLeftToday, 150, "the person still has all 150 (it did not count)");
    const s = await snap(api, "x");
    assert.deepEqual([s.global.requests, s.global.tokens], [0, 1100], "money was spent, so the meter matches the provider's bill");
    const st = await api.call("editor", "GET", "/v1/ai/status");
    assert.deepEqual([st.json.usage.requestsToday, st.json.usage.yourRequestsToday, st.json.usage.tokensToday], [0, 0, 1100]);
    const recent = await api.call("editor", "GET", "/v1/ai/recent");
    assert.deepEqual(recent.json.items.map((x) => x.kind), ["rejected"]);
    assert.equal(recent.json.items[0].tokens, 1100);
    assert.ok(code);
  });
}

test("rejected answers do not eat the person's daily suggestions", async () => {
  const key = (instruction) => require("../../api/ai/proposal").replayKey("edit", instruction, "", [], false, "default");
  const api = makeApi({ env: Object.assign({}, AI_ENV, { STUDIO_AI_USER_PER_DAY: "1" }), depsOverrides: { aiRecordings: { [await key("bad one")]: MARKUP, [await key("good one")]: GOOD } } });
  const ask = (instruction) => api.call("editor", "POST", "/v1/ai/propose", { idempotencyKey: uuid(), mode: "edit", instruction, context: { refs: [] } });
  assert.equal((await ask("bad one")).status, 502);
  assert.equal((await ask("bad one")).status, 502);
  assert.equal((await ask("good one")).status, 200, "still has its one suggestion for today");
  const over = await ask("good one");
  assert.equal(over.status, 429);
  assert.equal(over.json.error.code, "rate_limited");
  assert.ok(Number(over.headers.get("retry-after")) >= 1);
  assert.match(over.json.error.message, /come back at midnight/);
  api.advance(24 * 3600 * 1000);
  assert.equal((await ask("good one")).status, 200, "a new UTC day");
});

test("a provider failure counts nothing at all and leaves no 'recent' row", async () => {
  const api = await replayApi(REQ, { throw: { code: "unavailable", status: 503 } });
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal(r.status, 502);
  const s = await snap(api);
  assert.deepEqual([s.global.requests, s.global.tokens], [0, 0]);
  assert.deepEqual((await api.call("editor", "GET", "/v1/ai/recent")).json.items, []);
});

// ---- estimate ------------------------------------------------------------------------------------------------------------------------
test("estimate: builds the prompt, calls NO model, reserves and counts NOTHING, and says what it would cost", async () => {
  let calls = 0;
  const spy = { id: "replay", model: "spy", async complete() { calls += 1; throw new Error("the estimate must not call the model"); } };
  const api = makeApi({ env: AI_ENV, depsOverrides: { aiProvider: spy } });
  const before = await snap(api);
  const r = await api.call("editor", "POST", "/v1/ai/estimate", { mode: "edit", instruction: "make the hero shorter", context: { refs: [] } });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(p1.validateAiEstimate(r.json), []);
  const e = r.json.estimate;
  assert.equal(calls, 0);
  assert.equal(e.maxOutputTokens, 6000);
  assert.equal(e.estTokens, e.inputTokens + 6000);
  assert.equal(e.typicalTokens, null, "nothing to average yet");
  assert.equal(e.requestsLeftToday, 150);
  assert.equal(e.yourRequestsLeftToday, 1000, "the test environment allows 1000 a day");
  assert.equal(e.wouldFit, true);
  assert.match(e.label, /^(About \d+(\.\d)?%|Less than 0\.1%) of today's AI allowance\.$/);
  assert.deepEqual(await snap(api), before, "nothing reserved or counted");
  assert.equal(api.audit.entries.filter((x) => /^ai\./.test(x.action)).length, 0);
  // an idempotency key is optional, repeats are fine, and they are free
  for (let i = 0; i < 3; i += 1) assert.equal((await api.call("editor", "POST", "/v1/ai/estimate", { mode: "edit", instruction: "x", context: { refs: [] } })).status, 200);
  assert.deepEqual(await snap(api), before);
});

test("estimate: typical = the mean of the person's recent requests; wouldFit turns false when the day cannot hold it", async () => {
  const api = await replayApi(REQ, GOOD, { env: { STUDIO_AI_DAILY_TOKENS: "200000" } });
  await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  const r = await api.call("editor", "POST", "/v1/ai/estimate", Object.assign({}, REQ, { context: { refs: [] } }));
  assert.equal(r.json.estimate.typicalTokens, 350);
  assert.equal(r.json.estimate.requestsLeftToday, 149);
  assert.equal(r.json.estimate.yourRequestsLeftToday, 999);
  assert.equal(r.json.estimate.wouldFit, true, "200000 - 350 left, far more than needed");
  const small = await replayApi(REQ, GOOD, { env: { STUDIO_AI_DAILY_TOKENS: "5000" } });
  const tight = await small.call("editor", "POST", "/v1/ai/estimate", Object.assign({}, REQ, { context: { refs: [] } }));
  assert.equal(tight.json.estimate.wouldFit, false, "the maximum answer alone is over the day's tokens");
  const none = await replayApi(REQ, GOOD, { env: { STUDIO_AI_DAILY_REQUESTS: "1" } });
  await none.call("editor", "POST", "/v1/ai/propose", body(REQ));
  assert.equal((await none.call("editor", "POST", "/v1/ai/estimate", Object.assign({}, REQ, { context: { refs: [] } }))).json.estimate.wouldFit, false, "no requests left");
});

test("estimate: roles, off switch, bad bodies, someone else's draft", async () => {
  const on = makeApi({ env: AI_ENV });
  assert.equal((await on.call(null, "POST", "/v1/ai/estimate", { mode: "edit", instruction: "x" })).status, 401);
  assert.equal((await on.call("editor", "POST", "/v1/ai/estimate", { mode: "edit", instruction: "x" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await on.call("editor", "POST", "/v1/ai/estimate", "{nope")).status, 400);
  assert.equal((await on.call("editor", "POST", "/v1/ai/estimate", { mode: "chat", instruction: "x" })).status, 400);
  assert.equal((await on.call("editor", "POST", "/v1/ai/estimate", [1])).status, 400);
  assert.equal((await on.call("editor", "POST", "/v1/ai/estimate", { mode: "edit", instruction: "x", surprise: 1 })).status, 400);
  const off = makeApi();
  const r = await off.call("editor", "POST", "/v1/ai/estimate", { mode: "edit", instruction: "x" });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "ai_disabled");
  const d = await on.call("approver", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: on.mainSha(), title: "Mine", ops: [rep(HERO, "/badge", "Theirs")], uploads: [] });
  assert.equal((await on.call("editor", "POST", "/v1/ai/estimate", { mode: "edit", instruction: "x", draftId: d.json.draft.id })).status, 404);
});

test("the estimate label: one decimal below 10%, whole numbers above, a floor at 0.1%", () => {
  assert.equal(labelFor(0), "Less than 0.1% of today's AI allowance.");
  assert.equal(labelFor(0.09), "Less than 0.1% of today's AI allowance.");
  assert.equal(labelFor(0.4), "About 0.4% of today's AI allowance.");
  assert.equal(labelFor(9.94), "About 9.9% of today's AI allowance.");
  assert.equal(labelFor(10), "About 10% of today's AI allowance.");
  assert.equal(labelFor(37.6), "About 38% of today's AI allowance.");
  assert.equal(labelFor(100), "About 100% of today's AI allowance.");
});

// ---- recent --------------------------------------------------------------------------------------------------------------------------
test("recent: the person's own requests, newest first, accepted/total and the pull request once accepted; never instruction text", async () => {
  const api = await replayApi(REQ, GOOD);
  const p = (await api.call("editor", "POST", "/v1/ai/propose", body(REQ))).json.proposal;
  let r = await api.call("editor", "GET", "/v1/ai/recent");
  assert.equal(r.status, 200);
  assert.deepEqual(p1.validateAiRecent(r.json), []);
  assert.deepEqual([r.json.store, r.json.items.length, r.json.items[0].id, r.json.items[0].kind, r.json.items[0].accepted, r.json.items[0].prNumber, r.json.items[0].prUrl], ["memory", 1, p.id, "patch", null, null, null]);
  const acc = await api.call("editor", "POST", "/v1/ai/accept", { idempotencyKey: uuid(), proposal: strip(p, REQ.instruction), accept: ["c1"] });
  assert.equal(acc.status, 201, acc.text.slice(0, 300));
  r = await api.call("editor", "GET", "/v1/ai/recent");
  const it = r.json.items[0];
  assert.deepEqual([it.accepted, it.total, it.prNumber], [1, 1, acc.json.draft.number]);
  assert.match(it.prUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/);
  assert.equal(JSON.stringify(r.json).includes("hero shorter"), false, "no instruction text is ever stored or returned");
  assert.deepEqual((await api.call("approver", "GET", "/v1/ai/recent")).json.items, [], "nobody sees another person's list");
  assert.equal((await api.call(null, "GET", "/v1/ai/recent")).status, 401);
});

test("recent: at most 20 items", async () => {
  const api = await replayApi(REQ, CLARIFY);
  for (let i = 0; i < 25; i += 1) await api.call("editor", "POST", "/v1/ai/propose", body(REQ));
  const r = await api.call("editor", "GET", "/v1/ai/recent");
  assert.equal(r.json.items.length, 1, "identical clarifying answers share one proposal id, so they are one row");
  const many = await replayApi(REQ, GOOD);
  const memory = many.deps.ai._budget;
  for (let i = 0; i < 25; i += 1) await memory.recordRequest({ userId: "u", id: "p_" + String(i).padStart(12, "0"), mode: "edit", kind: "patch", tokens: 1 });
  assert.equal((await memory.recent({ userId: "u", limit: 100 })).length, 20);
});

// ---- the shared store, wired into the AI service ----------------------------------------------------------------------------
async function sharedService(over) {
  const api = makeApi({ env: AI_ENV });
  const fake = createFakePostgrest();
  const spy = { id: "replay", model: "claude-sonnet-5-5", async complete() { return JSON.parse(JSON.stringify(GOOD)); } };
  const config = Object.assign({}, api.deps.config, { dev: false, aiBudgetStore: "supabase", supabase: { url: "https://x.supabase.co", anonKey: "pub", jwtMode: "jwks" } });
  const deps = Object.assign({}, api.deps, { config, fetch: fake.fetch });
  const { createAiService } = require("../../api/ai");
  const svc = createAiService(Object.assign({ deps, provider: spy, config: config.ai }, over || {}));
  const ids = require("../../api/services/ids");
  const ctxFor = async (uid, token) => ({ deps, requestId: "r-1", token, role: "editor", user: { id: uid, email: "x@covered.test", name: "X" }, userKey: await ids.userKey(uid) });
  return { api, fake, svc, deps, ctxFor, molly: "11111111-1111-4111-8111-111111111111", amelia: "22222222-2222-4222-8222-222222222222" };
}

test("shared store: propose reserves and settles in the SHARED counters with the person's own token; status says supabase", async () => {
  const s = await sharedService();
  const ctx = await s.ctxFor(s.molly, "tok-molly");
  const out = await s.svc.propose(ctx, body(REQ));
  assert.equal(out.proposal.meter.counted, true);
  assert.deepEqual(s.fake.calls.filter((c) => c !== "studio_ai_snapshot2"), ["studio_ai_reserve2", "studio_ai_settle2", "studio_ai_record"]);
  const st = s.fake.state();
  assert.deepEqual([...st.global.values()], [{ requests: 1, tokens: 350 }]);
  assert.equal([...st.requests.values()][0].user_id, s.molly);
  const status = await s.svc.status(ctx);
  assert.deepEqual(shapes.validateStatus(status), []);
  assert.deepEqual([status.usage.store, status.usage.requestsToday, status.usage.tokensToday, status.usage.yourRequestsToday], ["supabase", 1, 350, 1]);
  // a second person's request lands in the SAME global counter, in their own per-person row
  await s.svc.propose(await s.ctxFor(s.amelia, "tok-amelia"), body(REQ));
  assert.equal((await s.svc.status(ctx)).usage.requestsToday, 2);
  assert.equal((await s.svc.status(ctx)).usage.yourRequestsToday, 1);
  const rec = await s.svc.recent(ctx);
  assert.deepEqual([rec.store, rec.items.length], ["supabase", 1]);
});

test("shared store down: the request still works from memory, usage.store_fallback is logged, status says memory, and caps still hold", async () => {
  const s = await sharedService();
  s.fake.fail = "404"; // 003 was never applied
  const ctx = await s.ctxFor(s.molly, "tok-molly");
  const out = await s.svc.propose(ctx, body(REQ));
  assert.equal(out.proposal.meter.counted, true);
  assert.equal(s.api.audit.entries.filter((e) => e.action === "usage.store_fallback").length, 1);
  assert.equal(s.fake.state().global.size, 0, "nothing reached the shared store");
  const status = await s.svc.status(ctx);
  assert.equal(status.usage.store, "memory");
  assert.equal(status.usage.requestsToday, 1);
  assert.equal(JSON.stringify(s.api.audit.entries).includes("tok-molly"), false, "the token is never logged");
});

test("shared store: the global request cap is enforced by the database function", async () => {
  const s = await sharedService();
  s.svc._budget; // (memory store exists but is not used while the shared one answers)
  const ctx = await s.ctxFor(s.molly, "tok-molly");
  const cfg = s.deps.config.ai;
  const tight = Object.assign({}, cfg, { dailyRequests: 2, userPerDay: 99 });
  const { createAiService } = require("../../api/ai");
  const svc = createAiService({ deps: Object.assign({}, s.deps, { config: Object.assign({}, s.deps.config, { ai: tight }) }), provider: { id: "replay", model: "m", async complete() { return JSON.parse(JSON.stringify(GOOD)); } }, config: tight });
  await svc.propose(ctx, body(REQ));
  await svc.propose(ctx, body(REQ));
  await assert.rejects(() => svc.propose(ctx, body(REQ)), (e) => e.code === "ai_budget_exhausted" && !!e.details.resetsAt);
});

test("health: the AI line names the store and never fails the service", async () => {
  const api = makeApi({ env: AI_ENV });
  const h = await api.deps.ai.health();
  assert.deepEqual(h, { state: "ready", store: "memory", message: null });
});
