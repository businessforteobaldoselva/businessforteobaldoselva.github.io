"use strict";
// Selftest scenarios of the Phase 5 UI unit (studio/AI-DESIGN.md 17.3): break one thing at a time in a throwaway copy and
// check that check-ai-overlay.js (and, for the first one, check-overlay.js too) notices, for the right reason. No site build.
//   module.exports = (h) => [ { name, mutate(ws), build, run(ws, siteDir) } ]
// Edits use single-line patterns so they work whatever the line endings of the checkout are.
const path = require("path");

module.exports = (h) => {
  const guard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-ai-overlay.js"), ws.dir, []);
  const overlayGuard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-overlay.js"), ws.dir, []);
  const PANEL = "studio/overlay/ext/ai.js";
  const VIEW = "studio/overlay/ext/ai-view.js";
  const CSS = "studio/overlay/ext/ai.css";
  const DEMO = "studio/overlay/dev/ai-demo.js";
  const rx = (re, to) => (t) => {
    if (!re.test(t)) throw new Error("selftest anchor not found: " + re);
    return t.replace(re, to);
  };
  const scenario = (name, rel, change, has, runner) => ({
    name: "studio AI UI: " + name,
    build: false,
    mutate: (ws) => h.edit(ws, rel, change),
    run: (ws) => h.expectRun(name, (runner || guard)(ws), { code: 1, has }),
  });

  return [
    {
      name: "studio AI UI: control (untouched copy passes check-ai-overlay and check-overlay)",
      build: false,
      run: (ws) => {
        h.expectRun("check-ai-overlay passes on the untouched copy", guard(ws), { code: 0, has: ["check-ai-overlay: OK"] });
        h.expectRun("check-overlay passes on the untouched copy", overlayGuard(ws), { code: 0, has: ["check-overlay: OK"] });
      },
    },
    scenario("a model string goes to innerHTML", PANEL, rx(/var root = el\("div", \{ class: "csx-ai" \}\);/, 'var root = el("div", { class: "csx-ai" }); root.innerHTML = state.instruction;'), ["innerHTML"]),
    scenario("the same break is also caught by the overlay-wide guard", PANEL, rx(/var root = el\("div", \{ class: "csx-ai" \}\);/, 'var root = el("div", { class: "csx-ai" }); root.innerHTML = state.instruction;'), ["innerHTML"], overlayGuard),
    scenario("the panel makes its own network call", PANEL, rx(/function uuid\(\) \{ return studio\.util\.uuid\(\); \}/, 'function uuid() { fetch("/steal"); return studio.util.uuid(); }'), ["references fetch"]),
    scenario("flagged changes are pre-ticked again (defaultChecked trusted)", VIEW, rx(/c\[ch\.id\] = ch\.defaultChecked === true && !ch\.outsideAsk && !ch\.sensitive;/, "c[ch.id] = ch.defaultChecked === true;"), ["flagged changes (outsideAsk / sensitive) must start unticked"]),
    scenario("ticking a change no longer ticks what it needs", VIEW, rx(/if \(on\) closure\(changes, \[id\]\)\.forEach\(/, "if (on) [id].forEach("), ["ticking a change must tick the change it needs"]),
    scenario("the model host name appears in another overlay file", "studio/overlay/ext/help.js", rx(/\/\/ Help panel \("\?"\)/, '// Help panel ("?") api.anthropic.com'), ["mentions api.anthropic.com"]),
    scenario("the key header name appears in the demo server", DEMO, rx(/"use strict";/, '"use strict"; // x-api-key'), ["mentions x-api-key"]),
    scenario("a tag that is not a literal is passed to el()", PANEL, rx(/return el\("h3", \{ class: "csx-ai-h"/, 'return el(text.length > 3 ? "h3" : "script", { class: "csx-ai-h"'), ["el() tag is not a literal from the allowed list"]),
    scenario("the view model touches the document", VIEW, rx(/function oneLine\(s, max\) \{/, "function oneLine(s, max) { void document.title;"), ["must stay pure but references document"]),
    scenario("copy for a state is removed (the allowance message)", VIEW, rx(/\n    off_budget_exhausted: [^\n]*/, ""), ["missing copy: off_budget_exhausted"]),
    scenario("a link target comes straight from the model", PANEL, rx(/href: ask,/, "href: nc.title,"), ["a link target must come from httpUrl() or V.askClaudeUrl()"]),
    scenario("the panel edits the ops the model proposed", VIEW, rx(/ops: JSON\.parse\(JSON\.stringify\(arr\(c\.ops\)\)\)/, "ops: (c.ops = JSON.parse(JSON.stringify(arr(c.ops))))"), ["the panel must never edit the ops the model proposed"]),
    scenario("a lying diff would be shown (the diff law is not checked)", VIEW, rx(/return joinSegs\(diff, \["same", "del"\]\) === before\.text && joinSegs\(diff, \["same", "ins"\]\) === after\.text;/, "return true;"), ["a diff that does not rebuild the texts must be dropped"]),
    scenario("server error text is shown to the person", VIEW, rx(/info\.message = e\[0\] === "x" \? "" : COPY\[e\[0\]\];|info\.message = COPY\[e\[0\]\];/, "info.message = err.message || COPY[e[0]];"), ["shows the server's own words"]),
    scenario("the overlay script budget is raised past the design's limit", "studio/guards/check-overlay.js", rx(/scriptsKiB: 330/, "scriptsKiB: 400"), ["the script budget is 400 KiB"]),
    scenario("a colour pair loses contrast (muted text on white)", CSS, rx(/--csx-muted: #4a5a52;/, "--csx-muted: #9aa8a0;"), ["--csx-muted on --csx-bg"]),
    scenario("the manifest lists the panel before its view model", "studio/overlay/manifest.json", (t) => {
      const a = t.replace(/\s*"ext\/ai-view\.js",/, "");
      if (a === t) throw new Error("selftest anchor not found: ext/ai-view.js");
      return a.replace(/"ext\/ai\.js",/, '"ext/ai.js",\n    "ext/ai-view.js",');
    }, ["ext/ai-view.js must come before ext/ai.js"]),
    scenario("the founders' runbook loses its Describe a change section", "docs/STUDIO-RUNBOOK.md", (t) => t.split("Describe a change").join("Make a change"), ['has no "Describe a change" section']),
  ];
};
