// Filters for the hero / ticker / closing-banner unit (loaded automatically by .eleventy.js).

module.exports = function (eleventyConfig) {
  // Turns an editor-supplied email subject line into the value that follows
  // "?subject=" in a mailto: link.
  //
  // Every ASCII character that is not unreserved (space, & ? # = % + quotes,
  // control characters ...) is percent-encoded, so an editor can never add a
  // second mailto header such as "&cc=..." or "&body=...". Non-ASCII text
  // (an em dash, accents, emoji) is left as it is, exactly as the template
  // always emitted it for "COVERED — Hello". Chain it after nothing else:
  //   mailto:{{ email }}?subject={{ sectionData.emailSubject | ctaMailtoSubject }}
  eleventyConfig.addFilter("ctaMailtoSubject", (value) => {
    const s = value == null ? "" : String(value);
    return s.replace(/[^A-Za-z0-9\-._~\u{0080}-\u{10FFFF}]/gu, (c) => {
      return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    });
  });
};
