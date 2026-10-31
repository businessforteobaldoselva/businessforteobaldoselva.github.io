"use strict";
// The model provider interface (AI-DESIGN 7.1). The AI layer talks to a model only through this shape, so the real
// Anthropic client, the deterministic replay provider and the "off" provider are interchangeable.
//
//   Provider = { id: "anthropic"|"replay"|"disabled", model: string, complete(req: ProviderRequest): Promise<ProviderResult> }
//   ProviderRequest = { system, user, images?: [{ mediaType, dataBase64 }], tool: { name, description, inputSchema },
//                       maxTokens, deadlineAtMs, meta: { replayKey, mode } }
//   ProviderResult  = { toolInputs: object[], text: string, usage: { inTok, outTok }, stopReason, model }
//   complete() throws ProviderError { code: "timeout"|"unavailable"|"auth"|"rate"|"bad_response"|"disabled", status?, type? }
//   A ProviderError never carries a body, a header or the key.
// Portable.

class ProviderError extends Error {
  constructor(code, status, type) {
    super("model provider error: " + code + (status ? " (" + status + ")" : ""));
    this.name = "ProviderError";
    this.code = code;
    if (status) this.status = status;
    if (type) this.type = String(type).replace(/[^a-z_]/g, "").slice(0, 40);
  }
}

const IDS = ["anthropic", "replay", "disabled"];

function assertProvider(p) {
  if (!p || typeof p !== "object") throw new TypeError("a provider is required");
  if (IDS.indexOf(p.id) < 0) throw new TypeError("provider.id must be one of " + IDS.join(", "));
  if (typeof p.model !== "string") throw new TypeError("provider.model must be a string");
  if (typeof p.complete !== "function") throw new TypeError("provider.complete must be a function");
  return p;
}

module.exports = { ProviderError, assertProvider, IDS };
