#!/usr/bin/env node
// Probe: GPU texture lifetime across scene-framebuffer rebuilds and sky-box
// source swaps, on the shared runtime.
// @purpose Resource-lifetime regression probe on the shared runtime: the default globe at 4x MSAA through a resize ladder (rig globe-msaa4-resize-ladder) and the default sky box swapped twice in place (rig skybox-source-swap), on both renderers, recording per-label texture create/destroy counts, uncaptured WebGPU errors, destroyed-texture console lines, the sky-corner colour and the cross-renderer diff.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// WHAT IT MEASURES. Destruction is not visible in a frame, so each WebGPU cell
// also carries `lib/gpu-texture-census.mjs`: how many textures under the label
// the fix concerns were created and how many destroyed by the end of the steps.
// The frames are a regression guard. Errors are tallied per texture label
// (`tallyErrorsByLabel`), because a resize can raise destroyed-texture lines
// on textures this probe does not concern; BEFORE and AFTER compare per label.
//
// SCENES (`--scene`, comma-separated; default both):
//   resize — rig `globe-msaa4-resize-ladder`, steps `lib/globe-resize-steps.mjs`.
//            Census label `SceneFramebuffer-Color_depth_resolve_ss`.
//   skybox — rig `skybox-source-swap`, steps `lib/skybox-swap-steps.mjs`.
//            Census label `CubeMapPanorama-cubemap`; the sky corners must read
//            the last swap's colour on both renderers.
//
// The probe declares cells; the browser, the origin, the served-build
// preflight, the Edge slot, the deadline and the receipt belong to the runtime.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { DET_BROWSER_SETUP } from "./lib/determinism-kit.mjs";
import { runGlobeResizeSteps } from "./lib/globe-resize-steps.mjs";
import {
  gpuTextureCensusInit,
  readGpuTextureCensus,
  summarizeTextureCensus,
} from "./lib/gpu-texture-census.mjs";
import { diffImages } from "./lib/image-diff.mjs";
import { cornerMeans, dominantChannel } from "./lib/metrics/corner-colour.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { runSkyBoxSwapSteps } from "./lib/skybox-swap-steps.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import RESIZE_RIG from "./rigs/globe-msaa4-resize-ladder.mjs";
import SKYBOX_RIG from "./rigs/skybox-source-swap.mjs";

/** The scenes by `--scene` name: rig, steps and the census label. */
export const LIFETIME_SCENES = Object.freeze({
  resize: Object.freeze({
    rig: RESIZE_RIG,
    steps: runGlobeResizeSteps,
    censusLabel: "SceneFramebuffer-Color_depth_resolve_ss",
  }),
  skybox: Object.freeze({
    rig: SKYBOX_RIG,
    steps: runSkyBoxSwapSteps,
    censusLabel: "CubeMapPanorama-cubemap",
  }),
});

export const DEFAULT_SCENES = Object.freeze(["resize", "skybox"]);

/** A validation line naming a destroyed resource used in a submit. */
export const DESTROYED_TEXTURE_RE = /destroyed texture|used in a submit/i;

/** The key a line that names no texture is tallied under. */
export const NO_TEXTURE_LABEL = "(no texture label)";

/**
 * The texture labels a WebGPU error line names, each once, in order.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function textureLabelsIn(text) {
  const labels = [];
  for (const match of String(text).matchAll(/\[Texture "([^"]*)"\]/g)) {
    if (!labels.includes(match[1])) {
      labels.push(match[1]);
    }
  }
  return labels;
}

/**
 * The error class of a line: its text with every `[Kind "label"]` reduced to
 * `[Kind]` and every number to `#`, so the same fault on two textures or at
 * two sizes is one class.
 *
 * @param {string} text
 * @returns {string}
 */
