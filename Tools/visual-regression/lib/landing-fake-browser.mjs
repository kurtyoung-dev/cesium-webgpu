/**
 * The fake Playwright browser the landing probe's Node specs run its
 * descriptor against.
 * @purpose Spec support for probe-landing-cells: a fake browser whose pages answer every page function the landing probe evaluates (stage, startup, census, gate, pipeline cache, onmessage sentinel and its positive control, displacement readback at t = 0 and at the evolved clock, PF windows) from canned records, logging what was asked, plus a tiny PNG for its screenshots; no browser is launched.
 * @status ACTIVE
 *
 * WHY A PIECE. Lane TAR-ALDARION's round-2 spec for the landing probe needs the
 * same fake as `probe-landing-cells.spec.mjs`, which was already over 1,000
 * lines; the fake moved here verbatim (exported) so both specs share one copy.
 * A page function is recognised by its name or by a marker in its source, so a
 * renamed page function falls through to the "unstubbed evaluate" throw.
 *
 * @module Tools/visual-regression/lib/landing-fake-browser
 */

import { encodeRgbaPng } from "../../lib/png-rgba.mjs";

export function makeSmallPng(width = 8, height = 8, diffPixel = false) {
  const pixels = new Uint8Array(width * height * 4);
  if (diffPixel) {
    pixels[0] = 255;
    pixels[1] = 255;
    pixels[2] = 255;
    pixels[3] = 255;
  }
  return Buffer.from(encodeRgbaPng(pixels, width, height));
}

