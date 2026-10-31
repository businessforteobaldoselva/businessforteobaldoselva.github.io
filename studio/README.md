# COVERED Studio

Edit the site on the page itself: click a headline, change it, swap a photo, hide a section (also from a phone). Edits are staged in the browser and saved as ONE validated patch to a draft branch and pull request. History lists what went live and Restore opens an undo draft. The binding design is [DESIGN.md](DESIGN.md); the plain-English guide for people is [../docs/STUDIO-RUNBOOK.md](../docs/STUDIO-RUNBOOK.md); what an attacker could and could not do is [THREAT-MODEL.md](THREAT-MODEL.md).

```
 preview build (CMS_EDIT=1)                       API (one portable handler, 3 adapters)           GitHub
 +------------------------------+   Bearer JWT    +--------------------------------------+        +-------------------+
 | site + data-cms markers      | --------------> | validate (scope, pointers, fields,    | -----> | studio/* branch   |
 | /studio/overlay.js           |   JSON patch    |  images) -> serialise -> Git provider |        | draft pull request|
 |  edit, Changes, Sections,    | <-------------- |  roles: editor < approver < admin     | <----- | checks (CI)       |
 |  Fields, History, Help,      |   plain-English |  history + restore (revert draft)     |        | merge (approver)  |
 |  tour, Ctrl/Cmd+K palette    |   changes       +--------------------------------------+        +-------------------+
 +------------------------------+                    auth: Supabase JWT (local verify)   roles: Supabase table (RLS)
```

Production HTML is byte-identical: markers and the overlay exist only in builds with `CMS_EDIT=1`.

## Run it

```
npm run studio:dev        # local preview build + API + mock GitHub + dev sign-in, no accounts
npm run check             # everything, ends with check:studio
npm run check:selftest    # breaks the guards on purpose
npm run studio:e2e        # draft -> checks -> publish against a local git repository
```

## Unit D: History, onboarding, help, command palette

Owns (nothing else was touched except where noted):

