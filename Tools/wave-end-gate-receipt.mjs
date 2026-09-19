// @purpose Normalizes wave-end child results and constructs durable receipts and summaries.
// @status ACTIVE

import {
  S5_FINAL_STATUSES,
  S5_STATUS_EXIT_CODES,
  exitCodeForS5Status,
} from "./visual-regression/lib/verdict-exit-gate.mjs";
import {
  CHILD_WATCHDOG_MS,
  DESCENDANT_QUIESCENCE_LIMITATION,
  ERROR_REASONS,
  REFUSAL_REASONS,
  ROOT_BINDING,
  STEP_RESULT_SCHEMA_VERSION,
  collectPreSpawnBlockers,
  isProblemContract,
  isRootBoundStep,
  makeError,
  makeRefusal,
} from "./wave-end-gate-binding.mjs";
import {
  RENDERER_IDS,
  SLOT_IDS,
  VERDICT_TOKENS,
} from "./visual-regression/lib/contact-sheet-page.mjs";
import { relativePosixPathViolation } from "./visual-regression/lib/relative-path.mjs";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

export function foldStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return "STRUCTURAL";
  }

  let folded = "PASS";
  for (const status of statuses) {
    if (!S5_FINAL_STATUSES.includes(status)) {
      return "ERROR";
    }
    if (exitCodeForS5Status(status) > exitCodeForS5Status(folded)) {
      folded = status;
    }
  }
  return folded;
}

export function buildReceipt({
  wave,
  startedAt,
  finishedAt,
  source,
  servedSubject,
  preflight,
  plan,
  steps,
  updateBaselines,
  reason,
  problem = null,
  verdict,
  contactSheets,
}) {
  return {
    schemaVersion: 1,
    wave,
    startedAt,
    finishedAt,
    source: Object.freeze({
      commit: source.commit,
      dirty: source.dirty,
      identity: source.identity,
    }),
    servedSubject: {
      base: servedSubject.base,
      sandcastleBase: servedSubject.sandcastleBase,
      artifacts: servedSubject.artifacts.map((artifact) => ({ ...artifact })),
    },
    preflight: preflight.map((record) => ({
      ...record,
      reasons: [...record.reasons],
    })),
    plan: plan.map((step) => ({
      name: step.name,
      file: step.file,
      args: [...step.args],
      env: { ...step.env },
      command: step.command,
      resultReportPath: step.resultReportPath,
      bindability: { ...step.bindability },
      binding: step.binding ?? null,
    })),
    steps: steps.map((step) => ({
      name: step.name,
      command: step.command,
      bindability: { ...step.bindability },
      binding: step.binding ?? null,
      raw: {
        ...step.raw,
        cleanup: { ...step.raw.cleanup },
        quiescence: { ...step.raw.quiescence },
      },
      normalized: {
        ...step.normalized,
        typedResult: step.normalized.typedResult ?? null,
      },
    })),
    baselineUpdate: {
      requested: Boolean(updateBaselines),
      reason: updateBaselines ? (reason ?? null) : null,
    },
    problem: problem
      ? {
          status: problem.status,
          reason: problem.name,
          message: problem.message,
        }
      : null,
    verdict,
    exitCode: exitCodeForS5Status(verdict),
    // Additive and last: a receipt built with no sheets must serialize
    // byte-identically to one from before this field existed, so an absent or
    // empty list omits the key entirely rather than writing `[]`.
    ...(Array.isArray(contactSheets) && contactSheets.length > 0
      ? { contactSheets: contactSheets.map(projectContactSheetEntry) }
      : {}),
  };
}

export function normalizedProblem(problem, typedResult = null) {
  return {
    status: problem.status,
    exitCode: problem.exitCode,
    reason: problem.name,
    message: problem.message,
    typedResult,
  };
}

export function classifyRawChildProblem(raw) {
  if (raw?.error) {
    return makeError(
      ERROR_REASONS.CHILD_SPAWN_ERROR,
      `Child process error: ${raw.error}`,
    );
  }
  if (raw?.timedOut) {
    return makeError(
      ERROR_REASONS.CHILD_TIMEOUT,
      `Child exceeded its ${raw.watchdogMs} ms watchdog.`,
    );
  }
  if (raw?.cleanup?.error || raw?.cleanup?.cleanupDeadlineExceeded) {
    return makeError(
      ERROR_REASONS.CHILD_CLEANUP_ERROR,
      `Child cleanup did not complete: ${raw.cleanup.error ?? "deadline exceeded"}.`,
    );
  }
  if (raw?.signal) {
    return makeError(
      ERROR_REASONS.CHILD_SIGNAL,
      `Child closed from signal ${raw.signal}.`,
    );
  }
  if (raw?.exitCode === null || raw?.exitCode === undefined) {
    return makeError(
      ERROR_REASONS.CHILD_NULL_EXIT,
      "Child closed without an exit code or signal.",
    );
  }
  if (
    !Number.isInteger(raw.exitCode) ||
    !Object.values(S5_STATUS_EXIT_CODES).includes(raw.exitCode)
  ) {
    return makeError(
      ERROR_REASONS.CHILD_UNKNOWN_EXIT,
      `Child returned unsupported raw exit code ${String(raw.exitCode)}.`,
    );
  }
  return null;
}

export function buildServedSubject(args, preflightRecords) {
  return {
    base: `http://localhost:${args.port}`,
    sandcastleBase: `http://localhost:${args.bucketPort}`,
    artifacts: preflightRecords.map((record) => ({
      path: record.path,
      origin: record.origin,
      byteLength: record.byteLength,
      md5: record.servedMd5,
    })),
  };
}

