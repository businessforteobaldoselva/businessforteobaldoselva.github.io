"use strict";
// Phase 1 placeholder, owned by the REVIEW unit (studio/PHASE1-DESIGN.md sections 2 and 13): parses the review-related
// environment variables into config.review. Pure (plain values only), portable, throws ConfigError on a malformed value.
// loadConfig() in config.js already calls load(env); BACKEND owns config.js, REVIEW owns THIS file and fills load().

function load(env) {
  void env;
  return { reviewers: [], previewEmbed: false, siteUrl: "", reviewBaseUrl: "", settlingMinutes: 10 };
}

module.exports = { load };
