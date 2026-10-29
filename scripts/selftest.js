#!/usr/bin/env node
"use strict";
// selftest: proves the guards still catch what they exist to catch.
//
//   node scripts/selftest.js [--only <scenario substring>] [--unit] [--list]
//                            [--baseline-site <built pre-refactor site> --baseline-root <its src/ parent>]
//
// 1. Unit checks of the detectors (scripts/fixtures): the JavaScript string detector and a page full
//    of hard-coded text in every place a visitor can read it.
// 2. Deliberate regressions: a throwaway copy of the site is broken in one way at a time (a hard-coded
//    sentence in a template or a script, a data key without a CMS field, a CMS field without data, an
//    unescaped interpolation ...) and the guard that should notice must fail for the right reason.
//    A control run first shows that the untouched copy passes everything.
// Nothing in the real checkout is modified. Exit code 0 = every expectation held.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { spawnSync } = require("child_process");
const { runMain, parseArgs, REPO_ROOT, SCRIPTS_DIR, collapse, mkTmp, removeTree } = require("./lib/util");
const { Workspace } = require("./lib/workspace");
const { scanScript } = require("./lib/jsscan");
const { cssContentStrings } = require("./lib/css");

const GUARDS = {
  cms: "check-cms.js",
  copy: "check-copy.js",
  previews: "check-previews.js",
  wiring: "check-wiring.js",
  hostile: "check-hostile.js",
  tokens: "check-tokens.js",
  a11y: "check-a11y.js",
  seo: "check-seo.js",
};

let passed = 0;
let failed = 0;
const failures = [];
const mark = (ok, label, detail) => {
  if (ok) {
    passed += 1;
    console.log("  ok    " + label);
  } else {
    failed += 1;
    failures.push(label);
    console.log("  FAIL  " + label + (detail ? "\n" + String(detail).split("\n").slice(0, Number(process.env.SELFTEST_TAIL) || 25).map((l) => "          " + l).join("\n") : ""));
  }
};

