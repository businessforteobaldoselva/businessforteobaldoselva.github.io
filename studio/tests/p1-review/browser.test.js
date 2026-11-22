"use strict";
// Real-browser walkthroughs of the REVIEW unit against the REAL API (handler + in-memory Git + dev sign-in, loopback only) and the
// real overlay bundle on the overlay's fixture page: Molly sends a draft for review, Amelia opens the link, reads the list of
// changes, approves and publishes. Everything is driven with the keyboard where a person would. Skips cleanly when puppeteer-core
// or Chrome is missing (STUDIO_PUPPETEER_DIR=<folder with node_modules>, CHROME_PATH=<binary>).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

function loadPuppeteer() {
  const tries = [() => require("puppeteer-core")];
  if (process.env.STUDIO_PUPPETEER_DIR) tries.push(() => require(require.resolve("puppeteer-core", { paths: [process.env.STUDIO_PUPPETEER_DIR] })));
  for (const t of tries) { try { return t(); } catch (e) { /* next */ } }
  return null;
}
const chromePath = [process.env.CHROME_PATH, process.env.STUDIO_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && fs.existsSync(p)) || null;
const puppeteer = loadPuppeteer();
const SKIP = !puppeteer ? "puppeteer-core is not installed" : !chromePath ? "no Chrome binary found" : false;

const FIX = path.resolve(__dirname, "..", "overlay", "fixtures");
const { bundle } = require("../../overlay/bundle.js");
const { createNodeServer } = require("../../api/adapters/node");
const { api: makeReviewApi, draftBy, submit, heroOp } = require("./helpers");

