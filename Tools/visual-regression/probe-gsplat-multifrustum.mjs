#!/usr/bin/env node
/**
 * C15-G6 Gaussian-splat multi-frustum acquisition probe.
 * @purpose Acquire counter-grounded multi-frustum tower/globe evidence and lazily score the dual-backend splat/globe/background label partition.
 * @status ACTIVE
 *
 * This file is acquisition only. It has never been run, its landing claims no
 * verdict, and only an authorized machine-lane run against an already-served
 * build can earn one. The probe does not start a server or build Cesium.
 *
 * The framing deliberately forces `scene.logarithmicDepthFarToNearRatio` to 2
 * instead of the engine default of 1e9. The default collapses this scene to one
 * band (the recorded B889 collapse), so this instrument addresses the row only
 * under a deliberately non-production depth partition.
 *
 * With that ratio forced to 2, merely reaching two active frusta is nearly
 * free: almost any far camera over a globe splits. The discriminating evidence
 * is the library's selective-binning standing: the bounded splat occupies at
 * least one but not all bands (`bounded-splat:not-selectively-binned`), some
 * clean band holds both globe and splat
 * (`clean:no-shared-globe-splat-band`), and the suppressed control populates
 * every band (`negative:splat-not-in-every-band` when absent), including at
 * least one splat-only band (`negative:no-splat-only-band` when absent). Two
 * frusta alone are not evidence of the subject.
 *
 * The framing also removes imagery, installs an ellipsoid terrain provider,
 * disables globe lighting and ground atmosphere, and uses a flat globe base
 * colour. That is not the default globe; it makes the three-way pixel labels
 * decidable.
 *
 * The embedded page helpers are behaviour-and-token pinned, not byte pinned.
 * Repository formatting reflows their declaration-form copy at this embedding
 * depth, so the browser-free spec executes identical fixtures against both
 * copies and admits only whitespace reflow outside string/template literals.
 *
 * This probe interprets “same pixels occluded on both” as agreement of the
 * per-pixel background/globe/splat producer label. A far-nadir frame may
 * honestly contain no pixel where the globe hides a splat, so a hidden-pixel
 * count could be zero on both sides and agree vacuously; the label partition
 * instead records which producer wins every pixel.
 *
 * Tier routing for absent splat pixels is pre-registered by maintainer ruling
 * R-2026-08-24-14, taken before any machine run. If exactly one backend
 * composes splat-coloured pixels and the other composes none - both having
 * produced a settled frame with at least one splat command - the lane SAW its
 * subject and the subject failed: that is tier 1 FAIL (exit 1), reported as
 * `${backend}:labels:zero-splat-asymmetric`, and it is the row's headline
 * defect. If BOTH backends compose none, the lane never saw the subject at
 * all: that stays tier 3 STRUCTURAL (exit 3) as
 * `${backend}:labels:zero-splat`.
 *
 * Ruling R-2026-08-24-16 fixes the precedence between that FAIL and the
 * anti-vacuity reasons. On the backend that composed nothing, its own
 * `labels:zero-globe` and `labels:single-label-frame` are CONSEQUENCES of the
 * same compose failure, not independent blindness, so they do not demote the
 * verdict; they are published as diagnostics and the run stays FAIL exit 1.
 * UNRELATED blindness still outranks: a corner-background mismatch, an invalid
 * RGBA frame, mismatched frame dimensions, an unproven settled frame on either
 * backend, or a capture-contract or framing-agreement failure all demote the
 * run to exit 3. Where that demotion comes from decides whether the compose
 * failure stays legible: a LABEL-layer structural (dimensions, corner, invalid
 * frame) is raised by the same evaluator that found the asymmetry, so the
 * reason survives in `topology.failures`; a FRAMING-layer structural (unproven
 * settled frame, framing disagreement) short-circuits the deliberately lazy
 * occlusion reader before any pixel is examined, so no topology record exists
 * at all and the artifact carries only the framing reason.
 *
 * The scene is deliberately re-framed in depth. The framing library pins the
 * camera - nadir, heading 0, at the range that makes the tower bounding sphere
 * occupy a fixed fraction of viewport height - so the scene near plane is
 * always `range - radius` and, at the forced ratio of 2, the first band
 * boundary is always `2 * (range - radius)`. The tower asset's authored
 * content stands 2,852 m above its own georeferenced origin; at that altitude
 * the globe sits roughly 4 km from the camera while the tower sits 1.2 km from
 * it, so the two occupy disjoint bands and the row's second clause - the splat
 * cloud composing over the globe - cannot hold no matter how many frusta the
 * first clause opens. The probe therefore translates the tileset along its
 * local up until the camera sits one derived margin BELOW the first band
 * boundary. Every globe bounding volume brackets the camera altitude along the
 * view direction, so its near then falls in band 0 beside the splat and its
 * inflated far opens band 1: both clauses hold at once, for every globe depth
 * extent including none measurable at all, and without touching the camera
 * the library pins.
 *
 * That margin is derived, not tuned. Its upper bound is the engine's own far
 * inflation - `View.js updateFrustums` multiplies the scene far plane by
 * `1.0 + CesiumMath.EPSILON2` - past which a globe with no measurable depth
 * extent stops opening a second band; its lower bound is the bounding-volume
 * centre offset the placement has to absorb. The landed constant is the
 * midpoint, which maximises the symmetric offset tolerance.
 *
 * The retarget changes no projected geometry: the range derivation reads only
 * the bounding-sphere radius and the field of view, both untouched by a
 * translation, so the projected disc, its perimeter and every registration
 * ratio below are byte-identical to the pre-retarget instrument. The
 * disagreement bar does not move.
 *
 * The landed range formula maps the configured fraction to NDC radius: the
 * tower bounding-sphere radius is 0.05 times viewport height and its diameter
 * is 0.1 times viewport height. At 1280 by 720, the corrected analytic disc is
 * 0.4418% of the canvas and its one-pixel perimeter is 0.0245%.
 *
 * Recorded erratum: the brief treated the radius as 0.1 times viewport height,
 * implying a 1.7672% disc and a 0.0491% one-pixel perimeter. That registered
 * model is superseded by the landed code, but the artifact retains both models
 * so the correction is explicit.
 *
 * The exported disagreement bar is PRE-REGISTERED and UNCALIBRATED because
 * this authoring lane does not run the probe. It is 10.185916 times the
 * corrected one-pixel perimeter, while the corrected full disc is only
 * 1.767146 times the bar. The bar-to-disc separation is therefore much thinner
 * than the registration assumed. A first machine-lane measurement in that
 * landed-geometry region is the finding, not a reason to move or widen the bar.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  GSPLAT_MULTIFRUSTUM_CONFIG,
  GSPLAT_MULTIFRUSTUM_SCHEMA,
  evaluateGsplatMultifrustumFraming,
} from "./lib/gsplat-multifrustum-framing.mjs";
import {
  FUSED_SNAPSHOT_BEGIN,
  FUSED_SNAPSHOT_END,
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const probeSourcePath = fileURLToPath(import.meta.url);
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputRoot = path.resolve(
  process.env.C15_G6_OUTPUT_DIR ??
    path.join(toolDirectory, "output/gsplat-multifrustum"),
);
const VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const RUN_WATCHDOG_MS = 300_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const PROCESS_WATCHDOG_MS =
  BROWSER_LAUNCH_TIMEOUT_MS +
  RUN_WATCHDOG_MS +
  BROWSER_CLOSE_TIMEOUT_MS +
  60_000;

// ==BEGIN gsplat-multifrustum-node-model==
// The landed range maps f to NDC radius, or fH/2 pixels: its analytic disc is
// pi*(f/2)^2*H/W and its one-pixel perimeter is pi*f/W. The registered brief
// instead treated radius as fH. The registration record publishes that model
// as an erratum after the corrected projection; neither analytic disc is a
// measured splat-cloud footprint, and the uncalibrated bar does not move.
export const MAX_LABEL_DISAGREEMENT_FRACTION = 0.0025;

// `View.js updateFrustums` inflates the accumulated scene far plane by
// `1.0 + CesiumMath.EPSILON2` before splitting it, and `CesiumMath.EPSILON2`
// is 0.01. That inflation is what still opens a second band when the globe's
// bounding volumes have no measurable depth extent at all.
export const SCENE_FAR_INFLATION = 0.01;

// Seat the camera this fraction below the first band boundary. Above
// `1 - 1 / (1 + SCENE_FAR_INFLATION)` a zero-extent globe no longer inflates
// past the boundary and the second band is lost; below the bounding-volume
// centre offset the placement must absorb, the globe no longer reaches band 0
// and the shared band is lost. The midpoint maximises the symmetric offset
// tolerance, so this constant is derived from the engine rather than tuned
// against a measurement.
export const TOWER_BOUNDARY_MARGIN_FRACTION =
  SCENE_FAR_INFLATION / (2 * (1 + SCENE_FAR_INFLATION));

// How much of the placement's own offset budget the achieved tower altitude is
// allowed to consume. A tenth leaves the budget itself intact while still
// catching a move that never happened, which is off by the whole stand-off.
export const TOWER_ALTITUDE_TOLERANCE_DIVISOR = 10;

/**
 * The altitude window the achieved tower placement has to land inside.
 *
 * Kept beside the derivation so the page that publishes the number and the
 * evaluator that re-derives it cannot drift apart; the evaluator never judges
 * against the published value.
 */
