#!/usr/bin/env node
/**
 * Probe: C13-07 — dateline + pole weather-map seam correction (pixel gate).
 * @purpose C13-07 pixel gate: no dateline luminance wall (frame-relative column-step test), bounded polar-cap variance, no NaN cluster; non-vacuity gate.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * PINNED for determinism under `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`.
 *
 * The Node contract suite (weather-map-seam.spec.mjs) proves the TEXTURE math:
 * periodic fBM removed the antimeridian wall (max step 1.000 -> 0.067) and the
 * polar low-pass made both cap rows constant. This probe proves the PIXELS:
 *
 *   D1 DATELINE — nadir over lon 180 with the weather map ON. The adjacent-
 *      column luminance step of the center band (where the +/-180 meridian
 *      projects) must not be an outlier against the same frame's own column-
 *      step distribution. Pre-fix this was a full-contrast cloud/clear wall.
 *   D2 CONTROL  — the seam view is its own control: the frame's own step
 *      distribution supplies the comparison scale.
 *   P1 POLE     — nadir near 90N/90S. A small ring around the projected pole
 *      must have bounded azimuthal luminance variance (constant cap row), and
 *      the central pixel block must contain no NaN-garbage cluster (atan2 guard).
 *   NV NON-VACUITY — the dateline lane requires a visible cloud fraction; a
 *      frame with no clouds cannot certify a seam and reports STRUCTURAL.
 *
 * Volumetric clouds are WebGPU-only, so the pixel lanes run on WebGPU. A
 * WebGL viewer load-sanity arm confirms the backend-neutral Scene/Weather
 * modules do not break the WebGL bundle.
 *
 * WHAT IS SCORED — every threshold below is UNCHANGED from the pre-pinning
 * probe. None was widened, lowered, or dropped.
 *   WEBGL-LOAD  the WebGL viewer comes up with 0 console errors
 *   D-eq NV     `cloudFrac >= 0.05` (else STRUCTURAL, as before)
 *   D-eq wall   `max(L,R)/min(L,R) <= 3.0` across the meridian
 *   D-eq step   `centerMax <= max(2.5 * p95, 20)`
 *   P-ring      NOT (`mean > 15` AND `maxDev > max(0.6 * mean, 40)`)
 *   P-center    NOT (`cMax > 3 * max(mean, 20)` AND `cMax > 200`)
 *   WEBGPU      0 console errors on the WebGPU page
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PROBE WAS PINNED — and what it already had right
 * ─────────────────────────────────────────────────────────────────────────────
 * It was one of the six Gate-B legs recorded GREEN while `probe-weather-
 * channels.mjs` flipped GREEN/RED/RED/RED/RED on one build. The audit
 * (`C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`) classified it SUSCEPTIBLE, but on a
 * DIFFERENT axis from the rest of the fleet, and it deserves credit for what it
 * already closed:
 *
 *   ALREADY CLOSED, before this pass. It called `imageryLayers.removeAll()` and
 *   set a dark globe base colour with sky/sun/moon/skyBox off, so the imagery
 *   contamination that produced the `channels` flip could not reach its
 *   luminance metric. It pinned the clock to a computed local solar noon per
 *   view with `shouldAnimate = false`. It fused render + read in one task. It
 *   had a real non-vacuity gate. None of that was the problem.
 *
 *   STILL OPEN — the clock, via the render driver. `viewer.useDefaultRenderLoop`
 *   was left true and every settle frame was `s.render()` with NO argument,
 *   which `Scene.js` fills with `JulianDate.now()`. Setting
 *   `viewer.clock.currentTime` does not reach a render that supplies its own
 *   time, so `frameState.time` — and therefore the cloud `time` uniform — still
 *   advanced with the wall clock on every frame the probe drove.
 *
 *   STILL OPEN — an advecting field. `cloudWindSpeed` sat at its 15.0 m/s
 *   default (`CloudVolumetrics.js:83`), and `cloud.time` reaches the density
 *   field exactly as `windDirection * windSpeed * time`. Combined with the point
 *   above, the cloud field was translating across the frame throughout the 120
 *   settle frames and into the scored capture. Both scored quantities here are
 *   fine-grained spatial statistics — an adjacent-column step distribution and a
 *   12-sector azimuthal variance — so a translating field moves them directly.
 *
 *   STILL OPEN — the tier path. `cloudQuality` sat at its 64 default, so at
 *   250 km the march ran with temporal accumulation, jitter and half-res. All
 *   three are frame-index inputs. Temporal accumulation is the dangerous one
 *   HERE, because it low-pass filters exactly the adjacent-column step this
 *   probe scores: it can suppress `centerMax` below the outlier bar, which is a
 *   false-GREEN direction for D1.
 *
 *   STILL OPEN — streamed terrain. The probe removed imagery but never forced an
 *   `EllipsoidTerrainProvider`, and the page had no `offline` flag, so
 *   `CesiumViewerStartupOptions.js:27-42` supplied Cesium World Terrain. Tiles
 *   arriving during the settle re-tile the frame mid-capture.
 *
 * The pins are P1-P8 as documented in `lib/weather-probe-pinning.mjs`; that
 * module is the shared enforceable home, and `probe-weather-channels.mjs` is the
 * reference implementation. Every pin is READ BACK — from the scene for the
 * scene pins, from packed cloud-uniform slots 35/44/64/74 for the shader-visible
 * ones — and a pin that did not take reports STRUCTURAL rather than a verdict.
 * Slot 64 (`weatherMapEnabled`) is required to read 1: this probe drives the
 * PROCEDURAL weather map via `cloudWeatherMap = true` and there is no provider,
 * so `weatherEnabled = config.cloudWeatherMap === true` is the whole condition
 * (`WebGPUProceduralCloudRenderer.ts:2027-2029`) — if it reads 0 the seam under
 * test is not even in the frame.
 *
 * DETERMINISM CONTROL. Two of the three evidence views are captured TWICE back
 * to back under one configuration: the dateline view (control on its ~819
 * adjacent column means, which is what BOTH D1 statistics are derived from) and
 * the north-pole view (control on its 12 azimuthal sector means, which is what
 * the P1 ring statistic is derived from). The repeats must agree per sample
 * within `CONTROL.perSample` luminance units and on the mean within
 * `CONTROL.mean`, the cloud `time` uniform must read identically in both, and
 * the dateline `cloudFrac` must agree within `CONTROL.cloudFrac`. The tolerances
 * sit strictly inside the smallest scored bar (D1's `centerMax` floor of 20: a
 * per-column noise of 2.0 can move one step by at most 4.0). If a control fails
 * the probe reports STRUCTURAL (exit 3) and certifies NOTHING. The south-pole
 * lane is not repeated; it uses the identical capture path the north-pole
 * control validates.
 *
 * WHAT THE PINNING CHANGES ABOUT THE NUMBERS. Stopping the wind, escaping the
 * tier path (LIVE noise, full-res, no temporal), fixing the render clock and
 * disabling ground atmosphere and fog all move the ABSOLUTE luminances. Any
 * `centerMax` / `p95` / `ring mean` / `cloudFrac` values recorded for this probe
 * before this pass are NOT a baseline and must not be compared against. Every
 * scored quantity here is relative to the SAME frame's own distribution
 * (centerMax vs that frame's p95, one hemisphere vs the other, one sector vs the
 * ring mean), so the comparisons survive; the absolute level does not.
 *
 * Capture doctrine: `scene.render(julianDate)` and the `canvas.toDataURL` freeze
 * share one task with no await/rAF yield; pixel decode reads only that frozen PNG.
 *
 * RUNTIME (probe-kit harvest). The browser, the served-build preflight, the
 * Edge slot, the deadline and the receipt belong to `lib/probe-runtime.mjs`;
 * this file keeps the WebGL load arm, the page lanes, the pins and the gates.
 * The page lanes are byte-for-byte what they were; the Node-side statistics
 * are `lib/metrics/seam-pole-structure.mjs`, and the bars that used to sit
 * inline are the `ASSERT` table below, every value unchanged.
 *
 * Usage (serve the built tree on a governed port first, e.g.
 * `node server.js --port 8094 --serve-built`):
 *   node Tools/visual-regression/probe-weather-seam-poles.mjs [--port 8094] [--runs 10]
 *   (`--renderer webgpu` skips the WebGL load arm; the seam lanes need WebGPU)
 * Exit (the runtime's table):
 *   0 PASS | 1 a real product FAIL | 2 harness error or deadline
 *   3 STRUCTURAL, raised as a refusal — a pin did not take, the frame was too
 *     clear to certify, or the probe could not reproduce its own capture
 *     (acceptance INCOMPLETE)
 */
