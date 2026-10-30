# Unit A - markers + schema

Branch `phase4/markers`. Implements DESIGN.md sections 2, 3 and 4. Owns: `lib/eleventy/studio.js`, `studio/markers/`,
`studio/schema/`, `studio/guards/{check-markers,check-schema,selftest-a}.js`, `studio/tests/markers/`,
`studio/tests/fixtures/content.sample.json`, the `{% cms %}` markers in `src/**` templates, one line in
`scripts/lib/util.js`, append-only blocks in `netlify.toml` and `.gitignore`.

## Run it

```
npm run studio:schema                        # cms/config.yml -> studio/schema/studio-schema.json (committed; --check to verify)
npm run studio:build-edit                    # CMS_EDIT=1 build into _site-edit/ (STUDIO_API_URL defaults to http://localhost:8787)
node studio/guards/check-markers.js          # builds normal + edit (+ two hostile edit builds), ~60 s; --update raises the coverage ratchet,
                                             #   --warnings lists visible text without a marker, --no-hostile skips the two extra builds
node studio/guards/check-schema.js           # schema is fresh, complete, rules attached (instant)
node --test studio/tests/markers/*.test.js   # 44 unit tests (grammar, shortcode + plugin, snapshot, schema/resolver, analysis, parity)
node scripts/selftest.js --only studio       # 9 deliberate regressions (about 4 min)
```
All of it is part of `npm run check` through `check:studio`.

## What a marker looks like

`{% cms "<ref>", "<kind>" [, { alt, decorative, href, hide, cssvar }] %}` goes inside an opening tag, directly after the last
attribute with no spaces, so a normal build prints nothing and the HTML stays byte-identical. Pictures go through the
`picture` macro, which takes three extra arguments `(imgRef, altRef, decRef)` and puts the marker on the `<img>`.
Section partials and the shared block partials read two variables set by the loop in `src/index.njk` / `src/_includes/page.njk`:
`blockRef` (`homepage.sections.N` or `pages:<slug>.sections.N`) and `blockKind` (`section` on the home page, `item` on pages).
Link items read `linkRef` (`nav.items.N`, `footer.columns.C.links.N`, `footer.compactLinks.N`) or `linkLabelRef`.

Coverage today (home page + /about/ + /privacy/): 343 markers - text 202, item 58, longtext 40, section 12, image 13,
markdown 5, color 9, toggle 4. 228 visible text leaves of `/` and `/about/` are editable in place (ratchet in
`studio/schema/marker-coverage.json`); `check-markers.js --warnings` lists the rest ("Fields panel only").

Colours: `<body>` -> `theme.paper` (`--paper`), both footers -> `theme.inkDeep` (`--ink-deep`), both closing banners -> `theme.ink`
(`--ink`). The guard reads `src/_includes/theme-vars.njk` and checks that each `data-cms-cssvar` is really set from that theme key.
Toggles: `#progress` (`motion.scrollProgress`), `.conveyor` (`motion.conveyor`), `.marquee-pause` (`motion.marquee`), the picture
`<figure>` of an image+text block (`imageRight`). Section containers: every section partial and every block partial.

## Deviations from DESIGN.md (the integrator folds these back)

1. **Guard names.** The task text named `scripts/check-studio-markers.js`; the contract (and `scripts/check-studio.js`) say
   `studio/guards/check-markers.js`, so that is where it lives; it runs inside `npm run check` through `check:studio`.
2. **`blockRef` instead of `secIdx`.** DESIGN.md 2.2 suggests `{% set secIdx = loop.index0 %}`. The same block partials are included from the
   home page and from `page.njk`, so one variable holding the whole reference (`blockRef`) plus `blockKind` replaced it. Nothing else changed.
3. **`pages.body` is a read-only (`hidden`) field `_body`.** `cms/config.yml` has no body field for pages and `page.njk` never renders the body,
   so the schema declares `_body` with widget `hidden` (unit B: it may only be re-sent unchanged). No template marks it.
4. **`reservedIds`** is `lib/reserved-ids.js` `.sorted()` (the lower-case ids the CMS anchor patterns list). The reserved *prefix*
   (`faq-panel-`) is not in the schema as the contract has no field for it; it is inside the anchor field's `pattern` (a negative lookahead), which B validates.
5. **`x.imageStyle`** is derived from the pattern as specified (`bare-name` for all current image fields, because the config patterns
   accept only a file name). The stored data nevertheless holds `images/x.jpg` or `/images/x.jpg` (Decap prepends `public_folder`).
   B must treat the stored form, not the pattern, as the value form (`safeUrl`-style path under `images/`). I did not touch config.yml.
6. **Number fields have no marker kind.** The contract's kind list has no `number`, so stat numbers (`problem.stats.N.number`),
   photo tilts, map coordinates and design tokens are Fields-panel-only. (`stats` block numbers are strings and are marked.)
7. **Not marked (Fields panel only):** copyright line (`{year}` placeholder), "updated" line (two values in one element), the conveyor words
   (the template repeats them), enquiry-form questions (a macro; they would need ref arguments), aria-labels and meta text, videos (`file` widget).
8. **`lib/eleventy/studio.js` tolerates a config without `addShortcode`.** `node lib/reserved-ids.js --check` loads every plugin with a
   stub config that has none; the plugin skips registration there. (Editing that stub was not in scope.)
9. **Passthrough HTML** (`admin/`, `cms/`) is copied as is, so the parity guard does not require the overlay tag in files under the
   folders named in `addPassthroughCopy(...)` of `.eleventy.js`; every other page with `</body>` must carry exactly one tag.
10. **Hostile check tolerance.** The shared hostile plan adds list items to the attack build, so a marker for another item of the same list is
    accepted; a marker that disappears, or one for a field the reference never had, fails.
11. **The overlay tag is injected into every HTML page with a `</body>`**, including the tool pages (`/og/`, `/ident/`, `/scroll/`). That follows 3.1 literally; the overlay is inert without `?studio=1`.
12. `lib/rules.js` does not exist yet (unit B): `check-markers.js` uses an identical private copy of `safeUrl` until it appears, and
    `build-schema.js` hard-codes `LINK_PATTERN_SOURCE`; `check-schema.js` compares it with `lib/rules.js` as soon as that file exports it.

## For the other units

* `content.json` / `studio-schema.json` shapes are exactly DESIGN.md 3.3 / 4. `studio/tests/fixtures/content.sample.json` is a trimmed real snapshot
  (11 files incl. `pages:about`); a test keeps it equal to the live data, so regenerate it when a listed data file changes
  (`node -e` over `studio/markers/snapshot.js`, as in the unit test).
* `studio/schema/resolve.js` is UMD (Node + browser). A pointer to a typed-list item needs the document (`doc`) to learn the item's type.
* `studio/markers/analyse.js` (Node) exposes `markersOf`, `resolveProblems`, `truthProblems` for B's validator-parity and for tests.
* The overlay bundle is looked up at `studio/overlay/bundle.js` (`bundle()`); without it a stub `overlay.js` is written and a warning printed.