export function deriveTowerAltitudeToleranceMeters(
  boundaryOffsetToleranceMeters,
) {
  return Number.isFinite(boundaryOffsetToleranceMeters)
    ? boundaryOffsetToleranceMeters / TOWER_ALTITUDE_TOLERANCE_DIVISOR
    : null;
}

/**
 * Derive the tower altitude at which both row clauses hold simultaneously.
 *
 * Only the tower's altitude is free - the library pins heading, pitch, the
 * viewport fraction and the range derivation - and moving the tower moves the
 * camera with it, because the camera is placed relative to the tileset's
 * bounding sphere. The scene near plane therefore stays `range - radius` and
 * the first band boundary stays `2 * (range - radius)` whatever altitude is
 * chosen, which is what makes a closed-form target possible.
 */
export function deriveGsplatTowerDepthRetarget(range, radius) {
  if (
    !Number.isFinite(range) ||
    range <= 0 ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return {
      structural: ["retarget:framing-scalars-invalid"],
      sceneNearMeters: null,
      firstBandBoundaryMeters: null,
      boundaryMarginFraction: TOWER_BOUNDARY_MARGIN_FRACTION,
      boundaryOffsetToleranceMeters: null,
      splatFarMeters: null,
      targetCameraAltitudeMeters: null,
      targetTowerAltitudeMeters: null,
    };
  }
  const structural = [];
  const sceneNearMeters = range - radius;
  const firstBandBoundaryMeters = 2 * sceneNearMeters;
  const splatFarMeters = range + radius;
  const targetCameraAltitudeMeters =
    firstBandBoundaryMeters * (1 - TOWER_BOUNDARY_MARGIN_FRACTION);
  const targetTowerAltitudeMeters = targetCameraAltitudeMeters - range;
  // The tower's own depth extent has to stay wholly inside band 0, otherwise
  // the splat is binned into every band and stops being selectively binned.
  if (!(splatFarMeters < firstBandBoundaryMeters)) {
    structural.push("retarget:splat-extent-reaches-first-band-boundary");
  }
  // The whole bounding sphere has to clear the ellipsoid, or the tower is
  // buried in the globe it is supposed to compose over.
  if (!(targetTowerAltitudeMeters > radius)) {
    structural.push("retarget:target-tower-altitude-below-bounding-radius");
  }
  return {
    structural,
    sceneNearMeters,
    firstBandBoundaryMeters,
    boundaryMarginFraction: TOWER_BOUNDARY_MARGIN_FRACTION,
    boundaryOffsetToleranceMeters:
      firstBandBoundaryMeters * TOWER_BOUNDARY_MARGIN_FRACTION,
    splatFarMeters,
    targetCameraAltitudeMeters,
    targetTowerAltitudeMeters,
  };
}

const BACKGROUND_REFERENCE = Object.freeze([16, 16, 20]);
const GLOBE_REFERENCE = Object.freeze([38, 38, 44]);
const REFERENCE_COLOR_TOLERANCE = 12;
const LABEL_BACKGROUND = 0;
const LABEL_GLOBE = 1;
const LABEL_SPLAT = 2;

function maxReferenceDelta(data, offset, reference) {
  return Math.max(
    Math.abs(data[offset] - reference[0]),
    Math.abs(data[offset + 1] - reference[1]),
    Math.abs(data[offset + 2] - reference[2]),
  );
}

export function partitionGsplatTopologyFrame(frame, backend = "frame") {
  const width = frame?.width;
  const height = frame?.height;
  const data = frame?.data;
  const totalPixels = width * height;
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    !data ||
    typeof data.length !== "number" ||
    data.length !== totalPixels * 4
  ) {
    return {
      valid: false,
      structural: [`${backend}:labels:rgba-frame-invalid`],
      width: Number.isInteger(width) ? width : null,
      height: Number.isInteger(height) ? height : null,
      totalPixels: Number.isFinite(totalPixels) ? totalPixels : null,
      counts: null,
      corner: null,
      labels: null,
    };
  }
  const cornerRgb = [data[0], data[1], data[2]];
  const cornerBackgroundMaximumChannelDelta = maxReferenceDelta(
    data,
    0,
    BACKGROUND_REFERENCE,
  );
  const corner = {
    x: 0,
    y: 0,
    rgb: cornerRgb,
    backgroundMaximumChannelDelta: cornerBackgroundMaximumChannelDelta,
    withinBackgroundTolerance:
      cornerBackgroundMaximumChannelDelta <= REFERENCE_COLOR_TOLERANCE,
  };
  const labels = new Uint8Array(totalPixels);
  const counts = { background: 0, globe: 0, splat: 0 };
  for (let pixel = 0, offset = 0; pixel < totalPixels; pixel++, offset += 4) {
    let label = LABEL_SPLAT;
    if (
      maxReferenceDelta(data, offset, BACKGROUND_REFERENCE) <=
      REFERENCE_COLOR_TOLERANCE
    ) {
      label = LABEL_BACKGROUND;
      counts.background++;
    } else if (
      maxReferenceDelta(data, offset, GLOBE_REFERENCE) <=
      REFERENCE_COLOR_TOLERANCE
    ) {
      label = LABEL_GLOBE;
      counts.globe++;
    } else {
      counts.splat++;
    }
    labels[pixel] = label;
  }
  return {
    valid: true,
    structural: [],
    width,
    height,
    totalPixels,
    counts,
    corner,
    labels,
  };
}

export function deriveGsplatTopologyRegistration(width, height) {
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1
  ) {
    throw new RangeError("topology registration requires positive dimensions");
  }
  const viewportHeightFraction =
    GSPLAT_MULTIFRUSTUM_CONFIG.towerViewportHeightFraction;
  const registeredProjectedRadiusPixels = viewportHeightFraction * height;
  const registeredProjectedDiscAreaFraction =
    (Math.PI *
      registeredProjectedRadiusPixels *
      registeredProjectedRadiusPixels) /
    (width * height);
  const registeredPerimeterPixels =
    2 * Math.PI * registeredProjectedRadiusPixels;
  const registeredPerimeterFraction =
    registeredPerimeterPixels / (width * height);
  const actualProjectedRadiusPixels = registeredProjectedRadiusPixels / 2;
  const actualProjectedDiscAreaFraction =
    (Math.PI * actualProjectedRadiusPixels * actualProjectedRadiusPixels) /
    (width * height);
  const actualPerimeterPixels = 2 * Math.PI * actualProjectedRadiusPixels;
  const actualPerimeterFraction = actualPerimeterPixels / (width * height);
  return {
    viewportWidth: width,
    viewportHeight: height,
    viewportHeightFraction,
    labelPartition: {
      backgroundRgb: [...BACKGROUND_REFERENCE],
      globeRgb: [...GLOBE_REFERENCE],
      referenceColorTolerance: REFERENCE_COLOR_TOLERANCE,
      splatRule: "Any pixel outside both reference-colour tolerances.",
    },
    actualProjection: {
      projectedRadiusPixels: actualProjectedRadiusPixels,
      projectedDiscAreaFraction: actualProjectedDiscAreaFraction,
      derivedPerimeterPixels: actualPerimeterPixels,
      derivedPerimeterFraction: actualPerimeterFraction,
      geometry:
        "Corrected model: the landed range maps the configured fraction to NDC radius, so projected radius is half the registered model.",
    },
    registeredRationale: {
      projectedRadiusPixels: registeredProjectedRadiusPixels,
      projectedDiscAreaFraction: registeredProjectedDiscAreaFraction,
      derivedPerimeterPixels: registeredPerimeterPixels,
      derivedPerimeterFraction: registeredPerimeterFraction,
      geometry:
        "Recorded erratum: the row brief treats the configured fraction as projected radius divided by full viewport height; the landed code supersedes it.",
    },
    maximumLabelDisagreementFraction: MAX_LABEL_DISAGREEMENT_FRACTION,
    barToRegisteredPerimeterRatio:
      MAX_LABEL_DISAGREEMENT_FRACTION / registeredPerimeterFraction,
    barToActualPerimeterRatio:
      MAX_LABEL_DISAGREEMENT_FRACTION / actualPerimeterFraction,
    registeredFootprintToBarRatio:
      registeredProjectedDiscAreaFraction / MAX_LABEL_DISAGREEMENT_FRACTION,
    actualFootprintToBarRatio:
      actualProjectedDiscAreaFraction / MAX_LABEL_DISAGREEMENT_FRACTION,
    registration: "PRE-REGISTERED AND UNCALIBRATED",
    wideningPolicy:
      "A first-run value in the landed-geometry separation region is the finding; the bar is not widened around it.",
  };
}

