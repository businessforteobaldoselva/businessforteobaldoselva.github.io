# Notes: Phase 1 REVIEW unit

Decisions and deviations are recorded under REVIEW in studio/README.md. Preview-access research: studio/NOTES-preview-access.md.

- describe(op, ctx) in validate/describe.js is the single source of the plain-English lines for the review screen; describeApplied (PR text, Changes panel, History) is unchanged.
- publishBlockers() in api/services/drafts.js is the single source of publish conditions for both the publish route and the review screen.
- Board and review read only; the guard check-review.js proves it and the selftest breaks each promise.
