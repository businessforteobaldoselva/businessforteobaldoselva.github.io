"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, fixtures } = require("./load");

function setup() {
  const S = load();
  S.state.config.appUrl = "https://studio.example.test";
  return S;
}
const msg = (origin, source, data) => ({ origin, source, data });
const good = { type: "covered-studio-token", accessToken: "tok.en.value", expiresAt: Math.floor(Date.now() / 1000) + 3600 };

test("a token is accepted only from the login origin AND the popup the overlay opened", () => {
  const S = setup();
  const popup = { close() { this.closed = true; } };
  S.auth._setPopup(popup);
  S.auth._accept(msg("https://evil.test", popup, good));
  assert.equal(S.auth.getToken(), null, "wrong origin");
  S.auth._accept(msg("https://studio.example.test", {}, good));
  assert.equal(S.auth.getToken(), null, "right origin but not our popup");
  S.auth._accept(msg("https://studio.example.test", popup, { type: "other", accessToken: "x" }));
  assert.equal(S.auth.getToken(), null, "wrong type");
  S.auth._accept(msg("https://studio.example.test", popup, { type: "covered-studio-token", accessToken: "x".repeat(9000) }));
  assert.equal(S.auth.getToken(), null, "absurd size");
  S.auth._accept(msg("https://studio.example.test", popup, { type: "covered-studio-token", accessToken: { a: 1 } }));
  assert.equal(S.auth.getToken(), null, "not a string");
  S.auth._accept(msg("https://studio.example.test", popup, good));
  assert.equal(S.auth.getToken(), "tok.en.value");
  assert.equal(popup.closed, true, "popup is closed after use");
});

test("an expired token is not handed out; sign out forgets it", () => {
  const S = setup();
  const popup = {};
  S.auth._setPopup(popup);
  S.auth._accept(msg("https://studio.example.test", popup, { type: "covered-studio-token", accessToken: "old", expiresAt: Math.floor(Date.now() / 1000) - 10 }));
  assert.equal(S.auth.getToken(), null);
  S.auth._setPopup(popup);
  S.auth._accept(msg("https://studio.example.test", popup, good));
  assert.equal(S.auth.getToken(), "tok.en.value");
  S.auth.signOut();
  assert.equal(S.auth.getToken(), null);
});

test("no app url configured means no message is ever accepted", () => {
  const S = load();
  const popup = {};
  S.auth._setPopup(popup);
  S.auth._accept(msg("https://studio.example.test", popup, good));
  assert.equal(S.auth.getToken(), null);
});

test("api client: bearer header, no cookies, JSON errors become human messages, network failure is 'offline'", async () => {
  const calls = [];
  const responses = [
    { ok: true, status: 200, text: '{"hello":1}', headers: { get: () => null } },
    { ok: false, status: 422, text: JSON.stringify({ error: { code: "validation_failed", message: "bad", details: { problems: [{ code: "pattern", file: "src/_data/hero.json", path: "/headlineMain", message: "No." }] } }, requestId: "r1" }), headers: { get: () => null } },
    { ok: false, status: 429, text: JSON.stringify({ error: { code: "rate_limited", message: "slow" } }), headers: { get: (h) => (h === "Retry-After" ? "12" : null) } },
    { ok: false, status: 500, text: "<html>boom</html>", headers: { get: () => null } },
  ];
  const fetch = (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: r.ok, status: r.status, headers: r.headers, text: () => Promise.resolve(r.text) });
  };
  const S = load(null, { fetch, globals: { AbortController } });
  S.api.configure({ base: "http://localhost:8787/", getToken: () => "dev:editor:molly@covered.test" });
  assert.deepEqual(JSON.parse(JSON.stringify(await S.api.get("/v1/me"))), { hello: 1 });
  assert.equal(calls[0].url, "http://localhost:8787/v1/me");
  assert.equal(calls[0].init.headers.Authorization, "Bearer dev:editor:molly@covered.test");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
  await assert.rejects(S.api.post("/v1/drafts", { a: 1 }), (e) => {
    assert.equal(e.status, 422);
    assert.equal(e.code, "validation_failed");
    assert.equal(e.details.problems[0].path, "/headlineMain");
    assert.match(e.userMessage, /marked in red/);
    assert.equal(e.requestId, "r1");
    return true;
  });
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  await assert.rejects(S.api.post("/v1/drafts", {}), (e) => e.code === "rate_limited" && e.retryAfter === 12);
  await assert.rejects(S.api.get("/v1/x"), (e) => e.code === "internal" && /Nothing was lost/.test(e.userMessage));
  await assert.rejects(S.api.get("/v1/x"), (e) => e.code === "offline" && /kept on this device/.test(e.userMessage));
  S.api.configure({ base: "" });
  await assert.rejects(S.api.get("/v1/x"), (e) => e.code === "offline");
});

