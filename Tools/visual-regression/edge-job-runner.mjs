#!/usr/bin/env node
// edge-job-runner.mjs — runs an Edge job's probe commands from a plan, one at a time, and indexes their receipts.
//
// @purpose Reads a positive-list plan (edge-job-plan.json: family, probe, args, env, expected exits, rigs, instrument note), runs each entry strictly in order with --output under the job directory, stops on an infrastructure refusal and never retries a refusal, writes <jobDir>/<family>/INDEX.md plus <jobDir>/elapsed.json, and exits 4 (naming the entries on one stdout line and in elapsed.json) when a finished entry's exit lies outside its plan expectedExit; a selection that resolves no entry is refused as a usage error (exit 2); --dry-run prints the commands and launches nothing.
// @status ACTIVE
//
// WHY THIS EXISTS. A wave-end Edge job is roughly eighty probe commands across
// ten families. Run by hand they were typed one at a time, run with whatever
// output directory the probe defaulted to (some of them the shared output root,
// where banked pre-migration frames live), and indexed afterwards from memory.
// This runner makes the job a file: the plan is reviewed before the slot is
// taken, every entry writes under its own `<jobDir>/<family>/<id>/`, and the
// index and the elapsed table are written as the job goes, so a job stopped by
// an infrastructure refusal still leaves an honest record of what it ran.
//
// WHAT IT NEVER DOES.
//   - Run two entries at once. The probe runtime takes the single Edge slot
//     itself (`lib/probe-edge-slot.mjs`); the runner adds the ordering.
//   - Retry. A refusal is the instrument saying it could not see its subject;
//     a second attempt is a second measurement nobody planned.
//   - Continue past an INFRASTRUCTURE refusal (served build, origin, Edge slot,
//     port), a refusal it cannot identify, a spawn failure or a timeout: every
//     later entry would refuse or measure the wrong thing for the same reason.
//     A SUBJECT refusal (a chrome-over-canvas leftover, a renderer the probe
//     cannot measure, a lost device) is recorded and the job continues.
//   - Run an entry whose probe cannot take `--output`, or a plan whose args
//     already carry `--output` or point at port 8080. Those are refused when
//     the plan is loaded, before anything launches.
//   - Run a job whose directory lies outside the checkout. A probe on the
//     runtime refuses an `--output` outside its repository root
//     (`lib/probe-output-location.mjs`, Batch 1623), so every runtime entry
//     would exit 2 before launch and the job would be a wall of errors; the
//     plan is refused at load instead, naming the directory and the root.
//   - Run a job whose selection resolves no entry (an empty plan, or a
//     --family value with no family name in it). Such a job would measure
//     nothing and still finish clean, so the plan is refused at load.
//   - Let a job whose entries errored read as clean. It keeps running past an
//     errored entry (an error is the subject's or the host's, and a later
//     entry may still measure), but it exits 4 when a finished entry's exit
//     lies outside that entry's `expectedExit`.
//   - Launch a browser itself. It spawns `node <probe>` through the kit's
//     bounded child runner (`Tools/lib/bounded-command.mjs`).
//
// MORIA F3. `page.waitForFunction(fn, { timeout })` passes the options object
// as the PAGE FUNCTION'S ARGUMENT, so the wait runs at Playwright's 30 s
// default whatever timeout it declares. The runner reads each probe's source
// (and the `./lib/` modules it imports) for that shape and writes it into the
// entry's instrument note, so an early timeout in such a probe is read as F3,
// not as a finding about the engine.
//
// Usage:
//   node Tools/visual-regression/edge-job-runner.mjs --job-dir <dir> [--plan <file>] [--family a,b] [--dry-run]
// Default plan: Tools/visual-regression/edge-job-plan.json.
//
// Exit codes (precedence 2, then 1, then 4, then 0):
//   0  every entry that ran finished with an exit its plan lists in
//      `expectedExit` (a verdict failure the plan expects is still 0), or
//      --dry-run of a selection of at least one entry, which finishes no
//      entry; either way at least one entry was selected. It does NOT mean
//      "no entry errored": an entry that errored with an exit the plan lists
//      is 0.
//   1  the job stopped early (infrastructure refusal, unidentified refusal,
//      spawn failure or timeout), whatever the finished entries' exits.
//   2  usage error or invalid plan; nothing was launched and no job directory
//      was made. A selection that resolves no entry is a usage error: a plan
//      with no entries, or a --family value that names no family once split
//      on commas and trimmed (`""`, `","`, `" "`), with or without --dry-run.
//   4  every entry that ran finished and the job did not stop early, but at
//      least one finished entry's exit lies outside its `expectedExit` (an
//      entry that errored, an unexpected verdict failure or a subject
//      refusal; an entry with no exit stops the job, so it reads 1 and is still
//      named). Not a probe exit code (those are 0 to 3).
// After a run (not --dry-run) one stdout line names the count and the entries
// that exited outside their expected exits, and elapsed.json carries the same
// fact as `unexpectedExits`; a stopped job writes both too. A second line
// names how many finished entries measured (a pass or a verdict failure that
// left a -report.json receipt, or a c11 harness's performance/ artifact) and
// which, and elapsed.json carries it as
// `measured`; exit 0 does not by itself say that anything measured.

