"use strict";
// The engine behind check-copy.js: scans built pages and reports every visible word, attribute
// text, meta snippet and script string that is not traceable to editable data.

const fs = require("fs");
const path = require("path");
const { clip, collapse, listFiles, toPosix, readText } = require("./util");
const { extractPage, jsonLdStrings } = require("./html");
const { scanScript } = require("./jsscan");
const { proseKind } = require("./prose");
const { hasCopyChars, norm } = require("./corpus");
const { cssContentStrings } = require("./css");

const PASSTHROUGH_DIRS = new Set(["images", "img", "frames", "fonts", "videos", "node_modules"]);

function pageUrlOf(siteDir, file) {
  const rel = toPosix(path.relative(siteDir, file));
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return "/" + rel.slice(0, -"index.html".length);
  return "/" + rel;
}

function findPages(siteDir) {
  return listFiles(siteDir, (f) => /\.html?$/i.test(f))
    .filter((f) => !PASSTHROUGH_DIRS.has(toPosix(path.relative(siteDir, f)).split("/")[0]))
    .sort();
}

// accept(text, channel, pageUrl, info) -> truthy when the text is acceptable
//   channel: "text" | "attr" | "meta" | "script" | "ldjson"
// info: { kind, where } for messages
function scanSite(siteDir, accept, report, opts) {
  const o = opts || {};
  const stats = { pages: [], skipped: [], items: 0, scriptStrings: 0, scripts: 0 };
  const seenSheets = new Set();
  const sheetCache = new Map();
  for (const file of findPages(siteDir)) {
    const url = pageUrlOf(siteDir, file);
    if (o.isExcluded && o.isExcluded(url)) {
      stats.skipped.push(url);
      continue;
    }
    const html = readText(file);
    const page = extractPage(html);
    const indexable = !/noindex/i.test(page.robots);
    stats.pages.push(url);
    // stylesheets of the page: inline <style> blocks and same-site linked files
    const sheets = page.styles.map((css) => ({ css, label: "inline <style>" }));
    for (const href of page.stylesheets) {
      if (/^(https?:)?\/\//i.test(href)) continue;
      if (!sheetCache.has(href)) {
        const f = path.join(siteDir, href.split(/[?#]/)[0].replace(/^\/+/, ""));
        sheetCache.set(href, fs.existsSync(f) ? readText(f) : null);
      }
      if (sheetCache.get(href) === null) continue;
      // a shared stylesheet is read for every page (hidden-text checks) but its content: strings are reported once
      sheets.push({ css: sheetCache.get(href), label: href, scan: !seenSheets.has(href) });
      seenSheets.add(href);
    }
    const flag = (channel, text, info) => {
      stats.items += 1;
      if (channel !== "media" && channel !== "link" && channel !== "third-party" && !hasCopyChars(norm(text))) return;
      const res = accept(text, channel, url, Object.assign({ indexable, styles: sheets.map((s) => s.css) }, info));
      if (!res) report.add(url, channel + " " + JSON.stringify(clip(text, 140)), info.where || "");
    };
    for (const it of page.items) {
      if (it.kind === "handler") {
        report.add(url, "inline event handler " + it.attr, it.where + "  (behaviour belongs in the page scripts, never in attributes)");
        continue;
      }
      const channel = it.kind === "meta" ? "meta" : it.kind === "attr" ? "attr" : it.kind === "media" ? "media" : it.kind === "link" ? "link" : it.kind === "third-party" ? "third-party" : "text";
      flag(channel, it.text, { kind: it.kind, where: it.where, classes: it.classes || [] });
    }
    // words a stylesheet prints with content: on ::before / ::after
    for (const sh of sheets) if (sh.scan !== false) for (const str of cssContentStrings(sh.css)) flag("css", str, { kind: "css", where: "content: in " + sh.label });
    for (const s of page.scripts) {
      stats.scripts += 1;
      if (s.external) {
        // third-party scripts are reported through the "third-party" channel; same-site files are scanned like inline code
        if (/^(https?:)?\/\//i.test(s.src) && !/^(https?:)?\/\/(www\.)?coveredaccess\.com(\/|$)/i.test(s.src)) continue;
        const f = path.join(siteDir, s.src.split(/[?#]/)[0].replace(/^(https?:)?\/\/(www\.)?coveredaccess\.com/i, "").replace(/^\/+/, ""));
        if (!fs.existsSync(f)) {
          report.add(url, "script file " + s.src + " is not in the build, so its strings cannot be checked");
          continue;
        }
        const rx = scanScript(readText(f));
        if (rx.error) {
          report.add(url, "script file " + s.src + " could not be parsed, so its strings cannot be checked", rx.error);
          continue;
        }
        for (const str of rx.strings) {
          stats.scriptStrings += 1;
          flag("script", str.text, { kind: str.kind, where: s.src + ", line " + str.line });
        }
        continue;
      }
      if (!s.code.trim()) continue;
      if (s.isJsonLd) {
        const r = jsonLdStrings(s.code);
        if (r.error) {
          report.add(url, "JSON-LD block is not valid JSON", r.error);
          continue;
        }
        for (const str of r.strings) flag("ldjson", str.text, { kind: "ldjson", where: "JSON-LD \"" + str.key + "\"" });
        continue;
      }
      if (!s.isJs) {
        if (/json|importmap|speculationrules/i.test(s.type)) {
          try {
            const data = JSON.parse(s.code);
            const walk = (v) => {
              if (typeof v === "string") {
                if (proseKind(v) === "copy") flag("script", v, { kind: "json-script", where: "<script type=" + s.type + ">" });
              } else if (Array.isArray(v)) v.forEach(walk);
              else if (v && typeof v === "object") Object.values(v).forEach(walk);
            };
            walk(data);
          } catch (e) {
            report.add(url, "<script type=" + s.type + "> is not valid JSON", e.message);
          }
        } else report.add(url, "inline <script type=\"" + s.type + "\"> is not understood by the guard", "use a plain script, JSON or JSON-LD block");
        continue;
      }
      const r = scanScript(s.code);
      if (r.error) {
        report.add(url, "inline script could not be parsed, so its strings cannot be checked", r.error + "  (" + s.code.length + " chars, starts: " + JSON.stringify(clip(s.code, 60)) + ")");
        continue;
      }
      for (const str of r.strings) {
        stats.scriptStrings += 1;
        flag("script", str.text, { kind: str.kind, where: "inline script, line " + str.line + (str.via === "html" ? " (HTML in a string)" : "") });
      }
    }
  }
  return stats;
}

// Decides whether a piece of text is acceptable: allow-list first (with its hidden-text claim
// verified), then the corpus (check-copy) or the token rule (sentinel build, tokenRe set).
class Acceptor {
  constructor(allow, report, opts) {
    const o = opts || {};
    this.allow = allow;
    this.report = report;
    this.corpus = o.corpus || null;
    this.tokenRe = o.tokenRe || null;
    this.tokenTest = o.tokenRe ? new RegExp(o.tokenRe.source, "i") : null;
    this.proseUses = new Map();
  }

  cssHides(styles, cls) {
    const re = new RegExp("\\." + cls.replace(/[^\w-]/g, "") + "\\s*\\{([^}]*)\\}", "g");
    for (const css of styles || []) {
      let m;
      while ((m = re.exec(css))) if (/display:\s*none|visibility:\s*hidden|left:\s*-\d{3,}px|clip(-path)?:|text-indent:\s*-\d{3,}/.test(m[1])) return true;
    }
    return false;
  }

  fromAllowList(text, channel, url, info) {
    const e = this.allow.match(text, channel, url);
    if (!e) return false;
    if (e.hiddenBy) {
      const inside = (info.classes || []).includes(e.hiddenBy.class);
      if (!inside || !this.cssHides(info.styles, e.hiddenBy.class)) {
        this.report.add(url, "allow-list entry '" + e.id + "' says its text is hidden by ." + e.hiddenBy.class + ", but " + (inside ? "the page CSS does not hide that class" : "this text is not inside an element with that class"), info.where || "");
      }
    } else if (e.text !== undefined && e.words >= 3 && info.indexable) {
      this.proseUses.set(e.id, (this.proseUses.get(e.id) || new Set()).add(url));
    }
    return true;
  }

  accept(text, channel, url, info) {
    if (this.fromAllowList(text, channel, url, info)) return true;
    if (channel === "third-party") return false;
    if (this.tokenRe && (channel === "media" || channel === "link")) return this.tokenTest.test(text);
    if (this.tokenRe) {
      // sentinel build: everything visible must be made of tokens; leftover words are hard-coded
      const residue = collapse(text.replace(this.tokenRe, " "));
      if (!hasCopyChars(residue)) return true;
      return residue !== collapse(text) && this.fromAllowList(residue, channel, url, info);
    }
    if (channel === "media") return this.corpus.hasMedia(text);
    if (channel === "link") return this.corpus.hasLink(text);
    return !!this.corpus.has(text);
  }

  proseProblems() {
    const out = [];
    for (const [id, pages] of this.proseUses) out.push({ id, pages: [...pages] });
    return out;
  }
}

module.exports = { scanSite, findPages, pageUrlOf, PASSTHROUGH_DIRS, Acceptor };
