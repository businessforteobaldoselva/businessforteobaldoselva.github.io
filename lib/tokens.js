"use strict";
// Design tokens: the single source of truth for every "Type & spacing" setting (src/_data/tokens.json).
//
// Each token is stored as plain numbers (or one word from a short list) and turned into CSS here, with hard
// bounds, so a typo, a string typed into a number field, or an attack string can never reach the stylesheet:
//   - a number outside [min, max] is clamped to the nearest bound;
//   - anything that is not a finite number (string, null, array, NaN ...) falls back to the shipped default;
//   - a select value that is not one of the listed words falls back to the shipped default;
//   - nothing from the data is ever pasted into CSS as text: numbers are re-printed by this file, words are
//     looked up in a fixed table.
// The same table drives the CMS bounds (checked by scripts/check-tokens.js) and the live preview (cms/previews.js
// carries a checked copy), and the shipped defaults equal the values that used to be hard-coded in
// src/_includes/site-styles.css, so with an untouched tokens.json the site renders exactly as before.

const FONT_STACKS = {
  motor: '"Motor", "Oswald", "Arial Narrow", Arial, sans-serif',
  openSauce: '"Open Sauce One", "Helvetica Neue", Helvetica, Arial, sans-serif',
};
const RADIUS_PRESETS = { pill: "999px", rounded: "16px", soft: "10px", square: "0px" };
const WEIGHTS = ["400", "500", "600", "700"];
const weightOptions = () => Object.fromEntries(WEIGHTS.map((w) => [w, w]));

