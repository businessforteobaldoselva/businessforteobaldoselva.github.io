const markdownIt = require("markdown-it");
const htmlmin = require("html-minifier-terser");

module.exports = function (eleventyConfig) {
  const md = markdownIt({ html: false, linkify: true });
  eleventyConfig.addFilter("md", (value) => (value ? md.render(String(value)) : ""));

  // True when the homepage layout (src/_data/homepage.json) contains an
  // enabled section of the given type — used to gate nav/footer anchors.
  eleventyConfig.addFilter("sectionEnabled", (homepage, type) => {
    const sections = homepage && Array.isArray(homepage.sections) ? homepage.sections : [];
    return sections.some((s) => s && s.type === type && s.enabled !== false);
  });

  // Guards CMS-supplied colours (src/_data/theme.json): only a well-formed
  // hex colour is emitted; anything else — including attempted CSS/JS
  // injection — falls back to the shipped default.
  const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  eleventyConfig.addFilter("safeColor", (value, fallback) => {
    const v = typeof value === "string" ? value.trim() : "";
    return HEX_COLOR_RE.test(v) ? v : fallback;
  });

  // Guards CMS-supplied link fields (button links, source URLs): only
  // same-site paths (/…), in-page anchors (#…) and http(s)/mailto URLs are
  // emitted. Anything else — javascript:, data:, protocol-relative //… —
  // falls back to "/", closing off URL-scheme XSS from the CMS.
  eleventyConfig.addFilter("safeUrl", (value) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (!v) return "/";
    if (/^\/(?!\/)/.test(v) || v.startsWith("#")) return v;
    if (/^(https?|mailto):/i.test(v)) return v;
    return "/";
  });

  // Section headings advertised in the CMS as "HTML allowed, e.g. <br />"
  // accept ONLY line breaks: everything is escaped, then <br> variants are
  // restored. Chain with | safe in templates.
  eleventyConfig.addFilter("safeTitle", (value) => {
    const s = value == null ? "" : String(value);
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/&lt;br\s*\/?\s*&gt;/gi, "<br />");
  });

  // Custom-block anchors: re-applies the CMS slug pattern server-side and
  // rejects ids the site already uses (sections, form fields, JS hooks) so an
  // editor-chosen anchor can never shadow a built-in id or break the JS.
  const RESERVED_IDS = new Set([
    "top", "progress", "navlinks", "year", "pack", "stepper",
    "problem", "model", "how", "brands", "partners", "venues", "locations",
    "vision", "faq", "cta",
    "problem-title", "model-title", "how-title", "brands-title",
    "partners-title", "venues-title", "locations-title", "vision-title",
    "faq-title",
    "marqueepause", "herostamp", "phonescreen", "machinescreen",
    "machineslot", "machinestamp", "machinestage", "mappins", "citychips",
    "citydetail", "brandform", "venueform", "notifyform", "adbar",
    "btnscan", "btnverify", "btnreset",
    "bname", "bcompany", "bemail", "bbudget", "btiming", "bmsg",
    "vname", "vvenue", "vemail", "vtype", "vmsg", "nemail",
  ]);
  eleventyConfig.addFilter("safeAnchor", (value) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (!/^[a-z0-9-]+$/.test(v)) return "";
    if (RESERVED_IDS.has(v) || v.startsWith("faq-panel-")) return "";
    return v;
  });

  // hex (#RGB/#RGBA/#RRGGBB/#RRGGBBAA) -> rgba(r, g, b, alpha). Any alpha
  // channel in the source colour is ignored — the caller supplies alpha.
  // Invalid input returns the empty string; always chain after safeColor.
  eleventyConfig.addFilter("hexToRgba", (hex, alpha) => {
    const v = typeof hex === "string" ? hex.trim() : "";
    const m = HEX_COLOR_RE.exec(v);
    if (!m) return "";
    let h = m[1];
    if (h.length <= 4) {
      h = h.split("").map((c) => c + c).join("");
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = typeof alpha === "number" && isFinite(alpha) ? alpha : 1;
    return "rgba(" + r + ", " + g + ", " + b + ", " + a + ")";
  });

  eleventyConfig.addTransform("htmlmin", async function (content) {
    if ((this.page.outputPath || "").endsWith(".html")) {
      try {
        return await htmlmin.minify(content, {
          collapseWhitespace: true,
          conservativeCollapse: true,
          removeComments: true,
          minifyCSS: true,
          minifyJS: true,
        });
      } catch (e) {
        console.warn("[htmlmin] skipped:", e.message);
        return content;
      }
    }
    return content;
  });

  eleventyConfig.addPassthroughCopy("images");
  eleventyConfig.addPassthroughCopy("fonts");
  eleventyConfig.addPassthroughCopy("admin");
  eleventyConfig.addPassthroughCopy("cms");
  eleventyConfig.addPassthroughCopy("robots.txt");
  eleventyConfig.addPassthroughCopy("llms.txt");
  eleventyConfig.addPassthroughCopy(".well-known");
  eleventyConfig.addPassthroughCopy("feed.xml");
  // Scroll-scrub hero frame sequences (ffmpeg-exported stills painted onto a
  // <canvas>). Root-level like images/, so they serve at /frames/… on both
  // GitHub Pages (root) and Netlify (_site).
  eleventyConfig.addPassthroughCopy("frames");
  eleventyConfig.addPassthroughCopy("videos");

  return {
    dir: {
      input: "src",
      output: "_site",
    },
  };
};
