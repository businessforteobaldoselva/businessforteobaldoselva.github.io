"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../overlay/ext/palette.js");

const CMDS = [
  { id: "draft.save", title: "Save draft", keywords: ["save", "keep"], group: "Draft" },
  { id: "draft.publish", title: "Publish", keywords: ["go live", "approve"], group: "Draft" },
  { id: "panel.history", title: "Open History", keywords: ["undo", "restore", "revert", "past"], group: "Go" },
  { id: "panel.help", title: "Open Help", keywords: ["guide", "shortcuts"], group: "Go" },
  { id: "mode.toggle", title: "Toggle edit mode", keywords: ["edit", "browse"], group: "View" },
  { id: "edit.site.ogImage", title: "Edit Share picture", keywords: ["change", "picture photo image", "site og image"], group: "Edit this page" },
  { id: "edit.hero.headlineMain", title: "Edit Hero > Headline", keywords: ["change", "text"], group: "Edit this page" },
  { id: "toggle.section.1", title: "Hide Partners", keywords: ["section", "switch"], group: "Sections" },
  { id: "go.section.1", title: "Go to Partners", keywords: ["section", "jump"], group: "Sections" },
  { id: "account.signout", title: "Sign out", keywords: ["log out", "logout"], group: "Account" },
];
const top = (q, n) => P.search(CMDS, q, n || 8).map((c) => c.id);

test("empty query returns the first items in the given order, capped", () => {
  assert.deepEqual(top("", 3), ["draft.save", "draft.publish", "panel.history"]);
  assert.equal(P.search(CMDS, "", 8).length, 8);
});

test("prefix and word matches rank first", () => {
  assert.equal(top("hist")[0], "panel.history");
  assert.equal(top("save")[0], "draft.save");
  assert.deepEqual(top("partners").sort(), ["go.section.1", "toggle.section.1"]);
});

test("fuzzy (subsequence) match works for 3+ letters, not for noise", () => {
  assert.equal(top("hlp")[0], "panel.help");
  assert.equal(top("pbl")[0], "draft.publish");
  assert.deepEqual(top("zzq"), []);
  assert.deepEqual(top("xy"), []);
});

test("every word must match (AND)", () => {
  assert.deepEqual(top("hide partners"), ["toggle.section.1"]);
  assert.deepEqual(top("hide nothing"), []);
});

test("a founder's words reach our commands (synonyms and stop words)", () => {
  assert.equal(top("change the logo")[0], "edit.site.ogImage");
  assert.equal(top("headline")[0], "edit.hero.headlineMain");
  assert.equal(top("undo")[0], "panel.history");
  assert.equal(top("go live")[0], "draft.publish");
  assert.equal(top("log out")[0], "account.signout");
  assert.equal(top("remove partners")[0], "toggle.section.1");
});

test("exact title beats a partial one", () => {
  assert.equal(top("publish")[0], "draft.publish");
  assert.equal(top("sign out")[0], "account.signout");
});

test("scoring ignores case and punctuation and never throws on odd input", () => {
  assert.equal(top("  HISTORY!! ")[0], "panel.history");
  for (const q of ["(((", "\\", "a".repeat(5000), "\u0000", "<img>"]) assert.ok(Array.isArray(P.search(CMDS, q)));
});

test("generated section commands name sections and reflect enabled state", () => {
  const cmds = P.sectionCommands([{ type: "hero", enabled: true }, { type: "how-it-works", enabled: false }], (i) => (i === 0 ? "Hero" : null));
  assert.deepEqual(cmds.map((c) => c.title), ["Go to Hero", "Hide Hero", "Go to How it works", "Show How it works"]);
  assert.equal(cmds[1].ref, "homepage.sections.0.enabled");
});

test("generated field commands: unique, editable kinds only, capped", () => {
  const marks = [{ ref: "a.b", kind: "text" }, { ref: "a.b", kind: "text" }, { ref: "x", kind: "section" }, { ref: "c.d", kind: "image" }];
  const cmds = P.fieldCommands(marks, (r) => (r === "c.d" ? "Share picture" : null));
  assert.deepEqual(cmds.map((c) => c.title), ["Edit a.b", "Edit Share picture"]);
  assert.equal(P.fieldCommands(Array.from({ length: 300 }, (_, i) => ({ ref: "f." + i, kind: "text" })), null, 80).length, 80);
});

test("mergeById keeps the first of each id", () => {
  assert.deepEqual(P.mergeById([[{ id: "a", t: 1 }], [{ id: "a", t: 2 }, { id: "b" }]]).map((c) => c.t || c.id), [1, "b"]);
});
