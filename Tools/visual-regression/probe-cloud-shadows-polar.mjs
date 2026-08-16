#!/usr/bin/env node
/**
 * Probe: C13-06 — cloud cast shadows at high latitude (pixel gate).
 * @purpose C13-06 pixel gate: cloud cast shadows must darken the ground band at 82N; fully pinned (P1-P8+P10) with bracketing control legs.
 * @status ACTIVE
 *
 * PINNED for determinism under `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`.
 *
 * Pre-fix the shadow pass marched empty space (spherical footprint 21 km off at
 * the pole) so the cast shadow silently vanished at high latitude; post-fix an
 * ON/OFF pair must differ on the ground band.
 *
 *   S1 SHADOW   82N, oblique view, midsummer low sun. `cloudCastShadows` ON
 *      must DARKEN the ground band relative to OFF: `off.mean - on.mean > 0.5`.
 *   S2 CONTROL  the ON leg is captured TWICE, BRACKETING the OFF leg, and the
 *      two must agree inside `CONTROL.mean`. That bounds every drift over the
 *      interval the scored difference is taken across.
 *   NV          globe readiness (binned `Pass.GLOBE` commands) and procedural-
 *      cloud readiness (`executeCalls > 0`) are both read back and enforced.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PROBE WAS PINNED
 * ─────────────────────────────────────────────────────────────────────────────
 * The pre-pinning revision scored an ABSOLUTE ground-band brightness difference
 * between two captures taken seconds apart, with three uncontrolled inputs all
 * free to move over that interval and the OFF leg always captured LAST:
 *
 *   STILL OPEN (until now) — a NETWORK globe. It loaded `?renderer=webgpu` with
 *   no `offline` flag, so `CesiumViewerStartupOptions.js` supplied Cesium World
 *   Terrain and the Ion world-imagery base layer. The scored region is "the
 *   lower 40% of the frame (terrain under the deck)", i.e. exactly where those
 *   tiles land. Residual tiles arriving between the ON and OFF captures change
 *   the band mean by an unbounded, unmodelled amount in either direction.
 *
 *   STILL OPEN — the wall clock, via the render driver. It pinned
 *   `viewer.clock.currentTime` but every settle frame was `s.render()` with NO
 *   argument, which `Scene.js` fills with `JulianDate.now()`; and
 *   `requestRenderMode: true` did not save it, because the pinned 2026-06-21
 *   date and `JulianDate.now()` differ by ~46 days, far beyond
 *   `maximumRenderTimeChange = 0`, so every frame re-rendered at the wall clock.
 *
 *   STILL OPEN — an advecting field. `cloudWindSpeed` sat at its 15.0 m/s
 *   default and `cloud.time` reaches the density field exactly as
 *   `windDirection * windSpeed * time`, so the deck translated across the frame
 *   throughout both captures.
 *
 *   STILL OPEN — the tier path. `cloudQuality` sat at its 64 default, so the
 *   march ran with temporal accumulation, jitter and half-res — all three
 *   frame-index inputs, and temporal accumulation in particular low-passes the
 *   very brightness the gate reads.
 *
 * The pins are P1-P8 + P10 as documented in `lib/weather-probe-pinning.mjs`;
 * `probe-weather-channels.mjs` is the reference implementation. `cloudCastShadows`
 * is this probe's SUBJECT, so it is declared via `subjectDials` and asserted
 * per leg here instead of being pinned false by the shared dials.
 *
 * WHAT PINNING CHANGES ABOUT THE NUMBERS. Removing imagery, stopping the wind,
 * escaping the tier path and fixing the render clock all move the ABSOLUTE band
 * means. **The recorded pre-pinning landing figure (ON 23.6 / OFF 60.8, delta
 * 37.2) is NOT a baseline for this revision and must not be compared against.**
 * The scored quantity is a difference between two legs of one pinned
 * configuration, so the comparison survives; the absolute level does not.
 *
 * WHAT IS SCORED — the threshold is UNCHANGED from the pre-pinning probe.
 * Nothing was widened, lowered or dropped; the additions are STRUCTURAL tiers.
 *   S1  `off.mean - on.mean > 0.5` and 0 console errors
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-shadows-polar.mjs
 * Exit:
 *   0 PASS | 1 a real product FAIL | 2 watchdog or exception
 *   3 STRUCTURAL — a pin did not take, the globe or the cloud renderer was not
 *     ready, or the probe could not reproduce its own capture (INCOMPLETE)
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

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/cloud-shadows";
fs.mkdirSync(OUT, { recursive: true });

const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-cloud-shadows-polar] watchdog fired after ${WATCHDOG_MS} ms`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

const PIN = {
  // 82N, oblique view, midsummer low sun (always up at 82N in June).
  lon: 15.0,
  lat: 82.0,
  height: 12000.0,
  headingDeg: 30.0,
  pitchDeg: -35.0,
  isoDate: "2026-06-21T12:00:00Z",
  warmupDiscards: 4,
  viewSettleMs: 2000,
  readyMinSettleMs: 3000,
  readyBudgetMs: 90_000,
  readyMaxFrames: 120,
};

/**
 * Determinism-control tolerance, one fifth of the 0.5 scored bar. The scored
 * quantity is a single band mean, so a per-leg reproduction error of 0.1 can
 * move the difference by at most 0.1 — five times smaller than the bar it would
 * have to cross to flip the verdict.
 */
