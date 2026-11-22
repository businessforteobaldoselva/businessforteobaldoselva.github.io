"use strict";
// The AI usage store (PHASE1-DESIGN 10.1): one contract, run on BOTH implementations (memory, and the Supabase one against a fake
// PostgREST that models 003_studio_ai_usage.sql), then the fallback rules: a failing shared store degrades to memory, never to
// "unlimited".
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryBudget, selectStore, StoreUnavailable } = require("../../api/ai/budget");
const { createSupabaseBudget } = require("../../api/providers/usage/supabase-budget");
const { createFakePostgrest } = require("./fake-postgrest");

const LIMITS = { dailyRequests: 10, dailyTokens: 100000, userPerDay: 4 };
const CAPS = { requests: 10, tokens: 100000, userRequests: 4 };
const DAY = "2026-11-22";
const TOKENS = { u1: "tok-molly", u2: "tok-amelia" };

// -> { for(userName) -> store }
function implementations() {
  return [
    ["memory", () => { const m = createMemoryBudget(LIMITS); return { forUser: () => m }; }, (user) => user],
    ["supabase", () => {
      const fake = createFakePostgrest();
      const deps = { config: { supabase: { url: "https://x.supabase.co", anonKey: "pub" } }, fetch: fake.fetch };
      return { fake, forUser: (n) => createSupabaseBudget({ deps, token: TOKENS[n], limits: LIMITS }) };
    }, (user) => user],
  ];
}

