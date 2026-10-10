// stub-browser.mjs — the stub browser and the per-probe page answers that
// `voxel-probe-routing.spec.mjs` drives the eleven migrated voxel probes with.
//
// @purpose Stub browser, synthetic frames and per-probe page answers for voxel-probe-routing.spec.mjs: runs each migrated voxel probe's real descriptor through runProbe with every page.evaluate answered by a fixture, delivers injected console, page and gate errors through the listeners the probe attached, answers the kit's widget strip (with an injected leftover on request) and records each page's open-sequence calls and captures in order.
// @status ACTIVE
//
// Held here rather than in the spec, so the spec stays under the file-size
// rule (the capture-seam spec keeps its rig fixtures beside it the same way).
// Every answer is a fixture chosen to put a clause on a known side of its bar,
// so nothing here is evidence about the renderer; the spec's header says what
// the drive proves and what it cannot. An in-page callback the stub does not
// recognise throws, so a probe that grows a new one fails loudly rather than
// being answered with the wrong shape.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  isUnderTmpdir,
  mkLaneTmp,
  removeLaneTmp,
} from "../../../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../../../lib/png-rgba.mjs";
import { expectedC1113VoxelPickPipelineName } from "../../lib/c11-13-voxel-pick-pipeline-name.mjs";
import { expectedVoxelSampleIndex } from "../../lib/metrics/voxel-pick-coordinate.mjs";
import { runProbe } from "../../lib/probe-runtime.mjs";
import { descriptor as cellPick } from "../../probe-voxel-cell-pick.mjs";
import { descriptor as cylinder } from "../../probe-voxel-cylinder.mjs";
import { descriptor as ellipsoid } from "../../probe-voxel-ellipsoid.mjs";
import { descriptor as megatexture } from "../../probe-voxel-megatexture.mjs";
import { descriptor as octreeL3plus } from "../../probe-voxel-octree-l3plus.mjs";
import { descriptor as octree } from "../../probe-voxel-octree.mjs";
import { descriptor as parity } from "../../probe-voxel-parity.mjs";
import { descriptor as pickLogDepth } from "../../probe-voxel-pick-logdepth.mjs";
import { descriptor as pick } from "../../probe-voxel-pick.mjs";
import { descriptor as refinedPick } from "../../probe-voxel-refined-pick.mjs";
import { descriptor as userCustomShader } from "../../probe-voxel-user-customshader.mjs";

const R = 6378137.0;
const W = 256;
const H = 192;
const UNSTUBBED = Symbol("unstubbed");

// Faults the stub page can deliver (A8), each unique text so a receipt that
// publishes one can be searched for it.
const INJECTED_CONSOLE_ERROR = "injected console error (voxel routing spec)";
const INJECTED_PAGE_ERROR = "injected page error (voxel routing spec)";
export const INJECTED_DEVICE_ERROR =
  "GPUValidationError: injected device error (voxel routing spec)";
// Delivered on every stub page: a warning no error clause may count, and a
// trace line only the megatexture probe echoes.
export const BENIGN_WARNING = "a console warning every stub page carries";
export const ECHO_LINE = "PROBE: a trace line every stub page carries";
// The widget strip's answer: how many widgets it removed, and (A12) the
// class name of an element it injects as still lying over the canvas.
export const STRIPPED_WIDGETS = 9;
export const LEFTOVER_OVERLAY = "stub-overlay-over-the-canvas";

/** A console message shaped the way Playwright hands one to a listener. */
function consoleMessage(type, text) {
  return { type: () => type, text: () => text, location: () => null };
}

// ---------------------------------------------------------------------------
// Synthetic frames
// ---------------------------------------------------------------------------

/** A black frame (W x H unless sized) with the rectangles painted, as PNG bytes. */
function frame(rects = [], width = W, height = H) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = 255;
  }
  for (const { x0, y0, x1, y1, rgb } of rects) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4;
        const [r, g, b] = typeof rgb === "function" ? rgb(x, y) : rgb;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
      }
    }
  }
  return Buffer.from(encodeRgbaPng(data, width, height));
}

