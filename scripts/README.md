# Site guards

Phase 1 made every word, picture, link and form field of the site editable data. These scripts make
that a rule that cannot silently regress: they run on every push and pull request
(`.github/workflows/site-checks.yml`) and locally with `npm run check`.

No network, no secrets, Node 22+. Each script is standalone, prints `file/page + snippet` for every
problem and exits `1` on any violation (`2` for a usage error such as a missing build).

| command | what it proves | time |
| --- | --- | --- |
| `npm run check` | runs the id guard and the guards below, fast ones first | ~1 min |
| `npm run check:ids` | the built-in page ids that editor anchors must not reuse are read from the templates, and every CMS anchor pattern lists them all (`lib/reserved-ids.js --check`) | <1 s |
| `npm run check:cms` | `cms/config.yml` is well formed and **covers every key** of the content | <1 s |
| `npm run check:previews` | the live previews survive empty / broken / hostile entries | <1 s |
| `npm run check:tokens` | **design tokens** ("Type & spacing") are bounded, wired to the stylesheet and match the CMS | ~20 s |
| `npm run check:copy` | **every visible word, picture and outward link on the built site is traceable to editable data** | <1 s |
| `npm run check:wiring` | **sentinel test**: every editable field really reaches the page, and no word is hard-coded | ~15 s |
| `npm run check:hostile` | hostile text typed into any field cannot break out of where it is printed | ~20 s |
| `npm run check:a11y` | **accessibility gate**: colour contrast of every text / background pairing (from the built CSS and `theme.json`, in hover / focus / toggled states) and page structure (headings, alt text, names, labels, landmarks, ARIA, media) | ~5 s + build |
| `npm run check:seo` | **search / social presentation**: one h1, unique titles and descriptions, canonical, og tags, sitemap, hidden pages, redirects file (below) | ~25 s |
| `npm run check:images` | **every picture exists, has a size and a description, and `/` is no heavier than before the image pipeline** | ~10 s |
| `npm run check:selftest` | breaks a throwaway copy of the site in ~20 ways and requires the right guard to fail | ~2.5 min |

`check:copy` builds the checkout into a fresh temp folder (so leftovers in `_site` cannot add pages that
are not in the source) and deletes it afterwards; `--site <dir>` reads an existing build instead and
`--root <dir>` takes the data from another checkout. The others build their own throwaway copies in
the OS temp folder and delete them; the real checkout is never modified.

## check-copy

Scans the **built** pages `/`, `/about/`, `/privacy/`, `/scroll/` and any page added later
(everything except `/og/ /ident/ /cms/ /admin/`, the internal tools listed in `excludePages`).

*Visible* means: text nodes (also inside `<noscript>`, `<template>`, SVG `<text>/<title>/<desc>`),
`alt`, `aria-label`, `title`, `placeholder`, `aria-description` and friends, submit-button and prefilled
text-input values, any other attribute whose value reads like a sentence (`data-tooltip="…"`),
`<title>`, the meta description, keywords and share tags, the text of JSON-LD blocks, the words a
stylesheet prints with `content:` on `::before` / `::after` (inline `<style>` and linked CSS), and the
human-readable strings of the scripts (inline, and same-site script files). Pictures
(`img/source/video/poster`, share images, icons, any `/images /frames /videos` path), outward links
(`http(s):`, `mailto:`, `tel:`) must come from data as well, and anything loaded from another site
(scripts, stylesheets, frames) must be allow-listed - the guard cannot read it.

Scripts are parsed with **acorn**, so string and template literals are found whatever they contain
(`{ } ; = < >` and backticks included - there is a fixture for exactly that). HTML held in a string
(`innerHTML = "<p>…</p>"`) is parsed and its text and attributes are checked. A string is judged by what
it says (`lib/prose.js`), not by which characters it contains. Strings in positions that are never
shown (selectors, event and attribute names, comparisons, `className`/`style` targets, `Error` /
`console` messages, `"use strict"`) are skipped. An unparsable script is a violation (fail closed).

**Traceable** means: the normalised text equals (not "contains") a piece of the corpus - every string
leaf of `src/_data/*.json`, front matter and markdown body of `src/pages/*.md`, front matter of
`src/*.njk` - expanded the way the site renders it: split at `<br />` and inline tags, markdown
rendered with the site's own options, `{placeholders}` (`© {year} COVERED`) as wildcards. Anything
else is a violation unless `scripts/copy-allowlist.json` accepts it.

