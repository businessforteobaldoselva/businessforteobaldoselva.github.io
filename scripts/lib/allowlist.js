"use strict";
// scripts/copy-allowlist.json: the only way text that is not traceable to editable data may be
// accepted by check-copy. Every entry needs a reason. Two kinds:
//
//   { "id", "text": "⏸", "reason", "pages": ["/"], "kinds": ["text"] }
//       an exact piece of text that is user-interface chrome (a glyph, the brand wordmark)
//   { "id", "template": "{{footer.updatedLabel}} {{footer.lastUpdated}}", "reason" }
//       a text the page assembles from SEVERAL editable strings. {{path}} stands for the current
//       value(s) of an editable string, so editing the data never needs an allow-list change.
//       Paths: dotted keys, [0], [key=value] (pick the list item whose key equals value) and [*]
//       (any item); append |lower for a lower-cased copy. Outside the {{ }} references the
//       template may contain no letters at all - composites are made of data, not of words in code.
//       With "regex": true, ( ) ? : * + [ ] \d | are regular-expression syntax (for repeated items).
//
// Policy (enforced below and in check-copy.js): unused entries are an error (no rot); an exact
// "text" entry that reads as prose (3+ words) is only accepted on pages that are noindex.

const { collapse, escapeRegExp } = require("./util");
const { norm } = require("./corpus");

const REF = /\{\{\s*([^{}]+?)\s*\}\}/g;

// Resolve a path like homepage.sections[type=marquee].items[*] against a nested object.
function resolveRef(refs, expr) {
  const [pathPart, ...filters] = expr.split("|").map((x) => x.trim());
  const tokens = [];
  const re = /([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[([\w$-]+)=([^\]]*)\]|\[(\*)\]/g;
  let m;
  let last = 0;
  while ((m = re.exec(pathPart))) {
    if (m.index !== last && pathPart[last] !== ".") return { error: "bad path '" + pathPart + "'" };
    last = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ key: m[1] });
    else if (m[2] !== undefined) tokens.push({ index: Number(m[2]) });
    else if (m[3] !== undefined) tokens.push({ where: [m[3], m[4]] });
    else tokens.push({ any: true });
  }
  if (last < pathPart.length) return { error: "bad path '" + pathPart + "'" };
  let cur = [refs];
  for (const t of tokens) {
    const next = [];
    for (const v of cur) {
      if (v === null || v === undefined) continue;
      if (t.key !== undefined) {
        if (typeof v === "object" && !Array.isArray(v) && t.key in v) next.push(v[t.key]);
      } else if (!Array.isArray(v)) continue;
      else if (t.index !== undefined) {
        if (t.index < v.length) next.push(v[t.index]);
      } else if (t.where) {
        v.forEach((it) => {
          if (it && typeof it === "object" && String(it[t.where[0]]) === t.where[1]) next.push(it);
        });
      } else if (t.any) next.push(...v);
    }
    cur = next;
  }
  let out = cur.filter((v) => typeof v === "string" || typeof v === "number").map((v) => String(v));
  if (!out.length) return { error: "'" + pathPart + "' does not resolve to any editable string", unresolved: true };
  for (const f of filters) {
    if (f === "lower") out = out.concat(out.map((s) => s.toLowerCase()));
    else if (f === "upper") out = out.concat(out.map((s) => s.toUpperCase()));
    else return { error: "unknown filter '" + f + "'" };
  }
  return { values: [...new Set(out)] };
}

function compileTemplate(entry, refs) {
  const tpl = entry.template;
  const residue = tpl.replace(REF, "").replace(/\\d/g, "");
  if (/\p{L}/u.test(residue)) return { error: "template contains letters outside {{ }}; a composite must be made of data only" };
  let error = null;
  let unresolved = false;
  let body = "";
  let at = 0;
  let m;
  REF.lastIndex = 0;
  const literal = (s) => (entry.regex ? s.replace(/\s+/g, "\\s+") : escapeRegExp(s).replace(/\s+/g, "\\s+"));
  while ((m = REF.exec(tpl))) {
    body += literal(tpl.slice(at, m.index));
    const r = resolveRef(refs, m[1]);
    if (r.error) {
      error = r.error;
      unresolved = !!r.unresolved;
      break;
    }
    body += "(?:" + r.values.sort((a, b) => b.length - a.length).map((v) => escapeRegExp(norm(v)).replace(/ /g, "\\s+")).join("|") + ")";
    at = m.index + m[0].length;
  }
  if (error) return { error, unresolved };
  body += literal(tpl.slice(at));
  try {
    return { re: new RegExp("^" + body + "$", "u") };
  } catch (e) {
    return { error: "template does not compile: " + e.message };
  }
}

