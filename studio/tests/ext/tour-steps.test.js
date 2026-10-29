"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../overlay/ext/tour.js");

test("the tour has the 7 contract steps in order, in plain English", () => {
  assert.deepEqual(T.STEPS.map((s) => s.id), ["welcome", "text", "image", "sections", "save", "history", "palette"]);
  for (const s of T.STEPS) {
    assert.ok(s.title.length > 3 && s.title.length <= 60, s.id);
    assert.ok(s.body.length > 20 && s.body.length <= 260, s.id);
    assert.doesNotMatch(s.title + s.body, /<|>|pull request|branch|commit|merge|json/i, s.id + " must not use developer words");
  }
});

test("storage key is per user and safe", () => {
  assert.equal(T.storageKey("abc-123"), "covered.studio.v1.tour.abc-123");
  assert.equal(T.storageKey("../../x y"), "covered.studio.v1.tour.xy");
  assert.equal(T.storageKey(null), "covered.studio.v1.tour.anon");
  assert.ok(T.storageKey("a".repeat(500)).length < 100);
});

test("navigation is clamped", () => {
  assert.equal(T.nextIndex(0, -1, 7), 0);
  assert.equal(T.nextIndex(6, 1, 7), 6);
  assert.equal(T.nextIndex(2, 1, 7), 3);
  assert.equal(T.progressText(1, 7, "Hi"), "Step 2 of 7: Hi");
});

test("anchor resolution takes the first visible match and falls back to null", () => {
  const box = (w) => ({ getBoundingClientRect: () => ({ width: w, height: w, top: 10, left: 10, bottom: 10 + w, right: 10 + w }) });
  const step = { anchors: ["#a", "#b", "#c"] };
  assert.equal(T.resolveAnchor(step, (s) => ({ "#a": null, "#b": box(0), "#c": box(5) })[s]).rect.width, 5);
  assert.equal(T.resolveAnchor(step, () => null), null);
  assert.equal(T.resolveAnchor({ anchors: [] }, () => box(5)), null);
  assert.equal(T.resolveAnchor(step, () => { throw new Error("bad selector"); }), null);
});

test("card placement stays inside the viewport", () => {
  const vp = { w: 1000, h: 700 };
  const card = { w: 340, h: 200 };
  const below = T.placeCard({ top: 100, bottom: 140, left: 900, right: 990, width: 90, height: 40 }, card, vp, 12);
  assert.equal(below.placement, "below");
  assert.ok(below.left + below.width <= vp.w - 12 && below.left >= 12);
  const above = T.placeCard({ top: 600, bottom: 640, left: 20, right: 100, width: 80, height: 40 }, card, vp, 12);
  assert.equal(above.placement, "above");
  assert.ok(above.top >= 12);
  assert.equal(T.placeCard(null, card, vp, 12).placement, "center");
  assert.equal(T.placeCard({ top: 0, bottom: 690, left: 0, right: 100, width: 100, height: 690 }, card, vp, 12).placement, "center");
  const phone = T.placeCard(null, card, { w: 300, h: 500 }, 12);
  assert.ok(phone.width <= 276 && phone.left >= 12);
});
