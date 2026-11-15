#!/usr/bin/env node
/**
 * Two-phase sweep of the system temp directory.
 * @purpose Classify the Temp root into an explicit positive delete list, bank any visual evidence inside it, then delete exactly that list behind a protect set that is re-checked at execute time.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. On 2026-09-11 `%LOCALAPPDATA%\Temp` held 13.1 GB across
 * 59,142 files and 5,306 top-level entries: ~2,000 mkdtemp sandboxes from this
 * repository's specs, 215 `karma-*` and 171 `playwright_chromiumdev_profile-*`
 * directories from killed runners, and bundle copies curled to the root by
 * served-build preflights. `Tools/lib/lane-tmp.mjs` stops new sandboxes landing
 * there; this is the backstop for what a killed run leaves behind, and for the
 * foreign tools that will never use the helper.
 *
 * POSITIVE-LIST DISCIPLINE (lesson of 2026-09-11, memory
 * `feedback_destructive_scripts_positive_list.md`). The delete set is an
 * explicit list of absolute paths written to disk, readable before it is used,
 * and consumed verbatim. `--execute` deletes nothing that is not in the file,
 * and re-checks the protect set, the temp containment, the plan's own age
 * horizon and a live-lock probe on every path before removing it. No regex
 * decides anything at execute time.
 *
 * NEVER FOLLOWS A LINK. Every symlink and junction inside a delete target is
 * unlinked first, so a recursive removal cannot reach through a junction into a
 * directory that was never in the plan.
 *
 * Usage:
 *   node Tools/temp-hygiene.mjs --plan [--out plan.json] [--temp <dir>] [--finished-lanes <a,b>]
 *   node Tools/temp-hygiene.mjs --bank-evidence <archiveDir> --plan plan.json
 *   node Tools/temp-hygiene.mjs --execute --plan plan.json
 *
 * Default mode is `--plan`, which is read-only: nothing is deleted unless
 * `--execute` is passed AND a plan file is named. Without `--out` the plan is
 * written to the lane temp root (`laneTmpRoot()`), never the working directory.
 *
 * LANE ROOTS. `<temp>/cesium-lane/<lane>` is kept while anything in it is
 * younger than a day, because a lane may still be running. `--finished-lanes`
 * names lanes that have returned: their roots go on the delete list whatever
 * their age, and every execute-time check still applies to them. The slot's
 * state folder (`_seat`), the default lane (`seat`) and the landing tools'
 * scratch (`landing`) can never be named; a named lane with no root is listed
 * in the plan and printed.
 *
 * CLAUDE SESSIONS. The running session is the folder `CLAUDE_SESSION_ID`
 * names; without the variable no folder is named, and a session folder with
 * anything younger than a day in it is kept whether or not it holds files.
 *
 * EVIDENCE. A folder inside a delete target holding a `.png`/`.webp` is
 * evidence unless every such image in it has the bytes of an image the
 * repository tracks (a built tree's copies of the repo's own assets).
 *
 * Exit: 0 ok · 1 refused (unbanked evidence, bad plan) · 2 cannot determine
 *
 * @module Tools/temp-hygiene
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LANE_NAME,
  LANE_TMP_NAMESPACE,
  laneTmpRoot,
} from "./lib/lane-tmp.mjs";

/**
 * Where `--plan` writes without `--out`: the lane temp root, so a plan run from
 * inside another checkout leaves nothing in that checkout. A freshly written
 * lane root is younger than the lane-root age floor, so the plan never lists
 * itself for deletion.
 *
 * @param {string} [laneName] Defaults as `laneTmpRoot` does.
 * @returns {string}
 */
export function defaultPlanPath(laneName) {
  return path.join(laneTmpRoot(laneName), "temp-hygiene-plan.json");
}

const DAY_MS = 86_400_000;

/** Age gate for an entry whose NAME says it is temporary. */
export const PATTERN_AGE_DAYS = 1;
/** Age gate for a loose file at the Temp root and for an empty directory. */
export const LOOSE_AGE_DAYS = 3;
/** Age gate for a directory no rule recognises. */
export const UNRECOGNISED_AGE_DAYS = 30;

/**
 * Directory-name classes that are temporary by construction. Order matters only
 * for the reported category; every entry gets the same age gate.
 */
