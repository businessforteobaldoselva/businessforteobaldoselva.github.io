"use strict";
// Recordings for studio:dev (AI-DESIGN 11, 1.1): the fixtures' recorded answers keyed by the same replay key the service
// computes, so the overlay can be driven without an API key. Type one of the sample instructions (see
// studio/ai-eval/README.md) and the recorded answer comes back; anything else gets a polite "ask" from the fallback.
// Node only (reads the fixtures folder); never used in production.

const fs = require("fs");
const path = require("path");
const prop = require("../api/ai/proposal");

function expand(v) {
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") {
    const k = Object.keys(v);
    if (k.length === 1 && k[0] === "$repeat") return String(v.$repeat[0]).repeat(Number(v.$repeat[1]));
    const o = {};
    for (const x of k) o[x] = expand(v[x]);
    return o;
  }
  return v;
}

// -> { recordings: { [replayKey]: ProviderResult-like }, samples: [{ id, mode, instruction }] }
async function loadRecordings(dir) {
  const base = dir || path.join(__dirname, "fixtures");
  const recordings = {};
  const samples = [];
  for (const n of fs.readdirSync(base).filter((x) => /\.json$/.test(x)).sort()) {
    const fx = JSON.parse(fs.readFileSync(path.join(base, n), "utf8"));
    if (fx.group === "adversarial" || (fx.request && fx.request.draft)) continue;
    const r = fx.request;
    const instruction = typeof r.instruction === "string" ? r.instruction.trim() : "";
    const key = await prop.replayKey(r.mode, instruction, "", (r.context && r.context.refs) || [], false, "default");
    recordings[key] = expand(fx.recorded);
    samples.push({ id: fx.id, mode: r.mode, instruction });
  }
  return { recordings, samples };
}

// a provider for studio:dev: recorded answers, and a friendly clarify for anything that has no recording
function devReplayProvider(replayProvider, samples) {
  return {
    id: "replay",
    model: replayProvider.model,
    async complete(req) {
      try { return await replayProvider.complete(req); } catch (e) {
        const some = samples.filter((s) => s.mode === req.meta.mode && s.instruction).slice(0, 3).map((s) => "\"" + s.instruction + "\"").join(", ");
        return { toolInputs: [req.meta.mode === "tone_check" ? { kind: "tone", summary: "No recorded answer.", overall: "on_brand", findings: [] } : { kind: "clarify", summary: "Development mode.", question: "This is the development stand-in for the AI, which only knows a few sample requests" + (some ? ", for example " + some : "") + "." }], text: "", usage: { inTok: 0, outTok: 0 }, stopReason: "tool_use", model: replayProvider.model };
      }
    },
  };
}

module.exports = { loadRecordings, devReplayProvider, expand };
