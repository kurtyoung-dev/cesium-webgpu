#!/usr/bin/env node
// verify-tracked-references.mjs — the claim-vs-tree guard for references that
// point OUT of a commit.
// @purpose Asserts every node launch target in package.json/.mcp.json and every relative import in changed .mjs/.cjs/.js files resolves to a path the tree actually tracks.
// @status ACTIVE
//
// WHY THIS EXISTS. Three times in one week a tracked file routed through an
// untracked one, and every time the local machine stayed green while a clone
// would have been broken:
//
//   - `package.json` scripts `generate-tooling-catalog` / `verify-tooling-catalog`
//     were repointed at `Tools/generate-tooling-catalog-launcher.cjs`, which was
//     never added. `npm run verify-tooling-catalog` works here and dies with
//     MODULE_NOT_FOUND in every fresh clone.
//   - `.mcp.json` (itself gitignored) launches `Tools/codex-mcp-launcher.mjs`,
//     also untracked. A gitignored referrer is not an excuse: the launcher is
//     the shared artifact, and a teammate writing their own `.mcp.json` from the
//     documented recipe gets nothing to launch.
//
// Neither instance is visible to a test suite, a build, or a probe — they all
// run against the WORKING TREE, where the file is present. The only thing that
// can see the defect is a check that asks the TREE, not the disk. That is the
// design constraint here, and it is why `--rev` exists: "would this commit work
// in a clone" has to be answerable about a candidate commit, before it is
// pushed.
//
// THE DISPOSITIONS, AND WHY ONE OF THEM IS NOT A FAILURE.
//   UNTRACKED  the target is on disk, git neither tracks nor ignores it. The
//              dangerous case: somebody forgot `git add`, and nothing else in
//              the repository will ever tell them.
//   MISSING    the target is absent from the tree AND from disk. A plainly
//              broken reference — a typo, or a deletion whose referrer was not
//              updated.
//   IGNORED    the target is on disk and matched by a `.gitignore` rule, i.e. a
//              DECLARED build artifact. `packages/engine/index.js` is generated
//              by the build and imported by ~40 engine Specs, so this is
//              reported as an advisory rather than a failure. The declaration is
//              the whole difference from UNTRACKED — and if somebody ever
//              silences this guard by gitignoring a launcher, that shows up as a
//              `.gitignore` diff, which a reviewer can see.
//
// WHAT IS DELIBERATELY OUT OF SCOPE. `new URL("./x.mjs", import.meta.url)`,
// `spawn("node", [path])`, and path strings handed to `readFileSync` are all
// real cross-file references, and none of them are checked: they are
// indistinguishable from ordinary data without evaluating the program, and a
// guard that guesses produces noise, which is how guards get switched off. The
// two reference classes below are the syntactically unambiguous ones — and
// between them they cover both instances that motivated this file. TypeScript
// sources are not scanned (`tsc --noEmit` already resolves them), but a `.js`
// specifier MAY be satisfied by a tracked `.ts` sibling, because that is how
// this repository's TypeScript imports its own modules (`import GraphicsContext
// from "./GraphicsContext.js"` against `GraphicsContext.ts`).
//
// STRING-AWARE, NOT REGEX-OVER-BYTES. Specifiers are found by tokenizing the
// source with the C16 comment scanner and accepting only a string literal whose
// preceding CODE ends in `from` / `require(` / `import(`. A regex over raw bytes
// reports every `from "./x.mjs"` that lives inside a fixture template literal or
// a comment — this repository has several — and each one is a false alarm on a
// guard whose only value is being believed.
//
// CRLF. The checkout is `core.autocrlf=true`. Every pattern here is
// line-ending agnostic (`\s` covers `\r`), nothing splits on a bare "\n" to
// reconstruct text, and line numbers are counted from "\n" occurrences, which is
// correct under both terminators.
//
// USAGE
//   node Tools/verify-tracked-references.mjs              # the working tree
//   node Tools/verify-tracked-references.mjs --rev HEAD   # a candidate commit
//   node Tools/verify-tracked-references.mjs --rev HEAD --json
//
// EXIT CODES (the frozen fleet table, imported — never re-declared)
//   0 PASS        every reference resolves to a tracked path
//   1 FAIL        at least one UNTRACKED or MISSING reference
//   2 ERROR       the guard itself broke, or was handed an argument it cannot read
//   3 STRUCTURAL  not a git repository, or the rev is unreadable, so the guard
//                 has no tree to ask and no standing to report anything

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tokenize } from "./c16/lib/comment-scanner.mjs";
import { exitCodeForS5Status } from "./visual-regression/lib/verdict-exit-gate.mjs";

