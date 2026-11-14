// landing-zero-coverage-cells.spec.mjs - the zero-coverage cloud cells and the comparison of each page with its clouds-off control page.
// @purpose Node spec for the landing cells E-ZC-underside, E-ZC-density and E-ZC-skycube and lib/metrics/landing-variant-control.mjs: each cell rides its rig and stages one page per variant with exactly the variant's dial over the rig's (the real payload builder carries the coverage unchanged, including 0, 1e-30 and -0.5), is off by default, and declares its control page; the pixel comparison reads each page against the control page of the same run and the control's own run-to-run band (equal, within the band, no band on one run, NOT MEASURED naming the page for a page with no capture); the sky-cube comparison reads per-face sha256 through compareSkyCubeRecords and names the faces that differ; the verdicts say only that the comparison was made; the real probe on the fake browser writes the receipt's variantControl and the :measured verdicts and writes each variant page's cube faces under its own file names, leaving E-SKY-cube's names as they were; with inertness mutants for the control lookup, the band, the measured guard, the verdict, the cube branch, the probe's face names and the table's variants.
// @status ACTIVE
//
// The fake page never answers the quantity under test: every frame and every
// cube face a case compares is one the case wrote to a file or handed to the
// fake browser.

import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  landingRunners,
  writePng,
} from "./fixtures/probe-landing-cells-support.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { makeSmallPng } from "./lib/landing-fake-browser.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  planLandingCells,
  rigForPage,
} from "./lib/landing-cell-table.mjs";
import * as control from "./lib/metrics/landing-variant-control.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import { skyCubeRecord } from "./lib/sky-cubemap-steps.mjs";
import * as probe from "./probe-landing-cells.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTROL_FILE = path.join(here, "lib/metrics/landing-variant-control.mjs");
const PROBE_FILE = path.join(here, "probe-landing-cells.mjs");
const TABLE_FILE = path.join(here, "lib/landing-cell-table.mjs");

