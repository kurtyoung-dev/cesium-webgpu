// probe-landing-cells-identity-sentinel.spec.mjs - the per-cell wait and the identity-cell onmessage sentinel. Pure Node: no browser, no GPU.
// @purpose Asserts the P14 landing cells' table, variant dials, per-cell pipeline wait and the onmessage sentinel of the identity cells (installed before load, judged twice, hijack and lazy-replacement cases) of probe-landing-cells.
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
import { PROBE_EXIT_CODES, ProbeRefusal } from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import {
  PIPELINE_WAIT_MODES,
  pipelineWaitMismatches,
  pipelineWaitPlan,
  rigForPage,
  waitedForCell,
} from "./lib/landing-cell-table.mjs";
import { mergeLandingReports } from "./lib/metrics/merge-landing-reports.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  allWaited,
  descriptor,
  planLandingCells,
  readComparisonInputs,
} from "./probe-landing-cells.mjs";
import {
  pfRecord,
  reportOf,
  verdictById,
  landingRunners,
} from "./fixtures/probe-landing-cells-support.mjs";

// A per-run root under this lane's namespace: two runs of this spec at once
// (two lanes, or a lane and the seat) must not share, or delete, each other's
// fixtures.
let TEMP_ROOT = "";

before(() => {
  TEMP_ROOT = mkLaneTmp("probe-landing-cells-sentinel-");
});

after(() => {
  removeLaneTmp(TEMP_ROOT);
});

const { p14Run } = landingRunners(() => TEMP_ROOT);

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((r) => [r.id, r]));

const TABLE_MODULE = fileURLToPath(
  new URL("./lib/landing-cell-table.mjs", import.meta.url),
);
const PROBE_MODULE = fileURLToPath(
  new URL("./probe-landing-cells.mjs", import.meta.url),
);

test("P14: the new cells name their rigs and pages and stay out of the default set", () => {
  const plan = (cells) =>
    planLandingCells({ cells }, rigsById).map((entry) => [
      entry.renderer,
      entry.page,
    ]);
  assert.deepEqual(plan("E-FFT-ifft"), [
    ["webgpu", "stockham"],
    ["webgpu", "pingpong"],
  ]);
  for (const cell of ["E-C-chukotka", "E-ID-2d", "E-ID-cv"]) {
    assert.deepEqual(plan(cell), [
      ["webgl", "scene"],
      ["webgpu", "scene"],
    ]);
  }
  assert.equal(LANDING_CELLS["E-FFT-ifft"].rig, "ocean-fft-patch-rebase");
  assert.equal(
    LANDING_CELLS["E-C-chukotka"].rig,
    "water-antimeridian-chukotka",
  );
  assert.equal(LANDING_CELLS["E-ID-2d"].rig, "default-2d-pinned");
  assert.equal(LANDING_CELLS["E-ID-cv"].rig, "default-columbus-pinned");
  for (const cell of ["E-D", "E-D-HDR", "E-ID-2d", "E-ID-cv"]) {
    assert.equal(LANDING_CELLS[cell].identity, true, cell);
  }
  for (const cell of ["E-FFT-ifft", "E-C-chukotka", "E-ID-2d", "E-ID-cv"]) {
    assert.ok(!DEFAULT_CELLS.includes(cell), cell);
  }
});

test("P14: a variant page stages its rig with the variant's dials, which the stage accepts; the 2D and CV rigs stage their scene mode", () => {
  const rig = rigsById.get("ocean-fft-patch-rebase");
  const before = JSON.stringify(rig);
  const pingpong = rigForPage(rig, { cell: "E-FFT-ifft", page: "pingpong" });
  assert.equal(pingpong.dials.waterOceanIfftKernel, "pingpong");
  assert.equal(pingpong.dials.waterOceanEnabled, true, "rig dials kept");
  assert.equal(JSON.stringify(rig), before, "the rig record is untouched");
  assert.equal(rigForPage(rig, { cell: "E-D", page: "scene" }), rig);
  assert.equal(
    landingStagePayload(pingpong).water.waterOceanIfftKernel,
    "pingpong",
  );
  assert.equal(
    landingStagePayload(rigsById.get("default-2d-pinned")).scene.sceneMode,
    "SCENE2D",
  );
  assert.equal(
    landingStagePayload(rigsById.get("default-columbus-pinned")).scene
      .sceneMode,
    "COLUMBUS_VIEW",
  );
  assert.doesNotThrow(() =>
    landingStagePayload(rigsById.get("water-antimeridian-chukotka")),
  );
});

