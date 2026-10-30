"use strict";
// Self-test scenarios for unit C (the overlay): each breaks a throwaway copy of the repo in one way and requires
// check-overlay (studio/guards/check-overlay.js) to fail for the right reason. Loaded by scripts/selftest.js.
const path = require("path");

module.exports = (h) => {
  const guard = (ws, args) => h.runScript(path.join(ws.dir, "studio", "guards", "check-overlay.js"), ws.dir, args);
  const append = (rel, code) => (text) => text.replace(/\}\)\(window\.__CoveredStudioBoot\);\s*$/, code + "\n})(window.__CoveredStudioBoot);\n");
  const broken = (name, rel, fn, has) => ({
    name: "overlay: " + name,
    mutate: (ws) => h.edit(ws, rel, fn),
    run(ws) {
      h.expectRun("check-overlay catches it", guard(ws), { code: 1, has });
    },
  });
  return [
    {
      name: "overlay: control - the untouched overlay passes check-overlay",
      mutate: () => {},
      run(ws) {
        h.expectRun("check-overlay is green on the real overlay", guard(ws), { code: 0, has: ["check-overlay: OK"] });
      },
    },
    broken("an editor-text path gains innerHTML", "studio/overlay/ui/panel-changes.js", append("", 'var __x = document.createElement("div"); __x.innerHTML = "<b>" + 1 + "</b>";'), ["uses .innerHTML"]),
    broken("an HTML parser is smuggled in via insertAdjacentHTML", "studio/overlay/ui/inspect.js", append("", 'document.body.insertAdjacentHTML("beforeend", "<i>x</i>");'), ["insertAdjacentHTML"]),
    broken("eval and new Function appear", "studio/overlay/core/util.js", append("", 'eval("1"); new Function("return 1");'), ["uses eval", "uses new Function"]),
    broken("a script element is created", "studio/overlay/ui/editors.js", append("", 'document.createElement("script");'), ["createElement(script)"]),
    broken("a CDN script URL is added", "studio/overlay/main.js", append("", 'var __u = "https://cdn.jsdelivr.net/npm/lodash@4/lodash.min.js";'), ["URL to a third-party host: https://cdn.jsdelivr.net"]),
    broken("a second fetch call site appears in a UI file", "studio/overlay/ui/panel-account.js", append("", 'fetch("/x");'), ["fetch outside core/api-client.js and core/util.js"]),
    broken("postMessage to any origin", "studio/overlay/core/auth.js", append("", 'window.opener.postMessage({ a: 1 }, "*");'), ["postMessage to the wildcard origin"]),
    broken("an inline event handler property is assigned", "studio/overlay/ui/shell.js", append("", 'var __b = document.createElement("div"); __b.onclick = function () {};'), ["touches .onclick"]),
    broken("a muted text colour that no longer reads (light mode)", "studio/overlay/overlay.css", (t) => t.replace("--s-muted: #454545;", "--s-muted: #b5b5b5;"), ["light mode: --s-muted on --s-bg"]),
    broken("the focus ring is removed", "studio/overlay/overlay.css", (t) => t.replace("button:focus-visible, input:focus-visible", "button:hover, input:hover").replace(/\[tabindex\]:focus-visible/, "[tabindex]:hover").replace(/:focus-visible/g, ":hover"), ["no :focus-visible rule"]),
    broken("a module escapes the shared IIFE", "studio/overlay/core/events.js", (t) => t.replace("(function (S) {", "(function (S, extra) {"), ["must be an IIFE"]),
  ];
};