export function makeFakeBrowser(
  log,
  {
    notApplied = [],
    pipelines = { pending: 0 },
    onmessage = null,
    displacements = [],
    evolvedDisplacements = null,
    controlRecord = null,
    passCost = null,
  } = {},
) {
  let displacementCalls = 0;
  // Lane TAR-ALDARION: the evolved readback moves the frozen clock away and
  // back (lib/clock-steps.mjs pageSetClock); reads made while it is away are
  // the evolved field: `evolvedDisplacements` in order, else the last t = 0
  // record evolved by the advance (a new hash, the wave time moved on).
  let clockAway = false;
  let evolvedCalls = 0;
  let lastT0 = null;
  let connected = true;
  const smallPng = makeSmallPng(8, 8);

  function makePage() {
    // Set once this page ran the sentinel's positive control.
    let controlled = false;
    return {
      on(event) {
        log.events.push(`on:${event}`);
      },
      off(event) {
        log.events.push(`off:${event}`);
      },
      async addInitScript(script) {
        log.scripts.push(script);
      },
      async goto(url) {
        log.urls.push(url);
      },
      async waitForFunction() {},
      async evaluate(fn, arg) {
        const src = String(fn);
        if (fn.name === "pageSetClock") {
          log.clockSets?.push(arg.iso);
          clockAway = !clockAway;
          return { ok: true, observed: arg.iso };
        }
        if (fn.name === "pageAssignOnmessagePositiveControl") {
          log.controls?.push(true);
          controlled = true;
          return { assigned: true, name: "onmessagePositiveControlHandler" };
        }
        // Lane LINDISSE: the onmessage sentinel and the displacement readback.
        if (src.includes("__onmessageSentinel") && controlled) {
          log.sentinelReads?.push(true);
          return (
            controlRecord ?? {
              installed: true,
              before: null,
              after: {
                type: "function",
                name: "onmessagePositiveControlHandler",
              },
              changed: true,
              assignments: 1,
              stacks: ["at pageAssignOnmessagePositiveControl"],
            }
          );
        }
        if (src.includes("__onmessageSentinel")) {
          log.sentinelReads?.push(true);
          return (
            onmessage ?? {
              installed: true,
              before: null,
              after: null,
              changed: false,
              assignments: 0,
              stacks: [],
            }
          );
        }
        if (src.includes("_webgpuCache") && clockAway) {
          log.evolvedReadbacks?.push(arg);
          const listed = evolvedDisplacements?.[evolvedCalls];
          evolvedCalls++;
          if (listed) {
            return listed;
          }
          return lastT0?.available === true
            ? {
                ...lastT0,
                hash: `${lastT0.hash}-evolved`,
                simulationSeconds: lastT0.simulationSeconds + 30,
              }
            : { available: false, reason: "no fake evolved readback" };
        }
        if (src.includes("_webgpuCache")) {
          log.readbacks?.push(arg);
          const record = displacements[displacementCalls] ?? {
            available: false,
            reason: "no fake readback",
          };
          displacementCalls++;
          lastT0 = record;
          return record;
        }
        // Lane LINDISSE: the PF-1 / PF-2 window E-FFT-ifft runs without --perf.
        if (fn.name === "pageSampleFrameTimes") {
          return { frameMs: [10, 10], frames: arg?.frames ?? 0 };
        }
        if (fn.name === "pageSampleGpuPassCost") {
          return passCost ?? { available: false, reason: "fake browser" };
        }
        // Lead addition (Celos, round 5, K5-2): the pipeline-cache readers.
        if (src.includes("pageWaitForPendingPipelines")) {
          log.waits?.push(arg);
          return {
            requested: true,
            available: true,
            pendingAtStart: 5,
            pendingAtEnd: 0,
            pendingMax: 5,
            createdAtEnd: 9,
            framesWaited: 7,
            waitedMs: 70,
            timedOut: false,
          };
        }
        if (src.includes("pageReadPendingPipelines")) {
          return {
            available: true,
            rendererType: "webgpu",
            pending: pipelines.pending,
            created: 9,
          };
        }
        if (src.includes("performance.now()")) {
          return 100;
        }
        if (src.includes("__armWebGPUDevice")) {
          return { armed: 1, found: 1, total: 1 };
        }
        if (src.includes("stageLandingCellInPage")) {
          return {
            dials: {
              cloudsEnabled: {
                requested: true,
                observed: true,
                applied: true,
              },
            },
            notApplied,
          };
        }
        if (src.includes("pageMeasureStartup")) {
          return {
            viewerReadyAtMs: 10,
            stagedAtMs: 20,
            firstFrameAtMs: 30,
            firstCloudFrameAtMs: 40,
            tilesLoadedAtMs: 50,
            frames: 10,
            outcome: "done",
          };
        }
        if (src.includes("__gpuDeviceCensus")) {
          return {
            textures: { created: 0, destroyed: 0 },
            buffers: { created: 0, destroyed: 0 },
            byLabel: {},
            compile: { shaderModules: { count: 0, syncMs: 0 } },
          };
        }
        if (
          src.includes("pageReadRendererStatistics") ||
          src.includes("getRendererStatistics")
        ) {
          return { pipelineCache: null, shaderModuleCache: null };
        }
        if (
          src.includes("render(viewer.clock.currentTime)") ||
          src.includes("pageRenderFrames")
        ) {
          return arg?.frames ?? 1;
        }
        if (typeof fn === "string" && fn.includes("leftovers")) {
          return { removed: 3, leftovers: [] };
        }
        if (src.includes("__captureLiveness")) {
          return { gateArmed: true, deviceLost: null, frameNumber: 1 };
        }
        if (src.includes("__webgpuGate")) {
          return { errors: [], deviceLost: null, armedDevices: 1 };
        }
        throw new Error(`unstubbed evaluate: ${src.slice(0, 100)}`);
      },
      locator(selector) {
        log.selectors.push(selector);
        return {
          async count() {
            return 1;
          },
          nth: () => ({
            async screenshot() {
              return smallPng;
            },
          }),
          async screenshot() {
            return smallPng;
          },
        };
      },
    };
  }

  return {
    isConnected() {
      return connected;
    },
    async newContext(options) {
      log.contexts.push(options);
      return {
        async newPage() {
          return makePage();
        },
        async close() {},
      };
    },
    async close() {
      connected = false;
    },
  };
}
