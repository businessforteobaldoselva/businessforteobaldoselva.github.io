const markdownIt = require("markdown-it");
const htmlmin = require("html-minifier-terser");

module.exports = function (eleventyConfig) {
  const md = markdownIt({ html: false, linkify: true });
  eleventyConfig.addFilter("md", (value) => (value ? md.render(String(value)) : ""));

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
  eleventyConfig.addPassthroughCopy("admin");
  eleventyConfig.addPassthroughCopy("cms");
  eleventyConfig.addPassthroughCopy("robots.txt");
  eleventyConfig.addPassthroughCopy("llms.txt");
  eleventyConfig.addPassthroughCopy(".well-known");
  eleventyConfig.addPassthroughCopy("feed.xml");

  return {
    dir: {
      input: "src",
      output: "_site",
    },
  };
};
