"use strict";
// Daily AI allowance (AI-DESIGN 12.2, PHASE1-DESIGN 10.1). ONE async interface, two implementations:
//
//   BudgetStore { kind: "memory"|"supabase",
//     reserve({ day, tokens, userId, caps:{ requests, tokens, userRequests } }) -> { ok, reason, global:{requests,tokens}, user:{requests,tokens} }
//     settle({ day, reserved, actual, userId, countRequest })   always adds the REAL tokens; countRequest:false gives the request back
//     release({ day, reserved, userId })                         the call failed before any answer: nothing was spent
//     snapshot({ day, userId }) -> { global:{requests,tokens,requestsLimit,tokensLimit}, user:{requests,tokens,requestsLimit} }
//     recordRequest({ userId, id, mode, kind, tokens })  attachAccept({ userId, id, accepted, total, prNumber })
//     recent({ userId, limit }) -> [{ id, at, mode, kind, tokens, accepted, total, prNumber }] }
//
// memory: per runtime instance (on serverless every instance counts alone, so the real ceiling is the limit times the number of
// instances; the runbook says so). supabase (providers/usage/supabase-budget.js): ONE shared counter through the RPC functions of
// studio/sql/003_studio_ai_usage.sql, called with the CALLER'S OWN JWT (the API holds no service key). When the shared store fails or is not set up, that request is
// served by the memory store and one `usage.store_fallback` line is logged: the caps still apply, never "unlimited". Portable.

const dayKey = (d) => d.toISOString().slice(0, 10);
const nextMidnight = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
const nat = (v) => Math.max(0, Math.floor(Number(v) || 0));
const RECENT_MAX = 20;

function createMemoryBudget(opts) {
  const o = opts || {};
  const now = o.now || (() => new Date());
  const days = new Map(); // day -> { g:{requests,tokens}, users: Map(userId -> {requests,tokens}) }
  const recents = new Map(); // userId -> [item], newest first
  const day = (k) => {
    let r = days.get(k);
    if (!r) {
      r = { g: { requests: 0, tokens: 0 }, users: new Map() };
      days.set(k, r);
      if (days.size > 4) for (const x of [...days.keys()].sort().slice(0, days.size - 4)) days.delete(x);
    }
    return r;
  };
  const user = (d, id) => { let u = d.users.get(id || ""); if (!u) { u = { requests: 0, tokens: 0 }; d.users.set(id || "", u); } return u; };
  const view = (d, id) => ({ global: { requests: d.g.requests, tokens: d.g.tokens }, user: { requests: user(d, id).requests, tokens: user(d, id).tokens } });
  const limits = () => ({ requestsLimit: o.dailyRequests, tokensLimit: o.dailyTokens });
  return {
    kind: "memory",
    // everything below is synchronous inside, so two calls can never interleave: the check and the increment are one step
    async reserve({ day: k, tokens, userId, caps }) {
      const d = day(k);
      const u = user(d, userId);
      const t = nat(tokens);
      const c = caps || { requests: o.dailyRequests, tokens: o.dailyTokens, userRequests: o.userPerDay };
      let reason = null;
      if (d.g.requests + 1 > c.requests) reason = "global_requests";
      else if (d.g.tokens + t > c.tokens) reason = "global_tokens";
      else if (c.userRequests !== undefined && u.requests + 1 > c.userRequests) reason = "user_requests";
      if (reason) return Object.assign({ ok: false, reason }, view(d, userId));
      d.g.requests += 1; d.g.tokens += t; u.requests += 1; u.tokens += t;
      return Object.assign({ ok: true, reason: null }, view(d, userId));
    },
    async settle({ day: k, reserved, actual, userId, countRequest }) {
      const d = day(k);
      const u = user(d, userId);
      const delta = nat(actual) - nat(reserved);
      d.g.tokens = Math.max(0, d.g.tokens + delta);
      u.tokens = Math.max(0, u.tokens + delta);
      if (countRequest === false) { d.g.requests = Math.max(0, d.g.requests - 1); u.requests = Math.max(0, u.requests - 1); }
    },
    async release({ day: k, reserved, userId }) {
      const d = day(k);
      const u = user(d, userId);
      d.g.requests = Math.max(0, d.g.requests - 1); d.g.tokens = Math.max(0, d.g.tokens - nat(reserved));
      u.requests = Math.max(0, u.requests - 1); u.tokens = Math.max(0, u.tokens - nat(reserved));
    },
    async snapshot({ day: k, userId }) {
      const d = day(k);
      const v = view(d, userId);
      return { global: Object.assign(v.global, limits()), user: Object.assign(v.user, { requestsLimit: o.userPerDay }) };
    },
    async recordRequest({ userId, id, mode, kind, tokens }) {
      // the same proposal id again (the same answer asked for twice) refreshes its row, like the SQL's "on conflict do update"
      const all = recents.get(userId || "") || [];
      const old = all.find((x) => x.id === id);
      const list = all.filter((x) => x.id !== id);
      list.unshift({ id, at: now().toISOString(), mode, kind, tokens: nat(tokens), accepted: old ? old.accepted : null, total: old ? old.total : null, prNumber: old ? old.prNumber : null });
      recents.set(userId || "", list.slice(0, RECENT_MAX));
      if (recents.size > 500) recents.delete(recents.keys().next().value);
    },
    async attachAccept({ userId, id, accepted, total, prNumber }) {
      const it = (recents.get(userId || "") || []).find((x) => x.id === id);
      if (it) { it.accepted = nat(accepted); it.total = nat(total); it.prNumber = prNumber === null || prNumber === undefined ? null : nat(prNumber); }
    },
    async recent({ userId, limit }) {
      return (recents.get(userId || "") || []).slice(0, Math.max(1, Math.min(RECENT_MAX, limit || RECENT_MAX))).map((x) => Object.assign({}, x));
    },
  };
}

class StoreUnavailable extends Error { constructor(why) { super(why); this.name = "StoreUnavailable"; } }

// One store for one request: the shared store when it is configured and answering, else the memory store. `shared.down` remembers
// a failure for a minute so a dead database is not asked on every call; `log` receives { store, why } once per failure.
function selectStore({ memory, supabase, shared, now, log }) {
  if (!supabase) return memory;
  const state = shared || {};
  let usedKind = "supabase";
  const down = () => state.downUntil && now().getTime() < state.downUntil;
  const fall = (why) => { usedKind = "memory"; if (!down()) { state.downUntil = now().getTime() + 60000; if (log) log({ store: "supabase", why }); } };
  let reservedOn = null; // the counters a reservation went to; settle / release must undo it THERE
  const wrap = (name) => async (args) => {
    const pin = name === "settle" || name === "release";
    if (down() || (pin && reservedOn === "memory")) { usedKind = "memory"; if (name === "reserve") reservedOn = "memory"; return memory[name](args); }
    try { const r = await supabase[name](args); if (name === "reserve") reservedOn = "supabase"; return r; } catch (e) {
      if (!(e instanceof StoreUnavailable)) throw e;
      fall(e.message);
      if (name === "reserve") reservedOn = "memory";
      return memory[name](args);
    }
  };
  const store = { get kind() { return down() ? "memory" : usedKind; } };
  for (const m of ["reserve", "settle", "release", "snapshot", "recordRequest", "attachAccept", "recent"]) store[m] = wrap(m);
  return store;
}

module.exports = { createMemoryBudget, selectStore, StoreUnavailable, dayKey, nextMidnight };
