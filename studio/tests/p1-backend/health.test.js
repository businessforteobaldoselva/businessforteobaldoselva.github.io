"use strict";
// GET /v1/health (PHASE1-DESIGN 4.1): every state, the timeouts, the cache, the shared in-flight check, and what must never leak.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHealth, MESSAGES } = require("../../api/services/health");
const { validateHealth } = require("../../api/shapes/phase1");
const { makeApi } = require("../fixtures/harness");

const SECRET_URL = "https://secret-project-ref.supabase.co";
const SECRET_KEY = "anon-key-should-never-appear";

// a health checker over fake dependencies; `clock` can be advanced, `perf` jumps to model a slow answer
function make(over) {
  const o = over || {};
  const clock = { t: Date.parse("2026-11-22T10:00:00Z") };
  const perf = { t: 0 };
  const calls = { fetch: 0, git: 0 };
  const deps = {
    config: { dev: false, supabase: { url: SECRET_URL, anonKey: SECRET_KEY }, health: Object.assign({ ttlSeconds: 30, timeoutMs: 500 }, o.health || {}) },
    now: () => new Date(clock.t),
    perfNow: () => perf.t,
    fetch: async (url, init) => {
      calls.fetch += 1;
      calls.last = { url, init };
      if (o.fetch) return o.fetch(url, init, perf);
      return { status: 200, text: async () => '{"name":"GoTrue"}' };
    },
    git: { getBaseBranch: () => "main", getHead: async () => { calls.git += 1; if (o.git) return o.git(perf); return { sha: "a".repeat(40) }; } },
    ai: { health: async () => (o.ai || { state: "ready", store: "memory", message: null }) },
  };
  return { health: createHealth(deps), deps, clock, perf, calls };
}
const valid = (h) => assert.deepEqual(validateHealth(h), [], JSON.stringify(h));

test("everything fine: ok, no message, the shape validates", async () => {
  const m = make();
  const h = await m.health.check();
  valid(h);
  assert.equal(h.ok, true);
  assert.equal(h.cached, false);
  assert.equal(h.message, null);
  assert.deepEqual([h.services.auth.state, h.services.git.state, h.services.ai.state], ["ok", "ok", "ready"]);
  assert.equal(m.calls.last.url, SECRET_URL + "/auth/v1/health", "one GET to the sign-in service's health address");
  assert.equal(m.calls.last.init.headers.apikey, SECRET_KEY, "with the public key");
});

test("slow answers are still ok", async () => {
  const m = make({ fetch: async (u, i, perf) => { perf.t += 2000; return { status: 200, text: async () => "{}" }; }, git: async (perf) => { perf.t += 2000; return { sha: "b".repeat(40) }; } });
  const h = await m.health.check();
  valid(h);
  assert.equal(h.ok, true);
  assert.deepEqual([h.services.auth.state, h.services.git.state], ["slow", "slow"]);
});

test("paused: status 540 or a body that says paused", async () => {
  for (const f of [async () => ({ status: 540, text: async () => "" }), async () => ({ status: 200, text: async () => '{"message":"Project is PAUSED"}' })]) {
    const h = await make({ fetch: f }).health.check();
    valid(h);
    assert.equal(h.ok, false);
    assert.equal(h.services.auth.state, "paused");
    assert.equal(h.message, MESSAGES.paused);
    assert.match(h.message, /Restore project/);
  }
});

test("unreachable: a network error, a 5xx, a hang past the timeout", async () => {
  const cases = [async () => { throw new Error("getaddrinfo ENOTFOUND secret-project-ref.supabase.co"); }, async () => ({ status: 503, text: async () => "boom " + SECRET_URL }), () => new Promise(() => {})];
  for (const f of cases) {
    const h = await make({ fetch: f }).health.check();
    valid(h);
    assert.equal(h.ok, false);
    assert.equal(h.services.auth.state, "unreachable");
    assert.equal(h.message, MESSAGES.authDown);
  }
});

test("GitHub failing or hanging is its own plain message; AI state never changes ok", async () => {
  let h = await make({ git: async () => { throw new Error("GitHub HTTP 502 on GET /repos/owner/secret-repo"); } }).health.check();
  valid(h);
  assert.deepEqual([h.ok, h.services.git.state, h.message], [false, "unreachable", MESSAGES.gitDown]);
  h = await make({ git: () => new Promise(() => {}) }).health.check();
  assert.equal(h.services.git.state, "unreachable");
  h = await make({ ai: { state: "budget_exhausted", store: "supabase", message: "Today's AI allowance is used up." } }).health.check();
  valid(h);
  assert.equal(h.ok, true, "a used-up AI allowance does not make the service unhealthy");
  assert.equal(h.message, null);
  h = await make({ fetch: async () => { throw new Error("x"); }, git: async () => { throw new Error("y"); } }).health.check();
  assert.equal(h.message, MESSAGES.authDown, "the first message that needs a human is the sign-in one");
});

