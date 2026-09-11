/**
 * Per-lane temporary space for the spec, probe and tool fleet.
 * @purpose The one way a spec, probe or tool takes scratch space: a single per-lane root under os.tmpdir() with removal in `finally`, so a throwing or killed run leaves one sweepable root instead of loose mkdtemp sandboxes at the Temp root.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. On 2026-09-11 the user's `%LOCALAPPDATA%\Temp` held 13.1 GB
 * across 59,142 files and 5,306 top-level entries. Roughly 2,000 of those
 * top-level entries were mkdtemp sandboxes created by THIS repository's specs
 * and left behind: `helm-aec-residency-e2-*` (108), `turin-stall-locus-*` (45),
 * `catalog-index-mutant-*` (43), `helm-trace-*` (31) and a long tail. Every one
 * of them came from the same shape — `mkdtempSync(path.join(tmpdir(), prefix))`
 * with the removal either missing, or written after the assertions so a failing
 * assertion skipped it, or unreachable because the run was killed.
 *
 * Two things fix that shape. First, cleanup belongs in a `finally`, not after
 * the assertions: `withLaneTmp` owns the directory and removes it whether the
 * body returns, throws, or rejects. Second, what does survive a kill should
 * survive in ONE place: every directory this module hands out lives under
 * `<tmpdir>/cesium-lane/<lane>`, so the backstop sweep
 * (`Tools/temp-hygiene.mjs`) has a single root per lane to remove instead of a
 * thousand unrelated sandboxes to classify by name.
 *
 * SAFETY. Every path this module is willing to delete is asserted to be
 * strictly under `os.tmpdir()` AND strictly under the `cesium-lane` namespace
 * before any `rmSync` runs — the no-destructive-tests-outside-temp rule
 * (maintainer, 2026-08-31) made structural. The tmpdir root itself, the
 * namespace root itself, and anything reached through a symlink or junction
 * are all refused.
 *
 * Usage:
 *   import { withLaneTmp } from "./lane-tmp.mjs";
 *   test("...", () => withLaneTmp("catalog-index-mutant-", (dir) => { ... }));
 *   await withLaneTmp("served-preflight-", async (dir) => { ... });
 *
 * The lane name comes from the argument, else `process.env.CESIUM_LANE`, else
 * `"seat"`. Worker clones set `CESIUM_LANE` to their Tolkien lane name so a
 * lane's scratch is identifiable and sweepable on its own.
 *
 * @module Tools/lib/lane-tmp
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directory under `os.tmpdir()` that contains every lane's temp root. */
export const LANE_TMP_NAMESPACE = "cesium-lane";

/** Lane name used when neither an argument nor `CESIUM_LANE` supplies one. */
export const DEFAULT_LANE_NAME = "seat";

// A lane name becomes one path segment, so it may not contain a separator, may
// not be `.`/`..`, and may not start with a dot (dot-prefixed entries are the
// shape the sweep attributes to foreign tools).
const LANE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// mkdtemp appends six random characters to the prefix; the prefix itself must
// stay one segment so the result cannot climb out of the lane root.
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

const CASE_INSENSITIVE_FS = process.platform === "win32";

