"use strict";
// Selftest scenarios for the EDIT unit's guard (check-content-rules.js, studio/PHASE1-DESIGN.md 15): break one promise at a time in a
// throwaway copy and expect the guard to say so. Every rule is switched off in turn, so a rule that stops working cannot slip through.
const path = require("path");

module.exports = (h) => {
  const guard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-content-rules.js"), ws.dir, []);
  const scenario = (name, rel, change, has) => ({
    name: "content rules: " + name,
    build: false,
    mutate: (ws) => h.edit(ws, rel, change),
    run: (ws) => h.expectRun(name, guard(ws), { code: 1, has }),
  });
  const RULES = "studio/content-rules/rules.js";
  // switch one rule's check off: return [] as the first statement of its function
  const disable = (id) => (t) => {
    const reg = t.indexOf('register("' + id + '"');
    const at = reg >= 0 ? t.indexOf("function (ctx) {", reg) : -1;
    if (at < 0) throw new Error("selftest: cannot find rule " + id);
    return t.slice(0, at + "function (ctx) {".length) + " return [];" + t.slice(at + "function (ctx) {".length);
  };
  const ids = ["alt-missing", "alt-weak", "broken-internal-link", "description-length", "duplicate-text", "heading-skip", "image-heavy", "page-weight", "vague-link-text"];
  const list = [
    { name: "content rules: control (untouched copy passes check-content-rules)", build: false, run: (ws) => h.expectRun("check-content-rules passes on the untouched copy", guard(ws), { code: 0, has: ["check-content-rules: OK"] }) },
  ];
  for (const id of ids) list.push(scenario("rule " + id + " is switched off", RULES, disable(id), ["rule " + id, "no longer flags its own known-bad example"]));
  // title-length is made by a helper shared with nothing else: break the helper's role test instead
  list.push(scenario("rule title-length is switched off", RULES, h.replaceOnce('if (typeof l.value !== "string" || roleOf(ctx, l.file, l.field.name) !== roleName) return;', "return;"), ["rule title-length", "no longer flags its own known-bad example"]));
  list.push(
    scenario("a block finding appears in the content and is not in the baseline", "src/_data/nav.json", h.replaceOnce('"url": "/about/"', '"url": "/no-such-page/"'), ["broken-internal-link|nav|", "there is no page at that address"]),
    scenario("the baseline lists a block that is gone (the ratchet only goes down)", "studio/content-rules/baseline.json", h.replaceOnce('"blocked": []', '"blocked": ["alt-missing|how|/story/9/alt"]'), ["no longer occurs: remove it"]),
    scenario("the facts lose their routes (the link rules go blind)", "studio/content-rules/facts-node.js", h.replaceOnce('const routes = ["/"].concat(', 'const routes = [].concat('), ["no routes"]),
    scenario("a role-named schema field is not mapped", "studio/content-rules/field-roles.json", h.replaceOnce('    "*:title": "heading",\n', ""), ["is named like a content role but is not mapped"]),
    scenario("a role entry points at nothing", "studio/content-rules/field-roles.json", h.replaceOnce('"*:q": "heading",', '"*:q": "heading",\n    "*:nothingLikeThis": "ignore",'), ["matches no schema field"]),
    scenario("Ignore is offered for a block finding", "studio/overlay/ext/checks.js", h.replaceOnce('return !!f && f.severity !== "block";', "return !!f;"), ["a block finding can be ignored"]),
    scenario('"Send for review" is no longer refused for a new block', "studio/overlay/ext/checks.js", h.replaceOnce("return summary.blockers.length ? {", "return false ? {"), ['"Send for review" is not refused']),
    scenario("ignoring a block lets the draft through", "studio/overlay/ext/checks.js", (t) => h.replaceOnce('ignored: canIgnore(f) && ign[f.key] === 1', 'ignored: ign[f.key] === 1')(h.replaceOnce('var blockers = rows.filter(function (r) { return r.finding.severity === "block" && !r.existing; });', 'var blockers = rows.filter(function (r) { return r.finding.severity === "block" && !r.existing && !r.ignored; });')(t)), ["ignoring a block finding lets the draft through"]),
    scenario("the panel loses its disclaimer", "studio/overlay/ext/checks.js", h.replaceOnce("They are not a full accessibility audit.", "They make your page accessible."), ["the sub-line must say"]),
    scenario("the panel claims WCAG", "studio/overlay/ext/checks.js", h.replaceOnce('var HEADER = "Check my changes";', 'var HEADER = "Check my changes"; // WCAG'), ["mentions WCAG"]),
    scenario("the legend count is off by one", "studio/overlay/ext/legend.js", h.replaceOnce("      seen[m.ref] = 1;\n      n += 1;\n    });\n    return n;", "      seen[m.ref] = 1;\n      n += 1;\n    });\n    return n + 1;"), ["countEditable must count distinct refs"]),
    scenario("the legend counts a section wrapper", "studio/overlay/ext/legend.js", h.replaceOnce("var LEAF = { text: 1,", "var LEAF = { section: 1, text: 1,"), ["countEditable must count distinct refs"]),
    scenario("the AI estimate is asked on every keystroke", "studio/overlay/ext/ai.js", h.replaceOnce("}, 600);\n      }\n      function syncSubmit", "}, 0);\n      }\n      function syncSubmit"), ["debounce of at least 400 ms"]),
    scenario("the palette search reaches for the network", "studio/overlay/ext/palette.js", h.replaceOnce("      fieldRowsCache = rows;\n      return rows;", '      studio.api.get("/v1/ping");\n      fieldRowsCache = rows;\n      return rows;'), ["may call the API only in loadHistory"]),
    scenario("the palette loses its footer line", "studio/overlay/ext/palette.js", h.replaceOnce('"Up/Down to move, Enter to run, Esc to close, ? for help"', '"Up and Down to choose"'), ["footer line is missing"])
  );
  return list;
};