export const DIRECTORY_CLASSES = [
  [/^karma-/, "karma"],
  [/^playwright/i, "playwright"],
  [/^puppeteer/i, "puppeteer"],
  [/^scoped_dir/, "chromium"],
  [/^chrome_/, "chromium"],
  [/^msedge_/, "edge"],
  [/^edge-/, "edge"],
  [/^PSES-/, "powershell-editor-services"],
  [/^docker-tar-extract/, "docker"],
  [/^_MEI\d+/, "pyinstaller"],
  [/^pip-/, "pip"],
  [/^npm-/, "npm"],
  [/^esbuild/, "esbuild"],
  [/^vite-/, "vite"],
  [/^jest_/, "jest"],
  [/^tsx-/, "tsx"],
  [/^ts-node/, "ts-node"],
  [/^hsperfdata_/, "java"],
  [/^nuget/i, "nuget"],
  [/^dotnet-/, "dotnet"],
  [/^\.bun-/, "bun"],
  [/^codex-/, "codex"],
  [/^\{[0-9A-F-]{36}\}$/i, "installer-guid"],
  [
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
    "installer-guid",
  ],
  // mkdtemp appends exactly six URL-safe characters to its prefix. This is the
  // class that carried ~2,000 of the 5,306 top-level entries.
  [/-[A-Za-z0-9]{6}$/, "mkdtemp-sandbox"],
  [/^\.tmp[A-Za-z0-9]{6}$/, "foreign-tempfile-crate"],
];

/** Loose-file classes at the Temp root. Nothing deliberate lives loose in Temp. */
export const FILE_CLASSES = [
  [/\.(js|mjs|cjs)$/, "bundle-copy-or-script"],
  [/\.(log|out|tap)$/, "log"],
  [/\.(txt|md|json|csv|xml|html|patch)$/, "report"],
  [/\.cpuprofile$/, "vscode-profile"],
  [/\.(png|jpg|webp|pdf|zip)$/, "artifact"],
  [/\.tmp$/i, "tmp"],
];

/**
 * Absolute paths that are never deleted, never descended into for deletion, and
 * re-checked at execute time whatever the plan says. Relative entries resolve
 * against the temp root being swept.
 */
export function protectPaths(temp) {
  return [
    path.join(temp, "node-compile-cache"),
    path.join(os.homedir(), ".codex"),
    path.join(os.homedir(), ".claude"),
    "F:\\",
  ];
}

const CASE_INSENSITIVE_FS = process.platform === "win32";
const normalize = (p) =>
  CASE_INSENSITIVE_FS ? path.resolve(p).toLowerCase() : path.resolve(p);

/**
 * True when `candidate` is at or under any protected path.
 *
 * @param {string} candidate
 * @param {string[]} protects
 * @returns {boolean}
 */
export function isProtected(candidate, protects) {
  const target = normalize(candidate);
  return protects.some((entry) => {
    const root = normalize(entry);
    // A drive root already ends in a separator; appending another produces a
    // prefix (`f:\\`) that no real path can start with, so the entry would
    // protect only its own literal string. That is exactly the silently-empty
    // keep rule the positive-list memory was written about.
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return target === root || target.startsWith(prefix);
  });
}

function lstatSafe(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * Recursive size/age summary that never traverses a link.
 *
 * @param {string} target
 * @param {{bytes: number, files: number, links: number, newest: number}} [accumulator]
 * @returns {{bytes: number, files: number, links: number, newest: number}}
 */
export function measure(
  target,
  accumulator = { bytes: 0, files: 0, links: 0, newest: 0 },
) {
  const stats = lstatSafe(target);
  if (stats === null) return accumulator;
  if (stats.isSymbolicLink()) {
    accumulator.links += 1;
    return accumulator;
  }
  if (stats.mtimeMs > accumulator.newest) accumulator.newest = stats.mtimeMs;
  if (stats.isFile()) {
    accumulator.bytes += stats.size;
    accumulator.files += 1;
    return accumulator;
  }
  if (!stats.isDirectory()) return accumulator;
  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch {
    return accumulator;
  }
  for (const entry of entries) measure(path.join(target, entry), accumulator);
  return accumulator;
}

function classifyName(name, classes) {
  const hit = classes.find(([pattern]) => pattern.test(name));
  return hit === undefined ? null : hit[1];
}

/**
 * The Claude session directory this process belongs to, which is never
 * descended into: the folder `CLAUDE_SESSION_ID` names. Without the variable
 * nothing tells this conversation's folder from another's (a folder's
 * modification time does not), so none is named; the age floor in
 * `planClaudeSessions` keeps every session folder that is in use.
 *
 * @param {string} claudeRoot
 * @returns {string|null}
 */
export function runningSessionDirectory(claudeRoot) {
  const declared = process.env.CLAUDE_SESSION_ID;
  if (declared === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(declared))
    return null;
  let projects;
  try {
    projects = fs.readdirSync(claudeRoot);
  } catch {
    return null;
  }
  for (const project of projects) {
    const sessionPath = path.join(claudeRoot, project, declared);
    if (lstatSafe(sessionPath) !== null) return sessionPath;
  }
  return null;
}

/** The lane folder that holds the heavy-step slot's state; never named finished. */
export const SLOT_STATE_LANE = "_seat";

/** The lane folder of landing-tool scratch (`Tools/landing`). */
const LANDING_LANE = "landing";

/**
 * Lane folders that are shared roots, never one finished lane, each with what
 * it is. `--finished-lanes` refuses every name here (case-folded).
 */
export const NEVER_FINISHED_LANES = new Map([
  [SLOT_STATE_LANE, "the slot's state folder"],
  [DEFAULT_LANE_NAME, "the root of every process run without a lane name"],
  [LANDING_LANE, "the landing tools' scratch"],
]);

const fold = (name) => (CASE_INSENSITIVE_FS ? name.toLowerCase() : name);

/**
 * Lane names from `--finished-lanes` (comma or space separated). Refuses the
 * shared lane folders (`NEVER_FINISHED_LANES`) and any name that is not one
 * lane-root segment.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
export function parseFinishedLanes(value) {
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  const names = raw
    .split(/[\s,]+/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const name of names) {
    const shared = NEVER_FINISHED_LANES.get(name.toLowerCase());
    if (shared !== undefined) {
      throw new Error(
        `--finished-lanes may never name ${name.toLowerCase()}: it is ${shared}, not a lane`,
      );
    }
    // laneTmpRoot validates the name as one path segment and throws otherwise.
    laneTmpRoot(name);
  }
  return [...new Map(names.map((name) => [fold(name), name])).values()];
}

/**
 * The repository this tool belongs to, or null when the module was loaded from
 * somewhere that is not a file.
 *
 * @returns {string|null}
 */
function defaultRepoRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return null;
  }
}