/** A lit block inside the parity region (x 51..191, y 38..153 at 256 x 192). */
const BOX = { x0: 80, y0: 60, x1: 160, y1: 130 };
const GREY_BOX = frame([{ ...BOX, rgb: [128, 128, 128] }]);
const GRADIENT_BOX = frame([
  { ...BOX, rgb: (x, y) => [(x - 80) * 3, (y - 60) * 3, 90] },
]);
const RAMP_BOX = frame([{ ...BOX, rgb: [200, 60, 40] }]);
/** A 5 x 5 lit block centred on each given window point. */
const litAt = (points) =>
  frame(
    points.map(([x, y]) => ({
      x0: x - 2,
      y0: y - 2,
      x1: x + 3,
      y1: y + 3,
      rgb: [200, 200, 200],
    })),
  );
const BLACK = frame();

// ---------------------------------------------------------------------------
// Pick fixtures
// ---------------------------------------------------------------------------

const readback = (tile, sample) => [
  Math.floor(tile / 255),
  tile % 255,
  Math.floor(sample / 255),
  sample % 255,
];
const CLEARED = [0, 0, 0, 0];

function staircaseColour(cell) {
  return [0.35 + 0.65 * cell.x, 0.15 + 0.28 * cell.y, 0.2 + 0.4 * cell.z, 1];
}

/** `probe-voxel-pick.mjs`'s page answer for one backend. */
function publicPickAnswer(arg, page) {
  const picks = arg.targets.map((t) =>
    t.cell
      ? {
          cell: {
            tileIndex: 0,
            sampleIndex: expectedVoxelSampleIndex(t.cell, arg.dims),
            color: staircaseColour(t.cell),
            isVoxelCell: true,
          },
          threw: null,
          stable: true,
          attempts: 3,
        }
      : { cell: null, threw: null, stable: false, attempts: 14 },
  );
  return {
    renderer: page.renderer,
    picks,
    offPick: { cell: null, threw: null, stable: false, attempts: 14 },
  };
}

/** `probe-voxel-refined-pick.mjs`'s page answer for one backend. */
function refinedPickAnswer(arg, page) {
  const dims = { x: arg.tile, y: arg.tile, z: arg.tile };
  const picks = arg.targets.map((t) => {
    const octantIndex = t.octant.x + 2 * t.octant.y + 4 * t.octant.z;
    const local = t.localCell;
    return {
      cell: {
        tileIndex: 1 + octantIndex,
        sampleIndex: expectedVoxelSampleIndex(local, dims),
        color: [
          octantIndex / 8,
          (local.x + 4 * local.y + 16 * local.z) / 64,
          0.5,
          1,
        ],
        isVoxelCell: true,
      },
      threw: null,
      stable: true,
      attempts: 3,
    };
  });
  return {
    renderer: page.renderer,
    slotCount: 9,
    lastTargetLevel: 1,
    picks,
    offPick: { cell: null, threw: null, stable: false, attempts: 16 },
  };
}

/** `probe-voxel-cell-pick.mjs`'s page answer for one part on one backend. */
function cellPickAnswer(arg, page, state) {
  const webgpu = page.renderer === "webgpu";
  const state3 = { master: false, frame: false, realized: false };
  const base = {
    renderer: page.renderer,
    usingRealData: true,
    uploadPhase: "done",
    hasPickVoxelCommand: true,
    objectPickOk: arg.part === "A" ? true : null,
    offPick: { bytes: CLEARED },
    pickLogDepthState: state3,
    pickVoxelPipelineName:
      arg.part === "C"
        ? "Voxel pickVoxel pipeline (userCustomShader#1)"
        : expectedC1113VoxelPickPipelineName(state3),
  };
  const tile4 = { x: arg.tile, y: arg.tile, z: arg.tile };
  if (arg.part === "A" || arg.part === "C") {
    const targets = arg.part === "A" ? arg.targetsA : arg.targetsC;
    return {
      ...base,
      picks: targets.map((t) => ({
        bytes: t.cell
          ? readback(0, expectedVoxelSampleIndex(t.cell, arg.dims))
          : CLEARED,
      })),
    };
  }
  if (arg.part === "B") {
    return {
      ...base,
      slotCount: 9,
      childSlots: [1, 2, 3, 4, 5, 6, 7, 8],
      lastTargetLevel: 1,
      tileResolves: webgpu
        ? null
        : arg.targetsB.map((t) =>
            t.expOctant ? { level: 1, ...t.expOctant } : null,
          ),
      picks: arg.targetsB.map((t) => {
        if (!t.expOctant) {
          return { bytes: CLEARED };
        }
        const slot = 1 + t.expOctant.x + 2 * t.expOctant.y + 4 * t.expOctant.z;
        const sample = expectedVoxelSampleIndex(t.localCell, tile4);
        return { bytes: readback(webgpu ? slot : 40, sample) };
      }),
    };
  }
  // Part D: level-3 tiles; WebGPU's slot is 73 + the tile's l3Slots index.
  const l3Slots = new Array(512).fill(-1);
  const picks = arg.targetsD.map((t) => {
    const index = t.expTile.x + 8 * t.expTile.y + 64 * t.expTile.z;
    const slot = state.corruptL3Slot ? 10 : 73 + index;
    l3Slots[index] = 73 + index;
    return { bytes: readback(webgpu ? slot : 200, 3) };
  });
  return {
    ...base,
    slotCount: 585,
    lastTargetLevel: 3,
    l3Slots,
    tileResolves: webgpu
      ? null
      : arg.targetsD.map((t) => ({ level: 3, ...t.expTile })),
    picks,
  };
}