test("P14: the pipeline wait is per cell: identity, E-M-water, Chukotka and ocean cells wait by default; the flags force or waive it; both together refuse", () => {
  const all = Object.keys(LANDING_CELLS).join(",");
  const byDefault = pipelineWaitPlan({ cells: all });
  assert.equal(byDefault.mode, PIPELINE_WAIT_MODES.CELL_DEFAULT);
  for (const cell of [
    "E-D",
    "E-D-HDR",
    "E-ID-2d",
    "E-ID-cv",
    "E-M-water",
    "E-C-chukotka",
    "E-FFT-ifft",
  ]) {
    assert.equal(byDefault.byCell[cell], true, cell);
  }
  for (const cell of ["E-O", "E-F", "E-G", "R-14", "E-T-water"]) {
    assert.equal(byDefault.byCell[cell], false, cell);
  }
  const forced = pipelineWaitPlan({ cells: all, waitPipelines: true });
  assert.equal(forced.mode, PIPELINE_WAIT_MODES.FORCED);
  assert.ok(Object.values(forced.byCell).every((w) => w === true));
  const waived = pipelineWaitPlan({ cells: all, noWaitPipelines: true });
  assert.equal(waived.mode, PIPELINE_WAIT_MODES.WAIVED);
  assert.ok(Object.values(waived.byCell).every((w) => w === false));
  assert.throws(
    () => readComparisonInputs({ waitPipelines: true, noWaitPipelines: true }),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "pipeline-wait-conflict",
  );
  assert.equal(allWaited({ "E-D": true, "E-ID-2d": true }), true);
  assert.equal(allWaited({ "E-D": true, "E-O": false }), false);
  assert.equal(allWaited({}), false);
});

test("P14: a report's wait is read per cell, falling back to the run-wide flag, and two reports mismatch only on a cell both cover", () => {
  assert.equal(waitedForCell({ waitForPendingPipelines: true }, "E-D"), true);
  assert.equal(
    waitedForCell(
      { waitForPendingPipelines: true, pipelineWaitByCell: { "E-D": false } },
      "E-D",
    ),
    false,
  );
  const old = { pages: [pfRecord({ run: 0 })] };
  const now = { pipelineWaitByCell: { "E-D": true, "E-O": false } };
  assert.deepEqual(pipelineWaitMismatches(old, now), ["E-D"]);
  assert.deepEqual(
    pipelineWaitMismatches(
      { pipelineWaitByCell: { "E-O": true } },
      { pipelineWaitByCell: { "E-D": false } },
    ),
    [],
  );
  const pages = [pfRecord({ run: 0 })];
  assert.throws(
    () =>
      mergeLandingReports([
        { ...reportOf(pages), pipelineWaitByCell: { "E-D": true } },
        { ...reportOf(pages), pipelineWaitByCell: { "E-D": false } },
      ]),
    /waitForPendingPipelines/,
  );
  const merged = mergeLandingReports([
    { ...reportOf(pages), pipelineWaitByCell: { "E-D": true } },
    { ...reportOf(pages), pipelineWaitByCell: { "E-D": true } },
  ]);
  assert.deepEqual(merged.pipelineWaitByCell, { "E-D": true });
});

test("P14: (mutant) a table whose wait default is unreachable leaves E-D unwaited", async () => {
  const mutated = await importMutated(TABLE_MODULE, [
    [
      "        LANDING_CELLS[cell].waitPipelines === true);",
      "        false && LANDING_CELLS[cell].waitPipelines === true);",
    ],
  ]);
  assert.equal(pipelineWaitPlan({ cells: "E-D" }).byCell["E-D"], true);
  assert.equal(mutated.pipelineWaitPlan({ cells: "E-D" }).byCell["E-D"], false);
});

