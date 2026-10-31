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

### Describe a change (AI help)

This only appears when a Studio admin has switched AI help on. If you open **Describe a change** and it says AI help is switched off, everything else in Studio works as usual and you can carry on editing by hand.

1. Open **Describe a change** (the sparkle button, or press **Ctrl/Cmd + K** and type `describe`). On a very small phone screen it is the link **Or describe a change in words** at the top of **Changes**.
2. Say what you want in your own words: "make the hero shorter and warmer", "translate the FAQ to Welsh", "add a question about venues to the FAQ". If you clicked something on the page first, the panel says **About: ...** and the suggestion stays on that part. Press the small x to remove it.
3. Press **Suggest changes** (or Ctrl/Cmd + Enter). It usually takes 5 to 20 seconds, longer for a translation. You can **Cancel**.
4. Read the suggestion. Every change is a card with a **Before** and an **After**: removed words are struck through and added words are underlined (and read out as "[removed]" and "[added]" to a screen reader). **Nothing is saved yet.**
5. Tick the ones you want. **Select all**, **Select none** and **Discard** do what they say. Some changes go together (for example a new FAQ question and its answer): ticking one ticks the other, and Studio tells you.
6. Press **Save N changes as a draft**. It becomes a normal draft, exactly like one you made by hand: send it for review, an approver publishes it. **Nothing goes live until an approver publishes it.**

If you change your mind: **Discard** before saving; discard the draft in **Changes** after saving; or, once it is live, use **History** and **Restore**. Every AI draft can be undone in one click, like any other change.

What the yellow notes mean:

* **Outside what you asked about:** the change is on a part of the site you did not mention. It starts unticked. Look at it before you tick it.
* **Changes where visitors go (link or email):** links and email addresses decide where people end up. It starts unticked. Only tick it if you are sure.
* **Some page text reads like an instruction:** text on the site tells the AI what to do. Studio treated it as plain text, but look at every change carefully.
* **Left out:** the AI suggested something Studio could not use (too long, not allowed). It is listed with the reason and nothing was saved for it.

Other things on the same panel: **Alt text** writes the short description of a picture for people who cannot see it; **Meta description** drafts the line people see under the page title in search results (70 to 160 characters is best); **Tone check** points out wording that does not sound like COVERED and never changes anything by itself (use "Use this wording" on a finding to tick a fix).

**When AI help says "This needs a developer change":** AI help only changes words, picture settings and colours. For anything about how the site works or looks (a new page, a font, an animation) it drafts a request for you. Press **Copy request**, then **Open Ask Claude** and paste it there. Nothing is sent for you.

### Shortcuts worth knowing

| Keys | What it does |
|---|---|
| Ctrl/Cmd + K | Search for anything you can do ("hide partners", "change the logo", "history") |
| E | Switch editing on and off |
| Ctrl/Cmd + S | Save draft |
| Ctrl/Cmd + Enter | In Describe a change: ask for suggestions |
| Ctrl/Cmd + Z | Undo your last change |
| ? | Help |
| Esc | Close what is open |

The first time you sign in, a short tour shows you around. You can replay it from **Help**.

### Words you will see

* **Draft:** your changes, kept safely on the side.
* **Review:** an approver looking at your draft.
* **Publish:** make the draft live.
* **Restore:** undo a change that is already live (it makes a new draft first).
* **Suggestion:** what AI help proposes. It is only a proposal until you save it as a draft.

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
* Settings, General, Pull Requests: turn on **Allow squash merging**. Studio publishes only by squash merge; with it switched off every Publish answers "not mergeable".
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
| `STUDIO_PREVIEW_ORIGIN_TEMPLATE` | your preview address shape, for example `https://deploy-preview-{n}--coveredaccess.netlify.app` (only `{n}` varies). Not enough on its own: see "Preview addresses" below | no |
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
| `STUDIO_AI_ENABLED` | `1` turns on AI help ("Describe a change"). Default off. See 4b | no |
| `STUDIO_AI_API_KEY` | your Anthropic key, only if you turn AI help on. See 4b | yes |
| `STUDIO_AI_MODEL` | model name for AI help, default `claude-sonnet-5-5`. More settings in 4b | no |

For the Netlify site (Deploy Preview context only), also set `STUDIO_API_URL` (the API's address) and `STUDIO_APP_URL` (the login page's address). They must start with `https://` (or be localhost). If they are missing, the overlay says it is not configured and tells you why.

### 4b. AI settings: "Describe a change" (optional, off by default)

What it is: a text box in Studio. A founder types "make the hero shorter and warmer" or "translate the FAQ to Welsh". A model suggests changes, Studio shows each one as BEFORE and AFTER, and the person saves all, some or none of them as an ordinary draft. Everything after that (preview, checks, a second person publishing, History and Restore) is exactly as for a hand-made edit.

