// Cloudflare Workers adapter. Thin: no logic. NOT deployed by anyone yet (studio/README.md lists the manual steps).
// Secrets go in with `wrangler secret put`; plain variables in wrangler.toml [vars]. STUDIO_BASE_PATH is the route prefix.
import schema from "../../schema/studio-schema.json" with { type: "json" };
import api from "../boot.js";

let handler = null;

export default {
  async fetch(req, env) {
    if (!handler) handler = api.boot(env, { schema });
    const headers = new Headers(req.headers);
    headers.delete("x-studio-client-ip");
    headers.set("x-studio-client-ip", req.headers.get("cf-connecting-ip") || "unknown");
    return handler(new Request(req, { headers }));
  },
  // Cron trigger (wrangler.toml [triggers]). A Supabase free project pauses after about a week without requests and Studio
  // stops working; one cheap REST call through the project's API (a read the anonymous role may not even see) keeps it awake.
  async scheduled(_event, env, ctx) {
    const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) || !env.SUPABASE_ANON_KEY) return;
    const doFetch = (...a) => fetch(...a);
    ctx.waitUntil(doFetch(base + "/rest/v1/studio_roles?select=id&limit=1", { headers: { apikey: env.SUPABASE_ANON_KEY } })
      .then((r) => console.log("supabase keep-alive: HTTP " + r.status), (e) => console.log("supabase keep-alive failed: " + (e && e.message))));
  },
};
