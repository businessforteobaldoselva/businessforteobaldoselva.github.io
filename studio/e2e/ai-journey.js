#!/usr/bin/env node
"use strict";
// npm run studio:ai-journey  -  the Phase 5 "Describe a change" journey on this machine, REPLAY provider, no key, no network:
//
//   node studio/e2e/ai-journey.js [--quick] [--keep] [--require-browser]
//
//   Same set-up as journey.js (local git acts as GitHub, real API handler with the dev auth stub, a CMS_EDIT=1 preview, headless
//   Chrome), with the AI layer switched on and its provider replaced by recorded answers (studio/ai-eval/fixtures).
//   1  Molly asks "make the hero shorter and warmer", sees Before/After for three changes, unticks one, saves ONE draft:
//      the draft branch holds exactly the two accepted ops (and nothing else), builds and passes every repo guard + studio-scope.
//   2  Amelia publishes it (the role gate is unchanged), then History -> Restore puts the old words back (one click).
//   3  Discard path: ask, press Discard: no branch, no pull request.
//   4  Needs-code path: "make the hero video autoplay with a parallax effect" -> a ready-to-send request, no draft, no code touched.
//   5  Hostile model output (markup in a value; a CI workflow as target): a plain refusal, no draft, nothing written.
// Skips (exit 0) without puppeteer-core or Chrome unless --require-browser.  Not part of CI.

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

const step = (m) => console.log("ai-journey  " + m);
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
const FIX = path.join(__dirname, "..", "ai-eval", "fixtures");
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + ".json"), "utf8"));

