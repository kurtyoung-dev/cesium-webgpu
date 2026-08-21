#!/usr/bin/env node
/**
 * Weather Phase 3 — G/B/A weather-channel reads (Batch 424). WebGPU-only.
 * @purpose Gate-B leg: raymarcher applies weather-map G/B/A channels, 9-longitude sweep with a richA/richB determinism control bracketing scored swaps.
 * @status ACTIVE
 *
 * PINNED for determinism under `C13-GATE-B-CHANNELS-PROBE-NONDETERMINISM`.
 *
 * Proves the cloud raymarcher APPLIES the weather map's G (genus), B (cloud
 * base) and A (density-bias) channels, not just R (coverage). Drives a
 * `SyntheticWeatherSource("rich")` field whose R is near-flat (0.85 everywhere)
 * but whose A varies WEST(thin 0.05) -> EAST(dense 0.95), B varies NORTH(low) ->
 * SOUTH(high), and G varies WEST(stratus/SLAB) -> EAST(cumulonimbus/TOWER)
 * (`Scene/Weather/SyntheticWeatherSource.ts:129-141`; the source is pure
 * arithmetic with no RNG and no clock dependence).
 *
 * Measurement: fly a 250 km nadir camera to nine far-apart longitudes at a fixed
 * latitude, with sky/sun/skyBox OFF and a dark globe, and count bright pixels at
 * each. Because R is ~flat, the per-location spread is driven by A (and the
 * genus/base shape change from G/B).
 *
 * WHAT IS SCORED — every threshold below is UNCHANGED from the pre-pinning
 * probe. None was widened, lowered, or dropped.
 *   1 DECK       the rich field renders a deck (`hasData`, `version > 0`)
 *   2 PRESENT    clouds present across the sweep (rich mean > 0.02)
 *   3 SPREAD     rich stddev >= neutral stddev + 0.01 — the same flat R cannot
 *                produce it, so the excess is the G/B/A response
 *   4 WEST/EAST  west(thin A, flat G) is lighter than east(dense A, tower G),
 *                west < east - 0.02
 *   5 GATED      `cloudWeatherChannelStrength = 0` collapses the spread back
 *                toward the neutral control (neutral G=0.5/B=0/A=0.5 is a no-op)
 *   6 CLEAN      0 new device / console errors
 *   plus BACKEND `scene.context.rendererType === "webgpu"`. A silent WebGL
 *                fallback HARD-FAILS: scoring a WebGL frame as a WebGPU pass is
 *                a false green (the `probe-vector-draping.mjs` gate-A rule).
 *
 * DETERMINISM CONTROL — the reason this file was rewritten. The rich sweep is
 * captured TWICE under one configuration (`richA` then `richB`).
 * The two captures must agree per location within `CONTROL.perLocation` and on
 * the sweep mean within `CONTROL.mean`, and the cloud `time` uniform must read
 * the SAME value at each location in both. If they do not, the probe
 * reports STRUCTURAL (exit 3) with the measured spread and certifies NOTHING —
 * a probe that cannot reproduce its own capture cannot certify a channel. Note
 * that `richB` reaches location 0 from location 8 while `richA` reaches it from
 * the readiness pose, so the control also tests independence from view history,
 * which is where the recorded flip lived.
 *
 * THE CONTROL NOW BRACKETS THE SCORED GAP (Batch 861). It originally ran
 * `richA -> richB` back to back, BEFORE the neutral and gated legs. But nothing
 * this probe scores is read across that gap: gate 3 differences `rich` against
 * `neutral` (a SOURCE swap), and gate 5 differences `richOff` against both (a
 * source swap AND a strength change). A control that only spans a back-to-back
 * repeat certifies stability across an interval no assertion reads. The order is
 * therefore `richA -> neutral -> richOff -> richB`, so `richA`/`richB` bracket
 * every source and strength change the scored gates read across — the same
 * convention `probe-weather-metar.mjs` (`ch1A -> ch0 -> ch1B`) and
 * `probe-weather-ingest.mjs` (`hiA -> lo -> hiB`) already use. The tolerances are
 * UNCHANGED; only the interval they bound got wider, which is strictly stronger.
 *
 * SHARED PINNING (Batch 861). This probe was pinned at Batch 852, three batches
 * BEFORE `lib/weather-probe-pinning.mjs` was extracted from it at Batch 855 for
 * the other five Gate-B legs — so it was the reference implementation and also
 * the last holder of a private copy. It now consumes the shared module like its
 * five siblings: `installWeatherPinHarnessOnPage` for the in-page pins,
 * same-task capture, wall-clock settle, binned-`Pass.GLOBE` readiness and
 * `awaitWeatherApplied`; `collectPinStructural` for read-back enforcement; and
 * `collectRepeatStructural` for the control. That closes the copy, and it also
 * gains the read-backs the private copy never had — `requestRenderMode`,
 * `clock.multiplier`, the `cloudQuality`/`cloudCastShadows`/`cloudContributesIBL`
 * dial round trips — every one an ADDITIONAL structural check. No scored
 * threshold moved.
 *
 * The tolerances are set strictly INSIDE the smallest scored margin (gate 3's
 * 0.01 on stddev, gate 4's 0.02 on a fraction), so a control PASS means the
 * residual capture noise cannot flip an assertion. They are small-but-nonzero
 * rather than exact-equality only because this probe had never once reproduced
 * its own capture; the first pinned runs should REPORT the true residual instead
 * of failing on an unmeasured epsilon. If ten runs measure 0.000, tighten them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PINNING MECHANISM, AND WHY EACH PIN IS HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * Recorded evidence: five runs on ONE build with no rebuild between them gave
 * verdicts GREEN/RED/RED/RED/RED, a rich mean swinging 0.4129..0.5374 (~30%),
 * and a `west` sample flipping between 0.000 and a fully saturated 1.000. The
 * mean deltas are ~1/9 of the sweep, i.e. dominated by ONE location changing
 * state — the first one visited.
 *
 * P1 OFFLINE GLOBE. The old probe loaded `?renderer=webgpu` with no `offline`
 *    flag, so `CesiumViewerStartupOptions.js:36-42` handed the Viewer Cesium
 *    World Terrain AND the Ion world-imagery base layer. Nine far-apart
 *    longitudes therefore streamed network imagery/terrain during the capture,
 *    and `mx > 120` counts a bright imagery tile as CLOUD. lon -170 / lat 25 is
 *    open ocean: unloaded it shows the dark `baseColor` (max 25 -> frac 0.000),
 *    loaded it shows bright ocean imagery over the whole frame (frac 1.000).
 *    That is exactly the recorded bimodal flip, on exactly the location most
 *    likely to be caught mid-load (the first one after a camera jump). Every
 *    other cloud probe in the fleet already loads `&offline=true`; this one did
 *    not. Now: `&offline=true`, plus `imageryLayers.removeAll()` and a forced
 *    `EllipsoidTerrainProvider`, both READ BACK and reported STRUCTURAL if the
 *    globe is still network-fed. This is also a measurement fix, not only a
 *    determinism fix: the old metric was partly counting imagery.
 *
 * P2 ONE RENDER DRIVER, ONE CLOCK. The old probe left
 *    `viewer.useDefaultRenderLoop` true, so the widget's rAF loop rendered with
 *    `clock.tick()` while the probe's own loop called `scene.render()` with NO
 *    argument — and `Scene.js:4222-4224` then substitutes `JulianDate.now()`.
 *    The cloud `time` uniform is derived from `frameState.time`
 *    (`WebGPUProceduralCloudRenderer.ts:688-706`, epoch-subtracted), so half the
 *    frames advanced it with the wall clock no matter what the Viewer clock
 *    said. Now: `useDefaultRenderLoop = false`, `clock.shouldAnimate = false`,
 *    `clock.multiplier = 0`, and EVERY render is `scene.render(jd)` with an
 *    explicit pinned `JulianDate`. Slot 35 of `context._cloudCache.uniformData`
 *    is that time value; the determinism control requires it identical across
 *    the repeat.
 *
 * P3 ZERO WIND. `cloudWindSpeed = 0`. `cloud.time` is consumed in exactly three
 *    places in `Shaders/WebGPU/Environment/ProceduralClouds.wgsl` (1212-1214,
 *    1294-1296, 1353-1355) and all three are
 *    `windDirection * windSpeed * time`. At speed 0 the time uniform is
 *    provably inert on the density field, which is what lets P6 vary the clock
 *    per location for illumination without varying cloud shape. Wind DIRECTION
 *    is left alone.
 *
 * P4 ESCAPE THE TIER PATH. `cloudQuality = 32`. Any value `!== 64` takes the
 *    power-user escape hatch in `resolveCloudPreset`
 *    (`WebGPUCloudTierPresets.ts:173-197`), which forces `temporalEnabled:
 *    false`, `jitterEnabled: false`, `noiseSource: LIVE`, `renderResScale: 1.0`,
 *    `lightConeSampling: false`. The DEFAULT `cloudQuality` is 64
 *    (`Scene/CloudVolumetrics.js:164`), so the old probe took the TIER path and
 *    at 250 km resolved T1/T2 — `temporalEnabled: true`,
 *    `temporalUpdateFraction: 1/16`, `jitterEnabled: true`, half-res. That is
 *    the same hazard `probe-cloud-genus-morphology.mjs` records for its own
 *    gate-B determinism control, and it also removes the async BAKED-noise
 *    transition (`noiseBakedBit` self-heals to LIVE until the bake lands, so the
 *    image silently changes mid-run when it does).
 *    On the escape hatch the march has NO frame-index input at all: every
 *    `cloud.frameCounter` consumer is gated — `cloudRaySamplePhase` returns a
 *    constant 0.5 when QF_JITTER is clear (`ProceduralClouds.wgsl:378-392`),
 *    `coneJitter` is reachable only through the QF_LIGHT_CONE march, and the
 *    Bayer sub-texel offset is inside `halfResEnabled()`. The probe READS BACK
 *    `qualityFlags` (slot 74) and requires bits 0/1/2/3/10 clear, and `maxSteps`
 *    (slot 44) to equal 32, on every capture; otherwise STRUCTURAL.
 *
 * P5 WEATHER-APPLIED GATE, not a sleep. `weatherMapEnabled` auto-enables only
 *    once `getPackedTexture` returns bytes (`WebGPUProceduralCloudRenderer.ts:
 *    2023-2028`), and the upload is version-edge-triggered (1254-1258). The old
 *    probe waited a flat 5 s and read `provider.hasData`, which says the CPU
 *    pack exists — not that the bytes reached the GPU texture, and not that the
 *    uniform enabled the map. Until it does, the deck renders from the global
 *    `cloudCoverage` alone, i.e. dense everywhere: a second, independent route
 *    to a saturated west. Now the probe polls until
 *    `provider.hasData && cache.weatherProviderVersion === provider.version &&
 *    uniformData[64] === 1`, under a wall-clock budget, after every source
 *    change. Failure to reach it is STRUCTURAL, never a channel verdict.
 *
 * P6 PER-LOCATION LOCAL NOON. A single fixed UTC instant necessarily puts part
 *    of a 320-degree longitude sweep in darkness, which would let gate 4's
 *    `west < east` be satisfied by the terminator rather than by the A channel —
 *    the C13-07 lesson recorded in `probe-cloud-genus-morphology.mjs`. Each
 *    location is rendered at ITS OWN local mean noon, so at a fixed latitude the
 *    solar elevation is the same everywhere and the only thing that differs
 *    between locations is the weather field. Safe only because of P3: the clock
 *    reaches the cloud density field solely through `windSpeed * time`.
 *
 * P7 WARM-UP DISCARD + WALL-CLOCK SETTLE + SAME-TASK CAPTURE. Renders after a
 *    camera jump are discarded before the evidence loop, the settle is a
 *    wall-clock budget driven by `setTimeout(0)` yields (never a frame count —
 *    a cold pipeline variant has measured ~2674 ms to compile), and
 *    render -> `canvas.toDataURL` freeze happens in ONE task with no await
 *    between them; pixel decode consumes only those immutable PNG bytes.
 *    Readiness itself is binned `Pass.GLOBE` commands plus the
 *    shared `__cloudProbe.awaitProceduralReady` contract
 *    (`initialized && pipelineReady && executeCalls > 0`).
 *
 * P8 NON-CLOUD LIGHT SOURCES OFF. Ground atmosphere and fog are disabled and
 *    globe lighting is left off, alongside the pre-existing sky/sun/moon/skyBox
 *    disables, so a sun-dependent glow cannot enter a bright-pixel count that is
 *    supposed to measure cloud. `cloudCastShadows` and `cloudContributesIBL` are
 *    pinned false: the env-cube refill is revision-edge-triggered and would
 *    otherwise land at an arbitrary point in the sweep.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE PINNING CHANGES ABOUT THE NUMBERS
 * ─────────────────────────────────────────────────────────────────────────────
 * P1 (imagery gone), P4 (LIVE noise, full-res, no temporal) and P6 (uniform
 * illumination) all move the ABSOLUTE fractions. The recorded 0.4129..0.5374
 * rich means are NOT a baseline for this probe and must not be compared against.
 * Every scored gate is relative — rich vs its own neutral control, west vs east
 * within one sweep — so the comparisons survive; the absolute level does not.
 *
 * SATURATION IS A SEPARATE FINDING, NOT A LICENCE TO LOOSEN. The scored metric
 * is a hard threshold (`max(r,g,b) > 120`) over a nearly uniform nadir frame, so
 * it is a step function: a location is essentially all-cloud (1.000) or
 * all-background (0.000), and a deck sitting near the threshold amplifies any
 * residual noise into a full-scale swing. At `cloudCoverage 0.6 / cloudDensity
 * 0.9` a lit deck clears 120 comfortably, so a legitimately dense east can pin
 * at 1.000 and lose all headroom for gate 4. This probe does NOT change those
 * dials — it keeps measuring the authored scene and additionally reports a
 * CONTINUOUS `meanMax` per location so a threshold straddle is visible in the
 * log. The headroom fix, if the orchestrator wants one, is a scene change to be
 * ruled on separately: lower `cloudDensity` toward 0.5 (and/or score `meanMax`
 * instead of the threshold count) so the sweep lands mid-scale. Filed under
 * `C13-GATE-B-CHANNELS-METRIC-SATURATION` in DEFERRED_WORK.md.
 *
 * Usage:
 *   node Tools/visual-regression/probe-weather-channels.mjs
 * Env:
 *   PROBE_BASE  default http://localhost:8080
 * Out:
 *   Tools/visual-regression/output/weather-channels/*.png + manifest.json
 * Exit:
 *   0 every gate decided and passed | 1 a real product FAIL |
 *   2 watchdog or exception | 3 STRUCTURAL — a pin did not take, a source never
 *     reached the GPU, or the probe could not reproduce its own capture
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
const OUT = "Tools/visual-regression/output/weather-channels";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
const VIEW = { width: 1024, height: 768 };

const WATCHDOG_MS = 600_000;

const PIN = {
  // Far-apart longitudes spanning the field west->east at a fixed mid latitude,
  // so each samples a different A/G column of the "rich" field. UNCHANGED.
  lonSweep: [-170, -130, -90, -50, -10, 30, 70, 110, 150],
  lat: 25.0,
  cameraHeight: 250_000.0,
  brightThreshold: 120,
  // Step 3 — UNCHANGED from the pre-pinning probe's sampling grid.
  sampleStride: 3,
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
  minRichMean: 0.02,
  stddevMargin: 0.01,
  westEastMargin: 0.02,
};

/** Determinism-control tolerances (see the header). */
const CONTROL = {
  perLocation: 0.005,
  mean: 0.0025,
};

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
  return {
    mean: +mean.toFixed(4),
    stddev: +Math.sqrt(variance).toFixed(4),
    range: +(Math.max(...arr) - Math.min(...arr)).toFixed(4),
  };
}

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

  // ── P6: per-location local mean noon. Same solar elevation at every location
  // at a fixed latitude, so illumination cannot masquerade as a channel effect.
  const timeForLon = new Map();
  for (const lon of cfg.lonSweep) {
    timeForLon.set(lon, pin.localNoonAt(C, lon));
  }
  const readyTime = timeForLon.get(cfg.lonSweep[0]);

  // ── Cloud dials. Coverage/density/deck are the AUTHORED scene and are
  // deliberately unchanged; the determinism dials (P3/P4/P8) are spread in from
  // the shared module. `weatherProvider` is assigned directly rather than through
  // `configure`, whose round-trip snapshot would deep-walk the packed Uint8Array
  // the provider holds.
  const volumetricDials = {
    cloudCoverage: 0.6,
    cloudDensity: 0.9,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWeatherChannelStrength: 1.0,
    cloudWeatherMap: false,
    ...cfg.determinismDials,
  };
  const configure = (overrides) =>
    globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: { ...volumetricDials, ...overrides },
    });

  const setSource = (kind) => {
    const volumetric = scene.globe.defaultCloudCollection.volumetric;
    const source =
      kind === "rich"
        ? new C.SyntheticWeatherSource("rich")
        : new C.SyntheticWeatherSource("uniform", 0.85);
    if (!volumetric.weatherProvider) {
      volumetric.weatherProvider = new C.WeatherProvider(source);
    } else {
      volumetric.weatherProvider.setSource(source);
    }
    return volumetric.weatherProvider;
  };

  const setView = (lon) =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, cfg.lat, cfg.cameraHeight),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });

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
    const metric = pin.brightFraction(
      frame,
      cfg.brightThreshold,
      cfg.sampleStride,
    );
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

  // ── Readiness, then the legs.
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

  // Leg order is `richA -> neutral -> richOff -> richB`, so the richA/richB
  // determinism control BRACKETS every source and strength change the scored
  // gates read across. A back-to-back richA/richB pair — which is what this probe
  // ran before Batch 861 — would only prove stability across an interval no
  // assertion reads.
  const richProvider = setSource("rich");
  const richApplied = await pin.awaitWeatherApplied(
    richProvider,
    readyTime,
    cfg.sourceBudgetMs,
  );
  await pin.settle(readyTime, cfg.sourceSettleMs);
  const richState = {
    hasData: richProvider.hasData,
    version: richProvider.version,
    lastError: richProvider.lastError ? String(richProvider.lastError) : null,
  };
  const west = cfg.lonSweep[0];
  const east = cfg.lonSweep[cfg.lonSweep.length - 1];
  const richA = await sweep("richA", [west, east]);

  const neutralProvider = setSource("uniform");
  const neutralApplied = await pin.awaitWeatherApplied(
    neutralProvider,
    readyTime,
    cfg.sourceBudgetMs,
  );
  await pin.settle(readyTime, cfg.sourceSettleMs);
  const neutral = await sweep("neutral", []);

  const offProvider = setSource("rich");
  const offApplied = await pin.awaitWeatherApplied(
    offProvider,
    readyTime,
    cfg.sourceBudgetMs,
  );
  const configuredOff = configure({ cloudWeatherChannelStrength: 0.0 });
  await pin.settle(readyTime, cfg.sourceSettleMs);
  const richOff = await sweep("richOff", []);

  const configuredBackOn = configure();
  await pin.settle(readyTime, cfg.sourceSettleMs);
  const richB = await sweep("richB", []);

  return {
    pins,
    dials: pin.readDials(),
    readiness: {
      globeReady,
      proceduralReady,
      configured,
      configuredOff,
      configuredBackOn,
    },
    applied: {
      rich: richApplied,
      neutral: neutralApplied,
      richOff: offApplied,
    },
    richState,
    sweeps: { richA, richB, neutral, richOff },
  };
};

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
    {
      timeout: 60000,
    },
  );
  await armWebGPUDevices(page);

  const result = await page.evaluate(RUN_LANE, {
    ...PIN,
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

  const { richA, richB, neutral, richOff } = result.sweeps;
  const fracs = (s) => s.captures.map((c) => c.frac);
  const richFr = fracs(richA);
  const richBFr = fracs(richB);
  const neutralFr = fracs(neutral);
  const richOffFr = fracs(richOff);

  const rich = stats(richFr);
  const richRepeat = stats(richBFr);
  const neutralStats = stats(neutralFr);
  const richOffStats = stats(richOffFr);
  const westFrac = richFr[0];
  const eastFrac = richFr[richFr.length - 1];

  // ── Evidence PNGs (canvas-element bits, captured in the same task as the
  // render that produced them), at the longitudes that are actually SCORED.
  const written = [];
  for (const capture of richA.captures) {
    if (!capture.png) continue;
    const name = `weather-channels-rich-lon${capture.lon}.png`;
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
  console.log(`applied ${JSON.stringify(result.applied)}`);
  console.log(`richState ${JSON.stringify(result.richState)}`);
  console.log(`rich    fr: ${fmt(richFr)} -> ${JSON.stringify(rich)}`);
  console.log(`richRpt fr: ${fmt(richBFr)} -> ${JSON.stringify(richRepeat)}`);
  console.log(
    `neutral fr: ${fmt(neutralFr)} -> ${JSON.stringify(neutralStats)}`,
  );
  console.log(
    `richOff fr: ${fmt(richOffFr)} -> ${JSON.stringify(richOffStats)}`,
  );
  console.log(
    `rich  meanMax: ${richA.captures.map((c) => c.meanMax.toFixed(1)).join(", ")}`,
  );
  console.log(`west=${westFrac.toFixed(3)} east=${eastFrac.toFixed(3)}`);
  console.log(`errs ${newErrs.length}`);

  // ── STRUCTURAL preconditions, via the shared enforcement. A pin that did not
  // take means the probe is not measuring the configuration it documents, so it
  // certifies nothing. Slot 107 must read 1 on the three full-strength legs and
  // 0 on the gated one; gate 5 is meaningless otherwise.
  const labelled = [
    ...richA.captures.map((c) => ({
      ...c,
      label: `richA lon ${c.lon}`,
      expectedChannelStrength: 1,
    })),
    ...neutral.captures.map((c) => ({
      ...c,
      label: `neutral lon ${c.lon}`,
      expectedChannelStrength: 1,
    })),
    ...richOff.captures.map((c) => ({
      ...c,
      label: `richOff lon ${c.lon}`,
      expectedChannelStrength: 0,
    })),
    ...richB.captures.map((c) => ({
      ...c,
      label: `richB lon ${c.lon}`,
      expectedChannelStrength: 1,
    })),
  ];
  const structural = collectPinStructural({
    pins: result.pins,
    dials: result.dials,
    captures: labelled,
    applied: result.applied,
    globeReadiness: { setup: result.readiness.globeReady },
    brightThreshold: PIN.brightThreshold,
  });

  // ── DETERMINISM CONTROL. richA and richB BRACKET the neutral and gated legs,
  // so this bounds the instrument across the same interval gates 3 and 5 read
  // across — a source round trip plus both strength changes.
  const control = collectRepeatStructural({
    label: "richA vs richB",
    a: richA.captures.map((c) => ({
      key: c.lon,
      value: c.frac,
      time: c.slots.time,
    })),
    b: richB.captures.map((c) => ({
      key: c.lon,
      value: c.frac,
      time: c.slots.time,
    })),
    perSample: CONTROL.perLocation,
    mean: CONTROL.mean,
  });
  console.log(
    `\n=== DETERMINISM CONTROL (richA vs richB, bracketing neutral + richOff) ===\n` +
      `  per-location |delta|: ${fmt(control.deltas)}\n` +
      `  max per-location ${control.maxPerSample.toFixed(4)} (tolerance ${CONTROL.perLocation})\n` +
      `  rich mean ${rich.mean} vs ${richRepeat.mean}, delta ${control.meanDelta.toFixed(4)} (tolerance ${CONTROL.mean})\n` +
      `  cloud time uniform (slot 35) drift: ${control.timeDrift.length === 0 ? "none" : JSON.stringify(control.timeDrift)}`,
  );
  structural.push(...control.reasons);

  // ── Scored gates. Thresholds UNCHANGED from the pre-pinning probe.
  const checks = [
    [
      "rich field renders a deck (hasData, version>0)",
      !!result.richState &&
        result.richState.hasData === true &&
        result.richState.version > 0,
    ],
    [
      `clouds present across the sweep (rich mean ${rich.mean} > ${ASSERT.minRichMean})`,
      rich.mean > ASSERT.minRichMean,
    ],
    [
      `G/B/A drive a per-location spread ABOVE the R-only control (rich stddev ${rich.stddev} >= neutral stddev ${neutralStats.stddev} + ${ASSERT.stddevMargin})`,
      rich.stddev >= neutralStats.stddev + ASSERT.stddevMargin,
    ],
    [
      `west(thin/flat A,G) is lighter than east(dense/tower) (west ${westFrac.toFixed(3)} < east ${eastFrac.toFixed(3)} - ${ASSERT.westEastMargin})`,
      westFrac < eastFrac - ASSERT.westEastMargin,
    ],
    [
      `channelStrength=0 collapses the spread toward neutral (richOff stddev ${richOffStats.stddev} closer to neutral ${neutralStats.stddev} than rich ${rich.stddev})`,
      Math.abs(richOffStats.stddev - neutralStats.stddev) <
        Math.abs(rich.stddev - neutralStats.stddev),
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
  if (!backendOk) pass = false;
  for (const [name, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
    if (!ok) pass = false;
  }
  if (newErrs.length) {
    console.log("  errors:", newErrs.slice(0, 5));
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
      maxPerLocation: control.maxPerSample,
      meanDelta: control.meanDelta,
      ok: control.reasons.length === 0,
    },
    result,
    stats: {
      rich,
      richRepeat,
      neutral: neutralStats,
      richOff: richOffStats,
      westFrac,
      eastFrac,
    },
    errors: newErrs,
    structural,
    verdict: structural.length ? "STRUCTURAL" : pass ? "GREEN" : "RED",
  };
  // Strip the base64 PNGs out of the manifest — they are already on disk.
  for (const s of Object.values(manifest.result.sweeps)) {
    for (const c of s.captures) delete c.png;
  }
  fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));

  if (structural.length) {
    console.log("\n=== STRUCTURAL ===");
    for (const reason of structural) console.log(`  - ${reason}`);
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
