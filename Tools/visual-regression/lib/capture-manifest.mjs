// capture-manifest.mjs — the capture manifest: its builder, its unmeasured records and its reader.
//
// @purpose Manifest piece of capture.mjs: buildCaptureManifest (the one document the contact sheet reads, carrying no verdict), the unmeasuredCell and unmeasuredPair records, and validateManifest with its cell, pair and rig readers and the verdict-token scan that reports a pass/fail word anywhere in the document.
// @status ACTIVE
//
// WHY A PIECE. The manifest moved out of `capture.mjs` when that module passed
// 1,000 lines (DX-KIT-CAPTURE-SEAM-OVER-SIZE). `capture.mjs` re-exports
// buildCaptureManifest and validateManifest, so importers are unchanged;
// unmeasuredCell and unmeasuredPair are exported here for `capture.mjs` only.

import { isRelativePosixPath } from "./relative-path.mjs";
import {
  CAPTURE_MANIFEST_KIND,
  CAPTURE_MANIFEST_SCHEMA_VERSION,
  CAPTURE_RENDERERS,
  CAPTURE_SLOTS,
  CELL_METRIC_PROVENANCE,
  CELL_STATES,
  FORBIDDEN_MANIFEST_KEYS,
  FORBIDDEN_MANIFEST_VALUES,
  HEX64,
  HEX8,
  ISO_INSTANT,
} from "./capture-vocabulary.mjs";

/**
 * Assemble the capture manifest from a plan and what the run produced.
 *
 * @param {object} inputs Inputs.
 * @param {object} inputs.descriptor The plan.
 * @param {Map<string, object>|object} inputs.cells Cell records by cell key.
 * @param {Map<string, object>|object} inputs.pairs Pair records by pair key.
 * @param {string} inputs.receiptPath The receipt, relative to the manifest.
 * @param {string} inputs.generatedAt ISO-8601 UTC instant.
 * @param {"enforced"|"waived"} inputs.servedBuildAssertion The assertion's state.
 * @returns {object} The manifest.
 */
export function buildCaptureManifest({
  descriptor,
  cells,
  pairs,
  receiptPath,
  generatedAt,
  servedBuildAssertion,
}) {
  const cellAt = (key) =>
    cells instanceof Map ? cells.get(key) : cells?.[key];
  const pairAt = (key) =>
    pairs instanceof Map ? pairs.get(key) : pairs?.[key];

  return {
    schemaVersion: CAPTURE_MANIFEST_SCHEMA_VERSION,
    kind: CAPTURE_MANIFEST_KIND,
    generatedAt,
    captureRoot: descriptor.captureRoot,
    origins: { ...descriptor.origins },
    servedBuildAssertion,
    receipt: receiptPath,
    slots: [...descriptor.slots],
    renderers: [...descriptor.renderers],
    rigs: descriptor.rigs.map((summary) => {
      const rigCells = {};
      const rigPairs = {};
      for (const renderer of summary.renderers) {
        rigCells[renderer] = {};
        for (const slot of descriptor.slots) {
          rigCells[renderer][slot] =
            cellAt(`${summary.id}|${renderer}|${slot}`) ??
            unmeasuredCell("no cell record was produced for this slot");
        }
        rigPairs[renderer] =
          pairAt(`${summary.id}|${renderer}`) ??
          unmeasuredPair("no pair record was produced for this renderer");
      }
      return {
        id: summary.id,
        replayKey: summary.replayKey,
        description: summary.description,
        viewport: { ...summary.viewport },
        cells: rigCells,
        pairs: rigPairs,
      };
    }),
  };
}

export function unmeasuredCell(reason, trackedBy = null) {
  return {
    state: CELL_STATES.UNMEASURED,
    image: null,
    reason,
    trackedBy,
    metrics: null,
  };
}

export function unmeasuredPair(reason) {
  return {
    state: CELL_STATES.UNMEASURED,
    diffImage: null,
    mismatchPct: null,
    changedPx: null,
    bbox: null,
    tolerance: null,
    metrics: null,
    reason,
  };
}

// The manifest's path predicate is `lib/relative-path.mjs`'s, not a copy of
// it. The copy that used to stand here tested `ABSOLUTE_SCHEME`, which
// requires `://` — so `C:/ESCAPED/x.png` had no scheme to match and validated
// clean HERE while the contact sheet's reader refused it. Two fail-closed
// readers of the same manifest disagreeing about what a relative path is is
// the defect, not a style difference. `ABSOLUTE_SCHEME` stays above for
// `resolveRigPage`, where "is this a url to parse" really is the question.

