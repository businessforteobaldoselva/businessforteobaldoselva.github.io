const fs = require("fs");
const path = require("path");

// Filters for the "problem" and "model" sections (src/_includes/sections/problem.njk, model.njk).
// Each one turns an editor-supplied value into something that is safe by
// construction, so a bad value can never break the page.
const ROOT = process.cwd();
const SAFE_VIDEO = /^\/?(images|videos)\/[A-Za-z0-9._\/-]+\.(mp4|webm|m4v)$/i;

module.exports = function (eleventyConfig) {
  // Polaroid rotation. Editors enter degrees as a number; anything that is not
  // a finite number becomes 0, and the angle is held between -10 and 10 so a
  // photo can never be rotated out of its card. Old "-3deg" strings still work.
  //   style="--tilt: {{ photo.tilt | storyTilt }}deg;"
  eleventyConfig.addFilter("storyTilt", (value) => {
    const n = parseFloat(value);
    if (!isFinite(n)) return 0;
    return Math.max(-10, Math.min(10, n));
  });

  // Repeats a list of words N times (the conveyor belt strip). N is held
  // between 1 and 12 so a stray value can never explode the page.
  //   {% for word in model.belt.words | storyRepeat(model.belt.repeats) %}
  eleventyConfig.addFilter("storyRepeat", (list, times) => {
    const words = Array.isArray(list) ? list : [];
    let n = Math.floor(Number(times));
    if (!isFinite(n) || n < 1) n = 1;
    if (n > 12) n = 12;
    const out = [];
    for (let i = 0; i < n; i++) out.push(...words);
    return out;
  });

  // A video file from the site's own media folders. Returns the path exactly
  // as given, or "" when it is not a plain .mp4/.webm/.m4v path under
  // /images or /videos that exists on disk (so nothing else can be pointed at).
  //   {% set vsrc = model.video.src | storyVideo %}
  eleventyConfig.addFilter("storyVideo", (value) => {
    const src = typeof value === "string" ? value.trim() : "";
    if (!SAFE_VIDEO.test(src) || src.split("/").includes("..")) return "";
    return fs.existsSync(path.join(ROOT, src.replace(/^\//, ""))) ? src : "";
  });
};
