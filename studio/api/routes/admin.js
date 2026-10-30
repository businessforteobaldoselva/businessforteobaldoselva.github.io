"use strict";
// /v1/admin/people (admin only). The store enforces the same with row level security; the last-admin and
// self-demotion guards live here.

const { ApiError } = require("../errors");

const ROLES = ["editor", "approver", "admin"];

function parsePerson(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError("bad_request", "The request must be a JSON object.");
  for (const k of Object.keys(b)) if (["email", "role", "active", "displayName"].indexOf(k) < 0) throw new ApiError("bad_request", "Unknown field " + JSON.stringify(k.slice(0, 30)) + ".");
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && !/^[^\s@<>]+@localhost$/.test(email)) throw new ApiError("bad_request", "email is not valid.");
  if (email.length > 254) throw new ApiError("bad_request", "email is too long.");
  if (ROLES.indexOf(b.role) < 0) throw new ApiError("bad_request", "role must be editor, approver or admin.");
  if (typeof b.active !== "boolean") throw new ApiError("bad_request", "active must be true or false.");
  let displayName = null;
  if (b.displayName !== undefined && b.displayName !== null) {
    if (typeof b.displayName !== "string" || b.displayName.length > 60 || /[\u0000-\u001f<>]/.test(b.displayName)) throw new ApiError("bad_request", "displayName must be plain text of at most 60 characters.");
    displayName = b.displayName.trim() || null;
  }
  return { email, role: b.role, active: b.active, displayName };
}

const routes = [
  {
    method: "GET", path: "/v1/admin/people", cls: "admin", minRole: "admin",
    async run(ctx) { return { status: 200, body: { people: await ctx.deps.roles.listPeople(ctx.token) } }; },
  },
  {
    method: "PUT", path: "/v1/admin/people", cls: "admin", minRole: "admin",
    async run(ctx, req) {
      const p = parsePerson(await req.json());
      const people = await ctx.deps.roles.listPeople(ctx.token);
      const current = people.find((x) => String(x.email).toLowerCase() === p.email);
      const wasActiveAdmin = current && current.role === "admin" && current.active;
      const staysActiveAdmin = p.role === "admin" && p.active;
      if (p.email === ctx.user.email && !staysActiveAdmin) throw new ApiError("forbidden", "You cannot remove your own admin access.");
      if (wasActiveAdmin && !staysActiveAdmin && people.filter((x) => x.role === "admin" && x.active).length <= 1) throw new ApiError("forbidden", "There must always be one active admin.");
      let person;
      try { person = await ctx.deps.roles.upsertPerson(ctx.token, p); } catch (e) {
        if (e && e.code === "denied") throw new ApiError("forbidden", "Not allowed.");
        throw new ApiError("upstream_error", "The people list could not be saved.");
      }
      ctx.deps.roleCache.clear();
      ctx.deps.audit.write({ requestId: ctx.requestId, actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role }, action: "people.upsert", target: { email: p.email, role: p.role, active: p.active }, outcome: "ok" });
      return { status: 200, body: { person } };
    },
  },
];

module.exports = { routes, parsePerson };
