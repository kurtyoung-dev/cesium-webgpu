#!/usr/bin/env node
/**
 * C13-N04b — the orbital ladder probe. SOURCE + DESCRIPTOR CONTRACT ONLY.
 * @purpose Capture the cloud disc at each decade from 20 km to 20,000 km and compute O3, O4, O6 and O7, so the orbital rows are graded on statistics rather than on a capture pair.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHY IT EXISTS, AND WHY IT EXISTS FIRST. Campaign 13 v2 makes the orbital band
 * the primary goal and grades three rows on statistics this probe produces:
 * `C13-N20`'s acceptance is "**O3 = 0 measured by C13-N04b**, not an eyeballed
 * capture pair"; `C13-N13` is O7; `C13-N14` is O6/H1/H2. In the draft plan the
 * instrument was a deliverable INSIDE the Wave-4 row it was supposed to judge,
 * while Wave-1 and Wave-3 rows already claimed its numbers. `C13-N04b` pulls it
 * forward so the instrument exists before the rows it grades.
 *
 * WHAT HAS AND HAS NOT RUN. At the batch that lands this file, **no leg of this
 * probe has been executed**: Wave 1 is pure-Node while an Edge job holds the
 * machine, so the source, the statistics in `lib/cloud-orbital-ladder-model.mjs`
 * and the descriptor contract in `cloud-orbital-ladder-contract.spec.mjs` are
 * what landed, and every number in this file's output is still owed. The run
 * recipe is in the landing packet and in the ladder row's ledger entry. Nothing
 * here should be cited as evidence until a receipt exists.
 *
 * THE MEASUREMENT, IN ONE PARAGRAPH. Build one scene with one cloud
 * configuration. Walk the camera up the ladder — 20 km, 200 km, 2,000 km,
 * 20,000 km — and at each rung capture the canvas and read back the uniforms
 * the derivable bars need (`maxSteps` slot 44, `aerialStrength` slot 91,
 * `aerialColor` slots 92-94, `exposure` slot 97). O7 and O3's derivable leg
 * come from those numbers and the geometry; O4 and O6's retention clause come
 * from the pixels. Then run a continuous 10 s zoom across the same range and
 * take the per-frame mean luminance, which is O6's second clause. One browser
 * per run, because a warm shader cache is exactly the confound the ladder's
 * first rung would otherwise inherit.
 *
 * PHOTOMETRY GOES THROUGH THE C13-N09 RULE. Every luminance this probe reports
 * is recovered pre-Reinhard with the sun disc masked, via
 * `lib/cloud-photometry.mjs` and the harness's `photometricContext()`. A mean
 * luminance taken off the canvas bytes is a mean of the tonemapper, and O6's
 * 5 % flicker bar measured that way would be reporting the curve's compression
 * rather than the renderer's stability.
 *
 * WHAT THIS PROBE DELIBERATELY DOES NOT DO. It does not compare backends: the
 * volumetric march is WebGPU-only until `C13-N15c`, so a WebGL arm would be
 * measuring a globe with no clouds on it. It does not score O1 or O5 — those
 * are `C13-N05`'s referee and `lib/cloud-spectrum.mjs`. And it does not derive
 * any threshold: the four bars carry the numbers §1.3 states, and anything the
 * plan marks "derive" is `C13-N47`'s row, not this one's.
 */

import fs from "node:fs";
import path from "node:path";

import { decodePng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  DEFAULT_TRANSFER,
  circularMask,
  inverseReinhard,
  luminance,
  photometricStats,
} from "./lib/cloud-photometry.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import {
  ALTITUDE_LADDER_METRES,
  ORBITAL_BARS,
  evaluateO3,
  evaluateO4,
  evaluateO6Retention,
  evaluateO6ZoomFlicker,
  evaluateO7,
  imageAerialCapFraction,
  limbBand,
  meanCloudAlpha,
} from "./lib/cloud-orbital-ladder-model.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const VIEWPORT = Object.freeze({ width: 1024, height: 1024 });

/**
 * Machine-safety ceiling for one run. Four rungs at 90 settle frames plus a
 * 600-frame zoom leg is minutes of real work, so the budget is generous — its
 * job is to stop a HUNG device, not to bound a slow one.
 */
