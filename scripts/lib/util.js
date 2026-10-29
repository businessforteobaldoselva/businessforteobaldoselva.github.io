"use strict";
// Studio (phase 4): every guard must build the PRODUCTION html, even when the developer's shell has CMS_EDIT=1.
delete process.env.CMS_EDIT;
// Shared helpers for the site guards (scripts/check-*.js). No network, no side effects outside
// the directories a script is told to use.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPTS_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");

// ---------------------------------------------------------------- arguments
// parseArgs(["--site", "x", "--json", "pos"], { site: "string", json: "boolean" })
function parseArgs(argv, spec) {
  const out = { _: [] };
  for (const [k, t] of Object.entries(spec || {})) out[k] = t === "boolean" ? false : t === "list" ? [] : undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    const type = spec && spec[key];
    if (!type) throw new Error("Unknown option " + a);
    if (type === "boolean") out[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error("Option " + a + " needs a value");
      if (type === "list") out[key].push(v);
      else if (type === "number") out[key] = Number(v);
      else out[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- text helpers
const readText = (file) => fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
const readJson = (file) => JSON.parse(readText(file));
const exists = (p) => fs.existsSync(p);

// Collapse every kind of whitespace (including no-break and thin spaces) to one space.
const collapse = (s) => String(s).replace(/[\s  -   　]+/g, " ").trim();
const clip = (s, n) => {
  const t = collapse(s);
  return t.length > (n || 110) ? t.slice(0, (n || 110) - 1) + "…" : t;
};
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- violations
class Report {
  constructor(name) {
    this.name = name;
    this.items = []; // { group, title, detail }
    this.notes = [];
  }
  add(group, title, detail) {
    this.items.push({ group: group || "", title, detail: detail || "" });
  }
  note(line) {
    this.notes.push(line);
  }
  get failed() {
    return this.items.length > 0;
  }
  // Prints every violation (grouped) and a final PASS/FAIL line. Returns the exit code.
  print(opts) {
    const o = Object.assign({ max: 200, okMessage: "OK" }, opts || {});
    for (const n of this.notes) console.log(n);
    if (this.items.length) {
      const groups = new Map();
      for (const it of this.items) {
        if (!groups.has(it.group)) groups.set(it.group, []);
        groups.get(it.group).push(it);
      }
      let shown = 0;
      for (const [g, list] of groups) {
        if (g) console.log("\n== " + g + " (" + list.length + ")");
        for (const it of list) {
          if (shown >= o.max) break;
          console.log("  - " + it.title + (it.detail ? "\n      " + String(it.detail).split("\n").join("\n      ") : ""));
          shown += 1;
        }
      }
      if (this.items.length > shown) console.log("\n  … " + (this.items.length - shown) + " more (use --max <n> to see more)");
      console.log("\n" + this.name.toUpperCase() + " FAILED: " + this.items.length + " violation" + (this.items.length === 1 ? "" : "s"));
      return 1;
    }
    console.log(this.name.toUpperCase() + " " + o.okMessage);
    return 0;
  }
}

// ---------------------------------------------------------------- temp dirs & links
function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Directory link that works for non-admin users on Windows (junction) and elsewhere (symlink).
function linkDir(target, linkPath) {
  const abs = path.resolve(target);
  try {
    fs.symlinkSync(abs, linkPath, "junction");
  } catch (e) {
    try {
      fs.symlinkSync(abs, linkPath, "dir");
    } catch (e2) {
      throw new Error("cannot link " + abs + " into the throwaway copy (" + e2.message + ")");
    }
  }
}

// Remove a directory tree WITHOUT following links: every symlink/junction is unlinked first,
// so a workspace that links back to the real node_modules/images can never delete them.
function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (err) {
        continue;
      }
      if (st.isSymbolicLink()) {
        try {
          fs.unlinkSync(p);
        } catch (err) {
          fs.rmdirSync(p); // Windows junctions are removed like (empty) directories
        }
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function listFiles(dir, filter) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!filter || filter(p)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const toPosix = (p) => p.split(path.sep).join("/");

// Runs a guard's main(): its return value is the exit code; a crash (for example a malformed JSON
// file in scripts/ or a config that does not parse) is reported plainly and also fails the run.
function runMain(name, main) {
  let code = 1;
  try {
    code = main();
  } catch (e) {
    console.error(name + " stopped: " + (e && e.message ? e.message : e));
    if (e && e.stack) console.error(String(e.stack).split("\n").slice(1, 5).join("\n"));
    code = 1;
  }
  process.exit(code);
}

// Entries of an allow-list / ignore-list that matched nothing. Reported as an error with --strict-stale (or
// GUARD_STRICT_STALE=1, used for pull requests): hygiene for developers. By default only noted, because an
// editor who switches a feature off (empties the ticker, removes a form) must not fail the checks.
const strictStale = (args) => !!(args && args.strictStale) || process.env.GUARD_STRICT_STALE === "1";

module.exports = {
  strictStale,
  runMain,
  SCRIPTS_DIR,
  REPO_ROOT,
  parseArgs,
  readText,
  readJson,
  exists,
  collapse,
  clip,
  escapeRegExp,
  Report,
  mkTmp,
  linkDir,
  removeTree,
  listFiles,
  toPosix,
};