/**
 * Variables that make git answer for another repository than the one in its
 * cwd: `GIT_DIR` names a repository and `GIT_INDEX_FILE` an index. `GIT_WORK_TREE`
 * alone changes nothing git reports for the files listed here, so it is left.
 */
const GIT_REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE"];

/**
 * The environment git runs in here: the caller's, without the variables that
 * choose the repository (a hook exports them), so that the answer is about the
 * folder asked and no other.
 *
 * @returns {Record<string, string|undefined>}
 */
function gitEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (GIT_REPOSITORY_VARIABLES.includes(name.toUpperCase())) continue;
    env[name] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/**
 * Git blob ids of every `.png`/`.webp` the repository's index tracks, read
 * once with `git ls-files -s`. Null when git cannot answer, which leaves every
 * image counted as evidence. Git never takes `GIT_DIR` or `GIT_INDEX_FILE` from
 * the caller.
 *
 * @param {string|null} repoRoot
 * @returns {{algorithm: string, ids: Set<string>}|null}
 */
export function trackedImageBlobIds(repoRoot) {
  if (repoRoot === null || repoRoot === undefined) return null;
  const listed = spawnSync("git", ["ls-files", "-s", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return null;
  const ids = new Set();
  let length = 0;
  for (const record of listed.stdout.split("\0")) {
    const match = /^\d{6} ([0-9a-f]{40,64}) \d\t(.+)$/u.exec(record);
    if (match === null || !/\.(png|webp)$/iu.test(match[2])) continue;
    ids.add(match[1]);
    length = match[1].length;
  }
  if (ids.size === 0) return null;
  return { algorithm: length === 64 ? "sha256" : "sha1", ids };
}

/**
 * The git blob id of a file's bytes.
 *
 * @param {Buffer} bytes
 * @param {string} algorithm `sha1` or `sha256`.
 * @returns {string}
 */
export function gitBlobId(bytes, algorithm) {
  return createHash(algorithm)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * Classify a temp root into a positive delete list plus keep/residue lists.
 * Read-only: this function never removes anything.
 *
 * @param {{temp?: string, now?: number, finishedLanes?: string|string[], repoRoot?: string|null}} [options]
 *   `finishedLanes` names lanes whose roots go on the delete list whatever
 *   their age (throws on a shared lane name or a malformed name); `repoRoot` is the
 *   repository whose tracked images are not evidence (default: this tool's).
 * @returns {object} The plan.
 */
export function planTempRoot(options = {}) {
  const temp = path.resolve(options.temp ?? os.tmpdir());
  const now = Number(options.now ?? Date.now());
  const finishedLanes = parseFinishedLanes(options.finishedLanes);
  const repoRoot =
    options.repoRoot === undefined ? defaultRepoRoot() : options.repoRoot;
  const protects = protectPaths(temp);
  const claudeRoot = path.join(temp, "claude");
  const runningSession = runningSessionDirectory(claudeRoot);
  const laneRoot = path.join(temp, LANE_TMP_NAMESPACE);
  const finished = { named: [], missing: [] };

  const remove = [];
  const keep = [];
  const residue = [];
  const ageDays = (summary, stats) =>
    (now - (summary.newest || stats.mtimeMs)) / DAY_MS;
  const record = (list, target, category, reason, summary, age) =>
    list.push({
      path: target,
      bytes: summary.bytes,
      files: summary.files,
      links: summary.links,
      ageDays: Number(age.toFixed(2)),
      category,
      reason,
    });

  let names;
  try {
    names = fs.readdirSync(temp);
  } catch {
    return {
      generatedAt: new Date(now).toISOString(),
      temp,
      error: "unreadable",
    };
  }

  for (const name of names) {
    const target = path.join(temp, name);
    const stats = lstatSafe(target);
    if (stats === null) continue;
    if (isProtected(target, protects)) {
      record(
        keep,
        target,
        "protected",
        "on the protect set",
        measure(target),
        0,
      );
      continue;
    }
    if (stats.isSymbolicLink()) {
      record(
        keep,
        target,
        "link",
        "symlink or junction at the Temp root — never followed, never removed",
        { bytes: 0, files: 0, links: 1, newest: stats.mtimeMs },
        (now - stats.mtimeMs) / DAY_MS,
      );
      continue;
    }
    if (normalize(target) === normalize(claudeRoot)) {
      planClaudeSessions({
        claudeRoot,
        runningSession,
        now,
        remove,
        keep,
        record,
      });
      continue;
    }
    if (normalize(target) === normalize(laneRoot)) {
      finished.named = planLaneRoots({
        laneRoot,
        now,
        remove,
        keep,
        record,
        finishedLanes,
      });
      continue;
    }

    const summary = measure(target);
    const age = ageDays(summary, stats);
    if (stats.isDirectory()) {
      const category = classifyName(name, DIRECTORY_CLASSES);
      if (category !== null) {
        if (age < PATTERN_AGE_DAYS) {
          record(
            keep,
            target,
            category,
            `younger than ${PATTERN_AGE_DAYS} day — may be in use`,
            summary,
            age,
          );
        } else {
          record(
            remove,
            target,
            category,
            `temporary by construction, ${age.toFixed(1)} d old`,
            summary,
            age,
          );
        }
      } else if (
        summary.files === 0 &&
        summary.links === 0 &&
        age > LOOSE_AGE_DAYS
      ) {
        record(
          remove,
          target,
          "empty-dir",
          `empty for more than ${LOOSE_AGE_DAYS} days`,
          summary,
          age,
        );
      } else if (age > UNRECOGNISED_AGE_DAYS) {
        record(
          remove,
          target,
          "stale-dir",
          `unrecognised directory older than ${UNRECOGNISED_AGE_DAYS} days`,
          summary,
          age,
        );
      } else {
        record(
          residue,
          target,
          "unknown-dir",
          "unrecognised — KEPT, reported for a human",
          summary,
          age,
        );
      }
      continue;
    }
    if (!stats.isFile()) continue;
    const category = classifyName(name, FILE_CLASSES);
    if (age < PATTERN_AGE_DAYS) {
      record(
        keep,
        target,
        "young-file",
        `younger than ${PATTERN_AGE_DAYS} day`,
        summary,
        age,
      );
    } else if (category !== null) {
      record(
        remove,
        target,
        category,
        `loose file at the Temp root, ${age.toFixed(1)} d old`,
        summary,
        age,
      );
    } else if (age > LOOSE_AGE_DAYS) {
      record(
        remove,
        target,
        "stale-file",
        `loose file older than ${LOOSE_AGE_DAYS} days — nothing deliberate lives loose in Temp`,
        summary,
        age,
      );
    } else {
      record(
        residue,
        target,
        "unknown-file",
        "unrecognised — KEPT, reported for a human",
        summary,
        age,
      );
    }
  }

  const namedFolded = new Set(finished.named.map(fold));
  finished.missing = finishedLanes.filter(
    (name) => !namedFolded.has(fold(name)),
  );
  const plan = {
    generatedAt: new Date(now).toISOString(),
    generatedAtMs: now,
    temp,
    runningSession,
    finishedLanes: finished,
    repoRoot,
    protect: protects,
    delete: remove,
    keep,
    residue,
    totals: {
      deleteEntries: remove.length,
      deleteFiles: remove.reduce((sum, row) => sum + row.files, 0),
      deleteBytes: remove.reduce((sum, row) => sum + row.bytes, 0),
      keepBytes: keep.reduce((sum, row) => sum + row.bytes, 0),
      residueEntries: residue.length,
    },
  };
  const stats = { trackedCopyDirs: 0 };
  plan.evidence = {
    dirs: findEvidenceDirs(plan, { stats }),
    trackedCopyDirs: stats.trackedCopyDirs,
    receipt: null,
  };
  return plan;
}

function planClaudeSessions({
  claudeRoot,
  runningSession,
  now,
  remove,
  keep,
  record,
}) {
  let projects;
  try {
    projects = fs.readdirSync(claudeRoot);
  } catch {
    return;
  }
  for (const project of projects) {
    const projectPath = path.join(claudeRoot, project);
    let sessions;
    try {
      sessions = fs.readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const sessionPath = path.join(projectPath, session);
      if (
        runningSession !== null &&
        normalize(sessionPath) === normalize(runningSession)
      ) {
        record(
          keep,
          sessionPath,
          "running-session",
          "this session — never descended into",
          { bytes: 0, files: 0, links: 0, newest: now },
          0,
        );
        continue;
      }
      const summary = measure(sessionPath);
      const age = (now - (summary.newest || now)) / DAY_MS;
      if (age < PATTERN_AGE_DAYS) {
        // A session in use writes into its folder; with no variable naming the
        // running one, anything touched within the floor may be it.
        record(
          keep,
          sessionPath,
          "young-session",
          `a session folder touched within ${PATTERN_AGE_DAYS} day — may be running; never deleted while young`,
          summary,
          age,
        );
        continue;
      }
      if (summary.files === 0 && summary.links === 0) {
        record(
          remove,
          sessionPath,
          "empty-session",
          "empty Claude session directory",
          summary,
          age,
        );
      } else {
        record(
          keep,
          sessionPath,
          "other-session",
          runningSession === null
            ? "a session folder with files — not ours to delete (no CLAUDE_SESSION_ID, so no folder is named running)"
            : "another conversation's session — its transcripts are not ours to delete",
          summary,
          age,
        );
      }
    }
  }
}

/**
 * Classify each lane root; returns the finished-lane names that had a root.
 */
function planLaneRoots({ laneRoot, now, remove, keep, record, finishedLanes }) {
  const finished = new Map(finishedLanes.map((name) => [fold(name), name]));
  const named = [];
  let lanes;
  try {
    lanes = fs.readdirSync(laneRoot);
  } catch {
    return named;
  }
  for (const lane of lanes) {
    const lanePath = path.join(laneRoot, lane);
    const stats = lstatSafe(lanePath);
    if (stats === null) continue;
    const summary = measure(lanePath);
    const age = (now - (summary.newest || stats.mtimeMs)) / DAY_MS;
    if (finished.has(fold(lane)) && stats.isDirectory()) {
      named.push(finished.get(fold(lane)));
      record(
        remove,
        lanePath,
        "finished-lane",
        `lane named finished by --finished-lanes, ${age.toFixed(1)} d old`,
        summary,
        age,
      );
      continue;
    }
    if (age < PATTERN_AGE_DAYS) {
      record(
        keep,
        lanePath,
        "lane-root",
        `lane scratch younger than ${PATTERN_AGE_DAYS} day — a lane may still be running`,
        summary,
        age,
      );
    } else {
      record(
        remove,
        lanePath,
        "lane-root",
        `lane scratch ${age.toFixed(1)} d old — the lane returned or died`,
        summary,
        age,
      );
    }
  }
  return named;
}

/**
 * Every evidence directory inside a delete target, `visual-regression/output`
 * trees first. These must be banked before anything is removed
 * (CLAUDE.md, "Evidence Repatriation"). A directory holding a `.png`/`.webp` is
 * evidence when at least one such image in it is not byte-identical to an
 * image the repository tracks (`plan.repoRoot`, else this tool's repository);
 * a built tree's copies of the repository's own assets are not.
 *
 * @param {object} plan
 * @param {{tracked?: {algorithm: string, ids: Set<string>}|null, stats?: {trackedCopyDirs: number}}} [options]
 * @returns {string[]} Top-level directories, no nesting.
 */
export function findEvidenceDirs(plan, options = {}) {
  const found = new Set();
  const imageDirs = new Set();
  let tracked = options.tracked;
  const isTrackedCopy = (file) => {
    if (tracked === undefined) {
      tracked = trackedImageBlobIds(
        plan.repoRoot === undefined ? defaultRepoRoot() : plan.repoRoot,
      );
    }
    if (tracked === null) return false;
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return false;
    }
    return tracked.ids.has(gitBlobId(bytes, tracked.algorithm));
  };
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          /^output$/i.test(entry.name) &&
          /visual-regression$/i.test(directory)
        ) {
          found.add(child);
          continue;
        }
        walk(child);
      } else if (/\.(png|webp)$/i.test(entry.name)) {
        imageDirs.add(directory);
        if (!found.has(directory) && !isTrackedCopy(child)) {
          found.add(directory);
        }
      }
    }
  };
  for (const row of plan.delete ?? []) {
    const stats = lstatSafe(row.path);
    if (stats !== null && stats.isDirectory() && !stats.isSymbolicLink()) {
      walk(row.path);
    }
  }
  if (options.stats !== undefined) {
    options.stats.trackedCopyDirs = [...imageDirs].filter(
      (directory) => !found.has(directory),
    ).length;
  }
  const all = [...found].sort();
  return all.filter(
    (directory) =>
      !all.some(
        (other) =>
          other !== directory && directory.startsWith(other + path.sep),
      ),
  );
}

