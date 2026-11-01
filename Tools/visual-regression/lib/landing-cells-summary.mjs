/**
 * The landing-cells probe's Markdown summary.
 * @purpose The landing-cells Markdown summary hook: the default id-and-result table plus the marks a reader needs where they look (a PASS decided by a provisional floor reads PASS* with the flag and figures footnoted, a floor that did not decide, the reason a contended or not-run verdict was not read, the CPU warm-up note, a base frame found beside the report), and nothing else changed.
 * @status ACTIVE
 *
 * The table is `buildMarkdownSummary`'s own: this module post-edits its lines
 * (one table row per verdict, in verdict order) rather than copying it, so a
 * receipt that carries no mark prints exactly what the default summary prints.
 *
 * @module Tools/visual-regression/lib/landing-cells-summary
 */

import { UNMEASURED_REASONS, verdictResultLabel } from "./probe-refusal.mjs";
import { buildMarkdownSummary } from "./probe-runtime-receipts.mjs";

const NOT_RECORDED = "reason not recorded";
const TABLE_HEADER = "| Verdict | Result |";
const PF_ID_METRIC = /^PF-(\d)$/;
const UNMEASURED_STATISTIC = /^unmeasured/;

/** A figure as a reader wants it: four significant digits at most. */
function figure(value) {
  return Number.isFinite(value) ? String(Number(value.toPrecision(4))) : null;
}

/** A byte count with thousands separators (fixed locale: a summary must not vary by machine). */
function bytes(value) {
  return Number.isFinite(value)
    ? `${Math.round(value).toLocaleString("en-US")} B`
    : null;
}

/**
 * The figures a provisional-floor mark names, for either shape (PF-3's
 * `fraction` over `registeredBandFraction`, PF-4's `floorBytes` over
 * `registeredAllocationBytes`). A mark of neither shape prints its other
 * scalar fields; an unknown extra field never breaks the known shapes.
 */
function floorFigures(mark) {
  const parts = [];
  const fraction = figure(mark.fraction);
  if (fraction !== null) {
    const band = figure(mark.registeredBandFraction);
    parts.push(
      band === null ? fraction : `${fraction} over registered band ${band}`,
    );
  }
  const floorBytes = bytes(mark.floorBytes);
  if (floorBytes !== null) {
    const registered = bytes(mark.registeredAllocationBytes);
    parts.push(
      registered === null
        ? floorBytes
        : `${floorBytes} over registered allocation ${registered}`,
    );
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(mark)) {
      if (
        !["flag", "decided", "source"].includes(key) &&
        ["string", "number", "boolean"].includes(typeof value)
      ) {
        parts.push(`${key} ${value}`);
      }
    }
  }
  return parts.join("; ");
}

function floorText(mark) {
  const flag = typeof mark.flag === "string" ? mark.flag : "provisional-floor";
  const figures = floorFigures(mark);
  return figures === "" ? flag : `${flag} ${figures}`;
}

/** Reasons a statistic carries once it has been read as unmeasured, anywhere in a PF record. */
function statisticReasons(node, depth, out) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return;
  }
  if (
    UNMEASURED_STATISTIC.test(String(node.verdict ?? "")) &&
    Array.isArray(node.reasons)
  ) {
    out.push(...node.reasons);
  }
  if (depth > 0) {
    for (const child of Object.values(node)) {
      statisticReasons(child, depth - 1, out);
    }
  }
}

/**
 * Why a PF verdict was not read. A PF verdict id is `<arm key>:<metric>`;
 * the arm's contention guard names the machine reasons and the unmeasured
 * statistics name their own (a number the arm never produced).
 */
function pfReasons(receipt, id) {
  const cut = id.lastIndexOf(":");
  const metric = PF_ID_METRIC.exec(id.slice(cut + 1));
  const arm = cut > 0 ? receipt.comparison?.[id.slice(0, cut)] : undefined;
  if (!metric || !arm) {
    return [];
  }
  const found = Array.isArray(arm.contention?.reasons)
    ? [...arm.contention.reasons]
    : [];
  statisticReasons(arm[`pf${metric[1]}`], 4, found);
  return [...new Set(found.filter((reason) => typeof reason === "string"))];
}