import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "../lib/bounded-command.mjs";
import { blankNonCode } from "./lib/probe-fleet-contract.mjs";
import { PROBE_EXIT_CODES } from "./lib/probe-refusal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");

export const DEFAULT_PLAN_PATH = path.join(HERE, "edge-job-plan.json");

/** Per-entry ceiling when the plan names none (the wave-end gate's own). */
export const DEFAULT_ENTRY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TERMINATION_GRACE_MS = 10_000;

/**
 * Refusal ids that mean the job's INFRASTRUCTURE is wrong, so every later
 * entry would refuse or mismeasure for the same reason. Read from the kit
 * modules that raise them: `lib/probe-runtime-decisions.mjs` (served build,
 * origin, port and the c11 run-entry PROBE_BASE refusal; the runtime
 * re-exports it) and `lib/probe-edge-slot.mjs` (the slot).
 */
export const INFRASTRUCTURE_REFUSAL_CLASSES = Object.freeze({
  "served-build-preflight-failed": "served-build",
  "served-build-preflight-incomplete": "served-build",
  "origin-mismatch": "origin",
  "requested-origin-invalid": "origin",
  "navigation-url-invalid": "origin",
  "edge-slot-busy": "slot",
  "port-8080-forbidden": "port",
  "probe-base-unset": "port",
});

/** The outcome classes an entry can end in, as the index spells them. */
export const ENTRY_OUTCOMES = Object.freeze({
  OK: "ok",
  VERDICT_FAIL: "verdict-fail",
  ERRORED: "errored",
  SUBJECT_REFUSAL: "subject-refusal",
  INFRASTRUCTURE_REFUSAL: "infrastructure-refusal",
  UNIDENTIFIED_REFUSAL: "unidentified-refusal",
  RUNNER_FAILURE: "runner-failure",
  DRY_RUN: "dry-run",
});

