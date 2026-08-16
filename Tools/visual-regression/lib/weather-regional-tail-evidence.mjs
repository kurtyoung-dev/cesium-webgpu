// Pure evidence model for the C13-08 rendered-tail probe.
// @purpose Fixture and pass/fail policy for the C13-08 rendered antimeridian weather-tail probe, mutation-tested against its two target regressions.
// @status ACTIVE
//
// The browser probe owns scene construction and pixel capture. This module owns
// the fixture and pass/fail policy so mutation tests can prove the gate rejects
// the two regressions it exists to catch: a duplicated/nearly-global band on
// WebGPU and weather-provider state perturbing WebGL billboards.

export const ANTIMERIDIAN_LONGITUDES = Object.freeze([
  170, 175, 180, -175, -170,
]);

// The rendered lane samples 5 S, where the committed procedural map is clear
// on both sides of the seam. Keeping the field wider than that camera footprint
// makes a uniform-1 observation a strong positive response without measuring
// the regional rectangle's hard edge (feathering belongs to C13-20).
export const ANTIMERIDIAN_LATITUDES = Object.freeze([10, 0, -10]);

export function createAntimeridianCoverageJson() {
  const values = new Array(
    ANTIMERIDIAN_LONGITUDES.length * ANTIMERIDIAN_LATITUDES.length,
  ).fill(100);
  return {
    type: "Coverage",
    domain: {
      type: "Domain",
      domainType: "Grid",
      axes: {
        x: { values: [...ANTIMERIDIAN_LONGITUDES] },
        y: { values: [...ANTIMERIDIAN_LATITUDES] },
      },
    },
    ranges: {
      TCDC: {
        type: "NdArray",
        dataType: "float",
        axisNames: ["y", "x"],
        shape: [ANTIMERIDIAN_LATITUDES.length, ANTIMERIDIAN_LONGITUDES.length],
        values,
      },
    },
  };
}

export const WEBGPU_REGIONAL_TAIL_LIMITS = Object.freeze({
  minimumInsideBrightFractionDelta: 0.02,
  maximumFarSignificantMismatchFraction: 0.002,
  maximumFarMeanAbsoluteRgbDelta: 0.5,
  maximumSeamHalfRatio: 3.0,
  maximumCenterStepFloor: 20.0,
  maximumCenterStepToP95Ratio: 2.5,
});

export const WEBGL_REGIONAL_TAIL_LIMITS = Object.freeze({
  minimumBillboardBrightPixels: 50,
  maximumSignificantMismatchFraction: 0.001,
  maximumMeanAbsoluteRgbDelta: 0.25,
});

function regionalStatsAreValid(stats) {
  return (
    stats?.global === false &&
    Number.isInteger(stats.observedTexels) &&
    stats.observedTexels > 0 &&
    Number.isInteger(stats.filledTexels) &&
    stats.filledTexels > 0
  );
}

function parserBoundsAreValid(field) {
  return (
    field?.registration === "node" &&
    Math.abs(field.westDegrees - 170) < 1e-6 &&
    Math.abs(field.eastDegrees - 190) < 1e-6 &&
    Math.abs(field.southDegrees + 10) < 1e-6 &&
    Math.abs(field.northDegrees - 10) < 1e-6
  );
}

function insideResponse(control, regional, minimumDelta) {
  return (
    Number.isFinite(control?.brightFraction) &&
    Number.isFinite(regional?.brightFraction) &&
    regional.brightFraction - control.brightFraction >= minimumDelta
  );
}

