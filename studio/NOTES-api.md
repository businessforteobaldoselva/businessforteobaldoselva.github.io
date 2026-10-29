# Unit B (API) - notes for the integrator

Branch `phase4/api`. Contract: `studio/DESIGN.md` (sections 5-9, 12, 13). This file records what was built, how to run it
and every place the build deviates from or extends the contract. (D folds deviations back into DESIGN.md.)

## What exists

| area | files |
|---|---|
| shared rules (extracted, behaviour unchanged) | `lib/rules.js` (safeUrl, safeColor, HEX_COLOR_RE, LINK_PATTERN_SOURCE, safeAnchor), `scripts/lib/image-rules.js` (svgProblems, jpegHasGps, sniffImage, fileNameOk); `.eleventy.js` and `scripts/check-images.js` import them |
| validator (portable, pure) | `studio/validate/*` - `index.js` (pipeline), `scope.js`, `pointer.js`, `ops.js`, `fields.js`, `images.js`, `jsontext.js` (format-preserving JSON patching), `pagefile.js` (front matter round trip), `describe.js`, `diff.js`, `walk.js` |
| API (portable) | `studio/api/{handler,router,http,errors,cors,config,ratelimit,audit,boot}.js`, `routes/*`, `services/*`, `providers/{git,auth,roles}/*` |
| adapters | `adapters/node.js`, `adapters/netlify.mjs`, `adapters/cloudflare.mjs` (thin; nothing deployed) |
| dev | `studio/dev/server.js` (`npm run studio:dev`), `studio/dev/mock-github-server.js` |
| SQL (human applies) | `studio/sql/001_studio_roles.sql` |
| CI | `.github/workflows/studio-scope.yml` (job `studio-scope`) |
| guards | `studio/guards/check-scope.js`, `check-portability.js`, `check-validator-parity.js`, `selftest-b.js`; `scripts/check-studio-api.js` (static rules; `npm run check:studio-api`, added to `npm run check`) |
| tests | `studio/tests/api/*.test.js` (node:test), `studio/tests/e2e/run.js` (`npm run studio:e2e`, `--quick` for three guards only), fixtures in `studio/tests/fixtures/` |

Run: `npm run check:studio` (all guards + tests), `npm run studio:e2e`, `npm run studio:dev`.

## Deviations from DESIGN.md (all additive or clarifying)

1. **GitProvider interface** gains `listDir(ref, dir)` (permalink uniqueness among pages), `changedFiles(a, b)` (base_moved, rebase, history),
   `prUrl(n)` and `getBaseBranch()`. All three implementations (mock-memory, local-git, github.js) pass the shared contract test.
2. **Page files normalised once** (commit `3f60969`): `src/pages/about.md` and `privacy.md` had hand-written YAML quoting. They now use exactly
   what js-yaml writes so the round-trip law `serialize(parse(file)) === file` holds and an edit touches only the changed lines. Both parse to identical
   data; production HTML parity verified. Data JSON files are patched textually (`jsontext.js`) so hand formatting (compact objects) survives.
3. **`validatePatch` returns `conflicts`** (the `expect` mismatches) beside `problems`; the handler turns them into `409 conflict`.
4. **Unknown keys at the head** are warnings (not blockers) as designed; so are all problems already present at the draft head (validated first, subtracted).
5. **`studio/tests/fixtures/schema-from-config.js`** builds a schema straight from `cms/config.yml` and prefers unit A's committed
   `studio/schema/studio-schema.json` as soon as it exists. Until A is merged `reservedIds` in that fallback is `[]` and the API takes reserved ids from
   `lib/reserved-ids.js` through `buildDeps` (Node side). After A lands, re-run `npm run check:studio`; no code change is expected.
   `check-validator-parity.js` imports the fixture; after A lands it may switch to the committed schema file (same function).
6. **Draft titles** are plain text (control characters stripped, `@` neutralised, `<` kept); PR *bodies* escape `<` so the authorship marker cannot be forged.
7. **`check-scope.js` reads `scope.js` from beside itself** (not from `--root`), so the workflow can run main's copy of both against a pull request and a PR
   cannot widen its own scope. With no `--base` it only verifies the scope definition (that is how `check:studio` runs it).
8. **`check-studio-api.js`** is the guard asked for in the task brief (static rules, optional test run). `package.json`: new script `check:studio-api`,
   chained into `check`; `js-yaml` moved to `dependencies` (lock file edited to match: root entry, `js-yaml`, `argparse` lose `"dev": true`).
9. `studio/tests/e2e/run.js` clones a *copy of the working tree* into a temp git repo (not `.git` history) and uses a `checkRunner` that runs the repository's
   guards on the draft branch head. It takes a few minutes in full mode.
10. SQL file name is `001_studio_roles.sql` (contract) although the task text says `studio_roles.sql`.

## Known limits / gaps (be honest)

- `github.js` is written to the documented public API and exercised only against `studio/dev/mock-github-server.js`; never run against github.com. The mock emulates
  exactly the endpoints used; real GitHub differences (rate limits, eventual consistency of check runs, GraphQL pagination for >100 files per PR) are untested.
- GraphQL merged-PR listing reads `files(first:100)`; a merged PR touching more than 100 files shows its first 100 only.
- Rate limiting is in-memory per runtime instance (best effort on serverless); production needs a shared store (KV / Redis / Durable Object). Same for the 30 s role cache.
- JWKS mode is tested with locally generated RS256/ES256 keys against a stub endpoint, not against a real Supabase project.
- The SQL has not been executed anywhere (by design). Review the `studio_claim_role` function and the policies before applying.
- `STUDIO_AUDIT` Supabase sink: the table exists in the SQL, the API writes console JSON lines; the optional Supabase insert sink is not wired.
- No overlay, markers or schema generator here (units A, C, D).
