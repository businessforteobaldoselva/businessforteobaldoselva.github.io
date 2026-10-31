"use strict";
// Configuration (DESIGN 7.7). loadConfig is PURE: it reads only the env object it is given, never process.env, and it
// refuses unsafe combinations at start-up. buildDeps wires real providers, or the dev ones when config.dev is true.
// Portable.

const { isValidOrigin, templateToRegExp } = require("./cors");
const { createDevAuth, SECRET_VARS } = require("./providers/auth/dev");
const { createMemoryRoles, DEV_PEOPLE } = require("./providers/roles/memory");
const { createSupabaseAuth } = require("./providers/auth/supabase");
const { createSupabaseRoles } = require("./providers/roles/supabase");
const { createGithubGit } = require("./providers/git/github");
const { createLimiter } = require("./ratelimit");
const { createAudit, consoleSink } = require("./audit");
const { loadAiConfig } = require("./ai/config");
const { createAiService } = require("./ai");
const { createAnthropicProvider } = require("./ai/providers/anthropic");
const { createReplayProvider } = require("./ai/providers/replay");
const { createDisabledProvider } = require("./ai/providers/disabled");

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}

const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter((x) => x.length > 0);
const flag = (v) => v === "1" || v === "true";

function loadConfig(env) {
  const e = env || {};
  const studioEnv = e.STUDIO_ENV || "production";
  if (studioEnv !== "production" && studioEnv !== "development") throw new ConfigError("STUDIO_ENV must be production or development");
  const production = studioEnv === "production";
  const dev = e.STUDIO_DEV === "1";
  const raw = e.STUDIO_ALLOWED_ORIGINS === undefined ? [] : String(e.STUDIO_ALLOWED_ORIGINS).split(",").map((x) => x.trim());
  for (const o of raw) if (!isValidOrigin(o)) throw new ConfigError("STUDIO_ALLOWED_ORIGINS holds an origin that is empty, has a path, uses a wildcard or is http:// but not localhost: " + JSON.stringify(o.slice(0, 60)));
  const allowedOrigins = raw;
  if (e.STUDIO_PREVIEW_ORIGIN_TEMPLATE) { try { templateToRegExp(e.STUDIO_PREVIEW_ORIGIN_TEMPLATE); } catch (err) { throw new ConfigError(err.message); } }

  if (dev) {
    if (production) throw new ConfigError("STUDIO_DEV=1 is not allowed when STUDIO_ENV is production (set STUDIO_ENV=development on a local machine)");
    for (const k of SECRET_VARS) if (e[k]) throw new ConfigError("STUDIO_DEV=1 cannot be combined with " + k);
    for (const o of allowedOrigins) if (!LOCAL_ORIGIN.test(o)) throw new ConfigError("STUDIO_DEV=1 allows only localhost origins, not " + o);
    if (e.STUDIO_PREVIEW_ORIGIN_TEMPLATE) throw new ConfigError("STUDIO_DEV=1 cannot be combined with STUDIO_PREVIEW_ORIGIN_TEMPLATE");
  }

  const repo = String(e.GITHUB_REPO || "");
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(repo);
  const jwtMode = e.STUDIO_JWT_MODE || "jwks";
  if (jwtMode !== "jwks" && jwtMode !== "hs256") throw new ConfigError("STUDIO_JWT_MODE must be jwks or hs256");
  if (!dev) {
    const need = ["GITHUB_REPO", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY"].concat(jwtMode === "hs256" ? ["SUPABASE_JWT_SECRET"] : []);
    const missing = need.filter((k) => !e[k]);
    if (missing.length) throw new ConfigError("missing configuration: " + missing.join(", "));
    if (!m) throw new ConfigError("GITHUB_REPO must look like owner/name");
    if (!allowedOrigins.length && !e.STUDIO_PREVIEW_ORIGIN_TEMPLATE) throw new ConfigError("set STUDIO_ALLOWED_ORIGINS and/or STUDIO_PREVIEW_ORIGIN_TEMPLATE");
  }
  const preview = e.STUDIO_PREVIEW_URL_TEMPLATE || "";
  if (preview && (!/^https?:\/\/[^\s]*\{pr\}[^\s]*$/.test(preview) || (!preview.startsWith("https://") && !LOCAL_ORIGIN.test(preview.replace(/^(http:\/\/[^/]+).*$/, "$1"))))) throw new ConfigError("STUDIO_PREVIEW_URL_TEMPLATE must be an https URL containing {pr}");

  return {
    env: studioEnv,
    production,
    dev,
    basePath: String(e.STUDIO_BASE_PATH || "").replace(/\/+$/, ""),
    allowedOrigins,
    previewOriginTemplate: e.STUDIO_PREVIEW_ORIGIN_TEMPLATE || "",
    allowNoOrigin: flag(e.STUDIO_ALLOW_NO_ORIGIN),
    allowSelfPublish: flag(e.STUDIO_ALLOW_SELF_PUBLISH),
    maxBodyBytes: Math.max(1000, Math.min(20000000, Number(e.STUDIO_MAX_BODY_BYTES) || 6000000)),
    maxImageBytes: 4 * 1024 * 1024,
    previewUrlTemplate: preview,
    auditSalt: e.STUDIO_AUDIT_SALT || "",
    appUrl: e.STUDIO_APP_URL || "",
    baseBranch: e.GITHUB_BASE_BRANCH || "main",
    github: m ? { owner: m[1], repo: m[2], appId: e.GITHUB_APP_ID || "", installationId: e.GITHUB_APP_INSTALLATION_ID || "" } : null,
    supabase: { url: e.SUPABASE_URL || "", anonKey: e.SUPABASE_ANON_KEY || "", jwtMode },
    ai: loadAiConfig(e), // plain numbers and flags only: the AI key is never part of the configuration
  };
}

// overrides (tests, studio:dev): { git, auth, roles, audit, limiter, schema, reservedIds, fetch, now, randomUUID }
// Secrets are read from `env` here and handed straight to the providers; nothing logs them.
function buildDeps(config, env, overrides) {
  const o = overrides || {};
  const e = env || {};
  const now = o.now || (() => new Date());
  const doFetch = o.fetch || ((...a) => fetch(...a));
  let auth = o.auth;
  let roles = o.roles;
  let git = o.git;
  if (config.dev) {
    if (!auth) auth = createDevAuth(e, "http://localhost/");
    if (!roles) roles = createMemoryRoles(DEV_PEOPLE, now);
    if (!git) throw new ConfigError("dev mode needs a Git provider (studio:dev passes the in-memory one)");
  } else {
    if (!auth) auth = createSupabaseAuth({ supabaseUrl: config.supabase.url, mode: config.supabase.jwtMode, jwtSecret: e.SUPABASE_JWT_SECRET, fetch: doFetch, now });
    if (!roles) roles = createSupabaseRoles({ supabaseUrl: config.supabase.url, anonKey: config.supabase.anonKey, fetch: doFetch });
    if (!git) git = createGithubGit({ owner: config.github.owner, repo: config.github.repo, baseBranch: config.baseBranch, appId: config.github.appId, installationId: config.github.installationId, privateKey: e.GITHUB_APP_PRIVATE_KEY, fetch: doFetch, now });
  }
  const audit = o.audit || createAudit({ sinks: [consoleSink], salt: config.auditSalt, now });
  if (!o.schema) throw new ConfigError("a schema is required (adapters load studio/schema/studio-schema.json)");
  const reserved = o.reservedIds || makeReserved(o.schema);
  const deps = {
    config, auth, roles, git, audit, schema: o.schema, reservedIds: reserved,
    limiter: o.limiter || createLimiter({ now: () => now().getTime() }),
    now, fetch: doFetch,
    randomUUID: o.randomUUID || (() => crypto.randomUUID()),
  };
  // AI help: the key is read from the environment HERE, once, and goes straight into the provider closure
  deps.ai = createAiService({ deps, provider: makeAiProvider(config, e, doFetch, o), config: config.ai, budget: o.aiBudget, worldId: o.aiWorldId });
  return deps;
}

// Which model provider backs AI help. Off (the default) = a provider that can never be called; the real one is only
// constructed when AI is switched on AND a key is present. `replay` (tests, CI, studio:dev) never touches the network.
function makeAiProvider(config, env, doFetch, o) {
  if (o.aiProvider) return o.aiProvider;
  const c = config.ai;
  if (!c.enabled) return createDisabledProvider();
  if (c.provider === "replay") return createReplayProvider({ recordings: o.aiRecordings || {}, model: c.model });
  const key = env.STUDIO_AI_API_KEY;
  if (typeof key !== "string" || !key.trim()) return createDisabledProvider();
  return createAnthropicProvider({ apiKey: key.trim(), model: c.model, fetchFn: doFetch });
}

// ids the page itself uses: the schema carries the lower-case list; the CMS anchor pattern inside the schema also
// rejects them (and prefixes), so the two checks overlap on purpose.
function makeReserved(schema) {
  const set = new Set((schema.reservedIds || []).map((s) => String(s).toLowerCase()));
  const prefixes = (schema.reservedPrefixes || []).map((s) => String(s).toLowerCase());
  return { has: (id) => { const v = String(id).toLowerCase(); return set.has(v) || prefixes.some((p) => v.startsWith(p)); } };
}

module.exports = { loadConfig, buildDeps, makeReserved, ConfigError };
