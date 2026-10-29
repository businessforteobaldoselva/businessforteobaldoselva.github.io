#!/usr/bin/env node
"use strict";
// check-images: the picture pipeline (lib/eleventy/images.js + src/_includes/picture.njk) must serve
// every picture correctly, and must not make the page heavier than the hand-made WebP set it replaced.
//
//   node scripts/check-images.js [--site <built site>] [--root .] [--write-baseline <site built before the pipeline>]
//
// Reads the BUILT site (without --site it builds the checkout into a temp folder and deletes it).
// For every public page it requires:
//   * every content <img> (one that points at /img/ or /images/) has numeric width + height, an alt
//     attribute, loading and decoding="async"; alt may be empty only for pictures the data marks
//     "decorative: true" (the number of empty alts may not exceed the number of decorative switches)
//   * no <img src>, <source srcset>, <img srcset> or <video poster> points at a file missing from the site
//   * at most one picture per page is eager / fetchpriority="high" (the LCP image; today none)
//   * every <img> has an alt attribute (the decorative scroll-scrub stills under /frames/ may be empty)
// It also reads the uploaded FILES in images/ and videos/ (they are published byte for byte):
//   * a picture must not be empty or corrupt (the page would show a broken image), and a JPEG must not
//     carry the GPS position of where the photo was taken (the original stays downloadable and is the share picture)
//   * an SVG must be inert: no <script>, event-handler attribute, <foreignObject>, <iframe> / <embed> / <object>,
//     javascript: URL, or link / CSS url() to another site - opened on its own address it would run on our domain
// and, for the home page, that the image bytes a browser would download (simulated: sizes + srcset
// choice, AVIF first, every lazy picture counted as if the visitor scrolled the whole page) at
// 390 px and 1280 px wide, on 1x and 2x screens, are not larger than scripts/fixtures/images-baseline.json
// (measured once on the previous, hand-made <picture>/WebP markup with --write-baseline).
// Exit code: 0 clean, 1 violations, 2 usage / missing build.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseDocument } = require("htmlparser2");
const { runMain, mkTmp, removeTree, parseArgs, readJson, exists, Report, REPO_ROOT, SCRIPTS_DIR } = require("./lib/util");
const { loadSources } = require("./lib/data");
const { eleventyBin } = require("./lib/workspace");
const sizeOf = require("image-size");

const BASELINE_FILE = path.join(SCRIPTS_DIR, "fixtures", "images-baseline.json");
const VIEWPORTS = [390, 1280];
const DPRS = [1, 2];
const INTERNAL_TOP = new Set(["cms", "admin", "og", "ident", "scroll", "img", "images", "frames", "fonts", "videos", "assets", "node_modules"]);
const CONTENT_SRC = /^\/?(img|images)\//i;

function freshBuild(root) {
  const tmp = mkTmp("covered-img-");
  const out = path.join(tmp, "site");
  const r = spawnSync(process.execPath, [eleventyBin(root), "--quiet", "--output=" + out], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0 && exists(out), out, tmp, log: (r.stdout || "") + (r.stderr || "") };
}

function pages(siteDir) {
  const out = [];
  (function walk(dir, rel) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) {
        if (!rel && INTERNAL_TOP.has(f.name)) continue;
        walk(path.join(dir, f.name), rel + "/" + f.name);
      } else if (f.name === "index.html") out.push({ url: rel + "/", file: path.join(dir, f.name) });
    }
  })(siteDir, "");
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

function elements(html, names) {
  const found = [];
  (function walk(n) {
    if (n.type === "tag" && names.includes(n.name)) found.push(n);
    (n.children || []).forEach(walk);
  })(parseDocument(html, { decodeEntities: true }));
  return found;
}

// "/img/a.avif 480w, /img/b.avif 960w" -> [{ url, w }]  (w = 0 for a plain 1x candidate)
function candidates(srcset) {
  return String(srcset || "")
    .split(/,\s+|,$/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [url, d] = p.split(/\s+/);
      const m = /^(\d+)w$/.exec(d || "");
      return { url, w: m ? Number(m[1]) : 0 };
    });
}

