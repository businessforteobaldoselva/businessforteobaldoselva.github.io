/* COVERED - the redirect rules, shared by the build and the CMS.
   One plain UMD file with no dependencies:
     - lib/eleventy/seo.js loads it with require() and writes the Netlify _redirects file from the result;
     - cms/index.html loads it with a <script> tag and the "Redirects" preview (cms/previews.js) uses the
       very same function to mark every rule the website will leave out, with the same reason.
   It only does string tests: no network, no DOM, no eval, and it never produces HTML. Tested by
   scripts/check-seo.js (rule battery, fuzzing, hostile builds). */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.CoveredRedirects = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SITE_HOSTS = ["coveredaccess.com", "www.coveredaccess.com"];

  // Websites a redirect may send visitors to (besides this site). A redirect starts on OUR address, so a
  // lookalike or hostile target would carry our good name: every host needs a developer's approval here
  // (a change to this file is reviewed like any code change). Exact host names only, lower case.
  var EXTERNAL_HOSTS = {
    "example.org": "IANA-reserved documentation domain, used by the guards' fixtures; it can never serve anything",
  };

  // One rule per line of the Netlify _redirects file:   /old-address  /new-address  301
  // Only plain paths and https addresses; no wildcards, no :placeholders, no query on the old address,
  // no status other than 301 / 302 (so no 200 "rewrite" that could proxy another site through ours).
  var FROM_RE = /^\/[A-Za-z0-9._~%+-][A-Za-z0-9._~\/%+-]*$/;
  var TO_PATH_RE = /^\/(?!\/)[A-Za-z0-9._~\/%+=?#-]*$/;
  var TO_ABS_RE = /^https:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(:\d{1,5})?(\/[A-Za-z0-9._~\/%+=?#-]*)?$/;
  // Addresses the redirect may not start from: the editor itself, the platform's own folders, and files
  // search engines expect to find.
  var RESERVED_FROM = /^\/(cms|admin|\.netlify|\.well-known|assets|fonts|images|videos|frames)(\/|$)|^\/(feed\.xml|sitemap\.xml|robots\.txt|llms\.txt|_redirects|_headers)$/i;
  // a dot-segment hidden as %2e, or an encoded slash / backslash
  var ENCODED_TRICK = /(^|\/)(%2e|\.){1,2}(\/|$)|%2f|%5c/i;
  var MAX_RULES = 100;
  var MAX_CHAIN = 5;

  function norm(p) {
    return (p.length > 1 ? p.replace(/\/+$/, "") : p).toLowerCase();
  }
  function isSiteHost(h) {
    return SITE_HOSTS.indexOf(h.toLowerCase()) >= 0;
  }
  function isApprovedHost(h) {
    return Object.prototype.hasOwnProperty.call(EXTERNAL_HOSTS, h.toLowerCase());
  }

  // analyse(items, opts) -> { lines: ["/old /new 301", ...], dropped: [{ index, reason }], ineffective: [{ index, reason }] }
  //   dropped      rules that are left out of the file
  //   ineffective  rules that are written but never fire (opts.pages: an object whose keys are the normalised paths of the pages that exist)
  function analyse(items, opts) {
    var lines = [];
    var dropped = [];
    var ineffective = [];
    var pages = opts && opts.pages ? opts.pages : null;
    var target = {}; // normalised from -> normalised internal target ("" for an external one)
    var has = function (k) {
      return Object.prototype.hasOwnProperty.call(target, k);
    };
    var list = Array.isArray(items) ? items : [];
    list.forEach(function (it, index) {
      var drop = function (reason) {
        dropped.push({ index: index, reason: reason });
      };
      if (lines.length >= MAX_RULES) return drop("more than " + MAX_RULES + " redirects: only the first " + MAX_RULES + " work");
      if (!it || typeof it !== "object" || Array.isArray(it)) return drop("not a redirect");
      var from = typeof it.fromLink === "string" ? it.fromLink.trim() : "";
      var to = typeof it.toLink === "string" ? it.toLink.trim() : "";
      if (!from || !to) return drop("the old or the new address is empty");
      if (from.length > 200 || to.length > 300) return drop("address too long");
      if (!FROM_RE.test(from) || /(^|\/)\.\.?(\/|$)/.test(from) || from.indexOf("//") >= 0) return drop("the old address must be a plain path such as /old-page/ (letters, numbers, dashes, dots; no wildcards, spaces or ?)");
      if (ENCODED_TRICK.test(from)) return drop("the old address may not contain encoded dots or slashes (%2e, %2f)");
      if (RESERVED_FROM.test(from)) return drop("the old address is a protected part of the site (the editor, images, fonts, sitemap ...)");
      // an address on the site's own domain becomes a path, so loops are always visible
      var own = /^https:\/\/([A-Za-z0-9.-]+)(\/.*)?$/.exec(to);
      if (own && isSiteHost(own[1])) to = own[2] || "/";
      var internal = true;
      if (TO_PATH_RE.test(to)) {
        var plain = to.split(/[?#]/)[0];
        if (/(^|\/)\.\.?(\/|$)/.test(plain) || plain.indexOf("//") >= 0) return drop("the new address may not contain .. or //");
        if (ENCODED_TRICK.test(plain)) return drop("the new address may not contain encoded dots or slashes (%2e, %2f)");
      } else {
        var abs = TO_ABS_RE.exec(to);
        if (!abs || /(^|\/)\.\.(\/|$)/.test(to) || to.indexOf("//", 8) >= 0) return drop("the new address must be a path on this site (/page/) or a full https:// address");
        if (abs[2]) return drop("the new address may not name a port number");
        if (!isApprovedHost(abs[1])) return drop("the website " + abs[1].toLowerCase() + " is not on the approved list for redirects: ask the person who looks after the site to approve it first");
        if (ENCODED_TRICK.test(abs[3] || "")) return drop("the new address may not contain encoded dots or slashes (%2e, %2f)");
        internal = false;
      }
      var key = norm(from);
      if (has(key)) return drop("this old address is already redirected by an earlier rule");
      if (internal) {
        var dest = norm(to.split(/[?#]/)[0]);
        if (dest === key) return drop("sends the page to itself");
        // follow the chain from the new address; coming back to the old address would be a loop
        var cur = dest;
        var depth = 1;
        while (has(cur) && target[cur]) {
          cur = target[cur];
          depth += 1;
          if (cur === key) return drop("would create a redirect loop");
          if (depth > MAX_CHAIN) break;
        }
        if (depth > MAX_CHAIN) return drop("would create a chain of more than " + MAX_CHAIN + " redirects");
        target[key] = dest;
      } else target[key] = "";
      lines.push(from + " " + to + " " + (it.permanent === false ? 302 : 301));
      if (pages && Object.prototype.hasOwnProperty.call(pages, key)) ineffective.push({ index: index, reason: "a page already exists at this old address, and a real page always wins, so this rule never fires" });
    });
    return { lines: lines, dropped: dropped, ineffective: ineffective };
  }

  return { analyse: analyse, norm: norm, SITE_HOSTS: SITE_HOSTS, EXTERNAL_HOSTS: EXTERNAL_HOSTS, FROM_RE: FROM_RE, TO_PATH_RE: TO_PATH_RE, TO_ABS_RE: TO_ABS_RE, RESERVED_FROM: RESERVED_FROM, MAX_RULES: MAX_RULES, MAX_CHAIN: MAX_CHAIN };
});
