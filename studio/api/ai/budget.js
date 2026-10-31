"use strict";
// Daily budget (AI-DESIGN 12.2). BudgetStore { reserve(day, tokens), settle(day, reserved, actual), release(day, reserved),
// snapshot(day) }. In memory, per runtime instance: on serverless every instance counts alone, so the real ceiling is
// the limit times the number of instances (the runbook says so). A shared store can implement the same four methods
// (studio/sql/002_studio_ai.sql). Portable.

const dayKey = (d) => d.toISOString().slice(0, 10);
const nextMidnight = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();

function createMemoryBudget(opts) {
  const o = opts || {};
  const days = new Map();
  const get = (day) => {
    let r = days.get(day);
    if (!r) {
      r = { requests: 0, tokens: 0 };
      days.set(day, r);
      if (days.size > 4) for (const k of [...days.keys()].sort().slice(0, days.size - 4)) days.delete(k);
    }
    return r;
  };
  return {
    // -> { ok, remainingTokens, remainingRequests }
    reserve(day, tokens) {
      const r = get(day);
      const t = Math.max(0, Math.floor(Number(tokens) || 0));
      if (r.requests + 1 > o.dailyRequests || r.tokens + t > o.dailyTokens) return { ok: false, remainingTokens: Math.max(0, o.dailyTokens - r.tokens), remainingRequests: Math.max(0, o.dailyRequests - r.requests) };
      r.requests += 1;
      r.tokens += t;
      return { ok: true, remainingTokens: o.dailyTokens - r.tokens, remainingRequests: o.dailyRequests - r.requests };
    },
    // replace the estimate by what the model really used
    settle(day, reserved, actual) {
      const r = get(day);
      r.tokens = Math.max(0, r.tokens - Math.max(0, Number(reserved) || 0) + Math.max(0, Number(actual) || 0));
    },
    // a call that failed before returning any usage costs nothing
    release(day, reserved) {
      const r = get(day);
      r.requests = Math.max(0, r.requests - 1);
      r.tokens = Math.max(0, r.tokens - Math.max(0, Number(reserved) || 0));
    },
    snapshot(day) {
      const r = get(day);
      return { requests: r.requests, tokens: r.tokens, requestsLimit: o.dailyRequests, tokensLimit: o.dailyTokens };
    },
  };
}

module.exports = { createMemoryBudget, dayKey, nextMidnight };
