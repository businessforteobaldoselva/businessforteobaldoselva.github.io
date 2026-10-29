"use strict";
// Unit checks of the accessibility gate's own parts (node scripts/check-a11y.js --unit, and part of selftest):
// the contrast maths, the CSS reader / cascade, the contrast finder and the structure rules, each on
// tiny hand-written pages whose answer is known.

const { parseDocument } = require("htmlparser2");
const CC = require("../../cms/contrast.js");
const { Styler, evalLength } = require("./a11y-style");
const { parseSelector, matchComplex } = require("./a11y-css");
const { analysePage } = require("./a11y-contrast");
const { analyseStructure } = require("./a11y-structure");

let ok = 0;
const bad = [];
function t(name, cond, detail) {
  if (cond) ok += 1;
  else {
    bad.push(name);
    console.log("  FAIL  a11y unit: " + name + (detail ? "\n          " + detail : ""));
  }
}
const near = (a, b, e) => Math.abs(a - b) <= (e || 0.01);

function page(css, body, extraHead) {
  return "<!doctype html><html lang=en><head><title>t</title>" + (extraHead || "") + "<style>" + css + "</style></head><body>" + body + "</body></html>";
}
function pairsOf(css, body, opts) {
  const doc = parseDocument(page(css, body));
  const styler = new Styler([css]);
  const r = analysePage(Object.assign({ doc, styler, url: "/t/", themeVars: new Set(["--ink", "--paper", "--bad"]), stateClasses: ["on"] }, opts || {}));
  return [...r.pairs.values()];
}
function findingsOf(body, extra) {
  const html = page("body{color:#000;background:#fff}", body);
  const doc = parseDocument(html);
  const styler = new Styler(["body{color:#000;background:#fff}"]);
  const ctx = styler.newCtx({ w: 1280, h: 800 });
  return analyseStructure({ doc, styler, ctx, url: "/t/", config: { genericLinkText: { error: ["click here", "here"], warn: ["read more"] } }, motion: Object.assign({ reducedMotionCss: false, reducedMotionScript: false, animations: false }, extra || {}) });
}
const rules = (list) => list.filter((f) => f.severity === "error").map((f) => f.rule).sort().join(",");