import fs from "node:fs";
import path from "node:path";

import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";
import {
  centreHotSpot,
  columnStepStats,
  halfBalance,
  ringSpread,
} from "./lib/metrics/seam-pole-structure.mjs";
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

/** The pre-migration watchdog bound, now the lifecycle's per-run work budget. */
const WORK_BUDGET_MS = 600_000;

const PIN = {
  cameraHeight: 250000.0,
  warmupDiscards: 2,
  viewSettleMs: 1500,
  readyMinSettleMs: 3000,
  readyBudgetMs: 90_000,
  readyMaxFrames: 120,
};

/** Determinism-control tolerances — inside D1's `centerMax` floor bar of 20. */
const CONTROL = {
  perSample: 2.0,
  mean: 0.5,
  cloudFrac: 0.01,
};

/**
 * Scored bars — IDENTICAL to the pre-pinning probe, which wrote them inline.
 * D-eq: a frame clearer than `minCloudFrac` is STRUCTURAL; the brighter half
 * may be at most `maxHalfRatio` times the dimmer; the centre step may be at
 * most `max(stepP95Multiple * p95, stepFloor)`. P-ring: a pinwheel is
 * `mean > ringMeanFloor` AND `maxDev > max(ringDevFraction * mean,
 * ringDevFloor)`. P-centre: a hot cluster is `centreMax > centreMultiple *
 * max(ringMean, 20)` AND `centreMax > centreAbsolute`.
 */
