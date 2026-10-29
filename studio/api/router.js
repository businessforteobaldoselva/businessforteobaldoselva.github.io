"use strict";
// Minimal router: exact method + path patterns with :params. Portable.

function compile(path) {
  const names = [];
  const src = path.split("/").map((seg) => {
    if (seg.startsWith(":")) { names.push(seg.slice(1)); return "([^/]+)"; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { re: new RegExp("^" + src + "/?$"), names };
}

function createRouter(routes) {
  const table = routes.map((r) => Object.assign({}, r, compile(r.path)));
  return {
    // -> { route, params } | { methodNotAllowed: true } | null
    match(method, pathname) {
      let pathHit = false;
      for (const r of table) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathHit = true;
        if (r.method !== method) continue;
        const params = {};
        r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch (e) { params[n] = ""; } });
        return { route: r, params };
      }
      return pathHit ? { methodNotAllowed: true } : null;
    },
  };
}

module.exports = { createRouter };