/** Every git call is bounded; a wedged git must not wedge the guard. */
const GIT_TIMEOUT_MS = 60_000;

/** Whole-run watchdog. The timer body itself exits — it never merely warns. */
const WATCHDOG_MS = 300_000;

/** Buffer ceiling for `git ls-files` on a repository this size. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** Reference dispositions. IGNORED is advisory; see the header. */
export const DISPOSITIONS = Object.freeze({
  MISSING: "MISSING",
  UNTRACKED: "UNTRACKED",
  IGNORED: "IGNORED",
  TRACKED: "TRACKED",
});

/** Config files scanned for `node <path>` launch targets. */
export const LAUNCH_CONFIG_FILES = Object.freeze(["package.json", ".mcp.json"]);

/** Source extensions whose relative imports are resolved. */
const SCANNED_EXTENSIONS = Object.freeze([".mjs", ".cjs", ".js"]);

/**
 * Node CLI flags that take their value as a SEPARATE argv entry.
 *
 * Getting this set wrong lies in both directions: miss a flag and its value is
 * read as the script path, invent one and the real script path is swallowed as
 * a flag value.
 */
const NODE_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--title",
  "--input-type",
  "--test-reporter",
  "--test-name-pattern",
]);

/** Value flags whose value is itself a module reference worth checking. */
const NODE_MODULE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
]);

/** Flags after which node runs an INLINE program and takes no script file. */
const NODE_INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse argv.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{rev: (string|null), json: boolean, help: boolean}} Options.
 * @throws {Error} On an unrecognized argument or a `--rev` with no value.
 */
export function parseArgs(argv) {
  const options = { rev: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--rev") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--rev requires a revision argument");
      }
      options.rev = value;
      i += 1;
    } else if (arg.startsWith("--rev=")) {
      const value = arg.slice("--rev=".length);
      if (value.length === 0) {
        throw new Error("--rev requires a revision argument");
      }
      options.rev = value;
    } else {
      throw new Error(`unrecognized argument ${arg}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Layer 1 — `node <path>` launch targets in config files
// ---------------------------------------------------------------------------

/**
 * Split an npm script into individual commands, honouring quotes.
 *
 * `gulp clean && node scripts/buildWasm.js` is two commands and only the second
 * is a node invocation; `"**\/*.md"` must not be split on its own contents.
 *
 * @param {string} script The script body.
 * @returns {string[][]} One token list per command.
 */
export function splitShellCommands(script) {
  const commands = [];
  let tokens = [];
  let current = "";
  let started = false;
  let quote = null;

  const endToken = () => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };
  const endCommand = () => {
    endToken();
    if (tokens.length > 0) {
      commands.push(tokens);
      tokens = [];
    }
  };

  for (let i = 0; i < script.length; i += 1) {
    const c = script[i];
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      } else if (quote === '"' && c === "\\" && i + 1 < script.length) {
        current += script[i + 1];
        i += 1;
      } else {
        current += c;
      }
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < script.length) {
      current += script[i + 1];
      started = true;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      endToken();
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "(" || c === ")") {
      endCommand();
      continue;
    }
    current += c;
    started = true;
  }
  endCommand();
  return commands;
}

/**
 * Whether a token names a repository file rather than a package or a flag.
 *
 * @param {string} token Candidate token.
 * @returns {boolean} True when it should be resolved against the tree.
 */
function isRepoPathLike(token) {
  if (token.length === 0 || token.startsWith("-")) {
    return false;
  }
  // Shell metacharacters and absolute/drive-letter paths are not
  // repository-relative, so the tree has no opinion about them.
  if (
    /[*?$`<>]/.test(token) ||
    token.startsWith("/") ||
    /^[A-Za-z]:/.test(token)
  ) {
    return false;
  }
  return (
    /\.(?:mjs|cjs|js)$/i.test(token) ||
    token.startsWith("./") ||
    token.startsWith("../")
  );
}