async function main() {
  const puppeteer = loadPuppeteer();
  const chrome = findChrome();
  if (!puppeteer || !chrome) {
    console.log("ai-journey  SKIPPED: " + (!puppeteer ? "puppeteer-core is not installed (set STUDIO_PUPPETEER)" : "no Chrome/Edge found (set STUDIO_CHROME)"));
    process.exit(REQUIRE_BROWSER ? 1 : 0);
  }
  const { loadRecordings, expand } = require("../ai-eval/recordings");
  const { createReplayProvider } = require("../api/ai/providers/replay");
  const prop = require("../api/ai/proposal");

  // recorded answers for the sample requests, plus the two hostile ones this journey plays
  const { recordings } = await loadRecordings();
  for (const n of ["A05-markup-in-value", "A03-workflow-file"]) {
    const fx = fixture(n);
    recordings[await prop.replayKey(fx.request.mode, fx.request.instruction.trim(), "", (fx.request.context && fx.request.context.refs) || [], false, "default")] = expand(fx.recorded);
  }
  const replay = createReplayProvider({ recordings });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ai-journey-"));
  const origin = path.join(tmp, "origin");
  fs.mkdirSync(origin);
  const servers = [];
  let browser = null;
  try {
    step("copying the working tree into a real git repository (the stand-in for GitHub)");
    copyTree(origin);
    git(origin, ["init", "--quiet", "-b", "main"]);
    git(origin, ["add", "-A"]);
    git(origin, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed"]);

    const siteDir = { dir: path.join(tmp, "site-edit") };
    const siteServer = staticServer(siteDir);
    servers.push(siteServer);
    const sitePort = await listen(siteServer);
    const siteOrigin = "http://localhost:" + sitePort;

    const jobs = new Map(); jobsRef.map = jobs;
    async function runChecks(headSha, repoDir, job) {
      const dir = path.join(tmp, "ci-" + headSha.slice(0, 8));
      await run("git", ["clone", "--quiet", repoDir, dir], { env: GIT_ENV });
      await run("git", ["-C", dir, "checkout", "--quiet", "--detach", headSha], { env: GIT_ENV });
      link(dir);
      const failed = [];
      for (const edit of [false, true]) {
        try { await buildSiteAsync(dir, path.join(tmp, "ci-build-" + headSha.slice(0, 8) + (edit ? "-edit" : "")), edit, null); } catch (e) { failed.push("build" + (edit ? " (CMS_EDIT=1)" : "") + ": " + String(e.message).slice(0, 200)); }
      }
      const ran = [];
      for (const g of guardCommands()) {
        const r = await run(process.execPath, g.argv, { cwd: dir, env: Object.assign({}, process.env, { GUARD_STRICT_STALE: "", GITHUB_ACTIONS: "", CMS_EDIT: "" }) });
        ran.push(g.name);
        if (r.status !== 0) failed.push(g.name + ": " + r.out.split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 300));
      }
      const sc = await run(process.execPath, [path.join(ROOT, "studio", "guards", "check-scope.js"), "--root", dir, "--base", "main", "--head", headSha], {});
      unlink(dir);
      job.failed = failed; job.ran = ran;
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
        job.promise = runChecks(headSha, repoDir, job).catch((e) => { job.failed = ["the check runner crashed: " + e.message]; job.ran = []; job.scope = null; job.runs = [{ name: "Build and guards", status: "completed", conclusion: "failure" }]; job.done = true; });
      }
      return job.done ? job.runs : [{ name: "Build and guards", status: "in_progress", conclusion: null }];
    }
    const lg = createLocalGit({ source: origin, dir: path.join(tmp, "host"), baseBranch: "main", checkRunner });
    const sink = memorySink();
    const apiRef = {};
    const env = { STUDIO_ENV: "development", STUDIO_DEV: "1", STUDIO_ALLOWED_ORIGINS: siteOrigin, STUDIO_APP_URL: siteOrigin, STUDIO_PREVIEW_URL_TEMPLATE: siteOrigin + "/?draft={pr}", STUDIO_AI_ENABLED: "1", STUDIO_AI_PROVIDER: "replay" };
    const config = loadConfig(env);
    const deps = buildDeps(config, env, { git: lg, roles: createMemoryRoles(DEV_PEOPLE), audit: createAudit({ sinks: [sink], salt: "ai-journey" }), schema: loadSchema(ROOT), reservedIds: reservedIds(ROOT), aiProvider: replay });
    const api = createNodeServer(createHandler(deps));
    servers.push(api);
    const apiPort = await listen(api);
    apiRef.url = "http://localhost:" + apiPort;
    step("API on " + apiRef.url + "  preview on " + siteOrigin + "  (dev auth, local git, AI provider = replay)");

    link(origin);
    buildSite(origin, siteDir.dir, true, { STUDIO_API_URL: apiRef.url, STUDIO_APP_URL: siteOrigin });
    step("edit build ready (CMS_EDIT=1)");

    const tokenOf = { editor: "dev:editor:molly@covered.test", approver: "dev:approver:amelia@covered.test" };
    const call = async (who, method, p, body) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const res = await fetch(apiRef.url + p, { method, headers: { authorization: "Bearer " + tokenOf[who], origin: siteOrigin, "content-type": "application/json", connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
          const t = await res.text();
          return { status: res.status, json: t ? JSON.parse(t) : null };
        } catch (e) { if (attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 500)); }
      }
    };
    const mainSha = () => git(lg.repoDir, ["rev-parse", "main"]).stdout.trim();
    const showAt = (ref, file) => git(lg.repoDir, ["show", ref + ":" + file]).stdout;
    const branches = () => git(lg.repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).stdout.split("\n").filter(Boolean).sort();
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

    const heroBefore = JSON.parse(fs.readFileSync(path.join(origin, "src/_data/hero.json"), "utf8"));
    const fx1 = fixture("01-hero-shorter-warmer");
    const ops1 = fx1.recorded.toolInputs[0].changes.map((c) => c.ops[0]);
    const accepted = [ops1[0], ops1[2]]; // c1 headlineMain, c3 subhead; c2 (headlineAccent) is left out

    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"] });
    const errors = [];
    const newPage = async () => {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      page.__ctx = ctx;
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
    const inShadow = (page, fn, arg) => page.evaluate((src, a) => new Function("root", "arg", "return (" + src + ")(root, arg)")(document.getElementById("covered-studio").shadowRoot, a), fn.toString(), arg);
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
      await waitShadow(page, (r) => r.querySelector(".csx-tour"));
      await clickText(page, "Skip tour");
      await page.waitForFunction(() => !document.getElementById("covered-studio").shadowRoot.querySelector(".csx-tour"), { polling: 200, timeout: 5000 });
    };
    const openAi = async (page) => {
      await clickText(page, "Describe a change", true);
      await waitShadow(page, (r) => r.querySelector(".csx-ai [data-phase='idle']"));
    };
    // type like a person: focus the box, type, press the button
    const ask = async (page, text) => {
      // a pre-selected element travels with the request as context; these samples are page-wide, so clear any chip first
      await inShadow(page, (r) => { Array.from(r.querySelectorAll(".csx-ai-x")).forEach((b) => b.click()); });
      const box = (await page.evaluateHandle(() => document.getElementById("covered-studio").shadowRoot.querySelector("#csx-ai-instr"))).asElement();
      await box.focus();
      await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(text);
      await clickText(page, "Suggest changes");
      await waitShadow(page, (r) => r.querySelector(".csx-ai [data-kind], .csx-ai [data-phase='error'], .csx-ai [data-phase='off']"), undefined, 30000);
    };
    const resultKind = (page) => inShadow(page, (r) => { const e = r.querySelector(".csx-ai [data-kind], .csx-ai [data-phase]"); return e ? (e.getAttribute("data-kind") || e.getAttribute("data-phase")) : null; });

    // ------------------------------------------------------------ 1 partial accept
    step("1  Molly asks for a shorter, warmer hero and accepts only some of it");
    const molly = await newPage();
    await signIn(molly, "Molly");
    await openAi(molly);
    const b0 = branches(), main0 = mainSha();
    await ask(molly, "make the hero shorter and warmer");
    assert.equal(await resultKind(molly), "patch");
    assert.deepEqual(branches(), b0, "asking writes nothing: no new branch");
    assert.equal(mainSha(), main0);
    const shown = await inShadow(molly, (r) => ({
      cards: r.querySelectorAll(".csx-ai-card").length,
      deltas: r.querySelectorAll(".csx-ai-delta").length,
      before: r.querySelectorAll(".csx-ai-before").length,
      after: r.querySelectorAll(".csx-ai-after").length,
      save: r.querySelector("[data-act='save']").textContent,
      text: r.textContent,
      afterText: Array.from(r.querySelectorAll(".csx-ai-after")).map((e) => e.textContent.replace(/\[(added|removed)\] /g, "").replace(/\s+/g, " ")).join(" | "),
      beforeText: Array.from(r.querySelectorAll(".csx-ai-before")).map((e) => e.textContent.replace(/\[(added|removed)\] /g, "").replace(/\s+/g, " ")).join(" | "),
    }));
    assert.equal(shown.cards, 3, "three suggested changes");
    assert.ok(shown.deltas >= 3 && shown.before >= 3 && shown.after >= 3, "every change shows a Before and an After: " + JSON.stringify(Object.assign({}, shown, { text: undefined })));
    assert.equal(shown.save, "Save 3 changes as a draft");
    assert.ok(shown.beforeText.indexOf(heroBefore.headlineMain) >= 0, "the Before side shows the real current headline");
    assert.ok(shown.afterText.indexOf(ops1[0].value) >= 0, "the After side shows the proposed headline: " + shown.afterText.slice(0, 300));
    // leave out the middle change
    await inShadow(molly, (r) => r.querySelector("[data-card='c2'] input[type=checkbox]").click());
    await waitShadow(molly, (r) => r.querySelector("[data-act='save']").textContent === "Save 2 changes as a draft");
    await clickText(molly, "Save 2 changes as a draft");
    await waitShadow(molly, (r) => r.querySelector(".csx-ai [data-phase='saved']"), undefined, 60000);
    const savedText = await shadowText(molly);
    assert.match(savedText, /Nothing is live yet/, "the saved screen says nothing is live");
    assert.match(savedText, /1 left out/);
    step("saved: 2 of 3 changes");

    const list = await call("editor", "GET", "/v1/drafts");
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const drafts = list.json.drafts || list.json.items || [];
    assert.equal(drafts.length, 1, "exactly one draft exists");
    const draftId = drafts[0].id;
    const draft = (await call("editor", "GET", "/v1/drafts/" + draftId)).json.draft;
    const branch = draft.branch;
    const touched = git(lg.repoDir, ["diff", "--name-only", "main", branch]).stdout.trim().split("\n").sort();
    assert.deepEqual(touched, ["src/_data/hero.json"], "the branch touches only the hero data file");
    const heroAfter = JSON.parse(showAt(branch, "src/_data/hero.json"));
    const expected = Object.assign({}, heroBefore, { headlineMain: accepted[0].value, subhead: accepted[1].value });
    assert.deepEqual(heroAfter, expected, "the draft holds EXACTLY the two accepted ops and the left-out change did not happen");
    assert.equal(heroAfter.headlineAccent, heroBefore.headlineAccent);
    const body = String((await lg.getPr(draft.number)).body);
    assert.match(body, /Drafted with AI/, "the pull request says the AI drafted it");
    assert.ok(!/"op"\s*:/.test(body), "plain English, not raw ops");
    step("draft branch " + branch + " holds exactly the 2 accepted ops (hero.json headlineMain + subhead)");
    const audited = sink.entries.filter((e) => /^ai\./.test(e.action || ""));
    assert.ok(audited.some((e) => e.action === "ai.propose") && audited.some((e) => e.action === "ai.accept" && e.outcome === "ok"), "propose and accept are in the audit log: " + audited.map((e) => e.action + ":" + e.outcome).join(","));
    assert.ok(!JSON.stringify(sink.entries).includes("make the hero shorter"), "the audit log keeps a hash, not the instruction text");

    // send for review from the panel, then the guards
    step("sending for review; building the draft and running " + (QUICK ? "3 guards" : "every guard in npm run check") + " on the draft branch (takes a while)");
    await clickText(molly, "Send for review");
    const approverView = await waitChecks("approver", draftId);
    const last = jobs.get(approverView.json.draft.headSha);
    assert.ok(last && last.done, "the check runner ran on the draft head");
    assert.deepEqual(last.failed, [], "the AI draft failed the build or the guards:\n" + last.failed.join("\n"));
    assert.equal(last.scope, null, "studio-scope: " + last.scope);
    assert.equal(approverView.json.draft.checks.state, "success");
    step("AI draft builds and passes " + last.ran.length + " repo guards + studio-scope");

    // an editor cannot publish; the approver can: the role gate is unchanged
    const denied = await call("editor", "POST", "/v1/drafts/" + draftId + "/publish", { expectedHeadSha: approverView.json.draft.headSha, idempotencyKey: crypto.randomUUID() });
    assert.equal(denied.status, 403, "an Editor cannot publish an AI draft: " + JSON.stringify(denied.json));
    const before = mainSha();
    const pub = await call("approver", "POST", "/v1/drafts/" + draftId + "/publish", { expectedHeadSha: approverView.json.draft.headSha, idempotencyKey: crypto.randomUUID() });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    const landed = git(lg.repoDir, ["diff", "--name-only", before, mainSha()]).stdout.trim().split("\n").sort();
    assert.deepEqual(landed, ["src/_data/hero.json"]);
    assert.equal(JSON.parse(showAt("main", "src/_data/hero.json")).headlineMain, accepted[0].value);
    step("Amelia published it: main changed src/_data/hero.json only");

    // ------------------------------------------------------------ 2 revert in one click
    step("2  Amelia opens History and presses Restore (one click undoes the AI change)");
    const amelia = await newPage();
    await signIn(amelia, "Amelia");
    await amelia.keyboard.down("Control"); await amelia.keyboard.press("k"); await amelia.keyboard.up("Control");
    await waitShadow(amelia, (r) => r.querySelector(".csx-pal"));
    await amelia.keyboard.type("history");
    await amelia.keyboard.press("Enter");
    await waitShadow(amelia, (r) => r.querySelectorAll(".csx-row").length >= 1);
    const rows = await amelia.evaluate(() => Array.from(document.getElementById("covered-studio").shadowRoot.querySelectorAll(".csx-row")).map((x) => ({ title: x.querySelector(".csx-row-title").textContent, restore: x.querySelector("[data-restore]") ? x.querySelector("[data-restore]").getAttribute("data-restore") : null })));
    assert.ok(rows.length >= 1 && rows[0].restore, "History lists the AI change with a Restore button: " + JSON.stringify(rows));
    await amelia.evaluate((n) => document.getElementById("covered-studio").shadowRoot.querySelector('[data-restore="' + n + '"]').click(), rows[0].restore);
    await waitShadow(amelia, (r) => r.querySelector('[role="dialog"]'));
    await clickText(amelia, "Create undo draft");
    await waitShadow(amelia, (r) => r.textContent.indexOf("Draft created") >= 0, undefined, 90000);
    await amelia.waitForFunction(() => window.CoveredStudio.drafts.current() && window.CoveredStudio.drafts.current().id, { polling: 200, timeout: 20000 });
    const restoredId = await amelia.evaluate(() => window.CoveredStudio.drafts.current().id);
    const revBranch = (await call("approver", "GET", "/v1/drafts/" + restoredId)).json.draft.branch;
    assert.deepEqual(JSON.parse(showAt(revBranch, "src/_data/hero.json")), heroBefore, "the undo draft restores hero.json exactly");
    assert.deepEqual(git(lg.repoDir, ["diff", "--name-only", "main", revBranch]).stdout.trim().split("\n"), ["src/_data/hero.json"]);
    step("Restore opened an undo draft that puts hero.json back exactly");
    await amelia.__ctx.close();

    // ------------------------------------------------------------ 3 discard
    step("3  discard path");
    await molly.__ctx.close(); // the first session still holds a draft in progress, which would change what is asked; start clean
    const molly2 = await newPage();
    await signIn(molly2, "Molly");
    await openAi(molly2);
    const b3 = branches(), m3 = mainSha();
    await ask(molly2, "add a venue called The Anchor in Bristol");
    assert.equal(await resultKind(molly2), "patch", (await shadowText(molly2)).slice(0, 600));
    await clickText(molly2, "Discard");
    await waitShadow(molly2, (r) => r.querySelector(".csx-ai [data-phase='idle']"));
    assert.deepEqual(branches(), b3, "Discard leaves no branch");
    assert.equal(mainSha(), m3);
    step("Discard: nothing written");

    // ------------------------------------------------------------ 4 needs code
    step("4  needs-code path");
    await ask(molly2, "make the hero video autoplay with a parallax effect");
    assert.equal(await resultKind(molly2), "needs_code");
    const nc = await inShadow(molly2, (r) => ({ title: r.querySelector("[data-req='title']").value, body: r.querySelector("[data-req='body']").value, copy: !!r.querySelector("[data-act='copy']"), askHref: (r.querySelector("a.csx-ai-link") || {}).href || "", save: !!r.querySelector("[data-act='save']") }));
    assert.ok(nc.title && nc.body, "a ready-to-send request is shown");
    assert.ok(nc.copy, "Copy request is offered");
    assert.ok(/^https?:\/\/[^ ]+\/admin\/#\/collections\/requests\/new$/.test(nc.askHref), "an Ask Claude link is offered: " + nc.askHref);
    assert.equal(nc.save, false, "there is nothing to save: no code change is ever made");
    assert.deepEqual(branches(), b3, "needs-code writes nothing");
    await clickText(molly2, "Done");
    await waitShadow(molly2, (r) => r.querySelector(".csx-ai [data-phase='idle']"));
    step("needs-code: request card shown, no draft, no code touched");

    // ------------------------------------------------------------ 5 hostile model output
    step("5  hostile model output");
    const m5 = mainSha();
    for (const [instr, why] of [["make the hero more exciting", "markup in a value"], ["make the checks run faster", "a CI workflow as the target"]]) {
      await ask(molly2, instr);
      assert.equal(await resultKind(molly2), "error", why + " gives the error screen");
      const t = await shadowText(molly2);
      assert.match(t, /That did not work/);
      assert.ok(!/<script|onerror|site-checks\.yml/.test(t), "the hostile text is not echoed");
      assert.deepEqual(branches(), b3, why + ": no draft");
      assert.equal(mainSha(), m5);
      await clickText(molly2, "Back");
      await waitShadow(molly2, (r) => r.querySelector(".csx-ai [data-phase='idle']"));
    }
    const refusals = sink.entries.filter((e) => e.action === "ai.rejected");
    assert.ok(refusals.length >= 2, "both refusals are in the audit log: " + audited.length + " / " + sink.entries.filter((e) => /^ai\./.test(e.action)).map((e) => e.action + ":" + e.outcome).join(","));
    assert.deepEqual(errors, [], "no page errors");
    await molly2.__ctx.close();
    console.log("ai-journey  OK: ask -> Before/After -> accept 2 of 3 -> draft holds exactly those ops, builds, passes " + last.ran.length + " guards + studio-scope -> Editor refused / Approver publishes -> Restore undoes it; discard writes nothing; needs-code routes to Ask Claude; 2 hostile outputs refused with no draft");
  } catch (e) {
    console.error("ai-journey  FAILED: " + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const s of servers) s.close();
    await Promise.allSettled(Array.from(jobsRef.map ? jobsRef.map.values() : []).map((j) => j.promise).filter(Boolean));
    try { unlink(origin); } catch (e) { /* ignore */ }
    try { unlink(path.join(tmp, "host", "repo")); } catch (e) { /* ignore */ }
    if (KEEP) console.log("ai-journey  kept " + tmp);
    else { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { console.log("ai-journey  note: could not remove " + tmp + " (" + e.code + ")"); } }
  }
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("ai-journey  FAILED: " + (e && e.stack || e)); process.exit(1); });
