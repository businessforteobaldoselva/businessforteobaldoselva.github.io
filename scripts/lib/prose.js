"use strict";
// Shape-based classification of a string: is it human-readable copy, a UI glyph, or code?
//
// This deliberately looks at the VALUE only (never at which characters it contains: strings with
// { } ; = < > or backticks are judged exactly like any other), so a sentence cannot hide from the
// guard by containing punctuation. Context-based exemptions (querySelector arguments, className
// assignments, ...) live in jsscan.js.

const { collapse } = require("./util");

const LETTER = /\p{L}/u;
const LETTERS = /\p{L}/gu;
const NON_ASCII = /[^\x00-\x7f]/;

// Upper-case tokens that are protocol / DOM vocabulary, not words.
const CODE_CAPS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "HTTP", "HTTPS", "JSON", "HTML", "CSS", "SVG", "UTF",
  "BODY", "MAIN", "NAV", "FORM", "INPUT", "SELECT", "OPTION", "TEXTAREA", "BUTTON", "LABEL", "SPAN", "IMG", "VIDEO",
  "CANVAS", "SECTION", "HEADER", "FOOTER", "TABLE", "AREA", "BASE", "LINK", "META", "NULL", "TRUE", "FALSE", "NONE",
]);
const JOINERS = new Set(["and", "or", "of", "the", "with", "for", "plus", "per", "to", "&"]);

function letterCount(s) {
  const m = s.match(LETTERS);
  return m ? m.length : 0;
}

// A natural-language word with optional trailing punctuation: Hello, you're, plastic-free, ask…
const PLAIN_WORD = /^[\p{L}][\p{L}'’-]*[.,;:!?…)"”’]*$/u;
const isPlainWord = (w) => PLAIN_WORD.test(w) && letterCount(w) >= 2;
const isCssUnit = (w) => /^-?\d*\.?\d+(px|em|rem|vh|vw|vmin|vmax|ch|s|ms|deg|%|fr)?[;,)]*$/.test(w) && /\d/.test(w) && /[a-z%]/.test(w);

function urlish(t) {
  return (
    /^(https?:|mailto:|tel:|data:|blob:|javascript:|\/\/)/i.test(t) ||
    /^(\.{0,2}\/|#|\?)\S*$/.test(t) ||
    /^[\w./-]+\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|m4v|css|js|json|html|woff2?|ico|txt|xml)([?#]\S*)?$/i.test(t) ||
    /^[a-z][a-z0-9+.-]*\/[a-z0-9.+-]+(;.*)?$/i.test(t) || // MIME type
    /^[\w.-]+@[\w.-]+\.[a-z]{2,}$/i.test(t) // bare e-mail address
  );
}

function singleToken(t, raw) {
  const letters = letterCount(t);
  if (/^[a-z]+$/.test(t) && JOINERS.has(t) && raw !== t) return "copy"; // " and "
  if (NON_ASCII.test(t) && letters >= 2 && !/^[\w$.-]+$/.test(t)) return "copy"; // Sending…  Café  Nº
  if (NON_ASCII.test(t) && letters >= 1) return "copy"; // 5×  Nº
  if (/^[\p{Lu}][\p{Ll}'’]+[.,!?…:;]*$/u.test(t) && letters >= 3) return "copy"; // Close  Sponsored  Thanks!
  if (/^[\p{L}][\p{L}'’]{2,}[.!?…]$/u.test(t)) return "copy"; // done.
  if (/^[A-Z]{4,}$/.test(t) && !CODE_CAPS.has(t)) return "copy"; // FREE
  return null;
}

// -> "copy" | "glyph" | null
function proseKind(raw) {
  const t = collapse(raw);
  if (!t) return null;
  if (!LETTER.test(t)) return NON_ASCII.test(t) ? "glyph" : null;
  if (urlish(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(t)) return null; // ISO date
  if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(t) && t.length <= 6 && /-/.test(t)) return null; // locale en-GB
  const tokens = t.split(" ");
  if (tokens.length === 1) return singleToken(t, raw);

  const joinersOnly = tokens.every((w) => JOINERS.has(w.replace(/[.,;:]+$/g, "").toLowerCase()) || !LETTER.test(w));
  if (joinersOnly && /[A-Za-z]/.test(t) && (raw !== t || /[,;]/.test(t))) return "copy";

  if (tokens.some(isCssUnit)) return null; // "opacity 1s ease", "-40% 0px"
  if (tokens.every((w) => /^[a-z0-9_:-]+$/.test(w)) && tokens.some((w) => /[-_:0-9]/.test(w))) return null; // class list: "btn btn-primary"
  const plain = tokens.filter(isPlainWord);
  const long = plain.filter((w) => letterCount(w) >= 3);
  if (!plain.length) return NON_ASCII.test(t) && letterCount(t) >= 2 ? "copy" : null;
  if (!long.length && !tokens.some((w) => NON_ASCII.test(w) && LETTER.test(w))) return null;
  const startsUpper = /^[^\p{L}]*\p{Lu}/u.test(t);
  const sentenceEnd = /[.!?…]["”’)]?$/.test(t);
  if (plain.length >= 2 || startsUpper || sentenceEnd || (NON_ASCII.test(t) && LETTER.test(t))) return "copy";
  return null;
}

module.exports = { proseKind, letterCount, urlish };