function runGuard(guard, root, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, GUARDS[guard]), "--root", root].concat(args || []), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: Object.assign({}, process.env, { GUARD_STRICT_STALE: "", GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" }) });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// expect: { code: 0|1, has: [substrings], hasNot: [substrings] }
function expectRun(label, res, expect) {
  const problems = [];
  if (res.code !== expect.code) problems.push("exit code " + res.code + ", expected " + expect.code);
  for (const s of expect.has || []) if (!res.out.includes(s)) problems.push("output does not mention: " + s);
  for (const s of expect.hasNot || []) if (res.out.includes(s)) problems.push("output unexpectedly mentions: " + s);
  mark(problems.length === 0, label, problems.length ? problems.join("\n") + "\n--- output ---\n" + res.out.split("\n").slice(-(Number(process.env.SELFTEST_TAIL) || 30)).join("\n") : "");
}

// ------------------------------------------------------------------ helpers to break a copy
const edit = (ws, rel, fn) => {
  const before = ws.read(rel);
  const after = fn(before);
  if (after === before) throw new Error("selftest mutation changed nothing in " + rel);
  ws.write(rel, after);
};
const replaceOnce = (a, b) => (text) => {
  if (!text.includes(a)) throw new Error("selftest anchor not found: " + a.slice(0, 70));
  return text.replace(a, b);
};
const editYaml = (ws, fn) => {
  const cfg = yaml.load(ws.read("cms/config.yml"));
  fn(cfg);
  ws.write("cms/config.yml", yaml.dump(cfg, { lineWidth: -1 }));
};
const heroEntry = (cfg) => cfg.collections[0].files.find((f) => f.name === "hero");
const editJson = (ws, rel, fn) => {
  const j = ws.readJson(rel);
  fn(j);
  ws.writeJson(rel, j);
};

const FAST = ["--variants", "0"]; // the sentinel build only; the dropdown / switch variants are exercised by the control run and one dedicated scenario
const FAQ_TEMPLATE = "src/_includes/sections/faq.njk";
const SCRIPT_PARTIAL = "src/_includes/scripts/faq.njk";

// ------------------------------------------------------------------ scenarios
const scenarios = [
  {
    name: "control: the untouched copy passes every guard",
    build: true,
    run(ws, site) {
      for (const g of ["cms", "previews"]) expectRun(g + " passes", runGuard(g, ws.dir), { code: 0 });
      expectRun("copy passes", runGuard("copy", ws.dir, ["--site", site]), { code: 0 });
      expectRun("wiring passes (sentinel build and its switch / dropdown variants)", runGuard("wiring", ws.dir), { code: 0 });
      expectRun("hostile passes", runGuard("hostile", ws.dir), { code: 0 });
      expectRun("tokens passes (hostile, lowest and highest token values built)", runGuard("tokens", ws.dir), { code: 0 });
      expectRun("a11y passes (the recorded known issues are listed, nothing new)", runGuard("a11y", ws.dir, ["--site", site]), { code: 0, has: ["CHECK-A11Y OK", "known issues recorded"] });
      expectRun("a11y: the CMS contrast table also covers the copy with every optional field and block switched on", runGuard("a11y", ws.dir, ["--site", site, "--maximal"]), { code: 0 });
      expectRun("seo passes (rules, site audit and the all-switches probe)", runGuard("seo", ws.dir), { code: 0 });
    },
  },
  {
    name: "ordinary editor changes (new words, markdown, a new page, a new form field, a new menu link) keep every guard green",
    mutate: (ws) => {
      editJson(ws, "src/_data/hero.json", (j) => {
        j.headlineMain = "Brand new headline, with: punctuation & symbols — ok?";
        j.badge = "Launching 🚀 soon";
      });
      editJson(ws, "src/_data/homepage.json", (j) => {
        const m = j.sections.find((s) => s.type === "marquee");
        m.items = ["Hospitals", "Gyms", "Cafés & bars"];
        m.screenReaderJoiner = "plus";
        m.screenReaderEnd = "!";
      });
      editJson(ws, "src/_data/footer.json", (j) => {
        j.copyright = "© {year} Covered Ltd. Some rights reserved.";
        j.lastUpdated = "12 August 2026";
        j.updatedLabel = "Refreshed on";
        j.signOff = "Made with love";
      });
      editJson(ws, "src/_data/site.json", (j) => (j.subpageTitle = "{title} | Covered"));
      editJson(ws, "src/_data/faq.json", (j) => j.items.push({ q: "Can I **bold** things?", a: "Yes: **bold**, *italic* and [a link](https://example.org/x).\n\nSecond paragraph with `code`." }));
      editJson(ws, "src/_data/brands.json", (j) => j.form.fields.push({ label: "Phone number", type: "tel", placeholder: "07… or +44…", required: false, hint: "Optional. We only call about this enquiry." }));
      editJson(ws, "src/_data/nav.json", (j) => j.items.splice(2, 0, { type: "link", label: "Press kit", url: "https://example.org/press" }));
      ws.write(
        "src/pages/press.md",
        [
          "---",
          "title: A very long page title that keeps going and going to see whether the browser tab title still matches",
          "permalink: /press/",
          "description: Press information, logos and contact details for journalists writing about COVERED and free period products.",
          "layout: page.njk",
          "sections:",
          "  - type: hero",
          '    heading: "Press & media,"',
          '    accent: "all in one place."',
          '    sub: "Everything journalists need."',
          "  - type: stats",
          '    heading: "By the numbers"',
          "    items:",
          '      - number: "145"',
          '        label: "frames of film"',
          "  - type: text",
          '    kicker: "About"',
          '    heading: "Hello"',
          "    body: |-",
          "      Para one with a link to [our team page](/about/).",
          "",
          "      - bullet one",
          "      - bullet two",
          "---",
          "",
        ].join("\n")
      );
    },
    build: true,
    run(ws, site) {
      expectRun("cms passes", runGuard("cms", ws.dir), { code: 0 });
      expectRun("previews pass", runGuard("previews", ws.dir), { code: 0 });
      expectRun("copy passes (new words are traceable, derived sentences still match)", runGuard("copy", ws.dir, ["--site", site]), { code: 0, has: ["/press/"] });
      expectRun("wiring passes (every new field reaches the page)", runGuard("wiring", ws.dir, FAST), { code: 0 });
      expectRun("a11y passes (the new page, form field and menu link are accessible too)", runGuard("a11y", ws.dir, ["--site", site]), { code: 0, has: ["/press/"] });
      expectRun("seo passes (the new page has one h1, its own title and description)", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 0, has: ["/press/"] });
    },
  },
  {
    name: "an editor does SEO work (hides a page, sets a canonical, titles, social card, sitemap values, redirects) and every guard stays green",
    mutate: (ws) => {
      const fm = (rel, fn) => {
        const yamlLib = require("js-yaml");
        const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(ws.read(rel));
        const data = yamlLib.load(m[1]);
        fn(data);
        ws.write(rel, "---\n" + yamlLib.dump(data, { lineWidth: -1 }) + "---\n" + m[2]);
      };
      fm("src/pages/privacy.md", (d) => (d.hideFromSearch = true));
      fm("src/pages/about.md", (d) => {
        d.seoTitle = "About COVERED - who we are";
        d.socialTitle = "Meet the team behind COVERED";
        d.socialDescription = "Free period products, paid for by advertising.";
        d.shareImage = "/images/covered-og.jpg";
        d.shareImageAlt = "The COVERED dispenser";
        d.sitemapPriority = "0.8";
        d.sitemapChangefreq = "monthly";
        d.lastModified = "2026-09-01";
      });
      editJson(ws, "src/_data/site.json", (j) => {
        j.socialTitle = "COVERED - free period products";
        j.shareImageAlt = "Two COVERED dispensers";
        j.sitemapPriority = "1.0";
      });
      editJson(ws, "src/_data/redirects.json", (j) => {
        j.items = [
          { fromLink: "/about-us/", toLink: "/about/", permanent: true },
          { fromLink: "/privacy-policy/", toLink: "/privacy/", permanent: false },
          { fromLink: "/partners-old/", toLink: "https://example.org/partners", permanent: true },
        ];
      });
    },
    build: true,
    run(ws, site) {
      expectRun("cms passes", runGuard("cms", ws.dir), { code: 0 });
      expectRun("previews pass", runGuard("previews", ws.dir), { code: 0 });
      expectRun("copy passes", runGuard("copy", ws.dir, ["--site", site]), { code: 0 });
      expectRun("seo passes (hidden page out of the sitemap, redirect targets exist, tags complete)", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 0, has: ["2 public page(s)"] });
      expectRun("wiring passes", runGuard("wiring", ws.dir, FAST), { code: 0 });
    },
  },
  {
    name: "seo regression: a public page without an <h1>",
    mutate: (ws) => edit(ws, "src/pages/about.md", (t) => t.replace(/  - type: hero[\s\S]*?  - type: text/, "  - type: text")),
    build: true,
    run(ws, site) {
      expectRun("check-seo reports the missing <h1>", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 1, has: ["/about/ has 0 <h1>"] });
    },
  },
  {
    name: "seo regression: two pages with the same title and the same description",
    mutate: (ws) => {
      const take = (rel) => ws.read(rel);
      const desc = /^description: .*$/m.exec(take("src/pages/about.md"))[0];
      edit(ws, "src/pages/privacy.md", (t) => t.replace(/^description: .*$/m, desc).replace(/^title: .*$/m, "title: About us"));
    },
    build: true,
    run(ws, site) {
      expectRun("check-seo reports both duplicates", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 1, has: ["has the same title as", "has the same description as"] });
    },
  },
  {
    name: "seo regression: the sitemap lists a page hidden from search engines",
    mutate: (ws) => {
      edit(ws, "src/pages/privacy.md", (t) => t.replace("layout: page.njk", "layout: page.njk\nhideFromSearch: true"));
      edit(ws, "src/sitemap.njk", replaceOnce("d.hideFromSearch !== true and ", ""));
    },
    build: true,
    run(ws, site) {
      expectRun("check-seo reports the hidden page in sitemap.xml", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 1, has: ["is hidden from search engines but listed in sitemap.xml"] });
    },
  },
  {
    name: "seo regression: the noindex tag is not printed for a hidden page",
    mutate: (ws) => {
      edit(ws, "src/pages/privacy.md", (t) => t.replace("layout: page.njk", "layout: page.njk\nhideFromSearch: true"));
      edit(ws, "src/_includes/page.njk", replaceOnce('{% if hideFromSearch === true %}<meta name="robots" content="noindex, follow" />{% endif %}', ""));
    },
    build: true,
    run(ws, site) {
      expectRun("check-seo notices: the page is still public, so it must be in the sitemap", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 1, has: ["/privacy/ is a public page but is missing from sitemap.xml"] });
      expectRun("the probe notices the missing noindex tag", runGuard("seo", ws.dir), { code: 1, has: ["hideFromSearch adds a robots noindex tag"] });
    },
  },
  {
    name: "seo regression: a relative canonical link and a missing share picture tag",
    mutate: (ws) => {
      edit(ws, "src/_includes/page.njk", replaceOnce('<link rel="canonical" href="{{ canon }}" />', '<link rel="canonical" href="{{ page.url }}" />'));
      edit(ws, "src/_includes/page.njk", (t) => t.replace(/<meta property="og:image" content="https:\/\/coveredaccess\.com\{\{ shareSrc \}\}" \/>/, ""));
    },
    build: true,
    run(ws, site) {
      expectRun("check-seo reports both", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 1, has: ["canonical is not an absolute https address", "is missing og:image"] });
    },
  },
  {
    name: "seo regression: redirects printed without the safe filter (hostile addresses reach the file)",
    mutate: (ws) => {
      edit(ws, "src/redirects.njk", replaceOnce("{%- for line in redirects.items | redirectRules %}\n{{ line }}", "{%- for it in redirects.items %}\n{{ it.fromLink }} {{ it.toLink }} 200"));
      editJson(ws, "src/_data/redirects.json", (j) => (j.items = [{ fromLink: "/old/", toLink: "/about/", permanent: true }, { fromLink: "/proxy/", toLink: "https://evil.example/ x", permanent: true }]));
    },
    build: true,
    run(ws, site) {
      expectRun("check-seo reports the malformed lines", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 1, has: ["_redirects holds a line of the wrong shape"] });
      expectRun("check-hostile reports them too", runGuard("hostile", ws.dir, ["--quick"]), { code: 1, has: ["Redirects file"] });
    },
  },
  {
    name: "seo regression: redirects.json with a loop, a wildcard and a missing target",
    mutate: (ws) => {
      editJson(ws, "src/_data/redirects.json", (j) => {
        j.items = [
          { fromLink: "/a/", toLink: "/b/", permanent: true },
          { fromLink: "/b/", toLink: "/a/", permanent: true },
          { fromLink: "/blog/*", toLink: "/about/", permanent: true },
          { fromLink: "/gone/", toLink: "/does-not-exist/", permanent: true },
        ];
      });
    },
    build: true,
    run(ws, site) {
      expectRun("check-seo reports the ignored rules and the dead target", runGuard("seo", ws.dir, ["--site", site, "--no-probe"]), { code: 1, has: ["would create a redirect loop", "plain path", "which is not a page of the site"] });
    },
  },
  {
    name: "an editor switches features off (no ticker, no 'last updated' line, brands / venues / locations hidden)",
    mutate: (ws) => {
      editJson(ws, "src/_data/homepage.json", (j) => {
        j.sections.find((s) => s.type === "marquee").items = [];
        for (const s of j.sections) if (["brands", "venues", "locations"].includes(s.type)) s.enabled = false;
      });
      editJson(ws, "src/_data/footer.json", (j) => (j.lastUpdated = ""));
    },
    build: true,
    run(ws, site) {
      expectRun("cms passes", runGuard("cms", ws.dir), { code: 0 });
      expectRun("previews pass", runGuard("previews", ws.dir), { code: 0 });
      expectRun("copy passes; allow-list entries for the missing features are only noted", runGuard("copy", ws.dir, ["--site", site]), { code: 0, has: ["note:"] });
      expectRun("wiring passes (sections that are off are switched on for the test)", runGuard("wiring", ws.dir, FAST), { code: 0 });
      expectRun("hostile passes", runGuard("hostile", ws.dir, ["--quick"]), { code: 0 });
      expectRun("a11y passes (nothing is measured for what is switched off)", runGuard("a11y", ws.dir, ["--site", site]), { code: 0 });
    },
  },
  {
    name: "accessibility: a safe re-theme (white page, black text) stays green",
    mutate: (ws) =>
      editJson(ws, "src/_data/theme.json", (j) => {
        j.paper = "#FFFFFF";
        j.ink = "#000000";
        j.inkDeep = "#000000";
        j.inkSoft = "#222222";
        j.muted = "#444444";
      }),
    build: true,
    run(ws, site) {
      expectRun("a11y passes after the editor picks a stricter palette", runGuard("a11y", ws.dir, ["--site", site]), { code: 0 });
    },
  },
  {
    name: "accessibility: hostile palettes typed into the colour boxes are flagged, naming the colour roles and the ratio",
    mutate: (ws) =>
      editJson(ws, "src/_data/theme.json", (j) => {
        for (const k of Object.keys(j)) j[k] = "#FFFFFF";
      }),
    build: true,
    run(ws, site) {
      expectRun("all-white palette: errors name the roles and the 1.00:1 ratio", runGuard("a11y", ws.dir, ["--site", site]), {
        code: 1,
        has: ["[contrast]", "1.00:1", "needs 4.5:1", "“Main text & dark sections” [ink]", "“Page background” [paper]", "CHECK-A11Y FAILED"],
      });
      const palettes = [
        ["near-identical text and page background", { ink: "#FEF8EC", inkSoft: "#FEF8EC", inkDeep: "#FEF8EC" }, ["“Main text & dark sections” [ink]", "“Page background” [paper]"]],
        ["quiet text barely darker than the page", { muted: "#F5EBDD" }, ["“Quiet text” [muted]", "“Page background” [paper]"]],
        ["white button text on a white button colour", { accentDeep: "#FFFFFF" }, ["“Button colour” [accentDeep]", "fixed #FFFFFF"]],
      ];
      for (const [label, over, mentions] of palettes) {
        ws.writeJson("src/_data/theme.json", Object.assign(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "src/_data/theme.json"), "utf8")), over));
        const b = ws.build("pal");
        if (!b.ok) {
          mark(false, label + ": the copy still builds", b.log.split("\n").slice(-8).join("\n"));
          continue;
        }
        expectRun(label + ": flagged with the roles", runGuard("a11y", ws.dir, ["--site", b.out]), { code: 1, has: ["[contrast]", ":1, needs"].concat(mentions) });
      }
    },
  },
  {
    name: "accessibility: missing alt text, a skipped heading and an empty link each fail the gate",
    mutate: (ws) => {
      editJson(ws, "src/_data/venues.json", (j) => (j.photos[0].alt = ""));
      edit(ws, FAQ_TEMPLATE, replaceOnce('<h2 class="section-title" id="faq-title">', '<h6 class="section-title" id="faq-title">'));
      edit(ws, FAQ_TEMPLATE, replaceOnce("{{ faq.title }}</h2>", "{{ faq.title }}</h6>"));
      edit(ws, FAQ_TEMPLATE, (t) => t + '\n<a class="guard-test" href="/empty-link-test/"></a>\n');
    },
    build: true,
    run(ws, site) {
      expectRun("check-a11y names all three, each with the page and element", runGuard("a11y", ws.dir, ["--site", site]), {
        code: 1,
        has: ["[image-alt]", "[heading-order]", "is followed by <h6>", "[link-name]", "a link with no accessible name", "/empty-link-test/", "CHECK-A11Y FAILED"],
      });
      // the same page with the alt attribute removed altogether
      editJson(ws, "src/_data/venues.json", (j) => (j.photos[0].alt = "A COVERED dispenser on a pub wall"));
      edit(ws, "src/_includes/sections/venues.njk", replaceOnce('alt="{{ photo.alt }}" /></picture>', "/></picture>"));
      const b = ws.build("noalt");
      if (!b.ok) return mark(false, "the copy without alt attributes builds", b.log.split("\n").slice(-8).join("\n"));
      expectRun("an <img> with no alt attribute at all fails too", runGuard("a11y", ws.dir, ["--site", b.out]), { code: 1, has: ["image has no alt attribute"] });
    },
  },
  {
    name: "accessibility: unreadable markup (several h1, unlabelled field, positive tabindex, duplicate id, aria-hidden link)",
    mutate: (ws) => {
      edit(ws, FAQ_TEMPLATE, (t) => t + '\n<h1 id="dup-id">Second main heading</h1><div id="dup-id" tabindex="4">x</div><div aria-hidden="true"><a href="/x/">reachable</a></div><input type="text" name="guardtest" placeholder="Name">\n');
    },
    build: true,
    run(ws, site) {
      expectRun("each defect is reported by rule", runGuard("a11y", ws.dir, ["--site", site]), {
        code: 1,
        has: ["[heading-h1]", "[duplicate-id]", "[tabindex]", "[aria-hidden]", "[form-label]"],
      });
    },
  },
  {
    name: "accessibility: a new colour pairing in the stylesheet that the CMS contrast table does not know fails the pair-table check",
    mutate: (ws) => edit(ws, "src/_includes/site-styles.css", (t) => t + "\n    .stats-source { color: var(--green-dark); }\n"),
    build: true,
    run(ws, site) {
      expectRun("the table in cms/contrast.js is reported out of date", runGuard("a11y", ws.dir, ["--site", site]), { code: 1, has: ["[pair-table]", "--write-pairs"] });
      expectRun("--write-pairs regenerates it and the check passes again", runGuard("a11y", ws.dir, ["--site", site, "--write-pairs"]), { code: 0, has: ["wrote"] });
      expectRun("and a second run is green", runGuard("a11y", ws.dir, ["--site", site]), { code: 0 });
    },
  },
  {
    name: "accessibility: the pull-request output (annotations and job summary) is written without trusting editor text",
    mutate: (ws) => {
      editJson(ws, "src/_data/theme.json", (j) => (j.ink = "#FFF8EC"));
      editJson(ws, "src/_data/faq.json", (j) => (j.title = "Q\n::error file=evil.txt::INJECTED"));
      edit(ws, FAQ_TEMPLATE, replaceOnce('<h2 class="section-title" id="faq-title">', '<h6 class="section-title" id="faq-title">'));
      edit(ws, FAQ_TEMPLATE, replaceOnce("{{ faq.title }}</h2>", "{{ faq.title }}</h6>"));
    },
    build: true,
    run(ws, site) {
      const summary = path.join(ws.dir, "summary.md");
      fs.writeFileSync(summary, "");
      const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, "check-a11y.js"), "--root", ws.dir, "--site", site, "--github"], { encoding: "utf8", env: Object.assign({}, process.env, { GITHUB_STEP_SUMMARY: summary, GITHUB_ACTIONS: "true" }) });
      const out = (r.stdout || "") + (r.stderr || "");
      const md = fs.readFileSync(summary, "utf8");
      const problems = [];
      if (r.status !== 1) problems.push("exit code " + r.status + ", expected 1");
      if (!/^::error file=src\/_data\/theme\.json,title=contrast::/m.test(out)) problems.push("no ::error annotation pointing at src/_data/theme.json");
      if (!out.includes("INJECTED")) problems.push("the editor text never reached the report, so this test proves nothing");
      if (/^::error file=evil\.txt/m.test(out)) problems.push("text typed by an editor became a workflow command");
      if (/^::(set-output|stop-commands|add-mask|set-env)/m.test(out)) problems.push("a workflow command from editor text");
      if (!md.includes("## Accessibility gate: FAILED") || !md.includes("| Errors |")) problems.push("job summary has no result table");
      if (/\n::/.test(md)) problems.push("summary contains a line starting with ::");
      mark(problems.length === 0, "--github writes ::error annotations and a job-summary table, and editor text cannot inject a command", problems.join("\n") + "\n" + out.split("\n").slice(-12).join("\n"));
    },
  },
  {
    name: "a hard-coded sentence in a template",
    mutate: (ws) => edit(ws, FAQ_TEMPLATE, (t) => t + '\n<p class="guard-test">A hard-coded sentence sneaked into a template.</p>\n'),
    build: true,
    run(ws, site) {
      expectRun("check-copy names the sentence", runGuard("copy", ws.dir, ["--site", site]), { code: 1, has: ["A hard-coded sentence sneaked into a template."] });
      expectRun("check-wiring (sentinel build) names it too", runGuard("wiring", ws.dir, FAST), { code: 1, has: ["Hard-coded words", "A hard-coded sentence sneaked into a template."] });
    },
  },
  {
    name: "a hard-coded word that also exists in the data (\"Contact\")",
    mutate: (ws) => edit(ws, FAQ_TEMPLATE, (t) => t + '\n<span class="guard-test">Contact</span>\n'),
    build: true,
    run(ws) {
      expectRun("check-wiring flags the word although the corpus contains it", runGuard("wiring", ws.dir, FAST), { code: 1, has: ["Hard-coded words", '"Contact"'] });
    },
  },
  {
    name: "a hard-coded picture in a template",
    mutate: (ws) => {
      const used = ["src/_data", "src/pages"].map((d) => fs.readdirSync(ws.file(d)).map((f) => ws.read(d + "/" + f)).join("\n")).join("\n");
      const pic = fs.readdirSync(ws.file("images")).find((f) => /\.jpg$/.test(f) && !used.includes(f));
      if (!pic) throw new Error("selftest needs a .jpg in images/ that no data file mentions");
      ws.guardPicture = "/images/" + pic;
      edit(ws, FAQ_TEMPLATE, (t) => t + '\n<img class="guard-test" src="' + ws.guardPicture + '" alt="">\n');
    },
    build: true,
    run(ws, site) {
      expectRun("check-copy names the picture", runGuard("copy", ws.dir, ["--site", site]), { code: 1, has: ["media", ws.guardPicture] });
      expectRun("check-wiring (sentinel build) names it too", runGuard("wiring", ws.dir, FAST), { code: 1, has: ["Hard-coded words", ws.guardPicture] });
    },
  },
  {
    name: "hard-coded words in a stylesheet (::before content)",
    mutate: (ws) => edit(ws, "src/_includes/site-styles.css", (t) => t + '\n.guard-test::before { content: "Hard-coded pseudo-element words"; }\n'),
    build: true,
    run(ws, site) {
      expectRun("check-copy names the generated text", runGuard("copy", ws.dir, ["--site", site]), { code: 1, has: ["css", "Hard-coded pseudo-element words"] });
    },
  },
  {
    name: "a hard-coded outward link in a template",
    mutate: (ws) => edit(ws, FAQ_TEMPLATE, (t) => t + '\n<a class="guard-test" href="https://example.org/hard-coded-link">{{ footer.tagline }}</a>\n'),
    build: true,
    run(ws, site) {
      expectRun("check-copy names the link", runGuard("copy", ws.dir, ["--site", site]), { code: 1, has: ["link", "https://example.org/hard-coded-link"] });
    },
  },
  {
    name: "a hard-coded sentence that only shows when an editor picks a certain dropdown choice (field type \"tel\")",
    mutate: (ws) =>
      edit(ws, "src/_includes/forms/enquiry-form.njk", replaceOnce("{%- macro field(f) -%}\n", '{%- macro field(f) -%}\n{% if f.type == "tel" %}<span class="guard-test">Hard-coded words for phone fields.</span>{% endif %}')),
    build: true,
    run(ws, site) {
      expectRun("check-copy cannot see it in the shipped state (no phone field exists)", runGuard("copy", ws.dir, ["--site", site]), { code: 0 });
      expectRun("check-wiring finds it in the variant builds", runGuard("wiring", ws.dir), { code: 1, has: ["Hard-coded words", "Hard-coded words for phone fields."] });
    },
  },
  {
    name: "hard-coded sentences in a script partial (braces, equals, angle brackets, backtick template)",
    mutate: (ws) =>
      edit(ws, SCRIPT_PARTIAL, (t) =>
        t +
        '\n      document.title = "Guard test; title = {odd} <chars> in a script.";\n' +
        "      document.body.setAttribute(\"aria-label\", `Guard test ${1} template sentence in a script.`);\n"
      ),
    build: true,
    run(ws, site) {
      expectRun("check-copy finds both script strings", runGuard("copy", ws.dir, ["--site", site]), {
        code: 1,
        has: ["Guard test; title = {odd} <chars> in a script.", "template sentence in a script."],
      });
      expectRun("check-wiring finds them in the sentinel build", runGuard("wiring", ws.dir, FAST), { code: 1, has: ["Hard-coded words", "in a script."] });
    },
  },
  {
    name: "a new JSON key with no CMS field",
    mutate: (ws) => editJson(ws, "src/_data/hero.json", (j) => (j.guardGhost = "Words nobody can edit")),
    run(ws) {
      expectRun("check-cms names the key", runGuard("cms", ws.dir), { code: 1, has: ["hero.json > guardGhost has no CMS field"] });
    },
  },
  {
    name: "a CMS field with no data (optional, and required)",
    mutate: (ws) =>
      editYaml(ws, (cfg) => {
        heroEntry(cfg).fields.push({ label: "Ghost (optional)", name: "ghostOptional", widget: "string", required: false });
        heroEntry(cfg).fields.push({ label: "Ghost (required)", name: "ghostRequired", widget: "string" });
      }),
    run(ws) {
      expectRun("check-cms: the required field has no data", runGuard("cms", ws.dir), { code: 1, has: ["hero.json > ghostRequired", "marks this field required but the data has no value"] });
      expectRun("check-wiring: nothing reads the optional field", runGuard("wiring", ws.dir, FAST), { code: 1, has: ["Dead fields", "hero.json > ghostOptional", "no template reads it"] });
    },
  },
  {
    name: "data and a CMS field that no template reads",
    mutate: (ws) => {
      editJson(ws, "src/_data/hero.json", (j) => (j.deadNote = "Nobody prints this note"));
      editYaml(ws, (cfg) => heroEntry(cfg).fields.push({ label: "Dead note", name: "deadNote", widget: "string" }));
    },
    run(ws) {
      expectRun("check-wiring reports the dead field", runGuard("wiring", ws.dir, FAST), { code: 1, has: ["Dead fields", "hero.json > deadNote", "no template or script puts it on a page"] });
      expectRun("check-cms is satisfied (the field exists)", runGuard("cms", ws.dir), { code: 0 });
    },
  },
  {
    name: "a template reads the wrong key (typo): the field stops reaching the page",
    mutate: (ws) => edit(ws, "src/_includes/sections/hero.njk", replaceOnce("{{ hero.badge }}", "{{ hero.badgee }}")),
    run(ws) {
      expectRun("check-wiring reports hero.badge as dead", runGuard("wiring", ws.dir, FAST), { code: 1, has: ["Dead fields", "hero.json > badge"] });
    },
  },
  {
    name: "an unescaped interpolation (| safe on a plain text field)",
    mutate: (ws) => edit(ws, "src/_includes/sections/hero.njk", replaceOnce("{{ hero.badge }}", "{{ hero.badge | safe }}")),
    run(ws) {
      expectRun("check-hostile sees the injected markup", runGuard("hostile", ws.dir, ["--quick"]), { code: 1, has: ["appended markup", "Script injection"] });
    },
  },
  {
    name: "data printed into a script without escaping < (breaks out of the script)",
    mutate: (ws) => edit(ws, "src/_includes/scripts/map.njk", replaceOnce('{{ (locations.labels or {}) | dump | replace("<", "\\\\u003c") | safe }}', "{{ (locations.labels or {}) | dump | safe }}")),
    run(ws) {
      expectRun("check-hostile sees the extra script", runGuard("hostile", ws.dir, ["--quick"]), { code: 1, has: ["Script injection", "script"] });
    },
  },
  {
    name: "a link from data without the safeUrl filter",
    mutate: (ws) => edit(ws, "src/_includes/blocks/banner.njk", replaceOnce("{{ block.buttonLink | safeUrl }}", "{{ block.buttonLink }}")),
    run(ws) {
      expectRun("check-hostile sees the javascript: link", runGuard("hostile", ws.dir, ["--quick"]), { code: 1, has: ["Dangerous link / source", "javascript:"] });
    },
  },
  {
    name: "an unescaped image alt text (| safe on an alt attribute)",
    mutate: (ws) => edit(ws, "src/_includes/sections/problem.njk", replaceOnce('alt="{{ problem.manifestoPhoto.alt }}"', 'alt="{{ problem.manifestoPhoto.alt | safe }}"')),
    run(ws) {
      expectRun("check-hostile sees the attribute breakout in the alt", runGuard("hostile", ws.dir), { code: 1, has: ["CHECK-HOSTILE FAILED"] });
    },
  },
  {
    name: "an image field whose pattern needs a folder (Decap only checks the file name)",
    mutate: (ws) => edit(ws, "cms/config.yml", (t) => t.replace("pattern: [\"^[A-Za-z0-9._-]+", "pattern: [\"^/?images/[A-Za-z0-9._/-]+")),
    run(ws) {
      expectRun("check-cms refuses the folder-based pattern", runGuard("cms", ws.dir), { code: 1, has: ["must match a bare file name"] });
    },
  },
  {
    name: "a page script that writes data into innerHTML",
    mutate: (ws) => edit(ws, "src/_includes/scripts/map.njk", (t) => t + "\n      if (typeof pinsG !== \"undefined\" && pinsG) { pinsG.innerHTML = MAP_COPY.statusLive; }\n"),
    run(ws) {
      expectRun("check-hostile's static rule flags innerHTML", runGuard("hostile", ws.dir, ["--quick"]), { code: 1, has: ["Scripts feeding data into HTML / code", "innerHTML"] });
    },
  },
  {
    name: "a preview that throws on an empty entry",
    mutate: (ws) => edit(ws, "cms/previews.js", replaceOnce('" " + g(e, ["badge"])', '" " + e.getIn(["data", "badge"]).trim()')),
    run(ws) {
      expectRun("check-previews reports the crash", runGuard("previews", ws.dir), { code: 1, has: ["Preview crashes", "hero"] });
    },
  },
  {
    name: "a preview that prints typed text as live HTML",
    mutate: (ws) => edit(ws, "cms/previews.js", replaceOnce('h("p", { className: "hero-sub" }, g(e, ["subhead"]))', 'h("p", { className: "hero-sub", dangerouslySetInnerHTML: { __html: g(e, ["subhead"]) } })')),
    run(ws) {
      expectRun("check-previews reports the new sink", runGuard("previews", ws.dir), { code: 1, has: ["Hostile markup reaches the preview", "preview 'hero'"] });
    },
  },
  {
    name: "a preview that prints \"undefined\" for a missing field",
    mutate: (ws) => edit(ws, "cms/previews.js", replaceOnce('h("p", { className: "hero-sub" }, g(e, ["subhead"]))', 'h("p", { className: "hero-sub" }, "Sub: " + e.getIn(["data", "subhead"]))')),
    run(ws) {
      expectRun("check-previews reports the broken text", runGuard("previews", ws.dir), { code: 1, has: ["Preview shows broken text", "undefined"] });
    },
  },
  {
    name: "a malformed CMS config (duplicate name, unknown widget, bad select default, bad pattern)",
    mutate: (ws) =>
      editYaml(ws, (cfg) => {
        const f = heroEntry(cfg).fields;
        f.push({ label: "Dup", name: f[0].name, widget: "string", required: false });
        f.push({ label: "Odd", name: "oddWidget", widget: "texxt", required: false });
        f.push({ label: "Pick", name: "pickOne", widget: "select", options: ["a", "b"], default: "c", required: false });
        f.push({ label: "Pat", name: "patField", widget: "string", pattern: ["([", "broken"], required: false });
      }),
    run(ws) {
      expectRun("check-cms lists all four problems", runGuard("cms", ws.dir), {
        code: 1,
        has: ["duplicate field name", 'unknown widget "texxt"', 'default "c" is not one of the options', "pattern is not a valid regular expression"],
      });
    },
  },
  {
    name: "a field that editors cannot see (widget: hidden) and a stored value that breaks its own rules",
    mutate: (ws) => {
      editYaml(ws, (cfg) => {
        const f = heroEntry(cfg).fields.find((x) => x.name === "stamp");
        f.widget = "hidden";
      });
      editJson(ws, "src/_data/motion.json", (j) => (j.speed = "warp"));
    },
    run(ws) {
      expectRun("check-cms reports both", runGuard("cms", ws.dir), { code: 1, has: ["hero.json > stamp is hidden in the CMS", '"warp" is not one of this select\'s options'] });
    },
  },
  // ---- design tokens (src/_data/tokens.json, lib/tokens.js, scripts/check-tokens.js)
  {
    name: "an editor changes design tokens within their limits (sizes, spacing, corners, fonts) and keeps every guard green",
    mutate: (ws) =>
      editJson(ws, "src/_data/tokens.json", (j) => {
        j.text.title.max = 4.6;
        j.text.baseSize = 105;
        j.lines.body = 1.7;
        j.space.cardGap = 1.5;
        j.shape.radiusButton = "square";
        j.shape.shadow = 0.2;
        j.fonts.display = "openSauce";
        j.weights.button = "700";
      }),
    run(ws) {
      expectRun("check-tokens passes", runGuard("tokens", ws.dir), { code: 0 });
      expectRun("check-cms passes", runGuard("cms", ws.dir), { code: 0 });
    },
  },
  {
    name: "a design token with no limit (the clamp removed from lib/tokens.js)",
    mutate: (ws) => edit(ws, "lib/tokens.js", replaceOnce("(isNum(v) ? Math.min(hi, Math.max(lo, v)) : dflt)", "(isNum(v) ? v : dflt)")),
    run(ws) {
      expectRun("check-tokens sees values escape their bounds", runGuard("tokens", ws.dir, ["--static"]), { code: 1, has: ["Tokens: values are bounded by the build", "escaped its bounds"] });
    },
  },
  {
    name: "a word typed into a font / weight / corner choice is not checked against the allowed list",
    mutate: (ws) => edit(ws, "lib/tokens.js", replaceOnce('typeof raw === "string" && Object.prototype.hasOwnProperty.call(t.options, raw) ? raw : t.def', 'typeof raw === "string" ? raw : t.def')),
    run(ws) {
      expectRun("check-tokens sees an unlisted word reach the css", runGuard("tokens", ws.dir, ["--static"]), { code: 1, has: ["Tokens: values are bounded by the build", "escaped its bounds"] });
    },
  },
  {
    name: "a CMS field allows a wider range than the build enforces",
    mutate: (ws) =>
      editYaml(ws, (cfg) => {
        const e = cfg.collections[0].files.find((f) => f.name === "tokens");
        const text = e.fields.find((f) => f.name === "text");
        text.fields.find((f) => f.name === "small").max = 50;
      }),
    run(ws) {
      expectRun("check-tokens names the field and the bound", runGuard("tokens", ws.dir, ["--static"]), { code: 1, has: ["text.small: max must be 1.2"] });
    },
  },
  {
    name: "a design token that nothing in the stylesheet uses (dead token)",
    mutate: (ws) => edit(ws, "src/_includes/site-styles.css", (t) => t.split("var(--tk-card-gap)").join("1.2rem")),
    run(ws) {
      expectRun("check-tokens reports the dead token", runGuard("tokens", ws.dir, ["--static"]), { code: 1, has: ["--tk-card-gap is declared but nothing in site-styles.css uses it"] });
    },
  },
  {
    name: "a shipped default in the stylesheet drifts from the token table (the untouched site would change)",
    mutate: (ws) => edit(ws, "src/_includes/site-styles.css", replaceOnce("--tk-small: 0.93rem;", "--tk-small: 0.95rem;")),
    run(ws) {
      expectRun("check-tokens reports the drift", runGuard("tokens", ws.dir, ["--static"]), { code: 1, has: ["default of --tk-small differs from the table"] });
    },
  },
  {
    name: "theme-vars prints token data without the validating filter",
    mutate: (ws) => edit(ws, "src/_includes/theme-vars.njk", replaceOnce("{{ tokens | tokenVars | safe }}", "  --tk-title: clamp(2.5rem, {{ tokens.text.title.fluid }}vw, 4.2rem);")),
    run(ws) {
      expectRun("check-tokens reports it", runGuard("tokens", ws.dir, ["--static"]), { code: 1, has: ["does not print the validated tokens"] });
    },
  },
  {
    name: "the live preview carries an out-of-date copy of the token limits",
    mutate: (ws) => edit(ws, "cms/previews.js", replaceOnce('"def":0.93,"min":0.7,"max":1.2', '"def":0.93,"min":0.7,"max":9')),
    run(ws) {
      expectRun("check-tokens reports the stale copy", runGuard("tokens", ws.dir, ["--static"]), { code: 1, has: ["TOKEN_SPEC is out of date"] });
    },
  },
];

