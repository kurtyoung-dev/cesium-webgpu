// @purpose Node spec for the W4 cache landing cells E-ON-occupancy, E-ON-density, E-ON-shadow, E-ON-lighting and E-T-on: each E-ON rig is its base rig plus an experimental block of real CloudVolumetrics dials that are on, the flight rig's block is the union, the cells plan onto their rigs, a fake-browser run of the real probe stages each page through the REAL page stager, harness and CloudVolumetrics so every experimental dial reads back from the instance, `--help` names every cell, with inertness mutants for the help title and the stage payload.
// @status ACTIVE
//
// The only thing the fake browser stands in for is the page: the stager
// (`stageLandingCellInPage`), the cloud probe harness and `CloudVolumetrics`
// run as written, against the fake Cesium module and a fake viewer. The
// read-back that decides whether a dial applied is the harness reading the
// instance, never a canned answer.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import CloudVolumetrics from "../../packages/engine/Source/Scene/CloudVolumetrics.js";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  FAKE_CESIUM_URL,
  createFakeViewer,
} from "./fixtures/landing-cell-stage-support.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import * as stageModule from "./lib/landing-cell-stage.mjs";
import {
  CLOUD_LAYOUT_LABELS,
  DEFAULT_CELLS,
  LANDING_CELLS,
  planLandingCells,
} from "./lib/landing-cell-table.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STAGE_MODULE = path.join(here, "lib", "landing-cell-stage.mjs");
const PROBE_MODULE = path.join(here, "probe-landing-cells.mjs");

