#!/usr/bin/env node
/**
 * `SUN-SHADOW-GATE-PROBE-NEEDED` — sun shadow receive on the globe, browser
 * acceptance probe (owed since Batch 805).
 * @purpose Sun-shadow receive-on-globe acceptance: WebGL reference darkening, WebGPU receive ratio band, faded-vs-unfaded darkness asymmetry.
 * @status ACTIVE
 *
 * The Batch 775/780 `cascadesEnabled` fix is static-analysis-verified only. A
 * quick orchestrator gate at Batch 805 produced instrument ambiguity instead of
 * a verdict and recorded two things this probe exists to resolve:
 *
 *   1. the WebGL leg's `scene.shadowMap.enabled` toggle changed NOTHING, so no
 *      reference existed and the WebGPU leg could not be judged against it;
 *   2. on the WebGPU leg, enabling the shadow map BRIGHTENED the ground band by
 *      ~112/255 at local noon (dayOff ~68 -> dayOn ~180). A receive-shadow
 *      shader variant that replaces the base lighting term wholesale would look
 *      exactly like that, so the delta is evidence to explain, not noise.
 *
 * WHY THE BATCH-805 WebGL LEG SAW NOTHING — the reach conditions, from source
 * (these are also dumped per lane as `reach`, so a red is diagnosable):
 *
 *   * `Globe.shadows` defaults to `ShadowMode.RECEIVE_ONLY` (`Globe.js:470`),
 *     forwarded to the tile provider at `Globe.js:1236` and turned into
 *     `command.receiveShadows` at `GlobeSurfaceTileProviderRendering.js:1493`.
 *     Receive is therefore ON by default; nothing needs enabling there.
 *   * `enableLighting` is NOT a prerequisite. `ShadowMapShader.js:434` appends
 *     `out_FragColor.rgb *= visibility;` outside every lighting `#ifdef`, and
 *     `ENABLE_DAYNIGHT_SHADING` is only added when the globe also CASTS
 *     (`ShadowMapShader.js:265`), which `RECEIVE_ONLY` does not. This probe
 *     still sweeps lighting on AND off so the claim is measured, not asserted.
 *   * The real reach limit is DEPTH. The cascaded receive shader returns early
 *     when `depth > shadowMap_cascadeSplits[1].w` (`ShadowMapShader.js:388`),
 *     and `ShadowMap.maximumDistance` defaults to 5000 m
 *     (`ShadowMap.js:425`). A camera parked at orbital or even regional
 *     altitude puts every globe fragment past the last cascade and the toggle
 *     is a visual no-op — which is exactly the shape of the Batch-805 report.
 *     This probe flies a 2600 m nadir camera and states the budget explicitly.
 *   * Below the horizon the shadow map is culled: `checkVisibility` sets
 *     `_outOfView` when `dot(surfaceNormal, lightDirection) < 0`
 *     (`ShadowMapComputations.js:705-721`) and, with `fadingEnabled` (default
 *     true), ramps `_darkness` to 1.0 first — and 1.0 means
 *     `visibility = max(visibility, 1.0)`, i.e. no darkening at all.
 *
 * A RECORDED ASYMMETRY THIS PROBE IS BUILT TO EXPOSE — WebGL's receive uniform
 * reads the FADED `shadowMap._darkness` (`ShadowMap.js:215`), while the WebGPU
 * receive path reads the PUBLIC, unfaded `shadowMap.darkness`
 * (`WebGPUShadowMapRenderer.js:1310`, `WebGPUEffectsBindGroup.js:1289`). The
 * globe's WebGPU receive gate also never consults `outOfView`
 * (`WebGPUGlobeSurfaceRenderer.ts:862-867`) even though the cast pass does
 * (`WebGPUContext.ts:4656`). Predicted consequence: below the horizon WebGL
 * fades to zero delta by construction and WebGPU may keep sampling a stale
 * depth target at darkness 0.3. Gate E is the measurement of that prediction.
 *
 * SCENE ISOLATION. The caster is a floating slab with
 * `shadows: ShadowMode.CAST_ONLY`, so it never RECEIVES and its own pixels are
 * byte-identical between the shadow-off and shadow-on captures. Combined with
 * an explicit caster mask (the pixels that differ between a caster-hidden and a
 * caster-shown frame, dilated to swallow the antialiased rim), every remaining
 * changed pixel in the band is a globe-receive change and nothing else.
 *
 * GATES (each prints predicted vs measured)
 *   A BACKEND    `scene.context.rendererType` equals the requested backend on
 *                both lanes. A silent WebGL fallback HARD-FAILS: scoring a
 *                WebGL frame as a WebGPU pass is a false green.
 *   B REFERENCE  the load-bearing one. WebGL, sun at +30 deg: the shadow-map
 *                toggle must DARKEN the banded ground mean. Until this is true
 *                there is no reference and every cross-backend claim below is
 *                unmeasurable, so a WebGL leg that will not darken reports
 *                STRUCTURAL (with the full `reach` dump) — never PASS, and
 *                never FAIL against WebGPU.
 *   C RECEIVE    WebGPU darkens too, in both lighting modes, and the
 *                WebGPU:WebGL drop ratio stays inside a bounded band. This is
 *                the `cascadesEnabled` claim at pixels.
 *   D BRIGHTEN   the Batch-805 anomaly, decided from the full four-cell table
 *                (backend x shadow on/off, both lighting modes). A band mean
 *                that RISES with shadows on is a confirmed defect and FAILS
 *                with the numbers. Guarded by an A/B/A control: every cell
 *                captures shadow-off, shadow-on, shadow-off again, and if the
 *                two off frames disagree the cell could not resolve "the
 *                toggle did it" from "the scene was still settling" and reports
 *                STRUCTURAL. That control is the discriminator the Batch-805
 *                measurement lacked.
 *   E NIGHT      sun at -20 deg: the toggle must produce zero delta on BOTH
 *                backends (below-horizon cull + darkness fade). Scored per
 *                backend and only for a backend whose own day leg darkened —
 *                otherwise "no delta" is trivially true and would be a false
 *                green. DAY runs BEFORE NIGHT deliberately: that ordering
 *                leaves a populated depth target behind, which is the only
 *                ordering in which a stale-depth night shadow can appear.
 *   F CLEAN      zero console / uncaptured-device errors across the whole run.
 *
 * READINESS is binned `Pass.GLOBE` commands reaching `view.frustumCommandsList`
 * plus a WALL-CLOCK settle budget — never `tilesLoaded` alone and never a frame
 * count. A cold globe pipeline variant has measured ~2674 ms to compile, which
 * a frame budget silently under-runs.
 *
 * Usage:
 *   node Tools/visual-regression/probe-sun-shadow-gate.mjs
 * Env:
 *   PROBE_BASE  default http://localhost:8080
 * Out:
 *   Tools/visual-regression/output/sun-shadow-gate/*.png + manifest.json
 *   Per cell and lane: `-caster-hidden`, `-shadow-off`, `-shadow-on` and a
 *   `-delta` visualization (blue = darkened, red = brightened, green = the
 *   masked caster, grey = outside the band).
 * Exit:
 *   0 every gate decided and passed | 1 a real product FAIL |
 *   2 watchdog or exception | 3 no FAIL but a gate had no subject to measure
 *     (acceptance INCOMPLETE, not green)
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

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/sun-shadow-gate";
const VIEW = { width: 1024, height: 768 };

// Two page loads, three cells each, four wall-clock-settled captures per cell.
const WATCHDOG_MS = 600_000;
const watchdog = setTimeout(() => {
  console.error(`STRUCTURAL: probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

// ── The scene, stated as numbers so the geometry is auditable without running.
// Site + slab sized so the shadow clears the caster's own screen footprint at
// the pinned sun elevation, and so both stay inside the measured band.
const SITE = {
  lon: -105.0,
  lat: 40.0,
  // ~700 m square. 1 deg lat ~ 111 000 m; 1 deg lon ~ 85 300 m at lat 40.
  halfLatDeg: 0.00315,
  halfLonDeg: 0.0041,
  slabBaseHeight: 380.0,
  slabTopHeight: 460.0,
};

const PREDICT = {
  // Camera depth budget. Ground fragments sit ~2600 m down the view axis under
  // a nadir camera, well inside the last cascade split, which is what the
  // Batch-805 scene is suspected to have missed.
  cameraHeight: 2600.0,
  shadowMaximumDistance: 10_000.0,
  shadowDarkness: 0.3,
  // Sun elevations. +30 deg puts the slab's shadow ~730 m from the slab
  // (~187 px at this altitude), clear of its own ~213 px footprint. -20 deg is
  // unambiguously below the horizon for the cull leg.
  dayElevationDeg: 30.0,
  nightElevationDeg: -20.0,
  // The clock solve is verified against the sun direction the ENGINE actually
  // rendered with, not trusted.
  elevationToleranceDeg: 3.0,
  // Band: the centre 80% x 80% of the canvas. Never a whole-frame mean.
  bandMargin: 0.1,
  // Caster mask.
  minCasterMaskPixels: 3000,
  casterMaskDilation: 3,
  // Per-pixel luminance delta (8-bit) that counts as darkened / brightened.
  lumThreshold: 8.0,
  // Day-side darkening. The slab shadow covers ~6% of the band and drops those
  // pixels by ~0.7 x ~202, so the band mean is predicted to fall ~9/255.
  dayMeanDropPredicted: 9.0,
  dayMeanDropFloor: 3.0,
  minShadowPixels: 4000,
  // The Batch-805 anomaly. Anything above this is a RISE, i.e. the defect.
  brightenMeanCeiling: 1.5,
  // Cross-backend agreement on the size of the drop.
  dropRatioPredicted: 1.0,
  dropRatioBand: [0.4, 2.5],
  // Night: the toggle must do nothing.
  nightMeanDeltaCeiling: 1.0,
  nightChangedFraction: 0.01,
  // A/B/A control: the two shadow-off captures of a cell must agree.
  abaMeanCeiling: 1.0,
  abaChangedFraction: 0.02,
};

const CELLS = [
  { id: "DAY_UNLIT", elevationDeg: 30.0, enableLighting: false, day: true },
  { id: "DAY_LIT", elevationDeg: 30.0, enableLighting: true, day: true },
  { id: "NIGHT_UNLIT", elevationDeg: -20.0, enableLighting: false, day: false },
];

/**
 * Everything below runs INSIDE the page. `page.evaluate` serializes the
 * function source and drops the surrounding closure, so every helper this lane
 * needs is defined here rather than imported — the recorded trap from the
 * shared-helper work.
 */