let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("zero-coverage-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));
const get = (id) => rigById(rigs, id);

/** The plan of one cell on the WebGPU renderer: its pages in order. */
const pagesOf = (cell) =>
  planLandingCells({ cells: cell, renderers: ["webgpu"] }, rigsById).map(
    (entry) => entry.page,
  );

/** The rig a planned page stages and the real payload built from it. */
function stagedPage(cell, page) {
  const entry = planLandingCells(
    { cells: cell, renderers: ["webgpu"] },
    rigsById,
  ).find((planned) => planned.page === page);
  const rig = rigForPage(rigsById.get(entry.rigId), entry);
  return { rig, payload: landingStagePayload(rig) };
}

/** Every key of a rig but its dials, deep-compared. */
function assertRigUntouched(staged, original) {
  const { dials: stagedDials, ...stagedRest } = staged;
  const { dials: _originalDials, ...originalRest } = original;
  assert.deepEqual(stagedRest, originalRest);
  return stagedDials;
}

// ---------------------------------------------------------------------------
// Pieces 1 and 2: the cells and their staged pages
// ---------------------------------------------------------------------------

test("E-ZC-underside rides the E-G rig and plans one WebGPU page per variant, control first, off by default", () => {
  const cell = LANDING_CELLS["E-ZC-underside"];
  assert.equal(cell.rig, "cloud-underside-noon-cov055");
  assert.equal(cell.kind, "capture");
  assert.equal(cell.waitPipelines, true);
  assert.equal(cell.controlPage, "clouds-off");
  assert.ok(!DEFAULT_CELLS.includes("E-ZC-underside"));
  assert.deepEqual(pagesOf("E-ZC-underside"), [
    "clouds-off",
    "cov-0",
    "cov-1e-30",
    "cov-neg-0.5",
  ]);
  const rig = get("cloud-underside-noon-cov055");
  const wanted = {
    "clouds-off": { cloudsEnabled: false },
    "cov-0": { cloudCoverage: 0 },
    "cov-1e-30": { cloudCoverage: 1e-30 },
    "cov-neg-0.5": { cloudCoverage: -0.5 },
  };
  for (const [page, dial] of Object.entries(wanted)) {
    const { rig: staged, payload } = stagedPage("E-ZC-underside", page);
    const dials = assertRigUntouched(staged, rig);
    assert.deepEqual(
      dials,
      { ...rig.dials, ...dial },
      `${page}: only its dial`,
    );
    if (page === "clouds-off") {
      assert.equal(payload.cloudsEnabled, false);
      assert.equal(payload.volumetric.cloudCoverage, rig.dials.cloudCoverage);
    } else {
      assert.ok(
        Object.is(payload.volumetric.cloudCoverage, dial.cloudCoverage),
        `${page}: the coverage reaches the payload unchanged`,
      );
      assert.equal(payload.cloudsEnabled, true);
    }
  }
});

test("E-ZC-density rides the density-cache rig, clouds-off then cov-0, and keeps the experimental block on both pages, and turns the density moments on on both pages", () => {
  const cell = LANDING_CELLS["E-ZC-density"];
  assert.equal(cell.rig, "cloud-eon-density");
  assert.equal(cell.controlPage, "clouds-off");
  assert.ok(!DEFAULT_CELLS.includes("E-ZC-density"));
  assert.deepEqual(pagesOf("E-ZC-density"), ["clouds-off", "cov-0"]);
  const rig = get("cloud-eon-density");
  assert.ok(rig.experimental, "the rig carries the experimental block");
  for (const page of ["clouds-off", "cov-0"]) {
    const { rig: staged, payload } = stagedPage("E-ZC-density", page);
    const withMoments = {
      ...rig.experimental,
      cloudDistantDensityMoments: true,
    };
    assert.deepEqual(staged.experimental, withMoments, page);
    assert.deepEqual(payload.experimental, withMoments, page);
  }
  const { payload } = stagedPage("E-ZC-density", "cov-0");
  assert.ok(Object.is(payload.volumetric.cloudCoverage, 0));
  assert.equal(
    stagedPage("E-ZC-density", "clouds-off").payload.cloudsEnabled,
    false,
  );
});

test("E-ZC-skycube is a sky-cube cell on the cube rig: clouds-off, then cov-0 and cov-1e-30 with the clouds on and lighting the cube", () => {
  const cell = LANDING_CELLS["E-ZC-skycube"];
  assert.equal(cell.rig, "sky-cubemap-model");
  assert.equal(cell.kind, "sky-cube");
  assert.equal(cell.controlPage, "clouds-off");
  assert.ok(!DEFAULT_CELLS.includes("E-ZC-skycube"));
  assert.deepEqual(pagesOf("E-ZC-skycube"), [
    "clouds-off",
    "cov-0",
    "cov-1e-30",
  ]);
  const rig = get("sky-cubemap-model");
  for (const page of ["clouds-off", "cov-0", "cov-1e-30"]) {
    const { rig: staged, payload } = stagedPage("E-ZC-skycube", page);
    assert.deepEqual(staged.dials.skyCubeModel, rig.dials.skyCubeModel, page);
    assert.ok(payload.stepDials.includes("skyCubeModel"), page);
    if (page === "clouds-off") {
      assert.equal(payload.cloudsEnabled, false);
      continue;
    }
    assert.equal(payload.cloudsEnabled, true, page);
    assert.equal(payload.volumetric.cloudContributesIBL, true, page);
    assert.ok(
      Object.is(payload.volumetric.cloudCoverage, page === "cov-0" ? 0 : 1e-30),
      `${page}: the coverage`,
    );
  }
});

// ---------------------------------------------------------------------------
// The pixel comparison
// ---------------------------------------------------------------------------

let frameCount = 0;
/** A page record whose capture is a PNG with `changed` white pixels. */
function framePage({
  run,
  page,
  changed,
  cell = "E-ZC-underside",
  renderer = "webgpu",
}) {
  const file = path.join(tempRoot, `frame-${frameCount++}.png`);
  writePng(file, changed);
  return {
    cell,
    renderer,
    run,
    page,
    kind: "capture",
    notRun: null,
    capture: { name: `${cell}-${page}-run${run}`, path: file },
  };
}

const entryOf = (entries, page, run) =>
  entries.find((entry) => entry.page === page && entry.run === run);

/** The pixel comparison reads each page against its control and the control's band. */
function assertPixelComparisons(mod) {
  // Two runs: the control repeats exactly, so its band is 0 changed pixels.
  const exact = mod.variantControlComparisons([
    framePage({ run: 0, page: "clouds-off", changed: 0 }),
    framePage({ run: 1, page: "clouds-off", changed: 0 }),
    framePage({ run: 0, page: "cov-0", changed: 0 }),
    framePage({ run: 1, page: "cov-0", changed: 0 }),
    framePage({ run: 0, page: "cov-1e-30", changed: 1 }),
    framePage({ run: 1, page: "cov-1e-30", changed: 1 }),
  ]);
  assert.equal(
    exact.length,
    4,
    "two pages by two runs; the control is not compared with itself",
  );
  const same = entryOf(exact, "cov-0", 0);
  assert.equal(same.control, "clouds-off");
  assert.equal(same.kind, "pixels");
  assert.equal(same.measured, true);
  assert.equal(same.changedPx, 0);
  assert.equal(same.equalToControl, true);
  assert.deepEqual(same.band, { runs: [0, 1], changedPx: 0 });
  assert.equal(same.withinBand, true);
  const off = entryOf(exact, "cov-1e-30", 1);
  assert.equal(off.changedPx, 1);
  assert.equal(off.equalToControl, false, "one pixel differs from the control");
  assert.equal(off.withinBand, false, "one pixel is outside a band of none");

  // A control that moves 2 px from run to run has a band of 2.
  const noisy = mod.variantControlComparisons([
    framePage({ run: 0, page: "clouds-off", changed: 0 }),
    framePage({ run: 1, page: "clouds-off", changed: 2 }),
    framePage({ run: 0, page: "cov-neg-0.5", changed: 0 }),
    framePage({ run: 1, page: "cov-neg-0.5", changed: 0 }),
  ]);
  const inBand = entryOf(noisy, "cov-neg-0.5", 1);
  assert.equal(inBand.changedPx, 2);
  assert.equal(inBand.equalToControl, false);
  assert.deepEqual(inBand.band, { runs: [0, 1], changedPx: 2 });
  assert.equal(inBand.withinBand, true);

  // One run: no band, and the figure is still reported.
  const once = mod.variantControlComparisons([
    framePage({ run: 0, page: "clouds-off", changed: 0 }),
    framePage({ run: 0, page: "cov-1e-30", changed: 1 }),
  ]);
  assert.equal(once.length, 1);
  assert.equal(once[0].band, null);
  assert.equal(once[0].withinBand, null);
  assert.equal(once[0].changedPx, 1);
  assert.equal(once[0].measured, true);

  // A page that did not render is NOT MEASURED, naming the page and why.
  const missing = mod.variantControlComparisons([
    framePage({ run: 0, page: "clouds-off", changed: 0 }),
    {
      cell: "E-ZC-underside",
      renderer: "webgpu",
      run: 0,
      page: "cov-0",
      kind: "capture",
      notRun: "the stage did not apply cloudCoverage",
      capture: undefined,
    },
  ]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].measured, false);
  assert.match(missing[0].reason, /page cov-0/);
  assert.match(missing[0].reason, /the stage did not apply cloudCoverage/);
  assert.equal(missing[0].changedPx, undefined, "no figure is invented");
  assert.equal(missing[0].equalToControl, null);

  // A page that ran but left no capture is NOT MEASURED too, saying so.
  const bare = mod.variantControlComparisons([
    framePage({ run: 0, page: "clouds-off", changed: 0 }),
    {
      cell: "E-ZC-underside",
      renderer: "webgpu",
      run: 0,
      page: "cov-1e-30",
      kind: "capture",
      notRun: null,
    },
  ]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].measured, false);
  assert.match(bare[0].reason, /page cov-1e-30 has no capture/);

  // A page of a cell without a control page is not compared.
  assert.deepEqual(
    mod.variantControlComparisons([
      framePage({ run: 0, page: "scene", changed: 0, cell: "E-G" }),
    ]),
    [],
  );
}

