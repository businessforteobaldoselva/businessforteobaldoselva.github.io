"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAiConfig } = require("../../api/ai/config");
const { loadConfig } = require("../../api/config");
const { makeApi } = require("../fixtures/harness");

const DEV = { STUDIO_DEV: "1", STUDIO_ENV: "development" };

test("AI help is off unless STUDIO_AI_ENABLED is 1 or true (kill switch default)", () => {
  for (const v of [undefined, "", "0", "false", "no", "yes", "on", "TRUE ", "2"]) assert.equal(loadAiConfig({ STUDIO_AI_ENABLED: v }).enabled, false, String(v));
  assert.equal(loadAiConfig({ STUDIO_AI_ENABLED: "1" }).enabled, true);
  assert.equal(loadAiConfig({ STUDIO_AI_ENABLED: "true" }).enabled, true);
});

test("defaults match the design and numbers are clamped, not trusted", () => {
  const c = loadAiConfig({});
  assert.equal(c.model, "claude-sonnet-5-5");
  assert.equal(c.provider, "anthropic");
  assert.deepEqual([c.maxOutputTokens, c.timeoutMs, c.userPer10Min, c.userPerDay, c.globalPerHour, c.dailyRequests, c.dailyTokens, c.maxBodyBytes, c.maxInputChars], [6000, 25000, 8, 60, 100, 150, 3000000, 16000, 120000]);
  assert.equal(c.vision, true);
  const w = loadAiConfig({ STUDIO_AI_MAX_OUTPUT_TOKENS: "99999999", STUDIO_AI_TIMEOUT_MS: "5", STUDIO_AI_VISION: "0" });
  assert.equal(w.maxOutputTokens, 16000);
  assert.equal(w.timeoutMs, 3000);
  assert.equal(w.vision, false);
  assert.throws(() => loadAiConfig({ STUDIO_AI_USER_PER_DAY: "lots" }), /whole number/);
  assert.throws(() => loadAiConfig({ STUDIO_AI_USER_PER_DAY: "-3" }), /whole number/);
});

test("the model id is validated and the provider is anthropic or replay", () => {
  assert.equal(loadAiConfig({ STUDIO_AI_MODEL: "claude-haiku-4-5" }).model, "claude-haiku-4-5");
  for (const bad of ["x", "Claude Sonnet", "../../etc", "a".repeat(80), "claude/evil"]) assert.throws(() => loadAiConfig({ STUDIO_AI_MODEL: bad }), /model id/);
  assert.throws(() => loadAiConfig({ STUDIO_AI_PROVIDER: "openai" }), /anthropic or replay/);
});

test("the replay provider is refused in production and without STUDIO_DEV", () => {
  assert.throws(() => loadAiConfig({ STUDIO_AI_PROVIDER: "replay" }), /only allowed/);
  assert.throws(() => loadAiConfig({ STUDIO_AI_PROVIDER: "replay", STUDIO_DEV: "1" }), /only allowed/);
  assert.throws(() => loadAiConfig({ STUDIO_AI_PROVIDER: "replay", STUDIO_ENV: "development" }), /only allowed/);
  assert.equal(loadAiConfig(Object.assign({ STUDIO_AI_PROVIDER: "replay" }, DEV)).provider, "replay");
});

test("the Ask Claude address must be https (or loopback)", () => {
  assert.equal(loadAiConfig({ STUDIO_ASK_CLAUDE_URL: "https://example.org/admin/#/collections/requests/new" }).askClaudeUrl, "https://example.org/admin/#/collections/requests/new");
  assert.equal(loadAiConfig({ STUDIO_ASK_CLAUDE_URL: "http://localhost:8080/admin/" }).askClaudeUrl, "http://localhost:8080/admin/");
  for (const bad of ["http://evil.example/", "javascript:alert(1)", "//evil.example/", "ftp://x/"]) assert.throws(() => loadAiConfig({ STUDIO_ASK_CLAUDE_URL: bad }), /https/);
});

test("the API key is never part of the configuration object", () => {
  const KEY = "sk" + "-ant-TESTKEY-1234567890abcdef";
  const env = Object.assign({ STUDIO_AI_ENABLED: "1", STUDIO_AI_API_KEY: KEY }, DEV, { STUDIO_ALLOWED_ORIGINS: "http://localhost:8080" });
  assert.equal(JSON.stringify(loadAiConfig(env)).includes(KEY), false);
  assert.equal(JSON.stringify(loadConfig(env)).includes(KEY), false);
  const api = makeApi({ env: { STUDIO_AI_ENABLED: "1", STUDIO_AI_API_KEY: KEY } });
  assert.equal(JSON.stringify(api.deps.config).includes(KEY), false);
  assert.equal(Object.keys(loadAiConfig(env)).some((k) => /key/i.test(k)), false);
});

test("AI help is off for a deployment that sets nothing: loadConfig stays valid and status says why", async () => {
  const api = makeApi();
  const r = await api.call("editor", "GET", "/v1/ai/status");
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.enabled, r.json.reason, r.json.provider, r.json.model], [false, "disabled", "none", null]);
  const k = makeApi({ env: { STUDIO_AI_ENABLED: "1" } }); // enabled, but no key
  const s = await k.call("editor", "GET", "/v1/ai/status");
  assert.deepEqual([s.json.enabled, s.json.reason], [false, "no_key"]);
});

test("in production, AI help needs a secret audit salt (instruction hashes must not be guessable)", () => {
  const prod = { STUDIO_ENV: "production", GITHUB_REPO: "covered/website", STUDIO_ALLOWED_ORIGINS: "https://example.org", SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY: "pem" };
  const on = Object.assign({ STUDIO_AI_ENABLED: "1" }, prod);
  assert.throws(() => loadConfig(on), /STUDIO_AUDIT_SALT is required/);
  assert.doesNotThrow(() => loadConfig(Object.assign({ STUDIO_AUDIT_SALT: "a-long-random-secret" }, on)));
  assert.doesNotThrow(() => loadConfig(prod), "with AI switched off nothing new is demanded");
});
