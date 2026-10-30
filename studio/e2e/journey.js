#!/usr/bin/env node
"use strict";
// npm run check:studio-e2e  -  the whole Studio journey on this machine, nothing leaves loopback:
//
//   node studio/e2e/journey.js [--quick] [--keep]
//
//   * a real git repository (a copy of this working tree) acts as GitHub: the LOCAL git provider keeps branches and pull
//     requests in it; the API is the real handler on a Node http server with the dev auth stub (STUDIO_DEV=1, localhost);
//   * the preview is a real CMS_EDIT=1 build of that repository, served on a second loopback port;
//   * headless Chrome (puppeteer-core) plays Molly (editor): edits the headline, replaces a photo and its description, hides a
//     section, saves ONE draft;  then Amelia (approver) publishes it, opens History and presses Restore.
//   Asserted on the git side: the draft touches exactly the right data files and the new picture, the pull request body is
//   plain English, the draft branch BUILDS and passes the repository's own guards (the list in `npm run check`, plus the
//   studio-scope guard), publishing lands only those files on main, the revert pull request undoes exactly them.
//
// --quick runs only check:cms, check:copy and check:images on each draft instead of every guard (the draft is still built).
// Needs puppeteer-core and Chrome/Edge (STUDIO_PUPPETEER, STUDIO_CHROME); without them the script says so and exits 0 with
// "SKIPPED" (use --require-browser to make that a failure).  Not part of CI: see studio/README.md ("Journey").

const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const assert = require("assert/strict");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const QUICK = process.argv.includes("--quick");
const KEEP = process.argv.includes("--keep");
const REQUIRE_BROWSER = process.argv.includes("--require-browser");

const { loadConfig, buildDeps } = require("../api/config");
const { createHandler } = require("../api/handler");
const { createNodeServer } = require("../api/adapters/node");
const { createLocalGit } = require("../api/providers/git/local-git");
const { createMemoryRoles, DEV_PEOPLE } = require("../api/providers/roles/memory");
const { createAudit, memorySink } = require("../api/audit");
const { loadSchema } = require("../tests/fixtures/schema-from-config");
const { reservedIds } = require("../../lib/reserved-ids");

const step = (m) => console.log("journey  " + m);
const GIT_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: "journey", GIT_AUTHOR_EMAIL: "journey@example.invalid", GIT_COMMITTER_NAME: "journey", GIT_COMMITTER_EMAIL: "journey@example.invalid", GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd, args, o) => {
  const r = spawnSync("git", ["-C", cwd].concat(args), Object.assign({ encoding: "utf8", env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 }, o || {}));
  if (r.status !== 0 && !(o && o.allowFail)) throw new Error("git " + args.join(" ") + ": " + String(r.stderr).slice(0, 300));
  return r;
};

