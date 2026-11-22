"use strict";
// One known-bad example per rule (studio/PHASE1-DESIGN.md 8.5, "proven non-vacuous"). Node only: used by the CI guard
// (check-content-rules.js proves every rule still flags its own example, so a rule that was quietly disabled cannot pass),
// by the parity test (panel and CI must agree on these) and by the selftest. The examples are tiny synthetic drafts written against
// the real schema's file names; if a field is renamed the example stops firing and the guard says which rule lost its proof.
const FACTS = {
  routes: ["/", "/about/", "/privacy/"], tools: [], anchors: { "/": ["how", "faq"], "/about/": [], "/privacy/": [] }, redirectFrom: [],
  images: { "heavy.jpg": { bytes: 900 * 1024, width: 4000, height: 3000 }, "p1.jpg": { bytes: 2000 * 1024, width: 1000, height: 1000 }, "p2.jpg": { bytes: 2000 * 1024, width: 1000, height: 1000 } },
  pages: { "/": { images: ["p1.jpg", "p2.jpg"], bytes: 4096000 } },
};

const story = (o) => ({ how: { story: [Object.assign({ src: "x.jpg", title: "t", caption: "c", alt: "A hand taking a pad from the dispenser", decorative: false }, o)] } });

const SEEDS = [
  { rule: "alt-missing", files: story({ alt: "" }), expect: "alt-missing|how|/story/0/alt", severity: "block" },
  { rule: "alt-weak", files: story({ alt: "ab" }), expect: "alt-weak|how|/story/0/alt", severity: "warn" },
  { rule: "title-length", files: { site: { pageTitle: "Hi" } }, expect: "title-length|site|/pageTitle", severity: "warn" },
  { rule: "description-length", files: { site: { metaDescription: "Too short." } }, expect: "description-length|site|/metaDescription", severity: "warn" },
  { rule: "duplicate-text", files: { faq: { items: [{ q: "Is it free?", a: "Yes." }, { q: "is it free? ", a: "Still yes." }] } }, expect: "duplicate-text|faq|/items/1/q", severity: "warn" },
  { rule: "vague-link-text", files: { nav: { items: [{ type: "link", label: "Click here", url: "/about/" }] } }, expect: "vague-link-text|nav|/items/0/label", severity: "warn" },
  { rule: "broken-internal-link", files: { nav: { items: [{ type: "link", label: "Gone", url: "/no-such-page/" }] } }, expect: "broken-internal-link|nav|/items/0/url", severity: "block" },
  { rule: "heading-skip", files: { "pages:about": { title: "About", _body: "## One\n\n#### Four\n" } }, expect: "heading-skip|pages:about|/_body", severity: "warn" },
  { rule: "image-heavy", files: story({ src: "heavy.jpg" }), expect: "image-heavy|how|/story/0/src", severity: "warn" },
  { rule: "page-weight", files: {}, expect: "page-weight|/|", severity: "warn" },
];

// the same seeds with the facts every consumer gets
module.exports = { SEEDS, FACTS };
