#!/usr/bin/env node
/**
 * Weather Phase 1/3 — mock-EDR offline pipeline probe (Batch 424). WebGPU-only.
 * PINNED for determinism under `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`.
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
 * Usage:
 *   node Tools/visual-regression/probe-weather-edr-mock.mjs
 * Env:
 *   PROBE_BASE  default http://localhost:8080
 * Out:
 *   Tools/visual-regression/output/weather-edr-mock/*.png + manifest.json
 * Exit:
 *   0 every gate decided and passed | 1 a real product FAIL |
 *   2 watchdog or exception | 3 STRUCTURAL — a pin did not take, the fixture
 *     never reached the GPU, or the probe could not reproduce its own capture
 *     (acceptance INCOMPLETE, not green, and not red)
 */
import { chromium } from "playwright";
import fs from "node:fs";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";
import {
  collectPinStructural,
  collectRepeatStructural,
  installWeatherPinHarnessOnPage,
  WEATHER_DETERMINISM_DIALS,
} from "./lib/weather-probe-pinning.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/weather-edr-mock";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
const MOCK_BASE = `${BASE}/mock-edr`;
const VIEW = { width: 1024, height: 768 };

const WATCHDOG_MS = 600_000;

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

  const source = new C.EdrWeatherSource({
    baseUrl: cfg.mockBase,
    collection: "mock-gfs",
    parameterName: "TCDC",
    coverageUnits: "percent",
  });
  const edrUrl = source.buildUrl({ time: "latest" });
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
    const frame = pin.capture(julianDate, wantPng);
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
    edrUrl,
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

function stats(list) {
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  return {
    mean: +mean.toFixed(4),
    range: +(Math.max(...list) - Math.min(...list)).toFixed(4),
  };
}

