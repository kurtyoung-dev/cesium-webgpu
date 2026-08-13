/**
 * Pure policy for C12-29 S5's NASA-SVS 5073 absolute-footprint gate.
 *
 * The browser probe owns rendering, terrain sampling, and evidence publication.
 * This module owns the frozen experiment, physically-derived error budget, and
 * fail-closed verdict.  It intentionally has no browser or filesystem side
 * effects; SHA-256 is used only to bind reported primitive geometry to the
 * frozen fixture bytes.
 */

import { createHash } from "node:crypto";

export const C12_29_S5_SVS_SCHEMA = "c12-29-s5-svs-5073-footprint-evidence-v2";

export const C12_29_S5_SVS_DIAGNOSTICS_SCHEMA =
  "c12-29-s5-svs-5073-footprint-runtime-diagnostics-v2";

export const C12_29_S5_SVS_RENDERERS = Object.freeze(["webgl", "webgpu"]);

export const C12_29_S5_SVS_PHASES = Object.freeze([
  "A-runtime-fixture-ready",
  "B-icrf-ephemeris-ready",
  "C-mazatlan-180930",
  "D-greatest-before-181710",
  "E-greatest-after-181720",
  "F-dallas-184250",
  "G-noneclipse-control",
  "H-cleanup",
]);

export const C12_29_S5_SVS_ROWS = Object.freeze([
  Object.freeze({
    phase: C12_29_S5_SVS_PHASES[2],
    role: "named-observer-mazatlan",
    iso: "2024-04-08T18:09:30Z",
    sourceIndexZeroBased: 544,
    sourceRecordNumber: 545,
    outputRecordNumber: 1,
    sourceCenter: Object.freeze([-106.26671, 23.04871]),
    fixtureGeometry: Object.freeze({
      bbox: Object.freeze([
        -107.22654104232788, 22.150620818138123, -105.30465245246887,
        23.94869863986969,
      ]),
      storedPointCount: 171,
      canonicalSha256:
        "cbe7ce4c78ba5c87029ae58dcfaad303c137cc2e56141d9b5742d9288e56af66",
    }),
  }),
  Object.freeze({
    phase: C12_29_S5_SVS_PHASES[3],
    role: "greatest-eclipse-10-second-bracket-before",
    iso: "2024-04-08T18:17:10Z",
    sourceIndexZeroBased: 590,
    sourceRecordNumber: 591,
    outputRecordNumber: 2,
    sourceCenter: Object.freeze([-104.1956, 25.24078]),
    fixtureGeometry: Object.freeze({
      bbox: Object.freeze([
        -105.1610791683197, 24.345703125, -103.22807550430298,
        26.14741802215576,
      ]),
      storedPointCount: 171,
      canonicalSha256:
        "62cf49e5fc9006782ea8e277183b151512eaeefc99a62a15f216d9dc26b56736",
    }),
  }),
  Object.freeze({
    phase: C12_29_S5_SVS_PHASES[4],
    role: "greatest-eclipse-10-second-bracket-after",
    iso: "2024-04-08T18:17:20Z",
    sourceIndexZeroBased: 591,
    sourceRecordNumber: 592,
    outputRecordNumber: 3,
    sourceCenter: Object.freeze([-104.14985, 25.2883]),
    fixtureGeometry: Object.freeze({
      bbox: Object.freeze([
        -105.11703729629517, 24.3896484375, -103.18379759788513,
        26.19140088558197,
      ]),
      storedPointCount: 171,
      canonicalSha256:
        "8f602dac4d56239475a17a067791ec9d32c999d77db05f67da22472b6b908a42",
    }),
  }),
  Object.freeze({
    phase: C12_29_S5_SVS_PHASES[5],
    role: "named-observer-dallas",
    iso: "2024-04-08T18:42:50Z",
    sourceIndexZeroBased: 744,
    sourceRecordNumber: 745,
    outputRecordNumber: 4,
    sourceCenter: Object.freeze([-96.43722, 32.51228]),
    fixtureGeometry: Object.freeze({
      bbox: Object.freeze([
        -97.43116736412048, 31.586101055145264, -95.44056594371796,
        33.4423828125,
      ]),
      storedPointCount: 174,
      canonicalSha256:
        "021af6dbeaf85f8501438224f5c5a9b50b3305176a4dc56c3fd690e50c7efe29",
    }),
  }),
]);

export const C12_29_S5_SVS_CONTROL = Object.freeze({
  phase: C12_29_S5_SVS_PHASES[6],
  role: "noneclipse-control",
  iso: "2024-04-09T18:17:15Z",
  bracketBeforeRole: "greatest-eclipse-10-second-bracket-before",
  bracketAfterRole: "greatest-eclipse-10-second-bracket-after",
  bracketMidpointIso: "2024-04-08T18:17:15Z",
  offsetSeconds: 86_400,
  derivation: "greatest-bracket-midpoint-2024-04-08T18:17:15Z-plus-exactly-24h",
  cameraSourceRole: "greatest-eclipse-10-second-bracket-before",
  projectionSourceRole: "greatest-eclipse-10-second-bracket-before",
  terrainSourceRole: "greatest-eclipse-10-second-bracket-before",
});

export const C12_29_S5_SVS_CAPTURE_LABELS = Object.freeze([
  ...C12_29_S5_SVS_ROWS.flatMap((row) => [`${row.role}-off`, `${row.role}-on`]),
  "noneclipse-control-off",
  "noneclipse-control-on",
]);

export const C12_29_S5_SVS_CAPTURE_METHOD =
  "scene.render(pinnedJulianDate)+single-toDataURL+decode-same-immutable-PNG";

export const C12_29_S5_SVS_FIXTURE = Object.freeze({
  stem: "umbra-lo-c1229-s5",
  baseRoute: "/Tools/visual-regression/fixtures/nasa-svs-5073/",
  manifest: Object.freeze({
    file: "manifest.json",
    bytes: 9515,
    sha256: "9b977523d8a041d875a2f9cd42a18695824963b9e81a195213c3c0276543edab",
    schema: "nasa-svs-5073-umbra-lo-c1229-s5-fixture-v1",
  }),
  fixtureSetSha256:
    "1ee9f2537864171786ea9669cf01bf078cfcd92b47678c16b440811911f4844e",
  storedPointCount: 687,
  distinctNonClosingVertices: 683,
  members: Object.freeze({
    shp: Object.freeze({
      bytes: 11316,
      sha256:
        "bd5e931b81ccb1092a0d33d1156591ce5183924b9e4f78d9a61fbf3526d46c65",
    }),
    shx: Object.freeze({
      bytes: 132,
      sha256:
        "be4b5d094cf2a7ca0d38d2965d2c83320a9f3d0c1cd9ae1f87c89a5ab6866831",
    }),
    dbf: Object.freeze({
      bytes: 749,
      sha256:
        "84393c62b748d447ff4453b207d4314ed92c9666c792a9d885d1f966c4fb9168",
    }),
    prj: Object.freeze({
      bytes: 143,
      sha256:
        "98aaf3d1c0ecadf1a424a4536de261c3daf4e373697cb86c40c43b989daf52eb",
    }),
  }),
});

export const C12_29_S5_SVS_TERRAIN = Object.freeze({
  baseRoute: "/Specs/Data/CesiumTerrainTileJson/QuantizedMesh/",
  layer: Object.freeze({
    file: "Specs/Data/CesiumTerrainTileJson/QuantizedMesh/layer.json",
    byteLength: 569,
    sha256: "6c0e246c3bb2f0db6104c12560052369516a673020faee860a6e3113e57b4736",
  }),
  tile: Object.freeze({
    file: "Specs/Data/CesiumTerrainTileJson/QuantizedMesh/tile.terrain",
    byteLength: 3914,
    sha256: "8dc69d9e132d059ad77080c51daf844e255295c35a3c2654d243349b81a565b2",
  }),
});

export const C12_29_S5_SVS_SCENE = Object.freeze({
  viewport: Object.freeze({ width: 960, height: 960 }),
  cameraGuardDegrees: 1.5,
  minimumMarginPixels: 32,
  latticeSide: 129,
  minimumUniqueValidProjectedCells: 12000,
  minimumNasaInsideCells: 512,
  minimumNasaOutsideCells: 512,
  terrainResponseCodeThreshold: 8,
  offMinimumLuminanceCode: 16,
  onOffRatioMaximum: 0.02,
  controlOneCodeAllowance: 1,
  providerReadinessMaxFrames: 300,
  transitionReadinessMaxFrames: 120,
  readinessConsecutiveStableFrames: 3,
  readinessMethod:
    "render-first+three-consecutive-camera-provider-selection-content-stable-frames",
  cleanupCloseTimeoutMs: 15_000,
  cameraMode: "nadir-wgs84-dbf-centre",
  framingRule:
    "union-bbox-plus-1.5deg-guard-fit-fixed-fov-height-minimum-32px-margin",
  terrainMaskMethod:
    "same-camera-white-vs-black-baseColor-absolute-code-response-greater-than-8-intersect-valid-wgs84",
});

// This is the longest adjacent edge in the exact, unresampled NASA SVS shard.
// It is source resolution, not a tolerance fitted to a browser result.
export const C12_29_S5_SVS_SOURCE_EDGE = Object.freeze({
  maximumAdjacentDistanceKm: 8.172426664252349,
  method: "WGS84-EllipsoidGeodesic-surfaceDistance",
  units: "kilometres",
  outputRecordNumber: 4,
  edgeIndexZeroBased: 3,
  startLonLat: Object.freeze([-96.43798828125, 33.4423828125]),
  endLonLat: Object.freeze([-96.35009765625, 33.4423828125]),
});
export const C12_29_S5_SVS_SOURCE_MAX_EDGE_KM =
  C12_29_S5_SVS_SOURCE_EDGE.maximumAdjacentDistanceKm;
export const C12_29_S5_SVS_SIMON1994_BUDGET_KM = 40;

export const C12_29_S5_SVS_SOURCE_MOTION = Object.freeze({
  fromRole: "greatest-eclipse-10-second-bracket-before",
  toRole: "greatest-eclipse-10-second-bracket-after",
  seconds: 10,
  vectorDistanceKm: 6.996388125166818,
  initialHeadingDegrees: 41.191126975643336,
  eastKm: 4.607631831360955,
  northKm: 5.264900350871282,
  direction: "east+north",
  speedKmPerHour: 2518.6997250600543,
  method: "WGS84-EllipsoidGeodesic-with-local-ENU-components",
});

export const C12_29_S5_SVS_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Core/Cartesian2.js",
  "packages/engine/Source/Core/Cartesian3.js",
  "packages/engine/Source/Core/Cartographic.js",
  "packages/engine/Source/Core/Color.js",
  "packages/engine/Source/Core/EllipsoidGeodesic.js",
  "packages/engine/Source/Core/JulianDate.js",
  "packages/engine/Source/Core/Math.js",
  "packages/engine/Source/Core/Matrix3.js",
  "packages/engine/Source/Core/TimeInterval.js",
  "packages/engine/Source/Core/VerticalExaggeration.js",
  "packages/engine/Source/Core/Visibility.js",
  "packages/engine/Source/Core/Transforms.js",
  "packages/engine/Source/Core/Iau2006XysData.js",
  "packages/engine/Source/Core/Simon1994PlanetaryPositions.js",
  "packages/engine/Source/Core/CesiumTerrainProvider.js",
  "packages/engine/Source/Core/QuantizedMeshTerrainData.js",
  "packages/engine/Source/Scene/GridImageryProvider.js",
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/EclipseGlobeShadow.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/SceneTransforms.js",
  "packages/engine/Source/Scene/View.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Scene/SceneUtilities.js",
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/GlobeSurfaceTile.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
  "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js",
  "packages/engine/Source/Scene/TerrainFillMesh.js",
  "packages/engine/Source/Scene/QuadtreePrimitive.js",
  "packages/engine/Source/Scene/TileSelectionResult.js",
  "packages/engine/Source/Scene/Picking.js",
  "packages/engine/Source/Scene/PickFramebuffer.js",
  "packages/engine/Source/Renderer/Sync.js",
  "packages/engine/Source/Renderer/Pass.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
  "packages/engine/Source/Shaders/GlobeFS.glsl",
  "packages/engine/Source/Shaders/GlobeFS.js",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
  "packages/engine/Source/Scene/DynamicEnvironmentMapManager.js",
  "packages/engine/Source/Renderer/FeatureRendererKey.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
]);

export const C12_29_S5_SVS_BUILD_SOURCE_FILES = Object.freeze(
  C12_29_S5_SVS_SOURCE_FILES.filter(
    (file) => !file.endsWith(".glsl") && !file.endsWith(".wgsl"),
  ),
);