/**
 * Normalize a launch target to a repository-relative posix path.
 *
 * @param {string} token Raw token.
 * @returns {string} Normalized path.
 */
function normalizeRepoPath(token) {
  return path.posix.normalize(token.split("\\").join("/"));
}

/**
 * Extract the file targets of one node invocation.
 *
 * Two node behaviours have to be respected or the extraction lies. Under
 * `--test` EVERY positional is a test file; without it only the FIRST
 * positional is the script and the rest are the script's own arguments — so
 * `node server.js --public` has one target and `node --test a.spec.mjs
 * b.spec.mjs` has two. And after `-e`/`--eval` there is no script file at all.
 *
 * @param {string[]} tokens One command's tokens.
 * @returns {string[]} Repository-relative target paths.
 */
export function nodeTargetsFromCommand(tokens) {
  let nodeIndex = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "node" || token === "node.exe" || token.endsWith("/node")) {
      nodeIndex = i;
      break;
    }
  }
  if (nodeIndex < 0) {
    return [];
  }

  const targets = [];
  let testMode = false;
  let inlineProgram = false;
  let sawSeparator = false;

  for (let i = nodeIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--" && !sawSeparator) {
      sawSeparator = true;
      continue;
    }
    if (!sawSeparator && token.startsWith("-") && token !== "-") {
      const eq = token.indexOf("=");
      const name = eq < 0 ? token : token.slice(0, eq);
      const inlineValue = eq < 0 ? null : token.slice(eq + 1);
      if (name === "--test") {
        testMode = true;
        continue;
      }
      if (NODE_INLINE_FLAGS.has(name)) {
        inlineProgram = true;
        if (inlineValue === null) {
          i += 1;
        }
        continue;
      }
      if (NODE_VALUE_FLAGS.has(name)) {
        let value = inlineValue;
        if (value === null) {
          value = tokens[i + 1];
          i += 1;
        }
        if (
          NODE_MODULE_FLAGS.has(name) &&
          value !== undefined &&
          isRepoPathLike(value)
        ) {
          targets.push(normalizeRepoPath(value));
        }
        continue;
      }
      continue;
    }
    if (inlineProgram) {
      break;
    }
    if (isRepoPathLike(token)) {
      targets.push(normalizeRepoPath(token));
    }
    if (!testMode) {
      break;
    }
  }
  return targets;
}

/**
 * 1-indexed line for a byte offset. Correct under LF and CRLF alike.
 *
 * @param {string} source Text.
 * @param {number} index Offset.
 * @returns {number} Line number.
 */
function lineOfIndex(source, index) {
  let line = 1;
  const limit = Math.min(index, source.length);
  for (let i = 0; i < limit; i += 1) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

/**
 * Line number of the first occurrence of `needle`, or 0 when absent.
 *
 * @param {string} source Text to search.
 * @param {string} needle Literal substring.
 * @returns {number} 1-indexed line, or 0.
 */
function lineOfSubstring(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) {
    return 0;
  }
  return lineOfIndex(source, index);
}

/**
 * Launch targets declared by `package.json` scripts.
 *
 * @param {string} source Raw `package.json` text.
 * @returns {{specifier: string, line: number, detail: string}[]} References.
 */
export function packageScriptReferences(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const scripts = parsed?.scripts;
  if (scripts === null || typeof scripts !== "object") {
    return [];
  }
  const references = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== "string") {
      continue;
    }
    for (const tokens of splitShellCommands(body)) {
      for (const target of nodeTargetsFromCommand(tokens)) {
        references.push({
          specifier: target,
          line: lineOfSubstring(source, `"${name}":`),
          detail: `scripts.${name}`,
        });
      }
    }
  }
  return references;
}

