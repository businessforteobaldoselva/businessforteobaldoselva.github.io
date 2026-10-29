"use strict";
// /v1/drafts routes (DESIGN 7.4). Thin: parse, call the service, shape the response.

const { ApiError } = require("../errors");
const svc = require("../services/drafts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bodyObject(b, allowed) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError("bad_request", "The request must be a JSON object.");
  for (const k of Object.keys(b)) if (allowed.indexOf(k) < 0) throw new ApiError("bad_request", "Unknown field " + JSON.stringify(k.slice(0, 30)) + ".");
  if (!UUID_RE.test(String(b.idempotencyKey))) throw new ApiError("bad_request", "idempotencyKey must be a UUID v4.");
  return b;
}

const routes = [
  {
    method: "GET", path: "/v1/drafts", cls: "read",
    async run(ctx, req) {
      const scope = req.query.get("scope") || "mine";
      const state = req.query.get("state") || "open";
      if (scope !== "mine" && scope !== "all") throw new ApiError("bad_request", "scope must be mine or all.");
      if (state !== "open" && state !== "all") throw new ApiError("bad_request", "state must be open or all.");
      return { status: 200, body: await svc.listDrafts(ctx, { scope, state }) };
    },
  },
  {
    method: "GET", path: "/v1/drafts/:id", cls: "read",
    async run(ctx, req) { return { status: 200, body: await svc.getDraft(ctx, req.params.id) }; },
  },
  {
    method: "POST", path: "/v1/drafts", cls: "write",
    async run(ctx, req) {
      const patch = await req.json();
      const r = await svc.saveDraft(ctx, patch);
      if (r.noop) return { status: 200, body: { noop: true, draft: r.draft, changes: [], replayed: false, warnings: r.warnings } };
      return { status: r.replayed || patch.draftId ? 200 : 201, body: { draft: r.draft, changes: r.changes, replayed: r.replayed, warnings: r.warnings } };
    },
  },
  {
    method: "POST", path: "/v1/drafts/:id/submit", cls: "write",
    async run(ctx, req) { bodyObject(await req.json(), ["idempotencyKey"]); return { status: 200, body: await svc.submitDraft(ctx, req.params.id) }; },
  },
  {
    method: "POST", path: "/v1/drafts/:id/publish", cls: "publish", minRole: "approver",
    async run(ctx, req) {
      const b = bodyObject(await req.json(), ["idempotencyKey", "expectedHeadSha"]);
      return { status: 200, body: await svc.publishDraft(ctx, req.params.id, { expectedHeadSha: b.expectedHeadSha }) };
    },
  },
  {
    method: "POST", path: "/v1/drafts/:id/rebase", cls: "write",
    async run(ctx, req) {
      const b = bodyObject(await req.json(), ["idempotencyKey", "expectedHeadSha"]);
      return { status: 200, body: await svc.rebaseDraft(ctx, req.params.id, { expectedHeadSha: b.expectedHeadSha, idempotencyKey: b.idempotencyKey }) };
    },
  },
  {
    method: "DELETE", path: "/v1/drafts/:id", cls: "write",
    async run(ctx, req) { return { status: 200, body: await svc.discardDraft(ctx, req.params.id) }; },
  },
];

module.exports = { routes, bodyObject };
