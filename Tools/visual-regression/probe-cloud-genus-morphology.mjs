#!/usr/bin/env node
/**
 * C13-16 per-genus cloud MORPHOLOGY slice — browser acceptance probe.
 *
 * `cloud-genus-morphology.spec.mjs` (21/21) proves the coordinate transform and
 * the identity guards on the CPU. It cannot prove the GPU samples the new
 * uniform row, that the pipeline compiles the added functions, or that a viewer
 * READS cirrus as ice. This probe is that half, following the orchestrator
 * checklist in QUEUE_2026-07-23_CAMPAIGN13.md.
 *
 * WHAT IS SCORED (checklist items 1, 2, 3, 5, 9)
 * ----------------------------------------------
 *   A UNIFORMS   The three early returns are provably TAKEN at the default
 *                genus, read off the SHIPPED artifacts: the live
 *                `Scene/CloudTypeProfile.js` table must hand CUMULUS exactly
 *                `(strength 0, anisotropy 1, shear 0)` and phase delta exactly
 *                0, and the renderer's own packed uniform row — slots 168..171
 *                of `context._cloudCache.uniformData`, the array
 *                `WebGPUProceduralCloudRenderer` writes — must read exactly
 *                `[0, 1, 0, 0]`. Exact equality, no tolerance. This is the
 *                in-build, decidable half of item 1.
 *   B NEUTRAL    Item 1's pixel half. The DEFAULT (no `cloudType`, i.e.
 *                CUMULUS) cloud-bearing view must be EXACTLY 0 changed pixels
 *                against a baseline recorded on a PRE-change build — not a
 *                small diff. The design rests on three explicit early returns;
 *                a nonzero diff is a more important finding than the feature.
 *                Record with `--update-baseline` on the pre-change build.
 *   C DIRECTION  Item 2. Cirrus-vs-cumulus by DIRECTION, never brightness: the
 *                ratio of luminance autocorrelation half-length ALONG the
 *                projected wind azimuth to the half-length ACROSS it, measured
 *                on the cloud CONTRIBUTION field (clouds-on minus clouds-off at
 *                the same camera and clock). A band mean or a whole-frame mean
 *                is explicitly NOT acceptable evidence here — that is the trap
 *                this campaign recorded — and neither is a mean difference,
 *                which says nothing about shape.
 *   D WIND       Item 3. Re-run cirrus with the wind rotated 90 degrees and
 *                require the MEASURED elongation axis to rotate with it. An
 *                azimuth scan reports the argmax direction, so a fixed diagonal
 *                texture artifact (which would also look anisotropic) is
 *                separated from a genuinely wind-aligned domain.
 *   E GRAIN      Item 5. cirrus > cirrostratus > cirrocumulus, matching the
 *                spec's measured 8.10 / 4.65 / 1.95 aspect ordering.
 *   F CLEAN      Item 9. `rendererType === "webgpu"` on every lane, zero new
 *                device/console errors, canvas-element PNGs captured same-task,
 *                per-view local-noon clock, and a DISCARDED warm-up render
 *                before the evidence loop (the async prewarm cold start renders
 *                the first fixture stable-black).
 *
 * NOT SCORED HERE. Items 4 (fallstreak tilt) and 8 (near-sun phase sanity) are
 * explicitly human-verdict checks — "read the PNGs; a scalar cannot settle this
 * one" — so this probe CAPTURES those two views and names them in the log, but
 * does not invent a scalar for them. Items 6 (`probe-cloud-tour.mjs`
 * `northatlantic-cirrus-fibratus` floor) and 7 (`probe-cloud-shadows-flagon.mjs`)
 * are other probes' vehicles and are run separately.
 *
 * ITEM 10 — NO TIMING LANE. `C13-39` closed NEGATIVE on the finding that WGSL
 * register allocation is STATIC and this pass is occupancy-bound. A timing
 * measurement would require the mandatory interleaved-A/B protocol; this probe
 * measures no time and therefore claims nothing about it.
 *
 * BLIND LEGS report STRUCTURAL, never PASS and never FAIL. If a genus renders
 * too few contribution pixels to autocorrelate, or the projected wind azimuth is
 * degenerate on screen, or the correlation never decorrelates within the sample
 * window, the leg says so. Scoring a blind leg FAIL files a phantom defect;
 * scoring it PASS is a false green.
 *
 * GEOMETRY NOTE (why the camera sits where it does). The wind vector maps to
 * world as `vec3(windDirection.x, 0, windDirection.y)` — ECEF +X and +Z. At
 * lon 90 / lat 0 the local up is ECEF +Y, so BOTH candidate wind axes are
 * tangent to the surface and a nadir camera sees both in full, un-foreshortened
 * projection. Anywhere else, one of them would point partly into the sky and
 * the 90-degree rotation test would compare two differently-conditioned axes.
 *
 * Usage:
 *   node Tools/visual-regression/probe-cloud-genus-morphology.mjs
 *   node Tools/visual-regression/probe-cloud-genus-morphology.mjs --update-baseline
 * Exit: 0 every gate decided and passed | 1 a real product FAIL |
 *       2 watchdog or exception | 3 no FAIL but a gate had no subject to
 *         measure (acceptance INCOMPLETE, not green)
 * Env:  PROBE_BASE (default http://localhost:8080)
 * Out:  Tools/visual-regression/output/cloud-genus-morphology/*.png + manifest.json
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/cloud-genus-morphology";
const VIEW = { width: 1024, height: 768 };
const UPDATE_BASELINE =
  process.argv.includes("--update-baseline") ||
  process.env.PROBE_UPDATE_BASELINE === "1";

const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(`STRUCTURAL: probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

/**
 * Predictions. The authored `FIBRE_MORPHOLOGY` aspects are 9 / 5 / 2 and the
 * CPU twin recovered 8.10 / 4.65 / 1.95 from the noise field itself. A SCREEN
 * measurement is strictly weaker than the noise-space one — the raymarch
 * integrates along the view ray, the deck has finite thickness, and the
 * resampled canvas is band-limited — so the pixel gate asserts the ORDERING and
 * a conservative floor rather than the authored ratio.
 */