test("pixels: each page is read against the control page of its run and the control's own run-to-run band", () => {
  assertPixelComparisons(control);
});

/** The verdicts say that the comparison was made, never that the figure passes. */
function assertVerdicts(mod) {
  const entries = mod.variantControlComparisons([
    framePage({ run: 0, page: "clouds-off", changed: 0 }),
    framePage({ run: 0, page: "cov-1e-30", changed: 1 }),
    {
      cell: "E-ZC-underside",
      renderer: "webgpu",
      run: 0,
      page: "cov-0",
      kind: "capture",
      notRun: "the stage did not apply cloudCoverage",
    },
  ]);
  const verdicts = mod.variantControlVerdicts(entries);
  assert.equal(verdicts.length, 2);
  const measured = verdicts.find((v) => v.id.includes(":cov-1e-30:"));
  assert.equal(
    measured.id,
    "E-ZC-underside:cov-1e-30:vs-clouds-off:webgpu:run0:measured",
  );
  assert.equal(
    measured.pass,
    true,
    "a differing figure is still a measured one",
  );
  assert.equal(measured.changedPx, 1);
  assert.equal(measured.equalToControl, false);
  assert.equal(measured.notRun, undefined);
  const notRun = verdicts.find((v) => v.id.includes(":cov-0:"));
  assert.equal(
    notRun.id,
    "E-ZC-underside:cov-0:vs-clouds-off:webgpu:run0:measured",
  );
  assert.equal(notRun.pass, false);
  assert.equal(notRun.notRun, true);
  assert.match(notRun.reason, /cov-0/);
}

