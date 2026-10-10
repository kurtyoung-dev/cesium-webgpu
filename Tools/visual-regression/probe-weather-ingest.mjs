#!/usr/bin/env node
/**
 * Weather ingest MVP (Phase 0/1) — end-to-end pipeline probe. WebGPU-only.
 * @purpose Gate-B leg: ingest MVP — SyntheticWeatherSource through provider/packer to the C2-16 weather map; deck appears at 0.95, clears at 0.0.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
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
 * RUNTIME (probe-kit harvest). The browser, the served-build preflight, the
 * Edge slot, the deadline and the receipt belong to `lib/probe-runtime.mjs`;
 * this file keeps the page lane, the pins and the gates, and the page lane and
 * every threshold are byte-for-byte what they were before the migration.
 *
 * Usage (serve the built tree on a governed port first, e.g.
 * `node server.js --port 8094 --serve-built`):
 *   node Tools/visual-regression/probe-weather-ingest.mjs [--port 8094] [--runs 10]
 * Out:
 *   Tools/visual-regression/output/weather-ingest/*.png, plus the runtime's
 *   weather-ingest-report.json / -runtime.json / -summary.md
 * Exit (the runtime's table):
 *   0 every gate decided and passed | 1 a real product FAIL |
 *   2 harness error or deadline | 3 STRUCTURAL, raised as a refusal — a pin
 *     did not take, a source never reached the GPU, or the probe could not
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

/** The pre-migration watchdog bound, now the lifecycle's per-run work budget. */
const WORK_BUDGET_MS = 600_000;

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
    const frame = await pin.capture(frameTime, wantPng);
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

/**
 * Score one run from the page lane's own return value. Pure: the result and
 * the filtered error list go in; the gates, the STRUCTURAL reasons and the
 * numbers the receipt banks come out. Every threshold is the pre-migration
 * probe's.
 *
 * @param {object} result What `RUN_LANE` returned.
 * @param {string[]} errors New device / console errors, already filtered.
 * @returns {{checks: Array<[string, string, boolean]>, structural: string[],
 *   stats: object, control: object}}
 */
export function scoreIngest(result, errors) {
  const { hiA, hiB, lo } = result.legs;
  const deckHi = hiA.deck;
  const deckLo = lo.deck;

  // ── STRUCTURAL preconditions.
  const structural = collectPinStructural({
    pins: result.pins,
    dials: result.dials,
    captures: [hiA, hiB, lo].map((leg) => ({ ...leg, label: leg.label })),
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
  structural.push(...control.reasons);

  // ── Scored gates. Thresholds UNCHANGED from the pre-pinning probe.
  const edrOk =
    typeof result.edrUrl === "string" &&
    result.edrUrl.includes("/collections/") &&
    result.edrUrl.includes("/cube?") &&
    result.edrUrl.includes("parameter-name=") &&
    result.edrUrl.includes("CoverageJSON");
  const stateHi = result.states.hi;
  return {
    checks: [
      // A silent WebGL fallback HARD-FAILS rather than reporting STRUCTURAL.
      [
        "backend-webgpu",
        `backend is WebGPU (${result.pins.rendererType})`,
        result.pins.rendererType === "webgpu",
      ],
      [
        "api",
        "Weather API exported (Provider/Edr/Synthetic/packer)",
        Boolean(
          result.api.hasProvider &&
          result.api.hasEdr &&
          result.api.hasSynthetic &&
          result.api.hasPacker,
        ),
      ],
      ["edr-url", "EdrWeatherSource.buildUrl() is a valid EDR cube URL", edrOk],
      [
        "fetched",
        "provider fetched data (hasData true, version > 0)",
        Boolean(stateHi && stateHi.hasData && stateHi.version > 0),
      ],
      [
        "deck",
        `uniform-0.95 renders a deck (deck ${deckHi}% > ${ASSERT.minDeckHi})`,
        deckHi > ASSERT.minDeckHi,
      ],
      [
        "clears",
        `uniform-0.0 CLEARS the deck (deck ${deckLo}% < ${deckHi} - ${ASSERT.clearMargin}, i.e. data drives coverage)`,
        deckLo < deckHi - ASSERT.clearMargin,
      ],
      ["clean", `no NEW device errors (${errors.length})`, errors.length === 0],
    ],
    structural,
    stats: { deckHi, deckHiRepeat: hiB.deck, deckLo },
    control: {
      ...CONTROL,
      delta: control.maxPerSample,
      timeDrift: control.timeDrift,
      ok: control.reasons.length === 0,
    },
  };
}

/** The runtime descriptor: the page lane runs in `cells`, the gates in `verdicts`. */
export const descriptor = {
  name: "weather-ingest",
  title:
    "Weather ingest leg: a synthetic source through provider and packer to the weather map, deck present at 0.95 and cleared at 0.0",
  outputSubdirectory: "weather-ingest",
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

    const result = await page.evaluate(RUN_LANE, {
      ...PIN,
      determinismDials: WEATHER_DETERMINISM_DIALS,
    });

    const gate = await collectGateErrors(page);
    const errors = (gate.errors || [])
      .concat(consoleErrors)
      .concat(gate.deviceLost ? [gate.deviceLost] : [])
      .filter(
        (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
      );

    // ── Evidence PNGs (canvas-element bits, captured in the same task as the
    // render that produced them).
    const written = [];
    fs.mkdirSync(outputDirectory, { recursive: true });
    for (const [leg, name] of [
      [result.legs.hiA, "weather-ingest-uniform-hi.png"],
      [result.legs.lo, "weather-ingest-uniform-lo.png"],
    ]) {
      if (!leg?.png) continue;
      const bytes = Buffer.from(
        leg.png.slice(leg.png.indexOf(",") + 1),
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
    for (const leg of Object.values(result.legs)) delete leg.png;

    const scored = scoreIngest(result, errors);
    console.log(
      `weather-ingest run ${run}: ${result.pins.rendererType} | ` +
        `deck% hiA ${result.legs.hiA.deck} hiB ${result.legs.hiB.deck} lo ${result.legs.lo.deck} | ` +
        `control delta ${scored.control.delta.toFixed(4)} | errs ${errors.length}`,
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
      pin: PIN,
      assert: ASSERT,
      control: CONTROL,
      runs: cells,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