let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("landing-eon-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));

/** Each E-ON cell: its base rig and the experimental dials its rig turns on. */
const FAMILIES = Object.freeze({
  "E-ON-occupancy": {
    rig: "cloud-eon-occupancy",
    base: "cloud-underside-noon-cov055",
    dials: ["cloudSpatialOccupancy", "cloudWeatherVolumeBounds"],
  },
  "E-ON-density": {
    rig: "cloud-eon-density",
    base: "cloud-underside-noon-cov055",
    dials: ["cloudDensityCache", "cloudPrimaryDensityCache"],
  },
  "E-ON-shadow": {
    rig: "cloud-eon-shadow",
    base: "cloud-underside-noon-cov055",
    dials: ["cloudDeepShadowCache", "cloudDirectionalLighting"],
  },
  "E-ON-lighting": {
    rig: "cloud-eon-lighting",
    base: "cloud-underside-noon-cov055",
    dials: ["cloudContributionLighting"],
  },
});
const FLIGHT_BASE = "cloud-flight-multideck-hdr-1080p";
const FLIGHT_EON = "cloud-flight-multideck-hdr-1080p-eon";
const UNION = Object.values(FAMILIES).flatMap((family) => family.dials);

/** The fields a W4 rig may differ from its base in. */
const IDENTITY_AND_BLOCK = ["declaredBy", "description", "experimental", "id"];

const differingKeys = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();

/** A fake viewer whose cloud collection carries `volumetric`. */
function cloudViewer(volumetric) {
  const viewer = createFakeViewer();
  viewer.scene.globe.defaultCloudCollection = {
    enableVolumetric: false,
    renderMode: 0,
    volumetric,
  };
  return viewer;
}

/** Run `body` with `viewer` as the page's viewer and the real harness installed. */
async function withRealHarness(viewer, body) {
  globalThis.viewer = viewer;
  try {
    installCloudProbeHarness();
    return await body();
  } finally {
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
  }
}

/**
 * Wrap a fake browser so its pages run `stageLandingCellInPage` for real: the
 * function the probe handed to `page.evaluate`, the real harness and a real
 * `CloudVolumetrics`. Every other page function stays the base fake's. What
 * the probe sent and the instance each page staged are logged in `seen`.
 *
 * @param {Array<{payload: object, volumetric: object}>} seen
 * @param {() => object} [makeVolumetric] The instance each page stages.
 * @returns {(browser: object) => object}
 */
function withRealStage(seen, makeVolumetric = () => new CloudVolumetrics()) {
  return (browser) => ({
    isConnected: () => browser.isConnected(),
    close: () => browser.close(),
    async newContext(options) {
      const context = await browser.newContext(options);
      return {
        ...context,
        async newPage() {
          const page = await context.newPage();
          return {
            ...page,
            async evaluate(fn, arg) {
              if (fn.name !== "stageLandingCellInPage") {
                return page.evaluate(fn, arg);
              }
              const volumetric = makeVolumetric();
              seen.push({ payload: arg, volumetric });
              return withRealHarness(cloudViewer(volumetric), () =>
                fn({ ...arg, moduleUrl: FAKE_CESIUM_URL }),
              );
            },
          };
        },
      };
    },
  });
}

/** A namespace with the real instance's experimental keys whose setters drop writes. */
function droppingVolumetric() {
  const experimental = {};
  for (const key of Object.keys(new CloudVolumetrics().experimental)) {
    Object.defineProperty(experimental, key, {
      enumerable: true,
      get: () => false,
      set: () => {},
    });
  }
  return { experimental };
}

/** The stage-level behaviour: a rig's block reaches the instance through `stage`. */
async function behaviourStageCarriesBlock(stage, rig) {
  const payload = {
    ...stage.landingStagePayload(rig),
    moduleUrl: FAKE_CESIUM_URL,
  };
  assert.deepEqual(payload.experimental, rig.experimental);
  const volumetric = new CloudVolumetrics();
  await withRealHarness(cloudViewer(volumetric), async () => {
    const answer = await stage.stageLandingCellInPage(payload);
    assert.deepEqual(answer.notApplied, []);
    for (const dial of Object.keys(rig.experimental)) {
      assert.equal(
        answer.dials[`experimental.${dial}`].applied,
        true,
        `${dial} applied`,
      );
      assert.equal(volumetric.experimental[dial], true, `${dial} on instance`);
    }
  });
}

/** The help-level behaviour: the descriptor's title names every cell. */
function behaviourTitleNamesEveryCell(descriptor) {
  for (const cell of Object.keys(LANDING_CELLS)) {
    assert.ok(descriptor.title.includes(cell), `title names ${cell}`);
  }
}

// ---------------------------------------------------------------------------
// (a) The rigs.
// ---------------------------------------------------------------------------

test("a: each E-ON rig differs from E-G's rig only in id, description, declaredBy and the experimental block, and is valid", () => {
  const base = rigById(rigs, "cloud-underside-noon-cov055");
  assert.ok(base);
  for (const [cell, family] of Object.entries(FAMILIES)) {
    const rig = rigById(rigs, family.rig);
    assert.ok(rig, `${cell}: rig ${family.rig} is registered`);
    assert.equal(rigs.filter((entry) => entry.id === family.rig).length, 1);
    assert.deepEqual(validateRig(rig), [], family.rig);
    assert.deepEqual(differingKeys(rig, base), IDENTITY_AND_BLOCK, family.rig);
    assert.deepEqual(rig.tags, base.tags);
    assert.deepEqual(rig.renderers, ["webgpu"]);
    assert.equal(Object.isFrozen(rig), true);
  }
});

test("a: each block names own enumerable dials of a real CloudVolumetrics#experimental, and each is true", () => {
  const known = new Set(Object.keys(new CloudVolumetrics().experimental));
  for (const [cell, family] of Object.entries(FAMILIES)) {
    const { experimental } = rigById(rigs, family.rig);
    assert.deepEqual(
      Object.keys(experimental).sort(),
      [...family.dials].sort(),
      cell,
    );
    for (const [dial, value] of Object.entries(experimental)) {
      assert.ok(
        known.has(dial),
        `${cell}: ${dial} is a real experimental dial`,
      );
      assert.equal(value, true, `${cell}: ${dial} is on`);
    }
  }
});

test("a: the flight E-ON rig is the flight rig plus the union of the four blocks", () => {
  const base = rigById(rigs, FLIGHT_BASE);
  const rig = rigById(rigs, FLIGHT_EON);
  assert.ok(base && rig);
  assert.deepEqual(validateRig(rig), []);
  assert.deepEqual(differingKeys(rig, base), IDENTITY_AND_BLOCK);
  assert.equal(base.experimental, undefined);
  const known = new Set(Object.keys(new CloudVolumetrics().experimental));
  assert.deepEqual(Object.keys(rig.experimental).sort(), [...UNION].sort());
  for (const [dial, value] of Object.entries(rig.experimental)) {
    assert.ok(known.has(dial), dial);
    assert.equal(value, true, dial);
  }
  const fromRigs = Object.assign(
    {},
    ...Object.values(FAMILIES).map(
      (family) => rigById(rigs, family.rig).experimental,
    ),
  );
  assert.deepEqual(rig.experimental, fromRigs);
});

// ---------------------------------------------------------------------------
// (b) The cells.
// ---------------------------------------------------------------------------

test("b: the E-ON cells are WebGPU capture cells with the cloud layout census, and E-T-on is a device-loss cell; none is a default cell", () => {
  for (const [cell, family] of Object.entries(FAMILIES)) {
    assert.equal(LANDING_CELLS[cell].rig, family.rig, cell);
    assert.equal(LANDING_CELLS[cell].kind, "capture", cell);
    assert.equal(LANDING_CELLS[cell].layoutCensus, CLOUD_LAYOUT_LABELS, cell);
    assert.ok(!DEFAULT_CELLS.includes(cell), cell);
  }
  assert.equal(LANDING_CELLS["E-T-on"].rig, FLIGHT_EON);
  assert.equal(LANDING_CELLS["E-T-on"].kind, "device-loss");
  assert.ok(!DEFAULT_CELLS.includes("E-T-on"));
});

test("b: planLandingCells resolves each E-ON cell to its rig on WebGPU alone, and E-T-on to its two device-loss pages", () => {
  for (const [cell, family] of Object.entries(FAMILIES)) {
    assert.deepEqual(
      planLandingCells({ cells: cell }, rigsById).map((entry) => [
        entry.cell,
        entry.rigId,
        entry.kind,
        entry.renderer,
        entry.page,
      ]),
      [[cell, family.rig, "capture", "webgpu", "scene"]],
    );
  }
  assert.deepEqual(
    planLandingCells({ cells: "E-T-on" }, rigsById).map((entry) => [
      entry.rigId,
      entry.kind,
      entry.renderer,
      entry.page,
    ]),
    [
      [FLIGHT_EON, "device-loss", "webgpu", "teardown"],
      [FLIGHT_EON, "device-loss", "webgpu", "forced-loss"],
    ],
  );
});

// ---------------------------------------------------------------------------
// (c) A fake-browser run of the probe with the real stager.
// ---------------------------------------------------------------------------

test("c: the stage payload of every E-ON rig carries its block, and the real stager applies it to a real CloudVolumetrics", async () => {
  for (const family of Object.values(FAMILIES)) {
    await behaviourStageCarriesBlock(stageModule, rigById(rigs, family.rig));
  }
  await behaviourStageCarriesBlock(stageModule, rigById(rigs, FLIGHT_EON));
});

/** The probe-level behaviour: the run sends the rig's block and the instance reads it back. */
async function behaviourRunSendsBlock(name, cell, family, probe) {
  const seen = [];
  const run = await p14Run(
    name,
    ["--cells", cell],
    {},
    probe,
    withRealStage(seen),
  );
  assert.equal(run.code, 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(
    seen[0].payload.experimental,
    rigById(rigs, family.rig).experimental,
  );
  assert.equal(seen[0].payload.rigId, family.rig);
  const [page] = run.report.pages;
  assert.equal(page.cell, cell);
  assert.equal(page.rig, family.rig);
  assert.deepEqual(page.stage.notApplied, []);
  for (const dial of family.dials) {
    assert.deepEqual(page.stage.dials[`experimental.${dial}`], {
      requested: true,
      observed: true,
      applied: true,
    });
    assert.equal(seen[0].volumetric.experimental[dial], true, dial);
  }
  return { ...run, seen };
}

for (const [cell, family] of Object.entries(FAMILIES)) {
  test(`c: ${cell} run on the probe sends the block and every experimental dial reads back true from the instance`, async () => {
    const { report, log, seen } = await behaviourRunSendsBlock(
      `run-${cell}`,
      cell,
      family,
      undefined,
    );
    const [page] = report.pages;
    // The tuning dials the rig did not declare stay at the class defaults.
    const untouched = new CloudVolumetrics().experimental;
    for (const dial of Object.keys(untouched)) {
      if (!family.dials.includes(dial)) {
        assert.deepEqual(
          seen[0].volumetric.experimental[dial],
          untouched[dial],
          dial,
        );
      }
    }
    assert.equal(page.layoutCensus.installed, true);
    assert.equal(log.layoutReads.length, 1);
    assert.deepEqual(
      page.layoutCensus.rows.map((row) => row.label),
      CLOUD_LAYOUT_LABELS,
    );
    assert.ok(page.capture, `${cell}: the PNG is described`);
  });
}

test("c: E-T-on runs both device-loss pages, each staged with all seven W4 dials applied on its own instance", async () => {
  const seen = [];
  const { code, report, log } = await p14Run(
    "run-E-T-on",
    ["--cells", "E-T-on"],
    {},
    undefined,
    withRealStage(seen),
  );
  assert.equal(code, 0);
  assert.deepEqual(log.deviceLossCalls, [
    "pageDestroyViewer",
    "pageForceDeviceLoss",
    "pageRenderAfterLoss",
  ]);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].volumetric, seen[1].volumetric);
  assert.deepEqual(
    report.pages.map((page) => [page.page, page.rig]),
    [
      ["teardown", FLIGHT_EON],
      ["forced-loss", FLIGHT_EON],
    ],
  );
  report.pages.forEach((page, index) => {
    assert.deepEqual(
      seen[index].payload.experimental,
      rigById(rigs, FLIGHT_EON).experimental,
    );
    assert.deepEqual(page.stage.notApplied, []);
    for (const dial of UNION) {
      assert.equal(
        page.stage.dials[`experimental.${dial}`].applied,
        true,
        `${page.page}: ${dial}`,
      );
      assert.equal(seen[index].volumetric.experimental[dial], true, dial);
    }
  });
});

