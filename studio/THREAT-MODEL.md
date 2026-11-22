# COVERED Studio: threat model

Scope: Studio as specified in `studio/DESIGN.md` (overlay on preview builds, the data-patch API, the GitHub and Supabase providers, History/Restore). Written by the unit that built History, onboarding and the palette; it covers the whole system because the History/Restore feature touches all of it. The "Evidence" column names the automated check that fails when a defence stops working. Evidence owned by the other Studio units (validator, API, overlay core, markers) is the evidence the design contract requires of them; re-confirm each line when the units are integrated. Anything that depends on the real GitHub, Supabase or Netlify settings can only be confirmed once those are connected (runbook, "Before you trust it").

The security promise, unchanged from phases 1 to 3: **an editor, a stolen editor session or a hostile page cannot break or attack the site.** Studio adds a new way to change the site, so this document asks what that new way allows.

## Assets

1. The live website (what visitors see and load): HTML, CSS, scripts, forms, links, images.
2. The repository, above all `main`, and everything that is not content: templates, scripts, CI, configuration, `package.json`.
3. The GitHub App private key (can write to the repository inside its permissions).
4. Supabase project: user accounts, the roles table, the audit table.
5. People's sessions (a bearer token, valid about an hour).
6. The trust of the founders: what the History list says about who changed what.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|---|---|---|
| Browser to API | the API's checks | everything in the request: token claims about identity are verified, bodies, headers, origins |
| Overlay to page | the overlay's code | text from the page, from the server and from editors (all of it is data) |
| API to Git | the API's validation | patches (validated twice more: by the scope rule inside every Git provider, and by CI) |
| Git to the live site | branch protection plus CI | anything on a `studio/` branch |
| Supabase to API | signature, issuer, audience, expiry | token contents beyond identity; metadata fields are never used for permission |
| Preview page to login page | exact origin allow rule on both sides | any other page that opens or embeds the login popup |

## What an attacker gets, by starting point

| Starting point | What they can do | What they cannot do |
|---|---|---|
| A visitor of the live site | Nothing new. The live HTML contains no Studio marker, overlay or path (tested: parity check; production HTML is byte-identical) | Reach the API with a useful identity |
| A visitor of a preview | Read what a preview already shows. The overlay does nothing without `?studio=1` | Edit; the API needs a signed-in, invited, active person |
| A hostile page on a preview address that matches the template (a deploy preview of a fork pull request) | Nothing: the login page asks the API whether the pull request behind the address is open and in this repository; forks get no token. The runbook also tells the owner to switch off fork deploy previews | Receive the bearer token by `postMessage`; call the API with one |
| A hostile website the founder visits while signed in | Nothing. No cookies are used, the token is held in memory of the page only, the API accepts only `Authorization: Bearer`, JSON content type (forces a preflight) and exact-origin CORS (tested) | Make the browser send the token or call the API from their origin |
| A stolen **editor** token | For up to an hour: save, discard and restore drafts of that editor, inside the data scope, under rate limits | Publish; read other people's drafts; touch any non-content path; keep access after `active=false` (checked on every request, cached 30 seconds) |
| A stolen **approver** token | As above, plus publish drafts that already passed CI and were written by someone else | Publish their own draft (four-eyes, by default); publish anything that fails CI; change code or configuration |
| A stolen **admin** token | As approver, plus add or deactivate people | Demote or deactivate the last admin; change code or configuration; read the GitHub App key |
| A malicious or compromised editor | Write bad content into allowed fields. Every value must satisfy the same rules as the content editor: patterns, lengths, links (`safeUrl`), colours, anchors, redirects, images (type, size, EXIF location data, SVG rules) (tested) | Add script, markup or code paths: templates escape by construction and only two known filters emit HTML; scope rules refuse every other file |
| Someone who steals the GitHub App key | Whatever the App is allowed on this one repository: write branches and pull requests. They bypass Studio's validation | Merge without the required checks or reviews (branch protection applies to the App); push to `main` directly |
| An attacker with the Supabase anon key | Nothing the key was not already meant to allow (it is public); row-level security limits the roles table to the person's own row or active admins | Read others' roles, or write without being an active admin |

