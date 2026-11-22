"use strict";
// GET /v1/health (BACKEND unit, PHASE1-DESIGN 4.1): anonymous, rate-limited by IP, never needs a token and never audits (it is polled).

const { forDeps } = require("../services/health");

const routes = [
  {
    method: "GET", path: "/v1/health", anon: true, cls: "anon",
    async run(ctx) { return { status: 200, body: await forDeps(ctx.deps).check() }; },
  },
];

module.exports = { routes };
