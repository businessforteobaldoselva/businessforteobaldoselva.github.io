"use strict";
// The ONLY deny rules of the AI layer (AI-DESIGN 8.1). Everything the AI may never touch, everything it may touch only
// with a visible warning, and every size cap lives here, so a reviewer reads one file. The allow-list itself is DERIVED
// from the generated schema (allowlist.js) with these rules applied; nothing here widens what the Phase 4 validator
// accepts, it only narrows it. Pure, portable.

// widgets whose value a model may write (a list is only changed structurally; image / file / hidden / object never)
const ALLOWED_WIDGETS = new Set(["string", "text", "markdown", "boolean", "color", "select", "number"]);

// schema rules (studio-schema.json x.rule) the AI may not write: pictures, link anchors, page addresses, redirects
const DENIED_RULES = new Set(["image", "anchor", "permalink", "redirect-from", "redirect-to"]);

// field names the AI may not write, wherever they appear
const DENIED_FIELD_NAMES = new Set(["canonicalUrl", "hideFromSearch", "layout", "lastModified", "sitemapPriority", "sitemapChangefreq", "permalink"]);

// data files the AI may not touch at all. redirects: where visitors are sent. tokens and motion: typography, spacing and
// animation settings, which are styling, so "change the font" is answered as a request for a developer (DEVIATION D1).
const DENIED_FILE_STEMS = new Set(["redirects", "tokens", "motion"]);

// "where do visitors go" values: allowed (an editor could change them by hand) but flagged and unticked by default
const SENSITIVE_NAME_RE = /email|mailto|href|link|url|action|endpoint|phone/i;

// meta-description mode only touches these (page "description" only on pages)
const META_NAMES = new Set(["metaDescription", "ogDescription", "socialDescription", "schemaDescription"]);
const META_PAGE_NAMES = new Set(["description"]);

// lists whose items the AI may only re-order (built-in blocks are hidden with their "show" switch, never removed)
const LIST_OPS_OVERRIDE = { "homepage:/sections": ["move"], "pages:/sections": ["move"] };

const PAGES_FILE = "src/pages/*.md";

const MODES = ["edit", "alt_text", "meta_description", "tone_check"];
const BASE_MODES = ["edit", "tone_check"];

const CAPS = {
  instruction: 1000, feedback: 300, refs: 5,
  changes: 40, opsPerChange: 20, ops: 120,
  outputChars: 120000, depth: 8, nodes: 5000,
  summary: 200, title: 80, reason: 300, question: 300, issue: 300, suggestion: 500, quote: 200, requestBody: 1000, where: 80,
  findings: 20, violations: 10, skipped: 40,
  renderedText: 2000, fieldText: 300,
  altImages: 8, imageBytes: 1500000,
};

// value rules (Gate 1)
const MARKUP_RE = /<\/?[a-z!?][^>]*>/i;
const SCHEME_RE = /\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+\s*[;,]/i;
const BAD_CHARS = require("./chars").BAD_CHARS;
const BIDI = require("./chars").BIDI;

module.exports = {
  ALLOWED_WIDGETS, DENIED_RULES, DENIED_FIELD_NAMES, DENIED_FILE_STEMS, SENSITIVE_NAME_RE, META_NAMES, META_PAGE_NAMES,
  LIST_OPS_OVERRIDE, PAGES_FILE, MODES, BASE_MODES, CAPS, MARKUP_RE, SCHEME_RE, BAD_CHARS, BIDI,
};