test("verdicts: a measured comparison passes with its figure whatever it reads, an unmeasured one is NOT RUN with its reason", () => {
  assertVerdicts(control);
});

// ---------------------------------------------------------------------------
// The sky-cube comparison
// ---------------------------------------------------------------------------

const faceBytes = (face, tweak = 0) => Buffer.alloc(64, face + 1 + tweak);
const rawCube = ({ changedFace = null } = {}) => ({
  available: true,
  format: "rgba8unorm",
  size: 4,
  mipLevels: 3,
  frames: 5,
  faces: Array.from({ length: 6 }, (_, face) => ({
    face,
    bytes: faceBytes(face, face === changedFace ? 100 : 0).toString("base64"),
  })),
});

/** A cube page record built with the real skyCubeRecord; its faces are written under the spec's temp root. */
function cubePage({ run = 0, page, raw }) {
  const outputDirectory = path.join(tempRoot, "cube-faces");
  const capture = framePage({ run, page, changed: 0, cell: "E-ZC-skycube" });
  return {
    ...capture,
    kind: "sky-cube",
    skyCube: skyCubeRecord(raw, {
      base: `E-ZC-skycube-webgpu-run${run}-${page}`,
      outputDirectory,
    }),
  };
}

/** The cube branch reads per-face sha256, and names the faces that differ. */
function assertCubeComparisons(mod) {
  const entries = mod.variantControlComparisons([
    cubePage({ page: "clouds-off", raw: rawCube() }),
    cubePage({ page: "cov-0", raw: rawCube() }),
    cubePage({ page: "cov-1e-30", raw: rawCube({ changedFace: 3 }) }),
  ]);
  assert.equal(entries.length, 2);
  const same = entryOf(entries, "cov-0", 0);
  assert.equal(same.kind, "sky-cube");
  assert.equal(same.measured, true);
  assert.equal(same.cube.identical, true);
  assert.deepEqual(same.cube.differingFaces, []);
  assert.equal(same.equalToControl, true);
  assert.equal(same.changedPx, undefined, "no pixel figure on a cube page");
  const differs = entryOf(entries, "cov-1e-30", 0);
  assert.equal(differs.kind, "sky-cube");
  assert.equal(differs.cube.identical, false);
  assert.deepEqual(differs.cube.differingFaces, [3]);
  assert.equal(differs.equalToControl, false);

  // A cube that could not be read is NOT MEASURED with the page's own reason.
  const unread = mod.variantControlComparisons([
    cubePage({ page: "clouds-off", raw: rawCube() }),
    cubePage({ page: "cov-0", raw: null }),
  ]);
  assert.equal(unread.length, 1);
  assert.equal(unread[0].measured, false);
  assert.match(unread[0].reason, /NOT AVAILABLE/);
  assert.equal(unread[0].cube, undefined);

  // The control's own repeat is its band: a control whose second run differs on a face.
  const banded = mod.variantControlComparisons([
    cubePage({ run: 0, page: "clouds-off", raw: rawCube() }),
    cubePage({ run: 1, page: "clouds-off", raw: rawCube({ changedFace: 1 }) }),
    cubePage({ run: 0, page: "cov-0", raw: rawCube() }),
  ]);
  assert.equal(banded.length, 1);
  assert.deepEqual(banded[0].band, { runs: [0, 1], identical: false });
}

