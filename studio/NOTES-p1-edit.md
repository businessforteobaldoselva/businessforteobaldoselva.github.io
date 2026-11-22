# Phase 1, EDIT unit: working notes

Contract: `studio/PHASE1-DESIGN.md` sections 8 and 9. What was built and the deviations are in `studio/README.md` (heading EDIT); the
operating text is `docs/STUDIO-RUNBOOK.md` 4c.3; the risks are `studio/THREAT-MODEL.md` P1-EDIT. These notes are the decisions behind them.

## One engine, three callers

`studio/content-rules/engine.js` + `rules.js` are UMD files with no Node and no browser API inside. The overlay bundle concatenates them
(manifest order), Node `require`s them (`index.js`), and the parity test loads them into a bare `vm` context the way the bundle does. The only
non-data inputs are `facts` and `roles`, and both are passed in. That is why the panel and CI cannot drift: there is one function.

* A finding's identity is `rule|file|json-pointer` (`key`). The panel and the guard compare by key; the ignore list and the baseline are lists of keys.
* The schema walk (`walk()` in `rules.js`) re-implements what `core/schema-client.js#leaves` does (typed lists, `fields`, `field`) because the
  engine must not depend on overlay code. If a new list shape is added to the schema, both must learn it; `ci-parity.test.js` and the
  seeds notice when a rule goes blind.
* Picture pairs are derived: `src`/`image` pair with `alt`/`decorative`; any other picture `N` pairs with `NAlt`/`NDecorative`. A picture without
  a `decorative` switch (the share picture) is judged only if someone wrote a description. `check-content-rules` makes sure every picture field has a
  pair or an exemption in `scripts/alt-exemptions.json`, so a new picture field cannot slip past the rules.
* Only `block` findings can fail CI, and only when they are not in `baseline.json`. The baseline is empty today.

## The overlay side

* The gate on "Send for review" wraps `studio.drafts.submit` once (in `ext/checks.js`), because `core/drafts.js` and the Changes panel belong to the
  REVIEW unit. Every caller (command, palette, Changes, AI panel) goes through that property, so one wrapper covers all of them. A crash inside the
  check never blocks sending (CI still would).
* "Already on the live site": the engine also runs on the base content; a finding with the same key there is marked and never blocks the person.
* Findings are computed on the working copy, whose list positions can differ from the base (reordered sections). `data.ref` is in working
  coordinates; `S.panelFields.baseRef` converts it before `editRef`.
* The dock cannot grow without bound: wider than about 1150 px it wraps and the toast column used to cover it. Toasts now sit above the dock;
  phones lose the chip and the Check button from the dock (a test pins one row at 375 px) and get both inside All fields.
* All fields keeps the old form controls but builds them only for the rows a person opens (a row is a button with the label and the value,
  shortened). That keeps 200+ fields cheap and gives screen readers a list of names to scan.
* The palette's three sources read caches. The only request is `/v1/history?limit=5`, sent once when the palette opens by a signed-in person; a
  guard allows exactly that one call in `palette.js`.

## Shortcuts taken (and when to revisit)

* `facts.pages[route].images` is "every picture named anywhere in the data files" for `/` and "every picture in that page's own file" for pages.
  It over-counts for the home page (it includes pictures of hidden sections). Revisit when a founder meets a page-weight warning that surprises them.
* Heading-skip only reads markdown (`widget: markdown` and a page's `_body`); headings written into plain text fields are not headings.
* `duplicate-text` reports the later file in sorted order; it names the first. Revisit if founders ask which one to change.
* Ignoring is per device and per draft (`localStorage`). A person who switches device sees the warnings again; that is deliberate (nothing is stored on a server).
* The legend does not colour the kinds: the overlay draws one outline style, so the legend uses a small shape per kind. Real colours need a change in `inspect.js`.
* Browser tests build the whole site once (about 8 s) and serve it through `stub-server.js` (`siteDir`).