const ASSERT = {
  minCloudFrac: 0.05,
  maxHalfRatio: 3.0,
  stepP95Multiple: 2.5,
  stepFloor: 20,
  ringMeanFloor: 15,
  ringDevFraction: 0.6,
  ringDevFloor: 40,
  centreMultiple: 3,
  centreAbsolute: 200,
  lowPoleCloudNote: 0.03,
};

/**
 * Runs INSIDE the page. `page.evaluate` drops the surrounding closure, so the
 * shared helpers arrive through `globalThis.__weatherPin` /
 * `globalThis.__cloudProbe` (installed via `addInitScript`).
 */
const SETUP_LANE = async (cfg) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const pin = globalThis.__weatherPin;

  // ── P1/P2/P8. Imagery would pollute the luminance metric (bright land reads
  // as "cloud"); a dark base colour leaves clouds as the only bright signal.
  const pins = pin.pinScene(C, {
    darkGlobe: true,
    groundAtmosphere: false,
    fog: false,
    sky: false,
  });

  // ── Cloud dials. Coverage/density/layer and the procedural weather map are
  // the AUTHORED scene and are deliberately unchanged; the determinism dials
  // (P3/P4/P8) are spread in from the shared module.
  const configured = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: {
      cloudCoverage: 0.6,
      cloudDensity: 0.9,
      cloudLayerBottom: 1500,
      cloudLayerTop: 4000,
      cloudWeatherMap: true,
      ...cfg.determinismDials,
    },
  });

  const readyTime = pin.localNoonAt(C, 0.0);
  window.viewer.scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(0.0, 0.0, cfg.cameraHeight),
    orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
  });
  const globeReady = await pin.awaitGlobeReady(
    C,
    readyTime,
    cfg.readyMinSettleMs,
    cfg.readyBudgetMs,
  );
  const proceduralReady = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime: readyTime,
    maxFrames: cfg.readyMaxFrames,
  });

  return {
    pins,
    dials: pin.readDials(),
    readiness: { globeReady, proceduralReady, configured },
  };
};

/**
 * One shared in-page routine: set view, settle a wall-clock budget, then render
 * and capture fused in one task. Returns column mean-luminances of a horizontal
 * band plus a small center block and a pole ring sample. The reducers are
 * UNCHANGED from the pre-pinning probe.
 */