// ---------------------------------------------------------------------------
// Octree fixtures
// ---------------------------------------------------------------------------

/**
 * Cells for one octree view: four discriminator cells that must read black
 * (empty at every judged level, whole cone clear) and two filled cells lit.
 */
function octreeCells(levels, discriminators) {
  const cells = [];
  for (let i = 0; i < 4; i++) {
    const frac = new Array(levels).fill(0);
    frac[0] = 0.5;
    cells.push({
      label: `disc${i}`,
      win: [30 + i * 40, 40],
      frac,
      coneAny: [true, ...new Array(levels - 1).fill(false)],
      ...Object.fromEntries(discriminators.map((d) => [d, true])),
    });
  }
  for (let i = 0; i < 2; i++) {
    cells.push({
      label: `fill${i}`,
      win: [60 + i * 80, 140],
      frac: new Array(levels).fill(0.5),
      coneAny: new Array(levels).fill(true),
    });
  }
  return cells;
}

/** The stub's answer to an octree `measureView`, keyed off the rig camera. */
function octreeView(arg, fine) {
  const distance = arg.camera.position[0] / R;
  const far = !arg.judgeTargets;
  const lastTargetLevel = far ? 0 : fine;
  return {
    distance,
    lastTargetLevel,
    targets: far
      ? []
      : octreeCells(fine + 1, fine === 2 ? ["discL1", "discL2"] : ["discL3"]),
    cellPx: 8,
    half: 1,
    internals:
      fine === 3
        ? {
            usingRealData: true,
            slotCount: 585,
            childPhase: "done",
            childSlots: [1, 2, 3, 4, 5, 6, 7, 8],
            l2Uploaded: 64,
            l3Uploaded: 512,
            lastTargetLevel,
          }
        : undefined,
  };
}

const FILLED_WINDOWS = [
  [60, 140],
  [140, 140],
];

// ---------------------------------------------------------------------------
// Megatexture fixtures (the reupload policy spec's own valid evidence shape)
// ---------------------------------------------------------------------------

function snapshot(resident, evictionCount, generation, requestSerial = 1) {
  return {
    usingRealData: true,
    slotCount: 13,
    l2Dynamic: true,
    l2PoolSize: 4,
    childPhase: "done",
    childUploaded: 8,
    resident: [...resident],
    slotsUsed: [9, 10, 11, 12],
    requestSerials: Array(4).fill(requestSerial),
    slotGenerations: Array(4).fill(generation),
    evictionCount,
    demandCount: 11,
    demandLevel: 2,
    lastTargetLevel: 2,
    maxResident: 4,
  };
}

// ---------------------------------------------------------------------------
// The eleven probes
// ---------------------------------------------------------------------------

