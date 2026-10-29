"use strict";
// Pure helpers for History / Restore. No I/O.
//   invertDiff(file, before, after) -> ops that turn `after` back into `before`; each carries `expect` = the value
//   `after` has, so applying them to a document that has moved on is detected as a conflict instead of overwriting.

const { diffOps, invertOps } = require("../../validate/diff");

function invertDiff(file, before, after) {
  return invertOps(diffOps(file, before, after));
}

module.exports = { invertDiff };
