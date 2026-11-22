"use strict";
// GET /v1/board (studio/PHASE1-DESIGN.md section 5). Read only.

const { board } = require("../services/board");

const routes = [
  {
    method: "GET", path: "/v1/board", cls: "read",
    async run(ctx) { return { status: 200, body: await board(ctx) }; },
  },
];

module.exports = { routes };
