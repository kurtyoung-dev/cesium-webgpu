#!/usr/bin/env node
// @purpose E-2 residency locus measurement: captures a browser-process Chrome trace over the same AEC settle window E-1 measured, records animation-frame delivery independently of the engine's frame loop, censuses the WGSL handed to the device, and runs three single-dimension controls as separate page loads, then attributes each frame gap of a second or more to the GPU-process work that covered it.
// @status ACTIVE
//
// Q-143 / DM-09 — the second instrument, still not the fix.
//
// WHAT E-1 ESTABLISHED, AND WHY THAT IS NOT ENOUGH. E-1 measured the WebGPU
// settle window as four discrete waits rather than a slow grind: a handful of
// inter-frame gaps accounted for about three quarters of it, and across the
// largest one the renderer's main thread was demonstrably healthy — its
// wall-clock poll kept its nominal cadence — while no animation frame was
// delivered and not one in-flight pipeline creation settled. The event loop was
// free, the frames were not arriving, and the promises were not resolving. Two
// things that cannot stop each other stopped together, which places the wait
// BELOW both of them, off the renderer's main thread. E-1 samples the
// renderer's main thread and the engine's counters, so it cannot see there. The
// `pipeline-creation-bound` band reading stands; a pipeline-creation CAUSE does
// not, and no fix may be funded until the occupant is named.
//
// WHAT THIS ADDS, IN FOUR PARTS.
//
//   1. A browser-process trace across the window, so the GPU process's own
//      device timeline is on the record. Each gap of a second or more is then
//      attributed to the traced work that covered it — as a ranked list of
//      candidates, never as a verdict, because co-occurrence is not cause.
//   2. An animation-frame log that does NOT run through the engine. The E-1
//      frame recorder fires from `postRender`, so it only sees a frame the
//      engine chose to draw; a bare `requestAnimationFrame` chain installed
//      before the viewer exists sees BeginFrame DELIVERY. The two together
//      separate "the engine skipped a frame" from "no frame was offered".
//   3. A `createShaderModule` census with total coverage: the device method is
//      wrapped on the page, so compiles that bypass the engine's shader-module
//      cache are counted too, and the engine's own per-device census is read
//      alongside it so the compiles that happened during context
//      initialization — before any page code existed — are not lost.
//   4. Three controls, each a SEPARATE page load timed to the same readiness
//      gate, each differing from the baseline along exactly one dimension.
//
// WHY THE CONTROLS ARE SEPARATE LOADS. The question is what a cold scene costs
// to REACH readiness. A post-settle ablation can only show what a warmed scene
// costs to keep, so it cannot answer it at any level of care. Each control
// therefore pays for its own hundred seconds.
//
// EVERY SCENE FACT IS SHARED WITH E-1, NOT COPIED. The tilesets, the site
// clipping polygon, the camera, the clock, the readiness predicate, the frame
// recorder and the wall-clock cache poll all come from
// `probe-aec-residency-e1.mjs` through its exported page-module builder. A
// second copy of that text would be a second definition of readiness, and the
// two measurements would stop being comparable the first time either was
// edited.
//
// THE CLOCKS ARE BRIDGED, NEVER ASSUMED. A trace stamps events on the browser's
// monotonic clock and the gaps are stamped on the page's `performance.now()`.
// The probe drops CDP clock-sync markers at known page timestamps and the
// bridge is recovered from them; when it cannot be recovered, or a second
// marker disagrees with the first, NOTHING is attributed and the receipt says
// so.
//
// Preconditions:
//   node server.js --port 8094 --serve-built
//
// Examples:
//   node Tools/visual-regression/probe-aec-residency-e2.mjs
//   node Tools/visual-regression/probe-aec-residency-e2.mjs --reverse
//   node Tools/visual-regression/probe-aec-residency-e2.mjs --controls baseline
//   node Tools/visual-regression/probe-aec-residency-e2.mjs --trace-legs baseline
//
// Exit codes:
//   0 measurement completed
//   2 probe/runtime error
//   3 refusal: the requested measurement could not be validated