for (const [name, make] of implementations()) {
  test("store contract (" + name + "): the seven methods and the kind", () => {
    const s = make().forUser("u1");
    assert.equal(s.kind, name);
    for (const m of ["reserve", "settle", "release", "snapshot", "recordRequest", "attachAccept", "recent"]) assert.equal(typeof s[m], "function", m);
  });

  test("store contract (" + name + "): reserve respects the global request cap, the token cap and the person's own cap", async () => {
    const h = make();
    const a = h.forUser("u1");
    for (let i = 0; i < 4; i += 1) assert.equal((await a.reserve({ day: DAY, tokens: 100, userId: "u1", caps: CAPS })).ok, true);
    const fifth = await a.reserve({ day: DAY, tokens: 100, userId: "u1", caps: CAPS });
    assert.deepEqual([fifth.ok, fifth.reason], [false, "user_requests"]);
    assert.deepEqual([fifth.user.requests, fifth.global.requests], [4, 4], "a refused call changes nothing (the global bump is undone)");
    const b = h.forUser("u2");
    assert.equal((await b.reserve({ day: DAY, tokens: 100, userId: "u2", caps: CAPS })).ok, true, "another person is not affected");
    const big = await b.reserve({ day: DAY, tokens: 99999, userId: "u2", caps: CAPS });
    assert.deepEqual([big.ok, big.reason], [false, "global_tokens"]);
    for (let i = 0; i < 5; i += 1) await b.reserve({ day: DAY, tokens: 1, userId: "u2", caps: { requests: 10, tokens: 100000, userRequests: 99 } });
    const last = await b.reserve({ day: DAY, tokens: 1, userId: "u2", caps: { requests: 10, tokens: 100000, userRequests: 99 } });
    assert.deepEqual([last.ok, last.reason], [false, "global_requests"]);
    assert.equal((await a.reserve({ day: "2026-11-23", tokens: 1, userId: "u1", caps: CAPS })).ok, true, "a new day starts fresh");
  });

  test("store contract (" + name + "): settle keeps the REAL tokens and can give the request back; release gives everything back", async () => {
    const s = make().forUser("u1");
    await s.reserve({ day: DAY, tokens: 1000, userId: "u1", caps: CAPS });
    await s.settle({ day: DAY, reserved: 1000, actual: 300, userId: "u1", countRequest: true });
    let snap = await s.snapshot({ day: DAY, userId: "u1" });
    assert.deepEqual([snap.global.requests, snap.global.tokens, snap.user.requests, snap.user.tokens], [1, 300, 1, 300]);
    await s.reserve({ day: DAY, tokens: 1000, userId: "u1", caps: CAPS });
    await s.settle({ day: DAY, reserved: 1000, actual: 500, userId: "u1", countRequest: false });
    snap = await s.snapshot({ day: DAY, userId: "u1" });
    assert.deepEqual([snap.global.requests, snap.global.tokens, snap.user.requests, snap.user.tokens], [1, 800, 1, 800], "request given back, tokens spent");
    await s.reserve({ day: DAY, tokens: 700, userId: "u1", caps: CAPS });
    await s.release({ day: DAY, reserved: 700, userId: "u1" });
    snap = await s.snapshot({ day: DAY, userId: "u1" });
    assert.deepEqual([snap.global.requests, snap.global.tokens], [1, 800]);
    await s.settle({ day: DAY, reserved: 99999, actual: 0, userId: "u1", countRequest: false });
    snap = await s.snapshot({ day: DAY, userId: "u1" });
    assert.ok(snap.global.tokens >= 0 && snap.global.requests >= 0, "counters never go negative");
  });

  test("store contract (" + name + "): snapshot carries the limits", async () => {
    const s = make().forUser("u1");
    const snap = await s.snapshot({ day: DAY, userId: "u1" });
    assert.deepEqual([snap.global.requestsLimit, snap.global.tokensLimit, snap.user.requestsLimit], [10, 100000, 4]);
  });

  test("store contract (" + name + "): 50 concurrent reserves against a cap of 10 let exactly 10 through", async () => {
    const h = make();
    const stores = [h.forUser("u1"), h.forUser("u2")];
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => stores[i % 2].reserve({ day: DAY, tokens: 10, userId: i % 2 ? "u2" : "u1", caps: { requests: 10, tokens: 100000, userRequests: 100 } })));
    assert.equal(results.filter((r) => r.ok).length, 10);
    const snap = await stores[0].snapshot({ day: DAY, userId: "u1" });
    assert.equal(snap.global.requests, 10);
    assert.equal(snap.global.tokens, 100);
  });

  test("store contract (" + name + "): recent requests are the person's own, newest first, at most 20, and accept is attached", async () => {
    const h = make();
    const a = h.forUser("u1");
    const b = h.forUser("u2");
    for (let i = 0; i < 25; i += 1) {
      await a.recordRequest({ userId: "u1", id: "p_" + String(i).padStart(12, "a"), mode: "edit", kind: "patch", tokens: 100 + i });
      await new Promise((r) => setTimeout(r, 2));
    }
    await b.recordRequest({ userId: "u2", id: "p_bbbbbbbbbbbb", mode: "edit", kind: "clarify", tokens: 5 });
    const mine = await a.recent({ userId: "u1", limit: 50 });
    assert.equal(mine.length, 20);
    assert.equal(mine[0].id, "p_" + String(24).padStart(12, "a"), "newest first");
    assert.ok(mine.every((x) => x.id !== "p_bbbbbbbbbbbb"), "nobody sees another person's rows");
    await a.attachAccept({ userId: "u1", id: mine[0].id, accepted: 2, total: 3, prNumber: 58 });
    const again = await a.recent({ userId: "u1", limit: 1 });
    assert.deepEqual([again[0].accepted, again[0].total, again[0].prNumber], [2, 3, 58]);
    await b.attachAccept({ userId: "u2", id: mine[0].id, accepted: 9, total: 9, prNumber: 1 });
    assert.equal((await a.recent({ userId: "u1", limit: 1 }))[0].accepted, 2, "another person cannot attach to my row");
    assert.deepEqual(Object.keys(mine[0]).sort(), ["accepted", "at", "id", "kind", "mode", "prNumber", "tokens", "total"]);
  });
}

test("the Supabase store sends the CALLER'S token and only the public key, to /rest/v1/rpc/<function>", async () => {
  const seen = [];
  const fake = createFakePostgrest();
  const deps = { config: { supabase: { url: "https://x.supabase.co/", anonKey: "pub-key" } }, fetch: (u, i) => { seen.push([u, i]); return fake.fetch(u, i); } };
  const s = createSupabaseBudget({ deps, token: "tok-molly", limits: LIMITS });
  await s.reserve({ day: DAY, tokens: 5, userId: "ignored", caps: CAPS });
  assert.equal(seen[0][0], "https://x.supabase.co/rest/v1/rpc/studio_ai_reserve2");
  assert.equal(seen[0][1].headers.Authorization, "Bearer tok-molly");
  assert.equal(seen[0][1].headers.apikey, "pub-key");
  assert.equal(JSON.parse(seen[0][1].body).p_user_max_requests, 4);
  assert.equal(JSON.stringify(seen[0][1]).includes("service_role"), false);
});

