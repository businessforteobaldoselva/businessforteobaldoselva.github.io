"use strict";
// Loopback-only stub server for the browser tests: a page with Studio markers, the REAL ext/* files and ext.css,
// the stub host (stub-studio.js) and a fake /api/v1/history* behind them. Nothing here touches the network.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const EXT = path.join(ROOT, "overlay", "ext");
const FILES = ["history.js", "help.js", "tour.js", "palette.js"];

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stub</title>
<style>body{font:16px system-ui;margin:0;padding:24px}section{min-height:420px;border-bottom:1px solid #ccc}img{display:block;width:240px;height:120px;background:#9bc}</style></head><body>
<section data-cms="homepage.sections.0" data-cms-kind="section"><h1 id="headline" data-cms="hero.headlineMain" data-cms-kind="text">We cover the UK</h1>
<img alt="A phone charger" data-cms="site.ogImage" data-cms-kind="image" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></section>
<section data-cms="homepage.sections.1" data-cms-kind="section"><h2>Partners</h2><p>Our partners</p></section>
<script>window.__CoveredStudioBoot_pending = true;</script>
<script src="/stub-studio.js"></script>
${FILES.map((f) => `<script src="/ext/${f}"></script>`).join("\n")}
<script>window.__startStub(%CSS%);</script></body></html>`;

function history(page) {
  const mk = (n, title, hoursAgo, extra) => Object.assign({
    number: n, title, mergedAt: new Date(Date.now() - hoursAgo * 3600e3).toISOString(), sha: "a".repeat(40), url: "https://github.com/o/r/pull/" + n,
    author: { name: "Molly", via: "studio" }, mergedBy: "Teo", files: ["src/_data/hero.json"], changes: [{ label: "Hero > Headline", summary: 'Changed the text from "We\'re covering the UK," to "We cover the UK"' }], restorable: true, revertOf: null,
  }, extra || {});
  if (page === "2") return { items: [mk(40, "Old tidy", 24 * 9, { author: { name: "amelia-gh", via: "github" }, changes: null, files: ["src/_data/faq.json", "images/a.jpg"] })], next: null };
  return {
    items: [
      mk(52, "Make the hero friendlier", 2),
      mk(51, "<img src=x onerror=\"window.__pwned=1\"> sneaky", 30, { author: { name: "<b>Eve</b>", via: "decap" }, changes: null, files: ["src/_data/how.json", "src/pages/about.md"] }),
      mk(50, "Restore: undo \"Old\" (#44)", 55, { revertOf: 44, restorable: false }),
    ],
    next: "page2",
  };
}

function start() {
  const log = [];
  const state = { conflictOnce: true };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", PAGE.replace("%CSS%", JSON.stringify(fs.readFileSync(path.join(EXT, "ext.css"), "utf8"))));
    if (url.pathname === "/stub-studio.js") return send(200, "text/javascript", fs.readFileSync(path.join(__dirname, "stub-studio.js")));
    const m = /^\/ext\/([a-z]+\.js)$/.exec(url.pathname);
    if (m && FILES.includes(m[1])) return send(200, "text/javascript", fs.readFileSync(path.join(EXT, m[1])));
    if (url.pathname === "/favicon.ico") return send(204, "image/x-icon", "");
    if (url.pathname === "/__log") return send(200, "application/json", JSON.stringify(log));
    if (url.pathname === "/api/v1/history" && req.method === "GET") {
      log.push("GET history cursor=" + (url.searchParams.get("cursor") || ""));
      return send(200, "application/json", JSON.stringify(history(url.searchParams.get("cursor") === "page2" ? "2" : "1")));
    }
    const r = /^\/api\/v1\/history\/(\d+)\/restore$/.exec(url.pathname);
    if (r && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b = JSON.parse(body || "{}");
        log.push("POST restore " + r[1] + " " + b.onConflict + " key=" + (/^[0-9a-f-]{36}$/.test(b.idempotencyKey) ? "uuid" : "bad") + " auth=" + (req.headers.authorization ? "bearer" : "none"));
        if (r[1] === "51" && b.onConflict === "abort") return send(409, "application/json", JSON.stringify({ error: { code: "conflict", message: "Someone changed these.", details: { items: [{ file: "src/_data/how.json", path: "/title" }] } } }));
        return send(201, "application/json", JSON.stringify({ draft: { id: "u1--restore-" + r[1], number: 77, url: "https://github.com/o/r/pull/77", title: "Restore" }, changes: [], skipped: b.onConflict === "skip" ? [{ file: "x" }] : [] }));
      });
      return;
    }
    send(404, "text/plain", "not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: "http://127.0.0.1:" + server.address().port, log, state, close: () => new Promise((r2) => server.close(r2)) })));
}

module.exports = { start };
if (require.main === module) start().then((s) => console.log(s.url));