import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  E1RefusalError,
  EXIT_CODES,
  classifySettleWindow,
  decideOriginRefusal,
  decidePreflightRefusal,
  decideReadinessRefusal,
  deriveEntryContext,
  parseArgs,
  summarizeModuleCoverage,
  throwForDecision,
} from "./lib/aec-residency-e1.mjs";
import {
  HARNESS_PATH,
  TILESETS,
  harnessHtml,
  pageModule,
  runSettleWindow,
} from "./probe-aec-residency-e1.mjs";
import {
  E2_CONTROL_ORDER,
  E2_CONTROLS,
  E2_TRACE_CATEGORIES,
  buildControlMatrix,
  buildE2MarkdownSummary,
  buildE2Receipt,
  buildTraceClockBridge,
  deriveAnimationFrameGaps,
  resolveControl,
  summarizeGapTraceOverlap,
  summarizeShaderModuleCensus,
} from "./lib/aec-residency-e2.mjs";
import {
  analyzeReceipt,
  decomposeFrameGaps,
} from "./lib/aec-residency-stall-locus.mjs";

/**
 * Installed BEFORE the viewer exists, so the log covers the whole page life
 * including context creation. The chain records the callback's own frame
 * timestamp — that value IS the BeginFrame the browser delivered — and does no
 * rendering of its own, so it cannot keep a scene alive that would otherwise
 * have stopped.
 */
const ANIMATION_FRAME_LOGGER_SOURCE = `
const e2 = (window.__e2 = {
  rafSamples: [],
  shaderCompiles: [],
  shaderWrapInstalled: false,
  censusAtInstall: null,
});
(function pumpAnimationFrames(frameTimeMs) {
  if (typeof frameTimeMs === "number") {
    e2.rafSamples.push(frameTimeMs);
  }
  requestAnimationFrame(pumpAnimationFrames);
})();
`.trim();

/**
 * Installed as soon as the scene exists, which is as early as page code can
 * reach the device. Everything compiled before this point lives in the engine's
 * own per-device census, which is read here so the two halves can be reported
 * together rather than one being mistaken for the whole.
 */
const SHADER_CENSUS_SOURCE = `
e2.readShaderCensus = function () {
  try {
    const context = scene.context;
    if (!context || typeof context.getRendererStatistics !== "function") {
      return null;
    }
    const stats = context.getRendererStatistics();
    const census = stats && stats.shaderModuleCache;
    if (!census || typeof census !== "object" || census.error) {
      return null;
    }
    return {
      modulesCreated: census.modulesCreated ?? null,
      wgslBytes: census.wgslBytes ?? null,
      largestWgslBytes: census.largestWgslBytes ?? null,
      cacheHits: census.cacheHits ?? null,
    };
  } catch (error) {
    return null;
  }
};
e2.censusAtInstall = e2.readShaderCensus();
const e2Device = scene.context && scene.context.device;
if (
  e2Device &&
  typeof e2Device.createShaderModule === "function" &&
  e2Device.__e2WrappedCreateShaderModule !== true
) {
  const originalCreateShaderModule = e2Device.createShaderModule.bind(e2Device);
  e2Device.createShaderModule = function (descriptor) {
    const code = descriptor && descriptor.code;
    e2.shaderCompiles.push({
      atMs: performance.now(),
      bytes: typeof code === "string" ? code.length : 0,
      label: (descriptor && descriptor.label) || null,
    });
    return originalCreateShaderModule(descriptor);
  };
  e2Device.__e2WrappedCreateShaderModule = true;
  e2.shaderWrapInstalled = true;
}
`.trim();

/**
 * Parse the probe's command line.
 *
 * The core options are E-1's, parsed by E-1's own parser so the two probes
 * cannot drift on what `--port`, `--entry` or a deadline mean. Only the
 * E-2-specific flags are handled here, and they are removed before delegating
 * so an unknown argument still fails loudly there.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} Parsed options.
 */
export function parseE2Args(argv) {
  const passthrough = [];
  let controls = [...E2_CONTROL_ORDER];
  let traceLegs = "all";

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--controls") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new TypeError("--controls requires a value");
      }
      controls = value.split(",").map((name) => name.trim());
      for (const name of controls) {
        if (E2_CONTROLS[name] === undefined) {
          throw new TypeError(`unknown control: ${name}`);
        }
      }
      if (!controls.includes("baseline")) {
        throw new TypeError(
          "--controls must include baseline; every other control is reported as a delta against it",
        );
      }
      index++;
      continue;
    }
    if (arg === "--trace-legs") {
      const value = argv[index + 1];
      if (!["all", "baseline", "none"].includes(value)) {
        throw new TypeError("--trace-legs must be all, baseline or none");
      }
      traceLegs = value;
      index++;
      continue;
    }
    passthrough.push(arg);
  }

  return { ...parseArgs(passthrough), controls, traceLegs };
}