// ---- the two servers: the fixture site (with the real overlay bundle) and the real API behind a Node adapter
async function startServers(env) {
  let apiOrigin = "";
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
  const site = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
    if (p === "/studio/overlay.js") return send(200, MIME[".js"], bundle({ schemaPath: path.join(FIX, "schema.json"), warn: () => {} }));
    if (p === "/studio/content.json") return send(200, MIME[".json"], fs.readFileSync(path.join(FIX, "content.json")));
    if (p === "/" || p === "/index.html") return send(200, MIME[".html"], fs.readFileSync(path.join(FIX, "site", "index.html"), "utf8").split("__API__").join(apiOrigin));
    const f = path.normalize(path.join(FIX, "site", p));
    if (!f.startsWith(path.join(FIX, "site") + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, "text/plain", "not found");
    return send(200, MIME[path.extname(f)] || "application/octet-stream", fs.readFileSync(f));
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const siteOrigin = "http://127.0.0.1:" + site.address().port;
  const a = makeReviewApi({ env: Object.assign({ STUDIO_ALLOWED_ORIGINS: siteOrigin + ",http://localhost:8080", STUDIO_PREVIEW_URL_TEMPLATE: siteOrigin + "/?draft={pr}" }, env || {}) });
  const apiServer = createNodeServer(a.handler);
  await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
  apiOrigin = "http://127.0.0.1:" + apiServer.address().port;
  return { a, siteOrigin, apiOrigin, close: () => new Promise((r) => { site.closeAllConnections(); apiServer.closeAllConnections(); site.close(() => apiServer.close(() => r())); }) };
}

// ---- helpers: everything of Studio lives in the open shadow root of #covered-studio
const inShadow = (page, fn, ...args) => page.evaluate((src, a) => {
  const root = document.getElementById("covered-studio").shadowRoot;
  return new Function("root", "args", "return (" + src + ")(root, ...args)")(root, a);
}, fn.toString(), args);
const waitShadow = (page, fn, ...args) => page.waitForFunction((src, a) => {
  const el = document.getElementById("covered-studio");
  const root = el && el.shadowRoot;
  return root && new Function("root", "args", "return (" + src + ")(root, ...args)")(root, a);
}, { timeout: 8000 }, fn.toString(), args);
const active = (page) => inShadow(page, (r) => { const e = r.activeElement; return e ? { tag: e.tagName.toLowerCase(), text: (e.textContent || "").trim().slice(0, 50), type: e.getAttribute("type"), approve: e.getAttribute("data-approve") } : null; });
async function tabTo(page, pred, limit) {
  for (let i = 0; i < (limit || 80); i++) {
    await page.keyboard.press("Tab");
    const a = await active(page);
    if (a && pred(a)) return a;
  }
  throw new Error("could not Tab to the target");
}

test("review walkthroughs (keyboard, real API, real overlay)", { skip: SKIP }, async (t) => {
  const srv = await startServers();
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  t.after(async () => { await browser.close(); await srv.close(); });
  const { a } = srv;

  async function open(who, hash, viewport) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.__ctx = ctx;
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
    await page.setViewport(viewport || { width: 1100, height: 900 });
    await page.evaluateOnNewDocument((email) => {
      const g = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) { return String(k).indexOf("covered.studio.v1.tour.") === 0 ? "done" : g.call(this, k); };
      if (email) sessionStorage.setItem("covered.studio.devUser", email);
    }, who ? who + "@covered.test" : null);
    await page.goto(srv.siteOrigin + "/?studio=1" + (hash || ""), { waitUntil: "load" });
    await page.waitForFunction(() => window.CoveredStudio, { timeout: 8000 });
    if (who) await page.waitForFunction(() => window.CoveredStudio.me, { timeout: 8000 });
    return page;
  }
  const text = (page) => inShadow(page, (r) => r.textContent);

  await t.test("Molly sends her draft for review: the dialog names who is notified, then gives a ready-to-paste message", async () => {
    const d = await draftBy(a, "editor", [heroOp("We cover the UK"), { op: "replace", file: "src/_data/homepage.json", path: "/sections/4/enabled", value: false }], "Summer edits");
    const page = await open("molly");
    await page.evaluate((id) => { window.CoveredStudio.drafts.setCurrent(id); return window.CoveredStudio.drafts.refresh(); }, d.id);
    await page.evaluate(() => window.CoveredStudio.ui.openPanel("changes"));
    await waitShadow(page, (r) => Array.from(r.querySelectorAll("button")).some((b) => b.textContent === "Send for review"));
    // a keyboard user reaches the button with Tab and presses it
    await tabTo(page, (x) => x.tag === "button" && x.text === "Send for review");
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelector('[role="dialog"] [role="radiogroup"]'));
    const dlg = await inShadow(page, (r) => ({
      labelled: !!r.querySelector('[role="dialog"]').getAttribute("aria-labelledby"), modal: r.querySelector('[role="dialog"]').getAttribute("aria-modal"),
      radios: Array.from(r.querySelectorAll('[role="radiogroup"] label')).map((l) => l.textContent), focus: r.activeElement && r.activeElement.getAttribute("type"),
    }));
    assert.equal(dlg.labelled, true);
    assert.equal(dlg.modal, "true");
    assert.deepEqual(dlg.radios, [
      "Amelia \u2013 we will notify them on GitHub",
      "Teo \u2013 not set up for GitHub notifications; you will get a message to send",
      "No one in particular: I will share the link myself",
    ]);
    assert.equal(dlg.focus, "radio", "focus lands inside the dialog, on the choices");
    // choose Teo with the arrow keys (radio group), then Tab to Send
    await page.keyboard.press("ArrowDown");
    assert.equal(await inShadow(page, (r) => r.activeElement.value), "teo");
    await page.keyboard.press("Space");
    await tabTo(page, (x) => x.tag === "button" && x.text === "Send for review");
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelector(".csx-rv-share"));
    const done = await inShadow(page, (r) => ({ msg: r.querySelector(".csx-rv-sent").textContent, share: r.querySelector(".csx-rv-share").value, buttons: Array.from(r.querySelectorAll('[role="dialog"] button, [role="dialog"] a')).map((b) => b.textContent), focus: r.activeElement.className, mail: (r.querySelector('[role="dialog"] a') || {}).href }));
    assert.equal(done.msg, "Sent for review. Teo is not set up for GitHub notifications, so copy the link and send it to them.");
    assert.match(done.share, /^Hello Teo,/);
    assert.ok(done.share.includes("/?studio=1#review=" + d.id));
    assert.deepEqual(done.buttons, ["Copy link", "Email it", "Done"]);
    assert.match(done.focus, /csx-rv-sent/, "the result is announced and focused");
    assert.match(done.mail, /^mailto:\?subject=/);
    assert.equal(a.repo.prs.get(d.number).draft, false, "the pull request is ready for review");
    await page.keyboard.press("Escape");
    await waitShadow(page, (r) => !r.querySelector('[role="dialog"]'));
    assert.deepEqual(page.errors, []);
    await page.__ctx.close();
  });

  await t.test("Amelia opens the link: the screen lists the changes, hidden things first, and Approve and publish publishes", async () => {
    const d = (await a.call("approver", "GET", "/v1/drafts?scope=all")).json.drafts[0];
    const before = a.repo.head("main");
    const page = await open("amelia", "#review=" + d.id);
    await waitShadow(page, (r) => r.querySelector(".csx-review [data-approve]"));
    const view = await inShadow(page, (r) => ({
      title: r.querySelector(".csx-rv-title").textContent, summary: r.querySelector(".csx-rv-summary").textContent, live: r.querySelector(".csx-rv-summary").getAttribute("aria-live"),
      sections: Array.from(r.querySelectorAll(".csx-review section")).map((s) => s.getAttribute("aria-label")),
      lines: Array.from(r.querySelectorAll(".csx-rv-line")).map((l) => l.textContent), checks: r.querySelector(".csx-rv-checks").textContent,
      approve: r.querySelector("[data-approve]").disabled, focus: r.activeElement && r.activeElement.className, picture: r.textContent.indexOf("A picture of the draft is not available yet") >= 0,
    }));
    assert.equal(view.title, "Summer edits");
    assert.equal(view.summary, "2 changes on 1 page");
    assert.equal(view.live, "polite");
    assert.deepEqual(view.sections, ["Look at these carefully", "Other changes"]);
    assert.match(view.lines[0], /^Hides the \u201cHow it works\u201d section \(Home page\)\./);
    assert.match(view.lines[1], /^Changes the Headline \(Home page\) from \u201cFree period products,\u201d to \u201cWe cover the UK\u201d\./);
    assert.equal(view.checks, "All the safety checks passed.");
    assert.equal(view.approve, false);
    assert.equal(view.picture, true, "says plainly that no picture of the draft exists yet");
    assert.match(view.focus, /csx-rv-title/, "focus moves to the screen title");

    // keyboard only: Tab to the one button, Enter, then confirm
    await tabTo(page, (x) => x.approve === "1");
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelector('[role="dialog"]'));
    assert.equal(a.repo.head("main"), before, "nothing is published before the confirmation");
    const confirm = await inShadow(page, (r) => Array.from(r.querySelectorAll('[role="dialog"] button')).map((b) => b.textContent));
    assert.deepEqual(confirm, ["Cancel", "Approve and publish"]);
    await tabTo(page, (x) => x.tag === "button" && x.text === "Approve and publish");
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelector("[data-notice]"));
    assert.equal(await inShadow(page, (r) => r.querySelector("[data-notice]").textContent), "Published. The site updates in a few minutes.");
    assert.notEqual(a.repo.head("main"), before);
    assert.match(new TextDecoder().decode(a.repo.fileAt("main", "src/_data/hero.json")), /We cover the UK/);
    assert.equal(await inShadow(page, (r) => !r.querySelector("[data-approve]")), true, "nothing left to approve");
    // the Status panel now shows it as live, and as settling
    await page.evaluate(() => window.CoveredStudio.ui.openPanel("status"));
    await waitShadow(page, (r) => r.querySelector(".csx-status") && /Published\. The site updates in a few minutes\./.test(r.textContent));
    assert.deepEqual(page.errors, []);
    await page.__ctx.close();
  });

  await t.test("the status board for an editor and the approver; the palette source lists a waiting draft", async () => {
    const d = await draftBy(a, "editor", [{ op: "replace", file: "src/_data/hero.json", path: "/badge", value: "A new badge" }], "Badge change");
    await submit(a, "editor", d, "amelia");
    a.advance(20000);
    const mine = await open("molly");
    await mine.evaluate(() => window.CoveredStudio.ui.openPanel("status"));
    await waitShadow(mine, (r) => r.querySelector('[data-group="waiting"] .csx-row'));
    const e = await inShadow(mine, (r) => ({ groups: Array.from(r.querySelectorAll(".csx-status section")).map((s) => s.getAttribute("aria-label")), row: r.querySelector('[data-group="waiting"] .csx-row').textContent, review: !!r.querySelector('[data-group="waiting"] button[aria-label^="Review"]') }));
    assert.deepEqual(e.groups, ["Live now", "Waiting for approval", "My drafts", "Restored recently"]);
    assert.match(e.row, /Badge change/);
    assert.match(e.row, /Waiting for approval/);
    assert.equal(e.review, true, "the owner can open the review screen too");
    await mine.__ctx.close();

    const appr = await open("amelia");
    await waitShadow(appr, () => true);
    // the palette reads the board once the approver is signed in
    await appr.waitForFunction(() => window.CoveredStudio.ui.paletteSources().some((s) => s.id === "status.waiting" && s.search("badge").length === 1), { timeout: 8000 });
    // EDIT's palette merges registered sources at search time (PHASE1-DESIGN 3.2); here the source itself is exercised
    const row = await appr.evaluate(() => { const s = window.CoveredStudio.ui.paletteSources().find((x) => x.id === "status.waiting"); const rows = s.search("badge"); window.__row = rows[0]; return { n: rows.length, title: rows[0].title, group: rows[0].group, nothing: s.search("zzz").length }; });
    assert.deepEqual(row, { n: 1, title: "Waiting for approval: Badge change", group: "Review", nothing: 0 });
    await appr.evaluate(() => window.__row.run());
    await waitShadow(appr, (r) => r.querySelector(".csx-review [data-approve]"));
    assert.equal(await inShadow(appr, (r) => r.querySelector(".csx-rv-title").textContent), "Badge change");
    assert.deepEqual(appr.errors, []);
    await appr.__ctx.close();
  });

  await t.test("an approver cannot approve their own draft; the screen says why in plain words and the button is off", async () => {
    const d = await draftBy(a, "approver", [{ op: "replace", file: "src/_data/hero.json", path: "/stamp", value: "Stamped" }], "My own");
    await submit(a, "approver", d);
    const page = await open("amelia", "#review=" + d.id);
    await waitShadow(page, (r) => r.querySelector("[data-approve]"));
    const v = await inShadow(page, (r) => ({ disabled: r.querySelector("[data-approve]").disabled, blockers: Array.from(r.querySelectorAll(".csx-rv-blockers li")).map((l) => l.textContent), status: r.querySelector(".csx-rv-blockers").getAttribute("role") }));
    assert.equal(v.disabled, true);
    assert.deepEqual(v.blockers, ["Someone else has to publish your changes."]);
    assert.equal(v.status, "status");
    await page.__ctx.close();
  });

  await t.test("an editor opening their own draft sees the list but no publish button; a stranger's link is a clear message", async () => {
    const d = await draftBy(a, "editor", [{ op: "replace", file: "src/_data/hero.json", path: "/stamp", value: "Mine" }], "Molly again");
    const page = await open("molly", "#review=" + d.id);
    await waitShadow(page, (r) => r.querySelector(".csx-rv-checks"));
    assert.equal(await inShadow(page, (r) => !r.querySelector("[data-approve]")), true);
    assert.match(await text(page), /An approver will look at this before it goes live\./);
    await page.evaluate(() => window.CoveredStudio.ui.openPanel("status"));
    await page.evaluate(() => window.__CoveredStudioBoot.reviewScreen.open("u0000000--nobody"));
    await waitShadow(page, (r) => r.querySelector(".csx-error"));
    assert.match(await text(page), /could not be found/);
    await page.__ctx.close();
  });

  await t.test("a phone-sized screen: no sideways scrolling and before / after stack", async () => {
    const d = await draftBy(a, "editor", [heroOp("Phone check")], "Phone");
    await submit(a, "editor", d);
    const page = await open("amelia", "#review=" + d.id, { width: 375, height: 800 });
    await waitShadow(page, (r) => r.querySelector(".csx-rv-cmp"));
    const m = await inShadow(page, (r) => {
      const c = r.querySelector(".csx-rv-cmp");
      const panel = r.querySelector(".panel");
      return { cols: getComputedStyle(c).gridTemplateColumns.split(" ").length, over: panel.scrollWidth > panel.clientWidth + 1 };
    });
    assert.equal(m.cols, 1);
    assert.equal(m.over, false);
    await page.__ctx.close();
  });
});
