"use strict";
// Extracts, from one built HTML page, everything a visitor can see or hear:
//   text nodes (outside script / style), alt / aria-label / title / placeholder / … attributes,
//   submit-button values, <title>, the meta tags that become search / share snippets, the text of
//   JSON-LD blocks, and the inline <script> bodies (handed to jsscan.js by the callers).
//
// Beyond the bare minimum the guard also scans <noscript>, <template> and SVG <text>/<title>/<desc>
// content (all can show text to people), and any other attribute whose value reads like a sentence.

const { parseDocument } = require("htmlparser2");
const { collapse } = require("./util");
const { TEXT_ATTRS, CODE_ATTRS } = require("./jsscan");
const { proseKind } = require("./prose");

const META_TEXT = new Set([
  "description", "og:title", "og:description", "og:site_name", "og:image:alt", "twitter:title", "twitter:description",
  "twitter:image:alt", "application-name", "apple-mobile-web-app-title", "keywords", "author",
]);
const JS_TYPES = /^(|text\/javascript|application\/javascript|module|text\/ecmascript)$/i;

// Pictures, videos and outward links a page points at. An editor must be able to change each of them,
// so they have to come from data too: [{ kind: "media" | "link", url, attr }]
//   media  img / source / video / audio / track / embed / object / iframe / input[type=image] / SVG <image>
//          sources, social-share images, icon links, and any attribute holding an /images /frames /videos path
//   link   a / area hrefs that leave the site (http, https, mailto, tel, sms)
const MEDIA_TAGS = { img: ["src", "srcset"], source: ["src", "srcset"], video: ["src", "poster"], audio: ["src"], track: ["src"], embed: ["src"], object: ["data"], iframe: ["src"], image: ["href", "xlink:href"] };
const MEDIA_PATH = /^\/?(images|frames|videos)\//i;
function referencesOf(n, a) {
  const out = [];
  const add = (kind, attr, url) => {
    const u = String(url || "").trim();
    if (u && !/^data:/i.test(u)) out.push({ kind, attr, url: u });
  };
  const tag = n.name;
  // anything loaded from another site cannot be traced to editable data, whatever it is
  const offSite = (u) => /^(https?:)?\/\//i.test(String(u).trim()) && !/^(https?:)?\/\/(www\.)?coveredaccess\.com(\/|$)/i.test(String(u).trim());
  if (tag === "script" && a.src && offSite(a.src)) add("third-party", "src", a.src);
  if (tag === "link" && a.href && /stylesheet|preload|modulepreload|prefetch|preconnect|dns-prefetch/i.test(a.rel || "") && offSite(a.href)) add("third-party", "href", a.href);
  if (/^(iframe|frame|embed)$/.test(tag) && a.src && offSite(a.src)) add("third-party", "src", a.src);
  if (tag === "object" && a.data && offSite(a.data)) add("third-party", "data", a.data);
  for (const attr of MEDIA_TAGS[tag] || []) {
    if (a[attr] === undefined) continue;
    if (/^(iframe|embed|object)$/.test(tag) && offSite(a[attr])) continue;
    if (attr === "srcset") String(a[attr]).split(/,\s+/).forEach((part) => add("media", attr, part.trim().split(/\s+/)[0]));
    else add("media", attr, a[attr]);
  }
  if (tag === "input" && /^image$/i.test(a.type || "") && a.src) add("media", "src", a.src);
  if (tag === "meta") {
    const key = (a.name || a.property || "").toLowerCase();
    if (/^(og:image|og:image:url|og:image:secure_url|og:video|og:audio|twitter:image|twitter:image:src)$/.test(key)) add("media", "content", a.content);
  }
  if (tag === "link" && /icon|image_src|manifest/i.test(a.rel || "") && a.href) add("media", "href", a.href);
  if (tag === "a" || tag === "area") {
    if (/^(https?:|mailto:|tel:|sms:)/i.test(String(a.href || "").trim())) add("link", "href", a.href);
  }
  for (const [k, v] of Object.entries(a)) {
    if (/^(src|srcset|href|data|poster|content|xlink:href)$/.test(k.toLowerCase())) continue;
    if (MEDIA_PATH.test(String(v).trim())) add("media", k, v);
  }
  return out;
}

function describe(n) {
  const cls = (n.attribs && n.attribs.class ? "." + n.attribs.class.split(/\s+/)[0] : "") || "";
  return n.name + (n.attribs && n.attribs.id ? "#" + n.attribs.id : cls);
}

