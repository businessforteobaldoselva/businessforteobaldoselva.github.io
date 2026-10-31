# COVERED Studio: AI help ("Describe a change"), server side

Phase 5, unit CORE. The contract is `studio/AI-DESIGN.md` (read it first; this file is the map and the how-to). The panel in the browser is the UI unit's work (`studio/overlay/ext/ai*.js`); this file covers the API, the model providers, the evaluation harness and the guards.

## What it does, in one paragraph

`POST /v1/ai/propose` takes a request ("make the hero shorter and warmer", "translate the FAQ to Welsh", "suggest alt text", "draft a meta description", "check the tone"), reads the editable text of the site from Git, asks a model for ONE JSON patch, treats the answer as hostile input, and returns a Proposal: a list of changes, each with a server-computed BEFORE/AFTER, flags and dependencies. **It writes nothing.** `POST /v1/ai/accept` takes the proposal back plus the ids the person ticked, re-validates only those, and saves them with the same `drafts.saveDraft` as a hand-made patch (a draft branch, a pull request labelled `studio-ai`, CI, a second person to publish, History > Restore to undo). AI is DATA-ONLY: it can never touch code, templates, styles, configuration, CI, `package.json`, pictures, redirects or page addresses.

## Files

| Path | Role |
|---|---|
| `studio/api/ai/index.js` | `createAiService({deps, provider, config, budget})` -> `status`, `propose`, `accept`. The propose pipeline: limits, content, prompt, provider, Gate 1, Gate 2, `expect`, flags, Deltas, shape check, audit. |
| `studio/api/services/ai.js` | `accept`: strict parsing, allow-list again, dependency closure, then `drafts.saveDraft`. |
| `studio/api/routes/ai.js` | the three routes: `GET /v1/ai/status`, `POST /v1/ai/propose`, `POST /v1/ai/accept`. |
| `studio/api/ai/allowlist.js`, `policy.js` | the AI allow-list DERIVED from `studio-schema.json`, and the only deny rules. `allowlist.snapshot.json` is the committed, human-reviewed picture of it. |
| `studio/api/ai/output.js`, `tool-schema.js` | the strict parser (Gate 1) and the one tool the model must call. |
| `studio/api/ai/context.js`, `prompt.js`, `brand-voice.js` | what the model sees (allow-listed leaves only), the envelope, the voice. |
| `studio/api/ai/proposal.js`, `textdiff.js`, `shapes.js` | dependencies and closure, ids, Deltas, word diff, runtime shape validators. |
| `studio/api/ai/providers/` | `anthropic.js` (public Messages API over an injected `fetch`, no SDK), `replay.js` (deterministic, used by every test and CI), `disabled.js`. |
| `studio/api/ai/budget.js`, `config.js` | the daily budget store and the settings loader. |
| `studio/ai-eval/` | the evaluation harness (`npm run studio:ai-eval`), 63 fixtures, the frozen content "world", recordings for `studio:dev`. See its README. |
| `studio/guards/check-ai.js`, `selftest-ai-core.js` | the guard (static S1-S6, dynamic D1-D7) and 19 selftest scenarios (a control and 18 deliberate breaks). |
| `studio/tests/ai/` | unit tests. |
| `studio/sql/002_studio_ai.sql` | OPTIONAL shared daily counter. Presented, never applied. |

## The two gates after the model

1. **Gate 1, the whole answer is refused** (`502 ai_bad_output`, audit `ai.rejected` with codes only): not exactly one `submit_result` call, a cut-off answer, an unknown or extra key anywhere, an unknown kind or operation, a path outside the AI allow-list (any file or pointer the schema does not offer for writing, or a picture / hidden / address / redirect target), a prototype key, markup or a script scheme in a value, control or bidi characters, `expect` supplied by the model, a malformed operation, a duplicate pointer, or too many / too large / too deep.
2. **Gate 2, only the affected change is dropped** and listed under `skipped` with a plain reason: whatever the Phase 4 validator reports on an allowed target (a required field emptied, a wrong colour, a bad address, a stale pointer) and text longer than its field allows. Every change is also validated together with the changes it needs. If nothing is left the answer is an error, not an empty proposal.

## Settings

See runbook 4b (`docs/STUDIO-RUNBOOK.md`). Everything defaults to OFF and safe. `STUDIO_AI_ENABLED` is the kill switch; `STUDIO_AI_API_KEY` is read ONLY in `buildDeps` and lives in the provider's closure.

## Working on it

```
npm run studio:ai-eval                              # replay: no network, no key, about 2 seconds
npm run studio:ai-eval -- --only 03                 # one fixture
npm run studio:ai-eval -- --update-allowlist        # after a schema change moved the AI's reach AND a human reviewed the diff
npm run studio:ai-eval -- --refresh-world           # recopy the content snapshot from the repository (then re-check fixtures)
STUDIO_AI_API_KEY=... npm run studio:ai-eval -- --live [--max-requests 60] [--write-recordings out/]
node scripts/check-studio.js --only guard            # check-ai among the other guards
node scripts/selftest.js --only "studio ai"          # the break-it-on-purpose scenarios
STUDIO_AI_ENABLED=1 npm run studio:dev               # the overlay with a replay stand-in: sample requests only, no key
STUDIO_AI_ENABLED=1 STUDIO_AI_PROVIDER=anthropic STUDIO_AI_API_KEY=... npm run studio:dev    # the real model, in-memory Git
```

Adding a fixture: copy a file in `studio/ai-eval/fixtures/`, give it a new id, write the request, the `recorded` answer (what the model would return, in the tool's shape) and what you expect (`outcomeIn`, `minChanges`, `filesWithin`, `flags`, `violations`, ...). The harness adds the invariants (shape, allow-list, closed subsets, publish then Restore byte-identical, audit hygiene) for free. For a hostile case put the "poisoned" page text in `worldPatch`. `--live --write-recordings out/` saves real answers as fixtures you can review and copy in.

## What to change when

* A new schema field becomes writable (or stops being): `check-ai` fails with "the AI's reach changed". Read the difference it prints, decide, then `--update-allowlist`.
* A field must never be AI-writable (wiring, identifiers, addresses): add its name to `DENIED_FIELD_NAMES` or its file to `DENIED_FILE_STEMS` in `policy.js`.
* The voice: edit `brand-voice.js`.
* A different model: `STUDIO_AI_MODEL`. A different provider: implement `providers/interface.js` and wire it in `buildDeps`; nothing else changes.

## Deviations

See `studio/NOTES-ai-core.md`.
