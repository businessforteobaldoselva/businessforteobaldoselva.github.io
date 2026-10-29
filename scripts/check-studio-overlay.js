#!/usr/bin/env node
"use strict";
// check:studio-overlay - the static rules for the Studio overlay (no innerHTML / eval / external URLs, size budget,
// contrast and accessibility of the overlay's own chrome). The rules live in studio/guards/check-overlay.js, which
// `npm run check:studio` (and so `npm run check`) already runs; this file is a convenient direct entry point:
//   node scripts/check-studio-overlay.js [--root <repo>]
const path = require("path");
const { spawnSync } = require("child_process");

const guard = path.resolve(__dirname, "..", "studio", "guards", "check-overlay.js");
const r = spawnSync(process.execPath, [guard].concat(process.argv.slice(2)), { stdio: "inherit" });
process.exit(r.status === null ? 2 : r.status);