Limits: it sees what the build renders. A word in a branch the data never switches on, or a
hard-coded word that also occurs in the data, passes `check:copy`; `check:wiring` closes both gaps
(below). Text produced only at runtime from a non-literal source, text inside images / videos, and
non-HTML outputs (`feed.xml`, `llms.txt`, `robots.txt`) are not visible to any static guard.

### The allow-list (`scripts/copy-allowlist.json`)

The only way something that is not editable data may be accepted. **Every entry needs a reason**, and:

* `text` - an exact string that is user-interface chrome: a glyph (`⏸ ▶ · ● ✓ →`), the brand wordmark
  `COVERED`, hidden anti-spam wording.
* `template` - a text the page **assembles from several editable strings**, e.g.
  `"{{footer.updatedLabel}} {{footer.lastUpdated}}"`. `{{path}}` is the *current* value (dotted
  keys, `[0]`, `[key=value]`, `[*]`, `|lower`), so editing the data never needs an allow-list change.
  Outside the `{{ }}` a template may contain **no letters**: composites are made of data, not of
  words in code. `"regex": true` allows `( ) ? : * + [ ] \d |` for repeated items.
* `prefix` - an asset folder, for `media` / `link` kinds only (`/frames/` - a generated still sequence).
* `pages`, `kinds` narrow where an entry applies (`text meta attr media link css script ldjson third-party`).
  Do not pin an entry to the current pages when editors can add pages that use the same template.
* `hiddenBy: { "class": "hp-field" }` - a claim that the text is hidden from every visitor. It is
  **verified**: the text must sit inside that class and the page CSS must hide the class.
* A sentence-length exact `text` entry is only accepted on pages that are `noindex` (today: the
  developer demo `/scroll/`). On a public page, **move the words into data and give the CMS a field -
  adding copy to code is not an acceptable exception.**
* Entries that match nothing are *noted* by default (an editor who switches a feature off - empties the
  ticker, hides a section - must never fail a build) and are **errors** with `--strict-stale` /
  `GUARD_STRICT_STALE=1`, which CI sets for pull requests (developer changes). A template entry whose
  data is empty is dormant, not wrong, outside strict mode.

## check-wiring (sentinel test)

Copies the site, replaces **every editable string** (`wiretk00042x`) - and, so that nothing hides,
adds an example of every optional field the data lacks and of every list item type the data does not
use yet, pads plain-string lists to three items, turns every yes/no switch on, and gives images /
videos unique file names - builds, and looks for each token in the output. A token that never appears
is a **dead field**: an editor can change it and nothing on the site moves (or the CMS offers a field
no template reads).

The same build is the strictest copy test: with every editable word replaced by a token, any other
word on a page, in an attribute, in a meta tag, in a stylesheet or in a script can only come from
code. This is how a hard-coded word that also exists somewhere in the data is caught. The scan is
repeated for up to six more builds in which the switches alternate off / on and every dropdown moves to
its other choices (`--variants <n>`, `0` = off), so markup that only shows in some editor-chosen state
cannot hide a hard-coded word either.

Skipped on purpose: values that are not free text (selects, numbers, colours, booleans - their effect is
not a visible token; selects and booleans are varied for the copy scan instead) and fields listed in
`scripts/wiring-ignore.json`. A value that a script receives as a whole object (`dump`) counts as wired
once it reaches the page; only a browser run (the behaviour harness) proves the script then uses it.

### `scripts/wiring-ignore.json`

Data paths the structure and wiring guards skip, each with a **reason**. `checks` says which guard
(`cms`, `wiring`); `injectedOnly` skips only the probe injected into items that do not hold the field
(fields a template reads for some item types only). Path syntax: `<data file or page>.<key>[].<key>`,
`[]` = any list item, `*` = any key, `**` = anything below. `kind: "page"` / `"data"` limits an entry to page
front matter or to `src/_data` files (used for `title`, which an optional Search title overrides). It is for values an editor must not or
cannot meaningfully change - not a way to avoid giving the CMS a field. Unused entries: see strict mode
above.

## check-cms

* **Structure:** `config.yml` parses; field names (camelCase, unique among siblings), labels, widgets,
  select options and defaults, patterns (valid regular expressions with a message), list types,
  `min/max`, `summary` placeholders, `media_folder: images` / `public_folder: /images`, preview templates
  registered for real collections / files only, `previews.js` parses. Conventions that are not
  failures (lists without `label_singular` / `summary`, optional objects with required children,
  entries without a preview) are counted and listed with `--warnings`.
* **Coverage:** every key of every `src/_data/*.json` and every front-matter key of `src/pages/*.md`
  has a visible CMS field of the right kind; every data file has a CMS entry; page bodies are
  editable; every stored value is valid for its own field (select option, pattern, boolean, number
  range); every required field has a value (otherwise the CMS refuses to save the entry).

