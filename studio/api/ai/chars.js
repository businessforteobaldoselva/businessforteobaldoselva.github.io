"use strict";
// Character classes used to clean and to reject text. Built from code points at load time so the source file holds no
// raw invisible characters (they are easy to lose in an editor and invisible in review). Pure, portable.

const cc = (a, b) => (b === undefined ? String.fromCharCode(a) : String.fromCharCode(a) + "-" + String.fromCharCode(b));

// C0 controls except TAB and LF, DEL and C1 controls, line / paragraph separators, bidi overrides and isolates
const BAD_CHARS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f" + cc(0x2028) + cc(0x2029) + cc(0x202a, 0x202e) + cc(0x2066, 0x2069) + "]");
// the same set plus TAB / LF / CR, for text that must be one line of plain words (labels, titles)
const CONTROL_ALL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f" + cc(0x2028) + cc(0x2029) + cc(0x202a, 0x202e) + cc(0x2066, 0x2069) + "]+", "g");
// bidi marks and controls only
const BIDI = new RegExp("[" + cc(0x202a, 0x202e) + cc(0x2066, 0x2069) + cc(0x200e) + cc(0x200f) + cc(0x061c) + "]");
const ZWSP = String.fromCharCode(0x200b);
const ELLIPSIS = String.fromCharCode(0x2026);
const LDQUO = String.fromCharCode(0x201c);
const RDQUO = String.fromCharCode(0x201d);

// one line, no controls, "@" neutralised (no surprise mentions), at most `max` characters
function oneLine(s, max) {
  let t = String(s == null ? "" : s).replace(CONTROL_ALL, " ").replace(/\s+/g, " ").trim().replace(/@/g, "@" + ZWSP);
  if (max && t.length > max) t = t.slice(0, max - 1) + ELLIPSIS;
  return t;
}

// text a person reads (may hold line breaks): controls and bidi out, "@" neutralised, cut at `max`
function readable(s, max) {
  let t = String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(new RegExp(BAD_CHARS.source, "g"), " ").replace(/@/g, "@" + ZWSP);
  let truncated = false;
  if (max && t.length > max) { t = t.slice(0, max); truncated = true; }
  return { text: t, truncated };
}

module.exports = { BAD_CHARS, CONTROL_ALL, BIDI, ZWSP, ELLIPSIS, LDQUO, RDQUO, oneLine, readable, cc };
