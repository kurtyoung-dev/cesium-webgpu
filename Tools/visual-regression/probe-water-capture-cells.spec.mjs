// probe-water-capture-cells.spec.mjs - the opt-in capture cells of probe-water-cells (the water bookmark rigs and the offline Kauai shelf pair), in Node on a stub browser.
// @purpose Row DX-KIT-WATER-BOOKMARK-RIGS-UNCAPTURED: pins that --cells can name the seven water bookmark rigs and the offline Kauai shelf pair (pages, renderers and rig ids planned from each rig's own declaration), that the default cell list, plan, option default and served-build list are exactly what they were, that the stub-browser run captures each page through the shared stage and lists it in the receipt's captureCells without a band or a summary entry, that --no-ion makes the one Sandcastle 2 bookmark NOT RUN with its reason, that the capture manifest built from those records passes both validators with an entry per page, and that the cells vanish from the plan with an inertness mutant on the table lookup.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { validateManifest } from "./lib/capture.mjs";
import { validateManifest as validateSheetManifest } from "./lib/contact-sheet-page.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  LANDING_MANIFEST_FILE,
  runtimeReportFileName,
} from "./lib/landing-capture-manifest.mjs";
import { stageLandingCellInPage } from "./lib/landing-cell-stage.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import {
  WATER_CAPTURE_CELLS,
  WATER_CELLS,
  WATER_DEFAULT_CELLS,
  planWaterCells,
} from "./lib/water-cell-table.mjs";
import { descriptor, servedArtifactsForCells } from "./probe-water-cells.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TABLE_FILE = path.join(here, "lib/water-cell-table.mjs");

const ORIGIN = "http://localhost:8080";
const GENERATED_AT = "2026-10-31T07:00:00.000Z";
const BOTH = ["webgl", "webgpu"];
const DEMO_CELL = "bookmark-global-water-weather";

const DEFAULT_CELLS = [
  "great-lakes",
  "coast-50km",
  "orbit-disc",
  "great-lakes-lakeonly",
  "1f",
];
const CAPTURE_CELLS = [
  "bookmark-bahamas-photic-dive",
  "bookmark-cairo-nile",
  DEMO_CELL,
  "bookmark-ilulissat-ice",
  "bookmark-kauai-reef",
  "bookmark-mariana-trench",
  "bookmark-sunset-glint",
  "bathymetry-offline",
];
const SINGLE_RIG_CELLS = CAPTURE_CELLS.filter(
  (cell) => WATER_CAPTURE_CELLS[cell].kind === "capture-single",
);

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));

/** Every screenshot is its own picture, so no two captures are equal. */
let pngSerial = 0;
function nextPng() {
  pngSerial += 1;
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) {
    pixels.set(
      [(pngSerial * 37) % 256, (pngSerial * 91) % 256, 128, 255],
      i * 4,
    );
  }
  return Buffer.from(encodeRgbaPng(pixels, 8, 8));
}

/** A stub browser answering what a leg-2 style page asks (staged cleanly, settled at once). */
function makeBrowser({ gate = () => null } = {}) {
  const makePage = () => {
    const state = { renderer: null, rigId: null, armed: 0 };
    return {
      on() {},
      off() {},
      async goto(url) {
        state.renderer = new URL(String(url)).searchParams.get("renderer");
      },
      async waitForFunction() {},
      async evaluate(fn, arg) {
        if (fn === stageLandingCellInPage) {
          state.rigId = arg.rigId;
          return { rigId: arg.rigId, dials: {}, notApplied: [] };
        }
        if (typeof fn === "string") {
          return { removed: 0, leftovers: [] };
        }
        if (fn.name === "pageSettleWaterScene") {
          return {
            tilesSettled: true,
            tileFrames: 40,
            frames: arg.frames,
            tilesLoaded: true,
            datasetPending: false,
            elapsedMs: 5,
          };
        }
        const src = String(fn);
        if (src.includes("__captureLiveness")) {
          return { gateArmed: true, deviceLost: null, frameNumber: 7 };
        }
        if (src.includes("__armWebGPUDevice")) {
          const armed = state.renderer === "webgpu" ? 1 : 0;
          state.armed += armed;
          return { armed, found: armed, total: state.armed };
        }
        if (src.includes("__webgpuGate")) {
          const answer = gate(state.rigId) ?? {};
          return {
            errors: answer.errors ?? [],
            deviceLost: answer.deviceLost ?? null,
            armedDevices: state.armed,
          };
        }
        throw new Error(`unstubbed evaluate: ${src.slice(0, 120)}`);
      },
      locator: () => ({
        async count() {
          return 1;
        },
        nth: () => ({
          async screenshot() {
            return nextPng();
          },
        }),
        async screenshot() {
          return nextPng();
        },
      }),
    };
  };
  return {
    async newContext() {
      return {
        async addInitScript() {},
        async newPage() {
          return makePage();
        },
        async close() {},
      };
    },
  };
}

