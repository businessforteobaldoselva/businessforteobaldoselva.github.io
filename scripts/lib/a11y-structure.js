"use strict";
// Structure checks for one built page: the things an automated tool can judge without a browser
// (landmarks, headings, names of links / buttons / controls, image text alternatives, ids, ARIA misuse,
// media). Each finding: { severity: "error" | "warn", rule, message, where }.
// `styler` + `ctx` are used only to know which elements a visitor cannot see (display:none, hidden, clipped).

const { parentEl, elementKids } = require("./a11y-css");
const { collapse } = require("./util");
const { describe } = require("./a11y-contrast");

const HEADING = /^h([1-6])$/;
const FOCUSABLE_TAGS = /^(button|select|textarea|summary)$/;

function walkAll(n, fn) {
  fn(n);
  for (const k of elementKids(n)) walkAll(k, fn);
}
const attr = (n, a) => (n.attribs ? n.attribs[a] : undefined);
const has = (n, a) => attr(n, a) !== undefined;
const clip = (s, n) => {
  const t = collapse(s);
  return t.length > (n || 60) ? t.slice(0, (n || 60) - 1) + "…" : t;
};

function analyseStructure(opts) {
  const { doc, styler, ctx, url, config } = opts;
  const out = [];
  const add = (severity, rule, message, el) => out.push({ severity, rule, message, where: el ? describe(el) : "", url });

  let html = null;
  let head = null;
  let body = null;
  const all = [];
  walkAll(doc.children.find((k) => k.type === "tag") || doc, (n) => {
    all.push(n);
    if (n.name === "html" && !html) html = n;
    if (n.name === "head" && !head) head = n;
    if (n.name === "body" && !body) body = n;
  });
  if (!html || !body) {
    add("error", "document", "the page has no <html> and <body>");
    return out;
  }
  const byId = new Map();
  for (const n of all) if (has(n, "id") && attr(n, "id") !== "") (byId.get(attr(n, "id")) || byId.set(attr(n, "id"), []).get(attr(n, "id"))).push(n);

  const hidden = (n) => {
    const st = styler.computed(n, ctx);
    return st.hidden;
  };
  const invisible = (n) => {
    if (n.name === "noscript") return true;
    for (let p = n; p; p = parentEl(p)) if (p.name === "noscript" || p.name === "template") return true;
    const st = styler.computed(n, ctx);
    return st.hidden || st.visibility !== "visible";
  };
  const ariaHiddenAncestor = (n) => {
    for (let p = n; p; p = parentEl(p)) if (attr(p, "aria-hidden") === "true") return true;
    return false;
  };

  // ---- text a name is made of
  const textOf = (n, seen) => {
    let t = "";
    for (const k of n.children || []) {
      if (k.type === "text") t += k.data;
      else if (k.type === "tag") {
        if (attr(k, "aria-hidden") === "true" || has(k, "hidden")) continue;
        if (k.name === "script" || k.name === "style" || k.name === "template") continue;
        if (hidden(k) && !styler.computed(k, ctx).srOnly) continue;
        if (k.name === "img") t += " " + (attr(k, "alt") || "") + " ";
        else if (k.name === "svg") t += " " + svgName(k) + " ";
        else {
          const lab = attr(k, "aria-label");
          t += " " + (lab ? lab : textOf(k, seen)) + " ";
        }
      }
    }
    return collapse(t);
  };
  const svgName = (n) => {
    const al = attr(n, "aria-label");
    if (al) return al;
    for (const k of n.children || []) if (k.type === "tag" && k.name === "title") return textOf(k);
    return "";
  };
  const nameOf = (n) => {
    const lb = attr(n, "aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => (byId.get(id) ? textOf(byId.get(id)[0]) || attr(byId.get(id)[0], "aria-label") || "" : "")).join(" ");
      if (collapse(t)) return collapse(t);
    }
    const al = attr(n, "aria-label");
    if (al && collapse(al)) return collapse(al);
    if (n.name === "img") return collapse(attr(n, "alt") || "");
    if (n.name === "input") {
      const ty = (attr(n, "type") || "text").toLowerCase();
      if (ty === "image") return collapse(attr(n, "alt") || "");
      if (/^(submit|button|reset)$/.test(ty)) return collapse(attr(n, "value") || "");
    }
    const t = textOf(n);
    if (t) return t;
    return "";
  };

  // ---- page-level
  const titleEl = all.find((n) => n.name === "title");
  if (!titleEl || !collapse(textOf(titleEl))) add("error", "page-title", "the page has no <title> (the browser tab and screen readers need one)");
  const lang = attr(html, "lang");
  if (!lang || !collapse(lang)) add("error", "html-lang", "<html> has no lang attribute (screen readers pick the wrong voice)", html);
  else if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang.trim())) add("warn", "html-lang", "lang=\"" + lang + "\" does not look like a language code", html);
  for (const m of all.filter((n) => n.name === "meta" && /^viewport$/i.test(attr(n, "name") || ""))) {
    const c = (attr(m, "content") || "").toLowerCase();
    const max = /maximum-scale\s*=\s*([\d.]+)/.exec(c);
    if (/user-scalable\s*=\s*(no|0)/.test(c) || (max && parseFloat(max[1]) < 2)) add("error", "viewport-zoom", "the viewport meta tag stops visitors zooming (" + clip(c, 70) + ")", m);
  }

  // ---- landmarks
  const mains = all.filter((n) => (n.name === "main" || attr(n, "role") === "main") && !invisible(n));
  if (mains.length === 0) add("error", "landmark-main", "no <main> landmark (keyboard and screen-reader users cannot jump to the content)");
  if (mains.length > 1) add("error", "landmark-main", mains.length + " <main> landmarks; a page may have only one");
  if (!all.some((n) => n.name === "header" || attr(n, "role") === "banner")) add("warn", "landmark-banner", "no <header> landmark");
  if (!all.some((n) => n.name === "footer" || attr(n, "role") === "contentinfo")) add("warn", "landmark-contentinfo", "no <footer> landmark");
  const navs = all.filter((n) => n.name === "nav" && !invisible(n));
  if (navs.length > 1) for (const n of navs) if (!attr(n, "aria-label") && !attr(n, "aria-labelledby")) add("warn", "landmark-unique", "several <nav> landmarks and this one has no aria-label to tell them apart", n);

  // ---- headings
  const headings = all.filter((n) => HEADING.test(n.name) && !invisible(n) && attr(n, "aria-hidden") !== "true");
  const h1s = headings.filter((n) => n.name === "h1");
  if (h1s.length === 0) add("error", "heading-h1", "the page has no <h1>");
  if (h1s.length > 1) add("error", "heading-h1", h1s.length + " <h1> headings (" + h1s.map((n) => '"' + clip(textOf(n), 30) + '"').join(", ") + "); a page needs exactly one");
  let prev = 0;
  for (const h of headings) {
    const lvl = Number(HEADING.exec(h.name)[1]);
    const t = textOf(h);
    if (!t) add("error", "heading-empty", "an empty <" + h.name + "> heading", h);
    if (prev === 0 && lvl !== 1) add("warn", "heading-order", 'the first heading is <' + h.name + '> "' + clip(t, 30) + '", not <h1>', h);
    else if (prev && lvl > prev + 1) add("error", "heading-order", "heading level skipped: <h" + prev + "> is followed by <" + h.name + '> "' + clip(t, 40) + '" (expected at most <h' + (prev + 1) + ">)", h);
    prev = lvl;
  }

  // ---- skip link and in-page links
  const links = all.filter((n) => n.name === "a" && has(n, "href"));
  const firstFocusables = [];
  walkAll(body, (n) => {
    if (firstFocusables.length < 4 && isFocusable(n) && !invisible(n)) firstFocusables.push(n);
  });
  const skip = firstFocusables.find((n) => n.name === "a" && /^#./.test(attr(n, "href") || ""));
  if (!skip) add("warn", "skip-link", "no skip link before the navigation (the first focusable controls are " + (firstFocusables.map((n) => describe(n)).join(", ") || "none") + ")");
  else if (!byId.has(attr(skip, "href").slice(1))) add("error", "skip-link", 'the skip link points to "' + attr(skip, "href") + '" but nothing on the page has that id', skip);
  for (const a of links) {
    const h = attr(a, "href") || "";
    if (/^#[^\s]+$/.test(h) && !byId.has(decodeURIComponent(h.slice(1))) && h !== "#top") add("warn", "anchor-target", 'in-page link "' + h + '" points to an id that does not exist on this page', a);
  }

  // ---- links and buttons have names
  const generic = config.genericLinkText || { error: [], warn: [] };
  const buttons = all.filter((n) => n.name === "button" || attr(n, "role") === "button" || (n.name === "input" && /^(submit|button|reset|image)$/i.test(attr(n, "type") || "")));
  for (const a of links.concat(buttons)) {
    if (invisible(a) && !styler.computed(a, ctx).srOnly) continue;
    if (ariaHiddenAncestor(a) && (attr(a, "tabindex") === "-1" || a.name !== "a")) continue;
    const nm = nameOf(a);
    const kind = a.name === "a" ? "link" : "button";
    if (!nm) {
      add("error", kind + "-name", "a " + kind + " with no accessible name (" + (a.name === "a" ? "href=" + clip(attr(a, "href"), 40) : "no text, aria-label or title") + ")", a);
      continue;
    }
    const norm = nm.toLowerCase().replace(/[.!…→›»>\s]+$/g, "").trim();
    if ((generic.error || []).includes(norm)) add("error", kind + "-name", 'the ' + kind + ' text "' + nm + '" says nothing about where it goes; describe the destination', a);
    else if ((generic.warn || []).includes(norm)) add("warn", kind + "-name", 'the ' + kind + ' text "' + nm + '" is vague; screen-reader users hear links out of context', a);
  }

  // ---- images
  for (const img of all.filter((n) => n.name === "img")) {
    const inNoscript = !!(function () { for (let p = img; p; p = parentEl(p)) if (p.name === "noscript") return true; return false; })();
    if (invisible(img) && !inNoscript) continue;
    const alt = attr(img, "alt");
    const decorative = /^(presentation|none)$/.test(attr(img, "role") || "") || attr(img, "aria-hidden") === "true" || ariaHiddenAncestor(img);
    if (alt === undefined) {
      add(decorative ? "warn" : "error", "image-alt", 'image has no alt attribute (src="' + clip(attr(img, "src") || "", 50) + '")', img);
      continue;
    }
    if (!collapse(alt)) {
      if (decorative) continue;
      const link = (function () { for (let p = parentEl(img); p; p = parentEl(p)) if (p.name === "a" || p.name === "button") return p; return null; })();
      if (link && textOf(link).replace(/\s+/g, "")) continue; // decorative picture inside a link that has its own text
      if (link) add("error", "image-alt", 'the only content of a ' + (link.name === "a" ? "link" : "button") + ' is an image with empty alt (src="' + clip(attr(img, "src") || "", 50) + '"), so the control has no name', img);
      else add("error", "image-alt", 'empty alt on an image that is not marked decorative (src="' + clip(attr(img, "src") || "", 50) + '"): describe the picture, or mark it decorative with aria-hidden="true"', img);
      continue;
    }
    const a2 = collapse(alt);
    if (/\.(jpe?g|png|gif|webp|avif|svg)$/i.test(a2) || /^(img|image|photo|picture|dsc|screenshot)[\s_-]*\d*$/i.test(a2) || a2 === attr(img, "src")) add("warn", "image-alt-quality", 'alt text "' + clip(a2, 50) + '" looks like a file name, not a description', img);
    else if (/^(image|photo|picture|graphic) of\b/i.test(a2)) add("warn", "image-alt-quality", 'alt text "' + clip(a2, 50) + '" starts with "image of" (screen readers already say it is an image)', img);
    else if (a2.length > 150) add("warn", "image-alt-quality", "alt text is " + a2.length + " characters; keep it under about 150 and put the long version in the page text", img);
  }
  for (const s of all.filter((n) => n.name === "svg" && attr(n, "role") === "img")) if (!svgName(s) && !attr(s, "aria-labelledby")) add("error", "svg-name", 'an <svg role="img"> with no title or aria-label', s);
  for (const c of all.filter((n) => n.name === "canvas")) {
    if (attr(c, "aria-hidden") === "true" || attr(c, "role") || attr(c, "aria-label") || textOf(c) || ariaHiddenAncestor(c)) continue;
    add("warn", "canvas-name", "a <canvas> that is neither hidden from assistive technology (aria-hidden) nor described (aria-label or fallback text)", c);
  }
  for (const f of all.filter((n) => n.name === "iframe")) if (!attr(f, "title") && !attr(f, "aria-label")) add("error", "frame-title", "an <iframe> with no title", f);

  // ---- form controls
  const labelsFor = new Map();
  for (const l of all.filter((n) => n.name === "label" && has(n, "for"))) {
    const id = attr(l, "for");
    if (!labelsFor.has(id)) labelsFor.set(id, []);
    labelsFor.get(id).push(l);
    if (!byId.has(id)) add("error", "label-for", '<label for="' + id + '"> points to an id that does not exist', l);
  }
  for (const c of all.filter((n) => (n.name === "input" && !/^(hidden|submit|button|reset|image)$/i.test(attr(n, "type") || "text")) || n.name === "select" || n.name === "textarea")) {
    if (invisible(c)) continue;
    const id = attr(c, "id");
    let labelled = false;
    const texts = [];
    if (id && labelsFor.has(id)) for (const l of labelsFor.get(id)) texts.push(textOf(l));
    for (let p = parentEl(c); p; p = parentEl(p)) if (p.name === "label") texts.push(textOf(p));
    if (texts.some((t) => t)) labelled = true;
    if (!labelled && (collapse(attr(c, "aria-label") || "") || nameOf(c))) labelled = true;
    if (!labelled) {
      if (collapse(attr(c, "title") || "")) add("warn", "form-label", "a form control labelled only by its title attribute (use a visible <label>)", c);
      else add("error", "form-label", "a form control with no label (" + (attr(c, "placeholder") ? 'placeholder "' + clip(attr(c, "placeholder"), 30) + '" is not a label' : "no <label>, aria-label or aria-labelledby") + ")", c);
    }
    const ty = (attr(c, "type") || "text").toLowerCase();
    if ((ty === "email" || ty === "tel") && !attr(c, "autocomplete")) add("warn", "autocomplete", 'a ' + ty + ' field without autocomplete (WCAG 1.3.5: browsers can fill it in for people who find typing hard)', c);
    if (has(c, "autofocus")) add("warn", "autofocus", "autofocus moves keyboard focus without being asked", c);
  }

  // ---- ids, references, ARIA misuse, tabindex
  for (const [id, list] of byId) if (list.length > 1) add("error", "duplicate-id", 'id "' + id + '" is used ' + list.length + " times (" + list.slice(0, 3).map(describe).join(", ") + ")", list[1]);
  for (const n of all) {
    for (const a of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"]) {
      const v = attr(n, a);
      if (!v) continue;
      for (const id of v.split(/\s+/).filter(Boolean)) if (!byId.has(id)) add(a === "aria-labelledby" ? "error" : "warn", "aria-reference", a + '="' + id + '" points to an id that does not exist', n);
    }
    const ti = attr(n, "tabindex");
    if (ti !== undefined && parseInt(ti, 10) > 0) add("error", "tabindex", "tabindex=\"" + ti + '" makes the tab order unpredictable; use 0 or -1', n);
    if (attr(n, "aria-hidden") === "true") {
      if (n.name === "body") add("error", "aria-hidden", 'aria-hidden="true" on <body> hides the whole page from screen readers', n);
      else if (isFocusable(n) && attr(n, "tabindex") !== "-1") add("error", "aria-hidden", 'aria-hidden="true" on a control that can still be reached with the keyboard', n);
      else {
        let found = null;
        walkAll(n, (d) => {
          if (!found && d !== n && isFocusable(d) && attr(d, "tabindex") !== "-1" && !invisible(d)) found = d;
        });
        if (found) add("error", "aria-hidden", 'aria-hidden="true" contains something the keyboard can still reach (' + describe(found) + "), so people hear nothing where focus lands", n);
      }
    }
    if (/^(presentation|none)$/.test(attr(n, "role") || "") && isFocusable(n)) add("error", "aria-hidden", 'role="' + attr(n, "role") + '" on a focusable element', n);
    if (n.name === "marquee" || n.name === "blink") add("error", "obsolete-motion", "<" + n.name + "> cannot be paused", n);
  }

  // ---- media and motion
  const motionHandled = !!opts.motion.reducedMotionCss || !!opts.motion.reducedMotionScript;
  for (const m of all.filter((n) => n.name === "video" || n.name === "audio")) {
    const decorative = attr(m, "aria-hidden") === "true" || ariaHiddenAncestor(m) || attr(m, "role") === "presentation";
    const controls = has(m, "controls");
    const autoplay = has(m, "autoplay");
    const muted = has(m, "muted");
    if (m.name === "audio" || !muted) {
      if (autoplay) add("error", "media-autoplay", "<" + m.name + "> starts playing sound by itself (it must be muted or have no autoplay)", m);
    }
    if (m.name === "video") {
      if (!controls && !decorative) {
        if (muted && nameOf(m)) {
          if (has(m, "loop") || autoplay || has(m, "data-autoplay")) add("warn", "video-controls", "a silent video with no controls that plays or loops by itself: nobody can pause it (WCAG 2.2.2)" + (motionHandled ? "; visitors who ask their device for reduced motion are respected" : ""), m);
        } else add("error", "video-controls", 'a <video> with no controls that is neither silent and labelled (muted + aria-label) nor marked decorative (aria-hidden="true"): visitors cannot pause or describe it', m);
      }
      if (autoplay && !controls && !motionHandled) add("error", "motion-reduced", "an autoplaying video and no prefers-reduced-motion handling in the page's CSS or scripts", m);
      if (!muted && controls && !all.some((n) => n.name === "track" && parentEl(n) === m)) add("warn", "video-captions", "a video with sound and no <track kind=\"captions\">", m);
    } else if (!controls) add("error", "audio-controls", "an <audio> with no controls", m);
  }
  if (opts.motion.animations && !motionHandled) add("warn", "motion-reduced", "the page has CSS animations but no @media (prefers-reduced-motion) rule");
  return out;
}

function isFocusable(n) {
  if (n.name === "a" || n.name === "area") return has(n, "href");
  if (n.name === "input") return !/^hidden$/i.test(attr(n, "type") || "") && !has(n, "disabled");
  if (FOCUSABLE_TAGS.test(n.name)) return !has(n, "disabled");
  const ti = attr(n, "tabindex");
  return ti !== undefined && !isNaN(parseInt(ti, 10));
}

module.exports = { analyseStructure };