const CONTROL = { perSample: 0.1, mean: 0.1 };

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

  // ── P1/P2/P8. The scored band is terrain, so streamed imagery would BE the
  // signal; a dark uniform base colour leaves the cast shadow as the only thing
  // that can darken it.
  const pins = pin.pinScene(C, {
    darkGlobe: true,
    groundAtmosphere: false,
    fog: false,
    sky: false,
  });

  // ── Cloud dials. Coverage/density/layer are the AUTHORED scene under test and
  // are unchanged from the pre-pinning probe; the determinism dials (P3/P4) come
  // from the shared module. `cloudCastShadows` is the SUBJECT and is driven per
  // leg below, so the spread value here is only the starting state.
  const configured = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: {
      cloudCoverage: 0.7,
      cloudDensity: 1.0,
      cloudLayerBottom: 1200,
      cloudLayerTop: 3500,
      ...cfg.determinismDials,
    },
  });

  const readyTime = C.JulianDate.fromIso8601(cfg.isoDate);
  window.viewer.scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.lon, cfg.lat, cfg.height),
    orientation: {
      heading: C.Math.toRadians(cfg.headingDeg),
      pitch: C.Math.toRadians(cfg.pitchDeg),
      roll: 0.0,
    },
  });
  const globeReady = await pin.awaitGlobeReady(
    C,
    readyTime,
    cfg.readyMinSettleMs,
    cfg.readyBudgetMs,
  );
  // Throws unless the procedural renderer initialized, built its pipeline AND
  // executed — the cloud-side non-vacuity gate.
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
 * One capture leg. Drives the SUBJECT dial, reads it back, settles on a
 * wall-clock budget, then renders and reads pixels fused in ONE task. The
 * ground-band reducer is UNCHANGED from the pre-pinning probe.
 */