export function evaluateGsplatLabelTopology(webglFrame, webgpuFrame) {
  const partitions = {
    webgl: partitionGsplatTopologyFrame(webglFrame, "webgl"),
    webgpu: partitionGsplatTopologyFrame(webgpuFrame, "webgpu"),
  };
  const structural = [
    ...partitions.webgl.structural,
    ...partitions.webgpu.structural,
  ];
  if (
    partitions.webgl.valid &&
    partitions.webgpu.valid &&
    (partitions.webgl.width !== partitions.webgpu.width ||
      partitions.webgl.height !== partitions.webgpu.height)
  ) {
    structural.push("labels:frame-dimensions-mismatch");
  }
  // R-2026-08-24-14: one backend composing splat-coloured pixels while the
  // other composes none - both having produced a settled frame with at least
  // one splat command - is the row's headline defect, so the lane SAW its
  // subject and it failed. Only the symmetric zero/zero case means the lane
  // never saw the subject at all, and that stays structural.
  const splatOccupancy = {
    webgl: partitions.webgl.valid ? partitions.webgl.counts.splat : null,
    webgpu: partitions.webgpu.valid ? partitions.webgpu.counts.splat : null,
  };
  const asymmetricZeroSplatBackend =
    splatOccupancy.webgl === 0 && splatOccupancy.webgpu > 0
      ? "webgl"
      : splatOccupancy.webgpu === 0 && splatOccupancy.webgl > 0
        ? "webgpu"
        : null;
  const failures =
    asymmetricZeroSplatBackend === null
      ? []
      : [`${asymmetricZeroSplatBackend}:labels:zero-splat-asymmetric`];
  // R-2026-08-24-16: on the backend that composed nothing, "no globe pixels"
  // and "only one label" are CONSEQUENCES of the same compose failure, not
  // independent blindness, so they must not demote the verdict to structural.
  // They are published as diagnostics instead. Unrelated blindness - a corner
  // mismatch, an invalid frame, mismatched dimensions, or an unproven settled
  // frame on either backend - still outranks the asymmetric failure.
  const suppressedStructural = [];
  for (const backend of ["webgl", "webgpu"]) {
    const summary = partitions[backend];
    if (!summary.valid) continue;
    const consequenceSink =
      backend === asymmetricZeroSplatBackend
        ? suppressedStructural
        : structural;
    if (summary.corner?.withinBackgroundTolerance !== true) {
      structural.push(`${backend}:labels:corner-background-mismatch`);
    }
    if (summary.counts.splat === 0 && asymmetricZeroSplatBackend === null) {
      structural.push(`${backend}:labels:zero-splat`);
    }
    if (summary.counts.globe === 0) {
      consequenceSink.push(`${backend}:labels:zero-globe`);
    }
    if (
      Object.values(summary.counts).filter((count) => count > 0).length === 1
    ) {
      consequenceSink.push(`${backend}:labels:single-label-frame`);
    }
  }
  const summaries = Object.fromEntries(
    Object.entries(partitions).map(([backend, partition]) => [
      backend,
      {
        valid: partition.valid,
        width: partition.width,
        height: partition.height,
        totalPixels: partition.totalPixels,
        counts: partition.counts,
        corner: partition.corner,
      },
    ]),
  );
  // Each backend's splat occupancy is read from its own partition and
  // published even when standing is structural. On the eligible path both
  // fields are necessarily true, so the ineligible record is the only place a
  // cross-backend read error is observable.
  const g2 = {
    webgl: partitions.webgl.valid ? partitions.webgl.counts.splat > 0 : null,
    webgpu: partitions.webgpu.valid ? partitions.webgpu.counts.splat > 0 : null,
  };
  if (structural.length > 0) {
    return {
      eligible: false,
      structural,
      summaries,
      disagreementPixels: null,
      disagreementFraction: null,
      disagreementToSplatFootprintRatio: null,
      g2,
      g3: null,
      failures,
      suppressedStructural,
    };
  }
  let disagreementPixels = 0;
  for (let index = 0; index < partitions.webgl.labels.length; index++) {
    if (partitions.webgl.labels[index] !== partitions.webgpu.labels[index]) {
      disagreementPixels++;
    }
  }
  const disagreementFraction =
    disagreementPixels / partitions.webgl.totalPixels;
  const minimumSplatPixels = Math.min(
    partitions.webgl.counts.splat,
    partitions.webgpu.counts.splat,
  );
  const disagreementToSplatFootprintRatio =
    minimumSplatPixels > 0 ? disagreementPixels / minimumSplatPixels : null;
  return {
    eligible: true,
    structural: [],
    summaries,
    disagreementPixels,
    disagreementFraction,
    disagreementToSplatFootprintRatio,
    g2,
    failures,
    suppressedStructural,
    g3: {
      passes: disagreementFraction <= MAX_LABEL_DISAGREEMENT_FRACTION,
      maximumFraction: MAX_LABEL_DISAGREEMENT_FRACTION,
    },
  };
}

const FRAMING_AGREEMENT_FIELDS = Object.freeze([
  "assetUrl",
  "radius",
  "fovyRadians",
  "viewportHeightFraction",
  "range",
  "logarithmicDepthFarToNearRatio",
  "globeShown",
  "logDepthEnabled",
  "firstBandBoundaryMeters",
  "targetTowerAltitudeMeters",
  "towerDepthRetargetTranslationMeters",
  "towerAltitudeMeters",
  "towerAltitudeToleranceMeters",
  "towerDepthRetargetApplied",
]);

function exactRgbTriple(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (channel, index) =>
        Number.isInteger(channel) && channel === expected[index],
    )
  );
}

export function compareGsplatBackendFraming(backends) {
  const webgl = backends?.webgl?.framing;
  const webgpu = backends?.webgpu?.framing;
  const disagreements = [];
  for (const field of FRAMING_AGREEMENT_FIELDS) {
    if (!Object.is(webgl?.[field], webgpu?.[field])) {
      disagreements.push({
        field,
        webgl: webgl?.[field] ?? null,
        webgpu: webgpu?.[field] ?? null,
      });
    }
  }
  const passFields = ["globe", "gaussianSplats"];
  for (const field of passFields) {
    if (
      !Object.is(
        backends?.webgl?.passes?.[field],
        backends?.webgpu?.passes?.[field],
      )
    ) {
      disagreements.push({
        field: `passes.${field}`,
        webgl: backends?.webgl?.passes?.[field] ?? null,
        webgpu: backends?.webgpu?.passes?.[field] ?? null,
      });
    }
  }
  for (const backend of ["webgl", "webgpu"]) {
    const runtime = backends?.[backend]?.runtime;
    if (runtime?.rendererType !== backend) {
      disagreements.push({
        field: `runtime.${backend}.rendererType`,
        actual: runtime?.rendererType ?? null,
        expected: backend,
        reason: `${backend}:runtime:backend-identity-unproven`,
      });
    }
    if (!exactRgbTriple(runtime?.backgroundColorRgb, BACKGROUND_REFERENCE)) {
      disagreements.push({
        field: `runtime.${backend}.backgroundColorRgb`,
        actual: runtime?.backgroundColorRgb ?? null,
        expected: [...BACKGROUND_REFERENCE],
        reason: `${backend}:runtime:background-rgb-mismatch`,
      });
    }
    if (!exactRgbTriple(runtime?.globeBaseColorRgb, GLOBE_REFERENCE)) {
      disagreements.push({
        field: `runtime.${backend}.globeBaseColorRgb`,
        actual: runtime?.globeBaseColorRgb ?? null,
        expected: [...GLOBE_REFERENCE],
        reason: `${backend}:runtime:globe-base-rgb-mismatch`,
      });
    }
    // The depth re-framing has three preconditions. Each one, when it fails,
    // means the derived placement never described this frame, so the run is
    // demoted at the framing layer before any pixel is examined - exactly like
    // the other framing-layer reasons above, and without disturbing the
    // R-2026-08-24-14/-16 label-layer routing.
    const backendFraming = backends?.[backend]?.framing;
    const towerDepthRetargetApplied =
      backendFraming?.towerDepthRetargetApplied === true;
    if (!towerDepthRetargetApplied) {
      disagreements.push({
        field: `framing.${backend}.towerDepthRetargetApplied`,
        actual: backendFraming?.towerDepthRetargetApplied ?? null,
        expected: true,
        reason: `${backend}:framing:tower-depth-retarget-not-applied`,
      });
    }
    // The page publishes the placement scalars, so the evaluator re-derives
    // them here from the two quantities the framing library itself pins -
    // `range` and `radius`, which `framing:not-far-nadir` already ties to the
    // asset and the field of view - and judges against the re-derivation. A
    // published target or tolerance is cross-checked, never trusted: widening
    // the page's divisor would otherwise defang the altitude gate silently.
    const derivedRetarget = deriveGsplatTowerDepthRetarget(
      backendFraming?.range,
      backendFraming?.radius,
    );
    const derivedTolerance = deriveTowerAltitudeToleranceMeters(
      derivedRetarget.boundaryOffsetToleranceMeters,
    );
    const retargetScalarsDerived =
      derivedRetarget.structural.length === 0 &&
      Object.is(
        backendFraming?.firstBandBoundaryMeters,
        derivedRetarget.firstBandBoundaryMeters,
      ) &&
      Object.is(
        backendFraming?.targetTowerAltitudeMeters,
        derivedRetarget.targetTowerAltitudeMeters,
      ) &&
      Object.is(backendFraming?.towerAltitudeToleranceMeters, derivedTolerance);
    if (!retargetScalarsDerived) {
      disagreements.push({
        field: `framing.${backend}.towerAltitudeToleranceMeters`,
        actual: {
          firstBandBoundaryMeters:
            backendFraming?.firstBandBoundaryMeters ?? null,
          targetTowerAltitudeMeters:
            backendFraming?.targetTowerAltitudeMeters ?? null,
          towerAltitudeToleranceMeters:
            backendFraming?.towerAltitudeToleranceMeters ?? null,
        },
        expected: {
          firstBandBoundaryMeters: derivedRetarget.firstBandBoundaryMeters,
          targetTowerAltitudeMeters: derivedRetarget.targetTowerAltitudeMeters,
          towerAltitudeToleranceMeters: derivedTolerance,
        },
        reason: `${backend}:framing:tower-altitude-tolerance-not-derived`,
      });
    }
    // Only the achieved altitude is an observation; both sides of the
    // comparison come from the re-derivation.
    const targetTowerAltitude = derivedRetarget.targetTowerAltitudeMeters;
    const towerAltitude = backendFraming?.towerAltitudeMeters;
    const altitudeTolerance = derivedTolerance ?? Number.NaN;
    const towerAltitudeOnTarget =
      Number.isFinite(targetTowerAltitude) &&
      Number.isFinite(towerAltitude) &&
      Number.isFinite(altitudeTolerance) &&
      Math.abs(towerAltitude - targetTowerAltitude) <= altitudeTolerance;
    if (!towerAltitudeOnTarget) {
      disagreements.push({
        field: `framing.${backend}.towerAltitudeMeters`,
        actual: towerAltitude ?? null,
        expected: targetTowerAltitude ?? null,
        reason: `${backend}:framing:tower-altitude-off-target`,
      });
    }
    // The closed-form target is only valid while the tower owns the scene near
    // plane. A globe bounding volume reaching closer moves every band boundary
    // and voids the derivation.
    const depthExtents = runtime?.depthExtents;
    const globeNearMeters = depthExtents?.globe?.near;
    const splatNearMeters = depthExtents?.gaussianSplats?.near;
    const splatOwnsSceneNear =
      Number.isFinite(globeNearMeters) &&
      Number.isFinite(splatNearMeters) &&
      splatNearMeters < globeNearMeters;
    if (!splatOwnsSceneNear) {
      disagreements.push({
        field: `runtime.${backend}.depthExtents`,
        actual: depthExtents ?? null,
        expected: "splat near strictly closer than globe near",
        reason: `${backend}:framing:scene-near-not-splat-owned`,
      });
    }
  }
  if (
    !Number.isInteger(backends?.webgpu?.runtime?.gpuGateArmedDevices) ||
    backends.webgpu.runtime.gpuGateArmedDevices < 1
  ) {
    disagreements.push({
      field: "runtime.webgpu.gpuGateArmedDevices",
      actual: backends?.webgpu?.runtime?.gpuGateArmedDevices ?? null,
      expected: "positive integer",
      reason: "webgpu:runtime:error-gate-unarmed",
    });
  }
  return {
    agree: disagreements.length === 0,
    structural: disagreements.map(
      ({ field, reason }) =>
        reason ?? `framing:backend-record-disagreement:${field}`,
    ),
    disagreements,
    framing: disagreements.length === 0 ? webgl : null,
    passes:
      disagreements.length === 0 ? (backends?.webgl?.passes ?? null) : null,
  };
}