const WATCHDOG_BUDGET_MS = 15 * 60 * 1000;

/**
 * The scene every rung shares. One configuration for the whole ladder, because
 * O6 is a statement about the SAME field seen from four distances — a rung that
 * changed the deck would be measuring the change, not the altitude.
 */
const LADDER_VOLUMETRIC = Object.freeze({
  cloudCoverage: 0.55,
  cloudDensity: 0.8,
  cloudLayerBottom: 1500,
  cloudLayerTop: 4000,
  cloudWindSpeed: 0,
  cloudWeatherMap: false,
  cloudVolumetricQuality: "high",
});

/** Pinned instant: local solar noon at the anchor longitude, June solstice. */
const LADDER_CLOCK_ISO = "2026-06-21T18:20:00Z";
const LADDER_ANCHOR = Object.freeze({ lon: -95, lat: 20 });

// ---------------------------------------------------------------------------
// Page-side functions. Each is recognisable by a unique marker in its source so
// a stubbed page can dispatch on it; `probe-descriptor-cells-contract.spec.mjs`
// established that convention and `cloud-orbital-ladder-contract.spec.mjs`
// relies on it.
// ---------------------------------------------------------------------------

/* c8 ignore start — page-context functions; exercised on Edge, not in Node */

async function pageBuildLadderScene(config) {
  // __ladderBuildScene
  const viewer = window.viewer;
  const scene = viewer.scene;
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = window.Cesium.JulianDate.fromIso8601(
    config.clockIso,
  );
  const truth = window.__cloudProbe.configure({
    requireWebGPU: true,
    enableVolumetric: true,
    volumetric: config.volumetric,
  });
  return {
    ok: truth.ok,
    rendererType: truth.rendererType,
    renderLoopDisabled: viewer.useDefaultRenderLoop === false,
    deck: {
      bottom: config.volumetric.cloudLayerBottom,
      top: config.volumetric.cloudLayerTop,
    },
  };
}

async function pageMeasureRung(request) {
  // __ladderMeasureRung
  const viewer = window.viewer;
  const scene = viewer.scene;
  const Cesium = window.Cesium;
  scene.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      request.lon,
      request.lat,
      request.altitudeMetres,
    ),
    orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
  });
  for (let frame = 0; frame < request.settleFrames; frame++) {
    scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const context = scene.context;
  const uniforms = context?._cloudCache?.uniformData;
  const photometry = window.__cloudProbe.photometricContext();
  const canvas = scene.canvas;
  const fovy = scene.camera.frustum.fovy;
  const planetRadius = scene.globe.ellipsoid.maximumRadius;
  // Angular radius of the planet from this altitude, and whether the whole
  // silhouette is inside the frame. Below the altitude where it is, there is no
  // limb in the capture and O4 is not evaluable — which is a fact about the
  // rung, not a failure of the probe.
  const angularRadius = Math.asin(
    planetRadius / (planetRadius + request.altitudeMetres),
  );
  const pixelsPerRadian = canvas.height / 2 / Math.tan(fovy / 2);
  return {
    altitudeMetres: request.altitudeMetres,
    width: canvas.width,
    height: canvas.height,
    photometry,
    limb: {
      visible: angularRadius < fovy / 2,
      angularRadiusRadians: angularRadius,
      centreX: canvas.width / 2,
      centreY: canvas.height / 2,
      radiusPixels: Math.tan(angularRadius) * pixelsPerRadian,
      pixelsPerRadian,
    },
    uniforms: {
      primarySteps: uniforms ? uniforms[44] : null,
      lightSteps: uniforms ? uniforms[45] : null,
      aerialStrength: uniforms ? uniforms[91] : null,
      aerialColor: uniforms
        ? { r: uniforms[92], g: uniforms[93], b: uniforms[94] }
        : null,
      exposure: uniforms ? uniforms[97] : null,
    },
  };
}

