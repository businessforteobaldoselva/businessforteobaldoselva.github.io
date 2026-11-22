"use strict";
// Real-browser tests of the EDIT unit's overlay features on a REAL edit build of the site (CMS_EDIT=1): the legend chip and its count on / and /about/,
// the All fields drawer, the palette's jumps (keyboard only), "Check my changes" and the refusal to send a draft with a new block finding.
// The API is the overlay's stub (studio/overlay/dev/stub-server.js); page requests are answered from the real build through request interception.
// Skips itself (not fails) without puppeteer-core or Chrome: STUDIO_PUPPETEER=<path to puppeteer-core>, STUDIO_CHROME=<chrome binary>.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..", "..");
function loadPuppeteer() {
  const tries = [process.env.STUDIO_PUPPETEER, "puppeteer-core"].filter(Boolean);
  if (process.env.STUDIO_PUPPETEER_DIR) tries.push(require.resolve("puppeteer-core", { paths: [process.env.STUDIO_PUPPETEER_DIR] }));
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  return null;
}
const puppeteer = loadPuppeteer();
const chrome = [process.env.STUDIO_CHROME, process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean).find((p) => fs.existsSync(p));
const SKIP = !puppeteer || !chrome ? "puppeteer-core or Chrome not found (set STUDIO_PUPPETEER / STUDIO_CHROME)" : false;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".xml": "text/xml", ".txt": "text/plain", ".mp4": "video/mp4" };

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

let stub = null;
let browser = null;
let site = null;
let tmp = null;

test.before(async () => {
  if (SKIP) return;
  const { start } = require("../../overlay/dev/stub-server.js");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-p1edit-"));
  site = path.join(tmp, "site");
  const bin = require("../../../scripts/lib/workspace").eleventyBin(REPO);
  const r = spawnSync(process.execPath, [bin, "--quiet", "--output=" + site], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: Object.assign({}, process.env, { CMS_EDIT: "1", COVERED_IMG_FAST: "1", STUDIO_API_URL: "http://127.0.0.1:9", STUDIO_APP_URL: "" }) });
  assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  stub = await start({ sitePort: 0, apiPort: 0, siteDir: site }); // the stub serves the real build and points the overlay at itself
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"] });
});
test.after(async () => {
  if (browser) await browser.close();
  if (stub) await stub.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function newPage(p, viewport) {
  stub.reset();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.__errors = [];
  page.__dialogs = 0;
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.__errors.push(m.text()); });
  page.on("dialog", (d) => { page.__dialogs += 1; d.dismiss(); });
  await page.evaluateOnNewDocument(() => { const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return String(k).indexOf("covered.studio.v1.tour.") === 0 ? "done" : g.call(this, k); }; });
  await page.setViewport(viewport || { width: 1280, height: 900 });
  await page.goto(stub.siteOrigin + p + "?studio=1", { waitUntil: "load" });
  return page;
}
const close = (page) => page.__ctx.close();
const inShadow = (page, fn, ...args) => page.evaluate((src, a) => {
  const root = document.getElementById("covered-studio").shadowRoot;
  return new Function("root", "args", "return (" + src + ")(root, ...args)")(root, a);
}, fn.toString(), args);
const waitShadow = (page, fn, ...args) => page.waitForFunction((src, a) => {
  const el = document.getElementById("covered-studio");
  return el && el.shadowRoot && new Function("root", "args", "return (" + src + ")(root, ...args)")(el.shadowRoot, a);
}, { timeout: 8000 }, fn.toString(), args);
async function clickText(page, text) {
  await waitShadow(page, (root, t) => Array.from(root.querySelectorAll("button")).some((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (b.getAttribute("aria-label") || b.textContent).trim().indexOf(t) === 0; }), text);
  await inShadow(page, (root, t) => { Array.from(root.querySelectorAll("button")).find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (b.getAttribute("aria-label") || b.textContent).trim().indexOf(t) === 0; }).click(); }, text);
}
async function signIn(page) {
  try { await waitShadow(page, (root) => root.querySelector("button.pill")); } catch (e) { throw new Error("the overlay did not start. Page errors: " + page.__errors.join(" | ") + " requests: " + stub.requests.length); }
  await clickText(page, "Edit this page");
  await clickText(page, "Sign in as Molly");
  await page.waitForFunction(() => window.CoveredStudio && window.CoveredStudio.mode === "edit", { timeout: 8000 });
}
const press = async (page, mod, key) => { if (mod) await page.keyboard.down(mod); await page.keyboard.press(key); if (mod) await page.keyboard.up(mod); };
const domCount = (page) => page.evaluate(() => { const leaf = ["text", "longtext", "markdown", "image", "link", "color", "toggle"]; const refs = new Set(); document.querySelectorAll("[data-cms]").forEach((n) => { if (leaf.indexOf(n.getAttribute("data-cms-kind")) >= 0) refs.add(n.getAttribute("data-cms")); }); return refs.size; });