/** Outcomes that stop the job. */
const STOPPING_OUTCOMES = new Set([
  ENTRY_OUTCOMES.INFRASTRUCTURE_REFUSAL,
  ENTRY_OUTCOMES.UNIDENTIFIED_REFUSAL,
  ENTRY_OUTCOMES.RUNNER_FAILURE,
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** A plan the runner will not run. Nothing launches when this is thrown. */
export class EdgeJobPlanError extends Error {
  /**
   * @param {string[]} problems One line per problem.
   */
  constructor(problems) {
    super(`edge-job plan refused:\n  - ${problems.join("\n  - ")}`);
    this.name = "EdgeJobPlanError";
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Probe source reading
// ---------------------------------------------------------------------------

/**
 * Whether a probe takes `--output`: it is runtime-resident (the runtime's core
 * flags include `--output`) or its own source parses the flag.
 *
 * @param {string} source The probe's source text.
 * @returns {boolean} True when the flag is accepted.
 */
export function probeAcceptsOutput(source) {
  return (
    /@runtime\s+lib\/probe-runtime\.mjs/.test(source) ||
    /["'`]--output["'`]/.test(source) ||
    /\bparseOutputOnlyArgs\s*\(/.test(source)
  );
}

/**
 * Find the Moria F3 shape: a `waitForFunction` call with exactly two
 * arguments whose second is an object literal carrying `timeout`. The options
 * then reach the page function as its argument and the wait runs at
 * Playwright's 30 s default.
 *
 * @param {string} source Source text.
 * @returns {Array<{line: number}>} One site per offending call (1-based lines).
 */
export function findOptionsAsArgumentWaits(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const code = blankNonCode(normalized);
  const sites = [];
  const pattern = /\bwaitForFunction\s*\(/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const open = match.index + match[0].length - 1;
    const args = splitTopLevelArguments(code, open);
    if (args === null || args.length !== 2) {
      continue;
    }
    const second = args[1].trim();
    if (second.startsWith("{") && /\btimeout\b/.test(second)) {
      sites.push({ line: normalized.slice(0, match.index).split("\n").length });
    }
  }
  return sites;
}

/**
 * Split a call's argument list at top-level commas.
 *
 * @param {string} code Blanked source.
 * @param {number} open Index of the call's `(`.
 * @returns {string[]|null} The argument texts (a trailing empty one dropped), or null when unbalanced.
 */
function splitTopLevelArguments(code, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < code.length; index++) {
    const ch = code[index];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(code.slice(start, index));
        if (args.length > 0 && args[args.length - 1].trim() === "") {
          args.pop();
        }
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(code.slice(start, index));
      start = index + 1;
    }
  }
  return null;
}

/**
 * The probe file and the `./lib/*.mjs` modules it imports directly.
 *
 * @param {string} probeFile Absolute probe path.
 * @param {Function} readText `(file) => string`.
 * @returns {Array<{file: string, source: string}>}
 */
function probeSourceSet(probeFile, readText) {
  const source = readText(probeFile);
  const set = [{ file: probeFile, source }];
  const importPattern = /from\s+["'](\.\/lib\/[^"']+\.mjs)["']/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const file = path.resolve(path.dirname(probeFile), match[1]);
    try {
      set.push({ file, source: readText(file) });
    } catch {
      // An unreadable import is the probe's own problem, not the note's.
    }
  }
  return set;
}

/**
 * The instrument note an entry is indexed with: the plan's own note, then any
 * F3 site found in the probe or its direct `./lib/` imports.
 *
 * @param {object} entry Plan entry.
 * @param {string} probeFile Absolute probe path.
 * @param {Function} readText `(file) => string`.
 * @returns {string} The note.
 */
export function instrumentNoteFor(entry, probeFile, readText) {
  const parts = [];
  if (typeof entry.instrumentNote === "string" && entry.instrumentNote) {
    parts.push(entry.instrumentNote);
  }
  for (const { file, source } of probeSourceSet(probeFile, readText)) {
    for (const site of findOptionsAsArgumentWaits(source)) {
      parts.push(
        `Moria F3 at ${path.relative(REPOSITORY_ROOT, file).replaceAll("\\", "/")}:${site.line}: waitForFunction(fn, {timeout}) passes the options as the page-function argument, so that wait runs at Playwright's 30 s default; an early timeout there is F3, not a finding`,
      );
    }
  }
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Validate a plan and resolve each entry. Throws {@link EdgeJobPlanError}
 * listing EVERY problem; nothing launches from a refused plan.
 *
 * @param {object} plan Parsed plan.
 * @param {object} options Options.
 * @param {string} options.jobDir The job directory.
 * @param {string[]|null} [options.families] Run only these families (positive list).
 * @param {Function} [options.readText] `(file) => string`.
 * @param {Function} [options.exists] `(file) => boolean`.
 * @param {string} [options.repositoryRoot] The checkout the job directory must lie in (a spec seam; the default is this runner's checkout).
 * @returns {Array<object>} Resolved entries, in plan order.
 */
export function resolvePlan(
  plan,
  {
    jobDir,
    families = null,
    readText = (file) => fs.readFileSync(file, "utf8"),
    exists = (file) => fs.existsSync(file),
    repositoryRoot = REPOSITORY_ROOT,
  },
) {
  const problems = [];
  if (!plan || plan.schema !== 1 || !Array.isArray(plan.entries)) {
    throw new EdgeJobPlanError(["plan must be { schema: 1, entries: [...] }"]);
  }
  const root = path.resolve(repositoryRoot);
  const jobRelative = path.relative(root, path.resolve(jobDir));
  if (jobRelative.startsWith("..") || path.isAbsolute(jobRelative)) {
    problems.push(
      `--job-dir ${path.resolve(jobDir)} is outside the repository root ${root}: a probe on the runtime refuses an --output outside its checkout (lib/probe-output-location.mjs), so every runtime entry would exit 2 before launch`,
    );
  }
  const known = new Set(plan.entries.map((entry) => entry?.family));
  for (const family of families ?? []) {
    if (!known.has(family)) {
      problems.push(`--family ${family} names no family in the plan`);
    }
  }
  const seen = new Set();
  const resolved = [];
  let selected = 0;
  for (const [index, entry] of plan.entries.entries()) {
    const where = `entry ${index} (${entry?.family}/${entry?.id})`;
    if (!entry || typeof entry !== "object") {
      problems.push(`entry ${index} is not an object`);
      continue;
    }
    if (families !== null && !families.includes(entry.family)) {
      continue;
    }
    selected += 1;
    if (typeof entry.family !== "string" || !ID_PATTERN.test(entry.family)) {
      problems.push(`${where}: family must match ${ID_PATTERN}`);
    }
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) {
      problems.push(`${where}: id must match ${ID_PATTERN}`);
    }
    const key = `${entry.family}/${entry.id}`;
    if (seen.has(key)) {
      problems.push(`${where}: duplicate family/id ${key}`);
    }
    seen.add(key);
    if (
      typeof entry.probe !== "string" ||
      !/^probe-[a-z0-9._-]+\.mjs$/.test(entry.probe)
    ) {
      problems.push(
        `${where}: probe must be a top-level probe-*.mjs file name`,
      );
      continue;
    }
    const args = entry.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      problems.push(`${where}: args must be an array of strings`);
      continue;
    }
    if (args.includes("--output")) {
      problems.push(
        `${where}: args carry --output; the runner owns the output directory`,
      );
    }
    const portIndex = args.indexOf("--port");
    if (portIndex !== -1 && args[portIndex + 1] === "8080") {
      problems.push(`${where}: --port 8080 is forbidden`);
    }
    const env = entry.env ?? {};
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      problems.push(`${where}: env must be an object of strings`);
      continue;
    }
    for (const [name, value] of Object.entries(env)) {
      if (!ENV_NAME_PATTERN.test(name) || typeof value !== "string") {
        problems.push(
          `${where}: env ${name} must be an UPPER_CASE name with a string value`,
        );
      } else if (/:8080(?:\/|$)/.test(value)) {
        problems.push(`${where}: env ${name} points at port 8080`);
      }
    }
    const expectedExit = entry.expectedExit ?? [PROBE_EXIT_CODES.OK];
    if (
      !Array.isArray(expectedExit) ||
      expectedExit.length === 0 ||
      !expectedExit.every((code) =>
        Object.values(PROBE_EXIT_CODES).includes(code),
      )
    ) {
      problems.push(`${where}: expectedExit must list probe exit codes`);
    }
    if (
      entry.timeoutMs !== undefined &&
      (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1)
    ) {
      problems.push(`${where}: timeoutMs must be a positive safe integer`);
    }
    const probeFile = path.join(HERE, entry.probe);
    if (!exists(probeFile)) {
      problems.push(`${where}: ${entry.probe} does not exist`);
      continue;
    }
    let source;
    try {
      source = readText(probeFile);
    } catch (error) {
      problems.push(`${where}: ${entry.probe} unreadable (${error.message})`);
      continue;
    }
    if (!probeAcceptsOutput(source)) {
      problems.push(
        `${where}: ${entry.probe} cannot take --output (not runtime-resident and parses no --output), so its writes cannot be kept out of the shared output root`,
      );
      continue;
    }
    const outputDirectory = path.resolve(jobDir, entry.family, entry.id);
    if (exists(outputDirectory)) {
      problems.push(
        `${where}: ${outputDirectory} already exists; a job never writes over an earlier job's receipts`,
      );
    }
    resolved.push({
      family: entry.family,
      id: entry.id,
      probe: entry.probe,
      probeFile,
      args: [...args],
      env: { ...env },
      expectedExit: [...expectedExit],
      rigs: Array.isArray(entry.rigs) ? [...entry.rigs] : [],
      timeoutMs: entry.timeoutMs ?? DEFAULT_ENTRY_TIMEOUT_MS,
      outputDirectory,
      instrumentNote: instrumentNoteFor(entry, probeFile, readText),
      argv: [
        process.execPath,
        path.relative(REPOSITORY_ROOT, probeFile).replaceAll("\\", "/"),
        ...args,
        "--output",
        outputDirectory,
      ],
    });
  }
  if (selected === 0) {
    problems.push(emptySelectionProblem(plan, families));
  }
  if (problems.length > 0) {
    throw new EdgeJobPlanError(problems);
  }
  return resolved;
}

/**
 * The cause named when a selection resolves no entry: a job with nothing
 * selected would launch nothing and still finish clean.
 *
 * @param {object} plan The plan.
 * @param {string[]|null} families The family selection.
 * @returns {string} One problem line.
 */
function emptySelectionProblem(plan, families) {
  const cause =
    plan.entries.length === 0
      ? "the plan has no entries"
      : families !== null && families.length === 0
        ? "--family names no family once split on commas and trimmed"
        : families !== null
          ? `--family ${families.join(",")} selects no entry of the plan`
          : "no entry of the plan is an object";
  return `the selection resolves no entry (${cause}): a job that runs nothing would measure nothing and still finish clean`;
}

/**
 * The shell-readable form of one entry's command, env first.
 *
 * @param {object} entry A resolved entry.
 * @returns {string} One line.
 */
export function formatCommand(entry) {
  const quote = (value) =>
    /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value) ? value : JSON.stringify(value);
  const env = Object.entries(entry.env).map(([k, v]) => `${k}=${quote(v)}`);
  return [...env, "node", ...entry.argv.slice(1).map(quote)].join(" ");
}

// ---------------------------------------------------------------------------
// Reading what an entry left behind
// ---------------------------------------------------------------------------

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listFiles(directory) {
  try {
    return fs.readdirSync(directory).sort();
  } catch {
    return [];
  }
}

/**
 * Collect the receipt facts of one finished entry from its output directory.
 *
 * @param {string} outputDirectory The entry's `--output`.
 * @param {string} stderrText What the child printed on stderr.
 * @returns {{reports: Array<{name: string, md5: string}>, redVerdictIds: string[], refusalId: string|null, receiptElapsedMs: number|null, harnessArtifacts: string[]}}
 */
export function readEntryReceipts(outputDirectory, stderrText = "") {
  const files = listFiles(outputDirectory);
  const reports = files
    .filter((name) => name.endsWith("-report.json"))
    .map((name) => ({
      name,
      md5: createHash("md5")
        .update(fs.readFileSync(path.join(outputDirectory, name)))
        .digest("hex"),
    }));
  const runtimeFile = files.find((name) => name.endsWith("-runtime.json"));
  const reportFile = files.find((name) => name.endsWith("-report.json"));
  const incidentFile = files.find(
    (name) => name.endsWith("-refusal.json") || name.endsWith("-error.json"),
  );
  const runtime = runtimeFile
    ? readJsonOrNull(path.join(outputDirectory, runtimeFile))
    : null;
  const report = reportFile
    ? readJsonOrNull(path.join(outputDirectory, reportFile))
    : null;
  const incident = incidentFile
    ? readJsonOrNull(path.join(outputDirectory, incidentFile))
    : null;

  const verdicts = Array.isArray(runtime?.verdicts)
    ? runtime.verdicts
    : Array.isArray(report?.verdicts)
      ? report.verdicts
      : [];
  const redVerdictIds = verdicts
    .filter((verdict) => verdict?.pass !== true)
    .map((verdict) => String(verdict?.id ?? verdict?.claim ?? "verdict"));

  let refusalId = incident?.refusal?.reason ?? null;
  if (refusalId === null) {
    const printed = /REFUSED \(([a-z0-9][a-z0-9-]*)\)/.exec(stderrText);
    refusalId = printed ? printed[1] : null;
  }

  const elapsedSource = runtime ?? incident ?? report;
  const receiptElapsedMs = Number.isSafeInteger(elapsedSource?.elapsedMs)
    ? elapsedSource.elapsedMs
    : null;
  // The c11 harnesses (own protocol, not runProbe) write their canonical
  // artifact under <output>/performance/ instead of a top-level report.
  const harnessArtifacts = listFiles(
    path.join(outputDirectory, "performance"),
  ).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".first-red.json"),
  );
  return {
    reports,
    redVerdictIds,
    refusalId,
    receiptElapsedMs,
    harnessArtifacts,
  };
}