const PREDICT = {
  cirrusElongationMin: 1.6,
  cumulusElongationMax: 1.35,
  cirrusOverCumulusMin: 1.4,
  // A 90-degree wind rotation must move the measured argmax axis by ~90.
  windRotationDeg: 90,
  windRotationToleranceDeg: 30,
  // Grain ordering, item 5.
  grainOrder: ["CIRRUS", "CIRROSTRATUS", "CIRROCUMULUS"],
  grainStrictMargin: 1.1,
  // Instrument floors — below these a leg is blind, not failing.
  minContributionPixels: 6000,
  minAcceptedLines: 6,
  maxSaturatedFraction: 0.5,
  minWindScreenPixels: 8,
  // Slots the renderer writes for this slice.
  uniformSlots: [168, 169, 170, 171],
  uniformIdentity: [0, 1, 0, 0],
};

const RUN_LANE = async ({ predict, view }) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const rendererType = String(scene.context?.rendererType ?? "").toLowerCase();

  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;

  for (const selector of [
    ".cesium-viewer-timelineContainer",
    ".cesium-viewer-animationContainer",
    ".cesium-viewer-bottom",
    ".cesium-viewer-toolbar",
    ".cesium-viewer-fullscreenContainer",
    ".cesium-viewer-navigationContainer",
    ".cesium-navigation-help",
    ".cesium-renderer-toggle",
  ]) {
    const element = document.querySelector(selector);
    if (element) element.style.display = "none";
  }

  // ── Site: lon 90 / lat 0, where both wind axes are surface-tangent.
  const SITE_LON = 90.0;
  const SITE_LAT = 0.0;
  const CAMERA_HEIGHT = 250_000.0;
  // LOCAL NOON, the recorded C13-07 lesson: a fixed UTC clock puts most sites
  // in the dark and the contribution field collapses to noise. Every view in
  // this probe sits at SITE_LON, so one local-noon instant serves all of them
  // AND pins the clock — a per-view clock here would vary the illumination
  // between the lanes that gate C and E compare against each other.
  const localNoon = (longitudeDegrees) =>
    C.JulianDate.fromDate(
      new Date(
        Date.UTC(2026, 5, 1, 12, 0, 0) -
          (longitudeDegrees / 15.0) * 60 * 60 * 1000,
      ),
    );
  const frameTime = localNoon(SITE_LON);
  viewer.clock.currentTime = frameTime;

  scene.globe.show = true;
  scene.globe.imageryLayers.removeAll();
  scene.globe.baseColor = C.Color.fromBytes(18, 22, 32);
  scene.globe.showGroundAtmosphere = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.fog) scene.fog.enabled = false;
  scene.backgroundColor = C.Color.BLACK;

  const nadirView = () =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(SITE_LON, SITE_LAT, CAMERA_HEIGHT),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
    });

  // ── Same-task capture.
  const scratch = document.createElement("canvas");
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
  const renderNow = () => scene.render(frameTime);
  const captureNow = () => {
    renderNow();
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    scratchContext.drawImage(canvas, 0, 0);
    return {
      image: scratchContext.getImageData(0, 0, canvas.width, canvas.height),
      png: canvas.toDataURL("image/png"),
    };
  };
  // WALL CLOCK, not frames: a cold pipeline variant has measured ~2674 ms to
  // compile and a frame budget silently under-runs it.
  const settleMs = async (milliseconds) => {
    const deadline = performance.now() + milliseconds;
    let frames = 0;
    while (performance.now() < deadline) {
      renderNow();
      frames++;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return frames;
  };

  if (!C.Pass || !Number.isInteger(C.Pass.GLOBE)) {
    throw new Error("Pass.GLOBE is not exported; readiness cannot be binned");
  }
  const binnedGlobeCommands = () => {
    const frustums = scene._view?.frustumCommandsList ?? [];
    let total = 0;
    for (const frustum of frustums) {
      total += frustum?.indices ? frustum.indices[C.Pass.GLOBE] | 0 : 0;
    }
    return total;
  };
  const awaitGlobeReady = async (minimumSettleMs, budgetMs) => {
    const start = performance.now();
    let binned = 0;
    let firstBinnedMs = null;
    while (performance.now() - start < budgetMs) {
      renderNow();
      binned = binnedGlobeCommands();
      if (binned > 0 && firstBinnedMs === null) {
        firstBinnedMs = performance.now() - start;
      }
      if (
        firstBinnedMs !== null &&
        performance.now() - start >= minimumSettleMs
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return {
      binnedGlobeCommands: binned,
      firstBinnedMs,
      elapsedMs: performance.now() - start,
    };
  };

  // ── Structural measurement: directional autocorrelation half-length on the
  // cloud CONTRIBUTION field. Mirrors the CPU twin's estimator exactly (r < 0.5
  // with linear interpolation between bracketing lags), so the two numbers are
  // comparable rather than merely both "some correlation statistic".
  const contributionField = (onImage, offImage) => {
    const { width, height } = onImage;
    const on = onImage.data;
    const off = offImage.data;
    const field = new Float32Array(width * height);
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const lumOn = 0.299 * on[i] + 0.587 * on[i + 1] + 0.114 * on[i + 2];
        const lumOff = 0.299 * off[i] + 0.587 * off[i + 1] + 0.114 * off[i + 2];
        const delta = lumOn - lumOff;
        const value = delta > 0 ? delta : 0;
        field[y * width + x] = value;
        if (value > 8) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      field,
      width,
      height,
      count,
      bbox: maxX < 0 ? null : [minX, minY, maxX, maxY],
    };
  };

  const halfLength = (samples, maxLag) => {
    const n = samples.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (samples[i] - mean) ** 2;
    variance /= n;
    if (variance <= 1e-9) {
      // A flat line has no structure to measure; report saturation so a
      // degenerate field can never masquerade as a short correlation length.
      return { length: maxLag, saturated: true };
    }
    let previous = 1;
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < n; i++) {
        sum += (samples[i] - mean) * (samples[i + lag] - mean);
      }
      const r = sum / ((n - lag) * variance);
      if (r < 0.5) {
        const t = (previous - 0.5) / Math.max(previous - r, 1e-9);
        return { length: lag - 1 + t, saturated: false };
      }
      previous = r;
    }
    return { length: maxLag, saturated: true };
  };

  /**
   * Mean correlation half-length of the contribution field along a screen
   * direction, sampled on parallel lines through the cloud region.
   */
  const directionalLength = (contribution, directionDeg) => {
    const { field, width, height, bbox } = contribution;
    if (!bbox) {
      return { resolved: false, why: "no contribution pixels" };
    }
    const centerX = (bbox[0] + bbox[2]) / 2;
    const centerY = (bbox[1] + bbox[3]) / 2;
    const halfExtent =
      Math.min(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.5 * 0.8;
    if (halfExtent < 40) {
      return {
        resolved: false,
        why: `cloud region half-extent ${halfExtent.toFixed(1)} px is too small to sample`,
      };
    }
    const radians = (directionDeg * Math.PI) / 180;
    const ux = Math.cos(radians);
    const uy = Math.sin(radians);
    const px = -uy;
    const py = ux;
    const sampleCount = Math.min(256, Math.floor(halfExtent * 2));
    const maxLag = Math.max(8, Math.floor(sampleCount / 3));
    const lineCount = 16;
    const sampleAt = (x, y) => {
      if (x < 0 || y < 0 || x > width - 2 || y > height - 2) return null;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const a = field[y0 * width + x0];
      const b = field[y0 * width + x0 + 1];
      const c = field[(y0 + 1) * width + x0];
      const d = field[(y0 + 1) * width + x0 + 1];
      return (
        a * (1 - fx) * (1 - fy) +
        b * fx * (1 - fy) +
        c * (1 - fx) * fy +
        d * fx * fy
      );
    };
    let total = 0;
    let accepted = 0;
    let saturated = 0;
    for (let line = 0; line < lineCount; line++) {
      const offset = (line / (lineCount - 1) - 0.5) * 2 * halfExtent * 0.85;
      const startX = centerX + px * offset - (ux * sampleCount) / 2;
      const startY = centerY + py * offset - (uy * sampleCount) / 2;
      const samples = new Float64Array(sampleCount);
      let inside = 0;
      let bad = false;
      for (let i = 0; i < sampleCount; i++) {
        const value = sampleAt(startX + ux * i, startY + uy * i);
        if (value === null) {
          bad = true;
          break;
        }
        samples[i] = value;
        if (value > 8) inside++;
      }
      // A line that mostly misses the deck measures the empty background, not
      // the cloud, so it is discarded rather than averaged in.
      if (bad || inside / sampleCount < 0.35) continue;
      const measured = halfLength(samples, maxLag);
      total += measured.length;
      accepted++;
      if (measured.saturated) saturated++;
    }
    if (accepted === 0) {
      return { resolved: false, why: "no sample line stayed inside the deck" };
    }
    return {
      resolved: true,
      length: total / accepted,
      accepted,
      saturated,
      lineCount,
      sampleCount,
      maxLag,
    };
  };

  /**
   * Elongation about a given screen axis, plus a full azimuth scan whose argmax
   * is the MEASURED elongation direction. The scan is what separates a genuine
   * wind-aligned domain from a fixed diagonal artifact: an artifact's argmax
   * does not move when the wind does.
   */
  const anisotropy = (contribution, alongDeg) => {
    const along = directionalLength(contribution, alongDeg);
    const across = directionalLength(contribution, alongDeg + 90);
    const scan = [];
    for (let deg = 0; deg < 180; deg += 15) {
      const measured = directionalLength(contribution, deg);
      scan.push({
        deg,
        length: measured.resolved ? measured.length : null,
        accepted: measured.accepted ?? 0,
        saturated: measured.saturated ?? 0,
      });
    }
    const usable = scan.filter((entry) => entry.length !== null);
    let argmaxDeg = null;
    if (usable.length > 0) {
      argmaxDeg = usable.reduce((best, entry) =>
        entry.length > best.length ? entry : best,
      ).deg;
    }
    if (!along.resolved || !across.resolved) {
      return {
        resolved: false,
        why: `along: ${along.why ?? "ok"}; across: ${across.why ?? "ok"}`,
        scan,
        argmaxDeg,
      };
    }
    const saturatedFraction =
      (along.saturated + across.saturated) /
      Math.max(along.accepted + across.accepted, 1);
    return {
      resolved: true,
      alongDeg,
      alongLength: along.length,
      acrossLength: across.length,
      elongation: along.length / Math.max(across.length, 1e-6),
      acceptedLines: Math.min(along.accepted, across.accepted),
      saturatedFraction,
      argmaxDeg,
      scan,
    };
  };

  // ── Projected wind azimuth. The wind maps to world as vec3(x, 0, y); its
  // component along the local surface normal is removed before projecting, so
  // what is measured on screen is the horizontal advection direction the deck
  // actually streaks along.
  const projectedWindAzimuthDeg = (windX, windY) => {
    const center = C.Cartesian3.fromDegrees(SITE_LON, SITE_LAT, 0.0);
    const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(
      center,
      new C.Cartesian3(),
    );
    const world = new C.Cartesian3(windX, 0.0, windY);
    C.Cartesian3.normalize(world, world);
    const alongUp = C.Cartesian3.dot(world, up);
    const tangent = C.Cartesian3.subtract(
      world,
      C.Cartesian3.multiplyByScalar(up, alongUp, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const tangentLength = C.Cartesian3.magnitude(tangent);
    if (tangentLength < 1e-6) {
      return {
        resolved: false,
        why: "wind vector is normal to the surface here",
      };
    }
    C.Cartesian3.normalize(tangent, tangent);
    const tip = C.Cartesian3.add(
      center,
      C.Cartesian3.multiplyByScalar(tangent, 60_000.0, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const a = C.SceneTransforms.worldToWindowCoordinates(scene, center);
    const b = C.SceneTransforms.worldToWindowCoordinates(scene, tip);
    if (!a || !b) {
      return { resolved: false, why: "wind endpoints did not project" };
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const screenLength = Math.hypot(dx, dy);
    if (screenLength < predict.minWindScreenPixels) {
      return {
        resolved: false,
        why: `projected wind spans only ${screenLength.toFixed(2)} screen px (floor ${predict.minWindScreenPixels}) — the azimuth is degenerate at this camera`,
        screenLength,
      };
    }
    // Screen y grows downward; the azimuth is taken modulo 180 because a
    // correlation axis is undirected. `worldToWindowCoordinates` returns CSS
    // pixels while the ImageData is in drawing-buffer pixels, but the two
    // differ by a UNIFORM scale, so the ANGLE this returns is the same in
    // both spaces — which is all the autocorrelation direction needs.
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    deg = ((deg % 180) + 180) % 180;
    return { resolved: true, deg, screenLength, screenDelta: [dx, dy] };
  };

  // ── Shared cloud configuration. Coverage stays above the documented
  // CLOUD-LOW-COVERAGE-CUTOFF (<= 0.40 renders zero cloud) and wind SPEED is 0
  // while wind DIRECTION stays non-zero: the fibre frame reads the direction
  // regardless of speed, and a zero speed removes per-frame advection drift so
  // repeated captures of the same view are byte-comparable.
  const baseVolumetric = {
    cloudCoverage: 0.8,
    cloudDensity: 0.5,
    cloudQuality: 96,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudCastShadows: false,
    cloudContributesIBL: false,
    weatherProvider: undefined,
  };

  const collection = scene.globe.defaultCloudCollection;
  const configure = (overrides) =>
    globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: { ...baseVolumetric, ...overrides },
    });

  const readGenusUniformRow = () => {
    const data = scene.context?._cloudCache?.uniformData;
    if (!data) return null;
    return predict.uniformSlots.map((slot) => data[slot]);
  };

  nadirView();
  const readiness = await awaitGlobeReady(3000, 90_000);
  const proceduralReady = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime,
    maxFrames: 240,
  });
  nadirView();

  // ── Leg A: the shipped table + the shipped uniform row at the DEFAULT genus.
  const CloudTypeProfile = (
    await import("/packages/engine/Source/Scene/CloudTypeProfile.js")
  ).default;
  const CloudType = (await import("/packages/engine/Source/Scene/CloudType.js"))
    .default;
  const cumulusRow = CloudTypeProfile.getFibreMorphology(CloudType.CUMULUS);
  const cirrusRow = CloudTypeProfile.getFibreMorphology(CloudType.CIRRUS);
  // The CIRRUS phase offset is the NON-IDENTITY control for slot 171. Reading
  // the cumulus-minus-cumulus difference would be a tautology and would prove
  // nothing; what matters is that the quantity the renderer packs is nonzero
  // for a genus that should offset the lobe, while slot 171 still reads exactly
  // 0 at the default.
  const cirrusPhaseDelta =
    CloudTypeProfile.get(CloudType.CIRRUS).phaseG -
    CloudTypeProfile.get(CloudType.CUMULUS).phaseG;

  configure({ cloudType: undefined });
  // DISCARDED warm-up: the async prewarm cold start renders the first fixture
  // stable-black, so this capture is thrown away on purpose.
  await settleMs(3000);
  captureNow();

  await settleMs(1500);
  const defaultUniformRow = readGenusUniformRow();
  const defaultA = captureNow();
  await settleMs(1200);
  const defaultB = captureNow();
  const defaultRepeatChanged = (() => {
    const a = defaultA.image.data;
    const b = defaultB.image.data;
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (
        a[i] !== b[i] ||
        a[i + 1] !== b[i + 1] ||
        a[i + 2] !== b[i + 2] ||
        a[i + 3] !== b[i + 3]
      ) {
        changed++;
      }
    }
    return changed;
  })();
  const hashPixels = (data) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      hash ^= data[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };

  // ── Clouds-OFF reference at the identical camera/clock, the subtrahend of
  // every contribution field below.
  collection.enableVolumetric = false;
  await settleMs(2000);
  const cloudsOff = captureNow();
  collection.enableVolumetric = true;

  const WIND_A = { x: 1.0, y: 0.0 };
  const WIND_B = { x: 0.0, y: 1.0 };
  const windA = projectedWindAzimuthDeg(WIND_A.x, WIND_A.y);
  const windB = projectedWindAzimuthDeg(WIND_B.x, WIND_B.y);

  const genusLane = async (label, cloudType, wind, azimuth) => {
    configure({ cloudType, cloudWindDirection: { ...wind } });
    await settleMs(2500);
    const shot = captureNow();
    const contribution = contributionField(shot.image, cloudsOff.image);
    const uniformRow = readGenusUniformRow();
    const measured = azimuth.resolved
      ? anisotropy(contribution, azimuth.deg)
      : { resolved: false, why: azimuth.why };
    return {
      label,
      cloudType,
      wind,
      windAzimuthDeg: azimuth.resolved ? azimuth.deg : null,
      windScreenLength: azimuth.screenLength ?? null,
      uniformRow,
      contributionPixels: contribution.count,
      contributionBbox: contribution.bbox,
      anisotropy: measured,
      png: shot.png,
    };
  };

  const lanes = {};
  lanes.cumulus = await genusLane("CUMULUS", CloudType.CUMULUS, WIND_A, windA);
  lanes.cirrus = await genusLane("CIRRUS", CloudType.CIRRUS, WIND_A, windA);
  lanes.cirrusRotated = await genusLane(
    "CIRRUS+wind90",
    CloudType.CIRRUS,
    WIND_B,
    windB,
  );
  lanes.cirrostratus = await genusLane(
    "CIRROSTRATUS",
    CloudType.CIRROSTRATUS,
    WIND_A,
    windA,
  );
  lanes.cirrocumulus = await genusLane(
    "CIRROCUMULUS",
    CloudType.CIRROCUMULUS,
    WIND_A,
    windA,
  );

  // ── Human-verdict captures. Items 4 and 8 are explicitly "read the PNGs";
  // no scalar is invented for them.
  configure({ cloudType: CloudType.CIRRUS, cloudWindDirection: { ...WIND_A } });
  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(SITE_LON, SITE_LAT - 2.2, 9_000.0),
    orientation: { heading: 0, pitch: C.Math.toRadians(-2), roll: 0 },
  });
  await settleMs(2500);
  const fallstreakPng = captureNow().png;

  // Near-sun view for the phase check: local noon puts the sun near the zenith,
  // so a steeply-up-tilted camera looks through the forward lobe.
  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(SITE_LON, SITE_LAT - 0.5, 6_000.0),
    orientation: { heading: 0, pitch: C.Math.toRadians(55), roll: 0 },
  });
  await settleMs(2500);
  const nearSunPng = captureNow().png;

  const pngs = {
    "default-cumulus": defaultA.png,
    "clouds-off": cloudsOff.png,
    "item4-fallstreak-tilt": fallstreakPng,
    "item8-near-sun-phase": nearSunPng,
  };
  for (const lane of Object.values(lanes)) {
    pngs[`genus-${lane.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`] =
      lane.png;
    delete lane.png;
  }

  return {
    rendererType,
    readiness,
    proceduralReady,
    viewport: view,
    table: {
      cumulus: { ...cumulusRow },
      cirrus: { ...cirrusRow },
      cirrusPhaseDelta,
    },
    defaultUniformRow,
    defaultRepeatChanged,
    defaultHash: hashPixels(defaultA.image.data),
    canvasSize: { width: canvas.width, height: canvas.height },
    wind: { a: windA, b: windB },
    lanes,
    pngs,
  };
};

