"use strict";
// Real-browser tests of the overlay (puppeteer-core + the machine's Chrome) against the overlay's fixture page and the
// stub API (studio/overlay/dev/stub-server.js). They edit a headline, swap a picture, hide and reorder sections, change a
// colour, save, and assert the EXACT patch that reached the API; plus hostile input, failures, phone layout and isolation.
// They skip themselves (not fail) when puppeteer-core or Chrome is not available, so CI without a browser stays green.
//   STUDIO_PUPPETEER=<path to puppeteer-core>   STUDIO_CHROME=<path to chrome.exe>
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const PPT_CANDIDATES = [
  process.env.STUDIO_PUPPETEER,
  "puppeteer-core",
].filter(Boolean);
const CHROME_CANDIDATES = [process.env.STUDIO_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);

let puppeteer = null;
for (const c of PPT_CANDIDATES) { try { puppeteer = require(c); break; } catch (e) { /* next */ } }
const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const SKIP = !puppeteer || !chrome ? "puppeteer-core or Chrome not found (set STUDIO_PUPPETEER / STUDIO_CHROME)" : false;

const { start } = require("../../overlay/dev/stub-server.js");

function crc(buf) { return zlib.crc32 ? zlib.crc32(buf) : 0; }
function makePng(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, (_, i) => [rgb[0], (rgb[1] + i * 7) & 255, rgb[2]]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-overlay-"));
const pngFile = path.join(tmp, "Holiday Photo (final).PNG");
const htmlFile = path.join(tmp, "notapicture.exe");
const svgFile = path.join(tmp, "x.svg");

let stub = null;
let browser = null;

test.before(async () => {
  if (SKIP) return;
  fs.writeFileSync(pngFile, makePng(640, 480, [200, 30, 90]));
  fs.writeFileSync(htmlFile, "MZ not a picture");
  fs.writeFileSync(svgFile, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  stub = await start({ sitePort: 0, apiPort: 0 });
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"] });
});
test.after(async () => {
  if (browser) await browser.close();
  if (stub) await stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers
async function newPage(opts) {
  opts = opts || {};
  stub.reset();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__errors.push(m.text()); });
  // the first-run tour has its own tests (studio/tests/ext); here it must not take the keyboard mid-test
  await page.evaluateOnNewDocument(() => { const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return String(k).indexOf("covered.studio.v1.tour.") === 0 ? "done" : g.call(this, k); }; });
  await page.setViewport(opts.viewport || { width: 1280, height: 900 });
  await page.goto(stub.siteOrigin + (opts.path || "/?studio=1"), { waitUntil: "load" });
  return page;
}
async function close(page) { await page.__ctx.close(); }
const ui = (page, sel, timeout) => page.waitForSelector("pierce/" + sel, { visible: true, timeout: timeout || 6000 });
async function btn(page, text, opts) {
  opts = opts || {};
  const h = await page.waitForFunction((t, exact) => {
    const root = document.getElementById("covered-studio") && document.getElementById("covered-studio").shadowRoot;
    if (!root) return null;
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const all = Array.from(root.querySelectorAll("button, a"));
    return all.find((b) => !b.disabled && vis(b) && (exact ? (b.getAttribute("aria-label") || b.textContent.trim()) === t : (b.textContent.trim().indexOf(t) === 0 || (b.getAttribute("aria-label") || "").indexOf(t) === 0))) || null;
  }, { timeout: 6000 }, text, !!opts.exact);
  return h.asElement();
}
async function click(page, text, opts) { const e = await btn(page, text, opts); await e.click(); return e; }
const shadowText = (page) => page.evaluate(() => document.getElementById("covered-studio").shadowRoot.textContent);
async function signIn(page, who) {
  await click(page, "Edit this page", {});
  await click(page, "Sign in as " + (who || "Molly"));
  await page.waitForFunction(() => window.CoveredStudio && window.CoveredStudio.mode === "edit", { timeout: 6000 });
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
async function openPanel(page, name) { await click(page, name, { exact: true }); await ui(page, ".panel-body"); }
async function waitSaved(page) { await page.waitForFunction(() => window.CoveredStudio.staging.count() === 0 && window.CoveredStudio.drafts.current(), { timeout: 8000 }); }

// ---------------------------------------------------------------- tests
test("a normal visit does nothing: no host, no request, no change to the page", { skip: SKIP }, async () => {
  const page = await newPage({ path: "/" });
  assert.equal(await page.$("#covered-studio"), null);
  assert.equal(stub.requests.length, 0, "no API call");
  assert.equal(await page.evaluate(() => typeof window.CoveredStudio), "undefined");
  assert.equal(await text(page, "#h1"), "We're covering the UK,");
  assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 0);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-studio-editing")), false);
  await close(page);
});

test("opens with ?studio=1: a pill, nothing else changes until you sign in and switch Edit on", { skip: SKIP }, async () => {
  const page = await newPage();
  await ui(page, "button.pill");
  assert.equal(await page.evaluate(() => window.CoveredStudio.mode), "browse");
  assert.equal(await page.evaluate(() => document.querySelectorAll("[data-studio-hidden],[data-studio-dirty]").length), 0);
  // an ordinary link click is not intercepted in browse mode
  assert.equal(await page.evaluate(() => { let n = 0; const h = (e) => { n += e.defaultPrevented ? 1 : 0; }; document.addEventListener("click", h, false); const a = document.createElement("a"); a.href = "#x"; document.body.appendChild(a); a.click(); document.removeEventListener("click", h); return n; }), 0);
  await signIn(page, "Molly");
  assert.equal(await page.evaluate(() => window.CoveredStudio.me.role), "editor");
  assert.equal(await page.evaluate(() => window.CoveredStudio.mode), "edit");
  assert.deepEqual(page.__errors, []);
  await close(page);
});

test("headline: click, type, Enter -> staged; the Changes panel says it in plain English; Save sends ONE exact patch", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  await page.click("#h1");
  assert.equal(await page.$eval("#h1", (e) => e.getAttribute("contenteditable")), "plaintext-only");
  await page.keyboard.type("We cover the UK");
  await page.keyboard.press("Enter");
  assert.equal(await text(page, "#h1"), "We cover the UK");
  assert.equal(await page.$eval("#h1", (e) => e.hasAttribute("contenteditable")), false);
  await openPanel(page, "Changes");
  const t = await shadowText(page);
  assert.match(t, /Hero > Headline/);
  assert.match(t, /Changed the text from \u201cWe're covering the UK,\u201d to \u201cWe cover the UK\u201d/);
  await click(page, "Save draft");
  await waitSaved(page);
  assert.equal(stub.patches.length, 1);
  const p = stub.patches[0];
  assert.match(p.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(p.baseSha, "a".repeat(40));
  assert.deepEqual(p.ops, [{ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: "We cover the UK", expect: "We're covering the UK," }]);
  assert.deepEqual(p.uploads, []);
  const auth = stub.requests.filter((r) => r.path === "/v1/drafts" && r.method === "POST")[0].auth;
  assert.equal(auth, "Bearer dev:editor:molly@covered.test");
  assert.match(await shadowText(page), /Your draft/);
  assert.match(await shadowText(page), /pull request/);
  assert.deepEqual(page.__errors, []);
  await close(page);
});

test("everything at once: edit text, swap a photo (with description), hide a section, reorder, colour -> one patch, exact", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  // 1 text
  await page.click("#t1");
  await page.keyboard.type("Step 2: tap");
  await page.keyboard.press("Enter");
  // 2 picture
  await page.click("#img1");
  const dlgTitle = await ui(page, ".dialog-title");
  assert.match(await dlgTitle.evaluate((e) => e.textContent), /Replace picture/);
  const fileIn = await ui(page, "input[type=file]");
  await fileIn.uploadFile(htmlFile);
  await page.waitForFunction(() => /isn't a picture Studio can use/.test(document.getElementById("covered-studio").shadowRoot.textContent));
  await fileIn.uploadFile(svgFile);
  await page.waitForFunction(() => /SVG drawings can't be added/.test(document.getElementById("covered-studio").shadowRoot.textContent));
  await fileIn.uploadFile(pngFile);
  // the Use button stays disabled until a description is given
  await page.waitForFunction(() => { const r = document.getElementById("covered-studio").shadowRoot; return /Use this picture/.test(r.textContent) && Array.from(r.querySelectorAll("button")).find((b) => b.textContent.trim() === "Use this picture").disabled === true; });
  assert.match(await shadowText(page), /Describe the picture.*Required unless the picture is purely decorative/);
  const alt = await ui(page, "textarea");
  await alt.type("A student holding a phone next to a dispenser");
  await click(page, "Use this picture");
  await page.waitForFunction(() => document.getElementById("img1").src.startsWith("blob:"), { timeout: 8000 });
  assert.equal(await page.$eval("#img1", (e) => e.getAttribute("alt")), "A student holding a phone next to a dispenser");
  // 3 hide + 4 reorder via the Sections panel
  await openPanel(page, "Sections");
  await page.evaluate(() => { const r = document.getElementById("covered-studio").shadowRoot; r.querySelector("input[type=checkbox][data-key=chk2]").click(); });
  assert.equal(await page.$eval("#faq", (e) => e.hasAttribute("data-studio-hidden")), true);
  await click(page, "Move The problem up", { exact: true });
  await click(page, "Move The problem up", { exact: true });
  // 5 colour
  await page.click("#swatch");
  const hex = await ui(page, "input[type=text]");
  await hex.click({ clickCount: 3 });
  await hex.type("#EEF4CC");
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim().toUpperCase() === "#EEF4CC");
  assert.match(await shadowText(page), /contrast|easy to read/i, "contrast feedback is shown");
  await click(page, "Keep change");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(238, 244, 204)");
  // review panel, then ONE save
  await openPanel(page, "Changes");
  const t = await shadowText(page);
  for (const s of [/Changed the text from \u201cStep two\u201d to \u201cStep 2: tap\u201d/, /Uploaded a new picture/, /Changed the text from \u201cA phone showing an advert\u201d to/, /Hid \u201cFAQ\u201d on the live site/, /Moved \u201cThe problem\u201d up/, /Changed the colour from #FFEFDA to #EEF4CC/]) assert.match(t, s);
  await click(page, "Save draft");
  await waitSaved(page);
  assert.equal(stub.patches.length, 1, "exactly one request");
  const p = stub.patches[0];
  const norm = (o) => (o.op === "replace" && o.path === "/story/1/image" ? Object.assign({}, o, { value: "<new-file>" }) : o);
  const key = (o) => o.op + o.path;
  const expected = [
    { op: "replace", file: "src/_data/how.json", path: "/story/1/title", value: "Step 2: tap", expect: "Step two" },
    { op: "replace", file: "src/_data/how.json", path: "/story/1/image", value: "<new-file>", expect: "story-2.svg" },
    { op: "add", file: "src/_data/how.json", path: "/story/1/decorative", value: false },
    { op: "replace", file: "src/_data/how.json", path: "/story/1/alt", value: "A student holding a phone next to a dispenser", expect: "A phone showing an advert" },
    { op: "replace", file: "src/_data/homepage.json", path: "/sections/2/enabled", value: false, expect: true },
    { op: "replace", file: "src/_data/theme.json", path: "/paper", value: "#EEF4CC", expect: "#FFEFDA" },
    { op: "move", file: "src/_data/homepage.json", from: "/sections/3", path: "/sections/1" },
  ];
  const byKey = (x, y) => (key(x) < key(y) ? -1 : 1);
  assert.deepEqual(p.ops.map(norm).sort(byKey), expected.sort(byKey), "exactly these seven ops");
  const byPath = Object.fromEntries(p.ops.map((o) => [o.op + o.path, o]));
  assert.equal(byPath["replace/story/1/title"].expect, "Step two");
  assert.equal(byPath["replace/sections/2/enabled"].value, false);
  assert.equal(byPath["replace/paper"].value, "#EEF4CC");
  assert.equal(byPath["move/sections/1"].from, "/sections/3");
  assert.equal(p.ops[p.ops.length - 1].op, "move", "moves come last");
  // the upload
  assert.equal(p.uploads.length, 1);
  const up = p.uploads[0];
  assert.match(up.name, /^holiday-photo-final-[0-9a-f]{5}\.jpg$/, "a safe file name derived from the original");
  assert.equal(up.contentType, "image/jpeg");
  const bytes = Buffer.from(up.dataBase64, "base64");
  assert.equal(bytes.length, up.size);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], "a JPEG (re-encoded in the browser: no EXIF/GPS survives)");
  assert.ok(up.size < 1500 * 1024);
  assert.equal(byPath["replace/story/1/image"].value, up.name);
  assert.deepEqual(Object.keys(p).sort(), ["baseSha", "idempotencyKey", "ops", "uploads"]);
  assert.deepEqual(page.__errors, []);
  await close(page);
});

test("hostile input is only ever text: script tags, huge text, RTL override characters, rich HTML paste", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  // script tag typed into a headline
  await page.click("#h1");
  await page.keyboard.type("<script>window.__pwned=1</script><img src=x onerror=window.__pwned=2>");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.$eval("#h1", (e) => e.children.length), 0, "no elements were created");
  assert.equal(await text(page, "#h1"), "<script>window.__pwned=1</script><img src=x onerror=window.__pwned=2>");
  // the schema forbids < > in this headline: it is kept as a draft change but flagged and cannot be saved
  await openPanel(page, "Changes");
  assert.match(await shadowText(page), /Please don't use < or > in the headline/);
  await click(page, "Save draft");
  await page.waitForFunction(() => /Fix the items marked in red/.test(document.getElementById("covered-studio").shadowRoot.textContent));
  assert.equal(stub.patches.length, 0, "nothing was sent");
  await page.evaluate(() => window.CoveredStudio.staging.discard("hero.headlineMain"));
  await page.evaluate(() => window.CoveredStudio.ui.closePanel());
  // rich HTML paste lands as plain text
  await page.click("#sub");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/html", '<b onmouseover="window.__pwned=3">bold</b><script>window.__pwned=4</script><iframe src="//evil.test"></iframe>');
    dt.setData("text/plain", "pasted plain text");
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById("sub").dispatchEvent(ev);
  });
  assert.equal(await page.$eval("#sub", (e) => e.querySelectorAll("*").length), 0, "no markup survived the paste");
  assert.match(await text(page, "#sub"), /pasted plain text/);
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  // RTL override and control characters: typed, flagged, not savable
  await page.$eval("#q0", (e) => e.scrollIntoView({ block: "center" })); // the dock (now with History and Help) can cover the bottom of the viewport
  await page.click("#q0");
  await page.keyboard.type("evil\u202Etxt");
  await page.keyboard.press("Enter");
  const probs = await page.evaluate(() => window.CoveredStudio.staging.problems().map((p) => p.codes.join()));
  assert.ok(probs.some((c) => /encoding/.test(c)), "bidi override is flagged: " + probs.join("|"));
  await page.evaluate(() => window.CoveredStudio.staging.discard("faq.items.0.q"));
  // a huge text is refused or flagged instantly, and does not hang the page
  await page.click("#q1");
  await page.evaluate(() => { document.getElementById("q1").textContent = "x".repeat(30000); document.getElementById("q1").dispatchEvent(new Event("input")); });
  assert.match(await page.evaluate(() => document.getElementById("covered-studio").shadowRoot.querySelector(".inline-hint").textContent), /too long/);
  await page.keyboard.press("Enter");
  const bigProblems = await page.evaluate(() => window.CoveredStudio.staging.problems().map((p) => p.codes.join()));
  assert.ok(bigProblems.some((c) => /too_large/.test(c)));
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(stub.patches.length, 0);
  await close(page);
});

