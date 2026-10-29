# COVERED Studio: runbook

Two readers, two parts.

* Part 1 is for the founders. It takes under two minutes to read, and it is all you need to edit the site.
* Part 2 is for Teo, once: the setup checklist, what each setting is, and what to do when something breaks.

Status of this document: everything described here is built and tested against local stand-ins (a local copy of the repository, a mock of GitHub, a dev sign-in). Nothing has been run against github.com or supabase.co yet. Part 2 is the list of things only a person with the accounts can do.

---

## Part 1. Founders: edit, draft, review, publish, undo (2 minutes)

### The idea in one sentence

You change the website on the page itself. Your changes are saved as a **draft** on the side. Another person (an **approver**) looks at the draft and presses **Publish**. Only then does the live website change. You cannot break the live site by editing.

### What you can do, by role

| Role | Change things and save a draft | Undo something that went live | Publish a draft | Add or remove people |
|---|:-:|:-:|:-:|:-:|
| Editor | yes | yes (makes a draft) | no | no |
| Approver | yes | yes (makes a draft) | yes, but not your own | no |
| Admin | yes | yes (makes a draft) | yes, but not your own | yes |

"Not your own" is deliberate: a second person always looks before anything goes live.

### Edit something (about 30 seconds)

1. Open the **preview link** from the draft (or any preview of the site) and add `/?studio=1` to the end of the address. In the Studio on your own computer it is `http://localhost:8080/?studio=1`.
2. Sign in with your email. Studio sends you a code.
3. Press **E** (or the **Edit** button) to switch editing on. Things you can change get an outline.
4. **Text:** click it, type, press **Enter**.
5. **A picture:** click it, choose a new photo, drag to crop. Studio asks for a short description of the photo (for people who cannot see it). If the picture is only decoration, switch on "decorative".
6. **Hide a section** (this works on a phone too): open **Sections**, press **Hide** on the section. Hidden sections show as dimmed; they are only hidden on the live site after publishing. Use the arrows to move a section up or down.
7. Press **Save draft** (or Ctrl/Cmd + S). Studio checks everything and keeps it as a draft. If something is not allowed, it tells you which field and why, and nothing is lost.
8. Press **Send for review**. Tell your approver.

### Publish (approvers)

1. Open the draft. Studio shows what changed in plain English and whether the safety checks are green.
2. When the checks are green and you are happy, press **Publish**. The site updates in a few minutes.
3. If the checks are not green, do not publish. Ask the editor to look, or see "When it breaks" below.

### Undo something that already went live

1. Press **Ctrl/Cmd + K**, type `history`, press **Enter** (or open the **History** panel).
2. Find the change. Each row says who changed what and when.
3. Press **Restore**, then confirm. Studio makes a **new draft** that undoes that change. Nothing is live yet.
4. An approver publishes that draft like any other. Done.

If someone changed the same thing since, Studio tells you and offers to undo only the parts that are still the same.

### Shortcuts worth knowing

| Keys | What it does |
|---|---|
| Ctrl/Cmd + K | Search for anything you can do ("hide partners", "change the logo", "history") |
| E | Switch editing on and off |
| Ctrl/Cmd + S | Save draft |
| Ctrl/Cmd + Z | Undo your last change |
| ? | Help |
| Esc | Close what is open |

The first time you sign in, a short tour shows you around. You can replay it from **Help**.

### Words you will see

* **Draft:** your changes, kept safely on the side.
* **Review:** an approver looking at your draft.
* **Publish:** make the draft live.
* **Restore:** undo a change that is already live (it makes a new draft first).

---

## Part 2. Teo: one-time setup, settings and troubleshooting

### 0. Try it locally first (no accounts needed)

```
npm run studio:dev
```

Open `http://localhost:8080/?studio=1`. It builds the preview version of the site, runs the API on `http://localhost:8787` against a pretend GitHub and a pretend sign-in, and lets you sign in as Molly (editor), Amelia (approver) or Teo (admin). Change a headline, swap a photo, hide a section, save, publish as the approver, look at History, press Restore. This is the same code that will run for real; only the two outside services are pretend. The pretend sign-in refuses to run unless `STUDIO_DEV=1`, the address is localhost, and no real secret is set.

Then run the full checks once: `npm run check`, `npm run check:selftest`, `npm run studio:e2e`.

### 1. Create the GitHub App (about 5 minutes)

GitHub: Settings, Developer settings, GitHub Apps, New GitHub App.