export const C12_29_S5_SVS_BUILD_SOURCE_MAP =
  "Build/CesiumUnminified/index.js.map";

const SHA256 = /^[0-9a-f]{64}$/u;
const FINAL_STATUSES = new Set(["PASS", "FAIL", "STRUCTURAL", "ERROR"]);
const spatialMetricCache = new Map();
const latticeAnchorCache = new Map();

const finite = (value) => Number.isFinite(value);
const close = (left, right, epsilon = 1e-9) =>
  finite(left) && finite(right) && Math.abs(left - right) <= epsilon;

function exactSortedUniqueIntegers(value) {
  if (!Array.isArray(value)) return false;
  let previous = -1;
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item <= previous) return false;
    previous = item;
  }
  return true;
}

function exactSortedUniqueTileIds(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => /^\d+\/\d+\/\d+$/u.test(item)) &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameMembers(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function exactObjectKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function isCanonicalUtcTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isSubsetOf(values, membership) {
  return (
    Array.isArray(values) && values.every((value) => membership.has(value))
  );
}

function pointInFixtureRing([longitude, latitude], ring) {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const [x, y] = ring[index];
    const [priorX, priorY] = ring[previous];
    if (
      y > latitude !== priorY > latitude &&
      longitude < ((priorX - x) * (latitude - y)) / (priorY - y) + x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function fixtureGeometrySha256(bbox, ring) {
  return createHash("sha256")
    .update(JSON.stringify([bbox, ring]))
    .digest("hex");
}

function validateFixtureGeometry(row, expected, renderer, reasons) {
  const geometry = row?.fixtureGeometry;
  const bbox = geometry?.bbox;
  const ring = geometry?.ring;
  const pinned = expected.fixtureGeometry;
  const coordinatesValid =
    Array.isArray(ring) &&
    ring.length === pinned.storedPointCount &&
    ring.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every(finite) &&
        Math.abs(point[0]) <= 180 &&
        Math.abs(point[1]) <= 90,
    );
  let derivedBbox;
  if (coordinatesValid) {
    derivedBbox = ring.reduce(
      (bounds, [longitude, latitude]) => [
        Math.min(bounds[0], longitude),
        Math.min(bounds[1], latitude),
        Math.max(bounds[2], longitude),
        Math.max(bounds[3], latitude),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
  }
  let computedSha256;
  if (coordinatesValid && Array.isArray(bbox) && bbox.length === 4) {
    computedSha256 = fixtureGeometrySha256(bbox, ring);
  }
  if (
    !coordinatesValid ||
    !sameMembers(bbox, pinned.bbox) ||
    !sameMembers(derivedBbox, pinned.bbox) ||
    !sameMembers(ring?.[0], ring?.at(-1)) ||
    geometry?.storedPointCount !== pinned.storedPointCount ||
    geometry?.canonicalSha256 !== pinned.canonicalSha256 ||
    computedSha256 !== pinned.canonicalSha256
  ) {
    reasons.push(
      `${renderer}/${row?.role}: fixture geometry is not the frozen row`,
    );
    return undefined;
  }
  return { bbox, ring, canonicalSha256: computedSha256 };
}

/** WGS84 inverse-geodesic distance for Node-side cross-backend comparison. */
export function wgs84GeodesicDistanceKm(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== 2 ||
    right.length !== 2 ||
    !left.every(finite) ||
    !right.every(finite) ||
    Math.abs(left[1]) > 90 ||
    Math.abs(right[1]) > 90
  ) {
    return NaN;
  }
  if (sameMembers(left, right)) return 0;

  // Vincenty's inverse solution on the WGS84 ellipsoid. The experiment's
  // paired centroids are nearby, so the well-known antipodal singularity is
  // outside the frozen domain; failure to converge still returns NaN.
  const semiMajorMeters = 6_378_137;
  const flattening = 1 / 298.257223563;
  const semiMinorMeters = semiMajorMeters * (1 - flattening);
  const radians = Math.PI / 180;
  const phi1 = left[1] * radians;
  const phi2 = right[1] * radians;
  const reduced1 = Math.atan((1 - flattening) * Math.tan(phi1));
  const reduced2 = Math.atan((1 - flattening) * Math.tan(phi2));
  const sin1 = Math.sin(reduced1);
  const cos1 = Math.cos(reduced1);
  const sin2 = Math.sin(reduced2);
  const cos2 = Math.cos(reduced2);
  const longitudeDifference = (right[0] - left[0]) * radians;
  let lambda = longitudeDifference;
  let sinSigma;
  let cosSigma;
  let sigma;
  let sinAlpha;
  let cosSquaredAlpha;
  let cosTwoSigmaMidpoint;
  let converged = false;
  for (let iteration = 0; iteration < 200; iteration++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(
      cos2 * sinLambda,
      cos1 * sin2 - sin1 * cos2 * cosLambda,
    );
    if (sinSigma === 0) return 0;
    cosSigma = sin1 * sin2 + cos1 * cos2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cos1 * cos2 * sinLambda) / sinSigma;
    cosSquaredAlpha = 1 - sinAlpha * sinAlpha;
    cosTwoSigmaMidpoint =
      cosSquaredAlpha === 0
        ? 0
        : cosSigma - (2 * sin1 * sin2) / cosSquaredAlpha;
    const coefficient =
      (flattening / 16) *
      cosSquaredAlpha *
      (4 + flattening * (4 - 3 * cosSquaredAlpha));
    const next =
      longitudeDifference +
      (1 - coefficient) *
        flattening *
        sinAlpha *
        (sigma +
          coefficient *
            sinSigma *
            (cosTwoSigmaMidpoint +
              coefficient *
                cosSigma *
                (-1 + 2 * cosTwoSigmaMidpoint * cosTwoSigmaMidpoint)));
    if (Math.abs(next - lambda) <= 1e-12) {
      converged = true;
      break;
    }
    lambda = next;
  }
  if (!converged) return NaN;
  const reducedSquared =
    (cosSquaredAlpha *
      (semiMajorMeters * semiMajorMeters - semiMinorMeters * semiMinorMeters)) /
    (semiMinorMeters * semiMinorMeters);
  const seriesA =
    1 +
    (reducedSquared / 16_384) *
      (4096 +
        reducedSquared *
          (-768 + reducedSquared * (320 - 175 * reducedSquared)));
  const seriesB =
    (reducedSquared / 1024) *
    (256 +
      reducedSquared * (-128 + reducedSquared * (74 - 47 * reducedSquared)));
  const deltaSigma =
    seriesB *
    sinSigma *
    (cosTwoSigmaMidpoint +
      (seriesB / 4) *
        (cosSigma * (-1 + 2 * cosTwoSigmaMidpoint * cosTwoSigmaMidpoint) -
          (seriesB / 6) *
            cosTwoSigmaMidpoint *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cosTwoSigmaMidpoint * cosTwoSigmaMidpoint)));
  return (semiMinorMeters * seriesA * (sigma - deltaSigma)) / 1000;
}

export function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value ?? "",
  );
}

export function exitCodeForSvsStatus(status) {
  if (status === "PASS") return 0;
  if (status === "FAIL") return 1;
  if (status === "ERROR") return 2;
  return 3;
}

/**
 * Derive every spatial tolerance from source resolution and two quantizers.
 * There is deliberately no IoU or observed-centroid input.
 */
export function computeSvsFootprintBudget({
  latticePitchKm,
  pixelGroundFootprintKm,
  sourceMaxAdjacentEdgeKm = C12_29_S5_SVS_SOURCE_MAX_EDGE_KM,
  simon1994BudgetKm = C12_29_S5_SVS_SIMON1994_BUDGET_KM,
} = {}) {
  if (
    !finite(latticePitchKm) ||
    latticePitchKm <= 0 ||
    !finite(pixelGroundFootprintKm) ||
    pixelGroundFootprintKm <= 0 ||
    sourceMaxAdjacentEdgeKm !== C12_29_S5_SVS_SOURCE_MAX_EDGE_KM ||
    simon1994BudgetKm !== C12_29_S5_SVS_SIMON1994_BUDGET_KM
  ) {
    throw new TypeError(
      "SVS footprint budget inputs are not the frozen design",
    );
  }
  const latticeHalfKm = 0.5 * latticePitchKm;
  const pixelHalfKm = 0.5 * pixelGroundFootprintKm;
  const quantizationKm = latticeHalfKm + pixelHalfKm;
  const qKm = sourceMaxAdjacentEdgeKm + quantizationKm;
  const centroidLimitKm =
    simon1994BudgetKm + sourceMaxAdjacentEdgeKm + quantizationKm;
  const motionVectorLimitKm = 2 * qKm;
  const speedUncertaintyKmPerHour =
    (motionVectorLimitKm / C12_29_S5_SVS_SOURCE_MOTION.seconds) * 3600;
  return Object.freeze({
    sourceMaxAdjacentEdgeKm,
    simon1994BudgetKm,
    latticePitchKm,
    pixelGroundFootprintKm,
    latticeHalfKm,
    pixelHalfKm,
    quantizationKm,
    qKm,
    boundaryP95LimitKm: qKm,
    boundaryMaximumLimitKm: 2 * qKm,
    centroidLimitKm,
    motionVectorLimitKm,
    speedUncertaintyKmPerHour,
  });
}

export function validateSvsRunningArtifactShape(artifact) {
  const reasons = [];
  if (
    !exactObjectKeys(artifact, [
      "schema",
      "runId",
      "generatedAt",
      "status",
      "incomplete",
      "nonce",
    ])
  ) {
    reasons.push("RUNNING artifact keys are not exact");
  }
  if (artifact?.schema !== C12_29_S5_SVS_SCHEMA) {
    reasons.push("RUNNING artifact schema is not the frozen SVS schema");
  }
  if (!isUuidV4(artifact?.runId)) {
    reasons.push("RUNNING artifact runId is not UUIDv4");
  }
  if (artifact?.status !== "RUNNING") {
    reasons.push("RUNNING artifact status differs");
  }
  if (artifact?.incomplete !== true) {
    reasons.push("RUNNING artifact is not incomplete");
  }
  if (!isUuidV4(artifact?.nonce)) {
    reasons.push("RUNNING artifact nonce is not UUIDv4");
  }
  if (!isCanonicalUtcTimestamp(artifact?.generatedAt)) {
    reasons.push("RUNNING artifact generatedAt is not exact ISO-8601 UTC");
  }
  return reasons;
}

export function validateSvsFinalArtifactShape(artifact) {
  const reasons = [];
  if (artifact?.schema !== C12_29_S5_SVS_SCHEMA) {
    reasons.push("artifact schema is not the frozen SVS schema");
  }
  if (!isUuidV4(artifact?.runId)) reasons.push("artifact runId is not UUIDv4");
  if (!FINAL_STATUSES.has(artifact?.status)) {
    reasons.push("artifact status is not final");
  }
  if (artifact?.exitCode !== exitCodeForSvsStatus(artifact?.status)) {
    reasons.push("artifact exit code does not match status");
  }
  if (artifact?.incomplete !== false)
    reasons.push("final artifact is incomplete");
  if (!isCanonicalUtcTimestamp(artifact?.generatedAt)) {
    reasons.push("artifact generatedAt is not exact ISO-8601 UTC");
  }
  if (artifact?.status === "ERROR") {
    if (
      !exactObjectKeys(artifact, [
        "schema",
        "runId",
        "generatedAt",
        "status",
        "exitCode",
        "incomplete",
        "error",
        "diagnostics",
      ])
    ) {
      reasons.push("ERROR artifact keys are not exact");
    }
    if (typeof artifact?.error !== "string" || artifact.error.length === 0) {
      reasons.push("ERROR artifact has no error diagnostic");
    }
    if (
      artifact?.diagnostics !== null &&
      (artifact.diagnostics === null ||
        typeof artifact.diagnostics !== "object" ||
        Array.isArray(artifact.diagnostics))
    ) {
      reasons.push("ERROR artifact diagnostics are malformed");
    }
  } else {
    if (
      !exactObjectKeys(artifact, [
        "schema",
        "runId",
        "generatedAt",
        "status",
        "exitCode",
        "incomplete",
        "report",
      ])
    ) {
      reasons.push("certifying artifact keys are not exact");
    }
    if (
      !exactObjectKeys(artifact?.report, [
        "schema",
        "runId",
        "lifecycle",
        "provenance",
        "sessions",
        "crossBackend",
        "status",
        "exitCode",
        "structuralReasons",
        "failures",
      ])
    ) {
      reasons.push("certifying report keys are not exact");
    }
    if (artifact?.report?.schema !== artifact?.schema) {
      reasons.push("artifact/report schema mismatch");
    }
    if (artifact?.report?.runId !== artifact?.runId) {
      reasons.push("artifact/report run identity mismatch");
    }
    if (artifact?.report?.status !== artifact?.status) {
      reasons.push("artifact/report status mismatch");
    }
    let folded;
    try {
      folded = foldC1229S5SvsGate(artifact?.report);
    } catch (error) {
      reasons.push(`artifact report fold failed: ${error.message}`);
    }
    if (
      folded &&
      (artifact?.report?.status !== folded.status ||
        artifact?.report?.exitCode !== folded.exitCode ||
        !sameMembers(
          artifact?.report?.structuralReasons,
          folded.structuralReasons,
        ) ||
        !sameMembers(artifact?.report?.failures, folded.failures))
    ) {
      reasons.push("artifact report verdict is not an exact pure fold");
    }
  }
  return reasons;
}