test("markdown preview is built from nodes: raw HTML in the text is shown as text", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  await page.click("#md");
  const ta = await ui(page, "textarea");
  await ta.click({ clickCount: 3 });
  await page.keyboard.type('**bold** <img src=x onerror="window.__pwned=9"> [ok](https://example.test) [bad](javascript:alert(1))');
  await page.waitForFunction(() => document.getElementById("covered-studio").shadowRoot.querySelector(".md-preview a"));
  const html = await page.evaluate(() => document.getElementById("covered-studio").shadowRoot.querySelector(".md-preview").innerHTML);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /&lt;img src=x onerror="window.__pwned=9"&gt;/);
  assert.match(html, /<a href="https:\/\/example.test"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  await click(page, "Cancel");
  await close(page);
});

test("link editor: helper always writes a safe link, bad ones are refused with a reason", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  await page.click("#cta"); // the button text is editable in place; the link is on the toolbar
  await page.keyboard.press("Escape");
  await click(page, "Link", { exact: false });
  await ui(page, "select");
  const sel = await ui(page, "select");
  await sel.select("web");
  const input = await ui(page, "input[type=text]");
  await input.type("javascript:alert(1)");
  assert.match(await shadowText(page), /The link will be: javascript:alert\(1\)/);
  assert.match(await shadowText(page), /Start with \//);
  assert.equal(await page.evaluate(() => Array.from(document.getElementById("covered-studio").shadowRoot.querySelectorAll("button")).find((b) => b.textContent.trim() === "Keep change").disabled), true);
  await input.click({ clickCount: 3 });
  await input.type("https://example.test/join");
  await click(page, "Keep change");
  assert.equal(await page.$eval("#cta", (e) => e.getAttribute("href")), "https://example.test/join");
  assert.equal(await page.evaluate(() => window.CoveredStudio.staging.get("hero.ctaLink")), "https://example.test/join");
  await close(page);
});

