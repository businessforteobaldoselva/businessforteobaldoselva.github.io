"use strict";
// TEST HELPER (not a test): a fake PostgREST that MODELS studio/sql/003_studio_ai_usage.sql function by function. Every call is
// applied atomically (the real functions run in one transaction), the caller is the user the bearer token maps to, and a caller
// who is not an active person is refused with 403, like the role check at the top of every function.
//   fake.fetch(url, init)       the injected fetch
//   fake.tokens                 Map(token -> { userId, active })
//   fake.fail                   null | "network" | "404" | "500" | "401"     (what the NEXT calls do, until reset)
//   fake.calls                  [ "studio_ai_reserve2", ... ]
//   fake.state()                { global: Map(day -> {requests,tokens}), users: Map(day|user -> {requests,tokens}), requests: Map(id -> row) }

function createFakePostgrest(opts) {
  const o = opts || {};
  const tokens = new Map(o.tokens || [["tok-molly", { userId: "11111111-1111-4111-8111-111111111111", active: true }], ["tok-amelia", { userId: "22222222-2222-4222-8222-222222222222", active: true }], ["tok-gone", { userId: "33333333-3333-4333-8333-333333333333", active: false }]]);
  const global = new Map();
  const users = new Map();
  const requests = new Map();
  const calls = [];
  const fake = { tokens, fail: null, calls, limits: { max_requests: 150, max_tokens: 3000000, user_max_requests: 60, user_max_tokens: 1000000, max_reservation: 60000 } };
  const g = (day) => { let r = global.get(day); if (!r) { r = { requests: 0, tokens: 0 }; global.set(day, r); } return r; };
  const u = (day, id) => { const k = day + "|" + id; let r = users.get(k); if (!r) { r = { requests: 0, tokens: 0, pendingN: 0, pendingT: 0 }; users.set(k, r); } return r; };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });

  const fns = {
    // mirrors studio/sql/003: caps are the LOWER of the caller's and the owner's limits row; settle / release only undo a pending reservation
    studio_ai_reserve2(a, me) {
      const L = fake.limits;
      const G = g(a.p_day); const U = u(a.p_day, me);
      const out = (ok, reason) => [{ ok, reason, g_requests: G.requests, g_tokens: G.tokens, u_requests: U.requests, u_tokens: U.tokens }];
      const t = a.p_tokens;
      if (G.requests + 1 > Math.min(a.p_max_requests, L.max_requests)) return out(false, "global_requests");
      if (G.tokens + t > Math.min(a.p_max_tokens, L.max_tokens) || t > L.max_reservation) return out(false, "global_tokens");
      if (U.requests + 1 > Math.min(a.p_user_max_requests, L.user_max_requests) || U.tokens + t > L.user_max_tokens) return out(false, "user_requests"); // the real function bumps global then undoes it: same outcome
      G.requests += 1; G.tokens += t; U.requests += 1; U.tokens += t; U.pendingN += 1; U.pendingT += t;
      return out(true, null);
    },
    studio_ai_settle2(a, me) {
      const G = g(a.p_day); const U = u(a.p_day, me); const give = a.p_count_request ? 0 : 1;
      if (U.pendingN < 1) return null;
      const reserved = Math.min(Math.max(a.p_reserved, 0), U.pendingT); const actual = Math.min(Math.max(a.p_actual, 0), fake.limits.max_reservation);
      for (const X of [G, U]) { X.tokens = Math.max(0, X.tokens + actual - reserved); X.requests = Math.max(0, X.requests - give); }
      U.pendingN -= 1; U.pendingT -= reserved;
      return null;
    },
    studio_ai_release2(a, me) {
      const U = u(a.p_day, me);
      if (U.pendingN < 1) return null;
      const amount = Math.min(Math.max(a.p_tokens, 0), U.pendingT);
      for (const X of [g(a.p_day), U]) { X.tokens = Math.max(0, X.tokens - amount); X.requests = Math.max(0, X.requests - 1); }
      U.pendingN -= 1; U.pendingT -= amount;
      return null;
    },
    studio_ai_snapshot2(a, me) { const G = g(a.p_day); const U = u(a.p_day, me); return [{ g_requests: G.requests, g_tokens: G.tokens, u_requests: U.requests, u_tokens: U.tokens }]; },
    studio_ai_record(a, me) {
      if (!/^p_[a-z0-9]{12}$/.test(a.p_id) || String(a.p_mode || "").length > 20 || String(a.p_kind || "").length > 20 || a.p_tokens < 0) return "bad";
      const old = requests.get(a.p_id);
      if (old && old.user_id !== me) return null; // on conflict ... where user_id = caller: someone else's row is left alone
      requests.set(a.p_id, { id: a.p_id, user_id: me, at: new Date(o.now ? o.now() : Date.now()).toISOString(), mode: a.p_mode, kind: a.p_kind, tokens: a.p_tokens, accepted: old ? old.accepted : null, total: old ? old.total : null, pr_number: old ? old.pr_number : null });
      return null;
    },
    studio_ai_attach(a, me) { const r = requests.get(a.p_id); if (r && r.user_id === me) Object.assign(r, { accepted: a.p_accepted, total: a.p_total, pr_number: a.p_pr }); return null; },
    studio_ai_recent(a, me) { return [...requests.values()].filter((r) => r.user_id === me).sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, Math.min(Math.max(a.p_limit || 20, 1), 20)); },
  };

  fake.fetch = async (url, init) => {
    const m = /\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(String(url));
    if (fake.fail === "network") throw new TypeError("fetch failed");
    if (!m) return res(404, { message: "not found" });
    calls.push(m[1]);
    if (fake.fail === "404") return res(404, { message: "Could not find the function public." + m[1] });
    if (fake.fail === "500") return res(500, { message: "boom" });
    if (fake.fail === "401") return res(401, { message: "JWT expired" });
    const bearer = /^Bearer (.+)$/.exec((init.headers || {}).Authorization || "");
    const who = bearer && tokens.get(bearer[1]);
    if (!who || !(init.headers || {}).apikey) return res(401, { message: "no" });
    if (!who.active) return res(403, { message: "not allowed" }); // errcode 42501 from the role check
    if (!fns[m[1]]) return res(404, { message: "no such function" });
    const out = fns[m[1]](JSON.parse(init.body), who.userId);
    if (out === "bad") return res(400, { message: "bad arguments" });
    return res(200, out);
  };
  fake.state = () => ({ global, users, requests });
  return fake;
}

module.exports = { createFakePostgrest };
