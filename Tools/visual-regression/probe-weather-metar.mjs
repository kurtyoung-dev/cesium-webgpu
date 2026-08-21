#!/usr/bin/env node
/**
 * Weather Phase 3 — mock-METAR offline pipeline probe (Batch 425). WebGPU-only.
 * @purpose Gate-B leg: full-RGBA METAR chain (obs parse, IDW rasterize, packer) against the /mock-metar fixture; spatial + calibrated channel gates.
 * @status ACTIVE
 *
 * PINNED for determinism under `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`.
 *
 * Proves the FULL-RGBA METAR ingest chain — station obs -> parse cloud groups ->
 * IDW rasterize -> packer (R coverage + G genus + B base + A density) ->
 * weatherTex -> clouds — works end-to-end WITHOUT live network, by pointing a
 * MetarWeatherSource at the dev server's `/mock-metar` route, which serves a
 * committed station fixture (Tools/visual-regression/fixtures/metar-stations.json)
 * with a CLEAR station (west, SKC), a BKN station, an OVC station, and a CB
 * station — so the IDW field varies BOTH spatially (R) AND in the G/B/A channels.
 *
 * WHAT IS SCORED — every threshold below is UNCHANGED from the pre-pinning
 * probe. None was widened, lowered, or dropped.
 *   1 CAPS      `MetarWeatherSource` cap id `metar:mock`, `supportsTime` false
 *   2 FETCHED   the provider fetched + parsed + rasterized (`hasData`,
 *               `version > 0`, no `lastError` — i.e. NO fallback-to-procedural)
 *   3 SPATIAL   the IDW coverage field varies spatially:
 *               `cloudy(OVC) - clear(SKC) >= 0.05`
 *   4 CHANNELS  the G/B/A channels reach the shader: turning them ON shifts the
 *               deck per location, `sum|ch1 - ch0| >= 0.04` across the band —
 *               now scored over a band CALIBRATED to partial coverage, see the
 *               gate-4 section below. The 0.04 bar is UNCHANGED.
 *   5 CLEAN     0 new device / console errors
 *   plus BACKEND `scene.context.rendererType === "webgpu"`. A silent WebGL
 *               fallback HARD-FAILS: volumetric clouds are WebGPU-only, so
 *               scoring a WebGL frame as a WebGPU pass is a false green.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PROBE WAS PINNED — it had TWO independent false-GREEN paths
 * ─────────────────────────────────────────────────────────────────────────────
 * It was one of the six Gate-B legs recorded GREEN while `probe-weather-
 * channels.mjs` flipped GREEN/RED/RED/RED/RED on one build. The audit
 * (`C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`) classified it SUSCEPTIBLE, and it is
 * the worst case in the fleet because BOTH of its pixel gates could be satisfied
 * by something other than the METAR field:
 *
 *   GATE 3. The metric was a raw `max(r,g,b) > 120` count over the central 60%
 *   of a nadir frame, and the probe loaded `?renderer=webgpu` with NO `offline`
 *   flag — so `CesiumViewerStartupOptions.js:27-42` supplied Cesium World
 *   Terrain and the Ion world-imagery base layer. The two scored samples are
 *   geographically asymmetric: `clear` is lon -120 / lat 35 (Pacific + US west
 *   coast) and `cloudy` is lon 0 / lat 35 (western Mediterranean and the North
 *   African coast). Bright arid land imagery at lon 0 clears 120 and is counted
 *   as cloud, pushing `cloudy - clear` UP — the exact direction gate 3 scores.
 *
 *   GATE 4. `sum|ch1 - ch0|` compares two sweeps of the SAME seven longitudes
 *   taken at different wall-clock times. ANY frame difference between the two
 *   sweeps adds to the scored sum, whether or not the channels caused it. Three
 *   sources were live: imagery/terrain tiles continuing to arrive between the
 *   sweeps; the cloud field advecting, because `cloudWindSpeed` sat at its 15.0
 *   default (`CloudVolumetrics.js:83`) while every render was `s.render()` with
 *   no argument — which `Scene.js` fills with `JulianDate.now()`; and the tier
 *   path's temporal accumulation + jitter + half-res, because `cloudQuality` sat
 *   at its 64 default. A drifting instrument makes gate 4 easier to pass, so
 *   none of these is mere noise — each is a route to a green that the channels
 *   did not earn.
 *
 * Also: the provider wait was a flat 7 s `waitForTimeout` on `hasData`, which
 * says the CPU pack exists — not that the bytes reached the GPU texture and the
 * uniform enabled the map. Until it does the deck renders from global coverage,
 * dense everywhere.
 *
 * The pins are P1-P8 as documented in `lib/weather-probe-pinning.mjs`; that
 * module is the shared enforceable home, and `probe-weather-channels.mjs` is the
 * reference implementation. Every pin is READ BACK — from the scene for the
 * scene pins, from packed cloud-uniform slots 35/44/64/74/107 for the
 * shader-visible ones — and a pin that did not take reports STRUCTURAL. Slot 107
 * is checked per capture: 1 on the two full-strength sweeps, 0 on the gated one,
 * because gate 4 is meaningless if the strength dial never reached the shader.
 *
 * DETERMINISM CONTROL. The full-strength sweep is captured TWICE under one
 * configuration, and the order is deliberately `ch1A -> ch0 -> ch1B` so the
 * control BRACKETS the gated sweep in time and spans BOTH strength changes. A
 * control taken back to back before the gated leg would only prove the
 * instrument was stable across a gap that gate 4 never reads across.
 * The two must agree per longitude within `CONTROL.perSample`, on the sweep mean
 * within `CONTROL.mean`, and — the binding one — their summed |delta| must stay
 * under `CONTROL.absSum`, which is the SAME quantity gate 4 scores against 0.04.
 * A control that cannot hold its own summed delta well under 0.04 cannot
 * distinguish a channel response from capture noise. The cloud `time` uniform
 * must also read identically at each longitude in both. If the control fails the
 * probe reports STRUCTURAL (exit 3) and certifies NOTHING.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GATE 4 IS CALIBRATED TO PARTIAL COVERAGE (Batch 861) — the discriminator
 * ─────────────────────────────────────────────────────────────────────────────
 * The pinned probe went RED 3/3 on gate 4 with `sum|ch1-ch0| = 0.0019` while its
 * own determinism control read 0.0000 on the SAME quantity. Two readings were
 * left open (`C13-GATE-B-METAR-CHANNELS-NO-EFFECT`): (A) the previous GREEN was
 * manufactured by wall-clock drift and the channel path is an engine defect, or
 * (B) the seven sampled locations had NO HEADROOM — `ch1` read
 * `0.997,1.000,1.000,1.000,1.000,1.000,0.999` and `ch0`
 * `0.997,1.000,1.000,1.000,1.000,1.000,0.997`, five of seven pinned at exactly
 * 1.000 in BOTH legs.
 *
 * Reading B is confirmed ARITHMETICALLY from the fixture, and it is the reason
 * for this change. Along lat 35 the fixture places SKC at lon -120 (cover 0.00),
 * BKN040 at -60 (0.75), OVC008 at 0 (1.00), BKN012/SCT025CB at 60 (0.75) and
 * FEW035 at 120 (0.25); `MetarWeatherSource._rasterize` is IDW power 2 over a
 * PLANAR degree metric with a hard `influenceRadiusDeg` cutoff (45 here), and
 * the lat -25 row is 60 degrees away so it never contributes at lat 35. That
 * makes the field along lat 35 exactly `R = sum(w_i c_i)/sum(w_i)` over the
 * lat-35 stations within 45 degrees, `w = 1/(d^2 + 1e-3)`. The OLD band
 * `[-60,-40,-20,0,20,40,60]` therefore carries
 * `R = 0.750, 0.800, 0.950, 1.000, 0.950, 0.800, 0.750` — every point at or
 * ABOVE the BKN station's own coverage, because the band lies entirely between
 * the BKN, OVC and BKN stations and IDW cannot undershoot its inputs.
 *
 * Two further multipliers close it. `weatherStrength` (slot 65) is packed as
 * `cloudCoverage * 2` (`WebGPUProceduralCloudRenderer.ts:2032`), i.e. 1.2 at
 * this probe's authored `cloudCoverage 0.6`, so `effectiveCoverage = R * 1.2`
 * clamps to 1.0 for any `R >= 0.834`. Then `cloudEffectiveCoverage`
 * (`Shaders/WebGPU/Environment/CloudDensityDomain.wgsl:186-195`) LIFTS coverage
 * further below its 0.55 anchor. The old band's minimum effective coverage was
 * 0.90 of full scale and its median was 1.000 — a saturated deck at every
 * sampled point, which is precisely the measured 0.997..1.000.
 *
 * Reading A is separately REFUTED at source: the G/B/A path is complete and
 * live. `decodeWeatherChannels` (`ProceduralClouds.wgsl:1173-1198`) is called
 * from all three density evaluators — `legacyCloudDensity` (:1219-1226),
 * `legacyCloudBaseDensity` (:1301-1308) and `cloudMacroSampleAt` (:1371-1375) —
 * and its outputs are consumed as a density multiplier (`wch.densityScale`,
 * :1277/:1332/:1398), a height-gradient base shift (`wch.baseShiftFrac`,
 * :1240-1247) and a profile-shape bias (`wch.perGenusShape`, :1246). The payload
 * is non-neutral too: `densityFor` (`MetarWeatherSource.ts:148-157`) gives the
 * old band's stations A = 0.675 (BKN) and 0.850 (OVC) against a 0.5 neutral, so
 * `densityScale` ran 1.35..1.70 there. A 35-70% density INCREASE on an already
 * opaque deck is invisible to a nadir bright-pixel fraction. The channels were
 * doing something large; the instrument was at its ceiling.
 *
 * SO GATE 4 IS RE-AIMED, AND THE AIM IS PROVEN IN-PROBE. The partial-coverage
 * regions of this fixture are the two inter-station windows where the 45-degree
 * influence discs OVERLAP and the lower-coverage station pulls the field down:
 * lon [-104,-76] (SKC 0.00 <-> BKN 0.75, R rises 0.088 -> 0.662) and lon
 * [76,104] (BKN 0.75 <-> FEW 0.25, R falls 0.692 -> 0.308). Those two windows
 * are the CALIBRATION LADDER. But `R -> rendered bright fraction` runs through
 * the 1.2 strength multiplier, the coverage lift, the raymarch and an 8-bit
 * threshold, so it is not predictable offline — the ladder is therefore
 * MEASURED, in the strength-0 baseline configuration, and gate 4's seven
 * locations are selected from the measured result by
 * `selectPartialCoverageBand`. Three properties keep that honest:
 *   - the selector sees ONLY strength-0 values, so it cannot prefer locations
 *     where the channel delta is large;
 *   - it selects EVENLY SPACED in longitude across the in-band candidates, not
 *     ranked by closeness to mid-scale — mid-scale ranking would concentrate the
 *     sweep at the station midpoint, which is exactly where the IDW-interpolated
 *     A channel is most nearly neutral (at lon 90 the two stations' densities
 *     0.675 and 0.325 average to 0.500 and `densityScale` is 1.0);
 *   - the aim is RE-CHECKED against the scored `ch0` leg by
 *     `collectHeadroomStructural`. Every scored location must read `ch0` inside
 *     0.1..0.9. If the aim missed, or went stale between ladder and sweep, the
 *     probe reports STRUCTURAL (exit 3) and certifies NOTHING. That makes the
 *     blindness class structurally impossible to reintroduce.
 * Three saturated witnesses (lon -60, 0, 60) are measured in the same ladder and
 * marked ineligible, so every run re-evidences the saturation on the record
 * without any chance of scoring it.
 *
 * THE 0.04 BAR IS NOT LOWERED. It was authored against an expected channel
 * effect. With headroom now PROVEN at every scored point, a gate-4 failure is a
 * finding about the engine, not about the instrument — which is exactly the
 * discrimination this change exists to produce.
 *
 * WHAT THE PINNING CHANGES ABOUT THE NUMBERS. Removing imagery, stopping the
 * wind, escaping the tier path and fixing the clock all move the ABSOLUTE
 * fractions. Any `ch1 fr:` / `ch0 fr:` values recorded for this probe before
 * this pass are NOT a baseline and must not be compared against. Gates 3 and 4
 * are relative (one sample against another inside one configuration, and one
 * sweep against its own strength-0 twin), so the comparisons survive; the
 * absolute level does not.
 *
 * Usage:
 *   node Tools/visual-regression/probe-weather-metar.mjs
 * Env:
 *   PROBE_BASE  default http://localhost:8080
 * Out:
 *   Tools/visual-regression/output/weather-metar/*.png + manifest.json
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
  collectHeadroomStructural,
  collectPinStructural,
  collectRepeatStructural,
  COVERAGE_HEADROOM_BAND,
  inHeadroomBand,
  installWeatherPinHarnessOnPage,
  selectPartialCoverageBand,
  WEATHER_DETERMINISM_DIALS,
} from "./lib/weather-probe-pinning.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/weather-metar";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
const MOCK_URL = `${BASE}/mock-metar`;
const VIEW = { width: 1024, height: 768 };

const WATCHDOG_MS = 600_000;

// Fixture stations sit at lat 35: clear @ -120, BKN @ -60, OVC @ 0, CB @ 60,
// FEW @ 120. Gate 3's two point samples are UNCHANGED from the pre-pinning probe
// — that gate WANTS the saturated contrast and passes on it.
const CLEAR_LON = -120.0; // SKC station region (IDW coverage ~0)
const CLOUDY_LON = 0.0; // OVC station region (full coverage, densest, lowest base)

/** Gate 4's location count — UNCHANGED at 7, so the 0.04 bar keeps its meaning. */
const BAND_COUNT = 7;