## Threats and how they are met

| # | Threat | Defence | Evidence |
|---|---|---|---|
| T1 | A patch changes code, CI, config or packages | One scope definition (`validate/scope.js`) used by the validator, by every Git provider (a write method called with `main`, a workflow path or `package.json` throws) and by CI on every `studio/` pull request (`studio-scope`) | contract and scope tests; selftest breaks scope on purpose |
| T2 | A patch smuggles markup or script via a field | Server-side validation against the schema generated from the CMS config, then the build and all guards in CI; templates are safe by construction | validator parity test (30 mutated files agree with `check:cms`); CI |
| T3 | Path tricks: `..`, `%2e`, backslashes, names that differ only by capital letters from an existing picture, Windows device names (`con`, `nul`, `com1`) | Exact-match grammar on the normalised path; uploads are new files under `images/` only; existing files are never overwritten; a name equal to an existing picture ignoring case, or a Windows device name, is refused; CI refuses both in `images/` too. Files are written as plain blobs (mode 100644), never as links | validator tests; `check:images`; selftest |
| T4 | Hostile image: SVG with script or outside reference (including namespaced `<x:script>`, CSS escapes, `image-set()`, character references), photo with a GPS position (Exif in any segment, XMP, PNG `eXIf`, WebP `EXIF`/`XMP `, AVIF), wrong type, decompression bomb | The same rules as the image guard (`scripts/lib/image-rules.js`), magic bytes against extension against content type, 4 MB and 8000 px caps; metadata that cannot be read is treated as location data; overlay re-encodes (which also strips EXIF). The SVG rules hold without the Netlify `/images/*.svg` CSP header, which stays as a second layer | image tests; `check:images`; selftest |
| T5 | XSS in the overlay: server or editor text becomes markup | One element factory (`h()`), text only through text nodes, banned list enforced statically (`innerHTML`, `eval`, `createElement`, string timers, third-party hosts and others). The History, Help, tour and palette files are held to the same list and the same tag and property allow-list | `check-history.js`, `check-overlay.js`; browser test with a hostile PR title and author name that stay text |
| T6 | Third-party code or CDN in the overlay | No external host allowed anywhere; `fetch` is banned in the History/Help/tour/palette files (all network goes through the one API client) | static guards |
| T7 | Cross-site request forgery | Bearer header only, no cookie is read or set, JSON-only writes, exact-origin allow list, no wildcard, no credentials mode | CORS and CSRF tests |
| T8 | A forged or replayed token | Local verification: signature (algorithm chosen by configuration, never by the token), issuer, audience, role claim, expiry, subject; the database role is the only source of permission | auth tests with generated HS256, RS256 and ES256 vectors, `alg: none`, wrong audience, expired |
| T9 | The development sign-in reaches production | It throws unless the dev flag is set, the environment is not production, the host is localhost and no real secret is configured; checked on every request, and start-up refuses the combination | auth-dev and config tests; selftest |
| T10 | Privilege escalation: editor publishes, someone edits their own role | Roles looked up on every request; publish needs approver and a different author; people routes need admin; the last admin cannot be removed | handler tests |
| T11 | Restore used as a back door (revert PR carries more than the original) | Restore computes the inverse of the original pointer-level change only, and passes it to the same draft pipeline as any save: same validation, same studio/ branch, same CI, same approver. The restore code holds no Git write method (checked statically) and cannot reach `main` | `invert-diff` tests (400 random round trips and real data files), `check-history.js` |
| T12 | Restore silently overwrites later work | Every inverse operation carries the value it expects to find; if current `main` differs, the restore stops with a conflict (or, when the person agrees, restores only the parts still unchanged) | restore tests |
| T13 | A forged author in History | The `studio:v1` marker in a pull request is parsed strictly and only changes the display name; it grants nothing. A person who can open pull requests can already write any text there. Restore authority comes from the role of the caller, not from the marker | marker tests |
| T14 | Race: a push between "checks passed" and "merge" | Merge is requested with the exact head commit the approver saw; GitHub refuses if it moved | publish gate tests |
| T15 | Abuse and brute force | Per-IP limits before authentication, tighter limits on failed authentication, per-user limits on writes, publish, restore and admin | rate-limit tests (best effort on serverless hosts: limits are per instance) |
| T16 | Secrets in logs or files | Logger redacts keys matching key, secret, token, authorization, pepper. Audit entries never carry values, tokens or bodies. No secret is committed; tests generate their own keys | audit tests; repo review |
| T17 | Oversized or malicious bodies, ReDoS | Body size cap before parsing, JSON depth cap, string length checked before any regular expression runs | validator tests |
| T18 | Production site changed by Studio code shipping | The shortcode returns nothing and no file or tag is added unless `CMS_EDIT=1`; `netlify.toml` forces it empty for Production | parity test: normal build byte-identical, edit build differs only by marker attributes and one script tag |
| T19 | Login popup abused to phish or leak the token | The login page posts the token only to an origin that passes the same allow rule as the API; the overlay accepts messages only from the login page's origin; the token lives in memory | broker tests |
| T20 | Onboarding or palette runs an action by surprise | Palette commands are fixed code, never text from the server; destructive ones (discard, publish, restore) ask for a confirmation; commands the role cannot use are not offered, and the server enforces the role anyway | browser tests (keyboard-only) |

