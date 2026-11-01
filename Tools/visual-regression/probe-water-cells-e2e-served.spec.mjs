// probe-water-cells-e2e-served.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Asserts the served-build assertion names 1f's Sandcastle 2 files only when 1f is a requested cell (with a mutant check), and the gate behind a refused 1f page and the wave epoch reach 2e and 2g end to end through descriptor.cells.
// @status ACTIVE
//
// One subject of the water-cells spec, split out of probe-water-cells.spec.mjs (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE);
// the shared stub browser, run frame and fixtures live in fixtures/probe-water-cells-support.mjs.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import {
  WATER_CELLS,
  WATER_DEMO_ID,
  descriptor,
  summarizeWaterRecords,
  waterVerdicts,
} from "./probe-water-cells.mjs";
import {
  TEMP_ROOT,
  rigOf,
  CLOCK,
  makeFakeBrowser,
  runE,
  pageVerdict,
} from "./fixtures/probe-water-cells-support.mjs";

const SANDCASTLE2_FILES = [
  "Apps/Sandcastle2/standalone.html",
  "Apps/Sandcastle2/templates/bucket.html",
  "Apps/Sandcastle2/templates/Sandcastle.js",
  `Apps/Sandcastle2/gallery/${WATER_DEMO_ID}/index.html`,
  `Apps/Sandcastle2/gallery/${WATER_DEMO_ID}/main.js`,
];
const ENGINE_FILES = [
  "Build/CesiumUnminified/Cesium.js",
  "Build/CesiumUnminified/index.js",
  "packages/engine/Build/Unminified/index.js",
];

/** @param {object} subject A water descriptor (real or mutated). */
function assertDemandsSandcastle2WhenOneFIsRequested(subject) {
  assert.equal(typeof subject.servedArtifacts, "function");
  for (const options of [
    { cells: "1f" },
    { cells: "coast-50km, 1f" },
    { cells: Object.keys(WATER_CELLS).join(",") },
    {},
  ]) {
    const served = subject.servedArtifacts(options);
    for (const file of [...ENGINE_FILES, ...SANDCASTLE2_FILES]) {
      assert.ok(served.includes(file), `${JSON.stringify(options)}: ${file}`);
    }
  }
}

/** @param {object} subject A water descriptor (real or mutated). */
function assertDemandsNoSandcastle2WithoutOneF(subject) {
  for (const cells of [
    "coast-50km",
    "great-lakes,orbit-disc",
    "great-lakes-lakeonly",
  ]) {
    assert.deepEqual(subject.servedArtifacts({ cells }), ENGINE_FILES, cells);
  }
}

test("E6: descriptor.servedArtifacts names the Sandcastle 2 files cell 1f loads when 1f is requested, and by default", () => {
  // The default --cells is every WATER_CELLS key, 1f among them.
  assert.ok(Object.keys(WATER_CELLS).includes("1f"));
  assertDemandsSandcastle2WhenOneFIsRequested(descriptor);
  assert.equal(
    rigOf(WATER_CELLS["1f"].rig).dials.galleryId,
    WATER_DEMO_ID,
    "the asserted demo is the one the 1f rig opens",
  );
});

test("E6b: a run without cell 1f does not demand any Sandcastle 2 artifact", () => {
  assertDemandsNoSandcastle2WithoutOneF(descriptor);
});

test("E6c (MUTANT): a descriptor that always demands the Sandcastle 2 files, or never does, is caught", async () => {
  const waterPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "probe-water-cells.mjs",
  );
  const anchor = 'return names.includes("1f")';
  const always = await importMutated(waterPath, [
    [anchor, 'return (true || names.includes("1f"))'],
  ]);
  assert.throws(() => assertDemandsNoSandcastle2WithoutOneF(always.descriptor));
  const never = await importMutated(waterPath, [
    [anchor, 'return (false && names.includes("1f"))'],
  ]);
  assert.throws(() =>
    assertDemandsSandcastle2WhenOneFIsRequested(never.descriptor),
  );
});

// ---------------------------------------------------------------------------
// E (round 2): the gate behind a refused 1f page (A2-3) and the wave epoch
// end to end (A2-1), through descriptor.cells on the stub browser
// ---------------------------------------------------------------------------