const CAPTURE_LANE = async (cfg) => {
  const C = window.Cesium;
  const pin = globalThis.__weatherPin;
  const scene = window.viewer.scene;
  const volumetric = scene.globe.defaultCloudCollection.volumetric;

  volumetric.cloudCastShadows = cfg.castOn;
  const castShadowsReadBack = volumetric.cloudCastShadows;

  const julianDate = C.JulianDate.fromIso8601(cfg.isoDate);
  // DISCARDED warm-up renders after the dial change (the shadow pass rebuilds).
  for (let i = 0; i < cfg.warmupDiscards; i++) {
    pin.renderAt(julianDate);
  }
  // ── P7: WALL-CLOCK settle, then a same-task render + read.
  const settledFrames = await pin.settle(julianDate, cfg.viewSettleMs);
  const frame = pin.capture(julianDate, true);
  const { data, width: w, height: h } = frame;

  // Ground band: lower 40% of frame (terrain under the deck at this pitch).
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(h * 0.6); y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      n++;
    }
  }

  return {
    tag: cfg.tag,
    castOn: cfg.castOn,
    castShadowsReadBack,
    settledFrames,
    mean: n ? sum / n : 0,
    samples: n,
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
    `READY: globe binned=${setup.readiness.globeReady.binnedGlobeCommands} firstMs=${setup.readiness.globeReady.firstBinnedMs} ` +
      `elapsedMs=${setup.readiness.globeReady.elapsedMs} procedural frames=${setup.readiness.proceduralReady.waitedFrames} ` +
      `executeCalls=${setup.readiness.proceduralReady.executeCalls}`,
  );

  const shot = (castOn, tag) =>
    page.evaluate(CAPTURE_LANE, {
      castOn,
      tag,
      isoDate: PIN.isoDate,
      warmupDiscards: PIN.warmupDiscards,
      viewSettleMs: PIN.viewSettleMs,
    });

  const save = (r) =>
    fs.writeFileSync(
      `${OUT}/${r.tag}.png`,
      Buffer.from(r.png.split(",")[1], "base64"),
    );

  // BRACKETED order: onA -> off -> onB. The scored pair is still (onA, off) at
  // the unchanged 0.5 bar; onB bounds every drift across the interval that pair
  // spans, which is the property the unbracketed "warmup, on, off" order lacked.
  await shot(true, "warmup"); // discarded (async prewarm)
  const onA = await shot(true, "polar-shadows-on");
  const off = await shot(false, "polar-shadows-off");
  const onB = await shot(true, "polar-shadows-on-repeat");
  for (const r of [onA, off, onB]) {
    save(r);
  }
  const scored = [
    { ...onA, label: "polar-shadows-on" },
    { ...off, label: "polar-shadows-off" },
    { ...onB, label: "polar-shadows-on-repeat" },
  ];

  // ── The SUBJECT dial must have taken on every leg; a leg that silently kept
  // the previous value makes the difference an A/A comparison.
  for (const r of scored) {
    if (r.castShadowsReadBack !== r.castOn) {
      structural.push(
        `${r.label}: cloudCastShadows round trip failed (requested ${r.castOn}, read ${r.castShadowsReadBack}) — the scored legs are not the two configurations they are labelled`,
      );
    }
  }

  const control = collectRepeatStructural({
    label: "CONTROL polar-shadows-on bracket",
    a: [{ key: "band", value: onA.mean, time: onA.slots.time }],
    b: [{ key: "band", value: onB.mean, time: onB.slots.time }],
    perSample: CONTROL.perSample,
    mean: CONTROL.mean,
  });
  structural.push(...control.reasons);
  notes.push(
    `CONTROL bracket: onA ${onA.mean.toFixed(3)} vs onB ${onB.mean.toFixed(3)} ` +
      `delta ${control.maxPerSample.toFixed(4)} (tol ${CONTROL.perSample}), ` +
      `time drift ${control.timeDrift.length === 0 ? "none" : control.timeDrift.length}`,
  );

  const delta = off.mean - onA.mean;
  notes.push(
    `S1 polar 82N ground band: shadowsON mean ${onA.mean.toFixed(2)} shadowsOFF mean ${off.mean.toFixed(2)} ` +
      `delta ${delta.toFixed(2)} (need > 0.5) over ${onA.samples} samples`,
  );

  // ── STRUCTURAL preconditions. A pin that did not take, or a globe that never
  // rendered, means the probe is not measuring the configuration it documents.
  // Slot 64/107 are not checked: this probe drives no weather map or channel.
  structural.push(
    ...collectPinStructural({
      pins: setup.pins,
      dials: setup.dials,
      captures: scored,
      globeReadiness: { setup: setup.readiness.globeReady },
      subjectDials: ["cloudCastShadows"],
      requireWeatherMap: false,
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

  // ON must darken the ground: pre-fix the pass marched empty space, delta ~ 0.
  if (!(delta > 0.5)) {
    failures.push(
      `S1: no measurable polar cast shadow (delta ${delta.toFixed(2)} <= 0.5)`,
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

clearTimeout(watchdog);

if (fatal) {
  console.error(`STRUCTURAL: ${fatal?.stack ?? fatal}`);
  process.exit(2);
}

console.log("=== probe-cloud-shadows-polar ===");
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
console.log("PASS — cast shadows present at 82N");