async function pageZoomSeries(request) {
  // __ladderZoomSeries
  const viewer = window.viewer;
  const scene = viewer.scene;
  const Cesium = window.Cesium;

  // The canonical same-task capture primitive, embedded verbatim from
  // `lib/same-task-capture.mjs`. It is embedded rather than imported because
  // `page.evaluate` serializes this function's source and a Playwright page
  // cannot import a Node module.
  //
  // THIS IS NOT AN OPTIMIZATION, IT IS THE CORRECTNESS RULE. A first draft of
  // this leg did `ctx.drawImage(scene.canvas, 0, 0)` after the frame's rAF,
  // to avoid a PNG encode per frame. `probe-fleet-contract.spec.mjs` C14
  // caught it: after presentation the WebGPU swap-chain texture is
  // INVALIDATED, so a deferred read of the live canvas can return an empty or
  // stale surface — and a flicker statistic computed from stale frames would
  // have read as beautifully stable. `captureNow()` renders and snapshots in
  // ONE task, which is what makes the bytes real.
  // ==BEGIN same-task-capture==
  const makeSameTaskCapture = (scene, canvas, timeFn) => {
    const renderNow = () => scene.render(timeFn());
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decodeSnapshot = async (snapshot) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        const decodeFailed = "same-task PNG decode failed";
        image.onload = resolve;
        image.onerror = () => reject(new Error(decodeFailed));
      });
      image.src = snapshot;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const snapshotNow = () => {
      renderNow();
      return canvas.toDataURL("image/png");
    };
    const captureNow = () => {
      const snapshot = snapshotNow();
      return decodeSnapshot(snapshot);
    };
    const grabNow = snapshotNow;
    const settleThen = async (maxFrames, done, capture) => {
      let settled = false;
      for (let k = 0; k < maxFrames; k++) {
        if (typeof done === "function" && done() === true) {
          settled = true;
          break;
        }
        renderNow();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!settled && typeof done === "function") {
        settled = done() === true;
      }
      const hasCapture = typeof capture === "function";
      const result = hasCapture ? await capture() : undefined;
      return { settled, result };
    };
    return { renderNow, captureNow, grabNow, settleThen };
  };
  // ==END same-task-capture==
  const sameTask = makeSameTaskCapture(
    scene,
    scene.canvas,
    () => viewer.clock.currentTime,
  );

  const series = [];
  const steps = request.frames;
  const logLow = Math.log(request.fromMetres);
  const logHigh = Math.log(request.toMetres);
  for (let frame = 0; frame < steps; frame++) {
    // Logarithmic, so the zoom spends equal time in each decade. A linear
    // zoom crosses the first three decades in its first few frames and would
    // report a flicker statistic dominated by the last one.
    const altitude = Math.exp(
      logLow + ((logHigh - logLow) * frame) / (steps - 1),
    );
    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        request.lon,
        request.lat,
        altitude,
      ),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    const image = await sameTask.captureNow();
    const data = image.data;
    const pixels = image.width * image.height;
    let sum = 0;
    let saturated = 0;
    for (let index = 0; index < pixels; index++) {
      const base = index * 4;
      const r = data[base] / 255;
      const g = data[base + 1] / 255;
      const b = data[base + 2] / 255;
      if (r >= 1 || g >= 1 || b >= 1) {
        saturated++;
      }
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    series.push({
      altitudeMetres: altitude,
      // DISPLAY-space mean. The inverse is applied on the Node side by the
      // one implementation of the C13-N09 rule, rather than copied into this
      // injected function where it could drift out of step with it.
      meanDisplayLuminance: sum / pixels,
      saturatedFraction: saturated / pixels,
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return { series, photometry: window.__cloudProbe.photometricContext() };
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Node-side reduction
// ---------------------------------------------------------------------------

/**
 * Pre-Reinhard luminance per pixel, with the sun disc zeroed out of the mask.
 *
 * Saturated pixels are excluded from the MASK rather than clamped, so they can
 * neither enter a mean nor be inverted into an arbitrarily large number — the
 * C13-N09 rule, applied per pixel instead of per ROI.
 */
function radianceField(rgba, { width, height, exposure, sunMask, transfer }) {
  const decode =
    transfer === "srgb"
      ? (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      : (v) => v;
  const field = new Float64Array(width * height);
  const valid = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index++) {
    if (sunMask && sunMask.data[index] === 1) {
      continue;
    }
    const base = index * 4;
    const r = decode(rgba[base] / 255);
    const g = decode(rgba[base + 1] / 255);
    const b = decode(rgba[base + 2] / 255);
    if (r >= 1 || g >= 1 || b >= 1) {
      continue;
    }
    field[index] = luminance(
      inverseReinhard(r, exposure),
      inverseReinhard(g, exposure),
      inverseReinhard(b, exposure),
    );
    valid[index] = 1;
  }
  return { field, valid };
}

/**
 * Which pixels carry cloud. Alpha where the capture has it; otherwise the
 * pixels brighter than the frame's own median, which is a coverage proxy rather
 * than a cloud mask and is labelled as such in the receipt.
 */
function cloudMaskFrom(rgba, { width, height }) {
  let anyAlpha = false;
  for (let index = 0; index < width * height; index++) {
    if (rgba[index * 4 + 3] < 255) {
      anyAlpha = true;
      break;
    }
  }
  const mask = new Uint8Array(width * height);
  if (anyAlpha) {
    for (let index = 0; index < width * height; index++) {
      mask[index] = rgba[index * 4 + 3] > 8 ? 1 : 0;
    }
    return { mask, basis: "capture-alpha" };
  }
  const values = [];
  for (let index = 0; index < width * height; index++) {
    const base = index * 4;
    values.push(
      luminance(rgba[base] / 255, rgba[base + 1] / 255, rgba[base + 2] / 255),
    );
  }
  const sorted = [...values].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.75)];
  for (let index = 0; index < values.length; index++) {
    mask[index] = values[index] >= threshold ? 1 : 0;
  }
  return { mask, basis: "luminance-upper-quartile" };
}

/** Reduce one rung's capture and page readback into the four bars' inputs. */
export function reduceRung({ decoded, measurement, deck }) {
  const { width, height } = measurement;
  const photometry = measurement.photometry;
  if (!photometry?.ok || !(photometry.exposure > 0)) {
    throw new ProbeRefusal(
      "photometric-context-unavailable",
      `rung ${measurement.altitudeMetres} m: ${
        photometry?.reasons?.join("; ") ?? "no photometric context"
      }. Every luminance this probe reports must be pre-Reinhard (C13-N09); ` +
        "without the live exposure there is nothing to invert against.",
      { altitudeMetres: measurement.altitudeMetres, photometry },
    );
  }
  const sunMask =
    photometry.sunDisc?.visible === true
      ? circularMask({
          width,
          height,
          centreX: photometry.sunDisc.x,
          centreY: photometry.sunDisc.y,
          radiusPixels: photometry.sunDisc.radiusPixels,
        })
      : null;

  const { mask, basis } = cloudMaskFrom(decoded.data, { width, height });
  const alpha = meanCloudAlpha(decoded.data, {
    width,
    height,
    cloudMask: mask,
  });
  const { field } = radianceField(decoded.data, {
    width,
    height,
    exposure: photometry.exposure,
    sunMask,
    transfer: photometry.transfer ?? DEFAULT_TRANSFER,
  });

  const o7 = evaluateO7({
    primarySteps: measurement.uniforms.primarySteps,
    deckTopMetres: deck.top,
    deckBottomMetres: deck.bottom,
  });
  const o3 = evaluateO3({
    cameraAltitudeMetres: measurement.altitudeMetres,
    deckTopMetres: deck.top,
    deckBottomMetres: deck.bottom,
    aerialStrength: measurement.uniforms.aerialStrength,
    imageCappedFraction: measurement.uniforms.aerialColor
      ? imageAerialCapFraction(decoded.data, {
          width,
          height,
          cloudMask: mask,
          aerialColor: measurement.uniforms.aerialColor,
        }).fraction
      : null,
  });
  const o4 = measurement.limb.visible
    ? evaluateO4({
        luminanceField: field,
        width,
        height,
        band: limbBand({
          width,
          height,
          centreX: measurement.limb.centreX,
          centreY: measurement.limb.centreY,
          radiusPixels: measurement.limb.radiusPixels,
          // "view-angle" is the reading under which O4 is computable as
          // written; see limbBand for why, and for what changes if C13-29
          // rules for the surface-arc reading instead.
          mode: "view-angle",
          pixelsPerRadian: measurement.limb.pixelsPerRadian,
        }).band,
      })
    : {
        bar: "O4",
        kind: "measured",
        pass: null,
        reason: `the planet's angular radius exceeds the frustum at ${measurement.altitudeMetres} m, so no limb is in frame`,
      };

  const photometricSummary = photometricStats(decoded.data, {
    width,
    height,
    exposure: photometry.exposure,
    transfer: photometry.transfer ?? DEFAULT_TRANSFER,
    sunDiscMask: sunMask,
  });

  return {
    altitudeMetres: measurement.altitudeMetres,
    uniforms: measurement.uniforms,
    limb: measurement.limb,
    cloudMaskBasis: basis,
    meanCloudAlpha: alpha.meanAlpha,
    coverageFraction: alpha.coverageFraction,
    meanLuminance: photometricSummary.meanLuminance,
    saturatedFraction: photometricSummary.saturatedFraction,
    sunDiscMasked: photometricSummary.provenance.sunDiscMasked,
    o3,
    o4,
    o7,
  };
}

/**
 * The zoom leg's per-frame mean, brought into radiance by the one
 * implementation of the C13-N09 rule.
 *
 * LIMITATION, STATED: this is the inverse of the FRAME MEAN, not the mean of
 * the per-pixel inverses, and the two differ because Reinhard is non-linear.
 * It is used here only for O6's second clause, which is a frame-to-frame
 * STABILITY statistic — the inverse is smooth and strictly increasing, so a
 * series transformed through it preserves the ordering and the relative size
 * of frame-to-frame changes, which is what an RMS dL is made of. It is NOT a
 * radiometrically exact scene mean and must not be quoted as one; the per-rung
 * `meanLuminance` (computed per pixel by `photometricStats`) is the exact one.
 */
export function zoomLuminanceSeries(zoom) {
  const series = zoom?.series;
  if (!Array.isArray(series) || series.length < 2) {
    return null;
  }
  const exposure = zoom?.photometry?.exposure;
  if (!(exposure > 0)) {
    return null;
  }
  const values = [];
  for (const frame of series) {
    const mean = frame?.meanDisplayLuminance;
    if (typeof mean !== "number" || !Number.isFinite(mean) || mean >= 1) {
      // A frame whose mean is saturated carries no recoverable radiance; the
      // series is abandoned rather than silently shortened, because a gap in a
      // per-frame difference series manufactures a step that never happened.
      return null;
    }
    values.push(inverseReinhard(mean, exposure));
  }
  return values;
}

function verdictsFor(runCells) {
  const rungs = runCells.rungs;
  const retention = evaluateO6Retention(rungs);
  const series = runCells.zoom?.meanLuminancePerFrame;
  const flicker =
    Array.isArray(series) && series.length >= 2
      ? evaluateO6ZoomFlicker(series)
      : {
          bar: "O6",
          clause: "zoom-flicker",
          pass: null,
          reason:
            "the zoom leg produced no usable luminance series (absent, too short, " +
            "or saturated), so O6's stability clause was not measured — reported " +
            "rather than scored, because a zero-filled series would read as a " +
            "perfect 0 % flicker and pass the clause by construction",
        };
  const applicableO3 = rungs.filter((rung) => rung.o3.applies);
  const applicableO4 = rungs.filter((rung) => rung.o4.pass !== null);
  return [
    {
      id: "O3",
      claim: `no cloud pixel sits at the aerial cap at or above ${
        ORBITAL_BARS.O3.appliesAboveMetres / 1000
      } km`,
      pass:
        applicableO3.length > 0 &&
        applicableO3.every((rung) => rung.o3.pass === true),
      detail: applicableO3.map((rung) => ({
        altitudeMetres: rung.altitudeMetres,
        derived: rung.o3.derivedCappedFraction,
        image: rung.o3.imageCappedFraction,
        capDistanceMetres: rung.o3.capDistanceMetres,
      })),
    },
    {
      id: "O4",
      claim: `no 2-px luminance step within 5 deg of the limb exceeds ${
        ORBITAL_BARS.O4.target * 100
      } % of the local mean`,
      pass:
        applicableO4.length > 0 &&
        applicableO4.every((rung) => rung.o4.pass === true),
      detail: applicableO4.map((rung) => ({
        altitudeMetres: rung.altitudeMetres,
        normalizedStep: rung.o4.normalizedStep,
      })),
    },
    {
      id: "O6",
      claim: `every decade retains >= ${
        ORBITAL_BARS.O6.retentionTarget * 100
      } % of the 20 km mean cloud alpha, and a 10 s zoom's RMS dL stays under ${
        ORBITAL_BARS.O6.zoomRmsTarget * 100
      } %`,
      // Not-evaluable is `null`, not `false`: a clause nobody measured is not
      // a renderer defect, and recording it as one is how a real red gets lost
      // among manufactured ones.
      pass:
        retention.pass === null || flicker.pass === null
          ? null
          : retention.pass === true && flicker.pass === true,
      detail: { retention, flicker },
    },
    {
      id: "O7",
      claim: `fine samples along the limb chord are no more than ${
        ORBITAL_BARS.O7.targetMetres / 1000
      } km apart`,
      pass: rungs.length > 0 && rungs.every((rung) => rung.o7.pass === true),
      detail: rungs.map((rung) => ({
        altitudeMetres: rung.altitudeMetres,
        spacingMetres: rung.o7.spacingMetres,
        primarySteps: rung.o7.primarySteps,
        stepsRequired: rung.o7.stepsRequired,
      })),
    },
  ];
}

// ---------------------------------------------------------------------------
// The descriptor the shared runtime executes
// ---------------------------------------------------------------------------

export const descriptor = {
  name: "cloud-orbital-ladder",
  title:
    "Cloud orbital ladder — O3/O4/O6/O7 at each decade 20 km to 20,000 km (C13-N04b)",
  outputSubdirectory: "",
  receiptEnvelope: "probe-owned",
  // No `workBudgetMs`: declaring it adopts the lifecycle path, and
  // `C13-42a-3` item 8 records a hole in that path where a malformed
  // `scope.run` third argument silently drops the work and the run reports
  // success. Lane L1 is closing it; the plan sequences item 8 BEFORE migrating
  // any probe onto the runtime, for the reason that migrating first banks
  // results nobody can rely on. A brand-new probe is in exactly that position,
  // so it stays on the pre-adoption path until item 8 lands and adopts under
  // `C13-42a-2`.
  args: {
    extraOptions: [
      // 10 s at 60 Hz is O6's own window; a shorter leg reports a flicker
      // statistic over a window the bar does not describe.
      {
        flag: "--zoom-frames",
        key: "zoomFrames",
        kind: "positive-integer",
        default: 600,
      },
      {
        flag: "--settle-frames",
        key: "settleFrames",
        kind: "positive-integer",
        default: 90,
      },
    ],
  },
  async cells({ browser, options, origin, outputDirectory }) {
    // MACHINE SAFETY. The pre-adoption runtime path carries no deadline (the
    // lifecycle's `workBudgetMs` is deliberately not declared — see the note on
    // the descriptor), and this probe drives a 600-frame zoom leg. A hung device
    // with no ceiling is how a background Edge probe takes the machine with it.
    const work = (async () => {
      fs.mkdirSync(outputDirectory, { recursive: true });
      if (!options.renderers.includes("webgpu")) {
        throw new ProbeRefusal(
          "renderer-unavailable",
          "the volumetric march is WebGPU-only until C13-N15c lands the GLSL shell, so " +
            `an orbital ladder on ${options.renderers.join(",")} would measure a globe ` +
            "with no clouds on it",
          { renderers: options.renderers },
        );
      }

      const page = await browser.newPage({ viewport: VIEWPORT });
      const consoleErrors = attachConsoleErrorGate(page);
      await page.addInitScript(errorGateInit);
      await page.addInitScript(installCloudProbeHarness);
      await page.goto(
        `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
        {
          waitUntil: "networkidle",
          timeout: 120000,
        },
      );
      await page.waitForFunction(() => !!window.viewer, { timeout: 120000 });
      // Arm BEFORE the first cloud frame: a validation error raised while the
      // march is compiling its first pipeline is exactly the fault this ladder
      // would otherwise report as a dark rung.
      await armWebGPUDevices(page);

      const scene = await page.evaluate(pageBuildLadderScene, {
        clockIso: LADDER_CLOCK_ISO,
        volumetric: LADDER_VOLUMETRIC,
      });
      if (!scene.ok || scene.renderLoopDisabled !== true) {
        throw new ProbeRefusal(
          "scene-not-owned",
          "the ladder must own every frame it measures; the viewer's own render loop was " +
            "still running or the cloud configuration did not round-trip",
          { scene },
        );
      }

      const rungs = [];
      for (const altitudeMetres of ALTITUDE_LADDER_METRES) {
        const measurement = await page.evaluate(pageMeasureRung, {
          altitudeMetres,
          lon: LADDER_ANCHOR.lon,
          lat: LADDER_ANCHOR.lat,
          settleFrames: options.settleFrames,
        });
        const buffer = await page.locator("canvas").first().screenshot();
        const file = path.join(
          outputDirectory,
          `cloud-orbital-ladder-${altitudeMetres}m.png`,
        );
        fs.writeFileSync(file, buffer);
        rungs.push(
          reduceRung({
            decoded: decodePng(buffer),
            measurement,
            deck: scene.deck,
          }),
        );
      }

      const zoom = await page.evaluate(pageZoomSeries, {
        lon: LADDER_ANCHOR.lon,
        lat: LADDER_ANCHOR.lat,
        fromMetres: ALTITUDE_LADDER_METRES[0],
        toMetres: ALTITUDE_LADDER_METRES[ALTITUDE_LADDER_METRES.length - 1],
        frames: options.zoomFrames,
      });

      return [
        {
          rungs,
          zoom: {
            frames: zoom.series.length,
            meanLuminancePerFrame: zoomLuminanceSeries(zoom),
            altitudes: zoom.series.map((entry) => entry.altitudeMetres),
          },
          consoleErrors: [...consoleErrors],
          deviceGate: await collectGateErrors(page),
        },
      ];
    })();
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-cloud-orbital-ladder exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              { budgetMs: WATCHDOG_BUDGET_MS },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
    }
  },
  receipt(cells, context) {
    return {
      base: context.origin,
      bars: ORBITAL_BARS,
      ladderMetres: ALTITUDE_LADDER_METRES,
      volumetric: LADDER_VOLUMETRIC,
      clockIso: LADDER_CLOCK_ISO,
      runs: cells,
    };
  },
  verdicts(cells) {
    const perRun = cells.map((run) => verdictsFor(run));
    const ids = perRun[0].map((verdict) => verdict.id);
    return ids.map((id, index) => ({
      id,
      claim: perRun[0][index].claim,
      // The WORST run carries the verdict: one lucky ladder is not evidence
      // that the next one holds.
      pass: perRun.every((verdicts) => verdicts[index].pass),
      detail: perRun.map((verdicts) => verdicts[index].detail),
    }));
  },
  summary(receipt) {
    const lines = [
      "# Cloud orbital ladder (C13-N04b)",
      "",
      `Base: \`${receipt.base}\``,
      "",
      "| altitude | steps | O7 spacing | O3 derived | O3 image | O4 step | mean alpha | sat. frac |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const run of receipt.runs) {
      for (const rung of run.rungs) {
        const km = (rung.altitudeMetres / 1000).toFixed(0);
        lines.push(
          `| ${km} km | ${rung.o7.primarySteps ?? "n/a"} | ${(
            rung.o7.spacingMetres / 1000
          ).toFixed(2)} km | ${rung.o3.derivedCappedFraction ?? "—"} | ${
            rung.o3.imageCappedFraction === null
              ? "—"
              : rung.o3.imageCappedFraction.toFixed(3)
          } | ${
            rung.o4.normalizedStep === null ||
            rung.o4.normalizedStep === undefined
              ? "n/a"
              : rung.o4.normalizedStep.toFixed(3)
          } | ${rung.meanCloudAlpha.toFixed(4)} | ${
            rung.saturatedFraction === null
              ? "—"
              : rung.saturatedFraction.toFixed(4)
          } |`,
        );
      }
    }
    lines.push("");
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
