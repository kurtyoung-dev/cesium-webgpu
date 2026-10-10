#!/usr/bin/env node
/**
 * Weather Phase 1/3 — mock-EDR offline pipeline probe (Batch 424). WebGPU-only.
 * @purpose Gate-B leg: full EDR ingest chain (fetch, CoverageJSON, packer, weatherTex, clouds) end-to-end against the /mock-edr fixture, offline; hosts the coverage-sweep lane the WCS leg declares.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * PINNED for determinism under `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`.
 *
 * ONE LANE, TWO SOURCES (probe-kit harvest). `probe-weather-wcs.mjs` was this
 * file with a different source class, collection, URL check and file names —
 * the same pins, sweep, gates and thresholds, measured by the same page code.
 * Both sources are now rows of `COVERAGE_SWEEP_SOURCES` below, and the WCS leg
 * is a declaration over `sweepDescriptor("wcs")`. A further offline coverage
 * source is one more row, not one more copy of this file.
 *
 * Proves the FULL EDR ingest chain — fetch -> CoverageJSON parse -> packer ->
 * weatherTex -> clouds — works end-to-end WITHOUT the live (CORS-uncertain,
 * dev-lab) network, by pointing an EdrWeatherSource at the dev server's
 * `/mock-edr` route, which serves a committed CoverageJSON fixture
 * (Tools/visual-regression/fixtures/edr-cube-tcc.json: a 12x6 TCDC grid with a
 * recognizable clear-NW -> overcast-SE pattern + a clear "eye" in the east).
 * This retroactively completes Phase 1's end-to-end verification that the live
 * network blocked.
 *
 * Measurement: fly a 250 km nadir camera west->east across the fixture
 * (sky/sun/skyBox OFF, dark globe) and count bright pixels at each longitude.
 * The fixture ramps clear(west) -> overcast(east), so the per-location cloud
 * fraction should rise west->east.
 *
 * WHAT IS SCORED — every threshold below is UNCHANGED from the pre-pinning
 * probe. None was widened, lowered, or dropped.
 *   1 URL       `EdrWeatherSource.buildUrl()` targets the mock endpoint
 *   2 FETCHED   the provider fetched + parsed the fixture (`hasData`,
 *               `version > 0`, no `lastError` — i.e. NO fallback-to-procedural)
 *   3 PATTERN   the fixture's spatial pattern reaches the deck:
 *               `east - west >= 0.03`
 *   4 CLEAN     0 new device / console errors
 *   plus BACKEND `scene.context.rendererType === "webgpu"`. A silent WebGL
 *               fallback HARD-FAILS: volumetric clouds are WebGPU-only, so
 *               scoring a WebGL frame as a WebGPU pass is a false green.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PROBE WAS PINNED
 * ─────────────────────────────────────────────────────────────────────────────
 * It was one of the six Gate-B legs recorded GREEN while `probe-weather-
 * channels.mjs` flipped GREEN/RED/RED/RED/RED on one build. The audit
 * (`C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`) classified it SUSCEPTIBLE, because
 * its scored quantity is the SAME instrument that produced the flip:
 *
 *   - The metric was a raw `max(r,g,b) > 120` count over the central 60% of a
 *     nadir frame, and the probe loaded `?renderer=webgpu` with NO `offline`
 *     flag. `CesiumViewerStartupOptions.js:27-42` therefore supplied Cesium
 *     World Terrain and the Ion world-imagery base layer, and lit ocean/land
 *     imagery clears 120 comfortably. The metric was partly counting imagery.
 *   - Worse, the contamination is ORDERED. `west` (lon -160) is the FIRST
 *     longitude visited, ~7 s after setup; `east` (lon 160) is the LAST, nine
 *     camera jumps later, with a far warmer tile cache. Streamed imagery
 *     therefore biases `east - west` UPWARD — the exact direction gate 3 scores.
 *     That is a false-GREEN path on the only pixel assertion in this probe.
 *   - Wind was at its 15.0 m/s default and every render was `s.render()` with NO
 *     argument, which `Scene.js` fills with `JulianDate.now()`. The cloud field
 *     was advecting off the wall clock throughout the sweep.
 *   - `cloudQuality` was at its 64 default, i.e. the TIER path, which at 250 km
 *     resolves temporal accumulation + jitter + half-res — all frame-index
 *     inputs to the march.
 *   - The provider wait was a flat 7 s `waitForTimeout` on `hasData`, which says
 *     the CPU pack exists, not that the bytes reached the GPU texture and the
 *     uniform enabled the map. Until it does, the deck renders from global
 *     coverage — dense everywhere — an independent route to a saturated sample.
 *
 * The pins are P1-P8 as documented in `lib/weather-probe-pinning.mjs`; that
 * module is the shared enforceable home, and `probe-weather-channels.mjs` is the
 * reference implementation. Every pin is READ BACK — from the scene for the
 * scene pins, from packed cloud-uniform slots 35/44/64/74/107 for the
 * shader-visible ones — and a pin that did not take reports STRUCTURAL.
 *
 * DETERMINISM CONTROL. The sweep is captured TWICE back to back under one
 * configuration (`sweepA` then `sweepB`). The two must agree per longitude
 * within `CONTROL.perSample` and on the sweep mean within `CONTROL.mean`, and
 * the cloud `time` uniform must read the SAME value at each longitude in both.
 * Both tolerances sit strictly inside gate 3's scored 0.03 margin, so a control
 * PASS means residual capture noise cannot flip the assertion. If it fails the
 * probe reports STRUCTURAL (exit 3) and certifies NOTHING.
 *
 * WHAT THE PINNING CHANGES ABOUT THE NUMBERS. Removing imagery, stopping the
 * wind, escaping the tier path and fixing the clock all move the ABSOLUTE
 * fractions. Any `fr:` values recorded for this probe before this pass are NOT a
 * baseline and must not be compared against. Gate 3 is relative (east vs west
 * within one sweep), so the comparison survives; the absolute level does not.
 *
 * RUNTIME (probe-kit harvest). The browser, the served-build preflight, the
 * Edge slot, the deadline and the receipt belong to `lib/probe-runtime.mjs`;
 * this file keeps the page lane, the pins and the gates. The page lane and
 * every threshold are byte-for-byte what they were before the migration.
 *
 * Usage (serve the built tree on a governed port first, e.g.
 * `node server.js --port 8094 --serve-built`):
 *   node Tools/visual-regression/probe-weather-edr-mock.mjs [--port 8094] [--runs 10]
 * Out:
 *   Tools/visual-regression/output/weather-edr-mock/*.png, plus the runtime's
 *   weather-edr-mock-report.json / -runtime.json / -summary.md
 * Exit (the runtime's table):
 *   0 every gate decided and passed | 1 a real product FAIL |
 *   2 harness error or deadline | 3 STRUCTURAL, raised as a refusal — a pin
 *     did not take, the fixture never reached the GPU, or the probe could not
 *     reproduce its own capture (acceptance INCOMPLETE, not green, and not red)
 */
