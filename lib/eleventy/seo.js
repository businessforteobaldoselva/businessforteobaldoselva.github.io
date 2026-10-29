// SEO helpers: per-page search / social presentation, sitemap values and the redirects file are all
// data (see cms/config.yml). Everything an editor can type passes through one of these before it
// reaches a page, the sitemap or the _redirects file; anything invalid falls back to a safe default
// (or, for redirect rules, the rule is dropped) - it never breaks the build and never emits markup.
const SITE = "https://coveredaccess.com";
const SITE_HOSTS = new Set(["coveredaccess.com", "www.coveredaccess.com"]);

// ---------------------------------------------------------------- canonical address
// Same-site path ("/about/") or an https address on the site's own domain. Anything else (another
// site, http, javascript:, spaces, quotes, ...) falls back, so a stolen editor session cannot point
// search engines at someone else's page.
const CANON_PATH = /^\/(?!\/)[A-Za-z0-9._~\/%+-]*$/;
const CANON_ABS = /^https:\/\/([A-Za-z0-9.-]+)(\/[A-Za-z0-9._~\/%+-]*)?$/;
function seoCanonical(value, fallback) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || v.length > 300 || /(^|\/)\.\.(\/|$)/.test(v)) return fallback;
  if (CANON_PATH.test(v)) return SITE + v;
  const m = CANON_ABS.exec(v);
  if (m && SITE_HOSTS.has(m[1].toLowerCase())) return SITE + (m[2] || "/");
  return fallback;
}

// ---------------------------------------------------------------- sitemap values
function seoDate(value, fallback) {
  const v = typeof value === "string" ? value.trim() : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]) return v;
  }
  return fallback;
}
function seoPriority(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d(\.\d)?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n.toFixed(1) : "";
}
const CHANGEFREQ = ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"];
function seoChangefreq(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CHANGEFREQ.includes(v) ? v : "";
}

// ---------------------------------------------------------------- redirects
// The rules themselves live in cms/redirect-rules.js, one file shared with the CMS preview, so the editor
// sees exactly what the build will do (and why). See there for the allowed shapes and the approved websites.
const R = require("../../cms/redirect-rules.js");
const { RESERVED_FROM } = R;

// -> { lines: ["/old /new 301", ...], dropped: [{ index, reason }], ineffective: [{ index, reason }] }
const analyseRedirects = (items, opts) => R.analyse(items, opts);

module.exports = function (eleventyConfig) {
  eleventyConfig.addFilter("seoCanonical", seoCanonical);
  eleventyConfig.addFilter("seoDate", seoDate);
  eleventyConfig.addFilter("seoPriority", seoPriority);
  eleventyConfig.addFilter("seoChangefreq", seoChangefreq);
  // redirectRules(allPages): the optional argument is collections.all, used to say which rules never fire
  eleventyConfig.addFilter("redirectRules", (items, allPages) => {
    const pages = {};
    for (const p of Array.isArray(allPages) ? allPages : []) if (p && typeof p.url === "string") pages[R.norm(p.url)] = true;
    const r = analyseRedirects(items, Array.isArray(allPages) ? { pages } : undefined);
    r.dropped.forEach((d) => console.warn("[redirects] rule " + (d.index + 1) + " left out: " + d.reason));
    r.ineffective.forEach((d) => console.warn("[redirects] rule " + (d.index + 1) + " never fires: " + d.reason));
    return r.lines;
  });
};
Object.assign(module.exports, { seoCanonical, seoDate, seoPriority, seoChangefreq, analyseRedirects, SITE, RESERVED_FROM });
