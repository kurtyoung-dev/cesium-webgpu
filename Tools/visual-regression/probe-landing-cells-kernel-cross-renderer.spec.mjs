// probe-landing-cells-kernel-cross-renderer.spec.mjs - the ocean kernel readback and the cross-renderer variant pairing. Pure Node: no browser, no GPU.
// @purpose Asserts the E-FFT-ifft displacement readback and its kernel identity, the Chukotka cross-renderer diff, the 2D and Columbus stage-cell variant pairing (P15) and the wiring-clause mutants of the P14 cells of probe-landing-cells.
// @status ACTIVE
//
// One part of the probe-landing-cells spec, split by concern (row DX-KIT-LANDING-SPECS-OVER-SIZE); the
// test names and bodies are unchanged. The fixtures it shares with its siblings live in
// fixtures/probe-landing-cells-support.mjs. Written from _lane-out/BEHAVIOUR_CELOS.md and the lead
// additions named on each test.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { PROBE_EXIT_CODES } from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import { rigForPage } from "./lib/landing-cell-table.mjs";
import { GLOBE_FRAGMENT_DEBUG_MODE_NAMES } from "./lib/globe-fragment-debug-dial.mjs";
import {
  crossPageVerdicts,
  crossRendererComparisons,
  kernelIdentityComparisons,
} from "./lib/metrics/landing-cross-page.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  planLandingCells,
} from "./probe-landing-cells.mjs";
import {
  verdictById,
  readback,
  SAME_FIELDS,
  landingRunners,
} from "./fixtures/probe-landing-cells-support.mjs";

// A per-run root under this lane's namespace: two runs of this spec at once
// (two lanes, or a lane and the seat) must not share, or delete, each other's
// fixtures.
let TEMP_ROOT = "";

before(() => {
  TEMP_ROOT = mkLaneTmp("probe-landing-cells-kernel-");
});

after(() => {
  removeLaneTmp(TEMP_ROOT);
});

const { p14Run } = landingRunners(() => TEMP_ROOT);

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((r) => [r.id, r]));

const CROSS_MODULE = fileURLToPath(
  new URL("./lib/metrics/landing-cross-page.mjs", import.meta.url),
);
const PROBE_MODULE = fileURLToPath(
  new URL("./probe-landing-cells.mjs", import.meta.url),
);

test("P14: E-FFT-ifft reads the displacement back after each kernel's capture and passes when the two fields are identical", async () => {
  const run = await p14Run(
    "p14-kernels",
    ["--cells", "E-FFT-ifft"],
    SAME_FIELDS,
  );
  assert.equal(run.code, PROBE_EXIT_CODES.OK);
  assert.deepEqual(
    run.log.readbacks.map((arg) => arg.frames),
    [8, 8],
  );
  assert.deepEqual(
    run.report.pages.map((page) => [page.page, page.capture.name]),
    [
      ["stockham", "E-FFT-ifft-webgpu-run0-stockham"],
      ["pingpong", "E-FFT-ifft-webgpu-run0-pingpong"],
    ],
  );
  assert.ok(
    run.report.pages.every((page) => page.perf),
    "the PF-1 / PF-2 window runs without --perf",
  );
  const verdict = verdictById(
    run.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity",
  );
  assert.equal(verdict.pass, true);
  assert.equal(run.report.kernelIdentity[0].comparison.identical, true);
  assert.equal(run.report.pipelineWaitByCell["E-FFT-ifft"], true);
});

test("P14: E-FFT-ifft fails on different fields and is NOT RUN when a readback is unavailable", async () => {
  const differ = await p14Run("p14-kernels-differ", ["--cells", "E-FFT-ifft"], {
    displacements: [readback("stockham", "aa"), readback("pingpong", "bb")],
  });
  const failed = verdictById(
    differ.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity",
  );
  assert.equal(failed.pass, false);
  assert.equal(failed.notRun, undefined);
  assert.notEqual(differ.code, PROBE_EXIT_CODES.OK);
  const missing = await p14Run(
    "p14-kernels-missing",
    ["--cells", "E-FFT-ifft"],
    {
      displacements: [
        readback("stockham", "aa"),
        { available: false, reason: "compute pipelines are not ready" },
      ],
    },
  );
  const notRun = verdictById(
    missing.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity",
  );
  assert.equal(notRun.pass, false);
  assert.equal(notRun.notRun, true);
});

