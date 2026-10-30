"use strict";
// GitProvider interface (DESIGN 8.1) + the guards every implementation calls INSIDE its write methods.
// Portable (no node: modules): github.js imports this too.
//
//   getHead(branch) -> {sha}|null                 readTextFile(ref,path) -> string|null   readFileBytes(ref,path) -> Uint8Array|null
//   hasFile(ref,path) -> bool                     listDir(ref,dir) -> [name]|null          (added: permalink checks, DEVIATIONS)
//   createBranch(name, fromSha)                   commitFiles({branch,expectedHeadSha,message,files:[{path,text?|bytes?}]}) -> {sha}
//   resetBranch(branch, sha, expectedHeadSha)     openPr({head,base,title,body,labels,draft}) -> Pr      updatePr(n,{title?,body?,labels?}) -> Pr
//   getPr(n) -> Pr|null                           listPrs({headPrefix,state}) -> [Pr]    markReady(n)    closePr(n, comment)    deleteBranch(name)
//   merge(n,{method:"squash",sha}) -> {sha}       listMerged({limit,cursor}) -> {items,next}   getMergedPr(n) -> item|null
//   findCommitByTrailer(branch, key, value) -> {sha}|null     getBaseBranch() -> "main"
//   changedFiles(a, b) -> [path] changed between the merge base of a and b, and b   prUrl(n) -> string       (both added by unit B, see NOTES-api.md)
//
// Pr = { fromFork,number,url,state:"open"|"closed",draft,merged,headRef,headSha,baseSha,behindBase,mergeable,labels,authorLogin,title,body,checks:{state,failing[]},mergeCommitSha }
// Merged item = { number,title,body,mergedAt,mergeSha,parentSha,authorLogin,mergedByLogin,headRef,files:[path],labels }

const { assertInScope, assertStudioBranch, ScopeError } = require("../../../validate/scope");

const REQUIRED_CHECKS = ["Build and guards", "studio-scope"];
const METHODS = ["getHead", "readTextFile", "readFileBytes", "hasFile", "listDir", "createBranch", "commitFiles", "resetBranch", "openPr", "updatePr", "getPr", "listPrs", "markReady", "closePr", "deleteBranch", "merge", "listMerged", "getMergedPr", "findCommitByTrailer", "getBaseBranch", "changedFiles", "prUrl"];

class GitError extends Error {
  constructor(code, message, details) { super(message); this.name = "GitError"; this.code = code; this.details = details || {}; }
}

// ---- guards (a provider refuses these even if a route forgets to) -------------------------------------------
function guardBranchWrite(name) {
  assertStudioBranch(name);
}
function guardFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new GitError("bad_request", "no files to commit");
  for (const f of files) {
    assertInScope(f.path, ["data", "page", "image"]);
    if ((f.text === undefined) === (f.bytes === undefined)) throw new GitError("bad_request", "a file needs exactly one of text or bytes");
  }
}
function guardPrCreate({ head, base }, baseBranch) {
  assertStudioBranch(head);
  if (base !== baseBranch) throw new ScopeError("pull requests may only target " + baseBranch, base);
}

// Summarise the required checks from check runs [{name,status,conclusion}] and commit statuses [{context,state}].
function summarizeChecks(runs, statuses, required) {
  const req = required || REQUIRED_CHECKS;
  const byName = new Map();
  for (const r of runs || []) byName.set(r.name, r.status !== "completed" ? "pending" : /^(success|neutral|skipped)$/.test(r.conclusion || "") ? "success" : "failure");
  for (const s of statuses || []) if (!byName.has(s.context)) byName.set(s.context, s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure");
  if (!byName.size) return { state: "none", failing: [] };
  const failing = [];
  let pending = false;
  for (const n of req) {
    const st = byName.get(n);
    if (st === "failure") failing.push(n);
    else if (st !== "success") pending = true;
  }
  for (const [n, st] of byName) if (st === "failure" && !req.includes(n)) failing.push(n);
  if (failing.length) return { state: "failure", failing };
  return { state: pending ? "pending" : "success", failing: [] };
}

// commit-message trailers: "Key: value" lines in the last paragraph
function trailerValue(message, key) {
  const re = new RegExp("^" + key.replace(/[^A-Za-z0-9-]/g, "") + ": (.+)$", "m");
  const m = re.exec(String(message || ""));
  return m ? m[1].trim() : null;
}

module.exports = { REQUIRED_CHECKS, METHODS, GitError, guardBranchWrite, guardFiles, guardPrCreate, summarizeChecks, trailerValue, ScopeError };
