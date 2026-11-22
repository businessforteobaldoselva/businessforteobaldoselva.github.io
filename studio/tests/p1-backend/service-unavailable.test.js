"use strict";
// When the sign-in service (Supabase) is down, people get ONE plain sentence and a 503, not "something went wrong" and not
// "please sign in again" (PHASE1-DESIGN 4.2). A bad token is still a 401.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeApi, T } = require("../fixtures/harness");
const { AuthError } = require("../../api/providers/auth/interface");
const { STATUS } = require("../../api/errors");

const SENTENCE = "Studio cannot reach its sign-in service right now. Your edits on this page are safe. Try again in a minute.";

test("the error code exists and is a 503", () => { assert.equal(STATUS.service_unavailable, 503); });

test("the people list (roles) being unreachable is service_unavailable, with the plain sentence", async () => {
  const roles = { async getRole() { const e = new Error("roles store unreachable"); e.code = "upstream"; throw e; }, async listPeople() { return []; }, async upsertPerson() { return null; } };
  const api = makeApi({ roles });
  const r = await api.call("editor", "GET", "/v1/me");
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "service_unavailable");
  assert.equal(r.json.error.message, SENTENCE);
  assert.deepEqual(r.json.error.details, { service: "auth" });
  assert.ok(r.json.requestId);
});

test("the signing keys being unreachable is service_unavailable and does not count as a failed sign-in", async () => {
  let down = true;
  const auth = { async verify(token) { if (down) throw new AuthError("keys_unavailable", "cannot fetch the signing keys"); return { userId: "11111111-1111-4111-8111-111111111111", email: "molly@covered.test", name: "Molly" }; } };
  const api = makeApi({ depsOverrides: { auth } });
  for (let i = 0; i < 30; i += 1) {
    const r = await api.call("some-token-value-that-is-long-enough", "GET", "/v1/me");
    assert.equal(r.status, 503, "attempt " + i);
    assert.equal(r.json.error.code, "service_unavailable");
  }
  down = false;
  // 30 outages in a row did not lock this address out of signing in: the bad-auth limiter never saw them
  const ok = await api.call("some-token-value-that-is-long-enough", "GET", "/v1/me");
  assert.notEqual(ok.status, 429);
});

test("a BAD token is still a plain 401 'please sign in again'", async () => {
  const auth = { async verify() { throw new AuthError("bad_signature", "signature"); } };
  const api = makeApi({ depsOverrides: { auth } });
  const r = await api.call("some-token-value-that-is-long-enough", "GET", "/v1/me");
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, "unauthorized");
  assert.equal((await api.call(null, "GET", "/v1/me")).status, 401);
});

test("a person who is simply not invited still gets not_invited, not an outage message", async () => {
  const api = makeApi();
  const r = await api.call("dev:editor:stranger@nowhere.test", "GET", "/v1/me");
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "not_invited");
  assert.ok(T.editor);
});
