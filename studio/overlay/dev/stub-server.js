#!/usr/bin/env node
"use strict";
// Overlay dev harness: a STUB of the Studio API written against studio/DESIGN.md section 7, plus a static server for
// the overlay's fixture page. The real API (unit B, studio/dev/server.js) replaces it once merged; this exists so the
// overlay can be driven and tested on its own. It speaks the contract (routes, error shapes, CORS rules, dev tokens,
// the `expect` conflict rule) but validates only a little - the server-side validator is unit B's job.
//
//   node studio/overlay/dev/stub-server.js [--site-port 8080] [--api-port 8787]
//   then open http://localhost:8080/?studio=1
//
// Programmatic: const { start } = require("./stub-server"); const s = await start({ sitePort: 0, apiPort: 0 });
//   s.requests (every API request), s.patches (every accepted POST /v1/drafts body), s.failNext = { status, body }, s.reset(), s.close()
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { bundle } = require("../bundle.js");

const ROOT = path.resolve(__dirname, "..", "..", "tests", "overlay", "fixtures");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css; charset=utf-8" };
const HEX40 = () => crypto.randomBytes(20).toString("hex");

function pointerGet(doc, ptr) {
  if (ptr === "") return doc;
  let cur = doc;
  for (const raw of ptr.slice(1).split("/")) {
    const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}
function pointerParent(doc, ptr) {
  const segs = ptr.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const key = segs.pop();
  let cur = doc;
  for (const k of segs) cur = cur[k];
  return { parent: cur, key };
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function start(options) {
  options = options || {};
  const content = JSON.parse(fs.readFileSync(path.join(ROOT, "content.json"), "utf8"));
  const stub = {
    requests: [], patches: [], drafts: new Map(), failNext: null, mainDocs: {}, delayMs: 0,
    schemaPath: path.join(ROOT, "schema.json"),
  };
  stub.reset = () => {
    stub.requests.length = 0;
    stub.patches.length = 0;
    stub.drafts.clear();
    stub.failNext = null;
    for (const k of Object.keys(content.files)) stub.mainDocs[content.files[k].path] = JSON.parse(JSON.stringify(content.files[k].data));
  };
  stub.reset();
  let siteOrigin = "";
  let apiOrigin = "";

  const person = (token) => {
    const m = /^dev:(editor|approver|admin):([a-z0-9._-]+@(?:[a-z0-9-]+\.test|localhost))$/.exec(token || "");
    if (!m) return null;
    const name = m[2].split("@")[0];
    return { role: m[1], email: m[2], name: name.charAt(0).toUpperCase() + name.slice(1), id: crypto.createHash("sha256").update(m[2]).digest("hex").slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5") };
  };

  function json(res, status, body, extra) {
    const origin = res.__origin;
    const headers = Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }, extra || {});
    if (origin && origin === siteOrigin) { headers["Access-Control-Allow-Origin"] = origin; headers["Vary"] = "Origin"; }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }
  const err = (res, status, code, message, details) => json(res, status, { error: { code, message, details: details || null }, requestId: crypto.randomUUID() });

  function describeOp(op) {
    const f = op.file.replace(/^src\/(_data|pages)\//, "").replace(/\.(json|md)$/, "");
    if (op.op === "move") return { file: op.file, path: op.path, op: op.op, label: f, summary: "Moved an item", kind: "list" };
    const val = typeof op.value === "string" ? op.value : JSON.stringify(op.value);
    return { file: op.file, path: op.path, op: op.op, label: f + " " + op.path, summary: op.op === "remove" ? "Removed an item" : "Changed to “" + String(val).slice(0, 80) + "”", kind: "text" };
  }
  function makeDraft(id, number, user, title, baseSha, headSha, state) {
    return { id, number, url: "https://github.test/covered/site/pull/" + number, previewUrl: null, title, state: state || "draft", branch: "studio/" + id.replace("--", "/"), headSha, baseSha, behindMain: false, mergeable: true, author: { id: user.id, name: user.name }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checks: { state: "pending", failing: [] }, canPublish: false };
  }

  function applyOps(docs, ops, uploads) {
    const conflicts = [];
    for (const op of ops) {
      if (Object.prototype.hasOwnProperty.call(op, "expect")) {
        const cur = pointerGet(docs[op.file], op.path);
        if (!equal(cur, op.expect)) conflicts.push({ file: op.file, path: op.path, expected: op.expect, actual: cur });
      }
    }
    if (conflicts.length) return { conflicts };
    const next = JSON.parse(JSON.stringify(docs));
    for (const op of ops) {
      const doc = next[op.file];
      if (!doc) return { problems: [{ code: "path_forbidden", file: op.file, path: op.path, message: "That file can't be changed." }] };
      if (op.op === "replace") { const { parent, key } = pointerParent(doc, op.path); parent[key] = op.value; }
      else if (op.op === "add") { const { parent, key } = pointerParent(doc, op.path); if (Array.isArray(parent)) { if (key === "-") parent.push(op.value); else parent.splice(Number(key), 0, op.value); } else parent[key] = op.value; }
      else if (op.op === "remove") { const { parent, key } = pointerParent(doc, op.path); if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
      else if (op.op === "move") { const a = pointerParent(doc, op.from); const item = a.parent.splice(Number(a.key), 1)[0]; const b = pointerParent(doc, op.path); b.parent.splice(Number(b.key), 0, item); }
    }
    return { docs: next };
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("too large"), { code: "payload_too_large" })); req.destroy(); } else chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const ALLOWED = new Set(["idempotencyKey", "draftId", "baseSha", "expectedHeadSha", "title", "ops", "uploads"]);
  async function api(req, res) {
    const url = new URL(req.url, "http://x");
    const origin = req.headers.origin;
    res.__origin = origin;
    stub.requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization || null, origin: origin || null });
    if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
    if (req.method === "OPTIONS") {
      if (origin !== siteOrigin) { res.writeHead(403); res.end(); return; }
      res.writeHead(204, { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Max-Age": "600", Vary: "Origin" });
      res.end();
      return;
    }
    if (req.method !== "GET" && origin !== siteOrigin) return err(res, 403, "forbidden", "Origin not allowed.");
    if (url.pathname === "/v1/preview-config") {
      return json(res, 200, { apiVersion: 1, auth: { mode: "dev", supabaseUrl: null, supabaseAnonKey: null, loginUrl: null }, limits: { maxBodyBytes: 6000000, maxImageBytes: 4000000, maxOps: 200, maxUploads: 4 }, base: "main", schemaSha256: "fixture-sha", features: { selfPublish: false } });
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const user = person(auth && auth[1]);
    if (!user) return err(res, 401, "unauthorized", "Sign in.");
    if (stub.failNext) { const f = stub.failNext; stub.failNext = null; return json(res, f.status, f.body, f.headers); }
    if (url.pathname === "/v1/me") return json(res, 200, { user: { id: user.id, email: user.email, name: user.name }, role: user.role, capabilities: { draft: true, publish: user.role !== "editor", people: user.role === "admin" } });
    if (url.pathname === "/v1/history") return json(res, 200, { items: [], next: null });
    if (url.pathname === "/v1/drafts" && req.method === "GET") return json(res, 200, { drafts: Array.from(stub.drafts.values()).map((d) => d.draft) });
    if (url.pathname === "/v1/drafts" && req.method === "POST") {
      if (!/^application\/json/.test(req.headers["content-type"] || "")) return err(res, 415, "unsupported_media_type", "JSON only.");
      let body;
      try { body = JSON.parse(await readBody(req, 6000000)); } catch (e) { return e.code === "payload_too_large" ? err(res, 413, "payload_too_large", "Too large.") : err(res, 400, "bad_request", "Not JSON."); }
      for (const k of Object.keys(body)) if (!ALLOWED.has(k)) return err(res, 400, "bad_request", "Unknown field " + k);
      if (!/^[0-9a-f-]{36}$/.test(body.idempotencyKey || "")) return err(res, 400, "bad_request", "idempotencyKey required.");
      if (!Array.isArray(body.ops) || body.ops.length > 200) return err(res, 400, "bad_request", "ops.");
      for (const op of body.ops) {
        if (!/^src\/(_data\/[a-z0-9-]+\.json|pages\/[a-z0-9-]+\.md)$/.test(op.file || "")) return err(res, 422, "validation_failed", "Not allowed", { problems: [{ code: "path_forbidden", file: op.file, path: op.path, message: "That file can't be changed from Studio." }] });
        for (const k of Object.keys(op)) if (!["op", "file", "path", "from", "value", "expect"].includes(k)) return err(res, 400, "bad_request", "Unknown op field " + k);
      }
      stub.patches.push(body);
      const existing = body.draftId ? stub.drafts.get(body.draftId) : null;
      // replay of the same key
      for (const d of stub.drafts.values()) if (d.keys.has(body.idempotencyKey)) return json(res, 200, { draft: d.draft, changes: d.changes, replayed: true, warnings: [] });
      if (body.draftId && !existing) return err(res, 404, "not_found", "No such draft.");
      if (existing && existing.draft.headSha !== body.expectedHeadSha) return err(res, 409, "draft_moved", "Draft moved.", { headSha: existing.draft.headSha });
      const docs = existing ? existing.docs : stub.mainDocs;
      const r = applyOps(docs, body.ops, body.uploads || []);
      if (r.conflicts) return err(res, 409, "conflict", "Changed since.", { items: r.conflicts });
      if (r.problems) return err(res, 422, "validation_failed", "Invalid", { problems: r.problems });
      for (const u of body.uploads || []) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|jpeg|png|webp|gif|avif|svg)$/.test(u.name) || Buffer.from(u.dataBase64, "base64").length !== u.size) return err(res, 422, "validation_failed", "Bad upload", { problems: [{ code: "image", file: "images/" + u.name, path: "", message: "That picture can't be used." }] });
      }
      const changes = body.ops.map(describeOp);
      let record = existing;
      if (!record) {
        const id = "u7k2m9q--" + (String(body.title || "draft").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "draft");
        const number = 57 + stub.drafts.size;
        record = { draft: makeDraft(id, number, user, body.title || "Studio draft", body.baseSha, HEX40()), docs: null, keys: new Set(), changes: [], uploads: [] };
        stub.drafts.set(id, record);
      }
      record.docs = r.docs;
      record.draft.headSha = HEX40();
      record.draft.updatedAt = new Date().toISOString();
      record.keys.add(body.idempotencyKey);
      record.changes = record.changes.concat(changes);
      record.uploads = record.uploads.concat((body.uploads || []).map((u) => u.name));
      return json(res, existing ? 200 : 201, { draft: record.draft, changes: changes, replayed: false, warnings: [] });
    }
    const m = /^\/v1\/drafts\/([^/]+)(?:\/(submit|publish|rebase))?$/.exec(url.pathname);
    if (m) {
      const rec = stub.drafts.get(decodeURIComponent(m[1]));
      if (!rec) return err(res, 404, "not_found", "No such draft.");
      if (req.method === "GET" && !m[2]) return json(res, 200, { draft: rec.draft, changes: rec.changes });
      if (req.method === "DELETE") { stub.drafts.delete(rec.draft.id); return json(res, 200, { ok: true }); }
      if (req.method === "POST" && m[2] === "submit") { rec.draft.state = "ready"; rec.draft.checks = { state: "success", failing: [] }; rec.draft.canPublish = true; return json(res, 200, { draft: rec.draft }); }
      if (req.method === "POST" && m[2] === "publish") {
        if (user.role === "editor") return err(res, 403, "forbidden", "Approvers only.");
        if (rec.draft.author.id === user.id) return err(res, 409, "not_ready", "Self publish.", { reason: "self_publish" });
        rec.draft.state = "merged";
        Object.assign(stub.mainDocs, rec.docs);
        return json(res, 200, { draft: rec.draft });
      }
    }
    return err(res, 404, "not_found", "No such route.");
  }

  function site(req, res) {
    const url = new URL(req.url, "http://x");
    let p = decodeURIComponent(url.pathname);
    if (p === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (p === "/studio/overlay.js") {
      let text;
      try { text = bundle({ schemaPath: stub.schemaPath, warn: () => {} }); } catch (e) { res.writeHead(500); res.end("bundle failed: " + e.message); return; }
      res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
      res.end(text);
      return;
    }
    if (p === "/studio/content.json") { res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" }); res.end(fs.readFileSync(path.join(ROOT, "content.json"))); return; }
    if (p === "/" || p === "/index.html") {
      const html = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8").split("__API__").join(apiOrigin);
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    const file = path.normalize(path.join(ROOT, "site", p));
    if (!file.startsWith(path.join(ROOT, "site") + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }

  const apiServer = http.createServer((req, res) => { api(req, res).catch((e) => { try { err(res, 500, "internal", "Stub failure: " + e.message); } catch (x) { /* ignore */ } }); });
  const siteServer = http.createServer(site);
  return new Promise((resolve) => {
    apiServer.listen(options.apiPort || 0, "127.0.0.1", () => {
      siteServer.listen(options.sitePort || 0, "127.0.0.1", () => {
        // loopback IP origins (the overlay accepts https or http://localhost / 127.0.0.1 only)
        apiOrigin = "http://127.0.0.1:" + apiServer.address().port;
        siteOrigin = "http://127.0.0.1:" + siteServer.address().port;
        stub.apiOrigin = apiOrigin;
        stub.siteOrigin = siteOrigin;
        stub.close = () => new Promise((r) => { apiServer.close(() => siteServer.close(() => r())); apiServer.closeAllConnections && apiServer.closeAllConnections(); siteServer.closeAllConnections && siteServer.closeAllConnections(); });
        resolve(stub);
      });
    });
  });
}

module.exports = { start, ROOT };

if (require.main === module) {
  const a = process.argv.slice(2);
  const val = (n, d) => { const i = a.indexOf(n); return i >= 0 ? Number(a[i + 1]) : d; };
  start({ sitePort: val("--site-port", 8080), apiPort: val("--api-port", 8787) }).then((s) => {
    console.log("overlay stub: site " + s.siteOrigin + "/?studio=1   api " + s.apiOrigin + "   (dev sign-in as Molly / Amelia / Teo)");
  });
}
