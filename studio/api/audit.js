"use strict";
// Audit trail (DESIGN 7.2): who did what, never what was in it. Entries carry paths and codes, never values, tokens
// or request bodies; any key that looks secret is redacted from whatever a caller passes. Portable.

const SECRET_KEY = /key|secret|token|authorization|pepper|password|cookie/i;
const ACTIONS = new Set(["auth.denied", "draft.create", "draft.update", "draft.submit", "draft.publish", "draft.discard", "draft.rebase", "history.restore", "people.upsert", "validation.failed", "rate.limited", "ai.propose", "ai.accept", "ai.rejected", "ai.denied", "ai.injection_suspected"]);

function redact(v, depth) {
  if (depth > 5) return "[deep]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v[k], depth + 1);
    return o;
  }
  if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "..." : v;
  return v;
}

async function ipHash(salt, ip) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(salt || "") + String(ip || "")));
  return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// sinks: [{ write(entry) }]. The console sink is always part of the production wiring (see config.js).
function createAudit(opts) {
  const o = opts || {};
  const list = o.sinks || [];
  return {
    async write(entry) {
      const e = Object.assign({ ts: (o.now ? o.now() : new Date()).toISOString() }, entry);
      if (!ACTIONS.has(e.action)) e.action = "auth.denied";
      if (e.ip !== undefined) { e.ipHash = await ipHash(o.salt, e.ip); delete e.ip; }
      const clean = redact(e, 0);
      for (const s of list) {
        try { await s.write(clean); } catch (err) { /* an audit sink must never break a request */ }
      }
    },
  };
}

const consoleSink = { write(entry) { console.log(JSON.stringify({ studioAudit: entry })); } };
function memorySink() { const entries = []; return { entries, write(e) { entries.push(e); } }; }

module.exports = { createAudit, consoleSink, memorySink, redact, ACTIONS };
