// probe-runtime-receipts.mjs — the probe runtime's receipt serialisation, run outcomes and incident records.
//
// @purpose Companion of probe-runtime.mjs: sha256, normalizeJson, assembleReceipt, buildRuntimeReceipt, RUN_OUTCOMES, INCIDENT_ARTIFACT_SUFFIX, outcomeOfRun, buildIncidentRecord and buildMarkdownSummary, the pure builders of everything a run writes to disk.
// @status ACTIVE
//
// WHY A PIECE. Every function here is pure (sha256 hashes the bytes it is
// given), so the receipt half of the runtime moved out of
// `probe-runtime.mjs` when that module passed 1,000 lines
// (DX-KIT-DECOMPOSE-RUNTIME-WATER). The runtime re-exports every name, so no
// importer changed; `runProbe` is still the only caller that writes the files.

import { createHash } from "node:crypto";

/**
 * @param {Buffer|Uint8Array} bytes Bytes to fingerprint.
 * @returns {string} Lowercase hex sha256.
 */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Serialize a receipt the way every banked receipt in this fork is serialized:
 * two-space JSON, LF line endings, trailing newline. A receipt that changes its
 * whitespace between runs cannot be diffed, and diffing receipts is how a
 * regression gets found.
 *
 * @param {unknown} value The receipt.
 * @returns {string} The serialized text.
 */
export function normalizeJson(value) {
  return `${JSON.stringify(value, null, 2).replace(/\r\n/g, "\n")}\n`;
}

/**
 * Assemble the document a probe publishes.
 *
 * `probe-owned` (the default for a migrated probe) writes the probe's fields
 * and nothing else, so a receipt's field set survives migration unchanged.
 * `runtime` wraps them in the runtime's own envelope for probes written after
 * this module existed.
 *
 * @param {object} options Options.
 * @param {"probe-owned"|"runtime"} options.envelope Which shape to produce.
 * @param {object} options.fields The probe's own receipt fields.
 * @param {object} options.runtime The runtime section (origin, options, preflight, ...).
 * @returns {object} The receipt.
 */
export function assembleReceipt({ envelope, fields, runtime }) {
  if (envelope === "probe-owned") {
    return { ...fields };
  }
  if (envelope === "runtime") {
    return { ...runtime, ...fields };
  }
  throw new TypeError(`unknown receipt envelope: ${envelope}`);
}

/**
 * The runtime's own record of a run: everything the runtime knew and the probe
 * did not have to restate.
 *
 * @param {object} options Options.
 * @param {string} options.probe Probe name.
 * @param {string} options.generatedAt ISO timestamp.
 * @param {string} options.origin Resolved origin.
 * @param {object} options.options Parsed options.
 * @param {object|null} options.preflight Preflight result, or `null` when waived.
 * @param {object} options.edgeSlot Slot record.
 * @param {string[]} [options.launchArgs] Edge flags the run was launched with.
 * @param {Array<object>} options.captures Capture records.
 * @param {Array<object>} options.verdicts Probe verdicts.
 * @param {number} options.exitCode Final exit code.
 * @returns {object} The runtime receipt.
 */
export function buildRuntimeReceipt({
  probe,
  generatedAt,
  origin,
  options,
  preflight,
  edgeSlot,
  launchArgs,
  captures,
  verdicts,
  exitCode,
}) {
  return {
    probe,
    generatedAt,
    origin,
    options,
    servedBuildAssertion: options.servedBuild ? "enforced" : "waived",
    preflight,
    edgeSlot,
    launchArgs: launchArgs ?? null,
    captures,
    verdicts,
    exitCode,
  };
}

/**
 * The three ways a run can end, as far as its artifacts are concerned.
 *
 * Only a MEASURED run has standing to publish. The other two produce a
 * document that looks like a measurement and is not one: the cell loop never
 * ran, or ran partly, so a probe's receipt builder assembles a well-formed
 * envelope over zero cells and zero verdicts — and a `probe-owned` envelope by
 * design carries none of the runtime's fields, so it cannot even say why.
 * Written over a banked receipt, that is a probe reporting "nothing failed"
 * about a run it never took.
 */
export const RUN_OUTCOMES = Object.freeze({
  MEASURED: "measured",
  REFUSED: "refused",
  ERRORED: "errored",
});

/**
 * The sidecar a non-measuring run writes INSTEAD of a receipt.
 *
 * The name differs from `<name>-report.json` deliberately. What tells a reader
 * that the banked receipt is still the last real measurement is that no fresh
 * one appeared; an incident written under the receipt's own name could not say
 * that, whatever it contained.
 */
export const INCIDENT_ARTIFACT_SUFFIX = Object.freeze({
  [RUN_OUTCOMES.REFUSED]: "refusal",
  [RUN_OUTCOMES.ERRORED]: "error",
});

/**
 * Classify a finished run for the purpose of deciding what it may write.
 *
 * @param {object} options Options.
 * @param {object|null} [options.refusal] The refusal, when one occurred.
 * @param {boolean} [options.errored] Whether the harness threw.
 * @returns {string} One of {@link RUN_OUTCOMES}.
 */
export function outcomeOfRun({ refusal, errored }) {
  if (refusal) {
    return RUN_OUTCOMES.REFUSED;
  }
  if (errored === true) {
    return RUN_OUTCOMES.ERRORED;
  }
  return RUN_OUTCOMES.MEASURED;
}

/**
 * The durable record of a run that did not measure: the outcome first, then
 * everything the runtime knew — origin, options, the preflight result, the
 * Edge slot, the launch flags, the refusal — plus the harness error when there
 * was one. It is a strict superset of what the runtime sidecar carried, so
 * skipping the sidecar on this path loses nothing.
 *
 * @param {object} options Options.
 * @param {string} options.outcome One of {@link RUN_OUTCOMES}.
 * @param {object} options.runtimeReceipt The runtime receipt for the run.
 * @param {string|null} [options.error] The harness error text, when it threw.
 * @returns {object} The incident record.
 */
export function buildIncidentRecord({ outcome, runtimeReceipt, error = null }) {
  const record = { outcome, ...runtimeReceipt };
  if (error !== null && error !== undefined) {
    record.error = error;
  }
  return record;
}

/**
 * Default markdown summary. A probe with a richer table supplies its own
 * `summary(receipt, runtimeReceipt)`.
 *
 * @param {object} receipt The probe receipt.
 * @param {object} runtimeReceipt The runtime receipt.
 * @param {string} title Heading.
 * @returns {string} Markdown.
 */
export function buildMarkdownSummary(receipt, runtimeReceipt, title) {
  const verdicts = Array.isArray(runtimeReceipt.verdicts)
    ? runtimeReceipt.verdicts
    : [];
  const lines = [
    `# ${title}`,
    "",
    `Generated: ${runtimeReceipt.generatedAt}`,
    "",
    `Origin: \`${runtimeReceipt.origin}\``,
    "",
    `Served-build assertion: ${runtimeReceipt.servedBuildAssertion}`,
    "",
    `Exit code: ${runtimeReceipt.exitCode}`,
    "",
  ];
  if (verdicts.length > 0) {
    lines.push("| Verdict | Result |", "| --- | --- |");
    for (const verdict of verdicts) {
      const id = String(verdict.id ?? verdict.claim ?? "verdict").replaceAll(
        "|",
        "\\|",
      );
      lines.push(`| ${id} | ${verdict.pass === true ? "PASS" : "FAIL"} |`);
    }
    lines.push("");
  }
  lines.push(`Receipt fields: ${Object.keys(receipt).join(", ")}`, "");
  return lines.join("\n");
}
