// probe-water-cells-exports.spec.mjs - export parity of probe-water-cells.mjs after its decomposition (DX-KIT-DECOMPOSE-RUNTIME-WATER). Pure Node: no browser, no GPU.
// @purpose Pins that probe-water-cells.mjs still exports exactly the 17 names it exported before its cell table and its metrics reducer moved into lib/water-cell-table.mjs and lib/water-cell-verdicts.mjs, and that every moved name is the SAME binding as the piece that now owns it, so no importer of the probe could tell the split happened.
// @status ACTIVE
//
// WHY A SPEC FOR A PURE MOVE. A decomposition changes no behaviour, so a
// behaviour spec that does not import a given name stays green when that
// name's re-export is lost; the regime runners and the Edge executor do
// import it, and fail at their own import, in a session that already spent a
// GPU slot. This spec is the one place that fails when the probe's public
// surface drifts. The list below is the surface at 566ad99447, before the split; a
// name added to the probe later is a deliberate edit to this list.
//
// INERTNESS. The mutant imports the probe from a copy of its source with one
// re-export dropped and requires the parity check to report exactly that name,
// while the unmutated probe reports nothing.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import * as probe from "./probe-water-cells.mjs";
import * as table from "./lib/water-cell-table.mjs";
import * as verdicts from "./lib/water-cell-verdicts.mjs";

const PROBE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "probe-water-cells.mjs",
);

/** The probe's public surface before the split, sorted. */
const BASE_EXPORTS = Object.freeze([
  "WATER_ARMS",
  "WATER_BANDS",
  "WATER_CELLS",
  "WATER_DEMO_ID",
  "WAVE_EPOCH_DIAL",
  "descriptor",
  "mismatchPct",
  "parityNotMeasured",
  "planWaterCells",
  "servedArtifactsForCells",
  "splitList",
  "stageGaps",
  "stageHandlesDial",
  "summarizeWaterRecords",
  "waterStagePlan",
  "waterVerdicts",
  "waveEpochReadback",
]);

/** Which piece owns which re-exported names. */
const OWNERS = Object.freeze([
  [
    "water-cell-table.mjs",
    table,
    [
      "WATER_ARMS",
      "WATER_BANDS",
      "WATER_CELLS",
      "WATER_DEMO_ID",
      "WAVE_EPOCH_DIAL",
      "planWaterCells",
      "splitList",
      "stageGaps",
      "stageHandlesDial",
      "waterStagePlan",
      "waveEpochReadback",
    ],
  ],
  [
    "water-cell-verdicts.mjs",
    verdicts,
    [
      "mismatchPct",
      "parityNotMeasured",
      "summarizeWaterRecords",
      "waterVerdicts",
    ],
  ],
]);

/**
 * Compare a probe namespace with the base surface and the pieces.
 *
 * @param {object} namespace The probe module namespace under test.
 * @returns {{missing: string[], extra: string[], notSame: string[]}} The drift.
 */
function surfaceDrift(namespace) {
  const actual = Object.keys(namespace).sort();
  const missing = BASE_EXPORTS.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !BASE_EXPORTS.includes(name));
  const notSame = [];
  for (const [, owner, names] of OWNERS) {
    for (const name of names) {
      if (namespace[name] !== owner[name]) {
        notSame.push(name);
      }
    }
  }
  return { missing, extra, notSame };
}

test("the probe exports exactly the 17 names it exported before the split", () => {
  assert.equal(BASE_EXPORTS.length, 17);
  assert.deepEqual([...BASE_EXPORTS].sort(), [...BASE_EXPORTS]);
  assert.deepEqual(Object.keys(probe).sort(), [...BASE_EXPORTS]);
});

test("every moved name is the same binding as its piece's", () => {
  assert.deepEqual(surfaceDrift(probe), {
    missing: [],
    extra: [],
    notSame: [],
  });
});

test("the names that stayed in the probe are the descriptor and the served-build list", () => {
  assert.equal(typeof probe.descriptor, "object");
  assert.equal(probe.descriptor.name, "water-cells");
  assert.equal(typeof probe.servedArtifactsForCells, "function");
  assert.equal(probe.descriptor.servedArtifacts !== undefined, true);
});

test("MUTANT (inertness): a probe that drops one re-export is reported by name", async () => {
  const mutated = await importMutated(PROBE_PATH, [
    [
      "  summarizeWaterRecords,\n  waterStagePlan,\n  waterVerdicts,\n  waveEpochReadback,\n};",
      "  summarizeWaterRecords,\n  waterStagePlan,\n  waveEpochReadback,\n};",
    ],
  ]);
  assert.equal(
    Object.hasOwn(mutated, "waterVerdicts"),
    false,
    "the mutant must lose waterVerdicts, otherwise the parity check below proves nothing",
  );
  assert.deepEqual(surfaceDrift(mutated), {
    missing: ["waterVerdicts"],
    extra: [],
    notSame: ["waterVerdicts"],
  });
  assert.deepEqual(surfaceDrift(probe), {
    missing: [],
    extra: [],
    notSame: [],
  });
});