export const PROBES = [
  {
    descriptor: parity,
    file: "probe-voxel-parity.mjs",
    renderers: ["webgl", "webgpu"],
    captures: [
      "probe-voxel-parity-webgl",
      "probe-voxel-parity-webgpu",
      "probe-voxel-cells-webgl-front",
      "probe-voxel-cells-webgl-top",
      "probe-voxel-cells-webgpu-front",
      "probe-voxel-cells-webgpu-top",
    ],
    failing: "A/footprint-match/run0",
    // Console-only clauses: the gate's device errors are published, ungated.
    errorClauses: ["A/no-console-errors/run0", "B/no-console-errors/run0"],
    deviceClauses: [],
    evaluate(source, arg, page, state) {
      if (source.includes("Cesium3DTilesVoxelProvider.fromUrl")) {
        page.kind = "box";
        return {
          renderer: page.renderer,
          usingRealData: true,
          uploadPhase: "done",
        };
      }
      if (source.includes("window.__voxelProbe = { C, scene, prim, R, dims")) {
        page.kind = "cells";
        return {
          usingRealData: true,
          uploadPhase: "done",
          hasConvention: true,
          conventionYUp: true,
        };
      }
      if (source.includes("filledFrac")) {
        return [
          { label: "lit", win: [40, 40], filledFrac: 0.5, expected: "filled" },
          { label: "dark", win: [200, 150], filledFrac: 0, expected: "empty" },
        ];
      }
      return UNSTUBBED;
    },
    frame(page, index, state) {
      if (page.kind === "box") {
        return state.fail && page.renderer === "webgpu"
          ? frame([
              { x0: 170, y0: 140, x1: 190, y1: 152, rgb: [128, 128, 128] },
            ])
          : GREY_BOX;
      }
      return litAt([[40, 40]]);
    },
  },
  {
    descriptor: pick,
    file: "probe-voxel-pick.mjs",
    renderers: ["webgl", "webgpu"],
    captures: ["probe-voxel-pick-webgl", "probe-voxel-pick-webgpu"],
    failing: "target/y0z0/run0",
    errorClauses: ["errors/run0"],
    deviceClauses: ["errors/run0"],
    evaluate(source, arg, page, state) {
      if (source.includes("scene.pickVoxel(pos)")) {
        const answer = publicPickAnswer(arg, page);
        if (state.fail && page.renderer === "webgpu") {
          answer.picks[0].cell.sampleIndex += 1;
        }
        return answer;
      }
      return UNSTUBBED;
    },
    frame: () => BLACK,
  },
  {
    descriptor: refinedPick,
    file: "probe-voxel-refined-pick.mjs",
    renderers: ["webgl", "webgpu"],
    captures: [
      "probe-voxel-refined-pick-webgl",
      "probe-voxel-refined-pick-webgpu",
    ],
    failing: "webgpu-refined/run0",
    errorClauses: ["errors/run0"],
    deviceClauses: ["errors/run0"],
    evaluate(source, arg, page, state) {
      if (source.includes("scene.pickVoxel(pos)")) {
        const answer = refinedPickAnswer(arg, page);
        if (state.fail && page.renderer === "webgpu") {
          answer.slotCount = 1;
        }
        return answer;
      }
      return UNSTUBBED;
    },
    frame: () => BLACK,
  },
  {
    descriptor: pickLogDepth,
    file: "probe-voxel-pick-logdepth.mjs",
    renderers: ["webgpu"],
    captures: ["probe-voxel-pick-logdepth"],
    failing: "occlusion/run0",
    errorClauses: ["errors/run0"],
    deviceClauses: ["errors/run0"],
    evaluate(source, arg, page, state) {
      if (source.includes("_pickLogDepthWriteEnabled = true")) {
        return {
          renderer: "webgpu",
          introspect: {
            pickName: "Voxel pick pipeline [ld]",
            pickDepthWrite: true,
            pickVoxelName: "Voxel pickVoxel pipeline [ld]",
            pickVoxelDepthWrite: true,
            gate: true,
          },
          cellPicks: arg.targets.map((t) => ({
            cell: {
              tileIndex: 0,
              sampleIndex: expectedVoxelSampleIndex(t.cell, arg.dims),
              isVoxelCell: true,
            },
          })),
          objectPick: { hit: true, isVoxel: true },
          occlusion: {
            hit: true,
            isBlocker: !state.fail,
            isBigVoxel: state.fail === true,
          },
        };
      }
      return UNSTUBBED;
    },
    frame: () => BLACK,
  },
  {
    descriptor: cellPick,
    file: "probe-voxel-cell-pick.mjs",
    renderers: ["webgl", "webgpu"],
    captures: ["A", "B", "C", "D"].flatMap((part) => [
      `probe-voxel-cell-pick-${part}-webgl`,
      `probe-voxel-cell-pick-${part}-webgpu`,
    ]),
    failing: "D/l3-diag-y4z4/run0",
    errorClauses: ["errors/run0"],
    deviceClauses: ["errors/run0"],
    evaluate(source, arg, page, state) {
      if (source.includes("scene._picking.pickVoxelCoordinate")) {
        return cellPickAnswer(arg, page, {
          corruptL3Slot: state.fail === true && page.renderer === "webgpu",
        });
      }
      return UNSTUBBED;
    },
    frame: () => BLACK,
  },
  ...[
    [ellipsoid, "ellipsoid", "ELLIPSOID"],
    [cylinder, "cylinder", "CYLINDER"],
  ].map(([descriptor, shape, type]) => ({
    descriptor,
    file: `probe-voxel-${shape}.mjs`,
    renderers: ["webgl", "webgpu"],
    captures: [`probe-voxel-${shape}-webgl`, `probe-voxel-${shape}-webgpu`],
    failing: "cell-colours-match/run0",
    errorClauses: ["no-console-errors/run0"],
    deviceClauses: [],
    evaluate(source, arg, page) {
      if (source.includes(`VoxelShapeType.${type}`)) {
        return {
          renderer: page.renderer,
          usingRealData: true,
          uploadPhase: "done",
          colorDescName: "Voxel color pipeline (userCustomShader#7)",
        };
      }
      return UNSTUBBED;
    },
    frame(page, index, state) {
      return state.fail && page.renderer === "webgpu"
        ? frame([{ ...BOX, rgb: (x, y) => [(y - 60) * 3, (x - 80) * 3, 90] }])
        : GRADIENT_BOX;
    },
  })),
  {
    descriptor: userCustomShader,
    file: "probe-voxel-user-customshader.mjs",
    renderers: ["webgl", "webgpu"],
    captures: [
      "probe-voxel-user-customshader-webgl",
      "probe-voxel-user-customshader-webgpu",
    ],
    failing: "ramp-applied/run0",
    errorClauses: ["no-console-errors/run0"],
    deviceClauses: [],
    evaluate(source, arg, page) {
      if (source.includes("wgslFragmentShaderText: wgsl")) {
        return {
          renderer: page.renderer,
          propName: "a",
          usingRealData: true,
          uploadPhase: "done",
          colorDescName: "Voxel color pipeline (userCustomShader#3)",
          cmdPipelineIsColor: true,
        };
      }
      return UNSTUBBED;
    },
    frame(page, index, state) {
      return state.fail && page.renderer === "webgpu"
        ? frame([{ ...BOX, rgb: [120, 120, 120] }])
        : RAMP_BOX;
    },
  },
  ...[
    [octree, "octree", 2],
    [octreeL3plus, "octree-l3plus", 3],
  ].map(([descriptor, name, fine]) => ({
    descriptor,
    file: `probe-voxel-${name}.mjs`,
    renderers: ["webgl", "webgpu"],
    captures: ["webgl", "webgpu"].flatMap((renderer) =>
      ["close", "close2", "far"].map(
        (view) => `probe-voxel-${name}-${renderer}-${view}`,
      ),
    ),
    failing: "webgpu-close2/run0",
    errorClauses: ["no-console-errors/run0"],
    deviceClauses: [],
    evaluate(source, arg, page) {
      if (source.includes("rayHits")) {
        const view = octreeView(arg, fine);
        page.view = view;
        return view;
      }
      if (source.includes("providerFactorySrc")) {
        return fine === 2
          ? {
              usingRealData: true,
              uploadPhase: "done",
              slotCount: 73,
              childPhase: "done",
              childSlots: [1, 2, 3, 4, 5, 6, 7, 8],
              l2Uploaded: 64,
              lastTargetLevelClose: 2,
            }
          : undefined;
      }
      return UNSTUBBED;
    },
    frame(page, index, state) {
      const view = page.view;
      if (!view || view.targets.length === 0) {
        // The far view; A11 hands WebGPU a far frame `resizeFar` rows taller
        // (or shorter, when negative).
        return state.resizeFar && page.renderer === "webgpu"
          ? frame([], W, H + state.resizeFar)
          : BLACK;
      }
      const close2 = Math.abs(view.distance - (fine === 2 ? 5 : 3.5)) < 1e-9;
      return state.fail && page.renderer === "webgpu" && close2
        ? litAt([...FILLED_WINDOWS, [30, 40]])
        : litAt(FILLED_WINDOWS);
    },
  })),
  {
    descriptor: megatexture,
    file: "probe-voxel-megatexture.mjs",
    renderers: ["webgpu"],
    captures: [
      "probe-voxel-megatexture",
      "probe-voxel-megatexture-streaming",
      "probe-voxel-evict-cornerA1",
      "probe-voxel-evict-cornerA2",
    ],
    failing: "part3/reupload-evidence/run0",
    // PART 3's console count is read by the shared reupload assessor.
    errorClauses: [
      "part1/no-console-errors/run0",
      "part2/no-console-errors/run0",
      "part3/reupload-evidence/run0",
    ],
    deviceClauses: [],
    evaluate(source, arg, page, state) {
      if (source.includes("Cesium3DTilesVoxelProvider.fromUrl")) {
        return {
          providerDims: { x: 2, y: 4, z: 3 },
          usingRealData: true,
          uploadPhase: "done",
          uploadDims: { w: 2, h: 3, d: 4 },
          uploadFormat: "rgba32float",
        };
      }
      if (source.includes("const setCam = (pose)")) {
        const stream = {
          usingRealData: true,
          phase: "done",
          slotCount: 73,
        };
        return {
          far: {
            ...stream,
            childPhase: "loading",
            childUploaded: 0,
            l2Uploaded: 0,
            demandLevel: 0,
            lastTargetLevel: 0,
          },
          near: {
            ...stream,
            childPhase: "done",
            childUploaded: 8,
            l2Uploaded: 64,
            demandLevel: 2,
            lastTargetLevel: 2,
          },
          returnFar: {
            ...stream,
            childPhase: "done",
            childUploaded: 8,
            l2Uploaded: 64,
            demandLevel: 0,
            lastTargetLevel: 0,
          },
        };
      }
      if (source.includes("_webgpuVoxelAtlasMaxSlots = 13")) {
        return snapshot([31, 42, 43, 46], 0, 1);
      }
      if (source.includes("renderLeg")) {
        const restored = snapshot([31, 42, 43, 46], 8, 3, 2);
        return {
          converged: true,
          attempts: [{ a: restored, b: null }],
          finalA: restored,
        };
      }
      if (source.includes("P.setCorner(-1)")) {
        return snapshot([0, 1, 2, 4], 4, 2);
      }
      return UNSTUBBED;
    },
    frame(page, index, state) {
      // An A2 one row shorter than A1: the pair cannot be compared (A9).
      if (state.resizeA2 && page.shotsTaken === 1 && page.part3) {
        return frame(
          [{ x0: 60, y0: 50, x1: 200, y1: 150, rgb: [150, 150, 150] }],
          W,
          H - 1,
        );
      }
      // PART 3's second capture is corner A2; a failing run changes it.
      if (state.fail && page.shotsTaken === 1 && page.part3) {
        return frame([
          { x0: 60, y0: 50, x1: 200, y1: 150, rgb: [30, 200, 30] },
        ]);
      }
      return frame([
        { x0: 60, y0: 50, x1: 200, y1: 150, rgb: [150, 150, 150] },
      ]);
    },
  },
];