/** The mark a verdict earns, as `{star, note}` (the row gains `*` when a floor decided it), or null. */
function markOf(receipt, verdict) {
  const id = String(verdict.id ?? verdict.claim ?? "verdict");
  const floor = verdict.provisionalFloor;
  if (floor !== null && typeof floor === "object") {
    const text = floorText(floor);
    return floor.decided === true
      ? {
          star: true,
          note: `- ${verdictResultLabel(verdict)}* \`${id}\`: ${text}; the floor decided this verdict`,
        }
      : {
          star: false,
          note: `- \`${id}\`: ${text}; the floor was applied and did not decide this verdict`,
        };
  }
  if (verdict.unmeasured === UNMEASURED_REASONS.CONTENDED) {
    const reasons = pfReasons(receipt, id);
    return {
      star: false,
      note: `- ${verdictResultLabel(verdict)} \`${id}\`: ${
        reasons.length > 0 ? reasons.join("; ") : NOT_RECORDED
      }`,
    };
  }
  if (verdict.notRun === true && verdict.pass !== true) {
    const reasons =
      typeof verdict.reason === "string" && verdict.reason !== ""
        ? [verdict.reason]
        : pfReasons(receipt, id);
    return {
      star: false,
      note: `- ${verdictResultLabel(verdict)} \`${id}\`: ${
        reasons.length > 0 ? reasons.join("; ") : NOT_RECORDED
      }`,
    };
  }
  return null;
}

/** Notes for arms whose base frame was found beside the report, not at its recorded path. */
function siblingFallbackNotes(receipt) {
  const notes = [];
  const comparison = receipt.comparison;
  if (comparison === null || typeof comparison !== "object") {
    return notes;
  }
  for (const [armKey, arm] of Object.entries(comparison)) {
    if (arm?.pixels?.frameSource === "sibling-fallback") {
      const recorded = arm.pixels.baseRecordedPath;
      // Concatenated: the fleet's source scanner misreads an escaped backtick
      // inside a nested template.
      const where =
        typeof recorded === "string" && recorded !== ""
          ? "`" + recorded + "`"
          : "a path not recorded";
      notes.push(
        `- sibling-fallback \`${armKey}\`: the base frame was found beside the report; it was recorded at ${where}`,
      );
    }
  }
  return notes;
}

/**
 * @param {object} receipt The whole landing report.
 * @param {object} runtimeReceipt The runtime receipt (verdicts, generatedAt,
 *   origin, servedBuildAssertion, exitCode).
 * @param {string} title Heading.
 * @returns {string} Markdown: `buildMarkdownSummary`'s text when the receipt
 *   carries no mark, otherwise the same text with starred rows, a Warm-up
 *   line after the header block and a Marks section before the receipt fields.
 */
export function buildLandingCellsSummary(receipt, runtimeReceipt, title) {
  const summary = buildMarkdownSummary(receipt, runtimeReceipt, title);
  const verdicts = Array.isArray(runtimeReceipt.verdicts)
    ? runtimeReceipt.verdicts
    : [];
  const stars = new Map();
  const notes = [];
  verdicts.forEach((verdict, index) => {
    const mark = markOf(receipt, verdict);
    if (mark !== null) {
      notes.push(mark.note);
      if (mark.star) {
        stars.set(index, verdictResultLabel(verdict));
      }
    }
  });
  notes.push(...siblingFallbackNotes(receipt));
  // Only a PF run waits, so only a PF run's summary says how the wait ended.
  const warmUp =
    typeof receipt.warmUp?.note === "string" &&
    receipt.warmUp.note !== "" &&
    receipt.warmUp.status !== "not-a-pf-run"
      ? receipt.warmUp.note
      : null;
  if (notes.length === 0 && warmUp === null) {
    return summary;
  }

  const lines = summary.split("\n");
  const firstRow = lines.indexOf(TABLE_HEADER) + 2;
  for (const [index, label] of stars) {
    const row = lines[firstRow + index];
    const tail = ` | ${label} |`;
    if (row?.endsWith(tail)) {
      lines[firstRow + index] = `${row.slice(0, -tail.length)} | ${label}* |`;
    }
  }
  if (notes.length > 0) {
    const fields = lines.findLastIndex((line) =>
      line.startsWith("Receipt fields:"),
    );
    lines.splice(fields, 0, "## Marks", "", ...notes, "");
  }
  if (warmUp !== null) {
    // After the header block: the line after `Exit code:` is blank.
    const exit = lines.findIndex((line) => line.startsWith("Exit code:"));
    // The note already opens with its own `warm-up:` label.
    const said = warmUp.replace(/^warm-up:\s*/iu, "");
    lines.splice(exit + 2, 0, `Warm-up: ${said}`, "");
  }
  return lines.join("\n");
}
