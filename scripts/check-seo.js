#!/usr/bin/env node
"use strict";
// check-seo: the search / social presentation of the site is complete, consistent and cannot be abused.
//
//   node scripts/check-seo.js [--root .] [--site <built site>] [--max 200] [--no-probe]
//
// 1. Rules    the redirect and canonical helpers (lib/eleventy/seo.js) are run against a battery of
//             hostile and broken inputs plus a few thousand random ones: every line they emit for
//             the Netlify _redirects file must match one strict shape (path, path or https address,
//             301 / 302), nothing else.
// 2. Site     every public (indexable) page of a fresh build has exactly one <h1>, a unique title and
//             description of a sensible length, one absolute https canonical on the site's own domain,
//             complete Open Graph / Twitter tags with a picture that exists, and valid JSON-LD;
//             sitemap.xml lists exactly the public pages that are their own canonical address, pages
//             hidden from search appear in none of sitemap.xml / llms.txt / feed.xml; robots.txt points
//             at the sitemap and does not block the site; the generated _redirects file is well formed,
//             every rule in redirects.json took effect (a dropped rule is a defect) and every target exists.
// 3. Probe    (skipped by --no-probe) a throwaway copy is built with every SEO switch flipped - a page
//             hidden, a canonical elsewhere, sitemap priority / frequency / date, a social card, a
//             hostile canonical and hostile redirects - and the output must change exactly that way.
// Exit code: 0 clean, 1 violations, 2 usage error / site does not build.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseDocument } = require("htmlparser2");
const { runMain, parseArgs, Report, REPO_ROOT, readText, readJson, exists, mkTmp, removeTree, clip } = require("./lib/util");
const { loadSources, splitFrontMatter, joinFrontMatter } = require("./lib/data");
const { findPages, pageUrlOf } = require("./lib/copycheck");
const { Workspace, eleventyBin } = require("./lib/workspace");

const SITE = "https://coveredaccess.com";
const { LINE_RE, sitemapProblems } = require("./lib/seoshape");
const TITLE_MIN = 10;
const TITLE_MAX = 120;
const DESC_MIN = 50;
const DESC_MAX = 320;

// ---------------------------------------------------------------- page reading
function readPage(html) {
  const doc = parseDocument(html, { decodeEntities: true });
  const out = { title: null, titles: 0, metas: [], links: [], h1: 0, ld: [] };
  const text = (n) => (n.children || []).map((c) => (c.type === "text" ? c.data : text(c))).join("");
  (function walk(n) {
    if (n.type === "tag" || n.type === "script" || n.type === "style") {
      const a = n.attribs || {};
      if (n.name === "title") {
        out.titles += 1;
        out.title = text(n).trim();
      } else if (n.name === "meta") out.metas.push(a);
      else if (n.name === "link") out.links.push(a);
      else if (n.name === "h1") out.h1 += 1;
      else if (n.name === "script" && /ld\+json/i.test(a.type || "")) out.ld.push(text(n));
    }
    (n.children || []).forEach(walk);
  })(doc);
  const metaAll = (key, val) => out.metas.filter((m) => (m[key] || "").toLowerCase() === val).map((m) => m.content);
  out.name = (v) => metaAll("name", v);
  out.prop = (v) => metaAll("property", v);
  out.canonicals = out.links.filter((l) => (l.rel || "").toLowerCase() === "canonical").map((l) => l.href);
  out.noindex = out.name("robots").some((c) => /noindex/i.test(c || ""));
  return out;
}

