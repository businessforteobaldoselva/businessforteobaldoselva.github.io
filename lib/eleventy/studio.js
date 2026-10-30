// COVERED Studio (phase 4) - Eleventy plugin, auto-loaded like every file in lib/eleventy/.
//
//   {% cms "how.title", "text" %}   inside an opening tag. Prints NOTHING unless CMS_EDIT=1.
//
// In a normal build this file registers only that no-op shortcode: no transform, no event, no file, so the
// production HTML is byte-identical (proved by studio/guards/check-markers.js). With CMS_EDIT=1 (pull-request
// previews, `npm run studio:build-edit`) it also
//   1. injects ONE <script src="/studio/overlay.js" ...> before </body> of every HTML page,
//   2. writes /studio/overlay.js and /studio/content.json into the output folder,
//   3. fails the build when a template produced an invalid marker.
// See studio/DESIGN.md sections 2 and 3.

const fs = require("fs");
const path = require("path");
const shortcode = require("../../studio/markers/shortcode");

const ROOT = path.resolve(__dirname, "..", "..");
const URL_RE = /^(?:https:\/\/[A-Za-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1))(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/;

function checkedUrl(name, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!URL_RE.test(v)) throw new Error("[studio] " + name + " must be an https:// address or http://localhost[:port], got " + JSON.stringify(v.slice(0, 80)));
  return v;
}

function overlayScript() {
  let mod = null;
  try {
    mod = require("../../studio/overlay/bundle.js");
  } catch (e) {
    if (!e || e.code !== "MODULE_NOT_FOUND" || !/overlay[\/]bundle/.test(String(e.message))) throw e;
  }
  if (mod && typeof mod.bundle === "function") return mod.bundle();
  console.warn("[studio] studio/overlay/bundle.js is missing: writing a stub /studio/overlay.js");
  return '"use strict";\nwindow.CoveredStudioMissing = true;\n';
}

module.exports = function (eleventyConfig) {
  // The shortcode is always registered (templates call it unconditionally); it decides by itself.
  // (lib/reserved-ids.js --check loads this plugin with a stub config that has no addShortcode: nothing to register there.)
  if (typeof eleventyConfig.addShortcode === "function") eleventyConfig.addShortcode("cms", function (ref, kind, opts) {
      return shortcode.cms(ref, kind, opts);
    });

  if (process.env.CMS_EDIT !== "1") return;

  const apiUrl = checkedUrl("STUDIO_API_URL", process.env.STUDIO_API_URL);
  const appUrl = checkedUrl("STUDIO_APP_URL", process.env.STUDIO_APP_URL);
  const tag =
    '<script src="/studio/overlay.js" defer data-studio' +
    (apiUrl ? ' data-api="' + apiUrl + '"' : "") +
    (appUrl ? ' data-app="' + appUrl + '"' : "") +
    ' data-content="/studio/content.json"></script>';

  // Plugins load after .eleventy.js has registered htmlmin, so this transform runs on the minified HTML.
  eleventyConfig.addTransform("studio-overlay", function (content) {
    if (!(this.page.outputPath || "").endsWith(".html") || typeof content !== "string") return content;
    const i = content.lastIndexOf("</body>");
    return i < 0 ? content : content.slice(0, i) + tag + content.slice(i);
  });

  eleventyConfig.on("eleventy.after", async ({ dir, results }) => {
    if (shortcode.problems.length) {
      throw new Error("[studio] invalid markers in templates:\n  " + shortcode.problems.join("\n  "));
    }
    const home = (results || []).find((r) => r && r.url === "/" && r.outputPath);
    const out = path.join(home ? path.dirname(home.outputPath) : path.resolve((dir && dir.output) || "_site"), "studio");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "overlay.js"), overlayScript());
    const { snapshot } = require("../../studio/markers/snapshot");
    fs.writeFileSync(path.join(out, "content.json"), JSON.stringify(snapshot(process.cwd()), null, 1) + "\n");
  });
};