export function evaluateGsplatMultifrustumProbeResult(input) {
  const harnessErrors = Array.isArray(input?.harnessErrors)
    ? [...input.harnessErrors]
    : ["harness-errors:invalid"];
  if (input?.cleanup?.complete !== true) {
    harnessErrors.push("cleanup:incomplete");
  }
  if (harnessErrors.length > 0) {
    const status = "ERROR";
    return {
      status,
      exitCode: exitCodeForS5Status(status),
      structural: [],
      failures: [],
      harnessErrors,
      topology: input?.standing?.occlusion ?? null,
    };
  }

  const structural = [];
  if (Array.isArray(input?.captureContract?.failures)) {
    structural.push(...input.captureContract.failures);
  } else {
    structural.push("capture-contract:invalid");
  }
  if (Array.isArray(input?.framingAgreement?.structural)) {
    structural.push(...input.framingAgreement.structural);
  } else {
    structural.push("framing:agreement-record-invalid");
  }
  const framingAgrees = input?.framingAgreement?.agree === true;
  const standing = input?.standing;
  if (framingAgrees && standing?.eligible !== true) {
    if (Array.isArray(standing?.structural) && standing.structural.length > 0) {
      // Library reasons are copied verbatim; this layer never rewrites them.
      structural.push(...standing.structural);
    } else {
      structural.push("standing:ineligible-without-reason");
    }
  }
  if (
    framingAgrees &&
    standing?.eligible === true &&
    standing?.occlusionRead !== true
  ) {
    structural.push("standing:lazy-occlusion-read-missing");
  }
  const topology = standing?.occlusion ?? null;
  if (
    framingAgrees &&
    standing?.eligible === true &&
    topology?.eligible !== true
  ) {
    if (Array.isArray(topology?.structural) && topology.structural.length > 0) {
      structural.push(...topology.structural);
    } else {
      structural.push("labels:ineligible-without-reason");
    }
  }
  if (structural.length > 0) {
    const status = "STRUCTURAL";
    return {
      status,
      exitCode: exitCodeForS5Status(status),
      structural,
      failures: [],
      harnessErrors: [],
      topology,
    };
  }

  // R-2026-08-24-14 reasons are decided in the label evaluator, which owns the
  // symmetric/asymmetric distinction, and are carried here verbatim.
  const failures = Array.isArray(topology.failures)
    ? [...topology.failures]
    : [];
  // Reachable on exactly one path: the R-2026-08-24-14 asymmetric case, where
  // one backend composes no splat pixels but the frame is still scored. The
  // symmetric zero/zero case is caught upstream as
  // `${backend}:labels:zero-splat` and routes STRUCTURAL (exit 3) before this
  // fold runs, so this branch never fires for it.
  if (topology.g2.webgl !== true || topology.g2.webgpu !== true) {
    failures.push("G-2:non-background-splat-coloured-pixels-absent");
  }
  if (topology.g3.passes !== true) {
    failures.push("G-3:backend-label-topology-disagreement-above-bar");
  }
  const status = failures.length === 0 ? "PASS" : "FAIL";
  return {
    status,
    exitCode: exitCodeForS5Status(status),
    structural: [],
    failures,
    harnessErrors: [],
    topology,
  };
}
// ==END gsplat-multifrustum-node-model==

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function serializeError(value) {
  const error = value instanceof Error ? value : new Error(String(value));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    watchdog: error.c15G6Watchdog ?? null,
    cleanup: error.c15G6Cleanup ?? null,
  };
}

function validateLoopbackBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base must be an uncredentialed loopback HTTP URL");
  }
  return { href: url.href, origin: url.origin };
}

function markerCount(source, marker) {
  let count = 0;
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) >= 0) {
    count++;
    cursor += marker.length;
  }
  return count;
}

export function inspectGsplatMultifrustumCaptureContract(source) {
  const canonicalFailures = checkEmbeddedFusedSnapshotIsCanonical(source);
  const usageFailures = checkFusedCaptureUsage(source);
  const beginCount = markerCount(source, FUSED_SNAPSHOT_BEGIN);
  const endCount = markerCount(source, FUSED_SNAPSHOT_END);
  return {
    canonical: canonicalFailures.length === 0,
    singleBlock: beginCount === 1 && endCount === 1,
    usageValid: usageFailures.length === 0,
    beginCount,
    endCount,
    failures: [
      ...canonicalFailures,
      ...usageFailures,
      ...(beginCount === 1 && endCount === 1
        ? []
        : [
            `fused snapshot markers must occur exactly once (BEGIN=${beginCount}, END=${endCount})`,
          ]),
    ],
  };
}

function readExact(file, expected, label, operations = fs) {
  const actual = operations.readFileSync(file);
  const bytes = Buffer.isBuffer(actual) ? actual : Buffer.from(actual);
  if (!bytes.equals(Buffer.from(expected))) {
    throw new Error(`${label} bytes differ from the run-owned canonical bytes`);
  }
  return bytes;
}

function writeOnceExact(file, bytes, label, operations = fs) {
  const canonical = Buffer.from(bytes);
  try {
    operations.writeFileSync(file, canonical, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    readExact(file, canonical, label, operations);
  }
  readExact(file, canonical, label, operations);
  return readExact(file, canonical, label, operations);
}

function createRunPaths(runId, outputRoot = defaultOutputRoot) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      runId,
    )
  ) {
    throw new Error("runId must be a UUID v4");
  }
  const root = path.resolve(outputRoot);
  const directory = path.join(root, runId);
  if (path.dirname(directory) !== root) {
    throw new Error("run directory escaped the configured output root");
  }
  return {
    root,
    directory,
    artifact: path.join(directory, `${runId}.json`),
  };
}

function prepareRunDirectory(paths, operations = fs) {
  operations.mkdirSync(paths.root, { recursive: true });
  operations.mkdirSync(paths.directory, { recursive: false });
}

function pngBytes(dataUrl, label) {
  const prefix = "data:image/png;base64,";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) {
    throw new Error(`${label} is not a PNG data URL`);
  }
  const encoded = dataUrl.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error(`${label} is not canonical base64`);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length <= signature.length ||
    !bytes.subarray(0, 8).equals(signature)
  ) {
    throw new Error(`${label} did not decode to a complete PNG`);
  }
  return bytes;
}

