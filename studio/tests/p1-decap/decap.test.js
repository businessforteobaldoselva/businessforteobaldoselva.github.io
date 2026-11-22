"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test(".eleventy.js publishes only cms/moved.html, as /cms/index.html", () => {
  const src = read(".eleventy.js");
  assert.ok(src.includes('addPassthroughCopy({ "cms/moved.html": "cms/index.html" })'));
  assert.ok(!/addPassthroughCopy\(\s*"cms"\s*\)/.test(src), "the whole cms folder must not be copied");
  for (const f of ["config.yml", "contrast.js", "previews.js", "redirect-rules.js"]) assert.ok(!src.includes('"cms/' + f + '"'), f + " must not be published");
});

test("netlify.toml sends old /cms/ deep links to the moved page and holds no Identity wiring", () => {
  const toml = read("netlify.toml");
  assert.match(toml, /\[\[redirects\]\]\s*\n\s*from = "\/cms\/\*"\s*\n\s*to = "\/cms\/"\s*\n\s*status = 302/);
  assert.doesNotMatch(toml, /identity|gateway/i);
});

test("the home page template has no Netlify Identity forwarder", () => {
  const njk = read("src/index.njk");
  assert.doesNotMatch(njk, /invite_token|recovery_token|netlify/i);
});

test("the moved page is static, in plain English and tells people what to do", () => {
  const html = read("cms/moved.html");
  assert.match(html, /<html lang="en-GB">/);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  assert.match(html, /\?studio=1/);
  assert.doesNotMatch(html, /<script/i);
});

test("config.yml keeps the schema parts and loses every Decap-only key", () => {
  const cfg = read("cms/config.yml");
  assert.match(cfg, /^media_folder: "images"/m);
  assert.match(cfg, /^public_folder: "\/images"/m);
  assert.doesNotMatch(cfg, /^(backend|publish_mode|local_backend|site_url|display_url|logo_url|locale)\s*:/m);
  assert.doesNotMatch(cfg, /^\s+(preview_path|editor|summary)\s*:/m);
});

test("studio-schema.json is exactly what the stripped config generates", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "studio", "schema", "build-schema.js"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
