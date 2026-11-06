/**
 * The landing-cells probe's Markdown summary.
 * @purpose The landing-cells Markdown summary hook: the default id-and-result table plus the marks a reader needs where they look (a PASS decided by a provisional floor reads PASS* with the flag and figures footnoted, a floor that did not decide or that decided nothing because the verdict was not measured, the reason a contended or not-run verdict was not read with the arm's CPU figures (machine CPU figures and long float noise in a reason print at two decimals; the receipt keeps the raw floats), the CPU warm-up, prime and contention-basis notes, a base frame found beside the report, a gate-only cell whose frame compare its rig removed), a section of the bind group layouts a cell counted (label, group index, per-stage counts against the WebGPU default limits) and of the device limits it got, and nothing else changed.
 * @status ACTIVE
 *
 * The table is `buildMarkdownSummary`'s own: this module post-edits its lines
 * (one table row per verdict, in verdict order) rather than copying it, so a
 * receipt that carries no mark prints exactly what the default summary prints.
 *
 * @module Tools/visual-regression/lib/landing-cells-summary
 */

import { layoutCensusLine } from "./bind-group-layout-census.mjs";
import { deviceLimitsLine } from "./device-limits-dial.mjs";
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

/** A machine CPU figure to two decimals, trailing zeros dropped (61.76, 32.1). */
function cpuFigure(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(2))) : null;
}

// Five or more fractional digits is float arithmetic noise (83.75181818181818),
// where a recorded figure such as a mode value (0.458) has at most four.
const LONG_DECIMAL = /(?<![\d.])\d+\.\d{5,}(?!\d)/g;