test("failures: a 422 shows the server's reason next to the change and loses nothing; a 409 offers Keep mine / Take theirs; offline keeps everything", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  await page.click("#h1");
  await page.keyboard.type("Fine headline");
  await page.keyboard.press("Enter");
  await openPanel(page, "Changes");
  stub.failNext = { status: 422, body: { error: { code: "validation_failed", message: "bad", details: { problems: [{ code: "pattern", file: "src/_data/hero.json", path: "/headlineMain", message: "The server would rather have a different headline." }] } }, requestId: "r1" } };
  await click(page, "Save draft");
  await page.waitForFunction(() => /server would rather/.test(document.getElementById("covered-studio").shadowRoot.textContent));
  assert.equal(await page.evaluate(() => window.CoveredStudio.staging.count()), 1, "nothing lost");
  // 409
  stub.failNext = { status: 409, body: { error: { code: "conflict", message: "c", details: { items: [{ file: "src/_data/hero.json", path: "/headlineMain", expected: "We're covering the UK,", actual: "Someone else's headline" }] } } } };
  await click(page, "Save draft");
  await page.waitForFunction(() => /Someone changed these/.test(document.getElementById("covered-studio").shadowRoot.textContent));
  assert.match(await shadowText(page), /Someone else's headline/);
  await click(page, "Keep mine");
  stub.mainDocs["src/_data/hero.json"].headlineMain = "Someone else's headline";
  await click(page, "Save draft");
  await waitSaved(page);
  assert.equal(stub.patches[stub.patches.length - 1].ops[0].expect, "Someone else's headline");
  // offline: the request fails at the network level
  await page.click("#t0");
  await page.keyboard.type("!");
  await page.keyboard.press("Enter");
  await page.setOfflineMode(true);
  await click(page, "Save draft");
  await page.waitForFunction(() => /Saved on this device/.test(document.getElementById("covered-studio").shadowRoot.textContent));
  assert.equal(await page.evaluate(() => window.CoveredStudio.staging.count()), 1);
  await page.setOfflineMode(false);
  await click(page, "Try again now");
  await waitSaved(page);
  await close(page);
});

