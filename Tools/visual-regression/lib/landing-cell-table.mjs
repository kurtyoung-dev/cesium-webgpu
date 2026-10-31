/**
 * The landing program's cell table and the pure planning over it: which rig a
 * cell renders, on which renderers and pages, with which per-page dial
 * variants, and whether it waits for pending pipelines by default.
 * @purpose Cell table piece for probe-landing-cells.mjs: the LANDING_CELLS table (rig, kind, identity, per-cell pipeline-wait default, per-page dial variants, displacement readback and its evolved-clock second read, cross-renderer diff, forced performance leg and the GPU pass its PF-2 window must list), the (cell, renderer, page) plan, the rig a variant page stages, and the per-cell pending-pipeline wait resolved from --wait-pipelines / --no-wait-pipelines and read back from a report, all pure.
 * @status ACTIVE
 *
 * WHY A PIECE. The table and its planning moved out of
 * `probe-landing-cells.mjs` (lane LINDISSE) when the probe passed 1000 lines
 * with the ocean-kernel, Chukotka and 2D / Columbus cells; the probe re-exports
 * every name it exported before, so its importers are unchanged.
 *
 * PER-PAGE VARIANTS. A cell with `variants` runs one page per variant on each
 * renderer, the page named after the variant, and stages the cell's rig with
 * the variant's dials laid over the rig's own (`rigForPage`). E-FFT-ifft is
 * the first: the same ocean rig once per inverse-FFT kernel, so the two
 * kernels' displacement fields can be compared within one run.
 *
 * THE PIPELINE WAIT IS PER CELL. A WebGPU capture taken while pipelines still
 * compile shows the compile (the salvage-night receipt: an E-D frame with only
 * the atmosphere ring, an E-M-water frame all black). The identity cells,
 * E-M-water, E-C-chukotka and E-FFT-ifft therefore wait by default
 * (`waitPipelines: true`); `--wait-pipelines` forces the wait on every cell and
 * `--no-wait-pipelines` is the recorded waiver that turns it off on every cell.
 * A report records the wait each cell ran with (`pipelineWaitByCell`), and two
 * runs are compared or merged only where every shared cell waited alike. A
 * report written before the per-cell record reads its run-wide
 * `waitForPendingPipelines` for every cell (`waitedForCell`).
 *
 * @module Tools/visual-regression/lib/landing-cell-table
 */

import { OCEAN_EVOLVED_ADVANCE_SECONDS } from "./ocean-displacement-readback.mjs";
import { ProbeRefusal } from "./probe-refusal.mjs";

/**
 * The label of the FFT ocean's compute pass, the descriptor constant in
 * `packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts`
 * (`OCEAN_COMPUTE_PASS_DESCRIPTOR`); the PF-2 profiler keys passes by label.
 * A spec pins the two strings equal.
 */
export const OCEAN_COMPUTE_PASS_LABEL = "Ocean FFT single-pass compute chain";

/**
 * The cell table: cell name -> rig id and what the cell does on it.
 *
 * Fields beyond `rig` and `kind`: `identity` (a pixel-identity cell; the probe
 * wires the `window.onmessage` sentinel into it), `waitPipelines` (waits for
 * pending pipelines unless waived), `variants` (page name -> dials laid over
 * the rig), `readback` (`"ocean-displacement"`: the FFT ocean's displacement
 * field is read back after the capture), `crossRenderer` (the WebGPU capture
 * is diffed against the same run's WebGL capture), `perf` (the PF-1 / PF-2
 * window runs without `--perf`), `perfPass` (the GPU pass label the PF-2
 * window must list, judged by `lib/landing-verdicts.mjs`) and
 * `evolvedReadbackSeconds` (the displacement field is read a second time with
 * the clock that many seconds past the rig's, both kernels at the same evolved
 * wave time; lane TAR-ALDARION).
 */