What it can **never** do, and why you can rely on it: the model's answer is treated like text from a stranger. Studio only accepts changes to words, switches and colours in `src/_data/` and `src/pages/` that the content editor already offers. It cannot touch code, templates, styles, configuration, workflows, `package.json`, pictures, redirects or page addresses; an answer that tries is thrown away whole. This is enforced by code and by the same checks as a hand-made edit, not by asking the model nicely. If a request needs code, the model says so and Studio offers a ready-to-send note for **Ask Claude** (nothing is filed for you).

**Settings.** Set these where the API runs (same place as step 4). Only the first two are needed.

| Name | Default | What it is | Secret |
|---|---|---|:-:|
| `STUDIO_AI_ENABLED` | off | `1` or `true` turns AI help on. Anything else (or unset) is OFF. This is the kill switch. | no |
| `STUDIO_AI_API_KEY` | none | Your Anthropic API key. Without it, AI help says "not connected yet" and Studio works as before. | **yes** |
| `STUDIO_AI_MODEL` | `claude-sonnet-5-5` | the model name sent to Anthropic | no |
| `STUDIO_AI_MAX_OUTPUT_TOKENS` | 6000 | longest answer allowed (512 to 16000) | no |
| `STUDIO_AI_TIMEOUT_MS` | 25000 | the longest one request may take, retries included (3000 to 60000). If your host stops functions earlier than this (some stop at 10 or 26 seconds), set this a little lower than the host's limit. A long job such as "translate the FAQ" can take 15 seconds or more. | no |
| `STUDIO_AI_VISION` | on | `0` stops pictures being sent to the model. Alt text is then written from file names and nearby words only. | no |
| `STUDIO_AI_USER_PER_10MIN` | 8 | requests one person may make per 10 minutes | no |
| `STUDIO_AI_USER_PER_DAY` | 60 | requests one person may make per day (UTC) | no |
| `STUDIO_AI_GLOBAL_PER_HOUR` | 100 | requests everybody together may make per hour | no |
| `STUDIO_AI_DAILY_REQUESTS` | 150 | model calls per UTC day, in total | no |
| `STUDIO_AI_DAILY_TOKENS` | 3000000 | estimated tokens (input plus output) per UTC day, in total | no |
| `STUDIO_AI_MAX_BODY_BYTES` | 16000 | largest request from the browser | no |
| `STUDIO_AI_MAX_INPUT_CHARS` | 120000 | largest amount of site text sent in one request (the whole site is about 90,000 today) | no |
| `STUDIO_ASK_CLAUDE_URL` | derived | the address of the "Ask Claude" new-request page in the content editor, if it is not `<site>/admin/#/collections/requests/new` | no |

The daily limits are counted **in memory by each running copy of the API**. On a host that starts several copies at once, every copy counts alone, so the real ceiling is the limit times the number of copies. The spend limit you set in the Anthropic console (step 1 below) is the real ceiling; the numbers here are a second, softer one. `studio/sql/002_studio_ai.sql` is an optional, never-applied way to share one counter.

**Turn it on safely (five steps, about ten minutes).**

1. In the Anthropic console (console.anthropic.com), create an API key for COVERED only, and set a **monthly spend limit** on the account or workspace first (for example the amount you are happy to lose in a bad month). The key is shown once: copy it.
2. On the API host, add `STUDIO_AI_API_KEY` as a **secret** (the same place as `GITHUB_APP_PRIVATE_KEY`). Never put it in the website, in a file in the repository, in Netlify's site settings, or in a chat.
3. Add `STUDIO_AI_ENABLED` = `1` on the API host and restart or redeploy it.
4. Open Studio, then **Describe a change**. It should say AI help is on and show today's allowance. If it says "not connected yet", the key is missing; if it says "switched off", `STUDIO_AI_ENABLED` is not `1`.
5. Once, on your own computer: `STUDIO_AI_API_KEY=... npm run studio:ai-eval -- --live` (PowerShell: `$env:STUDIO_AI_API_KEY="..."; npm run studio:ai-eval -- --live`). It asks the real model the same questions as the sample requests, against a copy of the site in memory, and checks every answer with the same rules. Nothing on the live site or on GitHub is touched. Read the output. It uses at most 60 requests (about the price of one busy day) and it never prints the key.

**What it costs.** You pay Anthropic for the text sent and received (tokens). A request sends the editable text of the whole site, about 90,000 characters, which is roughly 25,000 tokens, and gets back 300 to 3,000 tokens (a Welsh translation of the FAQ is at the top of that range). Studio does not know Anthropic's current prices and does not state them: look up the price per million tokens of your model on the Anthropic pricing page and compute `requests x (25,000 x input price + 2,000 x output price) / 1,000,000`. Illustration only, with made-up prices of 3 and 15 dollars per million tokens: one request is about 10 pence, ten a day is about a pound, and the hard daily stop at the default 150 requests would be about 15 pounds on a day someone hammers it. The spend limit from step 1 is what actually protects you. If cost matters, lower `STUDIO_AI_DAILY_REQUESTS`, or choose a smaller model with `STUDIO_AI_MODEL`.