function scanForVerdicts(value, trail, violations) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForVerdicts(entry, `${trail}[${index}]`, violations),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_MANIFEST_KEYS.includes(key)) {
        violations.push(
          `${trail}.${key}: verdict vocabulary may not enter a capture manifest`,
        );
      }
      scanForVerdicts(entry, `${trail}.${key}`, violations);
    }
    return;
  }
  if (typeof value === "string" && FORBIDDEN_MANIFEST_VALUES.includes(value)) {
    violations.push(
      `${trail}: "${value}" is a GateExpectation token and may not appear in a capture manifest`,
    );
  }
}

/**
 * Validate a capture manifest. Fails CLOSED: an unrecognised shape is a
 * violation rather than a silent pass, the discipline `validateRig` already
 * uses.
 *
 * @param {object} manifest The manifest.
 * @returns {string[]} Violations; empty when the manifest is sound.
 */
export function validateManifest(manifest) {
  const violations = [];
  const need = (condition, message) => {
    if (!condition) {
      violations.push(message);
    }
  };

  if (manifest === null || typeof manifest !== "object") {
    return ["manifest must be an object"];
  }

  need(
    manifest.schemaVersion === CAPTURE_MANIFEST_SCHEMA_VERSION,
    `schemaVersion must be ${CAPTURE_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(manifest.schemaVersion)}`,
  );
  need(
    manifest.kind === CAPTURE_MANIFEST_KIND,
    `kind must be "${CAPTURE_MANIFEST_KIND}", got ${JSON.stringify(manifest.kind)}`,
  );
  need(
    ISO_INSTANT.test(String(manifest.generatedAt)),
    "generatedAt must be an ISO-8601 UTC instant with milliseconds",
  );
  need(
    isRelativePosixPath(manifest.captureRoot),
    "captureRoot must be a relative POSIX path",
  );
  need(
    isRelativePosixPath(manifest.receipt),
    "receipt must be a relative POSIX path",
  );
  need(
    manifest.servedBuildAssertion === "enforced" ||
      manifest.servedBuildAssertion === "waived",
    'servedBuildAssertion must be "enforced" or "waived"',
  );
  for (const slot of CAPTURE_SLOTS) {
    need(
      typeof manifest.origins?.[slot] === "string" &&
        manifest.origins[slot].length > 0,
      `origins.${slot} is required and is never defaulted`,
    );
  }
  need(
    Array.isArray(manifest.slots) &&
      manifest.slots.length === CAPTURE_SLOTS.length &&
      manifest.slots.every((slot, index) => slot === CAPTURE_SLOTS[index]),
    `slots must be exactly ${JSON.stringify(CAPTURE_SLOTS)}`,
  );
  need(
    Array.isArray(manifest.renderers) &&
      manifest.renderers.length > 0 &&
      manifest.renderers.every((renderer) =>
        CAPTURE_RENDERERS.includes(renderer),
      ),
    `renderers must be a non-empty subset of ${JSON.stringify(CAPTURE_RENDERERS)}`,
  );

  const known = new Set([
    "schemaVersion",
    "kind",
    "generatedAt",
    "captureRoot",
    "origins",
    "servedBuildAssertion",
    "receipt",
    "slots",
    "renderers",
    "rigs",
  ]);
  for (const key of Object.keys(manifest)) {
    need(known.has(key), `unknown top-level key ${key}`);
  }

  if (!Array.isArray(manifest.rigs) || manifest.rigs.length === 0) {
    violations.push("rigs must be a non-empty array");
  } else {
    for (const rig of manifest.rigs) {
      validateManifestRig(rig, manifest, violations);
    }
  }

  scanForVerdicts(manifest, "manifest", violations);
  return violations;
}

function validateManifestRig(rig, manifest, violations) {
  const id = rig?.id ?? "(unnamed)";
  const need = (condition, message) => {
    if (!condition) {
      violations.push(`${id}: ${message}`);
    }
  };

  need(typeof rig?.id === "string" && rig.id.length > 0, "missing id");
  need(HEX8.test(String(rig?.replayKey)), "replayKey must be 8 lowercase hex");
  need(typeof rig?.description === "string", "description must be a string");
  need(
    Number.isFinite(rig?.viewport?.width) && rig.viewport.width > 0,
    "viewport.width must be positive",
  );
  need(
    Number.isFinite(rig?.viewport?.height) && rig.viewport.height > 0,
    "viewport.height must be positive",
  );

  const renderers = Object.keys(rig?.cells ?? {});
  need(renderers.length > 0, "cells must name at least one renderer");
  for (const renderer of renderers) {
    need(
      CAPTURE_RENDERERS.includes(renderer),
      `unknown renderer ${renderer} in cells`,
    );
    for (const slot of CAPTURE_SLOTS) {
      validateManifestCell(
        rig.cells[renderer]?.[slot],
        `${id}.${renderer}.${slot}`,
        violations,
      );
    }
    validateManifestPair(
      rig.pairs?.[renderer],
      `${id}.${renderer}`,
      violations,
    );
  }
  need(
    Object.keys(rig?.pairs ?? {}).every((renderer) =>
      renderers.includes(renderer),
    ),
    "pairs name a renderer that has no cells",
  );
}