export const LANDING_CELLS = Object.freeze({
  "E-D": Object.freeze({
    rig: "default-3d-pinned",
    kind: "capture",
    identity: true,
    waitPipelines: true,
  }),
  "E-D-HDR": Object.freeze({
    rig: "default-3d-hdr",
    kind: "capture",
    identity: true,
    waitPipelines: true,
  }),
  "E-O": Object.freeze({
    rig: "orbital-fulldisc-6608km-msaa4-single-deck",
    kind: "capture",
  }),
  "E-F": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p",
    kind: "capture",
  }),
  "E-G": Object.freeze({ rig: "cloud-underside-noon-cov055", kind: "capture" }),
  "E-G-night": Object.freeze({
    rig: "cloud-underside-night-cov055",
    kind: "capture",
  }),
  "E-H": Object.freeze({ rig: "globe-horizon-viewer", kind: "capture" }),
  "R-14": Object.freeze({ rig: "sky-only-sun-change", kind: "clock-steps" }),
  "E-T-water": Object.freeze({
    rig: "water-coast-50km-enhanced-ocean",
    kind: "device-loss",
  }),
  "E-T-flight": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p",
    kind: "device-loss",
  }),
  "E-T-resize": Object.freeze({
    rig: "globe-msaa4-resize-ladder",
    kind: "device-loss",
  }),
  "E-T-skybox": Object.freeze({
    rig: "skybox-source-swap",
    kind: "device-loss",
  }),
  // Not in DEFAULT_CELLS: a material-reading-the-tile-water-mask capture the
  // water landing asks for by name (`--cells E-M-water`).
  "E-M-water": Object.freeze({
    rig: "globe-material-water-mask",
    kind: "capture",
    waitPipelines: true,
  }),
  // Not in DEFAULT_CELLS (lane LINDISSE): the default viewer in 2D and in
  // Columbus view at the pinned instant, identity cells like E-D.
  "E-ID-2d": Object.freeze({
    rig: "default-2d-pinned",
    kind: "capture",
    identity: true,
    waitPipelines: true,
  }),
  "E-ID-cv": Object.freeze({
    rig: "default-columbus-pinned",
    kind: "capture",
    identity: true,
    waitPipelines: true,
  }),
  // The Chukotka antimeridian coast on both renderers, the WebGPU capture
  // diffed against the same run's WebGL capture. No band is registered yet:
  // the first capture registers it.
  "E-C-chukotka": Object.freeze({
    rig: "water-antimeridian-chukotka",
    kind: "capture",
    waitPipelines: true,
    crossRenderer: true,
  }),
  // The opt-in FFT ocean once per inverse-FFT kernel (Batch 1622), the
  // displacement field read back after each capture and compared between the
  // kernels, with the frame-time and per-pass window on each.
  "E-FFT-ifft": Object.freeze({
    rig: "ocean-fft-patch-rebase",
    kind: "capture",
    waitPipelines: true,
    readback: "ocean-displacement",
    // The t = 0 identity checks the transform of the initial spectrum only (the
    // kit receipt, finding 3); the evolved read checks a time-evolved sea.
    evolvedReadbackSeconds: OCEAN_EVOLVED_ADVANCE_SECONDS,
    perf: true,
    // The label WebGPUOceanRenderer.ts opens the iFFT chain with: PF-2 lists
    // the chain under it once the pass carries timestamp writes (kit-PF
    // receipt, finding 1).
    perfPass: OCEAN_COMPUTE_PASS_LABEL,
    variants: Object.freeze({
      stockham: Object.freeze({ waterOceanIfftKernel: "stockham" }),
      pingpong: Object.freeze({ waterOceanIfftKernel: "pingpong" }),
    }),
  }),
});

/** The default `--cells`: the standard set's capture cells. */
export const DEFAULT_CELLS = Object.freeze([
  "E-D",
  "E-D-HDR",
  "E-O",
  "E-F",
  "E-G",
  "E-G-night",
]);

/** The pages an E-T cell runs, in order. */
export const DEVICE_LOSS_PAGES = Object.freeze(["teardown", "forced-loss"]);

/** How the run's pending-pipeline wait was decided. */
export const PIPELINE_WAIT_MODES = Object.freeze({
  CELL_DEFAULT: "cell-default",
  FORCED: "forced",
  WAIVED: "waived",
});

/**
 * The comma list of a string option, trimmed, empties dropped.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * The pages a cell runs on each renderer, in order.
 *
 * @param {object} cell A {@link LANDING_CELLS} entry.
 * @returns {string[]}
 */
export function pagesOfCell(cell) {
  if (cell.kind === "device-loss") {
    return [...DEVICE_LOSS_PAGES];
  }
  if (cell.variants) {
    return Object.keys(cell.variants);
  }
  return ["scene"];
}

/**
 * The (cell, renderer, page) triples a run takes, cell-major, WebGL before
 * WebGPU, and for an E-T cell its two pages in {@link DEVICE_LOSS_PAGES}
 * order, for a variant cell its variants in table order.
 *
 * @param {{cells?: string, renderers?: string[]}} options
 * @param {Map<string, object>|Record<string, object>} rigsById
 * @returns {Array<{cell: string, rigId: string, kind: string,
 *   renderer: string, page: string}>}
 * @throws {ProbeRefusal} `cell-unknown` or `cell-rig-absent`.
 */