// ---------------------------------------------------------------- browser discovery
function loadPuppeteer() {
  const c = [process.env.STUDIO_PUPPETEER, "puppeteer-core"].filter(Boolean);
  for (const p of c) { try { return require(p); } catch (e) { /* next */ } }
  return null;
}
function findChrome() {
  const c = [process.env.STUDIO_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return c.find((p) => p && fs.existsSync(p)) || null;
}

// ---------------------------------------------------------------- helpers
function makePng(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE((zlib.crc32 ? zlib.crc32(td) : 0) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, (_, i) => [rgb[0], (rgb[1] + i * 7) & 255, rgb[2]]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function copyTree(dest) {
  const list = spawnSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.split("\0").filter(Boolean);
  for (const rel of list) {
    if (/^(frames|\.claude|node_modules|_site|_site-edit)\//.test(rel) || rel === ".gitignore") continue;
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from) || fs.statSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, rel));
  }
}
function link(dir) {
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(ROOT, "node_modules"), nm, "junction");
}
function unlink(dir) {
  const nm = path.join(dir, "node_modules");
  try { if (fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm); } catch (e) { /* not there */ }
}
function guardCommands() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const chain = String(pkg.scripts.check).split("&&").map((s) => s.trim().replace(/^npm run /, "")).filter((n) => n && !/^check:studio/.test(n));
  const want = QUICK ? ["check:cms", "check:copy", "check:images"] : chain;
  return want.map((n) => ({ name: n, argv: String(pkg.scripts[n]).replace(/^node /, "").split(/\s+/) }));
}
function eleventyBin(dir) {
  const pkg = path.join(dir, "node_modules", "@11ty", "eleventy", "package.json");
  const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
  return path.join(path.dirname(pkg), typeof json.bin === "string" ? json.bin : json.bin.eleventy);
}
function buildSite(dir, out, edit, extraEnv) {
  fs.rmSync(out, { recursive: true, force: true });
  const env = Object.assign({}, process.env, { CMS_EDIT: edit ? "1" : "", COVERED_IMG_FAST: "1" }, extraEnv || {});
  const r = spawnSync(process.execPath, [eleventyBin(dir), "--quiet", "--output=" + out], { cwd: dir, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("the build failed:\n" + String(r.stdout).slice(-600) + String(r.stderr).slice(-600));
}
// the same as spawnSync but does not block this process, which is also the API and the preview server
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, Object.assign({ windowsHide: true }, opts));
    let out = "";
    const cap = (d) => { out += d; if (out.length > 2000000) out = out.slice(-1000000); };
    c.stdout.on("data", cap);
    c.stderr.on("data", cap);
    c.on("error", (e) => resolve({ status: 1, out: String(e.message) }));
    c.on("close", (status) => resolve({ status: status === null ? 1 : status, out }));
  });
}
async function buildSiteAsync(dir, out, edit, extraEnv) {
  fs.rmSync(out, { recursive: true, force: true });
  const env = Object.assign({}, process.env, { CMS_EDIT: edit ? "1" : "", COVERED_IMG_FAST: "1" }, extraEnv || {});
  const r = await run(process.execPath, [eleventyBin(dir), "--quiet", "--output=" + out], { cwd: dir, env });
  if (r.status !== 0) throw new Error("the build failed:\n" + r.out.slice(-600));
}
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".mp4": "video/mp4", ".xml": "application/xml", ".txt": "text/plain" };
function staticServer(dirRef) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const rel = decodeURIComponent(u.pathname);
    if (rel.includes("\0") || rel.split("/").includes("..")) { res.writeHead(400); res.end(); return; }
    let file = path.join(dirRef.dir, rel);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
}
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// ---------------------------------------------------------------- main
const jobsRef = {};