/**
 * Gate 4's calibration ladder: the two inter-station windows where the fixture's
 * 45-degree IDW influence discs OVERLAP at lat 35 and the lower-coverage station
 * pulls the field into partial coverage. Derived in the header from the fixture
 * layout and `MetarWeatherSource._rasterize`; the endpoints are held two degrees
 * inside each 45-degree cutoff so no candidate sits on the discontinuity where a
 * station leaves the radius.
 *   [-104,-76]  SKC 0.00 <-> BKN 0.75, R rises 0.088 -> 0.662
 *   [76,104]    BKN 0.75 <-> FEW 0.25, R falls 0.692 -> 0.308
 */
const ladder = (from, to, step) => {
  const out = [];
  for (let v = from; v <= to; v += step) {
    out.push(v);
  }
  return out;
};
const CALIBRATION_LONS = [...ladder(-104, -76, 2), ...ladder(76, 104, 2)];

/**
 * Measured in the same ladder and marked INELIGIBLE for scoring. These are three
 * of the OLD band's longitudes, whose `R` is 0.750 / 1.000 / 0.750 and whose
 * effective coverage is 0.90 / 1.00 / 0.90 after the `cloudCoverage * 2` strength
 * fold — the saturation that made the old gate 4 blind. Measuring them every run
 * keeps that finding on the record; `eligible: false` makes scoring them
 * impossible rather than merely unlikely.
 */