/**
 * Classify a finished entry.
 *
 * @param {{exitCode: number|null, timedOut?: boolean, spawnError?: unknown}} child What the child did.
 * @param {string|null} refusalId The refusal id read back, if any.
 * @returns {string} One of {@link ENTRY_OUTCOMES}.
 */
export function classifyEntry(child, refusalId) {
  if (child.spawnError || child.timedOut || child.exitCode === null) {
    return ENTRY_OUTCOMES.RUNNER_FAILURE;
  }
  if (child.exitCode === PROBE_EXIT_CODES.REFUSAL) {
    if (refusalId === null) {
      return ENTRY_OUTCOMES.UNIDENTIFIED_REFUSAL;
    }
    return Object.hasOwn(INFRASTRUCTURE_REFUSAL_CLASSES, refusalId)
      ? ENTRY_OUTCOMES.INFRASTRUCTURE_REFUSAL
      : ENTRY_OUTCOMES.SUBJECT_REFUSAL;
  }
  if (child.exitCode === PROBE_EXIT_CODES.OK) {
    return ENTRY_OUTCOMES.OK;
  }
  if (child.exitCode === PROBE_EXIT_CODES.FAILURE) {
    return ENTRY_OUTCOMES.VERDICT_FAIL;
  }
  return ENTRY_OUTCOMES.ERRORED;
}