class AllowList {
  // data: parsed copy-allowlist.json; refs: { siteName: dataObject, ... } for templates
  constructor(data, refs) {
    this.problems = [];
    this.inactive = []; // template entries whose data is currently empty / missing (an editor may have switched the feature off)
    this.entries = [];
    this.excludes = [];
    const d = data || {};
    const ids = new Set();
    for (const e of d.excludePages || []) {
      if (!e || typeof e.path !== "string" || !/^\/[a-z0-9\-/]*\/$|^\/$/.test(e.path)) this.problems.push("excludePages entry needs a path like /og/: " + JSON.stringify(e));
      else if (!e.reason || collapse(e.reason).length < 20) this.problems.push("excludePages " + e.path + " needs a reason (20+ characters)");
      else this.excludes.push(e);
    }
    for (const e of d.entries || []) {
      const label = "entry " + (e && e.id ? e.id : JSON.stringify(e).slice(0, 40));
      if (!e || typeof e !== "object") continue;
      if (!e.id || ids.has(e.id)) this.problems.push(label + ": needs a unique id");
      ids.add(e.id);
      if (!e.reason || collapse(e.reason).length < 20) {
        this.problems.push(label + ": needs a reason of at least 20 characters saying why this text is not editable copy");
        continue;
      }
      if ([e.text, e.template, e.prefix].filter((x) => x !== undefined).length !== 1) {
        this.problems.push(label + ': needs exactly one of "text", "template" or "prefix"');
        continue;
      }
      if (e.prefix !== undefined && !(Array.isArray(e.kinds) && e.kinds.length && e.kinds.every((k) => k === "media" || k === "link"))) {
        this.problems.push(label + ': a "prefix" entry is only for picture / video / link paths: set "kinds" to ["media"] and/or ["link"]');
        continue;
      }
      const entry = { id: e.id, reason: e.reason, pages: e.pages || null, kinds: e.kinds || null, uses: 0, usedOn: new Set(), allowUnused: e.allowUnused === true, hiddenBy: e.hiddenBy && typeof e.hiddenBy.class === "string" ? e.hiddenBy : null };
      if (e.prefix !== undefined) {
        entry.prefix = String(e.prefix).trim();
        if (entry.prefix.length < 4) {
          this.problems.push(label + ": prefix is too short to be a deliberate asset folder");
          continue;
        }
      } else if (e.text !== undefined) {
        entry.text = norm(e.text);
        entry.words = (entry.text.match(/\p{L}{2,}/gu) || []).length;
        if (!entry.text) {
          this.problems.push(label + ": empty text");
          continue;
        }
      } else {
        const c = compileTemplate(e, refs || {});
        if (c.error) {
          if (c.unresolved) this.inactive.push(label + ": " + c.error);
          else this.problems.push(label + ": " + c.error);
          continue;
        }
        entry.re = c.re;
      }
      this.entries.push(entry);
    }
  }

  isExcluded(pageUrl) {
    return this.excludes.find((e) => pageUrl === e.path || pageUrl.startsWith(e.path));
  }

  // -> entry that accepts this text, or null. Counts the use.
  match(text, kind, pageUrl) {
    const t = norm(text);
    for (const e of this.entries) {
      if (e.pages && !e.pages.includes(pageUrl) && !e.pages.includes("*")) continue;
      if (e.kinds && !e.kinds.includes(kind)) continue;
      const hit = e.prefix !== undefined ? t.startsWith(e.prefix) : e.text !== undefined ? e.text === t : e.re.test(t);
      if (hit) {
        e.uses += 1;
        e.usedOn.add(pageUrl);
        return e;
      }
    }
    return null;
  }
}

module.exports = { AllowList, resolveRef };
