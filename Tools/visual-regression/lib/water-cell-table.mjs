// water-cell-table.mjs — the water landing's cell table, bands and the pure planning over them.
//
// @purpose Cell table piece for probe-water-cells.mjs: WATER_CELLS (the leg-2 mask pairs and cell 1f's demo, the default run), WATER_CAPTURE_CELLS (the opt-in capture-only cells: the water bookmark rigs and the offline Kauai shelf pair, no band), the sheet's pre-registered WATER_BANDS, the declared arms, the demo id and the wave-epoch dial, plus the pure planning over them: splitList, planWaterCells (the page plan), stageGaps (blocking dials vs absent water dials), stageHandlesDial, waterStagePlan and waveEpochReadback (the pinned wave epoch).
// @status ACTIVE
//
// WHY A PIECE. The table and its planning moved out of
// `probe-water-cells.mjs` when the probe passed 1,000 lines
// (DX-KIT-DECOMPOSE-RUNTIME-WATER), the same move `landing-cell-table.mjs`
// made for the landing probe. The probe re-exports every name it exported
// before, so its importers (the water specs, the regime runners) are
// unchanged. Everything here is pure: no browser, no filesystem.

import { ProbeRefusal } from "./probe-runtime.mjs";
import {
  LANDING_WATER_DIALS,
  landingStagePayload,
} from "./landing-cell-stage.mjs";

/** The scene table: cell name -> its rigs and what the cell measures. */
export const WATER_CELLS = Object.freeze({
  "great-lakes": Object.freeze({
    kind: "mask-pair",
    on: "water-great-lakes",
    off: "water-great-lakes-off",
    effectFloorPct: 0.5,
    waveEpochRepeat: true,
  }),
  "coast-50km": Object.freeze({
    kind: "mask-pair",
    on: "water-coast-50km",
    off: "water-coast-50km-off",
    effectFloorPct: 5,
    waveEpochRepeat: true,
  }),
  "orbit-disc": Object.freeze({
    kind: "mask-pair",
    on: "water-orbit-disc",
    off: "water-orbit-disc-off",
    // Seat ruling S6 (pre-registered before the next Edge run): the Edge
    // round-2 orbital disc measured 3.325 % (WebGL) and 3.269 % (WebGPU),
    // agreeing within 0.06 pp, so the floor is 2 % rather than 5 %.
    effectFloorPct: 2,
    waveEpochRepeat: true,
  }),
  "great-lakes-lakeonly": Object.freeze({
    kind: "mask-pair",
    on: "water-great-lakes-lakeonly",
    off: "water-great-lakes-off",
    effectCeilingOverOffRepeatPp: 0.05,
  }),
  "1f": Object.freeze({
    kind: "sandcastle2-demo",
    rig: "sandcastle2-globe-materials-water-mask",
  }),
});

/** The cells a run without `--cells` takes: exactly the banded table. */
export const WATER_DEFAULT_CELLS = Object.freeze(Object.keys(WATER_CELLS));

/**
 * The opt-in capture cells (`--cells bookmark-sunset-glint`): a rig is staged,
 * settled and element-captured, and a person or a later check reads the
 * picture. They carry NO pre-registered band, so a verdict never judges them
 * beyond the stage and the device-fault gate. A single rig is page `capture`;
 * the offline Kauai shelf pair is `on` / `off` like a mask pair; the one
 * Sandcastle 2 bookmark is page `demo` and, like cell 1f, is NOT RUN without
 * Cesium ion.
 */
export const WATER_CAPTURE_CELLS = Object.freeze({
  "bookmark-bahamas-photic-dive": Object.freeze({
    kind: "capture-single",
    rig: "water-bookmark-bahamas-photic-dive",
  }),
  "bookmark-cairo-nile": Object.freeze({
    kind: "capture-single",
    rig: "water-bookmark-cairo-nile",
  }),
  "bookmark-global-water-weather": Object.freeze({
    kind: "capture-demo",
    rig: "water-bookmark-global-water-weather",
    galleryId: "webgpu-global-water-weather",
  }),
  "bookmark-ilulissat-ice": Object.freeze({
    kind: "capture-single",
    rig: "water-bookmark-ilulissat-ice",
  }),
  "bookmark-kauai-reef": Object.freeze({
    kind: "capture-single",
    rig: "water-bookmark-kauai-reef",
  }),
  "bookmark-mariana-trench": Object.freeze({
    kind: "capture-single",
    rig: "water-bookmark-mariana-trench",
  }),
  "bookmark-sunset-glint": Object.freeze({
    kind: "capture-single",
    rig: "water-bookmark-sunset-glint",
  }),
  "bathymetry-offline": Object.freeze({
    kind: "capture-pair",
    on: "water-bathymetry-offline",
    off: "water-bathymetry-offline-off",
  }),
});

