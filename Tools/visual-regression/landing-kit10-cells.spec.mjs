// landing-kit10-cells.spec.mjs - the single-sample orbital cell, the orbital device-loss cell and the layout-census and default-limits cells.
//
// @purpose Node spec for the landing cells E-O-msaa1, E-T-orbital, E-BGL and E-LL: the single-sample orbital rig differs from the 4x rig in exactly its identity text and msaaSamples and stages with msaaSamples 1; E-T-orbital plans exactly the two device-loss pages on the 4x orbital rig and a fake-browser run of the probe reaches the device-loss steps on both; E-BGL and E-LL install the layout-census and device-limits scripts only for themselves, record the rows and the comparison on the page record and print them in the Markdown summary, and a cell without the fields installs no new script and records nothing new, with inertness mutants for the installs, the record reads and the summary section.
// @status ACTIVE
//
// Every probe assertion runs the real descriptor over the fake browser
// (lib/landing-fake-browser.mjs); the page-side scripts are asserted in their
// own specs (bind-group-layout-census.spec.mjs, device-limits-dial.spec.mjs).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";
import { WEBGPU_DEFAULT_LIMITS } from "./lib/device-limits-dial.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import {
  CLOUD_LAYOUT_LABELS,
  DEFAULT_CELLS,
  LANDING_CELLS,
  planLandingCells,
} from "./lib/landing-cell-table.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";

const INIT_SCRIPTS_MODULE = fileURLToPath(
  new URL("./lib/landing-init-scripts.mjs", import.meta.url),
);
const SUMMARY_MODULE = fileURLToPath(
  new URL("./lib/landing-cells-summary.mjs", import.meta.url),
);
const MSAA4 = "orbital-fulldisc-6608km-msaa4-single-deck";
const MSAA1 = "orbital-fulldisc-6608km-msaa1-single-deck";