test("P14: E-C-chukotka diffs the WebGPU capture against the same run's WebGL capture and records the band as unregistered", async () => {
  const run = await p14Run("p14-chukotka", ["--cells", "E-C-chukotka"]);
  assert.equal(run.code, PROBE_EXIT_CODES.OK);
  const [entry] = run.report.crossRenderer;
  assert.equal(entry.cell, "E-C-chukotka");
  assert.equal(entry.measured, true);
  assert.equal(entry.changedPx, 0);
  assert.match(entry.band, /first capture registers/);
  assert.equal(
    verdictById(run.verdicts, "E-C-chukotka:cross-renderer:run0:measured").pass,
    true,
  );
});

test("P14: the cross-renderer diff is NOT RUN without both captures, and the kernel pairs are judged per run", () => {
  const page = (renderer, capture) => ({
    cell: "E-C-chukotka",
    run: 0,
    renderer,
    page: "scene",
    notRun: capture ? null : "the stage did not apply terrain",
    capture,
  });
  const shot = (name) => ({ name, path: `${name}.png` });
  const diff = () => ({
    measured: true,
    changedPx: 42,
    mismatchPct: 0.5,
    bbox: null,
  });
  const measured = crossRendererComparisons(
    [page("webgl", shot("a")), page("webgpu", shot("b"))],
    { diff },
  );
  assert.equal(measured[0].changedPx, 42);
  assert.equal(measured[0].webgl, "a");
  const missing = crossRendererComparisons(
    [page("webgl", shot("a")), page("webgpu", null)],
    { diff },
  );
  assert.equal(missing[0].measured, false);
  assert.match(missing[0].reason, /webgpu \(the stage did not apply terrain\)/);
  const [verdict] = crossPageVerdicts({ crossRenderer: missing });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, true);
  assert.deepEqual(
    crossRendererComparisons(
      [
        { ...page("webgl", shot("a")), cell: "E-D" },
        { ...page("webgpu", shot("b")), cell: "E-D" },
      ],
      { diff },
    ),
    [],
    "only crossRenderer cells are diffed",
  );
  const kernelPage = (run, name, hash) => ({
    cell: "E-FFT-ifft",
    run,
    renderer: "webgpu",
    page: name,
    displacement: readback(name, hash),
  });
  const pairs = kernelIdentityComparisons([
    kernelPage(0, "stockham", "aa"),
    kernelPage(0, "pingpong", "aa"),
    kernelPage(1, "stockham", "aa"),
    kernelPage(1, "pingpong", "cc"),
  ]);
  assert.deepEqual(
    pairs.map((pair) => [pair.run, pair.verdict.pass]),
    [
      [0, true],
      [1, false],
    ],
  );
});

const STAGES_CELLS = [
  ["E-2D-stages", "default-2d-pinned"],
  ["E-CV-stages", "default-columbus-pinned"],
];
const STAGE_PAGES = [
  "control",
  "no-drape",
  "fade",
  "atmo",
  "composite",
  "view-dir",
];

test("P15: the 2D and Columbus stage cells vary the globe fragment-debug dial over their pinned rigs, six pages per renderer, outside the default cells", () => {
  const modes = [
    "bypass-none",
    "bypass-drape",
    "fade-amount",
    "atmo-color",
    "post-composite-color",
    "view-dir",
  ];
  for (const [cell, rigId] of STAGES_CELLS) {
    const entry = LANDING_CELLS[cell];
    assert.equal(entry.rig, rigId);
    assert.equal(entry.kind, "capture");
    assert.equal(entry.crossRenderer, true);
    assert.equal(entry.waitPipelines, true);
    assert.ok(!DEFAULT_CELLS.includes(cell));
    assert.deepEqual(Object.keys(entry.variants), STAGE_PAGES);
    assert.deepEqual(
      Object.values(entry.variants).map((dials) => dials.globeFragmentDebug),
      modes,
    );
    for (const mode of modes) {
      assert.ok(GLOBE_FRAGMENT_DEBUG_MODE_NAMES.includes(mode), mode);
    }
    const plan = planLandingCells({ cells: cell }, rigsById);
    assert.deepEqual(
      plan.map((p) => [p.renderer, p.page]),
      ["webgl", "webgpu"].flatMap((renderer) =>
        STAGE_PAGES.map((page) => [renderer, page]),
      ),
    );
    // A variant page stages the rig with its mode laid over the rig's dials.
    const rig = rigsById.get(rigId);
    const staged = rigForPage(rig, { cell, page: "fade" });
    const payload = landingStagePayload(staged);
    assert.equal(payload.globe.globeFragmentDebug, "fade-amount");
    assert.equal(payload.scene.sceneMode, rig.dials.sceneMode);
    assert.equal(rig.dials.globeFragmentDebug, undefined, "rig untouched");
  }
});