test("E7 (A2-3): a 1f page whose settle stopped short on a lost device FAILS 2e on the gate the piece read before refusing", async () => {
  const { records, verdicts } = await runE({
    outName: "e7-lost-mid-settle",
    cells: "1f",
    demo: {
      deviceLost: "[webgpu] device lost: reason=unknown E7-STUB",
      settle: {
        outcome: "deadline",
        frames: 40,
        settledFrames: 12,
        frameNumber: 940,
        tilesLoaded: false,
      },
    },
  });
  const [rec] = records;
  assert.ok(rec.notRun.startsWith("demo-not-settled: "), rec.notRun);
  assert.equal(
    rec.refusal.details.gate.deviceLost,
    "[webgpu] device lost: reason=unknown E7-STUB",
  );
  const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
  assert.equal(fault.pass, false);
  assert.equal(fault.notRun, undefined, "the loss is measured, not NOT RUN");
  assert.equal(
    fault.gate.deviceLost,
    "[webgpu] device lost: reason=unknown E7-STUB",
  );
});

test("E7 (A2-3): a 1f clock the piece could not pin carries the gate it read, and 2e is judged on it", async () => {
  const { records, verdicts } = await runE({
    outName: "e7-clock",
    cells: "1f",
    demo: {
      clockAnswer: { applied: false, reason: "stub: no clock" },
      gateErrors: ["[webgpu] uncaptured GPU error: E7-CLOCK"],
    },
  });
  const [rec] = records;
  assert.ok(rec.notRun.startsWith("demo-clock-not-pinned: "), rec.notRun);
  assert.deepEqual(rec.refusal.details.gate.errors, [
    "[webgpu] uncaptured GPU error: E7-CLOCK",
  ]);
  const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
  assert.equal(fault.pass, false);
  assert.equal(fault.notRun, undefined);
  assert.deepEqual(fault.gate.errors, [
    "[webgpu] uncaptured GPU error: E7-CLOCK",
  ]);
});

test("E7 (A2-3): a 1f page NOT RUN for ion reports 2e as 'gate not read', never 'error gate not armed'", async () => {
  const log = { urls: [], contexts: 0, opened: [] };
  const records = await descriptor.cells({
    browser: makeFakeBrowser(log),
    run: 0,
    options: { arm: "before", cells: "1f", renderers: ["webgpu"], noIon: true },
    origin: "http://localhost:8080",
    outputDirectory: path.join(TEMP_ROOT, "e7-ion"),
    captures: [],
  });
  const verdicts = waterVerdicts(
    records,
    summarizeWaterRecords(records),
    null,
    {
      arm: "before",
    },
  );
  const fault = pageVerdict(verdicts, records[0], "2e-no-device-fault");
  assert.equal(fault.notRun, true);
  assert.equal(fault.reason, "gate not read (page NOT_RUN: ion)");
});

test("E8 (A2-1): on this tree's stage the epoch blocks no page, reads back applied false, and 2g is NOT RUN per renderer while the other bands still run", async () => {
  const log = { urls: [], contexts: 0, opened: [] };
  const records = [];
  for (const run of [0, 1]) {
    records.push(
      ...(await descriptor.cells({
        browser: makeFakeBrowser(log),
        run,
        options: {
          arm: "after",
          cells: "coast-50km",
          renderers: ["webgl", "webgpu"],
        },
        origin: "http://localhost:8080",
        outputDirectory: path.join(TEMP_ROOT, `e8-run${run}`),
        captures: [],
      })),
    );
  }
  assert.equal(records.length, 8);
  for (const rec of records) {
    assert.equal(rec.notRun, null, `${rec.variant} ${rec.renderer}`);
    assert.ok(rec.capture);
    // The stub stage answers no epoch readback; the stage at this tree has no
    // handler for the dial at all. Either way the page reads applied false.
    assert.equal(rec.waveEpoch.requested, CLOCK);
    assert.equal(rec.waveEpoch.applied, false);
    assert.ok(
      /no waterSimulationEpoch (handler|readback)/.test(rec.waveEpoch.reason),
      rec.waveEpoch.reason,
    );
  }
  const verdicts = waterVerdicts(
    records,
    summarizeWaterRecords(records),
    null,
    {
      arm: "after",
    },
  );
  for (const renderer of ["webgl", "webgpu"]) {
    const g = verdicts.find(
      (v) => v.id === `coast-50km:2g-wave-epoch-repeat:${renderer}`,
    );
    assert.ok(g, `2g on ${renderer}`);
    assert.equal(g.pass, false);
    assert.equal(g.notRun, true);
    assert.ok(g.reason.startsWith("waterSimulationEpoch applied: false"));
    assert.equal(g.rig, "water-coast-50km");
    assert.equal(g.repeatPct, 0, "the repeat is still measured and recorded");
  }
  assert.ok(verdicts.some((v) => v.id === "coast-50km:2b-effect-agreement"));
});
