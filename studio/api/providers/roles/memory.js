"use strict";
// RoleStore interface (DESIGN 8.1) + the in-memory implementation used by tests and `studio:dev`.
//   getRole(user, token) -> { role, active, displayName } | null      (a person is found by email; first login binds the user id)
//   listPeople(token) -> [Person]        upsertPerson(token, person) -> Person
// Authorisation (who may call list/upsert) is decided by the routes; the Supabase store additionally has RLS.

const ROLES = ["editor", "approver", "admin"];

function createMemoryRoles(seed, now) {
  const clock = now || (() => new Date());
  const byEmail = new Map();
  const put = (p) => {
    const email = String(p.email).toLowerCase();
    const prev = byEmail.get(email) || {};
    const rec = { userId: p.userId !== undefined ? p.userId : prev.userId || null, email, displayName: p.displayName || prev.displayName || email.split("@")[0], role: p.role || prev.role, active: p.active !== undefined ? !!p.active : prev.active !== undefined ? prev.active : true, createdAt: prev.createdAt || clock().toISOString() };
    if (ROLES.indexOf(rec.role) < 0) throw new Error("bad role");
    byEmail.set(email, rec);
    return rec;
  };
  (seed || []).forEach(put);
  return {
    async getRole(user) {
      const rec = byEmail.get(String(user.email).toLowerCase());
      if (!rec) return null;
      if (!rec.userId) rec.userId = user.userId; // an invited person signs in for the first time
      else if (rec.userId !== user.userId) return null; // the email is bound to another account
      return { role: rec.role, active: rec.active, displayName: rec.displayName };
    },
    async listPeople() { return [...byEmail.values()].map((r) => Object.assign({}, r)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)); },
    async upsertPerson(token, person) { return Object.assign({}, put(person)); },
  };
}

const DEV_PEOPLE = [
  { email: "molly@covered.test", displayName: "Molly", role: "editor" },
  { email: "amelia@covered.test", displayName: "Amelia", role: "approver" },
  { email: "teo@covered.test", displayName: "Teo", role: "admin" },
];

module.exports = { createMemoryRoles, ROLES, DEV_PEOPLE };