function countPngs(directory, counter = { n: 0 }) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return counter;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory())
      countPngs(path.join(directory, entry.name), counter);
    else if (/\.(png|webp)$/i.test(entry.name)) counter.n += 1;
  }
  return counter;
}

/**
 * Zip every evidence directory in the plan into `archiveDir` and verify the
 * archive holds every PNG that is on disk. A mismatch is a refusal: the caller
 * must not execute the plan.
 *
 * Windows bsdtar (`C:\Windows\System32\tar.exe`) writes zip from a `.zip` name;
 * Git's bundled tar cannot.
 *
 * @param {object} plan
 * @param {string} archiveDir
 * @returns {{verified: boolean, zip: string|null, pngInZip: number, pngOnDisk: number, dirs: string[], reason?: string}}
 */
export function bankEvidence(plan, archiveDir) {
  const dirs = findEvidenceDirs(plan);
  const pngOnDisk = dirs.reduce(
    (sum, directory) => sum + countPngs(directory).n,
    0,
  );
  if (dirs.length === 0) {
    return { verified: true, zip: null, pngInZip: 0, pngOnDisk: 0, dirs };
  }
  fs.mkdirSync(archiveDir, { recursive: true });
  const listFile = path.join(archiveDir, "EVIDENCE_DIRS_REL.txt");
  const relative = dirs.map((directory) =>
    path.relative(plan.temp, directory).split(path.sep).join("/"),
  );
  fs.writeFileSync(listFile, `${relative.join("\n")}\n`);
  const zip = path.join(
    archiveDir,
    `temp-evidence-${plan.generatedAt.slice(0, 10)}.zip`,
  );
  const tar =
    process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
  const created = spawnSync(
    tar,
    ["-a", "-cf", zip, "-C", plan.temp, "-T", listFile],
    { stdio: "inherit" },
  );
  if (created.status !== 0) {
    return {
      verified: false,
      zip,
      pngInZip: 0,
      pngOnDisk,
      dirs,
      reason: `tar exited ${created.status}`,
    };
  }
  const listed = spawnSync(tar, ["-tf", zip], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const pngInZip = (listed.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => /\.(png|webp)$/i.test(line)).length;
  const verified = pngInZip === pngOnDisk;
  return {
    verified,
    zip,
    pngInZip,
    pngOnDisk,
    dirs,
    reason: verified ? undefined : "PNG count in the zip differs from disk",
  };
}

/**
 * Unlink every symlink and junction inside `root` BEFORE any recursive removal,
 * so a delete can never reach through a link into a tree the plan never saw.
 *
 * @param {string} root
 * @param {{links: number, errors: string[]}} log
 */
export function unlinkLinksWithin(root, log) {
  const stats = lstatSafe(root);
  if (stats === null) return;
  if (stats.isSymbolicLink()) {
    removeLink(root, log);
    return;
  }
  if (!stats.isDirectory()) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) removeLink(child, log);
    else if (entry.isDirectory()) unlinkLinksWithin(child, log);
  }
}