/**
 * Launch targets declared by an MCP server config.
 *
 * The referrer is gitignored, which is precisely why this matters: nothing else
 * in the repository observes the edge, so an untracked launcher on the far end
 * stays invisible until a teammate tries to use the documented server.
 *
 * @param {string} source Raw `.mcp.json` text.
 * @returns {{specifier: string, line: number, detail: string}[]} References.
 */
export function mcpConfigReferences(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const servers = parsed?.mcpServers;
  if (servers === null || typeof servers !== "object") {
    return [];
  }
  const references = [];
  for (const [name, server] of Object.entries(servers)) {
    const args = Array.isArray(server?.args) ? server.args : [];
    const command = typeof server?.command === "string" ? server.command : "";
    const tokens = [command, ...args.filter((a) => typeof a === "string")];
    for (const target of nodeTargetsFromCommand(tokens)) {
      references.push({
        specifier: target,
        line: lineOfSubstring(source, `"${name}":`),
        detail: `mcpServers.${name}`,
      });
    }
  }
  return references;
}

/**
 * Launch targets for one config file.
 *
 * @param {string} filePath Repository-relative path.
 * @param {string} source File text.
 * @returns {{specifier: string, line: number, detail: string}[]} References.
 */
export function launchConfigReferences(filePath, source) {
  const base = filePath.split("/").pop();
  if (base === "package.json") {
    return packageScriptReferences(source);
  }
  if (base === ".mcp.json") {
    return mcpConfigReferences(source);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Layer 2 — relative imports in changed sources
// ---------------------------------------------------------------------------

/**
 * Decode a string/template literal, or `null` when its value is not static.
 *
 * @param {string} raw The literal including its delimiters.
 * @returns {string|null} The value, or null.
 */
function literalValue(raw) {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return null;
  }
  if (raw.length < 2 || raw[raw.length - 1] !== quote) {
    return null;
  }
  const body = raw.slice(1, -1);
  if (quote === "`" && body.includes("${")) {
    return null;
  }
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    if (next === "n") {
      out += "\n";
    } else if (next === "t") {
      out += "\t";
    } else if (next === "r") {
      out += "\r";
    } else if (next === undefined) {
      out += "\\";
    } else {
      out += next;
    }
  }
  return out;
}

/**
 * The code immediately preceding a string literal, comments elided.
 *
 * Comments may legally sit between `from` and its specifier, so they are
 * skipped rather than ending the walk; another string literal DOES end it,
 * because that means this literal is an operand, not a specifier.
 *
 * @param {string} source File text.
 * @param {{kind: string, start: number, end: number}[]} segments Tokenization.
 * @param {number} stringIndex Index of the string segment.
 * @returns {string} Preceding code text.
 */
function precedingCode(source, segments, stringIndex) {
  let text = "";
  for (let i = stringIndex - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment.kind === "string") {
      break;
    }
    if (segment.kind === "comment") {
      continue;
    }
    text = source.slice(segment.start, segment.end) + text;
    if (text.replace(/\s+/g, "").length >= 96) {
      break;
    }
  }
  return text;
}