/**
 * Whether a resolved object is an ATTEMPTED wave-end typed step contract, as
 * opposed to a child's own fixed report. `stepName` is the discriminator: it is
 * unique to this gate's contract and appears in none of the canonical children's
 * reports. An attempted contract is validated strictly and fails closed; a plain
 * child report falls through to the root binding, which uses it as freshness
 * evidence rather than as a verdict.
 *
 * @param {unknown} value A resolved child result.
 * @returns {boolean} True when the value claims to be a typed step contract.
 */
export function isAttemptedChildStepContract(value) {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "stepName")
    );
  } catch {
    return false;
  }
}

function normalizeTypedStepResultUnsafe(
  result,
  { step, raw, source, servedSubject, rootBound = false },
) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
        `${step.name} produced no typed current-run result.`,
      ),
    );
  }

  if (
    result.schemaVersion !== STEP_RESULT_SCHEMA_VERSION ||
    result.stepName !== step.name ||
    !S5_FINAL_STATUSES.includes(result.status) ||
    result.exitCode !== exitCodeForS5Status(result.status) ||
    (result.status === "PASS"
      ? result.reason !== null && result.reason !== undefined
      : typeof result.reason !== "string" || result.reason.length === 0) ||
    (result.message !== null &&
      result.message !== undefined &&
      typeof result.message !== "string")
  ) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
        `${step.name} produced a malformed typed result contract.`,
      ),
      result,
    );
  }

  const resultStartedMs = Date.parse(result.startedAt);
  const resultFinishedMs = Date.parse(result.finishedAt);
  if (
    result.runId !== raw.runId ||
    !Number.isFinite(resultStartedMs) ||
    !Number.isFinite(resultFinishedMs) ||
    resultStartedMs < raw.startedEpochMs ||
    resultFinishedMs < resultStartedMs ||
    resultFinishedMs > raw.finishedEpochMs
  ) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_RECEIPT_STALE,
        `${step.name} result is not bound to this child run and time window.`,
      ),
      result,
    );
  }

  if (JSON.stringify(result.source) !== JSON.stringify(source)) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.PROVENANCE_MISMATCH,
        `${step.name} result is not bound to the root-supplied source tuple.`,
      ),
      result,
    );
  }

  if (JSON.stringify(result.servedSubject) !== JSON.stringify(servedSubject)) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.SERVED_SUBJECT_MISMATCH,
        `${step.name} result is not bound to the preflighted served subject.`,
      ),
      result,
    );
  }

  // Quiescence is a ROOT observation, not a child claim. The root cannot verify
  // a child's assertion that its descendant process tree went quiet, so the
  // claim alone certifies nothing; what the root can insist on is that it saw
  // the direct child close, and that whatever was not proven is NAMED. A run
  // that neither proves quiescence nor records the limitation is refused — the
  // downgrade must never be silent.
  const quiescence = result.quiescence;
  const namesLimitation =
    typeof quiescence?.limitation === "string" &&
    quiescence.limitation.length > 0;
  if (
    quiescence === null ||
    typeof quiescence !== "object" ||
    Array.isArray(quiescence) ||
    raw.quiescence?.directChildCloseObserved !== true ||
    (quiescence.descendantProcessTreeProven !== true && !namesLimitation)
  ) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.DESCENDANT_QUIESCENCE_UNPROVEN,
        `${step.name} neither proved descendant process-tree quiescence nor named the limitation, or the root never observed the direct child close.`,
      ),
      result,
    );
  }

  // A child-emitted verdict must match the exit code the root actually saw. A
  // ROOT-BOUND result is the translation itself — the step's declared map turns
  // raw exit 2 into STRUCTURAL (exit 3) on purpose — so the equality is asserted
  // only for results the child offered. `rootBound` comes from the call site,
  // never off the result, so a child cannot set a field to skip this check.
  if (!rootBound && raw.exitCode !== result.exitCode) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
        `${step.name} typed exit does not match the observed raw exit.`,
      ),
      result,
    );
  }

  return {
    status: result.status,
    exitCode: result.exitCode,
    reason: result.reason ?? null,
    message:
      result.message ??
      (result.status === "PASS"
        ? null
        : `${step.name} reported ${result.status} [${result.reason}].`),
    typedResult: result,
  };
}

/**
 * The canonical typed result the ROOT derives for a step whose child emits
 * none. Every field names its source: the run id and time window are the root's
 * own, the source tuple was handed to the root on the command line, the served
 * subject was proven by the root's preflight, the freshness evidence is the
 * root's own before/after snapshot of the child's fixed report, and the status
 * comes from the step's DECLARED exit-code map rather than from a raw exit read
 * as though it were a verdict. An exit code the map does not declare is refused.
 *
 * @param {object} step The planned step, carrying its `binding` declaration.
 * @param {object} context Root observations for this run.
 * @returns {{typedResult?: object, problem?: object}} The derived result.
 */