/** The sheet's pre-registered bands (EDGE_LEG_WATER.md leg 1 cell 1f, leg 2). */
export const WATER_BANDS = Object.freeze({
  mismatchTolerance: 16,
  effectTolerance: 8,
  parityAllowancePp: 1.0,
  parityRepeatMultiplier: 3,
  effectAgreementRelative: 0.1,
  effectAgreementAbsolutePp: 0.3,
  demoFloorPp: 0.05,
  demoRepeatMultiplier: 2,
  waveEpochRepeatPp: 0.05,
});

/** The arms a run declares. */
export const WATER_ARMS = Object.freeze(["before", "after"]);

/** The gallery id cell 1f's rig opens (its served files are asserted). */
export const WATER_DEMO_ID = "globe-materials-water-mask-elevation-map";

/** The rig dial that pins the water's wave clock (W-A3, cell 2g). */
export const WAVE_EPOCH_DIAL = "waterSimulationEpoch";

/**
 * A cell's table row: the banded table's, else the capture table's.
 *
 * @param {string} cell
 * @returns {object|undefined}
 */
export function waterCellSpec(cell) {
  if (Object.hasOwn(WATER_CELLS, cell)) {
    return WATER_CELLS[cell];
  }
  return Object.hasOwn(WATER_CAPTURE_CELLS, cell)
    ? WATER_CAPTURE_CELLS[cell]
    : undefined;
}

/** Whether a cell is an opt-in capture cell (no band, not in the default run). */
export function isWaterCaptureCell(cell) {
  return Object.hasOwn(WATER_CAPTURE_CELLS, cell);
}

/** Whether a cell kind opens a Sandcastle 2 demo (cell 1f and a capture-demo). */
export function usesDemoPage(kind) {
  return kind === "sandcastle2-demo" || kind === "capture-demo";
}

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
 * The pages a run takes, cell-major in `--cells` order, WebGL before WebGPU,
 * and for a mask pair the ON rig before its OFF twin. Pure.
 *
 * @param {{cells?: string, renderers?: string[]}} options
 * @param {Map<string, object>} rigsById
 * @returns {Array<{cell: string, kind: string, rigId: string,
 *   variant: string, renderer: string}>}
 * @throws {ProbeRefusal} `cell-unknown` or `cell-rig-absent`.
 */
export function planWaterCells(options, rigsById) {
  const names = splitList(options?.cells ?? WATER_DEFAULT_CELLS.join(","));
  const plan = [];
  for (const cell of names) {
    const spec = waterCellSpec(cell);
    if (spec === undefined) {
      throw new ProbeRefusal(
        "cell-unknown",
        `--cells ${cell} is not one of ${[...WATER_DEFAULT_CELLS, ...Object.keys(WATER_CAPTURE_CELLS)].join(", ")}`,
        { cell },
      );
    }
    const variants =
      spec.kind === "mask-pair" || spec.kind === "capture-pair"
        ? [
            ["on", spec.on],
            ["off", spec.off],
          ]
        : [[usesDemoPage(spec.kind) ? "demo" : "capture", spec.rig]];
    for (const [, rigId] of variants) {
      if (!rigsById.has(rigId)) {
        throw new ProbeRefusal(
          "cell-rig-absent",
          `${cell}: rig ${rigId} is not in the registry`,
          { cell, rigId },
        );
      }
    }
    for (const renderer of ["webgl", "webgpu"]) {
      if (
        Array.isArray(options?.renderers) &&
        !options.renderers.includes(renderer)
      ) {
        continue;
      }
      for (const [variant, rigId] of variants) {
        if (!rigsById.get(rigId).renderers.includes(renderer)) {
          continue;
        }
        plan.push({ cell, kind: spec.kind, rigId, variant, renderer });
      }
    }
  }
  return plan;
}

/**
 * The water dials a rig sets to `true` that the tree did not take, and every
 * other dial that did not apply. The wave epoch is neither: only cell 2g
 * reads it, so a page whose epoch did not apply still runs. Pure.
 *
 * @param {object} rig
 * @param {object} staged `stageLandingCellInPage`'s answer.
 * @returns {{blocking: string[], waterAbsent: string[]}}
 */
export function stageGaps(rig, staged) {
  const blocking = [];
  const waterAbsent = [];
  for (const key of staged?.notApplied ?? []) {
    if (key === WAVE_EPOCH_DIAL) {
      continue;
    }
    if (!LANDING_WATER_DIALS.includes(key)) {
      blocking.push(key);
    } else if (rig?.dials?.[key] === true) {
      waterAbsent.push(key);
    }
  }
  return { blocking, waterAbsent };
}