import fs from "node:fs";
import path from "node:path";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";
import { sweepStats } from "./lib/metrics/sweep-stats.mjs";
import {
  ProbeRefusal,
  isEntryPoint,
  runProbe,
  sha256,
} from "./lib/probe-runtime.mjs";
import {
  collectPinStructural,
  collectRepeatStructural,
  installWeatherPinHarnessOnPage,
  WEATHER_DETERMINISM_DIALS,
} from "./lib/weather-probe-pinning.mjs";

const PAGE = "/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true";
const VIEW = { width: 1024, height: 768 };

/**
 * The offline coverage sources this lane sweeps, keyed by the leg's short
 * name. Each row is everything its leg does NOT share with the other: the
 * dev-server mock route, the source class and collection the page builds,
 * the URL markers gate 1 requires, and the evidence file names. Both serve a
 * committed 12x6 TCDC CoverageJSON fixture through the shared parser.
 */
export const COVERAGE_SWEEP_SOURCES = Object.freeze({
  edr: Object.freeze({
    name: "weather-edr-mock",
    title:
      "Weather mock-EDR leg: fetch, CoverageJSON parse, packer, weatherTex and clouds, offline",
    mockPath: "/mock-edr",
    sourceClass: "EdrWeatherSource",
    collection: "mock-gfs",
    urlMarkers: Object.freeze([
      "/collections/mock-gfs/cube?",
      "parameter-name=TCDC",
    ]),
    evidence: Object.freeze({
      west: "weather-edr-mock-west.png",
      east: "weather-edr-mock-east.png",
    }),
  }),
  wcs: Object.freeze({
    name: "weather-wcs",
    title:
      "Weather mock OGC API-Coverages leg: the shared CoverageJSON parser, packer, weatherTex and clouds, offline",
    mockPath: "/mock-wcs",
    sourceClass: "WcsCoveragesWeatherSource",
    collection: "gdps-cloud-cover",
    urlMarkers: Object.freeze([
      "/collections/gdps-cloud-cover/coverage?",
      "bbox=",
    ]),
    evidence: Object.freeze({
      west: "weather-wcs-mock-west.png",
      east: "weather-wcs-mock-east.png",
    }),
  }),
});