* Name: `covered-studio` (anything). Homepage URL: your site. **Untick Webhook** (Active).
* **Where can this app be installed:** Only on this account.
* **Minimal permissions.** Repository permissions, nothing else:

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | save a draft branch, read the current content |
| Pull requests | Read and write | open the draft pull request, mark it ready, merge it |
| Metadata | Read-only | GitHub adds this automatically |
| Checks | Read-only | so Studio can see whether the safety checks passed before allowing Publish |
| Commit statuses | Read-only | the same, for older-style checks |

  Contents, Pull requests and Metadata are the three the design needs to do the work. Checks and Commit statuses are read-only and exist only so the Publish button can refuse when the checks are red. The design document also lists Issues (read and write) for creating labels; GitHub normally lets Pull requests access manage labels on pull requests, so try without it and add Issues only if label creation is refused (error 403 on labels).
* No account permissions, no organisation permissions.
* Create the app, then **Generate a private key** (a `.pem` file downloads). Note the **App ID**.
* **Install App** on your account and choose **Only select repositories**, then pick the COVERED website repository and nothing else. Note the **Installation ID** (the number at the end of the installation's address).
* Keep the `.pem` file out of the repository, forever. It goes only into the hosting provider's secret settings (step 5).

### 2. Protect `main` on GitHub

Settings, Branches (or Rules), add a rule for `main`:

* Require a pull request before merging.
* Require status checks to pass: **Build and guards** and **studio-scope**.
* Do not allow force pushes or deletion.
* Do not let the GitHub App bypass the rules (it merges only when the checks are green, like anyone).
* Optional but wise: CODEOWNERS so that every path outside `src/_data`, `src/pages` and `images` needs your review.

This is what makes Studio safe even if everything else failed: nothing reaches `main` without the checks.

### 3. Supabase: sign-in and roles

1. Create a project at supabase.com. In Authentication, **turn off "Allow new users to sign up"** (invite only) and turn on Email (one-time code or magic link).
2. Add the Studio login page's address to the redirect URLs (step 6).
3. Note the **Project URL** and the **anon (public) key**. If you choose the shared-secret mode, note the JWT secret too. Never use the service-role key anywhere in Studio; Studio does not need it.
4. Open `studio/sql/001_studio_roles.sql`. **Read it first**, then paste it into the Supabase SQL editor and run it yourself. Claude and the Studio code never run it. It creates the roles table, locks it down, and creates the audit table.
5. At the bottom of the file there is a commented-out line that adds the first admin. Put in your email, un-comment it, run it. You are now the admin; add the others from Studio (Admin, People) or with the same kind of line.

### 4. Settings (environment variables)

Set these where the API runs (step 5). Secrets are marked. Names are final; a wrong combination makes the API refuse to start (it answers every request with a plain error and logs why), which is by design.

| Name | What it is | Secret |
|---|---|:-:|
| `STUDIO_ENV` | `production` (default) or `development` | no |
| `STUDIO_DEV` | `1` turns on the pretend sign-in. **Never set in production**: it only works on localhost and the API refuses to start if real secrets are also present | no |
| `STUDIO_BASE_PATH` | route prefix to strip, for example `/api/studio` | no |
| `STUDIO_ALLOWED_ORIGINS` | comma list of exact origins allowed to call the API: the login page origin, plus `http://localhost:8080` if you want local use | no |
| `STUDIO_PREVIEW_ORIGIN_TEMPLATE` | your preview address shape, for example `https://deploy-preview-{n}--coveredaccess.netlify.app` (only `{n}` varies) | no |
| `STUDIO_ALLOW_NO_ORIGIN` | `1` only for tests and dev | no |
| `STUDIO_ALLOW_SELF_PUBLISH` | `1` lets a person publish their own draft. Default off; leave it off | no |
| `STUDIO_MAX_BODY_BYTES` | largest save request, default 6000000 | no |
| `STUDIO_PREVIEW_URL_TEMPLATE` | where a draft's preview lives, with `{pr}` for the pull request number | no |
| `STUDIO_AUDIT_SALT` | random text used to hash IP addresses in the log | yes |
| `GITHUB_REPO` | `owner/name` of the website repository | no |
| `GITHUB_BASE_BRANCH` | `main` | no |
| `GITHUB_APP_ID` | from step 1 | no |
| `GITHUB_APP_INSTALLATION_ID` | from step 1 | no |
| `GITHUB_APP_PRIVATE_KEY` | the whole `.pem` text (`\n` escapes are fine) | yes |
| `SUPABASE_URL` | the project URL | no |
| `SUPABASE_ANON_KEY` | the public anon key | no |
| `STUDIO_JWT_MODE` | `jwks` (default, recommended) or `hs256` | no |
| `SUPABASE_JWT_SECRET` | only for `hs256` | yes |

For the Netlify site (Deploy Preview context only), also set `STUDIO_API_URL` (the API's address) and `STUDIO_APP_URL` (the login page's address). They must start with `https://` (or be localhost). If they are missing, the overlay says it is not configured and tells you why.

### 5. Deploy the API (one adapter)

The API is one portable function with three thin adapters. Pick **one** host:

* **Netlify Function:** `studio/api/adapters/netlify.mjs`. It answers on `/api/studio/*`. Put the settings from step 4 in the Netlify site settings.
* **Cloudflare Worker:** `studio/api/adapters/cloudflare.mjs`. Put the settings in the Worker's variables and secrets.

Check it: open `<API address>/v1/preview-config` in a browser. You should see a small JSON with `"apiVersion":1` and no secrets.

### 6. Deploy the login page

`studio/login/` is a small static page. Deploy it to its **own address** (not the website's address and not a preview address), with a `config.json` next to it:
`{ "api": "<API address>", "allowedOrigins": ["..."], "previewOriginTemplate": "..." }`.
That address is `STUDIO_APP_URL`.

### 7. Turn on preview builds with the overlay

* `netlify.toml` already sets `CMS_EDIT=1` for Deploy Previews and forces it empty for Production. Studio markers and the overlay exist **only** in builds where `CMS_EDIT=1`; the live site is byte-for-byte what it was. The parity check proves it.
* Confirm Deploy Previews are built for pull requests opened by the GitHub App, and fix the 401 on preview addresses that you saw earlier (they should open for signed-in team members). Until that works, keep using `npm run studio:dev`.
* **Never** set `CMS_EDIT` on Production.

### 8. People

Add each founder in Studio (Admin, People) or in `studio_roles`: email, display name, role. They sign in with the same email. Use Editor for most people and Approver for the two people who may publish. Remove access by setting `active` to false: it takes effect within 30 seconds.

### 9. Before you trust it

1. `npm run check`, `npm run check:selftest` and `npm run studio:e2e` are green.
2. On a preview: sign in as an editor, change a headline, swap a picture, hide a section on a phone, Save draft. A draft pull request appears with plain-English changes.
3. Sign in as an approver (a different person). Wait for green checks. Publish. The change is on the live site. History shows the row.
4. Press Restore on it. A new draft appears. Publish it. The site is back.
5. Look at the pull request's file list each time: only paths in `src/_data/`, `src/pages/` and `images/` should ever appear.

### When it breaks

| What you see | Likely reason | What to do |
|---|---|---|
| The Edit button never appears | Page opened without `?studio=1`, or it is the live site (never has the overlay) | Add `/?studio=1` to a preview address |
| "Studio is not configured" | `STUDIO_API_URL` or `STUDIO_APP_URL` missing for Deploy Previews | Set both (step 4), rebuild the preview |
| Sign-in window opens and closes with no result | The login page does not know this preview address | Check `allowedOrigins` and `previewOriginTemplate` in the login `config.json` and `STUDIO_ALLOWED_ORIGINS` / `STUDIO_PREVIEW_ORIGIN_TEMPLATE` |
| "You have not been invited" | Email is not in `studio_roles`, or `active` is false | Add or reactivate the person |
| Every request answers "internal error" | The API refused to start because of a bad combination of settings | Read the host's log: it names the setting (for example `STUDIO_DEV` together with a real key, or a missing `GITHUB_*`) |
| Save says a field is not allowed | The rules of the site (same as the content editor) refused it | Read the message next to the field and fix that one |
| "Someone changed these since you started" | Another draft was published first | Choose Keep mine or Take theirs per item, or Refresh |
| Publish is greyed out with "checks not green" | The site build or a guard failed on the draft | Open the pull request, read the failing check. Fix in a new save, or discard the draft |
| Publish says "not your own draft" | The four-eyes rule | Ask the other approver |
| Restore says nothing left to undo | Everything that change touched was edited again since | Nothing to do; make a normal edit instead |
| Preview shows 401 | Netlify password protection on previews | Phase 0 item: allow signed-in team members, or use `npm run studio:dev` |

### Emergency switches

* **Stop all Studio writes right now:** suspend or uninstall the GitHub App (GitHub, Settings, Applications). The website and its normal content editor keep working; nobody can save a draft.
* **Stop one person:** set `active` to false in `studio_roles`.
* **Undo a bad publish:** History, Restore, then an approver publishes. If Studio itself is down, revert the pull request on GitHub as usual.
* **Rotate a leaked GitHub App key:** generate a new private key in the app settings, replace `GITHUB_APP_PRIVATE_KEY`, delete the old key.
* The live site never depends on Studio. If Studio is broken, switch the API host off and nothing public changes.

### Where things are

| Thing | Place |
|---|---|
| Design contract | `studio/DESIGN.md` |
| What an attacker could and could not do | `studio/THREAT-MODEL.md` |
| Roles table SQL (for you to apply) | `studio/sql/001_studio_roles.sql` |
| API | `studio/api/` |
| The editing overlay and History, Help, tour, search | `studio/overlay/` |
| Every guard and test | `npm run check` (ends with `check:studio`) |
