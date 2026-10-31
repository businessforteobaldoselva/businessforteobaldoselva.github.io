"use strict";
// TEST HARNESS (Node only): a complete Studio API in memory - dev config, in-memory Git seeded from the working tree,
// dev auth, in-memory roles - and a `call()` helper that sends real Web Requests to the handler. No network.

const { loadConfig, buildDeps } = require("../../api/config");
const { createHandler } = require("../../api/handler");
const { createMemoryGit } = require("../../api/providers/git/mock-memory");
const { createMemoryRoles, DEV_PEOPLE } = require("../../api/providers/roles/memory");
const { createAudit, memorySink } = require("../../api/audit");
const { loadSchema, ROOT } = require("./schema-from-config");
const { reservedIds } = require("../../../lib/reserved-ids");
const { snapshot } = require("./repo");

const ORIGIN = "http://localhost:8080";
const T = { editor: "dev:editor:molly@covered.test", approver: "dev:approver:amelia@covered.test", admin: "dev:admin:teo@covered.test" };
const uuid = () => require("crypto").randomUUID();

function makeApi(opts) {
  const o = opts || {};
  const env = Object.assign({
    STUDIO_ENV: "development", STUDIO_DEV: "1", STUDIO_ALLOW_NO_ORIGIN: "1",
    STUDIO_ALLOWED_ORIGINS: ORIGIN, STUDIO_PREVIEW_URL_TEMPLATE: "http://localhost:8080/?draft={pr}",
  }, o.env || {});
  const config = loadConfig(env);
  const { repo, git } = createMemoryGit({ files: o.files || snapshot(), autoChecks: o.autoChecks || "success" });
  const sink = memorySink();
  let t = Date.parse("2026-10-29T12:00:00Z");
  const now = () => new Date(t);
  const roles = o.roles || createMemoryRoles(DEV_PEOPLE.concat(o.people || []), now);
  const audit = createAudit({ sinks: [sink], salt: "test", now });
  const deps = buildDeps(config, env, Object.assign({ git: o.git || git, roles, audit, schema: loadSchema(ROOT), reservedIds: reservedIds(ROOT), now }, o.depsOverrides || {}));
  const handler = createHandler(deps);
  async function call(who, method, path, body, headers) {
    const h = Object.assign({ origin: ORIGIN, "x-studio-client-ip": "10.0.0." + (o.ipOctet || 1) }, headers || {});
    const token = who && (T[who] || who);
    if (token) h.authorization = "Bearer " + token;
    const init = { method, headers: h };
    if (body !== undefined) { if (!h["content-type"]) h["content-type"] = "application/json"; init.body = typeof body === "string" ? body : JSON.stringify(body); }
    const res = await handler(new Request("http://localhost:8787" + path, init));
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: res.status, json, headers: res.headers, text };
  }
  return { call, repo, git: o.git || git, deps, handler, audit: sink, env, advance: (ms) => { t += ms; }, mainSha: () => repo.head("main") };
}

const patch = (api, ops, extra) => Object.assign({ idempotencyKey: uuid(), baseSha: api.mainSha(), title: "Test edit", ops, uploads: [] }, extra || {});
const heroOp = (value, expect) => Object.assign({ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value }, expect === undefined ? {} : { expect });

module.exports = { makeApi, patch, heroOp, T, ORIGIN, uuid };
