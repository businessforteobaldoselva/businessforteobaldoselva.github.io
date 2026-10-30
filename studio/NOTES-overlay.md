# Unit C (overlay) notes

Owns: `studio/overlay/**`, `studio/login/**`, `studio/guards/check-overlay.js`, `studio/guards/selftest-c.js`,
`studio/tests/overlay/**`, `scripts/check-studio-overlay.js` (thin entry to the guard; `npm run check:studio` already runs the guard).

Run
- Unit + browser tests: `node --test studio/tests/overlay/*.test.js` (browser tests use puppeteer-core (any place `require` finds it, or STUDIO_PUPPETEER)
  and Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`; they skip when either is missing).
- Static guard: `node studio/guards/check-overlay.js` (or `node scripts/check-studio-overlay.js`).
- Dev harness: `node studio/overlay/dev/stub-server.js` then open `http://localhost:8080/?studio=1` (contract-level stub API,
  dev tokens `dev:<role>:<email>`). Unit B's `studio/dev/server.js` replaces it once merged.
- Bundle: `node studio/overlay/bundle.js --stats`; `require("./studio/overlay/bundle.js").bundle()`.

Deviations
1. `../schema/resolve.js` is not in manifest.json; `core/schema-client.js` carries its own small resolver (unit A's file may
   not exist yet). `../../cms/contrast.js` IS bundled first (reuses the CMS contrast rules, no new code).
2. Focal point: no schema field stores one (DESIGN section 16), so the crop is baked into the uploaded picture (canvas re-encode,
   which also strips EXIF/GPS); drag/arrow-key repositioning is offered.
3. Markdown editor preview is built from DOM nodes (no innerHTML); it is an approximate preview, the server stays authoritative.
4. `ext/*.js` and `ext/ext.css` (unit D) are skipped by the bundler with a warning when absent.
5. puppeteer-core is referenced by path only, not added to package.json.
6. Staged picture bytes are kept in memory (IndexedDB persistence is best effort/not relied on); a reload drops an unsaved picture op.