function validateManifestCell(cell, trail, violations) {
  const need = (condition, message) => {
    if (!condition) {
      violations.push(`${trail}: ${message}`);
    }
  };
  if (cell === null || typeof cell !== "object") {
    violations.push(`${trail}: missing cell`);
    return;
  }
  if (cell.state === CELL_STATES.UNMEASURED) {
    need(cell.image === null, "an UNMEASURED cell has image null");
    need(
      typeof cell.reason === "string" && cell.reason.length > 0,
      "an UNMEASURED cell states its reason",
    );
    need(
      cell.trackedBy === null || typeof cell.trackedBy === "string",
      "trackedBy must be a string or null",
    );
    need(cell.metrics === null, "an UNMEASURED cell has metrics null");
    return;
  }
  if (cell.state !== CELL_STATES.MEASURED) {
    violations.push(
      `${trail}: state must be MEASURED or UNMEASURED, got ${JSON.stringify(cell.state)}`,
    );
    return;
  }
  need(
    isRelativePosixPath(cell.image),
    "image must be a relative POSIX path beside the manifest",
  );
  need(
    Number.isInteger(cell.width) && cell.width > 0,
    "width must be a positive integer",
  );
  need(
    Number.isInteger(cell.height) && cell.height > 0,
    "height must be a positive integer",
  );
  need(
    Number.isInteger(cell.byteLength) && cell.byteLength > 0,
    "byteLength must be a positive integer",
  );
  need(HEX64.test(String(cell.sha256)), "sha256 must be 64 lowercase hex");
  need(
    typeof cell.url === "string" && cell.url.length > 0,
    "url records what was fetched",
  );
  need(
    ISO_INSTANT.test(String(cell.capturedAt)),
    "capturedAt must be an ISO-8601 UTC instant",
  );
  need(
    Number.isFinite(cell.metrics?.rawByteLumaMean),
    "metrics.rawByteLumaMean must be finite",
  );
  need(
    Number.isFinite(cell.metrics?.nonBlackFraction) &&
      cell.metrics.nonBlackFraction >= 0 &&
      cell.metrics.nonBlackFraction <= 1,
    "metrics.nonBlackFraction must be in [0,1]",
  );
  need(
    cell.metrics?.provenance === CELL_METRIC_PROVENANCE,
    "metrics.provenance must state what the strip is",
  );
}

function validateManifestPair(pair, trail, violations) {
  const need = (condition, message) => {
    if (!condition) {
      violations.push(`${trail}: ${message}`);
    }
  };
  if (pair === null || typeof pair !== "object") {
    violations.push(`${trail}: missing pair`);
    return;
  }
  if (pair.state === CELL_STATES.UNMEASURED) {
    for (const key of [
      "diffImage",
      "mismatchPct",
      "changedPx",
      "bbox",
      "tolerance",
      "metrics",
    ]) {
      need(pair[key] === null, `an UNMEASURED pair has ${key} null`);
    }
    need(
      typeof pair.reason === "string" && pair.reason.length > 0,
      "an UNMEASURED pair states its reason",
    );
    return;
  }
  if (pair.state !== CELL_STATES.MEASURED) {
    violations.push(
      `${trail}: state must be MEASURED or UNMEASURED, got ${JSON.stringify(pair.state)}`,
    );
    return;
  }
  need(
    isRelativePosixPath(pair.diffImage),
    "diffImage must be a relative POSIX path beside the manifest",
  );
  need(
    pair.mismatchPct === null ||
      (Number.isFinite(pair.mismatchPct) &&
        pair.mismatchPct >= 0 &&
        pair.mismatchPct <= 100),
    "mismatchPct must be a percent in [0,100] or null",
  );
  need(
    Number.isInteger(pair.changedPx) && pair.changedPx >= 0,
    "changedPx must be a non-negative integer",
  );
  need(
    pair.bbox === null ||
      ["x0", "y0", "x1", "y1"].every((key) => Number.isInteger(pair.bbox[key])),
    "bbox must be null or four integers",
  );
  need(Number.isFinite(pair.tolerance), "tolerance records what the diff used");
  need(Number.isFinite(pair.metrics?.mssim), "metrics.mssim must be finite");
  need(
    Number.isInteger(pair.metrics?.windows) && pair.metrics.windows > 0,
    "metrics.windows must be a positive integer",
  );
}
