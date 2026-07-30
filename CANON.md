# CANON — COVERED visual system

Palette (locked, client decree 2026-07-30): violet `#472549` (ink + dark surfaces),
orange `#F0820B` (accent; `#B85800` deep for AA text/buttons, `#8A4A08` dark for
kickers/focus), lavender `#B49CDB` (bands `#E7DEF5`, canvas `#F6F1FB`), grass
`#B9A00F` (marquee, states; `#6E5E08` dark text variant). White = neutral ground
only. Logo asset colours (`#3A5641`/`#94AB8D`/`#F0A35C`) are fixed and exempt.
Fonts: Motor (display), Open Sauce One (body), Rumble Brave (script accents only).

## Signature system (engagement 2026-07-30, seed 42)

### 1. The brand period — `.brand-period`
Every display line that ends in a full stop gets that full stop in the brand
accent (JS progressive enhancement; band-aware colour: deep orange on light,
vivid orange on violet, deep violet on the lavender/orange bands).

- **Decision**: the terminal full stop of display type is a brand asset, coloured
  as the logo's own dot.
- **Reason**: strategy "Matter-of-fact. Period." — the voice already writes short
  declaratives; the logo already ends in an orange dot; the pun (full stop =
  period) destigmatizes by stating, not whispering.
- **Rejection**: NOT an appended decorative dot (titles already end in "."), NOT a
  mascot/sticker system, NOT more colour blocking. It is punctuation doing brand
  work.
- **Citations**: https://raggededge.com/partnerships/eager (brand built on "Tell
  the truth" — radical matter-of-factness as platform);
  https://raggededge.com/partnerships/monzo ("most distinctive asset… even
  hotter" — intensify the owned asset instead of adding new ones).

### 2. Dispense motion — `.reveal`
- **Decision**: scroll-reveals drop from above and settle
  (`cubic-bezier(0.3, 1.3, 0.5, 1)`), replacing the rise-up fade.
- **Motion source**: the demo machine's own `packDrop` — the pack falling into
  the dispenser tray. Same easing, so the whole page moves like the product.
- **Rejection**: NOT stock fade/slide-up (the default register), NOT parallax.
- **Citation**: https://www.instrument.com/work/electronic-arts ("motion wasn't
  just an add-on; it was a mindset").
- Reduced-motion + print paths unchanged (both neutralize `.reveal`).

### 3. The receipt — `.receipt`
- **Decision**: a printed till receipt in the model band: pads £0.00, tampons
  £0.00, judgement none, total £0.00, "paid in full by brands that get it",
  barcode, script sign-off.
- **Reason**: the model IS a transaction someone else settled; a receipt is the
  universal proof-of-payment artifact — it makes "Brands pay. You don't."
  physically legible.
- **Rejection**: NOT an infographic, NOT another stat card; a receipt from the
  brand's own world (a dispenser prints/logs transactions).
- **Citations**: https://raggededge.com/partnerships/wise ("The World's Money" —
  the money system made tangible);
  https://wearecollins.com/case-studies/sweetgreen (cultural-permission reframe).

### Colour record (no palette change)
- **Name/job**: "Full-Stop Orange" — terminal punctuation + logo dot.
  **Derivation**: the logo's own orange full stop after COVERED.
  **Rejection**: rejects reflex-blue SaaS accenting and the pink/red period-care
  category default. Band-aware shades keep ≥3:1 on every surface.

### Typography waiver
No new typeface decision. Motor / Rumble Brave / Open Sauce are licensed,
brand-book-mandated faces (client HARD constraint) — the Google-Fonts mandate
applies to new type decisions, none of which this engagement makes.

## Engine validation (2026-07-30, engine v2026.07.12.1 via bun 1.3.14)
- `route` → `engage` / `web` ✓
- `run` (seed 42, 4 records) → `status: success`, **0 violations**, coverage
  `uncovered: []` — all rationale/citation/colour/motion gates passed. The
  engine's seeded operator pick for seed 42 (lateral-thinking + scamper)
  matched the manually documented selection.
- `unique` (6 probes, live landscape search recorded) → **`oneOfAKind`**,
  0 violations, 0 fixMoves.
- Open item: the `judge` visual-judgement workflow still needs a perception
  pass (session screenshot tooling was down; DOM/computed-style verification
  was used instead — 12 brand-period nodes ≥3:1 per band, receipt rendered,
  reduced-motion path intact).

## Kill-list (converge stage)
1. **Custom orange-dot cursor** — a11y cost, no provenance beyond novelty.
2. **Dispenser-POV copy** ("I live in the loo at…") — fights CMS-owned voice.
3. **Skewed/tilted section bands** — fights the grid-paper school-notebook base;
   mobile legibility cost.
4. **Stamp-perforation partner slots** — postal stamps have no provenance in
   COVERED's world; decoration, not derivation.