// -> { items: [{ kind, text, attr?, where }], scripts: [{ type, code, where, isJs, isJsonLd }], robots }
function extractPage(html) {
  const doc = parseDocument(html, { decodeEntities: true });
  const items = [];
  const scripts = [];
  const styles = [];
  const stylesheets = [];
  let robots = "";

  (function walk(n, chain, tags, classes) {
    if (n.type === "text") {
      const t = collapse(n.data);
      if (t) items.push({ kind: tags[tags.length - 1] === "title" && !tags.includes("svg") ? "title" : "text", text: t, where: chain.slice(-3).join(" > "), classes });
      return;
    }
    if (n.type === "style") {
      styles.push((n.children || []).map((c) => c.data || "").join(""));
      return;
    }
    if (n.type === "script") {
      const type = (n.attribs.type || "").trim();
      const code = (n.children || []).map((c) => c.data || "").join("");
      scripts.push({
        type,
        code,
        where: chain.slice(-2).join(" > "),
        isJs: JS_TYPES.test(type) && !n.attribs.src,
        isJsonLd: /ld\+json/i.test(type),
        external: !!n.attribs.src,
        src: n.attribs.src || "",
      });
      for (const ref of referencesOf(n, n.attribs || {})) items.push({ kind: ref.kind, text: ref.url, attr: ref.attr, where: "<script " + ref.attr + ">", classes });
      return;
    }
    if (n.type !== "tag") {
      if (n.children) n.children.forEach((c) => walk(c, chain, tags, classes));
      return;
    }
    const here = chain.concat(describe(n));
    const hereTags = tags.concat(n.name);
    const a = n.attribs || {};
    const hereClasses = a.class ? classes.concat(String(a.class).split(/\s+/).filter(Boolean)) : classes;
    if (n.name === "link" && /stylesheet/i.test(a.rel || "") && a.href) stylesheets.push(a.href);
    if (n.name === "meta") {
      const key = (a.name || a.property || "").toLowerCase();
      if (key === "robots") robots = a.content || "";
      if (META_TEXT.has(key) && a.content) items.push({ kind: "meta", text: collapse(a.content), attr: key, where: "<meta " + key + ">", classes });
    }
    for (const [k0, v0] of Object.entries(a)) {
      const k = k0.toLowerCase();
      if (n.name === "meta" && k === "content") continue;
      const v = collapse(v0);
      if (!v) continue;
      if (TEXT_ATTRS.has(k) || (n.name === "input" && k === "value" && /^(submit|button|reset|image|text|email|tel|search|url|number|password|date|time)?$/i.test(a.type || ""))) {
        items.push({ kind: "attr", text: v, attr: k, where: "<" + describe(n) + " " + k + ">", classes: hereClasses });
      } else if (!CODE_ATTRS.has(k) && !/^on/.test(k) && proseKind(v) === "copy") {
        items.push({ kind: "attr", text: v, attr: k, where: "<" + describe(n) + " " + k + "> (reads like a sentence)", classes: hereClasses });
      } else if (/^on/.test(k)) {
        items.push({ kind: "handler", text: v, attr: k, where: "<" + describe(n) + " " + k + ">" });
      }
    }
    for (const ref of referencesOf(n, a)) items.push({ kind: ref.kind, text: ref.url, attr: ref.attr, where: "<" + describe(n) + " " + ref.attr + ">", classes: hereClasses });
    (n.children || []).forEach((c) => walk(c, here, hereTags, hereClasses));
  })(doc, [], [], []);

  return { items, scripts, styles, stylesheets, robots };
}

// Strings of a JSON-LD block that are meant to be read (skips @-keys, URLs, dates, codes).
function jsonLdStrings(code) {
  let data;
  try {
    data = JSON.parse(code);
  } catch (e) {
    return { error: e.message, strings: [] };
  }
  const out = [];
  (function walk(v, key) {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], k);
    else if (typeof v === "string") {
      if (/^@/.test(key) || /^(url|sameAs|logo|image|email|telephone|inLanguage|areaServed|datePublished|dateModified|dateCreated|identifier)$/.test(key)) return;
      const t = collapse(v);
      if (t && /\p{L}/u.test(t) && !/^https?:\/\//i.test(t)) out.push({ text: t, key });
    }
  })(data, "");
  return { strings: out, data };
}

module.exports = { extractPage, jsonLdStrings };
