"use strict";
// Anthropic Messages API client, written to the public documentation, no SDK (AI-DESIGN 7.2).
//   POST https://api.anthropic.com/v1/messages  with x-api-key, anthropic-version, one forced tool call.
// The API key arrives as a PARAMETER and lives only in this closure: it is never put in a config object, a log line, an
// error or a response. There is no console call in this file and no setting for the address (a mistyped address would
// send the key somewhere else), the host is the constant below. `fetchFn` is injected, so tests never touch the network.
// Retries: at most 3 attempts inside the caller's total deadline, only for network errors and 408/429/5xx; never for
// 400/401/403/404/413/422. Errors are reduced to { code, status, type } and carry no body text. Portable.

const { ProviderError } = require("./interface");

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const BACKOFF_MS = [400, 1200];
const MAX_ATTEMPTS = 3;

function buildBody(model, req) {
  const content = [{ type: "text", text: req.user }];
  for (const im of req.images || []) content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.dataBase64 } });
  return {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content }],
    tools: [{ name: req.tool.name, description: req.tool.description, input_schema: req.tool.inputSchema }],
    tool_choice: { type: "tool", name: req.tool.name },
  };
}

const intOf = (n) => (Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 100000000) : 0);

function toResult(json, fallbackModel) {
  if (!json || typeof json !== "object" || !Array.isArray(json.content)) throw new ProviderError("bad_response");
  const toolInputs = [];
  let text = "";
  for (const b of json.content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_use" && b.input && typeof b.input === "object") toolInputs.push(b.input);
    else if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  const sr = json.stop_reason;
  return {
    toolInputs,
    text: text.slice(0, 2000),
    usage: { inTok: intOf(json.usage && json.usage.input_tokens), outTok: intOf(json.usage && json.usage.output_tokens) },
    stopReason: sr === "tool_use" || sr === "end_turn" || sr === "max_tokens" ? sr : "other",
    model: typeof json.model === "string" ? json.model.slice(0, 80) : fallbackModel,
  };
}

// opts = { apiKey, model, fetchFn, now?: () => ms, sleep?: (ms) => Promise, random?: () => number }
function createAnthropicProvider(opts) {
  const o = opts || {};
  const apiKey = o.apiKey;
  const model = o.model;
  const doFetch = o.fetchFn;
  if (typeof apiKey !== "string" || !apiKey) throw new TypeError("an API key is required");
  if (typeof doFetch !== "function") throw new TypeError("fetchFn is required");
  const now = o.now || (() => Date.now());
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = o.random || Math.random;

  async function attempt(req, remaining) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, remaining));
    try {
      const res = await doFetch(ENDPOINT, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": VERSION, "content-type": "application/json" },
        body: JSON.stringify(buildBody(model, req)),
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        let json;
        try { json = await res.json(); } catch (e) { throw new ProviderError(controller.signal.aborted ? "timeout" : "bad_response"); }
        return { ok: true, json };
      }
      let type;
      try { const j = await res.json(); type = j && j.error && typeof j.error.type === "string" && /^[a-z_]{1,40}$/.test(j.error.type) ? j.error.type : undefined; } catch (e) { type = undefined; }
      return { ok: false, status: res.status, type, retryAfter: Number(res.headers && res.headers.get && res.headers.get("retry-after")) };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      return { ok: false, network: true, aborted: controller.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: "anthropic",
    model,
    async complete(req) {
      let last = null;
      for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
        const remaining = req.deadlineAtMs - now();
        if (remaining <= 0) throw new ProviderError("timeout");
        const r = await attempt(req, remaining);
        if (r.ok) return toResult(r.json, model);
        last = r;
        if (r.network && r.aborted) throw new ProviderError("timeout");
        const retriable = r.network || RETRY_STATUS.has(r.status);
        if (!retriable || n === MAX_ATTEMPTS - 1) break;
        let delay = BACKOFF_MS[n] * (0.75 + random() * 0.5);
        if (Number.isFinite(r.retryAfter) && r.retryAfter > 0) delay = Math.min(r.retryAfter, 3) * 1000;
        if (now() + delay >= req.deadlineAtMs) break;
        await sleep(delay);
      }
      if (last && last.network) throw new ProviderError(last.aborted ? "timeout" : "unavailable");
      const s = last && last.status;
      if (s === 401 || s === 403) throw new ProviderError("auth", s, last.type);
      if (s === 429) throw new ProviderError("rate", s, last.type);
      throw new ProviderError("unavailable", s, last && last.type);
    },
  };
}

module.exports = { createAnthropicProvider, ENDPOINT, buildBody };
