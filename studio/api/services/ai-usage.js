"use strict";
// AI usage routes (PHASE1-DESIGN 10.4 and 10.5): POST /v1/ai/estimate and GET /v1/ai/recent. The AI service (ai/index.js) hands in
// what these need (its own request parser, the "prepare" step shared with propose, and the usage store for THIS request).
//
// estimate calls NO model, reserves NOTHING, counts NOTHING and writes nothing: it builds the same prompt propose would build and
// says what it would cost against today's allowance. recent lists the caller's OWN last requests (never instruction text).
// Portable.

const { ApiError } = require("../errors");
const { validateAiEstimate, validateAiRecent } = require("../shapes/phase1");
const P = require("../../validate/pointer");

const NO_HASH = "0000000000000000"; // an estimate has no instruction hash; the prompt does not use it

// "About 0.4% of today's AI allowance." (one decimal below 10%, whole numbers from 10%)
function labelFor(pct) {
  if (pct < 0.1) return "Less than 0.1% of today's AI allowance.";
  const v = pct < 10 ? (Math.round(pct * 10) / 10).toFixed(1) : String(Math.round(pct));
  return "About " + v + "% of today's AI allowance.";
}

async function estimate(ctx, body, env) {
  const { deps, cfg } = env;
  if (!env.isEnabled()) throw new ApiError("ai_disabled", "AI help is switched off.");
  if (!P.isPlainObject(body)) throw new ApiError("bad_request", "The request must be a JSON object.");
  const req = env.parseRequest(Object.assign({ idempotencyKey: deps.randomUUID() }, body));
  const prep = await env.prepare(ctx, req, NO_HASH);
  const inputTokens = prep.early ? 0 : prep.inputTokens;
  const maxOutputTokens = prep.early ? 0 : cfg.maxOutputTokens;
  const estTokens = inputTokens + maxOutputTokens;
  const day = env.today();
  const snap = await env.store.snapshot({ day, userId: ctx.userKey });
  const recent = await env.store.recent({ userId: ctx.userKey, limit: 10 });
  const typicalTokens = recent.length ? Math.round(recent.reduce((n, r) => n + r.tokens, 0) / recent.length) : null;
  const requestsLeftToday = Math.max(0, cfg.dailyRequests - snap.global.requests);
  const yourRequestsLeftToday = Math.max(0, cfg.userPerDay - snap.user.requests);
  const rawPct = Math.min(100, (estTokens / Math.max(1, cfg.dailyTokens)) * 100);
  const out = {
    estimate: {
      inputTokens, maxOutputTokens, estTokens, typicalTokens,
      pctOfDay: env.pct(estTokens, cfg.dailyTokens), requestsLeftToday, yourRequestsLeftToday,
      label: labelFor(rawPct),
      wouldFit: requestsLeftToday > 0 && yourRequestsLeftToday > 0 && estTokens <= cfg.dailyTokens - snap.global.tokens,
    },
  };
  const bad = validateAiEstimate(out);
  if (bad.length) throw new Error("estimate shape: " + bad[0]);
  return out;
}

async function recent(ctx, env) {
  const { deps, store } = env;
  const rows = await store.recent({ userId: ctx.userKey, limit: 20 });
  const items = rows.slice(0, 20).map((r) => ({
    id: r.id, at: r.at, mode: String(r.mode || "").slice(0, 20), kind: r.kind, tokens: r.tokens,
    accepted: r.accepted, total: r.total, prNumber: r.prNumber,
    prUrl: r.prNumber ? deps.git.prUrl(r.prNumber) : null,
  }));
  const out = { store: store.kind, items };
  const bad = validateAiRecent(out);
  if (bad.length) throw new Error("recent shape: " + bad[0]);
  return out;
}

module.exports = { estimate, recent, labelFor };
