"use strict";
// Shared helpers for the real-browser AI panel tests: starts the overlay stub server WITH the deterministic AI demo
// (studio/overlay/dev/ai-demo.js), launches Chrome through puppeteer-core when both exist, signs in as a practice user.
// Without puppeteer-core or Chrome, SKIP is a reason string and the tests skip themselves (never fail).
//   STUDIO_PUPPETEER=<path to puppeteer-core>   STUDIO_CHROME=<path to chrome.exe>   STUDIO_PUPPETEER_DIR=<folder with node_modules>
const fs = require("fs");
const { start } = require("../../../overlay/dev/stub-server.js");

function loadPuppeteer() {
  const tries = [];
  if (process.env.STUDIO_PUPPETEER) tries.push(() => require(process.env.STUDIO_PUPPETEER));
  tries.push(() => require("puppeteer-core"));
  if (process.env.STUDIO_PUPPETEER_DIR) tries.push(() => require(require.resolve("puppeteer-core", { paths: [process.env.STUDIO_PUPPETEER_DIR] })));
  for (const t of tries) { try { return t(); } catch (e) { /* next */ } }
  return null;
}
const CHROME = [process.env.STUDIO_CHROME, process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
const puppeteer = loadPuppeteer();
const chrome = CHROME.find((p) => fs.existsSync(p)) || null;
const SKIP = !puppeteer ? "puppeteer-core is not installed" : !chrome ? "no Chrome/Edge binary found" : false;

async function launch() {
  const stub = await start({ sitePort: 0, apiPort: 0, ai: true });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"] });
  return { stub, browser, close: async () => { await browser.close(); await stub.close(); } };
}

// everything of the overlay lives in one open shadow root
const SHADOW = "document.getElementById('covered-studio').shadowRoot";
async function newPage(env, opts) {
  opts = opts || {};
  env.stub.reset();
  const ctx = await env.browser.createBrowserContext();
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    window.__pwned = 0;
    const g = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) { return String(k).indexOf("covered.studio.v1.tour.") === 0 ? "done" : g.call(this, k); };
  });
  await page.setViewport(opts.viewport || { width: 1280, height: 900 });
  await page.goto(env.stub.siteOrigin + (opts.path || "/?studio=1"), { waitUntil: "load" });
  return page;
}
const closePage = (page) => page.__ctx.close();
const ui = (page, sel, timeout) => page.waitForSelector("pierce/" + sel, { visible: true, timeout: timeout || 6000 });
async function btn(page, text, opts) {
  opts = opts || {};
  const h = await page.waitForFunction((t, exact) => {
    const root = document.getElementById("covered-studio") && document.getElementById("covered-studio").shadowRoot;
    if (!root) return null;
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(root.querySelectorAll("button, a")).find((b) => !b.disabled && vis(b) && (exact ? (b.getAttribute("aria-label") || b.textContent.trim()) === t : (b.textContent.trim().indexOf(t) === 0 || (b.getAttribute("aria-label") || "").indexOf(t) === 0))) || null;
  }, { timeout: opts.timeout || 6000 }, text, !!opts.exact);
  return h.asElement();
}
async function click(page, text, opts) { const e = await btn(page, text, opts); await e.click(); return e; }
async function signIn(page, who) {
  await click(page, "Edit this page");
  await click(page, "Sign in as " + (who || "Molly"));
  await page.waitForFunction(() => window.CoveredStudio && window.CoveredStudio.mode === "edit", { timeout: 6000 });
}
// run fn(root, ...args) inside the page with the shadow root as first argument
const inShadow = (page, fn, ...args) => page.evaluate((src, a) => new Function("root", "args", "return (" + src + ")(root, ...args)")(document.getElementById("covered-studio").shadowRoot, a), fn.toString(), args);
const waitShadow = (page, fn, ...args) => page.waitForFunction((src, a) => {
  const host = document.getElementById("covered-studio");
  return host && host.shadowRoot && new Function("root", "args", "return (" + src + ")(root, ...args)")(host.shadowRoot, a);
}, { timeout: 7000 }, fn.toString(), args);
const shadowText = (page) => page.evaluate(() => document.getElementById("covered-studio").shadowRoot.textContent);
const active = (page) => inShadow(page, (r) => { const a = r.activeElement; return a ? { tag: a.tagName.toLowerCase(), id: a.id, text: (a.textContent || "").trim().slice(0, 50), act: a.getAttribute("data-act"), change: a.getAttribute("data-change") } : null; });
async function openAi(page) {
  await click(page, "Describe a change", { exact: true });
  await waitShadow(page, (r) => r.querySelector(".csx-ai [data-phase='idle'], .csx-ai [data-phase='off']"));
}
async function ask(page, instruction) {
  await inShadow(page, (r, t) => { const ta = r.querySelector("#csx-ai-instr"); ta.value = t; ta.dispatchEvent(new Event("input", { bubbles: true })); }, instruction);
  await click(page, "Suggest changes");
  await waitShadow(page, (r) => r.querySelector(".csx-ai [data-kind], .csx-ai [data-phase='error'], .csx-ai [data-phase='off']"));
}

module.exports = { SKIP, launch, newPage, closePage, ui, btn, click, signIn, inShadow, waitShadow, shadowText, active, openAi, ask, SHADOW };