const CAPTURE_LANE = async (cfg) => {
  const C = window.Cesium;
  const pin = globalThis.__weatherPin;
  const scene = window.viewer.scene;

  // ── P6: local solar noon for the view longitude — a fixed UTC time would put
  // the antimeridian on the night side and read unlit clouds as absent.
  const julianDate = pin.localNoonAt(C, cfg.lon);
  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.lon, cfg.lat, cfg.height),
    orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
  });
  // DISCARDED warm-up renders after the camera jump.
  for (let i = 0; i < cfg.warmupDiscards; i++) {
    pin.renderAt(julianDate);
  }
  // ── P7: WALL-CLOCK settle, then a same-task render + read.
  const settledFrames = await pin.settle(julianDate, cfg.viewSettleMs);
  const frame = await pin.capture(julianDate, true);
  const { data, width: w, height: h } = frame;

  const lum = (x, y) => {
    const i = (y * w + x) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]);
  };

  // Column means over the central horizontal band.
  const y0 = Math.floor(h * 0.3),
    y1 = Math.floor(h * 0.7);
  const cols = [];
  for (let x = Math.floor(w * 0.1); x < Math.floor(w * 0.9); x++) {
    let sum = 0,
      n = 0;
    for (let y = y0; y < y1; y += 2) {
      sum += lum(x, y);
      n++;
    }
    cols.push(sum / n);
  }

  // Cloud fraction (non-vacuity).
  let cloud = 0,
    n = 0;
  for (let y = Math.floor(h * 0.2); y < Math.floor(h * 0.8); y += 3) {
    for (let x = Math.floor(w * 0.2); x < Math.floor(w * 0.8); x += 3) {
      if (lum(x, y) > 120) {
        cloud++;
      }
      n++;
    }
  }

  // Pole sectors: mean luminance of 12 azimuthal sectors over an annulus
  // (radius 4%..12% of frame). At 250 km the whole frame sits inside the
  // constant polar cap (156 km radius), so a pre-fix pinwheel shows as
  // sector-to-sector spokes; sector MEANS (hundreds of px each) suppress
  // individual cloud-puff noise that single-pixel rings cannot.
  const cxp = Math.floor(w / 2),
    cyp = Math.floor(h / 2),
    r0 = Math.min(w, h) * 0.04,
    r1 = Math.min(w, h) * 0.12;
  const secSum = new Array(12).fill(0),
    secN = new Array(12).fill(0);
  for (let y = Math.floor(cyp - r1); y <= cyp + r1; y++) {
    for (let x = Math.floor(cxp - r1); x <= cxp + r1; x++) {
      const dx = x - cxp,
        dy = y - cyp,
        rr = Math.sqrt(dx * dx + dy * dy);
      if (rr < r0 || rr > r1) {
        continue;
      }
      const k =
        (Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 12) +
          12) %
        12;
      secSum[k] += lum(x, y);
      secN[k]++;
    }
  }
  const ring = secSum.map((s2, k) => (secN[k] ? s2 / secN[k] : 0));
  const center = [];
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      center.push(lum(cxp + dx, cyp + dy));
    }
  }

  return {
    tag: cfg.tag,
    settledFrames,
    cols,
    cloudFrac: n ? cloud / n : 0,
    ring,
    center,
    png: frame.png,
    slots: frame.slots,
  };
};

/**
 * Score one run. Pure: the setup lane's report, the five captured views (the
 * column means, sector means and centre block each view's page lane reduced
 * its frozen frame to), the WebGL load arm's console errors (`null` when the
 * arm did not run) and the WebGPU page's errors go in; the gates, the
 * STRUCTURAL reasons, the notes and the numbers come out.
 *
 * @param {{setup: object, views: object, webglErrors: string[]|null,
 *   webgpuErrors: string[]}} run
 * @returns {{checks: Array<[string, string, boolean]>, structural: string[],
 *   notes: string[], stats: object}}
 */