## Residual risks (accepted, with the reason)

1. **Content abuse by an invited person.** A trusted editor can write misleading words or pick an unflattering photo. The four-eyes review and the plain-English change list are the control. Technical limits cannot judge meaning.
2. **Approver and editor collusion, or one person with both roles using two accounts.** Four-eyes assumes people are distinct. Keep the approver list short and review the audit log.
3. **GitHub App key theft.** The App can write branches and open pull requests. Branch protection and required checks stop it reaching `main`, but only if you set them (runbook step 2). Rotate the key if in doubt.
4. **In-memory rate limits on serverless hosts** are per instance, so an attacker spreading across instances gets more attempts. They are a brake, not a wall; Supabase also limits sign-in attempts.
5. **Token lifetime.** A stolen token works until it expires (about an hour) unless the person is deactivated, which takes effect within 30 seconds.
6. **Supabase and GitHub availability and their own security.** Studio inherits them. If either is down, Studio stops and the live site is unaffected.
7. **Preview exposure.** Preview builds contain the overlay file and a copy of the site's content data. They carry nothing that is not already public content, but preview addresses should still be kept for the team (the 401 on previews today is a feature to keep, not a bug to remove blindly).
8. **A bug in the scope or validation code.** That is why there are three independent gates (validator, Git provider, CI) and branch protection behind them, and why selftest breaks each gate on purpose to prove it still fires.
9. **Browser-side limits.** The overlay uses the browser's own security. A founder's compromised browser or extension can act as that founder.

## Operating rules that keep this model true

* Never set `CMS_EDIT` on Production; never set `STUDIO_DEV` outside a laptop.
* Never grant the GitHub App more than the permissions in the runbook; never give Studio the Supabase service-role key.
* Keep `main` protected with the two required checks.
* Review `studio/sql/001_studio_roles.sql` yourself before applying it.
* Keep `STUDIO_ALLOW_SELF_PUBLISH` off.
* When Studio and the content editor change, re-run `npm run check` and `npm run check:selftest`: the guards exist to notice drift.

## AI layer ("Describe a change", phase 5)

Scope: `studio/AI-DESIGN.md`. A founder types a request; a model proposes a JSON patch; the person reviews BEFORE/AFTER and saves some or all of it as an ordinary draft. The AI layer adds ONE new thing to the system, a text-producing outsider whose output looks like an editor's request. The promise is unchanged: **model output has no more power than a hostile editor**, and an editor's reach is already limited by the validator, the Git scope guard, CI, branch protection and four-eyes publishing.