function validateFingerprint(actual, expected, label, reasons) {
  if (
    actual?.byteLength !== expected.bytes &&
    actual?.byteLength !== expected.byteLength
  ) {
    reasons.push(`${label}: byte length differs`);
  }
  if (actual?.sha256 !== expected.sha256) reasons.push(`${label}: SHA differs`);
}

function validateProvenance(provenance, reasons) {
  if (!/^[0-9a-f]{40}$/u.test(provenance?.gitHead ?? "")) {
    reasons.push("git HEAD provenance is absent");
  }
  if (provenance?.sourceStable !== true)
    reasons.push("source bytes were unstable");
  if (provenance?.buildStable !== true)
    reasons.push("build bytes were unstable");
  if (provenance?.servedEntry?.ok !== true) {
    reasons.push("served entry identity is not exact");
  }
  if (provenance?.buildSourceIdentity?.ok !== true) {
    reasons.push("build/source-map identity is not exact");
  }
  const buildEntries = provenance?.buildSourceIdentity?.entries;
  if (
    !Array.isArray(buildEntries) ||
    buildEntries.length !== C12_29_S5_SVS_BUILD_SOURCE_FILES.length ||
    buildEntries.some((entry, index) => {
      const relative = C12_29_S5_SVS_BUILD_SOURCE_FILES[index];
      const file = String(entry?.file ?? "").replaceAll("\\", "/");
      const expectedMap = `../../${relative}`;
      return (
        !/^(?:[A-Za-z]:\/|\/)/u.test(file) ||
        !file.endsWith(`/${relative}`) ||
        entry?.sourceMapEntry !== expectedMap ||
        entry?.exact !== true ||
        !(entry?.currentByteLength > 0) ||
        entry?.currentByteLength !== entry?.embeddedByteLength ||
        !SHA256.test(entry?.currentSha256 ?? "") ||
        entry?.currentSha256 !== entry?.embeddedSha256 ||
        entry?.reason != null
      );
    })
  ) {
    reasons.push(
      "build/source-map entries are not exact one-to-one identities",
    );
  }
  if (provenance?.fixtureSetSha256 !== C12_29_S5_SVS_FIXTURE.fixtureSetSha256) {
    reasons.push("fixture-set identity differs");
  }
  validateFingerprint(
    provenance?.fixtures?.manifest,
    C12_29_S5_SVS_FIXTURE.manifest,
    "fixture manifest",
    reasons,
  );
  if (
    provenance?.generatedShaders?.globeFsExact !== true ||
    provenance?.generatedShaders?.globeTerrainExact !== true
  ) {
    reasons.push("raw/generated globe shader identity differs");
  }
  for (const [extension, expected] of Object.entries(
    C12_29_S5_SVS_FIXTURE.members,
  )) {
    validateFingerprint(
      provenance?.fixtures?.[extension],
      expected,
      `fixture ${extension}`,
      reasons,
    );
  }
  validateFingerprint(
    provenance?.terrain?.layer,
    C12_29_S5_SVS_TERRAIN.layer,
    "terrain layer",
    reasons,
  );
  validateFingerprint(
    provenance?.terrain?.tile,
    C12_29_S5_SVS_TERRAIN.tile,
    "terrain tile",
    reasons,
  );
}

function validateSceneContract(scene, renderer, reasons) {
  const expected = C12_29_S5_SVS_SCENE;
  if (
    scene?.renderer !== renderer ||
    scene?.viewport?.width !== expected.viewport.width ||
    scene?.viewport?.height !== expected.viewport.height ||
    scene?.cameraMode !== expected.cameraMode ||
    scene?.framingRule !== expected.framingRule ||
    scene?.cameraGuardDegrees !== expected.cameraGuardDegrees ||
    scene?.minimumMarginPixels !== expected.minimumMarginPixels ||
    !finite(scene?.actualMarginPixels) ||
    scene.actualMarginPixels < expected.minimumMarginPixels ||
    scene?.recentered !== false ||
    scene?.translatedToModel !== false ||
    scene?.fixedCameraHeightAcrossRows !== true ||
    scene?.shouldAnimate !== false ||
    scene?.requestRenderMode !== false ||
    scene?.hdr !== false ||
    scene?.bloom !== false ||
    scene?.taa !== false ||
    scene?.fxaa !== false ||
    scene?.fog !== false ||
    scene?.volumetricFog !== false ||
    scene?.atmosphere !== false ||
    scene?.clouds !== false ||
    scene?.water !== false ||
    scene?.eclipseAutoExposure !== true
  ) {
    reasons.push(`${renderer}: neutral scene/camera contract differs`);
  }
  if (
    !finite(scene?.cameraHeightMeters) ||
    scene.cameraHeightMeters <= 0 ||
    !finite(scene?.verticalFovRadians) ||
    scene.verticalFovRadians <= 0 ||
    !(scene.verticalFovRadians < Math.PI)
  ) {
    reasons.push(`${renderer}: derived fixed camera is invalid`);
  }
}

function validateIcrf(ephemeris, renderer, reasons) {
  if (
    ephemeris?.preloadComplete !== true ||
    ephemeris?.matrixMethod !== "Transforms.computeIcrfToFixedMatrix" ||
    ephemeris?.allMatricesDefined !== true ||
    ephemeris?.allMatricesFinite !== true ||
    ephemeris?.allMatricesOrthonormal !== true ||
    ephemeris?.temeUsed !== false ||
    ephemeris?.fallbackUsed !== false ||
    ephemeris?.independentSimon1994 !== true ||
    !finite(ephemeris?.maximumSunPositionDeltaMeters) ||
    ephemeris.maximumSunPositionDeltaMeters < 0 ||
    ephemeris.maximumSunPositionDeltaMeters > 1e-3 ||
    !finite(ephemeris?.maximumMoonPositionDeltaMeters) ||
    ephemeris.maximumMoonPositionDeltaMeters < 0 ||
    ephemeris.maximumMoonPositionDeltaMeters > 1e-3
  ) {
    reasons.push(
      `${renderer}: true ICRF/independent ephemeris proof is absent`,
    );
  }
  const xys = ephemeris?.xysFiles;
  const xysRoutes = Array.isArray(xys) ? xys.map((entry) => entry?.route) : [];
  if (
    !Array.isArray(xys) ||
    xys.length === 0 ||
    new Set(xysRoutes).size !== xysRoutes.length ||
    JSON.stringify(xysRoutes) !== JSON.stringify([...xysRoutes].sort()) ||
    xys.some(
      (entry) =>
        !/^\/Build\/CesiumUnminified\/Assets\/IAU2006_XYS\/IAU2006_XYS_\d+\.json$/u.test(
          entry?.route ?? "",
        ) ||
        entry?.status !== 200 ||
        !(entry?.byteLength > 0) ||
        !SHA256.test(entry?.sha256 ?? "") ||
        entry?.localStart?.exists !== true ||
        entry.localStart.byteLength !== entry.byteLength ||
        entry.localStart.sha256 !== entry.sha256 ||
        entry?.localEnd?.exists !== true ||
        entry.localEnd.byteLength !== entry.byteLength ||
        entry.localEnd.sha256 !== entry.sha256,
    )
  ) {
    reasons.push(`${renderer}: IAU2006 XYS response fingerprints are absent`);
  }
}

function validateTerrain(terrain, renderer, reasons) {
  if (
    terrain?.providerClass !== "CesiumTerrainProvider" ||
    terrain?.terrainDataInstanceProof !==
      "instanceof-C.QuantizedMeshTerrainData" ||
    !Number.isInteger(terrain?.decodedQuantizedMeshCount) ||
    terrain.decodedQuantizedMeshCount < 1 ||
    !Number.isInteger(terrain?.selectedRealMeshCount) ||
    terrain.selectedRealMeshCount < 1 ||
    !Number.isInteger(terrain?.preparedRealMeshCount) ||
    terrain.preparedRealMeshCount < 1 ||
    !Number.isInteger(terrain?.preparedTupleCount) ||
    terrain.preparedTupleCount !== C12_29_S5_SVS_ROWS.length ||
    terrain?.allPreparedTuplesMatchSelected !== true ||
    terrain?.allPreparedTuplesReal !== true ||
    terrain?.fillMeshCount !== 0 ||
    terrain?.surrogateUsed !== false ||
    terrain?.ellipsoidOnly !== false ||
    terrain?.maskMethod !== C12_29_S5_SVS_SCENE.terrainMaskMethod ||
    terrain?.responseCodeThreshold !==
      C12_29_S5_SVS_SCENE.terrainResponseCodeThreshold ||
    terrain?.whiteBlackSameCamera !== true ||
    terrain?.validWgs84Intersection !== true
  ) {
    reasons.push(`${renderer}: real quantized-terrain/mask proof is absent`);
  }
}

