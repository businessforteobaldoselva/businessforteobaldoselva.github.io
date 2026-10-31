"use strict";
// Preloaded (node --require) by the unit tests and the replay evaluation: NOTHING may leave the machine. Constraint: "no network
// in CI". Loopback (127.0.0.0/8, ::1, localhost, a pipe or a unix socket) stays open because tests start local mock servers; every
// other connection, and every DNS lookup of a name other than localhost, throws before a packet is sent.
//
// This is a runtime guard on purpose: a source scan cannot see a call that is built from a variable, a library, or a copied
// helper, and it fails open. check-ai.js proves the guard works (D10) and that the test runner really loads it (S7).

const net = require("net");
const dns = require("dns");

const LOOP = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|0\.0\.0\.0|::ffff:127(?:\.\d{1,3}){3})$/i;
const blocked = (host) => {
  const e = new Error("network is not allowed in tests and CI (tried to reach " + String(host).slice(0, 80) + "). Inject a fake fetch instead.");
  e.code = "ENETBLOCKED";
  return e;
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0]; // net normalises its arguments into [options, cb]
  if (a && typeof a === "object") {
    if (a.path) return connect.apply(this, args); // a pipe or unix socket
    if (a.host !== undefined && a.host !== null && !LOOP.test(String(a.host))) throw blocked(a.host);
    if ((a.host === undefined || a.host === null) && a.port !== undefined) return connect.apply(this, args); // net's default host is localhost
  } else if (typeof a === "string" && !/^\d+$/.test(a)) {
    return connect.apply(this, args); // net.connect(path)
  }
  return connect.apply(this, args);
};

for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
  const orig = dns[name];
  dns[name] = function guardedDns(host, ...rest) {
    if (typeof host === "string" && !LOOP.test(host)) {
      const cb = rest.find((x) => typeof x === "function");
      const err = blocked(host);
      if (cb) return process.nextTick(cb, err);
      throw err;
    }
    return orig.call(this, host, ...rest);
  };
}