export function deriveRootBoundTypedResult(
  step,
  { raw, source, servedSubject, reportSnapshot = null },
) {
  const binding = step?.binding;
  if (!isRootBoundStep(step)) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
        `${step?.name} declares no root binding and produced no typed current-run result.`,
      ),
    };
  }

  // A step that DECLARES a fixed report must be bound to a current-run digest of
  // it. Without one the verdict would rest on the exit code alone, which is the
  // very thing the declared map is meant to be an improvement over.
  if (step.resultReportPath && typeof reportSnapshot?.sha256 !== "string") {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
        `${step.name} declares ${step.resultReportPath} but the root holds no current-run digest of it.`,
      ),
    };
  }

  const status = binding.exitCodeStatus?.[String(raw.exitCode)];
  if (!S5_FINAL_STATUSES.includes(status)) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.EXIT_CODE_UNDECLARED,
        `${step.name} exited ${String(raw.exitCode)}, which its declared exit-code map does not cover.`,
      ),
    };
  }

  const meaning =
    binding.exitCodeMeaning?.[String(raw.exitCode)] ?? "undeclared meaning";
  return {
    typedResult: {
      schemaVersion: STEP_RESULT_SCHEMA_VERSION,
      stepName: step.name,
      runId: raw.runId,
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt,
      source,
      servedSubject,
      status,
      exitCode: exitCodeForS5Status(status),
      reason: status === "PASS" ? null : `ROOT_BOUND_EXIT_${raw.exitCode}`,
      message: `${step.name} exited ${raw.exitCode}: ${meaning}. Bound by ${ROOT_BINDING}.`,
      boundBy: ROOT_BINDING,
      binding: {
        ...binding.fields,
        declaredExitCodeStatus: { ...binding.exitCodeStatus },
        observedExitCode: raw.exitCode,
      },
      evidence: {
        resultReportPath: step.resultReportPath,
        resultReportSha256: reportSnapshot?.sha256 ?? null,
        resultReportMtimeMs: reportSnapshot?.mtimeMs ?? null,
      },
      quiescence: { ...raw.quiescence },
      limitations: [...(binding.limitations ?? [])],
    },
  };
}

export function normalizeTypedStepResult(result, context) {
  try {
    return normalizeTypedStepResultUnsafe(result, context);
  } catch (error) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
        `The typed result contract is unreadable: ${error.message ?? error}`,
      ),
    );
  }
}

export async function readResultReportSnapshot(
  step,
  projectRoot,
  {
    readFile = (absolutePath) => fs.readFile(absolutePath),
    statPath = (absolutePath) => fs.stat(absolutePath),
  } = {},
) {
  if (!step.resultReportPath) {
    return { exists: false, bytes: null, mtimeMs: null, sha256: null };
  }

  const absolutePath = path.resolve(projectRoot, step.resultReportPath);
  try {
    const [bytes, stat] = await Promise.all([
      readFile(absolutePath),
      statPath(absolutePath),
    ]);
    return {
      exists: true,
      bytes,
      mtimeMs: stat.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { exists: false, bytes: null, mtimeMs: null, sha256: null };
    }
    return {
      exists: false,
      bytes: null,
      mtimeMs: null,
      sha256: null,
      problem: makeError(
        ERROR_REASONS.CHILD_RESULT_READ_FAILED,
        `Could not read ${step.resultReportPath}: ${error.message ?? error}`,
      ),
    };
  }
}

export async function resolveCurrentStepResult(
  { step, raw, projectRoot, priorSnapshot },
  snapshotDependencies = {},
) {
  if (!step.resultReportPath) {
    // A root-bound step with no fixed report has nothing to read: its freshness
    // evidence is the root's own direct-child close, so the resolver yields no
    // result and the caller derives one. A step that is NOT root-bound still
    // owes a typed receipt and is refused for its absence.
    if (isRootBoundStep(step)) {
      return { result: null, snapshot: priorSnapshot };
    }
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
        step.bindability.reason,
      ),
      snapshot: priorSnapshot,
    };
  }

  const snapshot = await readResultReportSnapshot(
    step,
    projectRoot,
    snapshotDependencies,
  );
  if (snapshot.problem) {
    return { problem: snapshot.problem, snapshot };
  }
  if (!snapshot.exists) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
        `${step.name} did not produce ${step.resultReportPath}.`,
      ),
      snapshot,
    };
  }

  if (
    !Number.isFinite(snapshot.mtimeMs) ||
    snapshot.mtimeMs < raw.startedEpochMs ||
    snapshot.mtimeMs > raw.finishedEpochMs ||
    (priorSnapshot?.exists && priorSnapshot.sha256 === snapshot.sha256)
  ) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_RECEIPT_STALE,
        `${step.resultReportPath} is not fresh for ${raw.runId}.`,
      ),
      snapshot,
    };
  }

  try {
    return {
      result: JSON.parse(Buffer.from(snapshot.bytes).toString("utf8")),
      snapshot,
    };
  } catch (error) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
        `${step.resultReportPath} is not valid JSON: ${error.message}`,
      ),
      snapshot,
    };
  }
}

export function sourceFromArgs(args) {
  return Object.freeze({
    commit: args.sourceCommit,
    dirty:
      args.sourceDirty === "true"
        ? true
        : args.sourceDirty === "false"
          ? false
          : null,
    identity: args.sourceIdentity,
  });
}

