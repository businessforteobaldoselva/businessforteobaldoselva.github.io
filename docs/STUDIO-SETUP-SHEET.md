# Studio setup sheet: every value, where it comes from, where it goes

Nothing secret belongs in this file or anywhere in the repository. Secrets go only into the host's secret store (Cloudflare: `wrangler secret put NAME`, or Settings, Variables and Secrets, type Secret).

Tick each row as you set it.

| # | Value | Where you get it | Where it goes | Secret |
|---|---|---|---|:-:|
| 1 | GitHub App ID | GitHub, Settings, Developer settings, GitHub Apps, your app, "App ID" | API: `GITHUB_APP_ID` | no |
| 2 | Installation ID | the number at the end of the address of the app's installation page | API: `GITHUB_APP_INSTALLATION_ID` | no |
| 3 | Private key (`.pem`) | the file GitHub downloaded when you generated the key | API: `GITHUB_APP_PRIVATE_KEY` (whole text) | **yes** |
| 4 | Repository | `businessforteobaldoselva/businessforteobaldoselva.github.io` | API: `GITHUB_REPO` | no |
| 5 | Supabase Project URL | Supabase, Project Settings, API | API: `SUPABASE_URL` | no |
| 6 | Supabase anon key | same page, "anon public" (never the service-role key) | API: `SUPABASE_ANON_KEY` | no |
| 7 | Audit salt | make up a long random string (30+ characters) | API: `STUDIO_AUDIT_SALT` | **yes** |
| 8 | Login page address | where you deploy `studio/login/` (for example `https://covered-studio.pages.dev`) | API: `STUDIO_ALLOWED_ORIGINS`; Supabase: Site URL and Redirect URLs; Netlify (Deploy Preview only): `STUDIO_APP_URL` | no |
| 9 | API address | where you deploy the API (for example `https://covered-studio-api.<you>.workers.dev`) plus `STUDIO_BASE_PATH` if any | login page `config.json` `api`; Netlify (Deploy Preview only): `STUDIO_API_URL` | no |
| 10 | Preview address shape | `https://deploy-preview-{n}--coveredaccess.netlify.app` | API: `STUDIO_PREVIEW_ORIGIN_TEMPLATE`; login `config.json` `previewOriginTemplate` | no |
| 11 | Preview link for a draft | same shape with `{pr}` | API: `STUDIO_PREVIEW_URL_TEMPLATE` | no |

Login page `config.json` (copy `studio/login/config.example.json` next to `index.html` on the host; no secrets):

```
{ "api": "<row 9>", "allowedOrigins": ["<row 10 with each deploy-preview origin allowed by the template>"], "previewOriginTemplate": "<row 10>" }
```

Leave `STUDIO_DEV`, `STUDIO_ALLOW_NO_ORIGIN` and `STUDIO_ALLOW_SELF_PUBLISH` unset. Leave `STUDIO_AI_ENABLED` at `0` until runbook step 4b.

Check after deploying: `<API address>/v1/preview-config` returns a small JSON with `"apiVersion":1` and no secrets.

## Live values (set 2026-11-10; none are secret)

| What | Value |
|---|---|
| API (Cloudflare Worker `covered-studio-api`) | `https://covered-studio-api.covered-website.workers.dev` |
| Login page (Cloudflare Worker static site `covered-studio`) | `https://covered-studio.covered-website.workers.dev` |
| GitHub App | `covered-access-studio`, App ID 5549366, Installation ID 177063583 |
| Supabase project | `irkzuzctzyncyzvngjiz` (Frankfurt) |
| Netlify (Deploy Preview only) | `STUDIO_API_URL`, `STUDIO_APP_URL` = the two addresses above |
| Secrets held only in Cloudflare | `GITHUB_APP_PRIVATE_KEY`, `STUDIO_AUDIT_SALT` |
