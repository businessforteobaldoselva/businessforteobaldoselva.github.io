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
// One rule per line of the Netlify _redirects file:   /old-address  /new-address  301
// Only plain paths and https addresses; no wildcards, no :placeholders, no query on the old address,
// no status other than 301 / 302 (so no 200 "rewrite" that could proxy another site through ours).
const FROM_RE = /^\/[A-Za-z0-9._~%+-][A-Za-z0-9._~\/%+-]*$/;
const TO_PATH_RE = /^\/(?!\/)[A-Za-z0-9._~\/%+=?#-]*$/;
const TO_ABS_RE = /^https:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(:\d{1,5})?(\/[A-Za-z0-9._~\/%+=?#-]*)?$/;
// Addresses the redirect may not start from: the editor itself, the platform's own folders, and files
// search engines expect to find.
const RESERVED_FROM = /^\/(cms|admin|\.netlify|\.well-known|assets|fonts|images|videos|frames)(\/|$)|^\/(feed\.xml|sitemap\.xml|robots\.txt|llms\.txt|_redirects|_headers)$/i;
const MAX_RULES = 100;
const MAX_CHAIN = 5;
const norm = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p).toLowerCase();

// -> { lines: ["/old /new 301", ...], dropped: [{ index, reason }] }
function analyseRedirects(items) {
  const lines = [];
  const dropped = [];
  const target = new Map(); // normalised from -> normalised internal target ("" for an external one)
  const list = Array.isArray(items) ? items : [];
  list.forEach((it, index) => {
    const drop = (reason) => dropped.push({ index, reason });
    if (lines.length >= MAX_RULES) return drop("more than " + MAX_RULES + " redirects");
    if (!it || typeof it !== "object" || Array.isArray(it)) return drop("not a redirect");
    const from = typeof it.fromLink === "string" ? it.fromLink.trim() : "";
    let to = typeof it.toLink === "string" ? it.toLink.trim() : "";
    if (!from || !to) return drop("the old or the new address is empty");
    if (from.length > 200 || to.length > 300) return drop("address too long");
    if (!FROM_RE.test(from) || /(^|\/)\.\.?(\/|$)/.test(from) || from.includes("//")) return drop("the old address must be a plain path such as /old-page/ (letters, numbers, dashes, dots; no wildcards, spaces or ?)");
    if (RESERVED_FROM.test(from)) return drop("the old address is a protected part of the site");
    // an address on the site's own domain becomes a path, so loops are always visible
    const own = /^https:\/\/([A-Za-z0-9.-]+)(\/.*)?$/.exec(to);
    if (own && SITE_HOSTS.has(own[1].toLowerCase())) to = own[2] || "/";
    let internal = true;
    if (TO_PATH_RE.test(to)) {
      if (/(^|\/)\.\.?(\/|$)/.test(to.split(/[?#]/)[0]) || to.split(/[?#]/)[0].includes("//")) return drop("the new address may not contain .. or //");
    } else if (TO_ABS_RE.test(to) && !/(^|\/)\.\.(\/|$)/.test(to) && !to.includes("//", 8)) {
      internal = false;
    } else return drop("the new address must be a path on this site (/page/) or a full https:// address");
    const key = norm(from);
    if (target.has(key)) return drop("this old address is already redirected by an earlier rule");
    if (internal) {
      const dest = norm(to.split(/[?#]/)[0]);
      if (dest === key) return drop("sends the page to itself");
      // follow the chain from the new address; coming back to the old address would be a loop
      let cur = dest;
      let depth = 1;
      while (target.has(cur) && target.get(cur)) {
        cur = target.get(cur);
        depth += 1;
        if (cur === key) return drop("would create a redirect loop");
        if (depth > MAX_CHAIN) break;
      }
      if (depth > MAX_CHAIN) return drop("would create a chain of more than " + MAX_CHAIN + " redirects");
      target.set(key, dest);
    } else target.set(key, "");
    lines.push(from + " " + to + " " + (it.permanent === false ? 302 : 301));
  });
  return { lines, dropped };
}

module.exports = function (eleventyConfig) {
  eleventyConfig.addFilter("seoCanonical", seoCanonical);
  eleventyConfig.addFilter("seoDate", seoDate);
  eleventyConfig.addFilter("seoPriority", seoPriority);
  eleventyConfig.addFilter("seoChangefreq", seoChangefreq);
  eleventyConfig.addFilter("redirectRules", (items) => {
    const r = analyseRedirects(items);
    r.dropped.forEach((d) => console.warn("[redirects] rule " + (d.index + 1) + " left out: " + d.reason));
    return r.lines;
  });
};
Object.assign(module.exports, { seoCanonical, seoDate, seoPriority, seoChangefreq, analyseRedirects, SITE, RESERVED_FROM });