const SATURATION_WITNESS_LONS = [-60, 0, 60];

const PIN = {
  clearLon: CLEAR_LON,
  cloudyLon: CLOUDY_LON,
  calibrationLons: CALIBRATION_LONS,
  witnessLons: SATURATION_WITNESS_LONS,
  bandCount: BAND_COUNT,
  headroomBand: COVERAGE_HEADROOM_BAND,
  lat: 35.0,
  cameraHeight: 250_000.0,
  brightThreshold: 120,
  // Step 2 (not 3) — UNCHANGED from the pre-pinning probe's sampling grid.
  sampleStride: 2,
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
  spatialMargin: 0.05,
  absDeltaSumMin: 0.04,
};

/**
 * Determinism-control tolerances. `absSum` is the binding one: it bounds the
 * SAME quantity gate 4 scores, strictly inside its 0.04 bar.
 */
const CONTROL = {
  perSample: 0.004,
  mean: 0.002,
  absSum: 0.015,
};

/**
 * Everything below runs INSIDE the page. `page.evaluate` serializes the function
 * source and drops the surrounding closure, so the shared helpers arrive through
 * `globalThis.__weatherPin` / `globalThis.__cloudProbe` (installed via
 * `addInitScript`) rather than through imports.
 *
 * The lane is SPLIT in two because gate 4's aim is chosen by
 * `selectPartialCoverageBand`, which lives in the shared Node module and must not
 * be re-implemented in page scope (one enforceable home). Lane 1 measures the
 * calibration ladder and stashes its live closures on `globalThis.__metarLane`;
 * Node selects; lane 2 reuses those exact closures for the scored sweeps. Nothing
 * renders between the two lanes, and with the render loop off, the wind at 0 and
 * the clock explicit, the pause cannot advance any scene state.
 */