export function assessWebGPURegionalTail(record) {
  const limits = WEBGPU_REGIONAL_TAIL_LIMITS;
  const seamControl = record?.control?.seam;
  const seamRegional = record?.regional?.seam;
  const seamDenominator = Math.max(
    1e-6,
    Math.min(
      seamRegional?.leftBrightFraction ?? 0,
      seamRegional?.rightBrightFraction ?? 0,
    ),
  );
  const seamHalfRatio =
    Math.max(
      seamRegional?.leftBrightFraction ?? 0,
      seamRegional?.rightBrightFraction ?? 0,
    ) / seamDenominator;
  const centerStepLimit = Math.max(
    limits.maximumCenterStepFloor,
    limits.maximumCenterStepToP95Ratio * (seamRegional?.columnStepP95 ?? 0),
  );

  const checks = {
    requestedRenderer: record?.renderer === "webgpu",
    providerFetched:
      record?.routeRequests >= 1 &&
      record?.provider?.hasData === true &&
      record?.provider?.version > 0 &&
      record?.provider?.lastError === null,
    parserDerivedWrappedBounds: parserBoundsAreValid(record?.field),
    regionalPackStats: regionalStatsAreValid(record?.provider?.packStats),
    eastSideObserved: insideResponse(
      record?.control?.east,
      record?.regional?.east,
      limits.minimumInsideBrightFractionDelta,
    ),
    westSideObserved: insideResponse(
      record?.control?.west,
      record?.regional?.west,
      limits.minimumInsideBrightFractionDelta,
    ),
    seamLeftObserved:
      (seamRegional?.leftBrightFraction ?? 0) -
        (seamControl?.leftBrightFraction ?? 0) >=
      limits.minimumInsideBrightFractionDelta,
    seamRightObserved:
      (seamRegional?.rightBrightFraction ?? 0) -
        (seamControl?.rightBrightFraction ?? 0) >=
      limits.minimumInsideBrightFractionDelta,
    seamHalvesContinuous: seamHalfRatio <= limits.maximumSeamHalfRatio,
    seamCenterHasNoWall:
      Number.isFinite(seamRegional?.centerColumnStepMax) &&
      seamRegional.centerColumnStepMax <= centerStepLimit,
    farViewUsesProceduralFill:
      record?.comparisons?.far?.significantMismatchFraction <=
        limits.maximumFarSignificantMismatchFraction &&
      record?.comparisons?.far?.meanAbsoluteRgbDelta <=
        limits.maximumFarMeanAbsoluteRgbDelta,
    sameEvaluationStats:
      record?.regional?.east?.packStats?.global === false &&
      record?.regional?.west?.packStats?.global === false &&
      record?.regional?.seam?.packStats?.global === false &&
      record?.regional?.far?.packStats?.global === false,
    deviceAndConsoleClean:
      Array.isArray(record?.errors) && record.errors.length === 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    diagnostics: { seamHalfRatio, centerStepLimit },
  };
}

export function assessWebGLRegionalTail(record) {
  const limits = WEBGL_REGIONAL_TAIL_LIMITS;
  const checks = {
    requestedRenderer: record?.renderer === "webgl",
    providerFetched:
      record?.routeRequests >= 1 &&
      record?.provider?.hasData === true &&
      record?.provider?.version > 0 &&
      record?.provider?.lastError === null,
    parserDerivedWrappedBounds: parserBoundsAreValid(record?.field),
    regionalPackStats: regionalStatsAreValid(record?.provider?.packStats),
    billboardLaneNonVacuous:
      record?.control?.brightPixels >= limits.minimumBillboardBrightPixels &&
      record?.regional?.brightPixels >= limits.minimumBillboardBrightPixels,
    billboardPixelsPreserved:
      record?.comparison?.significantMismatchFraction <=
        limits.maximumSignificantMismatchFraction &&
      record?.comparison?.meanAbsoluteRgbDelta <=
        limits.maximumMeanAbsoluteRgbDelta,
    noVolumetricPublication: record?.volumetricRequestCount === 0,
    sameEvaluationStats: record?.regional?.packStats?.global === false,
    consoleClean: Array.isArray(record?.errors) && record.errors.length === 0,
  };

  return { ok: Object.values(checks).every(Boolean), checks };
}

export default {
  ANTIMERIDIAN_LONGITUDES,
  ANTIMERIDIAN_LATITUDES,
  createAntimeridianCoverageJson,
  WEBGPU_REGIONAL_TAIL_LIMITS,
  WEBGL_REGIONAL_TAIL_LIMITS,
  assessWebGPURegionalTail,
  assessWebGLRegionalTail,
};