### New assets

1. The Anthropic API key (can spend money on the account, nothing else).
2. The daily AI allowance (money and availability).
3. Page text and, in alt-text mode, pictures, which leave the site towards the provider.
4. The trust of a reviewer who sees "AI suggested this" and may tick too quickly.

### New trust boundary

| Boundary | Trusted side | Untrusted side |
|---|---|---|
| API to model provider | the request Studio builds from Git | the answer: every byte of it, including its "explanations" |
| Page content to prompt | the allow-listed leaves chosen by code | the text of those leaves (editors, uploads and old content can all carry instructions) |
| Instruction to prompt | the person's identity | the instruction text (data, not a command) |

### Threats and how they are met

| # | Threat | Control | Proof |
|---|---|---|---|
| A1 | The model, or page text steering it, names a file outside the data layer (a workflow, a template, `package.json`, the CMS configuration, Studio's own code) | The AI allow-list is derived from the generated schema and enforced in code before anything else uses the answer. One out-of-scope path rejects the WHOLE answer. The Git provider's scope guard and CI sit behind it | fixtures A02, A03 (five files), A10, A15; `check-ai` D2 and its snapshot; selftest scenarios 1, 10, 18 |
| A2 | Prompt injection in page text, in the instruction or in the feedback box | Not defended by wording. Content is data inside a per-request nonce envelope in which `<`, `>` and `&` are escaped, so nothing can close it. Whatever the model then does still passes the allow-list and the validator. Instruction-like page text raises a visible warning and an audit entry | `check-ai` D5; fixtures A01, A02, A15 |
| A3 | A fooled model changes a link or the contact email (the realistic attack) | Allowed, because an editor may change them by hand, but flagged "changes where visitors go" and "outside what you asked", unticked by default, shown BEFORE/AFTER, then CI and a second person | fixtures A01, 07; selftest scenario 13 |
| A4 | Prototype pollution, traversal, encoded paths, bidi/NUL tricks, markup, `javascript:`/`data:` addresses, unknown operations, extra fields, invented `expect` values | A strict parser with a closed vocabulary; every key at every level checked; values may not contain markup or script schemes (the site's own `<br />` aside); the model supplies no `expect`, ids or "before" text | fixtures A04 to A16; `output-parse.test` (62 cases); selftest 2, 3, 4 |
| A5 | Oversized, deeply nested or endless answers; cost bombs | Output token cap, total deadline with at most 3 attempts, size and node and depth caps, change and op caps, per-person and global rate limits, daily request and token budgets, body caps, kill switch | `check-ai` D6; fixtures A07, A14; `providers.test`; selftest 7 |
| A6 | The API key leaks (config, logs, errors, responses, audit, browser) | The key is read once in `buildDeps` and lives in a closure inside the Anthropic provider; it is not in the configuration object; the provider has no logging; its errors carry only a status and an error type; the overlay never contains the key's name or the provider's host | `check-ai` S1, S2, S6 and D3 (a canary key); selftest 6 |
| A7 | Instruction text ends up in logs | The audit entry holds a salted hash, counts, model, token counts and outcome codes. Only an ACCEPTED draft shows a 200 character, escaped preview in the pull request body, because the person chose to save it | eval invariant; selftest 14 |
| A8 | A person uses `/v1/ai/accept` as a side door | It re-applies the allow-list and the value rules, recomputes dependencies, and then calls the same `drafts.saveDraft` as a hand-made patch (same validator, `expect`, base-moved check, scope guard, CI, labels). The same role rules apply | `accept-flow.test`; `check-ai` S5; selftest 9, 11 |
| A9 | Half of a change set is applied and breaks the page | The server computes which changes need which (list positions, overlapping paths) and refuses an incomplete selection; the harness proves every closed subset of every proposal validates and gives the same values | eval invariant 4; selftest 11 |
| A10 | A model message is rendered as HTML in the panel | Model text is capped, stripped of angle brackets, and rendered by the overlay as text only (unit UI); BEFORE/AFTER come from the server's own dry run, never from the model | shapes; eval; UI guard |
| A11 | The feature is on when nobody wants it | Default off. Off means the provider is never constructed, never called, both routes answer 503, and status says why | `check-ai` D4; selftest 5 |

### Residual risks (accepted, with the reason)

1. **A persuasive but wrong edit inside the allow-list.** A model can write a fluent sentence that is subtly untrue ("we have 20 machines"). Controls: the person reviews BEFORE/AFTER, CI, a different person publishes, History Restore undoes it in one step. Nothing in code can judge truth.
2. **The reviewer ticks everything.** Flags and unticked defaults help; they do not force attention.
3. **Cost abuse by a valid editor.** Bounded by per-person and global limits and the daily budget, which are in memory per running copy of the API on a serverless host, so the real ceiling is the limit times the number of copies. The Anthropic spend limit is the hard stop; set it (runbook 4b).
4. **Data sent to the provider.** Site text, and in alt-text mode one picture at a time, leave the site; the provider's retention terms apply. Nothing about the people using Studio, no secrets and no code is sent. Teo confirms the terms for the account used.
5. **Provider outage or changed behaviour.** AI help degrades with a plain message; Studio does not. Replay fixtures keep CI independent of the provider; `studio:ai-eval -- --live` re-checks the real one on demand.
6. **Model output that is valid but unhelpful.** Costs a click (Discard). No control needed.
7. **The brand voice text and the "sensitive" list are advice and heuristics, not boundaries.** They are in `brand-voice.js` and `policy.js` for Teo to read.

### Operating rules that keep this model true

* Keep `STUDIO_AI_API_KEY` only as a secret on the API host. Set a spend limit at Anthropic first.
* Treat any change to `allowlist.snapshot.json` as a security review: the guard fails until a human has looked at what the AI can now reach.
* Do not add a second write path for AI. The only write is `drafts.saveDraft`; `check-ai` fails otherwise.
* Never raise the overlay or API trust of AI output "just for this feature". If a field needs to be writable by AI, make it writable by hand-editing first.

## Phase 1 additions (one subsection per unit; edit only your own, see studio/PHASE1-DESIGN.md section 2)

### P1-BACKEND (health route, usage tables, label fallback)
**New inputs and who can call them**

| Input | Who | What it can do | What stops abuse |
|---|---|---|---|
| `GET /v1/health` | anyone (no token) | Learn whether Supabase and GitHub answer and whether AI help is on. | The answer is fixed sentences and states: no address, key, error text, version or count. Cached (default 30 s) with ONE shared in-flight check, so a flood costs one upstream call per window; the anonymous IP rate limit still applies; no audit entry (it is polled). The check itself sends only the public key, to the sign-in service's own health address. |
| `POST /v1/ai/estimate`, `GET /v1/ai/recent` | editor and above | Estimate a request's cost (it builds the prompt, calls no model, reserves and counts nothing); list the caller's own last 20 requests. | Same role and CSRF rules as the other AI routes. Estimate reads Git like propose does but never writes; recent returns only the caller's rows, ids and counters, never instruction text. Rate class `read`. |
| `studio_ai_*` functions (`003`) | the caller's own JWT, through PostgREST | Count the caller's own usage and read the caller's own recent list. | `security definer`, pinned search path, active-person check on every function, only the caller's rows (`auth.uid()`), tables closed to anon and signed-in users (RLS on, no policies), nothing stored but counters and request ids. Applied by a human; Studio never applies it. |
| Label write on a pull request | the GitHub App | Add labels. | A failure is logged once and ignored. Labels are not trusted: merge identifies a Studio draft by `studio/` branch + this repository + base branch + Studio's marker. |
| `requestReviewers` | the API (REVIEW's submit) | Ask GitHub to notify named collaborators. | Logins are validated against GitHub's own pattern inside the provider; at most 10; a refusal never fails a submit; it cannot approve, merge or request itself. |

**What an editor can newly do:** see how healthy the services are, see the cost estimate of their own request and their own recent requests. **What an editor can no longer do:** use up other people's daily suggestions (the per-person cap is enforced in the store, and a shared store makes it hold across API copies); push the global counter past its caps with several API copies when the shared store is on.

**What got safer.** An outage of the sign-in service used to look like "please sign in again" (and counted toward the bad-sign-in limit, so an outage could lock people out); it is now a 503 with a plain sentence and is not counted. A missing "Issues" permission used to make saving a draft report an error (the pull request was already created); it no longer does.

**Failure modes (all fail closed).** Shared usage store unreachable, paused, not set up, or answering strangely: the request is served from the memory store with the same caps (never "unlimited") and one `usage.store_fallback` line is logged per minute. Health check hangs: it is abandoned at `STUDIO_HEALTH_TIMEOUT_MS` and reported as unreachable. A forged marker on a non-`studio/` branch or on a fork is refused by the branch guard and the fork check before the marker is even read.

**Residual risks.** (1) Anyone who can edit a pull request's body on a `studio/` branch in the repository can write a marker; they could already add a label, they already have repository write access, and the pull request still needs CI, `studio-scope` and a second person. (2) The health route tells an anonymous caller when a service is down; that is the same thing the login page needs to show a founder, and it reveals nothing about the configuration. (3) The memory counters are per API copy: with the shared store off, the real ceiling is the limit times the number of copies (the runbook says so).

### P1-REVIEW (board, review screen, reviewer notification)
New inputs: `reviewerId` on submit (must match `[a-z0-9-]{1,30}` AND an id in the server-side list, else 400); the draft id in the review route (same parser as every draft route); `STUDIO_REVIEWERS` (operator-set, validated at start-up). New outputs: the board, the review list, the approver list, the review link.
Who can call: board and approvers: any signed-in role. Review: the draft's owner or an approver/admin; anyone else gets the same 404 as for a missing draft. Submit: owner only. No new write route: publishing is still POST /v1/drafts/:id/publish with its gates (CI, studio-scope, second person, head sha, ready state).
Newly possible for an editor: seeing a COUNT of other people's waiting drafts (never titles or authors); asking GitHub to request a review from a listed approver (the request names only the configured login; an editor cannot supply a login). Nothing is removed.
Leaks considered: GitHub logins and Studio user ids stay on the server (the approver list carries id, first name, role and how they are told); the audit entry records the reviewer id only. Text from drafts reaches the browser only as text nodes; the review route also swaps `<` and `>` for look-alikes and strips control characters. The review link holds the draft id, not a secret: opening it needs a Studio sign-in, and viewing the draft needs ownership or an approver role. A notification failure never blocks a submit and never shows upstream error text. The board is cached 15 s per role and person; a stale board cannot publish anything (the publish route re-reads the pull request).
Residual: who can open the Netlify preview is a separate door, see `studio/NOTES-preview-access.md`.

### P1-EDIT (rule engine, checks panel, palette sources)
(not written yet)

### P1-DECAP (what removing Decap and Netlify Identity changes)

* **Removed attack surface:** the Decap bundle loaded from a third-party CDN, the Netlify Identity widget script, the invite-link forwarder on the home page, and Git Gateway (a second route to write to the repository that bypassed Studio's validation, CI gate and second-person rule). With the old draft workflow gone there is no other draft path.
* **What stays risky until Teo acts:** Identity and Git Gateway are Netlify site settings, not code. While they stay enabled, anyone with an old invite or a signed-up Identity account could still obtain a Git Gateway token even though no page uses it. Runbook 4c.4 lists the three switches (disable Identity and delete users, disable Git Gateway, remove the leftover GitHub grant). Until then the open signup noted in the security audit is still open.
* **`/cms/`:** a static page with no script, no third-party loads and noindex; old deep links redirect to it, so there is no editor login form to phish with.
* **Regression guard:** `check-no-decap.js` fails on any return of the dead strings, files or settings; its selftest puts each back and expects a failure.