/** A reason as the summary prints it: long decimals at two places; the receipt keeps its own text. */
function roundedReason(reason) {
  return reason.replace(LONG_DECIMAL, (found) =>
    String(Number(Number(found).toFixed(2))),
  );
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

/** A PF verdict id's arm contention record, or undefined. */
function contentionOf(receipt, id) {
  const cut = id.lastIndexOf(":");
  return cut > 0
    ? receipt.comparison?.[id.slice(0, cut)]?.contention
    : undefined;
}

/**
 * The machine CPU figures behind a contention verdict, as the guard recorded
 * them (the reasons string may or may not hold them), or "" when the arm has
 * none.
 */
function cpuFigures(contention) {
  const base = cpuFigure(contention?.baseMeanCpu);
  const tip = cpuFigure(contention?.tipMeanCpu);
  if (base === null || tip === null) {
    return "";
  }
  const delta = cpuFigure(contention.armDeltaPct);
  const busy = cpuFigure(contention.contendedCpuPct);
  const apart = cpuFigure(contention.cpuArmDeltaPct);
  const limits = [
    ...(busy === null ? [] : [`mean above ${busy} %`]),
    ...(apart === null ? [] : [`arms apart by more than ${apart} points`]),
  ];
  const gap = delta === null ? "" : `, arms apart by ${delta} points`;
  const at = limits.length > 0 ? ` (contended at: ${limits.join(", ")})` : "";
  return `machine CPU: base mean ${base} %, tip mean ${tip} %${gap}${at}`;
}

/**
 * The marks a verdict earns, as `{star, notes}` (the row gains `*` when a
 * floor decided a measured verdict), or null. A verdict that was not measured
 * (contended or not run) always gets its own line naming why, with the arm's
 * CPU figures when it has them; a provisional floor on it is footnoted as
 * applied and deciding nothing, and never stars the row.
 */
function markOf(receipt, verdict) {
  const id = String(verdict.id ?? verdict.claim ?? "verdict");
  const floor = verdict.provisionalFloor;
  const hasFloor = floor !== null && typeof floor === "object";
  const contended = verdict.unmeasured === UNMEASURED_REASONS.CONTENDED;
  const notRun = verdict.notRun === true && verdict.pass !== true;
  const notes = [];
  let star = false;
  if (contended || notRun) {
    const reasons =
      !contended && typeof verdict.reason === "string" && verdict.reason !== ""
        ? [verdict.reason]
        : pfReasons(receipt, id);
    const contention = contentionOf(receipt, id);
    const figures =
      contended || contention?.status === "contended"
        ? cpuFigures(contention)
        : "";
    const why =
      reasons.length > 0 ? roundedReason(reasons.join("; ")) : NOT_RECORDED;
    notes.push(
      `- ${verdictResultLabel(verdict)} \`${id}\`: ${why}${figures === "" ? "" : `; ${figures}`}`,
    );
  } else if (
    verdict.pass !== true &&
    verdict.modes !== null &&
    typeof verdict.modes === "object" &&
    typeof verdict.reason === "string"
  ) {
    // A measured failure whose repeats fell into two modes keeps its result
    // and names the modes beside it.
    notes.push(
      `- ${verdictResultLabel(verdict)} \`${id}\`: ${roundedReason(verdict.reason)}`,
    );
  }
  if (hasFloor) {
    const text = floorText(floor);
    if (contended || notRun) {
      notes.push(
        `- \`${id}\`: ${text}; the floor was applied and decided nothing because the verdict was not measured`,
      );
    } else if (floor.decided === true) {
      star = true;
      notes.push(
        `- ${verdictResultLabel(verdict)}* \`${id}\`: ${text}; the floor decided this verdict`,
      );
    } else {
      notes.push(
        `- \`${id}\`: ${text}; the floor was applied and did not decide this verdict`,
      );
    }
  }
  // A gate-only cell's frames were removed from every compare by its rig, so a
  // byte-identical pair beside a passing gate is not read as a visual pass.
  const frames = verdict.frames;
  if (
    frames !== null &&
    typeof frames === "object" &&
    frames.comparable === false
  ) {
    notes.push(
      `- \`${id}\`: ${frames.reason ?? "frames not comparable"}; the frame compare was removed (declared by ${frames.declaredBy ?? "a rig not recorded"})`,
    );
  }
  return notes.length === 0 ? null : { star, notes };
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
 * The lines of the layout census and device limits a page recorded: one block
 * per page that carries either record, none for a page that carries neither.
 */
function layoutCensusNotes(receipt) {
  const notes = [];
  for (const page of receipt.pages ?? []) {
    const census = page?.layoutCensus;
    const limits = page?.deviceLimits;
    if (!census && !limits) {
      continue;
    }
    notes.push(
      `- \`${page.cell}\` ${page.renderer} ${page.page} (run ${page.run}):`,
    );
    if (census) {
      if (census.installed !== true) {
        notes.push("  - bind group layout census: script not installed");
      }
      for (const row of census.rows ?? []) {
        notes.push(`  - layout ${layoutCensusLine(row)}`);
      }
    }
    if (limits) {
      notes.push(`  - ${deviceLimitsLine(limits)}`);
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
 *   carries no mark, otherwise the same text with starred rows, Warm-up,
 *   Prime and Contention basis lines after the header block (a PF run only),
 *   a Marks section before the receipt fields and, after it, the layout census
 *   and device limits section when a page recorded either.
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
      notes.push(...mark.notes);
      if (mark.star) {
        stars.set(index, verdictResultLabel(verdict));
      }
    }
  });
  notes.push(...siblingFallbackNotes(receipt));
  const census = layoutCensusNotes(receipt);
  // Only a PF run waits, so only a PF run's summary says how the wait ended.
  const onPfRun = receipt.warmUp?.status !== "not-a-pf-run";
  const noteOf = (record) =>
    onPfRun && typeof record?.note === "string" && record.note !== ""
      ? record.note
      : null;
  const warmUp = noteOf(receipt.warmUp);
  const prime = noteOf(receipt.prime);
  const basis = noteOf(receipt.contentionBasis);
  const headed = warmUp !== null || prime !== null || basis !== null;
  if (notes.length === 0 && census.length === 0 && !headed) {
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
  if (census.length > 0) {
    const fields = lines.findLastIndex((line) =>
      line.startsWith("Receipt fields:"),
    );
    lines.splice(
      fields,
      0,
      "## Bind group layouts and device limits",
      "",
      ...census,
      "",
    );
  }
  if (headed) {
    // After the header block: the line after `Exit code:` is blank. Each note
    // already opens with its own label, which the line's own label replaces.
    const said = (label, note) => {
      if (note === null) {
        return [];
      }
      const own = `${label.toLowerCase()}:`;
      const body = note.toLowerCase().startsWith(own)
        ? note.slice(own.length).trimStart()
        : note;
      return [`${label}: ${body}`, ""];
    };
    const exit = lines.findIndex((line) => line.startsWith("Exit code:"));
    lines.splice(
      exit + 2,
      0,
      ...said("Warm-up", warmUp),
      ...said("Prime", prime),
      ...said("Contention basis", basis),
    );
  }
  return lines.join("\n");
}
