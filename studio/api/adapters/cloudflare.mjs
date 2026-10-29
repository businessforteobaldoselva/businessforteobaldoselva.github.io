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
};
