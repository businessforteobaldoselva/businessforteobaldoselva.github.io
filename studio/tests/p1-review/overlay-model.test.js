"use strict";
globalThis.window = globalThis.window || {}; // the ext files end with })(window.__CoveredStudioBoot): outside a browser they only export their pure parts
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const status = require("../../overlay/ext/status.js");
const review = require("../../overlay/ext/review.js");
const S = require("../../api/shapes/phase1");

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "phase1", n), "utf8"));
const NOW = Date.parse("2026-11-22T10:05:00Z");

test("board model from the shared fixture: groups, rows, plain times", () => {
  const board = fx("board.json");
  assert.deepEqual(S.validateBoard(board), []);
  const vm = status.buildBoardModel(board, { now: NOW });
  assert.equal(vm.live.settling, true);
  assert.equal(vm.live.settlingText, "Published. The site updates in a few minutes.");
  assert.equal(vm.live.text, "Published 7 minutes ago by Molly.");
  assert.deepEqual(vm.groups.map((g) => g.id), ["waiting", "mine", "restored"]);
  const w = vm.groups[0].rows[0];
  assert.equal(w.title, "Summer edits");
  assert.equal(w.meta, "Amelia \u00b7 1 hour ago \u00b7 3 changes");
  assert.equal(w.stepLabel, "Waiting for approval");
  assert.equal(w.canReview, true);
  assert.equal(vm.groups[1].rows.length, 0);
  assert.equal(vm.groups[1].empty, "You have no open drafts.");
  assert.equal(vm.note, "");
});

test("board model: your own waiting draft is not listed twice; editors get a count, never titles", () => {
  const board = fx("board.json");
  board.waiting[0].mine = true;
  board.mine = [JSON.parse(JSON.stringify(board.waiting[0])), Object.assign(JSON.parse(JSON.stringify(board.waiting[0])), { id: "u7k2m9qa--other", step: "editing", stepLabel: "Still being edited", title: "Second" })];
  board.othersWaiting = 2;
  const vm = status.buildBoardModel(board, { now: NOW });
  assert.equal(vm.groups[0].rows[0].meta.split(" \u00b7 ")[0], "You");
  assert.deepEqual(vm.groups[1].rows.map((r) => r.title), ["Second"]);
  assert.equal(vm.note, "2 other drafts are waiting for an approver.");
  board.othersWaiting = 1;
  assert.equal(status.buildBoardModel(board, { now: NOW }).note, "1 other draft is waiting for an approver.");
});

test("board model: an empty site says so in words, and hostile titles stay plain strings", () => {
  const vm = status.buildBoardModel({ generatedAt: "2026-11-22T10:00:00Z", live: null, waiting: [], restored: [], mine: [], othersWaiting: 0 }, { now: NOW });
  assert.equal(vm.live, null);
  assert.deepEqual(vm.groups.map((g) => g.rows.length), [0, 0, 0]);
  const board = fx("board.json");
  board.waiting[0].title = '<img src=x onerror="alert(1)">';
  assert.equal(status.buildBoardModel(board, { now: NOW }).groups[0].rows[0].title, '<img src=x onerror="alert(1)">');
});

test("status.since: just now, minutes, hours, days", () => {
  const ago = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(status.since(ago(5e3), NOW), "just now");
  assert.equal(status.since(ago(60e3), NOW), "1 minute ago");
  assert.equal(status.since(ago(3 * 3600e3), NOW), "3 hours ago");
  assert.equal(status.since(ago(2 * 86400e3), NOW), "2 days ago");
  assert.equal(status.since("garbage", NOW), "");
});

test("review model from the shared fixture: the hidden section is listed first, with its warning", () => {
  const r = fx("review.json");
  assert.deepEqual(S.validateReview(r), []);
  const vm = review.buildReviewModel(r, { canPublish: true, since: () => "5 minutes ago" });
  assert.equal(vm.summary, "2 changes on 1 page");
  assert.deepEqual(vm.careful.map((x) => x.id), ["r2"]);
  assert.equal(vm.careful[0].attentionText, "Something is switched off");
  assert.deepEqual(vm.rest.map((x) => x.id), ["r1"]);
  assert.equal(vm.rest[0].before, "We're covering the UK,");
  assert.equal(vm.rest[0].after, "We cover the UK");
  assert.equal(vm.checksText, "All the safety checks passed.");
  assert.equal(vm.canApprove, true);
  assert.equal(vm.sideBySide, null);
  assert.equal(vm.headSha, r.headSha);
});

test("approve is possible only when the server says so AND the person's role may publish", () => {
  const r = fx("review.json");
  assert.equal(review.buildReviewModel(r, { canPublish: false }).canApprove, false, "an editor never sees an enabled button");
  r.gates = { checks: "pending", canPublish: false, blockers: [{ reason: "checks_pending", message: "The website checks have not finished yet. Try again in a minute." }] };
  const vm = review.buildReviewModel(r, { canPublish: true });
  assert.equal(vm.canApprove, false);
  assert.deepEqual(vm.blockers, ["The website checks have not finished yet. Try again in a minute."]);
  assert.equal(vm.checksText, "The safety checks are still running.");
  r.gates.canPublish = true;
  r.gates.blockers = [];
  r.draft = Object.assign({}, r.draft, { state: "merged" });
  assert.equal(review.buildReviewModel(r, { canPublish: true }).canApprove, false, "an already published draft cannot be approved again");
});

test("values: add and remove say what the missing side means; a cut-short value is flagged", () => {
  const r = fx("review.json");
  r.items[0].op = "add"; r.items[0].before = null;
  r.items[1].op = "remove"; r.items[1].after = null; r.items[1].before.truncated = true;
  const vm = review.buildReviewModel(r, { canPublish: true });
  const all = vm.careful.concat(vm.rest);
  assert.equal(all.find((x) => x.id === "r1").beforeNote, "Not there before");
  assert.equal(all.find((x) => x.id === "r2").afterNote, "Taken away");
  assert.equal(all.find((x) => x.id === "r2").beforeCut, true);
});

test("share text: names the draft, the size and the link; no link falls back to words; mailto has no recipient", () => {
  const link = "https://deploy-preview-57--x.netlify.app/?studio=1#review=u7k2m9qa--summer-edits";
  const t = review.buildShareText({ title: "Summer edits", count: 3, link, reviewerName: "Teo" });
  assert.match(t, /^Hello Teo,\n\nI have changed the website/);
  assert.match(t, /Draft: Summer edits\n3 changes\n/);
  assert.ok(t.includes(link));
  assert.ok(t.includes('press "Approve and publish"'));
  const noLink = review.buildShareText({ title: "x", count: null, link: null, reviewerName: "" });
  assert.match(noLink, /^Hello,/);
  assert.match(noLink, /choose Status, then Review/);
  assert.equal(/\n\n\n/.test(noLink), false);
  const m = review.mailtoFor("Summer edits", t);
  assert.match(m, /^mailto:\?subject=/);
  assert.equal(decodeURIComponent(m.split("&body=")[1]), t);
  assert.equal(m.includes("\n"), false);
});

test("the submit fixtures carry what the dialog needs", () => {
  for (const n of ["submit.github.json", "submit.manual.json"]) {
    const s = fx(n);
    assert.deepEqual(S.validateSubmitResponse(s), []);
    assert.ok(s.message.startsWith("Sent for review."));
    assert.ok(/^https:\/\//.test(s.reviewLink));
  }
  assert.equal(fx("submit.manual.json").notified.via, "none");
});