// kind: select | num | clamp | clampvh
//   num     { css, unit, def, min, max, step }                 -> "<n><unit>"
//   clamp   { css, def:{min,fluid,max}, bounds, step }          -> "clamp(<min>rem, <fluid>vw, <max>rem)"
//   clampvh the same with vh                                    -> "clamp(<min>rem, <fluid>vh, <max>rem)"
//   clampfit { def:{min,fluid,vh,max} }                         -> "clamp(<min>rem, min(<fluid>vw, <vh>vh), <max>rem)"
//   select  { css, def, options:{word:css value} }
const TOKENS = [
  // ---- fonts (only fonts that ship in /fonts)
  { key: "fonts.display", kind: "select", css: "--tk-font-display", def: "motor", options: FONT_STACKS },
  { key: "fonts.heading", kind: "select", css: "--tk-font-head", def: "openSauce", options: FONT_STACKS },
  { key: "fonts.body", kind: "select", css: "--tk-font-body", def: "openSauce", options: FONT_STACKS },
  // ---- type sizes
  { key: "text.baseSize", kind: "num", css: "--tk-root-size", unit: "%", def: 100, min: 80, max: 130, step: 1 },
  { key: "text.small", kind: "num", css: "--tk-small", unit: "rem", def: 0.93, min: 0.7, max: 1.2, step: 0.01 },
  { key: "text.lead", kind: "clamp", css: "--tk-lead", def: { min: 1.05, fluid: 2, max: 1.2 }, bounds: { min: [0.8, 2], fluid: [0, 6], max: [0.9, 3] }, step: 0.05 },
  { key: "text.heroLead", kind: "clamp", css: "--tk-hero-lead", def: { min: 1.05, fluid: 2.2, max: 1.25 }, bounds: { min: [0.8, 2], fluid: [0, 6], max: [0.9, 3] }, step: 0.05 },
  { key: "text.heading", kind: "clamp", css: "--tk-heading", def: { min: 1.8, fluid: 4, max: 2.6 }, bounds: { min: [1, 4], fluid: [0, 10], max: [1.2, 6] }, step: 0.05 },
  { key: "text.stat", kind: "clamp", css: "--tk-stat", def: { min: 2.6, fluid: 5, max: 3.4 }, bounds: { min: [1.2, 5], fluid: [0, 10], max: [1.5, 7] }, step: 0.05 },
  { key: "text.quote", kind: "clamp", css: "--tk-quote", def: { min: 1.5, fluid: 2.9, max: 2.5 }, bounds: { min: [1, 4], fluid: [0, 8], max: [1.2, 5] }, step: 0.05 },
  // largeText: this text sits on the accent colour (dark ink on orange, 3.4:1), which passes WCAG only as LARGE text
  // (24px or more). The smallest size is bounded so that, even with the page text at its smallest (80%), it stays
  // large: 1.9rem x 16px x 0.8 = 24.3px. scripts/check-tokens.js checks the arithmetic, scripts/check-a11y.js the result.
  { key: "text.title", kind: "clamp", css: "--tk-title", def: { min: 2.5, fluid: 5.5, max: 4.2 }, bounds: { min: [1.9, 6], fluid: [0, 12], max: [1.9, 9] }, step: 0.05, largeText: true },
  { key: "text.heroPin", kind: "clampfit", css: "--tk-hero-pin", def: { min: 2.6, fluid: 7.2, vh: 10.5, max: 5.6 }, bounds: { min: [1.5, 5], fluid: [0, 14], vh: [0, 20], max: [2, 9] }, step: 0.1 },
  { key: "text.display", kind: "clamp", css: "--tk-display", def: { min: 3.2, fluid: 8.5, max: 6.5 }, bounds: { min: [1.5, 8], fluid: [0, 16], max: [2, 12] }, step: 0.05 },
  // ---- line height, letter spacing, weight
  { key: "lines.body", kind: "num", css: "--tk-lh-body", unit: "", def: 1.6, min: 1.2, max: 2.2, step: 0.05 },
  { key: "lines.heading", kind: "num", css: "--tk-lh-heading", unit: "", def: 1.1, min: 0.9, max: 1.6, step: 0.05 },
  { key: "lines.title", kind: "num", css: "--tk-lh-title", unit: "", def: 1.04, min: 0.8, max: 1.5, step: 0.01 },
  { key: "lines.display", kind: "num", css: "--tk-lh-display", unit: "", def: 1.05, min: 0.8, max: 1.4, step: 0.01 },
  { key: "tracking.heading", kind: "num", css: "--tk-ls-heading", unit: "em", def: -0.02, min: -0.06, max: 0.1, step: 0.005 },
  { key: "tracking.title", kind: "num", css: "--tk-ls-title", unit: "em", def: 0.015, min: -0.06, max: 0.1, step: 0.005 },
  { key: "tracking.display", kind: "num", css: "--tk-ls-display", unit: "em", def: 0.01, min: -0.08, max: 0.1, step: 0.005 },
  { key: "tracking.kicker", kind: "num", css: "--tk-ls-kicker", unit: "em", def: 0.16, min: 0, max: 0.4, step: 0.01 },
  { key: "weights.display", kind: "select", css: "--tk-fw-display", def: "600", options: weightOptions() },
  { key: "weights.title", kind: "select", css: "--tk-fw-title", def: "600", options: weightOptions() },
  { key: "weights.label", kind: "select", css: "--tk-fw-label", def: "700", options: weightOptions() },
  { key: "weights.button", kind: "select", css: "--tk-fw-button", def: "600", options: weightOptions() },
  // ---- spacing
  { key: "space.section", kind: "clampvh", css: "--tk-section-pad", def: { min: 6, fluid: 12, max: 10 }, bounds: { min: [2, 12], fluid: [0, 30], max: [3, 18] }, step: 0.5 },
  { key: "space.containerMax", kind: "num", css: "--tk-container-max", unit: "px", def: 1120, min: 800, max: 1600, step: 10 },
  { key: "space.containerWidth", kind: "num", css: "--tk-container-width", unit: "%", def: 92, min: 80, max: 100, step: 1 },
  { key: "space.cardGap", kind: "num", css: "--tk-card-gap", unit: "rem", def: 1.2, min: 0.5, max: 3, step: 0.05 },
  // ---- shape
  { key: "shape.radiusCard", kind: "num", css: "--tk-radius-card", unit: "px", def: 20, min: 0, max: 40, step: 1 },
  { key: "shape.radiusButton", kind: "select", css: "--tk-radius-button", def: "pill", options: RADIUS_PRESETS },
  { key: "shape.radiusPill", kind: "select", css: "--tk-radius-pill", def: "pill", options: RADIUS_PRESETS },
  // shadow strength is not a CSS variable of its own: theme-vars.njk builds --shadow from the ink colour and this alpha
  { key: "shape.shadow", kind: "num", css: null, unit: "", def: 0.12, min: 0, max: 0.4, step: 0.01 },
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const getAt = (obj, key) => key.split(".").reduce((o, k) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round3 = (n) => Math.round(n * 1000) / 1000;
const fmt = (n) => String(round3(n) + 0); // + 0 turns -0 into 0
const clampNum = (v, lo, hi, dflt) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : dflt);

// The number (or word, or {min,fluid,max}) a token ends up with after validation. `tokens` may be anything.
function value(tokens, key) {
  const t = TOKENS.find((x) => x.key === key);
  if (!t) throw new Error("unknown token " + key);
  const raw = getAt(tokens, key);
  if (t.kind === "select") return typeof raw === "string" && Object.prototype.hasOwnProperty.call(t.options, raw) ? raw : t.def;
  if (t.kind === "num") return round3(clampNum(raw, t.min, t.max, t.def));
  const r = isObj(raw) ? raw : {};
  const out = {};
  for (const p of Object.keys(t.bounds)) {
    const v = Object.prototype.hasOwnProperty.call(r, p) ? r[p] : undefined;
    out[p] = round3(clampNum(v, t.bounds[p][0], t.bounds[p][1], t.def[p]));
  }
  out.max = Math.max(out.min, out.max); // the largest size can never be below the smallest
  return out;
}

function render(t, v) {
  if (t.kind === "select") return t.options[v];
  if (t.kind === "num") return fmt(v) + t.unit;
  if (t.kind === "clampfit") return "clamp(" + fmt(v.min) + "rem, min(" + fmt(v.fluid) + "vw, " + fmt(v.vh) + "vh), " + fmt(v.max) + "rem)";
  return "clamp(" + fmt(v.min) + "rem, " + fmt(v.fluid) + (t.kind === "clampvh" ? "vh" : "vw") + ", " + fmt(v.max) + "rem)";
}

// [[css-name, css-value], ...] for the validated tokens.
function cssVars(tokens) {
  return TOKENS.filter((t) => t.css).map((t) => [t.css, render(t, value(tokens, t.key))]);
}

// Declarations printed into the stylesheet (one per line).
function declarations(tokens, indent) {
  return cssVars(tokens).map(([n, v]) => (indent || "") + n + ": " + v + ";").join("\n");
}

// What each CMS field of the "Type & spacing" entry must declare (field path -> {min, max, step} | {options}).
function fieldSpecs() {
  const out = {};
  for (const t of TOKENS) {
    if (t.kind === "num") out[t.key] = { min: t.min, max: t.max, step: t.step };
    else if (t.bounds) {
      for (const p of Object.keys(t.bounds)) out[t.key + "." + p] = { min: t.bounds[p][0], max: t.bounds[p][1], step: t.step };
    } else out[t.key] = { options: Object.keys(t.options) };
  }
  return out;
}

// The shipped values, shaped like src/_data/tokens.json.
function shippedData() {
  const out = {};
  for (const t of TOKENS) {
    const [a, b] = t.key.split(".");
    out[a] = out[a] || {};
    out[a][b] = t.bounds ? Object.assign({}, t.def) : t.def;
  }
  return out;
}

module.exports = { TOKENS, FONT_STACKS, RADIUS_PRESETS, WEIGHTS, value, render, cssVars, declarations, fieldSpecs, shippedData, getAt };
