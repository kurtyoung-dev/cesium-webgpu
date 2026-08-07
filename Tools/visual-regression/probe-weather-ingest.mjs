#!/usr/bin/env node
/**
 * Weather ingest MVP (Phase 0/1) — end-to-end pipeline probe. WebGPU-only.
 * PINNED for determinism under `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`.
 *
 * Proves the data-driven path: a WeatherProvider + a WeatherSource emits a real
 * WeatherField -> WeatherTexPacker bakes it into the C2-16 weather-map texture ->
 * the cloud raymarcher's effectiveCoverage reads R -> the deck reflects the data,
 * and the weather map AUTO-ENABLES once data arrives. Uses SyntheticWeatherSource
 * (deterministic, no network) so the pipeline is verifiable without the live
 * (CORS-uncertain, dev-lab) EDR endpoint. The EdrWeatherSource is checked for a
 * well-formed cube URL (its live call is opt-in).
 *
 * WHAT IS SCORED — every threshold below is UNCHANGED from the pre-pinning
 * probe. None was widened, lowered, or dropped.
 *   1 API       WeatherProvider / EdrWeatherSource / SyntheticWeatherSource /
 *               packWeatherField are exported
 *   2 EDR URL   `EdrWeatherSource.buildUrl()` is a valid OGC API-EDR cube URL
 *   3 FETCHED   the uniform-0.95 provider has data (`hasData`, `version > 0`)
 *   4 DECK      uniform-0.95 renders a deck: `deckHi > 5` (percent of the
 *               sampled sky region classified whitish/grey)
 *   5 CLEARS    uniform-0.0 CLEARS the deck: `deckLo < deckHi - 5`
 *   6 CLEAN     0 new device / console errors
 *   plus BACKEND `scene.context.rendererType === "webgpu"`. A silent WebGL
 *               fallback HARD-FAILS: volumetric clouds are WebGPU-only, so
 *               scoring a WebGL frame as a WebGPU pass is a false green.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PROBE WAS PINNED
 * ─────────────────────────────────────────────────────────────────────────────
 * It was one of the six Gate-B legs recorded GREEN while `probe-weather-
 * channels.mjs` flipped GREEN/RED/RED/RED/RED on one build. The audit
 * (`C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`) classified it SUSCEPTIBLE. Unlike
 * the nadir probes its dominant contaminant was NOT imagery — it was the clock:
 *
 *   UNPINNED SUN. This probe never disabled the sky, the sun, the atmosphere or
 *   the skyBox, and never set the clock. `Viewer` starts at the wall-clock
 *   instant with `shouldAnimate` true, and every render was `s.render()` with no
 *   argument, which `Scene.js` fills with `JulianDate.now()`. Solar elevation,
 *   and therefore the brightness of every lit pixel the metric classifies,
 *   differed on every run and drifted DURING each run. The metric's
 *   classification is a hard luminance threshold (`L > 90`) with a saturation
 *   bound (`max-min < 55`), so a sun-angle change moves pixels across it in
 *   bulk.
 *
 *   ADVECTING DECK. `cloudWindSpeed` sat at its 15.0 m/s default
 *   (`CloudVolumetrics.js:83`), so the deck was moving across a near-ground
 *   upward view through the whole capture — with `time` supplied by the wall
 *   clock, per the point above.
 *
 *   TIER PATH. `cloudQuality` sat at its 64 default, i.e. temporal accumulation
 *   + jitter + half-res, all frame-index inputs to the march.
 *
 *   NETWORK GLOBE + BRIGHT GROUND. It loaded `?renderer=webgpu` with no
 *   `offline` flag, so `CesiumViewerStartupOptions.js:27-42` supplied Cesium
 *   World Terrain and the Ion world-imagery base layer, and it never set a globe
 *   base colour. The camera sits at 650 m with a +16 degree pitch and a ~23.4
 *   degree vertical half-FOV, so the BOTTOM of the frame is at or below the
 *   horizon and the sampled region reaches down to y = 0.82h. Sunlit terrain
 *   imagery is exactly what the classifier is looking for — bright, low
 *   saturation, not blue. How much of it lands inside the band depends on the
 *   projection and on which tiles had arrived, so this was a variable, not a
 *   constant, offset. (The precise fraction of the band that is below the
 *   horizon was NOT measured — it needs a browser. The pin removes the question
 *   rather than answering it: imagery is gone and the ground is a provably
 *   non-classifying dark base colour.)
 *
 *   BLIND WAIT. Both legs were flat `waitForTimeout` sleeps on nothing —
 *   6000 ms after a source swap, with the verdict read whenever that expired.
 *
 * The pins are P1-P8 as documented in `lib/weather-probe-pinning.mjs`; that
 * module is the shared enforceable home, and `probe-weather-channels.mjs` is the
 * reference implementation. Every pin is READ BACK — from the scene for the
 * scene pins, from packed cloud-uniform slots 35/44/64/74/107 for the
 * shader-visible ones — and a pin that did not take reports STRUCTURAL.
 *
 * THE SKY IS DELIBERATELY LEFT ON. Unlike the nadir probes in this fleet, this
 * probe's metric is built AROUND a lit sky: it excludes blue sky explicitly
 * (`b > r + 25 && b > 120`) and counts what is left. Blanking the sky would
 * change what the classifier means, so the sky, sun, moon and skyBox stay as
 * authored and are made deterministic by the fixed clock instead. What IS
 * removed is everything below the horizon that the classifier would mistake for
 * deck: imagery, streamed terrain, ground atmosphere, fog, and the default globe
 * colour (now a dark base colour whose L is far under the 90 bar).
 *
 * RESIDUAL METRIC WEAKNESS, recorded and NOT worked around. Near the horizon the
 * atmosphere whitens, so `b > r + 25` stops holding and low-altitude sky can be
 * classified as deck. That is a property of the authored metric, it is present
 * in both the hi and the lo leg, and gate 5 scores a DIFFERENCE — so it is not a
 * false-green path for gate 5. It IS a constant offset on gate 4's absolute
 * `deckHi > 5`. This probe does not adjust either threshold; the observation is
 * filed here so the number is read with it in mind.
 *
 * DETERMINISM CONTROL. The uniform-0.95 deck is captured TWICE under one
 * configuration, and the order is deliberately `hiA -> lo -> hiB` so the control
 * BRACKETS the cleared leg in time and spans BOTH source swaps — including the
 * swap back to 0.95, which additionally proves the deck is a function of the
 * CURRENT source rather than of how many sources have been seen. The two must
 * agree within `CONTROL.perSample` percentage points and the cloud `time`
 * uniform must read the same value in both. The tolerance sits strictly inside
 * gate 5's scored 5-point margin. If the control fails the probe reports
 * STRUCTURAL (exit 3) and certifies NOTHING.
 *
 * WHAT THE PINNING CHANGES ABOUT THE NUMBERS. Removing imagery and ground
 * atmosphere, darkening the globe, stopping the wind, escaping the tier path and
 * fixing the clock all move the ABSOLUTE percentages. Any `deck%` values
 * recorded for this probe before this pass are NOT a baseline and must not be
 * compared against. Gate 5 is relative and survives; gate 4 (`deckHi > 5`) is
 * ABSOLUTE and is the one gate in this probe whose pass/fail could legitimately
 * change — if it now fails, that is a finding to investigate, not a licence to
 * lower the bar.
 *
 * Usage:
 *   node Tools/visual-regression/probe-weather-ingest.mjs
 * Env:
 *   PROBE_BASE  default http://localhost:8080
 * Out:
 *   Tools/visual-regression/output/weather-ingest/*.png + manifest.json
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
const OUT = "Tools/visual-regression/output/weather-ingest";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
const VIEW = { width: 1024, height: 768 };

const WATCHDOG_MS = 600_000;

const PIN = {
  // Near-ground upward view so the deck fills the sky and reads clearly.
  // UNCHANGED from the pre-pinning probe.
  lon: -95.0,
  lat: 39.0,
  cameraHeight: 650.0,
  headingDegrees: 90.0,
  pitchDegrees: 16.0,
  // Sampled sky region — UNCHANGED fractions.
  region: { x0: 0.1, x1: 0.95, y0: 0.1, y1: 0.82 },
  warmupDiscards: 2,
  viewSettleMs: 1500,
  sourceSettleMs: 1500,
  sourceBudgetMs: 30_000,
  readyMinSettleMs: 3000,
  readyBudgetMs: 90_000,
  readyMaxFrames: 120,
};

/** Scored thresholds — IDENTICAL to the pre-pinning probe. */
const ASSERT = {
  minDeckHi: 5,
  clearMargin: 5,
};