/** The pre-migration watchdog bound, now the lifecycle's per-run work budget. */
const WORK_BUDGET_MS = 600_000;

const PIN = {
  // West -> east longitudes across the fixture (clear -> overcast ramp).
  // UNCHANGED from the pre-pinning probe.
  lonSweep: [-160, -120, -80, -40, 0, 40, 80, 120, 160],
  lat: 30.0,
  cameraHeight: 250_000.0,
  brightThreshold: 120,
  warmupDiscards: 2,
  viewSettleMs: 1000,
  sourceSettleMs: 1500,
  sourceBudgetMs: 30_000,
  readyMinSettleMs: 3000,
  readyBudgetMs: 90_000,
  readyMaxFrames: 120,
};

/** Scored thresholds — IDENTICAL to the pre-pinning probe. */
const ASSERT = {
  westEastMargin: 0.03,
};

/** Determinism-control tolerances — strictly inside ASSERT.westEastMargin. */
const CONTROL = {
  perSample: 0.005,
  mean: 0.0025,
};

/**
 * Everything below runs INSIDE the page. `page.evaluate` serializes the function
 * source and drops the surrounding closure, so the shared helpers arrive through
 * `globalThis.__weatherPin` / `globalThis.__cloudProbe` (installed via
 * `addInitScript`) rather than through imports.
 */