// ------------------------------------------------------------------ allow-list hygiene (uses the control build)
function allowListScenarios(ws, site) {
  const tmp = mkTmp("covered-allow-");
  const real = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, "copy-allowlist.json"), "utf8"));
  const variant = (name, fn) => {
    const j = JSON.parse(JSON.stringify(real));
    fn(j);
    const f = path.join(tmp, name + ".json");
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
    return f;
  };
  try {
    expectRun(
      "an allow-list entry without a reason is rejected",
      runGuard("copy", ws.dir, ["--site", site, "--allowlist", variant("noreason", (j) => j.entries.push({ id: "bad", text: "Anything" }))]),
      { code: 1, has: ["Allow-list file", "needs a reason"] }
    );
    const staleFile = variant("stale", (j) => j.entries.push({ id: "stale", text: "Words that are nowhere on the site", reason: "Deliberately stale entry used by the guard self-test." }));
    expectRun("an entry that matches nothing is rejected in strict mode (no rot)", runGuard("copy", ws.dir, ["--site", site, "--allowlist", staleFile, "--strict-stale"]), { code: 1, has: ["entry 'stale' matched nothing"] });
    expectRun("... and only noted otherwise, so an editor who switches a feature off never fails the build", runGuard("copy", ws.dir, ["--site", site, "--allowlist", staleFile]), { code: 0, has: ["note: 1 allow-list entry matched nothing (stale)"] });
    expectRun(
      "a sentence on an indexable page cannot be allow-listed",
      runGuard("copy", ws.dir, ["--site", site, "--allowlist", variant("prose", (j) => j.entries.push({ id: "prose", text: "Skip to content", pages: ["/"], reason: "Deliberate attempt to excuse real copy on the home page." }))]),
      { code: 1, has: ["entry 'prose' is a sentence-length exact text used on indexable page"] }
    );
    expectRun(
      "a template that contains words of its own is rejected",
      runGuard("copy", ws.dir, ["--site", site, "--allowlist", variant("tpl", (j) => j.entries.push({ id: "tpl", template: "Sneaky words {{footer.updatedLabel}}", reason: "Deliberate attempt to hide hard-coded words in a template." }))]),
      { code: 1, has: ["template contains letters outside"] }
    );
    expectRun(
      "an entry that points at data that no longer exists is rejected",
      runGuard("copy", ws.dir, ["--site", site, "--strict-stale", "--allowlist", variant("ref", (j) => j.entries.push({ id: "ref", template: "{{footer.noSuchKey}}", reason: "Deliberate reference to a key that does not exist." }))]),
      { code: 1, has: ["does not resolve to any editable string"] }
    );
    expectRun(
      "a hidden-text claim is verified against the page CSS",
      runGuard("copy", ws.dir, ["--site", site, "--allowlist", variant("hidden", (j) => (j.entries.find((e) => e.id === "honeypot-label").hiddenBy = { class: "no-such-class" }))]),
      { code: 1, has: ["says its text is hidden by .no-such-class"] }
    );
  } finally {
    removeTree(tmp);
  }
}

