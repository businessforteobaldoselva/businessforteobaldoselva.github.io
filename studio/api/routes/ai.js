"use strict";
// /v1/ai/* routes (AI-DESIGN 6). Thin: the service does the work. Every route needs a signed-in editor or better; none is
// anonymous. "propose" never writes anything; "accept" ends in the same drafts.saveDraft as a hand-made patch.

const { ApiError } = require("../errors");
const { readJson } = require("../http");

function service(ctx) {
  const ai = ctx.deps.ai;
  if (!ai) throw new ApiError("ai_disabled", "AI help is switched off.");
  return ai;
}

const routes = [
  {
    method: "GET", path: "/v1/ai/status", cls: "read", minRole: "editor",
    async run(ctx) { return { status: 200, body: await service(ctx).status(ctx) }; },
  },
  {
    method: "POST", path: "/v1/ai/propose", cls: "ai", minRole: "editor",
    async run(ctx, req) {
      const body = await readJson(req.request, ctx.deps.config.ai.maxBodyBytes);
      return { status: 200, body: await service(ctx).propose(ctx, body) };
    },
  },
  {
    method: "POST", path: "/v1/ai/accept", cls: "write", minRole: "editor",
    async run(ctx, req) {
      const r = await service(ctx).accept(ctx, await readJson(req.request, 200000));
      return { status: r.status, body: r.body };
    },
  },
];

module.exports = { routes };