test("every API error code has a sentence a founder can act on", () => {
  const S = load();
  const codes = ["bad_request", "unauthorized", "not_invited", "forbidden", "not_found", "conflict", "draft_moved", "base_moved", "not_ready", "payload_too_large", "unsupported_media_type", "validation_failed", "rate_limited", "upstream_error", "internal"];
  for (const code of codes) {
    const m = S.api.humanMessage({ code });
    assert.ok(m.length > 20 && !/[{}]/.test(m), code + ": " + m);
  }
  ["checks_pending", "checks_failed", "not_mergeable", "draft_state", "self_publish", "head_changed"].forEach((reason) => assert.ok(S.api.humanMessage({ code: "not_ready", details: { reason } }).length > 20));
});

test("drafts: a 422 is mapped back to the field, a 409 conflict into per-item choices, retry reuses the same key", async () => {
  const fx = fixtures();
  const posted = [];
  let mode = "422";
  const S = load(null, {});
  const sc = S.schemaClient.create(fx.schema);
  const st = S.stagingLib.create({ files: fx.content.files, schemaClient: sc, emit() {} });
  const ev = [];
  const api = {
    post: (p, body) => {
      posted.push(body);
      if (mode === "422") return Promise.reject(Object.assign(new Error("v"), { code: "validation_failed", details: { problems: [{ code: "pattern", file: "src/_data/hero.json", path: "/headlineMain", message: "Not that." }] }, userMessage: "x" }));
      if (mode === "409") return Promise.reject(Object.assign(new Error("c"), { code: "conflict", details: { items: [{ file: "src/_data/hero.json", path: "/headlineMain", expected: "We're covering the UK,", actual: "Theirs" }] }, userMessage: "x" }));
      if (mode === "offline") return Promise.reject(Object.assign(new Error("o"), { code: "offline", userMessage: "x" }));
      return Promise.resolve({ draft: { id: "u--d", state: "draft", headSha: "c".repeat(40) }, changes: [] });
    },
    get: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  };
  const drafts = S.draftsLib.create({ staging: st, api, events: { emit: (e, d) => ev.push(e) }, content: fx.content });
  st.set("hero.headlineMain", "Mine");
  await assert.rejects(drafts.save({}));
  const p = drafts.status().problems[0];
  assert.equal(p.ref, "hero.headlineMain");
  assert.equal(p.message, "Not that.");
  assert.equal(st.get("hero.headlineMain"), "Mine", "nothing lost");
  mode = "409";
  await assert.rejects(drafts.save({}));
  const c = drafts.status().conflicts[0];
  assert.equal(c.ref, "hero.headlineMain");
  assert.equal(c.theirs, "Theirs");
  drafts.keepMine(c);
  assert.equal(drafts.status().conflicts.length, 0);
  mode = "offline";
  await assert.rejects(drafts.save({}));
  assert.equal(drafts.status().offline, true);
  const k1 = posted[posted.length - 1].idempotencyKey;
  mode = "ok";
  const r = await drafts.save({ retry: true });
  assert.equal(posted[posted.length - 1].idempotencyKey, k1, "retry of the same click reuses the key");
  assert.equal(posted[posted.length - 1].ops[0].expect, "Theirs", "after Keep mine the expect is their value");
  assert.equal(drafts.current().id, "u--d");
  assert.equal(st.count(), 0, "saved");
  assert.ok(ev.includes("draft:saved"));
  st.set("hero.badge", "Next");
  await drafts.save({});
  const last = posted[posted.length - 1];
  assert.equal(last.draftId, "u--d");
  assert.equal(last.expectedHeadSha, "c".repeat(40));
  assert.notEqual(last.idempotencyKey, k1, "a new Save click gets a new key");
});

test("drafts: client-side problems block the save before anything is sent", async () => {
  const fx = fixtures();
  const S = load();
  const sc = S.schemaClient.create(fx.schema);
  const st = S.stagingLib.create({ files: fx.content.files, schemaClient: sc, emit() {} });
  let sent = 0;
  const drafts = S.draftsLib.create({ staging: st, api: { post: () => { sent += 1; return Promise.resolve({}); } }, events: { emit() {} }, content: fx.content });
  st.set("hero.headlineMain", "a <b> c");
  await assert.rejects(drafts.save({}), (e) => e.code === "client_invalid");
  assert.equal(sent, 0);
  assert.equal(drafts.status().problems[0].ref, "hero.headlineMain");
});
