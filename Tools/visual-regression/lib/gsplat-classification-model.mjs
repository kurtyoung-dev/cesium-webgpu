// gsplat-classification-model.mjs — browser-free C15-G7 pixel and route model.
// @purpose Pure C15-G7 Gaussian-splat classification placement, route-counter, negative-control, and verdict arithmetic for the fleet probe.
// @status ACTIVE
//
// The probe owns scene construction and immutable capture.  This module owns
// every inference made from those captures.  `summarizeClassificationPixels`
// is deliberately self-contained and executes in Node over RGBA decoded from
// the write-once reread PNGs; the browser owns no verdict oracle.

import { exitCodeForS5Status } from "./verdict-exit-gate.mjs";
import {
  TOWER_FRAMING_CONFIG,
  computeTowerTerrainRange,
  evaluateTowerMaskFloor,
} from "./gsplat-tower-framing.mjs";

export const GSPLAT_CLASSIFICATION_SCHEMA =
  "cesium.c15-g7.gsplat-classification-depth.v1";
export const GSPLAT_CLASSIFICATION_PIXEL_SCHEMA =
  "cesium.c15-g7.gsplat-classification-pixels.v1";

export const GSPLAT_CLASSIFICATION_CONFIG = Object.freeze({
  assetUrl: "/Specs/Data/Cesium3DTiles/GaussianSplats/tower/tileset.json",
  width: 960,
  height: 720,
  // The classified material is opaque magenta over a deliberately neutral,
  // dark scene.  These code-value tests recognize the material after normal
  // lighting/compositing while rejecting both the grey globe and the tower.
  minimumRed: 80,
  minimumBlue: 65,
  redOverGreen: 30,
  blueOverGreen: 20,
  minimumClassificationRgbDelta: 36,
  minimumTowerRgbDelta: 24,
  // The two projected runtime anchors must be far enough apart that a mask can
  // be assigned to a surface without sub-pixel judgement.  This is an
  // instrument-resolution precondition, not a product tolerance.
  minimumAnchorSeparationPixels: 40,
  // A signal must clear the measured same-state noise by this factor.  No
  // fixed product pixel count is smuggled into the row: the floor is derived
  // from the actual capture pair, with 16 pixels as the raster-resolution
  // minimum needed to reject a one-pixel/confetti coincidence.
  signalToNoiseMargin: 10,
  minimumResolvedPixels: 16,
  // A centroid must clear the perpendicular bisector by 10% of the measured
  // anchor separation.  The negative-reference agreement bound is one
  // quarter of that same runtime separation.
  anchorSideMarginFraction: 0.1,
  referenceAgreementFraction: 0.25,
  // The pre-registered framing floor (`gsplat-tower-framing.mjs`): below
  // this many rendered tower-silhouette pixels the probe refuses rather than
  // scoring the splat-overlap positive legs against a mask too small to
  // carry a meaningful verdict either way.
  minimumTowerMaskPixels: TOWER_FRAMING_CONFIG.minimumTowerMaskPixels,
});

/**
 * Derive classification topology from immutable RGBA frames.
 *
 * This function has no free variables and performs no canvas or filesystem
 * read.  The probe supplies each `data` array by decoding an immutable PNG
 * after its exclusive write and byte-exact reread.
 *
 * @param {object} input Capture frames and projected surface anchors.
 * @param {object} config Numeric discriminator configuration.
 * @returns {object} Serializable topology summary.
 */