// A page record of the cross-renderer metric; the capture name tells which
// pair a diff received.
const crossPage = (cell, run, renderer, page) => ({
  cell,
  run,
  renderer,
  page,
  capture: { name: `${renderer}-${page}-${run}`, path: "x.png" },
});
const stubDiff = () => {
  const calls = [];
  const diff = (a, b) => {
    calls.push([a.name, b.name]);
    return {
      measured: true,
      changedPx: calls.length,
      mismatchPct: 0.1,
      bbox: null,
    };
  };
  return { diff, calls };
};

test("P15: a cell without variants pairs exactly as before (literal derived by running the unchanged function)", () => {
  const { diff } = stubDiff();
  const page = (run, renderer, capture, extra = {}) => ({
    cell: "E-C-chukotka",
    run,
    renderer,
    page: "scene",
    capture,
    ...extra,
  });
  const out = crossRendererComparisons(
    [
      page(0, "webgl", { name: "a0" }),
      page(0, "webgpu", { name: "b0" }),
      page(1, "webgl", { name: "a1" }),
      page(1, "webgpu", null, { notRun: "no terrain" }),
    ],
    { diff },
  );
  assert.deepEqual(out, [
    {
      cell: "E-C-chukotka",
      run: 0,
      band: "unregistered (first capture registers)",
      webgl: "a0",
      webgpu: "b0",
      measured: true,
      changedPx: 1,
      mismatchPct: 0.1,
      bbox: null,
    },
    {
      cell: "E-C-chukotka",
      run: 1,
      band: "unregistered (first capture registers)",
      measured: false,
      reason: "no capture on webgpu (no terrain)",
    },
  ]);
  assert.deepEqual(
    crossPageVerdicts({ crossRenderer: out }).map((v) => v.id),
    [
      "E-C-chukotka:cross-renderer:run0:measured",
      "E-C-chukotka:cross-renderer:run1:measured",
    ],
  );
});

const stagePages = (cell, runs, { without = [] } = {}) =>
  runs.flatMap((run) =>
    ["webgl", "webgpu"].flatMap((renderer) =>
      STAGE_PAGES.filter(
        (name) => !(renderer === "webgpu" && without.includes(name)),
      ).map((name) => crossPage(cell, run, renderer, name)),
    ),
  );

async function assertVariantPairing(comparisons) {
  for (const [cell] of STAGES_CELLS) {
    const { diff, calls } = stubDiff();
    const out = comparisons(stagePages(cell, [0, 1]), { diff });
    assert.equal(out.length, 12, cell);
    assert.deepEqual(
      out.map((entry) => [entry.run, entry.page]),
      [0, 1].flatMap((run) => STAGE_PAGES.map((name) => [run, name])),
    );
    // Each entry paired the WebGL page of the same name with the WebGPU one.
    assert.deepEqual(
      calls,
      [0, 1].flatMap((run) =>
        STAGE_PAGES.map((name) => [
          `webgl-${name}-${run}`,
          `webgpu-${name}-${run}`,
        ]),
      ),
    );
    for (const entry of out) {
      assert.equal(entry.cell, cell);
      assert.equal(entry.measured, true);
      assert.equal(entry.webgl, `webgl-${entry.page}-${entry.run}`);
      assert.equal(entry.webgpu, `webgpu-${entry.page}-${entry.run}`);
    }
  }
}

