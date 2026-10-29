"use strict";
// The code-level rules shared by the Eleventy filters (.eleventy.js) and the Studio API validator.
// One definition, two users: a value the site would neutralise is a value Studio refuses to save.
// Pure functions, no fs / path / process, so it runs in Node, Netlify Functions and Cloudflare Workers.

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// The standard "link" field pattern of cms/config.yml (same-site path, in-page anchor, http(s) or mailto).
const LINK_PATTERN_SOURCE = "^(/(?!/)\S*|#\S+|https?://\S+|mailto:\S+)$";

// Guards CMS-supplied colours: only a well-formed hex colour is emitted, anything else gives `fallback`.
function safeColor(value, fallback) {
  const v = typeof value === "string" ? value.trim() : "";
  return HEX_COLOR_RE.test(v) ? v : fallback;
}

// Guards CMS-supplied link fields: only same-site paths (/...), in-page anchors (#...) and http(s)/mailto URLs
// are emitted. Anything else (javascript:, data:, protocol-relative //...) falls back to "/".
function safeUrl(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return "/";
  if (/^\/(?!\/)/.test(v) || v.startsWith("#")) return v;
  if (/^(https?|mailto):/i.test(v)) return v;
  return "/";
}

// Custom-block anchors: the slug grammar plus "not a built-in id". `reserved` is anything with has(id)
// (lib/reserved-ids.js result) or a Set of lower-case ids. Returns "" for a rejected anchor.
function safeAnchor(value, reserved) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9-]+$/.test(v)) return "";
  if (reserved && typeof reserved.has === "function" && reserved.has(v)) return "";
  return v;
}

module.exports = { HEX_COLOR_RE, LINK_PATTERN_SOURCE, safeColor, safeUrl, safeAnchor };
