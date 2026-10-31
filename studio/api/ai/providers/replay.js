"use strict";
// Deterministic provider for every test, for CI and for studio:dev (AI-DESIGN 11). It answers from recordings keyed by
// the request's replay key and does nothing else: no network, no timers, no randomness. An unknown key fails loudly.
// Portable.

const { ProviderError } = require("./interface");

// recordings: { [replayKey]: ProviderResult-like | { throw: { code, status? } } }
function createReplayProvider(opts) {
  const o = opts || {};
  const recordings = o.recordings || {};
  const model = o.model || "claude-sonnet-5-5";
  const calls = [];
  return {
    id: "replay",
    model,
    calls,
    async complete(req) {
      const key = req && req.meta && req.meta.replayKey;
      const rec = Object.prototype.hasOwnProperty.call(recordings, key) ? recordings[key] : undefined;
      calls.push({ key, mode: req && req.meta && req.meta.mode });
      if (rec === undefined) throw new ProviderError("bad_response");
      if (rec && rec.throw) throw new ProviderError(rec.throw.code || "unavailable", rec.throw.status);
      const c = structuredClone(rec);
      return {
        toolInputs: Array.isArray(c.toolInputs) ? c.toolInputs : [],
        text: typeof c.text === "string" ? c.text : "",
        usage: { inTok: (c.usage && c.usage.inTok) || 1000, outTok: (c.usage && c.usage.outTok) || 200 },
        stopReason: c.stopReason || "tool_use",
        model: c.model || model,
      };
    },
  };
}

module.exports = { createReplayProvider };
