# COVERED Website Enhancement Plan — v1 for review

Draft 2026-08-06. Not committed to the live repo until Teo approves.
Tools: **Gemini** (all image generation) · **Kling AI** (all video) ·
Claude Code (build) · WMA workflows (Business/web-motion-academy/ notes).

Design law we follow throughout (from the WMA design system + our brand):
**one spectacle between calm sections · motion must mean something (dispense,
reveal, relief) · Warm Orange as punctuation only · real content, never
placeholder · mobile fallback + reduced-motion for every move · one section at
a time, audit after each.**

---

## PHASE 1 — Brand asset production (no layout risk, do first)

### A. The "How it works" story set — 4 Gemini images
The four-image narrative strip (already spec'd in detail in our earlier
descriptions, rewritten for COVERED):
1. **Spot it** — cream/peach dispenser on tiled bathroom wall, "FREE PERIOD
   PRODUCTS" in forest green, flat-line pad/tampon illustrations in orange +
   olive, COVERED. lockup, QR + orange glow strip
2. **Scan and join** — hand holding phone scanning the dispenser screen
   ("Scan to unlock" on cream screen)
3. **Get your product** — macro corner shot: COVERED. lockup + "FREE. ALWAYS."
   orange badge, product pack peeking from tray
4. **Perks incoming** — person on sofa smiling at phone, warm room with
   peach/olive props, orange notification bubble with the leaf mark
