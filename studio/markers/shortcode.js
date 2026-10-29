"use strict";
// {% cms "<ref>", "<kind>" %} / {% cms "<ref>", "<kind>", { alt: "<ref>", ... } %}  (DESIGN.md section 2.2)
// Returns "" unless the build is an edit build (CMS_EDIT=1). Fails closed: any invalid argument gives "" and is
// recorded in `problems` so studio/guards/check-markers.js (and the build log) can report it.

const { parseRef } = require("./grammar");

const KINDS = new Set(["text", "longtext", "markdown", "image", "link", "color", "toggle", "section", "item"]);
// opts key -> attribute name
const OPTS = { alt: "data-cms-alt", decorative: "data-cms-decorative", href: "data-cms-href", hide: "data-cms-hide", cssvar: "data-cms-cssvar" };
const ORDER = ["alt", "decorative", "href", "hide", "cssvar"];
const CSSVAR_RE = /^--[a-z0-9-]+$/;

const problems = [];

function isEditBuild(env) {
  return (env || process.env).CMS_EDIT === "1";
}

// -> { html: ' data-cms="..." ...', problem: null } or { html: "", problem: "..." }
function render(ref, kind, opts) {
  if (!parseRef(ref)) return { html: "", problem: "invalid ref " + JSON.stringify(ref) };
  if (!KINDS.has(kind)) return { html: "", problem: "invalid kind " + JSON.stringify(kind) + " for " + ref };
  let out = ' data-cms="' + ref + '" data-cms-kind="' + kind + '"';
  if (opts !== undefined && opts !== null) {
    if (typeof opts !== "object" || Array.isArray(opts)) return { html: "", problem: "opts must be an object for " + ref };
    for (const k of Object.keys(opts)) if (!Object.prototype.hasOwnProperty.call(OPTS, k)) return { html: "", problem: "unknown opts key " + JSON.stringify(k) + " for " + ref };
    for (const k of ORDER) {
      if (!(k in opts)) continue;
      const v = opts[k];
      if (v === undefined || v === null || v === "") continue; // an unset template variable simply means "no such field"
      if (k === "cssvar") {
        if (typeof v !== "string" || !CSSVAR_RE.test(v)) return { html: "", problem: "invalid cssvar " + JSON.stringify(v) + " for " + ref };
      } else if (!parseRef(v)) return { html: "", problem: "invalid " + k + " ref " + JSON.stringify(v) + " for " + ref };
      out += " " + OPTS[k] + '="' + v + '"';
    }
  }
  return { html: out, problem: null };
}

// The function registered with Eleventy. `env` is injectable for tests.
function cms(ref, kind, opts, env) {
  if (!isEditBuild(env)) return "";
  const r = render(ref, kind, opts);
  if (r.problem) {
    problems.push(r.problem);
    console.warn("[studio] marker refused: " + r.problem);
  }
  return r.html;
}

module.exports = { cms, render, isEditBuild, problems, KINDS, OPTS };
