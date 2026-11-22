"use strict";
// Facts for the content rules (studio/PHASE1-DESIGN.md 8.2): everything the rules need that is not in the data files themselves
// (which pages exist, which anchors they have, how big the pictures are). Node only (fs). ONE builder, two callers:
//   - studio/markers/snapshot.js embeds the result in content.json (key `facts`) so the overlay can run the same rules;
//   - studio/guards/check-content-rules.js builds it from the checkout.
// buildFacts(root, { site? }) -> Facts. `site` = a built _site folder: when given, element ids found in its pages are added to
// `anchors` (tests only; the snapshot and the guard use the static set so the panel and CI always agree).
const fs = require("fs");
const path = require("path");

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif|svg)$/i;
const readText = (f) => fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
const exists = (f) => { try { return fs.existsSync(f); } catch (e) { return false; } };
const slash = (p) => (p.endsWith("/") ? p : p + "/");
const baseName = (v) => { const s = String(v || "").split("?")[0].split("#")[0]; return s.slice(s.lastIndexOf("/") + 1); };

function pagePermalinks(root) {
  const { splitFrontMatter } = require("../markers/snapshot");
  const dir = path.join(root, "src", "pages");
  const out = [];
  if (!exists(dir)) return out;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/^[a-z0-9-]+\.md$/.test(f)) continue;
    const front = splitFrontMatter(readText(path.join(dir, f))).front;
    out.push({ key: "pages:" + f.replace(/\.md$/, ""), permalink: typeof front.permalink === "string" ? front.permalink : "/" + f.replace(/\.md$/, "") + "/", front });
  }
  return out;
}

function toolRoutes(root) {
  const out = new Set();
  const src = path.join(root, "src");
  if (exists(src)) {
    for (const f of fs.readdirSync(src)) {
      if (!/\.(njk|md|html)$/.test(f)) continue;
      const m = /^permalink:\s*(\/\S*?)(?:index\.html)?\s*$/m.exec(readText(path.join(src, f)).split("\n---")[0]);
      if (m && m[1].endsWith("/")) out.add(m[1]);
    }
  }
  try {
    for (const e of JSON.parse(readText(path.join(root, "scripts", "copy-allowlist.json"))).excludePages || []) if (/^\/[a-z0-9-]+\/$/.test(e.path || "")) out.add(e.path);
  } catch (e) { /* no allow-list in a throwaway workspace */ }
  return out;
}

function imageInfo(root) {
  const dir = path.join(root, "images");
  const out = {};
  let sniff = null;
  try { sniff = require(path.join(root, "scripts", "lib", "image-rules.js")).sniffImage; } catch (e) { /* sizes stay 0 */ }
  if (!exists(dir)) return out;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!IMG_EXT.test(f)) continue;
    const buf = fs.readFileSync(path.join(dir, f));
    let w = 0;
    let h = 0;
    if (sniff) { try { const s = sniff(new Uint8Array(buf)); if (s) { w = s.width || 0; h = s.height || 0; } } catch (e) { /* unreadable header */ } }
    out[f] = { bytes: buf.length, width: w, height: h };
  }
  return out;
}

function imagesIn(value, known, into) {
  if (typeof value === "string") { const n = baseName(value); if (IMG_EXT.test(n) && known[n]) into.add(n); }
  else if (Array.isArray(value)) value.forEach((v) => imagesIn(v, known, into));
  else if (value && typeof value === "object") Object.keys(value).forEach((k) => imagesIn(value[k], known, into));
}

function anchorValues(value, into) {
  // `anchor` fields hold the id a section answers to; data-only, no schema needed
  if (Array.isArray(value)) value.forEach((v) => anchorValues(v, into));
  else if (value && typeof value === "object") Object.keys(value).forEach((k) => { if (k === "anchor" && typeof value[k] === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(value[k].trim())) into.add(value[k].trim()); else anchorValues(value[k], into); });
}

function siteIds(site, route) {
  const f = path.join(site, route === "/" ? "" : route.replace(/^\/|\/$/g, ""), "index.html");
  const ids = new Set();
  if (!exists(f)) return ids;
  // minified html drops the quotes (id=how), so accept both
  for (const m of readText(f).matchAll(/\sid=(?:"([^"]+)"|'([^']+)'|([^\s"'<>=`]+))/g)) ids.add(m[1] || m[2] || m[3]);
  return ids;
}

function buildFacts(root, opts) {
  opts = opts || {};
  root = path.resolve(root);
  const pages = pagePermalinks(root);
  const routes = ["/"].concat(pages.map((p) => slash(p.permalink))).filter((r, i, a) => a.indexOf(r) === i).sort();
  const tools = Array.from(toolRoutes(root)).filter((r) => routes.indexOf(r) < 0).sort();

  const dataDir = path.join(root, "src", "_data");
  const data = {};
  if (exists(dataDir)) for (const f of fs.readdirSync(dataDir).sort()) if (/^[a-z][a-z0-9-]*\.json$/.test(f)) { try { data[f.replace(/\.json$/, "")] = JSON.parse(readText(path.join(dataDir, f))); } catch (e) { /* a broken file is another guard's job */ } }

  let reserved = [];
  try { reserved = JSON.parse(readText(path.join(root, "studio", "schema", "studio-schema.json"))).reservedIds || []; } catch (e) { /* none */ }

  const redirectFrom = [];
  for (const it of (data.redirects && data.redirects.items) || []) if (it && typeof it.fromLink === "string" && it.fromLink.startsWith("/")) redirectFrom.push(it.fromLink);

  const images = imageInfo(root);
  const siteWide = new Set();
  Object.keys(data).forEach((k) => imagesIn(data[k], images, siteWide));
  const anchors = {};
  const pageInfo = {};
  const homeAnchors = new Set(reserved);
  Object.keys(data).forEach((k) => anchorValues(data[k], homeAnchors));
  if (opts.site) siteIds(opts.site, "/").forEach((i) => homeAnchors.add(i));
  anchors["/"] = Array.from(homeAnchors).sort();
  const sumBytes = (set) => { let b = 0; set.forEach((n) => { b += (images[n] || {}).bytes || 0; }); return b; };
  pageInfo["/"] = { images: Array.from(siteWide).sort(), bytes: sumBytes(siteWide) };
  for (const p of pages) {
    const route = slash(p.permalink);
    const own = new Set();
    imagesIn(p.front, images, own);
    const a = new Set(reserved);
    anchorValues(p.front, a);
    if (opts.site) siteIds(opts.site, route).forEach((i) => a.add(i));
    anchors[route] = Array.from(a).sort();
    pageInfo[route] = { images: Array.from(own).sort(), bytes: sumBytes(own) };
  }
  return { routes, tools, anchors, redirectFrom: redirectFrom.sort(), images, pages: pageInfo };
}

module.exports = { buildFacts };