| File | What |
|---|---|
| `overlay/ext/history.js` | History panel: merged changes, who and when, plain-English lines, Restore with confirmation, conflict handling, empty/loading/error states, pure view model |
| `overlay/ext/help.js` | Help panel ("?"): quick start, what the words mean, what this role can do, shortcuts, replay tour, build info |
| `overlay/ext/tour.js` | First-run tour (7 steps), anchored highlights, keyboard operable, remembered per user, replay |
| `overlay/ext/palette.js` | Ctrl/Cmd+K combobox, fuzzy search, synonyms, generated section/field commands |
| `overlay/ext/ext.css` | styles for the four (inside the overlay's shadow root) |
| `api/services/history-diff.js`, `api/services/history.js` | pure `invertDiff`; `createHistoryService({git, drafts, ...}).list/restore` |
| `guards/check-history.js`, `guards/selftest-d.js` | static rules, restore maths on real data, docs completeness; 12 selftest scenarios |
| `tests/ext/*.test.js` | node unit tests (view model, tour steps, palette search, invertDiff + restore service) and `browser.test.js` |
| `../docs/STUDIO-RUNBOOK.md`, `THREAT-MODEL.md`, this README | docs |

Browser tests (`tests/ext/browser.test.js`) drive Chrome with the keyboard only against a loopback stub (`tests/ext/harness/`) that implements the `window.CoveredStudio` contract. They need `puppeteer-core` and a Chrome or Edge binary, neither of which is a repository dependency, so the file skips itself when they are missing:

```
npm i --no-save puppeteer-core            # or: STUDIO_PUPPETEER_DIR=<folder whose node_modules has puppeteer-core>
CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node --test studio/tests/ext/browser.test.js
```

### What unit D needs from the overlay core (unit C), beyond DESIGN 10.2

Written as optional hooks; everything degrades gracefully when one is missing.

1. `studio.ui.root`: the overlay's shadow root, so the tour and palette mount their layers inside it. Without it they create their own shadow host, and take styles from `S.styles["ext/ext.css"]` if the bundler exposes that.
2. `ext/ext.css` must be part of the styles injected into that shadow root.
3. `studio.ui.listCommands()` (optional): the palette lists commands registered by C's own modules. Without it the palette knows only the commands registered after `ext/history.js` loads, plus its own static ones.
4. `studio.setMode("edit"|"browse")` (optional): the palette's "Toggle edit mode". Without it the palette emits `mode:request {mode}`.
5. `studio.auth.signOut()` (optional): the palette's "Sign out". Without it the palette opens the Account panel.
6. Stable `data-tour` / `data-panel-id` attributes on the panel launch buttons (`panel-sections`, `panel-changes`, `panel-history`, plus `save` and `pill`/`palette`) so the tour can highlight the real controls; otherwise a tour card is centred.
7. DOM tags used by unit D through `h()`: `div span p ul ol li h3 h4 button a strong input`. Props: `class id type role tabindex disabled placeholder title href target rel aria-* data-* on`, `autocomplete`, `spellcheck`.

## Deviations (unit D)

Recorded here because DESIGN.md must not be edited during the build.

* The task text asked for `studio/overlay/history.js` and `scripts/check-studio-history.js`. The contract (section 1 and 15) names `studio/overlay/ext/history.js` and `studio/guards/check-history.js`, and says `npm run check` reaches guards through `check:studio`. The contract names were used; no `package.json` edit was needed.
* The task said "do not touch API files", while the contract gives unit D `api/services/history.js` and `history-diff.js` (and `routes/history.js`). The two service files were written (pure, no framework). `routes/history.js` was NOT written: it depends on unit B's router, error and handler conventions, which are not in this branch. It is a thin wrapper: `GET /v1/history` calls `svc.list(user, token, {limit, cursor})`; `POST /v1/history/:pr/restore` calls `svc.restore(user, token, Number(pr), {onConflict, idempotencyKey})` and maps `HistoryError {status, code, message, details}` to the API error shape. The service expects `git.listMerged`, `git.getMergedPr`, `git.readTextFile` from the provider interface (8.1) and `drafts.createFromOps` (7.6).
* `history.js` (service) keeps its own copy of the three scope regular expressions because `validate/scope.js` does not exist in this branch. Replace them with the import when unit B lands.
* `describeOps` (the plain-English `Change` lines in History) is injected; without it History falls back to "Changed: Hero, About page" per file. Unit B's `describe.js` is the intended implementation.
* The tour has one exit, "Skip tour", which also remembers the choice (a separate "Don't show again" would duplicate it). Without usable storage the tour shows again next session.
* Seven tour steps (contract) rather than the five or six in the task text.
* The only "Restore" gate in the overlay is role (editor, approver, admin) and the server's `restorable` flag; the server enforces both again.
* Commands registered by `ext/history.js` onward are captured by wrapping `ui.registerCommand`; see item 3 above.

## Phase 5 (UI): "Describe a change"

The AI panel in the overlay (`studio/AI-DESIGN.md` section 14). It is a client of three routes that the CORE unit builds
(`GET /v1/ai/status`, `POST /v1/ai/propose`, `POST /v1/ai/accept`). Asking for a suggestion writes nothing; saving it goes through
the same server pipeline as a hand-made patch.

Owns (nothing else was touched except where noted in `studio/NOTES-ai-ui.md`):

| file | what |
|---|---|
| `studio/overlay/ext/ai-view.js` | PURE view model: one reducer (signedOut, loadingStatus, off, idle, working, result, saving, saved, error), default ticks, closure toggling, fixed plain-English copy, error code to copy, Delta to render plan, request bodies. No DOM, no network, no timers. Tested under node. |
| `studio/overlay/ext/ai.js` | the panel `ai` and four palette commands. Text nodes only (`h()` children), every server call through `studio.api`. |
| `studio/overlay/ext/ai.css` | styles inside the shadow root (own tokens, light and dark, contrast checked) |
| `studio/overlay/dev/ai-demo.js` | the deterministic demo and test double of the three routes (not the real validator) |
| `studio/guards/check-ai-overlay.js`, `selftest-ai-ui.js` | the guard and 20 selftest expectations (each guard rule is broken on purpose) |
| `studio/tests/ai-ui/` | view-model, panel-flow, a11y-dom, no-html, abuse and real-browser tests, plus `harness/` (a tiny DOM, a host stub, a fake of the routes built from `tests/fixtures/ai-proposals.sample.json`) |

Run it:

```
node studio/overlay/dev/stub-server.js --ai     # fixture page + API stub + the AI demo: http://127.0.0.1:8080/?studio=1, sign in as Molly
npm run studio:test                              # all guards and unit tests (includes studio/tests/ai-ui)
node scripts/selftest.js --only "studio AI UI"  # break each guard rule on purpose and watch it fail
STUDIO_PUPPETEER=<path to puppeteer-core> node --test studio/tests/ai-ui/browser.test.js   # real Chrome, keyboard only
```

In the demo, instruction keywords pick a canned scenario: plain text gives a three-change hero edit; "contact email" adds a
flagged change; "faq ... add" gives two dependent changes; "translate / welsh" gives the FAQ in Welsh; "code / font / autoplay"
gives the needs-code card; "make it better" gives a question. The Alt text, Meta description and Tone check tabs have scenarios too.
Test hooks: `stub.ai.status = "disabled" | "no_key" | "budget_exhausted"`, `stub.ai.next = <proposal>` (returned once), `stub.ai.delayMs`.
Once the CORE unit is merged the same panel talks to the real service: `STUDIO_AI_ENABLED=1 STUDIO_AI_PROVIDER=replay STUDIO_DEV=1 npm run studio:dev`.

What the panel guarantees (and the tests prove):

* The person sees BEFORE and AFTER for every change, with a non-colour cue (underline, strikethrough, and "[added]" / "[removed]" for screen readers). The BEFORE text comes from the server, never from the model.
* Changes flagged "outside what you asked about" or "changes where visitors go" start unticked, whatever the server says. Ticking a change ticks what it needs; unticking it unticks what needs it.
* Save sends exactly `{idempotencyKey, proposal:{id, instructionHash, instructionPreview, base, model, changes:[{id,title,ops}]}, accept:[ids], title}`. The ops go back exactly as received.
* Every string from the model or the server reaches the page as a text node: the test DOM throws on `innerHTML`, 12 hostile payloads (markup, script, `javascript:` links, forged envelope tags, bidi overrides, control characters, template syntax, `__proto__`, emoji) are put into every text field of every kind of proposal, and megabyte-sized strings and thousands of changes are cut.
* Errors show fixed copy and never the server's words. The kill switch and the daily allowance end in a plain "AI help is switched off" screen; the rest of Studio keeps working.
* "This needs a developer change" never writes anything: it drafts a request with Copy and an Open Ask Claude link.

## Deviations (UI, Phase 5)

See `studio/NOTES-ai-ui.md`.

## Journey (end-to-end, on this machine)

`npm run check:studio-e2e` (full: `node studio/e2e/journey.js`) plays the whole product once, loopback only:

1. copies the working tree into a real git repository that stands in for GitHub (LOCAL git provider keeps branches and pull requests in it);
2. runs the real API handler on a Node http server with the dev auth stub (`STUDIO_DEV=1`, localhost only) and serves a real `CMS_EDIT=1` build of that repository;
3. headless Chrome (puppeteer-core) signs in as an editor, edits the hero headline, replaces a photo and its description, hides a section and saves ONE draft;
4. asserts on the git side that the draft touches exactly the right JSON files and the new picture, that the pull request body is plain English, that the draft branch BUILDS and passes the repository guards (all of them without `--quick`, plus the scope guard), and that publishing lands only those files on main;
5. as an approver opens History, presses Restore, and asserts the revert draft undoes exactly those files and also builds and passes the guards.

`--quick` runs only check:cms, check:copy and check:images on each draft (it still builds them); `--keep` leaves the temp folder. Without puppeteer-core and Chrome/Edge (`STUDIO_PUPPETEER`, `STUDIO_CHROME`) it prints SKIPPED and exits 0 (`--require-browser` makes that a failure).

It is NOT in CI (`site-checks.yml` is unchanged): puppeteer-core is deliberately not a repository dependency (no heavy dependency for a developer-machine check), and the run takes several minutes because every draft is built and guarded. The browser tests under `studio/tests/overlay` and `studio/tests/ext` follow the same rule: they skip themselves when puppeteer-core or Chrome is missing, so CI runs the node tests and guards only.

### AI journey (Phase 5)

`npm run studio:ai-journey` (`node studio/e2e/ai-journey.js [--quick] [--keep]`) is the same set-up with "Describe a change" switched on and the AI provider replaced by recorded answers (no key, no network). In headless Chrome: Molly asks "make the hero shorter and warmer", sees Before and After for three changes, unticks one and saves; the draft branch must hold exactly the two accepted ops and nothing else, build, and pass every repository guard plus studio-scope; an Editor is refused when publishing, Amelia publishes; History > Restore puts the old data back exactly. Then the discard path (nothing written), the needs-code path (a ready-to-send Ask Claude request, nothing saved) and two hostile model outputs (markup in a value; a CI workflow as the target), each a plain refusal with no draft and no change to main. Like the journey above it is not in CI and skips without puppeteer-core and Chrome.

## One-time setup for Teo

See the runbook, Part 2. Summary of DESIGN.md section 17: create the GitHub App (Contents RW, Pull requests RW, Metadata R, plus Checks R and Commit statuses R), protect `main` (checks `Build and guards` and `studio-scope`), create the Supabase project and apply `sql/001_studio_roles.sql` yourself, deploy one API adapter with the environment variables, deploy `login/`, set `STUDIO_API_URL` and `STUDIO_APP_URL` for Deploy Previews, add people, then run the checks and the walkthrough locally before trusting a hosted setup.

## Phase 5 (CORE): AI help, server side

"Describe a change": a model proposes a JSON patch, Studio treats it as hostile input, shows BEFORE/AFTER, and the person saves some or all of it as an ordinary draft. Data only: it can never change code, templates, configuration, CI or pictures. Default OFF (`STUDIO_AI_ENABLED`).

* Map, commands and how to add a fixture: `studio/AI-README.md`. Contract: `studio/AI-DESIGN.md`. Deviations: `studio/NOTES-ai-core.md`.
* Threat model: `studio/THREAT-MODEL.md`, section "AI layer". Runbook for Teo (key, cost, switches): `docs/STUDIO-RUNBOOK.md`, step 4b.
* `npm run studio:ai-eval` (part of `npm run check`): 63 recorded model answers, 25 valid patches and 33 hostile or failing ones, through the real API; every valid one is undone by History > Restore byte for byte.
* `studio/guards/check-ai.js` (part of `check:studio`) and 19 scenarios in `studio/guards/selftest-ai-core.js` that break it on purpose.
* Try it on your machine without a key: `STUDIO_AI_ENABLED=1 npm run studio:dev` (a replay stand-in that knows the sample requests).
