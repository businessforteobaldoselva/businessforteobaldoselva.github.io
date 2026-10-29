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
| T3 | Path tricks: `..`, `%2e`, backslashes, case collisions, symlinks in uploads | Exact-match grammar on the normalised path; uploads are new files under `images/` only; existing files are never overwritten | validator tests |
| T4 | Hostile image: SVG with script, JPEG with GPS, wrong type, decompression bomb | The same rules as the image guard (`scripts/lib/image-rules.js`), magic bytes against extension against content type, 4 MB and 8000 px caps, overlay re-encodes (which also strips EXIF) | image tests; `check:images` |
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
