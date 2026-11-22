"use strict";
// GET /v1/health (PHASE1-DESIGN 4.1). Is the sign-in service up, is GitHub up, is AI help on. Anonymous and cheap: the result
// is cached per runtime instance, concurrent callers share ONE check, and the answer holds only fixed plain-English sentences
// (never an address, a key, an upstream error text or a count of anything). Portable: time, fetch and Git come from deps.

const SLOW_MS = 1500;
const MESSAGES = {
  paused: "Sign-in is paused because the Studio database has been idle. An admin can wake it from the Supabase dashboard (Restore project).",
  authDown: "Studio cannot reach its sign-in service right now. Your edits on this page are safe. Try again in a minute.",
  gitDown: "Studio cannot reach GitHub right now. You can keep editing; saving will work again when it is back.",
};

const clamp = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : def; };

// run fn with a hard time limit; a late answer is ignored
function withTimeout(ms, fn) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => { if (ac) ac.abort(); reject(new Error("timeout")); }, ms); });
  return Promise.race([Promise.resolve().then(() => fn(ac ? ac.signal : undefined)), limit]).finally(() => clearTimeout(timer));
}

function createHealth(deps) {
  const cfg = deps.config.health || {};
  const ttlMs = clamp(cfg.ttlSeconds, 5, 300, 30) * 1000;
  const timeoutMs = clamp(cfg.timeoutMs, 500, 10000, 3000);
  const perf = deps.perfNow || (() => Date.now());
  let cache = null; // { at, value }
  let flight = null;

  async function checkAuth() {
    if (deps.config.dev) return { state: "ok", message: null };
    const t0 = perf();
    try {
      const url = deps.config.supabase.url.replace(/\/+$/, "") + "/auth/v1/health";
      const res = await withTimeout(timeoutMs, async (signal) => {
        const r = await deps.fetch(url, { headers: { apikey: deps.config.supabase.anonKey, Accept: "application/json" }, signal });
        const text = r.status === 540 || r.status >= 500 ? "" : await r.text().catch(() => "");
        return { status: r.status, text };
      });
      if (res.status === 540 || /paus/i.test(res.text)) return { state: "paused", message: MESSAGES.paused };
      if (res.status >= 500) return { state: "unreachable", message: MESSAGES.authDown };
      return { state: perf() - t0 > SLOW_MS ? "slow" : "ok", message: null };
    } catch (e) { return { state: "unreachable", message: MESSAGES.authDown }; }
  }

  async function checkGit() {
    const t0 = perf();
    try {
      await withTimeout(timeoutMs, () => deps.git.getHead(deps.git.getBaseBranch()));
      return { state: perf() - t0 > SLOW_MS ? "slow" : "ok", message: null };
    } catch (e) { return { state: "unreachable", message: MESSAGES.gitDown }; }
  }

  async function checkAi() {
    try { return await deps.ai.health(); } catch (e) { return { state: "unknown", store: "memory", message: null }; }
  }

  async function run() {
    const [auth, git, ai] = await Promise.all([checkAuth(), checkGit(), checkAi()]);
    const good = (s) => s.state === "ok" || s.state === "slow";
    const ok = good(auth) && good(git);
    return { ok, checkedAt: deps.now().toISOString(), cached: false, services: { auth, git, ai }, message: ok ? null : auth.message || git.message || MESSAGES.authDown };
  }

  async function check() {
    const t = deps.now().getTime();
    if (cache && t - cache.at < ttlMs) return Object.assign({}, cache.value, { cached: true });
    if (!flight) flight = run().then((v) => { cache = { at: deps.now().getTime(), value: v }; return v; }).finally(() => { flight = null; });
    return Object.assign({}, await flight);
  }

  return { check };
}

// one health checker per deps object (so the cache and the shared in-flight check live as long as the runtime instance)
function forDeps(deps) { return deps._health || (deps._health = createHealth(deps)); }

module.exports = { createHealth, forDeps, MESSAGES, SLOW_MS };