function run() {
  // ---- maths
  t("black on white is 21:1", near(CC.ratio(CC.parseColor("#000"), CC.parseColor("#fff")), 21, 0.001));
  t("white on white is 1:1", near(CC.ratio(CC.parseColor("#fff"), CC.parseColor("#ffffff")), 1, 0.0001));
  t("#767676 on white passes 4.5:1", CC.ratio(CC.parseColor("#767676"), CC.parseColor("#fff")) >= 4.5);
  t("#777777 on white fails 4.5:1 (4.48)", CC.ratio(CC.parseColor("#777"), CC.parseColor("#fff")) < 4.5 && CC.fmt(CC.ratio(CC.parseColor("#777"), CC.parseColor("#fff"))) === "4.48");
  t("a ratio just under a limit is never shown as the limit", CC.fmt(4.499, 4.5) === "4.49" && CC.fmt(4.5, 4.5) === "4.50" && CC.fmt(4.4778, 4.5) === "4.48");
  t("50% black over white reads as mid grey (3.95:1)", near(CC.ratio(CC.parseColor("rgba(0,0,0,.5)"), CC.parseColor("#fff")), 3.95, 0.01));
  t(
    "colour parsing: short, alpha, rgb() with spaces and slash, rejects junk",
    JSON.stringify(CC.parseColor("#abc")) === JSON.stringify({ r: 170, g: 187, b: 204, a: 1 }) &&
      near(CC.parseColor("#11223380").a, 0.5, 0.01) &&
      CC.parseColor("rgb(1 2 3 / 50%)").a === 0.5 &&
      CC.parseColor("url(x)") === null &&
      CC.parseColor("#12") === null &&
      CC.parseColor(null) === null
  );
  const vars = { "--a": { key: "a", def: "#000000", label: "A" } };
  t("theme values fall back to the default for anything that is not a hex colour", CC.themeValues({ a: "red; } body{" }, vars)["--a"] === "#000000" && CC.themeValues({ a: " #ffffff " }, vars)["--a"] === "#ffffff");
  const v = { "--ink": "#000000", "--paper": "#ffffff" };
  t("a pair is evaluated from theme roles, with opacity", CC.evaluatePair({ fg: "--ink@0.5", bg: ["--paper"], k: "t" }, v).status === "fail" && CC.evaluatePair({ fg: "--ink", bg: ["--paper"], k: "t" }, v).status === "pass");
  t("a focus ring that fails on one side only warns", CC.evaluatePair({ fg: "--ink", bg: ["--paper"], alt: ["--ink"], k: "u" }, v).status === "warn" && CC.evaluatePair({ fg: "--ink", bg: ["--ink"], alt: ["--ink"], k: "u" }, v).status === "fail");
  t("a decorative symbol never fails", CC.evaluatePair({ fg: "--paper", bg: ["--paper"], k: "u", soft: 1 }, v).status === "warn");
  t("a see-through background is laid over the stack below it", CC.evaluatePair({ fg: "#000000", bg: ["#FFFFFF", "rgba(0, 0, 0, 1)"], k: "t" }, v).status === "fail");

  // ---- lengths
  const env = (vw) => ({ rem: 16, em: 16, vw, vh: 800 });
  t("clamp() length picks the middle value by viewport", near(evalLength("clamp(2.5rem, 5.5vw, 4.2rem)", env(1280)), 67.2, 0.01) && near(evalLength("clamp(2.5rem, 5.5vw, 4.2rem)", env(360)), 40, 0.01) && near(evalLength("clamp(2.5rem, 5.5vw, 4.2rem)", env(900)), 49.5, 0.01));
  t("calc and em lengths", near(evalLength("calc(1rem + 2vw)", env(1000)), 36, 0.01) && near(evalLength("1.5em", env(1000)), 24, 0.01) && evalLength("banana", env(1)) === null);

  // ---- selectors
  const doc = parseDocument('<div class="a"><p class="b c" id="x">t</p><span>s</span></div>');
  const p = doc.children[0].children[0];
  const m = (sel) => matchComplex(p, parseSelector(sel), parseSelector(sel).parts.length - 1, new Styler([]).newCtx({ w: 1, h: 1 }), [], new Map());
  t("selectors: class, id, descendant, child, :not, attribute, :nth-child", m(".b") && m("#x") && m(".a .b") && m(".a > .c") && !m(".a > .zz") && m("p:not(.zz)") && !m("p:not(.b)") && m("[id=x]") && m("p:nth-child(1)") && !m("p:nth-child(2)") && m("div p.b.c") && !m("span p"));
  t("specificity is counted", JSON.stringify(parseSelector("#a .b p").spec) === "[1,1,1]" && JSON.stringify(parseSelector("a:not(.x)").spec) === "[0,1,1]");

  // ---- cascade and pairs
  let pr = pairsOf("body{color:#000;background:#fff}", "<p>hello</p>");
  t("plain text on the page background: one pair, passing", pr.length === 1 && pr[0].fg === "#000000" && pr[0].bg.join() === "#FFFFFF" && CC.evaluatePair(pr[0], {}).pass);
  pr = pairsOf(":root{--ink:#fff;--paper:#fff}body{color:var(--ink);background:var(--paper)}", "<p>hello</p>");
  t("custom properties keep their role names, and the pair fails at 1:1", pr.length === 1 && pr[0].fg === "--ink" && pr[0].bg[0] === "--paper" && !CC.evaluatePair(pr[0], { "--ink": "#fff", "--paper": "#fff" }).pass);
  pr = pairsOf("body{color:#000;background:#fff} p{color:#111} p.k{color:#222} #i{color:#333}", '<p class="k" id="i" style="color:#444">hello</p>');
  t("cascade: inline style beats id beats class beats element", pr.some((x) => x.fg === "#444444") && pr.length === 1);
  pr = pairsOf("body{color:#000;background:#fff} p{color:#111 !important} #i{color:#333}", '<p id="i">hello</p>');
  t("cascade: !important wins", pr.length === 1 && pr[0].fg === "#111111");
  pr = pairsOf("body{color:#000;background:#fff} .btn{color:#fff;background:#00f}", '<a class="btn" href="/x">go</a>');
  t("author colour beats the browser's blue link colour", pr.length === 1 && pr[0].fg === "#FFFFFF" && pr[0].bg.join() === "#0000FF");
  pr = pairsOf("body{color:#000;background:#fff} .dark{background:#003} .dark p{color:#eee}", '<div class="dark"><p>hello</p></div>');
  t("text takes the background of its nearest painted ancestor", pr.length === 1 && pr[0].bg.join() === "#000033");
  pr = pairsOf("body{color:#000;background:#fff} .tint{background:rgba(0,0,0,.1)}", '<div class="tint"><p>hello</p></div>');
  t("a see-through background is stacked over the one below", pr.length === 1 && pr[0].bg.join() === "#FFFFFF,rgba(0, 0, 0, 0.1)");
  pr = pairsOf("body{color:#000;background:#fff} p{font-size:1.5rem}", "<p>hello</p>");
  t("large text (24px) is judged against 3:1", pr.length === 1 && pr[0].k === "l");
  pr = pairsOf("body{color:#000;background:#fff} p{font-size:1.2rem;font-weight:700}", "<p>hello</p>");
  t("bold 19px text is large too, bold 18px is not", pr[0].k === "l" && pairsOf("body{color:#000;background:#fff} p{font-size:1.1rem;font-weight:700}", "<p>hello</p>")[0].k === "t");
  pr = pairsOf("body{color:#000;background:#fff} a{color:#000} a:hover{color:#fff}", '<a href="/x">hello</a>');
  t("hover state is measured (white on white on hover)", pr.some((x) => x.fg === "#FFFFFF" && x.states.has(":hover")));
  pr = pairsOf("body{color:#000;background:#fff} .step{color:#000} .step.on{color:#fff}", '<span class="step">hello</span>');
  t("a class the page's scripts toggle is simulated", pr.some((x) => x.fg === "#FFFFFF" && x.states.has(".on")));
  pr = pairsOf("body{color:#000;background:#fff} p{opacity:.2}", "<p>hello</p>");
  t("opacity weakens the text colour", pr.length === 1 && pr[0].fg.includes("0.2"));
  pr = pairsOf("body{color:#000;background:#fff} p{display:none} .sr{position:absolute;clip:rect(0 0 0 0)}", '<p>gone</p><span class="sr">only for readers</span>');
  t("hidden and screen-reader-only text is not measured", pr.length === 0);
  pr = pairsOf("body{color:#000;background:#fff} .hero{background:linear-gradient(90deg,#fff,#000)}", '<div class="hero"><p>over a gradient</p></div>');
  t("a gradient is measured at each colour stop", pr.length === 2);
  pr = pairsOf("body{color:#000;background:#fff} :focus-visible{outline:2px solid #eee;outline-offset:2px}", '<a href="/x">x</a>');
  t("a focus ring is measured against what is outside it", pr.some((x) => x.what === "focus ring" && x.fg === "#EEEEEE"));
  pr = pairsOf("body{color:#000;background:#fff} .logo{color:#fefefe}", '<span class="logo">brand</span>', { exempt: [parseSelector(".logo")] });
  t("an exempt selector (the logo) is skipped", pr.length === 0);
  pr = pairsOf("body{color:#000;background:#fff} li::before{content:'✓';color:#ddd}", "<ul><li>item</li></ul>");
  t("text printed by ::before is measured", pr.some((x) => x.fg === "#DDDDDD"));
  pr = pairsOf("@media (max-width: 600px){ p{color:#fff} } body{color:#000;background:#fff}", "<p>hello</p>");
  t("narrow-screen rules are measured too", pr.some((x) => x.vps.has("narrow") && x.fg === "#FFFFFF") && pr.some((x) => x.vps.has("wide") && x.fg === "#000000"));

  // ---- structure
  t(
    "a clean page has no errors",
    rules(findingsOf("<header><a href='#m'>Skip</a></header><main id='m'><h1>T</h1><h2>S</h2><p><a href='/x'>A real link</a></p><img src='/a.jpg' alt='A dog on a beach'><label for='e'>Email</label><input id='e' type='email' autocomplete='email'></main><footer>f</footer>")) === ""
  );
  t("missing alt is an error", rules(findingsOf("<main><h1>T</h1><img src='/a.jpg'></main>")) === "image-alt");
  t(
    "empty alt on an informative image is an error; marked decorative or inside a text link it is fine",
    rules(findingsOf("<main><h1>T</h1><img src='/a.jpg' alt=''></main>")) === "image-alt" && rules(findingsOf("<main><h1>T</h1><img src='/a.jpg' alt='' aria-hidden='true'><a href='/x'><img src='/a.jpg' alt=''> Shop</a></main>")) === ""
  );
  t("a skipped heading level is an error", rules(findingsOf("<main><h1>T</h1><h3>Skipped</h3></main>")) === "heading-order");
  t("two h1 or none are errors", rules(findingsOf("<main><h1>A</h1><h1>B</h1></main>")) === "heading-h1" && rules(findingsOf("<main><h2>A</h2></main>")) === "heading-h1");
  t("an empty link is an error, so is click here", rules(findingsOf("<main><h1>T</h1><a href='/x'></a></main>")) === "link-name" && rules(findingsOf("<main><h1>T</h1><a href='/x'>Click here</a></main>")) === "link-name");
  t("a link named only by its image's alt is fine", rules(findingsOf("<main><h1>T</h1><a href='/x'><img src='/a.png' alt='Home'></a></main>")) === "");
  t("an icon button with no name is an error; with aria-label it is fine", rules(findingsOf("<main><h1>T</h1><button><svg></svg></button></main>")) === "button-name" && rules(findingsOf("<main><h1>T</h1><button aria-label='Menu'><svg></svg></button></main>")) === "");
  t("an unlabelled field is an error (a placeholder is not a label)", rules(findingsOf("<main><h1>T</h1><input type='text' placeholder='Name'></main>")) === "form-label");
  t(
    "duplicate ids, tabindex above 0, aria-hidden on a reachable link",
    rules(findingsOf("<main id='a'><h1 id='a'>T</h1></main>")) === "duplicate-id" &&
      rules(findingsOf("<main><h1>T</h1><div tabindex='3'>x</div></main>")) === "tabindex" &&
      rules(findingsOf("<main><h1>T</h1><div aria-hidden='true'><a href='/x'>x</a></div></main>")) === "aria-hidden"
  );
  t("a broken skip link target is an error", rules(findingsOf("<a href='#nowhere'>Skip</a><main><h1>T</h1></main>")) === "skip-link");
  t("missing lang / title / zoom block are errors", (() => {
    const html = "<!doctype html><html><head><meta name=viewport content='width=device-width, user-scalable=no'></head><body><main><h1>T</h1></main></body></html>";
    const d = parseDocument(html);
    const s = new Styler([]);
    return rules(analyseStructure({ doc: d, styler: s, ctx: s.newCtx({ w: 1, h: 1 }), url: "/", config: {}, motion: {} })) === "html-lang,page-title,viewport-zoom";
  })());
  t(
    "media: a sound autoplay is an error; a silent labelled loop only warns; a plain video needs controls; reduced motion must be handled",
    rules(findingsOf("<main><h1>T</h1><video autoplay src='a.mp4' controls></video></main>")) === "media-autoplay" &&
      rules(findingsOf("<main><h1>T</h1><video muted loop aria-label='x' src='a.mp4'></video></main>")) === "" &&
      rules(findingsOf("<main><h1>T</h1><video src='a.mp4'></video></main>")) === "video-controls" &&
      rules(findingsOf("<main><h1>T</h1><video muted autoplay aria-hidden='true' src='a.mp4'></video></main>", {})) === "motion-reduced" &&
      rules(findingsOf("<main><h1>T</h1><video muted autoplay aria-hidden='true' src='a.mp4'></video></main>", { reducedMotionScript: true })) === ""
  );

  console.log(bad.length ? "\nA11Y UNIT CHECKS FAILED: " + bad.length + " of " + (ok + bad.length) : "a11y unit checks: " + ok + " held");
  return bad.length ? 1 : 0;
}

module.exports = { run };
