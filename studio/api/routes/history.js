"use strict";
// GET /v1/history and POST /v1/history/:pr/restore

const { ApiError } = require("../errors");
const history = require("../services/history");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const routes = [
  {
    method: "GET", path: "/v1/history", cls: "read",
    async run(ctx, req) {
      const limit = req.query.get("limit");
      if (limit !== null && !/^[0-9]{1,3}$/.test(limit)) throw new ApiError("bad_request", "limit must be a number.");
      const cursor = req.query.get("cursor");
      if (cursor !== null && !/^[A-Za-z0-9_=:.-]{1,200}$/.test(cursor)) throw new ApiError("bad_request", "cursor is not valid.");
      return { status: 200, body: await history.listHistory(ctx, { limit, cursor }) };
    },
  },
  {
    method: "POST", path: "/v1/history/:pr/restore", cls: "restore",
    async run(ctx, req) {
      if (!/^[0-9]{1,9}$/.test(req.params.pr)) throw new ApiError("bad_request", "The change number is not valid.");
      const b = await req.json();
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError("bad_request", "The request must be a JSON object.");
      for (const k of Object.keys(b)) if (["onConflict", "idempotencyKey"].indexOf(k) < 0) throw new ApiError("bad_request", "Unknown field " + JSON.stringify(k.slice(0, 30)) + ".");
      if (!UUID_RE.test(String(b.idempotencyKey))) throw new ApiError("bad_request", "idempotencyKey must be a UUID v4.");
      const r = await history.restore(ctx, Number(req.params.pr), { onConflict: b.onConflict, idempotencyKey: b.idempotencyKey });
      return { status: r.replayed ? 200 : 201, body: { draft: r.draft, changes: r.changes, skipped: r.skipped } };
    },
  },
];

module.exports = { routes };