test("a person who is not active is refused by the database function (403), which the store reports as unavailable", async () => {
  const fake = createFakePostgrest();
  const deps = { config: { supabase: { url: "https://x.supabase.co", anonKey: "pub" } }, fetch: fake.fetch };
  const s = createSupabaseBudget({ deps, token: "tok-gone", limits: LIMITS });
  await assert.rejects(() => s.reserve({ day: DAY, tokens: 1, userId: "x", caps: CAPS }), (e) => e instanceof StoreUnavailable && e.message === "http_403");
});

// ---- fallback ------------------------------------------------------------------------------------------------------------------
for (const mode of ["404", "500", "network", "401"]) {
  test("fallback (" + mode + "): the request is served by the memory store, one usage.store_fallback line, and the caps STILL apply", async () => {
    const fake = createFakePostgrest();
    fake.fail = mode;
    const deps = { config: { supabase: { url: "https://x.supabase.co", anonKey: "pub" } }, fetch: fake.fetch };
    const memory = createMemoryBudget(LIMITS);
    const logs = [];
    let clock = 1000000;
    const shared = {};
    const mk = () => selectStore({ memory, supabase: createSupabaseBudget({ deps, token: "tok-molly", limits: LIMITS }), shared, now: () => new Date(clock), log: (x) => logs.push(x) });
    let store = mk();
    const r = await store.reserve({ day: DAY, tokens: 10, userId: "u1", caps: CAPS });
    assert.equal(r.ok, true);
    assert.equal(store.kind, "memory", "the store says it fell back");
    assert.equal(logs.length, 1);
    assert.match(logs[0].why, mode === "network" ? /network/ : new RegExp("http_" + mode));
    // not asked again for a minute: no new log, no new network call
    const before = fake.calls.length;
    for (let i = 0; i < 3; i += 1) assert.equal((await mk().reserve({ day: DAY, tokens: 10, userId: "u1", caps: CAPS })).ok, true);
    assert.equal(logs.length, 1);
    assert.equal(fake.calls.length, before);
    // the 4th request of the day by this person is refused: NOT unlimited
    const fifth = await mk().reserve({ day: DAY, tokens: 10, userId: "u1", caps: CAPS });
    assert.deepEqual([fifth.ok, fifth.reason], [false, "user_requests"]);
    // a minute later it tries the shared store again (still failing: one more log line)
    clock += 61000;
    await mk().snapshot({ day: DAY, userId: "u1" });
    assert.equal(logs.length, 2);
    // and once the database is back, it is used again
    fake.fail = null;
    clock += 61000;
    store = mk();
    const back = await store.reserve({ day: DAY, tokens: 10, userId: "u1", caps: CAPS });
    assert.equal(back.ok, true);
    assert.equal(store.kind, "supabase");
  });
}

test("fallback: settle and release go back to the counters the reservation used, even if the shared store came back in between", async () => {
  const fake = createFakePostgrest();
  fake.fail = "500";
  const deps = { config: { supabase: { url: "https://x.supabase.co", anonKey: "pub" } }, fetch: fake.fetch };
  const memory = createMemoryBudget(LIMITS);
  const store = selectStore({ memory, supabase: createSupabaseBudget({ deps, token: "tok-molly", limits: LIMITS }), shared: {}, now: () => new Date(0), log: () => {} });
  await store.reserve({ day: DAY, tokens: 1000, userId: "u1", caps: CAPS });
  fake.fail = null; // the database recovers while the model is thinking
  await store.settle({ day: DAY, reserved: 1000, actual: 200, userId: "u1", countRequest: true });
  assert.equal(fake.calls.length, 1, "only the failed reserve ever reached the shared store");
  const snap = await memory.snapshot({ day: DAY, userId: "u1" });
  assert.deepEqual([snap.global.requests, snap.global.tokens], [1, 200]);
});

test("a programming error in the shared store is NOT swallowed as a fallback", async () => {
  const bad = { reserve: async () => { throw new TypeError("a bug"); } };
  const store = selectStore({ memory: createMemoryBudget(LIMITS), supabase: bad, shared: {}, now: () => new Date(0), log: () => {} });
  await assert.rejects(() => store.reserve({ day: DAY, tokens: 1, userId: "u", caps: CAPS }), TypeError);
});
