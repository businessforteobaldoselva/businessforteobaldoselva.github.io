"use strict";
// GET /v1/preview-config (anyone, rate-limited) and GET /v1/me (any role).

const { ROLE_RANK } = require("../services/drafts");

const routes = [
  {
    method: "GET", path: "/v1/preview-config", anon: true, cls: "anon",
    async run(ctx) {
      const c = ctx.deps.config;
      return {
        status: 200,
        body: {
          apiVersion: 1,
          auth: { mode: c.dev ? "dev" : "supabase", supabaseUrl: c.dev ? null : c.supabase.url, supabaseAnonKey: c.dev ? null : c.supabase.anonKey, loginUrl: c.appUrl ? c.appUrl.replace(/\/+$/, "") + "/" : null },
          limits: { maxBodyBytes: c.maxBodyBytes, maxImageBytes: c.maxImageBytes, maxOps: 200, maxUploads: 4 },
          base: c.baseBranch,
          schemaSha256: ctx.deps.schema.configSha256 || null,
          features: { selfPublish: !!c.allowSelfPublish },
        },
      };
    },
  },
  {
    method: "GET", path: "/v1/me", cls: "read",
    async run(ctx) {
      const rank = ROLE_RANK[ctx.role];
      return { status: 200, body: { user: { id: ctx.user.id, email: ctx.user.email, name: ctx.person && ctx.person.displayName ? ctx.person.displayName : ctx.user.name }, role: ctx.role, capabilities: { draft: rank >= 1, publish: rank >= 2, people: rank >= 3 } } };
    },
  },
];

module.exports = { routes };