export function scoreSeamPoles({ setup, views, webglErrors, webgpuErrors }) {
  const { seam, seamRepeat, npole, npoleRepeat, spole } = views;
  const structural = [];
  const notes = [];

  // D1 — the seam view is its own control. Captured TWICE back to back: the
  // repeat is the determinism control on the very column means both D1
  // statistics are derived from.
  const eqControl = collectRepeatStructural({
    label: "CONTROL dateline-eq column means",
    a: seam.cols.map((v, i) => ({ key: i, value: v, time: seam.slots.time })),
    b: seamRepeat.cols.map((v, i) => ({
      key: i,
      value: v,
      time: seamRepeat.slots.time,
    })),
    perSample: CONTROL.perSample,
    mean: CONTROL.mean,
  });
  structural.push(...eqControl.reasons);
  const fracDelta = Math.abs(seam.cloudFrac - seamRepeat.cloudFrac);
  if (!(fracDelta <= CONTROL.cloudFrac)) {
    structural.push(
      `CONTROL dateline-eq: cloudFrac ${seam.cloudFrac.toFixed(3)} vs ${seamRepeat.cloudFrac.toFixed(3)} differs by ${fracDelta.toFixed(4)} (tolerance ${CONTROL.cloudFrac})`,
    );
  }
  const steps = columnStepStats(seam.cols);
  const stepsRepeat = columnStepStats(seamRepeat.cols);
  const halves = halfBalance(seam.cols);
  notes.push(
    `CONTROL D-eq: max per-column |delta| ${eqControl.maxPerSample.toFixed(3)} (tol ${CONTROL.perSample}), ` +
      `mean delta ${eqControl.meanDelta.toFixed(3)} (tol ${CONTROL.mean}), cloudFrac delta ${fracDelta.toFixed(4)}, ` +
      `centreMax ${steps.centreMax.toFixed(1)} vs ${stepsRepeat.centreMax.toFixed(1)}, ` +
      `time drift ${eqControl.timeDrift.length === 0 ? "none" : eqControl.timeDrift.length}`,
    `D-eq(0.7N): halves L ${halves.left.toFixed(1)} R ${halves.right.toFixed(1)} | centreMax ${steps.centreMax.toFixed(1)} p95 ${steps.p95.toFixed(1)} | cloudFrac ${seam.cloudFrac.toFixed(3)}`,
  );
  if (seam.cloudFrac < ASSERT.minCloudFrac) {
    structural.push(
      `D-eq: cloud fraction ${seam.cloudFrac.toFixed(3)} too low to certify (twin map says both seam sides cloudy at 0.7N)`,
    );
  }

  // P1 — the pole ring and the centre block. The north lane is captured twice:
  // the repeat is the determinism control on the sector means the ring
  // statistic is derived from.
  const poleControl = collectRepeatStructural({
    label: "CONTROL npole sector means",
    a: npole.ring.map((v, i) => ({ key: i, value: v, time: npole.slots.time })),
    b: npoleRepeat.ring.map((v, i) => ({
      key: i,
      value: v,
      time: npoleRepeat.slots.time,
    })),
    perSample: CONTROL.perSample,
    mean: CONTROL.mean,
  });
  structural.push(...poleControl.reasons);
  notes.push(
    `CONTROL npole: max per-sector |delta| ${poleControl.maxPerSample.toFixed(3)} (tol ${CONTROL.perSample}), ` +
      `mean delta ${poleControl.meanDelta.toFixed(3)} (tol ${CONTROL.mean}), ` +
      `time drift ${poleControl.timeDrift.length === 0 ? "none" : poleControl.timeDrift.length}`,
  );
  const poles = {};
  for (const [tag, view] of [
    ["npole", npole],
    ["spole", spole],
  ]) {
    if (view.cloudFrac < ASSERT.lowPoleCloudNote) {
      notes.push(
        `P-${tag}: cloud fraction ${view.cloudFrac.toFixed(3)} — cap row may legitimately be clear here; ring variance check still valid on any nonzero signal`,
      );
    }
    const ring = ringSpread(view.ring);
    const hot = centreHotSpot(view.center, ring.mean);
    poles[tag] = { ring, hot, cloudFrac: view.cloudFrac };
    notes.push(
      `P-${tag}: ring mean ${ring.mean.toFixed(1)} maxDev ${ring.maxDev.toFixed(1)} centreMax ${hot.centreMax} cloudFrac ${view.cloudFrac.toFixed(3)}`,
    );
  }

  // ── STRUCTURAL preconditions. A pin that did not take means the probe is not
  // measuring the configuration it documents, so it certifies nothing. Slot 107
  // is not checked: this probe never drives the G/B/A channel-strength dial.
  structural.push(
    ...collectPinStructural({
      pins: setup.pins,
      dials: setup.dials,
      captures: [
        { ...seam, label: "dateline-eq" },
        { ...seamRepeat, label: "dateline-eq-repeat" },
        { ...npole, label: "npole" },
        { ...npoleRepeat, label: "npole-repeat" },
        { ...spole, label: "spole" },
      ],
      globeReadiness: { setup: setup.readiness.globeReady },
      expectedChannelStrength: undefined,
    }),
  );

  // Constant cap row -> small azimuthal deviation on the small ring; a pre-fix
  // pinwheel produced full-range spokes. A hot centre cluster far above the
  // ring is the atan2(0,0) failure signature.
  const pinwheel = (p) =>
    p.ring.mean > ASSERT.ringMeanFloor &&
    p.ring.maxDev >
      Math.max(ASSERT.ringDevFraction * p.ring.mean, ASSERT.ringDevFloor);
  const hotCluster = (p) =>
    p.hot.centreMax > ASSERT.centreMultiple * p.hot.reference &&
    p.hot.centreMax > ASSERT.centreAbsolute;

  const checks = [];
  if (webglErrors !== null) {
    checks.push([
      "webgl-load",
      `the WebGL viewer comes up with 0 console errors (${webglErrors.length}${webglErrors.length ? `: ${webglErrors[0]}` : ""})`,
      webglErrors.length === 0,
    ]);
  }
  checks.push(
    // A silent WebGL fallback HARD-FAILS: volumetric clouds are WebGPU-only,
    // so scoring a WebGL frame as a WebGPU pass is a false green, not a blind leg.
    [
      "backend-webgpu",
      `backend is WebGPU (${setup.pins.rendererType})`,
      setup.pins.rendererType === "webgpu",
    ],
    [
      "deq-wall",
      `no hemisphere brightness wall across the meridian (L ${halves.left.toFixed(1)} vs R ${halves.right.toFixed(1)}, ratio ${halves.ratio.toFixed(2)} <= ${ASSERT.maxHalfRatio})`,
      halves.ratio <= ASSERT.maxHalfRatio,
    ],
    [
      "deq-step",
      `the centre column step is not an outlier (centreMax ${steps.centreMax.toFixed(1)} <= max(${ASSERT.stepP95Multiple} x p95 ${steps.p95.toFixed(1)}, ${ASSERT.stepFloor}))`,
      steps.centreMax <=
        Math.max(ASSERT.stepP95Multiple * steps.p95, ASSERT.stepFloor),
    ],
  );
  for (const tag of ["npole", "spole"]) {
    const p = poles[tag];
    checks.push(
      [
        `${tag}-ring`,
        `P-${tag}: no azimuthal pinwheel (ring mean ${p.ring.mean.toFixed(1)}, maxDev ${p.ring.maxDev.toFixed(1)})`,
        !pinwheel(p),
      ],
      [
        `${tag}-centre`,
        `P-${tag}: no hot centre cluster (centreMax ${p.hot.centreMax} vs ring mean ${p.ring.mean.toFixed(1)})`,
        !hotCluster(p),
      ],
    );
  }
  checks.push([
    "webgpu-clean",
    `0 console errors on the WebGPU page (${webgpuErrors.length}${webgpuErrors.length ? `: ${webgpuErrors[0]}` : ""})`,
    webgpuErrors.length === 0,
  ]);

  return {
    checks,
    structural,
    notes,
    stats: {
      deq: { ...halves, ...steps, cloudFrac: seam.cloudFrac, fracDelta },
      npole: poles.npole,
      spole: poles.spole,
      controls: {
        eq: {
          maxPerSample: eqControl.maxPerSample,
          meanDelta: eqControl.meanDelta,
        },
        npole: {
          maxPerSample: poleControl.maxPerSample,
          meanDelta: poleControl.meanDelta,
        },
      },
    },
  };
}

