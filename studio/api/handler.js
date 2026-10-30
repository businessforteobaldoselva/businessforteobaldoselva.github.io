"use strict";
// createHandler(deps) -> async (Request) => Response. Web standard, no framework, no Node-only API (DESIGN 7.1).
//   order: base path -> CORS / preflight -> route -> CSRF checks -> rate limit -> bearer auth -> role -> route.run
// The only credential is `Authorization: Bearer <jwt>`. No cookie is ever read or set.

const { ApiError } = require("./errors");
const { json, errorBody, readJson, bearer } = require("./http");
const { createCors } = require("./cors");
const { createRouter } = require("./router");
const { LIMITS } = require("./ratelimit");
const { AuthError } = require("./providers/auth/interface");
const ids = require("./services/ids");
const drafts = require("./services/drafts");

const ROLE_RANK = drafts.ROLE_RANK;
const ROLE_TTL_MS = 30000;
const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function allRoutes() {
  return [].concat(
    require("./routes/me").routes,
    require("./routes/drafts").routes,
    require("./routes/history").routes,
    require("./routes/admin").routes,
  );
}

function createHandler(deps) {
  const config = deps.config;
  deps.roleCache = deps.roleCache || new Map();
  deps.drafts = deps.drafts || { createFromOps: (args) => drafts.createFromOps(Object.assign({ deps }, args)) };
  const cors = createCors({ allowedOrigins: config.allowedOrigins, previewTemplate: config.previewOriginTemplate });
  deps.cors = cors;
  const router = createRouter(allRoutes());

  async function handle(request, requestId) {
    const url = new URL(request.url);
    let pathname = url.pathname;
    if (config.basePath) {
      if (pathname !== config.basePath && !pathname.startsWith(config.basePath + "/")) throw new ApiError("not_found", "Not found.");
      pathname = pathname.slice(config.basePath.length) || "/";
    }
    const method = request.method.toUpperCase();
    const origin = request.headers.get("origin");
    const ip = request.headers.get("x-studio-client-ip") || "unknown";
    const corsHeaders = cors.headers(origin);

    if (method === "OPTIONS") {
      if (origin && cors.allowed(origin)) return new Response(null, { status: 204, headers: Object.assign({ "Cache-Control": "no-store" }, corsHeaders) });
      throw new ApiError("forbidden", "This origin is not allowed.");
    }

    const m = router.match(method, pathname);
    if (!m) throw new ApiError("not_found", "Not found.");
    if (m.methodNotAllowed) throw new ApiError("bad_request", "Method not allowed.");
    const route = m.route;

    // CSRF: state-changing calls need an allowed Origin (or none, only when configured for tests / dev tools) and JSON
    if (WRITE_METHODS.has(method)) {
      if (origin) { if (!cors.allowed(origin)) throw new ApiError("forbidden", "This origin is not allowed."); }
      else if (!config.allowNoOrigin) throw new ApiError("forbidden", "Requests must come from the Studio page.");
      if (method !== "DELETE" && !/^application\/json\b/i.test(request.headers.get("content-type") || "")) throw new ApiError("unsupported_media_type", "Send the request as application/json.");
    }

    const take = (key, spec) => {
      const r = deps.limiter.take(key, spec);
      if (!r.ok) {
        deps.audit.write({ requestId, action: "rate.limited", outcome: "denied", ip, target: { route: route.path } });
        throw new ApiError("rate_limited", "Too many requests. Try again shortly.", { retryAfterSec: r.retryAfterSec }, { headers: { "Retry-After": String(r.retryAfterSec) } });
      }
    };
    const req = { params: m.params, query: url.searchParams, request, json: () => readJson(request, config.maxBodyBytes) };

    if (route.anon) {
      take("anon:" + ip, LIMITS.anon);
      const out = await route.run({ deps, requestId }, req);
      return json(out.status, out.body);
    }

    const token = bearer(request);
    if (!token) { take("anon:" + ip, LIMITS.anon); await deny(requestId, ip, "missing token"); }
    let user;
    try { user = await deps.auth.verify(token, { now: deps.now(), url: request.url }); } catch (e) {
      take("badauth:" + ip, LIMITS.badAuth);
      if (e instanceof AuthError || (e && e.name === "AuthError")) await deny(requestId, ip, e.code);
      throw e;
    }

    // role on EVERY request (cached <= 30 s), so a deactivated person loses access quickly
    const nowMs = deps.now().getTime();
    let person;
    const cached = deps.roleCache.get(user.userId);
    if (cached && nowMs - cached.at < ROLE_TTL_MS) person = cached.value;
    else {
      try { person = await deps.roles.getRole(user, token); } catch (e) { throw new ApiError("upstream_error", "The people list is unavailable."); }
      if (person && person.active && ROLE_RANK[person.role]) deps.roleCache.set(user.userId, { at: nowMs, value: person });
    }
    if (!person || !person.active || !ROLE_RANK[person.role]) {
      take("badauth:" + ip, LIMITS.badAuth);
      deps.audit.write({ requestId, actor: { id: user.userId, email: user.email, role: null }, action: "auth.denied", outcome: "denied", ip });
      throw new ApiError("not_invited", "You have not been invited to Studio yet. Ask an admin to add you.");
    }
    if (route.minRole && ROLE_RANK[person.role] < ROLE_RANK[route.minRole]) throw new ApiError("forbidden", "Your role cannot do this.");
    take("u:" + user.userId + ":" + route.cls, LIMITS[route.cls] || LIMITS.read);

    const ctx = {
      deps, requestId, token, role: person.role, person,
      user: { id: user.userId, email: user.email, name: person.displayName || user.name },
      userKey: await ids.userKey(user.userId),
    };
    const out = await route.run(ctx, req);
    return json(out.status, out.body);
  }

  async function deny(requestId, ip, why) {
    deps.audit.write({ requestId, action: "auth.denied", outcome: "denied", ip, problems: [String(why).slice(0, 40)] });
    throw new ApiError("unauthorized", "Please sign in again.");
  }

  return async function studioHandler(request) {
    const requestId = deps.randomUUID();
    const corsHeaders = cors.headers(request.headers.get("origin"));
    let res;
    try {
      res = await handle(request, requestId);
    } catch (err) {
      if (err instanceof ApiError) res = json(err.status, errorBody(err, requestId), err.headers);
      else {
        console.error("[studio] internal error " + requestId + ": " + String(err && err.message ? err.message : err).slice(0, 300));
        res = json(500, errorBody(new ApiError("internal", "Something went wrong. Quote this id if you report it: " + requestId), requestId));
      }
    }
    const headers = new Headers(res.headers);
    headers.set("X-Request-Id", requestId);
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  };
}

module.exports = { createHandler };