function nonExecutionStepReceipt(step, problem) {
  return {
    name: step.name,
    command: step.command,
    bindability: { ...step.bindability },
    binding: step.binding ?? null,
    raw: {
      runId: null,
      spawned: false,
      startedAt: null,
      finishedAt: null,
      startedEpochMs: null,
      finishedEpochMs: null,
      wallMs: 0,
      exitCode: null,
      signal: null,
      error: null,
      timedOut: false,
      watchdogMs: CHILD_WATCHDOG_MS,
      cleanup: {
        terminateAttempted: false,
        terminateAccepted: null,
        hardKillAttempted: false,
        hardKillAccepted: null,
        directChildCloseObserved: false,
        cleanupDeadlineExceeded: false,
        error: null,
      },
      quiescence: {
        directChildCloseObserved: false,
        descendantProcessTreeProven: false,
        limitation: DESCENDANT_QUIESCENCE_LIMITATION,
      },
    },
    normalized: normalizedProblem(problem),
  };
}

export function nonExecutionPlanResult(plan, problem) {
  return {
    steps: plan.map((step) => nonExecutionStepReceipt(step, problem)),
    problem,
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

const CONTACT_SHEET_MD5_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The kebab-case grammar every rig id in `lib/rig-registry.mjs`'s registry
 * satisfies today (39 of 39 — pinned by a spec case that loads the real
 * registry via `loadRigs()` and asserts every id matches; a future rig id
 * that diverged would turn that case red). `rig-registry.mjs`'s own
 * `validateRig` requires only a non-empty string for `rig.id` — there is no
 * grammar there to import, and `rig-registry.mjs` is a landed file outside
 * this lane's ownership, so the grammar is declared here rather than added
 * there. It follows the same path-safe identifier discipline
 * `contact-sheet-page.mjs`'s (unexported) `SHEET_ID_PATTERN` uses:
 * lowercase-only so it collates and slugifies identically on every OS, and
 * hyphen-only separation so a rig id can never itself read as prose. Contrast
 * `sheetId`, which carries no grammar here and is instead covered by
 * `scanEntryForVerdicts` below.
 */
export const RIG_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The complete field list of a `sheet-index.json` entry (`DX-105`'s
 * `sheetIndexEntry`), in the order the receipt records them.
 *
 * WHY THE LIST EXISTS RATHER THAN A SPREAD. A banked entry is a file on disk
 * that anyone can edit, and `{...entry}` carries whatever it finds into the
 * wave-end receipt — including a `verdict: "PASS"` or a `gate` object, which
 * is the exact vocabulary this row exists to keep out of the artefact, and
 * including keys that would change the receipt's own top-level shape. The
 * entry is therefore PROJECTED onto these fields and unknown keys are a
 * validation violation, not silent freight.
 */
export const CONTACT_SHEET_ENTRY_FIELDS = Object.freeze([
  "schemaVersion",
  "kind",
  "sheetId",
  "date",
  "path",
  "md5",
  "byteLength",
  "rigIds",
  "renderers",
  "slots",
  "cells",
  "manifest",
  "generatedAt",
]);

/**
 * Copy exactly {@link CONTACT_SHEET_ENTRY_FIELDS} out of `entry`, in that
 * order, deep-copying the two arrays and the cell counts so a later mutation
 * of the source cannot reach the banked receipt.
 *
 * @param {object} entry A validated entry.
 * @returns {object} The projection.
 */
export function projectContactSheetEntry(entry) {
  const projected = {};
  for (const field of CONTACT_SHEET_ENTRY_FIELDS) {
    if (!Object.hasOwn(entry, field)) {
      continue;
    }
    const value = entry[field];
    if (Array.isArray(value)) {
      projected[field] = [...value];
    } else if (
      field === "cells" &&
      value !== null &&
      typeof value === "object"
    ) {
      projected[field] = {
        measured: value.measured,
        unmeasured: value.unmeasured,
      };
    } else {
      projected[field] = value;
    }
  }
  return projected;
}

/**
 * Fail-closed shape check for one banked `sheet-index.json` entry (DX-105's
 * output, DX-106's input). An unrecognised shape is a violation, never a
 * silent pass — the same discipline `validateManifest`/`validateRig` use
 * elsewhere in this lane. `path` is asserted repo-relative and POSIX because
 * it is the one field in the entry that is repo-relative rather than
 * sheet-relative: a Windows backslash there would silently fail to resolve on
 * a POSIX CI runner, and an absolute or `..`-traversing path would send
 * `collectContactSheets`, which reads it verbatim, at a file outside the wave
 * directory entirely.
 *
 * @param {unknown} entry A parsed `sheet-index.json` document.
 * @returns {string[]} Violations; empty when the shape is valid.
 */
export function validateContactSheetEntry(entry) {
  const failures = [];
  const id =
    entry && typeof entry === "object" && typeof entry.sheetId === "string"
      ? entry.sheetId
      : "(unnamed sheet)";
  const need = (condition, message) => {
    if (!condition) {
      failures.push(`${id}: ${message}`);
    }
  };

  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    failures.push(`${id}: entry must be an object`);
    return failures;
  }

  need(
    entry.schemaVersion === 1,
    `schemaVersion must be 1, got ${String(entry.schemaVersion)}`,
  );
  need(
    entry.kind === "contact-sheet-index-entry",
    `kind must be "contact-sheet-index-entry", got ${String(entry.kind)}`,
  );
  need(
    typeof entry.sheetId === "string" && entry.sheetId.length > 0,
    "missing sheetId",
  );
  need(
    typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date),
    "date must be YYYY-MM-DD",
  );
  const pathViolation = relativePosixPathViolation(entry.path);
  need(
    pathViolation === null,
    `path must be a relative POSIX path — collectContactSheets reads it verbatim (${pathViolation})`,
  );
  need(
    typeof entry.md5 === "string" && CONTACT_SHEET_MD5_PATTERN.test(entry.md5),
    "md5 must be 32 lowercase hex characters",
  );
  need(
    Number.isInteger(entry.byteLength) && entry.byteLength >= 0,
    "byteLength must be a non-negative integer",
  );
  need(
    Array.isArray(entry.rigIds) &&
      entry.rigIds.every(
        (rigId) => typeof rigId === "string" && RIG_ID_PATTERN.test(rigId),
      ),
    `rigIds must be an array of ids matching ${RIG_ID_PATTERN}`,
  );
  need(
    Array.isArray(entry.renderers) &&
      entry.renderers.length > 0 &&
      entry.renderers.every((renderer) => RENDERER_IDS.includes(renderer)) &&
      new Set(entry.renderers).size === entry.renderers.length,
    `renderers must be a duplicate-free non-empty subset of ${RENDERER_IDS.join(", ")}`,
  );
  need(
    Array.isArray(entry.slots) &&
      entry.slots.length > 0 &&
      entry.slots.every((slot) => SLOT_IDS.includes(slot)) &&
      new Set(entry.slots).size === entry.slots.length,
    `slots must be a duplicate-free non-empty subset of ${SLOT_IDS.join(", ")}`,
  );
  need(
    entry.cells !== null &&
      typeof entry.cells === "object" &&
      Number.isInteger(entry.cells?.measured) &&
      entry.cells.measured >= 0 &&
      Number.isInteger(entry.cells?.unmeasured) &&
      entry.cells.unmeasured >= 0,
    "cells must be { measured, unmeasured } non-negative integers",
  );
  const manifestViolation = relativePosixPathViolation(entry.manifest);
  need(
    manifestViolation === null,
    `manifest must be a relative POSIX path (${manifestViolation})`,
  );
  need(
    typeof entry.generatedAt === "string" &&
      Number.isFinite(Date.parse(entry.generatedAt)),
    "generatedAt must be a parseable ISO timestamp",
  );
  const unknown = Object.keys(entry).filter(
    (key) => !CONTACT_SHEET_ENTRY_FIELDS.includes(key),
  );
  need(
    unknown.length === 0,
    `unknown key(s) ${unknown.join(", ")} — a banked entry carries exactly ${CONTACT_SHEET_ENTRY_FIELDS.length} fields, so nothing rides into the receipt uninspected`,
  );

  // REFUSING UNKNOWN KEYS IS NOT THE SAME AS REFUSING THE VOCABULARY. Every
  // field above is checked for SHAPE, and a few of them are still open
  // strings (`sheetId`) or grammar-constrained but content-agnostic
  // (`rigIds`) — so `sheetId: "FAILED-globe-default"` validates clean on
  // shape alone, is projected verbatim by `projectContactSheetEntry`, and
  // would reach both `receipt.json` and the markdown summary's sheet row.
  // The whole point of DX-105/DX-106 is that the artefact does not rule, so
  // the CONTENT is scanned the way `lib/capture.mjs`'s `scanForVerdicts`
  // already scans a capture manifest. This is a BACKSTOP, not the primary
  // guard: `renderers`/`slots` are closed vocabularies and `rigIds` is
  // grammar-constrained above, so this scan is what still catches the
  // vocabulary when it arrives through the fields nothing else types
  // (`sheetId`), or nested inside an otherwise-shaped value.
  // `path` and `manifest` are filesystem locations, not prose, and are
  // already pinned by `relativePosixPathViolation` above; excluding them
  // also avoids a false positive from the repo's own
  // `Tools/visual-regression/…` root, which contains "regression" at a word
  // boundary.
  const { path: _p, manifest: _m, ...prose } = entry;
  scanEntryForVerdicts(prose, id, failures);

  return failures;
}

