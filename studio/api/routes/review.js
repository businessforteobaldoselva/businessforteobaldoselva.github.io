"use strict";
// GET /v1/drafts/:id/review and GET /v1/people/approvers (studio/PHASE1-DESIGN.md sections 6 and 7.1). Read only.

const review = require("../services/review");

const routes = [
  {
    method: "GET", path: "/v1/drafts/:id/review", cls: "read",
    async run(ctx, req) { return { status: 200, body: await review.reviewDraft(ctx, req.params.id) }; },
  },
  {
    method: "GET", path: "/v1/people/approvers", cls: "read",
    async run(ctx) { return { status: 200, body: review.approvers(ctx) }; },
  },
];

module.exports = { routes };
