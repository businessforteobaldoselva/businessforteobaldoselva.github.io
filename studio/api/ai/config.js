"use strict";
// AI settings (AI-DESIGN 3). loadAiConfig(env) is PURE: plain numbers, strings and booleans, never the API key (the key
// is read once in buildDeps from the environment variable that holds it and handed straight to the provider).
// Numbers are clamped, malformed values are refused at start-up. Portable.

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/|$)/;

function fail(msg) {
  const { ConfigError } = require("../config"); // lazy: config.js requires this file
  return new ConfigError(msg);
}

function num(env, name, def, lo, hi) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const s = String(raw).trim();
  if (!/^[0-9]{1,9}$/.test(s)) throw fail(name + " must be a whole number");
  return Math.max(lo, Math.min(hi, Number(s)));
}

function loadAiConfig(env) {
  const e = env || {};
  const enabled = e.STUDIO_AI_ENABLED === "1" || e.STUDIO_AI_ENABLED === "true";
  const provider = e.STUDIO_AI_PROVIDER === undefined || e.STUDIO_AI_PROVIDER === "" ? "anthropic" : String(e.STUDIO_AI_PROVIDER);
  if (provider !== "anthropic" && provider !== "replay") throw fail("STUDIO_AI_PROVIDER must be anthropic or replay");
  if (provider === "replay" && !(e.STUDIO_DEV === "1" && (e.STUDIO_ENV || "production") !== "production")) throw fail("STUDIO_AI_PROVIDER=replay is only allowed with STUDIO_DEV=1 on a development machine");
  const model = e.STUDIO_AI_MODEL === undefined || e.STUDIO_AI_MODEL === "" ? "claude-sonnet-5-5" : String(e.STUDIO_AI_MODEL);
  if (!MODEL_RE.test(model)) throw fail("STUDIO_AI_MODEL is not a valid model id");
  let ask = "";
  if (e.STUDIO_ASK_CLAUDE_URL) {
    ask = String(e.STUDIO_ASK_CLAUDE_URL);
    if (!/^https:\/\/[^\s]+$/.test(ask) && !LOCAL_URL.test(ask)) throw fail("STUDIO_ASK_CLAUDE_URL must be an https address");
  }
  return {
    enabled,
    provider,
    model,
    maxOutputTokens: num(e, "STUDIO_AI_MAX_OUTPUT_TOKENS", 6000, 512, 16000),
    maxInputChars: num(e, "STUDIO_AI_MAX_INPUT_CHARS", 120000, 5000, 400000),
    timeoutMs: num(e, "STUDIO_AI_TIMEOUT_MS", 25000, 3000, 60000),
    vision: !(e.STUDIO_AI_VISION === "0" || e.STUDIO_AI_VISION === "false"),
    userPer10Min: num(e, "STUDIO_AI_USER_PER_10MIN", 8, 1, 1000),
    userPerDay: num(e, "STUDIO_AI_USER_PER_DAY", 60, 1, 10000),
    globalPerHour: num(e, "STUDIO_AI_GLOBAL_PER_HOUR", 100, 1, 100000),
    dailyRequests: num(e, "STUDIO_AI_DAILY_REQUESTS", 150, 1, 1000000),
    dailyTokens: num(e, "STUDIO_AI_DAILY_TOKENS", 400000, 1000, 1000000000),
    maxBodyBytes: num(e, "STUDIO_AI_MAX_BODY_BYTES", 16000, 2000, 200000),
    askClaudeUrl: ask,
  };
}

module.exports = { loadAiConfig, MODEL_RE };