// ---------------------------------------------------------------------------
// The stub browser
// ---------------------------------------------------------------------------

function fakePage(entry, log, state) {
  const listeners = { console: new Set(), pageerror: new Set() };
  const emit = (event, payload) => {
    for (const listener of listeners[event]) {
      listener(payload);
    }
  };
  // A fault is injected on every page of the chosen backend.
  const injected = (kind) =>
    state.inject?.kind === kind && state.inject.renderer === page.renderer;
  // Every page keeps its own ordered record of the calls the open sequence
  // and the captures make (A2 reads it; the stub cannot run page functions,
  // so their order and arguments are what can be pinned here).
  const events = [];
  log.pages.push(events);
  const page = {
    renderer: null,
    shotsTaken: 0,
    armed: false,
    events,
    on(event, listener) {
      listeners[event]?.add(listener);
    },
    off(event, listener) {
      listeners[event]?.delete(listener);
    },
    async addInitScript(script) {
      events.push({ kind: "init", script });
    },
    async goto(url) {
      events.push({ kind: "goto" });
      log.gotos.push(url);
      page.renderer = new URL(url).searchParams.get("renderer");
      // Delivered the way Playwright delivers them: to the listeners already
      // attached when the page loads.
      emit("console", consoleMessage("warning", BENIGN_WARNING));
      emit("console", consoleMessage("log", ECHO_LINE));
      if (injected("console")) {
        emit("console", consoleMessage("error", INJECTED_CONSOLE_ERROR));
      }
      if (injected("pageerror")) {
        emit("pageerror", new Error(INJECTED_PAGE_ERROR));
      }
    },
    async waitForFunction(fn, arg, options) {
      events.push({ kind: "wait", source: String(fn), arg, options });
      return true;
    },
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("__captureLiveness")) {
        return { gateArmed: true, deviceLost: null, frameNumber: 42 };
      }
      if (source.includes("__armWebGPUDevice")) {
        events.push({ kind: "arm" });
        page.armed = true;
        return { armed: 1, found: 1, total: 1 };
      }
      if (
        source.includes(".cesium-navigation-help") &&
        source.includes("leftovers")
      ) {
        // The kit's widget strip. A12 leaves an element over the canvas on
        // every page of the chosen backend.
        events.push({ kind: "strip" });
        return {
          removed: STRIPPED_WIDGETS,
          leftovers:
            state.leftover?.renderer === page.renderer
              ? [LEFTOVER_OVERLAY]
              : [],
        };
      }
      if (source.includes("__webgpuGate")) {
        // The gate hears only a device it was armed on.
        return {
          errors:
            page.armed && injected("device") ? [INJECTED_DEVICE_ERROR] : [],
          deviceLost: null,
          armedDevices: page.armed ? 1 : 0,
        };
      }
      if (source.includes("_webgpuVoxelAtlasMaxSlots = 13")) {
        page.part3 = true;
      }
      const answer = entry.evaluate(source, arg, page, state);
      if (answer === UNSTUBBED) {
        throw new Error(
          `${entry.file}: unstubbed page.evaluate: ${source.slice(0, 160)}`,
        );
      }
      return answer;
    },
    locator(selector) {
      log.selectors.push(selector);
      return {
        async count() {
          return 1;
        },
        async screenshot() {
          events.push({ kind: "shot" });
          const png = entry.frame(page, page.shotsTaken, state);
          page.shotsTaken += 1;
          return png;
        },
      };
    },
    async close() {},
  };
  return page;
}