/** The runtime descriptor: the WebGL arm and the page lanes run in `cells`. */
export const descriptor = {
  name: "weather-seam-poles",
  title:
    "Weather-map dateline and pole seam gate: no meridian wall, bounded polar-cap spread, no centre hot cluster",
  outputSubdirectory: "weather-seam-poles",
  receiptEnvelope: "probe-owned",
  // Both viewer pages import this one ESM entry; the Sandcastle2 bucket
  // bundle in the runtime's default list is never loaded.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () => WORK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the seam lanes read volumetric clouds, which are WebGPU-only, so a run on " +
          `${options.renderers.join(",")} would score an empty frame`,
        { renderers: options.renderers },
      );
    }

    // --- WebGL load sanity --------------------------------------------------
    // Deliberately UNCHANGED, including the absence of `offline=true`. This arm
    // scores console errors, not pixels, and exercising the normal online
    // startup path is the point of a bundle load-sanity check.
    let webglErrors = null;
    if (options.renderers.includes("webgl")) {
      const page = await browser.newPage({
        viewport: { width: 640, height: 480 },
      });
      const errs = [];
      page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
      page.on("pageerror", (e) => errs.push("PE:" + e.message));
      await page.goto(`${origin}/Apps/CesiumViewer/index.html?renderer=webgl`, {
        waitUntil: "networkidle",
        timeout: 90000,
      });
      // The options are the THIRD argument; the second is the page function's
      // own argument, where this bound used to sit and never applied.
      await page.waitForFunction(() => !!window.viewer, null, {
        timeout: 90000,
      });
      webglErrors = errs;
      await page.close();
    }

    // --- WebGPU pixel lanes -------------------------------------------------
    const page = await browser.newPage({
      viewport: { width: 1024, height: 768 },
    });
    const webgpuErrors = [];
    page.on(
      "console",
      (m) => m.type() === "error" && webgpuErrors.push(m.text()),
    );
    page.on("pageerror", (e) => webgpuErrors.push("PE:" + e.message));
    await installCloudProbeHarnessOnPage(page);
    await installWeatherPinHarnessOnPage(page);
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90000,
    });

    const setup = await page.evaluate(SETUP_LANE, {
      ...PIN,
      determinismDials: WEATHER_DETERMINISM_DIALS,
    });
    const captureView = (lon, lat, height, tag) =>
      page.evaluate(CAPTURE_LANE, {
        lon,
        lat,
        height,
        tag,
        warmupDiscards: PIN.warmupDiscards,
        viewSettleMs: PIN.viewSettleMs,
      });

    // D1 — latitude 0.7N was chosen from the CPU-twin map: the texels on BOTH
    // sides of the seam are cloudy there (west 0.935 / east 0.882), so a
    // residual wall would split the frame into a bright half and a dark half at
    // the centre meridian. P1 — 89.995 keeps the camera regular while the cap
    // rows span 88.6..90, so the view still reads the constant cap. The order
    // is the pre-migration probe's: seam, its repeat, north, its repeat, south.
    const views = {
      seam: await captureView(180.0, 0.7, PIN.cameraHeight, "dateline-eq"),
      seamRepeat: await captureView(
        180.0,
        0.7,
        PIN.cameraHeight,
        "dateline-eq-repeat",
      ),
      npole: await captureView(0.0, 89.995, PIN.cameraHeight, "npole"),
      npoleRepeat: await captureView(
        0.0,
        89.995,
        PIN.cameraHeight,
        "npole-repeat",
      ),
      spole: await captureView(0.0, -89.995, PIN.cameraHeight, "spole"),
    };
    await page.close();

    // ── Evidence PNGs: every view, under its own tag, as the probe always
    // banked them. The receipt keeps the numbers, not the base64.
    const written = [];
    fs.mkdirSync(outputDirectory, { recursive: true });
    for (const view of Object.values(views)) {
      const name = `${view.tag}.png`;
      const bytes = Buffer.from(view.png.split(",")[1], "base64");
      const file = path.join(outputDirectory, name);
      fs.writeFileSync(file, bytes);
      captures.push({
        name,
        path: file,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      });
      written.push(name);
      delete view.png;
    }

    const scored = scoreSeamPoles({ setup, views, webglErrors, webgpuErrors });
    console.log(
      `weather-seam-poles run ${run}: renderer=${setup.pins.rendererType} ` +
        `readiness binned=${setup.readiness.globeReady.binnedGlobeCommands}`,
    );
    for (const note of scored.notes) {
      console.log(`  ${note}`);
    }
    // STRUCTURAL is a refusal, never a verdict: the runtime exits 3 and banks
    // the reasons and the numbers in the refusal record, not a receipt.
    if (scored.structural.length > 0) {
      throw new ProbeRefusal(
        "weather-structural",
        `STRUCTURAL in run ${run}, acceptance INCOMPLETE: ${scored.structural.join(" | ")}`,
        { run, scored },
      );
    }
    return [{ run, setup, views, written, scored }];
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
    return { pin: PIN, control: CONTROL, assert: ASSERT, runs: cells };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
