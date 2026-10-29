"use strict";
// Real-browser tests for History, Help, Tour and the palette, driven with the KEYBOARD against a loopback stub.
// Needs puppeteer-core and a Chrome/Edge binary; neither is a repo dependency (DESIGN 13), so the file SKIPS cleanly
// without them. To run it: npm i --no-save puppeteer-core (or STUDIO_PUPPETEER_DIR=<folder with node_modules>) and,
// if Chrome is not in a standard place, CHROME_PATH=<binary>.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { start } = require("./harness/serve.js");

function loadPuppeteer() {
  const tries = [() => require("puppeteer-core")];
  if (process.env.STUDIO_PUPPETEER_DIR) tries.push(() => require(require.resolve("puppeteer-core", { paths: [process.env.STUDIO_PUPPETEER_DIR] })));
  for (const t of tries) { try { return t(); } catch (e) { /* next */ } }
  return null;
}
function findChrome() {
  const c = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return c.find((p) => p && fs.existsSync(p)) || null;
}

const puppeteer = loadPuppeteer();
const chrome = findChrome();
const SKIP = !puppeteer ? "puppeteer-core is not installed" : !chrome ? "no Chrome/Edge binary found" : false;

// ---- helpers: everything lives in the overlay's open shadow root
const inShadow = (page, fn, ...args) => page.evaluate((src, a) => {
  const root = document.getElementById("covered-studio").shadowRoot;
  return new Function("root", "args", "return (" + src + ")(root, ...args)")(root, a);
}, fn.toString(), args);
const active = (page) => page.evaluate(() => {
  const r = document.getElementById("covered-studio").shadowRoot.activeElement;
  if (!r) return null;
  return { tag: r.tagName.toLowerCase(), text: (r.textContent || "").trim().slice(0, 40), restore: r.getAttribute("data-restore"), confirm: r.getAttribute("data-confirm"), id: r.id, role: r.getAttribute("role") };
});
async function tabTo(page, pred, limit) {
  for (let i = 0; i < (limit || 60); i++) {
    await page.keyboard.press("Tab");
    const a = await active(page);
    if (a && pred(a)) return a;
  }
  throw new Error("could not Tab to the target within " + (limit || 60) + " presses");
}
const waitShadow = (page, fn, ...args) => page.waitForFunction((src, a) => {
  const root = document.getElementById("covered-studio") && document.getElementById("covered-studio").shadowRoot;
  return root && new Function("root", "args", "return (" + src + ")(root, ...args)")(root, a);
}, { timeout: 5000 }, fn.toString(), args);

