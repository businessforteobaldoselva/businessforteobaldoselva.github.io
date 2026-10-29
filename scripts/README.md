# Site guards

Phase 1 made every word, picture, link and form field of the site editable data. These scripts make
that a rule that cannot silently regress: they run on every push and pull request
(`.github/workflows/site-checks.yml`) and locally with `npm run check`.

No network, no secrets, Node 22+. Each script is standalone, prints `file/page + snippet` for every
problem and exits `1` on any violation (`2` for a usage error such as a missing build).

| command | what it proves | time |
| --- | --- | --- |
| `npm run check` | runs the id guard and the six guards below, fast ones first | ~60 s |
| `npm run check:ids` | the built-in page ids that editor anchors must not reuse are read from the templates, and every CMS anchor pattern lists them all (`lib/reserved-ids.js --check`) | <1 s |
| `npm run check:cms` | `cms/config.yml` is well formed and **covers every key** of the content | <1 s |
| `npm run check:previews` | the live previews survive empty / broken / hostile entries | <1 s |
| `npm run check:copy` | **every visible word, picture and outward link on the built site is traceable to editable data** | <1 s |
| `npm run check:wiring` | **sentinel test**: every editable field really reaches the page, and no word is hard-coded | ~15 s |
| `npm run check:hostile` | hostile text typed into any field cannot break out of where it is printed | ~20 s |
| `npm run check:seo` | **search / social presentation**: one h1, unique titles and descriptions, canonical, og tags, sitemap, hidden pages, redirects file (below) | ~25 s |
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
`https://coveredaccess.com/...` address is turned into a path so loops stay visible). A rule that points to itself,
closes a loop, repeats an earlier old address, makes a chain of more than 5 steps, or is number 101+ is dropped (with a
build warning). The CMS field patterns say the same in plain English, so a valid CMS save is never dropped; the
Redirects preview marks lines that would be ignored.

**Netlify precedence** (Netlify documentation, not testable offline): redirect rules in a `_redirects` file in the
published folder are processed *before* the `[[redirects]]` of `netlify.toml`, first match wins, and neither is
"forced" here, so a real page always beats a redirect from the same address. `netlify.toml` is unchanged: its four
`coveredaccess.co.uk` host rules are host-based (`force = true`) and keep canonicalising the old domain. A path
rule from `_redirects` applies to every host, so a visitor to `coveredaccess.co.uk/old` takes two hops (path rule,
then host rule). The GitHub Pages mirror ignores `_redirects`.

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
  malformed CMS config; hidden fields and values outside their select; every allow-list rule.

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
  check-*.js                  the six guards            selftest.js   the regression proof
  copy-allowlist.json         accepted non-data text     wiring-ignore.json   skipped fields
  previews-known-issues.json  known preview problems
  fixtures/                   detector fixtures
  lib/                        parsing, corpus, sentinel, workspace, hostile analysis
```

Throwaway copies (`lib/workspace.js`) copy everything except `node_modules` (linked) and `frames/`
(21 MB of stills only referenced by URL) into the OS temp folder, build with the repo's Eleventy, and
are deleted afterwards (links are removed first, so nothing real can be deleted).
