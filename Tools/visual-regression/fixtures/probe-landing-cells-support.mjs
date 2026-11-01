// probe-landing-cells-support.mjs - shared fixtures for the probe-landing-cells spec parts.
// @purpose Spec support for probe-landing-cells: the PF page record, landing report, PNG and verdict builders, the P14 readback fixtures and the runProbe harnesses (p13Run, p14Run) that more than one probe-landing-cells spec part drives.
// @status ACTIVE
//
// Moved verbatim out of probe-landing-cells.spec.mjs when that spec was split by concern (row
// DX-KIT-LANDING-SPECS-OVER-SIZE). The harnesses take the part's temp root through landingRunners(), so
// each part keeps its own per-run mkLaneTmp root and never shares a path with another part.

import fs from "node:fs";
import path from "node:path";
import { encodeRgbaPng } from "../../lib/png-rgba.mjs";
import { runProbe } from "../lib/probe-runtime.mjs";
import { makeFakeBrowser } from "../lib/landing-fake-browser.mjs";
import {
  STUB_CESIUM_MODULE_URL,
  makeDiveGateFakeWorld,
} from "./dive-gate-fake-world.mjs";
import { descriptor, groupArms } from "../probe-landing-cells.mjs";

export function writePng(file, changed = 0, width = 8, height = 8) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < changed; i++) {
    pixels.set([255, 255, 255, 255], i * 4);
  }
  fs.writeFileSync(file, Buffer.from(encodeRgbaPng(pixels, width, height)));
  return file;
}

function census(liveBytes) {
  return {
    installed: true,
    textures: { created: 1, destroyed: 0, liveBytes, unknownSize: 0 },
    buffers: { created: 0, destroyed: 0, liveBytes: 0, unknownSize: 0 },
  };
}

/** One scene page record carrying every PF input and its machine CPU. */

export function pfRecord({
  run,
  renderer = "webgpu",
  frameMs = 10,
  passMs = 1,
  firstFrameAtMs = 1500,
  cpu = 20,
  capture = null,
}) {
  return {
    run,
    cell: "E-D",
    rig: "default-3d-pinned",
    kind: "capture",
    renderer,
    page: "scene",
    notRun: null,
    startup: {
      viewerReadyAtMs: 200,
      stagedAtMs: 300,
      firstFrameAtMs,
      firstCloudFrameAtMs: null,
      tilesLoadedAtMs: null,
      outcome: "settled",
    },
    compileAtStartup: { shaderModules: { count: 1, syncMs: 10 } },
    perf: {
      frameTimes: { frameMs: new Array(60).fill(frameMs) },
      passCost: {
        available: true,
        enabled: true,
        frameAvgMs: passMs,
        frameCount: 60,
        passes: {},
        sampleLedgerBalanced: true,
      },
      census: { start: census(1000), end: census(1000) },
    },
    capture,
    cpu: cpu === null ? null : { mean: cpu, samples: [] },
    gate: { deviceLost: null },
  };
}

/** A landing-cells report as the runtime writes it (envelope "runtime"). */

export function reportOf(pages, { md5 = "a".repeat(32), runs = 1 } = {}) {
  return {
    probe: "landing-cells",
    generatedAt: "2026-10-22T00:00:00.000Z",
    preflight: {
      ok: true,
      artifacts: descriptor.servedArtifacts.map((artifact) => ({
        path: artifact,
        disk: { md5 },
      })),
    },
    options: { runs },
    windows: { frames: 120, warmup: 30, passFrames: 60 },
    perf: true,
    pages,
    arms: groupArms(pages),
  };
}

export function pfVerdicts(comparison) {
  const out = {};
  for (const [key, arm] of Object.entries(comparison)) {
    out[key] = ["pf1", "pf2", "pf3", "pf4"].map((pf) => [
      pf,
      arm[pf]?.verdict ?? null,
    ]);
  }
  return out;
}

export function p13Log() {
  return {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
    waits: [],
  };
}

export function p14Log() {
  return {
    ...p13Log(),
    sentinelReads: [],
    readbacks: [],
    evolvedReadbacks: [],
    clockSets: [],
    controls: [],
  };
}

export const verdictById = (verdicts, id) => verdicts.find((v) => v.id === id);

/**
 * Wrap a fake browser so its pages run the dive-gate step's REAL page
 * functions. Each page gets a fake world (`fixtures/dive-gate-fake-world.mjs`)
 * for the cell's surface height: a viewer whose `globeHeight` is undefined
 * until `initializeFrame()` runs, whose wheel moves the camera only in that
 * call, and whose water facade applies the engine's gate. The page functions
 * the probe hands to `page.evaluate` (`pagePlaceDiveCamera`,
 * `pageReadDiveState`, and `pageRenderFrames` once the camera is placed) run
 * against that world; every other page function falls through to the base fake
 * browser, which answers `pageRenderFrames` by name for the pages that never
 * dive. Nothing here answers the gate or a height itself, so a probe whose
 * frames do not reach `initializeFrame()` reads what the real page read:
 * `globe-height-undefined`.
 *
 * The one thing served by the wrapper is the Cesium build: the rig's module
 * URL is a browser path, so the world's stub module stands behind it (the
 * result still names the URL the probe asked for).
 *
 * @param {object} browser A `makeFakeBrowser` browser.
 * @param {object} [options]
 * @param {number} [options.globeHeight] The terrain height every page reads.
 * @param {boolean} [options.placementFails] The globe has no water facade, so
 *   the real placement reports that reason.
 * @param {{placements: object[], moves: number[][], wheels: number[]}} [options.diveLog]
 *   Receives what the pages were asked.
 * @param {Record<string, Function>} [options.functionOverrides] Page
 *   functions to run in place of the ones the probe passes, by name (a spec's
 *   mutated copy of the frame driver or the placement).
 * @param {object[]} [options.worlds] Receives each page's world.
 * @returns {object} The wrapped browser.
 */