test("sky cube: faces are compared by sha256 against the control's cube, the differing face is named and an unreadable cube is NOT MEASURED", () => {
  assertCubeComparisons(control);
});

// ---------------------------------------------------------------------------
// Wiring: the real probe on the fake browser
// ---------------------------------------------------------------------------

/** The probe's receipt carries the comparison and the verdicts, and the page records the named console lines. */
async function assertProbeWiring(probeModule) {
  const seen = new Set();
  const run = await p14Run(
    "wiring-underside",
    ["--cells", "E-ZC-underside", "--runs", "2"],
    {
      // The cov-1e-30 page of the second run alone shows one different pixel.
      screenshotFor: ({ payload }) => {
        if (Object.is(payload?.volumetric?.cloudCoverage, 1e-30)) {
          seen.add(payload);
          if (seen.size > 1) {
            return makeSmallPng(8, 8, true);
          }
        }
        return undefined;
      },
    },
    probeModule.descriptor,
  );
  const entries = run.report.variantControl;
  assert.ok(Array.isArray(entries), "the receipt carries variantControl");
  assert.equal(entries.length, 6, "three pages by two runs");
  assert.ok(entries.every((entry) => entry.measured === true));
  const changed = entries.find((e) => e.page === "cov-1e-30" && e.run === 1);
  assert.equal(changed.changedPx, 1);
  assert.equal(changed.equalToControl, false);
  const ids = run.verdicts
    .map((verdict) => verdict.id)
    .filter((id) => id.endsWith(":measured") && id.includes(":vs-clouds-off:"));
  assert.equal(ids.length, 6);
  assert.ok(
    ids.includes("E-ZC-underside:cov-1e-30:vs-clouds-off:webgpu:run1:measured"),
  );
  for (const page of run.report.pages) {
    assert.ok(page.consoleLines, `${page.page} counts its named console lines`);
  }
}

test("the probe writes the comparison into the receipt, one :measured verdict per page and run, and consoleLines on every page", async () => {
  await assertProbeWiring(probe);
});

const RAW_CUBE_ANSWERS = {
  add: { added: true, ready: true, frames: 3 },
  read: rawCube(),
};

/** Each variant page writes its faces under its own names; E-SKY-cube keeps its own. */
async function assertFaceNames(probeModule) {
  const run = await p14Run(
    "wiring-skycube",
    ["--cells", "E-ZC-skycube"],
    { skyCubeAnswers: RAW_CUBE_ANSWERS },
    probeModule.descriptor,
  );
  const paths = run.report.pages.flatMap((page) =>
    page.skyCube.faces.map((face) => path.basename(face.path)),
  );
  assert.equal(paths.length, 18, "three pages by six faces");
  assert.equal(new Set(paths).size, 18, "no two pages share a face file");
  assert.ok(paths.includes("E-ZC-skycube-webgpu-run0-cov-0-skycube-face0.bin"));
  assert.ok(
    paths.includes("E-ZC-skycube-webgpu-run0-clouds-off-skycube-face5.bin"),
  );
  const entries = run.report.variantControl;
  assert.equal(entries.length, 2);
  assert.ok(
    entries.every((entry) => entry.kind === "sky-cube" && entry.cube.identical),
  );
  const plain = await p14Run(
    "wiring-skycube-plain",
    ["--cells", "E-SKY-cube"],
    { skyCubeAnswers: RAW_CUBE_ANSWERS },
    probeModule.descriptor,
  );
  assert.equal(
    path.basename(plain.report.pages[0].skyCube.faces[0].path),
    "E-SKY-cube-webgpu-run0-skycube-face0.bin",
  );
}

test("the probe writes the cube faces of each variant page under its own file names, compares them with the control, and leaves E-SKY-cube's names alone", async () => {
  await assertFaceNames(probe);
});

// ---------------------------------------------------------------------------
// Inertness: each mutant runs the passing behaviour and must fail with an AssertionError
// ---------------------------------------------------------------------------