test("a reload keeps unsaved changes (per person, in this browser) and signs the practice user back in", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  await page.click("#h1");
  await page.keyboard.type("Kept across reload");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.CoveredStudio.staging.flush());
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.CoveredStudio && window.CoveredStudio.me && window.CoveredStudio.staging.count() === 1, { timeout: 8000 });
  assert.equal(await text(page, "#h1"), "Kept across reload");
  assert.match(await shadowText(page), /Restored 1 unsaved change/);
  await close(page);
});

test("phone layout (390px): bottom sheet, 44px targets, no sideways scroll, hide a section from the phone", { skip: SKIP }, async () => {
  const page = await newPage({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await signIn(page);
  await openPanel(page, "Sections");
  const geo = await page.evaluate(() => {
    const r = document.getElementById("covered-studio").shadowRoot;
    const rect = (s) => { const e = r.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
    const small = Array.from(r.querySelectorAll("button, input:not([type=hidden]), select, textarea")).filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.width < 43.5 || b.height < 43.5); }).map((e) => (e.textContent || e.type || e.tagName) + " " + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height));
    return { panel: rect(".panel"), dock: rect(".dock"), small, scrollW: document.documentElement.scrollWidth, vw: window.innerWidth };
  });
  assert.ok(geo.panel.l >= 0 && geo.panel.r <= 391, "panel inside the screen");
  assert.ok(geo.panel.b <= geo.dock.t + 1, "sheet sits above the dock");
  assert.ok(geo.panel.h <= 844 * 0.71, "at most ~70% of the height: " + geo.panel.h);
  assert.deepEqual(geo.small, [], "every control is at least 44x44");
  assert.ok(geo.scrollW <= geo.vw, "no horizontal scroll: " + geo.scrollW);
  // tap to hide the FAQ section from the phone
  await page.evaluate(() => { const r = document.getElementById("covered-studio").shadowRoot; r.querySelector("input[data-key=chk2]").click(); });
  assert.equal(await page.$eval("#faq", (e) => e.hasAttribute("data-studio-hidden")), true);
  // touch: first tap selects, the toolbar offers actions, second tap opens the editor
  await page.evaluate(() => window.CoveredStudio.ui.closePanel());
  await page.evaluate(() => document.getElementById("h1").scrollIntoView());
  await page.tap("#h1");
  await ui(page, ".seltool");
  assert.equal(await page.$eval("#h1", (e) => e.hasAttribute("contenteditable")), false, "first tap only selects");
  await page.tap("#h1");
  await ui(page, ".dialog"); // on a phone text opens in a bottom sheet (keyboard-aware), not in place
  const dlg = await page.evaluate(() => { const b = document.getElementById("covered-studio").shadowRoot.querySelector(".dialog").getBoundingClientRect(); return { l: b.left, r: b.right, b: b.bottom, w: b.width }; });
  assert.ok(dlg.w <= 391 && dlg.b <= 845);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("covered-studio").shadowRoot.querySelector(".dialog"));
  await close(page);
});