/** Preceding-code shapes that make the next string literal a specifier. */
const REFERENCE_FORMS = Object.freeze([
  { form: "static", pattern: /\bfrom\s*$/ },
  { form: "require", pattern: /\brequire\s*\(\s*$/ },
  { form: "require.resolve", pattern: /\brequire\.resolve\s*\(\s*$/ },
  { form: "dynamic", pattern: /\bimport\s*\(\s*$/ },
  { form: "import.meta.resolve", pattern: /\bimport\.meta\.resolve\s*\(\s*$/ },
  { form: "bare", pattern: /(?:^|[\s;{}])import\s+$/ },
]);

/**
 * Relative import/require specifiers in a JavaScript source.
 *
 * @param {string} source File text.
 * @returns {{specifier: string, form: string, line: number}[]} References.
 */
export function moduleReferences(source) {
  const segments = tokenize(source, "js");
  const references = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.kind !== "string") {
      continue;
    }
    const value = literalValue(source.slice(segment.start, segment.end));
    if (value === null || !/^\.\.?(?:$|\/)/.test(value)) {
      continue;
    }
    const before = precedingCode(source, segments, i);
    const match = REFERENCE_FORMS.find((entry) => entry.pattern.test(before));
    if (match === undefined) {
      continue;
    }
    references.push({
      specifier: value,
      form: match.form,
      line: lineOfIndex(source, segment.start),
    });
  }
  return references;
}

/**
 * The module system a file is read under.
 *
 * `.js` is ambiguous and this repository genuinely uses both readings: the root
 * `package.json` declares `"type": "module"` while `Tools/package.json`
 * declares `"type": "commonjs"`. The nearest declaration decides, exactly as
 * Node decides it.
 *
 * @param {string} filePath Repository-relative path.
 * @param {(dirPath: string) => (string|null)} readPackageType Nearest-package
 *   `type` lookup for a directory, or null when it declares none.
 * @returns {"esm"|"cjs"} The module system.
 */
export function moduleSystemFor(filePath, readPackageType) {
  const ext = path.posix.extname(filePath).toLowerCase();
  if (ext === ".mjs" || ext === ".mts") {
    return "esm";
  }
  if (ext === ".cjs" || ext === ".cts") {
    return "cjs";
  }
  let dir = path.posix.dirname(filePath);
  for (;;) {
    const declared = readPackageType(dir === "." ? "" : dir);
    if (declared === "module") {
      return "esm";
    }
    if (declared === "commonjs") {
      return "cjs";
    }
    if (dir === "." || dir === "" || dir === "/") {
      return "cjs";
    }
    dir = path.posix.dirname(dir);
  }
}

/**
 * Candidate tree paths a specifier may legitimately resolve to.
 *
 * ESM requires an explicit extension and does no index resolution; CJS allows
 * both. On top of Node's rules a `.js`/`.mjs`/`.cjs` specifier may be satisfied
 * by a tracked TypeScript sibling — the repository's TS sources import each
 * other that way and the emitted `.js` never exists in the tree.
 *
 * @param {string} fromPath Repository-relative path of the referring file.
 * @param {string} specifier The relative specifier.
 * @param {"esm"|"cjs"} moduleSystem Module system of the referring file.
 * @returns {{base: string, candidates: string[], external: boolean}} Resolution.
 */
export function resolutionCandidates(fromPath, specifier, moduleSystem) {
  const dir = path.posix.dirname(fromPath.split("\\").join("/"));
  const base = path.posix.normalize(path.posix.join(dir, specifier));
  if (base === ".." || base.startsWith("../")) {
    return { base, candidates: [], external: true };
  }
  const candidates = [];
  const add = (candidate) => {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };
  add(base);
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -3);
    add(`${stem}.ts`);
    add(`${stem}.tsx`);
    add(`${stem}.d.ts`);
  } else if (base.endsWith(".mjs")) {
    const stem = base.slice(0, -4);
    add(`${stem}.mts`);
    add(`${stem}.d.mts`);
  } else if (base.endsWith(".cjs")) {
    const stem = base.slice(0, -4);
    add(`${stem}.cts`);
    add(`${stem}.d.cts`);
  }
  if (moduleSystem === "cjs" && path.posix.extname(base) === "") {
    for (const ext of [".js", ".json", ".node", ".cjs", ".ts"]) {
      add(`${base}${ext}`);
    }
    for (const name of ["index.js", "index.json", "index.node", "index.cjs"]) {
      add(path.posix.join(base, name));
    }
  }
  return { base, candidates, external: false };
}

// ---------------------------------------------------------------------------
// Tree adapters
// ---------------------------------------------------------------------------

/**
 * Run git, returning stdout.
 *
 * @param {string[]} args Arguments.
 * @param {string} cwd Repository root.
 * @returns {string} stdout.
 */
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Split NUL-delimited git output into entries.
 *
 * @param {string} output Raw stdout.
 * @returns {string[]} Entries.
 */