const RUN_LANE = async (cfg) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const pin = globalThis.__weatherPin;
  const scene = window.viewer.scene;

  // ── P1/P2/P8.
  const pins = pin.pinScene(C, {
    darkGlobe: true,
    groundAtmosphere: false,
    fog: false,
    sky: false,
  });

  // ── Cloud dials. Coverage/density/layer are the AUTHORED scene and are
  // deliberately unchanged; the determinism dials (P3/P4/P8) are spread in from
  // the shared module. `configure` validates every round trip and throws on a
  // dial that did not take.
  const volumetricDials = {
    cloudCoverage: 0.6,
    cloudDensity: 0.9,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWeatherChannelStrength: 1.0,
    ...cfg.determinismDials,
  };
  const configure = () =>
    globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: volumetricDials,
    });

  // ── P6: per-location local mean noon. A single fixed UTC instant necessarily
  // puts part of a 320-degree sweep in darkness, which would let gate 3's
  // west<east be satisfied by the terminator rather than by the fixture.
  const timeForLon = new Map();
  for (const lon of cfg.lonSweep) {
    timeForLon.set(lon, pin.localNoonAt(C, lon));
  }
  const readyTime = timeForLon.get(cfg.lonSweep[0]);

  const setView = (lon) =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, cfg.lat, cfg.cameraHeight),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });

  // ── Readiness, then the source, then the legs.
  setView(cfg.lonSweep[0]);
  const globeReady = await pin.awaitGlobeReady(
    C,
    readyTime,
    cfg.readyMinSettleMs,
    cfg.readyBudgetMs,
  );
  // configure() is what actually ENABLES the volumetric renderer; awaiting
  // readiness without it times out at executeCalls=0, which reads exactly like a
  // broken renderer rather than an unconfigured one.
  const configured = configure();
  const proceduralReady = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime: readyTime,
    maxFrames: cfg.readyMaxFrames,
  });

  // The one line that differs between the EDR and WCS legs: which source class
  // and collection the page builds (`COVERAGE_SWEEP_SOURCES`).
  const source = new C[cfg.sourceClass]({
    baseUrl: cfg.mockBase,
    collection: cfg.collection,
    parameterName: "TCDC",
    coverageUnits: "percent",
  });
  const sourceUrl = source.buildUrl({ time: "latest" });
  const volumetric = scene.globe.defaultCloudCollection.volumetric;
  // Assigned directly rather than through `configure`, whose round-trip snapshot
  // would deep-walk the packed Uint8Array the provider holds.
  volumetric.weatherProvider = new C.WeatherProvider(source);
  const provider = volumetric.weatherProvider;

  // ── P5: the fixture bytes must reach the GPU and the uniform must enable the
  // map. A flat sleep on `hasData` proves neither.
  const applied = await pin.awaitWeatherApplied(
    provider,
    readyTime,
    cfg.sourceBudgetMs,
  );
  await pin.settle(readyTime, cfg.sourceSettleMs);

  const captureAt = async (lon, wantPng) => {
    const julianDate = timeForLon.get(lon);
    setView(lon);
    // DISCARDED warm-up renders: the first frames after a camera jump can be the
    // async prewarm's cold start.
    for (let i = 0; i < cfg.warmupDiscards; i++) {
      pin.renderAt(julianDate);
    }
    const settledFrames = await pin.settle(julianDate, cfg.viewSettleMs);
    // ── P7: same-task capture.
    const frame = await pin.capture(julianDate, wantPng);
    const metric = pin.brightFraction(frame, cfg.brightThreshold, 3);
    return {
      lon,
      settledFrames,
      png: frame.png,
      slots: frame.slots,
      ...metric,
    };
  };

  const sweep = async (label, pngLons) => {
    const captures = [];
    for (const lon of cfg.lonSweep) {
      captures.push(await captureAt(lon, pngLons.includes(lon)));
    }
    return { label, captures };
  };

  const west = cfg.lonSweep[0];
  const east = cfg.lonSweep[cfg.lonSweep.length - 1];
  const sweepA = await sweep("sweepA", [west, east]);
  const sweepB = await sweep("sweepB", []);

  return {
    sourceUrl,
    providerState: {
      hasData: provider.hasData,
      version: provider.version,
      lastError: provider.lastError ? String(provider.lastError) : null,
    },
    pins,
    dials: pin.readDials(),
    readiness: { globeReady, proceduralReady, configured },
    applied: { fixture: applied },
    sweeps: { sweepA, sweepB },
  };
};

function fmt(list) {
  return list.map((v) => v.toFixed(3)).join(", ");
}

/**
 * Score one run from the page lane's own return value. Pure: the result, the
 * filtered error list, the mock base the source was pointed at and the source
 * row go in; the gates, the STRUCTURAL reasons and the numbers the receipt
 * banks come out. Every threshold is the pre-migration probe's.
 *
 * @param {object} result What `RUN_LANE` returned.
 * @param {string[]} errors New device / console errors, already filtered.
 * @param {string} mockBase The mock endpoint this run's source targeted.
 * @param {object} source The `COVERAGE_SWEEP_SOURCES` row this run swept.
 * @returns {{checks: Array<[string, string, boolean]>, structural: string[],
 *   stats: object, control: object}}
 */