/**
 * Words a banked entry may never spell — the artefact does not rule. Sourced
 * from `contact-sheet-page.mjs`'s `VERDICT_TOKENS` list rather than a second,
 * independently-maintained copy, so the two vocabularies cannot drift the way
 * the fleet's path predicates once did (see `relative-path.mjs`'s module
 * doc).
 */
const FORBIDDEN_ENTRY_TOKENS = VERDICT_TOKENS;

/**
 * Recursively scan `value` (an entry, or a sub-value of one) for
 * {@link FORBIDDEN_ENTRY_TOKENS}, pushing a violation per hit that names the
 * exact path (`trail`) and the token found. A glyph token (no alphabetic
 * characters) matches as a plain substring; a word token matches only at a
 * word boundary, case-insensitively, so an organic word such as "bypass"
 * does not false-positive against "PASS" — the same rule
 * `findVerdictTokens` uses for rendered HTML.
 *
 * @param {unknown} value
 * @param {string} trail Human-readable path to `value`, extended per
 *   recursion step.
 * @param {string[]} failures Violations are pushed here.
 */
function scanEntryForVerdicts(value, trail, failures) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanEntryForVerdicts(item, `${trail}[${index}]`, failures),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      scanEntryForVerdicts(item, `${trail}.${key}`, failures);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  for (const token of FORBIDDEN_ENTRY_TOKENS) {
    const hit = /[A-Za-z]/.test(token)
      ? new RegExp(`\\b${token}\\b`, "i").test(value)
      : value.includes(token);
    if (hit) {
      failures.push(
        `${trail}: "${token}" is verdict vocabulary and may not enter a banked contact-sheet entry`,
      );
    }
  }
}