/** `descriptor.cells` then `descriptor.receipt`, the way the runtime drives a probe. */
async function drive(root, name, options, browser = makeBrowser()) {
  const outputDirectory = path.join(root, name);
  const merged = { arm: "before", renderers: BOTH, ...options };
  const records = await descriptor.cells({
    browser,
    run: 0,
    options: merged,
    origin: ORIGIN,
    outputDirectory,
    captures: [],
  });
  const context = {
    options: merged,
    origin: ORIGIN,
    outputDirectory,
    generatedAt: GENERATED_AT,
  };
  const receipt = descriptor.receipt(records, context);
  fs.writeFileSync(
    path.join(outputDirectory, runtimeReportFileName(descriptor.name)),
    `${JSON.stringify({ origin: ORIGIN, generatedAt: GENERATED_AT, ...receipt })}\n`,
  );
  const manifestPath = path.join(outputDirectory, LANDING_MANIFEST_FILE);
  return {
    records,
    receipt,
    context,
    manifest: fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      : null,
  };
}

// ---------------------------------------------------------------------------
// The table and the plan
// ---------------------------------------------------------------------------

test("the capture table names exactly the seven bookmark rigs and the offline pair, on registered rigs, and none is a default cell", () => {
  assert.deepEqual(
    Object.keys(WATER_CAPTURE_CELLS).sort(),
    [...CAPTURE_CELLS].sort(),
  );
  for (const cell of CAPTURE_CELLS) {
    assert.ok(!Object.hasOwn(WATER_CELLS, cell), `${cell} is not banded`);
    const spec = WATER_CAPTURE_CELLS[cell];
    for (const id of [spec.rig, spec.on, spec.off].filter(Boolean)) {
      assert.ok(rigsById.has(id), `${cell}: rig ${id} is registered`);
    }
  }
});

test("the default run is unchanged: the same five cells, the same plan, the same option default, the same served-build list", () => {
  assert.deepEqual(Object.keys(WATER_CELLS), DEFAULT_CELLS);
  assert.deepEqual([...WATER_DEFAULT_CELLS], DEFAULT_CELLS);
  const option = descriptor.args.extraOptions.find((o) => o.key === "cells");
  assert.equal(option.default, DEFAULT_CELLS.join(","));
  const plan = planWaterCells({}, rigsById);
  assert.deepEqual([...new Set(plan.map((p) => p.cell))], DEFAULT_CELLS);
  assert.equal(
    plan.length,
    4 * 4 + 2,
    "four mask pairs on two renderers, and 1f",
  );
  assert.deepEqual(servedArtifactsForCells({}), [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
    "Apps/Sandcastle2/standalone.html",
    "Apps/Sandcastle2/templates/bucket.html",
    "Apps/Sandcastle2/templates/Sandcastle.js",
    "Apps/Sandcastle2/gallery/globe-materials-water-mask-elevation-map/index.html",
    "Apps/Sandcastle2/gallery/globe-materials-water-mask-elevation-map/main.js",
  ]);
});