export function scoreCoverageSweep(result, errors, mockBase, source) {
  const { sweepA, sweepB } = result.sweeps;
  const fracsA = sweepA.captures.map((c) => c.frac);
  const fracsB = sweepB.captures.map((c) => c.frac);
  const west = fracsA[0];
  const east = fracsA[fracsA.length - 1];

  // ── STRUCTURAL preconditions.
  const labelled = [
    ...sweepA.captures.map((c) => ({ ...c, label: `sweepA lon ${c.lon}` })),
    ...sweepB.captures.map((c) => ({ ...c, label: `sweepB lon ${c.lon}` })),
  ];
  const structural = collectPinStructural({
    pins: result.pins,
    dials: result.dials,
    captures: labelled,
    applied: result.applied,
    globeReadiness: { setup: result.readiness.globeReady },
    expectedChannelStrength: 1,
    brightThreshold: PIN.brightThreshold,
  });

  // ── DETERMINISM CONTROL.
  const control = collectRepeatStructural({
    label: "sweepA vs sweepB",
    a: sweepA.captures.map((c) => ({
      key: c.lon,
      value: c.frac,
      time: c.slots.time,
    })),
    b: sweepB.captures.map((c) => ({
      key: c.lon,
      value: c.frac,
      time: c.slots.time,
    })),
    perSample: CONTROL.perSample,
    mean: CONTROL.mean,
  });
  structural.push(...control.reasons);

  // ── Scored gates. Thresholds UNCHANGED from the pre-pinning probe.
  const urlOk =
    typeof result.sourceUrl === "string" &&
    result.sourceUrl.startsWith(mockBase) &&
    source.urlMarkers.every((marker) => result.sourceUrl.includes(marker));
  const state = result.providerState;
  return {
    checks: [
      // A silent WebGL fallback HARD-FAILS rather than reporting STRUCTURAL:
      // scoring a WebGL frame as a WebGPU pass is a false green, not a blind leg.
      [
        "backend-webgpu",
        `backend is WebGPU (${result.pins.rendererType})`,
        result.pins.rendererType === "webgpu",
      ],
      [
        "url",
        `${source.sourceClass}.buildUrl() targets the mock endpoint`,
        urlOk,
      ],
      [
        "fetched",
        "provider FETCHED + PARSED the fixture (hasData, version>0, no fallback)",
        Boolean(
          state && state.hasData && state.version > 0 && !state.lastError,
        ),
      ],
      [
        "pattern",
        `fixture spatial pattern reaches the deck (overcast east ${east.toFixed(3)} ` +
          `> clear west ${west.toFixed(3)} by >= ${ASSERT.westEastMargin})`,
        east - west >= ASSERT.westEastMargin,
      ],
      ["clean", `no NEW device errors (${errors.length})`, errors.length === 0],
    ],
    structural,
    stats: {
      sweepA: sweepStats(fracsA),
      sweepB: sweepStats(fracsB),
      west,
      east,
    },
    control: {
      ...CONTROL,
      deltas: control.deltas,
      maxPerSample: control.maxPerSample,
      meanDelta: control.meanDelta,
      timeDrift: control.timeDrift,
      ok: control.reasons.length === 0,
    },
  };
}

/**
 * The runtime descriptor for one coverage source: the page lane runs in
 * `cells`, the gates in `verdicts`. `probe-weather-wcs.mjs` is this with
 * `"wcs"`; this file's own entry point is `"edr"`.
 *
 * @param {keyof typeof COVERAGE_SWEEP_SOURCES} key Which source to sweep.
 * @returns {object} The descriptor `runProbe` executes.
 */