function filteredErrors(errors) {
  return [...new Set(errors)].filter(
    // Deliberately narrow. A broad filter (e.g. "Failed to load
    // resource") would mask exactly the class of error these gates exist to
    // catch.
    (error) => !/favicon|Ion access token/i.test(error),
  );
}

function verdict(value) {
  if (value === null) return "STRUCTURAL";
  return value ? "PASS" : "FAIL";
}

function writePngs(record) {
  for (const [name, dataUrl] of Object.entries(record.pngs ?? {})) {
    const comma = dataUrl.indexOf(",");
    fs.writeFileSync(
      path.join(OUT, `${name}.png`),
      Buffer.from(dataUrl.slice(comma + 1), "base64"),
    );
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });

  const pageErrors = [];
  let result;
  try {
    const page = await browser.newPage({ viewport: VIEW });
    const consoleGate = attachConsoleErrorGate(page);
    page.on("console", (message) => {
      if (message.type() === "error")
        pageErrors.push(`console.error: ${message.text()}`);
    });
    page.on("pageerror", (error) =>
      pageErrors.push(`pageerror: ${error.message}`),
    );
    await page.addInitScript(errorGateInit);
    await installCloudProbeHarnessOnPage(page);
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer?.scene, null, {
      timeout: 90_000,
    });
    await armWebGPUDevices(page);
    result = await page.evaluate(RUN_LANE, { predict: PREDICT, view: VIEW });
    const gate = await collectGateErrors(page);
    pageErrors.push(
      ...consoleGate,
      ...(gate.errors ?? []),
      ...(gate.deviceLost ? [gate.deviceLost] : []),
    );
    await page.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  writePngs(result);
  const errors = filteredErrors(pageErrors);

  console.log("=== C13-16 per-genus cloud morphology acceptance ===");
  console.log(
    `rendererType=${result.rendererType} readiness{binnedGlobe=${result.readiness.binnedGlobeCommands} firstBinnedMs=${
      result.readiness.firstBinnedMs === null
        ? "never"
        : Math.round(result.readiness.firstBinnedMs)
    } elapsedMs=${Math.round(result.readiness.elapsedMs)}} proceduralReady{frames=${result.proceduralReady.waitedFrames} executeCalls=${result.proceduralReady.executeCalls} pipeline=${result.proceduralReady.pipelineReady}}`,
  );
  for (const lane of Object.values(result.lanes)) {
    const a = lane.anisotropy;
    console.log(
      `  ${lane.label.padEnd(14)} uniforms=[${(lane.uniformRow ?? []).join(", ")}] ` +
        `contribPx=${lane.contributionPixels} windAz=${lane.windAzimuthDeg === null ? "n/a" : lane.windAzimuthDeg.toFixed(1)} ` +
        (a.resolved
          ? `along=${a.alongLength.toFixed(2)} across=${a.acrossLength.toFixed(2)} elongation=${a.elongation.toFixed(2)} argmax=${a.argmaxDeg} lines=${a.acceptedLines} sat=${(a.saturatedFraction * 100).toFixed(0)}%`
          : `UNRESOLVED (${a.why})`),
    );
  }

  // ── Gate A — uniforms.
  const table = result.table;
  const row = result.defaultUniformRow;
  const tableIdentity =
    table.cumulus.strength === 0 &&
    table.cumulus.anisotropy === 1 &&
    table.cumulus.shear === 0;
  const rowIdentity =
    Array.isArray(row) &&
    row.length === PREDICT.uniformIdentity.length &&
    row.every((value, i) => value === PREDICT.uniformIdentity[i]);
  // The non-identity control: if CIRRUS were also identity, slot 171 reading 0
  // at the default would be vacuous rather than evidence of an early return.
  const cirrusNonIdentity =
    table.cirrus.strength > 0 &&
    table.cirrus.anisotropy > 1 &&
    table.cirrusPhaseDelta !== 0;
  const gateA = tableIdentity && rowIdentity && cirrusNonIdentity;
  console.log(
    `\n[A UNIFORMS]   predicted CUMULUS table exactly (0,1,0) and packed slots ${PREDICT.uniformSlots.join("/")} === [${PREDICT.uniformIdentity.join(", ")}] exactly (no tolerance); ` +
      `measured table (${table.cumulus.strength},${table.cumulus.anisotropy},${table.cumulus.shear}) row=[${row === null ? "unreadable" : row.join(", ")}]; ` +
      `non-identity control CIRRUS (${table.cirrus.strength},${table.cirrus.anisotropy},${table.cirrus.shear}) phaseDelta=${table.cirrusPhaseDelta}  ${verdict(gateA)}`,
  );

  // ── Gate B — default byte-neutrality against a PRE-change baseline.
  const baselineFile = path.join(OUT, "baseline-default-cumulus.json");
  if (UPDATE_BASELINE) {
    fs.writeFileSync(
      baselineFile,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          canvasSize: result.canvasSize,
          hash: result.defaultHash,
        },
        null,
        2,
      ),
    );
    console.log(
      `[B NEUTRAL]    baseline WRITTEN to ${baselineFile} — re-run WITHOUT --update-baseline on the post-change build to score this gate`,
    );
  }
  let gateB = null;
  let bDetail;
  if (result.defaultRepeatChanged !== 0) {
    bDetail = `determinism control FAILED to resolve: re-capturing the SAME default view changed ${result.defaultRepeatChanged} px, so "exactly 0" is not a measurable quantity in this scene and a byte-neutrality verdict would be meaningless either way. Most likely cause is temporal accumulation in the cloud pass (cache.frameCounter advances per frame); settle longer or disable the temporal tier before re-running, do NOT relax the gate to a tolerance`;
  } else if (!fs.existsSync(baselineFile)) {
    bDetail = `determinism control PASSED (repeat capture 0 px), but no PRE-change baseline exists at ${baselineFile}; record one with --update-baseline on a build without the change. The cross-build claim has no subject to compare against`;
  } else {
    const recorded = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    gateB = recorded.hash === result.defaultHash;
    bDetail = `predicted EXACTLY 0 changed px vs the pre-change build; baseline hash ${recorded.hash} vs measured ${result.defaultHash} → ${gateB ? "identical" : "DIFFERS (a nonzero diff means one of the three early returns is not being taken — that finding outranks the feature)"}`;
  }
  console.log(`[B NEUTRAL]    ${bDetail}  ${verdict(gateB)}`);

  // ── Gate C — direction, not brightness.
  const cirrus = result.lanes.cirrus;
  const cumulus = result.lanes.cumulus;
  const laneBlind = (lane) =>
    !lane.anisotropy.resolved ||
    lane.contributionPixels < PREDICT.minContributionPixels ||
    lane.anisotropy.acceptedLines < PREDICT.minAcceptedLines ||
    lane.anisotropy.saturatedFraction > PREDICT.maxSaturatedFraction;
  let gateC = null;
  let cDetail;
  if (laneBlind(cirrus) || laneBlind(cumulus)) {
    cDetail =
      `blind — contribution pixels cirrus=${cirrus.contributionPixels} cumulus=${cumulus.contributionPixels} (floor ${PREDICT.minContributionPixels}), ` +
      `accepted lines ${cirrus.anisotropy.acceptedLines ?? 0}/${cumulus.anisotropy.acceptedLines ?? 0} (floor ${PREDICT.minAcceptedLines}); ` +
      `this leg could not see its subject (instrument gap, NOT a product verdict). ${cirrus.anisotropy.why ?? ""} ${cumulus.anisotropy.why ?? ""}`;
  } else {
    const ratio =
      cirrus.anisotropy.elongation /
      Math.max(cumulus.anisotropy.elongation, 1e-6);
    gateC =
      cirrus.anisotropy.elongation >= PREDICT.cirrusElongationMin &&
      cumulus.anisotropy.elongation <= PREDICT.cumulusElongationMax &&
      ratio >= PREDICT.cirrusOverCumulusMin;
    cDetail =
      `along/across autocorrelation half-length on the CONTRIBUTION field (never a band mean): ` +
      `cirrus predicted >=${PREDICT.cirrusElongationMin} measured ${cirrus.anisotropy.elongation.toFixed(2)}; ` +
      `cumulus predicted <=${PREDICT.cumulusElongationMax} measured ${cumulus.anisotropy.elongation.toFixed(2)}; ` +
      `ratio predicted >=${PREDICT.cirrusOverCumulusMin} measured ${ratio.toFixed(2)}`;
  }
  console.log(`[C DIRECTION]  ${cDetail}  ${verdict(gateC)}`);

  // ── Gate D — the wind actually steers the streaks.
  const rotated = result.lanes.cirrusRotated;
  let gateD = null;
  let dDetail;
  if (laneBlind(cirrus) || laneBlind(rotated)) {
    dDetail = `blind — one of the two cirrus lanes did not resolve (contribPx ${cirrus.contributionPixels}/${rotated.contributionPixels}); the rotation claim has no subject`;
  } else if (
    cirrus.anisotropy.argmaxDeg === null ||
    rotated.anisotropy.argmaxDeg === null
  ) {
    dDetail = "blind — the azimuth scan produced no usable argmax on one lane";
  } else {
    const windDelta = Math.abs(
      ((rotated.windAzimuthDeg - cirrus.windAzimuthDeg + 90) % 180) - 90,
    );
    let measuredDelta = Math.abs(
      rotated.anisotropy.argmaxDeg - cirrus.anisotropy.argmaxDeg,
    );
    if (measuredDelta > 90) measuredDelta = 180 - measuredDelta;
    gateD =
      Math.abs(measuredDelta - PREDICT.windRotationDeg) <=
        PREDICT.windRotationToleranceDeg &&
      rotated.anisotropy.elongation >= PREDICT.cirrusElongationMin;
    dDetail =
      `wind azimuth moved ${windDelta.toFixed(1)} deg on screen; measured elongation argmax moved ` +
      `${measuredDelta.toFixed(1)} deg (predicted ${PREDICT.windRotationDeg} +/- ${PREDICT.windRotationToleranceDeg}) ` +
      `[${cirrus.anisotropy.argmaxDeg} -> ${rotated.anisotropy.argmaxDeg}]; rotated-lane elongation ${rotated.anisotropy.elongation.toFixed(2)} ` +
      `(a fixed diagonal artifact would keep the SAME argmax)`;
  }
  console.log(`[D WIND]       ${dDetail}  ${verdict(gateD)}`);

  // ── Gate E — grain ordering across the three ice genera.
  const grainLanes = [
    result.lanes.cirrus,
    result.lanes.cirrostratus,
    result.lanes.cirrocumulus,
  ];
  let gateE = null;
  let eDetail;
  if (grainLanes.some(laneBlind)) {
    eDetail = `blind — ${grainLanes
      .map((lane) => `${lane.label}:${lane.contributionPixels}px`)
      .join(" ")} did not all clear the instrument floors`;
  } else {
    const values = grainLanes.map((lane) => lane.anisotropy.elongation);
    gateE =
      values[0] >= values[1] * PREDICT.grainStrictMargin &&
      values[1] >= values[2] * PREDICT.grainStrictMargin;
    eDetail =
      `predicted ordering ${PREDICT.grainOrder.join(" > ")} (spec noise-space aspects 8.10 / 4.65 / 1.95, each step >= x${PREDICT.grainStrictMargin}); ` +
      `measured screen elongation ${values.map((v) => v.toFixed(2)).join(" / ")}`;
  }
  console.log(`[E GRAIN]      ${eDetail}  ${verdict(gateE)}`);

  // ── Gate F — clean, WebGPU, item 9.
  const gateF = result.rendererType === "webgpu" && errors.length === 0;
  console.log(
    `[F CLEAN]      predicted rendererType=webgpu and 0 device/console errors; measured ${result.rendererType} and ${errors.length}  ${verdict(gateF)}`,
  );
  if (errors.length) console.log(`  ${errors.slice(0, 8).join("\n  ")}`);

  console.log(
    `\nHUMAN VERDICT OWED (checklist items 4 and 8 — "read the PNGs; a scalar cannot settle this one"):\n` +
      `  ${OUT}/item4-fallstreak-tilt.png  — the filament's lower edge must sit DOWNWIND of its upper edge\n` +
      `  ${OUT}/item8-near-sun-phase.png   — the forward glow must read as a bright gradient, not a clipped white disc.\n` +
      `                                     If it blows out, the lever is GENUS_PHASE_G_LIMIT and the number should be reported, not quietly retuned.\n` +
      `NOT RUN HERE: item 6 (probe-cloud-tour.mjs northatlantic-cirrus-fibratus floor, minChangedFraction 0.002) and\n` +
      `              item 7 (probe-cloud-shadows-flagon.mjs streaked cast shadow) are other probes' vehicles.\n` +
      `NO TIMING LANE (item 10): C13-39 closed NEGATIVE on static WGSL register allocation; a timing claim would need the interleaved-A/B protocol.`,
  );

  const { pngs: _pngs, ...manifestBody } = result;
  const manifestPath = path.join(OUT, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        predictions: PREDICT,
        errors,
        ...manifestBody,
      },
      null,
      2,
    ),
  );
  console.log(`\nmanifest: ${manifestPath}`);
  console.log(`PNGs: ${OUT}/*.png`);

  const gates = [gateA, gateB, gateC, gateD, gateE, gateF];
  const failed = gates.some((gate) => gate === false);
  const structural = gates.some((gate) => gate === null);
  console.log(
    `\nGATE ${failed ? "FAIL" : structural ? "INCOMPLETE (structural)" : "PASS"}` +
      (structural
        ? " — one or more legs could not see their subject. Those are instrument gaps owed as follow-up, NOT product verdicts, and NOT a pass: exit 3 so a structural run can never be mistaken for a green one."
        : ""),
  );
  // Exit codes: 0 = every gate decided and passed. 1 = a real product FAIL.
  // 2 = watchdog or an exception. 3 = no FAIL, but at least one gate had no
  // subject to measure — acceptance is INCOMPLETE, not green.
  process.exitCode = failed ? 1 : structural ? 3 : 0;
}

main()
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  })
  .finally(() => clearTimeout(watchdog));