/** The real write-open probe. Separated so `hasLiveLock` stays testable. */
function openForWrite(target) {
  fs.closeSync(fs.openSync(target, "r+"));
}

function removeLink(target, log) {
  // A Windows directory junction needs rmdir; a file symlink needs unlink.
  try {
    fs.rmdirSync(target);
    log.links += 1;
    return;
  } catch {
    /* fall through to unlink */
  }
  try {
    fs.unlinkSync(target);
    log.links += 1;
  } catch (error) {
    log.errors.push(`link ${target}: ${error.message}`);
  }
}

/**
 * True when something still holds the path open. Only EBUSY counts: a
 * read-only file is a permission bit, not a live handle, and spec fixtures
 * deliberately chmod their outputs read-only — so the read-only ATTRIBUTE is
 * what separates the two cases, not the errno. A writable file that still
 * refuses `r+` (EBUSY, and on Windows EPERM for a mapped image) is held.
 *
 * @param {string} target
 * @param {(target: string) => void} [open] Write-open probe; injectable so the
 *   spec can exercise the busy branch without a second process.
 * @returns {boolean}
 */
export function hasLiveLock(target, open = openForWrite) {
  const stats = lstatSafe(target);
  if (stats === null) return false;
  if (stats.isFile()) {
    // A file the filesystem itself reports as read-only cannot be opened for
    // writing for a reason that has nothing to do with another process: spec
    // fixtures chmod their published outputs 0o444 on purpose, and treating
    // those as locked would make the whole tree permanently unsweepable.
    // Only a file that IS writable and still refuses to open is being held.
    if ((stats.mode & 0o200) === 0) return false;
    try {
      open(target);
      return false;
    } catch (error) {
      return (
        error.code === "EBUSY" ||
        error.code === "EPERM" ||
        error.code === "EACCES"
      );
    }
  }
  if (!stats.isDirectory()) return false;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return false;
  }
  // Bounded: a lock lives at the top of a runner's profile, not twelve levels in.
  for (const entry of entries.slice(0, 64)) {
    if (!entry.isFile()) continue;
    if (!/(^|\.)lock(file)?$|^LOCK$/i.test(entry.name)) continue;
    if (hasLiveLock(path.join(target, entry.name), open)) return true;
  }
  return false;
}