function splitNul(output) {
  return output.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Which of `paths` git is explicitly ignoring.
 *
 * @param {string[]} paths Repository-relative paths.
 * @param {string} cwd Repository root.
 * @returns {Set<string>} The ignored subset.
 */
export function ignoredPaths(paths, cwd) {
  const ignored = new Set();
  for (const candidate of new Set(paths)) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", candidate], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        stdio: "ignore",
      });
      ignored.add(candidate);
    } catch {
      // Exit 1 means "not ignored"; anything else means git could not answer,
      // and an unanswerable ignore question must not upgrade to "ignored" —
      // that direction would silently downgrade a violation to an advisory.
    }
  }
  return ignored;
}

/**
 * Tree adapter over the working tree: tracked-ness is the git INDEX, content
 * and existence are the disk.
 *
 * @param {string} root Repository root.
 * @returns {object} Tree adapter.
 */
export function createWorktreeTree(root) {
  const tracked = new Set(splitNul(git(["ls-files", "-z"], root)));
  return {
    label: "working tree",
    rev: null,
    tracked,
    read(filePath) {
      const absolute = path.join(root, filePath);
      if (!existsSync(absolute)) {
        return null;
      }
      try {
        return readFileSync(absolute, "utf8");
      } catch {
        return null;
      }
    },
    changedFiles() {
      const entries = splitNul(git(["status", "--porcelain", "-z"], root));
      const changed = [];
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const status = entry.slice(0, 2);
        const filePath = entry.slice(3);
        // A rename/copy entry is followed by its source path in the -z stream.
        if (status[0] === "R" || status[0] === "C") {
          i += 1;
        }
        if (status.includes("D")) {
          continue;
        }
        changed.push(filePath);
      }
      return changed;
    },
  };
}

/**
 * Tree adapter over a commit: tracked-ness and content are BOTH read from that
 * commit, so the answer is what a clone of it would see.
 *
 * @param {string} root Repository root.
 * @param {string} rev The revision.
 * @returns {object} Tree adapter.
 */
