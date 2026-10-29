const fs = require("fs");
const path = require("path");
const sizeOf = require("image-size");
const Image = require("@11ty/eleventy-img");

// Image pipeline for templates.
//
//   {% set im = photo.src | imageInfo %}
//   {{ pic.picture(im, photo.alt, photo.decorative, "(max-width: 780px) 92vw, 420px") }}
//
// `im` is { src, width, height, avif, webp, fallback, fallbackType, fallbackSrc }:
//   src      the path exactly as the editor supplied it ("" if it is not a safe, existing file
//            under /images, or under the site's own /videos folder where a video's cover picture
//            lives - so a bad value can never point the page at anything else; web addresses and
//            other file types are refused). This is the ORIGINAL file, still copied to the site;
//            posters, the share picture and the SVG map keep using it.
//   width/height   the pixel size of the original file (the shape of every variant); the optional
//            arguments are only a fallback (e.g. SVG has no pixel size)
//   avif / webp / fallback   ready-made `srcset` strings ("/img/x-<hash>-480.avif 480w, ...") for
//            AVIF, WebP and the original format (JPEG / PNG / WebP); "" when none were made
//   fallbackType   MIME type of `fallback`; fallbackSrc   the middle-sized fallback file (the <img> src)
//
// How the variants appear (no hand work): before every build ("eleventy.before") the plugin finds
// every /images/... picture that the site's data and pages mention (src/_data, src/pages, src/*.njk),
// and @11ty/eleventy-img resizes each one (480 / 960 / 1600 px wide, never enlarged) into AVIF, WebP
// and its own format. Results are cached in .cache/img/ (git-ignored; Netlify may start with it
// empty - then everything is simply regenerated) under names that contain a hash of the picture's
// bytes, so a replaced picture can never be served stale. After the build ("eleventy.after") exactly
// the files that the built pages mention (and that the optimiser itself wrote) are copied to <output>/img/.
// A picture the optimiser does not know (GIF/SVG, a path the scan missed) just falls back to the plain original.
// A file that is not a picture at all (empty, corrupt) is left out of the pages - never a broken image - and
// scripts/check-images.js fails on it, so the pull request is red until the file is replaced. width/height are
// turned when the photo carries an EXIF "rotate" flag, like the generated copies.
const ROOT = process.cwd();
const SAFE_PATH = /^\/?(images|videos)\/[A-Za-z0-9._\/-]+\.(jpe?g|png|webp|gif|avif|svg)$/i;
const PROCESSABLE = /^images\/[A-Za-z0-9._\/-]+\.(jpe?g|png|webp)$/i;
const MENTION = /\/?images\/[A-Za-z0-9._\/-]+\.(?:jpe?g|png|webp)/gi;
// COVERED_IMG_FAST=1 (set by the throwaway builds of the scripts/ guards, which rebuild the site dozens of times)
// makes one small WebP + original per picture instead of the full set; scripts/check-images.js builds the full set.
const FAST = process.env.COVERED_IMG_FAST === "1";
const WIDTHS = FAST ? [480] : [480, 960, 1600];
const FORMATS = FAST ? ["webp", "auto"] : ["avif", "webp", "auto"];
const CACHE_DIR = path.join(ROOT, ".cache", "img");
const URL_PATH = "/img/";

const none = { src: "", width: 0, height: 0, avif: "", webp: "", fallback: "", fallbackType: "", fallbackSrc: "" };

function listFiles(dir, exts) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => exts.some((e) => f.endsWith(e)))
      .map((f) => path.join(dir, f));
  } catch (e) {
    return [];
  }
}

// Every picture path the content mentions (raw text scan: JSON strings, front matter, markdown).
function referencedPictures() {
  const files = [
    ...listFiles(path.join(ROOT, "src", "_data"), [".json"]),
    ...listFiles(path.join(ROOT, "src", "pages"), [".md"]),
    ...listFiles(path.join(ROOT, "src"), [".njk", ".md"]),
  ];
  const found = new Set();
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch (e) {
      continue;
    }
    for (const m of text.match(MENTION) || []) {
      const rel = m.replace(/^\//, "");
      if (PROCESSABLE.test(rel) && !rel.split("/").includes("..") && fs.existsSync(path.join(ROOT, rel))) found.add(rel);
    }
  }
  return [...found].sort();
}