/** Determinism-control tolerance (percentage points) — inside ASSERT.clearMargin. */
const CONTROL = {
  perSample: 1.0,
  mean: 1.0,
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

  // ── P1/P2 plus the below-the-horizon half of P8. The SKY stays as authored —
  // see the header: this probe's classifier is built around a lit sky.
  const pins = pin.pinScene(C, {
    darkGlobe: true,
    groundAtmosphere: false,
    fog: false,
  });

  // ── Cloud dials. Coverage/density are the AUTHORED scene and are deliberately
  // unchanged (coverage 0.5 makes weatherStrength 1.0, so effectiveCoverage is
  // the map's R directly). The determinism dials (P3/P4/P8) are spread in from
  // the shared module.
  const volumetricDials = {
    cloudCoverage: 0.5,
    cloudDensity: 0.45,
    cloudWeatherChannelStrength: 1.0,
    ...cfg.determinismDials,
  };
  const configure = () =>
    globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: volumetricDials,
    });

  // ── P6: one fixed instant — local mean noon at the view longitude. The sun is
  // then ~73 degrees up and due south while the camera looks east through a
  // frame spanning about -7 to +39 degrees of pitch, so the solar disc is out of
  // frame and the illumination is identical on every run.
  const frameTime = pin.localNoonAt(C, cfg.lon);

  const setView = () =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(cfg.lon, cfg.lat, cfg.cameraHeight),
      orientation: {
        heading: C.Math.toRadians(cfg.headingDegrees),
        pitch: C.Math.toRadians(cfg.pitchDegrees),
        roll: 0.0,
      },
    });

  // Export-surface + EDR URL checks (no network).
  const api = {
    hasProvider: typeof C.WeatherProvider === "function",
    hasEdr: typeof C.EdrWeatherSource === "function",
    hasSynthetic: typeof C.SyntheticWeatherSource === "function",
    hasPacker: typeof C.packWeatherField === "function",
  };
  const edrUrl = api.hasEdr
    ? new C.EdrWeatherSource().buildUrl({ time: "latest" })
    : "";

  setView();
  const globeReady = await pin.awaitGlobeReady(
    C,
    frameTime,
    cfg.readyMinSettleMs,
    cfg.readyBudgetMs,
  );
  // configure() is what actually ENABLES the volumetric renderer; awaiting
  // readiness without it times out at executeCalls=0.
  const configured = configure();
  const proceduralReady = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime,
    maxFrames: cfg.readyMaxFrames,
  });
  setView();

  const volumetric = scene.globe.defaultCloudCollection.volumetric;
  const setSource = (value) => {
    const source = new C.SyntheticWeatherSource("uniform", value);
    // Assigned directly rather than through `configure`, whose round-trip
    // snapshot would deep-walk the packed Uint8Array the provider holds.
    if (!volumetric.weatherProvider) {
      volumetric.weatherProvider = new C.WeatherProvider(source);
    } else {
      volumetric.weatherProvider.setSource(source);
    }
    return volumetric.weatherProvider;
  };

  /**
   * Whitish/grey cloud-deck fraction in the sky region (upper-centre). The
   * classifier is UNCHANGED from the pre-pinning probe: same region fractions,
   * same luminance bar, same saturation bound, same blue-sky exclusion, and the
   * same "every pixel in the region counts toward n" denominator. It now runs on
   * the canvas bits captured in the SAME task as the render that produced them,
   * instead of on a re-decoded Playwright screenshot.
   */
  const deckPercent = (frame) => {
    const { data, width, height } = frame;
    const x0 = Math.floor(width * cfg.region.x0);
    const x1 = Math.floor(width * cfg.region.x1);
    const y0 = Math.floor(height * cfg.region.y0);
    const y1 = Math.floor(height * cfg.region.y1);
    let cloud = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const blueSky = b > r + 25 && b > 120;
        if (!blueSky && L > 90 && mx - mn < 55) {
          cloud++;
        }
        n++;
      }
    }
    return { deck: n ? +((100 * cloud) / n).toFixed(2) : 0, samples: n };
  };

  const captureLeg = async (label, wantPng) => {
    setView();
    // DISCARDED warm-up renders.
    for (let i = 0; i < cfg.warmupDiscards; i++) {
      pin.renderAt(frameTime);
    }
    const settledFrames = await pin.settle(frameTime, cfg.viewSettleMs);
    // ── P7: same-task capture.
    const frame = pin.capture(frameTime, wantPng);
    return {
      label,
      settledFrames,
      png: frame.png,
      slots: frame.slots,
      ...deckPercent(frame),
    };
  };

  // ── P5: the packed bytes must reach the GPU and the uniform must enable the
  // map, after EVERY source change. A flat sleep proves neither.
  const hiProvider = setSource(0.95);
  const hiApplied = await pin.awaitWeatherApplied(
    hiProvider,
    frameTime,
    cfg.sourceBudgetMs,
  );
  await pin.settle(frameTime, cfg.sourceSettleMs);
  const hiState = {
    hasData: hiProvider.hasData,
    version: hiProvider.version,
    lastError: hiProvider.lastError ? String(hiProvider.lastError) : null,
  };
  // Order is deliberate: hiA -> lo -> hiB, so the hiA/hiB determinism control
  // BRACKETS the cleared leg in time and spans BOTH source swaps. A control
  // taken back to back before the swap would only prove the instrument was
  // stable across a gap that gate 5 never reads across.
  const hiA = await captureLeg("hiA", true);

  const loProvider = setSource(0.0);
  const loApplied = await pin.awaitWeatherApplied(
    loProvider,
    frameTime,
    cfg.sourceBudgetMs,
  );
  await pin.settle(frameTime, cfg.sourceSettleMs);
  const loState = {
    hasData: loProvider.hasData,
    version: loProvider.version,
    lastError: loProvider.lastError ? String(loProvider.lastError) : null,
  };
  const lo = await captureLeg("lo", true);

  const hiBackProvider = setSource(0.95);
  const hiBackApplied = await pin.awaitWeatherApplied(
    hiBackProvider,
    frameTime,
    cfg.sourceBudgetMs,
  );
  await pin.settle(frameTime, cfg.sourceSettleMs);
  const hiB = await captureLeg("hiB", false);

  return {
    api,
    edrUrl,
    pins,
    dials: pin.readDials(),
    readiness: { globeReady, proceduralReady, configured },
    applied: { hi: hiApplied, lo: loApplied, hiBack: hiBackApplied },
    states: { hi: hiState, lo: loState },
    legs: { hiA, hiB, lo },
  };
};

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

  const { hiA, hiB, lo } = result.legs;
  const deckHi = hiA.deck;
  const deckLo = lo.deck;

  // ── Evidence PNGs (canvas-element bits, captured in the same task as the
  // render that produced them).
  const written = [];
  const writePng = (leg, name) => {
    if (!leg?.png) {
      return;
    }
    fs.writeFileSync(
      `${OUT}/${name}`,
      Buffer.from(leg.png.slice(leg.png.indexOf(",") + 1), "base64"),
    );
    written.push(name);
  };
  writePng(hiA, "weather-ingest-uniform-hi.png");
  writePng(lo, "weather-ingest-uniform-lo.png");

  console.log(
    `renderer=${result.pins.rendererType} pins=${JSON.stringify(result.pins)}`,
  );
  console.log(`dials ${JSON.stringify(result.dials)}`);
  console.log(
    `readiness globe{binned=${result.readiness.globeReady.binnedGlobeCommands} firstMs=${result.readiness.globeReady.firstBinnedMs} elapsedMs=${result.readiness.globeReady.elapsedMs}} procedural{frames=${result.readiness.proceduralReady.waitedFrames} executeCalls=${result.readiness.proceduralReady.executeCalls}}`,
  );
  console.log(`api ${JSON.stringify(result.api)}`);
  console.log(`edrUrl ${result.edrUrl}`);
  console.log(`applied ${JSON.stringify(result.applied)}`);
  console.log(
    `deck%% hiA=${hiA.deck} hiB=${hiB.deck} lo=${lo.deck} | ` +
      `stateHi=${JSON.stringify(result.states.hi)} stateLo=${JSON.stringify(result.states.lo)} errs=${newErrs.length}`,
  );

  // ── STRUCTURAL preconditions.
  const labelled = [hiA, hiB, lo].map((leg) => ({ ...leg, label: leg.label }));
  const structural = collectPinStructural({
    pins: result.pins,
    dials: result.dials,
    captures: labelled,
    applied: result.applied,
    globeReadiness: { setup: result.readiness.globeReady },
    expectedChannelStrength: 1,
  });

  // ── DETERMINISM CONTROL.
  const control = collectRepeatStructural({
    label: "hiA vs hiB",
    a: [{ key: "deck", value: hiA.deck, time: hiA.slots.time }],
    b: [{ key: "deck", value: hiB.deck, time: hiB.slots.time }],
    perSample: CONTROL.perSample,
    mean: CONTROL.mean,
  });
  console.log(
    `\n=== DETERMINISM CONTROL (hiA vs hiB, one configuration) ===\n` +
      `  deck%% ${hiA.deck} vs ${hiB.deck}, delta ${control.maxPerSample.toFixed(4)} (tolerance ${CONTROL.perSample} point(s))\n` +
      `  cloud time uniform (slot 35) drift: ${control.timeDrift.length === 0 ? "none" : JSON.stringify(control.timeDrift)}`,
  );
  structural.push(...control.reasons);

  // ── Scored gates. Thresholds UNCHANGED from the pre-pinning probe.
  const edrOk =
    typeof result.edrUrl === "string" &&
    result.edrUrl.includes("/collections/") &&
    result.edrUrl.includes("/cube?") &&
    result.edrUrl.includes("parameter-name=") &&
    result.edrUrl.includes("CoverageJSON");
  const stateHi = result.states.hi;
  const checks = [
    [
      "Weather API exported (Provider/Edr/Synthetic/packer)",
      result.api.hasProvider &&
        result.api.hasEdr &&
        result.api.hasSynthetic &&
        result.api.hasPacker,
    ],
    ["EdrWeatherSource.buildUrl() is a valid EDR cube URL", edrOk],
    [
      "provider fetched data (hasData true, version > 0)",
      !!stateHi && stateHi.hasData && stateHi.version > 0,
    ],
    [
      `uniform-0.95 renders a deck (deck ${deckHi}% > ${ASSERT.minDeckHi})`,
      deckHi > ASSERT.minDeckHi,
    ],
    [
      `uniform-0.0 CLEARS the deck (deck ${deckLo}% < ${deckHi} - ${ASSERT.clearMargin}, i.e. data drives coverage)`,
      deckLo < deckHi - ASSERT.clearMargin,
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
      delta: control.maxPerSample,
      ok: control.reasons.length === 0,
    },
    result,
    stats: { deckHi, deckHiRepeat: hiB.deck, deckLo },
    errors: newErrs,
    structural,
    verdict: structural.length ? "STRUCTURAL" : pass ? "GREEN" : "RED",
  };
  // Strip the base64 PNGs out of the manifest — they are already on disk.
  for (const leg of Object.values(manifest.result.legs)) {
    delete leg.png;
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