const RUN_LANE = async ({ renderer, cells, site, predict, view }) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const rendererType = String(scene.context?.rendererType ?? "").toLowerCase();

  // ── Deterministic, offline, sky-free scene. Anything that animates on its
  // own would make the A/B/A control meaningless.
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 0;
  viewer.terrainProvider = new C.EllipsoidTerrainProvider();
  scene.globe.show = true;
  // Imagery removal is a CONFOUND removal, not cosmetics: enabling the shadow
  // map costs the globe one texture unit
  // (`GlobeSurfaceTileProviderRendering.js:1527` decrements `maxTextures`), so
  // with layers attached the toggle could change how many imagery layers a tile
  // draws in one pass and the band would move for a reason that has nothing to
  // do with shadow receive.
  scene.globe.imageryLayers.removeAll();
  scene.globe.baseColor = new C.Color(0.82, 0.8, 0.74, 1.0);
  scene.globe.showGroundAtmosphere = false;
  scene.globe.depthTestAgainstTerrain = true;
  // Explicit even though it is the default: globe receive is the SUBJECT, and
  // an implicit subject is one a future default change silently removes.
  scene.globe.shadows = C.ShadowMode.RECEIVE_ONLY;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.fog) scene.fog.enabled = false;
  scene.backgroundColor = C.Color.BLACK;
  // The single-shadow-map path on both backends. CSM is a separate subject with
  // its own probes; mixing it in would make a red ambiguous between the two.
  scene.useCascadedShadowMaps = false;
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

  const shadowMap = scene.shadowMap;
  shadowMap.enabled = false;
  shadowMap.softShadows = false;
  shadowMap.darkness = predict.shadowDarkness;
  shadowMap.maximumDistance = predict.shadowMaximumDistance;
  shadowMap.size = 2048;

  // ── Caster: a floating slab, CAST_ONLY. CAST_ONLY is the isolation: the slab
  // never receives, so its own pixels are identical across the toggle and every
  // changed pixel in the band belongs to the globe.
  const slabRing = C.Cartesian3.fromDegreesArray([
    site.lon - site.halfLonDeg,
    site.lat - site.halfLatDeg,
    site.lon + site.halfLonDeg,
    site.lat - site.halfLatDeg,
    site.lon + site.halfLonDeg,
    site.lat + site.halfLatDeg,
    site.lon - site.halfLonDeg,
    site.lat + site.halfLatDeg,
  ]);
  const slab = new C.Primitive({
    geometryInstances: new C.GeometryInstance({
      geometry: new C.PolygonGeometry({
        polygonHierarchy: new C.PolygonHierarchy(slabRing),
        height: site.slabBaseHeight,
        extrudedHeight: site.slabTopHeight,
        vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: C.ColorGeometryInstanceAttribute.fromColor(
          new C.Color(0.15, 0.15, 0.18, 1.0),
        ),
      },
    }),
    // `flat: false` with `PerInstanceColorAppearance.VERTEX_FORMAT` is the
    // combination `probe-c10-10-shadow-single-sweep.mjs` already proves renders
    // on both backends; `flat: true` wants the narrower FLAT_VERTEX_FORMAT and
    // is not worth the risk here — the slab is masked out of every metric
    // anyway, so its shading model is irrelevant to the measurement.
    appearance: new C.PerInstanceColorAppearance({
      translucent: false,
      flat: false,
    }),
    asynchronous: false,
    shadows: C.ShadowMode.CAST_ONLY,
  });
  scene.primitives.add(slab);

  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(
      site.lon,
      site.lat,
      predict.cameraHeight,
    ),
    orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
  });

  // ── Clock solve. The sun the renderer draws with comes from the clock, so
  // synthesizing a direction would have the geometry and the pixels describing
  // different scenes. Mirror `UniformStateComputations.setSunAndMoonDirections`
  // exactly (ICRF -> central-body-fixed x Simon1994), then VERIFY the achieved
  // elevation against the direction the engine actually rendered with.
  const sitePosition = C.Cartesian3.fromDegrees(site.lon, site.lat, 0.0);
  const siteUp = C.Ellipsoid.WGS84.geodeticSurfaceNormal(
    sitePosition,
    new C.Cartesian3(),
  );
  const sunDirectionAt = (julianDate) => {
    const icrf = C.Transforms.computeIcrfToCentralBodyFixedMatrix(
      julianDate,
      new C.Matrix3(),
    );
    const inertial =
      C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        julianDate,
        new C.Cartesian3(),
      );
    const fixed = C.defined(icrf)
      ? C.Matrix3.multiplyByVector(icrf, inertial, new C.Cartesian3())
      : inertial;
    return C.Cartesian3.normalize(fixed, new C.Cartesian3());
  };
  const elevationOfDirection = (direction) =>
    C.Math.toDegrees(
      Math.asin(
        Math.max(-1.0, Math.min(1.0, C.Cartesian3.dot(direction, siteUp))),
      ),
    );
  const elevationAt = (julianDate) =>
    elevationOfDirection(sunDirectionAt(julianDate));
  const solveClock = (targetDeg) => {
    const base = C.JulianDate.fromIso8601("2026-06-01T00:00:00Z");
    let low = null;
    let high = null;
    let previousDate = base;
    let previousElevation = elevationAt(base);
    for (let minutes = 5; minutes <= 1440; minutes += 5) {
      const date = C.JulianDate.addMinutes(base, minutes, new C.JulianDate());
      const elevation = elevationAt(date);
      if (previousElevation >= targetDeg !== elevation >= targetDeg) {
        low = previousDate;
        high = date;
        break;
      }
      previousDate = date;
      previousElevation = elevation;
    }
    if (low === null) {
      return null;
    }
    for (let i = 0; i < 40; i++) {
      const middle = C.JulianDate.addSeconds(
        low,
        C.JulianDate.secondsDifference(high, low) * 0.5,
        new C.JulianDate(),
      );
      if (elevationAt(low) >= targetDeg !== elevationAt(middle) >= targetDeg) {
        high = middle;
      } else {
        low = middle;
      }
    }
    return low;
  };

  // ── Same-task capture: render and read the canvas element without yielding
  // in between. A read across a rAF yield is invalid on BOTH backends.
  const scratch = document.createElement("canvas");
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
  let frameTime = C.JulianDate.fromIso8601("2026-06-01T00:00:00Z");
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
  // WALL CLOCK, not frames. `setTimeout(0)` rather than rAF so the budget is a
  // real duration even when the compositor throttles a headless page.
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

  // ── Readiness: binned Pass.GLOBE commands, never `tilesLoaded` alone.
  // `tilesLoaded` can go true while the globe's pipeline variant is still
  // compiling, which is exactly the window a frame-count budget lands in.
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
      tilesLoaded: scene.globe.tilesLoaded === true,
    };
  };

  // ── Pixel helpers.
  const luminanceAt = (data, index) =>
    0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];

  const bandOf = (width, height) => {
    const marginX = Math.round(width * predict.bandMargin);
    const marginY = Math.round(height * predict.bandMargin);
    return {
      x0: marginX,
      y0: marginY,
      x1: width - marginX,
      y1: height - marginY,
    };
  };

  /**
   * The caster mask: pixels that differ between a caster-hidden frame and a
   * caster-shown frame, dilated so the antialiased rim cannot leak into the
   * darkened/brightened populations. Separable max-dilation, horizontal then
   * vertical.
   */
  const buildCasterMask = (shown, hidden, radius) => {
    const { width, height } = shown;
    const raw = new Uint8Array(width * height);
    let rawCount = 0;
    for (let i = 0, p = 0; i < shown.data.length; i += 4, p++) {
      if (
        shown.data[i] !== hidden.data[i] ||
        shown.data[i + 1] !== hidden.data[i + 1] ||
        shown.data[i + 2] !== hidden.data[i + 2] ||
        shown.data[i + 3] !== hidden.data[i + 3]
      ) {
        raw[p] = 1;
        rawCount++;
      }
    }
    const horizontal = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let hit = 0;
        const from = Math.max(0, x - radius);
        const to = Math.min(width - 1, x + radius);
        for (let k = from; k <= to; k++) {
          if (raw[row + k]) {
            hit = 1;
            break;
          }
        }
        horizontal[row + x] = hit;
      }
    }
    const mask = new Uint8Array(width * height);
    let count = 0;
    for (let y = 0; y < height; y++) {
      const from = Math.max(0, y - radius);
      const to = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x++) {
        let hit = 0;
        for (let k = from; k <= to; k++) {
          if (horizontal[k * width + x]) {
            hit = 1;
            break;
          }
        }
        mask[y * width + x] = hit;
        count += hit;
      }
    }
    return { mask, count, rawCount };
  };

  /**
   * BANDED metrics over the ground, caster excluded. Reports the whole
   * population — darkened AND brightened — because the open question is which
   * direction the toggle moves the band, not merely how far.
   */
  const bandMetrics = (onFrame, offFrame, mask) => {
    const { width, height } = onFrame;
    const band = bandOf(width, height);
    const on = onFrame.data;
    const off = offFrame.data;
    let samples = 0;
    let sumOn = 0;
    let sumOff = 0;
    let sumDelta = 0;
    let darkened = 0;
    let brightened = 0;
    let changed = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = band.y0; y < band.y1; y++) {
      for (let x = band.x0; x < band.x1; x++) {
        const p = y * width + x;
        if (mask && mask[p]) {
          continue;
        }
        const i = p * 4;
        const lumOn = luminanceAt(on, i);
        const lumOff = luminanceAt(off, i);
        const delta = lumOn - lumOff;
        samples++;
        sumOn += lumOn;
        sumOff += lumOff;
        sumDelta += delta;
        if (
          on[i] !== off[i] ||
          on[i + 1] !== off[i + 1] ||
          on[i + 2] !== off[i + 2] ||
          on[i + 3] !== off[i + 3]
        ) {
          changed++;
        }
        if (delta <= -predict.lumThreshold) {
          darkened++;
          sumX += x;
          sumY += y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        } else if (delta >= predict.lumThreshold) {
          brightened++;
        }
      }
    }
    const safe = Math.max(samples, 1);
    return {
      band,
      samples,
      meanOn: sumOn / safe,
      meanOff: sumOff / safe,
      meanDelta: sumDelta / safe,
      darkened,
      brightened,
      changed,
      changedFraction: changed / safe,
      darkenedCentroid:
        darkened > 0 ? [sumX / darkened, sumY / darkened] : [null, null],
      darkenedBbox: maxX < 0 ? null : [minX, minY, maxX, maxY],
    };
  };

  // Visualization: blue = darkened, red = brightened, green = masked caster,
  // grey = outside the band. Amplified 3x so a small real delta is visible.
  const deltaPng = (onFrame, offFrame, mask) => {
    const { width, height } = onFrame;
    const band = bandOf(width, height);
    const target = document.createElement("canvas");
    target.width = width;
    target.height = height;
    const targetContext = target.getContext("2d");
    const out = targetContext.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i = p * 4;
        out.data[i + 3] = 255;
        const inBand =
          x >= band.x0 && x < band.x1 && y >= band.y0 && y < band.y1;
        if (!inBand) {
          out.data[i] = 20;
          out.data[i + 1] = 20;
          out.data[i + 2] = 20;
          continue;
        }
        if (mask && mask[p]) {
          out.data[i + 1] = 90;
          continue;
        }
        const delta =
          luminanceAt(onFrame.data, i) - luminanceAt(offFrame.data, i);
        if (delta < 0) {
          out.data[i + 2] = Math.min(255, Math.round(-delta * 3));
        } else {
          out.data[i] = Math.min(255, Math.round(delta * 3));
        }
      }
    }
    targetContext.putImageData(out, 0, 0);
    return target.toDataURL("image/png");
  };

  /**
   * The shadow machinery, read straight off the live objects after a render.
   * This is what makes a STRUCTURAL verdict actionable instead of a shrug: it
   * separates "no casters reached the map", "the map was culled", "the fade
   * zeroed the darkness" and "the receive never ran" from each other.
   */
  const readReach = () => {
    const frameState = scene.frameState ?? scene._frameState;
    const shadowState = frameState?.shadowState;
    const passes = shadowMap.passes ?? [];
    return {
      enabled: shadowMap.enabled === true,
      shadowsEnabled: shadowState?.shadowsEnabled === true,
      lightShadowsEnabled: shadowState?.lightShadowsEnabled === true,
      lightShadowMaps: shadowState?.lightShadowMaps?.length ?? 0,
      casterCommands: shadowState?.casterCommands?.length ?? null,
      passCommandLists: passes.map((pass) => pass?.commandList?.length ?? 0),
      numberOfPasses: passes.length,
      outOfView: shadowMap.outOfView === true,
      // The WebGL receive uniform reads `_darkness` (faded); the WebGPU receive
      // path reads the public `darkness` (unfaded). Both are recorded so the
      // divergence is visible in the manifest rather than inferred.
      darknessPublic: shadowMap.darkness,
      darknessEffective: shadowMap._darkness,
      maximumDistance: shadowMap.maximumDistance,
      cameraHeight: scene.camera.positionCartographic?.height ?? null,
      globeShadowMode: scene.globe.shadows,
      enableLighting: scene.globe.enableLighting === true,
      useCascadedShadowMaps: scene.useCascadedShadowMaps === true,
      managesSceneShadowCascadesNatively:
        scene.context?.managesSceneShadowCascadesNatively === true,
      sunElevationDeg: elevationOfDirection(
        C.Cartesian3.clone(
          scene.context.uniformState.sunDirectionWC,
          new C.Cartesian3(),
        ),
      ),
    };
  };

  // ── Warm the globe once, with the caster hidden and shadows off.
  slab.show = false;
  shadowMap.enabled = false;
  frameTime = C.JulianDate.fromIso8601("2026-06-01T18:00:00Z");
  const readiness = await awaitGlobeReady(3000, 90_000);
  await settleMs(2000);

  const results = [];
  const pngs = {};
  for (const cell of cells) {
    const solved = solveClock(cell.elevationDeg);
    if (solved === null) {
      results.push({ id: cell.id, unsolved: true });
      continue;
    }
    frameTime = solved.clone();
    viewer.clock.currentTime = solved.clone();
    viewer.clock.startTime = solved.clone();
    viewer.clock.stopTime = solved.clone();
    scene.globe.enableLighting = cell.enableLighting;

    // 1. caster hidden, shadows off -> the mask reference.
    slab.show = false;
    shadowMap.enabled = false;
    await settleMs(1800);
    const casterHidden = captureNow();

    // 2. caster shown, shadows off.
    slab.show = true;
    await settleMs(1800);
    const shadowOff = captureNow();
    const reachOff = readReach();

    // 3. caster shown, shadows on. The longest settle of the four: enabling the
    // map makes WebGL derive and link a NEW globe receive program
    // (`ShadowMapShader.createShadowReceiveFragmentShader`) and makes WebGPU
    // allocate its depth target and rebuild the effects bind group. A budget
    // that lands during that compile captures the pre-shadow frame and reads
    // as "the toggle did nothing" — the exact Batch-805 symptom.
    shadowMap.enabled = true;
    await settleMs(2200);
    const shadowOn = captureNow();
    const reachOn = readReach();

    // 4. back off — the A/B/A control. If this does not reproduce step 2 the
    // cell cannot attribute step 3's delta to the toggle at all.
    shadowMap.enabled = false;
    await settleMs(1800);
    const shadowOffAgain = captureNow();

    const casterMask = buildCasterMask(
      shadowOff.image,
      casterHidden.image,
      predict.casterMaskDilation,
    );
    const toggle = bandMetrics(
      shadowOn.image,
      shadowOff.image,
      casterMask.mask,
    );
    const aba = bandMetrics(
      shadowOffAgain.image,
      shadowOff.image,
      casterMask.mask,
    );

    pngs[`${renderer}-${cell.id}-caster-hidden`] = casterHidden.png;
    pngs[`${renderer}-${cell.id}-shadow-off`] = shadowOff.png;
    pngs[`${renderer}-${cell.id}-shadow-on`] = shadowOn.png;
    pngs[`${renderer}-${cell.id}-delta`] = deltaPng(
      shadowOn.image,
      shadowOff.image,
      casterMask.mask,
    );

    results.push({
      id: cell.id,
      enableLighting: cell.enableLighting,
      day: cell.day,
      targetElevationDeg: cell.elevationDeg,
      // Predicted from the offline solve; measured from the direction the
      // engine actually rendered with. A gap means the clock did not land.
      solvedElevationDeg: elevationAt(solved),
      renderedElevationDeg: reachOn.sunElevationDeg,
      isoTime: C.JulianDate.toIso8601(solved),
      casterMaskPixels: casterMask.count,
      casterMaskRawPixels: casterMask.rawCount,
      toggle,
      aba,
      reachOff,
      reachOn,
    });
  }

  scene.primitives.remove(slab);

  return {
    rendererType,
    readiness,
    canvasSize: { width: canvas.width, height: canvas.height },
    viewport: { width: view.width, height: view.height },
    cells: results,
    pngs,
  };
};

function attachPageErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function filteredErrors(errors) {
  return [...new Set(errors)].filter(
    // Deliberately narrow. A broad filter would mask exactly the class of error
    // these gates exist to catch.
    (error) => !/favicon|Ion access token/i.test(error),
  );
}

async function runBackend(browser, renderer) {
  const page = await browser.newPage({ viewport: VIEW });
  const pageErrors = attachPageErrors(page);
  const consoleGate = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer?.scene, null, {
      timeout: 90_000,
    });
    if (renderer === "webgpu") {
      await armWebGPUDevices(page);
    }
    const result = await page.evaluate(RUN_LANE, {
      renderer,
      cells: CELLS,
      site: SITE,
      predict: PREDICT,
      view: VIEW,
    });
    const gate = await collectGateErrors(page);
    const errors = filteredErrors([
      ...pageErrors,
      ...consoleGate,
      ...(gate.errors ?? []),
      ...(gate.deviceLost ? [gate.deviceLost] : []),
    ]);
    return { requested: renderer, ...result, errors };
  } finally {
    await page.close().catch(() => {});
  }
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

function withoutPngs(record) {
  const { pngs: _pngs, ...rest } = record;
  return rest;
}

function verdict(value) {
  if (value === null) {
    return "STRUCTURAL";
  }
  return value ? "PASS" : "FAIL";
}