/**
 * Start a browser-process trace and drop the first clock-sync anchor.
 *
 * The anchor's page timestamp is bracketed by two reads of the page clock, so
 * the receipt carries how much uncertainty the CDP round trip introduced
 * instead of pretending the marker landed at an instant.
 *
 * @param {object} input The browser session, the page and the categories.
 * @returns {Promise<object>} The tracing handle.
 */
async function startTrace({ session, page, categories, syncId }) {
  await session.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    streamFormat: "json",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      includedCategories: [...categories],
    },
  });
  const anchor = await dropClockSyncAnchor({ session, page, syncId });
  return { anchors: [anchor] };
}

/**
 * Ask the browser to stamp a clock-sync marker into the trace, bracketed by
 * page-clock reads.
 *
 * @param {object} input The browser session, the page and the marker id.
 * @returns {Promise<{syncId: string, pageMs: number, uncertaintyMs: number}>} The anchor.
 */
async function dropClockSyncAnchor({ session, page, syncId }) {
  const before = await page.evaluate(() => performance.now());
  await session.send("Tracing.recordClockSyncMarker", { syncId });
  const after = await page.evaluate(() => performance.now());
  return {
    syncId,
    pageMs: (before + after) / 2,
    uncertaintyMs: after - before,
  };
}

/**
 * Stop the trace and stream it to disk without holding it in memory twice.
 *
 * @param {object} input The browser session and the destination path.
 * @returns {Promise<{path: string, bytes: number}|{error: string}>} The result.
 */
async function endTrace({ session, filePath }) {
  const complete = new Promise((resolve) => {
    session.once("Tracing.tracingComplete", resolve);
  });
  await session.send("Tracing.end");
  const event = await complete;
  const handle = event?.stream;
  if (handle === undefined) {
    return { error: "tracing-complete-carried-no-stream" };
  }

  const stream = createWriteStream(filePath);
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await session.send("IO.read", { handle, size: 1 << 20 });
      const text = chunk.base64Encoded
        ? Buffer.from(chunk.data, "base64").toString("utf8")
        : chunk.data;
      bytes += Buffer.byteLength(text);
      stream.write(text);
      if (chunk.eof) {
        break;
      }
    }
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    await new Promise((resolve) => stream.end(resolve));
    await session.send("IO.close", { handle }).catch(() => {});
  }
  return { path: filePath, bytes };
}

/**
 * The largest trace this probe will read back into memory.
 *
 * A whole-file read is the one place this probe can consume unbounded memory:
 * the trace is streamed to disk precisely so it never sits in RAM twice, and
 * reading it back undoes that. A `toplevel` trace over a ~100 s window emits
 * every task boundary in every process, so the size is operator- and
 * machine-dependent rather than bounded by anything the probe controls.
 * Refusing above a stated size costs that leg its attribution and says so;
 * exhausting the heap kills the process and takes every completed leg's
 * measurement with it.
 *
 * Sized well under V8's maximum string length so the refusal, not the
 * allocator, is what a large trace meets.
 */
export const E2_TRACE_READ_CAP_BYTES = 256 * 1024 * 1024;

/**
 * Read a written trace back and hand out its events.
 *
 * A parse failure is reported as one, never worked around: a partially read
 * trace would produce an attribution over a fraction of the window that reads
 * exactly like an attribution over all of it. A trace too large to read is
 * reported the same way, and the file stays on disk for offline analysis.
 *
 * @param {string} filePath The written trace.
 * @param {object} [options] Overrides.
 * @param {number} [options.capBytes] The largest file this will parse.
 * @returns {{traceEvents: object[], error: string|null}} The events.
 */
export function readTraceEvents(filePath, options = {}) {
  const capBytes = options.capBytes ?? E2_TRACE_READ_CAP_BYTES;
  try {
    const bytes = statSync(filePath).size;
    if (bytes > capBytes) {
      return {
        traceEvents: [],
        error: `trace-too-large-to-read: ${bytes} bytes exceeds the ${capBytes} byte cap; the trace is on disk and can be read offline`,
      };
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const traceEvents = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.traceEvents)
        ? parsed.traceEvents
        : null;
    if (traceEvents === null) {
      return { traceEvents: [], error: "trace-file-has-no-events-array" };
    }
    return { traceEvents, error: null };
  } catch (error) {
    return {
      traceEvents: [],
      error: `trace-parse-failed: ${String(error?.message ?? error).slice(0, 160)}`,
    };
  }
}