function fmt(list) {
  return list.map((v) => v.toFixed(3)).join(", ");
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: VIEW });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await installCloudProbeHarnessOnPage(page);
  await installWeatherPinHarnessOnPage(page);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    { timeout: 60000 },
  );
  await armWebGPUDevices(page);

  const result = await page.evaluate(RUN_LANE, {
    ...PIN,
    mockBase: MOCK_BASE,
    determinismDials: WEATHER_DETERMINISM_DIALS,
  });

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .concat(gate.deviceLost ? [gate.deviceLost] : [])
    .filter(
      (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
    );
  await browser.close();

  const { sweepA, sweepB } = result.sweeps;
  const fracsA = sweepA.captures.map((c) => c.frac);
  const fracsB = sweepB.captures.map((c) => c.frac);
  const statsA = stats(fracsA);
  const statsB = stats(fracsB);
  const west = fracsA[0];
  const east = fracsA[fracsA.length - 1];

  // ── Evidence PNGs (canvas-element bits, captured in the same task as the
  // render that produced them), at the longitudes that are actually SCORED.
  const written = [];
  for (const capture of sweepA.captures) {
    if (!capture.png) {
      continue;
    }
    const name =
      capture.lon === PIN.lonSweep[0]
        ? "weather-edr-mock-west.png"
        : "weather-edr-mock-east.png";
    fs.writeFileSync(
      `${OUT}/${name}`,
      Buffer.from(capture.png.slice(capture.png.indexOf(",") + 1), "base64"),
    );
    written.push(name);
  }

  console.log(
    `renderer=${result.pins.rendererType} pins=${JSON.stringify(result.pins)}`,
  );
  console.log(`dials ${JSON.stringify(result.dials)}`);
  console.log(
    `readiness globe{binned=${result.readiness.globeReady.binnedGlobeCommands} firstMs=${result.readiness.globeReady.firstBinnedMs} elapsedMs=${result.readiness.globeReady.elapsedMs}} procedural{frames=${result.readiness.proceduralReady.waitedFrames} executeCalls=${result.readiness.proceduralReady.executeCalls}}`,
  );
  console.log(`edrUrl ${result.edrUrl}`);
  console.log(`state ${JSON.stringify(result.providerState)}`);
  console.log(`applied ${JSON.stringify(result.applied)}`);
  console.log(`frA: ${fmt(fracsA)} -> ${JSON.stringify(statsA)}`);
  console.log(`frB: ${fmt(fracsB)} -> ${JSON.stringify(statsB)}`);
  console.log(
    `meanMax: ${sweepA.captures.map((c) => c.meanMax.toFixed(1)).join(", ")}`,
  );
  console.log(`west=${west.toFixed(3)} east=${east.toFixed(3)}`);
  console.log(`errs ${newErrs.length}`);

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
  console.log(
    `\n=== DETERMINISM CONTROL (sweepA vs sweepB, one configuration) ===\n` +
      `  per-location |delta|: ${fmt(control.deltas)}\n` +
      `  max per-location ${control.maxPerSample.toFixed(4)} (tolerance ${CONTROL.perSample})\n` +
      `  sweep mean ${statsA.mean} vs ${statsB.mean}, delta ${control.meanDelta.toFixed(4)} (tolerance ${CONTROL.mean})\n` +
      `  cloud time uniform (slot 35) drift: ${control.timeDrift.length === 0 ? "none" : JSON.stringify(control.timeDrift)}`,
  );
  structural.push(...control.reasons);

  // ── Scored gates. Thresholds UNCHANGED from the pre-pinning probe.
  const urlOk =
    typeof result.edrUrl === "string" &&
    result.edrUrl.startsWith(MOCK_BASE) &&
    result.edrUrl.includes("/collections/mock-gfs/cube?") &&
    result.edrUrl.includes("parameter-name=TCDC");
  const state = result.providerState;
  const checks = [
    ["EdrWeatherSource.buildUrl() targets the mock endpoint", urlOk],
    [
      "provider FETCHED + PARSED the fixture (hasData, version>0, no fallback)",
      !!state && state.hasData && state.version > 0 && !state.lastError,
    ],
    [
      `fixture spatial pattern reaches the deck (overcast east ${east.toFixed(3)} ` +
        `> clear west ${west.toFixed(3)} by >= ${ASSERT.westEastMargin})`,
      east - west >= ASSERT.westEastMargin,
    ],
    [`no NEW device errors (${newErrs.length})`, newErrs.length === 0],
  ];

  console.log("\n=== ANALYSIS ===");
  let pass = true;
  // A silent WebGL fallback HARD-FAILS rather than reporting STRUCTURAL: scoring
  // a WebGL frame as a WebGPU pass is a false green, not a blind leg.
  const backendOk = result.pins.rendererType === "webgpu";
  console.log(
    `  [${backendOk ? "PASS" : "FAIL"}] backend is WebGPU (${result.pins.rendererType})`,
  );
  if (!backendOk) {
    pass = false;
  }
  for (const [name, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
    if (!ok) {
      pass = false;
    }
  }
  if (newErrs.length) {
    console.log("  errors:", newErrs.slice(0, 5));
  }
  if (state && state.lastError) {
    console.log("  lastError:", state.lastError);
  }
  if (written.length) {
    console.log(`  evidence PNGs: ${written.join(", ")} (in ${OUT})`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    url: URL,
    pin: PIN,
    assert: ASSERT,
    control: {
      ...CONTROL,
      maxPerSample: control.maxPerSample,
      meanDelta: control.meanDelta,
      ok: control.reasons.length === 0,
    },
    result,
    stats: { sweepA: statsA, sweepB: statsB, west, east },
    errors: newErrs,
    structural,
    verdict: structural.length ? "STRUCTURAL" : pass ? "GREEN" : "RED",
  };
  // Strip the base64 PNGs out of the manifest — they are already on disk.
  for (const s of Object.values(manifest.result.sweeps)) {
    for (const c of s.captures) {
      delete c.png;
    }
  }
  fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));

  if (structural.length) {
    console.log("\n=== STRUCTURAL ===");
    for (const reason of structural) {
      console.log(`  - ${reason}`);
    }
    console.log(
      "\nRESULT: STRUCTURAL — acceptance INCOMPLETE. This probe certifies nothing in this state; the gate verdicts above are printed for diagnosis only.",
    );
    process.exitCode = 3;
    return;
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  process.exitCode = pass ? 0 : 1;
}

const watchdog = setTimeout(() => {
  console.error(`STRUCTURAL: probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

run()
  .catch((error) => {
    console.error(`STRUCTURAL: ${error?.stack ?? error}`);
    process.exitCode = 2;
  })
  .finally(() => clearTimeout(watchdog));