/** The plan assertions, run on the real table and on the mutant's. */
function assertCapturePlan(planOf) {
  for (const cell of SINGLE_RIG_CELLS) {
    const rig = rigsById.get(WATER_CAPTURE_CELLS[cell].rig);
    assert.deepEqual(
      planOf({ cells: cell }).map((p) => [p.renderer, p.variant, p.rigId]),
      rig.renderers.map((renderer) => [renderer, "capture", rig.id]),
      cell,
    );
  }
  assert.deepEqual(
    planOf({ cells: "bookmark-bahamas-photic-dive" }).map((p) => p.renderer),
    ["webgpu"],
    "the FFT-ocean dive is WebGPU only, as its rig declares",
  );
  assert.deepEqual(
    planOf({ cells: "bathymetry-offline" }).map((p) => [
      p.renderer,
      p.variant,
      p.rigId,
    ]),
    [
      ["webgl", "on", "water-bathymetry-offline"],
      ["webgl", "off", "water-bathymetry-offline-off"],
      ["webgpu", "on", "water-bathymetry-offline"],
      ["webgpu", "off", "water-bathymetry-offline-off"],
    ],
  );
  assert.deepEqual(
    planOf({ cells: DEMO_CELL }).map((p) => [p.renderer, p.variant, p.kind]),
    [
      ["webgl", "demo", "capture-demo"],
      ["webgpu", "demo", "capture-demo"],
    ],
  );
  assert.deepEqual(
    planOf({ cells: "bookmark-sunset-glint", renderers: ["webgpu"] }).map(
      (p) => p.renderer,
    ),
    ["webgpu"],
    "--renderer keeps its meaning",
  );
}

test("--cells plans each capture cell on the renderers its rig declares, the pair as ON before OFF, the ion bookmark as a demo page", () => {
  assertCapturePlan((options) => planWaterCells(options, rigsById));
});

test("--cells still refuses an unknown cell, and a capture cell whose rig is gone", () => {
  assert.throws(
    () => planWaterCells({ cells: "bookmark-nowhere" }, rigsById),
    (error) => error.reason === "cell-unknown",
  );
  assert.throws(
    () => planWaterCells({ cells: "bookmark-cairo-nile" }, new Map()),
    (error) => error.reason === "cell-rig-absent",
  );
});

test("the served-build list adds the Sandcastle 2 shell and the ion bookmark's own gallery only when that cell is requested", () => {
  const maskOnly = servedArtifactsForCells({ cells: "bookmark-cairo-nile" });
  assert.equal(maskOnly.length, 3, "a mask-page capture cell: engine only");
  const demo = servedArtifactsForCells({ cells: DEMO_CELL });
  assert.ok(demo.includes("Apps/Sandcastle2/standalone.html"));
  assert.ok(
    demo.includes(
      "Apps/Sandcastle2/gallery/webgpu-global-water-weather/main.js",
    ),
  );
  const both = servedArtifactsForCells({ cells: `1f,${DEMO_CELL}` });
  assert.equal(
    both.filter((file) => file === "Apps/Sandcastle2/standalone.html").length,
    1,
    "the shell is demanded once",
  );
  assert.ok(
    both.some((file) =>
      file.includes("/globe-materials-water-mask-elevation-map/"),
    ),
  );
});

test("inertness mutant: the capture table made unreachable in the cell lookup refuses every capture cell, so the plan check goes red", async () => {
  assertCapturePlan((options) => planWaterCells(options, rigsById));
  const mutated = await importMutated(TABLE_FILE, [
    ["    ? WATER_CAPTURE_CELLS[cell]", "    ? undefined"],
  ]);
  assert.throws(() =>
    assertCapturePlan((options) => mutated.planWaterCells(options, rigsById)),
  );
});

// ---------------------------------------------------------------------------
// A run on the stub browser
// ---------------------------------------------------------------------------