function normalize(candidate) {
  const resolved = path.resolve(candidate);
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

/**
 * The resolved system temp directory. Read through `os.tmpdir()` on every call
 * rather than cached, so a test that repoints TMPDIR/TEMP is honoured.
 *
 * @returns {string}
 */
export function systemTmpRoot() {
  return path.resolve(os.tmpdir());
}

/**
 * True when `candidate` is STRICTLY under the system temp directory. The temp
 * directory itself is deliberately not "under" itself: nothing in this module
 * may ever remove the temp root.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
export function isUnderTmpdir(candidate) {
  const root = normalize(systemTmpRoot());
  const target = normalize(candidate);
  return target.startsWith(root + path.sep) && target.length > root.length + 1;
}

/**
 * Throw unless `candidate` is a path this module is allowed to delete: strictly
 * under `os.tmpdir()`, strictly under the `cesium-lane` namespace, and not the
 * namespace root itself.
 *
 * @param {string} candidate
 * @param {string} [what] Noun used in the error message.
 * @returns {string} The resolved path.
 */
export function assertRemovableLanePath(candidate, what = "path") {
  const resolved = path.resolve(candidate);
  if (!isUnderTmpdir(resolved)) {
    throw new Error(
      `refusing to touch ${what} outside the system temp directory: ${resolved} (tmpdir ${systemTmpRoot()})`,
    );
  }
  const namespaceRoot = path.join(systemTmpRoot(), LANE_TMP_NAMESPACE);
  const normalized = normalize(resolved);
  if (!normalized.startsWith(normalize(namespaceRoot) + path.sep)) {
    throw new Error(
      `refusing to touch ${what} outside the lane namespace: ${resolved} (namespace ${namespaceRoot})`,
    );
  }
  return resolved;
}

/**
 * The temp root for one lane: `<tmpdir>/cesium-lane/<lane>`.
 *
 * @param {string} [laneName] Defaults to `process.env.CESIUM_LANE`, else `"seat"`.
 * @returns {string} Absolute path. The directory is NOT created.
 */
export function laneTmpRoot(laneName) {
  const raw = laneName ?? process.env.CESIUM_LANE ?? DEFAULT_LANE_NAME;
  const name = String(raw).trim();
  if (!LANE_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid lane name ${JSON.stringify(raw)}: expected one path segment matching ${LANE_NAME_PATTERN}`,
    );
  }
  const root = path.join(systemTmpRoot(), LANE_TMP_NAMESPACE, name);
  // Belt and braces: a lane name that somehow escaped the pattern must not
  // produce a root outside the namespace.
  assertRemovableLanePath(root, "lane temp root");
  return root;
}

/**
 * Create a fresh mkdtemp directory UNDER the lane root, creating the root if
 * needed. The caller owns the directory; prefer `withLaneTmp`, which removes it.
 *
 * @param {string} prefix mkdtemp prefix, one path segment (e.g. `"catalog-index-mutant-"`).
 * @param {{laneName?: string}} [options]
 * @returns {string} Absolute path to the new directory.
 */
export function mkLaneTmp(prefix, options = {}) {
  const name = String(prefix ?? "");
  if (!PREFIX_PATTERN.test(name)) {
    throw new Error(
      `invalid temp prefix ${JSON.stringify(prefix)}: expected one path segment matching ${PREFIX_PATTERN}`,
    );
  }
  const root = laneTmpRoot(options.laneName);
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, name));
  return assertRemovableLanePath(directory, "lane temp directory");
}

/**
 * Remove a directory previously handed out by `mkLaneTmp`. Refuses anything
 * outside the lane namespace, and refuses to follow a symlink or junction:
 * a link is unlinked, never recursed into.
 *
 * @param {string} directory
 * @returns {boolean} True when something was removed.
 */
export function removeLaneTmp(directory) {
  const resolved = assertRemovableLanePath(directory, "lane temp directory");
  let stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) {
    // Never recurse through a link: unlink the link itself and leave whatever
    // it pointed at untouched.
    try {
      fs.unlinkSync(resolved);
    } catch {
      fs.rmdirSync(resolved);
    }
    return true;
  }
  fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
  return true;
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

/**
 * Run `fn(directory)` with a fresh lane temp directory and remove that
 * directory afterwards — on a normal return, on a thrown error, and on a
 * rejected promise. This is the cleanup the leaking specs did not have.
 *
 * @template T
 * @param {string} prefix mkdtemp prefix, one path segment.
 * @param {(directory: string) => T} fn
 * @param {{laneName?: string}} [options]
 * @returns {T} Whatever `fn` returned; a promise if `fn` returned one.
 */
export function withLaneTmp(prefix, fn, options = {}) {
  const directory = mkLaneTmp(prefix, options);
  let ownershipPassedToPromise = false;
  try {
    const result = fn(directory);
    if (isThenable(result)) {
      ownershipPassedToPromise = true;
      return Promise.resolve(result).finally(() => removeLaneTmp(directory));
    }
    return result;
  } finally {
    if (!ownershipPassedToPromise) {
      removeLaneTmp(directory);
    }
  }
}

/**
 * Remove a lane's temp root — the backstop for directories a killed run left
 * behind. With `olderThanMs`, only children last modified longer ago than that
 * are removed, and the root survives if anything younger is still in it.
 *
 * @param {string} [laneName]
 * @param {{olderThanMs?: number, now?: number}} [options]
 * @returns {{root: string, removed: string[], kept: string[], removedRoot: boolean}}
 */
export function sweepLaneTmp(laneName, options = {}) {
  const root = laneTmpRoot(laneName);
  const olderThanMs = Number(options.olderThanMs ?? 0);
  const now = Number(options.now ?? Date.now());
  const summary = { root, removed: [], kept: [], removedRoot: false };
  if (!fs.existsSync(root)) {
    return summary;
  }
  if (!(olderThanMs > 0)) {
    removeLaneTmp(root);
    summary.removedRoot = true;
    return summary;
  }
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return summary;
  }
  for (const entry of entries) {
    const child = path.join(root, entry);
    let stats;
    try {
      stats = fs.lstatSync(child);
    } catch {
      continue;
    }
    if (now - stats.mtimeMs >= olderThanMs) {
      removeLaneTmp(child);
      summary.removed.push(child);
    } else {
      summary.kept.push(child);
    }
  }
  if (summary.kept.length === 0) {
    removeLaneTmp(root);
    summary.removedRoot = true;
  }
  return summary;
}
