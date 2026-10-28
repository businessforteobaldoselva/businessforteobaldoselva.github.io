"use strict";
// Text that a stylesheet writes onto the page: the string values of `content:` declarations
// (::before / ::after). attr(...) and counters carry no words of their own and are skipped.

// CSS string escapes: \2192 (hex, optional trailing space), \" (any other char)
function decodeCssString(s) {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (m, hex, ch) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";
    }
    return ch === "\n" ? "" : ch;
  });
}

// -> [string]
function cssContentStrings(css) {
  const clean = String(css).replace(/\/\*[\s\S]*?\*\//g, " ");
  const out = [];
  const decl = /(?:^|[;{}\s])content\s*:\s*((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^;{}"'])*)/gi;
  let m;
  while ((m = decl.exec(clean))) {
    const strRe = /"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'/g;
    let s;
    while ((s = strRe.exec(m[1]))) {
      const text = decodeCssString(s[1] !== undefined ? s[1] : s[2]);
      if (text.trim()) out.push(text);
    }
  }
  return out;
}

module.exports = { cssContentStrings, decodeCssString };