export function planLandingCells(options, rigsById) {
  const lookup = (id) =>
    rigsById instanceof Map ? rigsById.get(id) : rigsById?.[id];
  const names = splitList(options?.cells ?? DEFAULT_CELLS.join(","));
  const plan = [];
  for (const cell of names) {
    if (!Object.hasOwn(LANDING_CELLS, cell)) {
      throw new ProbeRefusal(
        "cell-unknown",
        `--cells ${cell} is not one of ${Object.keys(LANDING_CELLS).join(", ")}`,
        { cell },
      );
    }
    const { rig: rigId, kind } = LANDING_CELLS[cell];
    const rig = lookup(rigId);
    if (!rig) {
      throw new ProbeRefusal(
        "cell-rig-absent",
        `${cell}: rig ${rigId} is not in the registry`,
        { cell, rigId },
      );
    }
    for (const renderer of ["webgl", "webgpu"]) {
      if (!rig.renderers.includes(renderer)) {
        continue;
      }
      if (
        Array.isArray(options?.renderers) &&
        !options.renderers.includes(renderer)
      ) {
        continue;
      }
      for (const page of pagesOfCell(LANDING_CELLS[cell])) {
        plan.push({ cell, rigId, kind, renderer, page });
      }
    }
  }
  return plan;
}

/**
 * The rig a planned page stages: the cell's rig, with the page's variant
 * dials laid over its own when the cell has variants. Pure; the rig record is
 * not modified.
 *
 * @param {object} rig The cell's rig.
 * @param {{cell: string, page: string}} entry A planned page.
 * @returns {object}
 */
export function rigForPage(rig, entry) {
  const variants = LANDING_CELLS[entry.cell]?.variants;
  if (!variants || !Object.hasOwn(variants, entry.page)) {
    return rig;
  }
  return { ...rig, dials: { ...rig.dials, ...variants[entry.page] } };
}

/**
 * The pending-pipeline wait of every requested cell. Pure.
 *
 * @param {{cells?: string, waitPipelines?: boolean,
 *   noWaitPipelines?: boolean}} options
 * @returns {{mode: string, byCell: Record<string, boolean>}}
 * @throws {ProbeRefusal} `pipeline-wait-conflict` when both flags are given.
 */
export function pipelineWaitPlan(options) {
  const forced = options?.waitPipelines === true;
  const waived = options?.noWaitPipelines === true;
  if (forced && waived) {
    throw new ProbeRefusal(
      "pipeline-wait-conflict",
      "--wait-pipelines and --no-wait-pipelines contradict each other; give one",
      {},
    );
  }
  let mode = PIPELINE_WAIT_MODES.CELL_DEFAULT;
  if (forced) {
    mode = PIPELINE_WAIT_MODES.FORCED;
  } else if (waived) {
    mode = PIPELINE_WAIT_MODES.WAIVED;
  }
  const byCell = {};
  for (const cell of splitList(options?.cells ?? DEFAULT_CELLS.join(","))) {
    if (!Object.hasOwn(LANDING_CELLS, cell)) {
      continue;
    }
    byCell[cell] =
      mode === PIPELINE_WAIT_MODES.FORCED ||
      (mode === PIPELINE_WAIT_MODES.CELL_DEFAULT &&
        LANDING_CELLS[cell].waitPipelines === true);
  }
  return { mode, byCell };
}

/**
 * Whether `cell` waited for pending pipelines in `report`: its per-cell
 * record, else (a report written before it) the run-wide flag. Pure.
 *
 * @param {object|null|undefined} report A landing-cells report.
 * @param {string} cell
 * @returns {boolean}
 */
export function waitedForCell(report, cell) {
  const byCell = report?.pipelineWaitByCell;
  if (byCell && Object.hasOwn(byCell, cell)) {
    return byCell[cell] === true;
  }
  return report?.waitForPendingPipelines === true;
}

/**
 * The cells a report covers: those its pages, its arms and its per-cell wait
 * record name. Pure.
 *
 * @param {object|null|undefined} report
 * @returns {Set<string>}
 */
export function cellsOfReport(report) {
  const cells = new Set(Object.keys(report?.pipelineWaitByCell ?? {}));
  for (const page of report?.pages ?? []) {
    if (typeof page?.cell === "string") {
      cells.add(page.cell);
    }
  }
  for (const arm of Object.values(report?.arms ?? {})) {
    if (typeof arm?.cell === "string") {
      cells.add(arm.cell);
    }
  }
  return cells;
}

/**
 * The cells two reports both cover on which one waited for pending pipelines
 * and the other did not. Pure.
 *
 * @param {object} a
 * @param {object} b
 * @returns {string[]}
 */
export function pipelineWaitMismatches(a, b) {
  const inB = cellsOfReport(b);
  return [...cellsOfReport(a)]
    .filter((cell) => inB.has(cell))
    .filter((cell) => waitedForCell(a, cell) !== waitedForCell(b, cell));
}
