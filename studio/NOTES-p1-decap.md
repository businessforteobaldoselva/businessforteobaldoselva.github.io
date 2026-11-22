# NOTES: Phase 1 DECAP unit (retire Decap CMS and Netlify Identity)

Inventory from `git grep -inE "decap|netlify-identity|git-gateway|identity\.netlify|editorial_workflow|decap-server|cms/previews|cms-local|check-previews|preview_path|local_backend"` (excluding `admin/`, `package-lock.json`, `studio/PHASE1-DESIGN.md`), taken before any change. R = Remove, E = Edit, K = Keep.

| File | Hits | Class | What happens |
|---|---|---|---|
| `cms/index.html` | Identity widget + decap-cms script | R | deleted, replaced by `cms/moved.html` (published as `/cms/`) |
| `cms/previews.js`, `cms/custom.css` | Decap previews / theme | R | deleted |
| `scripts/check-previews.js`, `scripts/lib/previews.js`, `scripts/previews-known-issues.json` | previews guard | R | deleted, `check:previews` leaves the `check` chain |
| `package.json` | `cms-local`, `check:previews`, `decap-server` | R | removed; lockfile regenerated |
| `src/index.njk` | Identity `invite_token` forwarder | R | removed (parity exception E1) |
| `.eleventy.js` | `addPassthroughCopy("cms")` | E | only `cms/moved.html` -> `cms/index.html` |
| `netlify.toml` | (none today) | E | add `/cms/*` -> `/cms/` 302; no Identity/Git Gateway |
| `cms/config.yml` (23 + `summary`, `editor`, `create`, `slug`) | backend, publish_mode, local_backend, site_url, display_url, logo_url, locale, 19x preview_path, editor, create, slug, summary | E | stripped; schema source of truth stays (header comment says so) |
| `scripts/check-cms.js` | backend requirement, previews block, "Decap" wording, summary checks | E | reworded / removed |
| `scripts/check-tokens.js` | TOKEN_SPEC copy in previews.js | E | comparison and `--write` rewrite removed |
| `scripts/check-seo.js` | Redirects preview must use shared checker | E | check removed (rules file stays used by seo.js) |
| `scripts/selftest.js` | previews scenarios, TOKEN_SPEC mutation | E | removed / replaced |
| `scripts/README.md`, `scripts/copy-allowlist.json`, `lib/tokens.js`, `cms/contrast.js`, `cms/redirect-rules.js`, `BRIEF.md`, `studio/DESIGN.md`, `AI-DESIGN.md`, `NOTES-markers.md`, `docs/STUDIO-RUNBOOK.md` | wording | E | reworded |
| `studio/guards/check-scope.js`, `studio/tests/api/validate-paths.test.js` | `cms/previews.js` in a list of protected paths | K | harmless: a protected path that no longer exists stays refused |
| `studio/api/services/history.js`, `studio/overlay/ext/history.js`, history/drafts/publish tests, `mock-memory.js`, `tests/ext/*` | `via: "decap"` for old `cms/*` branches | K | History must still label old merged Decap PRs |
| `cms/contrast.js`, `cms/redirect-rules.js`, `scripts/lib/cmsconfig.js`, `scripts/alt-exemptions.json` | | K | used by overlay, a11y guard, seo.js, validators |
| `admin/` | one code comment | K | owned by another session, untouched |

Deferred: renaming the `cms/` folder (about 25 consumers across build, guards, overlay, tests).
