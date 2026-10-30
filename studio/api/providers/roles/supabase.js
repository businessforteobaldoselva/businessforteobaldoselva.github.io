"use strict";
// RoleStore over Supabase PostgREST, called with the CALLER'S OWN JWT so row level security decides what they may see
// (studio/sql/001_studio_roles.sql). This API never holds a service-role key. Portable (fetch only).

const ROLES = ["editor", "approver", "admin"];

function createSupabaseRoles({ supabaseUrl, anonKey, fetch: fetchFn }) {
  const base = supabaseUrl.replace(/\/+$/, "");
  const doFetch = fetchFn || ((...a) => fetch(...a));
  const headers = (token, extra) => Object.assign({ apikey: anonKey, Authorization: "Bearer " + token, Accept: "application/json" }, extra || {});

  async function call(url, init) {
    let res;
    try { res = await doFetch(url, init); } catch (e) { const err = new Error("roles store unreachable"); err.code = "upstream"; throw err; }
    if (res.status === 401 || res.status === 403) return { denied: true };
    if (!res.ok) { const err = new Error("roles store: HTTP " + res.status); err.code = "upstream"; throw err; }
    const text = await res.text();
    return { body: text ? JSON.parse(text) : null };
  }
  const toRole = (r) => (r && ROLES.indexOf(r.role) >= 0 ? { role: r.role, active: r.active === true, displayName: r.display_name || null } : null);
  const toPerson = (r) => ({ userId: r.user_id || null, email: r.email, displayName: r.display_name || null, role: r.role, active: r.active === true, createdAt: r.created_at });

  return {
    async getRole(user, token) {
      const r = await call(base + "/rest/v1/studio_roles?select=role,active,display_name&user_id=eq." + encodeURIComponent(user.userId), { headers: headers(token) });
      if (r.denied) return null;
      if (Array.isArray(r.body) && r.body.length) return toRole(r.body[0]);
      // first sign-in of an invited person: the SQL function binds the invited email to this account (needs a confirmed email)
      const c = await call(base + "/rest/v1/rpc/studio_claim_role", { method: "POST", headers: headers(token, { "Content-Type": "application/json" }), body: "{}" });
      if (c.denied || !c.body) return null;
      return toRole(Array.isArray(c.body) ? c.body[0] : c.body);
    },
    async listPeople(token) {
      const r = await call(base + "/rest/v1/studio_roles?select=user_id,email,display_name,role,active,created_at&order=created_at.asc&limit=200", { headers: headers(token) });
      if (r.denied) return [];
      return (r.body || []).map(toPerson);
    },
    async upsertPerson(token, p) {
      const row = { email: String(p.email).toLowerCase(), role: p.role, active: p.active !== false, display_name: p.displayName || null };
      const r = await call(base + "/rest/v1/studio_roles?on_conflict=email", { method: "POST", headers: headers(token, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" }), body: JSON.stringify(row) });
      if (r.denied) { const err = new Error("not allowed"); err.code = "denied"; throw err; }
      return toPerson((r.body || [])[0] || row);
    },
  };
}

module.exports = { createSupabaseRoles };