**Switch it off, at once.** Set `STUDIO_AI_ENABLED` to `0` (or delete it) and restart or redeploy the API. The panel then says "AI help is switched off", the model is never called, and nothing else in Studio changes. Drafts already saved stay as they are.

**Rotate the key.** Create a new key in the Anthropic console, replace `STUDIO_AI_API_KEY` on the API host, redeploy, delete the old key in the console. If you think it leaked, delete the old key first.

**What leaves the site.** Each request sends Anthropic the editable text of the site (words, labels, current values: the same words anyone can read on the live site, plus text on draft pages) and the person's instruction. In alt-text mode it also sends the one picture being described (from the repository, never from the browser), unless `STUDIO_AI_VISION=0`. It never sends passwords, keys, the email addresses of the people using Studio, code, or settings. Check Anthropic's data-retention terms for the account you use and decide whether you are happy with them.

**Review once before you turn it on.** The voice the model is told to write in is in `studio/api/ai/brand-voice.js` (taken from `CANON.md`, `BRIEF.md` and the site copy), and what counts as "where visitors go" (so it is flagged and unticked by default) is in `studio/api/ai/policy.js`. Read both and change them if they are wrong.

**If AI help misbehaves.** Everything it does ends up as a normal draft pull request. Discard the draft, or after publishing use History, Restore. The audit log (the host's log, lines starting `studioAudit`) shows who asked, when, how many tokens, what the outcome was and a hash of the request, but never the request text or the key.

### 5. Deploy the API (one adapter)

The API is one portable function with three thin adapters. Pick **one** host:

* **Netlify Function:** the entry is `studio/api/deploy/netlify-functions/studio.mjs` (it re-exports `studio/api/adapters/netlify.mjs`). Netlify only finds functions in a folder you name, so add this to `netlify.toml` yourself (Studio never edits it):

  ```
  [functions]
    directory = "studio/api/deploy/netlify-functions"
    node_bundler = "esbuild"
  ```

  The folder holds only that one file on purpose, so the Node and Cloudflare adapters are never picked up as functions. Netlify bundles the API and the generated schema (`npm run studio:schema` keeps `studio/schema/studio-schema.json` current). It answers on `/api/studio/*`, so set `STUDIO_BASE_PATH` to `/api/studio`. Put the other settings from step 4 in the Netlify site settings.
* **Cloudflare Worker:** `studio/api/adapters/cloudflare.mjs`. Copy `studio/api/deploy/wrangler.example.toml` to a `wrangler.toml` of your own, fill in the variables, add the secrets with `wrangler secret put`, then `wrangler deploy`. Set `STUDIO_BASE_PATH` to whatever route prefix you give the Worker (empty if it has its own address).

Check it: open `<API address>/v1/preview-config` in a browser. You should see a small JSON with `"apiVersion":1` and no secrets.

#### Preview addresses: who may receive a sign-in

A deploy preview address matches the template for every pull request number, including pull requests opened by strangers on a public repository. Studio therefore never hands a sign-in token to an address on the strength of the template alone. Before the login page posts the token, the API checks that the pull request behind that address is **open and from this repository, not a fork** (`GET /v1/preview-origin`). Do these two things as well, in Netlify (Site configuration, Build and deploy):

1. Under **Deploy Previews**, choose "Any pull request against your production branch" only if fork pull requests are not built, and make sure **"Deploy previews from forks"** (or the equivalent "Do not build pull requests from forks") is **off**. Better still, choose "None" and use branch deploys of this repository's own branches.
2. Never put secrets (`GITHUB_*`, `SUPABASE_*` keys) in the **Deploy Preview** environment of the website site. Only `STUDIO_API_URL` and `STUDIO_APP_URL` belong there, and they are public.

If a preview address is not trusted, the sign-in window says "This sign-in page can't be opened from there" and no token is sent.

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
6. If you turned AI help on (4b): run `npm run studio:ai-eval` (it is part of `npm run check`: 20+ sample requests give valid patches, 14+ hostile answers are all refused, every AI draft is undone by Restore) and, once, `npm run studio:ai-eval -- --live` with your key. In Studio, ask for a small change, untick one part, save, and look at the pull request: it carries the label `studio-ai`, a "Drafted with AI" section, and only data and page files.

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
* **Stop AI help right now:** set `STUDIO_AI_ENABLED` to `0` (or remove it) on the API host and redeploy. The panel says AI help is switched off and the model is never called. Studio itself carries on. To also cut the money tap, delete the key in the Anthropic console.
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