test("the site cannot restyle or script the overlay, and the overlay does not leak into the site", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = "button,.pill,.dock,input,textarea{display:none!important;visibility:hidden!important;color:red!important;background:red!important}*{font-size:1px!important;color:red!important;font-family:cursive!important}";
    document.head.appendChild(st);
  });
  const inner = await page.evaluate(() => { const r = document.getElementById("covered-studio").shadowRoot; const p = r.querySelector("button.pill"); const b = p.getBoundingClientRect(); const cs = getComputedStyle(p); return { size: cs.fontSize, family: cs.fontFamily, bg: cs.backgroundColor, w: b.width, h: b.height, display: cs.display }; });
  assert.equal(inner.size, "15px", "site selectors do not reach into the shadow root");
  assert.doesNotMatch(inner.family, /cursive/);
  assert.notEqual(inner.bg, "rgb(255, 0, 0)");
  assert.ok(inner.h >= 44 && inner.w >= 44 && inner.display !== "none", JSON.stringify(inner));
  // no overlay markup in the light DOM except the host and the three data attributes
  const light = await page.evaluate(() => Array.from(document.body.children).map((e) => e.tagName + "#" + e.id).join(","));
  assert.match(light, /DIV#covered-studio/);
  assert.equal(await page.evaluate(() => document.querySelectorAll("style[data-studio], link[data-studio]").length), 0);
  await close(page);
});

