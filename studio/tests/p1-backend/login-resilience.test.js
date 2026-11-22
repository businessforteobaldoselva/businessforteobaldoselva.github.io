"use strict";
// The sign-in page when Supabase is paused or down (PHASE1-DESIGN 4.2): ask the API's health route first, show ONE plain sentence in
// the live region, keep the form usable, never show anything a server sent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const login = require("../../login/login.js");

const DOWN = "Studio cannot reach its sign-in service right now. Your edits on this page are safe. Try again in a minute.";
const PAUSED = "Sign-in is paused because the Studio database has been idle. An admin can wake it from the Supabase dashboard (Restore project).";

function el() {
  const h = {};
  return { hidden: false, textContent: "", value: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return { focus() {} }; }, addEventListener(t, f) { h[t] = f; }, fire(t, ev) { return h[t](ev || { preventDefault() {} }); } };
}
// `net` decides what each address answers: { health, otp, verify } -> a function (url) -> {status, body} | throws
function fakeWin(net) {
  const ids = {}; ["studio-login", "status", "step-email", "step-code", "step-done", "step-refused", "form-email", "email", "form-code", "code", "back"].forEach((i) => (ids[i] = el()));
  const calls = [];
  const win = {
    document: { getElementById: (i) => ids[i] },
    location: { search: "?origin=https%3A%2F%2Fp.example", hash: "", pathname: "/" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URLSearchParams, setTimeout: () => 0, close() {},
    opener: { closed: false, postMessage() {} },
    addEventListener() {}, removeEventListener() {},
    fetch: async (url) => {
      calls.push(String(url));
      const reply = (status, d) => ({ ok: status >= 200 && status < 300, status, json: async () => d, text: async () => (d === undefined ? "" : JSON.stringify(d)) });
      if (String(url).endsWith("config.json")) return reply(200, { allowedOrigins: ["https://p.example"], api: "https://api.example" });
      if (String(url).includes("/v1/preview-config")) return reply(200, { auth: { mode: "supabase", supabaseUrl: "https://sb.example", supabaseAnonKey: "k" } });
      if (String(url).endsWith("/v1/health")) { const r = net.health(); return reply(r.status, r.body); }
      if (String(url).endsWith("/auth/v1/otp")) { const r = net.otp ? net.otp() : { status: 200, body: {} }; return reply(r.status, r.body); }
      if (String(url).endsWith("/auth/v1/verify")) { const r = net.verify ? net.verify() : { status: 400, body: { msg: "bad" } }; return reply(r.status, r.body); }
      return reply(404, {});
    },
  };
  return { win, ids, calls };
}
const tick = () => new Promise((r) => setImmediate(r));
async function submitEmail(f) {
  login.boot(f.win);
  await tick(); await tick(); await tick();
  f.ids.email.value = "molly@covered.test";
  f.ids["form-email"].fire("submit");
  for (let i = 0; i < 8; i += 1) await tick();
}
const health = (state) => ({ status: 200, body: { ok: state === "ok", services: { auth: { state }, git: { state: "ok" }, ai: { state: "off" } } } });

test("a paused database: the plain sentence, no e-mail is sent, the status line is the live region", async () => {
  const f = fakeWin({ health: () => health("paused") });
  await submitEmail(f);
  assert.equal(f.ids.status.textContent, PAUSED);
  assert.equal(f.ids.status.attrs["data-bad"], "1");
  assert.equal(f.calls.some((c) => c.endsWith("/auth/v1/otp")), false, "no point asking a paused service to send a code");
  assert.equal(f.ids["step-email"].hidden, false, "the form stays usable");
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "login", "index.html"), "utf8");
  assert.match(html, /id="status"[^>]*aria-live="polite"/);
});

test("an unreachable service: the plain sentence, in the same live region", async () => {
  const f = fakeWin({ health: () => health("unreachable") });
  await submitEmail(f);
  assert.equal(f.ids.status.textContent, DOWN);
  assert.equal(f.calls.some((c) => c.endsWith("/auth/v1/otp")), false);
});

test("a healthy answer, a missing health route or an error from it: carry on and send the code", async () => {
  for (const h of [() => health("ok"), () => ({ status: 404, body: {} }), () => { throw new TypeError("offline"); }, () => ({ status: 200, body: "<html>" })]) {
    const f = fakeWin({ health: h });
    await submitEmail(f);
    assert.equal(f.calls.some((c) => c.endsWith("/auth/v1/otp")), true);
    assert.match(f.ids.status.textContent, /We emailed molly@covered\.test/);
  }
});

test("a server that sends its own words is never shown: only the page's fixed sentences appear", async () => {
  const f = fakeWin({ health: () => ({ status: 200, body: { services: { auth: { state: "unreachable", message: "<img src=x onerror=alert(1)> secret-project-ref.supabase.co" } } } }) });
  await submitEmail(f);
  assert.equal(f.ids.status.textContent, DOWN);
  assert.equal(f.ids.status.textContent.includes("secret"), false);
});

test("Supabase failing AFTER the health check (5xx or the network): the plain sentence, not 'check the address'", async () => {
  for (const otp of [() => ({ status: 503, body: { msg: "upstream timeout" } }), () => { throw new TypeError("fetch failed"); }]) {
    const f = fakeWin({ health: () => health("ok"), otp });
    await submitEmail(f);
    assert.equal(f.ids.status.textContent, DOWN);
  }
});

test("a 4xx from Supabase is still the person's own mistake and keeps its own words", async () => {
  let f = fakeWin({ health: () => health("ok"), otp: () => ({ status: 422, body: { msg: "Signups not allowed" } }) });
  await submitEmail(f);
  assert.match(f.ids.status.textContent, /only invited people can sign in/);
  f = fakeWin({ health: () => health("ok"), otp: () => ({ status: 429, body: { msg: "rate" } }) });
  await submitEmail(f);
  assert.match(f.ids.status.textContent, /Too many sign-in emails/);
});

test("entering the code while the service is down says so too; a wrong code is still a wrong code", async () => {
  let f = fakeWin({ health: () => health("ok"), verify: () => ({ status: 502, body: {} }) });
  await submitEmail(f);
  f.ids.code.value = "123456";
  f.ids["form-code"].fire("submit");
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(f.ids.status.textContent, DOWN);
  f = fakeWin({ health: () => health("ok"), verify: () => ({ status: 400, body: { msg: "Token has expired or is invalid" } }) });
  await submitEmail(f);
  f.ids.code.value = "123456";
  f.ids["form-code"].fire("submit");
  for (let i = 0; i < 6; i += 1) await tick();
  assert.match(f.ids.status.textContent, /That code didn't work/);
});

test("the page's source uses textContent only for what it shows and still has no third-party address", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "login", "login.js"), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const urls = (code.match(/https?:\/\/[^\s"'`)]+/g) || []).filter((u) => !/^https?:\/\/(localhost|127\.0\.0\.1|\.\.\.)/.test(u));
  assert.deepEqual(urls, [], "no address is hard-coded in the login script");
});
