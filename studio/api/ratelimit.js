"use strict";
// Sliding-window limiter, in memory, per runtime instance. BEST EFFORT on serverless (every cold instance starts
// empty and instances do not share counters): for a hard limit put a shared store (Netlify Blobs / Cloudflare KV or
// Durable Object / Redis) behind the same `take(key, {limit, windowMs})` signature. Portable.

function createLimiter(opts) {
  const o = opts || {};
  const clock = o.now || (() => Date.now());
  const hits = new Map();
  const cap = o.maxKeys || 20000;
  return {
    take(key, { limit, windowMs }) {
      const t = clock();
      let arr = hits.get(key);
      if (!arr) {
        if (hits.size >= cap) { // drop the oldest keys instead of growing without bound
          const drop = Math.ceil(cap / 10);
          let i = 0;
          for (const k of hits.keys()) { hits.delete(k); i += 1; if (i >= drop) break; }
        }
        arr = [];
        hits.set(key, arr);
      }
      while (arr.length && arr[0] <= t - windowMs) arr.shift();
      if (arr.length >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000)) };
      arr.push(t);
      return { ok: true, retryAfterSec: 0 };
    },
    size: () => hits.size,
  };
}

const LIMITS = {
  anon: { limit: 30, windowMs: 60000 },
  badAuth: { limit: 10, windowMs: 60000 },
  read: { limit: 120, windowMs: 60000 },
  write: { limit: 20, windowMs: 600000 },
  publish: { limit: 10, windowMs: 600000 },
  restore: { limit: 10, windowMs: 3600000 },
  admin: { limit: 30, windowMs: 600000 },
  // outer bound for the AI route class; the AI service enforces the configured per-user / per-day / global limits itself
  ai: { limit: 30, windowMs: 600000 },
  aiDay: { limit: 60, windowMs: 86400000 },
};

module.exports = { createLimiter, LIMITS };
