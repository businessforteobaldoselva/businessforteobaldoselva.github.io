"use strict";
// The sign-in email carries a link, not a code: the link lands on the login page in a new tab, which stores the refresh token;
// the window that asked for the email (still open, same origin) finishes the sign-in by itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const login = require("../../login/login.js");

function el() {
  const h = {};
  return { hidden: false, textContent: "", value: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return { focus() {} }; }, addEventListener(t, f) { h[t] = f; }, fire(t, ev) { return h[t](ev || { preventDefault() {} }); } };
}
function fakeWin(hash, stored) {
  const ids = {}; ["studio-login", "status", "step-email", "step-code", "step-done", "step-refused", "form-email", "email", "form-code", "code", "back"].forEach((i) => (ids[i] = el()));
  const ls = Object.assign({}, stored || {});
  const listeners = [];
  const posted = [];
  const calls = [];
  const win = {
    document: { getElementById: (i) => ids[i] },
    location: { search: "?origin=https%3A%2F%2Fp.example", hash: hash || "", pathname: "/" },
    history: { replaceState(_s, _t, url) { win.location.hash = ""; win.replaced = url; } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
    URLSearchParams, setTimeout: () => 0, close() {},
    opener: { closed: false, postMessage: (m, o) => posted.push([m, o]) },
    addEventListener: (t, f) => listeners.push([t, f]),
    removeEventListener: (t, f) => { const i = listeners.findIndex((x) => x[0] === t && x[1] === f); if (i >= 0) listeners.splice(i, 1); },
    fetch: async (url, init) => {
      calls.push(String(url));
      const ok = (d) => ({ ok: true, text: async () => JSON.stringify(d) });
      if (String(url).endsWith("config.json")) return ok({ allowedOrigins: ["https://p.example"], api: "https://api.example", previewOriginTemplate: "https://deploy-preview-{n}--s.netlify.app" });
      if (String(url).includes("/v1/preview-config")) return ok({ auth: { mode: "supabase", supabaseUrl: "https://sb.example", supabaseAnonKey: "k" } });
      if (String(url).endsWith("/auth/v1/otp")) return ok({});
      if (String(url).includes("/auth/v1/token")) return ok({ access_token: "a.b.c", refresh_token: "newrefresh1", expires_in: 3600 });
      return { ok: false, status: 404, text: async () => "" };
    },
  };
  return { win, ids, ls, listeners, posted, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

test("landing from the email link stores the refresh token, clears the address, and tells the person to go back", async () => {
  const f = fakeWin("#access_token=aaa.bbb.ccc&refresh_token=abcdef123456&expires_in=3600&token_type=bearer&type=magiclink");
  f.win.location.search = "";
  login.boot(f.win);
  assert.equal(f.ls["covered.studio.login.rt"], "abcdef123456");
  assert.equal(f.win.location.hash, "", "the token must not stay in the address bar");
  assert.equal(f.ids["step-done"].hidden, false);
  assert.match(f.ids.status.textContent, /Go back to the Studio window/);
  assert.equal(f.calls.length, 0, "the landing tab must not call anything or hand the token to anyone");
  assert.equal(f.posted.length, 0);
});

test("an expired or reused link says so and stores nothing", () => {
  const f = fakeWin("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
  f.win.location.search = "";
  login.boot(f.win);
  assert.equal(Object.keys(f.ls).length, 0);
  assert.equal(f.ids["step-refused"].hidden, false);
  assert.match(f.ids.status.textContent, /expired/);
});

test("a refresh token with odd characters is not stored", () => {
  const f = fakeWin("#access_token=a.b.c&refresh_token=%3Cscript%3E");
  f.win.location.search = "";
  login.boot(f.win);
  assert.equal(Object.keys(f.ls).length, 0);
});

test("the waiting window finishes the sign-in when the other tab stores the token, and delivers it to the preview only", async () => {
  const f = fakeWin("");
  login.boot(f.win);
  await tick(); await tick(); await tick(); await tick();
  f.ids.email.value = "Teo@Example.com";
  f.ids["form-email"].fire("submit");
  await tick(); await tick();
  assert.equal(f.ids["step-code"].hidden, false);
  assert.match(f.ids.status.textContent, /Click the link in that email/);
  const st = f.listeners.find((x) => x[0] === "storage");
  assert.ok(st, "waiting for the other tab");
  st[1]({ key: "something.else", newValue: "abcdef123456" });
  assert.equal(f.posted.length, 0, "other keys are ignored");
  st[1]({ key: "covered.studio.login.rt", newValue: "abcdef123456" });
  await tick(); await tick(); await tick();
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0][1], "https://p.example", "only to the origin that passed the checks");
  assert.equal(f.posted[0][0].accessToken, "a.b.c");
});

test("a rate-limited email request says so instead of blaming the address", async () => {
  const f = fakeWin("");
  const real = f.win.fetch;
  f.win.fetch = async (url, init) => (String(url).endsWith("/auth/v1/otp") ? { ok: false, status: 429, text: async () => JSON.stringify({ msg: "email rate limit exceeded" }) } : real(url, init));
  login.boot(f.win);
  await tick(); await tick(); await tick(); await tick();
  f.ids.email.value = "teo@example.com";
  f.ids["form-email"].fire("submit");
  await tick(); await tick(); await tick();
  assert.match(f.ids.status.textContent, /Too many sign-in emails/);
});