export function summarizeClassificationPixels(input, config) {
  const failures = [];
  const requiredFrames = [
    "baseline",
    "tower",
    "towerRepeat",
    "terrainReference",
    "positive",
  ];
  const optionalFrames = ["suppressed", "restored"];
  const frames = input?.frames ?? {};

  const finite = (value) => Number.isFinite(value);
  const validPoint = (point) => point && finite(point.x) && finite(point.y);
  const validFrame = (frame) =>
    frame &&
    Number.isInteger(frame.width) &&
    frame.width > 0 &&
    Number.isInteger(frame.height) &&
    frame.height > 0 &&
    frame.data &&
    Number.isInteger(frame.data.length) &&
    frame.data.length === frame.width * frame.height * 4;

  for (const name of requiredFrames) {
    if (!validFrame(frames[name])) {
      failures.push(`pixels:${name}:invalid-frame`);
    }
  }
  for (const name of optionalFrames) {
    if (frames[name] !== undefined && !validFrame(frames[name])) {
      failures.push(`pixels:${name}:invalid-frame`);
    }
  }
  if (!validPoint(input?.anchors?.splat)) {
    failures.push("pixels:splat-anchor:invalid");
  }
  if (!validPoint(input?.anchors?.terrain)) {
    failures.push("pixels:terrain-anchor:invalid");
  }
  const numericKeys = [
    "minimumRed",
    "minimumBlue",
    "redOverGreen",
    "blueOverGreen",
    "minimumClassificationRgbDelta",
    "minimumTowerRgbDelta",
    "minimumAnchorSeparationPixels",
    "signalToNoiseMargin",
    "minimumResolvedPixels",
    "anchorSideMarginFraction",
    "referenceAgreementFraction",
    "minimumTowerMaskPixels",
  ];
  for (const key of numericKeys) {
    if (!finite(config?.[key]) || config[key] < 0) {
      failures.push(`pixels:config:${key}:invalid`);
    }
  }
  if (
    !Number.isInteger(config?.minimumResolvedPixels) ||
    config.minimumResolvedPixels < 1
  ) {
    failures.push("pixels:config:minimumResolvedPixels:not-positive-integer");
  }
  for (const key of [
    "anchorSideMarginFraction",
    "referenceAgreementFraction",
  ]) {
    if (config?.[key] <= 0 || config[key] > 1) {
      failures.push(`pixels:config:${key}:outside-(0,1]`);
    }
  }
  if (failures.length > 0) {
    return {
      schema: "cesium.c15-g7.gsplat-classification-pixels.v1",
      ok: false,
      failures,
    };
  }

  const allNames = [...requiredFrames, ...optionalFrames].filter(
    (name) => frames[name] !== undefined,
  );
  const width = frames.baseline.width;
  const height = frames.baseline.height;
  for (const name of allNames) {
    if (frames[name].width !== width || frames[name].height !== height) {
      failures.push(`pixels:${name}:dimension-mismatch`);
    }
  }
  if (failures.length > 0) {
    return {
      schema: "cesium.c15-g7.gsplat-classification-pixels.v1",
      ok: false,
      failures,
    };
  }

  const pixelCount = width * height;
  const anchorSeparationPixels = Math.hypot(
    input.anchors.splat.x - input.anchors.terrain.x,
    input.anchors.splat.y - input.anchors.terrain.y,
  );
  const splatRoiRadiusPixels =
    anchorSeparationPixels * config.referenceAgreementFraction;
  const rgbDelta = (left, right, offset) =>
    Math.abs(left[offset] - right[offset]) +
    Math.abs(left[offset + 1] - right[offset + 1]) +
    Math.abs(left[offset + 2] - right[offset + 2]);
  const changedMask = (left, right, threshold) => {
    const mask = new Uint8Array(pixelCount);
    for (let pixel = 0, offset = 0; pixel < pixelCount; pixel++, offset += 4) {
      if (rgbDelta(left.data, right.data, offset) >= threshold) {
        mask[pixel] = 1;
      }
    }
    return mask;
  };
  const classificationMask = (classified, clean) => {
    const mask = new Uint8Array(pixelCount);
    for (let pixel = 0, offset = 0; pixel < pixelCount; pixel++, offset += 4) {
      const red = classified.data[offset];
      const green = classified.data[offset + 1];
      const blue = classified.data[offset + 2];
      const chroma =
        red >= config.minimumRed &&
        blue >= config.minimumBlue &&
        red - green >= config.redOverGreen &&
        blue - green >= config.blueOverGreen;
      if (
        chroma &&
        rgbDelta(classified.data, clean.data, offset) >=
          config.minimumClassificationRgbDelta
      ) {
        mask[pixel] = 1;
      }
    }
    return mask;
  };
  const maskStats = (mask, towerMask) => {
    let pixels = 0;
    let xSum = 0;
    let ySum = 0;
    let towerOverlapPixels = 0;
    let splatRoiPixels = 0;
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      if (mask[pixel] !== 1) continue;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      pixels++;
      xSum += x;
      ySum += y;
      if (towerMask?.[pixel] === 1) towerOverlapPixels++;
      if (
        Math.hypot(x - input.anchors.splat.x, y - input.anchors.splat.y) <=
        splatRoiRadiusPixels
      ) {
        splatRoiPixels++;
      }
    }
    const centroid = pixels > 0 ? { x: xSum / pixels, y: ySum / pixels } : null;
    const distance = (point, anchor) =>
      point ? Math.hypot(point.x - anchor.x, point.y - anchor.y) : null;
    return {
      pixels,
      centroid,
      distanceToSplat: distance(centroid, input.anchors.splat),
      distanceToTerrain: distance(centroid, input.anchors.terrain),
      towerOverlapPixels,
      splatRoiPixels,
      towerOverlapFraction: pixels > 0 ? towerOverlapPixels / pixels : 0,
    };
  };
  const maskCount = (mask) => {
    let count = 0;
    for (const value of mask) count += value;
    return count;
  };
  const maskComparison = (left, right) => {
    let intersectionPixels = 0;
    let unionPixels = 0;
    let symmetricDifferencePixels = 0;
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const l = left[pixel] === 1;
      const r = right[pixel] === 1;
      if (l && r) intersectionPixels++;
      if (l || r) unionPixels++;
      if (l !== r) symmetricDifferencePixels++;
    }
    return {
      intersectionPixels,
      unionPixels,
      symmetricDifferencePixels,
      intersectionOverSmaller:
        Math.min(maskCount(left), maskCount(right)) > 0
          ? intersectionPixels / Math.min(maskCount(left), maskCount(right))
          : 0,
    };
  };
  const subtractMask = (left, right) => {
    const mask = new Uint8Array(pixelCount);
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      if (left[pixel] === 1 && right[pixel] !== 1) mask[pixel] = 1;
    }
    return mask;
  };

  const towerMask = changedMask(
    frames.tower,
    frames.baseline,
    config.minimumTowerRgbDelta,
  );
  // Relevant noise is a false CLASSIFICATION-colour detection in the clean
  // repeat, not arbitrary splat colour variance.  C15-G9 owns the latter; if
  // it were multiplied into this lane's signal floor, a stable magenta mask
  // could be made structurally unreachable by unrelated SH shimmer.
  const noiseMask = classificationMask(frames.towerRepeat, frames.tower);
  const masks = {
    terrainReference: classificationMask(
      frames.terrainReference,
      frames.baseline,
    ),
    positive: classificationMask(frames.positive, frames.tower),
  };
  if (frames.suppressed) {
    masks.suppressed = classificationMask(frames.suppressed, frames.tower);
    masks.suppressedLift = subtractMask(
      masks.suppressed,
      masks.terrainReference,
    );
  }
  if (frames.restored) {
    masks.restored = classificationMask(frames.restored, frames.tower);
  }
  // A BOTH classifier legitimately paints the exposed terrain surrounding the
  // tower.  Its full positive centroid can therefore stay near terrain even
  // when the splat route is correct.  Subtract the tower-hidden terrain
  // reference and score only the additional surface selected by the tower.
  masks.positiveLift = subtractMask(masks.positive, masks.terrainReference);
  if (masks.restored) {
    masks.restoredLift = subtractMask(masks.restored, masks.terrainReference);
  }

  const states = {};
  for (const [name, mask] of Object.entries(masks)) {
    states[name] = maskStats(mask, towerMask);
  }
  const comparisons = {};
  if (masks.suppressed) {
    comparisons.suppressedToTerrain = maskComparison(
      masks.suppressed,
      masks.terrainReference,
    );
  }
  if (masks.restored) {
    comparisons.restoredToPositive = maskComparison(
      masks.restored,
      masks.positive,
    );
  }

  return {
    schema: "cesium.c15-g7.gsplat-classification-pixels.v1",
    ok: true,
    failures: [],
    width,
    height,
    pixelCount,
    anchorSeparationPixels,
    splatRoiRadiusPixels,
    anchors: {
      splat: { ...input.anchors.splat },
      terrain: { ...input.anchors.terrain },
    },
    towerMaskPixels: maskCount(towerMask),
    // The pre-registered floor this run judged `towerMaskPixels` against,
    // read straight from `config` so the receipt states the number the
    // refusal (if any) was measured against rather than leaving a reader to
    // rediscover it from the source.
    framingFloor: config.minimumTowerMaskPixels,
    noisePixels: maskCount(noiseMask),
    states,
    comparisons,
  };
}