test("P15: a variant cell pairs each WebGPU page with the WebGL page of the same name, per run, in table order", async () => {
  await assertVariantPairing(crossRendererComparisons);
});

test("P15: a missing WebGPU variant page is NOT RUN for that page only; verdict ids are unique per variant", () => {
  const { diff } = stubDiff();
  const out = crossRendererComparisons(
    stagePages("E-2D-stages", [0, 1], { without: ["atmo"] }),
    { diff },
  );
  assert.equal(out.length, 12);
  const unmeasured = out.filter((entry) => entry.measured !== true);
  assert.deepEqual(
    unmeasured.map((entry) => [entry.run, entry.page]),
    [
      [0, "atmo"],
      [1, "atmo"],
    ],
  );
  for (const entry of unmeasured) {
    assert.match(entry.reason, /no capture on webgpu \(no page\)/);
  }
  const verdicts = crossPageVerdicts({ crossRenderer: out });
  const ids = verdicts.map((verdict) => verdict.id);
  assert.equal(new Set(ids).size, 12, "one id per variant and run");
  assert.ok(ids.includes("E-2D-stages:fade:cross-renderer:run1:measured"));
  assert.deepEqual(
    verdicts
      .filter((verdict) => verdict.pass !== true)
      .map((verdict) => [verdict.id, verdict.notRun]),
    [
      ["E-2D-stages:atmo:cross-renderer:run0:measured", true],
      ["E-2D-stages:atmo:cross-renderer:run1:measured", true],
    ],
  );
});

test("P15: inertness mutant - variant cells collapsed to the first page per renderer turn the pairing checks red", async () => {
  const mutated = await importMutated(CROSS_MODULE, [
    ["? Object.keys(LANDING_CELLS[cell].variants)", "? [null]"],
  ]);
  await assert.rejects(
    assertVariantPairing(mutated.crossRendererComparisons),
    (error) => error instanceof assert.AssertionError,
  );
});

test("P14: (mutants) each wiring clause made unreachable loses the behaviour its test pins", async () => {
  const mutants = [
    {
      label: "sentinel never installed",
      anchor:
        "      if (cell.identity === true) {\n        // Before any page script",
      replacement:
        "      if (false && cell.identity === true) {\n        // Before any page script",
      cells: "E-D",
      lost: (run) =>
        !run.log.scripts.some((s) => s?.name === "installOnmessageSentinel"),
    },
    {
      label: "sentinel never read",
      anchor: "      if (cell.identity === true) {\n        record.onmessage",
      replacement:
        "      if (false && cell.identity === true) {\n        record.onmessage",
      cells: "E-D",
      lost: (run) =>
        !run.verdicts.some((v) => v.id.endsWith(":onmessage-unchanged")),
    },
    {
      label: "per-cell wait ignored",
      anchor:
        "          pipelineWaitPlan(options).byCell[entry.cell] === true,",
      replacement:
        "          false && pipelineWaitPlan(options).byCell[entry.cell] === true,",
      cells: "E-D",
      lost: (run) => run.log.waits.length === 0,
    },
    {
      label: "readback skipped",
      anchor: '        if (cell.readback === "ocean-displacement") {',
      replacement:
        '        if (false && cell.readback === "ocean-displacement") {',
      cells: "E-FFT-ifft",
      lost: (run) => run.log.readbacks.length === 0,
    },
    {
      label: "forced perf ignored",
      anchor:
        "          (cell.perf === true && options.noCellPerf !== true)) &&",
      replacement:
        "          (false && cell.perf === true && options.noCellPerf !== true)) &&",
      cells: "E-FFT-ifft",
      lost: (run) => run.report.pages.every((page) => !page.perf),
    },
    {
      label: "cross-page verdicts dropped",
      anchor: "      ...crossPageVerdicts({",
      replacement: "      ...[].concat(false && crossPageVerdicts({",
      close: true,
      cells: "E-FFT-ifft",
      lost: (run) =>
        !run.verdicts.some((v) => v.id.endsWith(":ifft-kernel-identity")),
    },
  ];
  for (const [index, mutant] of mutants.entries()) {
    const args = ["--cells", mutant.cells];
    const real = await p14Run(`p14-mut-real-${index}`, args, SAME_FIELDS);
    assert.equal(mutant.lost(real), false, `${mutant.label}: real keeps it`);
    const pairs = [[mutant.anchor, mutant.replacement]];
    if (mutant.close) {
      pairs.push([
        "        kernelIdentity: kernelIdentityComparisons(pages),\n      }),\n    ];",
        "        kernelIdentity: kernelIdentityComparisons(pages),\n      }) || []),\n    ];",
      ]);
    }
    const mutated = await importMutated(PROBE_MODULE, pairs);
    const run = await p14Run(
      `p14-mut-${index}`,
      args,
      SAME_FIELDS,
      mutated.descriptor,
    );
    assert.equal(mutant.lost(run), true, `${mutant.label}: mutant loses it`);
  }
});