test("P14: an identity cell waits by default, installs the onmessage sentinel before load and judges it; --no-wait-pipelines is recorded", async () => {
  const run = await p14Run("p14-identity", ["--cells", "E-D"]);
  assert.equal(run.code, PROBE_EXIT_CODES.OK);
  assert.equal(run.log.waits.length, 2, "one wait per renderer");
  assert.deepEqual(run.report.pipelineWait, {
    mode: "cell-default",
    byCell: { "E-D": true },
  });
  assert.equal(run.report.waitForPendingPipelines, true);
  assert.ok(
    run.log.scripts.some(
      (script) =>
        typeof script === "function" &&
        script.name === "installOnmessageSentinel",
    ),
    "the sentinel is an init script",
  );
  assert.equal(run.log.sentinelReads.length, 4, "two reads per page");
  for (const renderer of ["webgl", "webgpu"]) {
    const verdict = verdictById(
      run.verdicts,
      `E-D:${renderer}:scene:run0:onmessage-unchanged`,
    );
    assert.ok(verdict, renderer);
    assert.equal(verdict.pass, true);
    assert.equal(verdict.reads.first.changed, false);
    assert.equal(verdict.reads.second.changed, false);
  }
  const waived = await p14Run("p14-identity-waived", [
    "--cells",
    "E-D",
    "--no-wait-pipelines",
  ]);
  assert.equal(waived.log.waits.length, 0);
  assert.equal(waived.report.pipelineWait.mode, "waived");
  assert.equal(waived.report.pipelineWaitByCell["E-D"], false);
});

test("P14: a hijacked window.onmessage fails the identity cell, even when the stage did not apply", async () => {
  const hijacked = {
    installed: true,
    before: null,
    after: {
      type: "function",
      name: "workerHandler",
      source: "function workerHandler(){}",
    },
    changed: true,
    assignments: 1,
    stacks: ["Error: onmessage assigned"],
  };
  const run = await p14Run("p14-hijack", ["--cells", "E-ID-2d"], {
    onmessage: hijacked,
    notApplied: ["sceneMode"],
  });
  assert.notEqual(run.code, PROBE_EXIT_CODES.OK);
  const verdict = verdictById(
    run.verdicts,
    "E-ID-2d:webgpu:scene:run0:onmessage-unchanged",
  );
  assert.equal(verdict.pass, false);
  assert.equal(verdict.after.name, "workerHandler");
  assert.equal(
    verdictById(run.verdicts, "E-ID-2d:webgpu:scene:run0:stage").notRun,
    true,
  );
});

// Wraps the fake browser so a page's onmessage is replaced AFTER its first
// sentinel read (a lazily loaded module): the first read is clean and every
// later one before the positive control sees the replacement. `order` logs the
// reads and the control assignment in the order the page saw them.
const LAZY_HANDLER = {
  type: "function",
  name: "lazyModuleHandler",
  source: "function lazyModuleHandler(){}",
};

function replacedAfterFirstRead(order) {
  return (browser) => ({
    ...browser,
    async newContext(options) {
      const context = await browser.newContext(options);
      return {
        close: () => context.close(),
        async newPage() {
          const page = await context.newPage();
          let reads = 0;
          let controlled = false;
          return {
            ...page,
            async evaluate(fn, arg) {
              if (fn.name === "pageAssignOnmessagePositiveControl") {
                controlled = true;
                order.push("control");
              } else if (
                fn.name === "pageReadOnmessageSentinel" &&
                !controlled
              ) {
                reads++;
                order.push("read");
                if (reads >= 2) {
                  return {
                    installed: true,
                    before: null,
                    after: LAZY_HANDLER,
                    changed: true,
                    assignments: 1,
                    stacks: ["Error: onmessage assigned"],
                  };
                }
              }
              return page.evaluate(fn, arg);
            },
          };
        },
      };
    },
  });
}