function pushUnless(list, condition, reason) {
  if (!condition) list.push(reason);
}

function validCounter(counter) {
  return (
    counter &&
    Number.isInteger(counter.executions) &&
    counter.executions >= 0 &&
    Number.isInteger(counter.selectedExecutions) &&
    counter.selectedExecutions >= 0 &&
    Number.isInteger(counter.fallbackExecutions) &&
    counter.fallbackExecutions >= 0 &&
    Number.isInteger(counter.unexpectedReadExecutions) &&
    counter.unexpectedReadExecutions >= 0
  );
}

function checkCommonVisual(summary, backend, structural, failures, config) {
  if (
    !summary ||
    summary.schema !== GSPLAT_CLASSIFICATION_PIXEL_SCHEMA ||
    summary.ok !== true
  ) {
    structural.push(`${backend}:pixels:summary-invalid`);
    return null;
  }
  const separation = summary.anchorSeparationPixels;
  pushUnless(
    structural,
    Number.isFinite(separation) &&
      separation >= config.minimumAnchorSeparationPixels,
    `${backend}:anchors:not-resolved`,
  );
  const signalFloor = Math.max(
    config.minimumResolvedPixels,
    config.signalToNoiseMargin * Math.max(1, summary.noisePixels),
  );
  pushUnless(
    structural,
    Number.isInteger(summary.towerMaskPixels) &&
      summary.towerMaskPixels > signalFloor,
    `${backend}:tower-mask:not-resolved`,
  );
  // A fixed, pre-registered floor independent of measured noise --
  // `tower-mask:not-resolved` above only rejects a mask the noise could have
  // produced by chance; this rejects a mask that is real but still too small
  // for the tower to be "filling a useful fraction of the capture" (a mask
  // just over signalFloor is not "the hundreds" the framing fix targets).
  const towerFloorResult = evaluateTowerMaskFloor(
    summary.towerMaskPixels,
    config.minimumTowerMaskPixels,
  );
  pushUnless(
    structural,
    towerFloorResult.ok,
    `${backend}:${towerFloorResult.reason}`,
  );
  const terrain = summary.states?.terrainReference;
  pushUnless(
    structural,
    terrain?.pixels > signalFloor,
    `${backend}:terrain-reference:not-live`,
  );
  // Pixel subtraction is authoritative only when the terrain-only lobe stays
  // wholly outside the splat-anchor ROI.  Base pixels may legitimately share the
  // tower silhouette, but identical magenta around the resolved surface anchor
  // could erase a correctly classified splat from positiveLift.
  pushUnless(
    structural,
    terrain?.splatRoiPixels === 0,
    `${backend}:terrain-reference:overlaps-splat-roi`,
  );
  const sideMargin = separation * config.anchorSideMarginFraction;
  pushUnless(
    structural,
    Number.isFinite(terrain?.distanceToTerrain) &&
      Number.isFinite(terrain?.distanceToSplat) &&
      terrain.distanceToTerrain + sideMargin < terrain.distanceToSplat,
    `${backend}:terrain-reference:not-on-terrain`,
  );

  const positiveFrame = summary.states?.positive;
  pushUnless(
    failures,
    positiveFrame?.pixels > signalFloor,
    `${backend}:positive:classification-not-live`,
  );
  const positive = summary.states?.positiveLift;
  pushUnless(
    failures,
    Number.isFinite(positive?.distanceToSplat) &&
      Number.isFinite(positive?.distanceToTerrain) &&
      positive.distanceToSplat + sideMargin < positive.distanceToTerrain,
    `${backend}:positive:polygon-not-on-splat`,
  );
  pushUnless(
    failures,
    positive?.towerOverlapPixels > signalFloor &&
      positive?.splatRoiPixels > signalFloor,
    `${backend}:positive:splat-overlap-below-noise`,
  );
  return { separation, sideMargin, signalFloor, positive, terrain };
}