// ------------------------------------------------------------------ unit checks
function unitChecks(root) {
  console.log("\n== Detector checks");
  mark(require("./lib/a11y-unit").run() === 0, "accessibility gate: contrast maths, CSS cascade, contrast finder and structure rules (scripts/lib/a11y-unit.js)");
  const fx = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, "fixtures", "js-strings.json"), "utf8"));
  for (const c of fx.cases) {
    const r = scanScript(c.code);
    if (r.error) {
      mark(false, "js strings: " + c.name, "does not parse: " + r.error);
      continue;
    }
    const found = r.strings.map((s) => s.text);
    const want = (c.flag || []).map(collapse);
    const miss = want.filter((t) => !found.includes(t));
    const wrong = (c.ignore || []).map(collapse).filter((t) => found.includes(t));
    const extra = found.filter((t) => !want.includes(t));
    mark(!miss.length && !wrong.length && !extra.length, "js strings: " + c.name, "missing " + JSON.stringify(miss) + "\nwrongly reported " + JSON.stringify(wrong) + "\nunexpected " + JSON.stringify(extra));
  }
  const cssFx = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, "fixtures", "css-content.json"), "utf8"));
  for (const c of cssFx.cases) {
    const got = cssContentStrings(c.css);
    mark(JSON.stringify(got) === JSON.stringify(c.expect), "css content: " + c.name, "found " + JSON.stringify(got) + ", expected " + JSON.stringify(c.expect));
  }
  // a page with hard-coded text in every place a visitor can read it
  const tmp = mkTmp("covered-fixture-");
  try {
    fs.copyFileSync(path.join(SCRIPTS_DIR, "fixtures", "page-hardcoded.html"), path.join(tmp, "index.html"));
    const res = runGuard("copy", root, ["--site", tmp, "--no-stale", "--max", "500"]);
    const expected = [
      "Fixture hard coded title words", // <title>
      "Fixture hard coded description sentence.", // meta description
      "Fixture hard coded share title", // og:title
      "Fixture keywords list here",
      "Fixture prefilled value",
      "Fixture pseudo element words",
      "https://example.org/fixture-link",
      "https://cdn.example.net/x.js",
      "https://fonts.example.net/css",
      "/images/fixture-picture.jpg",
      "Fixture hard coded schema description.", // JSON-LD
      "Fixture noscript sentence for visitors.",
      "Fixture visible paragraph text.",
      "Fixture alt text words",
      "Fixture aria label words",
      "Fixture placeholder text",
      "Fixture submit value",
      "Fixture tooltip sentence here",
      "Fixture template text.",
      "Fixture svg title",
      "Fixture svg text",
      "Fixture composed",
      "with inline",
      "Fixture entity text.",
      "Fixture script sentence; with {braces} = and <angle> brackets.",
      "template literal",
      "Fixture html title",
      "Fixture html text",
    ];
    const missing = expected.filter((e) => !res.out.includes(e));
    const forbidden = ["fixture-hidden-value"].filter((e) => res.out.includes(e));
    mark(res.code === 1 && !missing.length && !forbidden.length, "page fixture: every hard-coded text, attribute, meta, JSON-LD, template and script string is reported", "exit " + res.code + "; not reported: " + JSON.stringify(missing) + "; wrongly reported: " + JSON.stringify(forbidden) + "\n" + res.out.split("\n").slice(0, 40).join("\n"));
  } finally {
    removeTree(tmp);
  }
}

