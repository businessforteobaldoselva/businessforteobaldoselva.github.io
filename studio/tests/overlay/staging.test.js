"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeStaging, plain } = require("./load");

test("set stages a value, undo and redo walk the log, setting it back leaves no change", () => {
  const { st } = makeStaging();
  assert.equal(st.count(), 0);
  assert.equal(st.set("hero.headlineMain", "We cover the UK").ok, true);
  assert.equal(st.get("hero.headlineMain"), "We cover the UK");
  assert.equal(st.base("hero.headlineMain"), "We're covering the UK,");
  assert.equal(st.count(), 1);
  assert.equal(st.canUndo(), true);
  st.undo();
  assert.equal(st.get("hero.headlineMain"), "We're covering the UK,");
  assert.equal(st.count(), 0);
  st.redo();
  assert.equal(st.get("hero.headlineMain"), "We cover the UK");
  st.set("hero.headlineMain", "We're covering the UK,");
  assert.equal(st.count(), 0, "editing back to the original is no change");
});

test("typing in the same field is one undo step", () => {
  const { st } = makeStaging();
  st.set("hero.badge", "A");
  st.set("hero.badge", "AB");
  st.set("hero.badge", "ABC");
  assert.equal(st._log().length, 1);
  st.undo();
  assert.equal(st.get("hero.badge"), "Now in 12 venues");
});

test("moves and removes are addressed in base coordinates, so later edits stay attached", () => {
  const { st } = makeStaging();
  st.move("homepage.sections", 3, 0); // problem to the top
  assert.deepEqual(plain(st.orderOf("homepage.sections").map((o) => o.tag)), [3, 0, 1, 2]);
  // the page marker for the FAQ section says homepage.sections.2 - still the faq after the move
  st.set("homepage.sections.2.enabled", false);
  const w = plain(st._working().homepage.sections);
  assert.deepEqual(w.map((s) => s.type), ["problem", "hero", "how", "faq"]);
  assert.equal(w[3].enabled, false);
  assert.equal(st.get("homepage.sections.2.enabled"), false);
  st.set("how.story.2.title", "Third");
  st.remove("how.story.0");
  assert.equal(st.get("how.story.2.title"), "Third");
  assert.equal(st.get("how.story.0"), undefined);
  assert.equal(st.removedItem("how.story.0"), true);
});

test("one undo reverts a whole picture swap (picture, description and decorative flag are one group)", async () => {
  const blob = new Blob([new Uint8Array([255, 216, 255, 224, 1, 2])], { type: "image/jpeg" });
  const { st } = makeStaging();
  await st.setImage("how.story.1.image", blob, { processed: true, name: "new-pic-ab12c.jpg", alt: "A bright bathroom", altRef: "how.story.1.alt", decorative: false, decorativeRef: "how.story.1.decorative" });
  assert.equal(st.get("how.story.1.image"), "new-pic-ab12c.jpg");
  assert.equal(st.get("how.story.1.alt"), "A bright bathroom");
  assert.equal(st.get("how.story.1.decorative"), false);
  assert.ok(st.uploadFor("new-pic-ab12c.jpg"));
  st.undo();
  assert.equal(st.get("how.story.1.image"), "story-2.svg");
  assert.equal(st.get("how.story.1.alt"), "A phone showing an advert");
  assert.equal(st.count(), 0);
});

test("discard(ref) drops only entries touching that ref; clear() drops everything unsaved", () => {
  const { st } = makeStaging();
  st.set("hero.badge", "X");
  st.set("hero.subhead", "Y");
  assert.equal(st.discard("hero.badge"), true);
  assert.equal(st.get("hero.badge"), "Now in 12 venues");
  assert.equal(st.get("hero.subhead"), "Y");
  st.clear();
  assert.equal(st.count(), 0);
});

test("refuses absurd values and unknown refs", () => {
  const { st } = makeStaging();
  assert.equal(st.set("hero.badge", "x".repeat(200000)).ok, false);
  assert.equal(st.set("nope.thing", "x").ok, false);
  assert.equal(st.add().ok, false);
});