export function createRevTree(root, rev) {
  const tracked = new Set(
    splitNul(git(["ls-tree", "-r", "-z", "--name-only", rev], root)),
  );
  return {
    label: `rev ${rev}`,
    rev,
    tracked,
    read(filePath) {
      if (!tracked.has(filePath)) {
        return null;
      }
      try {
        return git(["show", `${rev}:${filePath}`], root);
      } catch {
        return null;
      }
    },
    changedFiles() {
      const parents = git(["rev-list", "--parents", "-n", "1", rev], root)
        .trim()
        .split(/\s+/)
        .slice(1);
      if (parents.length === 0) {
        return [...tracked];
      }
      return splitNul(
        git(
          [
            "diff-tree",
            "-r",
            "-z",
            "--no-commit-id",
            "--name-only",
            "--diff-filter=d",
            parents[0],
            rev,
          ],
          root,
        ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Classify one resolved reference against a tree.
 *
 * @param {object} options Inputs.
 * @param {string[]} options.candidates Acceptable tree paths.
 * @param {string} options.base The literal resolution, for reporting.
 * @param {Set<string>} options.tracked Tree contents.
 * @param {(p: string) => boolean} options.onDisk Disk existence probe.
 * @returns {{disposition: string, resolved: string}} Verdict.
 */
export function classifyReference({ candidates, base, tracked, onDisk }) {
  for (const candidate of candidates) {
    if (tracked.has(candidate)) {
      return { disposition: DISPOSITIONS.TRACKED, resolved: candidate };
    }
  }
  for (const candidate of candidates) {
    if (onDisk(candidate)) {
      return { disposition: DISPOSITIONS.UNTRACKED, resolved: candidate };
    }
  }
  return { disposition: DISPOSITIONS.MISSING, resolved: base };
}

/**
 * Run both reference layers against a tree.
 *
 * @param {object} options Inputs.
 * @param {object} options.tree Tree adapter.
 * @param {(p: string) => boolean} options.onDisk Disk existence probe.
 * @param {(paths: string[]) => Set<string>} options.ignored Ignore probe.
 * @returns {object} The report.
 */
export function verifyTrackedReferences({ tree, onDisk, ignored }) {
  const findings = [];
  const scanned = { launchTargets: 0, moduleFiles: 0, moduleReferences: 0 };

  const packageTypeCache = new Map();
  const readPackageType = (dir) => {
    if (packageTypeCache.has(dir)) {
      return packageTypeCache.get(dir);
    }
    const manifest = dir.length === 0 ? "package.json" : `${dir}/package.json`;
    let declared = null;
    const source = tree.read(manifest);
    if (source !== null) {
      try {
        const type = JSON.parse(source)?.type;
        declared = typeof type === "string" ? type : null;
      } catch {
        declared = null;
      }
    }
    packageTypeCache.set(dir, declared);
    return declared;
  };

  const record = (entry) => {
    const { disposition, resolved } = classifyReference(entry);
    if (disposition === DISPOSITIONS.TRACKED) {
      return;
    }
    findings.push({
      rule: entry.rule,
      referencing: entry.referencing,
      referencingTracked: tree.tracked.has(entry.referencing),
      line: entry.line,
      specifier: entry.specifier,
      detail: entry.detail,
      target: resolved,
      disposition,
    });
  };

  // Layer 1: launch targets. Always the FULL config, never only its changed
  // part — a script that was already broken stays broken.
  for (const configPath of LAUNCH_CONFIG_FILES) {
    const source = tree.read(configPath);
    if (source === null) {
      continue;
    }
    for (const reference of launchConfigReferences(configPath, source)) {
      scanned.launchTargets += 1;
      record({
        rule: "launch-target",
        referencing: configPath,
        line: reference.line,
        specifier: reference.specifier,
        detail: reference.detail,
        base: reference.specifier,
        candidates: [reference.specifier],
        tracked: tree.tracked,
        onDisk,
      });
    }
  }

  // Layer 2: relative imports in the changed sources.
  for (const filePath of tree.changedFiles()) {
    const normalized = filePath.split("\\").join("/");
    if (normalized.includes("node_modules/")) {
      continue;
    }
    const ext = path.posix.extname(normalized).toLowerCase();
    if (!SCANNED_EXTENSIONS.includes(ext)) {
      continue;
    }
    const source = tree.read(normalized);
    if (source === null) {
      continue;
    }
    scanned.moduleFiles += 1;
    const moduleSystem = moduleSystemFor(normalized, readPackageType);
    for (const reference of moduleReferences(source)) {
      scanned.moduleReferences += 1;
      const resolution = resolutionCandidates(
        normalized,
        reference.specifier,
        moduleSystem,
      );
      if (resolution.external) {
        continue;
      }
      record({
        rule: "module-import",
        referencing: normalized,
        line: reference.line,
        specifier: reference.specifier,
        detail: `${reference.form} (${moduleSystem})`,
        base: resolution.base,
        candidates: resolution.candidates,
        tracked: tree.tracked,
        onDisk,
      });
    }
  }

  // An UNTRACKED target git was explicitly told to ignore is a declared build
  // artifact, not a forgotten `git add`. The downgrade happens here, once,
  // rather than at each call site.
  const ignoredSet = ignored(
    findings
      .filter((finding) => finding.disposition === DISPOSITIONS.UNTRACKED)
      .map((finding) => finding.target),
  );
  for (const finding of findings) {
    if (
      finding.disposition === DISPOSITIONS.UNTRACKED &&
      ignoredSet.has(finding.target)
    ) {
      finding.disposition = DISPOSITIONS.IGNORED;
    }
  }

  const violations = findings.filter(
    (finding) => finding.disposition !== DISPOSITIONS.IGNORED,
  );
  const advisories = findings.filter(
    (finding) => finding.disposition === DISPOSITIONS.IGNORED,
  );
  return {
    tool: "verify-tracked-references",
    tree: tree.label,
    rev: tree.rev,
    scanned,
    violations,
    advisories,
    status: violations.length === 0 ? "PASS" : "FAIL",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * One-line human description of a disposition.
 *
 * @param {string} disposition The disposition.
 * @returns {string} Description.
 */
function describeDisposition(disposition) {
  if (disposition === DISPOSITIONS.UNTRACKED) {
    return "present on disk, NOT in the tree — a clone gets nothing";
  }
  if (disposition === DISPOSITIONS.MISSING) {
    return "absent from the tree and from disk";
  }
  if (disposition === DISPOSITIONS.IGNORED) {
    return "gitignored build artifact — advisory";
  }
  return disposition;
}

/**
 * Render one finding.
 *
 * @param {object} finding The finding.
 * @returns {string} Text.
 */
function renderFinding(finding) {
  return (
    `  ${finding.referencing}:${finding.line} -> ${finding.target}` +
    `\n      ${finding.disposition}: ${describeDisposition(finding.disposition)}` +
    `\n      via ${finding.detail}, specifier "${finding.specifier}"` +
    (finding.referencingTracked
      ? ""
      : "\n      (the referring file is itself untracked)")
  );
}

/**
 * Render the report as text.
 *
 * @param {object} report The report.
 * @returns {string} Text.
 */
export function renderReport(report) {
  const lines = [];
  lines.push(`verify-tracked-references — ${report.tree}`);
  lines.push(
    `  scanned: ${report.scanned.launchTargets} launch targets, ` +
      `${report.scanned.moduleReferences} relative imports across ` +
      `${report.scanned.moduleFiles} changed source files`,
  );
  if (report.violations.length > 0) {
    lines.push(`\nVIOLATIONS (${report.violations.length})`);
    for (const finding of report.violations) {
      lines.push(renderFinding(finding));
    }
  }
  if (report.advisories.length > 0) {
    lines.push(`\nADVISORIES (${report.advisories.length})`);
    for (const finding of report.advisories) {
      lines.push(renderFinding(finding));
    }
  }
  lines.push(
    `\n${report.status}: ${report.violations.length} violation(s), ` +
      `${report.advisories.length} advisory(ies)`,
  );
  return lines.join("\n");
}

const USAGE = `Usage: node Tools/verify-tracked-references.mjs [--rev <rev>] [--json]

Asserts that every reference OUT of the tree resolves to something the tree
tracks: node launch targets in package.json / .mcp.json, and relative imports
in changed .mjs/.cjs/.js files.

  --rev <rev>   check a commit's tree instead of the working tree
  --json        emit the report as JSON
  -h, --help    this message

Exit: 0 clean, 1 violations, 2 guard error, 3 structural (no repo / bad rev).`;

/**
 * CLI entry point.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} Exit code.
 */
export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`verify-tracked-references: ${error.message}`);
    console.error(USAGE);
    return exitCodeForS5Status("ERROR");
  }
  if (options.help) {
    console.log(USAGE);
    return exitCodeForS5Status("PASS");
  }

  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  } catch {
    console.error(
      "verify-tracked-references: STRUCTURAL — not a git repository, so there is no tree to ask.",
    );
    return exitCodeForS5Status("STRUCTURAL");
  }

  if (options.rev !== null) {
    try {
      git(
        ["rev-parse", "--verify", "--quiet", `${options.rev}^{commit}`],
        root,
      );
    } catch {
      console.error(
        `verify-tracked-references: STRUCTURAL — cannot read rev "${options.rev}".`,
      );
      return exitCodeForS5Status("STRUCTURAL");
    }
  }

  let report;
  try {
    const tree =
      options.rev === null
        ? createWorktreeTree(root)
        : createRevTree(root, options.rev);
    report = verifyTrackedReferences({
      tree,
      onDisk: (candidate) => existsSync(path.join(root, candidate)),
      ignored: (paths) => ignoredPaths(paths, root),
    });
  } catch (error) {
    console.error(`verify-tracked-references: ERROR — ${error.message}`);
    return exitCodeForS5Status("ERROR");
  }

  console.log(
    options.json ? JSON.stringify(report, null, 2) : renderReport(report),
  );
  return exitCodeForS5Status(report.status);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The timer body exits; it never merely warns. A guard that hangs is a guard
  // that has silently stopped guarding.
  const watchdog = setTimeout(() => {
    console.error(
      `verify-tracked-references: ERROR — watchdog fired after ${WATCHDOG_MS} ms.`,
    );
    process.exit(exitCodeForS5Status("ERROR"));
  }, WATCHDOG_MS);
  watchdog.unref();
  process.exitCode = main(process.argv.slice(2));
}
