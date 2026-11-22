"use strict";
// The SHARED AI usage store: PostgREST RPC calls to the functions of studio/sql/003_studio_ai_usage.sql, made with the CALLER'S OWN
// JWT, so the database (not this code) decides who may count. The API holds no service key. Opt-in: STUDIO_AI_BUDGET_STORE=supabase.
// Any failure (network, 404 = the SQL was never applied, 401/403, 5xx, a strange answer) throws StoreUnavailable; ai/budget.js
// selectStore() then serves that request from the memory store (caps still apply) and logs one `usage.store_fallback` line.
// Same BudgetStore interface as the memory store. Portable: fetch comes from deps.

const { StoreUnavailable } = require("../../ai/budget");
const nat = (v) => Math.max(0, Math.floor(Number(v) || 0));
const RECENT_MAX = 20;

function createSupabaseBudget({ deps, token, limits }) {
  const url = deps.config.supabase.url;
  const anonKey = deps.config.supabase.anonKey;
  const base = String(url || "").replace(/\/+$/, "") + "/rest/v1/rpc/";
  const doFetch = (...a) => deps.fetch(...a);
  const lim = limits || {};
  async function rpc(fn, args) {
    let res;
    try { res = await doFetch(base + fn, { method: "POST", headers: { apikey: anonKey, Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(args) }); } catch (e) { throw new StoreUnavailable("network"); }
    if (!res.ok) throw new StoreUnavailable("http_" + res.status); // 404 = the functions were never applied; 401/403 = not an active person; 5xx = down
    const text = await res.text();
    try { return text ? JSON.parse(text) : null; } catch (e) { throw new StoreUnavailable("bad_json"); }
  }
  const first = (r) => (Array.isArray(r) ? r[0] : r) || null;
  const num = (v) => nat(v);
  return {
    kind: "supabase",
    async reserve({ day, tokens, caps }) {
      const r = first(await rpc("studio_ai_reserve2", { p_day: day, p_tokens: nat(tokens), p_max_requests: caps.requests, p_max_tokens: caps.tokens, p_user_max_requests: caps.userRequests }));
      if (!r || typeof r.ok !== "boolean") throw new StoreUnavailable("bad_shape");
      const reason = r.ok ? null : ["global_requests", "global_tokens", "user_requests"].indexOf(r.reason) >= 0 ? r.reason : "global_requests";
      return { ok: r.ok, reason, global: { requests: num(r.g_requests), tokens: num(r.g_tokens) }, user: { requests: num(r.u_requests), tokens: num(r.u_tokens) } };
    },
    async settle({ day, reserved, actual, countRequest }) { await rpc("studio_ai_settle2", { p_day: day, p_reserved: nat(reserved), p_actual: nat(actual), p_count_request: countRequest !== false }); },
    async release({ day, reserved }) { await rpc("studio_ai_release2", { p_day: day, p_tokens: nat(reserved) }); },
    async snapshot({ day }) {
      const r = first(await rpc("studio_ai_snapshot2", { p_day: day }));
      if (!r) throw new StoreUnavailable("bad_shape");
      return { global: { requests: num(r.g_requests), tokens: num(r.g_tokens), requestsLimit: lim.dailyRequests, tokensLimit: lim.dailyTokens }, user: { requests: num(r.u_requests), tokens: num(r.u_tokens), requestsLimit: lim.userPerDay } };
    },
    async recordRequest({ id, mode, kind, tokens }) { await rpc("studio_ai_record", { p_id: id, p_mode: mode, p_kind: kind, p_tokens: nat(tokens) }); },
    async attachAccept({ id, accepted, total, prNumber }) { await rpc("studio_ai_attach", { p_id: id, p_accepted: nat(accepted), p_total: nat(total), p_pr: prNumber === null || prNumber === undefined ? null : nat(prNumber) }); },
    async recent({ limit }) {
      const rows = await rpc("studio_ai_recent", { p_limit: Math.max(1, Math.min(RECENT_MAX, limit || RECENT_MAX)) });
      if (!Array.isArray(rows)) throw new StoreUnavailable("bad_shape");
      return rows.slice(0, RECENT_MAX).map((r) => ({ id: String(r.id), at: new Date(r.at).toISOString(), mode: String(r.mode || ""), kind: String(r.kind || ""), tokens: num(r.tokens), accepted: r.accepted === null || r.accepted === undefined ? null : num(r.accepted), total: r.total === null || r.total === undefined ? null : num(r.total), prNumber: r.pr_number === null || r.pr_number === undefined ? null : num(r.pr_number) }));
    },
  };
}

module.exports = { createSupabaseBudget };