test("nothing from upstream leaks: no address, key, error text", async () => {
  const sets = [
    make({ fetch: async () => { throw new Error("connect ECONNREFUSED " + SECRET_URL + " " + SECRET_KEY); }, git: async () => { throw new Error("token ghs_SECRET"); } }),
    make({ fetch: async () => ({ status: 500, text: async () => SECRET_KEY }) }),
    make({ fetch: async () => ({ status: 540, text: async () => SECRET_KEY }) }),
  ];
  for (const m of sets) {
    const text = JSON.stringify(await m.health.check());
    for (const bad of [SECRET_URL, "secret-project-ref", SECRET_KEY, "ghs_SECRET", "ECONNREFUSED", "secret-repo"]) assert.equal(text.includes(bad), false, bad + " leaked: " + text);
  }
});

test("the answer is cached for the TTL; hammering costs nothing upstream; then it refreshes", async () => {
  const m = make();
  const first = await m.health.check();
  for (let i = 0; i < 20; i += 1) {
    const again = await m.health.check();
    assert.equal(again.cached, true);
    assert.equal(again.checkedAt, first.checkedAt);
  }
  assert.equal(m.calls.fetch, 1);
  assert.equal(m.calls.git, 1);
  m.clock.t += 31000;
  const fresh = await m.health.check();
  assert.equal(fresh.cached, false);
  assert.equal(m.calls.fetch, 2);
});

test("concurrent callers share ONE in-flight check", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = make({ fetch: async () => { await gate; return { status: 200, text: async () => "{}" }; } });
  const all = Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => m.health.check()));
  await new Promise((r) => setImmediate(r));
  release();
  const out = await all;
  assert.equal(m.calls.fetch, 1);
  assert.equal(m.calls.git, 1);
  out.forEach(valid);
});

test("the settings are clamped: a tiny TTL or timeout cannot turn the route into a hammer", async () => {
  const { loadConfig, ConfigError } = require("../../api/config");
  const base = { STUDIO_ENV: "development", STUDIO_DEV: "1" };
  assert.deepEqual(loadConfig(Object.assign({ STUDIO_HEALTH_TTL_SECONDS: "1", STUDIO_HEALTH_TIMEOUT_MS: "10" }, base)).health, { ttlSeconds: 5, timeoutMs: 500 });
  assert.deepEqual(loadConfig(Object.assign({ STUDIO_HEALTH_TTL_SECONDS: "9999", STUDIO_HEALTH_TIMEOUT_MS: "999999" }, base)).health, { ttlSeconds: 300, timeoutMs: 10000 });
  assert.deepEqual(loadConfig(base).health, { ttlSeconds: 30, timeoutMs: 3000 });
  assert.throws(() => loadConfig(Object.assign({ STUDIO_HEALTH_TTL_SECONDS: "soon" }, base)), ConfigError);
  assert.throws(() => loadConfig(Object.assign({ STUDIO_HEALTH_TIMEOUT_MS: "-5" }, base)), ConfigError);
});

test("the route: anonymous, no token needed, validates, and never writes an audit entry", async () => {
  const api = makeApi();
  const r = await api.call(null, "GET", "/v1/health");
  assert.equal(r.status, 200, r.text);
  valid(r.json);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.services.ai.state, "off");
  assert.equal(api.audit.entries.length, 0, "it is polled: no audit entry per call");
  const again = await api.call(null, "GET", "/v1/health");
  assert.equal(again.json.cached, true);
  assert.equal((await api.call(null, "POST", "/v1/health", {})).status, 400, "GET only");
});

test("the route is rate limited like every anonymous route", async () => {
  const api = makeApi();
  let limited = 0;
  for (let i = 0; i < 400 && !limited; i += 1) if ((await api.call(null, "GET", "/v1/health")).status === 429) limited = i;
  assert.ok(limited > 0, "a flood of anonymous calls is eventually refused");
});

test("the AI state follows the settings: ready, no_key, budget exhausted", async () => {
  const { AI_ENV } = require("../ai/helpers");
  let api = makeApi({ env: AI_ENV });
  assert.equal((await api.call(null, "GET", "/v1/health")).json.services.ai.state, "ready");
  api = makeApi({ env: { STUDIO_AI_ENABLED: "1" } }); // enabled, but no key: the provider is the disabled one
  assert.equal((await api.call(null, "GET", "/v1/health")).json.services.ai.state, "no_key");
  api = makeApi({ env: Object.assign({}, AI_ENV, { STUDIO_AI_DAILY_REQUESTS: "1" }) });
  await api.deps.ai._budget.reserve({ day: api.deps.now().toISOString().slice(0, 10), tokens: 1, userId: "u", caps: { requests: 1, tokens: 1000, userRequests: 5 } });
  const h = (await api.call(null, "GET", "/v1/health")).json;
  valid(h);
  assert.equal(h.services.ai.state, "budget_exhausted");
  assert.equal(h.ok, true);
});