// P14 round 2 (lane LINDISSE, review Tar-Palantir P1: R1, R2, R3a and the

test("P14 R3a: E-FFT-ifft reads the field with values, reports maxAbsDelta and the differing count, and writes no values", async () => {
  const run = await p14Run("p14-r3a", ["--cells", "E-FFT-ifft"], {
    displacements: [
      readback("stockham", "aa", { values: [0, 1, 2, 3] }),
      readback("pingpong", "bb", { values: [0, 1, 2.5, 3] }),
    ],
  });
  assert.equal(run.log.readbacks[0].includeValues, true);
  const [pair] = run.report.kernelIdentity;
  assert.equal(pair.comparison.identical, false);
  assert.equal(pair.comparison.maxAbsDelta, 0.5);
  assert.equal(pair.comparison.differingValues, 1);
  for (const page of run.report.pages) {
    assert.equal("values" in page.displacement, false, page.page);
  }
});

test("P14: --no-cell-perf drops the PF window E-FFT-ifft forces and keeps its readback identity", async () => {
  const run = await p14Run(
    "p14-no-cell-perf",
    ["--cells", "E-FFT-ifft", "--no-cell-perf"],
    SAME_FIELDS,
  );
  assert.equal(run.code, PROBE_EXIT_CODES.OK);
  assert.ok(run.report.pages.every((page) => !page.perf));
  assert.equal(run.log.readbacks.length, 2);
  assert.equal(
    verdictById(run.verdicts, "E-FFT-ifft:webgpu:run0:ifft-kernel-identity")
      .pass,
    true,
  );
});

test("P14 round 2: (mutants) the values read, the values kept out of the report and the --no-cell-perf flag each made inert lose their behaviour", async () => {
  const fields = () => ({
    displacements: [
      readback("stockham", "aa", { values: [0, 1] }),
      readback("pingpong", "aa", { values: [0, 1] }),
    ],
  });
  const mutants = [
    {
      label: "values not read",
      anchor: "              includeValues: true,",
      replacement: "              includeValues: false,",
      args: [],
      lost: (run) => run.log.readbacks[0].includeValues !== true,
    },
    {
      label: "values written",
      anchor: "          record.displacement = keepValuesOutOfReport(",
      replacement: "          record.displacement = ((record) => record)(",
      args: [],
      lost: (run) =>
        run.report.pages.some((page) => "values" in page.displacement),
    },
    {
      label: "--no-cell-perf inert",
      anchor: "(cell.perf === true && options.noCellPerf !== true)) &&",
      replacement: "(cell.perf === true && true)) &&",
      args: ["--no-cell-perf"],
      lost: (run) => run.report.pages.some((page) => page.perf),
    },
  ];
  for (const [index, mutant] of mutants.entries()) {
    const args = ["--cells", "E-FFT-ifft", ...mutant.args];
    const real = await p14Run(`p14-r2-real-${index}`, args, fields());
    assert.equal(mutant.lost(real), false, `${mutant.label}: real keeps it`);
    const mutated = await importMutated(PROBE_MODULE, [
      [mutant.anchor, mutant.replacement],
    ]);
    const run = await p14Run(
      `p14-r2-mut-${index}`,
      args,
      fields(),
      mutated.descriptor,
    );
    assert.equal(mutant.lost(run), true, `${mutant.label}: mutant loses it`);
  }
});