/**
 * Whether the stage's Node half accepts a dial: it refuses one it does not
 * know with `rig-dial-unsupported`, before any page is involved. Pure.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {Function} [payloadOf] The stage's payload builder.
 * @returns {boolean}
 */
export function stageHandlesDial(key, value, payloadOf = landingStagePayload) {
  try {
    payloadOf({
      id: `probe-water-cells:${key}`,
      camera: null,
      dials: { [key]: value },
    });
    return true;
  } catch (error) {
    if (error?.reason === "rig-dial-unsupported") {
      return false;
    }
    throw error;
  }
}

/**
 * The rig the stage is handed, and what the probe knows about the rig's wave
 * epoch before the page opens. A rig without the epoch dial is staged as it
 * is; with it, on a stage that takes the dial, as it is too; on a stage that
 * does not, without the dial (the stage would refuse the whole rig), the epoch
 * then reading `applied: false`. Pure.
 *
 * @param {object} rig
 * @param {{handles?: (key: string, value: unknown) => boolean}} [io]
 * @returns {{rig: object, epoch: {requested: unknown,
 *   stageHandles: boolean}|null}}
 */
export function waterStagePlan(rig, io = {}) {
  const handles = io.handles ?? stageHandlesDial;
  if (!Object.hasOwn(rig?.dials ?? {}, WAVE_EPOCH_DIAL)) {
    return { rig, epoch: null };
  }
  const requested = rig.dials[WAVE_EPOCH_DIAL];
  if (handles(WAVE_EPOCH_DIAL, requested)) {
    return { rig, epoch: { requested, stageHandles: true } };
  }
  const dials = { ...rig.dials };
  delete dials[WAVE_EPOCH_DIAL];
  return { rig: { ...rig, dials }, epoch: { requested, stageHandles: false } };
}

/**
 * The page's wave-epoch readback: the stage's own answer where it staged the
 * dial, else `applied: false` with the reason. Null for a rig without the
 * dial. Pure.
 *
 * @param {{requested: unknown, stageHandles: boolean}|null} epoch
 *   {@link waterStagePlan}'s `epoch`.
 * @param {object} staged `stageLandingCellInPage`'s answer.
 * @returns {{requested: unknown, observed: unknown, applied: boolean,
 *   reason?: string}|null}
 */
export function waveEpochReadback(epoch, staged) {
  if (epoch === null || epoch === undefined) {
    return null;
  }
  if (epoch.stageHandles !== true) {
    return {
      requested: epoch.requested,
      observed: null,
      applied: false,
      reason: `the stage at this tree has no ${WAVE_EPOCH_DIAL} handler (rig-dial-unsupported); the dial was not staged`,
    };
  }
  const dial = staged?.dials?.[WAVE_EPOCH_DIAL];
  if (!dial || typeof dial !== "object") {
    return {
      requested: epoch.requested,
      observed: null,
      applied: false,
      reason: `the stage returned no ${WAVE_EPOCH_DIAL} readback`,
    };
  }
  return {
    requested: dial.requested ?? epoch.requested,
    observed: dial.observed ?? null,
    applied: dial.applied === true,
    ...(typeof dial.reason === "string" && { reason: dial.reason }),
  };
}

/**
 * The gallery demo a cell opens, or null: cell 1f's, or a capture-demo's own.
 *
 * @param {string} cell
 * @returns {string|null}
 */
export function waterCellGalleryId(cell) {
  const spec = waterCellSpec(cell);
  if (!spec) {
    return null;
  }
  return (
    spec.galleryId ?? (spec.kind === "sandcastle2-demo" ? WATER_DEMO_ID : null)
  );
}

/**
 * What a run captured for each capture cell: the rigs, every capture with its
 * digest, and the pages that were NOT RUN with their reasons. It judges
 * nothing: a capture cell has no band. Pure.
 *
 * @param {object[]} records Every page record of the run.
 * @returns {Record<string, {kind: string, rigs: string[],
 *   captures: object[], notRun: string[]}>}
 */
export function summarizeCaptureCells(records) {
  const summary = {};
  for (const record of records ?? []) {
    if (!isWaterCaptureCell(record.cell)) {
      continue;
    }
    const entry = (summary[record.cell] ??= {
      kind: WATER_CAPTURE_CELLS[record.cell].kind,
      rigs: [],
      captures: [],
      notRun: [],
    });
    if (!entry.rigs.includes(record.rig)) {
      entry.rigs.push(record.rig);
    }
    if (record.capture) {
      entry.captures.push({
        variant: record.variant,
        renderer: record.renderer,
        run: record.run,
        path: record.capture.path,
        sha256: record.capture.sha256,
      });
    }
    if (record.notRun !== null && record.notRun !== undefined) {
      entry.notRun.push(
        `${record.variant}:${record.renderer}:run${record.run}: ${record.notRun}`,
      );
    }
  }
  return summary;
}
