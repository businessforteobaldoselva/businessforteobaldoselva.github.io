"use strict";
// Node http adapter (tests, studio:dev, any VM). Thin: IncomingMessage -> Request -> handler -> ServerResponse.
//   * the client address comes from the socket, and any inbound x-studio-client-ip header is thrown away
//   * the request URL's host is built from the SOCKET's local address, not the Host header, so a client cannot talk its
//     way past the dev-auth "localhost only" rule by sending Host: localhost to a publicly bound server

const http = require("http");
const { Readable } = require("stream");

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function toRequest(req) {
  const local = req.socket.localAddress || "";
  const host = LOOPBACK.has(local) ? "localhost" : local.indexOf(":") >= 0 ? "[" + local + "]" : local;
  const url = "http://" + host + ":" + req.socket.localPort + req.url;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === "x-studio-client-ip") continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  headers.set("x-studio-client-ip", req.socket.remoteAddress || "unknown");
  const method = req.method || "GET";
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") { init.body = Readable.toWeb(req); init.duplex = "half"; }
  return new Request(url, init);
}

function createNodeServer(handler) {
  return http.createServer(async (req, res) => {
    try {
      const r = await handler(toRequest(req));
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":{"code":"internal","message":"Something went wrong."}}');
    }
  });
}

module.exports = { createNodeServer, toRequest };