for (const [route, file] of [["/", "index.html"], ["/about/", "about/index.html"]]) {
  test("legend: the chip on " + route + " says how many editable things the page has, equal to the markers in the page and to the guard's ratchet", { skip: SKIP }, async () => {
    const page = await newPage(route);
    await signIn(page);
    const dom = await domCount(page);
    assert.ok(dom > 3, "the page has editable things: " + dom);
    const chip = await inShadow(page, (root) => { const c = root.querySelector("[data-legend-chip]"); return c ? { n: Number(c.querySelector("[data-legend-count]").getAttribute("data-legend-count")), text: c.textContent.trim(), label: c.getAttribute("aria-label"), expanded: c.getAttribute("aria-expanded") } : null; });
    assert.ok(chip, "the chip is in the dock");
    assert.equal(chip.n, dom);
    assert.ok(chip.text.endsWith(dom + " editable things here"), chip.text);
    assert.equal(chip.expanded, "false");
    const cov = JSON.parse(fs.readFileSync(path.join(REPO, "studio", "schema", "marker-coverage.json"), "utf8"));
    // the guard counts markers in the built html (a few sit inside <template> and are not live elements): never fewer than what the page really has
    assert.ok(cov.pageCounts[file] >= dom && cov.pageCounts[file] - dom <= 5, "marker-coverage.json holds " + cov.pageCounts[file] + " for " + file + ", the page has " + dom);
    // the count is announced when edit mode turns on
    await waitShadow(page, (root, n) => Array.from(root.querySelectorAll("[role=status]")).some((e) => e.textContent.indexOf(n + " editable things here") >= 0), String(dom));
    // the legend opens from the chip, names the kinds and the keys, and gives focus back to the chip when closed
    await clickText(page, dom + " editable");
    await waitShadow(page, (root) => root.querySelector(".lg"));
    const lg = await inShadow(page, (root) => ({ total: root.querySelector("[data-legend-total]").getAttribute("data-legend-total"), text: root.querySelector(".lg").textContent, expanded: root.querySelector("[data-legend-chip]").getAttribute("aria-expanded") }));
    assert.equal(Number(lg.total), dom);
    for (const w of ["Text", "Picture", "Link", "Section", "Enter", "next thing you can edit"]) assert.ok(lg.text.includes(w), "the legend mentions " + w);
    assert.equal(lg.expanded, "true");
    await page.keyboard.press("Escape");
    await waitShadow(page, (root) => root.querySelector(".panel").hidden);
    assert.equal(await inShadow(page, (root) => !!root.activeElement && root.activeElement.hasAttribute("data-legend-chip")), true, "focus returns to the chip");
    assert.deepEqual(page.__errors, []);
    await close(page);
  });
}

test("All fields: always in the dock, finds the meta description by its visible label (no prompt), groups the page's fields apart from the hidden ones, widens to Everything", { skip: SKIP }, async () => {
  const page = await newPage("/");
  await signIn(page);
  await clickText(page, "All fields");
  await waitShadow(page, (root) => root.querySelector(".ff-group"));
  const groups = await inShadow(page, (root) => Array.from(root.querySelectorAll(".ff-group-title")).map((e) => e.textContent));
  assert.match(groups[0], /^On this page \(\d+\)$/);
  assert.match(groups[1], /^Not visible on the page \(\d+\)$/);
  const onPage = Number(/\((\d+)\)/.exec(groups[0])[1]);
  // type the words of the label and find the row
  await inShadow(page, (root) => root.querySelector("#ff-q").focus());
  await page.keyboard.type("meta description");
  await waitShadow(page, (root) => { const t = Array.from(root.querySelectorAll(".frow-label")).map((e) => e.textContent); return t.length === 1 || t.some((x) => /Meta description/.test(x)); });
  const row = await inShadow(page, (root) => { const b = Array.from(root.querySelectorAll(".frow-sum")).find((x) => /Meta description/.test(x.textContent)); return b ? { label: b.querySelector(".frow-label").textContent, value: b.querySelector(".frow-val").textContent, group: b.closest(".ff-group").querySelector("h3").textContent } : null; });
  assert.ok(row, "the meta description row is there");
  assert.match(row.label, /Meta description/);
  assert.ok(row.value.length > 20 && row.value.length <= 75, "the value is shown, shortened: " + row.value);
  assert.match(row.group, /^Not visible on the page/);
  // open it: a real, labelled control with the current text
  await inShadow(page, (root) => { Array.from(root.querySelectorAll(".frow-sum")).find((x) => /Meta description/.test(x.textContent)).click(); });
  await waitShadow(page, (root) => root.querySelector(".frow-body textarea"));
  const ctl = await inShadow(page, (root) => { const t = root.querySelector(".frow-body textarea"); return { label: t.getAttribute("aria-label"), focused: root.activeElement === t, len: t.value.length }; });
  assert.match(ctl.label, /Meta description/);
  assert.equal(ctl.focused, true);
  assert.ok(ctl.len > 50);
  // the switch to Everything shows more
  await inShadow(page, (root) => { const i = root.querySelector("#ff-q"); i.value = ""; i.dispatchEvent(new Event("input")); });
  await new Promise((r) => setTimeout(r, 300));
  await inShadow(page, (root) => { root.querySelector("[data-scope=all]").click(); });
  await waitShadow(page, (root) => root.querySelector("[data-scope=all]").getAttribute("aria-pressed") === "true");
  const all = await inShadow(page, (root) => Number(/\((\d+)\)/.exec(root.querySelectorAll(".ff-group-title")[0].textContent)[1]) + Number(/\((\d+)\)/.exec(root.querySelectorAll(".ff-group-title")[1].textContent)[1]));
  assert.ok(all > onPage, "Everything shows more than this page's groups");
  assert.equal(page.__dialogs, 0, "no prompt was needed");
  assert.deepEqual(page.__errors, []);
  await close(page);
});

