# Preview access: research note (Phase 1, item 1 is a spike; no code, no setting changed)

Written by the REVIEW unit. Decision 1 is Teo's. Facts were read from the vendor pages linked below on 2026-11-22; anything marked
"unverified" was not on those pages.

## The problem

Draft previews are Netlify deploy previews of pull requests, and while the site is unlaunched they sit behind a Netlify login that
founders do not have. A founder who is sent a review link (or who wants to look at her own draft) hits a login wall. Acceptance for
the fix: a founder opens her own draft link on a phone in under 5 minutes without an account on anything new, and a guessed
address of somebody else's draft returns 401 or a login, never the page.

## Options

1. **Keep the Netlify login and write a first-time guide.** Netlify's team-login protection lets only team members (Developers, Team
   Owners, Billing Admins) in; it can use SSO. The page says team login is an Enterprise feature and that Git contributors cannot
   use it. [Netlify site protection](https://docs.netlify.com/manage/security/secure-access-to-sites/site-protection/)
2. **Netlify shared password on previews only.** The same page lists a "universal password" and a scope limited to previews and
   branch deploys. Password protection is "available on all Pro plans"; whether previews-only scope is Enterprise-only is
   ambiguous on the page (unverified: check the plan screen).
3. **Cloudflare Pages previews behind Cloudflare Access.** Previews are public by default; an access policy can be switched on for
   preview deployments only, limiting them to people in the Cloudflare account (members can be added).
   [Cloudflare previews](https://developers.cloudflare.com/pages/configuration/preview-deployments/) The page does not state Access
   pricing (unverified). This also means moving the preview build off Netlify.
4. **A Worker that serves the built preview itself from a CI artifact.** The Studio API Worker already checks the sign-in token; a
   second route could serve files for `draft N` only to a signed-in person who owns it or is an approver. It matches the plan best
   (per-draft authorisation, no new vendor login) but is the most new code and needs CI to publish the build as an artifact.
   Unverified: size limits of Worker static storage for a built site (images are heavy).
5. **Unguessable preview addresses plus noindex.** Cheap, but the plan says never rely on guessability: links leak through chat
   history, mail and screenshots, so this fails the "guessed other-draft URL returns 401" test.

## What each option needs from Teo

- 1: a first-time guide (we can write it); each founder creates a Netlify account and Teo adds them to the team (cost depends on the
  plan; team login is Enterprise per the page). Ongoing: adding people.
- 2: a Pro plan (money), one shared password handed to founders; it cannot tell people apart.
- 3: moving preview builds to Cloudflare Pages, adding founders as Cloudflare members, a build change. Ongoing: member list.
- 4: no new account for founders; Teo deploys one more Worker route and a CI step; some engineering time. Ongoing: little.
- 5: nothing, but does not meet the acceptance test.

## Risks

- A review link names a draft, not a person: whoever can open the link and is signed in as an approver can approve. The link alone
  grants nothing without Studio sign-in; preview access is a separate door.
- A shared password (option 2) leaks easily and cannot be revoked per person.
- Option 3 and 4 add build or storage cost; option 1 adds a paid plan. Option 4 could expose drafts if the authorisation check has a
  bug, so it needs the same selftest-proven guard as the rest of Studio.
- Side-by-side review in Studio stays off (`STUDIO_PREVIEW_EMBED=0`) until previews are reachable by founders.

## Recommendation

Option 4 as the destination, option 2 as the stop-gap. Smallest first step: if a Pro plan is acceptable, switch on the Netlify
password for previews only and write the one-page guide (about 30 minutes, no code); decide on the Worker route afterwards. Option 1
only if an Enterprise plan already exists.

Settings once chosen (names only; values come from Teo, never written to the repo):

- `STUDIO_PREVIEW_URL_TEMPLATE`: the draft address with `{pr}`, for example `https://deploy-preview-{pr}--<site>.netlify.app`.
- `STUDIO_SITE_URL`: the live site's https address, for the "live page" link.
- `STUDIO_PREVIEW_EMBED`: set to `1` only after founders can open previews.