function cellOf(lane, id) {
  return lane.cells.find((cell) => cell.id === id);
}

function reachSummary(cell) {
  if (!cell || cell.unsolved) {
    return "cell unsolved (no clock bracket for the target elevation)";
  }
  const r = cell.reachOn;
  return (
    `enabled=${r.enabled} shadowsEnabled=${r.shadowsEnabled} ` +
    `lightShadowsEnabled=${r.lightShadowsEnabled} lightShadowMaps=${r.lightShadowMaps} ` +
    `casters=${r.casterCommands} passLists=[${r.passCommandLists}] outOfView=${r.outOfView} ` +
    `darkness(public/effective)=${r.darknessPublic}/${r.darknessEffective} ` +
    `maxDistance=${r.maximumDistance} cameraHeight=${Math.round(r.cameraHeight ?? -1)} ` +
    `globeShadowMode=${r.globeShadowMode} enableLighting=${r.enableLighting} ` +
    `nativeCascades=${r.managesSceneShadowCascadesNatively} ` +
    `casterMaskPx=${cell.casterMaskPixels}`
  );
}

/** A cell can only be read when its clock landed, its caster drew, and its
 * A/B/A control reproduced. Anything else is an instrument gap. */
function cellResolution(cell) {
  if (!cell) {
    return { ok: false, why: "cell missing from the lane record" };
  }
  if (cell.unsolved) {
    return {
      ok: false,
      why: "no clock bracket solved for the target elevation",
    };
  }
  const elevationError = Math.abs(
    cell.renderedElevationDeg - cell.targetElevationDeg,
  );
  if (elevationError > PREDICT.elevationToleranceDeg) {
    return {
      ok: false,
      why:
        `clock landed at ${cell.renderedElevationDeg.toFixed(2)} deg but the cell ` +
        `wants ${cell.targetElevationDeg.toFixed(2)} deg (tolerance ` +
        `${PREDICT.elevationToleranceDeg}); the rendered sun is not the pinned sun`,
    };
  }
  if (cell.casterMaskPixels < PREDICT.minCasterMaskPixels) {
    return {
      ok: false,
      why:
        `the caster occupies ${cell.casterMaskPixels} px (floor ` +
        `${PREDICT.minCasterMaskPixels}); nothing was there to cast, so no shadow ` +
        `verdict is available on this lane`,
    };
  }
  const abaMean = Math.abs(cell.aba.meanDelta);
  if (
    abaMean > PREDICT.abaMeanCeiling ||
    cell.aba.changedFraction > PREDICT.abaChangedFraction
  ) {
    return {
      ok: false,
      why:
        `A/B/A control did not reproduce: re-capturing the SAME shadow-off view ` +
        `moved the band mean by ${cell.aba.meanDelta.toFixed(2)} (ceiling ` +
        `${PREDICT.abaMeanCeiling}) and changed ` +
        `${(cell.aba.changedFraction * 100).toFixed(2)}% of the band (ceiling ` +
        `${(PREDICT.abaChangedFraction * 100).toFixed(2)}%), so this cell cannot ` +
        `separate "the toggle did it" from "the scene was still settling"`,
    };
  }
  return { ok: true, why: null };
}