const RUN_SETUP = async (cfg) => {
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
  // deliberately unchanged — in particular the moderate 0.5 density that gives
  // the A density-bias headroom to thicken thin cells. The determinism dials
  // (P3/P4/P8) are spread in from the shared module.
  const volumetricDials = {
    cloudCoverage: 0.6,
    cloudDensity: 0.5,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    ...cfg.determinismDials,
  };
  const configure = (channelStrength) =>
    globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: {
        ...volumetricDials,
        cloudWeatherChannelStrength: channelStrength,
      },
    });

  // ── P6: per-location local mean noon at a fixed latitude, so solar elevation
  // is equal at every sample and illumination cannot masquerade as an IDW
  // coverage difference between the clear and cloudy stations.
  const allLons = [
    ...new Set([
      cfg.clearLon,
      cfg.cloudyLon,
      ...cfg.calibrationLons,
      ...cfg.witnessLons,
    ]),
  ];
  const timeForLon = new Map();
  for (const lon of allLons) {
    timeForLon.set(lon, pin.localNoonAt(C, lon));
  }
  const readyTime = timeForLon.get(cfg.clearLon);

  const setView = (lon) =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, cfg.lat, cfg.cameraHeight),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });

  setView(cfg.clearLon);
  const globeReady = await pin.awaitGlobeReady(
    C,
    readyTime,
    cfg.readyMinSettleMs,
    cfg.readyBudgetMs,
  );
  // configure() is what actually ENABLES the volumetric renderer; awaiting
  // readiness without it times out at executeCalls=0.
  const configuredOn = configure(1.0);
  const proceduralReady = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime: readyTime,
    maxFrames: cfg.readyMaxFrames,
  });

  const source = new C.MetarWeatherSource({
    url: cfg.mockUrl,
    gridWidth: 64,
    gridHeight: 32,
    influenceRadiusDeg: 45,
    sourceLabel: "mock",
  });
  const caps = source.getCapabilities();
  const volumetric = scene.globe.defaultCloudCollection.volumetric;
  // Assigned directly rather than through `configure`, whose round-trip snapshot
  // would deep-walk the packed Uint8Array the provider holds.
  volumetric.weatherProvider = new C.WeatherProvider(source);
  const provider = volumetric.weatherProvider;

  // ── P5: the rasterized field must reach the GPU and the uniform must enable
  // the map. A flat sleep on `hasData` proves neither.
  const applied = await pin.awaitWeatherApplied(
    provider,
    readyTime,
    cfg.sourceBudgetMs,
  );
  await pin.settle(readyTime, cfg.sourceSettleMs);

  const captureAt = async (lon, wantPng) => {
    const julianDate = timeForLon.get(lon);
    setView(lon);
    // DISCARDED warm-up renders after the camera jump.
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

  const sweep = async (label, lons, pngLons) => {
    const captures = [];
    for (const lon of lons) {
      captures.push(await captureAt(lon, pngLons.includes(lon)));
    }
    return { label, captures };
  };

  // ── GATE-4 CALIBRATION LADDER, measured in the BASELINE (strength-0)
  // configuration — the same configuration gate 4 differences against. The
  // ladder exists because `R -> bright fraction` runs through the
  // `cloudCoverage * 2` strength fold, the `cloudEffectiveCoverage` lift, the
  // raymarch and an 8-bit threshold, and is therefore not predictable offline.
  // The saturated witnesses ride along; Node marks them ineligible.
  const configuredCalibration = configure(0.0);
  await pin.settle(readyTime, cfg.sourceSettleMs);
  const calibration = await sweep(
    "calibration",
    [...cfg.calibrationLons, ...cfg.witnessLons],
    [],
  );

  // Lane 2 reuses these EXACT closures rather than re-deriving them, so the
  // scored sweeps cannot drift from the ladder that aimed them.
  globalThis.__metarLane = { sweep, configure, readyTime, cfg, pin };

  return {
    caps: { capId: caps.id, supportsTime: caps.supportsTime },
    providerState: {
      hasData: provider.hasData,
      version: provider.version,
      lastError: provider.lastError ? String(provider.lastError) : null,
    },
    pins,
    dials: pin.readDials(),
    readiness: {
      globeReady,
      proceduralReady,
      configuredOn,
      configuredCalibration,
    },
    applied: { fixture: applied },
    calibration,
  };
};

