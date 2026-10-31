"use strict";
// Exact-origin CORS (DESIGN 7.2). Never "*", never credentials. Portable.

const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const HTTPS_RE = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

// "http://localhost:8080" / "https://app.example.com": scheme + host (+port), no path, no wildcard, http only for localhost
function isValidOrigin(o) {
  return typeof o === "string" && o.length <= 200 && o.indexOf("*") < 0 && (HTTPS_RE.test(o) || LOCAL_RE.test(o));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// "https://deploy-preview-{n}--coveredaccess.netlify.app" -> anchored regexp where {n} is 1-6 digits, the rest literal
function templateToRegExp(tpl) {
  if (typeof tpl !== "string" || (tpl.match(/\{n\}/g) || []).length !== 1) throw new Error("STUDIO_PREVIEW_ORIGIN_TEMPLATE needs exactly one {n}");
  const parts = tpl.split("{n}");
  if (!isValidOrigin(parts[0] + "1" + parts[1]) || parts[0].indexOf("https://") !== 0) throw new Error("STUDIO_PREVIEW_ORIGIN_TEMPLATE must be an https origin with {n}");
  return new RegExp("^" + escapeRe(parts[0]) + "[0-9]{1,6}" + escapeRe(parts[1]) + "$");
}

function createCors({ allowedOrigins, previewTemplate }) {
  const exact = new Set(allowedOrigins || []);
  for (const o of exact) if (!isValidOrigin(o)) throw new Error("invalid allowed origin: " + o);
  const re = previewTemplate ? templateToRegExp(previewTemplate) : null;
  const previewPrefixLen = previewTemplate ? previewTemplate.split("{n}")[0].length : 0;
  const allowed = (origin) => typeof origin === "string" && (exact.has(origin) || (re !== null && re.test(origin)));
  // the pull request number in a preview address that matches the template (null for exact origins and strangers)
  const previewNumber = (origin) => {
    if (typeof origin !== "string" || exact.has(origin) || re === null || !re.test(origin)) return null;
    const m = /[0-9]{1,6}/.exec(origin.slice(previewPrefixLen));
    return m ? Number(m[0]) : null;
  };
  return {
    allowed,
    previewNumber,
    headers(origin) {
      if (!allowed(origin)) return {};
      return {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        // without this a browser hides Retry-After from the page, and the wait it shows would be a guess
        "Access-Control-Expose-Headers": "Retry-After",
        "Access-Control-Max-Age": "600",
      };
    },
  };
}

module.exports = { createCors, isValidOrigin, templateToRegExp };
