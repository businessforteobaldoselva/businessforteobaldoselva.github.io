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
      "body { background: #EAF3FA; margin: 0; }",
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
          note("Footer: \"" + g(e, ["footerTagline"]) + "\" · Last updated: " + g(e, ["lastUpdated"])),
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
})();
