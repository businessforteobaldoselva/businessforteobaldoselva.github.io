# On The House — Advertise (extracted template)

## Mission
Create implementation-ready, token-driven UI guidance for On The House — Advertise (extracted template) that is optimized for consistency, accessibility, and fast delivery across e-commerce storefront.

## Brand
- Product/brand: On The House — Advertise (extracted template)
- URL: https://onthehousegroup.com/advertise
- Audience: online shoppers and consumers
- Product surface: e-commerce storefront

## Style Foundations
- Visual style: clean, functional, implementation-oriented
- Main font style: `font.family.primary=Helvetica`, `font.family.stack=Helvetica, Verdana, sans-serif`, `font.size.base=16px`, `font.weight.base=400`, `font.lineHeight.base=24px`
- Typography scale: `font.size.xs=16px`, `font.size.sm=24px`, `font.size.md=36px`, `font.size.lg=80px`
- Color palette: `color.border.default=#000000`, `color.text.secondary=#ffffff`, `color.text.tertiary=#f7f7f7`, `color.text.inverse=#333333`, `color.surface.muted=#c0ff71`, `color.surface.raised=#fd4949`, `color.surface.strong=#cdbcb2`
- Spacing scale: `space.1=4px`, `space.2=8px`, `space.3=16px`, `space.4=20px`, `space.5=28px`, `space.6=180px`
- Radius/shadow/motion tokens: `radius.xs=3px`, `radius.sm=4px`, `radius.md=8px`, `radius.lg=13px`, `radius.xl=20px`, `radius.2xl=30px`, `radius.step7=35px`, `radius.step8=40px` | `motion.duration.instant=200ms`, `motion.duration.fast=350ms`

## Accessibility
- Target: WCAG 2.2 AA
- Keyboard-first interactions required.
- Focus-visible rules required.
- Contrast constraints required.

## Writing Tone
Concise, confident, implementation-focused.

## Rules: Do
- Use semantic tokens, not raw hex values, in component guidance.
- Every component must define states for default, hover, focus-visible, active, disabled, loading, and error.
- Component behavior should specify responsive and edge-case handling.
- Interactive components must document keyboard, pointer, and touch behavior.
- Accessibility acceptance criteria must be testable in implementation.

## Rules: Don't
- Do not allow low-contrast text or hidden focus indicators.
- Do not introduce one-off spacing or typography exceptions.
- Do not use ambiguous labels or non-descriptive actions.
- Do not ship component guidance without explicit state rules.

## Guideline Authoring Workflow
1. Restate design intent in one sentence.
2. Define foundations and semantic tokens.
3. Define component anatomy, variants, interactions, and state behavior.
4. Add accessibility acceptance criteria with pass/fail checks.
5. Add anti-patterns, migration notes, and edge-case handling.
6. End with a QA checklist.

## Required Output Structure
- Context and goals.
- Design tokens and foundations.
- Component-level rules (anatomy, variants, states, responsive behavior).
- Accessibility requirements and testable acceptance criteria.
- Content and tone standards with examples.
- Anti-patterns and prohibited implementations.
- QA checklist.

## Component Rule Expectations
- Include keyboard, pointer, and touch behavior.
- Include spacing and typography token requirements.
- Include long-content, overflow, and empty-state handling.
- Include known page component density: cards (207), buttons (47), links (33), inputs (8), navigation (1).

- Extraction diagnostics: Audience and product surface inference confidence is low; verify generated brand context.

## Quality Gates
- Every non-negotiable rule must use "must".
- Every recommendation should use "should".
- Every accessibility rule must be testable in implementation.
- Teams should prefer system consistency over local visual exceptions.
