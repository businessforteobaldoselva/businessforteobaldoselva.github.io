/* COVERED — Decap CMS live previews.
   Renders each editable section with the site's real markup + stylesheet,
   so edits appear exactly as they will on the published page. */
/* global CMS, createClass, h */
(function () {
  "use strict";

  // The site stylesheet (built by Eleventy from the same CSS the page inlines)
  CMS.registerPreviewStyle("/assets/site.css");
  // Preview-only overrides: no scroll-reveal hiding, no animations, breathing room
  CMS.registerPreviewStyle(
    [
      "body { background: var(--paper); margin: 0; color: var(--ink); }",
      "*, *::before, *::after { animation: none !important; transition: none !important; }",
      ".reveal { opacity: 1 !important; transform: none !important; }",
      ".w-rise { opacity: 1 !important; transform: none !important; }",
      "section { padding: 3rem 0 !important; }",
      ".faq-a { max-height: none !important; }",
      ".cms-note { font-family: var(--font-body); font-size: 12px; color: var(--muted); background: var(--paper-2); border: 1px dashed var(--line); border-radius: 8px; padding: 8px 12px; margin: 12px auto; width: min(1120px, 92%); }",
    ].join("\n"),
    { raw: true }
  );

  // ---------- helpers ----------
  function g(entry, path, fb) {
    var v = entry.getIn(["data"].concat(path));
    return v === undefined || v === null ? (fb === undefined ? "" : fb) : v;
  }
  function list(entry, key) {
    var v = entry.getIn(["data", key]);
    return v && v.toJS ? v.toJS() : [];
  }
  // Mirrors the site's `safeTitle` filter (.eleventy.js): everything an editor
  // typed is HTML-escaped, then only line breaks (<br>, <br/>, <br />) are turned
  // back into real ones. Nothing else typed into a heading can become markup.
  function safeTitleHtml(value) {
    var s = value === undefined || value === null ? "" : String(value);
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/&lt;br\s*\/?\s*&gt;/gi, "<br />");
  }
  // The ONLY place a preview writes HTML. The string always comes from
  // safeTitleHtml(), so it can hold nothing but escaped text and <br /> — never
  // pass anything else here (this admin page shares its origin with the Git
  // Gateway login, so a script injected into a preview could steal it).
  function titleEl(tag, props, value) {
    props = props || {};
    props.dangerouslySetInnerHTML = { __html: safeTitleHtml(value) };
    return h(tag, props);
  }
  function imgSrc(src) {
    if (!src) return "";
    return src.charAt(0) === "/" ? src : "/" + src;
  }
  function note(text) {
    return h("p", { className: "cms-note" }, "ℹ️ " + text);
  }
  // `breaks` is true for the headings the site renders with safeTitle (line
  // breaks allowed) and false for plain-text headings (model, how, FAQ).
  function sectionHead(kicker, title, subtitle, center, breaks) {
    return h(
      "div",
      { style: center ? { textAlign: "center" } : {} },
      h("span", { className: "kicker" }, kicker),
      breaks ? titleEl("h2", { className: "section-title" }, title) : h("h2", { className: "section-title" }, String(title)),
      subtitle ? h("p", { className: "section-sub", style: center ? { margin: "0 auto" } : {} }, subtitle) : null
    );
  }

  // ---------- Search-result and social-card preview ----------
  // Text only: every editor-typed value is a React child or a plain attribute (React escapes
  // it); the picture src is only used when it looks like a site picture path. No raw HTML here.
  var SEO_DOMAIN = "coveredaccess.com";
  var SEO_IMG = /^\/?(images|videos)\/[A-Za-z0-9._\/-]+\.(jpe?g|png|webp|gif|avif|svg)$/i;
  function seoClip(value, n) {
    var s = value === undefined || value === null ? "" : String(value).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1).replace(/\s+$/, "") + "…" : s;
  }
  function seoCount(value, soft, label) {
    var n = value === undefined || value === null ? 0 : String(value).replace(/\s+/g, " ").trim().length;
    var msg = n === 0 ? label + ": empty" : label + ": " + n + " characters" + (n > soft ? " - longer than about " + soft + ", so Google may cut it off" : " - fits");
    return h("li", { style: { color: n > soft ? "#a15c00" : "#555" } }, msg);
  }
  function seoPreview(o) {
    var title = o.title ? String(o.title) : "";
    var desc = o.desc ? String(o.desc) : "";
    var sTitle = o.socialTitle ? String(o.socialTitle) : title;
    var sDesc = o.socialDesc ? String(o.socialDesc) : desc;
    var image = typeof o.image === "string" ? o.image : "";
    var imgOk = SEO_IMG.test(image) && image.indexOf("..") < 0;
    var box = { fontFamily: "Arial, sans-serif", background: "#fff", border: "1px solid #dadce0", borderRadius: "8px", padding: "14px 16px", maxWidth: "620px", margin: "8px 0 14px", color: "#202124" };
    var cap = { fontFamily: "Arial, sans-serif", fontSize: "12px", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.04em", color: "#555", margin: "14px 0 0" };
    return h(
      "div",
      { style: { width: "min(1120px, 92%)", margin: "14px auto" } },
      o.hidden ? h("p", { className: "cms-note" }, "🚫 This page is hidden from search engines (and left out of the sitemap). The previews below show what it would look like if it were listed.") : null,
      h("p", { style: cap }, "How it may look in Google"),
      h(
        "div",
        { style: box },
        h("div", { style: { fontSize: "12px", color: "#4d5156" } }, SEO_DOMAIN + (o.path ? String(o.path) : "")),
        h("div", { style: { fontSize: "20px", lineHeight: "1.3", color: "#1a0dab", margin: "2px 0 4px" } }, seoClip(title, 60) || "(no title yet)"),
        h("div", { style: { fontSize: "14px", lineHeight: "1.5", color: "#4d5156" } }, seoClip(desc, 160) || "(no description - Google will write its own from the page text)")
      ),
      h("ul", { style: { fontFamily: "Arial, sans-serif", fontSize: "12px", margin: "0 0 4px", paddingLeft: "18px" } }, seoCount(title, 60, "Title"), seoCount(desc, 160, "Description")),
      h("p", { style: cap }, "How it may look when shared (WhatsApp, LinkedIn, Facebook)"),
      h(
        "div",
        { style: Object.assign({}, box, { padding: "0", overflow: "hidden", maxWidth: "500px", background: "#f0f2f5" }) },
        imgOk
          ? h("img", { src: image.charAt(0) === "/" ? image : "/" + image, alt: "", style: { width: "100%", aspectRatio: "1.91 / 1", objectFit: "cover", display: "block" } })
          : h("div", { style: { aspectRatio: "1.91 / 1", background: "#dfe3e8", color: "#555", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", textAlign: "center", padding: "8px" } }, o.imageNote ? String(o.imageNote) : "No picture"),
        h(
          "div",
          { style: { padding: "10px 14px 12px" } },
          h("div", { style: { fontSize: "12px", color: "#65676b", textTransform: "uppercase" } }, SEO_DOMAIN),
          h("div", { style: { fontSize: "16px", fontWeight: "bold", lineHeight: "1.3", margin: "2px 0" } }, seoClip(sTitle, 70) || "(no title yet)"),
          h("div", { style: { fontSize: "14px", color: "#65676b", lineHeight: "1.4" } }, seoClip(sDesc, 200))
        )
      )
    );
  }

  // ---------- enquiry-form helpers (For Brands + For Venues) ----------
  var OLD_BRAND_FIELDS = [
    { label: "Your name", type: "text", required: true },
    { label: "Company", type: "text", required: true },
    { label: "Work email", type: "email", required: true },
    { label: "Indicative monthly budget", type: "select", emptyOption: "Prefer not to say", options: ["Under £500", "£500 – £2,000", "£2,000 – £5,000", "£5,000+"] },
    { label: "Preferred campaign timing", type: "text", placeholder: "e.g. Sept – Dec 2026" },
    { label: "What are you looking to achieve?", type: "textarea", placeholder: "Campaign goals, timing, locations of interest…" },
  ];
  var OLD_VENUE_FIELDS = [
    { label: "Your name", type: "text", required: true },
    { label: "Venue / organisation", type: "text", required: true },
    { label: "Email", type: "email", required: true },
    { label: "Venue type", type: "select", options: ["University / school", "Shopping centre / retail", "Stadium / large venue", "Transport hub", "Office / workplace", "Hospitality", "Other"] },
    { label: "Anything we should know?", type: "textarea", placeholder: "Location, footfall, timelines…" },
  ];
  var OLD_FORM_HINT = "Goes straight to the team — we usually reply within a couple of days. See our privacy note for how we handle it.";
  function formText(e, key, oldKey, fb) {
    return g(e, ["form", key], oldKey ? g(e, [oldKey], fb) : fb);
  }
  function formFieldList(e, fallback) {
    var v = e.getIn(["data", "form", "fields"]);
    return v && v.toJS ? v.toJS() : fallback;
  }
  function previewField(f, i) {
    var type = ["text", "email", "tel", "textarea", "select"].indexOf(f.type) >= 0 ? f.type : "text";
    var choices = (f.options || []).filter(function (o) { return String(o || "").trim(); });
    // The live form leaves out a question without a label, and a dropdown that has no choices.
    if (!String(f.label || "").trim()) return null;
    if (type === "select" && !choices.length && !String(f.emptyOption || "").trim()) return null;
    var control;
    if (type === "textarea") {
      control = h("textarea", { placeholder: f.placeholder || "", readOnly: true });
    } else if (type === "select") {
      control = h(
        "select",
        {},
        f.emptyOption ? h("option", { key: "empty" }, f.emptyOption) : null,
        choices.map(function (o, j) { return h("option", { key: j }, o); })
      );
    } else {
      control = h("input", { type: type, placeholder: f.placeholder || "", readOnly: true });
    }
    var full = f.width === "full" || (!f.width && type === "textarea");
    return h(
      "div",
      { className: "field" + (full ? " full" : ""), key: i },
      h("label", {}, f.label || "", f.required ? h("span", { className: "req" }, " *") : null),
      control,
      f.hint ? h("span", { className: "form-hint" }, f.hint) : null
    );
  }
  function enquiryFormPreview(e, oldFields, defHeading, defButton, light) {
    var fields = formFieldList(e, oldFields);
    var hint = formText(e, "hint", "formHint", OLD_FORM_HINT);
    return h(
      "div",
      { className: "form-card" + (light ? " light-form" : "") },
      h("h3", {}, formText(e, "heading", "formHeading", defHeading)),
      h("div", { className: "form-grid" }, fields.map(previewField)),
      h(
        "div",
        { className: "form-actions" },
        h("span", { className: "btn btn-primary" }, formText(e, "button", "formButton", defButton)),
        hint ? h("span", { className: "form-hint" }, hint) : null
      ),
      note("After a successful send the visitor sees: " + formText(e, "success", null, "Sent — thank you! We'll get back to you within a couple of days."))
    );
  }

  // ---------- Hero ----------
  CMS.registerPreviewTemplate(
    "hero",
    createClass({
      render: function () {
        var e = this.props.entry;
        return h(
          "div",
          {},
          h(
            "section",
            { className: "hero" },
            h(
              "div",
              { className: "container hero-inner" },
              h("span", { className: "hero-badge" }, h("span", { className: "dot-pulse" }), " " + g(e, ["badge"])),
              h("h1", {}, g(e, ["headlineMain"]) + " ", h("span", { className: "accent" }, g(e, ["headlineAccent"]))),
              h("div", { className: "hero-stamp-row" }, h("span", { className: "stamp" }, g(e, ["stamp"]))),
              h("p", { className: "hero-sub" }, g(e, ["subhead"])),
              h(
                "div",
                { className: "hero-ctas" },
                h("span", { className: "btn btn-primary" }, g(e, ["ctaBrand"])),
                h("span", { className: "btn btn-outline" }, g(e, ["ctaVenue"]))
              ),
              h("p", { className: "hero-scroll" }, g(e, ["scrollText"]))
            )
          )
        );
      },
    })
  );

  // ---------- Problem ----------
  // Every value is read the way the live site reads it: a missing value shows
  // nothing (no invented defaults), so the preview matches what will be published.
  CMS.registerPreviewTemplate(
    "problem",
    createClass({
      render: function () {
        var e = this.props.entry;
        var stats = list(e, "stats");
        var photos = list(e, "photos");
        var manifesto = g(e, ["manifesto"]);
        var mSrc = g(e, ["manifestoPhoto", "src"]);
        var mAlt = g(e, ["manifestoPhoto", "alt"]);
        var sourceLabel = g(e, ["sourceLabel"]);
        var sourceText = g(e, ["sourceText"]);
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"]), false, true),
            manifesto
              ? h(
                  "div",
                  { className: "manifesto-duo" },
                  h("p", { className: "manifesto" }, String(manifesto).replace(/\*/g, "")),
                  mSrc ? h("figure", { className: "manifesto-photo" }, h("img", { src: imgSrc(mSrc), alt: mAlt })) : null
                )
              : null,
            h(
              "div",
              { className: "stats-grid" },
              stats.map(function (s, i) {
                return h(
                  "div",
                  { className: "stat-card", key: i },
                  h("div", { className: "stat-num" }, h("span", {}, s.number === undefined || s.number === null ? "" : String(s.number)), s.suffix === undefined || s.suffix === null ? "" : s.suffix),
                  h("p", { className: "stat-label" }, s.label)
                );
              })
            ),
            sourceText ? h("p", { className: "stats-source" }, sourceLabel ? sourceLabel + " " : "", h("a", {}, sourceText), ".") : null,
            h(
              "div",
              { className: "photo-strip" },
              photos.map(function (p, i) {
                if (!p.src) return null;
                var tilt = parseFloat(p.tilt);
                if (isNaN(tilt)) tilt = 0;
                tilt = Math.max(-10, Math.min(10, tilt));
                return h(
                  "figure",
                  { className: "polaroid", key: i, style: { "--tilt": tilt + "deg" } },
                  h("img", { src: imgSrc(p.src), alt: p.alt || "" }),
                  h("figcaption", {}, p.caption)
                );
              })
            )
          )
        );
      },
    })
  );

  // ---------- Model ----------
  // Mirrors model.njk: a missing value shows nothing (no invented defaults), the
  // film only shows when it has a video file, and the receipt shows whichever of
  // its parts are filled in (all empty = no receipt).
  CMS.registerPreviewTemplate(
    "model",
    createClass({
      render: function () {
        var e = this.props.entry;
        var steps = list(e, "steps");
        var arrow = g(e, ["loopArrow"]);
        var beltNode = e.getIn(["data", "belt", "words"]);
        var beltWords = beltNode && beltNode.toJS ? beltNode.toJS() : [];
        var repeats = Math.floor(Number(g(e, ["belt", "repeats"], "")));
        if (!isFinite(repeats) || repeats < 1) repeats = 1;
        if (repeats > 12) repeats = 12;
        var packs = [];
        for (var r = 0; r < repeats; r++) {
          beltWords.forEach(function (w, i) {
            packs.push(h("span", { className: "belt-pack", key: r + "-" + i }, w));
          });
        }
        var poster = g(e, ["video", "poster"]);
        var videoSrc = g(e, ["video", "src"]);
        var videoLabel = g(e, ["video", "label"]);
        var rcNode = e.getIn(["data", "receipt"]);
        var rc = rcNode && rcNode.toJS ? rcNode.toJS() : {};
        var rcRows = Array.isArray(rc.rows) ? rc.rows : [];
        var rcTotal = rc.total || {};
        var showReceipt = rc.brand || rc.meta || rcRows.length || rcTotal.label || rcTotal.value || rc.paid || rc.script;
        var kids = [];
        steps.forEach(function (s, i) {
          kids.push(
            h(
              "div",
              { className: "loop-step", key: "s" + i },
              h("div", { className: "loop-emoji" }, s.emoji),
              h("h3", {}, s.title),
              h("p", {}, s.desc)
            )
          );
          if (i < steps.length - 1) {
            kids.push(h("div", { className: "loop-arrow", key: "a" + i }, arrow));
          }
        });
        return h(
          "section",
          { className: "model-band texture-dots" },
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"]), true, false),
            h("div", { className: "loop" }, kids),
            packs.length ? h("div", { className: "conveyor" }, h("div", { className: "belt-track" }, packs)) : null,
            h(
              "div",
              { className: "model-visual" },
              videoSrc
                ? h(
                    "figure",
                    { className: "model-photo" },
                    h("video", { className: "model-video", poster: imgSrc(poster), "aria-label": videoLabel, muted: true, controls: true, preload: "none" })
                  )
                : null,
              showReceipt
                ? h(
                    "aside",
                    { className: "receipt" },
                    rc.brand ? h("p", { className: "r-brand" }, rc.brand, h("span", { className: "brand-period" }, ".")) : null,
                    rc.meta ? h("p", { className: "r-meta" }, rc.meta) : null,
                    rcRows.map(function (row, i) {
                      return h("div", { className: "r-row", key: "r" + i }, h("span", {}, row.label), h("span", {}, row.value));
                    }),
                    rcTotal.label || rcTotal.value
                      ? h("div", { className: "r-row r-total" }, h("span", {}, rcTotal.label), h("span", {}, rcTotal.value))
                      : null,
                    rc.paid ? h("p", { className: "r-paid" }, rc.paid) : null,
                    h("div", { className: "r-code" }),
                    rc.script ? h("p", { className: "r-script" }, rc.script) : null
                  )
                : null
            )
          )
        );
      },
    })
  );

  // ---------- How it works ----------
  CMS.registerPreviewTemplate(
    "how",
    createClass({
      render: function () {
        var e = this.props.entry;
        var story = list(e, "story");
        // Demo text: older entries have no "demo" block yet, so fall back to the original wording.
        function d(path, fb) {
          return g(e, ["demo"].concat(path), fb);
        }
        var chips = [
          d(["scan", "chip"], "Scan the QR"),
          d(["checkIn", "chip"], "Quick check-in"),
          d(["sponsor", "chip"], "A word from our sponsor"),
          d(["done", "chip"], "Covered."),
        ];
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"]), true, false),
            story.length
              ? h(
                  "div",
                  { className: "story-strip", role: "list", "aria-label": g(e, ["storyLabel"], "How COVERED works, in four moments") },
                  story.map(function (s, i) {
                    var src = s.src || (s.img ? s.img + ".jpg" : "");
                    return h(
                      "figure",
                      { className: "story-card", role: "listitem", key: i },
                      src ? h("img", { src: imgSrc(src), alt: s.alt || "" }) : null,
                      h("figcaption", {}, h("strong", {}, s.title), h("span", {}, s.caption))
                    );
                  })
                )
              : null,
            h(
              "ol",
              { className: "stepper", "aria-label": d(["stepperLabel"], "Demo progress") },
              chips.map(function (label, i) {
                return h(
                  "li",
                  { className: "step-chip" + (i === 0 ? " active" : ""), key: i },
                  h("span", { className: "n" }, String(i + 1)),
                  " " + label
                );
              })
            ),
            h(
              "div",
              { className: "demo-card" },
              h(
                "div",
                { className: "machine-stage" },
                h(
                  "div",
                  { className: "machine", role: "img", "aria-label": d(["machine", "ariaLabel"], "Illustration of a COVERED wall-mounted dispenser") },
                  h("span", { className: "led" }),
                  h("div", { className: "m-screen" }, h("div", { className: "qr" })),
                  h("div", { className: "m-label" }, d(["machine", "label"], "Covered")),
                  h("div", { className: "m-slot" }, h("div", { className: "pack" }, d(["machine", "packText"], "4-PACK")))
                )
              ),
              h(
                "div",
                { className: "phone" },
                h(
                  "div",
                  { className: "p-screen" },
                  h("h3", {}, d(["scan", "title"], "Need a pad or tampon?")),
                  h("p", {}, d(["scan", "text"], "Scan the QR code on the machine to get started — it's free.")),
                  h("button", { className: "btn btn-primary" }, d(["scan", "button"], "Simulate scan"))
                )
              )
            ),
            note("This shows the first screen of the demo. The other three screens (check-in, sponsor, done) appear when you click through the live demo on the site — their text is edited in “Interactive demo text” on the left."),
            h("p", { className: "demo-note" }, g(e, ["demoNote"]))
          )
        );
      },
    })
  );

  // ---------- Brands ----------
  CMS.registerPreviewTemplate(
    "brands",
    createClass({
      render: function () {
        var e = this.props.entry;
        var benefits = list(e, "benefits");
        var chips = list(e, "chips");
        return h(
          "section",
          { className: "dark" },
          h(
            "div",
            { className: "container" },
            h(
              "div",
              { className: "brands-head" },
              h(
                "div",
                {},
                h("span", { className: "kicker" }, g(e, ["kicker"])),
                titleEl("h2", { className: "section-title" }, g(e, ["title"])),
                h("p", { className: "section-sub" }, g(e, ["subtitle"]))
              ),
              h(
                "figure",
                { className: "polaroid" },
                h("img", { src: imgSrc(g(e, ["headerPhoto", "src"])), alt: g(e, ["headerPhoto", "alt"]) }),
                h("figcaption", {}, g(e, ["headerPhoto", "caption"]))
              )
            ),
            h(
              "div",
              { className: "benefit-grid" },
              benefits.map(function (b, i) {
                return h(
                  "div",
                  { className: "benefit", key: i },
                  h("div", { className: "b-icon" }, b.icon),
                  h("h3", {}, b.title),
                  h("p", {}, b.desc)
                );
              })
            ),
            h(
              "div",
              { className: "chip-row" },
              chips.map(function (c, i) {
                return h("span", { className: "chip", key: i }, c);
              })
            ),
            enquiryFormPreview(e, OLD_BRAND_FIELDS, "Get the media kit", "Request media kit", false)
          )
        );
      },
    })
  );

  // ---------- Partners ----------
  CMS.registerPreviewTemplate(
    "partners",
    createClass({
      render: function () {
        var e = this.props.entry;
        var slots = list(e, "slots");
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"]), false, true),
            h(
              "div",
              { className: "partner-grid" },
              slots.map(function (s, i) {
                return h(
                  "div",
                  { className: "p-slot" + (s.founding ? " founding" : ""), key: i },
                  s.founding && g(e, ["reservedStamp"], "Reserved") ? h("span", { className: "stamp", style: { fontSize: "0.95rem", padding: "0.3em 0.7em" } }, g(e, ["reservedStamp"], "Reserved")) : null,
                  h("span", { className: "slot-logo" }, s.logoText),
                  h("small", {}, s.category || "")
                );
              })
            ),
            h(
              "p",
              { style: { marginTop: "2rem", textAlign: "center" } },
              h("span", { className: "btn btn-primary" }, g(e, ["ctaButton"]))
            )
          )
        );
      },
    })
  );

  // ---------- Venues ----------
  // A list card is { icon, title, items }; entries saved before the cards were
  // editable stored just the list of items.
  function venueCard(e, key, oldIcon, oldTitle) {
    var v = e.getIn(["data", key]);
    v = v && v.toJS ? v.toJS() : v;
    if (Array.isArray(v)) { return { icon: oldIcon, title: oldTitle, items: v }; }
    v = v || {};
    return { icon: v.icon || oldIcon, title: v.title || oldTitle, items: v.items || [] };
  }
  CMS.registerPreviewTemplate(
    "venues",
    createClass({
      render: function () {
        var e = this.props.entry;
        var handle = venueCard(e, "weHandle", "🛠️", "We handle");
        var provide = venueCard(e, "youProvide", "🧩", "You provide");
        var photos = list(e, "photos");
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            h("span", { className: "pilot-ribbon" }, g(e, ["ribbon"])),
            h("span", { className: "kicker", style: { display: "block" } }, g(e, ["kicker"])),
            titleEl("h2", { className: "section-title" }, g(e, ["title"])),
            h("p", { className: "section-sub" }, g(e, ["subtitle"])),
            h(
              "div",
              { className: "cols-2" },
              h(
                "div",
                { className: "list-card" },
                h("h3", {}, handle.icon + " " + handle.title),
                h("ul", {}, handle.items.map(function (item, i) { return h("li", { key: i }, item); }))
              ),
              h(
                "div",
                { className: "list-card wants" },
                h("h3", {}, provide.icon + " " + provide.title),
                h("ul", {}, provide.items.map(function (item, i) { return h("li", { key: i }, item); }))
              )
            ),
            photos.length
              ? h(
                  "div",
                  { className: "photo-strip" },
                  photos.map(function (ph, i) {
                    return h(
                      "figure",
                      { className: "polaroid", key: i, style: { "--tilt": (parseFloat(ph.tilt) || 0) + "deg" } },
                      h("img", { src: imgSrc(ph.src), alt: ph.alt || "" }),
                      h("figcaption", {}, ph.caption || "")
                    );
                  })
                )
              : null,
            enquiryFormPreview(e, OLD_VENUE_FIELDS, "Register your interest", "Talk to us about hosting", true)
          )
        );
      },
    })
  );

  // ---------- Locations (map) ----------
  // The preview shows one city's description at a time, so list what every other
  // city says when a visitor picks it, and name the parked cities (kept off the map).
  function cityNotes(e, cities, shown) {
    var others = cities.filter(function (c) { return c !== shown; });
    var parked = list(e, "citiesHidden");
    return h(
      "div",
      {},
      others.length
        ? h(
            "details",
            { className: "cms-note" },
            h("summary", {}, "ℹ️ What visitors see when they pick each other city"),
            others.map(function (c, i) {
              var tag = c.live ? g(e, ["labels", "statusLive"]) : g(e, ["labels", "statusSoon"]);
              return h("p", { key: i }, (c.name || "") + " — " + tag + " — " + (c.blurb || ""));
            })
          )
        : null,
      parked.length
        ? note("Parked cities (kept off the map for now): " + parked.map(function (c) { return c.name || ""; }).join(", "))
        : null
    );
  }
  CMS.registerPreviewTemplate(
    "locations",
    createClass({
      render: function () {
        var e = this.props.entry;
        var cities = list(e, "cities");
        var types = list(e, "placeTypes");
        var live = cities.filter(function (c) { return c.live; })[0] || cities[0] || {};
        var mapImage = g(e, ["mapImage"]);
        var viewBox = g(e, ["svgViewBox"], "0 0 765 1024");
        var box = String(viewBox).split(" ");
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"]), true, true),
            h(
              "div",
              { className: "loc-grid" },
              h(
                "div",
                { className: "uk-map-wrap" },
                h(
                  "svg",
                  { className: "uk-map", viewBox: viewBox },
                  mapImage ? h("image", { href: imgSrc(mapImage), x: 0, y: 0, width: box[2], height: box[3] }) : null,
                  mapImage ? null : h("path", { className: "uk-neighbor", d: g(e, ["neighborPath"]) }),
                  mapImage ? null : h("path", { className: "uk-land", d: g(e, ["landPath"]) }),
                  h(
                    "g",
                    {},
                    cities.map(function (c, i) {
                      return h("circle", {
                        key: i,
                        cx: c.x,
                        cy: c.y,
                        r: c.live ? 7 : 5.5,
                        // live pin = the "button colour"; roadmap pin = white with a dark outline (as the legend)
                        style: { fill: c.live ? "var(--red-deep)" : "#fff", stroke: c.live ? "var(--red-deep)" : "var(--ink)" },
                        strokeWidth: 2,
                      });
                    })
                  )
                ),
                h(
                  "div",
                  { className: "map-legend" },
                  h("span", {}, h("span", { className: "dot live" }), g(e, ["labels", "legendLive"], "Pilot city")),
                  h("span", {}, h("span", { className: "dot soon" }), g(e, ["labels", "legendSoon"], "On the roadmap"))
                )
              ),
              h(
                "div",
                {},
                h(
                  "div",
                  { className: "city-chips", role: "group", "aria-label": g(e, ["labels", "cityPickerAriaLabel"], "Choose a city to see its status") },
                  cities.map(function (c, i) {
                    return h(
                      "button",
                      { className: "city-chip", key: i, "aria-pressed": c.live ? "true" : "false" },
                      c.name,
                      c.live && g(e, ["labels", "liveBadge"], "● pilot") ? h("span", { className: "badge-live" }, " " + g(e, ["labels", "liveBadge"], "● pilot")) : null
                    );
                  })
                ),
                h(
                  "div",
                  { className: "city-detail" },
                  h(
                    "h3",
                    {},
                    live.name || "",
                    " ",
                    h("span", { className: "status-tag " + (live.live ? "live" : "soon") }, live.live ? g(e, ["labels", "statusLive"], "Pilot — recruiting venues") : g(e, ["labels", "statusSoon"], "On the roadmap"))
                  ),
                  h("p", {}, live.blurb || "")
                ),
                h(
                  "div",
                  { className: "loc-types" },
                  h("p", { className: "loc-types-title" }, g(e, ["placeTypesTitle"], "The kinds of places we're targeting first:")),
                  h(
                    "div",
                    { className: "chip-row" },
                    types.map(function (t, i) {
                      return h("span", { className: "chip", key: i }, [t.emoji, t.label].filter(function (x) { return x !== undefined && x !== null && x !== ""; }).join(" "));
                    })
                  ),
                  h("p", { className: "loc-cta" }, h("span", { className: "btn btn-outline" }, g(e, ["ctaButton"])))
                )
              )
            ),
            cityNotes(e, cities, live)
          )
        );
      },
    })
  );

  // ---------- Vision ----------
  CMS.registerPreviewTemplate(
    "vision",
    createClass({
      render: function () {
        var e = this.props.entry;
        var milestones = list(e, "milestones");
        var chips = list(e, "soonChips");
        return h(
          "section",
          { className: "vision-band texture-dots" },
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), null, true, true),
            h(
              "div",
              { className: "timeline" },
              milestones.map(function (m, i) {
                return h(
                  "div",
                  { className: "milestone", key: i },
                  h("span", { className: "phase-tag" }, m.tag),
                  h("h3", {}, m.title),
                  h("p", {}, m.desc)
                );
              })
            ),
            h(
              "div",
              { className: "bip" },
              h("h3", {}, g(e, ["bipTitle"])),
              h("p", {}, g(e, ["bipText"])),
              h(
                "div",
                { className: "soon-chips" },
                chips.map(function (c, i) {
                  return h("span", { className: "chip", key: i }, c);
                })
              ),
              h(
                "div",
                { className: "notify-form" },
                h("input", { type: "email", readOnly: true, placeholder: g(e, ["notify", "placeholder"]), "aria-label": g(e, ["notify", "label"]) }),
                h("span", { className: "btn btn-primary" }, g(e, ["notify", "button"]))
              )
            ),
            note("After a successful sign-up the visitor sees: " + g(e, ["notify", "success"]))
          )
        );
      },
    })
  );

  // ---------- FAQ ----------
  CMS.registerPreviewTemplate(
    "faq",
    createClass({
      render: function () {
        var e = this.props.entry;
        var items = list(e, "items");
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), null, true, false),
            h(
              "div",
              { className: "faq-list" },
              items.map(function (item, i) {
                return h(
                  "div",
                  { className: "faq-item open", key: i },
                  h("button", { className: "faq-q" }, item.q, h("span", { className: "indicator" }, "+")),
                  h("div", { className: "faq-a" }, h("div", { className: "faq-a-inner" }, item.a))
                );
              })
            )
          )
        );
      },
    })
  );

  // ---------- Editor-created pages (block builder) ----------
  CMS.registerPreviewTemplate(
    "pages",
    createClass({
      render: function () {
        var e = this.props.entry;
        var blocks = e.getIn(["data", "sections"]);
        blocks = blocks && blocks.toJS ? blocks.toJS() : [];
        function paras(text) {
          return String(text || "").split(/\n\n+/).filter(Boolean).map(function (p, i) {
            return h("p", { key: i, style: { marginBottom: "0.8em" } }, p);
          });
        }
        var pageTitle = g(e, ["seoTitle"]) || (g(e, ["title"]) ? String(g(e, ["title"])) + " — COVERED" : "");
        return h(
          "div",
          {},
          seoPreview({
            title: pageTitle,
            desc: g(e, ["description"]),
            path: g(e, ["permalink"]),
            socialTitle: g(e, ["socialTitle"]),
            socialDesc: g(e, ["socialDescription"]),
            image: g(e, ["shareImage"]),
            imageNote: "The site-wide social share picture is used (Site-wide settings)",
            hidden: g(e, ["hideFromSearch"]) === true,
          }),
          note("The search title ends with “ — COVERED” unless you typed a Search title or changed the ending in Site-wide settings."),
          blocks.length === 0 ? note("Add sections with the “Add page sections” button — they preview here as you type.") : null,
          blocks.map(function (b, i) {
            if (b.type === "hero") {
              return h("section", { className: "hero", key: i, style: { padding: "4rem 0 2.5rem" } },
                h("div", { className: "container hero-inner" },
                  h("h1", {}, b.heading || "", b.accent ? h("span", { className: "accent" }, " " + b.accent) : null),
                  b.sub ? h("p", { className: "hero-sub" }, b.sub) : null,
                  b.ctaText ? h("div", { className: "hero-ctas" }, h("span", { className: "btn btn-primary" }, b.ctaText)) : null));
            }
            if (b.type === "text") {
              return h("section", { key: i }, h("div", { className: "container" },
                b.kicker ? h("span", { className: "kicker" }, b.kicker) : null,
                b.heading ? h("h2", { className: "section-title" }, b.heading) : null,
                h("div", { className: "section-sub" }, paras(b.body))));
            }
            if (b.type === "imageText") {
              var img = h("figure", { className: "polaroid", style: { maxWidth: "380px" } },
                h("img", { src: b.image && b.image.charAt(0) === "/" ? b.image : "/" + (b.image || "") }),
                b.caption ? h("figcaption", {}, b.caption) : null);
              var txt = h("div", {},
                b.heading ? h("h2", { className: "section-title" }, b.heading) : null,
                h("div", { className: "section-sub" }, paras(b.body)));
              return h("section", { key: i }, h("div", { className: "container", style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2.5rem", alignItems: "center" } },
                b.imageRight ? txt : img, b.imageRight ? img : txt));
            }
            if (b.type === "stats") {
              return h("section", { key: i }, h("div", { className: "container" },
                b.heading ? h("h2", { className: "section-title", style: { textAlign: "center" } }, b.heading) : null,
                h("div", { className: "stats-grid" }, (b.items || []).map(function (it, j) {
                  return h("div", { className: "stat-card", key: j },
                    h("div", { className: "stat-num" }, it.number || ""),
                    h("p", { className: "stat-label" }, it.label || ""));
                }))));
            }
            if (b.type === "banner") {
              return h("section", { key: i }, h("div", { className: "container" },
                h("div", { className: "cta-banner" },
                  h("h2", {}, b.title || ""),
                  b.text ? h("p", {}, b.text) : null,
                  b.buttonText ? h("span", { className: "btn btn-light" }, b.buttonText) : null)));
            }
            if (b.type === "faq") {
              return h("section", { key: i }, h("div", { className: "container" },
                b.heading ? h("h2", { className: "section-title", style: { textAlign: "center" } }, b.heading) : null,
                h("div", { className: "faq-list" }, (b.items || []).map(function (it, j) {
                  return h("div", { className: "faq-item open", key: j },
                    h("div", { className: "faq-q" }, it.q || ""),
                    h("div", { className: "faq-a", style: { maxHeight: "none" } }, h("div", { className: "faq-a-inner" }, it.a || "")));
                }))));
            }
            return null;
          })
        );
      },
    })
  );

  // ---------- Redirects ----------
  CMS.registerPreviewTemplate(
    "redirects",
    createClass({
      render: function () {
        var items = list(this.props.entry, "items");
        var seen = {};
        var okFrom = /^\/[A-Za-z0-9._~%+-][A-Za-z0-9._~\/%+-]*$/;
        var okTo = /^(\/(?!\/)[A-Za-z0-9._~\/%+=?#-]*|https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\/%+=?#-]*)?)$/;
        return h(
          "div",
          { style: { width: "min(1120px, 92%)", margin: "14px auto", fontFamily: "Arial, sans-serif", fontSize: "14px" } },
          note("Each line sends visitors from an old address to a new one. Lines that cannot work are ignored by the website; they are marked below."),
          items.length === 0 ? note("No redirects yet.") : null,
          h(
            "ul",
            {},
            items.map(function (it, i) {
              var from = it && typeof it.fromLink === "string" ? it.fromLink.trim() : "";
              var to = it && typeof it.toLink === "string" ? it.toLink.trim() : "";
              var key = from.replace(/\/+$/, "").toLowerCase();
              var problem = "";
              if (!okFrom.test(from) || from.indexOf("..") >= 0 || from.indexOf("//") >= 0) problem = "the old address must look like /old-page/";
              else if (!okTo.test(to)) problem = "the new address must be a /page/ on this site or a full https:// address";
              else if (key === to.replace(/\/+$/, "").toLowerCase()) problem = "it sends the page to itself";
              else if (seen[key]) problem = "this old address is already used by an earlier line";
              seen[key] = true;
              return h("li", { key: i, style: { margin: "4px 0", color: problem ? "#b00020" : "inherit" } }, from + "  →  " + to + (it && it.permanent === false ? "  (temporary)" : "  (permanent)") + (problem ? "  - ignored: " + problem : ""));
            })
          )
        );
      },
    })
  );

  // ---------- Homepage layout (running order) ----------
  // Two homepage sections keep their text in the layout entry itself (the ticker
  // words and the closing banner's extras), so show it under their row.
  function tickerSentence(s) {
    var words = (s.items || []).map(function (w) { return String(w).toLowerCase(); });
    var out = s.screenReaderIntro ? s.screenReaderIntro + " " : "";
    words.forEach(function (w, i) {
      out += w;
      if (i === words.length - 2) out += " " + (s.screenReaderJoiner || "") + " ";
      else if (i < words.length - 1) out += ", ";
    });
    return out + (s.screenReaderEnd || "");
  }
  function sectionExtras(s) {
    if (!s) return null;
    if (s.type === "marquee") {
      var words = Array.isArray(s.items) ? s.items : [];
      if (!words.length) return note("No ticker words — the ticker is not shown on the site.");
      return h(
        "div",
        {},
        h(
          "div",
          { className: "marquee" },
          h("div", { className: "marquee-track" }, words.map(function (w, j) { return h("span", { key: j }, w); }))
        ),
        note("Hidden sentence for screen readers: “" + tickerSentence(s) + "”"),
        note("Pause button label for screen readers: “" + (s.pauseLabel || "") + "”")
      );
    }
    if (s.type === "cta") {
      var v = s.video || {};
      return h(
        "div",
        {},
        note("The banner’s heading, text and button label are edited under “Site-wide”."),
        note("Brand animation: " + (v.src ? v.src : "none — the animation is hidden") + (v.src && v.poster ? " (cover picture " + v.poster + ")" : "")),
        note("Animation description for screen readers: “" + (s.videoLabel || "") + "”"),
        note("Section name for screen readers: “" + (s.ariaLabel || "") + "”"),
        note("Email subject when the banner button is clicked: “" + (s.emailSubject || "") + "”")
      );
    }
    return null;
  }
  CMS.registerPreviewTemplate(
    "homepage",
    createClass({
      render: function () {
        var e = this.props.entry;
        var sections = e.getIn(["data", "sections"]);
        sections = sections && sections.toJS ? sections.toJS() : [];
        var names = {
          hero: "🏠 Hero (big opening screen)",
          marquee: "🎞️ Scrolling venue ticker",
          problem: "📊 The problem (stats & photos)",
          model: "🔁 The model (Brands pay. You don't.)",
          how: "📱 How it works (interactive demo)",
          brands: "📣 For brands (advertising enquiry)",
          partners: "🤝 Partner wall",
          venues: "🏟️ For venues (hosting enquiry)",
          locations: "🗺️ Locations (UK map)",
          vision: "🚀 Vision / roadmap",
          faq: "❓ FAQ",
          cta: "✉️ Closing banner (get in touch)",
          textBlock: "📝 Text section (yours)",
          imageTextBlock: "🖼️ Image + text (yours)",
          statsBlock: "🔢 Number cards (yours)",
          bannerBlock: "📣 Big call-to-action banner (yours)",
          faqBlock: "❓ Questions & answers (yours)",
        };
        return h(
          "div",
          {},
          note("The homepage running order, top to bottom. Drag sections in the editor to rearrange the live page; hidden sections stay saved but don't appear."),
          sections.map(function (s, i) {
            var hidden = s && s.enabled === false;
            var label = names[s && s.type] || (s && s.type ? s.type : "Unknown section");
            return h(
              "div",
              { key: i },
              h(
                "p",
                {
                  className: "cms-note",
                  style: hidden ? { opacity: 0.55, textDecoration: "line-through" } : {},
                },
                (i + 1) + ". " + label + (hidden ? " — hidden" : "")
              ),
              hidden ? null : sectionExtras(s)
            );
          })
        );
      },
    })
  );

  // ---------- Site-wide ----------
  CMS.registerPreviewTemplate(
    "site",
    createClass({
      render: function () {
        var e = this.props.entry;
        return h(
          "div",
          {},
          seoPreview({
            title: g(e, ["pageTitle"]),
            desc: g(e, ["metaDescription"]),
            path: "",
            socialTitle: g(e, ["socialTitle"]),
            socialDesc: g(e, ["ogDescription"]),
            image: g(e, ["shareImage"]),
            imageNote: "No social share picture chosen yet",
            hidden: g(e, ["hideFromSearch"]) === true,
          }),
          note("Browser-tab title: " + g(e, ["pageTitle"])),
          note("Search-engine description: " + g(e, ["metaDescription"])),
          note("Social-share description: " + g(e, ["ogDescription"])),
          note("Contact email (every “Email us” link, the closing-banner button and the forms’ fallback e-mail): " + g(e, ["contactEmail"])),
          note("Browser-tab title on other pages: " + g(e, ["subpageTitle"], "{title} — COVERED")),
          note("Social share picture: " + g(e, ["shareImage"], "none")),
          note("Updates feed name: " + g(e, ["feedTitle"], "COVERED updates")),
          note("Search-engine tagline: " + g(e, ["schemaSlogan"])),
          note("Search-engine description: " + g(e, ["schemaDescription"])),
          note("Search-engine location: " + g(e, ["schemaPlace"])),
          h(
            "section",
            {},
            h(
              "div",
              { className: "container" },
              h(
                "div",
                { className: "cta-banner" },
                h("h2", {}, g(e, ["ctaBannerTitle"])),
                h("p", {}, g(e, ["ctaBannerText"])),
                h("span", { className: "btn btn-light" }, g(e, ["ctaBannerButton"]))
              )
            )
          )
        );
      },
    })
  );

  // ---------- Navigation menu + footer (shared page chrome) ----------
  function chromeLogo() {
    return h(
      "a",
      { className: "logo", href: "#" },
      h(
        "span",
        { className: "logo-mark" },
        h(
          "svg",
          { viewBox: "0 0 48 48" },
          h("path", { fill: "#94AB8D", d: "M31 8C36.5 17 44 22.5 44 33A13 13 0 1 1 18 33C18 22.5 25.5 17 31 8Z" }),
          h("circle", { cx: 15, cy: 15, r: 11, fill: "#F0A35C" })
        )
      ),
      "COVERED",
      h("span", { className: "logo-dot" }, ".")
    );
  }
  function chromeLinks(items, extraProps) {
    return (items || []).map(function (it, i) {
      var props = { href: "#" };
      if (it && it.button) props.className = "btn btn-primary";
      if (extraProps) for (var k in extraProps) props[k] = extraProps[k];
      return h("li", { key: i }, h("a", props, (it && it.label) || ""));
    });
  }

  CMS.registerPreviewTemplate(
    "nav",
    createClass({
      render: function () {
        var e = this.props.entry;
        return h(
          "div",
          {},
          h(
            "header",
            { style: { position: "static" } },
            h(
              "div",
              { className: "container nav" },
              chromeLogo(),
              h(
                "ul",
                {
                  className: "nav-links",
                  style: { display: "flex", position: "static", maxHeight: "none", flexWrap: "wrap", boxShadow: "none", background: "transparent", padding: 0 },
                },
                chromeLinks(list(e, "items"))
              )
            )
          ),
          note("Skip link (hidden until someone presses Tab): \"" + g(e, ["skipLink"], "Skip to content") + "\""),
          note("Logo label for screen readers: \"" + g(e, ["homeLabel"], "COVERED home") + "\""),
          note("Mobile menu button label for screen readers: \"" + g(e, ["menuLabel"], "Toggle menu") + "\""),
          note("Button on About, Privacy and other pages: \"" + g(e, ["backLabel"], "Back to main site") + "\""),
          note("Links to sections that are switched off in “Page layout” are left out automatically on the live site.")
        );
      },
    })
  );

  CMS.registerPreviewTemplate(
    "footer",
    createClass({
      render: function () {
        var e = this.props.entry;
        var year = String(new Date().getFullYear());
        var copyright = String(g(e, ["copyright"], "© {year} COVERED. All rights reserved."));
        var updated = g(e, ["lastUpdated"], "");
        var signOff = g(e, ["signOff"], "");
        var emoji = g(e, ["signOffEmoji"], "");
        var columns = list(e, "columns");
        var compact = list(e, "compactLinks");
        var compactKids = [];
        compact.forEach(function (it, i) {
          if (i > 0) compactKids.push(" · ");
          compactKids.push(h("a", { href: "#", key: i, style: { color: "inherit" } }, (it && it.label) || ""));
        });
        return h(
          "div",
          {},
          h(
            "footer",
            {},
            h(
              "div",
              { className: "container" },
              h(
                "div",
                { className: "foot-grid" },
                h("div", { className: "foot-brand" }, chromeLogo(), h("p", {}, g(e, ["tagline"]))),
                columns.map(function (col, i) {
                  return h(
                    "nav",
                    { className: "foot-col", key: i },
                    h("p", { className: "foot-head" }, (col && col.heading) || ""),
                    h("ul", {}, chromeLinks(col && col.links))
                  );
                })
              ),
              h(
                "div",
                { className: "foot-bottom" },
                h("span", {}, copyright.replace("{year}", year)),
                updated ? h("span", {}, g(e, ["updatedLabel"], "Last updated:") + " " + updated) : null,
                signOff ? h("span", { className: "script", style: { fontSize: "1.15rem" } }, signOff) : null,
                emoji ? h("span", { "aria-hidden": "true" }, emoji) : null
              )
            )
          ),
          note("Below: the slim footer shown on About, Privacy and other pages."),
          h(
            "footer",
            {},
            h(
              "div",
              { className: "container" },
              h(
                "div",
                { className: "foot-bottom", style: { marginTop: 0, paddingTop: 0, borderTop: "none" } },
                h("span", {}, copyright.replace("{year} ", "").replace("{year}", "")),
                h("span", {}, compactKids)
              )
            )
          ),
          note("Links to sections that are switched off in “Page layout” are left out automatically on the live site.")
        );
      },
    })
  );
})();