function cellLine(lane, cell) {
  if (!cell || cell.unsolved) {
    return `${lane.requested.padEnd(6)} ${cell?.id ?? "?"}: UNSOLVED`;
  }
  const t = cell.toggle;
  return (
    `${lane.requested.padEnd(6)} ${cell.id.padEnd(12)} ` +
    `sun target=${cell.targetElevationDeg.toFixed(1)} rendered=${cell.renderedElevationDeg.toFixed(2)} deg  ` +
    `bandMean off=${t.meanOff.toFixed(2)} on=${t.meanOn.toFixed(2)} ` +
    `delta=${t.meanDelta >= 0 ? "+" : ""}${t.meanDelta.toFixed(2)}  ` +
    `darkPx=${t.darkened} brightPx=${t.brightened} changed=${t.changed}  ` +
    `aba delta=${cell.aba.meanDelta.toFixed(2)} changed=${cell.aba.changed}`
  );
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });

  let webgl;
  let webgpu;
  try {
    webgl = await runBackend(browser, "webgl");
    webgpu = await runBackend(browser, "webgpu");
  } finally {
    await browser.close().catch(() => {});
  }
  writePngs(webgl);
  writePngs(webgpu);

  const lanes = [webgl, webgpu];

  console.log("=== SUN-SHADOW-GATE sun shadow receive acceptance ===");
  console.log(
    `scene: ellipsoid globe, CAST_ONLY floating slab at ${SITE.lon}/${SITE.lat}, ` +
      `nadir camera ${PREDICT.cameraHeight} m, shadowMap.maximumDistance ` +
      `${PREDICT.shadowMaximumDistance} m, darkness ${PREDICT.shadowDarkness}, ` +
      `single map (useCascadedShadowMaps=false)`,
  );
  for (const lane of lanes) {
    console.log(
      `${lane.requested.padEnd(6)} rendererType=${lane.rendererType} ` +
        `readiness{binnedGlobe=${lane.readiness.binnedGlobeCommands} firstBinnedMs=${
          lane.readiness.firstBinnedMs === null
            ? "never"
            : Math.round(lane.readiness.firstBinnedMs)
        } elapsedMs=${Math.round(lane.readiness.elapsedMs)} tilesLoaded=${lane.readiness.tilesLoaded}} ` +
        `errs=${lane.errors.length}`,
    );
  }

  console.log(
    "\n-- four-cell band table (the Batch-805 measurement, redone) --",
  );
  for (const lane of lanes) {
    for (const definition of CELLS) {
      console.log(`  ${cellLine(lane, cellOf(lane, definition.id))}`);
    }
  }
  console.log("\n-- shadow machinery (shadow-on capture) --");
  for (const lane of lanes) {
    for (const definition of CELLS) {
      console.log(
        `  ${lane.requested.padEnd(6)} ${definition.id.padEnd(12)} ${reachSummary(
          cellOf(lane, definition.id),
        )}`,
      );
    }
  }

  // ── Gate A — backend identity. Checked FIRST: every number below is
  // meaningless if the WebGPU lane silently fell back to WebGL.
  const gateA =
    webgl.rendererType === "webgl" && webgpu.rendererType === "webgpu";
  console.log(
    `\n[A BACKEND]   predicted webgl/webgpu  measured ${webgl.rendererType}/${webgpu.rendererType}  ${verdict(gateA)}`,
  );

  // ── Gate B — the reference. Load-bearing: without a WebGL scene where the
  // toggle demonstrably darkens the ground, nothing downstream is measurable.
  const referenceCell = cellOf(webgl, "DAY_UNLIT");
  const referenceResolution = cellResolution(referenceCell);
  let gateB = null;
  let bDetail;
  if (!referenceResolution.ok) {
    bDetail =
      `WebGL DAY_UNLIT could not be read — ${referenceResolution.why}. ` +
      `reach: ${reachSummary(referenceCell)}`;
  } else {
    const drop = -referenceCell.toggle.meanDelta;
    gateB =
      drop >= PREDICT.dayMeanDropFloor &&
      referenceCell.toggle.darkened >= PREDICT.minShadowPixels;
    bDetail =
      `WebGL sun +${PREDICT.dayElevationDeg} deg: band mean predicted to DROP ` +
      `~${PREDICT.dayMeanDropPredicted.toFixed(1)}/255 (floor ` +
      `${PREDICT.dayMeanDropFloor.toFixed(1)}), measured ${drop.toFixed(2)}; ` +
      `darkened px predicted >=${PREDICT.minShadowPixels} measured ` +
      `${referenceCell.toggle.darkened}; shadow bbox ` +
      `${JSON.stringify(referenceCell.toggle.darkenedBbox)}`;
    if (!gateB) {
      // A reference that will not darken is an instrument gap, not a product
      // FAIL — there is no product claim being tested yet at this point.
      bDetail +=
        ` — the reference did not darken, so this is STRUCTURAL, not a WebGL ` +
        `regression verdict. reach: ${reachSummary(referenceCell)}`;
      gateB = null;
    }
  }
  console.log(`[B REFERENCE] ${bDetail}  ${verdict(gateB)}`);
  const haveReference = gateB === true;

  // ── Gate C — the `cascadesEnabled` claim at pixels: WebGPU darkens too, and
  // by a comparable amount, in both lighting modes.
  let gateC = null;
  const cNotes = [];
  if (!haveReference) {
    cNotes.push(
      "no WebGL reference (gate B) — a WebGPU verdict here would be scored " +
        "against a broken instrument",
    );
  } else {
    let decided = true;
    let passed = true;
    for (const definition of CELLS.filter((cell) => cell.day)) {
      const glCell = cellOf(webgl, definition.id);
      const gpuCell = cellOf(webgpu, definition.id);
      const glRes = cellResolution(glCell);
      const gpuRes = cellResolution(gpuCell);
      if (!glRes.ok || !gpuRes.ok) {
        decided = false;
        cNotes.push(
          `${definition.id}: unresolved — webgl: ${glRes.why ?? "ok"}; webgpu: ${gpuRes.why ?? "ok"}`,
        );
        continue;
      }
      const glDrop = -glCell.toggle.meanDelta;
      const gpuDrop = -gpuCell.toggle.meanDelta;
      const ratio = gpuDrop / (glDrop === 0 ? Number.EPSILON : glDrop);
      const ok =
        gpuDrop >= PREDICT.dayMeanDropFloor &&
        gpuCell.toggle.darkened >= PREDICT.minShadowPixels &&
        ratio >= PREDICT.dropRatioBand[0] &&
        ratio <= PREDICT.dropRatioBand[1];
      if (!ok) {
        passed = false;
      }
      cNotes.push(
        `${definition.id}: drop webgl=${glDrop.toFixed(2)} webgpu=${gpuDrop.toFixed(2)} ` +
          `ratio predicted ${PREDICT.dropRatioPredicted.toFixed(1)} in ` +
          `[${PREDICT.dropRatioBand}] measured ${ratio.toFixed(2)}; ` +
          `webgpu darkened px ${gpuCell.toggle.darkened} (floor ${PREDICT.minShadowPixels}) ` +
          `${ok ? "OK" : "MISS"}`,
      );
    }
    gateC = decided ? passed : null;
  }
  console.log(`[C RECEIVE]   ${cNotes.join("; ")}  ${verdict(gateC)}`);

  // ── Gate D — the Batch-805 brightening. Decided from the full table, not
  // from a single cell, and guarded by the per-cell A/B/A control.
  let gateD;
  const dNotes = [
    `predicted: no cell RISES; ceiling +${PREDICT.brightenMeanCeiling.toFixed(1)}/255. ` +
      `Batch 805 recorded WebGPU dayOff ~68 -> dayOn ~180 (+112)`,
  ];
  {
    let decided = true;
    let passed = true;
    for (const lane of lanes) {
      for (const definition of CELLS) {
        const cell = cellOf(lane, definition.id);
        const resolution = cellResolution(cell);
        if (!resolution.ok) {
          decided = false;
          dNotes.push(
            `${lane.requested}/${definition.id}: unresolved — ${resolution.why}`,
          );
          continue;
        }
        const rise = cell.toggle.meanDelta;
        if (rise > PREDICT.brightenMeanCeiling) {
          passed = false;
          dNotes.push(
            `${lane.requested}/${definition.id}: BRIGHTENED — off=${cell.toggle.meanOff.toFixed(2)} ` +
              `on=${cell.toggle.meanOn.toFixed(2)} rise=+${rise.toFixed(2)} ` +
              `brightPx=${cell.toggle.brightened} darkPx=${cell.toggle.darkened}`,
          );
        }
      }
    }
    if (decided && passed) {
      dNotes.push(
        "the +112 brightening did NOT reproduce under an A/B/A-controlled " +
          "capture on any cell; every resolved cell moved down or not at all, " +
          "which points at the Batch-805 number being a settle/ordering " +
          "artifact rather than a receive-shader lighting replacement",
      );
    }
    gateD = decided ? passed : null;
  }
  console.log(`[D BRIGHTEN]  ${dNotes.join("; ")}  ${verdict(gateD)}`);

  // ── Gate E — below-horizon cull. Scored per backend, and only for a backend
  // whose own day leg darkened: on a backend where the toggle does nothing at
  // all, "no night delta" is trivially true and would be a false green.
  let gateE;
  const eNotes = [
    `predicted |band mean delta| <= ${PREDICT.nightMeanDeltaCeiling.toFixed(1)} and ` +
      `changed <= ${(PREDICT.nightChangedFraction * 100).toFixed(1)}% of the band, both backends`,
  ];
  {
    let decided = true;
    let passed = true;
    for (const lane of lanes) {
      const dayCell = cellOf(lane, "DAY_UNLIT");
      const nightCell = cellOf(lane, "NIGHT_UNLIT");
      const dayResolution = cellResolution(dayCell);
      const nightResolution = cellResolution(nightCell);
      const dayDarkened =
        dayResolution.ok &&
        -dayCell.toggle.meanDelta >= PREDICT.dayMeanDropFloor;
      if (!dayDarkened) {
        decided = false;
        eNotes.push(
          `${lane.requested}: this backend's own DAY leg did not darken, so a null ` +
            `night delta proves nothing here`,
        );
        continue;
      }
      if (!nightResolution.ok) {
        decided = false;
        eNotes.push(
          `${lane.requested}: night cell unresolved — ${nightResolution.why}`,
        );
        continue;
      }
      const ok =
        Math.abs(nightCell.toggle.meanDelta) <= PREDICT.nightMeanDeltaCeiling &&
        nightCell.toggle.changedFraction <= PREDICT.nightChangedFraction;
      if (!ok) {
        passed = false;
      }
      eNotes.push(
        `${lane.requested}: night delta=${nightCell.toggle.meanDelta.toFixed(2)} ` +
          `changed=${(nightCell.toggle.changedFraction * 100).toFixed(2)}% ` +
          `outOfView=${nightCell.reachOn.outOfView} ` +
          `darkness(public/effective)=${nightCell.reachOn.darknessPublic}/${nightCell.reachOn.darknessEffective} ` +
          `${ok ? "OK" : "MISS"}`,
      );
    }
    gateE = decided ? passed : null;
  }
  console.log(`[E NIGHT]     ${eNotes.join("; ")}  ${verdict(gateE)}`);

  // ── Gate F — clean run.
  const allErrors = [...webgl.errors, ...webgpu.errors];
  const gateF = allErrors.length === 0;
  console.log(
    `[F CLEAN]     predicted 0 console/device errors; measured ${allErrors.length}  ${verdict(gateF)}`,
  );
  if (!gateF) {
    console.log(`  ${allErrors.slice(0, 8).join("\n  ")}`);
  }

  const manifestPath = path.join(OUT, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        site: SITE,
        cells: CELLS,
        predictions: PREDICT,
        webgl: withoutPngs(webgl),
        webgpu: withoutPngs(webgpu),
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
        ? " — one or more legs could not see their subject. Those are instrument" +
          " gaps owed as follow-up, NOT product verdicts, and NOT a pass: exit 3" +
          " so a structural run can never be mistaken for a green one."
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
