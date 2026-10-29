"use strict";
// boot(env, { schema, fetch }) -> (Request) => Promise<Response>.  Shared by the Netlify and Cloudflare adapters.
// A bad configuration never crashes the platform's runtime: every request gets a generic 500 and the reason (variable
// NAMES only, never values) is logged once. Portable.

const { loadConfig, buildDeps } = require("./config");
const { createHandler } = require("./handler");
const { json, errorBody } = require("./http");
const { ApiError } = require("./errors");

function boot(env, opts) {
  try {
    const config = loadConfig(env);
    const deps = buildDeps(config, env, { schema: opts.schema, fetch: opts.fetch });
    return createHandler(deps);
  } catch (e) {
    console.error("[studio] configuration error: " + String(e && e.message ? e.message : e).slice(0, 300));
    return async function misconfigured() {
      return json(500, errorBody(new ApiError("internal", "Studio is not configured."), crypto.randomUUID()));
    };
  }
}

module.exports = { boot };