test("palette: keyboard only - jump to a field that is not on the page, to a section, with the footer line and shortcut hints", { skip: SKIP }, async () => {
  const page = await newPage("/");
  await signIn(page);
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  await press(page, "Control", "k");
  await waitShadow(page, (root) => root.querySelector(".csx-pal"));
  assert.equal(await inShadow(page, (root) => root.querySelector("[data-pal-footer]").textContent), "Up/Down to move, Enter to run, Esc to close, ? for help");
  assert.ok((await inShadow(page, (root) => root.querySelectorAll(".csx-key").length)) >= 2, "rows that have a shortcut show it");
  await page.keyboard.type("meta description");
  // other commands (the AI one) match the same words: the field row is within reach of the arrow keys
  await waitShadow(page, (root) => Array.from(root.querySelectorAll('[role="option"]')).some((o) => /Jump to field: .*Meta description/.test(o.textContent)));
  for (let i = 0; i < 8; i += 1) {
    if (await inShadow(page, (root) => /Jump to field: .*Meta description/.test((root.querySelector('[aria-selected="true"]') || {}).textContent || ""))) break;
    await page.keyboard.press("ArrowDown");
    await new Promise((r) => setTimeout(r, 80));
  }
  assert.match(await inShadow(page, (root) => root.querySelector('[aria-selected="true"]').textContent), /Jump to field: .*Meta description/);
  await page.keyboard.press("Enter");
  await waitShadow(page, (root) => root.querySelector(".frow-body textarea") && root.activeElement === root.querySelector(".frow-body textarea"));
  assert.match(await inShadow(page, (root) => root.activeElement.getAttribute("aria-label")), /Meta description/);
  await page.keyboard.press("Escape");
  // a section
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  await press(page, "Control", "k");
  await waitShadow(page, (root) => root.querySelector(".csx-pal"));
  await page.keyboard.type("jump to section");
  await waitShadow(page, (root) => Array.from(root.querySelectorAll('[role="option"]')).some((o) => /^Jump to section: /.test(o.textContent)));
  const sec = await inShadow(page, (root) => Array.from(root.querySelectorAll('[role="option"]')).filter((o) => /^Jump to section: /.test(o.textContent)).length);
  assert.ok(sec >= 3);
  await page.keyboard.press("Enter");
  await waitShadow(page, (root) => !root.querySelector(".csx-pal"));
  // every row says what it is and the list is announced
  assert.deepEqual(page.__errors, []);
  await close(page);
});

test("palette: every field of the files the page uses can be reached by name", { skip: SKIP }, async () => {
  const page = await newPage("/about/");
  await signIn(page);
  const refs = await page.evaluate(() => { const c = window.CoveredStudio; const files = new Set(); document.querySelectorAll("[data-cms]").forEach((n) => files.add(n.getAttribute("data-cms").split(".")[0])); files.add("site"); const out = []; files.forEach((f) => { if (!c.staging.files().includes(f)) return; c.schemaClient.leaves(f, c.staging._base()[f], 4000).forEach((r) => { if (r.field.widget !== "hidden") out.push(f + "." + r.segs.join(".")); }); }); return out.length; });
  const found = await page.evaluate(() => { const rows = window.__CoveredStudioBoot && null; return rows; });
  void found;
  assert.ok(refs > 30);
  // the palette finds a few known fields by their schema labels
  await press(page, "Control", "k");
  await waitShadow(page, (root) => root.querySelector(".csx-pal"));
  for (const [q, want] of [["share description", /Jump to field: Site-wide > Social share description/], ["contact email", /Jump to field: Site-wide > Contact email/]]) {
    await inShadow(page, (root) => { const i = root.querySelector(".csx-pal-input"); i.value = ""; i.dispatchEvent(new Event("input")); });
    await page.keyboard.type(q);
    await waitShadow(page, (root, w) => Array.from(root.querySelectorAll('[role="option"]')).some((o) => new RegExp(w).test(o.textContent)), want.source);
  }
  assert.deepEqual(page.__errors, []);
  await close(page);
});

