"use strict";
// The strict shapes of the generated non-HTML SEO files, shared by check-seo and check-hostile:
// a line of the Netlify _redirects file ("/old /new 301") and the values inside sitemap.xml.

const fs = require("fs");
const path = require("path");

const LINE_RE = /^\/[A-Za-z0-9._~%+-][A-Za-z0-9._~\/%+-]* (\/(?!\/)[A-Za-z0-9._~\/%+=?#-]*|https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d{1,5})?(\/[A-Za-z0-9._~\/%+=?#-]*)?) (301|302)$/;

// -> { rules: [line, ...], problems: [text, ...] } for a built site folder (no file = no rules)
function redirectsOf(siteDir) {
  const f = path.join(siteDir, "_redirects");
  if (!fs.existsSync(f)) return { rules: [], problems: ["_redirects is missing from the build"] };
  const raw = fs.readFileSync(f, "utf8");
  const rules = [];
  const problems = [];
  if (/[^\n\x20-\x7e]/.test(raw.replace(/\r?\n/g, "\n"))) problems.push("_redirects holds a character other than printable ASCII");
  for (const line of raw.split("\n")) {
    const l = line.replace(/\r$/, "");
    if (!l.trim() || l.startsWith("#")) continue;
    if (LINE_RE.test(l)) rules.push(l);
    else problems.push("malformed line " + JSON.stringify(l.slice(0, 120)));
  }
  return { rules, problems };
}

// Problems with the values of a sitemap.xml (empty when well formed).
function sitemapProblems(xml) {
  const out = [];
  if (!/^<\?xml [^>]*\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">[\s\S]*<\/urlset>\s*$/.test(xml)) out.push("sitemap.xml is not a <urlset> document");
  const urls = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  const stripped = xml.replace(/<\?xml [^>]*\?>/, "").replace(/<\/?(urlset|url|loc|lastmod|changefreq|priority)( xmlns="[^"]*")?>/g, "");
  if (/[<>&"]/.test(stripped)) out.push("sitemap.xml holds markup or special characters outside the expected elements");
  for (const u of urls) {
    const loc = /<loc>([^<]*)<\/loc>/.exec(u);
    if (!loc || !/^https:\/\/coveredaccess\.com\/[A-Za-z0-9._~\/%+-]*$/.test(loc[1])) out.push("a sitemap <loc> is not an https address on the site: " + (loc ? loc[1] : "(none)"));
    const mod = /<lastmod>([^<]*)<\/lastmod>/.exec(u);
    if (mod && !/^\d{4}-\d{2}-\d{2}$/.test(mod[1])) out.push("malformed lastmod " + mod[1]);
    const pr = /<priority>([^<]*)<\/priority>/.exec(u);
    if (pr && !/^(0\.\d|1\.0)$/.test(pr[1])) out.push("malformed priority " + pr[1]);
    const cf = /<changefreq>([^<]*)<\/changefreq>/.exec(u);
    if (cf && !/^(always|hourly|daily|weekly|monthly|yearly|never)$/.test(cf[1])) out.push("malformed changefreq " + cf[1]);
  }
  return out;
}

module.exports = { LINE_RE, redirectsOf, sitemapProblems };
