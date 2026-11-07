/**
 * The fake Playwright browser the landing probe's Node specs run its
 * descriptor against.
 * @purpose Spec support for probe-landing-cells: a fake browser whose pages answer every page function the landing probe evaluates (stage, startup, census, gate, pipeline cache, onmessage sentinel and its positive control, displacement readback at t = 0 and at the evolved clock, PF windows, the E-T device-loss steps, the bind-group-layout census and the device-limits reader) from canned records, logging what was asked, plus a tiny PNG for its screenshots; no browser is launched.
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

import vm from "node:vm";

import { encodeRgbaPng } from "../../lib/png-rgba.mjs";
import { withInstantWarmUp } from "./cpu-warm-up.mjs";
import { ENGAGEMENT_PAGE_FUNCTION } from "./cloud-engagement-read.mjs";
import { READER_PAGE_FUNCTIONS } from "./landing-page-readers.mjs";

// The opt-in page readers (lib/landing-page-readers.mjs) run their REAL page
// functions and init sources inside a per-page vm context holding only the
// globals the spec's `readerWorld` gives it: a page the spec leaves empty
// answers nothing, so a reader that invents a value goes red.
const READER_INIT_MARKERS = ["__landingWorkerCensus", "__autoLayoutCensus"];

function makeReaderSandbox(world) {
  const globals = {
    requestAnimationFrame: (callback) => setImmediate(() => callback(0)),
    ...(typeof world === "function" ? world() : (world ?? {})),
  };
  const sandbox = vm.createContext(globals);
  return sandbox;
}

async function runReaderPageFunction(fn, arg, sandbox) {
  const run = vm.runInContext(`(${String(fn)})`, sandbox);
  const answer = await run(arg);
  return answer === undefined ? null : JSON.parse(JSON.stringify(answer));
}

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
    layoutCensus = null,
    deviceLimits = null,
    // The globals a reader's page sees (an object, or a function returning one
    // per page); `onPageLoad(sandbox)` runs at goto and `onViewerDestroy(sandbox)`
    // when the E-T step destroys the viewer, to drive the page's world.
    readerWorld = null,
    onPageLoad = null,
    onViewerDestroy = null,
    onHolderRelease = null,
    // What the keep-device holder step answers (lib/device-loss-steps.mjs):
    // `{held, sameDevice, reason?}`, and what releasing it answers.
    deviceHolder = { held: true, sameDevice: true },
    holderRelease = { released: true, threw: null },
    // `screenshotFor({pageIndex, payload})` returns the PNG bytes a page's
    // element screenshot answers with, or nothing for the default tiny frame.
    // `pageIndex` counts the pages the browser made; `payload` is the stage
    // payload the page last received (what the probe asked it to stage).
    screenshotFor = null,
    // What the morph-hold and sky-cube page functions answer
    // (lib/morph-steps.mjs, lib/sky-cubemap-steps.mjs): `morphAnswer` is the
    // raw pageMorphHold answer, `skyCubeAnswers` is {add, read}. Left null the
    // page answers NOT AVAILABLE, never a value.
    morphAnswer = null,
    skyCubeAnswers = null,
    // The globals the engagement read's page sees
    // (lib/cloud-engagement-read.mjs): `engagementWorld({pageIndex, payload})`
    // returns them for the page asked. Left null the page is empty, so every
    // flag answers NOT AVAILABLE, never a value.
    engagementWorld = null,
    // What the WebGPU error gate and the capture-liveness read report as the
    // page's device loss: a value, or a function of {pageIndex, gateReads}
    // (the reads this page made so far) answering it (null: no loss). A loss
    // after the capture makes the E-T step's provoking steps end the page
    // before its terminal action.
    gateDeviceLost = null,
    // The GPU device census's per-label rows (`byLabel`) the page answers;
    // left null the census is empty, so no owner is ever seen.
    censusByLabel = null,
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
  let pagesMade = 0;

  function makePage() {
    // Set once this page ran the sentinel's positive control.
    let controlled = false;
    const pageIndex = pagesMade++;
    let gateReads = 0;
    const lostNow = () =>
      typeof gateDeviceLost === "function"
        ? gateDeviceLost({ pageIndex, gateReads: gateReads++ })
        : gateDeviceLost;
    let stagedPayload;
    const screenshotBytes = () =>
      screenshotFor?.({ pageIndex, payload: stagedPayload }) ?? smallPng;
    const sandbox = makeReaderSandbox(readerWorld);
    log.readerWorlds?.push(sandbox);
    return {
      on(event) {
        log.events.push(`on:${event}`);
      },
      off(event) {
        log.events.push(`off:${event}`);
      },
      async addInitScript(script) {
        log.scripts.push(script);
        const content = script?.content;
        if (
          typeof content === "string" &&
          READER_INIT_MARKERS.some((marker) => content.includes(marker))
        ) {
          vm.runInContext(content, sandbox);
        }
      },
      async goto(url) {
        log.urls.push(url);
        await onPageLoad?.(sandbox);
      },
      async waitForFunction() {},
      async evaluate(fn, arg) {
        const src = String(fn);
        if (fn.name === ENGAGEMENT_PAGE_FUNCTION) {
          log.engagementReads?.push(arg);
          return runReaderPageFunction(
            fn,
            arg,
            vm.createContext(
              engagementWorld?.({ pageIndex, payload: stagedPayload }) ?? {},
            ),
          );
        }
        if (
          typeof fn === "function" &&
          Object.hasOwn(READER_PAGE_FUNCTIONS, fn.name)
        ) {
          log.readerReads?.push(fn.name);
          return runReaderPageFunction(fn, arg, sandbox);
        }
        if (fn.name === "pageMorphHold") {
          log.morphHolds?.push(arg);
          return (
            morphAnswer ?? {
              available: false,
              reason: "NOT AVAILABLE: fake page (seam: scene.morphTo*)",
            }
          );
        }
        if (fn.name === "pageSkyCubeAddModel") {
          log.skyCubeCalls?.push(fn.name);
          return (
            skyCubeAnswers?.add ?? {
              added: false,
              reason: "NOT AVAILABLE: fake page (seam: Model.fromGltfAsync)",
            }
          );
        }
        if (fn.name === "pageSkyCubeReadFaces") {
          log.skyCubeCalls?.push(fn.name);
          return (
            skyCubeAnswers?.read ?? {
              available: false,
              reason:
                "NOT AVAILABLE: fake page (seam: manager._webgpuCache.cubemapTexture)",
            }
          );
        }
        // The clock steps read the sun state after each step; the fake has no
        // sun, so it answers no direction (a spec that measures it wraps its own).
        if (fn.name === "pageReadSunState") {
          return { frameNumber: 1, sunDirectionWC: null };
        }
        if (fn.name === "pageSetClock") {
          log.clockSets?.push(arg.iso);
          clockAway = !clockAway;
          return { ok: true, observed: arg.iso };
        }
        // The opt-in page readers (lib/bind-group-layout-census.mjs,
        // lib/device-limits-dial.mjs): canned raw answers, what was asked logged.
        if (fn.name === "pageReadBindGroupLayoutCensus") {
          log.layoutReads?.push(arg);
          return (
            layoutCensus ?? {
              installed: true,
              layouts: {},
              groups: {},
              unlabelled: 0,
              device: { found: true, limits: {} },
            }
          );
        }
        if (fn.name === "pageReadDeviceLimits") {
          log.limitReads?.push(arg);
          return (
            deviceLimits ?? {
              installed: true,
              requests: [],
              device: { found: true, limits: {} },
            }
          );
        }
        // The E-T cells' terminal steps (lib/device-loss-steps.mjs), by name:
        // the frame driver's marker would otherwise answer the render loop.
        if (fn.name === "pageHoldDevice") {
          log.deviceLossCalls?.push(fn.name);
          return deviceHolder;
        }
        if (fn.name === "pageReleaseDeviceHolder") {
          log.deviceLossCalls?.push(fn.name);
          onHolderRelease?.(sandbox);
          return holderRelease;
        }
        if (fn.name === "pageDestroyViewer") {
          log.deviceLossCalls?.push(fn.name);
          onViewerDestroy?.(sandbox);
          return { destroyed: true, threw: null };
        }
        if (fn.name === "pageForceDeviceLoss") {
          log.deviceLossCalls?.push(fn.name);
          return {
            renderer: "webgpu",
            method: "GPUDevice.destroy",
            observed: { reason: "destroyed", message: "fake" },
          };
        }
        if (fn.name === "pageRenderAfterLoss") {
          log.deviceLossCalls?.push(fn.name);
          return {
            framesAttempted: arg?.frames ?? 0,
            throws: 0,
            firstThrows: [],
            terminallyLost: true,
          };
        }
        if (fn.name === "pageReadFrameNumber") {
          return 1;
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
          stagedPayload = arg;
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
            byLabel: censusByLabel ?? {},
            compile: { shaderModules: { count: 0, syncMs: 0 } },
          };
        }
        if (
          src.includes("pageReadRendererStatistics") ||
          src.includes("getRendererStatistics")
        ) {
          return { pipelineCache: null, shaderModuleCache: null };
        }
        // The frame driver, answered by name for every page that never dives.
        // A dive page runs the real driver against the dive-gate fake world
        // instead (fixtures/probe-landing-cells-support.mjs, withDiveGateAnswers).
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
          return {
            gateArmed: true,
            deviceLost: lostNow(),
            frameNumber: 1,
          };
        }
        if (src.includes("__webgpuGate")) {
          return { errors: [], deviceLost: lostNow(), armedDevices: 1 };
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
              return screenshotBytes();
            },
          }),
          async screenshot() {
            return screenshotBytes();
          },
        };
      },
    };
  }

  // A run launched on the fake takes the instant warm-up, never the machine's
  // CPU: every landing spec's fake-browser run goes through this one seam.
  return withInstantWarmUp({
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
  });
}
