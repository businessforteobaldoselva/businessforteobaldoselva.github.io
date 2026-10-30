"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimiter, LIMITS } = require("../../api/ratelimit");
const { createAudit, memorySink, redact } = require("../../api/audit");
const { makeApi, patch, heroOp } = require("../fixtures/harness");

test("limiter: sliding window, per key, Retry-After, bounded memory", () => {
  let t = 0;
  const l = createLimiter({ now: () => t, maxKeys: 50 });
  const rule = { limit: 3, windowMs: 1000 };
  for (let i = 0; i < 3; i += 1) assert.equal(l.take("a", rule).ok, true);
  const no = l.take("a", rule);
  assert.equal(no.ok, false);
  assert.ok(no.retryAfterSec >= 1);
  assert.equal(l.take("b", rule).ok, true); // another key is unaffected
  t = 1001;
  assert.equal(l.take("a", rule).ok, true);
  for (let i = 0; i < 500; i += 1) l.take("k" + i, rule);
  assert.ok(l.size() <= 50, "keys are capped");
  assert.ok(LIMITS.write.limit <= 20 && LIMITS.publish.limit <= 10);
});

test("audit: secrets are redacted, values never logged, IPs are salted hashes", async () => {
  const sink = memorySink();
  const a = createAudit({ sinks: [sink], salt: "s1" });
  await a.write({ action: "draft.create", actor: { id: "u", role: "editor" }, ip: "203.0.113.9", token: "abc", nested: { authorization: "Bearer x", ok: 1 } });
  const e = sink.entries[0];
  assert.equal(e.token, "[redacted]");
  assert.equal(e.nested.authorization, "[redacted]");
  assert.equal(e.nested.ok, 1);
  assert.match(e.ipHash, /^[0-9a-f]{16}$/);
  assert.equal("ip" in e, false);
  assert.ok(!JSON.stringify(e).includes("203.0.113.9"));
  const b = memorySink();
  await createAudit({ sinks: [b], salt: "s2" }).write({ action: "draft.create", ip: "203.0.113.9" });
  assert.notEqual(b.entries[0].ipHash, e.ipHash);
  assert.equal(redact({ pepper: "p", password: "x", note: "y".repeat(400) }, 0).note.length, 303);
});

test("a sink that throws never breaks a request", async () => {
  const a = createAudit({ sinks: [{ write() { throw new Error("down"); } }] });
  await a.write({ action: "draft.create" });
});

test("through the API: the audit trail has the action, actor and paths but never the text that was written", async () => {
  const api = makeApi();
  const secretText = "VERY-DISTINCT-HEADLINE-TEXT";
  const r = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp(secretText)]));
  assert.equal(r.status, 201);
  const entry = api.audit.entries.find((e) => e.action === "draft.create");
  assert.ok(entry, "draft.create audited");
  assert.equal(entry.actor.role, "editor");
  assert.ok(entry.files.includes("src/_data/hero.json"));
  assert.ok(!JSON.stringify(api.audit.entries).includes(secretText));
  assert.ok(!JSON.stringify(api.audit.entries).includes("dev:editor"));
});