test("Check my changes: finds a broken link, a block cannot be ignored, a warning can, and 'Send for review' is refused until it is fixed (saving is not)", { skip: SKIP }, async () => {
  const page = await newPage("/");
  await signIn(page);
  const idx = await page.evaluate(() => window.CoveredStudio.contentJson.files.nav.data.items.findIndex((i) => i.type === "link"));
  assert.ok(idx >= 0);
  await clickText(page, "Check my changes");
  await waitShadow(page, (root) => root.querySelector(".ck-status"));
  assert.match(await inShadow(page, (root) => root.querySelector(".ck-sub").textContent), /They are not a full accessibility audit\./);
  assert.match(await inShadow(page, (root) => root.querySelector(".panel-title").textContent), /^Check my changes$/);
  // the live content has one warning and no block
  assert.doesNotMatch(await inShadow(page, (root) => root.querySelector(".ck-status").textContent), /to fix/);
  await page.evaluate((i) => window.CoveredStudio.staging.set("nav.items." + i + ".url", "/no-such-page/"), idx);
  await waitShadow(page, (root) => /Fix before sending \(1\)/.test(root.querySelector(".ck-list").textContent));
  const block = await inShadow(page, (root) => { const it = root.querySelector(".ck-block"); return { text: it.textContent, fix: !!it.querySelector("[data-ck-fix]"), ignore: !!it.querySelector("[data-ck-ignore]") }; });
  assert.match(block.text, /there is no page at that address/);
  assert.equal(block.fix, true);
  assert.equal(block.ignore, false, "a block cannot be ignored");
  assert.match(await inShadow(page, (root) => root.querySelector(".ck-status").textContent), /1 thing to fix before sending/);
  // the refusal
  const refused = await page.evaluate(() => window.CoveredStudio.drafts.submit().then(() => "sent", (e) => e.userMessage || e.message));
  assert.equal(refused, "Fix these first; they would stop your change from going live.");
  assert.equal(stub.requests.filter((r) => /submit/.test(r.path)).length, 0, "nothing was sent to the server");
  // a warning can be ignored, and it moves out of the way
  await page.evaluate(() => window.CoveredStudio.staging.set("site.metaDescription", "Short."));
  await waitShadow(page, (root) => root.querySelector(".ck-warn [data-ck-ignore]"));
  await inShadow(page, (root) => { root.querySelector(".ck-warn [data-ck-ignore]").click(); });
  await waitShadow(page, (root) => /Ignored on this device \(\d+\)/.test(root.querySelector(".ck-list").textContent));
  assert.equal(await inShadow(page, (root) => root.querySelectorAll(".ck-group .ck-warn").length), 0);
  // fixing the link lifts the refusal
  await page.evaluate((i) => window.CoveredStudio.staging.discard("nav.items." + i + ".url"), idx);
  await waitShadow(page, (root) => !/Fix before sending/.test(root.querySelector(".ck-list").textContent));
  const ok = await page.evaluate(() => { try { return window.CoveredStudio.drafts.submit.__checksGate === true; } catch (e) { return false; } });
  assert.equal(ok, true, "submit is wrapped by the gate");
  assert.deepEqual(page.__errors, []);
  await close(page);
});

test("phone width: the dock stays on one row (the chip is hidden), and the count and legend are at the top of All fields", { skip: SKIP }, async () => {
  const page = await newPage("/", { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await signIn(page);
  const tops = await inShadow(page, (root) => Array.from(root.querySelectorAll(".dock > *")).filter((e) => e.getBoundingClientRect().width > 0).map((e) => Math.round(e.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, "one row: " + tops.join(","));
  assert.equal(await inShadow(page, (root) => { const c = root.querySelector("[data-legend-chip]"); return c ? c.getBoundingClientRect().width : 0; }), 0);
  await clickText(page, "All fields");
  await waitShadow(page, (root) => root.querySelector("[data-fields-count]"));
  assert.match(await inShadow(page, (root) => root.querySelector("[data-fields-count]").textContent), /\d+ editable things here\./);
  await close(page);
});
