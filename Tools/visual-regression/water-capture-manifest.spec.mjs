// water-capture-manifest.spec.mjs - the capture manifests the water probes write, in Node on a stub browser.
// @purpose Drives probe-water-cells, probe-fft-ocean and probe-ssr-water through descriptor.cells on a stub browser (real PNGs in a lane temp directory, the real rigs, and for cell 1f the real demo-capture piece on a stub run frame) and descriptor.receipt, then asserts the capture-manifest.json each writes beside its report: both validators accept it, the entries are the pages the run took on the rigs they ran (the FFT ocean's temporal capture its own entry), water-cells reads BEFORE from --base-report and says "no --base-report" without one and keeps the run when the base cannot be read, a NOT RUN page and a capture without a sha256 are UNMEASURED cells, a manifest the validators refuse is returned as violations and never thrown, and contact-sheet.mjs --manifest sheets the written file; with an inertness mutant per probe (the manifest not written) and one for the sha256 guard.
// @status ACTIVE
//
// Row DX-KIT-WATER-CELLS-CAPTURE-MANIFEST. The builder and its two validators
// are `lib/landing-capture-manifest.mjs`'s and have their own spec; this spec
// pins what the three water probes feed it and that each probe's receipt calls
// the writer.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { runContactSheet } from "./contact-sheet.mjs";
import { validateManifest } from "./lib/capture.mjs";
import { validateManifest as validateSheetManifest } from "./lib/contact-sheet-page.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  LANDING_MANIFEST_FILE,
  runtimeReportFileName,
} from "./lib/landing-capture-manifest.mjs";
import { stageLandingCellInPage } from "./lib/landing-cell-stage.mjs";
import { loadRigs, replayKeyFor } from "./lib/rig-registry.mjs";
import { readRendererStateInPage } from "./lib/sandcastle2-renderer-gate.mjs";
import * as piece from "./lib/water-capture-manifest.mjs";
import * as fftOcean from "./probe-fft-ocean.mjs";
import * as ssrWater from "./probe-ssr-water.mjs";
import * as waterCells from "./probe-water-cells.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WATER_CELLS_FILE = path.join(here, "probe-water-cells.mjs");
const FFT_OCEAN_FILE = path.join(here, "probe-fft-ocean.mjs");
const SSR_WATER_FILE = path.join(here, "probe-ssr-water.mjs");
const PIECE_FILE = path.join(here, "lib/water-capture-manifest.mjs");

const GENERATED_AT = "2026-10-31T07:00:00.000Z";
const ORIGIN = "http://localhost:8080";
const BOTH = ["webgl", "webgpu"];
const DEMO_RIG = "sandcastle2-globe-materials-water-mask";

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));

// ---------------------------------------------------------------------------
// The stub browser
// ---------------------------------------------------------------------------

/** Every screenshot is its own picture (8 x 8 unless asked), so no two captures are equal. */
let pngSerial = 0;
function nextPng([width, height] = [8, 8]) {
  pngSerial += 1;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels.set(
      [(pngSerial * 37) % 256, (pngSerial * 91) % 256, 128, 255],
      i * 4,
    );
  }
  return Buffer.from(encodeRgbaPng(pixels, width, height));
}

const stubLocatorOf = (size) => () => ({
  async count() {
    return 1;
  },
  nth: () => ({
    async screenshot() {
      return nextPng(size);
    },
  }),
  async screenshot() {
    return nextPng(size);
  },
});
const stubLocator = stubLocatorOf();

/**
 * A stub browser that answers what the three probes' pages ask. `leftovers`
 * (rig id -> selectors the chrome strip left) is a hook; `size` is the
 * screenshot's [width, height] (the FFT probe crops 980 x 600 out of it).
 */
