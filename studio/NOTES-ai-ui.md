# Phase 5 UI: notes and deviations

Unit: UI ("Describe a change" panel). Contract: `studio/AI-DESIGN.md` section 14, 17.3, 18. Everything below is a decision where
the contract was silent, tight or wrong. The integrator folds these back into the design.

## Deviations from the contract

1. **No dock button below 460 px; an entry in Changes instead.** The phone dock holds exactly seven buttons at 390 px (the Edit
   pill plus six panels), and any eighth wraps to a second row that the bottom sheet then overlaps (the existing phone test
   "sheet sits above the dock" caught it). `ext/ai.css` hides `.dock-btn[data-panel-id="ai"]` below 460 px and
   `ui/panel-changes.js` gets one small button, "Or describe a change in words", shown whenever the `ai` panel is registered. On
   wider screens the dock button is there. The command palette entry works everywhere. (Edit to a file outside the contract's list:
   `studio/overlay/ui/panel-changes.js`, 4 lines.)
2. **Script budget 330 KiB (the maximum the design allows), style budget 48 KiB.** The panel is 64.2 KiB of script and 9.0 KiB
   of styles (the design estimated about 35 KiB of headroom for it). The bundle is at 329.6 of 330 KiB. To stay inside: the optional
   unsent-instruction draft in sessionStorage and the "Site-wide change" proposal badge were dropped, copy was tightened and
   helpers were shared. `check-ai-overlay.js` fails if anyone raises the budgets past 330 / 48. Anything added to the overlay
   later must come out of something else or the design must raise the cap.
3. **No `<blockquote>`, no `dir` attribute.** `core/dom.js` `h()` allows neither. Tone quotes are `<p class="csx-ai-quote">`;
   right-to-left text is handled by `unicode-bidi: plaintext` in `ai.css` (a guard rule requires it) and tested with Arabic and
   Hebrew in a real browser.
4. **Cancel does not abort the HTTP request.** `core/api-client.js` has no per-call `signal`; the design says "if supported, else
   ignores the response". The panel ignores the late answer (a request counter), the server may still finish and charge the call.
   The api client's fixed 30 s timeout is longer than the server's 25 s propose deadline, so it does not cut a valid answer.
5. **The tone verdict word is derived.** The Proposal shape (5.4) has no `overall` field although 14.4 asks for a verdict word.
   The panel uses `overall` when the server sends one (`on_brand`, `mostly`, `off_brand`) and otherwise says "On brand" with no
   findings, "Mostly on brand" with one or two, "Off brand" with more. CORE should add `overall` to the Proposal so the model's
   own judgement is shown. One line in `shapes.js` and the service.
6. **"Show on the page" selects and scrolls to the element** (`studio.inspect.select(marker, {scroll})`) instead of calling
   `studio.ui.editRef(ref)`, because `editRef` also switches editing on and opens the editor, which is not "show me".
7. **Demo mode is the overlay stub server, not `studio:dev`.** `studio/overlay/dev/ai-demo.js` speaks the three routes with the
   sample shapes and canned scenarios, so the panel can be driven in Chrome now (`node studio/overlay/dev/stub-server.js --ai`). It
   is deliberately not a second validator. The joint drive against CORE's replay provider (`npm run studio:dev` with
   `STUDIO_AI_ENABLED=1 STUDIO_AI_PROVIDER=replay STUDIO_DEV=1`) is for the integrator, using the same panel.
8. **The overlay stub server checks `expect` step by step** (each op against the document as the earlier ops left it), like the
   real server must for dependent changes (add an FAQ item, then edit it), and its draft creation was extracted into
   `commitDraft` so the demo's accept route can reuse the exact code path of `POST /v1/drafts`. All earlier overlay tests still pass.
9. **Status `usage` is not shown.** The panel does not display the remaining allowance; it only reacts to `enabled` and `reason`.

## Things the integrator should know

* **Contract checks the panel makes about the CORE responses** (so CORE can keep them true): a Delta's `diff` is used only if
  its `same+del` segments rebuild `before.text` and its `same+ins` segments rebuild `after.text`, otherwise the plain BEFORE and AFTER
  are shown; `requires` ids that do not exist are dropped; at most 40 changes, 20 deltas per change and 20 fields per `fields`
  value are rendered; a change whose `id` is not `[A-Za-z0-9_-]{1,16}` is not offered; `422` problems are matched to cards by
  `file` + `path` (or `from`) of any op, and a problem on `/accept` or with no file becomes a general message.
* The panel never sends page content. The propose body is `{idempotencyKey, mode, instruction?, context?{refs?, page?, scope?},
  draftId?, retryOf?, feedback?}` and nothing else (a test fixes this).
* `retryOf` is sent with `feedback` for "Ask for another try" and for answering a clarify question (the original instruction is
  sent again). Answers to clarify questions are limited to 300 characters because they travel as `feedback`.
* Pre-existing, not touched: `History` registers an empty state for the Changes panel as a function that RETURNS an element, but
  `panel-changes.js` calls it and ignores the result (so the empty-state text never shows). Two tests of
  `studio/tests/overlay/browser.test.js` ("everything at once", "link editor") fail on this machine on the unchanged design branch too
  (a 30 s timeout and a link-helper assertion); they are not related to Phase 5.

## What was not done

* No run against the real CORE routes (CORE is a parallel unit). The panel, its fakes and the demo follow `AI-DESIGN.md` section 5
  and `tests/fixtures/ai-proposals.sample.json`; the fixtures are the shared anchor.
* No physical phone. The 375 px, 390 px and 700 px layouts, touch target sizes and contrast (light and dark) are measured in
  headless Chrome.
* No screen reader run. The structure is tested (names, groups, headings, live regions, focus moves); a human with VoiceOver or
  NVDA should listen to one full pass before this is announced to the team.