async function decodePngRgba(bytes, label) {
  let decoded;
  try {
    decoded = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: VIEWPORT.width * VIEWPORT.height * 16,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error(
      `${label} persisted PNG decode failed: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  const { data, info } = decoded;
  if (
    !Number.isInteger(info.width) ||
    info.width < 1 ||
    !Number.isInteger(info.height) ||
    info.height < 1 ||
    info.channels !== 4 ||
    data.length !== info.width * info.height * 4
  ) {
    throw new Error(`${label} persisted PNG is not a positive RGBA frame`);
  }
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

async function persistAndRederiveCaptureImages(
  paths,
  sessions,
  records,
  operations = fs,
) {
  const frames = {};
  for (const session of sessions) {
    const backend = session.renderer;
    records[backend] = {};
    frames[backend] = {};
    for (const [name, dataUrl] of Object.entries(
      session.measurement?.captures ?? {},
    )) {
      if (!/^[a-z][a-zA-Z]+$/u.test(name)) {
        throw new Error(`unsafe capture name ${name}`);
      }
      const bytes = pngBytes(dataUrl, `${backend}/${name}`);
      const file = path.join(paths.directory, `${backend}-${name}.png`);
      if (path.dirname(file) !== paths.directory) {
        throw new Error(`${backend}/${name} escaped the run directory`);
      }
      const reread = writeOnceExact(
        file,
        bytes,
        `${backend}/${name}`,
        operations,
      );
      records[backend][name] = {
        file: path.basename(file),
        bytes: reread.length,
        sha256: sha256(reread),
        rgbaRederived: false,
      };
      const decodedAfterWrite = await decodePngRgba(
        reread,
        `${backend}/${name}`,
      );
      frames[backend][name] = decodedAfterWrite;
      records[backend][name].rgbaRederived = true;
    }
  }
  return { records, frames };
}

async function closeBounded(instance, label, timeoutMs) {
  if (!instance) {
    return { label, attempted: false, closed: true, timedOut: false };
  }
  let timer;
  try {
    return {
      label,
      attempted: true,
      ...(await Promise.race([
        Promise.resolve()
          .then(() => instance.close())
          .then(
            () => ({ closed: true, timedOut: false }),
            (error) => ({
              closed: false,
              timedOut: false,
              error: serializeError(error),
            }),
          ),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ closed: false, timedOut: true }),
            timeoutMs,
          );
        }),
      ])),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function boundedPageCheckpoint(owned, timeoutMs = 2_000) {
  const page = owned.page;
  if (!page || page.isClosed()) {
    return { phase: owned.phase, pageAvailable: false };
  }
  let timer;
  try {
    return await Promise.race([
      page
        .evaluate(() => ({
          phase: window.__c15G6Progress?.phase ?? "unknown",
          renderer: window.__c15G6Progress?.renderer ?? null,
          frameNumber: window.viewer?.scene?.frameState?.frameNumber ?? null,
        }))
        .then(
          (checkpoint) => ({ ...checkpoint, pageAvailable: true }),
          (error) => ({
            phase: owned.phase,
            pageAvailable: true,
            error: serializeError(error),
          }),
        ),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              phase: owned.phase,
              pageAvailable: true,
              timedOut: true,
            }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupOwned(owned) {
  const page = owned.page;
  const context = owned.context;
  const browser = owned.browser;
  const pageClose = await closeBounded(
    page,
    "watchdog page",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  const contextClose = await closeBounded(
    context,
    "watchdog context",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  const browserClose = await closeBounded(
    browser,
    "watchdog browser",
    BROWSER_CLOSE_TIMEOUT_MS,
  );
  if (pageClose.closed && owned.page === page) owned.page = undefined;
  if (contextClose.closed && owned.context === context) {
    owned.context = undefined;
  }
  if (browserClose.closed && owned.browser === browser) {
    owned.browser = undefined;
  }
  const pendingRequests = owned.pending?.size ?? 0;
  return {
    pageClose,
    contextClose,
    browserClose,
    pendingRequests,
    cleanupComplete:
      pageClose.closed &&
      contextClose.closed &&
      browserClose.closed &&
      pendingRequests === 0,
  };
}

export async function withGsplatMultifrustumWatchdog(
  operation,
  onTimeout,
  timeoutMs = RUN_WATCHDOG_MS,
) {
  let timer;
  let timingOut = false;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value) => (timingOut ? new Promise(() => {}) : value),
          (error) =>
            timingOut ? new Promise(() => {}) : Promise.reject(error),
        ),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          timingOut = true;
          let timeoutEvidence;
          try {
            timeoutEvidence = await onTimeout();
          } catch (cleanupError) {
            const aggregate = new AggregateError(
              [
                new Error(`C15-G6 watchdog expired after ${timeoutMs} ms`),
                cleanupError,
              ],
              "C15-G6 watchdog cleanup failed",
            );
            aggregate.c15G6Watchdog = {
              timeoutMs,
              cleanupComplete: false,
            };
            reject(aggregate);
            return;
          }
          const error = new Error(
            timeoutEvidence?.cleanupComplete
              ? `C15-G6 watchdog expired after ${timeoutMs} ms`
              : `C15-G6 watchdog expired after ${timeoutMs} ms and cleanup remained unproven`,
          );
          error.c15G6Watchdog = { timeoutMs, ...timeoutEvidence };
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function acquirePageMeasurement({ renderer, assetUrl }) {
  window.__c15G6Progress = { renderer, phase: "setup" };
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  scene.requestRenderMode = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.fog) scene.fog.enabled = false;
  scene.backgroundColor = C.Color.fromCssColorString("#101014");
  const pageRuntimeErrors = [];
  scene.renderError.addEventListener((_scene, error) => {
    pageRuntimeErrors.push(error?.stack ?? error?.message ?? String(error));
  });
  const readLiveColorRgb = (color) => {
    try {
      const bytes = color?.toBytes?.();
      if (
        !Array.isArray(bytes) ||
        bytes.length < 3 ||
        !bytes.slice(0, 3).every(Number.isInteger)
      ) {
        return null;
      }
      return bytes.slice(0, 3);
    } catch {
      return null;
    }
  };

  // ==BEGIN gsplat-multifrustum-page-instrument==
  function summarizeGsplatFrustumBands(
    frustumCommandsList,
    globePass,
    gaussianSplatPass,
  ) {
    if (!Array.isArray(frustumCommandsList)) return [];
    return frustumCommandsList.map((band, index) => ({
      index,
      near: band?.near ?? band?.frustum?.near,
      far: band?.far ?? band?.frustum?.far,
      globeIndex: band?.indices?.[globePass],
      splatIndex: band?.indices?.[gaussianSplatPass],
    }));
  }

  function acquireGsplatBoundingVolumeControl(
    scene,
    globePass,
    gaussianSplatPass,
  ) {
    const view = scene?._view;
    const frameState = scene?.frameState;
    if (
      !view ||
      typeof view.createPotentiallyVisibleSet !== "function" ||
      !Array.isArray(frameState?.commandList)
    ) {
      return {
        ok: false,
        structural: ["pvs:live-view-or-command-list-missing"],
      };
    }
    const snapshot = () =>
      summarizeGsplatFrustumBands(
        view.frustumCommandsList ?? scene.frustumCommandsList,
        globePass,
        gaussianSplatPass,
      );
    const cleanBands = snapshot();
    const commands = frameState.commandList.filter(
      (command) => command?.pass === gaussianSplatPass,
    );
    const saved = commands.map((command) => ({
      command,
      boundingVolume: command.boundingVolume,
    }));
    const allBoundingVolumesDefined = saved.every(
      ({ boundingVolume }) =>
        boundingVolume !== undefined && boundingVolume !== null,
    );
    let suppressedBands = [];
    let restoredBands = [];
    let suppressionAppliedCount = 0;
    let restorationPvsRan = false;
    let controlError = null;
    try {
      for (const { command } of saved) {
        command.boundingVolume = undefined;
        if (command.boundingVolume === undefined) suppressionAppliedCount++;
      }
      view.createPotentiallyVisibleSet(scene);
      suppressedBands = snapshot();
    } catch (error) {
      controlError = error?.stack ?? error?.message ?? String(error);
    } finally {
      for (const { command, boundingVolume } of saved) {
        command.boundingVolume = boundingVolume;
      }
      try {
        view.createPotentiallyVisibleSet(scene);
        restorationPvsRan = true;
        restoredBands = snapshot();
      } catch (error) {
        const restorationError =
          error?.stack ?? error?.message ?? String(error);
        controlError = controlError
          ? `${controlError}\nRESTORATION: ${restorationError}`
          : restorationError;
      }
    }
    const structural = [];
    if (controlError) structural.push(`pvs:control-error:${controlError}`);
    if (commands.length < 1) {
      structural.push("pvs:no-current-frame-splat-command");
    }
    if (!allBoundingVolumesDefined) {
      structural.push("pvs:clean-bounding-volume-missing");
    }
    if (suppressionAppliedCount !== commands.length) {
      structural.push("pvs:suppression-not-applied-to-all");
    }
    const boundingVolumeIdentitiesRestored = saved.every(
      ({ command, boundingVolume }) =>
        command.boundingVolume === boundingVolume,
    );
    if (!boundingVolumeIdentitiesRestored) {
      structural.push("pvs:bounding-volume-identity-not-restored");
    }
    if (!restorationPvsRan) structural.push("pvs:restoration-pvs-not-run");
    return {
      ok: structural.length === 0,
      structural,
      clean: { bands: cleanBands },
      suppressed: { bands: suppressedBands },
      restored: { bands: restoredBands },
      commandCount: commands.length,
      allBoundingVolumesDefined,
      suppressionAppliedCount,
      boundingVolumeIdentitiesRestored,
      restorationPvsRan,
    };
  }

  function applyGsplatMultifrustumPageFraming(C, viewer, tileset) {
    const scene = viewer?.scene;
    const radius = tileset?.boundingSphere?.radius;
    const fovyRadians = scene?.camera?.frustum?.fovy;
    const expectedAssetUrl =
      "/Specs/Data/Cesium3DTiles/GaussianSplats/tower/tileset.json";
    const loadedUrl = tileset?.resource?.url;
    let assetUrl = null;
    try {
      assetUrl = new URL(loadedUrl, "http://cesium.invalid").pathname;
    } catch {
      // The common framing error below owns malformed/missing asset identity.
    }
    if (
      !scene?.globe ||
      assetUrl !== expectedAssetUrl ||
      !Number.isFinite(radius) ||
      radius <= 0 ||
      !Number.isFinite(fovyRadians) ||
      fovyRadians <= 0 ||
      fovyRadians >= Math.PI
    ) {
      throw new Error("G6 framing requires a perspective tower/globe scene");
    }
    const viewportHeightFraction = 0.1;
    const angularRadius = Math.atan(
      viewportHeightFraction * Math.tan(fovyRadians / 2),
    );
    const range = radius / Math.sin(angularRadius);
    scene.globe.show = true;
    scene.globe.imageryLayers?.removeAll();
    scene.globe.baseColor = C.Color.fromCssColorString("#26262c");
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.depthTestAgainstTerrain = true;
    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.logarithmicDepthFarToNearRatio = 2;
    viewer.camera.viewBoundingSphere(
      tileset.boundingSphere,
      new C.HeadingPitchRange(0, -Math.PI / 2, range),
    );
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    return {
      assetUrl,
      headingRadians: 0,
      pitchRadians: -Math.PI / 2,
      range,
      radius,
      fovyRadians,
      viewportHeightFraction,
      logarithmicDepthFarToNearRatio: 2,
      globeShown: scene.globe.show === true,
    };
  }

  async function settleGsplatMultifrustumPageFraming(
    C,
    viewer,
    tileset,
    timeoutMs = 90_000,
  ) {
    const scene = viewer.scene;
    const started = performance.now();
    const fixedTime = C.JulianDate.fromIso8601("2026-08-02T18:00:00Z");
    let latest = {
      activeFrusta: 0,
      globeCommands: 0,
      splatCommands: 0,
    };
    while (performance.now() - started < timeoutMs) {
      scene.requestRender();
      scene.render(fixedTime);
      const bands =
        scene._view?.frustumCommandsList ?? scene.frustumCommandsList ?? [];
      latest = {
        // This read is the page-side anti-vacuity anchor.  No occlusion pixel is
        // acquired anywhere in this helper.
        activeFrusta: bands.length,
        globeCommands: bands.reduce(
          (count, band) => count + (band.indices?.[C.Pass.GLOBE] ?? 0),
          0,
        ),
        splatCommands: bands.reduce(
          (count, band) =>
            count + (band.indices?.[C.Pass.GAUSSIAN_SPLATS] ?? 0),
          0,
        ),
      };
      if (
        tileset.tilesLoaded &&
        scene.globe.tilesLoaded &&
        latest.activeFrusta >= 2 &&
        latest.globeCommands > 0 &&
        latest.splatCommands > 0
      ) {
        return {
          ready: true,
          waitedMs: Math.round(performance.now() - started),
          logDepthEnabled: scene.frameState.useLogDepth === true,
          logarithmicDepthFarToNearRatio: scene.logarithmicDepthFarToNearRatio,
          ...latest,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      ready: false,
      waitedMs: Math.round(performance.now() - started),
      logDepthEnabled: scene.frameState.useLogDepth === true,
      logarithmicDepthFarToNearRatio: scene.logarithmicDepthFarToNearRatio,
      ...latest,
    };
  }
  // ==END gsplat-multifrustum-page-instrument==

  // ==BEGIN gsplat-multifrustum-page-retarget==
  // `page.evaluate` ships only this function's source, so page scope holds
  // none of this module's constants. Re-declare the inflation here - it is
  // the same `CesiumMath.EPSILON2` the exported model reads - so the twin is
  // self-contained and the spec can compile it with nothing injected.
  const PAGE_SCENE_FAR_INFLATION = 0.01;
  const TOWER_BOUNDARY_MARGIN_FRACTION =
    PAGE_SCENE_FAR_INFLATION / (2 * (1 + PAGE_SCENE_FAR_INFLATION));
  const PAGE_TOWER_ALTITUDE_TOLERANCE_DIVISOR = 10;

  function deriveGsplatTowerDepthRetarget(range, radius) {
    if (
      !Number.isFinite(range) ||
      range <= 0 ||
      !Number.isFinite(radius) ||
      radius <= 0
    ) {
      return {
        structural: ["retarget:framing-scalars-invalid"],
        sceneNearMeters: null,
        firstBandBoundaryMeters: null,
        boundaryMarginFraction: TOWER_BOUNDARY_MARGIN_FRACTION,
        boundaryOffsetToleranceMeters: null,
        splatFarMeters: null,
        targetCameraAltitudeMeters: null,
        targetTowerAltitudeMeters: null,
      };
    }
    const structural = [];
    const sceneNearMeters = range - radius;
    const firstBandBoundaryMeters = 2 * sceneNearMeters;
    const splatFarMeters = range + radius;
    const targetCameraAltitudeMeters =
      firstBandBoundaryMeters * (1 - TOWER_BOUNDARY_MARGIN_FRACTION);
    const targetTowerAltitudeMeters = targetCameraAltitudeMeters - range;
    // The tower's own depth extent has to stay wholly inside band 0, otherwise
    // the splat is binned into every band and stops being selectively binned.
    if (!(splatFarMeters < firstBandBoundaryMeters)) {
      structural.push("retarget:splat-extent-reaches-first-band-boundary");
    }
    // The whole bounding sphere has to clear the ellipsoid, or the tower is
    // buried in the globe it is supposed to compose over.
    if (!(targetTowerAltitudeMeters > radius)) {
      structural.push("retarget:target-tower-altitude-below-bounding-radius");
    }
    return {
      structural,
      sceneNearMeters,
      firstBandBoundaryMeters,
      boundaryMarginFraction: TOWER_BOUNDARY_MARGIN_FRACTION,
      boundaryOffsetToleranceMeters:
        firstBandBoundaryMeters * TOWER_BOUNDARY_MARGIN_FRACTION,
      splatFarMeters,
      targetCameraAltitudeMeters,
      targetTowerAltitudeMeters,
    };
  }

  const readTowerAltitudeMeters = (C, ellipsoid, tileset) => {
    const center = tileset?.boundingSphere?.center;
    if (!center) return null;
    const carto = C.Cartographic.fromCartesian(
      center,
      ellipsoid,
      new C.Cartographic(),
    );
    const height = carto?.height;
    return Number.isFinite(height) ? height : null;
  };

  const applyGsplatTowerDepthRetarget = (C, ellipsoid, tileset, plan) => {
    const derived = deriveGsplatTowerDepthRetarget(plan?.range, plan?.radius);
    const structural = [...derived.structural];
    const surveyedTowerAltitudeMeters = readTowerAltitudeMeters(
      C,
      ellipsoid,
      tileset,
    );
    let translationMeters = null;
    let applied = false;
    if (structural.length === 0) {
      if (surveyedTowerAltitudeMeters === null) {
        structural.push("retarget:surveyed-tower-altitude-unreadable");
      } else {
        translationMeters =
          derived.targetTowerAltitudeMeters - surveyedTowerAltitudeMeters;
        const normal = ellipsoid.geodeticSurfaceNormal(
          tileset.boundingSphere.center,
          new C.Cartesian3(),
        );
        const offset = C.Cartesian3.multiplyByScalar(
          normal,
          translationMeters,
          new C.Cartesian3(),
        );
        // Cesium3DTile.updateTransform pre-multiplies this against the
        // tileset's own transform, so it is a world-space slide along the
        // asset's local up. The bounding-sphere radius, and therefore the
        // library's range derivation, are untouched by it.
        tileset.modelMatrix = C.Matrix4.fromTranslation(
          offset,
          new C.Matrix4(),
        );
        applied = true;
      }
    }
    return {
      ...derived,
      structural,
      surveyedTowerAltitudeMeters,
      translationMeters,
      applied,
    };
  };

  const measureGsplatPassDepthExtents = (scene, passes) => {
    const camera = scene?.camera;
    const commandList = scene?.frameState?.commandList;
    const interval = { start: 0, stop: 0 };
    const extents = {};
    for (const name of Object.keys(passes)) {
      const pass = passes[name];
      let near = null;
      let far = null;
      let commands = 0;
      let withoutBoundingVolume = 0;
      if (Array.isArray(commandList) && camera) {
        for (const command of commandList) {
          if (command?.pass !== pass) continue;
          commands++;
          const volume = command.boundingVolume;
          if (typeof volume?.computePlaneDistances !== "function") {
            withoutBoundingVolume++;
            continue;
          }
          // The same production read View.js uses to bin the command, so these
          // extents are the numbers the frustum split actually saw.
          const measured = volume.computePlaneDistances(
            camera.positionWC,
            camera.directionWC,
            interval,
          );
          const start = measured?.start;
          const stop = measured?.stop;
          if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
          near = near === null ? start : Math.min(near, start);
          far = far === null ? stop : Math.max(far, stop);
        }
      }
      extents[name] = { commands, withoutBoundingVolume, near, far };
    }
    return extents;
  };
  // ==END gsplat-multifrustum-page-retarget==

  const tileset = await C.Cesium3DTileset.fromUrl(assetUrl, {
    maximumScreenSpaceError: 1,
  });
  scene.primitives.add(tileset);
  window.__c15G6Progress.phase = "framing:survey";
  // The first framing pass publishes the pinned range; the retarget consumes
  // it, and the second pass re-aims that same pinned camera at the moved
  // tileset. Both passes run the library helper unchanged, and nothing renders
  // between them, so the terrain provider the first pass installs is replaced
  // before it can issue a single tile request.
  const surveyFraming = applyGsplatMultifrustumPageFraming(C, viewer, tileset);
  window.__c15G6Progress.phase = "tower-depth-retarget";
  const ellipsoid = scene.globe.ellipsoid;
  const retarget = applyGsplatTowerDepthRetarget(
    C,
    ellipsoid,
    tileset,
    surveyFraming,
  );
  window.__c15G6Progress.phase = "framing:retargeted";
  const appliedFraming = applyGsplatMultifrustumPageFraming(C, viewer, tileset);
  if (!Object.is(appliedFraming.range, surveyFraming.range)) {
    retarget.structural.push("retarget:derived-range-changed");
    retarget.applied = false;
  }
  window.__c15G6Progress.phase = "settle";
  const settle = await settleGsplatMultifrustumPageFraming(C, viewer, tileset);
  const towerAltitudeMeters = readTowerAltitudeMeters(C, ellipsoid, tileset);
  const towerAltitudeToleranceMeters =
    typeof retarget.boundaryOffsetToleranceMeters === "number"
      ? retarget.boundaryOffsetToleranceMeters /
        PAGE_TOWER_ALTITUDE_TOLERANCE_DIVISOR
      : null;
  const framing = {
    ...appliedFraming,
    logDepthEnabled: settle.logDepthEnabled,
    firstBandBoundaryMeters: retarget.firstBandBoundaryMeters,
    targetTowerAltitudeMeters: retarget.targetTowerAltitudeMeters,
    towerDepthRetargetTranslationMeters: retarget.translationMeters,
    towerAltitudeMeters,
    towerAltitudeToleranceMeters,
    towerDepthRetargetApplied:
      retarget.applied === true && retarget.structural.length === 0,
  };

  // ==BEGIN fused-snapshot-capture==
  const makeFusedSnapshotCapture = (scene, canvas, timeFn) => {
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decode = async (dataUrl) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("fused PNG decode failed"));
      });
      image.src = dataUrl;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const captureSnapshot = async () => {
      scene.render(timeFn());
      const dataUrl = canvas.toDataURL("image/png");
      const imageData = await decode(dataUrl);
      return { dataUrl, imageData };
    };
    return { captureSnapshot };
  };
  // ==END fused-snapshot-capture==

  const captures = {};
  let control = {
    ok: false,
    structural: ["page:settle-not-ready"],
  };
  if (settle.ready === true) {
    const captureTime = C.JulianDate.fromIso8601("2026-08-02T18:00:00Z");
    const { captureSnapshot } = makeFusedSnapshotCapture(
      scene,
      scene.canvas,
      () => captureTime,
    );
    window.__c15G6Progress.phase = "capture:clean";
    const snapshot = await captureSnapshot();
    captures.clean = snapshot.dataUrl;

    // The clean image is frozen before BV suppression. The helper invokes
    // production PVS only, restores BV identities and clean bins in its
    // finally, and no BV-less render or capture exists in this callback.
    window.__c15G6Progress.phase = "bounding-volume-control";
    control = acquireGsplatBoundingVolumeControl(
      scene,
      C.Pass.GLOBE,
      C.Pass.GAUSSIAN_SPLATS,
    );
  }

  const bands = summarizeGsplatFrustumBands(
    scene._view?.frustumCommandsList ?? scene.frustumCommandsList ?? [],
    C.Pass.GLOBE,
    C.Pass.GAUSSIAN_SPLATS,
  );
  // Band-standing-layer evidence, acquired from the same restored PVS state as
  // the bands above and from no pixel. Without it an artifact can say the globe
  // and the splat never shared a band but not say where either one sat, which
  // is precisely what the 2026-08-25 first run could not report.
  const depthExtents = measureGsplatPassDepthExtents(scene, {
    globe: C.Pass.GLOBE,
    gaussianSplats: C.Pass.GAUSSIAN_SPLATS,
  });
  const boundary = retarget.firstBandBoundaryMeters;
  const globeExtent = depthExtents.globe;
  window.__c15G6Progress.phase = "measurement-complete";
  return {
    captures,
    framing,
    settle,
    control,
    retarget,
    passes: {
      globe: C.Pass.GLOBE,
      gaussianSplats: C.Pass.GAUSSIAN_SPLATS,
    },
    runtime: {
      activeFrusta: bands.length,
      bands,
      depthExtents,
      // Published, never gated: when the derived placement misses, the library
      // still owns the headline reason and this only says by how much.
      firstBandBoundaryInsideGlobeDepthSpan:
        Number.isFinite(boundary) &&
        Number.isFinite(globeExtent?.near) &&
        Number.isFinite(globeExtent?.far) &&
        globeExtent.near <= boundary &&
        boundary <= globeExtent.far,
      rendererType: String(scene.context?.rendererType ?? "").toLowerCase(),
      frameNumber: scene.frameState.frameNumber,
      waitedMs: settle.waitedMs,
      viewportWidth: scene.canvas.width,
      viewportHeight: scene.canvas.height,
      backgroundColorRgb: readLiveColorRgb(scene.backgroundColor),
      globeBaseColorRgb: readLiveColorRgb(scene.globe.baseColor),
    },
    harnessErrors: pageRuntimeErrors,
  };
}

async function runBackend(browser, renderer, base, owned) {
  const session = {
    renderer,
    measurement: null,
    cleanup: null,
  };
  let context;
  let page;
  const pending = new Set();
  const externalRequests = [];
  try {
    owned.phase = `${renderer}:context`;
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
    });
    owned.context = context;
    page = await context.newPage();
    owned.page = page;
    owned.pending = pending;
    await page.addInitScript(errorGateInit);
    const consoleErrors = attachConsoleErrorGate(page);

    page.on("request", (request) => {
      pending.add(request);
      const url = request.url();
      try {
        const parsed = new URL(url);
        if (
          parsed.origin !== base.origin &&
          parsed.protocol !== "data:" &&
          parsed.protocol !== "blob:"
        ) {
          externalRequests.push(url);
        }
      } catch {
        externalRequests.push(url);
      }
    });
    page.on("requestfinished", (request) => pending.delete(request));
    page.on("requestfailed", (request) => pending.delete(request));

    owned.phase = `${renderer}:navigate`;
    await page.goto(
      `${base.href.replace(/\/$/u, "")}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await page.waitForFunction(() => Boolean(window.viewer), null, {
      timeout: 60_000,
    });
    if (renderer === "webgpu") {
      await armWebGPUDevices(page);
    }

    owned.phase = `${renderer}:measure`;
    const measurement = await page.evaluate(acquirePageMeasurement, {
      renderer,
      assetUrl: GSPLAT_MULTIFRUSTUM_CONFIG.assetUrl,
    });
    owned.phase = `${renderer}:diagnostics`;
    const gpuGate =
      renderer === "webgpu"
        ? await collectGateErrors(page)
        : { errors: [], deviceLost: null, armedDevices: 0 };
    measurement.runtime.gpuGateArmedDevices = gpuGate.armedDevices;
    measurement.harnessErrors = [
      ...(measurement.harnessErrors ?? []),
      ...consoleErrors,
      ...gpuGate.errors,
      ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
      ...externalRequests.map(
        (url) => `non-loopback request escaped offline scene: ${url}`,
      ),
    ];
    measurement.diagnostics = {
      gpuGate,
      externalRequests: [...new Set(externalRequests)].sort(),
      pendingRequestsBeforeClose: pending.size,
    };
    session.measurement = measurement;
    return session;
  } finally {
    owned.phase = `${renderer}:cleanup`;
    const pageClose = await closeBounded(
      page,
      `${renderer} page`,
      SESSION_CLOSE_TIMEOUT_MS,
    );
    const contextClose = await closeBounded(
      context,
      `${renderer} context`,
      SESSION_CLOSE_TIMEOUT_MS,
    );
    if (pageClose.closed && owned.page === page) owned.page = undefined;
    if (contextClose.closed && owned.context === context) {
      owned.context = undefined;
    }
    const pendingRequests = pending.size;
    session.cleanup = {
      pageClose,
      contextClose,
      pendingRequests,
      complete:
        pageClose.closed && contextClose.closed && pendingRequests === 0,
    };
  }
}

async function acquireBothBackends(browser, options, owned) {
  const result = {
    sessions: [],
    cleanup: { complete: false },
  };
  try {
    for (const renderer of ["webgl", "webgpu"]) {
      result.sessions.push(
        await runBackend(browser, renderer, options.base, owned),
      );
    }
    return result;
  } finally {
    owned.phase = "browser-cleanup";
    const browserClose = await closeBounded(
      browser,
      "fleet browser",
      BROWSER_CLOSE_TIMEOUT_MS,
    );
    if (browserClose.closed && owned.browser === browser) {
      owned.browser = undefined;
    }
    let lastResortClose = {
      attempted: false,
      closed: browserClose.closed,
    };
    if (!browserClose.closed && owned.browser === browser) {
      try {
        // Fleet-visible last resort. The terminating process fuse owns a close
        // that does not return.
        await browser.close();
        lastResortClose = { attempted: true, closed: true };
        owned.browser = undefined;
      } catch (error) {
        lastResortClose = {
          attempted: true,
          closed: false,
          error: serializeError(error),
        };
      }
    }
    result.cleanup = {
      browserClose,
      lastResortClose,
      sessions: result.sessions.map((session) => session.cleanup),
      complete:
        browserClose.closed &&
        result.sessions.length === 2 &&
        result.sessions.every((session) => session.cleanup?.complete === true),
    };
  }
}

function artifactWithStatus(status, fields) {
  return {
    schema: GSPLAT_MULTIFRUSTUM_SCHEMA,
    instrument: "cesium.c15-g6.gsplat-multifrustum-probe.v1",
    disclosures: {
      acquisitionOnly: true,
      authoringRunState: "NEVER RUN IN AUTHORING LANE",
      verdictClaimedByLanding: false,
      forcedDepthPartition:
        "The probe forces logarithmicDepthFarToNearRatio=2 instead of the engine default 1e9.",
      flatGlobe:
        "The probe removes imagery, disables globe lighting/ground atmosphere, and installs ellipsoid terrain.",
      towerDepthRetarget:
        "The probe translates the tower tileset along its local up until the pinned nadir camera sits one derived margin below the first frustum boundary. At the asset's authored 2,852 m stand-off the globe and the splat occupy disjoint bands, so the row's two clauses cannot both hold; the margin is derived from the engine's own far inflation, and the retarget changes no projected geometry, so the registration and the bar are unmoved.",
      pageInstrumentPin:
        "The embedded declarations are token-and-behaviour pinned, not byte pinned, because repository formatting reflows them.",
      g3Interpretation:
        "Occlusion topology means the per-pixel background/globe/splat producer label, not a hidden-pixel count.",
      bar: "PRE-REGISTERED AND UNCALIBRATED; an intervening first-run measurement is a finding, not grounds to widen the bar.",
      tierRouting:
        "R-2026-08-24-14/-16, pre-registered: asymmetric one-backend zero-splat is FAIL exit 1 and outranks that backend's own zero-globe/single-label anti-vacuity reasons; symmetric zero/zero is STRUCTURAL exit 3; unrelated structurals outrank both.",
    },
    ...fields,
    status,
    exitCode: exitCodeForS5Status(status),
  };
}

export async function runGsplatMultifrustumProbe(options = {}) {
  const operations = options.operations ?? fs;
  const runId = options.runId ?? randomUUID();
  const paths = createRunPaths(runId, options.outputRoot);
  prepareRunDirectory(paths, operations);
  const startedAt = new Date().toISOString();
  const source = operations.readFileSync(probeSourcePath, "utf8");
  const capturePreflight = inspectGsplatMultifrustumCaptureContract(source);
  const registration = deriveGsplatTopologyRegistration(
    VIEWPORT.width,
    VIEWPORT.height,
  );
  const owned = {
    browser: undefined,
    context: undefined,
    page: undefined,
    pending: new Set(),
    phase: "preflight",
  };
  let artifact;
  let imageRecords = {};
  let quiescent = true;
  try {
    if (capturePreflight.failures.length > 0) {
      artifact = artifactWithStatus("STRUCTURAL", {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        registration,
        captureContract: { ...capturePreflight, writeOnce: true },
        structural: capturePreflight.failures,
        failures: [],
        harnessErrors: [],
        images: {},
      });
    } else {
      owned.phase = "browser-launch";
      const browser = await chromium.launch({
        channel: "msedge",
        headless: !options.headed,
        args: ["--enable-unsafe-webgpu"],
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      });
      owned.browser = browser;
      quiescent = false;
      const acquisition = await withGsplatMultifrustumWatchdog(
        () => acquireBothBackends(browser, options, owned),
        async () => {
          const checkpoint = await boundedPageCheckpoint(owned);
          const cleanup = await cleanupOwned(owned);
          return { checkpoint, ...cleanup };
        },
        options.watchdogMs ?? RUN_WATCHDOG_MS,
      );
      quiescent =
        acquisition.cleanup.complete === true &&
        !owned.browser &&
        !owned.context &&
        !owned.page &&
        (owned.pending?.size ?? 0) === 0;
      const persisted = await persistAndRederiveCaptureImages(
        paths,
        acquisition.sessions,
        imageRecords,
        operations,
      );
      imageRecords = persisted.records;
      const byRenderer = Object.fromEntries(
        acquisition.sessions.map((session) => [session.renderer, session]),
      );
      const harnessErrors = acquisition.sessions.flatMap((session) =>
        (session.measurement?.harnessErrors ?? []).map(
          (reason) => `${session.renderer}:${reason}`,
        ),
      );
      const backendRecords = Object.fromEntries(
        ["webgl", "webgpu"].map((renderer) => [
          renderer,
          {
            framing: byRenderer[renderer]?.measurement?.framing,
            passes: byRenderer[renderer]?.measurement?.passes,
            runtime: byRenderer[renderer]?.measurement?.runtime,
          },
        ]),
      );
      const framingAgreement = compareGsplatBackendFraming(backendRecords);
      let standing = null;
      if (harnessErrors.length === 0 && framingAgreement.agree) {
        const evaluationInput = {
          schema: GSPLAT_MULTIFRUSTUM_SCHEMA,
          passes: framingAgreement.passes,
          framing: framingAgreement.framing,
          backends: Object.fromEntries(
            ["webgl", "webgpu"].map((renderer) => {
              const measurement = byRenderer[renderer]?.measurement;
              return [
                renderer,
                { ...measurement?.control, settle: measurement?.settle },
              ];
            }),
          ),
        };
        standing = evaluateGsplatMultifrustumFraming(evaluationInput, () =>
          evaluateGsplatLabelTopology(
            persisted.frames.webgl?.clean,
            persisted.frames.webgpu?.clean,
          ),
        );
      }
      const evaluation = evaluateGsplatMultifrustumProbeResult({
        captureContract: capturePreflight,
        cleanup: acquisition.cleanup,
        harnessErrors,
        framingAgreement,
        standing,
      });
      const sessions = acquisition.sessions.map((session) => ({
        renderer: session.renderer,
        framing: session.measurement.framing,
        retarget: session.measurement.retarget,
        settle: session.measurement.settle,
        control: session.measurement.control,
        passes: session.measurement.passes,
        runtime: session.measurement.runtime,
        diagnostics: session.measurement.diagnostics,
        cleanup: session.cleanup,
      }));
      artifact = artifactWithStatus(evaluation.status, {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        registration,
        captureContract: { ...capturePreflight, writeOnce: true },
        framingAgreement,
        activeFrusta: standing?.activeFrusta ?? null,
        readOrder: standing?.readOrder ?? [],
        topology: evaluation.topology,
        structural: evaluation.structural,
        failures: evaluation.failures,
        harnessErrors: evaluation.harnessErrors,
        images: imageRecords,
        sessions,
        cleanup: acquisition.cleanup,
      });
    }
  } catch (error) {
    let terminalCleanup;
    let terminalCleanupError;
    try {
      terminalCleanup = await cleanupOwned(owned);
      quiescent =
        terminalCleanup.cleanupComplete === true &&
        !owned.browser &&
        !owned.context &&
        !owned.page;
    } catch (cleanupError) {
      quiescent = false;
      terminalCleanupError = serializeError(cleanupError);
    }
    artifact = artifactWithStatus("ERROR", {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      registration,
      captureContract: { ...capturePreflight, writeOnce: true },
      structural: [],
      failures: [],
      harnessErrors: [
        serializeError(error),
        ...(terminalCleanupError ? [terminalCleanupError] : []),
      ],
      images: imageRecords,
      cleanup: terminalCleanup ?? { complete: false },
    });
  }

  const artifactBytes = Buffer.from(stableJson(artifact));
  const reread = writeOnceExact(
    paths.artifact,
    artifactBytes,
    "final evidence",
    operations,
  );
  return {
    artifact,
    quiescent,
    publication: {
      file: paths.artifact,
      bytes: reread.length,
      sha256: sha256(reread),
    },
  };
}

function usage() {
  console.log(
    "Usage: node Tools/visual-regression/probe-gsplat-multifrustum.mjs " +
      "[--base URL] [--output-directory DIR] [--headed]\n\n" +
      "Requires an already-running loopback server and a current Build/CesiumUnminified build.",
  );
}

function parseArguments(argv) {
  const parsed = {
    base: validateLoopbackBase(defaultBase),
    outputRoot: defaultOutputRoot,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--base") {
      parsed.base = validateLoopbackBase(nextValue());
    } else if (argument === "--output-directory") {
      parsed.outputRoot = path.resolve(nextValue());
    } else if (argument === "--headed") {
      parsed.headed = true;
    } else if (argument === "--help") {
      usage();
      process.exit(exitCodeForS5Status("PASS"));
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return parsed;
}

async function main() {
  // The in-run watchdog can reject only if the event loop returns. This
  // terminating fuse stays armed through bounded teardown and evidence writes.
  const processWatchdog = setTimeout(() => {
    console.error(
      `[c15-g6] process watchdog fired after ${PROCESS_WATCHDOG_MS} ms`,
    );
    process.exit(exitCodeForS5Status("ERROR"));
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  let quiescent = false;
  try {
    const result = await runGsplatMultifrustumProbe(
      parseArguments(process.argv.slice(2)),
    );
    quiescent = result.quiescent === true;
    console.log(
      JSON.stringify(
        {
          status: result.artifact.status,
          exitCode: result.artifact.exitCode,
          runId: result.artifact.runId,
          evidence: result.publication,
        },
        null,
        2,
      ),
    );
    process.exitCode = exitCodeForS5Status(result.artifact.status);
  } catch (error) {
    console.error("[c15-g6] uncaught probe failure", error);
    process.exitCode = exitCodeForS5Status("ERROR");
  } finally {
    if (quiescent) clearTimeout(processWatchdog);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