export function sweepDescriptor(key) {
  const source = COVERAGE_SWEEP_SOURCES[key];
  if (source === undefined) {
    throw new TypeError(`no coverage sweep source named ${String(key)}`);
  }
  return {
    name: source.name,
    title: source.title,
    outputSubdirectory: source.name,
    receiptEnvelope: "probe-owned",
    // The viewer page and the page lane both import this one ESM entry; the
    // Sandcastle2 bucket bundle in the runtime's default list is never loaded.
    servedArtifacts: ["Build/CesiumUnminified/index.js"],
    workBudgetMs: () => WORK_BUDGET_MS,
    async cells({ browser, run, options, origin, outputDirectory, captures }) {
      if (!options.renderers.includes("webgpu")) {
        throw new ProbeRefusal(
          "renderer-unavailable",
          "volumetric clouds are WebGPU-only, so this leg measured on " +
            `${options.renderers.join(",")} would score an empty deck`,
          { renderers: options.renderers },
        );
      }
      const page = await browser.newPage({ viewport: VIEW });
      const consoleErrors = attachConsoleErrorGate(page);
      await page.addInitScript(errorGateInit);
      await installCloudProbeHarnessOnPage(page);
      await installWeatherPinHarnessOnPage(page);
      await page.goto(`${origin}${PAGE}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => !!(window.viewer && window.viewer.scene),
        null,
        { timeout: 60000 },
      );
      await armWebGPUDevices(page);

      const mockBase = `${origin}${source.mockPath}`;
      const result = await page.evaluate(RUN_LANE, {
        ...PIN,
        mockBase,
        sourceClass: source.sourceClass,
        collection: source.collection,
        determinismDials: WEATHER_DETERMINISM_DIALS,
      });

      const gate = await collectGateErrors(page);
      const errors = (gate.errors || [])
        .concat(consoleErrors)
        .concat(gate.deviceLost ? [gate.deviceLost] : [])
        .filter(
          (e) =>
            !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
        );

      // ── Evidence PNGs (canvas-element bits, captured in the same task as
      // the render that produced them), at the longitudes actually SCORED.
      const written = [];
      fs.mkdirSync(outputDirectory, { recursive: true });
      for (const capture of result.sweeps.sweepA.captures) {
        if (!capture.png) {
          continue;
        }
        const name =
          capture.lon === PIN.lonSweep[0]
            ? source.evidence.west
            : source.evidence.east;
        const bytes = Buffer.from(
          capture.png.slice(capture.png.indexOf(",") + 1),
          "base64",
        );
        const file = path.join(outputDirectory, name);
        fs.writeFileSync(file, bytes);
        captures.push({
          name,
          path: file,
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        });
        written.push(name);
      }
      // The PNGs are on disk; the receipt keeps the numbers, not the base64.
      for (const sweep of Object.values(result.sweeps)) {
        for (const capture of sweep.captures) {
          delete capture.png;
        }
      }

      const scored = scoreCoverageSweep(result, errors, mockBase, source);
      console.log(
        `${source.name} run ${run}: ${result.pins.rendererType} | ` +
          `frA ${fmt(result.sweeps.sweepA.captures.map((c) => c.frac))} | ` +
          `frB ${fmt(result.sweeps.sweepB.captures.map((c) => c.frac))} | ` +
          `control max ${scored.control.maxPerSample.toFixed(4)} mean ${scored.control.meanDelta.toFixed(4)} | ` +
          `errs ${errors.length}`,
      );
      // STRUCTURAL is a refusal, never a verdict: the runtime exits 3 and banks
      // the reasons and the numbers in the refusal record, not a receipt.
      if (scored.structural.length > 0) {
        throw new ProbeRefusal(
          "weather-structural",
          `STRUCTURAL in run ${run}, acceptance INCOMPLETE: ${scored.structural.join(" | ")}`,
          { run, scored },
        );
      }
      return [{ run, result, errors, written, scored }];
    },
    verdicts(cells) {
      return cells.flatMap((cell) =>
        cell.scored.checks.map(([id, claim, pass]) => ({
          id: cells.length > 1 ? `run${cell.run}:${id}` : id,
          claim,
          pass,
        })),
      );
    },
    receipt(cells) {
      return {
        page: PAGE,
        source,
        pin: PIN,
        assert: ASSERT,
        control: CONTROL,
        runs: cells,
      };
    },
  };
}

/** This file's own leg: the EDR source. */
export const descriptor = sweepDescriptor("edr");

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