Style locks for all four: same lighting direction, same palette
(#FFECD3/#2F4D19/#FC7130/#E2F099), photographic, no readable third-party text.

### B. Replace stock photography — ~6 Gemini images
Current stock (friends-laughing, students-campus, pads-beige, tampon-coral)
is off-palette. Regenerate in brand: dispenser in a pub loo / university
campus corridor / gym; plastic-free product flat-lay on peach; hands taking a
pack from the tray. (People OK in scene-setting shots; NEVER fake
testimonials/founder photos.)

### C. Social share card (OG image) — Gemini + overlay
Still the single most visible off-brand asset (old branding, used by WhatsApp/
LinkedIn embeds + schema.org logo). 1200×630: cream field, dispenser render
right, "Free period products. Paid for by advertising." + COVERED. lockup.

### D. Mobile hero video — Kling (K1)
Hero currently reuses landscape frames on phones. Per WMA T3: portrait 9:16
version — Gemini-outpaint our existing start/end frames to portrait → Kling
start+end → ffmpeg `scale=800` → `/frames/mobile/` → hero picks set by
viewport. Master Prompt workflow, 2–3 takes, judge first/last seconds.

**Phase 1 output:** an /images refresh + mobile hero + OG card. Effort M.

---

## PHASE 2 — Home page, section by section

Order below = page order. (S/M/L = effort.)

1. **Hero** (have: scroll-scrub dispenser) — polish only: first-frame poster
   for instant paint, preload hints, brand-period on headline. S
2. **Marquee** — keep (olive strip is our calm rhythm-keeper). –
3. **Problem → "The Manifesto"** — REBUILD as WMA *Scroll Text Reveal*: the
   period-poverty statement brightens word-by-word as you scroll (forest green
   text on cream, key figures flip to orange as they light). Emotional core of
   the page; costs no images. Adapt from WMA prompt №14 to vanilla JS. M
4. **Stats (in problem/vision)** — add WMA *Animated Stat Numbers*: iOS-style
   per-digit tickers for "1 in 10", "137,700 girls missed school", machine
   counts. Reusable micro-component, CMS-fed values. S/M
5. **Model "Brands pay. You don't."** — keep loop + conveyor + receipt
   (signature). Swap the collage photo for Phase-1 story set image #3. S
6. **How it works** — keep the interactive demo machine (nobody else has it),
   add the 4-image story strip (Phase 1A) as a horizontal band above it,
   captions in Rumble Brave. M
7. **Brands (dark section)** — add count-up stats (dwell time, gratitude
   moments); add one Kling asset (K2): short loop of the dispenser screen
   rotating brand ads in situ, played inline (not scroll-scrubbed — this
   section stays calm). M
8. **Partners** — keep wall; founding-partner card gets WMA *Fan-Out Card*
   hover (prints fan out = their campaign shots). Desktop-only garnish. S
9. **Venues** — keep copy; swap imagery to Phase-1 venue set; add a compact
   3-step "host a unit" using WMA *Process Steps* pattern (sticky image left,
   steps scroll right; static stack on mobile). M
10. **Locations/map** — keep (it's already a distinctive asset). Tick the
    "coming soon" pins count with the stat ticker. S
11. **Vision** — THE new spectacle: horizontal timeline (WMA *Horizontal
    Projects Showcase* adapted): Exeter pilot → 20 machines → UK-wide, with
    live counter "01/03" and progress bar. Desktop pinned, mobile = vertical
    cards (existing milestones). This replaces the static milestone row. L
12. **FAQ** — keep accordion; no change. –
13. **CTA** — keep calm violet→forest banner. Optional later: pre-CTA
    full-bleed Kling moment (pack drops into tray → "We got you covered.
    Period.") using the /scroll/ pinned variant we already built. Parked. –

Spectacle rhythm check (rule one): Hero(spectacle) → marquee/problem-manifesto
(calm-ish) → model(calm) → how(demo, medium) → brands(calm) → partners(calm) →
venues(calm) → map(calm) → **vision timeline(spectacle)** → FAQ → CTA. ✔

---

## PHASE 3 — Site-wide feel

14. **Slide-up page transitions** — WMA T5 rethought for our static MPA:
    cross-document View Transitions API (`@view-transition` CSS rule — no
    framework needed on Eleventy, Chrome/Safari support, graceful fallback
    elsewhere). New page slides up over the old on nav to /about/, /privacy/.
    S/M
15. **About page rethink** — currently the weakest page. New structure:
    letter-style intro from Amelia (real photo or none — no AI people for
    founders) → mission manifesto (reuse Scroll Text Reveal) → "the model in
    30 seconds" (receipt + 3 steps) → milestones → CTA to partner/host. M
16. **Privacy** — typography pass + brand periods only. S
17. **New dedicated landing pages (optional, needs decision):** /brands and
    /venues as standalone pitch pages (currently only home sections). Better
    for ad campaigns + sharing with a specific pub/brand. Reuses home
    sections via the CMS page builder. M each

---

## Guardrails (every phase)
- One section per Claude Code prompt; check desktop + mobile width after each.
- All new sections = CMS page-builder blocks (toggleable in homepage.json,
  colours from theme.json, motion respecting motion.json + reduced-motion).
- WMA prompts are React/GSAP — always adapt: "rebuild as vanilla JS/CSS for my
  Eleventy site, using this code as the spec."
- AA contrast sweep + old-palette regression grep before every push.
- Sync github.io mirror after each phase; keep Netlify hands-off (dashboard
  only, no CLI).
- Kling: master-prompt workflow, 2–3 takes, frames ≤300/set, ≤40MB videos.

## Suggested sequence & review gates
| Phase | Contents | Effort | Review gate |
|---|---|---|---|
| 1 | Assets (Gemini set, OG, mobile hero) | M | Teo approves images before they go on-site |
| 2 | Home sections 3,4,5,6 (manifesto, tickers, story strip) | M | Look at localhost/Netlify preview |
| 2b | Home sections 7,8,9,11 (brands loop, fan-out, venue steps, vision timeline) | L | Same |
| 3 | Transitions + About + Privacy | M | Same |
| 3b | /brands + /venues landing pages | M | Decide if wanted |

Open questions for Teo:
1. Vision timeline as the second spectacle — yes, or keep vision calm?
2. /brands and /venues standalone pages — build in this round?
3. Mobile hero: portrait Kling video worth the credits, or reuse landscape?
4. Any real photography coming (Amelia, real machine prototype)? Slots exist.