/**
 * Lane 2 — the scored sweeps, over the band Node selected from lane 1's ladder.
 * Order is deliberate: ch1A -> ch0 -> ch1B, so the ch1A/ch1B determinism control
 * BRACKETS the gated sweep in time and spans BOTH strength changes. A control
 * taken back to back before the gated leg would only prove the instrument was
 * stable across a gap that gate 4 never reads across.
 */
const RUN_SWEEPS = async (aim) => {
  const lane = globalThis.__metarLane;
  if (!lane) {
    throw new Error("lane 1 did not stash globalThis.__metarLane");
  }
  const { sweep, configure, readyTime, cfg, pin } = lane;

  const configuredOn = configure(1.0);
  await pin.settle(readyTime, cfg.sourceSettleMs);
  const ch1A = await sweep("ch1A", aim.strengthOneLons, [
    cfg.clearLon,
    cfg.cloudyLon,
    aim.bandLons[0],
  ]);

  const configuredOff = configure(0.0);
  await pin.settle(readyTime, cfg.sourceSettleMs);
  const ch0 = await sweep("ch0", aim.bandLons, [aim.bandLons[0]]);

  const configuredBackOn = configure(1.0);
  await pin.settle(readyTime, cfg.sourceSettleMs);
  const ch1B = await sweep("ch1B", aim.strengthOneLons, []);

  return {
    readiness: { configuredOn, configuredOff, configuredBackOn },
    dials: pin.readDials(),
    sweeps: { ch1A, ch1B, ch0 },
  };
};