function makeBrowser({ leftovers = () => [], size } = {}) {
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
          return { removed: 0, leftovers: leftovers(state.rigId) };
        }
        switch (fn.name) {
          case "pageSettleWaterScene":
            return {
              tilesSettled: true,
              tileFrames: 40,
              frames: arg.frames,
              tilesLoaded: true,
              datasetPending: false,
              elapsedMs: 5,
            };
          case "pageSettleUntilTilesLoaded":
            return {
              frames: arg.minFrames + arg.tailFrames,
              tilesLoaded: true,
              primitivesCount: 2,
            };
          case "pageRenderFrames":
            return arg.frames;
          case "pagePolygonScene":
            return { added: arg.polygons.map((polygon) => polygon.id) };
          case "pageSetClock":
            return { ok: true, observed: arg.iso };
          case "pageReadSunState":
            return {};
          default:
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
          return { errors: [], deviceLost: null, armedDevices: state.armed };
        }
        throw new Error(`unstubbed evaluate: ${src.slice(0, 120)}`);
      },
      locator: stubLocatorOf(size),
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

/** Cell 1f's seam: an opener that hands the real demo-capture piece a stub run frame. */
function makeDemoDependencies() {
  return {
    async open(_page, urlOptions) {
      const state = { armed: 0 };
      const rendererType = urlOptions.renderer;
      const frame = {
        async waitForFunction() {},
        async evaluate(fn, arg) {
          if (fn === readRendererStateInPage) {
            return {
              contexts: [{ id: "ctx-stub", rendererType }],
              frameNumbers: [900],
              note: "",
            };
          }
          if (typeof fn === "string") {
            return undefined;
          }
          if (arg && arg.timeoutMs !== undefined) {
            return {
              tokenPresent: true,
              terrainResolved: true,
              terrainProvider: "CesiumTerrainProvider",
              hasWaterMask: true,
              waitedMs: 5,
            };
          }
          if (arg && arg.iso !== undefined) {
            return { applied: true, observed: arg.iso };
          }
          if (arg && arg.frames !== undefined) {
            return {
              outcome: "done",
              frames: arg.frames,
              settledFrames: arg.frames,
              frameNumber: 900,
              tilesLoaded: true,
            };
          }
          const src = String(fn);
          if (src.includes("__captureLiveness")) {
            return { gateArmed: true, deviceLost: null, frameNumber: 901 };
          }
          if (src.includes("__armWebGPUDevice")) {
            const armed = rendererType === "webgpu" ? 1 : 0;
            state.armed += armed;
            return { found: armed, armed, gateInstalled: true };
          }
          if (src.includes("__webgpuGate")) {
            return { errors: [], deviceLost: null, armedDevices: state.armed };
          }
          throw new Error(`unstubbed frame evaluate: ${src.slice(0, 120)}`);
        },
        locator: stubLocator,
      };
      return {
        url: "http://localhost:8080/stub",
        finalUrl: "http://localhost:8080/stub",
        bucketFrame: frame,
        bucketFinalUrl: "http://localhost:8081/stub",
        assertNoOriginBreach() {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Driving a probe the way the runtime does
// ---------------------------------------------------------------------------

/**
 * `descriptor.cells` on the stub browser, then `descriptor.receipt` with the
 * context the runtime hands it; the report is written beside the manifest as
 * the runtime would (it is the BEFORE arm's input and the manifest's receipt).
 */
async function driveProbe(
  probe,
  root,
  name,
  { options = {}, browser = makeBrowser(), beforeReceipt } = {},
) {
  const outputDirectory = path.join(root, name);
  const probeDescriptor = probe.descriptor;
  const records = await probeDescriptor.cells({
    browser,
    run: 0,
    options,
    origin: ORIGIN,
    outputDirectory,
    captures: [],
    demoCaptureDependencies: makeDemoDependencies(),
  });
  beforeReceipt?.();
  const receipt = probeDescriptor.receipt(records, {
    options,
    origin: ORIGIN,
    outputDirectory,
    generatedAt: GENERATED_AT,
  });
  const reportFile = path.join(
    outputDirectory,
    runtimeReportFileName(probeDescriptor.name),
  );
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ origin: ORIGIN, generatedAt: GENERATED_AT, ...receipt }, null, 2)}\n`,
  );
  const manifestPath = path.join(outputDirectory, LANDING_MANIFEST_FILE);
  return {
    records,
    receipt,
    outputDirectory,
    reportFile,
    manifestPath,
    manifest: fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      : null,
  };
}

const entryOf = (manifest, entryId) => {
  const entry = manifest.rigs.find((rig) => rig.id === entryId);
  assert.ok(entry, `the manifest has entry ${entryId}`);
  return entry;
};

const cellOf = (manifest, entryId, renderer, slot) =>
  entryOf(manifest, entryId).cells[renderer][slot];

/** Every cell of one slot, in entry then renderer order. */
const slotCells = (manifest, slot) =>
  manifest.rigs.flatMap((entry) =>
    Object.values(entry.cells).map((byslot) => byslot[slot]),
  );

const allPairs = (manifest) =>
  manifest.rigs.flatMap((entry) => Object.values(entry.pairs));

/** Both validators accept the manifest (an empty violation list from each). */
function assertValid(manifest) {
  assert.deepEqual(validateManifest(manifest), []);
  assert.deepEqual(validateSheetManifest(manifest), []);
}

// ---------------------------------------------------------------------------
// water-cells
// ---------------------------------------------------------------------------

const WATER_OPTIONS = {
  cells: "great-lakes,1f",
  renderers: BOTH,
};

test("water-cells: an AFTER run with the BEFORE report writes a manifest both validators accept, with every page an entry on its own rig and BEFORE read from --base-report", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const before = await driveProbe(waterCells, root, "before", {
      options: { ...WATER_OPTIONS, arm: "before" },
    });
    assert.equal(before.receipt.captureManifest.written, true);
    const after = await driveProbe(waterCells, root, "after", {
      options: {
        ...WATER_OPTIONS,
        arm: "after",
        baseReport: before.reportFile,
      },
    });
    const { manifest, receipt } = after;
    assert.equal(receipt.captureManifest.written, true);
    assert.deepEqual(receipt.captureManifest.violations, []);
    assertValid(manifest);
    assert.deepEqual(
      manifest.rigs.map((rig) => rig.id),
      ["great-lakes:on", "great-lakes:off", "1f:demo"],
    );
    assert.deepEqual(manifest.renderers, BOTH);
    assert.equal(manifest.origins.AFTER, ORIGIN);
    assert.equal(manifest.origins.BEFORE, ORIGIN);
    assert.equal(manifest.receipt, "water-cells-report.json");
    // The sheet names a water entry as a water probe's cell, never a landing cell.
    for (const entry of manifest.rigs) {
      assert.ok(
        entry.description.startsWith(`${piece.WATER_ENTRY_LABEL} `),
        entry.description,
      );
      assert.doesNotMatch(entry.description, /Landing cell/);
    }
    // The entry's replay key is the registered rig's own.
    const keyOf = (id) => manifest.rigs.find((rig) => rig.id === id).replayKey;
    assert.equal(
      keyOf("great-lakes:on"),
      replayKeyFor(rigsById.get("water-great-lakes")),
    );
    assert.equal(
      keyOf("great-lakes:off"),
      replayKeyFor(rigsById.get("water-great-lakes-off")),
    );
    assert.equal(keyOf("1f:demo"), replayKeyFor(rigsById.get(DEMO_RIG)));
    assert.deepEqual(
      manifest.rigs.find((rig) => rig.id === "1f:demo").viewport,
      { width: 1280, height: 720 },
    );
    // Every slot of every entry on both renderers is measured and the pairs too.
    for (const slot of ["BEFORE", "AFTER"]) {
      const cells = slotCells(manifest, slot);
      assert.equal(cells.length, 3 * 2);
      for (const cell of cells) {
        assert.equal(cell.state, "MEASURED", slot);
        assert.match(cell.sha256, /^[0-9a-f]{64}$/);
      }
    }
    assert.equal(allPairs(manifest).length, 3 * 2);
    for (const pair of allPairs(manifest)) {
      assert.equal(pair.state, "MEASURED");
    }
    // The AFTER image is the capture the probe took, in place; BEFORE is a copy.
    const onWebgl = cellOf(manifest, "great-lakes:on", "webgl", "AFTER");
    assert.equal(
      onWebgl.image,
      after.records
        .find(
          (record) =>
            record.cell === "great-lakes" &&
            record.variant === "on" &&
            record.renderer === "webgl",
        )
        .capture.path.split("\\")
        .join("/")
        .slice(after.outputDirectory.split("\\").join("/").length + 1),
    );
    assert.ok(
      fs.existsSync(
        path.join(
          after.outputDirectory,
          cellOf(manifest, "great-lakes:on", "webgl", "BEFORE").image,
        ),
      ),
    );
    // The page's real url and instant ride along; cell 1f's is the run frame's.
    assert.match(onWebgl.url, /^http:\/\/localhost:8080\//);
    assert.equal(
      cellOf(manifest, "1f:demo", "webgl", "AFTER").url,
      "http://localhost:8080/stub",
    );
    assert.equal(onWebgl.fallbackFields, undefined);
  });
});

test("water-cells: contact-sheet.mjs --manifest sheets the written manifest", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const run = await driveProbe(waterCells, root, "sheeted", {
      options: { ...WATER_OPTIONS, arm: "before" },
    });
    const outDir = path.join(root, "sheets").split(path.sep).join("/");
    const result = await runContactSheet([
      "--manifest",
      run.manifestPath,
      "--sheet-id",
      "water-run",
      "--out-dir",
      outDir,
      "--generated-at",
      GENERATED_AT,
      "--date",
      "2026-10-31",
    ]);
    assert.equal(result.error, null);
    assert.equal(result.exitCode, 0);
    assert.ok(fs.existsSync(`${outDir}/2026-10-31/water-run/index.html`));
  });
});

test("water-cells: without --base-report every BEFORE cell and pair is UNMEASURED saying so", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const run = await driveProbe(waterCells, root, "nobase", {
      options: { ...WATER_OPTIONS, arm: "after" },
    });
    assertValid(run.manifest);
    for (const cell of slotCells(run.manifest, "BEFORE")) {
      assert.equal(cell.state, "UNMEASURED");
      assert.equal(cell.reason, "no --base-report");
    }
    for (const cell of slotCells(run.manifest, "AFTER")) {
      assert.equal(cell.state, "MEASURED");
    }
    for (const pair of allPairs(run.manifest)) {
      assert.equal(pair.state, "UNMEASURED");
    }
  });
});

test("water-cells: a base report that cannot be read at the receipt costs the manifest its BEFORE and never the run", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const before = await driveProbe(waterCells, root, "before", {
      options: { ...WATER_OPTIONS, arm: "before" },
    });
    const run = await driveProbe(waterCells, root, "after", {
      options: {
        ...WATER_OPTIONS,
        arm: "after",
        baseReport: before.reportFile,
      },
      beforeReceipt: () => fs.rmSync(before.reportFile),
    });
    assert.equal(run.receipt.captureManifest.written, true);
    assert.match(
      run.receipt.captureManifest.baseReportError,
      /base-report|ENOENT|no such file/i,
    );
    assertValid(run.manifest);
    for (const cell of slotCells(run.manifest, "BEFORE")) {
      assert.equal(cell.state, "UNMEASURED");
    }
  });
});

test("water-cells: a BEFORE capture file that changed after its run is an UNMEASURED BEFORE with the digest reason", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const before = await driveProbe(waterCells, root, "before", {
      options: { cells: "great-lakes", renderers: ["webgl"], arm: "before" },
    });
    const changed = before.records.find((record) => record.variant === "on")
      .capture.path;
    fs.writeFileSync(changed, nextPng());
    const run = await driveProbe(waterCells, root, "after", {
      options: {
        cells: "great-lakes",
        renderers: ["webgl"],
        arm: "after",
        baseReport: before.reportFile,
      },
    });
    assertValid(run.manifest);
    const on = cellOf(run.manifest, "great-lakes:on", "webgl", "BEFORE");
    assert.equal(on.state, "UNMEASURED");
    assert.match(on.reason, /changed after the run/);
    assert.equal(
      cellOf(run.manifest, "great-lakes:off", "webgl", "BEFORE").state,
      "MEASURED",
    );
  });
});

test("water-cells: a NOT RUN page is an UNMEASURED AFTER cell carrying the page's own reason", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const run = await driveProbe(waterCells, root, "notrun", {
      options: { cells: "great-lakes", renderers: ["webgl"], arm: "before" },
      browser: makeBrowser({
        leftovers: (rigId) =>
          rigId === "water-great-lakes" ? [".cesium-viewer-toolbar"] : [],
      }),
    });
    assertValid(run.manifest);
    const on = cellOf(run.manifest, "great-lakes:on", "webgl", "AFTER");
    assert.equal(on.state, "UNMEASURED");
    assert.match(on.reason, /^NOT RUN: capture-chrome-over-canvas: /);
    assert.equal(
      cellOf(run.manifest, "great-lakes:off", "webgl", "AFTER").state,
      "MEASURED",
    );
  });
});

// ---------------------------------------------------------------------------
// fft-ocean and ssr-water
// ---------------------------------------------------------------------------

test("fft-ocean: one entry per session capture on the session's last rig, the temporal capture its own entry, BEFORE UNMEASURED", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const run = await driveProbe(fftOcean, root, "fft", {
      browser: makeBrowser({ size: [1000, 640] }),
    });
    assert.equal(run.receipt.captureManifest.written, true);
    assert.deepEqual(run.receipt.captureManifest.violations, []);
    assertValid(run.manifest);
    assert.deepEqual(
      run.manifest.rigs.map((rig) => rig.id),
      [
        "fft-ocean:off1",
        "fft-ocean:off1b",
        "fft-ocean:off2",
        "fft-ocean:iso-off",
        "fft-ocean:iso-on",
        "fft-ocean:iso-on-t2",
        "fft-ocean:ctx-on",
      ],
    );
    assert.deepEqual(run.manifest.renderers, ["webgpu"]);
    assert.equal(run.manifest.receipt, "fft-ocean-report.json");
    const keyOf = (id) =>
      run.manifest.rigs.find((rig) => rig.id === id).replayKey;
    // The enabled-then-disabled session ends on the OFF rig.
    assert.equal(
      keyOf("fft-ocean:off2"),
      replayKeyFor(rigsById.get("fft-ocean-nadir-off")),
    );
    assert.equal(
      keyOf("fft-ocean:iso-on-t2"),
      replayKeyFor(rigsById.get("fft-ocean-nadir-isolated-on")),
    );
    for (const cell of slotCells(run.manifest, "AFTER")) {
      assert.equal(cell.state, "MEASURED");
    }
    for (const cell of slotCells(run.manifest, "BEFORE")) {
      assert.equal(cell.state, "UNMEASURED");
      assert.equal(cell.reason, "no --base-report");
    }
    // The two captures of the temporal session are two files.
    assert.notEqual(
      cellOf(run.manifest, "fft-ocean:iso-on", "webgpu", "AFTER").sha256,
      cellOf(run.manifest, "fft-ocean:iso-on-t2", "webgpu", "AFTER").sha256,
    );
    const outDir = path.join(root, "sheets").split(path.sep).join("/");
    const sheet = await runContactSheet([
      "--manifest",
      run.manifestPath,
      "--sheet-id",
      "fft-run",
      "--out-dir",
      outDir,
      "--generated-at",
      GENERATED_AT,
      "--date",
      "2026-10-31",
    ]);
    assert.equal(sheet.exitCode, 0);
  });
});

test("ssr-water: one entry per matrix cell on its own rig, BEFORE UNMEASURED", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const run = await driveProbe(ssrWater, root, "ssr");
    assert.equal(run.receipt.captureManifest.written, true);
    assert.deepEqual(run.receipt.captureManifest.violations, []);
    assertValid(run.manifest);
    assert.deepEqual(
      run.manifest.rigs.map((rig) => rig.id),
      ssrWater.SSR_WATER_CELLS.map(({ label }) => `ssr-water:${label}`),
    );
    for (const { label, rig } of ssrWater.SSR_WATER_CELLS) {
      assert.equal(
        run.manifest.rigs.find((entry) => entry.id === `ssr-water:${label}`)
          .replayKey,
        replayKeyFor(rigsById.get(rig)),
      );
    }
    assert.deepEqual(run.manifest.renderers, ["webgpu"]);
    assert.equal(run.manifest.receipt, "ssr-water-report.json");
    for (const cell of slotCells(run.manifest, "AFTER")) {
      assert.equal(cell.state, "MEASURED");
    }
    for (const cell of slotCells(run.manifest, "BEFORE")) {
      assert.equal(cell.state, "UNMEASURED");
    }
  });
});

// ---------------------------------------------------------------------------
// The adapter and the writer
// ---------------------------------------------------------------------------

function bankedPng(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, nextPng());
  return file;
}

test("a capture record without a sha256 is never handed over as a measured capture: its page is NOT RUN naming the file", () => {
  const pages = piece.ssrWaterManifestPages([
    {
      run: 0,
      label: "a-ssr-off-def-off",
      rig: "ssr-water-lake-wall-ssr-off-deferred-off",
      capture: { path: "somewhere/a.png", sha256: "" },
    },
    {
      run: 0,
      label: "b-ssr-on-def-off",
      rig: "ssr-water-lake-wall-ssr-on-deferred-off",
      capture: { path: "somewhere/b.png", sha256: "ab".repeat(32) },
    },
  ]);
  assert.equal(pages[0].capture, undefined);
  assert.match(pages[0].notRun, /a\.png carries no sha256/);
  assert.equal(pages[1].notRun, undefined);
  assert.equal(pages[1].capture.sha256, "ab".repeat(32));
  assert.ok(path.isAbsolute(pages[1].capture.path));
});

test("a sha256-less AFTER capture reaches the manifest as an UNMEASURED cell", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const dir = path.join(root, "out");
    const file = bankedPng(dir, "a");
    const result = piece.writeWaterProbeManifest({
      probe: "ssr-water",
      pages: piece.ssrWaterManifestPages([
        {
          run: 0,
          label: "a-ssr-off-def-off",
          rig: "ssr-water-lake-wall-ssr-off-deferred-off",
          capture: { path: file },
        },
      ]),
      rigsById,
      context: {
        origin: ORIGIN,
        outputDirectory: dir,
        generatedAt: GENERATED_AT,
      },
    });
    assert.equal(result.written, true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, LANDING_MANIFEST_FILE), "utf8"),
    );
    assertValid(manifest);
    const cell = cellOf(
      manifest,
      "ssr-water:a-ssr-off-def-off",
      "webgpu",
      "AFTER",
    );
    assert.equal(cell.state, "UNMEASURED");
    assert.match(cell.reason, /carries no sha256/);
  });
});

test("a page whose rig is not registered, or a manifest the validators refuse, is returned as violations and never thrown; a stale manifest is removed", async () => {
  await withLaneTmp("water-manifest-", async (root) => {
    const dir = path.join(root, "out");
    const file = bankedPng(dir, "a");
    const stale = path.join(dir, LANDING_MANIFEST_FILE);
    fs.writeFileSync(stale, "{}");
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let result;
    try {
      result = piece.writeWaterProbeManifest({
        probe: "ssr-water",
        pages: piece.ssrWaterManifestPages([
          {
            run: 0,
            label: "a",
            rig: "no-such-rig",
            capture: { path: file, sha256: "cd".repeat(32) },
          },
        ]),
        rigsById,
        context: {
          origin: ORIGIN,
          outputDirectory: dir,
          generatedAt: GENERATED_AT,
        },
      });
    } finally {
      console.warn = warn;
    }
    assert.equal(result.written, false);
    assert.match(result.violations.join("\n"), /no-such-rig/);
    assert.equal(
      fs.existsSync(stale),
      false,
      "a throw removes the stale manifest too",
    );
    assert.equal(warnings.length, 1);
    fs.writeFileSync(stale, "{}");

    const refused = piece.writeWaterProbeManifest({
      probe: "ssr-water",
      pages: [],
      rigsById,
      context: {
        origin: ORIGIN,
        outputDirectory: dir,
        generatedAt: GENERATED_AT,
        options: {},
      },
    });
    assert.equal(refused.written, false);
    assert.ok(refused.violations.length > 0);
    assert.equal(
      fs.existsSync(stale),
      false,
      "a refused manifest removes the stale one",
    );
  });
});

// ---------------------------------------------------------------------------
// Inertness mutants
// ---------------------------------------------------------------------------

/**
 * The check each probe's mutant must fail: the probe, driven on the stub
 * browser, leaves a manifest and says so in its receipt.
 */
async function assertManifestWritten(probe, driveOptions) {
  await withLaneTmp("water-manifest-mutant-", async (root) => {
    const run = await driveProbe(probe, root, "mutant", driveOptions);
    assert.equal(run.receipt.captureManifest?.written, true);
    assert.ok(run.manifest, "capture-manifest.json is beside the report");
  });
}

for (const [label, file, anchor, probe, driveOptions] of [
  [
    "water-cells",
    WATER_CELLS_FILE,
    "    if (context.outputDirectory) {",
    waterCells,
    { options: { cells: "great-lakes", renderers: ["webgl"], arm: "before" } },
  ],
  [
    "fft-ocean",
    FFT_OCEAN_FILE,
    "    if (context?.outputDirectory) {",
    fftOcean,
    { browser: makeBrowser({ size: [1000, 640] }) },
  ],
  [
    "ssr-water",
    SSR_WATER_FILE,
    "    if (context?.outputDirectory) {",
    ssrWater,
    {},
  ],
]) {
  test(`inertness mutant: ${label}'s manifest write made unreachable leaves no manifest, so the written check goes red`, async () => {
    await assertManifestWritten(probe, driveOptions);
    const mutated = await importMutated(file, [
      [anchor, anchor.replace("(", "(false && ")],
    ]);
    await assert.rejects(
      assertManifestWritten(mutated, driveOptions),
      (error) => error instanceof assert.AssertionError,
    );
  });
}

test("inertness mutant: the sha256 guard made unreachable hands a digest-less capture over as measured, so the NOT RUN check goes red", async () => {
  const check = (mod) => {
    const [page] = mod.ssrWaterManifestPages([
      {
        run: 0,
        label: "a",
        rig: "ssr-water-lake-wall-ssr-off-deferred-off",
        capture: { path: "somewhere/a.png" },
      },
    ]);
    assert.match(page.notRun, /carries no sha256/);
  };
  check(piece);
  const mutated = await importMutated(PIECE_FILE, [
    [
      `typeof capture.sha256 !== "string" || capture.sha256.length === 0`,
      `false && (typeof capture.sha256 !== "string" || capture.sha256.length === 0)`,
    ],
  ]);
  assert.throws(
    () => check(mutated),
    (error) =>
      error instanceof assert.AssertionError || error instanceof TypeError,
  );
});