// How wide the browser draws the picture: first matching entry of `sizes` (default 100vw).
function slotWidth(sizes, vw) {
  const entries = String(sizes || "100vw").split(/,\s*(?![^(]*\))/);
  for (const e of entries) {
    const m = /^\s*(?:\(([^)]*)\)\s*)?(\d+(?:\.\d+)?)(px|vw)\s*$/.exec(e);
    if (!m) continue;
    if (m[1]) {
      const c = /^\s*(max|min)-width\s*:\s*(\d+(?:\.\d+)?)px\s*$/.exec(m[1]);
      if (!c) continue;
      if (c[1] === "max" ? !(vw <= Number(c[2])) : !(vw >= Number(c[2]))) continue;
    }
    return m[3] === "vw" ? (Number(m[2]) / 100) * vw : Number(m[2]);
  }
  return vw;
}

function pick(list, need) {
  if (!list.length) return null;
  const w = list.filter((c) => c.w).sort((a, b) => a.w - b.w);
  if (!w.length) return list[0].url;
  return (w.find((c) => c.w >= need) || w[w.length - 1]).url;
}

// URL of the file a browser (AVIF + WebP capable, picks the first <source> it understands) downloads for one <img>.
function chosenFile(img, vw, dpr) {
  const sources = [];
  if (img.parent && img.parent.name === "picture") {
    for (const s of img.parent.children.filter((c) => c.name === "source")) sources.push(s.attribs || {});
  }
  const own = img.attribs || {};
  const supported = (t) => !t || /^image\/(avif|webp|jpeg|png|gif|svg\+xml)$/.test(t);
  for (const s of sources) {
    if (!supported(s.type)) continue;
    const need = slotWidth(s.sizes || own.sizes, vw) * dpr;
    const url = pick(candidates(s.srcset), need);
    if (url) return url;
  }
  const url = own.srcset ? pick(candidates(own.srcset), slotWidth(own.sizes, vw) * dpr) : null;
  return url || own.src || "";
}

