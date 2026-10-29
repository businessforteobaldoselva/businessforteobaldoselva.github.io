// Design-token filters (src/_data/tokens.json). All the validation lives in lib/tokens.js.
//
//   {{ tokens | tokenVars | safe }}               the "--tk-…: …;" declarations for theme-vars.njk
//   {{ tokens | tokenValue("shape.shadow") }}     one validated number (or word)
//
// tokenVars may be chained into `| safe` because every character of its result is printed by lib/tokens.js
// from clamped numbers and a fixed table of font stacks / radius presets - nothing from the data is pasted.
const T = require("../tokens");

module.exports = function (eleventyConfig) {
  eleventyConfig.addFilter("tokenVars", (tokens) => T.declarations(tokens, "  "));
  eleventyConfig.addFilter("tokenValue", (tokens, key) => T.value(tokens, key));
};