test("c: negative control, an instance that drops the writes lands the dials in notApplied", async () => {
  const seen = [];
  const { report } = await p14Run(
    "run-dropping",
    ["--cells", "E-ON-occupancy"],
    {},
    undefined,
    withRealStage(seen, droppingVolumetric),
  );
  assert.equal(seen.length, 1);
  const [page] = report.pages;
  assert.ok(
    page.stage.notApplied.includes("experimental.cloudSpatialOccupancy"),
  );
  assert.equal(
    page.stage.dials["experimental.cloudSpatialOccupancy"].applied,
    false,
  );
  assert.match(page.notRun, /experimental.cloudSpatialOccupancy/);
});

// ---------------------------------------------------------------------------
// (d) --help.
// ---------------------------------------------------------------------------

test("d: --help exits 2 and its output names every LANDING_CELLS key", () => {
  const result = spawnSync(process.execPath, [PROBE_MODULE, "--help"], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 2, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  for (const cell of Object.keys(LANDING_CELLS)) {
    assert.ok(output.includes(cell), `--help names ${cell}`);
  }
  for (const cell of [...Object.keys(FAMILIES), "E-T-on"]) {
    assert.ok(output.includes(cell), `--help names ${cell}`);
  }
});

// ---------------------------------------------------------------------------
// (e) Inertness mutants.
// ---------------------------------------------------------------------------

test("e: the behaviours pass on the unmutated modules", async () => {
  const probe = await importMutated(PROBE_MODULE, []);
  behaviourTitleNamesEveryCell(probe.descriptor);
  const stage = await importMutated(STAGE_MODULE, []);
  await behaviourStageCarriesBlock(stage, rigById(rigs, "cloud-eon-density"));
});

test("e: mutant, the help title made a hand-typed list again, goes red", async () => {
  const mutated = await importMutated(PROBE_MODULE, [
    [
      '(${Object.keys(LANDING_CELLS).join(", ")})',
      "(E-D, E-D-HDR, E-O, E-F, E-G, E-H, R-14, E-T, E-M-water)",
    ],
  ]);
  assert.throws(
    () => behaviourTitleNamesEveryCell(mutated.descriptor),
    /title names/,
  );
});

test("e: mutant, the stage payload drops the rig's experimental block, goes red", async () => {
  const mutated = await importMutated(STAGE_MODULE, [
    ["    ...(experimental === undefined ? {} : { experimental }),\n", ""],
  ]);
  await assert.rejects(
    behaviourStageCarriesBlock(mutated, rigById(rigs, "cloud-eon-occupancy")),
    assert.AssertionError,
  );
  await assert.rejects(
    behaviourStageCarriesBlock(mutated, rigById(rigs, FLIGHT_EON)),
    assert.AssertionError,
  );
});

test("e: mutant, the probe stages the cell's rig without its experimental block, goes red", async () => {
  const family = FAMILIES["E-ON-density"];
  const real = await importMutated(PROBE_MODULE, []);
  await behaviourRunSendsBlock(
    "mut-real",
    "E-ON-density",
    family,
    real.descriptor,
  );
  const mutated = await importMutated(PROBE_MODULE, [
    [
      "stageLandingCell({\n        page,\n        rig,\n",
      "stageLandingCell({\n        page,\n        rig: { ...rig, experimental: undefined },\n",
    ],
  ]);
  await assert.rejects(
    behaviourRunSendsBlock(
      "mut-probe",
      "E-ON-density",
      family,
      mutated.descriptor,
    ),
    assert.AssertionError,
  );
});

test("e: mutant, the page stager never passes the block to configure, goes red", async () => {
  const mutated = await importMutated(STAGE_MODULE, [
    [
      "          ...(payload.experimental === undefined\n            ? {}\n            : { experimental: payload.experimental }),\n",
      "",
    ],
  ]);
  await assert.rejects(
    behaviourStageCarriesBlock(mutated, rigById(rigs, "cloud-eon-shadow")),
    assert.AssertionError,
  );
});