/**
 * Markdown lines for the `## Contact sheets` section, or `[]` for an empty or
 * absent list — the empty case is what lets `buildMarkdownSummary` skip the
 * section entirely rather than print a headerless table.
 *
 * @param {object[] | undefined} entries Validated, md5-confirmed entries.
 * @returns {string[]} Markdown lines, header row included; `[]` when empty.
 */
export function buildContactSheetTable(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const lines = [
    "| Sheet | Date | Rigs | Cells | MD5 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    const cells = `${entry.cells?.measured ?? 0} measured, ${entry.cells?.unmeasured ?? 0} unmeasured`;
    lines.push(
      `| ${markdownCell(entry.sheetId)} | ${markdownCell(entry.date)} | ${markdownCell((entry.rigIds ?? []).join(", "))} | ${markdownCell(cells)} | ${markdownCell(entry.md5)} |`,
    );
  }
  return lines;
}

/**
 * Reads every `<waveDirectory>/contact-sheets/*\/sheet-index.json`, validates
 * its shape, and RECOMPUTES its md5 from the page file at the entry's own
 * `path` rather than trusting the value the entry carries — a banked md5
 * nobody recomputed is a claim, not a check. A mismatch is a violation naming
 * both values, and that entry is dropped rather than banked. All I/O is
 * injected so this runs on in-memory or fixture-backed doubles with no real
 * filesystem access required.
 *
 * @param {object} options
 * @param {string} options.waveDirectory The wave's own output directory
 *   (`<toolsDir>/visual-regression/output/wave-end/<wave>`), absolute or
 *   however the caller's `readDir`/`readFile` expect it.
 * @param {(dir: string) => Promise<string[]>} options.readDir Lists a
 *   directory's entries; rejects with `ENOENT`/`ENOTDIR` when the directory
 *   does not exist.
 * @param {string} [options.repositoryRoot] Root that an entry's repo-relative
 *   `path` resolves against. Supply it and the collector no longer depends on
 *   the caller's working directory; omit it and the path is read as given,
 *   which is what the pre-`repositoryRoot` callers did.
 * @param {(path: string) => Promise<Uint8Array | Buffer>} options.readFile
 *   Reads a file's bytes given either the constructed sheet-index.json path
 *   or an entry's own `path` field, resolved as described above.
 * @param {(bytes: Buffer) => string} [options.md5] The hash function; the
 *   real one by default. Injectable so a spec can prove the recomputation
 *   actually happened rather than reading `entry.md5` back at it.
 * @returns {Promise<{entries: object[], violations: string[]}>}
 */
export async function collectContactSheets({
  waveDirectory,
  repositoryRoot,
  readDir,
  readFile,
  md5 = (bytes) => createHash("md5").update(bytes).digest("hex"),
}) {
  const violations = [];
  const entries = [];
  const sheetsDirectory = path.join(waveDirectory, "contact-sheets");

  let dirNames;
  try {
    dirNames = await readDir(sheetsDirectory);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { entries: [], violations: [] };
    }
    throw error;
  }

  for (const dirName of [...dirNames].sort()) {
    const indexPath = path.join(sheetsDirectory, dirName, "sheet-index.json");
    let raw;
    try {
      raw = await readFile(indexPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        continue;
      }
      throw error;
    }

    let entry;
    try {
      entry = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch (error) {
      violations.push(
        `${dirName}: sheet-index.json is not valid JSON: ${error.message ?? error}`,
      );
      continue;
    }

    const shapeViolations = validateContactSheetEntry(entry);
    if (shapeViolations.length > 0) {
      violations.push(...shapeViolations);
      continue;
    }

    const pagePath =
      typeof repositoryRoot === "string" && repositoryRoot.length > 0
        ? path.join(repositoryRoot, entry.path)
        : entry.path;
    let pageBytes;
    try {
      pageBytes = await readFile(pagePath);
    } catch (error) {
      violations.push(
        `${entry.sheetId}: could not read ${pagePath} to recompute its md5: ${error.message ?? error}`,
      );
      continue;
    }

    const recomputedMd5 = md5(Buffer.from(pageBytes));
    if (recomputedMd5 !== entry.md5) {
      violations.push(
        `${entry.sheetId}: recomputed md5 ${recomputedMd5} for ${pagePath} does not match the banked entry's md5 ${entry.md5}`,
      );
      continue;
    }

    entries.push(projectContactSheetEntry({ ...entry, md5: recomputedMd5 }));
  }

  return { entries, violations };
}

