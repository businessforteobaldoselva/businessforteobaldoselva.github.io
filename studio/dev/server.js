#!/usr/bin/env node
"use strict";
// `npm run studio:dev` - everything Studio needs on one machine, no accounts, nothing leaves loopback:
//   http://localhost:8080   the edit build (_site-edit, CMS_EDIT=1) served as static files
//   http://localhost:8787   the Studio API (two origins on purpose, so CORS is exercised)
// The API runs with the in-memory Git host seeded from the working tree, the dev auth stub (STUDIO_DEV=1, development env,
// localhost only) and console audit. Open http://localhost:8080/?studio=1 and sign in as Molly (editor), Amelia (approver)
// or Teo (admin).  Dev-only extras on :8080:  POST /dev/rebuild  (rebuild _site-edit from the mock main after a mock
// merge)   POST /dev/checks {"number":1,"state":"success|pending|failure"}   (flip the mock CI result).

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SITE = path.join(ROOT, "_site-edit");
const API_PORT = Number(process.env.STUDIO_DEV_API_PORT || 8787);
const SITE_PORT = Number(process.env.STUDIO_DEV_SITE_PORT || 8080);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2", ".woff": "font/woff", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon" };

function buildEditSite(repoFiles) {
  const { Workspace, eleventyBin } = require("../../scripts/lib/workspace");
  const ws = new Workspace(ROOT, { prefix: "studio-dev-" });
  try {
    if (repoFiles) for (const [p, bytes] of repoFiles) { fs.mkdirSync(path.dirname(ws.file(p)), { recursive: true }); fs.writeFileSync(ws.file(p), Buffer.from(bytes)); }
    fs.rmSync(SITE, { recursive: true, force: true });
    const r = spawnSync(process.execPath, [eleventyBin(ROOT), "--quiet", "--output=" + SITE], {
      cwd: ws.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { CMS_EDIT: "1", COVERED_IMG_FAST: "1", STUDIO_API_URL: "http://localhost:" + API_PORT, STUDIO_APP_URL: "http://localhost:" + SITE_PORT }),
    });
    if (r.status !== 0) throw new Error("the edit build failed:\n" + String(r.stdout || "").slice(-800) + String(r.stderr || "").slice(-800));
  } finally { ws.cleanup(); }
}

function serveStatic(req, res) {
  const u = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(u.pathname);
  if (rel.indexOf("\0") >= 0 || rel.split("/").includes("..")) { res.writeHead(400); res.end(); return; }
  let file = path.join(SITE, rel);
  if (!file.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

async function main() {
  const { loadConfig, buildDeps } = require("../api/config");
  const { createHandler } = require("../api/handler");
  const { createNodeServer } = require("../api/adapters/node");
  const { createMemoryGit } = require("../api/providers/git/mock-memory");
  const { loadSchema } = require("../tests/fixtures/schema-from-config");
  const { reservedIds } = require("../../lib/reserved-ids");

  if (!fs.existsSync(path.join(SITE, "index.html"))) {
    console.log("studio:dev  building the edit site (CMS_EDIT=1) into _site-edit ...");
    buildEditSite(null);
  }

  const env = {
    STUDIO_ENV: "development", STUDIO_DEV: "1", STUDIO_ALLOW_NO_ORIGIN: "1",
    STUDIO_ALLOWED_ORIGINS: "http://localhost:" + SITE_PORT + ",http://127.0.0.1:" + SITE_PORT,
    STUDIO_PREVIEW_URL_TEMPLATE: "http://localhost:" + SITE_PORT + "/?draft={pr}", STUDIO_APP_URL: "http://localhost:" + SITE_PORT,
  };
  // AI help is off unless asked for. STUDIO_AI_ENABLED=1 turns on the REPLAY stand-in (recorded sample answers, no key, no network);
  // STUDIO_AI_PROVIDER=anthropic with STUDIO_AI_API_KEY in your shell uses the real service.
  const overrides = {};
  if (/^(1|true)$/.test(process.env.STUDIO_AI_ENABLED || "")) {
    env.STUDIO_AI_ENABLED = "1";
    if (process.env.STUDIO_AI_PROVIDER === "anthropic" && process.env.STUDIO_AI_API_KEY) {
      env.STUDIO_AI_PROVIDER = "anthropic";
      env.STUDIO_AI_API_KEY = process.env.STUDIO_AI_API_KEY;
      if (process.env.STUDIO_AI_MODEL) env.STUDIO_AI_MODEL = process.env.STUDIO_AI_MODEL;
    } else {
      env.STUDIO_AI_PROVIDER = "replay";
      const { loadRecordings, devReplayProvider } = require("../ai-eval/recordings");
      const { createReplayProvider } = require("../api/ai/providers/replay");
      const { recordings, samples } = await loadRecordings();
      overrides.aiProvider = devReplayProvider(createReplayProvider({ recordings }), samples);
      console.log("studio:dev  AI help: replay stand-in (try: " + samples.filter((s) => s.mode === "edit").slice(0, 3).map((s) => "\"" + s.instruction + "\"").join(", ") + ")");
    }
  }
  const config = loadConfig(env);
  const { repo, git } = createMemoryGit({ root: ROOT });
  const deps = buildDeps(config, env, Object.assign({ git, schema: loadSchema(ROOT), reservedIds: reservedIds(ROOT) }, overrides));
  const api = createNodeServer(createHandler(deps));
  api.listen(API_PORT, "127.0.0.1", () => console.log("studio:dev  API   http://localhost:" + API_PORT + "   (in-memory Git, dev auth)"));

  http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (req.method === "POST" && u.pathname === "/dev/rebuild") {
      try {
        const files = new Map();
        const main = repo.head(repo.baseBranch);
        for (const [p, sha] of repo.treeOf(main)) files.set(p, repo.blobs.get(sha));
        buildEditSite(files);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
      } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 500) })); }
      return;
    }
    if (req.method === "POST" && u.pathname === "/dev/checks") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          repo.setChecks(Number(b.number), String(b.state));
          res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
        } catch (e) { res.writeHead(400); res.end(); }
      });
      return;
    }
    serveStatic(req, res);
  }).listen(SITE_PORT, "127.0.0.1", () => {
    console.log("studio:dev  site  http://localhost:" + SITE_PORT + "/?studio=1");
    console.log("studio:dev  sign in as molly@covered.test (editor), amelia@covered.test (approver) or teo@covered.test (admin)");
  });
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });

module.exports = { buildEditSite };