/**
 * End a trace at most once, whichever path reaches the teardown first.
 *
 * `Tracing` is browser-global, so a leg that throws between `Tracing.start`
 * and `Tracing.end` leaves the browser recording. Detaching the session is not
 * the same as ending the trace, and a subsequent `Tracing.start` on a browser
 * that is still recording can be refused — which would cascade one bad leg
 * into every leg after it. The state object is what lets the happy path and
 * the teardown share one end, and what lets the receipt say "traced and
 * abandoned" rather than "not traced".
 *
 * @param {{started: boolean, ended: boolean, result: object|null,
 *   endError: string|null}} state The trace's lifecycle record, mutated here.
 * @param {Function} end Performs the end; called at most once.
 * @returns {Promise<object>} The same state object.
 */
export async function closeTraceOnce(state, end) {
  if (state.started !== true || state.ended === true) {
    return state;
  }
  try {
    state.result = await end();
    state.ended = true;
  } catch (error) {
    state.ended = false;
    state.endError = String(error?.message ?? error).slice(0, 200);
  }
  return state;
}

/**
 * Drive one control on one backend, end to end.
 *
 * @param {object} input Browser, control, backend and run options.
 * @returns {Promise<object>} The leg record.
 */
async function runLeg({
  browser,
  control,
  backend,
  options,
  origin,
  outputDirectory,
  entryContext,
  traceThisLeg,
}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const consoleLines = [];
  const loadedUrls = new Set();
  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith(origin) && loadedUrls.size < 500) {
      loadedUrls.add(url);
    }
  });
  page.on("console", (message) =>
    consoleLines.push(`${message.type()}: ${message.text()}`.slice(0, 300)),
  );
  page.on("pageerror", (error) =>
    consoleLines.push(`pageerror: ${error.message}`.slice(0, 300)),
  );

  const leg = {
    control: control.name,
    controlDimension: control.dimension,
    controlDescription: control.description,
    backend,
    entry: options.entry,
    tilesetCount: control.tilesets.length,
  };
  let browserSession = null;
  let tracing = null;
  // Hoisted out of the try so the teardown can end a trace this leg started
  // and then failed before reaching its own end. `Tracing` is browser-global;
  // a trace left running is not this leg's problem alone.
  const traceState = {
    started: false,
    ended: false,
    result: null,
    endError: null,
  };
  const tracePath = path.join(
    outputDirectory,
    `trace-${control.name}-${backend}.json`,
  );
  const endThisTrace = () =>
    endTrace({ session: browserSession, filePath: tracePath });
  try {
    await page.route(`**${HARNESS_PATH}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: harnessHtml(entryContext.stylesheetUrl),
      }),
    );
    await page.goto(`${origin}${HARNESS_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    throwForDecision(
      decideOriginRefusal({ requestedOrigin: origin, actualUrl: page.url() }),
      "the page did not stay on the requested origin",
    );

    // The trace opens BEFORE the page module runs, so context creation, the
    // init-time warms and the first compiles are all inside it. A trace that
    // started at the settle window would begin after the work this row is
    // about.
    if (traceThisLeg) {
      browserSession = await browser.newBrowserCDPSession();
      tracing = await startTrace({
        session: browserSession,
        page,
        categories: E2_TRACE_CATEGORIES,
        syncId: `e2-${control.name}-${backend}-open`,
      });
      traceState.started = true;
    }

    await page.addScriptTag({
      type: "module",
      content: pageModule(
        options.entry,
        entryContext.baseUrl,
        backend,
        control.tilesets,
        {
          ...control.pageConfig,
          preludeSource: ANIMATION_FRAME_LOGGER_SOURCE,
          postViewerSource: SHADER_CENSUS_SOURCE,
        },
      ),
    });
    await page.waitForFunction(
      () => window.__e1 && window.__e1.ready === true,
      {
        timeout: 150000,
      },
    );

    const client = await page.context().newCDPSession(page);
    const settle = await runSettleWindow({
      page,
      client,
      deadlineMs: options.settleDeadlineMs,
      samplingIntervalUs: options.samplingIntervalUs,
    });
    await client.detach().catch(() => {});

    if (tracing !== null) {
      tracing.anchors.push(
        await dropClockSyncAnchor({
          session: browserSession,
          page,
          syncId: `e2-${control.name}-${backend}-close`,
        }),
      );
      await closeTraceOnce(traceState, endThisTrace);
      leg.traceFile = traceState.result;
      leg.clockSyncAnchors = tracing.anchors;
    }

    leg.settleWindowMs = settle.settleWindowMs;
    leg.stalled = settle.stalled;
    leg.readiness = settle.readiness;
    leg.readinessReachedAtMs = settle.readinessReachedAtMs;
    leg.tilesetStatus = settle.tilesetStatus;
    leg.pageErrors = settle.pageErrors;

    throwForDecision(
      decideReadinessRefusal(settle.readiness),
      "the readiness observation contradicts itself",
    );

    // The E-1 classification and the E-1 sample arrays are kept verbatim, so
    // this receipt's legs can be read by the E-1 reader and by the stall-locus
    // analyzer without either being taught a second schema.
    leg.classification = classifySettleWindow({
      profile: settle.profile,
      frameSamples: settle.frames,
      cacheSamples: settle.cacheSamples,
      windowMs: settle.settleWindowMs,
    });
    leg.frameSamples = settle.frames;
    leg.cacheSamples = settle.cacheSamples;

    const e2State = await page.evaluate(() => ({
      rafSamples: window.__e2 ? window.__e2.rafSamples : [],
      shaderCompiles: window.__e2 ? window.__e2.shaderCompiles : [],
      shaderWrapInstalled: window.__e2
        ? window.__e2.shaderWrapInstalled === true
        : false,
      censusAtInstall: window.__e2 ? window.__e2.censusAtInstall : null,
      censusFinal:
        window.__e2 && typeof window.__e2.readShaderCensus === "function"
          ? window.__e2.readShaderCensus()
          : null,
    }));

    leg.frameGaps = decomposeFrameGaps(leg);
    leg.animationFrameGaps = deriveAnimationFrameGaps(e2State.rafSamples);
    leg.shaderWrapInstalled = e2State.shaderWrapInstalled;
    leg.shaderModules = summarizeShaderModuleCensus({
      deviceCompiles: e2State.shaderCompiles,
      censusAtInstall: e2State.censusAtInstall,
      censusFinal: e2State.censusFinal,
      firstGapStartMs: firstGapStartOf(leg.frameGaps),
    });

    // Only an ended trace has a file to read. A started-but-unended trace gets
    // its disposition from the teardown below, which is the only place that
    // knows the final state.
    if (traceState.ended === true) {
      const { traceEvents, error } = readTraceEvents(tracePath);
      if (error !== null) {
        leg.traceOverlap = { attributed: false, reason: error, gaps: [] };
      } else {
        const bridge = buildTraceClockBridge(traceEvents, leg.clockSyncAnchors);
        leg.traceClockBridge = bridge;
        leg.traceEventCount = traceEvents.length;
        leg.traceOverlap = summarizeGapTraceOverlap({
          traceEvents,
          gaps: leg.frameGaps.gaps,
          bridge,
        });
      }
    }

    leg.console = consoleLines.slice(-40);
    leg.ok = true;
  } catch (error) {
    if (error instanceof E1RefusalError) {
      throw error;
    }
    leg.ok = false;
    leg.error = String(error?.message ?? error).slice(0, 400);
    leg.console = consoleLines.slice(-40);
  } finally {
    leg.moduleCoverage = summarizeModuleCoverage({
      loadedUrls: [...loadedUrls],
      requiredArtifacts: entryContext.requiredArtifacts,
      origin,
    });
    // End before detaching, and end even when the leg threw. Detaching a
    // session does not stop a browser-global trace, and a browser still
    // recording can refuse the next leg's `Tracing.start` — which would turn
    // one failed leg into a failed run.
    if (browserSession !== null) {
      await closeTraceOnce(traceState, endThisTrace);
      await browserSession.detach().catch(() => {});
    }
    // Recorded on every leg so the receipt can tell "not traced" from "traced
    // and abandoned". `null` means this leg was never asked to trace.
    leg.traceStarted = traceState.started;
    leg.traceEnded = traceState.started ? traceState.ended : null;
    if (traceState.endError !== null) {
      leg.traceEndError = traceState.endError;
    }
    if (traceState.started === true && leg.traceOverlap === undefined) {
      leg.traceOverlap = {
        attributed: false,
        reason:
          traceState.ended === true
            ? "trace-ended-but-leg-did-not-reach-attribution"
            : `trace-not-ended: ${traceState.endError ?? "unknown"}`,
        gaps: [],
      };
    }
    await context.close().catch(() => {});
  }
  return leg;
}

/**
 * The page time the first REPORTED gap opened, in the order the gaps happened.
 *
 * The decomposition sorts by duration, so the longest gap is first; "before the
 * first gap opens" is about time, not size.
 *
 * @param {{gaps: object[]}} decomposition From `decomposeFrameGaps`.
 * @returns {number|null} The page timestamp, or null when there are no gaps.
 */
export function firstGapStartOf(decomposition) {
  const starts = (decomposition?.gaps ?? [])
    .map((gap) => Number(gap?.startMs))
    .filter((value) => Number.isFinite(value));
  return starts.length === 0 ? null : Math.min(...starts);
}

/**
 * Run a plan of legs in order, handing the caller its results as they land.
 *
 * The array is the CALLER'S, and every completed leg is in it before the next
 * one starts, so a leg that throws — or a process the operating system kills
 * for exhausting memory partway through leg four — cannot take the first three
 * legs' measurements with it. A run of this shape costs 25-35 minutes of Edge
 * time; losing all of it to a late failure is a defect in the harness, not an
 * accident of the run.
 *
 * @param {object} input The plan and the per-leg runner.
 * @param {ReadonlyArray<object>} input.plan The steps, in order.
 * @param {Function} input.runOne Runs one step; awaited.
 * @param {object[]} input.legs The caller's results array, appended in place.
 * @param {Function} [input.onLegComplete] Called with `legs` after each one.
 * @returns {Promise<object[]>} The same array.
 */
export async function runLegPlan({ plan, runOne, legs, onLegComplete }) {
  for (const step of plan) {
    legs.push(await runOne(step));
    if (onLegComplete) {
      await onLegComplete(legs);
    }
  }
  return legs;
}

/**
 * Entry point.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseE2Args(argv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot =
    options.repositoryRoot ?? path.resolve(here, "..", "..");
  const outputDirectory =
    options.outputDirectory ??
    path.join(
      repositoryRoot,
      "Tools",
      "visual-regression",
      "output",
      "dm09-e2",
    );
  mkdirSync(outputDirectory, { recursive: true });

  const origin = `http://localhost:${options.port}`;
  const entryContext = deriveEntryContext(options.entry);
  const { preflightServedBuildArtifacts } =
    await import("./lib/served-build-preflight.mjs");
  const preflight = await preflightServedBuildArtifacts({
    origin,
    repositoryRoot,
    artifacts: entryContext.requiredArtifacts,
  });
  throwForDecision(
    decidePreflightRefusal(preflight, entryContext.requiredArtifacts),
    "served-build preflight did not match the on-disk bundles",
  );

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    channel: "msedge",
    headless: !options.headed,
  });

  // The baseline runs on both backends in the requested order, so this
  // receipt's legs remain comparable with E-1's and the stall-locus analyzer
  // still has a WebGL leg to read. The controls exist to move the WebGPU
  // settle window, so they run on WebGPU alone.
  const baselineOrder = options.reverse
    ? ["webgpu", "webgl"]
    : ["webgl", "webgpu"];
  const plan = [];
  for (const name of options.controls) {
    if (name === "baseline") {
      for (const backend of baselineOrder) {
        plan.push({ name, backend });
      }
    } else {
      plan.push({ name, backend: "webgpu" });
    }
  }

  const startedAt = new Date().toISOString();
  const jsonPath = path.join(outputDirectory, "dm09-e2-receipt.json");
  const markdownPath = path.join(outputDirectory, "dm09-e2-summary.md");

  /**
   * Build the receipt over whatever legs have landed and write it out.
   *
   * @param {object[]} completedLegs The legs so far.
   * @param {boolean} complete Whether the plan finished.
   * @returns {object} The receipt that was written.
   */
  const bankReceipt = (completedLegs, complete) => {
    const controlMatrix = buildControlMatrix(
      completedLegs
        .filter((leg) => leg.backend === "webgpu")
        .map((leg) => ({
          control: leg.control,
          backend: leg.backend,
          reached: leg.readiness?.reached === true,
          readyMs: leg.readinessReachedAtMs,
          settleWindowMs: leg.settleWindowMs,
        })),
    );
    const receipt = buildE2Receipt({
      startedAt,
      origin,
      entry: options.entry,
      entryContext,
      reverse: options.reverse,
      preflight,
      traceCategories: E2_TRACE_CATEGORIES,
      legs: completedLegs,
      controlMatrix,
      stallLocus: null,
    });
    // A receipt written mid-run says so on its face, so a reader can never
    // mistake the legs that had landed by leg four for the whole plan.
    receipt.complete = complete;
    receipt.plannedLegCount = plan.length;
    // The locus verdict travels WITH the receipt, so a reader never has to
    // remember to run the analyzer separately and a run that contradicts the
    // banked E-1 finding says so on its own face.
    receipt.stallLocus = analyzeReceipt(receipt);
    writeFileSync(jsonPath, `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(markdownPath, buildE2MarkdownSummary(receipt));
    return receipt;
  };

  const legs = [];
  try {
    await runLegPlan({
      plan,
      legs,
      runOne: (step) =>
        runLeg({
          browser,
          control: resolveControl(step.name, TILESETS),
          backend: step.backend,
          options,
          origin,
          outputDirectory,
          entryContext,
          traceThisLeg:
            options.traceLegs === "all" ||
            (options.traceLegs === "baseline" && step.name === "baseline"),
        }),
      // Banked after every leg rather than once at the end. The alternative
      // spends 25-35 minutes of Edge time and writes nothing if the last leg
      // dies.
      onLegComplete: (completedLegs) => bankReceipt(completedLegs, false),
    });
  } finally {
    await browser.close().catch(() => {});
    if (legs.length > 0 && legs.length < plan.length) {
      bankReceipt(legs, false);
    }
  }

  const receipt = bankReceipt(legs, true);

  console.log(buildE2MarkdownSummary(receipt));
  console.log(`receipt: ${jsonPath}`);
  return legs.every((leg) => leg.ok === true)
    ? EXIT_CODES.OK
    : EXIT_CODES.ERROR;
}

/**
 * The wall-clock bound on a whole run, past which the process ends itself.
 *
 * Sized from the arguments rather than fixed, because the number of controls
 * and the settle deadline are both operator-chosen and a fixed bound would
 * either kill a legitimate long run or fail to end a hung short one.
 *
 * @param {object} options Parsed options.
 * @returns {number} The bound in milliseconds.
 */
export function watchdogBudgetMs(options) {
  const legCount = options.controls.reduce(
    (total, name) => total + (name === "baseline" ? 2 : 1),
    0,
  );
  const perLegOverheadMs = 240000;
  return legCount * (options.settleDeadlineMs + perLegOverheadMs);
}

function isMainModule() {
  const entry = process.argv[1];
  return (
    typeof entry === "string" &&
    import.meta.url === pathToFileURL(path.resolve(entry)).href
  );
}

/**
 * Report a failure and say which exit code it is.
 *
 * The argument parse happens BEFORE the watchdog can be sized, so it sits
 * outside the promise chain and would otherwise escape as an uncaught throw —
 * turning a refusal an operator should read as `REFUSED (port-8080-forbidden)`
 * with exit 3 into a raw stack with exit 1. One reporter serves both paths so
 * they cannot diverge again.
 *
 * @param {unknown} error The failure.
 * @returns {number} The exit code to leave with.
 */
export function reportFailure(error) {
  if (error instanceof E1RefusalError) {
    console.error(`REFUSED (${error.reason}): ${error.message}`);
    console.error(JSON.stringify(error.details ?? null, null, 2));
    return EXIT_CODES.REFUSAL;
  }
  console.error("[probe-aec-residency-e2] FATAL", error);
  return EXIT_CODES.ERROR;
}

if (isMainModule()) {
  let watchdog = null;
  try {
    const budgetMs = watchdogBudgetMs(parseE2Args(process.argv.slice(2)));
    // The load-bearing half of the probe contract: a run that hangs — a trace
    // stream that never reaches eof, a page that never reports ready — ends
    // here instead of occupying an executor slot indefinitely.
    watchdog = setTimeout(() => {
      console.error(
        `[probe-aec-residency-e2] WATCHDOG: no result after ${budgetMs} ms; ending the run`,
      );
      process.exit(EXIT_CODES.ERROR);
    }, budgetMs);
  } catch (error) {
    process.exit(reportFailure(error));
  }
  main()
    .then((code) => {
      clearTimeout(watchdog);
      process.exit(code);
    })
    .catch((error) => {
      clearTimeout(watchdog);
      process.exit(reportFailure(error));
    });
}