test("a run of the capture cells captures every mask page through the shared stage, NOT RUNs the ion bookmark under --no-ion, and lists them under captureCells with no summary entry and no band", async () => {
  await withLaneTmp("water-capture-cells-", async (root) => {
    const run = await drive(root, "all", {
      cells: CAPTURE_CELLS.join(","),
      noIon: true,
    });
    const expectedPages = planWaterCells(
      { cells: CAPTURE_CELLS.join(","), renderers: BOTH },
      rigsById,
    );
    assert.equal(run.records.length, expectedPages.length);
    for (const record of run.records) {
      if (record.cell === DEMO_CELL) {
        assert.equal(record.notRun, "NOT_RUN: ion");
        assert.ok(!record.capture);
        continue;
      }
      assert.equal(record.notRun, null, `${record.cell} ${record.renderer}`);
      assert.ok(fs.existsSync(record.capture.path));
      assert.equal(record.stage.rigId, record.rig);
    }

    assert.deepEqual(run.receipt.summary, {}, "no banded cell was run");
    assert.deepEqual(
      Object.keys(run.receipt.captureCells).sort(),
      [...CAPTURE_CELLS].sort(),
    );
    const weather = run.receipt.captureCells[DEMO_CELL];
    assert.equal(weather.captures.length, 0);
    assert.equal(weather.notRun.length, 2);
    assert.match(weather.notRun[0], /ion/);
    const pair = run.receipt.captureCells["bathymetry-offline"];
    assert.equal(pair.captures.length, 4);
    assert.deepEqual(pair.rigs, [
      "water-bathymetry-offline",
      "water-bathymetry-offline-off",
    ]);

    const verdicts = descriptor.verdicts(run.records, run.context);
    const kinds = new Set(
      verdicts.map((v) => v.id.split(":").slice(4).join(":")),
    );
    assert.deepEqual([...kinds].sort(), ["2e-no-device-fault", "stage"]);
    const ionStage = verdicts.find(
      (v) => v.id === `${DEMO_CELL}:demo:webgl:run0:stage`,
    );
    assert.equal(ionStage.notRun, true, "the ion page is NOT RUN");
    assert.ok(ionStage.reason);
  });
});

test("the capture manifest of a capture-cell run passes both validators, with an entry per page on the rig it ran", async () => {
  await withLaneTmp("water-capture-cells-manifest-", async (root) => {
    const run = await drive(root, "manifest", {
      cells: `bookmark-sunset-glint,bathymetry-offline,${DEMO_CELL}`,
      noIon: true,
    });
    assert.equal(
      run.receipt.captureManifest.written,
      true,
      run.receipt.captureManifest.violations?.join("; "),
    );
    assert.deepEqual(validateManifest(run.manifest), []);
    assert.deepEqual(validateSheetManifest(run.manifest), []);
    const ids = run.manifest.rigs.map((entry) => entry.id);
    assert.deepEqual(ids.sort(), [
      "bathymetry-offline:off",
      "bathymetry-offline:on",
      `${DEMO_CELL}:demo`,
      "bookmark-sunset-glint:capture",
    ]);
    const sunset = run.manifest.rigs.find(
      (e) => e.id === "bookmark-sunset-glint:capture",
    );
    assert.equal(sunset.cells.webgl.AFTER.state, "MEASURED");
    assert.equal(sunset.cells.webgpu.AFTER.state, "MEASURED");
    const demo = run.manifest.rigs.find((e) => e.id === `${DEMO_CELL}:demo`);
    assert.equal(demo.cells.webgl.AFTER.state, "UNMEASURED");
  });
});

test("a run of banded cells alone carries no captureCells, and a device fault on a capture page still FAILS 2e while no band reads it", async () => {
  await withLaneTmp("water-capture-cells-gate-", async (root) => {
    const plain = await drive(root, "plain", {
      cells: "coast-50km",
      renderers: ["webgl"],
    });
    assert.ok(!Object.hasOwn(plain.receipt, "captureCells"));
    assert.deepEqual(Object.keys(plain.receipt.summary), ["coast-50km"]);

    const mixed = await drive(
      root,
      "mixed",
      {
        cells: "coast-50km,bookmark-cairo-nile",
        renderers: ["webgpu"],
        arm: "after",
      },
      makeBrowser({
        gate: (rigId) =>
          rigId === "water-bookmark-cairo-nile"
            ? { deviceLost: "[webgpu] device lost: reason=unknown STUB" }
            : null,
      }),
    );
    assert.deepEqual(Object.keys(mixed.receipt.summary), ["coast-50km"]);
    const verdicts = descriptor.verdicts(mixed.records, mixed.context);
    const fault = verdicts.find(
      (v) =>
        v.id === "bookmark-cairo-nile:capture:webgpu:run0:2e-no-device-fault",
    );
    assert.equal(fault.pass, false);
    assert.ok(
      verdicts.every(
        (v) =>
          !v.id.startsWith("bookmark-cairo-nile:") ||
          /:(stage|2e-no-device-fault)$/.test(v.id),
      ),
      "no band reads a capture cell",
    );
  });
});