export function buildMarkdownSummary(receipt, { dryRun = false } = {}) {
  const lines = [
    `# Wave-end gate: ${receipt.wave}`,
    "",
    `- Verdict: **${receipt.verdict}**`,
    `- Started: ${receipt.startedAt}`,
    `- Finished: ${receipt.finishedAt}`,
    `- Source commit: \`${receipt.source.commit ?? "missing"}\``,
    `- Source dirty: ${receipt.source.dirty ?? "missing"}`,
    `- Source identity: \`${receipt.source.identity ?? "missing"}\``,
    `- Baseline update requested: ${receipt.baselineUpdate.requested ? "yes" : "no"}`,
    `- Baseline reason: ${receipt.baselineUpdate.reason ?? "n/a"}`,
  ];

  if (receipt.problem) {
    lines.push(
      `- Problem: **${receipt.problem.reason}** — ${markdownCell(receipt.problem.message)}`,
    );
  }

  if (dryRun) {
    lines.push("- Dry run: **STRUCTURAL**. Child processes were not executed.");
  }

  lines.push("", "## Served subject", "");
  lines.push(
    `- Base: \`${receipt.servedSubject.base}\``,
    `- Sandcastle base: \`${receipt.servedSubject.sandcastleBase}\``,
    "",
    "| Artifact | Origin | Bytes | MD5 |",
    "| --- | --- | ---: | --- |",
  );
  for (const artifact of receipt.servedSubject.artifacts) {
    lines.push(
      `| ${markdownCell(artifact.path)} | ${markdownCell(artifact.origin)} | ${markdownCell(artifact.byteLength)} | ${markdownCell(artifact.md5)} |`,
    );
  }

  lines.push(
    "",
    "## Plan",
    "",
    "| Step | Command | Bindable now | Phase | Bound by | Declared exit map | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const step of receipt.plan) {
    const exitMap = step.binding?.exitCodeStatus
      ? Object.entries(step.binding.exitCodeStatus)
          .map(([code, status]) => `${code}=${status}`)
          .join(", ")
      : "none";
    lines.push(
      `| ${markdownCell(step.name)} | \`${markdownCell(step.command)}\` | ${step.bindability.bindable ? "yes" : "no"} | ${markdownCell(step.bindability.phase)} | ${markdownCell(step.bindability.boundBy ?? "nothing")} | ${markdownCell(exitMap)} | ${markdownCell(step.bindability.reason)} |`,
    );
  }

  const blockers = collectPreSpawnBlockers(receipt.plan);
  if (blockers.length > 0) {
    lines.push(
      "",
      "## Pre-spawn blockers",
      "",
      "| Step | Code | Reason | Remediation |",
      "| --- | --- | --- | --- |",
    );
    for (const blocker of blockers) {
      lines.push(
        `| ${markdownCell(blocker.step)} | ${markdownCell(blocker.code)} | ${markdownCell(blocker.reason)} | ${markdownCell(blocker.remediation)} |`,
      );
    }
  }

  const limitations = [
    ...new Set(
      receipt.plan.flatMap((step) => step.bindability.limitations ?? []),
    ),
  ];
  if (limitations.length > 0) {
    lines.push("", "## Limitations this receipt does NOT prove", "");
    for (const limitation of limitations) {
      lines.push(`- ${limitation}`);
    }
  }

  lines.push("", "## Steps", "");
  if (receipt.steps.length === 0) {
    lines.push("No child steps were executed.");
  } else {
    lines.push(
      "| Step | Spawned | Raw exit | Signal | Error | Timeout | Cleanup closed | Descendant quiescence | Verdict bound by | Normalized |",
      "| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const step of receipt.steps) {
      lines.push(
        `| ${markdownCell(step.name)} | ${step.raw.spawned ? "yes" : "no"} | ${markdownCell(step.raw.exitCode)} | ${markdownCell(step.raw.signal)} | ${markdownCell(step.raw.error)} | ${step.raw.timedOut ? "yes" : "no"} | ${step.raw.cleanup.directChildCloseObserved ? "yes" : "no"} | ${step.raw.quiescence.descendantProcessTreeProven ? "proven" : `unproven (${step.raw.quiescence.limitation})`} | ${markdownCell(step.normalized.typedResult?.boundBy ?? "child")} | ${markdownCell(step.normalized.status)} (${markdownCell(step.normalized.reason ?? "typed")}) |`,
      );
    }
  }

  // Additive and last: appended after every existing section so a receipt
  // with no sheets produces byte-identical output to before this section
  // existed (see the golden comparison in
  // Tools/wave-end-contact-sheet-index.spec.mjs).
  const contactSheetTable = buildContactSheetTable(receipt.contactSheets);
  if (contactSheetTable.length > 0) {
    lines.push("", "## Contact sheets", "", ...contactSheetTable);
  }

  return `${lines.join("\n")}\n`;
}

export async function writeReceiptFiles(
  toolsDir,
  receipt,
  summaryOptions = {},
) {
  const outputDirectory = path.join(
    toolsDir,
    "visual-regression",
    "output",
    "wave-end",
    receipt.wave,
  );

  await fs.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(outputDirectory, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(outputDirectory, "summary.md"),
      buildMarkdownSummary(receipt, summaryOptions),
      "utf8",
    ),
  ]);
}

export async function finishProblem({
  args,
  problem,
  startedAt,
  toolsDir,
  source,
  servedSubject,
  preflight = [],
  plan = [],
  steps = [],
  dryRun = false,
  writeReceipt = writeReceiptFiles,
  logError = (message) => console.error(message),
}) {
  const verdict = foldStatuses([
    ...steps.map((step) => step.normalized.status),
    problem.status,
  ]);
  const receipt = buildReceipt({
    wave: args.wave,
    startedAt,
    finishedAt: new Date().toISOString(),
    source,
    servedSubject,
    preflight,
    plan,
    steps,
    updateBaselines: args.updateBaselines,
    reason: args.reason,
    problem,
    verdict,
  });

  await writeReceipt(toolsDir, receipt, { dryRun });
  logError(`${verdict} [${problem.name}]: ${problem.message}`);
  return receipt.exitCode;
}