// ------------------------------------------------------------------ main
function main() {
  const args = parseArgs(process.argv.slice(2), { only: "string", list: "boolean", unit: "boolean", baselineSite: "string", baselineRoot: "string" });
  if (args.help) {
    console.log("usage: node scripts/selftest.js [--only <text>] [--list] [--baseline-site <dir> --baseline-root <dir>]");
    return 0;
  }
  if (args.list) {
    scenarios.forEach((s) => console.log(s.name));
    return 0;
  }
  const root = REPO_ROOT;
  const started = Date.now();
  if (!args.only) unitChecks(root);
  if (args.unit) {
    console.log("\nSELFTEST " + (failed ? "FAILED" : "OK") + " (detector checks only): " + passed + " held, " + failed + " did not");
    return failed ? 1 : 0;
  }

  let controlSite = null;
  let controlWs = null;
  for (const sc of scenarios) {
    if (args.only && !sc.name.toLowerCase().includes(args.only.toLowerCase())) continue;
    console.log("\n== " + sc.name);
    const ws = new Workspace(root, { prefix: "covered-selftest-" });
    try {
      if (sc.mutate) sc.mutate(ws);
      let site = null;
      if (sc.build) {
        const b = ws.build("site");
        if (!b.ok) {
          mark(false, "the broken copy still builds", b.log.split("\n").slice(-12).join("\n"));
          continue;
        }
        site = b.out;
      }
      sc.run(ws, site);
      if (sc.name.startsWith("control")) {
        // keep the control build for the allow-list checks
        controlWs = ws;
        controlSite = site;
        console.log("\n== allow-list rules (check-copy)");
        allowListScenarios(ws, site);
      }
    } finally {
      if (ws !== controlWs) ws.cleanup();
    }
  }
  if (controlWs) controlWs.cleanup();

  if (args.baselineSite && args.baselineRoot && !args.only) {
    console.log("\n== not vacuous: the pre-refactor site is full of violations");
    const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, "check-copy.js"), "--root", path.resolve(args.baselineRoot), "--site", path.resolve(args.baselineSite), "--no-stale", "--max", "1"], { encoding: "utf8" });
    const m = /FAILED: (\d+) violation/.exec(r.stdout + r.stderr);
    const n = m ? Number(m[1]) : 0;
    mark(n > 100, "check-copy reports more than 100 violations on the pre-refactor build (found " + n + ")", r.stdout.split("\n").slice(-6).join("\n"));
  }

  console.log("\nSELFTEST " + (failed ? "FAILED" : "OK") + ": " + passed + " expectation(s) held, " + failed + " did not (" + ((Date.now() - started) / 1000).toFixed(0) + " s)");
  if (failed) console.log("failed: " + failures.join("; "));
  return failed ? 1 : 0;
}

runMain("selftest", main);