// ---------------------------------------------------------------------------
// The index and the elapsed table
// ---------------------------------------------------------------------------

const cell = (value) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ");

/**
 * The family index, rewritten after every entry so a stopped job leaves one.
 *
 * @param {string} family Family name.
 * @param {Array<object>} rows Finished rows of this family.
 * @returns {string} Markdown.
 */
export function renderFamilyIndex(family, rows) {
  const lines = [
    `# Edge job index: ${family}`,
    "",
    "| probe | exit | expected | outcome | report md5 | red verdict ids | refusal id | elapsedMs (receipt / wall) | instrument note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${cell(`${row.id} (${row.probe})`)} | ${cell(row.exitCode)} | ${cell(row.expectedExit.join(","))}${row.unexpectedExit ? " (UNEXPECTED)" : ""} | ${cell(row.outcome)} | ${cell(row.reports.map((r) => `${r.name} ${r.md5}`).join("; ") || "none")} | ${cell(row.redVerdictIds.join(", ") || "none")} | ${cell(row.refusalId ?? "none")} | ${cell(`${row.receiptElapsedMs ?? "n/a"} / ${row.wallClockMs ?? "n/a"}`)} | ${cell(row.instrumentNote || "none")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Count `--runs N` in an entry's args (1 when absent).
 *
 * @param {string[]} args Entry args.
 * @returns {number} The run count the probe was asked for.
 */
function runsOf(args) {
  const index = args.indexOf("--runs");
  const value = index === -1 ? 1 : Number(args[index + 1]);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * The default spawner: `runBoundedCommand` (the kit's bounded child runner)
 * with its spawn seam carrying the entry's env over the runner's own.
 *
 * @param {{argv: string[], cwd: string, env: object, timeoutMs: number, artifactPath: string}} command
 * @returns {Promise<{exitCode: number|null, timedOut: boolean, spawnError: object|null, stdout: string, stderr: string}>}
 */
export async function spawnWithBoundedCommand(command) {
  const result = await runBoundedCommand(
    {
      argv: command.argv,
      cwd: command.cwd,
      artifactPath: command.artifactPath,
      timeoutMs: command.timeoutMs,
      terminationGraceMs: TERMINATION_GRACE_MS,
    },
    {
      spawn: (file, args, options) =>
        nodeSpawn(file, args, {
          ...options,
          env: { ...process.env, ...command.env },
        }),
    },
  );
  const raw = result.raw;
  return {
    exitCode: raw.native.close.observed ? raw.native.close.exitCode : null,
    timedOut: raw.timeout.expired === true,
    spawnError: raw.native.spawnError ?? raw.native.childError ?? null,
    stdout: raw.stdout.retainedUtf8 ?? "",
    stderr: raw.stderr.retainedUtf8 ?? "",
  };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * The finished entries whose exit lies outside their plan `expectedExit`. An
 * entry with no exit (spawn failure, timeout) counts as outside.
 *
 * @param {Array<object>} rows Finished rows.
 * @returns {{count: number, entries: Array<{family: string, id: string, exitCode: number|null, expectedExit: number[]}>}}
 */
function summarizeUnexpectedExits(rows) {
  const entries = rows
    .filter((row) => row.unexpectedExit === true)
    .map((row) => ({
      family: row.family,
      id: row.id,
      exitCode: row.exitCode,
      expectedExit: row.expectedExit,
    }));
  return { count: entries.length, entries };
}

/**
 * The one stdout line that names the unexpected exits.
 *
 * @param {number} finished How many entries finished.
 * @param {{count: number, entries: Array<object>}} unexpected From {@link summarizeUnexpectedExits}.
 * @returns {string} The line, newline-terminated.
 */
function unexpectedExitsLine(finished, unexpected) {
  const named =
    unexpected.count === 0
      ? "none"
      : unexpected.entries
          .map(
            (e) =>
              `${e.family}/${e.id} (exit ${e.exitCode}, expected ${e.expectedExit.join(",")})`,
          )
          .join(", ");
  return `[edge-job] ${unexpected.count} of ${finished} finished entries exited outside their expected exits: ${named}\n`;
}

/**
 * The finished entries that measured: a pass or a verdict failure that left
 * at least one `-report.json` receipt, or, for a c11 harness, a canonical
 * artifact under `performance/`. An errored, refused, stopped or receiptless
 * entry did not measure, whatever its plan expected.
 *
 * @param {Array<object>} rows Finished rows.
 * @returns {{count: number, entries: Array<{family: string, id: string}>}}
 */
function summarizeMeasured(rows) {
  const entries = rows
    .filter(
      (row) =>
        (row.outcome === ENTRY_OUTCOMES.OK ||
          row.outcome === ENTRY_OUTCOMES.VERDICT_FAIL) &&
        (row.reports.length > 0 || row.harnessArtifacts.length > 0),
    )
    .map((row) => ({ family: row.family, id: row.id }));
  return { count: entries.length, entries };
}

/**
 * The one stdout line that names the entries that measured.
 *
 * @param {number} finished How many entries finished.
 * @param {{count: number, entries: Array<object>}} measured From {@link summarizeMeasured}.
 * @returns {string} The line, newline-terminated.
 */
function measuredLine(finished, measured) {
  const named =
    measured.count === 0
      ? "none"
      : measured.entries.map((e) => `${e.family}/${e.id}`).join(", ");
  return `[edge-job] ${measured.count} of ${finished} finished entries measured (exit 0 or 1 with a receipt): ${named}\n`;
}

/**
 * Run resolved entries strictly in order.
 *
 * @param {Array<object>} entries From {@link resolvePlan}.
 * @param {object} options Options.
 * @param {string} options.jobDir The job directory.
 * @param {boolean} [options.dryRun] Print the commands; launch and write nothing.
 * @param {Function} [options.spawnEntry] Spawner seam (see {@link spawnWithBoundedCommand}).
 * @param {Function} [options.now] Clock seam (epoch ms).
 * @param {{write: Function}} [options.log] Progress sink.
 * @returns {Promise<{stopped: boolean, stoppedAt: string|null, rows: Array<object>, unexpectedExits: {count: number, entries: Array<object>}}>} `unexpectedExits` is empty for a dry run, which finishes no entry.
 */
export async function runJob(
  entries,
  {
    jobDir,
    dryRun = false,
    spawnEntry = spawnWithBoundedCommand,
    now = Date.now,
    log = process.stdout,
  },
) {
  const rows = [];
  if (dryRun) {
    for (const entry of entries) {
      log.write(`${formatCommand(entry)}\n`);
      if (entry.instrumentNote) {
        log.write(`  # ${entry.instrumentNote}\n`);
      }
      rows.push({ ...entry, outcome: ENTRY_OUTCOMES.DRY_RUN });
    }
    return {
      stopped: false,
      stoppedAt: null,
      rows,
      unexpectedExits: { count: 0, entries: [] },
    };
  }

  const resolvedJobDir = path.resolve(jobDir);
  fs.mkdirSync(resolvedJobDir, { recursive: true });
  const elapsed = {
    schema: 1,
    jobDir: resolvedJobDir,
    startedAt: new Date(now()).toISOString(),
    entries: [],
  };
  const writeElapsed = () => {
    elapsed.unexpectedExits = summarizeUnexpectedExits(rows);
    elapsed.measured = summarizeMeasured(rows);
    fs.writeFileSync(
      path.join(resolvedJobDir, "elapsed.json"),
      `${JSON.stringify(elapsed, null, 2)}\n`,
    );
  };
  const byFamily = new Map();
  let stoppedAt = null;

  for (const entry of entries) {
    fs.mkdirSync(entry.outputDirectory, { recursive: true });
    const runnerDir = path.join(resolvedJobDir, entry.family, "_runner");
    fs.mkdirSync(runnerDir, { recursive: true });
    log.write(
      `[edge-job] ${entry.family}/${entry.id}: ${formatCommand(entry)}\n`,
    );
    const started = now();
    let child;
    try {
      child = await spawnEntry({
        argv: entry.argv,
        cwd: REPOSITORY_ROOT,
        env: entry.env,
        timeoutMs: entry.timeoutMs,
        artifactPath: path.join(runnerDir, `${entry.id}.command.jsonl`),
      });
    } catch (error) {
      child = {
        exitCode: null,
        timedOut: false,
        spawnError: { message: String(error?.message ?? error) },
        stdout: "",
        stderr: "",
      };
    }
    const wallClockMs = Math.max(0, Math.round(now() - started));
    const receipts = readEntryReceipts(
      entry.outputDirectory,
      child.stderr ?? "",
    );
    const outcome = classifyEntry(child, receipts.refusalId);
    const row = {
      family: entry.family,
      id: entry.id,
      probe: entry.probe,
      exitCode: child.exitCode,
      expectedExit: entry.expectedExit,
      unexpectedExit: !entry.expectedExit.includes(child.exitCode),
      outcome,
      ...receipts,
      wallClockMs,
      instrumentNote: entry.instrumentNote,
    };
    rows.push(row);
    const familyRows = byFamily.get(entry.family) ?? [];
    familyRows.push(row);
    byFamily.set(entry.family, familyRows);
    fs.writeFileSync(
      path.join(resolvedJobDir, entry.family, "INDEX.md"),
      renderFamilyIndex(entry.family, familyRows),
    );
    elapsed.entries.push({
      family: entry.family,
      id: entry.id,
      probe: entry.probe,
      args: entry.args,
      runs: runsOf(entry.args),
      exitCode: child.exitCode,
      outcome,
      wallClockMs,
      receiptElapsedMs: receipts.receiptElapsedMs,
    });
    writeElapsed();
    log.write(
      `[edge-job] ${entry.family}/${entry.id}: exit ${child.exitCode} (${outcome})${receipts.refusalId ? ` refusal ${receipts.refusalId}` : ""} in ${wallClockMs} ms\n`,
    );
    if (STOPPING_OUTCOMES.has(outcome)) {
      stoppedAt = `${entry.family}/${entry.id}`;
      log.write(
        `[edge-job] STOPPED after ${stoppedAt}: ${outcome}${receipts.refusalId ? ` (${receipts.refusalId})` : ""}; no later entry was started and nothing is retried\n`,
      );
      break;
    }
  }
  elapsed.stoppedAt = stoppedAt;
  writeElapsed();
  const unexpectedExits = elapsed.unexpectedExits;
  log.write(unexpectedExitsLine(rows.length, unexpectedExits));
  log.write(measuredLine(rows.length, elapsed.measured));
  return { stopped: stoppedAt !== null, stoppedAt, rows, unexpectedExits };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv Arguments after the script name.
 * @returns {{plan: string, jobDir: string, families: string[]|null, dryRun: boolean}}
 */
export function parseRunnerArgs(argv) {
  const options = {
    plan: DEFAULT_PLAN_PATH,
    jobDir: null,
    families: null,
    dryRun: false,
  };
  const value = (index, flag) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new TypeError(`${flag} requires a value`);
    }
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--plan") {
      options.plan = path.resolve(value(index++, arg));
    } else if (arg === "--job-dir") {
      options.jobDir = path.resolve(value(index++, arg));
    } else if (arg === "--family") {
      options.families = value(index++, arg)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    } else {
      throw new TypeError(`unknown argument: ${arg}`);
    }
  }
  if (options.jobDir === null) {
    throw new TypeError("--job-dir <dir> is required");
  }
  return options;
}

/**
 * CLI entry.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {object} [seams] `spawnEntry`, `now`, `log`, `stderr` and `repositoryRoot` for specs.
 * @returns {Promise<number>} The exit code: 2 (usage, invalid plan, or a selection that resolves no entry), else 1 (the job stopped early), else 4 (a finished entry exited outside its `expectedExit`), else 0.
 */
export async function main(argv, seams = {}) {
  const log = seams.log ?? process.stdout;
  const stderr = seams.stderr ?? process.stderr;
  let options;
  let entries;
  try {
    options = parseRunnerArgs(argv);
    const plan = JSON.parse(fs.readFileSync(options.plan, "utf8"));
    entries = resolvePlan(plan, {
      jobDir: options.jobDir,
      families: options.families,
      ...(seams.repositoryRoot ? { repositoryRoot: seams.repositoryRoot } : {}),
    });
  } catch (error) {
    stderr.write(`edge-job-runner: ${error.message}\n`);
    return 2;
  }
  const result = await runJob(entries, {
    jobDir: options.jobDir,
    dryRun: options.dryRun,
    ...(seams.spawnEntry ? { spawnEntry: seams.spawnEntry } : {}),
    ...(seams.now ? { now: seams.now } : {}),
    log,
  });
  if (result.stopped) {
    return 1;
  }
  return result.unexpectedExits.count > 0 ? 4 : 0;
}

/**
 * Whether `argv1` (the script path node was given) names this module. Node
 * loads the main module from its real path, so a script path that runs
 * through a link (a junction or a symlink) differs from `import.meta.url` as
 * typed; both sides are compared as real paths, or such a run would skip
 * `main` and exit 0 having run nothing.
 *
 * @param {string|undefined} argv1 `process.argv[1]`.
 * @param {string} moduleUrl `import.meta.url`.
 * @returns {boolean} True when the module is the script node was asked to run.
 */
export function isInvokedAsScript(argv1, moduleUrl) {
  if (!argv1 || !moduleUrl.startsWith("file:")) {
    return false;
  }
  const real = (file) => {
    try {
      return fs.realpathSync.native(file);
    } catch {
      return path.resolve(file);
    }
  };
  return real(path.resolve(argv1)) === real(fileURLToPath(moduleUrl));
}

if (isInvokedAsScript(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