export function withDiveGateAnswers(
  browser,
  {
    globeHeight = 0,
    placementFails = false,
    diveLog = { placements: [], moves: [], wheels: [] },
    functionOverrides = {},
    worlds = [],
  } = {},
) {
  const wrapPage = (page) => {
    const world = makeDiveGateFakeWorld({
      surface: globeHeight,
      waterAccessor: !placementFails,
    });
    worlds.push(world);
    let placed = false;
    return {
      ...page,
      mouse: {
        async move(x, y) {
          diveLog.moves.push([x, y]);
          return world.page.mouse.move(x, y);
        },
        async wheel(dx, deltaY) {
          diveLog.wheels.push(deltaY);
          return world.page.mouse.wheel(dx, deltaY);
        },
      },
      async evaluate(fn, arg) {
        const run = functionOverrides[fn.name] ?? fn;
        if (fn.name === "pagePlaceDiveCamera") {
          diveLog.placements.push(arg);
          const result = await world.page.evaluate(run, {
            ...arg,
            moduleUrl: STUB_CESIUM_MODULE_URL,
          });
          placed = result.ok === true;
          return { ...result, moduleUrl: arg.moduleUrl };
        }
        if (fn.name === "pageReadDiveState") {
          return world.page.evaluate(run, arg);
        }
        // The frames the stage settles before the dive are the base fake's;
        // once the camera is placed, they drive the world.
        if (fn.name === "pageRenderFrames" && placed) {
          return world.page.evaluate(run, arg);
        }
        return page.evaluate(fn, arg);
      },
    };
  };
  return {
    isConnected: () => browser.isConnected(),
    close: () => browser.close(),
    async newContext(options) {
      const context = await browser.newContext(options);
      return {
        ...context,
        async newPage() {
          return wrapPage(await context.newPage());
        },
      };
    },
  };
}

export function readback(kernel, hash, overrides = {}) {
  return {
    available: true,
    accessor: "primitive._webgpuCache.displacementTexture",
    format: "rgba16float",
    width: 4,
    height: 4,
    sampleCount: 64,
    hash,
    min: -1,
    max: 1,
    mean: 0,
    nonFinite: 0,
    nonZero: 60,
    kernel,
    frameNumber: 12,
    simulationSeconds: 3,
    computePipelinesReady: true,
    ...overrides,
  };
}

export const SAME_FIELDS = Object.freeze({
  displacements: [readback("stockham", "aa"), readback("pingpong", "aa")],
});

/**
 * The runProbe harnesses of the landing specs, bound to the calling part's per-run temp root.
 * @param {() => string} getTempRoot Reads the part getTempRoot() when a run starts.
 */
export function landingRunners(getTempRoot) {
  async function p13Run(name, extraArgs, pipelines) {
    const testDir = path.join(getTempRoot(), name);
    fs.mkdirSync(testDir, { recursive: true });
    const out = path.join(testDir, "out");
    const log = p13Log();
    const code = await runProbe(descriptor, {
      argv: [
        "--repository-root",
        testDir,
        "--output",
        out,
        "--runs",
        "1",
        "--cells",
        "E-O",
        "--no-serve-built",
        ...extraArgs,
      ],
      launch: async () => makeFakeBrowser(log, { pipelines }),
      preflight: async () => ({ ok: true, records: [] }),
    });
    const receipt = JSON.parse(
      fs.readFileSync(path.join(out, "landing-cells-report.json"), "utf8"),
    );
    return { code, receipt, log };
  }

  async function p14Run(
    name,
    extraArgs,
    fakeOptions = {},
    probe = descriptor,
    wrapBrowser = (browser) => browser,
  ) {
    const testDir = path.join(getTempRoot(), name);
    fs.mkdirSync(testDir, { recursive: true });
    const out = path.join(testDir, "out");
    const log = p14Log();
    const code = await runProbe(probe, {
      argv: [
        "--repository-root",
        testDir,
        "--output",
        out,
        "--runs",
        "1",
        "--no-serve-built",
        ...extraArgs,
      ],
      launch: async () => wrapBrowser(makeFakeBrowser(log, fakeOptions)),
      preflight: async () => ({ ok: true, records: [] }),
    });
    const report = JSON.parse(
      fs.readFileSync(path.join(out, "landing-cells-report.json"), "utf8"),
    );
    const verdicts = report.verdicts ?? report.runtime?.verdicts ?? [];
    return { code, report, log, verdicts };
  }

  return { p13Run, p14Run };
}