function hasOwnFields(record, fields) {
  return fields.every((field) => Object.hasOwn(record, field));
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isRawStepReceiptContract(raw) {
  const topLevelFields = [
    "runId",
    "spawned",
    "startedAt",
    "finishedAt",
    "startedEpochMs",
    "finishedEpochMs",
    "wallMs",
    "exitCode",
    "signal",
    "error",
    "timedOut",
    "watchdogMs",
    "cleanup",
    "quiescence",
  ];
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !hasOwnFields(raw, topLevelFields)
  ) {
    return false;
  }

  const isNonExecutionIdentity =
    raw.runId === null &&
    raw.startedAt === null &&
    raw.finishedAt === null &&
    raw.startedEpochMs === null &&
    raw.finishedEpochMs === null;
  const isCurrentRunIdentity =
    typeof raw.runId === "string" &&
    raw.runId.length > 0 &&
    typeof raw.startedAt === "string" &&
    Number.isFinite(Date.parse(raw.startedAt)) &&
    typeof raw.finishedAt === "string" &&
    Number.isFinite(Date.parse(raw.finishedAt)) &&
    Number.isFinite(raw.startedEpochMs) &&
    Number.isFinite(raw.finishedEpochMs);
  if (!isNonExecutionIdentity && !isCurrentRunIdentity) {
    return false;
  }

  const cleanupFields = [
    "terminateAttempted",
    "terminateAccepted",
    "hardKillAttempted",
    "hardKillAccepted",
    "directChildCloseObserved",
    "cleanupDeadlineExceeded",
    "error",
  ];
  const quiescenceFields = [
    "directChildCloseObserved",
    "descendantProcessTreeProven",
    "limitation",
  ];
  return (
    typeof raw.spawned === "boolean" &&
    Number.isFinite(raw.wallMs) &&
    raw.wallMs >= 0 &&
    (raw.exitCode === null || Number.isInteger(raw.exitCode)) &&
    isNullableString(raw.signal) &&
    isNullableString(raw.error) &&
    typeof raw.timedOut === "boolean" &&
    Number.isInteger(raw.watchdogMs) &&
    raw.watchdogMs > 0 &&
    raw.cleanup &&
    typeof raw.cleanup === "object" &&
    !Array.isArray(raw.cleanup) &&
    hasOwnFields(raw.cleanup, cleanupFields) &&
    typeof raw.cleanup.terminateAttempted === "boolean" &&
    (raw.cleanup.terminateAccepted === null ||
      typeof raw.cleanup.terminateAccepted === "boolean") &&
    typeof raw.cleanup.hardKillAttempted === "boolean" &&
    (raw.cleanup.hardKillAccepted === null ||
      typeof raw.cleanup.hardKillAccepted === "boolean") &&
    typeof raw.cleanup.directChildCloseObserved === "boolean" &&
    typeof raw.cleanup.cleanupDeadlineExceeded === "boolean" &&
    isNullableString(raw.cleanup.error) &&
    raw.quiescence &&
    typeof raw.quiescence === "object" &&
    !Array.isArray(raw.quiescence) &&
    hasOwnFields(raw.quiescence, quiescenceFields) &&
    typeof raw.quiescence.directChildCloseObserved === "boolean" &&
    typeof raw.quiescence.descendantProcessTreeProven === "boolean" &&
    typeof raw.quiescence.limitation === "string" &&
    raw.quiescence.limitation.length > 0
  );
}

function isNormalizedStepReceiptContract(normalized) {
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized) ||
    !hasOwnFields(normalized, [
      "status",
      "exitCode",
      "reason",
      "message",
      "typedResult",
    ]) ||
    !S5_FINAL_STATUSES.includes(normalized.status) ||
    normalized.exitCode !== exitCodeForS5Status(normalized.status) ||
    (normalized.status === "PASS"
      ? normalized.reason !== null
      : typeof normalized.reason !== "string" ||
        normalized.reason.length === 0) ||
    (normalized.status === "PASS"
      ? !isNullableString(normalized.message)
      : typeof normalized.message !== "string" ||
        normalized.message.length === 0) ||
    (normalized.typedResult !== null &&
      (typeof normalized.typedResult !== "object" ||
        Array.isArray(normalized.typedResult))) ||
    ((normalized.status === "PASS" || normalized.status === "FAIL") &&
      normalized.typedResult === null)
  ) {
    return false;
  }
  return true;
}

export function isExecutionResultContract(execution, plan) {
  try {
    if (
      !execution ||
      typeof execution !== "object" ||
      !Array.isArray(execution.steps) ||
      (execution.problem !== null && !isProblemContract(execution.problem))
    ) {
      return false;
    }

    if (
      execution.steps.length > plan.length ||
      execution.steps.some((step, index) => step?.name !== plan[index]?.name) ||
      (execution.problem === null && execution.steps.length !== plan.length)
    ) {
      return false;
    }

    for (let index = 0; index < execution.steps.length; index += 1) {
      const step = execution.steps[index];
      const planned = plan[index];
      if (
        step.command !== planned.command ||
        JSON.stringify(step.bindability) !==
          JSON.stringify(planned.bindability) ||
        JSON.stringify(step.binding ?? null) !==
          JSON.stringify(planned.binding ?? null) ||
        !isRawStepReceiptContract(step.raw) ||
        !isNormalizedStepReceiptContract(step.normalized)
      ) {
        return false;
      }
    }

    if (execution.problem === null) {
      return true;
    }
    if (execution.steps.length === 0) {
      return true;
    }
    const terminal = execution.steps.at(-1).normalized;
    return (
      terminal.status === execution.problem.status &&
      terminal.exitCode === execution.problem.exitCode &&
      terminal.reason === execution.problem.name &&
      terminal.message === execution.problem.message
    );
  } catch {
    return false;
  }
}