let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("landing-kit10-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));

const summaryOf = (name) =>
  fs.readFileSync(
    path.join(tempRoot, name, "out", "landing-cells-summary.md"),
    "utf8",
  );
const scriptsWith = (log, marker) =>
  log.scripts.filter(
    (script) =>
      typeof script?.content === "string" && script.content.includes(marker),
  );
const CENSUS_MARKER = "__bindGroupLayoutCensus";
const DIAL_MARKER = "__deviceLimitsDial";

/** What the page created: the march layout (group 0), no shadow layout. */
const RAW_CENSUS = {
  installed: true,
  layouts: {
    "ProceduralClouds BGL": {
      created: 1,
      variants: 1,
      entries: 11,
      counts: {
        vertex: { uniformBuffers: 1 },
        fragment: {
          sampledTextures: 17,
          uniformBuffers: 2,
          storageBuffers: 0,
          samplers: 3,
          storageTextures: 0,
          externalTextures: 0,
        },
        compute: {},
      },
    },
  },
  groups: { "ProceduralClouds BGL": { 0: 6 } },
  unlabelled: 0,
  device: {
    found: true,
    limits: {
      maxSampledTexturesPerShaderStage: 16,
      maxUniformBuffersPerShaderStage: 12,
      maxStorageBuffersPerShaderStage: 8,
      maxSamplersPerShaderStage: 16,
      maxStorageTexturesPerShaderStage: 4,
    },
  },
};

const RAW_LIMITS = (limits) => ({
  installed: true,
  requests: [
    {
      requiredLimits: { maxBindGroups: 8 },
      requiredFeatures: ["timestamp-query"],
      label: "viewer device",
    },
  ],
  device: { found: true, limits },
});

// ---------------------------------------------------------------------------
// E-O-msaa1
// ---------------------------------------------------------------------------

test("E-O-msaa1: the single-sample rig differs from the 4x rig in exactly its identity text and msaaSamples", () => {
  const four = rigById(rigs, MSAA4);
  const one = rigById(rigs, MSAA1);
  assert.ok(four && one, "both orbital rigs are in the registry");
  assert.equal(rigs.filter((rig) => rig.id === MSAA1).length, 1);
  assert.deepEqual(validateRig(one), []);

  const differing = [...new Set([...Object.keys(four), ...Object.keys(one)])]
    .filter((key) => JSON.stringify(four[key]) !== JSON.stringify(one[key]))
    .sort();
  assert.deepEqual(differing, ["declaredBy", "description", "dials", "id"]);
  const dialKeys = [
    ...new Set([...Object.keys(four.dials), ...Object.keys(one.dials)]),
  ];
  assert.deepEqual(
    dialKeys.filter((key) => four.dials[key] !== one.dials[key]),
    ["msaaSamples"],
  );
  assert.equal(four.dials.msaaSamples, 4);
  assert.equal(one.dials.msaaSamples, 1);
  assert.deepEqual(one.tags, ["cloud"]);
  assert.deepEqual(one.renderers, ["webgpu"]);
});

test("E-O-msaa1: the landing stage payload of the new rig carries msaaSamples 1 and the 4x rig's stays 4", () => {
  assert.equal(landingStagePayload(rigById(rigs, MSAA1)).scene.msaaSamples, 1);
  assert.equal(landingStagePayload(rigById(rigs, MSAA4)).scene.msaaSamples, 4);
});

test("E-O-msaa1: the cell is a capture cell on the new rig, off by default, planned as one WebGPU page", () => {
  assert.deepEqual(
    {
      rig: LANDING_CELLS["E-O-msaa1"].rig,
      kind: LANDING_CELLS["E-O-msaa1"].kind,
    },
    { rig: MSAA1, kind: "capture" },
  );
  assert.ok(!DEFAULT_CELLS.includes("E-O-msaa1"));
  assert.deepEqual(
    planLandingCells({ cells: "E-O-msaa1" }, rigsById).map((entry) => [
      entry.renderer,
      entry.page,
      entry.rigId,
    ]),
    [["webgpu", "scene", MSAA1]],
  );
});

// ---------------------------------------------------------------------------
// E-T-orbital
// ---------------------------------------------------------------------------

test("E-T-orbital: planning the cell yields exactly the teardown and forced-loss pages on WebGPU with the 4x orbital rig", () => {
  assert.equal(LANDING_CELLS["E-T-orbital"].kind, "device-loss");
  assert.ok(!DEFAULT_CELLS.includes("E-T-orbital"));
  assert.deepEqual(
    planLandingCells({ cells: "E-T-orbital" }, rigsById).map((entry) => [
      entry.cell,
      entry.renderer,
      entry.page,
      entry.rigId,
      entry.kind,
    ]),
    [
      ["E-T-orbital", "webgpu", "teardown", MSAA4, "device-loss"],
      ["E-T-orbital", "webgpu", "forced-loss", MSAA4, "device-loss"],
    ],
  );
});

test("E-T-orbital: a fake-browser run of the probe reaches the device-loss steps on both pages", async () => {
  const { code, report, log } = await p14Run("orbital-loss", [
    "--cells",
    "E-T-orbital",
  ]);
  assert.equal(code, 0);
  assert.deepEqual(log.deviceLossCalls, [
    "pageDestroyViewer",
    "pageForceDeviceLoss",
    "pageRenderAfterLoss",
  ]);
  assert.deepEqual(
    report.pages.map((page) => [
      page.page,
      page.rig,
      page.deviceLoss.mode,
      page.deviceLoss.terminal.action,
    ]),
    [
      ["teardown", MSAA4, "teardown", "viewer.destroy"],
      ["forced-loss", MSAA4, "forced-loss", "GPUDevice.destroy"],
    ],
  );
});

// ---------------------------------------------------------------------------
// E-BGL and E-LL
// ---------------------------------------------------------------------------

test("E-BGL and E-LL: the table entries ride the E-G rig, E-BGL with the census and E-LL with the census and the default-limits device", () => {
  assert.deepEqual(CLOUD_LAYOUT_LABELS, [
    "ProceduralClouds BGL",
    "CloudShadow BGL",
  ]);
  const bgl = LANDING_CELLS["E-BGL"];
  const ll = LANDING_CELLS["E-LL"];
  assert.deepEqual(
    [bgl.rig, bgl.kind, bgl.layoutCensus, bgl.deviceLimits],
    [LANDING_CELLS["E-G"].rig, "capture", CLOUD_LAYOUT_LABELS, undefined],
  );
  assert.deepEqual(
    [ll.rig, ll.kind, ll.layoutCensus, ll.deviceLimits],
    [
      LANDING_CELLS["E-G"].rig,
      "capture",
      CLOUD_LAYOUT_LABELS,
      "webgpu-default",
    ],
  );
  for (const cell of ["E-BGL", "E-LL"]) {
    assert.ok(!DEFAULT_CELLS.includes(cell));
  }
});

test("E-BGL: only the layout census is installed; its rows ride the page record and the summary names label, group and counts against the defaults", async () => {
  const { code, report, log } = await p14Run("bgl", ["--cells", "E-BGL"], {
    layoutCensus: RAW_CENSUS,
  });
  assert.equal(code, 0);
  assert.equal(scriptsWith(log, CENSUS_MARKER).length, 1);
  assert.equal(scriptsWith(log, DIAL_MARKER).length, 0);
  assert.equal(log.layoutReads.length, 1);
  assert.equal(log.limitReads.length, 0);

  const [page] = report.pages;
  assert.equal(page.deviceLimits, undefined);
  assert.equal(page.layoutCensus.installed, true);
  const [march, shadow] = page.layoutCensus.rows;
  assert.deepEqual(
    [march.label, march.seen, march.groups, march.overDefault],
    ["ProceduralClouds BGL", true, [0], ["fragment.sampledTextures"]],
  );
  assert.equal(march.counts.fragment.sampledTextures, 17);
  assert.deepEqual([shadow.label, shadow.seen], ["CloudShadow BGL", false]);

  const summary = summaryOf("bgl");
  assert.match(summary, /^## Bind group layouts and device limits$/mu);
  assert.match(
    summary,
    /layout `ProceduralClouds BGL`: group 0, 11 entries; vertex uniformBuffers 1\/12; fragment sampledTextures 17\/16, uniformBuffers 2\/12, samplers 3\/16; above the default limit: fragment\.sampledTextures/u,
  );
  assert.match(summary, /layout `CloudShadow BGL`: not created on the page/u);
  assert.doesNotMatch(summary, /device limits:/u);
});

test("E-LL: both scripts are installed; the page record carries the request, the device's limits and the comparison, and the summary names a key that differs", async () => {
  const equal = await p14Run("ll-equal", ["--cells", "E-LL"], {
    layoutCensus: RAW_CENSUS,
    deviceLimits: RAW_LIMITS(WEBGPU_DEFAULT_LIMITS),
  });
  assert.equal(equal.code, 0);
  assert.equal(scriptsWith(equal.log, CENSUS_MARKER).length, 1);
  assert.equal(scriptsWith(equal.log, DIAL_MARKER).length, 1);
  const [page] = equal.report.pages;
  assert.equal(page.deviceLimits.mode, "webgpu-default");
  assert.deepEqual(page.deviceLimits.requested[0].requiredLimits, {
    maxBindGroups: 8,
  });
  assert.equal(page.deviceLimits.comparison.equal, true);
  assert.equal(page.layoutCensus.rows.length, 2);
  assert.match(
    summaryOf("ll-equal"),
    /device limits: the page asked for 1 limits; the device reports the WebGPU defaults on \d+ keys/u,
  );

  const differs = await p14Run("ll-differs", ["--cells", "E-LL"], {
    layoutCensus: RAW_CENSUS,
    deviceLimits: RAW_LIMITS({
      ...WEBGPU_DEFAULT_LIMITS,
      maxStorageBuffersPerShaderStage: 10,
    }),
  });
  assert.deepEqual(differs.report.pages[0].deviceLimits.comparison.differing, [
    { key: "maxStorageBuffersPerShaderStage", device: 10, default: 8 },
  ]);
  assert.match(
    summaryOf("ll-differs"),
    /differs from the WebGPU defaults: maxStorageBuffersPerShaderStage 10 \(default 8\)/u,
  );
});

test("a cell without the new fields installs no new script, reads nothing and records nothing new", async () => {
  for (const [name, cell] of [
    ["plain-o", "E-O"],
    ["plain-g", "E-G"],
  ]) {
    const { code, report, log } = await p14Run(name, ["--cells", cell]);
    assert.equal(code, 0);
    assert.equal(scriptsWith(log, CENSUS_MARKER).length, 0);
    assert.equal(scriptsWith(log, DIAL_MARKER).length, 0);
    assert.deepEqual([log.layoutReads.length, log.limitReads.length], [0, 0]);
    for (const page of report.pages) {
      assert.equal(Object.hasOwn(page, "layoutCensus"), false);
      assert.equal(Object.hasOwn(page, "deviceLimits"), false);
    }
    assert.doesNotMatch(
      summaryOf(name),
      /Bind group layouts and device limits/u,
    );
  }
});

// ---------------------------------------------------------------------------
// Inertness mutants
// ---------------------------------------------------------------------------

function recordingPage() {
  const scripts = [];
  return {
    scripts,
    async addInitScript(script) {
      scripts.push(script);
    },
    async evaluate(fn) {
      return fn.name === "pageReadBindGroupLayoutCensus"
        ? RAW_CENSUS
        : RAW_LIMITS(WEBGPU_DEFAULT_LIMITS);
    },
  };
}

const BOTH = LANDING_CELLS["E-LL"];

test("inertness: the init-script module installs and reads for E-LL, and each opt-in made unreachable loses its script or record", async () => {
  const real = await importMutated(INIT_SCRIPTS_MODULE, []);
  const page = recordingPage();
  await real.installLandingInitScripts(page, BOTH);
  assert.equal(scriptsWith({ scripts: page.scripts }, CENSUS_MARKER).length, 1);
  assert.equal(scriptsWith({ scripts: page.scripts }, DIAL_MARKER).length, 1);
  const records = await real.readCellInitRecords(recordingPage(), BOTH);
  assert.deepEqual(Object.keys(records), ["layoutCensus", "deviceLimits"]);

  const noCensus = await importMutated(INIT_SCRIPTS_MODULE, [
    [
      "if (wantsLayoutCensus(cell)) {\n    await page.addInitScript(",
      "if (false && wantsLayoutCensus(cell)) {\n    await page.addInitScript(",
    ],
  ]);
  const a = recordingPage();
  await noCensus.installLandingInitScripts(a, BOTH);
  assert.equal(scriptsWith({ scripts: a.scripts }, CENSUS_MARKER).length, 0);

  const noDial = await importMutated(INIT_SCRIPTS_MODULE, [
    [
      "if (wantsDefaultLimits(cell)) {\n    await page.addInitScript(",
      "if (false && wantsDefaultLimits(cell)) {\n    await page.addInitScript(",
    ],
  ]);
  const b = recordingPage();
  await noDial.installLandingInitScripts(b, BOTH);
  assert.equal(scriptsWith({ scripts: b.scripts }, DIAL_MARKER).length, 0);

  const noReads = await importMutated(INIT_SCRIPTS_MODULE, [
    [
      "if (wantsLayoutCensus(cell)) {\n    records.layoutCensus",
      "if (false && wantsLayoutCensus(cell)) {\n    records.layoutCensus",
    ],
    [
      "if (wantsDefaultLimits(cell)) {\n    records.deviceLimits",
      "if (false && wantsDefaultLimits(cell)) {\n    records.deviceLimits",
    ],
  ]);
  assert.deepEqual(
    await noReads.readCellInitRecords(recordingPage(), BOTH),
    {},
  );
});

test("inertness: the summary section made unreachable loses the layout and device-limits lines", async () => {
  const { descriptor } = await import("./probe-landing-cells.mjs");
  const receipt = {
    pages: [
      {
        cell: "E-LL",
        renderer: "webgpu",
        page: "scene",
        run: 0,
        layoutCensus: {
          installed: true,
          rows: [
            {
              label: "ProceduralClouds BGL",
              seen: false,
              groups: [],
            },
          ],
        },
      },
    ],
  };
  const runtime = { verdicts: [], generatedAt: "2026-01-01T00:00:00Z" };
  const real = await importMutated(SUMMARY_MODULE, []);
  const text = real.buildLandingCellsSummary(
    receipt,
    runtime,
    descriptor.title,
  );
  assert.match(text, /## Bind group layouts and device limits/u);
  assert.match(text, /not created on the page/u);

  const mutated = await importMutated(SUMMARY_MODULE, [
    [
      "if (census.length > 0) {\n    const fields",
      "if (false && census.length > 0) {\n    const fields",
    ],
  ]);
  assert.doesNotMatch(
    mutated.buildLandingCellsSummary(receipt, runtime, descriptor.title),
    /Bind group layouts and device limits/u,
  );
});

test("inertness: the probe's two calls made unreachable lose the E-LL scripts and records", async () => {
  const PROBE_MODULE = fileURLToPath(
    new URL("./probe-landing-cells.mjs", import.meta.url),
  );
  const fake = { layoutCensus: RAW_CENSUS, deviceLimits: RAW_LIMITS({}) };
  const real = await p14Run("probe-mut-real", ["--cells", "E-LL"], fake);
  assert.equal(scriptsWith(real.log, CENSUS_MARKER).length, 1);
  assert.ok(real.report.pages[0].layoutCensus);

  const noInstall = await importMutated(PROBE_MODULE, [
    [
      "await installLandingInitScripts(page, cell);",
      "false && (await installLandingInitScripts(page, cell));",
    ],
  ]);
  const a = await p14Run(
    "probe-mut-install",
    ["--cells", "E-LL"],
    fake,
    noInstall.descriptor,
  );
  assert.equal(scriptsWith(a.log, CENSUS_MARKER).length, 0);
  assert.equal(scriptsWith(a.log, DIAL_MARKER).length, 0);

  const noRecord = await importMutated(PROBE_MODULE, [
    [
      "Object.assign(record, await readCellInitRecords(page, cell));",
      "false && Object.assign(record, await readCellInitRecords(page, cell));",
    ],
  ]);
  const b = await p14Run(
    "probe-mut-record",
    ["--cells", "E-LL"],
    fake,
    noRecord.descriptor,
  );
  assert.equal(b.report.pages[0].layoutCensus, undefined);
  assert.equal(b.report.pages[0].deviceLimits, undefined);
});