test("persistence: the log (not picture bytes) is saved per key and restored; saved entries are not persisted", async () => {
  const { S, st, storage, fx, sc, mem } = makeStaging();
  st.set("hero.badge", "Persist me");
  st.move("homepage.sections", 1, 2);
  st.flush();
  const raw = JSON.parse(mem.get("k1"));
  assert.equal(raw.v, 1);
  assert.equal(raw.ops.length, 2);
  const again = S.stagingLib.create({ files: fx.content.files, schemaClient: sc, storage, storeKey: "k1", emit() {} });
  const r = await again.load();
  assert.equal(r.restored, 2);
  assert.equal(again.get("hero.badge"), "Persist me");
  assert.deepEqual(plain(again.orderOf("homepage.sections").map((o) => o.tag)), [0, 2, 1, 3]);
  st.markSaved();
  st.flush();
  assert.equal(mem.has("k1"), false, "nothing unsaved left to keep");
});

test("a change made against an older base is flagged stale on load", async () => {
  const { S, st, storage, fx, sc } = makeStaging();
  st.set("hero.badge", "Mine");
  st.flush();
  const newer = JSON.parse(JSON.stringify(fx.content.files));
  newer.hero.data.badge = "Someone else changed this";
  const again = S.stagingLib.create({ files: newer, schemaClient: sc, storage, storeKey: "k1", emit() {} });
  const r = await again.load();
  assert.equal(r.stale, 1);
  assert.equal(again.staleCount(), 1);
});

test("after markSaved the diff is empty, saved entries cannot be undone, new edits diff against the saved state", () => {
  const { st } = makeStaging();
  st.set("hero.badge", "One");
  st.move("homepage.sections", 0, 1);
  st.markSaved();
  assert.equal(st.count(), 0);
  assert.equal(st.undo(), false);
  st.set("hero.badge", "Two");
  const ops = plain(st.diff().map((o) => ({ op: o.op, path: o.path, expect: o.expect, value: o.value })));
  assert.deepEqual(ops, [{ op: "replace", path: "/badge", expect: "One", value: "Two" }]);
});

test("conflict helpers: refs from head pointers, adopting the other person's value", () => {
  const { st } = makeStaging();
  st.move("how.story", 2, 0);
  st.markSaved();
  // head order is now [story 2, story 0, story 1]; head index 0 is page ref how.story.2
  assert.equal(st.refFromPointer("how", "/story/0/title", "head"), "how.story.2.title");
  assert.equal(st.adoptRemote("how", "/story/0/title", "Theirs"), true);
  st.set("how.story.2.title", "Mine");
  const ops = plain(st.diff().map((o) => ({ path: o.path, expect: o.expect, value: o.value })));
  assert.deepEqual(ops, [{ path: "/story/0/title", expect: "Theirs", value: "Mine" }]);
});

test("when the browser cannot keep the edits, staging says so (and says when it can again)", () => {
  const { st, mem, storage, events } = makeStaging();
  let works = false;
  storage.set = (k, v) => { if (works) mem.set(k, v); return works; };
  st.set("hero.badge", "Edited");
  st.flush();
  assert.equal(st.unsafeToLeave(), true, "unsaved edit and no storage: leaving would lose it");
  assert.deepEqual(events.filter((e) => e[0] === "storage:state").map((e) => e[1].kept), [false]);
  st.flush();
  assert.equal(events.filter((e) => e[0] === "storage:state").length, 1, "one warning, not one per write");
  works = true;
  st.flush();
  assert.equal(st.unsafeToLeave(), false);
  assert.deepEqual(events.filter((e) => e[0] === "storage:state").map((e) => e[1].kept), [false, true]);
});

test("a throwing storage layer is the same case (private window, quota)", () => {
  const { S, fx, sc } = makeStaging();
  const events = [];
  const boom = { get() { return null; }, set() { return false; }, del() {} };
  const st = S.stagingLib.create({ files: fx.content.files, schemaClient: sc, storage: boom, storeKey: "k2", emit: (e, d) => events.push([e, d]) });
  assert.equal(st.unsafeToLeave(), false, "nothing to lose yet");
  st.set("hero.badge", "Edited");
  st.flush();
  assert.equal(st.unsafeToLeave(), true);
  st.clear();
  st.flush();
  assert.equal(st.unsafeToLeave(), false, "nothing unsaved left");
});