function stats(list) {
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const variance =
    list.reduce((a, b) => a + (b - mean) * (b - mean), 0) / list.length;
  return {
    mean: +mean.toFixed(4),
    stddev: +Math.sqrt(variance).toFixed(4),
    range: +(Math.max(...list) - Math.min(...list)).toFixed(4),
  };
}

function fmt(list) {
  return list.map((v) => v.toFixed(3)).join(", ");
}

function byLon(sweep, lon) {
  return sweep.captures.find((c) => c.lon === lon);
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

  const setup = await page.evaluate(RUN_SETUP, {
    ...PIN,
    mockUrl: MOCK_URL,
    determinismDials: WEATHER_DETERMINISM_DIALS,
  });

  // ── GATE-4 AIM. The selector runs HERE, in the shared Node module, and sees
  // ONLY the strength-0 ladder — it has no access to any strength-1 measurement,
  // so it cannot prefer locations where the channel delta happens to be large.
  const ladderSamples = setup.calibration.captures.map((c) => ({
    key: c.lon,
    value: c.frac,
    meanMax: c.meanMax,
    eligible: !SATURATION_WITNESS_LONS.includes(c.lon),
  }));
  const aim = selectPartialCoverageBand({
    samples: ladderSamples,
    count: BAND_COUNT,
    band: COVERAGE_HEADROOM_BAND,
  });
  console.log(
    `\n=== GATE-4 CALIBRATION LADDER (strength 0, band ` +
      `${COVERAGE_HEADROOM_BAND.min}..${COVERAGE_HEADROOM_BAND.max}) ===\n` +
      ladderSamples
        .map(
          (s) =>
            `  lon ${String(s.key).padStart(5)} frac ${s.value.toFixed(3)} ` +
            `meanMax ${String(s.meanMax).padStart(6)}` +
            `${s.eligible ? (inHeadroomBand(s.value) ? "  IN-BAND" : "") : "  witness(saturated, never scored)"}`,
        )
        .join("\n"),
  );

  const bandLons = aim.selected.map((s) => s.key);
  console.log(
    `  in-band candidates ${aim.inBand.length}/${ladderSamples.filter((s) => s.eligible).length}` +
      `, selected band [${bandLons.join(", ")}]`,
  );

  // A missed aim is STRUCTURAL and the run stops here: scoring gate 4 over a
  // saturated band is exactly the blindness this change exists to remove, so the
  // probe must not fall back to one.
  if (aim.reasons.length) {
    await browser.close();
    console.log("\n=== STRUCTURAL ===");
    for (const reason of aim.reasons) {
      console.log(`  - ${reason}`);
    }
    console.log(
      "\nRESULT: STRUCTURAL — acceptance INCOMPLETE. Gate 4 could not be aimed at partial coverage, so it was not scored.",
    );
    fs.writeFileSync(
      `${OUT}/manifest.json`,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          url: URL,
          pin: PIN,
          setup,
          aim: { ladder: ladderSamples, reasons: aim.reasons },
          verdict: "STRUCTURAL",
        },
        null,
        2,
      ),
    );
    process.exitCode = 3;
    return;
  }

  const strengthOneLons = [...new Set([CLEAR_LON, CLOUDY_LON, ...bandLons])];
  const scored = await page.evaluate(RUN_SWEEPS, { strengthOneLons, bandLons });
  const result = {
    ...setup,
    readiness: { ...setup.readiness, ...scored.readiness },
    dials: scored.dials,
    aim: { ladder: ladderSamples, bandLons, inBand: aim.inBand.length },
    sweeps: scored.sweeps,
  };

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .concat(gate.deviceLost ? [gate.deviceLost] : [])
    .filter(
      (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
    );
  await browser.close();

  const { ch1A, ch1B, ch0 } = result.sweeps;
  const clear = byLon(ch1A, CLEAR_LON);
  const cloudy = byLon(ch1A, CLOUDY_LON);
  // Gate 4 reads the CALIBRATED BAND only. Location count and the 0.04 bar are
  // unchanged; only the aim moved.
  const ch1Fr = bandLons.map((lon) => byLon(ch1A, lon).frac);
  const ch0Fr = bandLons.map((lon) => byLon(ch0, lon).frac);
  const ch1 = stats(ch1Fr);
  const ch0Stats = stats(ch0Fr);
  // PER-LOCATION isolation: at each longitude R is identical between the two
  // sweeps (same field cell), so the ch1-vs-ch0 difference is PURELY the G/B/A
  // contribution.
  const perLocDeltas = ch1Fr.map((f, i) => f - ch0Fr[i]);
  const meanShift = +(ch1.mean - ch0Stats.mean).toFixed(4);
  const absDeltaSum = +perLocDeltas
    .reduce((a, d) => a + Math.abs(d), 0)
    .toFixed(4);

  // ── Evidence PNGs (canvas-element bits, captured in the same task as the
  // render that produced them).
  const written = [];
  const writePng = (capture, name) => {
    if (!capture?.png) {
      return;
    }
    fs.writeFileSync(
      `${OUT}/${name}`,
      Buffer.from(capture.png.slice(capture.png.indexOf(",") + 1), "base64"),
    );
    written.push(name);
  };
  writePng(clear, "weather-metar-clear.png");
  writePng(cloudy, "weather-metar-ovc.png");
  // Gate 4's evidence pair is now taken at the FIRST SCORED PARTIAL location, not
  // at the saturated OVC station: a channels-on/off pair at a saturated point is
  // two identical white frames and evidences nothing.
  writePng(byLon(ch1A, bandLons[0]), "weather-metar-channels-on.png");
  writePng(byLon(ch0, bandLons[0]), "weather-metar-channels-off.png");

  console.log(
    `renderer=${result.pins.rendererType} pins=${JSON.stringify(result.pins)}`,
  );
  console.log(`dials ${JSON.stringify(result.dials)}`);
  console.log(
    `readiness globe{binned=${result.readiness.globeReady.binnedGlobeCommands} firstMs=${result.readiness.globeReady.firstBinnedMs} elapsedMs=${result.readiness.globeReady.elapsedMs}} procedural{frames=${result.readiness.proceduralReady.waitedFrames} executeCalls=${result.readiness.proceduralReady.executeCalls}}`,
  );
  console.log(`cap ${JSON.stringify(result.caps)}`);
  console.log(`state ${JSON.stringify(result.providerState)}`);
  console.log(`applied ${JSON.stringify(result.applied)}`);
  console.log(
    `clear(frac=${clear.frac.toFixed(3)},meanMax=${clear.meanMax.toFixed(1)}) ` +
      `cloudy(frac=${cloudy.frac.toFixed(3)},meanMax=${cloudy.meanMax.toFixed(1)})`,
  );
  console.log(`band lons: ${bandLons.join(", ")}`);
  console.log(`ch1 fr: ${fmt(ch1Fr)} -> ${JSON.stringify(ch1)}`);
  console.log(`ch0 fr: ${fmt(ch0Fr)} -> ${JSON.stringify(ch0Stats)}`);
  console.log(`perLocD: ${fmt(perLocDeltas)}`);
  console.log(`meanShift=${meanShift} absDeltaSum=${absDeltaSum}`);
  console.log(`errs ${newErrs.length}`);

  // ── STRUCTURAL preconditions. Slot 107 is expected to read 1 on the two
  // full-strength sweeps and 0 on the gated one; gate 4 is meaningless
  // otherwise.
  const labelled = [
    // The calibration ladder AIMS gate 4, so the pins must have held while it was
    // measured; an unpinned ladder is an invalid aim even if the sweeps are clean.
    ...result.calibration.captures.map((c) => ({
      ...c,
      label: `calibration lon ${c.lon}`,
      expectedChannelStrength: 0,
    })),
    ...ch1A.captures.map((c) => ({
      ...c,
      label: `ch1A lon ${c.lon}`,
      expectedChannelStrength: 1,
    })),
    ...ch1B.captures.map((c) => ({
      ...c,
      label: `ch1B lon ${c.lon}`,
      expectedChannelStrength: 1,
    })),
    ...ch0.captures.map((c) => ({
      ...c,
      label: `ch0 lon ${c.lon}`,
      expectedChannelStrength: 0,
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

  // ── P9 HEADROOM. Read from the SCORED `ch0` leg, never from the calibration
  // ladder that aimed it: a ladder that went stale between aim and sweep must
  // report STRUCTURAL rather than certify a band that has since saturated. This
  // is the precondition that makes the Batch-860 blindness (five of seven
  // locations pinned at exactly 1.000 in both legs) impossible to reintroduce.
  const headroom = collectHeadroomStructural({
    label: "gate 4 ch0 baseline",
    samples: ch0.captures.map((c) => ({ key: c.lon, value: c.frac })),
    band: COVERAGE_HEADROOM_BAND,
  });
  console.log(
    `\n=== GATE-4 HEADROOM (scored ch0 leg, band ${COVERAGE_HEADROOM_BAND.min}..${COVERAGE_HEADROOM_BAND.max}) ===\n` +
      `  ch0 per-location: ${ch0.captures
        .map((c) => `${c.lon}=${c.frac.toFixed(3)}`)
        .join(", ")}\n` +
      `  ${headroom.length === 0 ? "every scored location can move in both directions" : "OUT OF BAND — gate 4 is blind here"}`,
  );
  structural.push(...headroom);

  // ── DETERMINISM CONTROL.
  const control = collectRepeatStructural({
    label: "ch1A vs ch1B",
    a: ch1A.captures.map((c) => ({
      key: c.lon,
      value: c.frac,
      time: c.slots.time,
    })),
    b: ch1B.captures.map((c) => ({
      key: c.lon,
      value: c.frac,
      time: c.slots.time,
    })),
    perSample: CONTROL.perSample,
    mean: CONTROL.mean,
    absSum: CONTROL.absSum,
  });
  console.log(
    `\n=== DETERMINISM CONTROL (ch1A vs ch1B, one configuration) ===\n` +
      `  per-location |delta|: ${fmt(control.deltas)}\n` +
      `  max per-location ${control.maxPerSample.toFixed(4)} (tolerance ${CONTROL.perSample})\n` +
      `  mean delta ${control.meanDelta.toFixed(4)} (tolerance ${CONTROL.mean})\n` +
      `  summed |delta| ${control.deltaSum.toFixed(4)} (tolerance ${CONTROL.absSum}; gate 4 scores this same quantity against ${ASSERT.absDeltaSumMin})\n` +
      `  cloud time uniform (slot 35) drift: ${control.timeDrift.length === 0 ? "none" : JSON.stringify(control.timeDrift)}`,
  );
  structural.push(...control.reasons);

  // ── Scored gates. Thresholds UNCHANGED from the pre-pinning probe.
  const state = result.providerState;
  const checks = [
    [
      "MetarWeatherSource cap id = metar:mock, supportsTime false",
      result.caps.capId === "metar:mock" && result.caps.supportsTime === false,
    ],
    [
      "provider FETCHED + PARSED + RASTERIZED (hasData, version>0, no fallback)",
      !!state && state.hasData && state.version > 0 && !state.lastError,
    ],
    [
      `IDW coverage varies spatially (cloudy OVC ${cloudy.frac.toFixed(3)} > ` +
        `clear SKC ${clear.frac.toFixed(3)} by >= ${ASSERT.spatialMargin})`,
      cloudy.frac - clear.frac >= ASSERT.spatialMargin,
    ],
    [
      `G/B/A channels reach the shader: turning them ON shifts the deck per ` +
        `location across the PARTIAL-COVERAGE band [${bandLons.join(",")}] ` +
        `(sum|delta| ${absDeltaSum} >= ${ASSERT.absDeltaSumMin}, mean shift ${meanShift})`,
      absDeltaSum >= ASSERT.absDeltaSumMin,
    ],
    [`no NEW device errors (${newErrs.length})`, newErrs.length === 0],
  ];

  console.log("\n=== ANALYSIS ===");
  let pass = true;
  // A silent WebGL fallback HARD-FAILS rather than reporting STRUCTURAL.
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
      deltaSum: control.deltaSum,
      ok: control.reasons.length === 0,
    },
    headroom: {
      band: COVERAGE_HEADROOM_BAND,
      ch0: ch0.captures.map((c) => ({ lon: c.lon, frac: c.frac })),
      ok: headroom.length === 0,
    },
    result,
    stats: {
      ch1,
      ch0: ch0Stats,
      clearFrac: clear.frac,
      cloudyFrac: cloudy.frac,
      perLocDeltas,
      meanShift,
      absDeltaSum,
    },
    errors: newErrs,
    structural,
    verdict: structural.length ? "STRUCTURAL" : pass ? "GREEN" : "RED",
  };
  // Strip the base64 PNGs out of the manifest — they are already on disk.
  for (const s of [
    ...Object.values(manifest.result.sweeps),
    manifest.result.calibration,
  ]) {
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