test("keyboard + accessibility of the overlay itself", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page);
  // E toggles edit mode (focus on the page), ] / [ cycle through marked parts, Enter edits
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  await page.keyboard.press("e");
  assert.equal(await page.evaluate(() => window.CoveredStudio.mode), "browse");
  await page.keyboard.press("e");
  assert.equal(await page.evaluate(() => window.CoveredStudio.mode), "edit");
  await page.keyboard.press("]");
  const first = await page.evaluate(() => window.CoveredStudio.inspect.selected().ref);
  assert.equal(first, "homepage.sections.0");
  await page.keyboard.press("]");
  assert.equal(await page.evaluate(() => window.CoveredStudio.inspect.selected().ref), "hero.headlineMain");
  await page.keyboard.press("Enter");
  assert.equal(await page.$eval("#h1", (e) => e.getAttribute("contenteditable")), "plaintext-only");
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#h1", (e) => e.hasAttribute("contenteditable")), false, "Esc cancels the in-place edit");
  // undo / redo by keyboard
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.CoveredStudio.staging.set("hero.badge", "Via API"));
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  assert.equal(await page.evaluate(() => window.CoveredStudio.staging.get("hero.badge")), "Now in 12 venues");
  // structure of the chrome
  await openPanel(page, "Fields");
  const a11y = await page.evaluate(() => {
    const r = document.getElementById("covered-studio").shadowRoot;
    const unnamed = Array.from(r.querySelectorAll("button, input, select, textarea")).filter((e) => { if (e.type === "hidden") return false; const name = (e.getAttribute("aria-label") || e.textContent || "").trim() || (e.id && r.querySelector('label[for="' + e.id + '"]')) || (e.closest("label")); return !name; }).map((e) => e.outerHTML.slice(0, 80));
    return { unnamed, live: !!r.querySelector('[aria-live="polite"][role=status]'), complementary: !!r.querySelector('aside[role=complementary][aria-label]'), imgsWithoutAlt: r.querySelectorAll("img:not([alt])").length };
  });
  assert.deepEqual(a11y.unnamed, []);
  assert.equal(a11y.live, true);
  assert.equal(a11y.complementary, true);
  // dialogs: role, modal, labelled, focus trapped, Esc closes and gives focus back
  await page.evaluate(() => window.CoveredStudio.ui.closePanel());
  await page.click("#swatch");
  const dlg = await page.evaluate(() => { const d = document.getElementById("covered-studio").shadowRoot.querySelector(".dialog"); return { role: d.getAttribute("role"), modal: d.getAttribute("aria-modal"), labelled: !!document.getElementById("covered-studio").shadowRoot.getElementById(d.getAttribute("aria-labelledby")) }; });
  assert.deepEqual(dlg, { role: "dialog", modal: "true", labelled: true });
  for (let i = 0; i < 12; i += 1) await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => !!document.getElementById("covered-studio").shadowRoot.activeElement && !!document.getElementById("covered-studio").shadowRoot.activeElement.closest(".dialog")), true, "focus stays inside the dialog");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("covered-studio").shadowRoot.querySelector(".dialog"));
  await close(page);
});