function validateRuntimeFixture(fixture, renderer, reasons) {
  if (
    fixture?.parser !== "parseSvs5073UmbraShapefile" ||
    !/^GEOGCS\["GCS_WGS_1984",DATUM\["D_WGS_1984"/u.test(
      fixture?.projectionWkt ?? "",
    ) ||
    fixture?.manifestSchema !== C12_29_S5_SVS_FIXTURE.manifest.schema ||
    fixture?.featureCount !== 4 ||
    fixture?.storedPointCount !== C12_29_S5_SVS_FIXTURE.storedPointCount ||
    JSON.stringify(fixture?.manifestRecordIdentities) !==
      JSON.stringify(
        C12_29_S5_SVS_ROWS.map((row) => ({
          sourceIndexZeroBased: row.sourceIndexZeroBased,
          sourceRecordNumber: row.sourceRecordNumber,
          outputRecordNumber: row.outputRecordNumber,
        })),
      ) ||
    JSON.stringify(fixture?.recordIdentities) !==
      JSON.stringify(
        C12_29_S5_SVS_ROWS.map((row) => ({
          sourceIndexZeroBased: row.sourceIndexZeroBased,
          sourceRecordNumber: row.sourceRecordNumber,
          outputRecordNumber: row.outputRecordNumber,
        })),
      ) ||
    !close(
      fixture?.maximumSourceEdge?.distanceKm,
      C12_29_S5_SVS_SOURCE_EDGE.maximumAdjacentDistanceKm,
      1e-9,
    ) ||
    fixture?.maximumSourceEdge?.method !== C12_29_S5_SVS_SOURCE_EDGE.method ||
    fixture?.maximumSourceEdge?.units !== C12_29_S5_SVS_SOURCE_EDGE.units ||
    fixture?.maximumSourceEdge?.outputRecordNumber !==
      C12_29_S5_SVS_SOURCE_EDGE.outputRecordNumber ||
    fixture?.maximumSourceEdge?.edgeIndexZeroBased !==
      C12_29_S5_SVS_SOURCE_EDGE.edgeIndexZeroBased ||
    !sameMembers(
      fixture?.maximumSourceEdge?.startLonLat,
      C12_29_S5_SVS_SOURCE_EDGE.startLonLat,
    ) ||
    !sameMembers(
      fixture?.maximumSourceEdge?.endLonLat,
      C12_29_S5_SVS_SOURCE_EDGE.endLonLat,
    )
  ) {
    reasons.push(`${renderer}: runtime NASA fixture/edge derivation differs`);
  }
  validateFingerprint(
    fixture?.manifestFingerprint,
    C12_29_S5_SVS_FIXTURE.manifest,
    `${renderer} runtime fixture manifest`,
    reasons,
  );
  for (const [extension, expected] of Object.entries(
    C12_29_S5_SVS_FIXTURE.members,
  )) {
    validateFingerprint(
      fixture?.fingerprints?.[extension],
      expected,
      `${renderer} runtime fixture ${extension}`,
      reasons,
    );
  }
}

function validateImage(image, expectedLabel, runId, renderer, reasons) {
  if (
    !isUuidV4(image?.imageId) ||
    image?.label !== expectedLabel ||
    image?.renderer !== renderer ||
    image?.runId !== runId ||
    image?.captureMethod !== C12_29_S5_SVS_CAPTURE_METHOD ||
    image?.width !== C12_29_S5_SVS_SCENE.viewport.width ||
    image?.height !== C12_29_S5_SVS_SCENE.viewport.height ||
    !(image?.byteLength > 1000) ||
    !SHA256.test(image?.sha256 ?? "") ||
    image?.pngSignatureValid !== true ||
    image?.decoded !== true ||
    typeof image?.file !== "string" ||
    !image.file.includes(runId)
  ) {
    reasons.push(`${renderer}/${expectedLabel}: capture identity is invalid`);
  }
}

function validateMetricImageBindings(owner, images, renderer, label, reasons) {
  for (const channel of ["off", "on"]) {
    const binding = owner?.metricImageBindings?.[channel];
    const expectedLabel = `${label}-${channel}`;
    const captureProof = owner?.captureTerrainProofs?.find(
      (proof) => proof?.label === channel,
    );
    const image = images.find(
      (candidate) =>
        candidate?.imageId === binding?.imageId &&
        candidate?.label === expectedLabel,
    );
    if (
      !image ||
      binding?.sha256 !== image.sha256 ||
      binding?.byteLength !== image.byteLength ||
      binding?.width !== image.width ||
      binding?.height !== image.height ||
      !captureProof ||
      binding?.captureFrameNumber !== captureProof?.tuple?.captureFrameNumber ||
      binding?.selectionRevision !== captureProof?.tuple?.selectionRevision ||
      binding?.selectionContentIdentity !==
        captureProof?.tuple?.selectionContentIdentity
    ) {
      reasons.push(`${renderer}/${expectedLabel}: metric/PNG binding differs`);
    }
  }
}

function validateLattice(row, expected, renderer, reasons) {
  const lattice = row?.lattice;
  const cells = C12_29_S5_SVS_SCENE.latticeSide ** 2;
  const geometry = validateFixtureGeometry(row, expected, renderer, reasons);
  if (
    lattice?.side !== C12_29_S5_SVS_SCENE.latticeSide ||
    lattice?.candidateCellCount !== cells ||
    lattice?.sampling !== "cell-centre" ||
    lattice?.guardDegrees !== C12_29_S5_SVS_SCENE.cameraGuardDegrees ||
    lattice?.uniqueProjectedCellCount !== lattice?.validProjectedCellCount ||
    lattice?.validProjectedCellCount <
      C12_29_S5_SVS_SCENE.minimumUniqueValidProjectedCells ||
    lattice?.nasaInsideCount < C12_29_S5_SVS_SCENE.minimumNasaInsideCells ||
    lattice?.nasaOutsideCount < C12_29_S5_SVS_SCENE.minimumNasaOutsideCells ||
    lattice?.duplicateProjectedCellCount !== 0 ||
    !finite(lattice?.latticePitchKm) ||
    lattice.latticePitchKm <= 0 ||
    !finite(lattice?.pixelGroundFootprintKm) ||
    lattice.pixelGroundFootprintKm <= 0
  ) {
    reasons.push(`${renderer}/${row?.role}: lattice coverage is invalid`);
  }
  for (const key of [
    "validProjectedCellIds",
    "nasaInsideCellIds",
    "terrainCellIds",
    "classifiedCellIds",
    "qBoundaryBandCellIds",
  ]) {
    if (!exactSortedUniqueIntegers(lattice?.[key])) {
      reasons.push(`${renderer}/${row?.role}: ${key} is not sorted/unique`);
    }
  }
  const valid = lattice?.validProjectedCellIds ?? [];
  const nasa = lattice?.nasaInsideCellIds ?? [];
  const terrain = lattice?.terrainCellIds ?? [];
  const classified = lattice?.classifiedCellIds ?? [];
  const qBoundary = lattice?.qBoundaryBandCellIds ?? [];
  const validSet = new Set(valid);
  const terrainSet = new Set(terrain);
  if (
    lattice?.validProjectedCellIds?.length !==
      lattice?.validProjectedCellCount ||
    lattice?.nasaInsideCellIds?.length !== lattice?.nasaInsideCount ||
    lattice?.terrainCellIds?.length !== row?.mask?.terrainPixelCount ||
    lattice?.classifiedCellIds?.length !== row?.mask?.classifiedCellCount
  ) {
    reasons.push(`${renderer}/${row?.role}: lattice arrays/counts disagree`);
  }
  if (
    valid.some((id) => id >= cells) ||
    !isSubsetOf(nasa, validSet) ||
    !isSubsetOf(terrain, validSet) ||
    !isSubsetOf(classified, terrainSet) ||
    !isSubsetOf(qBoundary, validSet) ||
    lattice?.nasaOutsideCount !== valid.length - nasa.length
  ) {
    reasons.push(
      `${renderer}/${row?.role}: lattice IDs are out of range or not subsets`,
    );
  }
  if (
    !Array.isArray(lattice?.cellLonLat) ||
    lattice.cellLonLat.length !== lattice?.validProjectedCellCount ||
    lattice.cellLonLat.some(
      (entry, index) =>
        !Array.isArray(entry) ||
        entry.length !== 3 ||
        entry[0] !== lattice.validProjectedCellIds?.[index] ||
        !finite(entry[1]) ||
        !finite(entry[2]) ||
        Math.abs(entry[2]) > 90,
    )
  ) {
    reasons.push(`${renderer}/${row?.role}: primitive cell coordinates differ`);
  }
  if (!geometry) return;
  const [fixtureWest, fixtureSouth, fixtureEast, fixtureNorth] = geometry.bbox;
  const west = fixtureWest - C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const south = fixtureSouth - C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const east = fixtureEast + C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const north = fixtureNorth + C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const side = C12_29_S5_SVS_SCENE.latticeSide;
  const coordinateForId = (id) => [
    west + (((id % side) + 0.5) / side) * (east - west),
    north - ((Math.floor(id / side) + 0.5) / side) * (north - south),
  ];
  const anchorKey = `${expected.role}:${geometry.canonicalSha256}:${valid.join(",")}`;
  let expectedNasa = latticeAnchorCache.get(anchorKey);
  if (!expectedNasa) {
    expectedNasa = valid.filter((id) =>
      pointInFixtureRing(coordinateForId(id), geometry.ring),
    );
    latticeAnchorCache.set(anchorKey, expectedNasa);
  }
  if (!sameMembers(nasa, expectedNasa)) {
    reasons.push(
      `${renderer}/${row?.role}: NASA membership is not derived from the frozen ring`,
    );
  }
  if (
    lattice.cellLonLat.some((entry) => {
      const expectedCoordinate = coordinateForId(entry[0]);
      return (
        !close(entry[1], expectedCoordinate[0], 1e-12) ||
        !close(entry[2], expectedCoordinate[1], 1e-12)
      );
    })
  ) {
    reasons.push(
      `${renderer}/${row?.role}: cell centres are not derived from the frozen bbox`,
    );
  }
  const horizontalPitchKm = wgs84GeodesicDistanceKm(
    [west, expected.sourceCenter[1]],
    [west + (east - west) / side, expected.sourceCenter[1]],
  );
  const verticalPitchKm = wgs84GeodesicDistanceKm(
    [expected.sourceCenter[0], south],
    [expected.sourceCenter[0], south + (north - south) / side],
  );
  const expectedPixelGroundFootprintKm =
    (2 *
      row?.cameraFrame?.heightMeters *
      Math.tan(row?.cameraFrame?.verticalFovRadians * 0.5)) /
    C12_29_S5_SVS_SCENE.viewport.height /
    1000;
  if (
    !close(
      lattice?.latticePitchKm,
      Math.max(horizontalPitchKm, verticalPitchKm),
      1e-9,
    ) ||
    !close(
      lattice?.pixelGroundFootprintKm,
      expectedPixelGroundFootprintKm,
      1e-9,
    )
  ) {
    reasons.push(
      `${renderer}/${row?.role}: lattice/pixel quantizers are not derived`,
    );
  }
}

export function deriveSvsSpatialMetrics(row) {
  const lattice = row?.lattice;
  const side = lattice?.side;
  const valid = lattice?.validProjectedCellIds ?? [];
  const nasa = lattice?.nasaInsideCellIds ?? [];
  const classified = lattice?.classifiedCellIds ?? [];
  const qKm = row?.budget?.qKm;
  const points = new Map(
    (lattice?.cellLonLat ?? []).map(([id, longitude, latitude]) => [
      id,
      [longitude, latitude],
    ]),
  );
  if (!Number.isInteger(side) || !finite(qKm) || points.size !== valid.length) {
    throw new TypeError("SVS primitive spatial inputs are invalid");
  }
  const cacheKey = JSON.stringify([
    side,
    qKm,
    valid,
    nasa,
    classified,
    lattice.cellLonLat,
  ]);
  const cached = spatialMetricCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const nasaSet = new Set(nasa);
  const classifiedSet = new Set(classified);
  const neighbors = (id) => {
    const x = id % side;
    const y = Math.floor(id / side);
    return [
      x > 0 ? id - 1 : -1,
      x + 1 < side ? id + 1 : -1,
      y > 0 ? id - side : -1,
      y + 1 < side ? id + side : -1,
    ];
  };
  const boundaryOf = (ids, membership) =>
    ids.filter((id) =>
      neighbors(id).some((neighbor) => !membership.has(neighbor)),
    );
  const nasaBoundary = boundaryOf(nasa, nasaSet);
  const classifiedBoundary = boundaryOf(classified, classifiedSet);
  const distanceTo = (id, boundary) => {
    const point = points.get(id);
    if (!point || boundary.length === 0) return Infinity;
    let minimum = Infinity;
    for (const otherId of boundary) {
      const other = points.get(otherId);
      if (other) {
        minimum = Math.min(minimum, wgs84GeodesicDistanceKm(point, other));
      }
    }
    return minimum;
  };
  const nasaDistance = new Map(
    valid.map((id) => [id, distanceTo(id, nasaBoundary)]),
  );
  const boundaryDistances = [
    ...classifiedBoundary.map((id) => distanceTo(id, nasaBoundary)),
    ...nasaBoundary.map((id) => distanceTo(id, classifiedBoundary)),
  ]
    .filter(finite)
    .sort((left, right) => left - right);
  const qBoundaryBandCellIds = valid.filter(
    (id) => nasaDistance.get(id) <= qKm,
  );
  const dilated = valid.filter(
    (id) => nasaSet.has(id) || nasaDistance.get(id) <= qKm,
  );
  const eroded = nasa.filter((id) => nasaDistance.get(id) > qKm);
  const centroid = (ids) => {
    if (ids.length === 0) return [NaN, NaN];
    const sum = ids.reduce(
      (value, id) => {
        const point = points.get(id);
        return [value[0] + point[0], value[1] + point[1]];
      },
      [0, 0],
    );
    return [sum[0] / ids.length, sum[1] / ids.length];
  };
  const sourceLonLat = centroid(nasa);
  const measuredLonLat = centroid(classified);
  const intersection = classified.filter((id) => nasaSet.has(id)).length;
  const union = new Set([...classified, ...nasa]).size;
  const result = {
    qBoundaryBandCellIds,
    boundary: {
      p95Km:
        boundaryDistances[
          Math.min(
            boundaryDistances.length - 1,
            Math.floor(boundaryDistances.length * 0.95),
          )
        ] ?? Infinity,
      maximumKm: boundaryDistances.at(-1) ?? Infinity,
      classifiedOutsideDilatedCount: classified.filter(
        (id) => !dilated.includes(id),
      ).length,
      erodedOutsideClassifiedCount: eroded.filter(
        (id) => !classifiedSet.has(id),
      ).length,
      erodedNasaCellCount: eroded.length,
      dilatedNasaCellCount: dilated.length,
      areaRatio: classified.length / nasa.length,
      minimumAreaRatio: eroded.length / nasa.length,
      maximumAreaRatio: dilated.length / nasa.length,
      rawIou: union > 0 ? intersection / union : 0,
    },
    centroid: {
      measuredLonLat,
      sourceLonLat,
      errorKm: wgs84GeodesicDistanceKm(sourceLonLat, measuredLonLat),
      longitudeResidualDegrees: measuredLonLat[0] - sourceLonLat[0],
      latitudeResidualDegrees: measuredLonLat[1] - sourceLonLat[1],
    },
  };
  spatialMetricCache.set(cacheKey, structuredClone(result));
  return result;
}

function validateBudget(row, renderer, failures, structural) {
  let expected;
  try {
    expected = computeSvsFootprintBudget({
      latticePitchKm: row?.lattice?.latticePitchKm,
      pixelGroundFootprintKm: row?.lattice?.pixelGroundFootprintKm,
    });
  } catch (error) {
    structural.push(`${renderer}/${row?.role}: budget inputs are invalid`);
    return undefined;
  }
  for (const key of Object.keys(expected)) {
    if (!close(row?.budget?.[key], expected[key], 1e-9)) {
      structural.push(
        `${renderer}/${row?.role}: derived budget ${key} differs`,
      );
    }
  }
  if (
    row?.thresholdOrigin !==
      "exact-WGS84-source-edge+half-lattice+half-pixel;40km-Simon1994" ||
    row?.sourceEdge?.method !== C12_29_S5_SVS_SOURCE_EDGE.method ||
    row?.sourceEdge?.units !== C12_29_S5_SVS_SOURCE_EDGE.units ||
    !close(
      row?.sourceEdge?.maximumAdjacentDistanceKm,
      C12_29_S5_SVS_SOURCE_EDGE.maximumAdjacentDistanceKm,
      1e-9,
    ) ||
    row?.sourceEdge?.outputRecordNumber !==
      C12_29_S5_SVS_SOURCE_EDGE.outputRecordNumber ||
    row?.sourceEdge?.edgeIndexZeroBased !==
      C12_29_S5_SVS_SOURCE_EDGE.edgeIndexZeroBased ||
    !sameMembers(
      row?.sourceEdge?.startLonLat,
      C12_29_S5_SVS_SOURCE_EDGE.startLonLat,
    ) ||
    !sameMembers(
      row?.sourceEdge?.endLonLat,
      C12_29_S5_SVS_SOURCE_EDGE.endLonLat,
    ) ||
    row?.iouUsedAsGate !== false ||
    row?.recentered !== false ||
    row?.translatedToModel !== false
  ) {
    structural.push(
      `${renderer}/${row?.role}: fitted/recentered threshold path`,
    );
  }
  const boundary = row?.boundary;
  let derived;
  try {
    derived = deriveSvsSpatialMetrics(row);
  } catch {
    structural.push(`${renderer}/${row?.role}: spatial recomputation failed`);
    return expected;
  }
  if (
    !sameMembers(
      row?.lattice?.qBoundaryBandCellIds,
      derived.qBoundaryBandCellIds,
    ) ||
    Object.keys(derived.boundary).some(
      (key) => !close(boundary?.[key], derived.boundary[key], 1e-9),
    )
  ) {
    structural.push(
      `${renderer}/${row?.role}: morphology summary is not derived`,
    );
  }
  if (
    !finite(boundary?.p95Km) ||
    !finite(boundary?.maximumKm) ||
    boundary?.p95Km > expected.boundaryP95LimitKm ||
    boundary?.maximumKm > expected.boundaryMaximumLimitKm ||
    boundary?.classifiedOutsideDilatedCount !== 0 ||
    boundary?.erodedOutsideClassifiedCount !== 0 ||
    row?.mask?.classifiedCellCount < boundary?.erodedNasaCellCount ||
    row?.mask?.classifiedCellCount > boundary?.dilatedNasaCellCount ||
    !close(
      boundary?.areaRatio,
      row?.mask?.classifiedCellCount / row?.lattice?.nasaInsideCount,
      1e-12,
    ) ||
    !close(
      boundary?.minimumAreaRatio,
      boundary?.erodedNasaCellCount / row?.lattice?.nasaInsideCount,
      1e-12,
    ) ||
    !close(
      boundary?.maximumAreaRatio,
      boundary?.dilatedNasaCellCount / row?.lattice?.nasaInsideCount,
      1e-12,
    ) ||
    boundary?.areaRatio < boundary?.minimumAreaRatio ||
    boundary?.areaRatio > boundary?.maximumAreaRatio
  ) {
    failures.push(`${renderer}/${row?.role}: boundary/area morphology is red`);
  }
  // Raw IoU is diagnostic only, but must be honestly bounded and reported.
  if (!finite(boundary?.rawIou) || boundary.rawIou < 0 || boundary.rawIou > 1) {
    structural.push(`${renderer}/${row?.role}: raw IoU is malformed`);
  }
  const centroid = row?.centroid;
  if (
    !sameMembers(centroid?.measuredLonLat, derived.centroid.measuredLonLat) ||
    !sameMembers(centroid?.sourceLonLat, derived.centroid.sourceLonLat) ||
    !close(centroid?.errorKm, derived.centroid.errorKm, 1e-9) ||
    !close(
      centroid?.longitudeResidualDegrees,
      derived.centroid.longitudeResidualDegrees,
      1e-12,
    ) ||
    !close(
      centroid?.latitudeResidualDegrees,
      derived.centroid.latitudeResidualDegrees,
      1e-12,
    )
  ) {
    structural.push(
      `${renderer}/${row?.role}: centroid summary is not derived`,
    );
  }
  if (
    !finite(centroid?.errorKm) ||
    centroid.errorKm > expected.centroidLimitKm ||
    !finite(centroid?.longitudeResidualDegrees) ||
    !finite(centroid?.latitudeResidualDegrees)
  ) {
    failures.push(`${renderer}/${row?.role}: absolute centroid is red`);
  }
  return expected;
}

function validTerrainContentRecords(records, expectedTileIds) {
  if (
    !Array.isArray(records) ||
    records.length !== expectedTileIds?.length ||
    records.some(
      (record) =>
        !exactObjectKeys(record, [
          "tileId",
          "tileObjectId",
          "terrainDataObjectId",
          "renderedMeshObjectId",
          "realMeshObjectId",
          "fillMeshObjectId",
        ]) ||
        !/^\d+\/\d+\/\d+$/u.test(record?.tileId ?? "") ||
        !Number.isInteger(record?.tileObjectId) ||
        record.tileObjectId < 1 ||
        !Number.isInteger(record?.terrainDataObjectId) ||
        record.terrainDataObjectId < 1 ||
        !Number.isInteger(record?.renderedMeshObjectId) ||
        record.renderedMeshObjectId < 1 ||
        record?.renderedMeshObjectId !== record?.realMeshObjectId ||
        !Number.isInteger(record?.fillMeshObjectId) ||
        record.fillMeshObjectId !== 0,
    ) ||
    !sameMembers(
      records.map((record) => record.tileId),
      expectedTileIds,
    ) ||
    new Set(records.map((record) => record.tileObjectId)).size !==
      records.length
  ) {
    return false;
  }
  return true;
}

function validateTerrainTuple(tuple, renderer, label, structural) {
  if (
    tuple?.prepared !== true ||
    tuple?.selectionRoute !==
      "GlobeSurfaceTileProvider.showTileThisFrame/pass-through-events" ||
    tuple?.preparationRoute !==
      "frameState.commandList/Pass.GLOBE/command.owner" ||
    !Number.isInteger(tuple?.selectionFrameNumber) ||
    tuple.selectionFrameNumber < 0 ||
    tuple?.preparedFrameNumber !== tuple?.selectionFrameNumber ||
    tuple?.captureFrameNumber !== tuple?.preparedFrameNumber ||
    tuple?.selectionEventsUnique !== true ||
    tuple?.selectionEventCount !== tuple?.selectedTileIds?.length ||
    !Number.isInteger(tuple?.preparedCommandCount) ||
    tuple.preparedCommandCount < tuple?.preparedSelectedTileIds?.length ||
    tuple?.preparedCommandOwnersMatchSelection !== true ||
    tuple?.selectedTileId !== tuple?.preparedTileId ||
    !/^\d+\/\d+\/\d+$/u.test(tuple?.selectedTileId ?? "") ||
    !exactSortedUniqueTileIds(tuple?.selectedTileIds) ||
    !exactSortedUniqueTileIds(tuple?.preparedSelectedTileIds) ||
    !exactSortedUniqueTileIds(tuple?.selectedRealTileIds) ||
    !exactSortedUniqueTileIds(tuple?.selectedFillTileIds) ||
    !sameMembers(tuple?.selectedTileIds, tuple?.preparedSelectedTileIds) ||
    !sameMembers(tuple?.selectedTileIds, tuple?.selectedRealTileIds) ||
    !sameMembers(tuple?.preparedSelectedTileIds, tuple?.preparedRealTileIds) ||
    !tuple?.selectedTileIds?.includes(tuple?.selectedTileId) ||
    tuple?.selectedPreparedTileSetsMatch !== true ||
    tuple?.preparedSelectionContainsRealTile !== true ||
    tuple?.preparedCapturedInEndUpdate !== true ||
    !exactSortedUniqueTileIds(tuple?.preparedRealTileIds) ||
    !exactSortedUniqueTileIds(tuple?.preparedFillTileIds) ||
    tuple.preparedRealTileIds.length < 1 ||
    !sameMembers(tuple?.selectedRealTileIds, tuple?.preparedRealTileIds) ||
    !sameMembers(tuple?.selectedFillTileIds, tuple?.preparedFillTileIds) ||
    tuple.selectedFillTileIds.length !== 0 ||
    tuple.preparedFillTileIds.length !== 0 ||
    tuple?.selectedTileId !== tuple?.selectedRealTileIds?.[0] ||
    tuple?.preparedTileId !== tuple?.preparedRealTileIds?.[0] ||
    !tuple.preparedRealTileIds.includes(tuple?.selectedTileId) ||
    tuple?.terrainDataInstanceProof !==
      "instanceof-C.QuantizedMeshTerrainData" ||
    tuple?.renderedMeshIsRealMesh !== true ||
    tuple?.renderedMeshIsFillMesh !== false ||
    !Number.isInteger(tuple?.selectionRevision) ||
    !finite(tuple?.surfaceRadiusMeters) ||
    tuple.surfaceRadiusMeters <= 0 ||
    tuple?.providerSelectionRevision !== tuple?.selectionRevision ||
    tuple?.providerSurfaceRadiusMeters !== tuple?.surfaceRadiusMeters ||
    tuple?.selectionRevisionMatches !== true ||
    tuple?.surfaceRadiusMatches !== true ||
    tuple?.mainViewShadowMatches !== true ||
    tuple?.tilesLoadedAfterRender !== true ||
    tuple?.sourceTerrainProviderMatches !== true ||
    !Number.isInteger(tuple?.terrainProviderIdentity) ||
    tuple.terrainProviderIdentity < 1 ||
    tuple?.sourceTerrainProviderIdentity !== tuple.terrainProviderIdentity ||
    !Number.isInteger(tuple?.surfaceProviderIdentity) ||
    tuple.surfaceProviderIdentity < 1 ||
    !Number.isInteger(tuple?.providerContentRevision) ||
    tuple.providerContentRevision < 0 ||
    typeof tuple?.cameraIdentity !== "string" ||
    tuple.cameraIdentity.length < 1 ||
    tuple?.expectedCameraIdentity !== tuple.cameraIdentity ||
    typeof tuple?.transitionRole !== "string" ||
    tuple.transitionRole.length < 1 ||
    typeof tuple?.transitionIso !== "string" ||
    Number.isNaN(Date.parse(tuple.transitionIso)) ||
    tuple?.clockTimeIso !== tuple.transitionIso ||
    tuple?.frameStateTimeIso !== tuple.transitionIso
  ) {
    structural.push(
      `${renderer}/${label}: selected/prepared terrain tuple differs`,
    );
  }
  const selectedContent = tuple?.selectedContent;
  const preparedContent = tuple?.preparedContent;
  const expectedIdentity = JSON.stringify({
    selected: selectedContent,
    prepared: preparedContent,
  });
  if (
    !validTerrainContentRecords(selectedContent, tuple?.selectedTileIds) ||
    !validTerrainContentRecords(
      preparedContent,
      tuple?.preparedSelectedTileIds,
    ) ||
    !sameJson(selectedContent, preparedContent) ||
    tuple?.selectionContentIdentity !== expectedIdentity
  ) {
    structural.push(
      `${renderer}/${label}: terrain selection/content identity differs`,
    );
  }
}

function validateTransitionReadiness(
  readiness,
  renderer,
  label,
  expectedRole,
  expectedIso,
  expectedMaxFrames,
  structural,
) {
  const observations = readiness?.observations;
  const required = C12_29_S5_SVS_SCENE.readinessConsecutiveStableFrames;
  if (
    readiness?.method !== C12_29_S5_SVS_SCENE.readinessMethod ||
    readiness?.transitionRole !== expectedRole ||
    readiness?.transitionIso !== expectedIso ||
    readiness?.forcedRenderBeforeFirstReadinessCheck !== true ||
    readiness?.settled !== true ||
    readiness?.boundedMaxFrames !== expectedMaxFrames ||
    !Number.isInteger(readiness?.renderCount) ||
    readiness.renderCount < required ||
    readiness.renderCount > expectedMaxFrames ||
    readiness?.requiredConsecutiveStableFrames !== required ||
    readiness?.consecutiveStableFrames !== required ||
    !Array.isArray(observations) ||
    observations.length !== required
  ) {
    structural.push(`${renderer}/${label}: render-first readiness differs`);
    return undefined;
  }
  for (const observation of observations) {
    validateTerrainTuple(
      observation?.tuple,
      renderer,
      `${label}/readiness`,
      structural,
    );
  }
  const tuples = observations.map((observation) => observation?.tuple);
  const finalTuple = tuples.at(-1);
  const ordinalSequenceIsExact = observations.every(
    (observation, index) =>
      Number.isInteger(observation?.renderOrdinal) &&
      observation.renderOrdinal ===
        readiness.renderCount - observations.length + index + 1,
  );
  const frameSequenceIsExact = tuples.every(
    (tuple, index) =>
      index === 0 ||
      tuple?.captureFrameNumber === tuples[index - 1]?.captureFrameNumber + 1,
  );
  const revisionSequenceIsExact = tuples.every(
    (tuple, index) =>
      index === 0 ||
      tuple?.selectionRevision === tuples[index - 1]?.selectionRevision + 1,
  );
  if (
    !ordinalSequenceIsExact ||
    !frameSequenceIsExact ||
    !revisionSequenceIsExact ||
    tuples.some(
      (tuple) =>
        tuple?.transitionRole !== expectedRole ||
        tuple?.transitionIso !== expectedIso ||
        tuple?.cameraIdentity !== readiness?.cameraIdentity ||
        tuple?.sourceTerrainProviderIdentity !==
          readiness?.sourceTerrainProviderIdentity ||
        tuple?.surfaceProviderIdentity !== readiness?.surfaceProviderIdentity ||
        tuple?.providerContentRevision !== readiness?.providerContentRevision ||
        tuple?.selectionContentIdentity !== readiness?.selectionContentIdentity,
    ) ||
    finalTuple?.captureFrameNumber !== readiness?.lastFrameNumber ||
    finalTuple?.selectionRevision !== readiness?.lastSelectionRevision
  ) {
    structural.push(
      `${renderer}/${label}: consecutive readiness identity/revision differs`,
    );
  }
  return finalTuple;
}

function validateCaptureTerrainProofs(
  owner,
  renderer,
  label,
  expectedRole,
  expectedIso,
  expectedLabels,
  readinessTuple,
  structural,
) {
  const proofs = owner?.captureTerrainProofs;
  if (
    !readinessTuple ||
    !Array.isArray(proofs) ||
    !sameMembers(
      proofs.map((proof) => proof?.label),
      expectedLabels,
    )
  ) {
    structural.push(`${renderer}/${label}: capture terrain proofs differ`);
    return;
  }
  for (const proof of proofs) {
    validateTerrainTuple(
      proof?.tuple,
      renderer,
      `${label}/${proof?.label ?? "capture"}`,
      structural,
    );
  }
  const tuples = proofs.map((proof) => proof?.tuple);
  if (
    tuples.some(
      (tuple) =>
        tuple?.transitionRole !== expectedRole ||
        tuple?.transitionIso !== expectedIso ||
        tuple?.cameraIdentity !== readinessTuple.cameraIdentity ||
        tuple?.sourceTerrainProviderIdentity !==
          readinessTuple.sourceTerrainProviderIdentity ||
        tuple?.surfaceProviderIdentity !==
          readinessTuple.surfaceProviderIdentity ||
        tuple?.providerContentRevision !==
          readinessTuple.providerContentRevision ||
        tuple?.selectionContentIdentity !==
          readinessTuple.selectionContentIdentity,
    ) ||
    tuples.some(
      (tuple, index) =>
        tuple?.captureFrameNumber !==
          (index === 0
            ? readinessTuple.captureFrameNumber + 1
            : tuples[index - 1]?.captureFrameNumber + 1) ||
        tuple?.selectionRevision !==
          (index === 0
            ? readinessTuple.selectionRevision + 1
            : tuples[index - 1]?.selectionRevision + 1),
    ) ||
    !sameJson(owner?.terrainTuple, tuples.at(-1))
  ) {
    structural.push(
      `${renderer}/${label}: inter-capture terrain/loading identity drifted`,
    );
  }
}

function validateRow(row, expected, renderer, failures, structural) {
  if (
    row?.phase !== expected.phase ||
    row?.role !== expected.role ||
    row?.iso !== expected.iso ||
    row?.sourceIndexZeroBased !== expected.sourceIndexZeroBased ||
    row?.sourceRecordNumber !== expected.sourceRecordNumber ||
    row?.outputRecordNumber !== expected.outputRecordNumber ||
    !sameMembers(row?.sourceCenter, expected.sourceCenter)
  ) {
    structural.push(`${renderer}/${expected.role}: exact NASA row differs`);
  }
  if (
    row?.clock?.shouldAnimate !== false ||
    row?.clock?.currentTimeIso !== expected.iso ||
    row?.clock?.renderArgumentIso !== expected.iso ||
    row?.clock?.frameStateTimeIso !== expected.iso ||
    row?.clock?.exactPinnedFrame !== true
  ) {
    structural.push(`${renderer}/${expected.role}: clock/frame pin differs`);
  }
  if (
    !sameMembers(row?.cameraFrame?.centerLonLat, expected.sourceCenter) ||
    row?.cameraFrame?.mode !== C12_29_S5_SVS_SCENE.cameraMode ||
    row?.cameraFrame?.derivedFromGuardedBbox !== true ||
    row?.cameraFrame?.fixedAcrossRows !== true ||
    row?.cameraFrame?.allFixtureVerticesProjected !== true ||
    !finite(row?.cameraFrame?.nadirAlignment) ||
    row.cameraFrame.nadirAlignment > 1e-9 ||
    !finite(row?.cameraFrame?.actualMarginPixels) ||
    row.cameraFrame.actualMarginPixels <
      C12_29_S5_SVS_SCENE.minimumMarginPixels ||
    !finite(row?.cameraFrame?.heightMeters) ||
    row.cameraFrame.heightMeters <= 0 ||
    !finite(row?.cameraFrame?.verticalFovRadians) ||
    row.cameraFrame.verticalFovRadians <= 0 ||
    !(row.cameraFrame.verticalFovRadians < Math.PI)
  ) {
    structural.push(
      `${renderer}/${expected.role}: camera framing proof differs`,
    );
  }
  if (
    row?.mask?.method !== C12_29_S5_SVS_SCENE.terrainMaskMethod ||
    !Number.isInteger(row?.mask?.terrainPixelCount) ||
    row.mask.terrainPixelCount <
      C12_29_S5_SVS_SCENE.minimumUniqueValidProjectedCells ||
    !Number.isInteger(row?.mask?.classifiedCellCount) ||
    row.mask.classifiedCellCount < C12_29_S5_SVS_SCENE.minimumNasaInsideCells ||
    row?.mask?.offMinimumLuminanceCode !==
      C12_29_S5_SVS_SCENE.offMinimumLuminanceCode ||
    row?.mask?.onOffRatioMaximum !== C12_29_S5_SVS_SCENE.onOffRatioMaximum ||
    row?.mask?.allClassifiedMeetOffMinimum !== true ||
    row?.mask?.allClassifiedMeetOnOffRatio !== true ||
    row?.mask?.classificationAppliedOnlyInsideTerrainMask !== true
  ) {
    structural.push(
      `${renderer}/${expected.role}: real-pixel classifier differs`,
    );
  }
  validateTerrainTuple(row?.terrainTuple, renderer, expected.role, structural);
  const readinessTuple = validateTransitionReadiness(
    row?.transitionReadiness,
    renderer,
    expected.role,
    expected.role,
    expected.iso,
    C12_29_S5_SVS_SCENE.transitionReadinessMaxFrames,
    structural,
  );
  validateCaptureTerrainProofs(
    row,
    renderer,
    expected.role,
    expected.role,
    expected.iso,
    ["white", "black", "off", "on"],
    readinessTuple,
    structural,
  );
  validateLattice(row, expected, renderer, structural);
  return validateBudget(row, renderer, failures, structural);
}

function validateMotion(session, budgets, failures, structural) {
  const motion = session?.motion;
  const before = budgets.get(C12_29_S5_SVS_SOURCE_MOTION.fromRole);
  const after = budgets.get(C12_29_S5_SVS_SOURCE_MOTION.toRole);
  const qKm = Math.max(before?.qKm ?? NaN, after?.qKm ?? NaN);
  const vectorLimitKm = 2 * qKm;
  const speedUncertaintyKmPerHour =
    (vectorLimitKm / C12_29_S5_SVS_SOURCE_MOTION.seconds) * 3600;
  const beforePoint = session?.rows?.find(
    (row) => row?.role === C12_29_S5_SVS_SOURCE_MOTION.fromRole,
  )?.centroid?.measuredLonLat;
  const afterPoint = session?.rows?.find(
    (row) => row?.role === C12_29_S5_SVS_SOURCE_MOTION.toRole,
  )?.centroid?.measuredLonLat;
  const measuredDistanceKm = wgs84GeodesicDistanceKm(beforePoint, afterPoint);
  const radians = Math.PI / 180;
  const deltaLongitude = (afterPoint?.[0] - beforePoint?.[0]) * radians;
  const beforeLatitude = beforePoint?.[1] * radians;
  const afterLatitude = afterPoint?.[1] * radians;
  const measuredHeading = Math.atan2(
    Math.sin(deltaLongitude) * Math.cos(afterLatitude),
    Math.cos(beforeLatitude) * Math.sin(afterLatitude) -
      Math.sin(beforeLatitude) *
        Math.cos(afterLatitude) *
        Math.cos(deltaLongitude),
  );
  const derivedVectorErrorKm = Math.hypot(
    measuredDistanceKm * Math.sin(measuredHeading) -
      C12_29_S5_SVS_SOURCE_MOTION.eastKm,
    measuredDistanceKm * Math.cos(measuredHeading) -
      C12_29_S5_SVS_SOURCE_MOTION.northKm,
  );
  const derivedSpeedKmPerHour =
    (measuredDistanceKm / C12_29_S5_SVS_SOURCE_MOTION.seconds) * 3600;
  if (
    motion?.fromRole !== C12_29_S5_SVS_SOURCE_MOTION.fromRole ||
    motion?.toRole !== C12_29_S5_SVS_SOURCE_MOTION.toRole ||
    motion?.seconds !== C12_29_S5_SVS_SOURCE_MOTION.seconds ||
    !close(
      motion?.sourceVectorDistanceKm,
      C12_29_S5_SVS_SOURCE_MOTION.vectorDistanceKm,
      1e-9,
    ) ||
    motion?.sourceDirection !== C12_29_S5_SVS_SOURCE_MOTION.direction ||
    motion?.method !== C12_29_S5_SVS_SOURCE_MOTION.method ||
    !close(
      motion?.sourceInitialHeadingDegrees,
      C12_29_S5_SVS_SOURCE_MOTION.initialHeadingDegrees,
      1e-9,
    ) ||
    !close(motion?.sourceEastKm, C12_29_S5_SVS_SOURCE_MOTION.eastKm, 1e-9) ||
    !close(motion?.sourceNorthKm, C12_29_S5_SVS_SOURCE_MOTION.northKm, 1e-9) ||
    !close(
      motion?.sourceSpeedKmPerHour,
      C12_29_S5_SVS_SOURCE_MOTION.speedKmPerHour,
      1e-9,
    ) ||
    !close(motion?.vectorLimitKm, vectorLimitKm, 1e-9) ||
    !close(
      motion?.speedUncertaintyKmPerHour,
      speedUncertaintyKmPerHour,
      1e-9,
    ) ||
    motion?.measuredDirectionEast !== Math.sin(measuredHeading) > 0 ||
    motion?.measuredDirectionNorth !== Math.cos(measuredHeading) > 0 ||
    !close(motion?.vectorErrorKm, derivedVectorErrorKm, 1e-6) ||
    !close(motion?.measuredSpeedKmPerHour, derivedSpeedKmPerHour, 1e-6)
  ) {
    structural.push(
      `${session?.renderer}: motion budget/source vector differs`,
    );
    return;
  }
  if (
    motion?.measuredDirectionEast !== true ||
    motion?.measuredDirectionNorth !== true ||
    !finite(motion?.vectorErrorKm) ||
    motion.vectorErrorKm > vectorLimitKm ||
    !finite(motion?.measuredSpeedKmPerHour) ||
    Math.abs(
      motion.measuredSpeedKmPerHour -
        C12_29_S5_SVS_SOURCE_MOTION.speedKmPerHour,
    ) > speedUncertaintyKmPerHour
  ) {
    failures.push(`${session?.renderer}: 10-second source motion is red`);
  }
}

function validateControl(control, renderer, cameraSource, structural) {
  const before = C12_29_S5_SVS_ROWS.find(
    (row) => row.role === C12_29_S5_SVS_CONTROL.bracketBeforeRole,
  );
  const after = C12_29_S5_SVS_ROWS.find(
    (row) => row.role === C12_29_S5_SVS_CONTROL.bracketAfterRole,
  );
  const midpointMs = (Date.parse(before?.iso) + Date.parse(after?.iso)) / 2;
  const controlMs = Date.parse(C12_29_S5_SVS_CONTROL.iso);
  if (
    control?.phase !== C12_29_S5_SVS_CONTROL.phase ||
    control?.role !== C12_29_S5_SVS_CONTROL.role ||
    control?.iso !== C12_29_S5_SVS_CONTROL.iso ||
    control?.bracketBeforeRole !== C12_29_S5_SVS_CONTROL.bracketBeforeRole ||
    control?.bracketAfterRole !== C12_29_S5_SVS_CONTROL.bracketAfterRole ||
    control?.bracketMidpointIso !== C12_29_S5_SVS_CONTROL.bracketMidpointIso ||
    control?.offsetSeconds !== C12_29_S5_SVS_CONTROL.offsetSeconds ||
    control?.derivation !== C12_29_S5_SVS_CONTROL.derivation ||
    control?.cameraSourceRole !== C12_29_S5_SVS_CONTROL.cameraSourceRole ||
    control?.projectionSourceRole !==
      C12_29_S5_SVS_CONTROL.projectionSourceRole ||
    control?.terrainSourceRole !== C12_29_S5_SVS_CONTROL.terrainSourceRole ||
    Date.parse(C12_29_S5_SVS_CONTROL.bracketMidpointIso) !== midpointMs ||
    controlMs - midpointMs !== C12_29_S5_SVS_CONTROL.offsetSeconds * 1000 ||
    control?.clock?.shouldAnimate !== false ||
    control?.clock?.currentTimeIso !== C12_29_S5_SVS_CONTROL.iso ||
    control?.clock?.renderArgumentIso !== C12_29_S5_SVS_CONTROL.iso ||
    control?.clock?.frameStateTimeIso !== C12_29_S5_SVS_CONTROL.iso ||
    control?.clock?.exactPinnedFrame !== true ||
    control?.classifiedCellCount !== 0 ||
    control?.strictlyClassifiedCellCount !== 0 ||
    !Number.isInteger(control?.oneCodeBoundaryCount) ||
    control.oneCodeBoundaryCount < 0 ||
    control.oneCodeBoundaryCount >
      C12_29_S5_SVS_SCENE.controlOneCodeAllowance ||
    control?.classificationAppliedOnlyInsideTerrainMask !== true ||
    !sameJson(control?.cameraFrame, cameraSource?.cameraFrame)
  ) {
    structural.push(
      `${renderer}: noneclipse zero-classification control differs`,
    );
  }

  validateTerrainTuple(
    control?.terrainTuple,
    renderer,
    C12_29_S5_SVS_CONTROL.role,
    structural,
  );
  const readinessTuple = validateTransitionReadiness(
    control?.transitionReadiness,
    renderer,
    C12_29_S5_SVS_CONTROL.role,
    C12_29_S5_SVS_CONTROL.role,
    C12_29_S5_SVS_CONTROL.iso,
    C12_29_S5_SVS_SCENE.transitionReadinessMaxFrames,
    structural,
  );
  validateCaptureTerrainProofs(
    control,
    renderer,
    C12_29_S5_SVS_CONTROL.role,
    C12_29_S5_SVS_CONTROL.role,
    C12_29_S5_SVS_CONTROL.iso,
    ["white", "black", "off", "on"],
    readinessTuple,
    structural,
  );
  const tupleFields = [
    "selectedTileIds",
    "preparedSelectedTileIds",
    "selectedRealTileIds",
    "selectedFillTileIds",
    "preparedRealTileIds",
    "preparedFillTileIds",
  ];
  if (
    !cameraSource ||
    tupleFields.some(
      (key) =>
        !sameMembers(
          control?.terrainTuple?.[key],
          cameraSource?.terrainTuple?.[key],
        ),
    ) ||
    control?.terrainTuple?.selectedTileId !==
      cameraSource?.terrainTuple?.selectedTileId ||
    control?.terrainTuple?.preparedTileId !==
      cameraSource?.terrainTuple?.preparedTileId ||
    !close(
      control?.terrainTuple?.surfaceRadiusMeters,
      cameraSource?.terrainTuple?.surfaceRadiusMeters,
      1e-9,
    )
  ) {
    structural.push(
      `${renderer}: noneclipse terrain/preparation differs from its camera source`,
    );
  }

  const lattice = control?.lattice;
  const sourceLattice = cameraSource?.lattice;
  const cells = C12_29_S5_SVS_SCENE.latticeSide ** 2;
  for (const key of [
    "validProjectedCellIds",
    "nasaInsideCellIds",
    "terrainCellIds",
    "classifiedCellIds",
    "qBoundaryBandCellIds",
  ]) {
    if (!exactSortedUniqueIntegers(lattice?.[key])) {
      structural.push(
        `${renderer}/noneclipse-control: ${key} is not sorted/unique`,
      );
    }
  }
  const valid = lattice?.validProjectedCellIds ?? [];
  const nasa = lattice?.nasaInsideCellIds ?? [];
  const terrain = lattice?.terrainCellIds ?? [];
  const classified = lattice?.classifiedCellIds ?? [];
  const validSet = new Set(valid);
  const terrainSet = new Set(terrain);
  if (
    lattice?.side !== C12_29_S5_SVS_SCENE.latticeSide ||
    lattice?.candidateCellCount !== cells ||
    lattice?.sampling !== "cell-centre" ||
    lattice?.guardDegrees !== C12_29_S5_SVS_SCENE.cameraGuardDegrees ||
    lattice?.uniqueProjectedCellCount !== valid.length ||
    lattice?.validProjectedCellCount !== valid.length ||
    valid.length < C12_29_S5_SVS_SCENE.minimumUniqueValidProjectedCells ||
    lattice?.nasaInsideCount !== nasa.length ||
    lattice?.nasaOutsideCount !== valid.length - nasa.length ||
    lattice?.duplicateProjectedCellCount !== 0 ||
    valid.some((id) => id >= cells) ||
    !isSubsetOf(nasa, validSet) ||
    !isSubsetOf(terrain, validSet) ||
    !isSubsetOf(classified, terrainSet) ||
    !sameMembers(valid, sourceLattice?.validProjectedCellIds) ||
    !sameMembers(nasa, sourceLattice?.nasaInsideCellIds) ||
    !sameMembers(terrain, sourceLattice?.terrainCellIds) ||
    !sameMembers(
      lattice?.qBoundaryBandCellIds,
      sourceLattice?.qBoundaryBandCellIds,
    ) ||
    !sameJson(lattice?.cellLonLat, sourceLattice?.cellLonLat)
  ) {
    structural.push(
      `${renderer}: noneclipse projection/terrain primitives differ from the exact camera source`,
    );
  }

  const mask = control?.mask;
  const oneCode = mask?.oneCodeBoundaryCellIds;
  const offBright = mask?.offBrightTerrainCellIds;
  if (
    !exactSortedUniqueIntegers(oneCode) ||
    !exactSortedUniqueIntegers(offBright) ||
    mask?.method !== C12_29_S5_SVS_SCENE.terrainMaskMethod ||
    mask?.offMinimumLuminanceCode !==
      C12_29_S5_SVS_SCENE.offMinimumLuminanceCode ||
    mask?.onOffRatioMaximum !== C12_29_S5_SVS_SCENE.onOffRatioMaximum ||
    mask?.terrainPixelCount !== terrain.length ||
    mask?.classifiedCellCount !== classified.length ||
    mask?.strictlyClassifiedCellCount !== classified.length ||
    control?.classifiedCellCount !== classified.length ||
    control?.strictlyClassifiedCellCount !== classified.length ||
    classified.length !== 0 ||
    mask?.oneCodeBoundaryCount !== oneCode?.length ||
    control?.oneCodeBoundaryCount !== oneCode?.length ||
    oneCode?.length > C12_29_S5_SVS_SCENE.controlOneCodeAllowance ||
    mask?.offBrightTerrainPixelCount !== offBright?.length ||
    offBright?.length < C12_29_S5_SVS_SCENE.minimumUniqueValidProjectedCells ||
    terrain.length < C12_29_S5_SVS_SCENE.minimumUniqueValidProjectedCells ||
    !isSubsetOf(oneCode, terrainSet) ||
    !isSubsetOf(offBright, terrainSet) ||
    mask?.allClassifiedMeetOffMinimum !== true ||
    mask?.allClassifiedMeetOnOffRatio !== true ||
    mask?.classificationAppliedOnlyInsideTerrainMask !== true ||
    control?.classificationAppliedOnlyInsideTerrainMask !== true
  ) {
    structural.push(
      `${renderer}: noneclipse raw classifier/brightness primitives differ`,
    );
  }
}

function validateSession(session, renderer, runId, failures, structural) {
  if (
    session?.schema !== C12_29_S5_SVS_DIAGNOSTICS_SCHEMA ||
    session?.renderer !== renderer ||
    session?.serialIndex !== C12_29_S5_SVS_RENDERERS.indexOf(renderer) ||
    session?.freshContext !== true ||
    !finite(session?.startedAtMs) ||
    !finite(session?.completedAtMs) ||
    session.startedAtMs > session.completedAtMs ||
    session?.transport?.loopbackOnly !== true ||
    session?.transport?.externalRequests !== 0 ||
    session?.transport?.failedRequests !== 0 ||
    session?.transport?.ledgerMethod !==
      "generation-aware-post-cleanup-response-drain" ||
    session?.transport?.ledgerSealed !== true ||
    !Number.isInteger(session?.transport?.ledgerGeneration) ||
    session.transport.ledgerGeneration < 1 ||
    session?.transport?.quiescentStableTurns !== 3 ||
    session?.transport?.postSealTurnObserved !== true ||
    session?.transport?.responseBodiesPending !== 0 ||
    session?.transport?.responseBodyErrors !== 0 ||
    !Array.isArray(session?.transport?.lateEvents) ||
    session.transport.lateEvents.length !== 0 ||
    session?.errors?.page?.length !== 0 ||
    session?.errors?.console?.length !== 0 ||
    session?.errors?.gpu?.length !== 0 ||
    session?.errors?.deviceLost !== false
  ) {
    structural.push(`${renderer}: session/runtime error surface is invalid`);
  }
  if (!sameMembers(session?.phaseOrder, C12_29_S5_SVS_PHASES)) {
    structural.push(`${renderer}: A-H phase order/cardinality differs`);
  }
  validateSceneContract(session?.scene, renderer, structural);
  validateIcrf(session?.ephemeris, renderer, structural);
  validateRuntimeFixture(session?.fixtureProof, renderer, structural);
  validateTerrain(session?.terrain, renderer, structural);
  const providerReadinessTuple = validateTransitionReadiness(
    session?.terrain?.providerReadiness,
    renderer,
    "terrain-provider",
    "terrain-provider",
    C12_29_S5_SVS_ROWS[0].iso,
    C12_29_S5_SVS_SCENE.providerReadinessMaxFrames,
    structural,
  );
  if (
    providerReadinessTuple?.sourceTerrainProviderIdentity !==
      session?.terrain?.sourceTerrainProviderIdentity ||
    providerReadinessTuple?.surfaceProviderIdentity !==
      session?.terrain?.surfaceProviderIdentity
  ) {
    structural.push(`${renderer}: terrain-provider readiness owner differs`);
  }
  const rows = Array.isArray(session?.rows) ? session.rows : [];
  if (rows.length !== C12_29_S5_SVS_ROWS.length) {
    structural.push(`${renderer}: expected four NASA rows`);
  }
  if (
    session?.terrain?.selectedRealMeshCount !==
      rows.reduce(
        (count, row) =>
          count + (row?.terrainTuple?.selectedRealTileIds?.length ?? 0),
        0,
      ) ||
    session?.terrain?.preparedRealMeshCount !==
      rows.reduce(
        (count, row) =>
          count + (row?.terrainTuple?.preparedRealTileIds?.length ?? 0),
        0,
      ) ||
    session?.terrain?.fillMeshCount !==
      rows.reduce(
        (count, row) =>
          count + (row?.terrainTuple?.preparedFillTileIds?.length ?? 0),
        0,
      )
  ) {
    structural.push(`${renderer}: terrain selection/preparation totals differ`);
  }
  const budgets = new Map();
  C12_29_S5_SVS_ROWS.forEach((expected, index) => {
    const row = rows[index];
    const budget = validateRow(row, expected, renderer, failures, structural);
    if (budget) budgets.set(expected.role, budget);
  });
  if (
    rows.some(
      (row) =>
        !close(
          row?.cameraFrame?.heightMeters,
          session?.scene?.cameraHeightMeters,
        ) ||
        !close(
          row?.cameraFrame?.verticalFovRadians,
          session?.scene?.verticalFovRadians,
        ),
    )
  ) {
    structural.push(`${renderer}: row cameras do not share the fixed camera`);
  }
  validateMotion(session, budgets, failures, structural);
  validateControl(
    session?.control,
    renderer,
    rows.find((row) => row?.role === C12_29_S5_SVS_CONTROL.cameraSourceRole),
    structural,
  );
  const images = Array.isArray(session?.images) ? session.images : [];
  if (images.length !== C12_29_S5_SVS_CAPTURE_LABELS.length) {
    structural.push(`${renderer}: expected ten captures`);
  }
  C12_29_S5_SVS_CAPTURE_LABELS.forEach((label, index) =>
    validateImage(images[index], label, runId, renderer, structural),
  );
  C12_29_S5_SVS_ROWS.forEach((row, index) =>
    validateMetricImageBindings(
      rows[index],
      images,
      renderer,
      row.role,
      structural,
    ),
  );
  validateMetricImageBindings(
    session?.control,
    images,
    renderer,
    C12_29_S5_SVS_CONTROL.role,
    structural,
  );
  if (
    new Set(images.map((image) => image?.imageId)).size !== images.length ||
    new Set(images.map((image) => image?.file)).size !== images.length
  ) {
    structural.push(`${renderer}: capture image identities are not unique`);
  }
  if (
    session?.capture?.method !== C12_29_S5_SVS_CAPTURE_METHOD ||
    session?.capture?.canonicalSameTask !== true ||
    session?.cleanup?.contextClosed !== true ||
    session?.cleanup?.contextCloseAttempted !== true ||
    session?.cleanup?.contextCloseTimedOut !== false ||
    session?.cleanup?.pageClosed !== true ||
    session?.cleanup?.pageCloseAttempted !== true ||
    session?.cleanup?.pageCloseTimedOut !== false ||
    session?.cleanup?.closeTimeoutMs !==
      C12_29_S5_SVS_SCENE.cleanupCloseTimeoutMs ||
    session?.cleanup?.pendingRequestsMeasured !== true ||
    session?.cleanup?.pendingRequests !== 0 ||
    !Number.isInteger(session?.cleanup?.requestStartedCount) ||
    session.cleanup.requestStartedCount < 1 ||
    session?.cleanup?.requestSettledCount !==
      session?.cleanup?.requestStartedCount ||
    !Number.isInteger(session?.cleanup?.pendingRequestPeak) ||
    session.cleanup.pendingRequestPeak < 1 ||
    session.cleanup.pendingRequestPeak > session.cleanup.requestStartedCount ||
    session?.cleanup?.deviceLost !== false
  ) {
    structural.push(`${renderer}: capture/cleanup proof is invalid`);
  }
}

function validateCrossBackend(cross, sessions, failures, structural) {
  if (!Array.isArray(cross) || cross.length !== C12_29_S5_SVS_ROWS.length) {
    structural.push("cross-backend comparison cardinality differs");
    return;
  }
  C12_29_S5_SVS_ROWS.forEach((expected, index) => {
    const row = cross[index];
    const gl = sessions[0]?.rows?.[index];
    const gpu = sessions[1]?.rows?.[index];
    const qKm = Math.max(gl?.budget?.qKm ?? NaN, gpu?.budget?.qKm ?? NaN);
    const glSet = new Set(gl?.lattice?.classifiedCellIds ?? []);
    const gpuSet = new Set(gpu?.lattice?.classifiedCellIds ?? []);
    const derivedDiffering = [...new Set([...glSet, ...gpuSet])]
      .filter((id) => glSet.has(id) !== gpuSet.has(id))
      .sort((left, right) => left - right);
    const derivedDistance = wgs84GeodesicDistanceKm(
      gl?.centroid?.measuredLonLat,
      gpu?.centroid?.measuredLonLat,
    );
    if (
      row?.role !== expected.role ||
      !exactSortedUniqueIntegers(row?.differingCellIds) ||
      row?.differingCellCount !== row?.differingCellIds?.length ||
      row?.allDifferingCellsWithinUnionQBoundaryBands !== true ||
      row?.centroidDistanceMethod !== "WGS84-Vincenty-inverse" ||
      !close(row?.centroidLimitKm, 2 * qKm, 1e-9)
    ) {
      structural.push(`${expected.role}: cross-backend proof is malformed`);
    }
    if (
      !sameMembers(row?.differingCellIds, derivedDiffering) ||
      !close(row?.centroidDistanceKm, derivedDistance, 1e-9)
    ) {
      structural.push(`${expected.role}: cross-backend summary is not derived`);
    }
    if (!finite(row?.centroidDistanceKm) || row.centroidDistanceKm > 2 * qKm) {
      failures.push(`${expected.role}: cross-backend centroid is red`);
    }
    const glBand = new Set(gl?.lattice?.qBoundaryBandCellIds ?? []);
    const gpuBand = new Set(gpu?.lattice?.qBoundaryBandCellIds ?? []);
    if (
      (row?.differingCellIds ?? []).some(
        (id) => !glBand.has(id) && !gpuBand.has(id),
      )
    ) {
      failures.push(`${expected.role}: differing cells escape both Q bands`);
    }
  });
}

function validFirstRedBaseline(value) {
  if (
    typeof value?.file !== "string" ||
    !/\.first-red\.json$/u.test(value.file)
  ) {
    return false;
  }
  if (value?.exists === false) {
    return (
      value?.byteLength === null &&
      value?.sha256 === null &&
      value?.error === "ENOENT"
    );
  }
  return (
    value?.exists === true &&
    Number.isInteger(value?.byteLength) &&
    value.byteLength > 0 &&
    SHA256.test(value?.sha256 ?? "") &&
    isUuidV4(value?.runId) &&
    new Set(["FAIL", "STRUCTURAL", "ERROR"]).has(value?.status)
  );
}

function sameFirstRedProof(left, right) {
  if (!validFirstRedBaseline(left) || !validFirstRedBaseline(right)) {
    return false;
  }
  if (
    left.file !== right.file ||
    left.exists !== right.exists ||
    left.byteLength !== right.byteLength ||
    left.sha256 !== right.sha256
  ) {
    return false;
  }
  return left.exists
    ? left.status === right.status && left.runId === right.runId
    : left.error === right.error;
}

/** Fold one complete report. STRUCTURAL takes precedence over product FAIL. */
export function foldC1229S5SvsGate(report) {
  const structuralReasons = [];
  const failures = [];
  if (report?.schema !== C12_29_S5_SVS_SCHEMA || !isUuidV4(report?.runId)) {
    structuralReasons.push("report schema/run identity is invalid");
  }
  const lifecycle = report?.lifecycle;
  if (
    lifecycle?.firstRedStable !== true ||
    lifecycle?.firstRedBaselineValidated !== true ||
    !validFirstRedBaseline(lifecycle?.firstRedBaseline) ||
    !sameFirstRedProof(
      lifecycle?.firstRedBaseline,
      lifecycle?.firstRedCurrent,
    ) ||
    lifecycle?.browserCleanup?.attempted !== true ||
    lifecycle?.browserCleanup?.closed !== true ||
    lifecycle?.browserCleanup?.timedOut !== false ||
    lifecycle?.browserCleanup?.closeTimeoutMs !==
      C12_29_S5_SVS_SCENE.cleanupCloseTimeoutMs ||
    lifecycle?.lockCreatedExclusively !== true ||
    lifecycle?.runningReceiptCreatedExclusively !== true ||
    lifecycle?.foreignOwnerPreserved !== true ||
    lifecycle?.recoveryInspected !== true ||
    lifecycle?.runningPublishedBeforeBrowser !== true ||
    lifecycle?.immutableBeforeLatest !== true ||
    lifecycle?.latestBeforeUnlock !== true ||
    lifecycle?.lockOwnedByRun !== true ||
    lifecycle?.archiveLatestByteIdentical !== true ||
    validateSvsRunningArtifactShape(lifecycle?.runningReceipt).length !== 0 ||
    lifecycle?.runningReceipt?.runId !== report?.runId ||
    lifecycle?.finalReceipt?.schema !== C12_29_S5_SVS_SCHEMA ||
    lifecycle?.finalReceipt?.runId !== report?.runId ||
    lifecycle?.finalReceipt?.status !== lifecycle?.finalStatus ||
    (report?.status !== undefined &&
      (lifecycle?.finalStatus !== report.status ||
        lifecycle?.finalReceipt?.status !== report.status)) ||
    lifecycle?.finalReceipt?.incomplete !== false ||
    lifecycle?.finalReceipt?.publicationProtocol !==
      "exclusive-lock+write-once-receipts+claim-verify-latest+foreign-preserving-unlock" ||
    lifecycle?.lock?.runId !== report?.runId ||
    lifecycle?.lock?.nonce !== lifecycle?.runningReceipt?.nonce ||
    lifecycle?.lock?.released !== true ||
    lifecycle?.lock?.releaseAfterLatestVerified !== true ||
    lifecycle?.priorStateInspected !== true ||
    lifecycle?.publicationOrder?.join(",") !==
      (lifecycle?.finalStatus === "PASS"
        ? "LOCK,RUNNING,ARCHIVE,LATEST,RECEIPT,UNLOCK"
        : "LOCK,RUNNING,ARCHIVE,FIRST_RED,LATEST,RECEIPT,UNLOCK")
  ) {
    structuralReasons.push("evidence lifecycle is not mature/write-once");
  }
  validateProvenance(report?.provenance, structuralReasons);
  const sessions = Array.isArray(report?.sessions) ? report.sessions : [];
  if (sessions.length !== C12_29_S5_SVS_RENDERERS.length) {
    structuralReasons.push("expected exactly two serial renderer sessions");
  }
  C12_29_S5_SVS_RENDERERS.forEach((renderer, index) =>
    validateSession(
      sessions[index],
      renderer,
      report?.runId,
      failures,
      structuralReasons,
    ),
  );
  if (sessions[0]?.completedAtMs > sessions[1]?.startedAtMs) {
    structuralReasons.push(
      "renderer sessions overlap instead of running serially",
    );
  }
  validateCrossBackend(
    report?.crossBackend,
    sessions,
    failures,
    structuralReasons,
  );
  const status =
    structuralReasons.length > 0
      ? "STRUCTURAL"
      : failures.length > 0
        ? "FAIL"
        : "PASS";
  return {
    status,
    exitCode: exitCodeForSvsStatus(status),
    structuralReasons,
    failures,
  };
}

export default {
  C12_29_S5_SVS_SCHEMA,
  C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
  C12_29_S5_SVS_RENDERERS,
  C12_29_S5_SVS_PHASES,
  C12_29_S5_SVS_ROWS,
  C12_29_S5_SVS_CONTROL,
  C12_29_S5_SVS_CAPTURE_LABELS,
  C12_29_S5_SVS_CAPTURE_METHOD,
  C12_29_S5_SVS_FIXTURE,
  C12_29_S5_SVS_TERRAIN,
  C12_29_S5_SVS_SCENE,
  C12_29_S5_SVS_SOURCE_MAX_EDGE_KM,
  C12_29_S5_SVS_SIMON1994_BUDGET_KM,
  C12_29_S5_SVS_SOURCE_MOTION,
  C12_29_S5_SVS_SOURCE_EDGE,
  C12_29_S5_SVS_SOURCE_FILES,
  C12_29_S5_SVS_BUILD_SOURCE_FILES,
  C12_29_S5_SVS_BUILD_SOURCE_MAP,
  computeSvsFootprintBudget,
  validateSvsRunningArtifactShape,
  wgs84GeodesicDistanceKm,
  foldC1229S5SvsGate,
};
