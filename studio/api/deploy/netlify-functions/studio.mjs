// The ONE file Netlify should treat as a function. It only re-exports the thin adapter (no logic here).
// Not active until a human adds this to netlify.toml (docs/STUDIO-RUNBOOK.md, step 5):
//
//   [functions]
//     directory = "studio/api/deploy/netlify-functions"
//     node_bundler = "esbuild"
//
// Netlify bundles the adapter, the API and the generated schema into the function. The folder holds nothing else on
// purpose: the Node and Cloudflare adapters must never be picked up as functions.
export { default, config } from "../../adapters/netlify.mjs";