function checkWebgpuControl(
  summary,
  route,
  common,
  structural,
  failures,
  config,
) {
  const instrument = route?.instrument;
  const instrumentFlags = [
    "commandLocated",
    "commandInFrustum",
    "gaussianSplatPass",
    "depthClassificationFlag",
    "variantDefined",
    "variantDistinctFromBase",
    "bundleAbsent",
    "stableCommandIdentity",
  ];
  for (const flag of instrumentFlags) {
    pushUnless(
      structural,
      instrument?.[flag] === true,
      `webgpu:route:${flag}:unproven`,
    );
  }
  for (const phase of ["positive", "suppressed", "restored"]) {
    pushUnless(
      structural,
      validCounter(route?.[phase]),
      `webgpu:route:${phase}:counter-invalid`,
    );
    pushUnless(
      structural,
      route?.[phase]?.unexpectedReadExecutions === 0,
      `webgpu:route:${phase}:unexpected-read-count`,
    );
  }

  if (validCounter(route?.positive)) {
    pushUnless(
      failures,
      route.positive.executions > 0 &&
        route.positive.selectedExecutions === route.positive.executions &&
        route.positive.fallbackExecutions === 0,
      "webgpu:route:classification-depth-pipeline-not-selected",
    );
  }
  if (validCounter(route?.suppressed)) {
    pushUnless(
      structural,
      route.suppressed.executions > 0 &&
        route.suppressed.selectedExecutions === 0 &&
        route.suppressed.fallbackExecutions === route.suppressed.executions,
      "webgpu:negative:suppression-did-not-force-base-pipeline",
    );
  }
  if (validCounter(route?.restored)) {
    pushUnless(
      structural,
      route.restored.executions > 0 &&
        route.restored.selectedExecutions === route.restored.executions &&
        route.restored.fallbackExecutions === 0,
      "webgpu:negative:route-not-restored",
    );
  }
  pushUnless(
    structural,
    instrument?.suppressionGetterHeld === true,
    "webgpu:negative:suppression-not-held",
  );
  pushUnless(
    structural,
    instrument?.descriptorRestored === true,
    "webgpu:negative:descriptor-not-restored",
  );

  if (!common) return;
  const suppressed = summary.states?.suppressed;
  const suppressedLift = summary.states?.suppressedLift;
  pushUnless(
    structural,
    suppressed?.pixels > common.signalFloor,
    "webgpu:negative:classification-not-live",
  );
  pushUnless(
    structural,
    Number.isFinite(suppressed?.distanceToTerrain) &&
      Number.isFinite(suppressed?.distanceToSplat) &&
      suppressed.distanceToTerrain + common.sideMargin <
        suppressed.distanceToSplat,
    "webgpu:negative:polygon-did-not-return-to-terrain",
  );
  const centroidDrift =
    suppressed?.centroid && common.terrain?.centroid
      ? Math.hypot(
          suppressed.centroid.x - common.terrain.centroid.x,
          suppressed.centroid.y - common.terrain.centroid.y,
        )
      : Number.POSITIVE_INFINITY;
  pushUnless(
    structural,
    centroidDrift <= common.separation * config.referenceAgreementFraction,
    "webgpu:negative:terrain-reference-disagreement",
  );
  // The terrain lobe from a BOTH classifier can dominate the whole-mask
  // centroid even while an invalid splat lobe remains.  The terrain-subtracted
  // lift must therefore stay below the same measured resolution/noise floor.
  pushUnless(
    structural,
    suppressedLift?.pixels < common.signalFloor &&
      suppressedLift?.towerOverlapPixels < common.signalFloor &&
      suppressedLift?.splatRoiPixels < common.signalFloor,
    "webgpu:negative:splat-lift-remains",
  );

  const restoredFrame = summary.states?.restored;
  const restored = summary.states?.restoredLift;
  pushUnless(
    structural,
    restoredFrame?.pixels > common.signalFloor &&
      restored?.pixels > common.signalFloor &&
      Number.isFinite(restored?.distanceToSplat) &&
      Number.isFinite(restored?.distanceToTerrain) &&
      restored.distanceToSplat + common.sideMargin <
        restored.distanceToTerrain &&
      restored.towerOverlapPixels > common.signalFloor &&
      restored.splatRoiPixels > common.signalFloor,
    "webgpu:negative:visual-route-not-restored",
  );
}