function fakeLaunch(entry, log, state) {
  return async () => {
    log.launches += 1;
    let connected = true;
    return {
      async newPage(options) {
        log.viewports.push(options?.viewport ?? null);
        return fakePage(entry, log, state);
      },
      async close() {
        log.closes += 1;
        connected = false;
      },
      isConnected: () => connected,
    };
  };
}

export async function drive(entry, { argv = [], descriptor, ...state } = {}) {
  // Scratch is taken through the kit's lane temp (one sweepable root per
  // lane). The caller removes it; a drive that throws removes it here.
  const root = mkLaneTmp("voxel-routing-");
  // Destructive-test discipline: everything this spec writes is under
  // os.tmpdir(), asserted rather than assumed.
  assert.ok(isUnderTmpdir(root), "sandbox must live under os.tmpdir()");
  const out = path.join(root, "out");
  const log = {
    gotos: [],
    selectors: [],
    viewports: [],
    pages: [],
    printed: [],
    launches: 0,
    closes: 0,
  };
  // The probes print their operator report; the runner's output is not the
  // place for eleven of them, so the report is kept in the log instead.
  const print = console.log;
  console.log = (...parts) => log.printed.push(parts.join(" "));
  let code;
  try {
    code = await runProbe(descriptor ?? entry.descriptor, {
      argv: [
        "--repository-root",
        root,
        "--output",
        out,
        "--no-serve-built",
        "--port",
        "8137",
        ...argv,
      ],
      now: () => Date.UTC(2026, 8, 26, 22, 0, 0),
      launch: fakeLaunch(entry, log, state),
    });
  } catch (error) {
    removeLaneTmp(root);
    throw error;
  } finally {
    console.log = print;
  }
  return { code, root, out, log };
}

/** A drive's receipt. */
export function readReport(out, entry) {
  return JSON.parse(
    readFileSync(
      path.join(out, `${entry.descriptor.name}-report.json`),
      "utf8",
    ),
  );
}

/** The ids of a receipt's red verdicts, sorted. */
export function redIds(report) {
  return report.verdicts
    .filter((verdict) => verdict.pass !== true)
    .map((verdict) => verdict.id)
    .sort();
}