test("roles: an editor cannot publish; an approver sees Publish; self-publish is refused with a clear reason", { skip: SKIP }, async () => {
  const page = await newPage();
  await signIn(page, "Amelia");
  await page.click("#h1");
  await page.keyboard.type("Approver edit");
  await page.keyboard.press("Enter");
  await openPanel(page, "Changes");
  await click(page, "Save draft");
  await waitSaved(page);
  await click(page, "Send for review");
  await page.waitForFunction(() => window.CoveredStudio.drafts.current().state === "ready");
  await click(page, "Publish");
  await click(page, "Publish", { exact: true }); // confirm dialog button
  await page.waitForFunction(() => /Someone else has to publish/.test(document.getElementById("covered-studio").shadowRoot.textContent), { timeout: 6000 });
  await close(page);
  const p2 = await newPage();
  await signIn(p2, "Molly");
  assert.equal(await p2.evaluate(() => window.CoveredStudio.me.capabilities.publish), false);
  await p2.click("#h1"); await p2.keyboard.type("x"); await p2.keyboard.press("Enter");
  await openPanel(p2, "Changes");
  await click(p2, "Save draft");
  await waitSaved(p2);
  assert.equal(await p2.evaluate(() => Array.from(document.getElementById("covered-studio").shadowRoot.querySelectorAll("button")).some((b) => b.textContent.trim() === "Publish")), false);
  await close(p2);
});