/**
 * Fold both backend observations.  Structural preconditions are deliberately
 * evaluated independently from the positive product predicates; in
 * particular, a live WebGPU route counter followed by terrain placement is a
 * FAIL, not a control failure.
 */
export function evaluateGsplatClassificationDepth(input) {
  const harnessErrors = Array.isArray(input?.harnessErrors)
    ? input.harnessErrors.filter(Boolean).map(String)
    : ["input:harness-errors-invalid"];
  const productErrors = Array.isArray(input?.productErrors)
    ? input.productErrors.filter(Boolean).map(String)
    : ["input:product-errors-invalid"];
  const structural = [];
  const failures = [
    ...productErrors.map((reason) => `product-error:${reason}`),
  ];

  if (input?.schema !== GSPLAT_CLASSIFICATION_SCHEMA) {
    structural.push("input:schema-invalid");
  }
  if (input?.captureContract?.canonical !== true) {
    structural.push("capture:canonical-source-unproven");
  }
  if (input?.captureContract?.singleBlock !== true) {
    structural.push("capture:marker-cardinality-unproven");
  }
  if (input?.captureContract?.usageValid !== true) {
    structural.push("capture:usage-unproven");
  }
  if (input?.captureContract?.writeOnce !== true) {
    structural.push("evidence:write-once-unproven");
  }
  if (input?.cleanup?.complete !== true) {
    harnessErrors.push("cleanup:incomplete");
  }

  const config = { ...GSPLAT_CLASSIFICATION_CONFIG, ...(input?.config ?? {}) };
  checkCommonVisual(
    input?.webgl?.pixels,
    "webgl",
    structural,
    failures,
    config,
  );
  const webgpuCommon = checkCommonVisual(
    input?.webgpu?.pixels,
    "webgpu",
    structural,
    failures,
    config,
  );
  checkWebgpuControl(
    input?.webgpu?.pixels,
    input?.webgpu?.route,
    webgpuCommon,
    structural,
    failures,
    config,
  );

  for (const backend of ["webgl", "webgpu"]) {
    const runtime = input?.[backend]?.runtime;
    pushUnless(
      structural,
      runtime &&
        runtime.ready === true &&
        runtime.globeTilesLoaded === true &&
        Number.isInteger(runtime.globeCommands) &&
        runtime.globeCommands > 0 &&
        Number.isInteger(runtime.splatCommands) &&
        runtime.splatCommands > 0 &&
        runtime.tilesetReady === true &&
        runtime.classifierReady === true,
      `${backend}:runtime:subject-not-ready`,
    );
    pushUnless(
      structural,
      runtime?.rendererType === backend,
      `${backend}:runtime:backend-identity-unproven`,
    );
    if (backend === "webgpu") {
      pushUnless(
        structural,
        Number.isInteger(runtime?.gpuGateArmedDevices) &&
          runtime.gpuGateArmedDevices > 0,
        "webgpu:runtime:error-gate-unarmed",
      );
    }
    // The page can't import `computeTowerTerrainRange` across the
    // `page.evaluate` boundary (see gsplat-tower-framing.mjs), so it
    // duplicates the formula inline. When a run records `runtime.framing`
    // telemetry (every real probe run does; older/unrelated fixtures that
    // predate this telemetry simply omit the field and are unaffected),
    // this recomputes the range from the page's own recorded inputs and
    // requires it to match what the page actually handed the camera -- the
    // formula's one production consumer, exercised on every real run rather
    // than only its own spec fixtures.
    const framing = runtime?.framing;
    if (framing !== undefined) {
      const framingInputsValid =
        Number.isFinite(framing?.verticalSeparationMeters) &&
        framing.verticalSeparationMeters > 0 &&
        Number.isFinite(framing?.fovYRadians) &&
        framing.fovYRadians > 0 &&
        Number.isFinite(framing?.marginFraction) &&
        framing.marginFraction > 0 &&
        Number.isFinite(framing?.range);
      pushUnless(
        structural,
        framingInputsValid &&
          Math.abs(
            framing.range -
              computeTowerTerrainRange(
                framing.verticalSeparationMeters,
                framing.fovYRadians,
                framing.marginFraction,
              ),
          ) <
            1e-6 * Math.max(1, framing.range),
        `${backend}:framing:range-not-pinned`,
      );
    }
  }

  const status =
    harnessErrors.length > 0
      ? "ERROR"
      : structural.length > 0
        ? "STRUCTURAL"
        : failures.length > 0
          ? "FAIL"
          : "PASS";
  return {
    status,
    exitCode: exitCodeForS5Status(status),
    harnessErrors,
    structural,
    failures,
  };
}

export default {
  GSPLAT_CLASSIFICATION_SCHEMA,
  GSPLAT_CLASSIFICATION_PIXEL_SCHEMA,
  GSPLAT_CLASSIFICATION_CONFIG,
  summarizeClassificationPixels,
  evaluateGsplatClassificationDepth,
};