async function open(srv, browser, query, size) {
  const page = await browser.newPage();
  await page.setViewport(size || { width: 1100, height: 800 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => { window.localStorage.setItem("covered.studio.v1.tour.u-molly", "done"); });
  await page.goto(srv.url + "/?" + (query || ""), { waitUntil: "load" });
  await page.waitForFunction(() => window.__started === true);
  page.errors = errors;
  return page;
}

test("browser tests (keyboard-only walkthroughs)", { skip: SKIP }, async (t) => {
  const srv = await start();
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  t.after(async () => { await browser.close(); await srv.close(); });

  await t.test("palette: opens with Ctrl+K, ARIA combobox, filters, runs by Enter, closes with Esc and returns focus", async () => {
    const page = await open(srv, browser, "");
    await page.focus("body");
    await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
    await waitShadow(page, (r) => r.querySelector(".csx-pal"));
    const a11y = await inShadow(page, (r) => {
      const i = r.querySelector(".csx-pal-input");
      const list = r.getElementById ? r.querySelector("#" + i.getAttribute("aria-controls")) : null;
      return { role: i.getAttribute("role"), expanded: i.getAttribute("aria-expanded"), controls: !!list, listRole: list && list.getAttribute("role"), dlg: r.querySelector(".csx-pal").getAttribute("role"), modal: r.querySelector(".csx-pal").getAttribute("aria-modal"), options: r.querySelectorAll('[role="option"]').length, focus: r.activeElement === i, ad: i.getAttribute("aria-activedescendant") };
    });
    assert.deepEqual({ role: a11y.role, expanded: a11y.expanded, controls: a11y.controls, listRole: a11y.listRole, dlg: a11y.dlg, modal: a11y.modal, focus: a11y.focus }, { role: "combobox", expanded: "true", controls: true, listRole: "listbox", dlg: "dialog", modal: "true", focus: true });
    assert.ok(a11y.options >= 3 && a11y.options <= 8, "max 8 options, got " + a11y.options);
    assert.ok(a11y.ad && a11y.ad.endsWith("-o0"));

    await page.keyboard.type("hist");
    const first = await inShadow(page, (r) => r.querySelector('[role="option"][aria-selected="true"]').textContent);
    assert.match(first, /Open History/);
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
    const ad = await inShadow(page, (r) => r.querySelector(".csx-pal-input").getAttribute("aria-activedescendant") === r.querySelector('[aria-selected="true"]').id);
    assert.ok(ad, "aria-activedescendant follows the selection");
    await page.keyboard.press("Escape");
    assert.equal(await inShadow(page, (r) => !r.querySelector(".csx-pal")), true);
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "focus goes back to where it was");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test("palette: 'change the logo', 'hide partners', 'help' and Tab does not leave the dialog", async () => {
    const page = await open(srv, browser, "");
    const run = async (q) => { await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control"); await waitShadow(page, (r) => r.querySelector(".csx-pal")); await page.keyboard.type(q); };
    await run("change the logo");
    assert.match(await inShadow(page, (r) => r.querySelector('[aria-selected="true"]').textContent), /Edit Share picture/);
    await page.keyboard.press("Enter");
    assert.deepEqual((await page.evaluate(() => window.__edits)).pop(), ["editRef", "site.ogImage"]);
    await run("hide partners");
    assert.match(await inShadow(page, (r) => r.querySelector('[aria-selected="true"]').textContent), /Hide Partners/);
    await page.keyboard.press("Enter");
    assert.deepEqual((await page.evaluate(() => window.__edits)).pop(), ["toggle", "homepage.sections.1.enabled"]);
    await run("");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    assert.equal(await inShadow(page, (r) => r.activeElement === r.querySelector(".csx-pal-input")), true, "focus stays on the combobox");
    await page.keyboard.type("zzqq");
    assert.match(await inShadow(page, (r) => r.querySelector(".csx-pal-list").textContent), /Nothing matches/);
    await page.keyboard.press("Escape");
    await run("help");
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelector(".csx-help"));
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test("palette: commands the role cannot use are hidden", async () => {
    const page = await open(srv, browser, "role=editor");
    await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
    await waitShadow(page, (r) => r.querySelector(".csx-pal"));
    await page.keyboard.type("publish");
    assert.doesNotMatch(await inShadow(page, (r) => r.querySelector(".csx-pal-list").textContent), /Publish/);
    await page.close();
    const page2 = await open(srv, browser, "role=approver&nolist=1");
    await page2.evaluate(() => { window.CoveredStudio.drafts.setCurrent("u1--x"); });
    await page2.keyboard.down("Control"); await page2.keyboard.press("k"); await page2.keyboard.up("Control");
    await waitShadow(page2, (r) => r.querySelector(".csx-pal"));
    await page2.keyboard.type("publish");
    assert.match(await inShadow(page2, (r) => r.querySelector(".csx-pal-list").textContent), /Publish/);
    await page2.keyboard.press("Escape");
    // 'nolist' = the host has no command listing: the palette still finds History through its own record
    await page2.keyboard.down("Control"); await page2.keyboard.press("k"); await page2.keyboard.up("Control");
    await waitShadow(page2, (r) => r.querySelector(".csx-pal"));
    await page2.keyboard.type("history");
    assert.match(await inShadow(page2, (r) => r.querySelector('[aria-selected="true"]').textContent), /History/);
    await page2.close();
  });

  await t.test("history: palette -> panel -> Tab to Restore -> confirm -> revert draft link (keyboard only)", async () => {
    srv.log.length = 0;
    const page = await open(srv, browser, "role=editor");
    await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
    await waitShadow(page, (r) => r.querySelector(".csx-pal"));
    await page.keyboard.type("history");
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelectorAll(".csx-row").length === 3);
    const rows = await inShadow(page, (r) => Array.from(r.querySelectorAll(".csx-row")).map((x) => ({ title: x.querySelector(".csx-row-title").textContent, meta: x.querySelector(".csx-meta").textContent, restore: !!x.querySelector("[data-restore]"), link: (x.querySelector("a") || {}).href })));
    assert.match(rows[0].title, /^Make the hero friendlier/);
    assert.match(rows[0].meta, /Molly via Studio · 2 hours ago/);
    assert.equal(rows[0].restore, true);
    assert.equal(rows[0].link, "https://github.com/o/r/pull/52");
    assert.equal(rows[2].restore, false, "a revert marked not restorable has no button");
    assert.match(await inShadow(page, (r) => r.querySelector(".csx-day-title").textContent), /^Today$/);

    await tabTo(page, (a) => a.restore === "52");
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelector('[role="dialog"][aria-label="Undo this change?"]'));
    assert.match(await inShadow(page, (r) => r.querySelector('[role="dialog"]').textContent), /Nothing goes live until an approver publishes it/);
    assert.equal((await active(page)).confirm, "yes", "confirm is focused");
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelector('[data-result="ok"]'));
    const res = await inShadow(page, (r) => { const a = r.querySelector('[data-result="ok"] a'); return { text: r.querySelector('[data-result="ok"]').textContent, href: a && a.href, rel: a && a.rel }; });
    assert.match(res.text, /Undo draft created/);
    assert.equal(res.href, "https://github.com/o/r/pull/77");
    assert.match(res.rel, /noopener/);
    assert.ok(srv.log.includes("POST restore 52 abort key=uuid auth=bearer"), srv.log.join(" | "));
    const ev = await page.evaluate(() => ({ events: window.__events.map((e) => e[0]), edits: window.__edits }));
    assert.ok(ev.events.includes("history:restored"));
    assert.deepEqual(ev.edits.filter((e) => e[0] === "setCurrent"), [["setCurrent", "u1--restore-52"]]);
    assert.equal(await inShadow(page, (r) => !!r.querySelector('[data-panel-id="changes"]')), false); // this stub has no Changes panel: openPanel("changes") must be harmless
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test("history: conflict -> second confirm -> restore the rest; Show earlier paginates; hostile text stays text", async () => {
    srv.log.length = 0;
    const page = await open(srv, browser, "role=admin");
    await page.evaluate(() => window.CoveredStudio.ui.openPanel("history"));
    await waitShadow(page, (r) => r.querySelectorAll(".csx-row").length === 3);
    await tabTo(page, (a) => a.restore === "51");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter"); // first confirm
    await waitShadow(page, (r) => r.querySelector('[role="dialog"][aria-label="Some parts have changed since"]'));
    await page.keyboard.press("Enter"); // "Undo the rest"
    await waitShadow(page, (r) => r.querySelector('[data-result="ok"]'));
    assert.deepEqual(srv.log.filter((l) => l.startsWith("POST")).map((l) => l.replace(/ key=.*/, "")), ["POST restore 51 abort", "POST restore 51 skip"]);
    assert.match(await inShadow(page, (r) => r.querySelector('[data-result="ok"]').textContent), /1 part was left as they are|1 part was left/);
    // hostile strings from the server are text
    const hostile = await inShadow(page, (r) => ({ imgs: r.querySelectorAll(".csx-history img, .csx-history b").length, title: r.querySelector('[data-pr="51"] .csx-row-title').textContent, meta: r.querySelector('[data-pr="51"] .csx-meta').textContent }));
    assert.equal(hostile.imgs, 0);
    assert.match(hostile.title, /<img src=x/);
    assert.match(hostile.meta, /<b>Eve<\/b> via the content editor/);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    // pagination
    await tabTo(page, (a) => /Show earlier/.test(a.text), 80);
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelectorAll(".csx-row").length === 4);
    assert.ok(srv.log.includes("GET history cursor=page2"));
    assert.equal(await inShadow(page, (r) => !r.querySelector(".csx-more")), true, "no more pages -> no button");
    assert.match(await inShadow(page, (r) => r.querySelector('[data-pr="40"]').textContent), /Changed: Faq, Picture a\.jpg/);
    assert.deepEqual(page.errors.filter((e) => !/409/.test(e)), []);
    await page.close();
  });

  await t.test("history: a person without a role sees the list but no Restore", async () => {
    const page = await open(srv, browser, "role=none");
    await page.evaluate(() => window.CoveredStudio.ui.openPanel("history"));
    await waitShadow(page, (r) => r.querySelectorAll(".csx-row").length === 3);
    assert.equal(await inShadow(page, (r) => r.querySelectorAll("[data-restore]").length), 0);
    assert.match(await inShadow(page, (r) => r.querySelector(".csx-row").textContent), /need an editor account/);
    await page.close();
  });

  await t.test("tour: auto-starts once, highlights real things, keyboard navigation, Esc closes, never again, replay from Help", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(srv.url + "/?role=editor&uid=newbie", { waitUntil: "load" });
    await page.waitForFunction(() => window.__started === true);
    await waitShadow(page, (r) => r.querySelector(".csx-tour-card"));
    const card = await inShadow(page, (r) => { const c = r.querySelector(".csx-tour-card"); return { role: c.getAttribute("role"), labelled: r.getElementById ? null : null, title: c.querySelector(".csx-tour-title").textContent, count: c.querySelector(".csx-tour-count").textContent, focus: r.activeElement && r.activeElement.getAttribute("data-tour-next"), labelledby: c.getAttribute("aria-labelledby") }; });
    assert.equal(card.role, "dialog");
    assert.equal(card.count, "Step 1 of 7");
    assert.equal(card.focus, "1");
    assert.equal(card.labelledby, "csx-tour-title");
    await page.keyboard.press("ArrowRight");
    assert.equal(await inShadow(page, (r) => r.querySelector(".csx-tour-title").textContent), "Click any text to change it");
    // the spotlight sits over the real headline
    const geom = await page.evaluate(() => { const s = document.getElementById("covered-studio").shadowRoot.querySelector(".csx-spot").getBoundingClientRect(); const h = document.getElementById("headline").getBoundingClientRect(); return { spot: [s.left, s.top, s.right, s.bottom], head: [h.left, h.top, h.right, h.bottom], show: document.getElementById("covered-studio").shadowRoot.querySelector(".csx-spot").style.display }; });
    await new Promise((r) => setTimeout(r, 450));
    const geom2 = await page.evaluate(() => { const s = document.getElementById("covered-studio").shadowRoot.querySelector(".csx-spot").getBoundingClientRect(); const h = document.getElementById("headline").getBoundingClientRect(); return { spot: [s.left, s.top, s.right, s.bottom], head: [h.left, h.top, h.right, h.bottom] }; });
    assert.equal(geom.show, "block");
    assert.ok(geom2.spot[0] <= geom2.head[0] && geom2.spot[1] <= geom2.head[1] && geom2.spot[2] >= geom2.head[2] && geom2.spot[3] >= geom2.head[3], "spotlight covers the headline: " + JSON.stringify(geom2));
    await page.keyboard.press("ArrowRight"); // image
    await page.keyboard.press("ArrowRight"); // sections tab (stub has data-tour attrs only once panels exist)
    assert.equal(await inShadow(page, (r) => r.querySelector(".csx-tour-count").textContent), "Step 4 of 7");
    // Tab never leaves the card
    for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); assert.equal(await inShadow(page, (r) => !!(r.activeElement && r.activeElement.closest(".csx-tour-card"))), true); }
    await page.keyboard.press("ArrowLeft");
    assert.equal(await inShadow(page, (r) => r.querySelector(".csx-tour-count").textContent), "Step 3 of 7");
    await page.keyboard.press("Escape");
    assert.equal(await inShadow(page, (r) => !r.querySelector(".csx-tour-card")), true);
    assert.equal(await page.evaluate(() => window.localStorage.getItem("covered.studio.v1.tour.u-newbie")), "done");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__started === true);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(await inShadow(page, (r) => !r.querySelector(".csx-tour-card")), true, "not shown again");
    // replay from Help via the keyboard
    await page.focus("body");
    await page.keyboard.press("?");
    await waitShadow(page, (r) => r.querySelector(".csx-help"));
    await tabTo(page, (a) => /Replay the tour/.test(a.text));
    await page.keyboard.press("Enter");
    await waitShadow(page, (r) => r.querySelector(".csx-tour-card"));
    // walk to the end with Next and finish
    for (let i = 0; i < 6; i++) await page.keyboard.press("Enter");
    assert.match(await inShadow(page, (r) => r.querySelector("[data-tour-next]").textContent), /Done/);
    await page.keyboard.press("Enter");
    assert.equal(await inShadow(page, (r) => !r.querySelector(".csx-tour-card")), true);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("tour works without localStorage (shown, closable, no crash)", async () => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(srv.url + "/?role=editor&uid=nostore", { waitUntil: "load" });
    await waitShadow(page, (r) => r.querySelector(".csx-tour-card"));
    await page.keyboard.press("Escape");
    assert.equal(await inShadow(page, (r) => !r.querySelector(".csx-tour-card")), true);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("help panel: plain-English content, role-aware, contact address, no raw markup", async () => {
    const page = await open(srv, browser, "role=editor");
    await page.evaluate(() => window.CoveredStudio.ui.openPanel("help"));
    await waitShadow(page, (r) => r.querySelector(".csx-help"));
    const text = await inShadow(page, (r) => r.querySelector(".csx-help").textContent);
    for (const s of ["Draft:", "Review:", "Publish:", "Restore:", "approver", "hello@covered.test", "Ctrl/Cmd + K", "Publishing is done by an approver", "Version 1"]) assert.ok(text.includes(s), "help mentions " + s);
    assert.ok(!/Publish a draft that someone else wrote/.test(text), "an editor is not told they can publish");
    await page.evaluate(() => window.CoveredStudio.ui.closePanel());
    const page2 = await open(srv, browser, "role=approver");
    await page2.evaluate(() => window.CoveredStudio.ui.openPanel("help"));
    await waitShadow(page2, (r) => r.querySelector(".csx-help"));
    assert.match(await inShadow(page2, (r) => r.querySelector(".csx-help").textContent), /Publish a draft that someone else wrote/);
    await page.close(); await page2.close();
  });

  await t.test("phone width (375px): palette and tour fit the screen", async () => {
    const page = await open(srv, browser, "role=editor&uid=phone", { width: 375, height: 700, isMobile: true, hasTouch: true });
    await page.evaluate(() => window.localStorage.removeItem("covered.studio.v1.tour.u-phone"));
    await page.evaluate(() => window.CoveredStudio.ui.openPanel("history"));
    await waitShadow(page, (r) => r.querySelectorAll(".csx-row").length === 3);
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(noOverflow);
    const fit = await inShadow(page, (r) => { const p = r.querySelector(".stub-panel").getBoundingClientRect(); return p.left >= 0 && p.right <= window.innerWidth + 1; });
    assert.ok(fit);
    await page.evaluate(() => window.CoveredStudio.ui.closePanel());
    await page.evaluate(() => window.__ext_tour = null);
    await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
    await waitShadow(page, (r) => r.querySelector(".csx-pal"));
    const pal = await inShadow(page, (r) => { const p = r.querySelector(".csx-pal").getBoundingClientRect(); return { l: p.left, r: p.right, w: window.innerWidth }; });
    assert.ok(pal.l >= 0 && pal.r <= pal.w + 1, JSON.stringify(pal));
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.CoveredStudio.ui.closePanel(); });
    await page.evaluate(() => { document.querySelector("body"); });
    // replay the tour on the phone and check the card is on screen
    await page.evaluate(() => window.CoveredStudio.ui.openPanel("help"));
    await waitShadow(page, (r) => r.querySelector("[data-help-tour]"));
    await inShadow(page, (r) => r.querySelector("[data-help-tour]").click());
    await waitShadow(page, (r) => r.querySelector(".csx-tour-card"));
    const card = await inShadow(page, (r) => { const c = r.querySelector(".csx-tour-card").getBoundingClientRect(); return { l: c.left, r: c.right, t: c.top, b: c.bottom, w: window.innerWidth, h: window.innerHeight }; });
    assert.ok(card.l >= 0 && card.r <= card.w + 1 && card.t >= 0 && card.b <= card.h + 1, JSON.stringify(card));
    await page.close();
  });
});