async function main() {
  const puppeteer = loadPuppeteer();
  const chrome = findChrome();
  if (!puppeteer || !chrome) {
    console.log("journey  SKIPPED: " + (!puppeteer ? "puppeteer-core is not installed (set STUDIO_PUPPETEER)" : "no Chrome/Edge found (set STUDIO_CHROME)"));
    process.exit(REQUIRE_BROWSER ? 1 : 0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-journey-"));
  const origin = path.join(tmp, "origin");
  fs.mkdirSync(origin);
  const servers = [];
  let browser = null;
  const pngFile = path.join(tmp, "Journey Photo.PNG");
  try {
    step("copying the working tree into a real git repository (this is the stand-in for GitHub)");
    copyTree(origin);
    git(origin, ["init", "--quiet", "-b", "main"]);
    git(origin, ["add", "-A"]);
    git(origin, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed"]);

    // servers: the preview first (its port is an allowed origin), then the API
    const siteDir = { dir: path.join(tmp, "site-edit") };
    const siteServer = staticServer(siteDir);
    servers.push(siteServer);
    const sitePort = await listen(siteServer);
    const siteOrigin = "http://localhost:" + sitePort;

    // CI stand-in. Like GitHub Actions it is asynchronous: the first time it is asked it starts the run in a throw-away
    // clone of the draft branch and answers "in progress"; later questions get the finished result.
    const jobs = new Map(); jobsRef.map = jobs; // headSha -> { done, runs, failed, scope }
    async function runChecks(headSha, repoDir, job) {
      const dir = path.join(tmp, "ci-" + headSha.slice(0, 8));
      await run("git", ["clone", "--quiet", repoDir, dir], { env: GIT_ENV });
      await run("git", ["-C", dir, "checkout", "--quiet", "--detach", headSha], { env: GIT_ENV });
      link(dir);
      const failed = [];
      // 1 the draft BUILDS (normal production build, then the edit build)
      for (const edit of [false, true]) {
        try { await buildSiteAsync(dir, path.join(tmp, "ci-build-" + headSha.slice(0, 8) + (edit ? "-edit" : "")), edit, null); } catch (e) { failed.push("build" + (edit ? " (CMS_EDIT=1)" : "") + ": " + String(e.message).slice(0, 200)); }
      }
      // 2 the repository's own guards
      for (const g of guardCommands()) {
        const r = await run(process.execPath, g.argv, { cwd: dir, env: Object.assign({}, process.env, { GUARD_STRICT_STALE: "", GITHUB_ACTIONS: "", CMS_EDIT: "" }) });
        if (r.status !== 0) failed.push(g.name + ": " + r.out.split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 300));
      }
      // 3 the scope guard against main (the copy from this checkout, as the workflow runs main's copy)
      const sc = await run(process.execPath, [path.join(ROOT, "studio", "guards", "check-scope.js"), "--root", dir, "--base", "main", "--head", headSha], {});
      unlink(dir);
      job.failed = failed;
      job.scope = sc.status === 0 ? null : sc.out.trim().split("\n").slice(-3).join(" | ");
      job.runs = [
        { name: "Build and guards", status: "completed", conclusion: failed.length ? "failure" : "success" },
        { name: "studio-scope", status: "completed", conclusion: sc.status === 0 ? "success" : "failure" },
      ];
      job.done = true;
    }
    async function checkRunner(headSha, repoDir) {
      let job = jobs.get(headSha);
      if (!job) {
        job = { done: false };
        jobs.set(headSha, job);
        job.promise = runChecks(headSha, repoDir, job).catch((e) => { job.failed = ["the check runner crashed: " + e.message]; job.scope = null; job.runs = [{ name: "Build and guards", status: "completed", conclusion: "failure" }]; job.done = true; });
      }
      return job.done ? job.runs : [{ name: "Build and guards", status: "in_progress", conclusion: null }];
    }
    const lg = createLocalGit({ source: origin, dir: path.join(tmp, "host"), baseBranch: "main", checkRunner });
    const sink = memorySink();
    const apiServerRef = {};
    const env = { STUDIO_ENV: "development", STUDIO_DEV: "1", STUDIO_ALLOWED_ORIGINS: siteOrigin, STUDIO_APP_URL: siteOrigin, STUDIO_PREVIEW_URL_TEMPLATE: siteOrigin + "/?draft={pr}" };
    const config = loadConfig(env);
    const deps = buildDeps(config, env, { git: lg, roles: createMemoryRoles(DEV_PEOPLE), audit: createAudit({ sinks: [sink], salt: "journey" }), schema: loadSchema(ROOT), reservedIds: reservedIds(ROOT) });
    const baseHandler = createHandler(deps);
    const api = createNodeServer(process.env.JDBG ? async (req) => { const r = await baseHandler(req); console.log("API", req.method, new URL(req.url).pathname, r.status, req.headers.get("content-length")); if (r.status >= 400) console.log("API-BODY", (await r.clone().text()).slice(0, 400)); return r; } : baseHandler);
    servers.push(api);
    const apiPort = await listen(api);
    apiServerRef.url = "http://localhost:" + apiPort;
    step("API on " + apiServerRef.url + "  preview on " + siteOrigin + "  (dev auth stub, local git provider)");

    // The preview is a CMS_EDIT=1 build of the repository's main
    link(origin);
    const buildPreview = () => buildSite(origin, siteDir.dir, true, { STUDIO_API_URL: apiServerRef.url, STUDIO_APP_URL: siteOrigin });
    // the build runs inside the temp repository, so its main is what History/Restore operate on
    buildPreview();
    step("edit build ready (CMS_EDIT=1)");

    const tokenOf = { editor: "dev:editor:molly@covered.test", approver: "dev:approver:amelia@covered.test" };
    const call = async (who, method, p, body) => {
      // a long-idle keep-alive connection can be closed by the server just as it is reused: try again (every write carries an idempotency key)
      for (let attempt = 1; ; attempt += 1) {
        try {
          const res = await fetch(apiServerRef.url + p, { method, headers: { authorization: "Bearer " + tokenOf[who], origin: siteOrigin, "content-type": "application/json", connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
          const t = await res.text();
          return { status: res.status, json: t ? JSON.parse(t) : null };
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    };
    const mainSha = () => git(lg.repoDir, ["rev-parse", "main"]).stdout.trim();
    const showAt = (ref, file) => git(lg.repoDir, ["show", ref + ":" + file]).stdout;
    const waitChecks = async (who, id) => {
      const t0 = Date.now();
      for (;;) {
        const v = await call(who, "GET", "/v1/drafts/" + id);
        assert.equal(v.status, 200, JSON.stringify(v.json));
        if (v.json.draft.checks.state !== "pending") return v;
        assert.ok(Date.now() - t0 < 20 * 60 * 1000, "the checks never finished");
        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    fs.writeFileSync(pngFile, makePng(640, 480, [200, 30, 90]));
    const heroBefore = JSON.parse(fs.readFileSync(path.join(origin, "src/_data/hero.json"), "utf8"));
    const homeBefore = JSON.parse(fs.readFileSync(path.join(origin, "src/_data/homepage.json"), "utf8"));
    const NEW_HEADLINE = "We cover the whole UK";
    const NEW_ALT = "A student holding a phone next to a COVERED dispenser";

    // ------------------------------------------------------------ 1 Molly in the browser
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"] });
    const errors = [];
    const newPage = async () => {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      page.__ctx = ctx;
      page.on("requestfailed", (r) => { if (process.env.JDBG) console.log("REQFAIL", r.method(), r.url(), r.failure() && r.failure().errorText); });
      page.on("response", (r) => { if (process.env.JDBG && r.url().includes("/v1/")) console.log("RESP", r.status(), r.request().method(), r.url()); });
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
      await page.setViewport({ width: 1280, height: 900 });
      return page;
    };
    const waitShadow = (page, fn, arg, timeout) => page.waitForFunction((src, a) => {
      const host = document.getElementById("covered-studio");
      const root = host && host.shadowRoot;
      return root ? new Function("root", "arg", "return (" + src + ")(root, arg)")(root, a) : null;
    }, { polling: 200, timeout: timeout || 20000 }, fn.toString(), arg);
    const clickText = async (page, text, exact) => {
      const h = await page.waitForFunction((t, ex) => {
        const root = document.getElementById("covered-studio") && document.getElementById("covered-studio").shadowRoot;
        if (!root) return null;
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        return Array.from(root.querySelectorAll("button, a")).find((b) => !b.disabled && vis(b) && (ex ? (b.getAttribute("aria-label") || b.textContent.trim()) === t : (b.textContent.trim().indexOf(t) === 0 || (b.getAttribute("aria-label") || "").indexOf(t) === 0))) || null;
      }, { polling: 200, timeout: 20000 }, text, !!exact);
      await h.asElement().click();
    };
    const shadowText = (page) => page.evaluate(() => document.getElementById("covered-studio").shadowRoot.textContent);
    const signIn = async (page, who) => {
      await page.goto(siteOrigin + "/?studio=1", { waitUntil: "load" });
      await clickText(page, "Edit this page");
      await clickText(page, "Sign in as " + who);
      await page.waitForFunction(() => window.CoveredStudio && window.CoveredStudio.mode === "edit", { polling: 200, timeout: 20000 });
      // the first-run tour appears once per person: it is part of the journey, and it can be skipped
      await waitShadow(page, (r) => r.querySelector(".csx-tour"));
      await clickText(page, "Skip tour");
      await page.waitForFunction(() => !document.getElementById("covered-studio").shadowRoot.querySelector(".csx-tour"), { polling: 200, timeout: 5000 });
    };

    step("Molly (editor) signs in and edits the preview");
    const molly = await newPage();
    await signIn(molly, "Molly");
    await molly.evaluate(() => window.scrollTo(0, 0));
    // the hero headline holds a second editable part inside it (the highlighted words), so Studio opens a small
    // editor for the main part instead of typing into the page: that is part of what is being proven here
    await molly.click('[data-cms="hero.headlineMain"]');
    await waitShadow(molly, (r) => r.querySelector(".dialog input[type=text], .dialog-wrap input[type=text]"));
    const box = (await molly.evaluateHandle(() => document.getElementById("covered-studio").shadowRoot.querySelector(".dialog input[type=text], .dialog-wrap input[type=text]"))).asElement();
    await box.focus();
    await molly.keyboard.down("Control"); await molly.keyboard.press("a"); await molly.keyboard.up("Control");
    await molly.keyboard.type(NEW_HEADLINE);
    if (process.env.JDBG) console.log("DBG4", await molly.evaluate(() => JSON.stringify({vals: Array.from(document.getElementById("covered-studio").shadowRoot.querySelectorAll("input,textarea")).map((i) => i.value), ae: document.getElementById("covered-studio").shadowRoot.activeElement && document.getElementById("covered-studio").shadowRoot.activeElement.tagName, btn: Array.from(document.getElementById("covered-studio").shadowRoot.querySelectorAll("button")).map((b) => b.textContent.trim() + (b.disabled ? "(disabled)" : "")).join("|")})));
    await clickText(molly, "Keep change");
    if (process.env.JDBG) console.log("DBG3", await molly.evaluate(() => JSON.stringify({v: window.CoveredStudio.content.get("hero.headlineMain"), n: window.CoveredStudio.staging.count(), t: document.getElementById("covered-studio").shadowRoot.textContent.slice(0, 400)})));
    await molly.waitForFunction((v) => window.CoveredStudio.content.get("hero.headlineMain") === v, { polling: 200, timeout: 10000 }, NEW_HEADLINE);
    assert.ok((await molly.$eval('[data-cms="hero.headlineMain"]', (e) => e.textContent)).includes(NEW_HEADLINE), "the page shows the new headline");
    step("headline changed");

    // a photo: the first picture marker on the page
    const imgInfo = await molly.evaluate(() => {
      const e = document.querySelector('img[data-cms-kind="image"]');
      e.scrollIntoView({ block: "center" });
      return { key: e.getAttribute("data-cms"), alt: e.getAttribute("data-cms-alt") };
    });
    await new Promise((r) => setTimeout(r, 400));
    await molly.click('img[data-cms="' + imgInfo.key + '"]');
    await waitShadow(molly, (r) => r.querySelector("input[type=file]"));
    const inShadowEl = async (page, sel) => (await page.evaluateHandle((q) => document.getElementById("covered-studio").shadowRoot.querySelector(q), sel)).asElement();
    const fileIn = await inShadowEl(molly, "input[type=file]");
    await fileIn.uploadFile(pngFile);
    await waitShadow(molly, (r) => /Use this picture/.test(r.textContent));
    await waitShadow(molly, (r) => r.querySelector("textarea"));
    const altBox = await inShadowEl(molly, "textarea");
    await altBox.type(NEW_ALT);
    await clickText(molly, "Use this picture");
    await molly.waitForFunction((k) => document.querySelector('img[data-cms="' + k + '"]').src.startsWith("blob:"), { polling: 200, timeout: 20000 }, imgInfo.key);
    step("photo " + imgInfo.key + " replaced, description set");

    // hide a section from the Sections panel (the first optional, currently visible section after the hero)
    await clickText(molly, "Sections", true);
    const hid = await waitShadow(molly, (r) => {
      const boxes = Array.from(r.querySelectorAll("input[type=checkbox]"));
      return boxes.length ? boxes.length : null;
    });
    const hiddenLabel = await molly.evaluate(() => {
      const r = document.getElementById("covered-studio").shadowRoot;
      const boxes = Array.from(r.querySelectorAll("input[type=checkbox]")).filter((b) => b.checked && !b.disabled);
      const b = boxes[boxes.length - 1];
      const label = (b.closest("li, label, div") || b).textContent.trim().slice(0, 60);
      b.click();
      return label;
    });
    step("section hidden: " + JSON.stringify(hiddenLabel));

    await clickText(molly, "Changes", true);
    await waitShadow(molly, (r) => r.querySelector(".panel-body"));
    const review = await shadowText(molly);
    for (const re of [/Changed the text from/, /Uploaded a new picture/, /Hid /]) assert.match(review, re, "the Changes panel says " + re);
    await clickText(molly, "Save draft");
    try { await molly.waitForFunction(() => window.CoveredStudio.staging.count() === 0 && window.CoveredStudio.drafts.current(), { polling: 200, timeout: 60000 }); } catch (e) { throw new Error("saving the draft did not finish (count=" + await molly.evaluate(() => window.CoveredStudio.staging.count() + " draft=" + JSON.stringify(window.CoveredStudio.drafts.current()).slice(0, 200)) + "). Studio says: " + (await shadowText(molly)).slice(0, 1500)); }
    const draftId = await molly.evaluate(() => { const d = window.CoveredStudio.drafts.current(); return typeof d === "string" ? d : d.id; });
    step("saved: draft " + draftId);

    // ------------------------------------------------------------ 2 what reached git
    const list = await call("editor", "GET", "/v1/drafts");
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const view = await call("editor", "GET", "/v1/drafts/" + draftId);
    assert.equal(view.status, 200, JSON.stringify(view.json));
    const draft = view.json.draft;
    const branch = draft.branch;
    const touched = git(lg.repoDir, ["diff", "--name-only", "main", branch]).stdout.trim().split("\n").sort();
    const imgFile = touched.find((f) => /^images\//.test(f));
    assert.ok(imgFile, "the new picture is committed under images/: " + touched.join(", "));
    const dataFiles = touched.filter((f) => !/^images\//.test(f));
    for (const f of touched) assert.match(f, /^(src\/_data\/[A-Za-z0-9._-]+\.json|src\/pages\/[A-Za-z0-9._-]+\.md|images\/[A-Za-z0-9._-]+)$/, "only data, pages and images: " + f);
    const heroAfter = JSON.parse(showAt(branch, "src/_data/hero.json"));
    assert.equal(heroAfter.headlineMain, NEW_HEADLINE, "hero.json carries the new headline");
    assert.notEqual(heroAfter.headlineMain, heroBefore.headlineMain);
    const homeAfter = JSON.parse(showAt(branch, "src/_data/homepage.json"));
    const hiddenCount = homeAfter.sections.filter((s, i) => s.enabled === false && homeBefore.sections[i].enabled !== false).length;
    assert.equal(hiddenCount, 1, "exactly one homepage section was hidden");
    const bytes = git(lg.repoDir, ["cat-file", "blob", branch + ":" + imgFile], { encoding: "buffer" }).stdout;
    assert.ok(Buffer.isBuffer(bytes) ? bytes.length > 100 : bytes.length > 100, "the uploaded picture has bytes");
    step("draft branch " + branch + " touches exactly: " + touched.join(", "));
    const prRaw = await lg.getPr(draft.number);
    const bodyText = String(prRaw.body);
    step("pull request #" + draft.number + " body:\n" + bodyText.split("\n").map((l) => "           | " + l).join("\n"));
    assert.match(bodyText, /changed the text from/i, "the pull request describes the text change in plain words");
    assert.match(bodyText, /swapped the picture/i, "the pull request describes the picture");
    assert.match(bodyText, /hid this section/i, "the pull request describes the hidden section");
    assert.ok(!/\?draft=\d+\/\?studio/.test(bodyText), "the Open-in-Studio link is well formed");
    assert.ok(!/"op"\s*:/.test(bodyText), "the pull request body is not raw JSON patch ops");

    // ------------------------------------------------------------ 3 the draft builds and passes the guards
    step("submitting the draft for review; building it and running " + (QUICK ? "3 guards" : "every guard in npm run check") + " on the draft branch (takes a while)");
    const sub = await call("editor", "POST", "/v1/drafts/" + draftId + "/submit", { idempotencyKey: crypto.randomUUID() });
    assert.ok([200, 201].includes(sub.status), JSON.stringify(sub.json));
    const approverView = await waitChecks("approver", draftId);
    const last = jobs.get(approverView.json.draft.headSha);
    assert.ok(last && last.done, "the check runner ran on the draft head");
    assert.deepEqual(last.failed, [], "the draft failed the build or the guards:\n" + last.failed.join("\n"));
    assert.equal(last.scope, null, "studio-scope: " + last.scope);
    assert.equal(approverView.json.draft.checks.state, "success");
    assert.equal(approverView.json.draft.canPublish, true);
    step("draft builds and passes every guard + studio-scope");

    // ------------------------------------------------------------ 4 Amelia publishes
    const before = mainSha();
    const pub = await call("approver", "POST", "/v1/drafts/" + draftId + "/publish", { expectedHeadSha: approverView.json.draft.headSha, idempotencyKey: crypto.randomUUID() });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    const landed = git(lg.repoDir, ["diff", "--name-only", before, mainSha()]).stdout.trim().split("\n").sort();
    assert.deepEqual(landed, touched, "main gained exactly the draft's files");
    assert.equal(JSON.parse(showAt("main", "src/_data/hero.json")).headlineMain, NEW_HEADLINE);
    step("published: main changed " + landed.join(", ") + " and nothing else");

    // ------------------------------------------------------------ 5 History -> Restore -> revert PR (browser, Amelia)
    step("Amelia opens History and presses Restore");
    const amelia = await newPage();
    await signIn(amelia, "Amelia");
    await amelia.keyboard.down("Control"); await amelia.keyboard.press("k"); await amelia.keyboard.up("Control");
    await waitShadow(amelia, (r) => r.querySelector(".csx-pal"));
    await amelia.keyboard.type("history");
    await amelia.keyboard.press("Enter");
    await waitShadow(amelia, (r) => r.querySelectorAll(".csx-row").length >= 1);
    const rows = await amelia.evaluate(() => Array.from(document.getElementById("covered-studio").shadowRoot.querySelectorAll(".csx-row")).map((x) => ({ title: x.querySelector(".csx-row-title").textContent, meta: x.querySelector(".csx-meta").textContent, restore: x.querySelector("[data-restore]") ? x.querySelector("[data-restore]").getAttribute("data-restore") : null })));
    assert.ok(rows.length >= 1 && rows[0].restore, "History lists the merged change with a Restore button: " + JSON.stringify(rows));
    assert.match(rows[0].meta, /Molly/, "History names the author");
    assert.match(rows[0].meta, /ago|now|Today|just/i, "History says when");
    step("History: " + JSON.stringify(rows[0].title) + " by " + rows[0].meta);
    await waitShadow(amelia, (r, n) => r.querySelector('[data-restore="' + n + '"]:not([disabled])'), rows[0].restore);
    await amelia.evaluate((n) => document.getElementById("covered-studio").shadowRoot.querySelector('[data-restore="' + n + '"]').click(), rows[0].restore);
    await waitShadow(amelia, (r) => r.querySelector('[role="dialog"]'));
    await clickText(amelia, "Create undo draft");
    // success: Studio says so, then moves to the new draft in the Changes panel
    try { await waitShadow(amelia, (r) => r.textContent.indexOf("Draft created") >= 0, undefined, 90000); } catch (e) { throw new Error("Restore gave no answer (" + String(e.message).slice(0, 200) + "). Studio says: " + (await shadowText(amelia)).slice(0, 800)); }
    await amelia.waitForFunction(() => window.CoveredStudio.drafts.current() && window.CoveredStudio.drafts.current().id, { polling: 200, timeout: 20000 });
    const restoredId = await amelia.evaluate(() => window.CoveredStudio.drafts.current().id);
    step("Restore opened an undo draft");

    const all = await call("approver", "GET", "/v1/drafts");
    assert.equal(all.status, 200, JSON.stringify(all.json));
    const revertDraft = (all.json.drafts || all.json.items || []).find((d) => d.id === restoredId);
    assert.ok(revertDraft && revertDraft.id !== draftId, "the revert draft is listed: " + JSON.stringify(all.json).slice(0, 400));
    const revertBranch = (await call("approver", "GET", "/v1/drafts/" + revertDraft.id)).json.draft.branch;
    const revTouched = git(lg.repoDir, ["diff", "--name-only", "main", revertBranch]).stdout.trim().split("\n").sort();
    assert.ok(revTouched.includes("src/_data/hero.json") && revTouched.includes("src/_data/homepage.json"), "the revert draft touches the files the change touched: " + revTouched.join(", "));
    assert.equal(JSON.parse(showAt(revertBranch, "src/_data/hero.json")).headlineMain, heroBefore.headlineMain, "the revert draft puts the old headline back");
    assert.deepEqual(JSON.parse(showAt(revertBranch, "src/_data/homepage.json")).sections.map((s) => s.enabled), homeBefore.sections.map((s) => s.enabled), "the revert draft shows the section again");
    step("revert draft " + revertDraft.id + " restores exactly: " + revTouched.join(", "));
    await call("approver", "POST", "/v1/drafts/" + revertDraft.id + "/submit", { idempotencyKey: crypto.randomUUID() });
    const revView = await waitChecks("approver", revertDraft.id);
    const revLast = jobs.get(revView.json.draft.headSha);
    assert.ok(revLast && revLast.done, "the check runner ran on the revert draft head");
    assert.deepEqual(revLast.failed, [], "the revert draft failed the build or the guards:\n" + revLast.failed.join("\n"));
    assert.equal(revLast.scope, null);
    assert.equal(revView.json.draft.checks.state, "success");
    step("revert draft builds and passes every guard");
    assert.deepEqual(errors, [], "no page errors in either browser session");
    await molly.__ctx.close();
    await amelia.__ctx.close();
    console.log("journey  OK: edit headline + swap photo + hide section -> one draft (" + touched.length + " files) builds and passes the guards -> published -> History -> Restore -> revert draft builds and passes the guards");
  } catch (e) {
    console.error("journey  FAILED: " + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const s of servers) s.close();
    // a check run may still be going (for example the undo draft's): let it finish before its folder is removed
    await Promise.allSettled(Array.from(jobsRef.map ? jobsRef.map.values() : []).map((j) => j.promise).filter(Boolean));
    try { unlink(origin); } catch (e) { /* ignore */ }
    try { unlink(path.join(tmp, "host", "repo")); } catch (e) { /* ignore */ }
    if (KEEP) console.log("journey  kept " + tmp);
    else { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { console.log("journey  note: could not remove " + tmp + " (" + e.code + ")"); } }
  }
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("journey  FAILED: " + (e && e.stack || e)); process.exit(1); });