function imageBytes(siteDir, html) {
  const out = {};
  const imgs = elements(html, ["img"]);
  for (const vw of VIEWPORTS) {
    for (const dpr of DPRS) {
      const urls = new Set();
      for (const img of imgs) {
        if ((img.parent && img.parent.name === "noscript") || /^\/?frames\//i.test((img.attribs || {}).src || "")) continue;
        const u = chosenFile(img, vw, dpr);
        if (u) urls.add(u.split(/[?#]/)[0]);
      }
      let sum = 0;
      for (const u of urls) {
        const f = path.join(siteDir, u.replace(/^\//, ""));
        if (exists(f)) sum += fs.statSync(f).size;
      }
      out[vw + "@" + dpr + "x"] = sum;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { site: "string", root: "string", writeBaseline: "string" });
  if (args.help) {
    console.log("usage: node scripts/check-images.js [--site <built site>] [--root <repo root>] [--write-baseline <site built from the previous markup>]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  if (args.writeBaseline) {
    const dir = path.resolve(args.writeBaseline);
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    const bytes = imageBytes(dir, html);
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ _comment: "Image bytes a browser downloads for / (every picture counted) on the markup before the image pipeline (hand-made WebP siblings). check-images fails if the pipeline is ever heavier. Regenerate only on purpose: node scripts/check-images.js --write-baseline <site>.", bytes }, null, 2) + "\n");
    console.log("check-images: baseline written to " + path.relative(process.cwd(), BASELINE_FILE) + " " + JSON.stringify(bytes));
    return 0;
  }
  if (args.site) {
    const siteDir = path.resolve(args.site);
    if (!exists(siteDir)) {
      console.error("check-images: built site not found at " + siteDir);
      return 2;
    }
    return check(root, siteDir);
  }
  const b = freshBuild(root);
  try {
    if (!b.ok) {
      console.error("check-images: the site does not build\n" + b.log.split("\n").slice(-20).join("\n"));
      return 2;
    }
    return check(root, b.out);
  } finally {
    removeTree(b.tmp);
  }
}

// ---- the uploaded files themselves
// The picture-file rules (SVG hazards, EXIF GPS) live in scripts/lib/image-rules.js, shared with the Studio API.
const { RASTER, SVG_HAZARDS, jpegHasGps } = require("./lib/image-rules");
function walkFiles(dir, out) {
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const f of list) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}
function fileProblems(root, report) {
  const G = "Picture files";
  let n = 0;
  for (const dirName of ["images", "videos"]) {
    for (const file of walkFiles(path.join(root, dirName), [])) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (RASTER.test(file)) {
        n += 1;
        let size = 0;
        try {
          size = fs.statSync(file).size;
          if (!size) throw new Error("the file is empty (0 bytes)");
          const d = sizeOf(file);
          if (!d.width || !d.height) throw new Error("it has no pixel size");
        } catch (e) {
          report.add(G, rel + " is not a usable picture (" + String(e.message).split("\n")[0] + ")", "Upload the picture again. A broken file would be shown as a broken image on the live site.");
          continue;
        }
        if (/\.jpe?g$/i.test(file) && jpegHasGps(fs.readFileSync(file))) report.add(G, rel + " carries the GPS position where the photo was taken", "The original upload is published as it is and can be downloaded. Remove the location data (re-save / export the photo without it) and upload it again.");
      } else if (/\.svg$/i.test(file)) {
        n += 1;
        const text = fs.readFileSync(file, "utf8");
        if (!/<\s*svg\b/i.test(text)) {
          report.add(G, rel + " is not an SVG picture", "The file holds no <svg> element.");
          continue;
        }
        for (const [re, what] of SVG_HAZARDS) {
          const m = re.exec(text);
          if (m) report.add(G, rel + " is not a safe SVG: it contains " + what, "An SVG opened on its own address runs its scripts on the real website. Export it again as a plain picture without scripts, event handlers or outside links. Found: " + JSON.stringify(m[0].slice(0, 60)));
        }
      }
    }
  }
  return n;
}

function check(root, siteDir) {
  const report = new Report("check-images");
  const G = "Pictures";
  const nFiles = fileProblems(root, report);
  const hasFrames = exists(path.join(siteDir, "frames"));
  const fileOk = (u) => {
    const p = String(u).split(/[?#]/)[0];
    if (!p.startsWith("/")) return true; // other sites / data: handled by check-copy
    if (!hasFrames && /^\/frames\//.test(p)) return true; // a throwaway copy built without the hero stills (the scripts' workspaces)
    return exists(path.join(siteDir, p.replace(/^\//, "")));
  };

  // pictures the data marks decorative: the most empty alts a build may legitimately contain
  const { sources } = loadSources(root);
  let decorative = 0;
  (function count(v) {
    if (Array.isArray(v)) v.forEach(count);
    else if (v && typeof v === "object") {
      if (v.decorative === true) decorative += 1;
      Object.values(v).forEach(count);
    }
  })(sources.map((s) => s.data));

  let nImg = 0;
  let nSrcset = 0;
  let emptyAlt = 0;
  const ps = pages(siteDir);
  for (const pg of ps) {
    const html = fs.readFileSync(pg.file, "utf8");
    let eager = 0;
    for (const img of elements(html, ["img"])) {
      const a = img.attribs || {};
      const where = pg.url + " <img src=" + JSON.stringify(a.src || "") + ">";
      nImg += 1;
      if (!("alt" in a)) report.add(G, where + ": no alt attribute", 'Every picture needs alt="" (decorative) or a description.');
      if (!a.src) {
        report.add(G, where + ": no src");
        continue;
      }
      if (!fileOk(a.src)) report.add(G, where + ": the file does not exist in the built site");
      for (const c of candidates(a.srcset)) {
        nSrcset += 1;
        if (!fileOk(c.url)) report.add(G, where + ": srcset file " + c.url + " does not exist in the built site");
      }
      const content = CONTENT_SRC.test(a.src);
      if (a.loading === "eager" || /^high$/i.test(a.fetchpriority || "")) eager += 1;
      if (!content) continue;
      if (!/^[1-9]\d*$/.test(a.width || "") || !/^[1-9]\d*$/.test(a.height || "")) report.add(G, where + ": needs numeric width and height (the page jumps while the picture loads)", "width=" + JSON.stringify(a.width) + " height=" + JSON.stringify(a.height));
      if (a.alt === "") emptyAlt += 1;
      if (!a.loading) report.add(G, where + ": needs loading=\"lazy\" (or eager for the top picture)");
      if (a.decoding !== "async") report.add(G, where + ': needs decoding="async"');
      if (a.srcset && !a.sizes) report.add(G, where + ": has a srcset but no sizes (the browser would assume the picture is full width)");
      if (img.parent && img.parent.name === "picture") {
        for (const s of img.parent.children.filter((c) => c.name === "source")) {
          const sa = s.attribs || {};
          if (!sa.type) report.add(G, where + ": <source> without a type");
          if (!sa.sizes) report.add(G, where + ": <source> without sizes");
          for (const c of candidates(sa.srcset)) {
            nSrcset += 1;
            if (!fileOk(c.url)) report.add(G, where + ": <source> file " + c.url + " does not exist in the built site");
          }
        }
      }
    }
    for (const s of elements(html, ["source"])) {
      if (s.parent && s.parent.name === "picture") continue;
      for (const c of candidates((s.attribs || {}).srcset)) if (!fileOk(c.url)) report.add(G, pg.url + " <source>: file " + c.url + " does not exist in the built site");
    }
    for (const v of elements(html, ["video"])) {
      const poster = (v.attribs || {}).poster;
      if (poster && !fileOk(poster)) report.add(G, pg.url + " <video poster=" + JSON.stringify(poster) + ">: the file does not exist in the built site");
    }
    if (eager > 1) report.add(G, pg.url + ": " + eager + " pictures are eager / high priority", "Only one picture per page (the one visitors see first) may skip lazy loading.");
  }
  if (emptyAlt > decorative) {
    report.add(G, emptyAlt + " content pictures have an empty alt but only " + decorative + " are marked decorative in the data", 'Give the others a description, or tick "Decorative picture" for them in the CMS.');
  }

  // weight against the previous markup
  let weightNote = "";
  if (exists(BASELINE_FILE)) {
    const base = readJson(BASELINE_FILE).bytes || {};
    const home = path.join(siteDir, "index.html");
    if (exists(home)) {
      const now = imageBytes(siteDir, fs.readFileSync(home, "utf8"));
      const parts = [];
      for (const k of Object.keys(base)) {
        parts.push(k + " " + now[k] + "/" + base[k]);
        if (now[k] > base[k]) report.add("Page weight", "/ downloads " + now[k] + " bytes of pictures at " + k + ", more than the " + base[k] + " bytes of the hand-made set", "The pipeline must not make the page heavier: check the widths / quality in lib/eleventy/images.js or the sizes in the templates.");
      }
      weightNote = "  picture bytes on / (now/before): " + parts.join(", ");
    }
  } else report.add("Page weight", "scripts/fixtures/images-baseline.json is missing", "Create it with --write-baseline <site built before the pipeline>.");

  report.note("check-images: " + nFiles + " picture file(s) read, " + ps.length + " page(s), " + nImg + " <img>, " + nSrcset + " srcset candidates, " + emptyAlt + " empty alt (" + decorative + " decorative in data)");
  if (weightNote) report.note(weightNote);
  return report.print({ max: 200, okMessage: "OK - every picture exists, has a size and a description, and the home page is no heavier than before" });
}

runMain("check-images", main);