## check-previews

Renders each preview in `cms/previews.js` the way Decap does (a tiny `h` and an Immutable-like
`entry`) with the real data and ~40 broken variants (empty entry, empty strings, nulls, emptied lists,
huge strings, random keys and items removed, every key missing in turn): no exception, no `undefined`
text. Markup typed into any field must not reach the preview as live HTML (the output of every
`dangerouslySetInnerHTML` is parsed: only `<br>` may stay live, escaped text such as `&lt;img&gt;` is fine)
and a `javascript:` value must not reach a link. Problems that existed when the guard was added are
listed with a reason in `scripts/previews-known-issues.json`; new ones fail, and a listed one that has
been fixed should be removed (strict mode). It also reports (information only) how many editable
values show up in their preview.

## check-hostile

Builds a reference copy, then rebuilds it with attack strings in every editable field (appended
markup / script / template breakouts, `javascript:` and `data:` links, protocol-relative links, path
traversal with attribute breakouts, a CSS/style breakout) plus a "chaos" build rewriting every string of
the data (selects and ids included). Compared with the reference: no new event-handler attribute,
`<script>`, `<style>`, `<iframe>`/`<object>`/`<base>`/meta refresh; no `javascript:`/`data:` URL, no
off-site or `..` resource path; every inline script still parses with no injected call or identifier;
JSON-LD still parses; no `{{ }}` / `{% %}` typed into a field was evaluated; no extra `</script`. A
static rule bans HTML or code sinks fed from data in the page's own scripts (`innerHTML =` anything but
a fixed string, `document.write`, `eval`, `setTimeout("…")`, `location` changes that do not start with
`mailto:`, `/` or `#`). The test fails when the attack string does not reach the pages (a vacuous run).

## check-tokens (design tokens: "Type & spacing")

Founders can change type sizes, line and letter spacing, boldness, fonts, section spacing, page width, card gap,
corner roundness and shadow strength in the CMS ("🔤 Type & spacing", `src/_data/tokens.json`). The colours stay
in `theme.json` ("Colours & theme"). The rules that keep this safe:

* **One table, `lib/tokens.js`.** Every token is stored as plain numbers (a type size is three numbers: smallest
  rem, growth in `vw`, largest rem; the opening headline has a fourth, a `vh` height limit) or one word from a short
  list (font: `motor` / `openSauce`, weight: 400-700, corners: pill / rounded / soft / square). The table holds the
  shipped default, the hard min and max, the step and the CSS variable. `lib/eleventy/tokens.js` turns it into
  the `tokenVars` / `tokenValue` filters; `theme-vars.njk` prints `--tk-*` declarations after the colour block.
* **A typo can never produce bad CSS.** A number outside its bounds is clamped to the nearest bound; anything that is
  not a finite number (a string, null, array, object, `NaN`) falls back to the shipped default; an unlisted word falls
  back to the default; the largest size can never be below the smallest. Nothing from the data is pasted as text:
  the filter re-prints numbers and looks words up in a fixed table, which is why `tokenVars` may be chained into `| safe`.
* **The untouched site is unchanged.** The stylesheet declares the shipped defaults once (`TOKENS-BEGIN … TOKENS-END`
  in `site-styles.css`) and uses `var(--tk-…)` where it used to hold literals; the generated override block restates them.
  `--radius`, `--text-sm` and `--font-*` now point at tokens, `--shadow` takes its alpha from `shape.shadow`.
* **Not tokenised (still fixed in the stylesheet):** the pinned-hero sub-lines (`stamp`, `hero-sub` inside `.hero-pin`),
  button/field padding, the smaller radii (stamp 14px, chips 12px ...), the one-off shadows (button glow, machine,
  polaroid), `--font-script` / `--font-stamp`, section `max-width`s in `ch`, and every media-query breakpoint.

`npm run check:tokens` (part of `npm run check`, ~20 s; `--static` skips the builds; `--write` regenerates the
`TOKEN_SPEC` copy inside `cms/previews.js`):

1. **In sync:** every token has a CMS field with exactly the filter's `min` / `max` / `step` / options and a hint, no CMS
   field is extra, `site-styles.css` defaults equal the table, every `--tk-*` is used by `var()` (no dead token) and every
   `var(--tk-*)` is declared, the preview carries the current table.
2. **Bounded:** ~40 hostile token documents (attack strings, template syntax, huge / negative / tiny numbers, objects,
   arrays, `__proto__`, scalars in place of groups) go through the real filters; every printed declaration is checked
   against the table independently of the clamping code.