// ---------------------------------------------------------------- 1. rules
function mulberry(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ruleChecks(report, seo) {
  const R = (items) => seo.analyseRedirects(items);
  const item = (f, t, p) => ({ fromLink: f, toLink: t, permanent: p });
  const expectLines = (label, items, want) => {
    const got = R(items).lines;
    if (JSON.stringify(got) !== JSON.stringify(want)) report.add("Redirect rules", label, "expected " + JSON.stringify(want) + " but got " + JSON.stringify(got));
  };
  expectLines("a plain rule is written as 'from to 301'", [item("/old/", "/about/", true)], ["/old/ /about/ 301"]);
  expectLines("permanent: false is a 302", [item("/old/", "/about/", false)], ["/old/ /about/ 302"]);
  expectLines("an https address and a homepage anchor are accepted", [item("/a/", "https://example.org/x?y=1", true), item("/b/", "/#faq", true)], ["/a/ https://example.org/x?y=1 301", "/b/ /#faq 301"]);
  expectLines("an address on the site's own domain becomes a path", [item("/c/", "https://coveredaccess.com/about/", true)], ["/c/ /about/ 301"]);
  const bad = {
    "newline injected into the old address": item("/a\n/b /c 301", "/about/"),
    "newline injected into the new address": item("/a/", "/about/\n/x /y 200"),
    "carriage return": item("/a/", "/about/\r/x"),
    "space in the old address": item("/a b", "/about/"),
    "space (status 200 rewrite) in the new address": item("/a/", "/about/ 200"),
    "tab": item("/a/", "/about/\t200"),
    "wildcard in the old address": item("/blog/*", "/about/"),
    "placeholder in the old address": item("/:x", "/about/"),
    ":splat in the new address": item("/a/", "/:splat"),
    "wildcard in the new address": item("/a/", "/x/*"),
    "the homepage as the old address": item("/", "/about/"),
    "protocol-relative old address": item("//evil.example/x", "/about/"),
    "protocol-relative new address": item("/a/", "//evil.example/x"),
    "javascript: new address": item("/a/", "javascript:alert(1)"),
    "data: new address": item("/a/", "data:text/html,x"),
    "plain http new address": item("/a/", "http://example.org/"),
    "https address without a dot": item("/a/", "https://localhost/"),
    "address with credentials": item("/a/", "https://user:pw@example.org/"),
    "path traversal in the old address": item("/a/../b/", "/about/"),
    "path traversal in the new address": item("/a/", "/../etc/passwd"),
    "the editor as the old address": item("/cms/", "/about/"),
    "the admin folder as the old address": item("/admin/x", "/about/"),
    "an image as the old address": item("/images/x.jpg", "/about/"),
    "the sitemap as the old address": item("/sitemap.xml", "/about/"),
    "the redirects file itself": item("/_redirects", "/about/"),
    "a query on the old address": item("/a/?x=1", "/about/"),
    "a fragment on the old address": item("/a/#x", "/about/"),
    "unicode look-alike": item("/ａ/", "/about/"),
    "a NUL byte": item("/a\u0000/", "/about/"),
    "an ampersand": item("/a/", "/about/?x=1&y=2"),
    "a quote": item("/a/", "/about/\"onmouseover=1"),
    "angle brackets": item("/a/", "/<script>/"),
    "a very long old address": item("/" + "a".repeat(500), "/about/"),
    "empty old address": item("", "/about/"),
    "empty new address": item("/a/", ""),
    "numbers instead of text": item(12, 34),
    "not an object": "/a/ /b/ 301",
    "a page sent to itself": item("/a/", "/a/"),
    "a page sent to itself (trailing slash differs)": item("/a", "/a/"),
  };
  for (const [label, it] of Object.entries(bad)) {
    const got = R([it]).lines;
    if (got.length) report.add("Redirect rules", "'" + label + "' was written to the redirects file", JSON.stringify(got));
  }
  // loops, duplicates, chains
  expectLines("a loop is cut at the rule that closes it", [item("/a/", "/b/"), item("/b/", "/a/")], ["/a/ /b/ 301"]);
  expectLines("a longer loop is cut", [item("/a/", "/b/"), item("/b/", "/c/"), item("/c/", "/a/")], ["/a/ /b/ 301", "/b/ /c/ 301"]);
  expectLines("the same old address twice keeps the first", [item("/a/", "/x/"), item("/a/", "/y/")], ["/a/ /x/ 301"]);
  expectLines("a different case or trailing slash is the same old address", [item("/a/", "/x/"), item("/A", "/y/")], ["/a/ /x/ 301"]);
  const chain = ["/a/", "/b/", "/c/", "/d/", "/e/", "/f/", "/g/"].map((x, i, a) => item(x, a[i + 1] || "/end/"));
  if (R(chain.reverse()).dropped.length === 0) report.add("Redirect rules", "a chain of seven redirects was accepted in full");
  const many = Array.from({ length: 150 }, (_, i) => item("/p" + i + "/", "/about/"));
  if (R(many).lines.length > 100) report.add("Redirect rules", "more than 100 rules were written");
  // status can only ever be 301 / 302 whatever "permanent" holds
  for (const p of [true, false, "200", 200, null, undefined, "false", {}, [], 0]) {
    const l = R([item("/x/", "/about/", p)]).lines[0] || "";
    if (!/ (301|302)$/.test(l)) report.add("Redirect rules", "permanent=" + JSON.stringify(p) + " produced a status other than 301 / 302", l);
  }
  // random fuzz: whatever comes out must have the one strict shape
  const rnd = mulberry(20260101);
  const alphabet = ["/", "/", "a", "B", "9", "-", ".", "..", "_", "~", "%", "+", "*", ":", "?", "#", "&", "=", " ", "\t", "\n", "\r", "\u0000", "<", ">", '"', "'", "\\", "@", "https://", "http://", "javascript:", "//", "example.org", "coveredaccess.com", "301", "200", "!", "ａ", "‮", " "];
  const gen = () => {
    let s = rnd() < 0.7 ? "/" : "";
    const n = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i += 1) s += alphabet[Math.floor(rnd() * alphabet.length)];
    return s;
  };
  let emitted = 0;
  for (let i = 0; i < 6000; i += 1) {
    const it = item(gen(), rnd() < 0.5 ? gen() : "https://" + gen(), rnd() < 0.5);
    for (const line of R([it]).lines) {
      emitted += 1;
      if (!LINE_RE.test(line)) report.add("Redirect rules", "fuzzed input produced a malformed _redirects line", JSON.stringify(line) + " from " + JSON.stringify(it));
    }
  }
  report.note("  redirect rules: " + Object.keys(bad).length + " hostile cases rejected, 6000 fuzzed inputs (" + emitted + " accepted, all strictly shaped)");

  // canonical
  const own = SITE + "/x/";
  const canon = (v) => seo.seoCanonical(v, own);
  const canonCases = [
    ["/about/", SITE + "/about/"],
    ["https://coveredaccess.com/about/", SITE + "/about/"],
    ["https://www.coveredaccess.com/about/", SITE + "/about/"],
    ["https://evil.example/about/", own],
    ["https://coveredaccess.com.evil.example/", own],
    ["https://coveredaccess.com@evil.example/", own],
    ["http://coveredaccess.com/about/", own],
    ["//evil.example/", own],
    ["javascript:alert(1)", own],
    ['/about/"><script>alert(1)</script>', own],
    ["/about/ x", own],
    ["/a/../b/", own],
    ["", own],
    [null, own],
    [42, own],
  ];
  for (const [v, want] of canonCases) if (canon(v) !== want) report.add("Canonical address", "canonical for " + JSON.stringify(v) + " should be " + want, "got " + canon(v));
  for (const v of ["0.5", 0.5, "1.0", 1, "0", 0]) if (!/^(0\.5|1\.0|0\.0)$/.test(seo.seoPriority(v))) report.add("Sitemap values", "priority " + JSON.stringify(v) + " was not accepted");
  for (const v of ["2", "1.5", "-1", "high", "0.55", "<b>", null, NaN, 7]) if (seo.seoPriority(v) !== "") report.add("Sitemap values", "priority " + JSON.stringify(v) + " should be refused", seo.seoPriority(v));
  for (const v of ["weekly", "Daily"]) if (!seo.seoChangefreq(v)) report.add("Sitemap values", "change frequency " + JSON.stringify(v) + " was not accepted");
  for (const v of ["sometimes", "<x>", "", null, "daily\nx"]) if (seo.seoChangefreq(v) !== "") report.add("Sitemap values", "change frequency " + JSON.stringify(v) + " should be refused");
  for (const v of ["2026-02-30", "2026-13-01", "26-01-01", "2026-01-01T00:00", "<b>", "", null]) if (seo.seoDate(v, "FB") !== "FB") report.add("Sitemap values", "date " + JSON.stringify(v) + " should be refused");
  if (seo.seoDate("2026-02-28", "FB") !== "2026-02-28") report.add("Sitemap values", "a valid date was refused");
}

