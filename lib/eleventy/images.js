const fs = require("fs");
const path = require("path");
const sizeOf = require("image-size");

// Image helper for templates.
//
//   {% set im = photo.src | imageInfo(photo.width, photo.height) %}
//
// `im` is { src, width, height, webp, webp480 }:
//   src      the path exactly as the editor supplied it ("" if it is not a
//            safe, existing file under /images, or under the site's own
//            /videos folder where a video's cover picture lives — so a bad
//            value can never point the page at anything else; web addresses
//            and other file types are refused)
//   width/height   read from the file itself; the optional arguments are only
//            a fallback (e.g. SVG, which has no pixel size)
//   webp / webp480   sibling "x.webp" / "x-480.webp" files, or "" when they do
//            not exist. Templates must only emit <source type="image/webp">
//            when these are non-empty, otherwise a freshly uploaded photo with
//            no WebP copy would render as a broken image.
const ROOT = process.cwd();
const SAFE_PATH = /^\/?(images|videos)\/[A-Za-z0-9._\/-]+\.(jpe?g|png|webp|gif|avif|svg)$/i;

module.exports = function (eleventyConfig) {
  eleventyConfig.addFilter("imageInfo", (value, fallbackW, fallbackH) => {
    const none = { src: "", width: 0, height: 0, webp: "", webp480: "" };
    const src = typeof value === "string" ? value.trim() : "";
    if (!SAFE_PATH.test(src) || src.split("/").includes("..")) return none;
    const file = path.join(ROOT, src.replace(/^\//, ""));
    if (!fs.existsSync(file)) return none;
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
    const variant = (suffix) => {
      if (!/\.(jpe?g|png)$/i.test(src)) return "";
      const rel = src.replace(/\.(jpe?g|png)$/i, suffix);
      return fs.existsSync(path.join(ROOT, rel.replace(/^\//, ""))) ? rel : "";
    };
    return { src, width, height, webp: variant(".webp"), webp480: variant("-480.webp") };
  });
};
