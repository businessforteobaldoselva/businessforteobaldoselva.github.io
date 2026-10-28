/* COVERED — Decap CMS live previews.
   Renders each editable section with the site's real markup + stylesheet,
   so edits appear exactly as they will on the published page. */
/* global CMS, createClass, h */
(function () {
  "use strict";

  // The site stylesheet (built by Eleventy from the same CSS the page inlines)
  CMS.registerPreviewStyle("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap");
  CMS.registerPreviewStyle("/assets/site.css");
  // Preview-only overrides: no scroll-reveal hiding, no animations, breathing room
  CMS.registerPreviewStyle(
    [
      "body { background: #1D2452; margin: 0; color: #EAF3FA; }",
      "*, *::before, *::after { animation: none !important; transition: none !important; }",
      ".reveal { opacity: 1 !important; transform: none !important; }",
      ".w-rise { opacity: 1 !important; transform: none !important; }",
      "section { padding: 3rem 0 !important; }",
      ".faq-a { max-height: none !important; }",
      ".cms-note { font-family: Inter, sans-serif; font-size: 12px; color: #56618A; background: #D9E7F4; border: 1px dashed #b9c5da; border-radius: 8px; padding: 8px 12px; margin: 12px auto; width: min(1120px, 92%); }",
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
  function raw(tag, props, htmlString) {
    props = props || {};
    props.dangerouslySetInnerHTML = { __html: htmlString };
    return h(tag, props);
  }
  function imgSrc(src) {
    if (!src) return "";
    return src.charAt(0) === "/" ? src : "/" + src;
  }
  function note(text) {
    return h("p", { className: "cms-note" }, "ℹ️ " + text);
  }
  function sectionHead(kicker, titleHtml, subtitle, center) {
    return h(
      "div",
      { style: center ? { textAlign: "center" } : {} },
      h("span", { className: "kicker" }, kicker),
      raw("h2", { className: "section-title" }, titleHtml),
      subtitle ? h("p", { className: "section-sub", style: center ? { margin: "0 auto" } : {} }, subtitle) : null
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
  CMS.registerPreviewTemplate(
    "problem",
    createClass({
      render: function () {
        var e = this.props.entry;
        var stats = list(e, "stats");
        var photos = list(e, "photos");
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"])),
            h(
              "div",
              { className: "stats-grid" },
              stats.map(function (s, i) {
                return h(
                  "div",
                  { className: "stat-card", key: i },
                  h("div", { className: "stat-num" }, h("span", {}, String(s.number)), "%"),
                  h("p", { className: "stat-label" }, s.label)
                );
              })
            ),
            h("p", { className: "stats-source" }, "Source: ", h("a", {}, g(e, ["sourceText"])), "."),
            h(
              "div",
              { className: "photo-strip" },
              photos.map(function (p, i) {
                return h(
                  "figure",
                  { className: "polaroid", key: i, style: { "--tilt": p.tilt || "-2deg" } },
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
  CMS.registerPreviewTemplate(
    "model",
    createClass({
      render: function () {
        var e = this.props.entry;
        var steps = list(e, "steps");
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
            kids.push(h("div", { className: "loop-arrow", key: "a" + i }, "→"));
          }
        });
        return h(
          "section",
          { className: "model-band texture-dots" },
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"]), true),
            h("div", { className: "loop" }, kids)
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
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"]), true),
            h(
              "ol",
              { className: "stepper" },
              ["Scan the QR", "Quick check-in", "A word from our sponsor", "Covered."].map(function (label, i) {
                return h(
                  "li",
                  { className: "step-chip" + (i === 0 ? " active" : ""), key: i },
                  h("span", { className: "n" }, String(i + 1)),
                  " " + label
                );
              })
            ),
            note("The interactive machine demo itself is code — it isn't edited here and stays exactly as it is."),
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
                raw("h2", { className: "section-title" }, g(e, ["title"])),
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
                return raw("span", { className: "chip", key: i }, c);
              })
            ),
            h(
              "div",
              { className: "form-card" },
              h("h3", {}, g(e, ["formHeading"])),
              h(
                "div",
                { className: "form-actions" },
                h("span", { className: "btn btn-primary" }, g(e, ["formButton"])),
                h("span", { className: "form-hint" }, g(e, ["formHint"]))
              )
            )
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
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"])),
            h(
              "div",
              { className: "partner-grid" },
              slots.map(function (s, i) {
                return h(
                  "div",
                  { className: "p-slot" + (s.founding ? " founding" : ""), key: i },
                  s.founding ? h("span", { className: "stamp", style: { fontSize: "0.95rem", padding: "0.3em 0.7em" } }, "Reserved") : null,
                  h("span", { className: "slot-logo" }, s.logoText),
                  raw("small", {}, s.category || "")
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
  CMS.registerPreviewTemplate(
    "venues",
    createClass({
      render: function () {
        var e = this.props.entry;
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            h("span", { className: "pilot-ribbon" }, g(e, ["ribbon"])),
            h("span", { className: "kicker", style: { display: "block" } }, g(e, ["kicker"])),
            raw("h2", { className: "section-title" }, g(e, ["title"])),
            h("p", { className: "section-sub" }, g(e, ["subtitle"])),
            h(
              "div",
              { className: "cols-2" },
              h(
                "div",
                { className: "list-card" },
                h("h3", {}, "🛠️ We handle"),
                h("ul", {}, list(e, "weHandle").map(function (item, i) { return h("li", { key: i }, item); }))
              ),
              h(
                "div",
                { className: "list-card wants" },
                h("h3", {}, "🧩 You provide"),
                h("ul", {}, list(e, "youProvide").map(function (item, i) { return h("li", { key: i }, item); }))
              )
            ),
            h(
              "div",
              { className: "form-card light-form" },
              h("h3", {}, g(e, ["formHeading"])),
              h(
                "div",
                { className: "form-actions" },
                h("span", { className: "btn btn-primary" }, g(e, ["formButton"])),
                h("span", { className: "form-hint" }, g(e, ["formHint"]))
              )
            )
          )
        );
      },
    })
  );

  // ---------- Locations (map) ----------
  CMS.registerPreviewTemplate(
    "locations",
    createClass({
      render: function () {
        var e = this.props.entry;
        var cities = list(e, "cities");
        var types = list(e, "placeTypes");
        var live = cities.filter(function (c) { return c.live; })[0] || cities[0] || {};
        return h(
          "section",
          {},
          h(
            "div",
            { className: "container" },
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), g(e, ["subtitle"]), true),
            h(
              "div",
              { className: "loc-grid" },
              h(
                "div",
                { className: "uk-map-wrap" },
                h(
                  "svg",
                  { className: "uk-map", viewBox: g(e, ["svgViewBox"], "0 0 475 624") },
                  h("path", { className: "uk-neighbor", d: g(e, ["neighborPath"]) }),
                  h("path", { className: "uk-land", d: g(e, ["landPath"]) }),
                  h(
                    "g",
                    {},
                    cities.map(function (c, i) {
                      return h("circle", {
                        key: i,
                        cx: c.x,
                        cy: c.y,
                        r: c.live ? 7 : 5.5,
                        fill: c.live ? "#C94D00" : "#fff",
                        stroke: c.live ? "#C94D00" : "#1D2452",
                        strokeWidth: 2,
                      });
                    })
                  )
                ),
                h(
                  "div",
                  { className: "map-legend" },
                  h("span", {}, h("span", { className: "dot live" }), "Pilot city"),
                  h("span", {}, h("span", { className: "dot soon" }), "On the roadmap")
                )
              ),
              h(
                "div",
                {},
                h(
                  "div",
                  { className: "city-chips" },
                  cities.map(function (c, i) {
                    return h(
                      "button",
                      { className: "city-chip", key: i, "aria-pressed": c.live ? "true" : "false" },
                      c.name,
                      c.live ? h("span", { className: "badge-live" }, " ● pilot") : null
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
                    h("span", { className: "status-tag " + (live.live ? "live" : "soon") }, live.live ? "Pilot — recruiting venues" : "On the roadmap")
                  ),
                  h("p", {}, live.blurb || "")
                ),
                h(
                  "div",
                  { className: "loc-types" },
                  h("p", { className: "loc-types-title" }, "The kinds of places we're targeting first:"),
                  h(
                    "div",
                    { className: "chip-row" },
                    types.map(function (t, i) {
                      return h("span", { className: "chip", key: i }, t.emoji + " " + t.label);
                    })
                  ),
                  h("p", { className: "loc-cta" }, h("span", { className: "btn btn-outline" }, g(e, ["ctaButton"])))
                )
              )
            )
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
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), null, true),
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
              )
            )
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
            sectionHead(g(e, ["kicker"]), g(e, ["title"]), null, true),
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
        return h(
          "div",
          {},
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

  // ---------- Homepage layout (running order) ----------
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
          bannerBlock: "📣 Big orange banner (yours)",
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
              "p",
              {
                className: "cms-note",
                key: i,
                style: hidden ? { opacity: 0.55, textDecoration: "line-through" } : {},
              },
              (i + 1) + ". " + label + (hidden ? " — hidden" : "")
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
          note("Browser-tab title: " + g(e, ["pageTitle"])),
          note("Search-engine description: " + g(e, ["metaDescription"])),
          note("Social-share description: " + g(e, ["ogDescription"])),
          note("Contact email (all forms + footer): " + g(e, ["contactEmail"])),
          note("Browser-tab title on other pages: " + g(e, ["subpageTitle"], "{title} — COVERED")),
          note("Social share picture: " + g(e, ["shareImage"], "/images/covered-og.jpg")),
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