export function errorClassOf(text) {
  return String(text)
    .replace(/\[(\w+) "[^"]*"\]/g, "[$1]")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function tallyInto(tally, key) {
  tally[key] = (tally[key] ?? 0) + 1;
}

/**
 * Tally a cell's errors per texture label, so BEFORE and AFTER compare per
 * texture rather than by a total.
 *
 * Two populations: every uncaptured error the gate collected, and every
 * destroyed-texture line among the gate's errors and the page's console and
 * page-error lines. A line counts once under each texture label it names, or
 * once under {@link NO_TEXTURE_LABEL} when it names none.
 *
 * @param {{gateErrors?: string[], pageLines?: string[]}} input
 * @returns {{
 *   uncapturedByLabel: Record<string, number>,
 *   destroyedTextureByLabel: Record<string, number>,
 *   uncapturedByClass: Record<string, number>,
 *   totals: {uncaptured: number, destroyedTextureLines: number, pageLines: number},
 * }}
 */
export function tallyErrorsByLabel({ gateErrors = [], pageLines = [] } = {}) {
  const uncapturedByLabel = {};
  const destroyedTextureByLabel = {};
  const uncapturedByClass = {};
  const keysOf = (text) => {
    const labels = textureLabelsIn(text);
    return labels.length > 0 ? labels : [NO_TEXTURE_LABEL];
  };
  for (const text of gateErrors) {
    keysOf(text).forEach((key) => tallyInto(uncapturedByLabel, key));
    tallyInto(uncapturedByClass, errorClassOf(text));
  }
  let destroyedTextureLines = 0;
  for (const text of [...gateErrors, ...pageLines]) {
    if (DESTROYED_TEXTURE_RE.test(text)) {
      destroyedTextureLines++;
      keysOf(text).forEach((key) => tallyInto(destroyedTextureByLabel, key));
    }
  }
  return {
    uncapturedByLabel,
    destroyedTextureByLabel,
    uncapturedByClass,
    totals: {
      uncaptured: gateErrors.length,
      destroyedTextureLines,
      pageLines: pageLines.length,
    },
  };
}

const CESIUM_MODULE_URL = "/Build/CesiumUnminified/index.js";
const CANVAS_SELECTOR = ".cesium-widget canvas";
const STABLE_FRAMES = 30;
const SETTLE_CAP_FRAMES = 1200;
const PAIR_TOLERANCE = 16;
const NAVIGATION_BUDGET_MS = 120_000;
const STEPS_BUDGET_MS = 180_000;
const READBACK_BUDGET_MS = 30_000;
const CELL_BUDGET_MS =
  NAVIGATION_BUDGET_MS + STEPS_BUDGET_MS + READBACK_BUDGET_MS;

/**
 * The cells a run takes, scene-major, WebGL before WebGPU.
 *
 * @param {{scene?: string, renderers?: string[]}} options `--scene` and the
 *   runtime's `--renderer` list; a renderer the list leaves out is not run.
 * @returns {Array<{scene: string, renderer: string}>}
 * @throws {ProbeRefusal} `scene-unknown`.
 */
export function planLifetimeCells({ scene, renderers } = {}) {
  const names = String(scene ?? DEFAULT_SCENES.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const cells = [];
  for (const name of names) {
    if (!Object.hasOwn(LIFETIME_SCENES, name)) {
      throw new ProbeRefusal(
        "scene-unknown",
        `--scene ${name} is not one of ${Object.keys(LIFETIME_SCENES).join(", ")}`,
        { scene: name },
      );
    }
    for (const renderer of LIFETIME_SCENES[name].rig.renderers) {
      if (Array.isArray(renderers) && !renderers.includes(renderer)) {
        continue;
      }
      cells.push({ scene: name, renderer });
    }
  }
  return cells;
}

/** Render `frames` frames. Runs in the page. */
async function pageRenderFrames({ frames }) {
  const scene = /** @type {any} */ (globalThis).viewer.scene;
  for (let i = 0; i < frames; i++) {
    scene.render();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return frames;
}

/** Pin the clock and settle the tiles. Runs in the page. */
async function pageFrameRig({
  moduleUrl,
  clock,
  det,
  minFrames,
  maxFrames,
  stableFrames,
}) {
  const root = /** @type {any} */ (globalThis);
  const viewer = root.viewer;
  const C = await import(moduleUrl);
  // eslint-disable-next-line no-new-func
  new Function(det)();
  root.__det.pinClock(C, viewer, viewer.scene, clock);
  const framesRendered = await root.__det.settleTiles(viewer.scene, {
    minFrames,
    maxFrames,
    stableFrames,
  });
  return { framesRendered, tilesLoaded: viewer.scene.globe.tilesLoaded };
}

/** Console error and warning lines and page errors, in arrival order. */
function pageLinesFrom(diagnostics) {
  return [
    ...diagnostics.console
      .filter((m) => m.type === "error" || m.type === "warning")
      .map((m) => ({ seq: m.seq, type: m.type, text: m.text })),
    ...diagnostics.errors.map((m) => ({
      seq: m.seq,
      type: "pageerror",
      text: m.text,
    })),
  ].sort((a, b) => a.seq - b.seq);
}

/**
 * One scene on one renderer: load, frame, run the family's steps, strip the
 * chrome, capture, and read the census and the error gate.
 */
async function captureLifetimeCell({
  browser,
  origin,
  cell,
  run,
  outputDirectory,
  captures,
}) {
  const { rig, steps, censusLabel } = LIFETIME_SCENES[cell.scene];
  const context = await browser.newContext({ viewport: { ...rig.viewport } });
  try {
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    try {
      await page.addInitScript(errorGateInit);
      await page.addInitScript(gpuTextureCensusInit);
      const url = new URL(captureUrlFor({ rig, origin }));
      url.searchParams.set("renderer", cell.renderer);
      await page.goto(url.href, {
        waitUntil: "networkidle",
        timeout: NAVIGATION_BUDGET_MS,
      });
      await page.waitForFunction(() => !!globalThis.viewer, null, {
        timeout: NAVIGATION_BUDGET_MS,
      });
      await armWebGPUDevices(page);
      const framing = await page.evaluate(pageFrameRig, {
        moduleUrl: CESIUM_MODULE_URL,
        clock: rig.clock,
        det: DET_BROWSER_SETUP,
        minFrames: rig.readiness.frames,
        maxFrames: Math.max(rig.readiness.frames, SETTLE_CAP_FRAMES),
        stableFrames: STABLE_FRAMES,
      });
      const settle = (frames) => page.evaluate(pageRenderFrames, { frames });
      const stepRecord = await steps({ page, rig, settle });
      const refused = (stepRecord.steps ?? []).find((s) => s.ok === false);
      if (refused) {
        throw new ProbeRefusal("step-refused", refused.reason, stepRecord);
      }
      await settle(STABLE_FRAMES);

      const widgets = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
      if (!Array.isArray(widgets?.leftovers) || widgets.leftovers.length > 0) {
        throw new ProbeRefusal(
          "capture-chrome-over-canvas",
          `${cell.scene} on ${cell.renderer}: the viewer chrome strip left ${JSON.stringify(widgets?.leftovers ?? null)} over the scene canvas`,
          { widgets: widgets ?? null },
        );
      }
      const shot = await captureElement({
        page,
        selector: CANVAS_SELECTOR,
        name: `${cell.scene}-${cell.renderer}-run${run}`,
        outputDirectory,
        captures,
      });
      const census = await readGpuTextureCensus(page);
      const gate = await collectGateErrors(page);
      const lines = pageLinesFrom(diagnostics);
      const tally = tallyErrorsByLabel({
        gateErrors: gate.errors,
        pageLines: lines.map((l) => l.text),
      });
      // Examples only; the per-label tallies are the measurement.
      const destroyedTextureLines = [
        ...gate.errors,
        ...lines.map((l) => l.text),
      ]
        .filter((text) => DESTROYED_TEXTURE_RE.test(text))
        .slice(0, 5);
      const image = decodePng(shot.buffer);
      const corners = cornerMeans(image);
      return {
        scene: cell.scene,
        renderer: cell.renderer,
        image,
        record: {
          run,
          scene: cell.scene,
          rig: rig.id,
          renderer: cell.renderer,
          framing,
          steps: stepRecord,
          capture: {
            name: shot.name,
            sha256: shot.sha256,
            width: image.width,
            height: image.height,
            liveness: shot.liveness,
          },
          census: {
            installed: census.installed,
            repeatedDestroys: census.repeatedDestroys,
            subject: summarizeTextureCensus(census, censusLabel),
          },
          uncapturedErrors: {
            count: gate.errors.length,
            first: gate.errors.slice(0, 5),
          },
          deviceLost: gate.deviceLost,
          errorTotals: tally.totals,
          uncapturedByLabel: tally.uncapturedByLabel,
          destroyedTextureByLabel: tally.destroyedTextureByLabel,
          uncapturedByClass: tally.uncapturedByClass,
          destroyedTextureLines,
          consoleErrors: lines.filter((l) => l.type !== "warning").length,
          skyCorners: { ...corners, dominant: dominantChannel(corners) },
        },
      };
    } finally {
      diagnostics.detach();
    }
  } finally {
    await context.close();
  }
}

/** Diff each scene's WebGPU frame against its WebGL frame. */
function pairLifetimeScenes(captured, run, outputDirectory) {
  const pairs = [];
  for (const scene of new Set(captured.map((cell) => cell.scene))) {
    const webgl = captured.find(
      (c) => c.scene === scene && c.renderer === "webgl",
    );
    const webgpu = captured.find(
      (c) => c.scene === scene && c.renderer === "webgpu",
    );
    if (!webgl || !webgpu) {
      continue;
    }
    if (
      webgl.image.width !== webgpu.image.width ||
      webgl.image.height !== webgpu.image.height
    ) {
      throw new ProbeRefusal(
        "capture-size-mismatch",
        `${scene}: WebGL ${webgl.image.width}x${webgl.image.height} vs WebGPU ${webgpu.image.width}x${webgpu.image.height}`,
        { scene },
      );
    }
    const diff = diffImages(webgl.image, webgpu.image, {
      tolerance: PAIR_TOLERANCE,
    });
    const diffImage = `${scene}-diff-run${run}.png`;
    fs.writeFileSync(
      path.join(outputDirectory, diffImage),
      Buffer.from(
        encodeRgbaPng(diff.diffRgba, webgl.image.width, webgl.image.height),
      ),
    );
    pairs.push({
      scene,
      diffImage,
      tolerance: PAIR_TOLERANCE,
      mismatchPct: diff.mismatchPct,
      changedPx: diff.changedPx,
      bbox: diff.bbox,
    });
  }
  return pairs;
}

function plannedCellCount(options) {
  try {
    return planLifetimeCells(options).length;
  } catch {
    return DEFAULT_SCENES.length * 2;
  }
}

export const descriptor = {
  name: "texture-lifetime",
  title:
    "GPU texture lifetime - default globe at 4x MSAA through a resize ladder, and the sky box swapped twice in place, WebGL vs WebGPU",
  outputSubdirectory: "texture-lifetime",
  receiptEnvelope: "runtime",
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
  ],
  args: {
    extraOptions: [
      {
        flag: "--scene",
        key: "scene",
        kind: "string",
        default: DEFAULT_SCENES.join(","),
      },
    ],
  },
  workBudgetMs: (options) =>
    Math.max(1, plannedCellCount(options)) * CELL_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const plan = planLifetimeCells(options);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const captured = [];
    for (const cell of plan) {
      console.log(
        `[probe-texture-lifetime] ${cell.scene} on ${cell.renderer} (run ${run})`,
      );
      captured.push(
        await captureLifetimeCell({
          browser,
          origin,
          cell,
          run,
          outputDirectory,
          captures,
        }),
      );
    }
    return [
      {
        run,
        captures: captured.map((cell) => cell.record),
        pairs: pairLifetimeScenes(captured, run, outputDirectory),
      },
    ];
  },
  receipt(cells, context) {
    for (const cell of cells) {
      for (const c of cell.captures) {
        const s = c.census.subject;
        console.log(
          `  ${c.scene} ${c.renderer} run${cell.run}: ${s.label} created=${s.created} destroyed=${s.destroyed} live=${s.live} uncaptured=${c.errorTotals.uncaptured} destroyedTextureLines=${c.errorTotals.destroyedTextureLines} sky=${c.skyCorners.dominant}`,
        );
        for (const [label, count] of Object.entries(
          c.destroyedTextureByLabel,
        )) {
          console.log(`    destroyed-texture ${label}: ${count}`);
        }
      }
      for (const pair of cell.pairs) {
        console.log(
          `  ${pair.scene} webgpu vs webgl run${cell.run}: mismatch=${pair.mismatchPct.toFixed(3)}%`,
        );
      }
    }
    return { scene: context.options.scene, cells };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
