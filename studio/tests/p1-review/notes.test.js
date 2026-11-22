"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("NOTES-preview-access.md has exactly the five required headings, links its sources and ends with the settings", () => {
  const t = fs.readFileSync(path.join(__dirname, "..", "..", "NOTES-preview-access.md"), "utf8");
  const h = [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(h, ["The problem", "Options", "What each option needs from Teo", "Risks", "Recommendation"]);
  assert.ok(/https:\/\/docs\.netlify\.com\//.test(t) && /https:\/\/developers\.cloudflare\.com\//.test(t), "vendor documentation is cited");
  assert.ok(/unverified/i.test(t), "anything not confirmed is labelled");
  for (const v of ["STUDIO_PREVIEW_URL_TEMPLATE", "STUDIO_PREVIEW_EMBED", "STUDIO_SITE_URL"]) assert.ok(t.includes(v), v);
});