module.exports = function (eleventyConfig) {
  const manifest = new Map(); // "images/x.jpg" -> eleventy-img metadata
  const failed = new Set(); // "images/x.jpg" that the optimiser could not read (empty / corrupt file): the picture is left out

  eleventyConfig.on("eleventy.before", async () => {
    manifest.clear();
    failed.clear();
    for (const rel of referencedPictures()) {
      try {
        const meta = await Image(path.join(ROOT, rel), {
          widths: WIDTHS,
          formats: FORMATS,
          outputDir: CACHE_DIR,
          urlPath: URL_PATH,
          sharpOptions: { animated: false },
          filenameFormat: (id, src, width, format) => path.basename(src, path.extname(src)) + "-" + id + "-" + width + "." + format,
        });
        manifest.set(rel, meta);
      } catch (e) {
        failed.add(rel);
        console.warn("[images] " + rel + " cannot be read as a picture (" + String(e.message).split("\n")[0] + "); it is left out of the pages - replace the file (npm run check:images fails on it)");
      }
    }
  });

  // Copy the files the built pages actually mention (and only those) next to the built site.
  eleventyConfig.on("eleventy.after", async ({ dir, results }) => {
    const used = new Set();
    for (const r of results || []) {
      for (const m of String((r && r.content) || "").match(/\/img\/[A-Za-z0-9._-]+/g) || []) used.add(m.slice(URL_PATH.length));
    }
    // Only files the optimiser itself wrote may be copied: editor text such as "/img/.." matches the pattern above
    // but is not one of them, and must never reach the file system (or stop the build).
    const known = new Set();
    for (const meta of manifest.values()) for (const list of Object.values(meta)) for (const e of list) known.add(path.basename(e.outputPath || e.url));
    if (!used.size) return;
    // The output folder is whatever --output / dir.output said: read it off the home page's output path.
    const home = (results || []).find((r) => r && r.url === "/" && r.outputPath);
    const root = home ? path.dirname(home.outputPath) : (dir && dir.output) || "_site";
    const out = path.resolve(ROOT, root, "img");
    fs.mkdirSync(out, { recursive: true });
    for (const name of used) {
      if (!known.has(name)) continue;
      try {
        const from = path.join(CACHE_DIR, name);
        if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(out, name));
      } catch (e) {
        console.warn("[images] could not copy " + name + " (" + String(e.message).split("\n")[0] + ")");
      }
    }
  });

  eleventyConfig.addFilter("imageInfo", (value, fallbackW, fallbackH) => {
    const src = typeof value === "string" ? value.trim() : "";
    if (!SAFE_PATH.test(src) || src.split("/").includes("..")) return { ...none };
    const rel = src.replace(/^\//, "");
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return { ...none };
    if (failed.has(rel)) return { ...none };

    let width = 0;
    let height = 0;
    if (!/\.svg$/i.test(file)) {
      try {
        const d = sizeOf(file);
        width = d.width || 0;
        height = d.height || 0;
        // a phone photo is stored sideways with an EXIF "rotate" flag (5-8): the browser shows it turned,
        // and so do the generated copies, so the reserved box must be turned too
        if (d.orientation >= 5 && d.orientation <= 8) [width, height] = [height, width];
      } catch (e) {
        // empty or corrupt file (it is not a picture): leave it out instead of publishing a broken image
        return { ...none };
      }
      if (!width || !height) return { ...none };
    }
    if (!width) width = Number(fallbackW) || 0;
    if (!height) height = Number(fallbackH) || 0;
    const info = { ...none, src, width, height };

    const meta = manifest.get(rel);
    if (!meta) return info;
    const formats = Object.keys(meta);
    const own = formats.find((f) => f !== "avif" && f !== "webp") || (meta.webp ? "webp" : "");
    const set = (key) => {
      const list = meta[key] || [];
      return list.map((e) => e.url + " " + e.width + "w").join(", ");
    };
    info.avif = set("avif");
    // A WebP original already is the WebP set: do not list it twice.
    info.webp = own === "webp" ? "" : set("webp");
    const fb = meta[own] || [];
    if (fb.length) {
      info.fallback = set(own);
      info.fallbackType = fb[0].sourceType;
      info.fallbackSrc = fb[Math.floor((fb.length - 1) / 2)].url;
    }
    return info;
  });
};
