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
// the files that the built pages mention are copied to <output>/img/. A picture that cannot be processed (broken
// file, GIF/SVG, unknown to the scan) just falls back to the plain original: never a broken image.
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

  eleventyConfig.on("eleventy.before", async () => {
    manifest.clear();
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
        console.warn("[images] no optimised copies of " + rel + " (" + String(e.message).split("\n")[0] + "); the original is used");
      }
    }
  });

  // Copy the files the built pages actually mention (and only those) next to the built site.
  eleventyConfig.on("eleventy.after", async ({ dir, results }) => {
    const used = new Set();
    for (const r of results || []) {
      for (const m of String((r && r.content) || "").match(/\/img\/[A-Za-z0-9._-]+/g) || []) used.add(m.slice(URL_PATH.length));
    }
    if (!used.size) return;
    // The output folder is whatever --output / dir.output said: read it off the home page's output path.
    const home = (results || []).find((r) => r && r.url === "/" && r.outputPath);
    const root = home ? path.dirname(home.outputPath) : (dir && dir.output) || "_site";
    const out = path.resolve(ROOT, root, "img");
    fs.mkdirSync(out, { recursive: true });
    for (const name of used) {
      const from = path.join(CACHE_DIR, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, name));
    }
  });

  eleventyConfig.addFilter("imageInfo", (value, fallbackW, fallbackH) => {
    const src = typeof value === "string" ? value.trim() : "";
    if (!SAFE_PATH.test(src) || src.split("/").includes("..")) return { ...none };
    const rel = src.replace(/^\//, "");
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return { ...none };

    let width = 0;
    let height = 0;
    if (!/\.svg$/i.test(file)) {
      try {
        const d = sizeOf(file);
        width = d.width || 0;
        height = d.height || 0;
      } catch (e) {
        /* unreadable image: fall through to the fallback sizes */
      }
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
