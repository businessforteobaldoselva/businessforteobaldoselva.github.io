# Phase 1 BACKEND: notes for the integrator

Branch `sl/backend` (off `sl/design`). Contract: `PHASE1-DESIGN.md` sections 4, 10, 15. The README heading BACKEND has what was built and the numbered Deviations; this file is the checklist for merging it with the other units.

## What REVIEW and EDIT can rely on

* `git.requestReviewers(prNumber, logins[]) -> { requested }` exists on all three providers (memory, GitHub, local-git); it throws `GitError` (`bad_request` for a malformed login, `conflict`/`upstream` when GitHub refuses). Test hooks: memory `repo.failReviewers = "<code>"`, mock GitHub `server.state.failReviewers = <http status>`.
* `Pr.labelsApplied` (boolean) and `Pr.labels` that always include `studio-draft` for a Studio draft, even when GitHub never stored the label. `services/drafts.js` therefore needs no change to keep finding drafts. Test hooks: memory `repo.failLabels = true`, mock GitHub `server.state.failLabels = 403`.
* `service_unavailable` (503, `details.service = "auth"`) for a role lookup or signing-key fetch that fails. The overlay's `api-client` should map it to the sentence in `PHASE1-DESIGN.md` 4.2.
* `GET /v1/health`, `POST /v1/ai/estimate`, `GET /v1/ai/recent`, `proposal.meter` (also `error.details.meter` on a rejected answer), `GET /v1/ai/status` `usage.{tokensToday,tokensLimit,pctOfDay,store}`.
* The API's AI service object now also has `estimate(ctx, body)`, `recent(ctx)`, `health()`.

## Merge notes

* `scripts/selftest.js` loads `studio/guards/selftest-p1-backend.js` by name pattern; nothing to register. 25 expectations, about one minute.
* Tests and guard files that other code had to change because the budget became async: `studio/guards/check-ai.js` (D1 route count 5, D8), `studio/guards/selftest-ai-core.js` (anchor text of the "budget reservation removed" scenario), `studio/tests/ai/routes.test.js`. If REVIEW or EDIT add AI tests that call `_budget.snapshot(...)`, they must `await` it and read `.global`.
* `studio/tests/fixtures/providers.js` passes an optional `onLabelFailure` to the GitHub provider; `studio/dev/mock-github-server.js` gained `head.repo`/`base.repo` (so `fromFork` is correct over the mock), `failLabels`, `failReviewers` and the requested-reviewers route.
* The sign-in page (`studio/login`) is a separate static deploy: redeploy it after merging, as well as the API.

## Plan items 2 and 3 (verified, not re-fixed)

* Item 2, the content fixture: `studio/tests/markers/schema.test.js` only checks that `content.sample.json` names real data files. The selftest scenario "three ordinary publishes ..." applies a headline change, a hidden section and an alt-text change to a copy and runs the tests that read live content; its control re-pins the fixture and must fail.
* Item 3, `studio-scope`: `.github/workflows/studio-scope.yml` copies the guard, `validate/scope.js` and `scripts/lib/image-rules.js` from main. `tests/ci/scope-workflow.test.js` (existing) checks the copy list against the guard's requires; the new `tests/p1-backend/scope-guard-behaviour.test.js` executes the workflow's own copy lines in a throwaway git repository and judges pull requests (content passes; editing `check-scope.js` or `validate/scope.js` is judged, not crashed; deleting a non-image fails; never `MODULE_NOT_FOUND`). Selftest: a guard that requires an uncopied module, and a workflow with the image-rules line removed, both fail.
* Item 4, keep-alive: `tests/p1-backend/reviewers-and-ops.test.js` asserts the cron trigger in `wrangler.example.toml`.

## Not done / not checked

* `003_studio_ai_usage.sql` has not been run on a real PostgreSQL. Its behaviour is modelled in `tests/p1-backend/fake-postgrest.js` and its safety properties are checked as text. A human must read it before applying (the header says so).
* No real Supabase, GitHub or Cloudflare was contacted. The 20-codes-in-60-seconds e-mail check and "Restore project" are manual (runbook 4c.1).
* The overlay does not use any of the new routes yet (EDIT's units).