async function assertRed(behaviour, file, ...mutations) {
  const mutated = await importMutated(file, mutations);
  await assert.rejects(
    async () => behaviour(mutated),
    (error) => {
      const at = String(error.stack)
        .split(String.fromCharCode(10))
        .find((line) => line.includes(".spec.mjs"));
      console.log(
        `[mutant red] ${String(error.message).slice(0, 100)} ${String(at).trim()}`,
      );
      return error instanceof assert.AssertionError;
    },
  );
}

test("inertness M1-1: the control lookup made unreachable (the page is its own control) turns the pixel comparison red", async () => {
  assertPixelComparisons(control);
  await assertRed(assertPixelComparisons, CONTROL_FILE, [
    "const reference = controls.get(run);",
    "const reference = page;",
  ]);
});

test("inertness M1-2: the band made unreachable turns the pixel comparison red", async () => {
  await assertRed(assertPixelComparisons, CONTROL_FILE, [
    "const band = bandOf(controls, cube, { diff, compareCube });",
    "const band = { runs: [0, 1], changedPx: 0 };",
  ]);
});

test("inertness M1-3: the measured guard made unreachable turns the pixel comparison red", async () => {
  await assertRed(assertPixelComparisons, CONTROL_FILE, [
    "if (cube ? !page.skyCube : !page.capture) {",
    "if (false && (cube ? !page.skyCube : !page.capture)) {",
  ]);
});

test("inertness M1-3b: the page's NOT RUN guard made unreachable turns the pixel comparison red", async () => {
  await assertRed(assertPixelComparisons, CONTROL_FILE, [
    "if (page.notRun) {",
    "if (false && page.notRun) {",
  ]);
});

test("inertness M1-4: the verdict's measured test made unreachable turns the verdicts red", async () => {
  assertVerdicts(control);
  await assertRed(assertVerdicts, CONTROL_FILE, [
    "if (entry.measured !== true) {",
    "if (false && entry.measured !== true) {",
  ]);
});

test("inertness M3-1: the cube branch made unreachable (every pair read as pixels) turns the cube comparison red", async () => {
  assertCubeComparisons(control);
  await assertRed(assertCubeComparisons, CONTROL_FILE, [
    'const cube = table.kind === "sky-cube";',
    "const cube = false;",
  ]);
});

test("inertness M3-2: the probe's page suffix on the face names made unreachable turns the face-name wiring red", async () => {
  await assertRed(assertFaceNames, PROBE_FILE, [
    'base: entry.page === "scene" ? base : `${base}-${entry.page}`,',
    "base,",
  ]);
});

test("inertness: the probe's variantControl receipt field made unreachable turns the probe wiring red", async () => {
  await assertRed(assertProbeWiring, PROBE_FILE, [
    "variantControl: variantControlComparisons(pages),",
    "variantControl: [],",
  ]);
});

test("inertness M2-1: the zero-coverage table entry's variants dropped plans one page and turns the cell plan red", async () => {
  const mutated = await importMutated(TABLE_FILE, [
    [
      '    controlPage: "clouds-off",\n    consoleLines: CLOUD_PIPELINE_CONSOLE_LINES,\n    variants: Object.freeze({\n      "clouds-off": Object.freeze({\n        cloudsEnabled: false,\n        experimental: Object.freeze({ cloudDistantDensityMoments: true }),\n      }),\n      "cov-0": Object.freeze({\n        cloudCoverage: 0,\n        experimental: Object.freeze({ cloudDistantDensityMoments: true }),\n      }),\n    }),',
      '    controlPage: "clouds-off",\n    consoleLines: CLOUD_PIPELINE_CONSOLE_LINES,',
    ],
  ]);
  const pages = planLandingCells(
    { cells: "E-ZC-density", renderers: ["webgpu"] },
    rigsById,
  ).map((entry) => entry.page);
  assert.deepEqual(pages, ["clouds-off", "cov-0"]);
  const mutatedPlan = mutated
    .planLandingCells(
      { cells: "E-ZC-density", renderers: ["webgpu"] },
      rigsById,
    )
    .map((entry) => entry.page);
  assert.deepEqual(mutatedPlan, ["scene"], "the cell now runs one page");
});
