"use strict";
// Everything that is written into Git or a pull request is generated here from validated data, escaped:
// control characters stripped, "@" neutralised (no surprise mentions), "<" escaped (nobody can forge the hidden
// authorship marker or inject HTML). Portable.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKER_RE = /<!-- studio:v1 (\{[^\n]*\}) -->\s*$/;

function neutral(s, max) {
  let t = String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
  t = t.replace(/@/g, "@\u200b").replace(/</g, "&lt;");
  if (max && t.length > max) t = t.slice(0, max - 1) + "\u2026";
  return t;
}
// plain text for titles and commit messages: GitHub renders those as text, so only control characters and @ are handled
const plain = (s, max) => {
  let t = String(s == null ? "" : s).replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u2029\u202a-\u202e\u2066-\u2069]/g, " ").trim().replace(/@/g, "@\u200b").replace(/#(?=\d)/g, "#\u200b"); // no @mentions, no "#12" issue references or closing keywords
  if (max && t.length > max) t = t.slice(0, max - 1) + "\u2026";
  return t;
};
// Editor-typed text that GitHub will render as Markdown (the pull request body): one line, then every Markdown
// character escaped, links and issue references broken so a hostile editor cannot plant a clickable phishing link, a tracking
// image, a "owner/repo#1" cross-reference or a "closes #1" keyword. The text still reads the same to a person.
const md = (s, max) => oneLine(s, max)
  .replace(/([\\`*_\[\]()!|~#])/g, "\\$1")
  .replace(/:\/\//g, ":\u200b//")
  .replace(/\bwww\./gi, "www\u200b.")
  .replace(/&(?!lt;)/g, "&\u200b");
const oneLine = (s, max) => neutral(String(s == null ? "" : s).replace(/\s+/g, " ").trim(), max);

function firstName(name) { return oneLine(String(name || "").split(/\s+/)[0] || "someone", 30); }

function prTitle(title, authorName) {
  return ("Studio: " + plain(title, 60) + " (" + plain(String(authorName || "").split(/\s+/)[0] || "someone", 30) + ")").slice(0, 90);
}

function commitMessage(title, changes, userId, key) {
  const lines = (changes || []).slice(0, 30).map((c) => "- " + plain(c.label, 80) + ": " + plain(c.summary, 120));
  return "Studio: " + plain(title, 70) + "\n\n" + lines.join("\n") + (lines.length ? "\n\n" : "") + "Studio-User: " + userId + "\nStudio-Idempotency: " + key;
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

function studioLink(u) {
  try { const x = new URL(u); x.searchParams.set("studio", "1"); return oneLine(x.toString(), 250); } catch (e) { return oneLine(u, 200); }
}

// "Drafted with AI": the asked-for change (a short escaped preview the requester chose to save), how many suggestions were
// kept, and the model. Never the key, never more than 200 characters of the instruction.
// a hand edit of an AI draft must not erase where the first changes came from: the old section is carried over, line by line, only
// when every line still has the exact shape aiSection wrote (already escaped, so no angle brackets, links or mentions can pass)
function carryAi(body) {
  const lines = String(body || "").replace(/\r/g, "").split("\n");
  const at = lines.indexOf("### Drafted with AI");
  if (at < 0) return null;
  const keep = [];
  for (let i = at + 1; i < lines.length && lines[i] !== "" && lines[i].indexOf("<!--") !== 0 && keep.length < 3; i += 1) {
    const l = lines[i];
    const shaped = l.indexOf("Asked: ") === 0 || /^Kept \d+ of \d+ suggestions\. Model: /.test(l) || l.indexOf("A person chose ") === 0;
    if (shaped && l.length <= 400 && !/[<>]/.test(l) && l.indexOf("](") < 0 && l.indexOf("://") < 0 && !/@(?!​)/.test(l)) keep.push(l);
  }
  return keep.length ? keep : null;
}

function aiSection(ai, carry) {
  if (!ai && carry && carry.length) return ["### Drafted with AI"].concat(carry, ["Edited by hand afterwards.", ""]);
  if (!ai) return [];
  return [
    "### Drafted with AI",
    "Asked: " + md(ai.instructionPreview || "(no description)", 200),
    "Kept " + (Number.isInteger(ai.accepted) ? ai.accepted : 0) + " of " + (Number.isInteger(ai.total) ? ai.total : 0) + " suggestions. Model: " + md(ai.model || "unknown", 80) + ".",
    "A person chose these changes and the same checks apply as for any draft.",
    "",
  ];
}

function prBody({ authorName, authorId, draftId, changes, previewUrl, opsCount, filesCount, revertOf, ai, aiCarry }) {
  const list = (changes || []).slice(0, 80);
  const lines = list.map((c) => "- " + md(c.label, 100) + ": " + lowerFirst(md(c.summary, 200)));
  if ((changes || []).length > list.length) lines.push("- ...and " + (changes.length - list.length) + " more");
  const n = (changes || []).length;
  const m = filesCount === undefined ? new Set((changes || []).map((c) => c.file)).size : filesCount;
  const marker = { authorId, authorName: oneLine(authorName, 60).replace(/>/g, ""), draftId, ops: opsCount === undefined ? n : opsCount, revertOf: revertOf || null };
  const preview = previewUrl ? oneLine(previewUrl, 200) + "  Open in Studio: " + studioLink(oneLine(previewUrl, 200)) : "A preview link appears here when the build finishes.";
  const body = [
    "**Studio draft by " + md(authorName, 60) + "** - " + n + " change" + (n === 1 ? "" : "s") + " in " + m + " file" + (m === 1 ? "" : "s"),
    "",
    "### What changed",
    lines.length ? lines.join("\n") : "- (see the Files tab)",
    "",
    "### Preview",
    preview,
    "",
    "### Checks",
    "The site build and all guards must be green before this can be published.",
    "",
  ].concat(aiSection(ai, aiCarry)).concat(["<!-- studio:v1 " + JSON.stringify(marker) + " -->"]).join("\n");
  return body.length > 20000 ? body.slice(0, 19000).replace(/\n[^\n]*$/, "") + "\n\n<!-- studio:v1 " + JSON.stringify(marker) + " -->" : body;
}

// The authorship marker of a Studio PR body, or null when it is missing or malformed. Strict: the marker must be the
// very last thing in the body, the JSON is validated field by field, nothing else is trusted.
function parseMarker(body) {
  const m = MARKER_RE.exec(String(body || ""));
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[1]); } catch (e) { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "authorId,authorName,draftId,ops,revertOf") return null;
  if (typeof o.authorId !== "string" || !UUID_RE.test(o.authorId)) return null;
  if (typeof o.authorName !== "string" || o.authorName.length > 60 || /[\u0000-\u001f<>]/.test(o.authorName)) return null;
  if (typeof o.draftId !== "string" || !/^[a-z0-9]{1,16}--[a-z0-9][a-z0-9-]{1,50}$/.test(o.draftId)) return null;
  if (!Number.isInteger(o.ops) || o.ops < 0 || o.ops > 100000) return null;
  if (o.revertOf !== null && !(Number.isInteger(o.revertOf) && o.revertOf > 0)) return null;
  return o;
}

module.exports = { carryAi, plain, neutral, oneLine, md, prTitle, commitMessage, prBody, parseMarker, firstName };