test("P14: a window.onmessage replaced mid-page (after the first read) fails the identity cell; the control still flips and is never seen by the second read", async () => {
  const order = [];
  const run = await p14Run(
    "p14-lazy-onmessage",
    ["--cells", "E-D", "--sentinel-positive-control"],
    {},
    descriptor,
    replacedAfterFirstRead(order),
  );
  assert.notEqual(run.code, PROBE_EXIT_CODES.OK);
  for (const renderer of ["webgl", "webgpu"]) {
    const verdict = verdictById(
      run.verdicts,
      `E-D:${renderer}:scene:run0:onmessage-unchanged`,
    );
    assert.equal(verdict.pass, false, renderer);
    assert.notEqual(verdict.notRun, true, "a finding, not a skipped check");
    assert.equal(verdict.after.name, "lazyModuleHandler");
    assert.equal(verdict.reads.first.changed, false);
    assert.equal(verdict.reads.second.changed, true);
  }
  // The control page: read, read, then the control assignment; its verdict
  // still passes on the control's own reading.
  assert.deepEqual(order.slice(0, 3), ["read", "read", "control"]);
  assert.equal(order.filter((entry) => entry === "control").length, 1);
  assert.equal(
    verdictById(run.verdicts, "E-D:webgl:scene:run0:onmessage-positive-control")
      .pass,
    true,
  );
});

test("P14: a mid-page replacement is caught on the not-run path too (the stage did not apply)", async () => {
  const run = await p14Run(
    "p14-lazy-onmessage-blocked",
    ["--cells", "E-ID-2d"],
    { notApplied: ["sceneMode"] },
    descriptor,
    replacedAfterFirstRead([]),
  );
  const verdict = verdictById(
    run.verdicts,
    "E-ID-2d:webgpu:scene:run0:onmessage-unchanged",
  );
  assert.equal(verdict.pass, false);
  assert.notEqual(verdict.notRun, true);
  assert.equal(verdict.after.name, "lazyModuleHandler");
});

test("P14: (mutants) the second sentinel read made unreachable loses the mid-page catch, and a first read alone never passes", async () => {
  const anchors = [
    [
      "      await rereadOnmessage();\n      await runControl();\n      return record;",
      "      if (false) await rereadOnmessage();\n      await runControl();\n      return record;",
    ],
    [
      "        if (cell.identity === true && record.onmessage?.reads) {",
      "        if (false && cell.identity === true && record.onmessage?.reads) {",
    ],
  ];
  for (const [index, pair] of anchors.entries()) {
    const mutated = await importMutated(PROBE_MODULE, [pair]);
    const lazy = await p14Run(
      `p14-mut-lazy-${index}`,
      ["--cells", "E-D"],
      {},
      mutated.descriptor,
      replacedAfterFirstRead([]),
    );
    const caught = verdictById(
      lazy.verdicts,
      "E-D:webgl:scene:run0:onmessage-unchanged",
    );
    assert.notEqual(
      caught.after?.name,
      "lazyModuleHandler",
      "mutant misses it",
    );
    const clean = await p14Run(
      `p14-mut-clean-${index}`,
      ["--cells", "E-D"],
      {},
      mutated.descriptor,
    );
    const verdict = verdictById(
      clean.verdicts,
      "E-D:webgl:scene:run0:onmessage-unchanged",
    );
    assert.equal(verdict.pass, false, "a first read alone never passes");
    assert.equal(verdict.notRun, true);
  }
});

test("P14: a non-identity cell neither installs nor judges the sentinel", async () => {
  const run = await p14Run("p14-no-sentinel", ["--cells", "E-O"]);
  assert.equal(run.log.sentinelReads.length, 0);
  assert.ok(
    !run.log.scripts.some((s) => s?.name === "installOnmessageSentinel"),
  );
  assert.ok(!run.verdicts.some((v) => v.id.endsWith(":onmessage-unchanged")));
  assert.equal(run.report.pipelineWaitByCell["E-O"], false);
});