3. **Built:** the site is built with the shipped data, a hostile `tokens.json`, every number at its lowest and at its
   highest allowed value (and every choice moved): `assets/site.css` and the home page `<style>` must contain exactly the
   validated declarations, each token must change the output (it follows its data), `--shadow` follows `shape.shadow`, and
   no attack text may appear in any output file.

   A token marked `largeText` in `lib/tokens.js` (today the section title, dark ink on the orange accent at 3.4:1) must
   not be settable below 24px even with the page text at 80%: layer 1 checks that arithmetic, so a size change inside the
   CMS limits can never turn large text into normal text and fail the accessibility gate for the wrong reason.

Adding a token: add a row to `lib/tokens.js`, the default to the `TOKENS` block of `site-styles.css`, use `var(--tk-…)`,
add the field to the "Type & spacing" entry of `cms/config.yml` and `tokens.json`, run `node scripts/check-tokens.js --write`.
## check-a11y (accessibility gate)

Builds the checkout (or reads `--site <dir>`) and, for every public page (everything `check-copy` scans; the
internal tools `/og/ /ident/ /cms/ /admin/` are skipped), checks colour contrast and page structure. **Errors
fail the run, warnings are listed.** Pages marked `noindex` (today the developer demo `/scroll/`) are checked but
their errors are only warnings. `--github` (used by the workflow) also prints `::error file=...` / `::warning`
annotations and appends a result table to `$GITHUB_STEP_SUMMARY`; nothing is posted, no token is needed.
`--list-pairs` prints every colour pairing found, worst first. `--unit` runs the gate's own tests.

### Colour contrast (WCAG 2.2: 1.4.3 text 4.5:1, large text 3:1, 1.4.11 symbols and focus rings 3:1)