// ---------------------------------------------------------------- 2. site audit
function listUrls(xml, tag) {
  return [...xml.matchAll(new RegExp("<" + tag + ">([^<]*)</" + tag + ">", "g"))].map((m) => m[1]);
}

function mentions(text, url) {
  // the page's own address, not merely another address that starts the same way (/about/ vs /about/team/)
  const re = new RegExp(SITE.replace(/[.]/g, "\\.") + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9_.~%/-]|\\.[A-Za-z0-9])");
  return re.test(text);
}

function auditSite(report, root, siteDir, opts) {
  const o = opts || {};
  const label = o.label ? "[" + o.label + "] " : "";
  const pages = new Map();
  for (const f of findPages(siteDir)) {
    const url = pageUrlOf(siteDir, f);
    if (/^\/(cms|admin)\//.test(url)) continue;
    pages.set(url, readPage(readText(f)));
  }
  const read = (name) => (exists(path.join(siteDir, name)) ? readText(path.join(siteDir, name)) : null);
  const sitemap = read("sitemap.xml");
  const llms = read("llms.txt") || "";
  const feed = read("feed.xml") || "";
  const robots = read("robots.txt");
  const redirects = read("_redirects");
  const inSitemap = sitemap ? listUrls(sitemap, "loc") : [];

  const isIndexable = (p) => !p.noindex;
  const titles = new Map();
  const descs = new Map();
  const expected = [];
  let publicCount = 0;
  for (const [url, p] of pages) {
    const w = (what) => label + url + " " + what;
    if (!isIndexable(p)) {
      if (mentions(sitemap || "", url)) report.add("Hidden pages", w("is hidden from search engines but listed in sitemap.xml"));
      if (url !== "/" && mentions(llms, url)) report.add("Hidden pages", w("is hidden from search engines but linked in llms.txt"));
      if (url !== "/" && mentions(feed, url)) report.add("Hidden pages", w("is hidden from search engines but linked in feed.xml"));
      continue;
    }
    publicCount += 1;
    // headline
    if (p.h1 !== 1) report.add("Headings", w("has " + p.h1 + " <h1> elements; a page needs exactly one"));
    // title
    if (p.titles !== 1 || !p.title) report.add("Title", w("needs exactly one non-empty <title> (found " + p.titles + ")"));
    else {
      if (p.title.length < TITLE_MIN) report.add("Title", w("title is very short (" + p.title.length + " characters)"), clip(p.title, 80));
      if (p.title.length > TITLE_MAX) report.add("Title", w("title is " + p.title.length + " characters (more than " + TITLE_MAX + ")"), clip(p.title, 80));
      else if (p.title.length > 60 && !o.quiet) report.note("  note: " + url + " title is " + p.title.length + " characters (Google shows about 60)");
      if (titles.has(p.title)) report.add("Title", w("has the same title as " + titles.get(p.title)), clip(p.title, 80));
      else titles.set(p.title, url);
    }
    // description
    const d = p.name("description");
    if (d.length !== 1 || !d[0]) report.add("Description", w("needs exactly one non-empty meta description (found " + d.length + ")"));
    else {
      if (d[0].length < DESC_MIN) report.add("Description", w("description is very short (" + d[0].length + " characters)"), clip(d[0], 80));
      if (d[0].length > DESC_MAX) report.add("Description", w("description is " + d[0].length + " characters (more than " + DESC_MAX + ")"));
      else if (d[0].length > 160 && !o.quiet) report.note("  note: " + url + " description is " + d[0].length + " characters (Google shows about 160)");
      if (descs.has(d[0])) report.add("Description", w("has the same description as " + descs.get(d[0])), clip(d[0], 80));
      else descs.set(d[0], url);
    }
    // canonical
    let canonical = null;
    if (p.canonicals.length !== 1) report.add("Canonical", w("needs exactly one canonical link (found " + p.canonicals.length + ")"));
    else {
      canonical = p.canonicals[0];
      const m = /^https:\/\/(?:www\.)?coveredaccess\.com(\/[A-Za-z0-9._~\/%+-]*)$/.exec(canonical || "");
      if (!m) report.add("Canonical", w("canonical is not an absolute https address on coveredaccess.com"), String(canonical));
      else if (m[1] !== url) report.note("  note: " + label + url + " has its canonical address set to " + canonical + " (left out of the sitemap)");
    }
    // social tags
    for (const k of ["og:title", "og:description", "og:type", "og:url", "og:image"]) {
      const v = p.prop(k);
      if (v.length !== 1 || !v[0]) report.add("Social tags", w("is missing " + k + (v.length > 1 ? " (found " + v.length + ")" : "")));
    }
    if (!p.name("twitter:card").length) report.add("Social tags", w("is missing twitter:card"));
    if (canonical && p.prop("og:url")[0] && p.prop("og:url")[0] !== canonical) report.add("Social tags", w("og:url differs from the canonical address"), p.prop("og:url")[0] + " vs " + canonical);
    const img = (p.prop("og:image") || [])[0];
    if (img) {
      const m = /^https:\/\/coveredaccess\.com(\/[^?#]+)$/.exec(img);
      if (!m) report.add("Social tags", w("og:image is not an absolute https address on the site"), img);
      else if (!exists(path.join(siteDir, m[1].replace(/^\//, "")))) report.add("Social tags", w("og:image points at a file that does not exist"), img);
      if (!p.prop("og:image:alt").length && !o.quiet) report.note("  note: " + label + url + " share picture has no description (og:image:alt); add one in the CMS");
    }
    // structured data
    p.ld.forEach((code, i) => {
      let j;
      try {
        j = JSON.parse(code);
      } catch (e) {
        report.add("Structured data", w("JSON-LD block " + (i + 1) + " is not valid JSON: " + e.message));
        return;
      }
      const nodes = Array.isArray(j["@graph"]) ? j["@graph"] : [j];
      if (j["@context"] !== "https://schema.org") report.add("Structured data", w("JSON-LD block " + (i + 1) + " has no schema.org @context"));
      nodes.forEach((n) => {
        if (!n || typeof n["@type"] !== "string") report.add("Structured data", w("JSON-LD block " + (i + 1) + " holds an item without an @type"));
      });
    });
    if (canonical === SITE + url || (canonical && canonical === SITE.replace("://", "://www.") + url)) expected.push(SITE + url);
  }
  // sitemap
  if (sitemap === null) report.add("Sitemap", label + "sitemap.xml is missing");
  else {
    if (new Set(inSitemap).size !== inSitemap.length) report.add("Sitemap", label + "sitemap.xml lists an address twice");
    for (const u of inSitemap) if (!/^https:\/\/coveredaccess\.com\/[A-Za-z0-9._~\/%+-]*$/.test(u)) report.add("Sitemap", label + "sitemap.xml holds an address that is not an absolute https address on the site", u);
    for (const u of expected) if (!inSitemap.includes(u)) report.add("Sitemap", label + u + " is a public page but is missing from sitemap.xml");
    for (const u of inSitemap) if (!expected.includes(u)) report.add("Sitemap", label + "sitemap.xml lists " + u + ", which is not a public page that is its own canonical address");
    sitemapProblems(sitemap).forEach((p) => report.add("Sitemap", label + p));
    const bad = listUrls(sitemap, "lastmod").filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
    if (bad.length) report.add("Sitemap", label + "sitemap.xml has a malformed lastmod", bad[0]);
    const badPri = listUrls(sitemap, "priority").filter((d) => !/^(0\.\d|1\.0)$/.test(d));
    if (badPri.length) report.add("Sitemap", label + "sitemap.xml has a malformed priority", badPri[0]);
    const badFreq = listUrls(sitemap, "changefreq").filter((d) => !/^(always|hourly|daily|weekly|monthly|yearly|never)$/.test(d));
    if (badFreq.length) report.add("Sitemap", label + "sitemap.xml has a malformed changefreq", badFreq[0]);
  }
  // robots.txt
  if (robots === null) report.add("robots.txt", label + "robots.txt is missing");
  else {
    if (!/^Sitemap:\s*https:\/\/coveredaccess\.com\/sitemap\.xml\s*$/m.test(robots)) report.add("robots.txt", label + "does not point at https://coveredaccess.com/sitemap.xml");
    if (/User-agent:\s*\*\s*[\r\n]+(?:(?:Allow|Crawl-delay)[^\r\n]*[\r\n]+)*Disallow:\s*\/\s*$/im.test(robots)) report.add("robots.txt", label + "blocks the whole site for every crawler");
  }
  // redirects file
  if (redirects === null) report.add("Redirects", label + "_redirects is missing from the build");
  else {
    const lines = redirects.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() && !l.startsWith("#"));
    for (const l of lines) if (!LINE_RE.test(l)) report.add("Redirects", label + "_redirects holds a line of the wrong shape", JSON.stringify(l));
    for (const l of lines) {
      const [from, to] = l.split(" ");
      if (pages.has(from.endsWith("/") ? from : from + "/")) report.note("  note: " + label + "redirect from " + from + " starts at a page that exists; the page wins (rules are not forced)");
      if (to.startsWith("/")) {
        const p = to.split(/[?#]/)[0];
        const known = pages.has(p) || pages.has(p.endsWith("/") ? p : p + "/") || lines.some((x) => x.split(" ")[0] === p) || exists(path.join(siteDir, p.replace(/^\//, "")));
        if (!known) report.add("Redirects", label + "redirect " + from + " leads to " + to + ", which is not a page of the site");
      }
    }
    if (!o.noData) {
      try {
        const seo = require(path.join(root, "lib", "eleventy", "seo.js"));
        const data = readJson(path.join(root, "src", "_data", "redirects.json"));
        const r = seo.analyseRedirects(data.items);
        r.dropped.forEach((d) => report.add("Redirects", label + "redirect " + (d.index + 1) + " in redirects.json has no effect: " + d.reason));
        if (r.lines.length !== lines.length) report.add("Redirects", label + "redirects.json has " + r.lines.length + " working rule(s) but _redirects holds " + lines.length);
      } catch (e) {
        report.add("Redirects", label + "redirects.json could not be read: " + e.message);
      }
    }
  }
  return { pages, publicCount, inSitemap, expected };
}

// ---------------------------------------------------------------- 3. probe
function probe(report, root) {
  const ws = new Workspace(root, { prefix: "covered-seo-" });
  try {
    const sources = loadSources(ws.dir).sources;
    const edit = (file, fn) => {
      const s = sources.find((x) => x.file === file);
      if (!s) throw new Error(file + " not found");
      const data = JSON.parse(JSON.stringify(s.data));
      fn(data);
      if (s.kind === "data") ws.writeJson(file, data);
      else ws.write(file, joinFrontMatter(data, s.body));
    };
    const page = (name) => "src/pages/" + name + ".md";
    edit(page("privacy"), (d) => {
      d.hideFromSearch = true;
    });
    edit(page("about"), (d) => {
      d.sitemapPriority = "0.8";
      d.sitemapChangefreq = "weekly";
      d.lastModified = "2026-01-02";
      d.socialTitle = "Probe social headline";
      d.socialDescription = "Probe social description";
      d.shareImage = "/images/covered-og.jpg";
      d.shareImageAlt = "Probe picture description";
      d.seoTitle = "Probe search title for the about page";
    });
    ws.write(
      page("copy"),
      joinFrontMatter({ title: "Copy", permalink: "/copy/", description: "A page that says another page is the real one, so it must stay out of the sitemap.", layout: "page.njk", canonicalUrl: "/about/", sections: [{ type: "hero", heading: "Copy page" }] }, "")
    );
    edit("src/_data/site.json", (d) => {
      d.canonicalUrl = "https://evil.example/steal";
      d.sitemapPriority = "1.0";
      d.sitemapChangefreq = "daily";
      d.lastModified = "2026-02-03";
    });
    edit("src/_data/redirects.json", (d) => {
      d.items = [
        { fromLink: "/old-about/", toLink: "/about/", permanent: true },
        { fromLink: "/temp/", toLink: "https://example.org/x", permanent: false },
        { fromLink: "/a\n/b /c 301", toLink: "/about/", permanent: true },
        { fromLink: "/wild/*", toLink: "/about/", permanent: true },
        { fromLink: "/proxy/", toLink: "/about/ 200", permanent: true },
        { fromLink: "/loop-a/", toLink: "/loop-b/", permanent: true },
        { fromLink: "/loop-b/", toLink: "/about/", permanent: true },
        { fromLink: "/about/", toLink: "/loop-a/", permanent: true },
        { fromLink: "/js/", toLink: "javascript:alert(1)", permanent: true },
      ];
    });
    const b = ws.build("probe");
    if (!b.ok) {
      report.add("Probe build", "the copy with every SEO switch set does not build", b.log.split("\n").slice(-12).join("\n"));
      return;
    }
    const out = b.out;
    const html = (rel) => readPage(readText(path.join(out, rel)));
    const sm = readText(path.join(out, "sitemap.xml"));
    const home = html("index.html");
    const about = html("about/index.html");
    const priv = html("privacy/index.html");
    const copy = html("copy/index.html");
    const P = (what, cond, detail) => {
      if (!cond) report.add("Probe (every SEO switch set)", what, detail);
    };
    P("hideFromSearch adds a robots noindex tag", priv.noindex, "privacy page: " + JSON.stringify(priv.name("robots")));
    P("a hidden page is left out of sitemap.xml", !mentions(sm, "/privacy/"));
    P("an ordinary page is not marked noindex", !about.noindex && !home.noindex);
    P("sitemap priority, change frequency and last-changed date come from the data", /<loc>https:\/\/coveredaccess\.com\/about\/<\/loc>\s*<lastmod>2026-01-02<\/lastmod>\s*<changefreq>weekly<\/changefreq>\s*<priority>0\.8<\/priority>/.test(sm), sm);
    P("the homepage takes its sitemap values from site.json", /<loc>https:\/\/coveredaccess\.com\/<\/loc>\s*<lastmod>2026-02-03<\/lastmod>\s*<changefreq>daily<\/changefreq>\s*<priority>1\.0<\/priority>/.test(sm), sm);
    P("a page whose canonical address is another page is left out of the sitemap", !mentions(sm, "/copy/"));
    P("that page's canonical link points at the other page", copy.canonicals[0] === SITE + "/about/", String(copy.canonicals));
    P("a canonical on another website is refused (falls back to the page itself)", home.canonicals[0] === SITE + "/", String(home.canonicals));
    P("a refused canonical also keeps og:url on the site", home.prop("og:url")[0] === SITE + "/", String(home.prop("og:url")));
    P("the search title override reaches <title>", about.title === "Probe search title for the about page", about.title);
    P("the social headline and description reach og:title / og:description", about.prop("og:title")[0] === "Probe social headline" && about.prop("og:description")[0] === "Probe social description", String(about.prop("og:title")));
    P("the page title and description still serve search", about.name("description")[0] && !/Probe social/.test(about.name("description")[0]));
    P("the share picture description reaches og:image:alt", about.prop("og:image:alt")[0] === "Probe picture description", String(about.prop("og:image:alt")));
    P("a page's own share picture gets its size tags", about.prop("og:image:width").length === 1 && about.prop("og:image:height").length === 1);
    const rd = readText(path.join(out, "_redirects"));
    const lines = rd.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    const want = ["/old-about/ /about/ 301", "/temp/ https://example.org/x 302", "/loop-a/ /loop-b/ 301", "/loop-b/ /about/ 301"];
    P("only the valid redirects are written, in order, with 301 / 302", JSON.stringify(lines) === JSON.stringify(want), JSON.stringify(lines));
    P("no line other than comments and rules exists (no injected line)", rd.split("\n").every((l) => !l.trim() || l.startsWith("#") || LINE_RE.test(l)), rd);
    // the whole probe site must still satisfy the site audit, apart from what was switched on on purpose
    const sub = new Report("probe");
    const r = auditSite(sub, root, out, { label: "probe", quiet: true, noData: true });
    for (const it of sub.items) {
      // the copy page is deliberately a duplicate address, the redirect target check sees real files only
      report.add("Probe site audit", it.title, it.detail);
    }
    P("the audited probe has the expected public pages", r.expected.includes(SITE + "/about/") && r.expected.includes(SITE + "/") && !r.expected.includes(SITE + "/privacy/") && !r.expected.includes(SITE + "/copy/"), JSON.stringify(r.expected));
  } finally {
    ws.cleanup();
  }
}

// ---------------------------------------------------------------- main
function freshBuild(root) {
  const tmp = mkTmp("covered-seo-site-");
  const out = path.join(tmp, "site");
  const r = spawnSync(process.execPath, [eleventyBin(root), "--quiet", "--output=" + out], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0 && exists(out), out, tmp, log: (r.stdout || "") + (r.stderr || "") };
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "string", site: "string", max: "number", noProbe: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-seo.js [--root <repo root>] [--site <built site>] [--max <n>] [--no-probe]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  const report = new Report("check-seo");
  let seo;
  try {
    seo = require(path.join(root, "lib", "eleventy", "seo.js"));
  } catch (e) {
    console.error("check-seo: lib/eleventy/seo.js could not be loaded: " + e.message);
    return 2;
  }
  ruleChecks(report, seo);
  let siteDir = args.site ? path.resolve(args.site) : null;
  let tmp = null;
  try {
    if (!siteDir) {
      const b = freshBuild(root);
      tmp = b.tmp;
      if (!b.ok) {
        console.error("check-seo: the site does not build\n" + b.log.split("\n").slice(-20).join("\n"));
        return 2;
      }
      siteDir = b.out;
    } else if (!exists(siteDir)) {
      console.error("check-seo: built site not found at " + siteDir);
      return 2;
    }
    const a = auditSite(report, root, siteDir);
    report.note("check-seo: " + a.publicCount + " public page(s) of " + a.pages.size + " checked, sitemap lists " + a.inSitemap.length);
    if (!args.noProbe) {
      probe(report, root);
      report.note("  probe: a copy with every SEO switch set was built and checked");
    }
  } finally {
    if (tmp) removeTree(tmp);
  }
  return report.print({ max: args.max || 200, okMessage: "OK - search and social presentation is complete, consistent and safe" });
}

runMain("check-seo", main);