/**
 * Delete exactly the plan's positive list. Every path is re-checked here; a
 * path that fails any check is skipped and reported, never removed.
 *
 * @param {object} plan
 * @param {{requireEvidenceReceipt?: boolean, open?: (target: string) => void}} [options]
 * @returns {{deleted: number, bytes: number, skipped: string[], errors: string[], links: number, refused: string|null}}
 */
export function executePlan(plan, options = {}) {
  const log = {
    deleted: 0,
    bytes: 0,
    skipped: [],
    errors: [],
    links: 0,
    refused: null,
  };
  const temp = path.resolve(plan.temp);
  if (!fs.existsSync(temp)) {
    log.refused = `plan temp root does not exist: ${temp}`;
    return log;
  }
  // `--plan --temp <dir>` will classify any directory, because planning reads
  // and writes nothing. Deleting is different: the plan file names its own
  // root, so without this the only containment `--execute` has is a value the
  // plan supplied to itself. This tool sweeps the system temp directory and
  // refuses anything else, with no flag to override it.
  //
  // `isUnderTmpdir` from lane-tmp is deliberately STRICT (the lane helper must
  // never be able to remove the Temp root), and the Temp root is precisely what
  // this tool sweeps — so the root itself is admitted here, and only here.
  const tmpRoot = normalize(os.tmpdir());
  if (
    normalize(temp) !== tmpRoot &&
    !normalize(temp).startsWith(tmpRoot + path.sep)
  ) {
    log.refused = `plan temp root is not the system temp directory or a child of it: ${temp} (tmpdir ${path.resolve(os.tmpdir())})`;
    return log;
  }
  const requireReceipt = options.requireEvidenceReceipt !== false;
  const evidenceDirs = plan.evidence?.dirs ?? [];
  if (
    requireReceipt &&
    evidenceDirs.length > 0 &&
    plan.evidence?.receipt?.verified !== true
  ) {
    log.refused = `${evidenceDirs.length} evidence director${evidenceDirs.length === 1 ? "y" : "ies"} inside the delete set are not banked — run --bank-evidence first`;
    return log;
  }
  const protects = protectPaths(temp);
  const horizon = Number(plan.generatedAtMs ?? Date.parse(plan.generatedAt));
  if (!Number.isFinite(horizon)) {
    // Without a horizon the age check silently stops running, and a hand-written
    // plan is exactly the case it exists to catch. Refuse rather than degrade.
    log.refused = `plan has no usable generatedAt horizon: ${JSON.stringify(plan.generatedAt ?? null)}`;
    return log;
  }
  const runningSession =
    typeof plan.runningSession === "string" ? plan.runningSession : null;
  for (const row of plan.delete ?? []) {
    const target = path.resolve(row.path);
    if (isProtected(target, protects)) {
      log.skipped.push(`PROTECTED ${target}`);
      continue;
    }
    if (
      runningSession !== null &&
      (normalize(target) === normalize(runningSession) ||
        normalize(target).startsWith(normalize(runningSession) + path.sep))
    ) {
      // A plan re-executed later can name a session that has since gone live.
      log.skipped.push(`RUNNING SESSION ${target}`);
      continue;
    }
    if (!normalize(target).startsWith(normalize(temp) + path.sep)) {
      log.skipped.push(`OUTSIDE TEMP ${target}`);
      continue;
    }
    const stats = lstatSafe(target);
    if (stats === null) {
      log.skipped.push(`gone ${target}`);
      continue;
    }
    const newest = measure(target).newest || stats.mtimeMs;
    if (newest > horizon) {
      log.skipped.push(`CHANGED SINCE THE PLAN ${target}`);
      continue;
    }
    if (hasLiveLock(target, options.open)) {
      log.skipped.push(`LOCKED ${target}`);
      continue;
    }
    try {
      unlinkLinksWithin(target, log);
      fs.rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
      if (lstatSafe(target) !== null) {
        log.skipped.push(`still present ${target}`);
      } else {
        log.deleted += 1;
        log.bytes += row.bytes ?? 0;
      }
    } catch (error) {
      log.errors.push(`${target}: ${error.message}`);
    }
  }
  return log;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const format = (bytes) =>
  bytes >= 1 << 30
    ? `${(bytes / (1 << 30)).toFixed(2)} GB`
    : bytes >= 1 << 20
      ? `${(bytes / (1 << 20)).toFixed(1)} MB`
      : `${(bytes / 1024).toFixed(0)} KB`;

function main(argv) {
  if (argv.includes("--help")) {
    process.stdout.write(
      "node Tools/temp-hygiene.mjs --plan [--out plan.json] [--temp <dir>] [--finished-lanes <a,b>]\n" +
        "node Tools/temp-hygiene.mjs --bank-evidence <archiveDir> --plan plan.json\n" +
        "node Tools/temp-hygiene.mjs --execute --plan plan.json\n",
    );
    return 0;
  }
  const planPath = readOption(argv, "--plan");
  const archiveDir = readOption(argv, "--bank-evidence");
  const execute = argv.includes("--execute");

  if (execute || (archiveDir !== null && planPath !== null)) {
    if (planPath === null) {
      process.stderr.write("--execute requires --plan <json>\n");
      return 2;
    }
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    if (archiveDir !== null) {
      const receipt = bankEvidence(plan, archiveDir);
      plan.evidence = { ...(plan.evidence ?? {}), dirs: receipt.dirs, receipt };
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 1));
      process.stdout.write(
        `banked ${receipt.dirs.length} evidence dirs: png in zip ${receipt.pngInZip}, on disk ${receipt.pngOnDisk} — ${receipt.verified ? "VERIFIED" : `REFUSED (${receipt.reason})`}\n`,
      );
      if (!receipt.verified) return 1;
      if (!execute) return 0;
    }
    const report = executePlan(plan);
    const reportPath = `${planPath.replace(/\.json$/, "")}-execute-report.json`;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
    if (report.refused !== null) {
      process.stderr.write(`REFUSED: ${report.refused}\n`);
      return 1;
    }
    process.stdout.write(
      `deleted ${report.deleted}/${plan.delete.length}, ${format(report.bytes)} freed; links unlinked first ${report.links}; skipped ${report.skipped.length}; errors ${report.errors.length}; report ${reportPath}\n`,
    );
    for (const line of report.skipped.slice(0, 20))
      process.stdout.write(`  skip: ${line}\n`);
    for (const line of report.errors.slice(0, 20))
      process.stdout.write(`  err:  ${line}\n`);
    return 0;
  }

  const finishedLanes = readOption(argv, "--finished-lanes");
  if (argv.includes("--finished-lanes") && finishedLanes === null) {
    process.stderr.write(
      "REFUSED: --finished-lanes needs <lane>[,<lane>...]\n",
    );
    return 1;
  }
  let plan;
  try {
    plan = planTempRoot({
      temp: readOption(argv, "--temp") ?? undefined,
      finishedLanes: finishedLanes ?? undefined,
    });
  } catch (error) {
    process.stderr.write(`REFUSED: ${error.message}\n`);
    return 1;
  }
  let out = readOption(argv, "--out");
  if (out === null) {
    out = defaultPlanPath();
    fs.mkdirSync(path.dirname(out), { recursive: true });
  }
  fs.writeFileSync(out, JSON.stringify(plan, null, 1));
  const byCategory = new Map();
  for (const row of plan.delete) {
    const current = byCategory.get(row.category) ?? { n: 0, bytes: 0 };
    current.n += 1;
    current.bytes += row.bytes;
    byCategory.set(row.category, current);
  }
  process.stdout.write(
    `PLAN ${out}\nDELETE ${plan.totals.deleteEntries} entries, ${plan.totals.deleteFiles} files, ${format(plan.totals.deleteBytes)}\n` +
      `KEEP ${plan.keep.length} entries, ${format(plan.totals.keepBytes)}   RESIDUE ${plan.totals.residueEntries} entries (kept, listed)\n` +
      `EVIDENCE ${plan.evidence.dirs.length} PNG-bearing directories inside the delete set${plan.evidence.dirs.length > 0 ? " — --bank-evidence before --execute" : ""}` +
      ` (${plan.evidence.trackedCopyDirs} more hold only copies of tracked images and are not evidence)\n`,
  );
  if (plan.finishedLanes.named.length + plan.finishedLanes.missing.length > 0) {
    process.stdout.write(
      `FINISHED LANES on the delete list: ${plan.finishedLanes.named.join(", ") || "none"}` +
        `${plan.finishedLanes.missing.length > 0 ? `; NO ROOT: ${plan.finishedLanes.missing.join(", ")}` : ""}\n`,
    );
  }
  for (const [category, value] of [...byCategory].sort(
    (a, b) => b[1].bytes - a[1].bytes,
  )) {
    process.stdout.write(
      `${format(value.bytes).padStart(10)}  ${String(value.n).padStart(5)}  ${category}\n`,
    );
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