The pairings are **derived, not typed in**. `lib/a11y-css.js` reads the page's real stylesheet (inline `<style>` and
linked CSS: selectors with specificity, `@media`, `var()`, `!important`, inheritance, inline `style`) and
`lib/a11y-style.js` computes for every element the text colour, the stack of backgrounds behind it (each
ancestor's colour, see-through layers composited, every colour stop of a gradient), opacity, font size and weight.
`lib/a11y-contrast.js` then collects one pairing per distinct (text colour, background stack, size class) and
keeps the theme **role** each colour came from (`var(--muted)` stays "Quiet text", not a hex code), so a failure
reads *"Quiet text [muted] #F5EBDD on Page background [paper] #FFF8EC: 1.12:1, needs 4.5:1"* and works for any values
in `src/_data/theme.json` (the check reads the built CSS, so an editor's colours are what is measured).

What is measured, on every page:

* text in every element: body text, headings, kickers / labels, links, buttons (incl. the white text on the button
  colour), section and band backgrounds (partner wall, opening screen, how-it-works, dark sections, accent band),
  the pastel cards, nav, footer, the form fields and their hints, stat numbers, receipts, chips, FAQ;
* text printed by CSS `::before` / `::after` (ticks, arrows, bullets: a symbol with no letters is judged at 3:1,
  and only warns when it is a purely decorative pseudo-element glyph), placeholders (the browser's grey when the
  stylesheet sets none), SVG `<text>` (uses `fill`);
* the **keyboard focus ring** (`outline`) of every link, button and form control against what is outside it
  (a ring touching the control, offset under 1px, is also judged against the control's own fill; failing on only
  one side is a warning);
* **states**: hover, `:focus`, `:focus-visible`, pressed, `[aria-*]` / `[data-*]` states, and the classes the
  page's scripts toggle (`stateClasses` in `a11y-config.json`: `active done lit live soon open`), each tried on every
  element a rule could apply it to; and a **wide (1280) and a narrow (360) screen** (`@media` rules differ);
* large text = 24px, or 18.66px and bold, computed from `rem` / `em` / `vw` / `clamp()` / `calc()`.

Deliberately **not** covered (the report says so for text over pictures): text drawn over a photograph or the
hero canvas / video (only the plain colour behind it is measured, the report counts such pairings), text size /
spacing overrides, hover text on elements the page positions over something else (the check follows the
element's ancestors, not stacking order), the logo (`exempt` in `a11y-config.json`, WCAG exempts logotypes),
disabled controls, form-control borders, target size. A selector the reader cannot interpret never matches and is
listed ("could not interpret"), so a new CSS feature cannot silently hide text.

### Structure

`lang` and `<title>`; zoom not blocked by the viewport tag; exactly one `<main>`, a banner and footer landmark,
labelled `<nav>`s when there are several; exactly one `<h1>`, no empty heading, **no skipped level**; a skip link
whose target exists, in-page `#links` that point at something; **every `<img>` has `alt`**, an empty `alt` only on
an image marked decorative (`aria-hidden="true"` or `role="presentation"`) or inside a link / button that has its
own text, file-name-like or "image of ..." alt text warns; `<svg role="img">`, `<canvas>`, `<iframe>` names;
**links and buttons have a name** (text, `aria-label`, `aria-labelledby`, image alt, SVG title), "click here" /
"here" / "link" fail, "read more" / "learn more" warn (`genericLinkText` in `a11y-config.json`); **every form
control has a label** (a placeholder is not one), `email` / `tel` fields without `autocomplete` warn; duplicate ids;
`aria-labelledby` / `for` pointing nowhere; `tabindex` above 0; **`aria-hidden="true"` on something the keyboard can
still reach** (or on `<body>`); autoplay with sound, a `<video>` without controls that is neither muted + labelled
nor decorative, a silent looping video with no pause control (warning), and **reduced motion**: an autoplaying video
needs a `prefers-reduced-motion` rule in the CSS or scripts, CSS animations without one warn.

### Known issues (`a11y-known-issues.json`)

Real defects the gate found on day one are recorded with a reason, not hidden: they are shown in every report and
in the pull-request summary, **may not get worse** (a contrast entry fails again when its ratio drops by more than
0.05), and a fixed one must be deleted (an error in strict mode, i.e. on pull requests). Today: the required-field
asterisk and the form-field focus ring on the dark enquiry card (1.62:1), and the placeholder grey (4.36:1).

### The live report in the CMS

`cms/contrast.js` is a plain UMD file (no dependencies, text maths only) loaded by `cms/index.html` and `require`d
by this script, so the CMS and the pull-request check use **the same code**. Its `PAIRS` block is generated by
`node scripts/check-a11y.js --write-pairs` from the built site **plus the same site with every optional field,
block type and yes / no switch turned on** (the copy `check-wiring` builds), so switching a feature off or adding a
block never makes it stale. `npm run check` fails when the site contains a themed pairing the table does not know
(a stylesheet or template change: run `--write-pairs` and commit), and `--maximal` (used by selftest) makes the same
check against the every-option copy. The "Colours & theme" preview
(`cms/previews.js`, template `theme`) re-runs every pairing against the colours currently typed into the form and
lists the ones that are too low with their ratio; pairings that are recorded known issues show as "worth a second
look" until they get worse. It prints plain text only (the only styled values are `#RRGGBB` strings produced by the
maths), so it adds no HTML sink. A custom Decap colour **widget** was not used on purpose: a widget only sees its own
value, so it could not judge a colour against the others without reaching into Decap's internals (and it would
replace the built-in picker); the preview sees the whole entry.

## check-seo

Search and social presentation (Phase 3). No network. `--site <dir>` audits an existing build,
`--no-probe` skips stage 3.

1. **Rules** - `lib/eleventy/seo.js` (`analyseRedirects`, `seoCanonical`, sitemap value filters) is run against
   ~40 hostile / broken redirect and canonical inputs (newline, space, tab, NUL, wildcard, `:splat`, `//host`,
   `javascript:`, `http:`, credentials, `..`, protected folders, loops, duplicates, long chains, >100 rules, a
   "permanent" value that tries to become a 200) and 6000 random ones. Every line that comes out must match one
   strict shape: `/path /path-or-https-address 301|302`.
2. **Site** - every public (not noindex) page of a fresh build has exactly one `<h1>`; one non-empty `<title>`
   and meta description that are unique across the site and of sensible length (title 10-120, description 50-320
   characters - longer than about 60 / 160 is only a note); exactly one canonical, absolute `https://coveredaccess.com/...`;
   `og:title/description/type/url/image` and `twitter:card`, `og:url` equal to the canonical, the share picture
   exists; every JSON-LD block parses, has the schema.org context and typed items. `sitemap.xml` lists exactly the
   public pages that are their own canonical address (no duplicates, valid values); a page hidden from search
   (`robots noindex`) appears in none of `sitemap.xml`, `llms.txt`, `feed.xml`; `robots.txt` points at the sitemap and does not
   block the site; `_redirects` has only well-shaped lines, every rule of `redirects.json` took effect (a rule the
   builder had to drop - loop, wildcard ... - is reported, because the CMS pattern would not have let it be typed) and
   every internal target exists.
3. **Probe** - a throwaway copy is built with every SEO field set: one page hidden, a page whose canonical is another page, a
   foreign canonical (must be refused), sitemap priority / frequency / date, a search title, a social card with
   picture and description, and a list of redirects mixing valid and hostile entries. The output must change exactly
   that way (noindex tag, sitemap entries, only the valid redirect lines), and the probe site must itself pass stage 2.

`check-hostile` also reads `_redirects` and `sitemap.xml` of every hostile build: any line of the wrong shape fails.

### What is generated from data, and what is not

| output | source |
| --- | --- |
| `<title>`, meta description, `og:*`, `twitter:*`, canonical, robots | `site.json` (homepage) and page front matter, through `seoCanonical` / `imageInfo`; defaults reproduce the pre-Phase-3 markup byte for byte |
| `sitemap.xml` | every page; hidden pages and pages whose canonical is elsewhere are left out; `lastmod` / `priority` / `changefreq` from the data (validated), `lastmod` falls back to the file date |
| `_redirects` | `src/_data/redirects.json` via `src/redirects.njk` |
| JSON-LD (homepage) | `site.json` / `faq.json`, unchanged and strict |
| `robots.txt`, `llms.txt`, `feed.xml` | **still hand-maintained files at the repository root** (copied as they are). `check-seo` verifies that no hidden page is linked from them. They are not data-driven yet. |

### Redirects: how they are kept safe

`redirects.json` -> `redirectRules` filter -> `_redirects`. Only `301` (permanent) and `302` (temporary) are ever written,
so an editor can never create a `200` rewrite / proxy of another site. The old address must be a plain path (letters,
digits, `- . _ ~ % +` and slashes; no `*`, no `:placeholder`, no query, no spaces; never `/`, the editor `/cms` `/admin`,
`/images` `/assets` `/fonts` `/videos` `/frames`, `sitemap.xml` `robots.txt` `llms.txt` `feed.xml`). The new address is
a path on the site (`#anchor` and `?x=1` allowed, `..` and `//` not) or a full `https://` address on another host (a
`https://coveredaccess.com/...` address is turned into a path so loops stay visible). **A full `https://` address on
another host is only accepted when the host is on the approved list `EXTERNAL_HOSTS` in `cms/redirect-rules.js`**
(exact host names, no ports, no IP addresses; a change to that file is a code review): a redirect starts on our own
address, so an unapproved target would let a stolen editor session send visitors from `coveredaccess.com` to a
lookalike site. Encoded dot-segments and slashes (`%2e`, `%2f`, `%5c`) are refused. The rules live in one shared file,
`cms/redirect-rules.js`, used by the build (`lib/eleventy/seo.js`) and by the CMS preview, so the preview marks exactly
the rules the build drops, with the same reason; a rule whose old address is a page that exists is written but the
build says it never fires. A rule that points to itself,
closes a loop, repeats an earlier old address, makes a chain of more than 5 steps, or is number 101+ is dropped (with a
build warning). The CMS field patterns say the same in plain English, so a valid CMS save is never dropped; the
Redirects preview marks lines that would be ignored.

**Netlify precedence** (Netlify documentation, not testable offline): redirect rules in a `_redirects` file in the
published folder are processed *before* the `[[redirects]]` of `netlify.toml`, first match wins, and neither is
"forced" here, so a real page always beats a redirect from the same address. `netlify.toml` is unchanged: its four
`coveredaccess.co.uk` host rules are host-based (`force = true`) and keep canonicalising the old domain. A path
rule from `_redirects` applies to every host, so a visitor to `coveredaccess.co.uk/old` takes two hops (path rule,
then host rule). The GitHub Pages mirror ignores `_redirects`.

## Pictures: the image pipeline and check-images

Editors upload a photo of any size (a 4 MB JPEG is fine); nothing else is done by hand.

* `lib/eleventy/images.js` (plugin, `@11ty/eleventy-img` 6.0.4 on sharp) finds every `/images/...` picture
  that `src/_data`, `src/pages` and `src/*.njk` mention and, before each build, makes AVIF + WebP + the
  original format at 480 / 960 / 1600 px wide (never enlarged) in `.cache/img/` (git-ignored; Netlify may
  start with it empty, then it is regenerated - about 30 s cold, 2 s warm). File names are
  `<name>-<hash of the picture's bytes>-<width>.<ext>`, so a replaced picture can never be served stale.
  After the build exactly the files the pages mention are copied to `_site/img/` (cached for a year in
  `netlify.toml`). The originals are still copied under `/images/`; hand-made `.webp` siblings are no
  longer used (and not deleted).
* `{% set im = photo.src | imageInfo %}` keeps its safe-path contract (only existing files under
  `images/`, or `videos/` for a cover picture; no `..`, no web addresses; anything else gives an empty
  `im.src` and the template prints nothing). `im` now also carries ready `srcset` strings; templates print
  them with the macro in `src/_includes/picture.njk`:
  `{{ pic.picture(im, photo.alt, photo.decorative, "(max-width: 780px) 92vw, 420px") }}`. The macro writes
  `<picture>` with AVIF and WebP `<source>`s and an `<img>` (original format) with `srcset`, `sizes`,
  intrinsic `width`/`height`, `decoding="async"` and `loading="lazy"` (a fifth argument `true` makes the
  one top-of-page picture `loading="eager" fetchpriority="high"`; nothing uses it today because the home
  page leads with the scroll-scrub canvas). A picture the pipeline cannot process (GIF, SVG, broken file, a
  path the scan did not see) falls back to a plain `<img src=original>` - never a broken image. Video cover
  pictures, the share picture and the SVG map keep pointing at the original file.
* **Picture descriptions.** Every picture field in `cms/config.yml` has an `alt` text field and a boolean
  "Decorative picture (no description needed)" (`decorative`) beside it; the macro prints `alt=""` for
  decorative pictures. Decap cannot require a field only while a switch is off, so the form leaves `alt`
  optional (hint: required unless decorative) and the rule is enforced by the guards: `check:cms` fails a
  picture field with no `alt` + `decorative` pair (structure) and any picture in the data that has
  neither a description nor `decorative: true` (values). Pictures that are never drawn as a picture are
  listed with a reason in `scripts/alt-exemptions.json` (share image, map backdrop, two video cover
  frames); an entry that exempts nothing is an error. The CMS previews print a warning under such a picture.
  `check:wiring` keeps every `decorative` switch off in its token build (otherwise the description would
  vanish and look like a dead field) and flips it in the alternating variants.
* `check:images` (`scripts/check-images.js`) reads a build and requires, per public page: every content
  `<img>` (`/img/` or `/images/`) has numeric `width` + `height`, an `alt` attribute, `loading` and
  `decoding="async"`; `sizes` wherever there is a `srcset` or `<source>`; no `src`, `srcset` candidate,
  `<source>` or video `poster` pointing at a file that is not in the site; at most one eager /
  `fetchpriority="high"` picture; empty `alt` only as often as the data has `decorative: true`. It also
  simulates the browser (the `sizes` + `srcset` choice, AVIF first, every lazy picture counted) for `/` at
  390 and 1280 px on 1x and 2x screens and requires the bytes to be no larger than
  `scripts/fixtures/images-baseline.json`, measured once on the previous hand-made WebP markup
  (`--write-baseline <site>`; today 64 KB against 147 KB at 1x). The scroll-scrub stills under `/frames/`
  are not content pictures (no size rule; they still need an `alt` attribute).
* `check:images` also reads the uploaded FILES in `images/` and `videos/` (they are published byte for byte): an
  empty or undecodable picture fails (the build leaves it out of the pages instead of publishing a broken image, and
  `imageInfo` reports `src: ""`); a JPEG carrying the GPS block of its EXIF data fails (the original stays
  downloadable and is the share picture); an SVG fails if it holds a `<script>`, an event-handler attribute,
  `<foreignObject>`, `<iframe>` / `<embed>` / `<object>` / `<link>`, a `javascript:` URL, an `href` or CSS `url()` that
  is not inside the file, or `@import` (an SVG opened on its own address runs on our domain; `netlify.toml` also
  serves `/images/*.svg` with a sandboxing Content-Security-Policy). Pictures with an EXIF rotate flag (5-8) get
  their `width` / `height` swapped, like the generated copies. After the build only files the optimiser itself wrote
  are copied to `/img/`, so text such as `/img/..` typed into a field can never reach the file system.
* `check:copy` accepts `/img/<name>-<hash>-<width>.<ext>` only when `<name>` is the file name of a
  picture held in the editable data, so the generated files are traceable like the originals.

## selftest

`npm run check:selftest` proves the guards still bite (`--unit` = detectors only, `--only <text>` =
matching scenarios, `--list`). It first checks the detectors against `scripts/fixtures` (a JavaScript
case list including strings with `{ } ; = < >` and backticks, CSS `content:` cases, and a page with
hard-coded text in every place a visitor can read it), then works on a throwaway copy of the site:

* a control run: the untouched copy passes everything;
* ordinary editor work stays green: new words, markdown, long titles, a new page, a new form field, a
  new menu link, a ticker whose items changed, a footer whose placeholders changed, features switched off;
* one deliberate regression at a time must fail **for the right reason**: a hard-coded sentence, word,
  picture and link in a template; words in a stylesheet; a sentence that only shows for one dropdown
  choice; hard-coded sentences in a script partial; a new JSON key with no CMS field; a CMS field with
  no data (optional and required); data and a field that no template reads; a template reading the wrong
  key; `| safe` on a text field; data in a script without escaping `<`; a link without `safeUrl`;
  `innerHTML` fed from data; a preview that throws, prints `undefined` or renders typed text as HTML; a
  malformed CMS config; hidden fields and values outside their select; every allow-list rule;
* the accessibility gate: a safe re-theme stays green; hostile palettes (all white, near-identical text and page, quiet text on the page colour, white button text on a white button) fail naming the colour roles and the ratio; a missing / empty alt, a skipped heading level and an empty link each fail; several `h1` / unlabelled field / `tabindex` / duplicate id / reachable `aria-hidden` fail; a stylesheet change that adds a pairing the CMS table does not know fails until `--write-pairs`; `--github` output carries annotations and a summary table and editor text cannot inject a workflow command.

**Not vacuous:** against the pre-refactor build the copy guard reports a wall of violations.

```
git archive 83a39dc src | tar -x -C /tmp/base          # data of the commit before Phase 1
node scripts/check-copy.js --root /tmp/base --site <pre-refactor build> --no-stale
```

(`83a39dc` is `main` before Phase 1; `selftest.js --baseline-site <dir> --baseline-root /tmp/base`
asserts more than 100.)

## Adding or changing editable content

1. Put the words in `src/_data/<file>.json` (or page front matter) - Unicode characters, not entities.
2. Add the field to `cms/config.yml` inside that file's entry: plain-English `label`, a `hint` saying where
   the text appears, `required: false` when optional.
3. Print it in the template with `{{ x }}` (never `| safe` on data; titles use `| safeTitle | safe`,
   markdown `| md | safe`, links `| safeUrl`, images `| imageInfo`).
4. Run `npm run check`. A field nothing reads fails `check:wiring`; a key without a field fails
   `check:cms`; a word left in the template fails `check:copy` (and `check:wiring`).

Treat a failing guard as a real defect first. Only when the thing is genuinely not editable copy add an
allow-list / ignore entry - with the reason a reviewer needs to agree.

## Layout

```
scripts/
  check-*.js                  the guards                 selftest.js   the regression proof
  a11y-config.json            gate settings              a11y-known-issues.json   recorded defects
  copy-allowlist.json         accepted non-data text     wiring-ignore.json   skipped fields
  previews-known-issues.json  known preview problems
  fixtures/                   detector fixtures
  lib/                        parsing, corpus, sentinel, workspace, hostile analysis
../lib/tokens.js             design-token table (bounds, defaults, CSS)
```

Throwaway copies (`lib/workspace.js`) copy everything except `node_modules` (linked) and `frames/`
(21 MB of stills only referenced by URL) into the OS temp folder, build with the repo's Eleventy, and
are deleted afterwards (links are removed first, so nothing real can be deleted).

## Studio guards (phase 4)

`npm run check` ends with `npm run check:studio` (`scripts/check-studio.js`), which runs every `studio/guards/check-*.js` and every `studio/tests/**/*.test.js`. `npm run check:selftest` also loads `studio/guards/selftest-*.js`, each of which breaks one thing in a throwaway copy and requires the matching guard to fail. Details live next to the code in `studio/README.md`; the contract is `studio/DESIGN.md`.

| Guard | Unit | What it proves |
|---|---|---|
| `check-history.js` | D | The History, Help, tour and palette overlay files obey the overlay rules (no `innerHTML`, `eval`, `createElement`, string timers, network calls or foreign hosts; `localStorage` only inside try/catch; only the tags and properties `h()` allows), `ext.css` is inert, the restore service never calls a Git write method and goes through `drafts.createFromOps`, `invertDiff` restores mutated copies of every real `src/_data/*.json` with an `expect` on each replace and remove, `docs/STUDIO-RUNBOOK.md` names every environment variable of the design and the GitHub App permissions, `studio/THREAT-MODEL.md` has its sections, and the manifest keeps the four `ext/` files in contract order |

`studio/tests/ext/browser.test.js` drives a real Chrome with the keyboard only (History, Restore, tour, palette, Help, 375 px). It needs `puppeteer-core` and a Chrome or Edge binary, which are not dependencies of the repository, so it skips itself when they are missing.
