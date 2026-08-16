#!/usr/bin/env node
/**
 * Probe: C13-07 — dateline + pole weather-map seam correction (pixel gate).
 * @purpose C13-07 pixel gate: no dateline luminance wall (frame-relative column-step test), bounded polar-cap variance, no NaN cluster; non-vacuity gate.
 * @status ACTIVE
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
 * Capture doctrine: every pixel read is fused with a `scene.render(julianDate)`
 * in the SAME task (no rAF yield between render and drawImage).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-seam-poles.mjs
 * Exit:
 *   0 PASS | 1 a real product FAIL | 2 exception
 *   3 STRUCTURAL — a pin did not take, the frame was too clear to certify, or
 *     the probe could not reproduce its own capture (acceptance INCOMPLETE)
 */
import { chromium } from "playwright";
import fs from "node:fs";

import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";
import {
  collectPinStructural,
  collectRepeatStructural,
  installWeatherPinHarnessOnPage,
  WEATHER_DETERMINISM_DIALS,
} from "./lib/weather-probe-pinning.mjs";

// Machine-safety watchdog (Batch 861+ fleet sweep). A probe that wedges holds a
// headless Edge + GPU process alive indefinitely; `unref` keeps the timer from
// extending a healthy run.
const WATCHDOG_MS = 600_000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-weather-seam-poles] watchdog fired after ${WATCHDOG_MS} ms`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/weather-seam-poles";
fs.mkdirSync(OUT, { recursive: true });

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

const failures = [];
const structural = [];
const notes = [];

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
  const frame = pin.capture(julianDate, true);
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

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

let fatal = null;
try {
  // --- WebGL load sanity ---------------------------------------------------
  // Deliberately UNCHANGED, including the absence of `offline=true`. This arm
  // scores console errors, not pixels, and exercising the normal online startup
  // path is the point of a bundle load-sanity check.
  {
    const page = await browser.newPage({
      viewport: { width: 640, height: 480 },
    });
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("pageerror", (e) => errs.push("PE:" + e.message));
    await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
      waitUntil: "networkidle",
      timeout: 90000,
    });
    await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
    if (errs.length > 0) {
      failures.push(`WEBGL-LOAD: ${errs.length} console errors: ${errs[0]}`);
    } else {
      notes.push("WEBGL-LOAD: viewer up, 0 errors");
    }
    await page.close();
  }

  // --- WebGPU pixel lanes --------------------------------------------------
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push("PE:" + e.message));
  await installCloudProbeHarnessOnPage(page);
  await installWeatherPinHarnessOnPage(page);
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    { waitUntil: "networkidle", timeout: 90000 },
  );
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const setup = await page.evaluate(SETUP_LANE, {
    ...PIN,
    determinismDials: WEATHER_DETERMINISM_DIALS,
  });
  notes.push(
    `PINS: renderer=${setup.pins.rendererType} imagery=${setup.pins.imageryLayersBefore}->${setup.pins.imageryLayersAfter} ` +
      `ellipsoidTerrain=${setup.pins.ellipsoidTerrain} dials=${JSON.stringify(setup.dials)}`,
  );
  notes.push(
    `READY: globe binned=${setup.readiness.globeReady.binnedGlobeCommands} elapsedMs=${setup.readiness.globeReady.elapsedMs} ` +
      `procedural frames=${setup.readiness.proceduralReady.waitedFrames} executeCalls=${setup.readiness.proceduralReady.executeCalls}`,
  );

  const captureView = (lon, lat, height, tag) =>
    page.evaluate(CAPTURE_LANE, {
      lon,
      lat,
      height,
      tag,
      warmupDiscards: PIN.warmupDiscards,
      viewSettleMs: PIN.viewSettleMs,
    });

  const save = (r) =>
    fs.writeFileSync(
      `${OUT}/${r.tag}.png`,
      Buffer.from(r.png.split(",")[1], "base64"),
    );

  const scored = [];

  const stepStats = (cols) => {
    const steps = [];
    for (let i = 1; i < cols.length; i++) {
      steps.push(Math.abs(cols[i] - cols[i - 1]));
    }
    const mid = Math.floor(steps.length / 2);
    const half = Math.floor(steps.length * 0.04); // center 8% band
    const centerMax = Math.max(...steps.slice(mid - half, mid + half));
    const rest = steps
      .slice(0, mid - half)
      .concat(steps.slice(mid + half))
      .sort((a, b) => a - b);
    const p95 = rest[Math.floor(rest.length * 0.95)];
    return { centerMax, p95 };
  };

  // D1 — the seam view is its own control. Latitude 0.7N chosen from the
  // CPU-twin map: the texels on BOTH sides of the seam are cloudy there
  // (west 0.935 / east 0.882), so a residual wall would split the frame into
  // a bright half and a dark half at the center meridian. Post-fix the two
  // halves must be comparably cloudy and the center column step must not be
  // an outlier against the frame's own step distribution.
  //
  // Captured TWICE back to back: the repeat is the determinism control on the
  // very column means both D1 statistics are derived from.
  {
    const seam = await captureView(180.0, 0.7, PIN.cameraHeight, "dateline-eq");
    const seamRepeat = await captureView(
      180.0,
      0.7,
      PIN.cameraHeight,
      "dateline-eq-repeat",
    );
    save(seam);
    save(seamRepeat);
    scored.push(
      { ...seam, label: "dateline-eq" },
      { ...seamRepeat, label: "dateline-eq-repeat" },
    );

    const control = collectRepeatStructural({
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
    structural.push(...control.reasons);
    const fracDelta = Math.abs(seam.cloudFrac - seamRepeat.cloudFrac);
    if (!(fracDelta <= CONTROL.cloudFrac)) {
      structural.push(
        `CONTROL dateline-eq: cloudFrac ${seam.cloudFrac.toFixed(3)} vs ${seamRepeat.cloudFrac.toFixed(3)} differs by ${fracDelta.toFixed(4)} (tolerance ${CONTROL.cloudFrac})`,
      );
    }
    const s1 = stepStats(seam.cols);
    const s1r = stepStats(seamRepeat.cols);
    notes.push(
      `CONTROL D-eq: max per-column |delta| ${control.maxPerSample.toFixed(3)} (tol ${CONTROL.perSample}), ` +
        `mean delta ${control.meanDelta.toFixed(3)} (tol ${CONTROL.mean}), cloudFrac delta ${fracDelta.toFixed(4)}, ` +
        `centerMax ${s1.centerMax.toFixed(1)} vs ${s1r.centerMax.toFixed(1)}, ` +
        `time drift ${control.timeDrift.length === 0 ? "none" : control.timeDrift.length}`,
    );

    const cols = seam.cols;
    const mid = Math.floor(cols.length / 2);
    const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const left = meanOf(cols.slice(0, mid)),
      right = meanOf(cols.slice(mid));
    notes.push(
      `D-eq(0.7N): halves L ${left.toFixed(1)} R ${right.toFixed(1)} | centerMax ${s1.centerMax.toFixed(1)} p95 ${s1.p95.toFixed(1)} | cloudFrac ${seam.cloudFrac.toFixed(3)}`,
    );
    if (seam.cloudFrac < 0.05) {
      structural.push(
        `D-eq: cloud fraction ${seam.cloudFrac.toFixed(3)} too low to certify (twin map says both seam sides cloudy at 0.7N)`,
      );
    } else {
      const ratio = Math.max(left, right) / Math.max(1, Math.min(left, right));
      if (ratio > 3.0) {
        failures.push(
          `D-eq: hemisphere brightness wall across the meridian (L ${left.toFixed(1)} vs R ${right.toFixed(1)})`,
        );
      }
      if (s1.centerMax > Math.max(2.5 * s1.p95, 20)) {
        failures.push(
          `D-eq: center column step is an outlier (centerMax ${s1.centerMax.toFixed(1)} vs p95 ${s1.p95.toFixed(1)})`,
        );
      }
    }
  }

  // P1 — pole ring + center garbage check (89.995 keeps the camera regular;
  // the cap rows span 88.6..90 so the view still reads the constant cap).
  // The north lane is captured twice: the repeat is the determinism control on
  // the azimuthal sector means the ring statistic is derived from.
  for (const [lat, tagP] of [
    [89.995, "npole"],
    [-89.995, "spole"],
  ]) {
    const r = await captureView(0.0, lat, PIN.cameraHeight, tagP);
    save(r);
    scored.push({ ...r, label: tagP });

    if (tagP === "npole") {
      const repeat = await captureView(
        0.0,
        lat,
        PIN.cameraHeight,
        "npole-repeat",
      );
      save(repeat);
      scored.push({ ...repeat, label: "npole-repeat" });
      const control = collectRepeatStructural({
        label: "CONTROL npole sector means",
        a: r.ring.map((v, i) => ({ key: i, value: v, time: r.slots.time })),
        b: repeat.ring.map((v, i) => ({
          key: i,
          value: v,
          time: repeat.slots.time,
        })),
        perSample: CONTROL.perSample,
        mean: CONTROL.mean,
      });
      structural.push(...control.reasons);
      notes.push(
        `CONTROL npole: max per-sector |delta| ${control.maxPerSample.toFixed(3)} (tol ${CONTROL.perSample}), ` +
          `mean delta ${control.meanDelta.toFixed(3)} (tol ${CONTROL.mean}), ` +
          `time drift ${control.timeDrift.length === 0 ? "none" : control.timeDrift.length}`,
      );
    }

    if (r.cloudFrac < 0.03) {
      notes.push(
        `P-${tagP}: cloud fraction ${r.cloudFrac.toFixed(3)} — cap row may legitimately be clear here; ring variance check still valid on any nonzero signal`,
      );
    }
    const mean = r.ring.reduce((a, b) => a + b, 0) / r.ring.length;
    const maxDev = Math.max(...r.ring.map((v) => Math.abs(v - mean)));
    // Constant cap row -> small azimuthal deviation on the small ring. Allow
    // raymarch noise; a pre-fix pinwheel produced full-range spokes.
    if (mean > 15 && maxDev > Math.max(0.6 * mean, 40)) {
      failures.push(
        `P-${tagP}: azimuthal ring spread too high (mean ${mean.toFixed(1)}, maxDev ${maxDev.toFixed(1)}) — pinwheel suspected`,
      );
    }
    // NaN/garbage cluster at the exact pole: center block must not contain a
    // hot cluster wildly above the ring (the atan2(0,0) failure signature).
    const cMax = Math.max(...r.center);
    if (cMax > 3 * Math.max(mean, 20) && cMax > 200) {
      failures.push(
        `P-${tagP}: center block hot cluster (${cMax}) vs ring mean ${mean.toFixed(1)} — spin-axis guard suspect`,
      );
    }
    notes.push(
      `P-${tagP}: ring mean ${mean.toFixed(1)} maxDev ${maxDev.toFixed(1)} centerMax ${cMax} cloudFrac ${r.cloudFrac.toFixed(3)}`,
    );
  }

  // ── STRUCTURAL preconditions. A pin that did not take means the probe is not
  // measuring the configuration it documents, so it certifies nothing. Slot 107
  // is not checked: this probe never drives the G/B/A channel-strength dial.
  structural.push(
    ...collectPinStructural({
      pins: setup.pins,
      dials: setup.dials,
      captures: scored,
      globeReadiness: { setup: setup.readiness.globeReady },
      expectedChannelStrength: undefined,
    }),
  );
  if (setup.pins.rendererType !== "webgpu") {
    // A silent WebGL fallback HARD-FAILS: volumetric clouds are WebGPU-only, so
    // scoring a WebGL frame as a WebGPU pass is a false green, not a blind leg.
    failures.push(
      `WEBGPU-BACKEND: resolved ${setup.pins.rendererType}, expected webgpu`,
    );
  }

  if (errs.length > 0) {
    failures.push(`WEBGPU console errors (${errs.length}): ${errs[0]}`);
  }
  await page.close();
} catch (error) {
  // Recorded rather than exited here, so the single `finally` still closes the
  // browser: `process.exit()` inside a catch skips it.
  fatal = error;
} finally {
  await browser.close();
}

if (fatal) {
  console.error(`STRUCTURAL: ${fatal?.stack ?? fatal}`);
  process.exit(2);
}

console.log("=== probe-weather-seam-poles ===");
for (const n of notes) {
  console.log("  " + n);
}
if (structural.length > 0) {
  console.log("STRUCTURAL");
  for (const s of structural) {
    console.log("  STRUCTURAL: " + s);
  }
  if (failures.length > 0) {
    console.log("  (gate failures printed for diagnosis only:)");
    for (const f of failures) {
      console.log("  FAIL: " + f);
    }
  }
  console.log(
    "RESULT: STRUCTURAL — acceptance INCOMPLETE. This probe certifies nothing in this state.",
  );
  process.exit(3);
}
if (failures.length > 0) {
  console.log("FAIL");
  for (const f of failures) {
    console.log("  FAIL: " + f);
  }
  process.exit(1);
}
console.log("PASS");
