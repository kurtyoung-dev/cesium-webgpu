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
import { types as utilTypes } from "node:util";

import { exitCodeForS5StatusOrStructural as exitCodeForSvsStatus } from "./verdict-exit-gate.mjs";

export const C12_29_S5_SVS_SCHEMA = "c12-29-s5-svs-5073-footprint-evidence-v5";

export const C12_29_S5_SVS_DIAGNOSTICS_SCHEMA =
  "c12-29-s5-svs-5073-footprint-runtime-diagnostics-v5";

export const C12_29_S5_SVS_SUPERSEDED_V4_SCHEMA =
  "c12-29-s5-svs-5073-footprint-evidence-v4";

export const C12_29_S5_SVS_SUPERSEDED_V4_DIAGNOSTICS_SCHEMA =
  "c12-29-s5-svs-5073-footprint-runtime-diagnostics-v4";

export const C12_29_S5_SVS_SUPERSEDED_SCHEMA =
  "c12-29-s5-svs-5073-footprint-evidence-v3";

export const C12_29_S5_SVS_SUPERSEDED_DIAGNOSTICS_SCHEMA =
  "c12-29-s5-svs-5073-footprint-runtime-diagnostics-v3";

export const C12_29_S5_SVS_LEGACY_ERROR_SCHEMA =
  "c12-29-s5-svs-5073-footprint-evidence-v2";

export const C12_29_S5_SVS_ARTIFACT_PREFIX =
  "campaign12-c12-29-s5-svs-5073-footprint";

export const C12_29_S5_SVS_EPHEMERIS = Object.freeze({
  providerConstructor: "Simon1994EphemerisProvider",
  providerId: "cesium-simon1994-ecef",
  providerRevision: 2,
  referenceFrame: "ECEF",
  units: "metres",
  transformBranch: "SIMON1994_ICRF_TO_FIXED_IAU2006_XYS",
  maximumIndependentDeltaMeters: 1e-3,
  outputAllocationStable: true,
  thirdPartyTemporaryFree: true,
  independentMethod:
    "Simon1994PlanetaryPositions+Transforms.computeIcrfToFixedMatrix",
  provenance: Object.freeze({
    id: "cesium-simon1994-planetary-positions/current-engine-series",
    sunAndMoonSeries: "Simon1994PlanetaryPositions",
    outputFrame: "ECEF",
    outputUnits: "metres",
    eventSpecificCorrections: false,
    angularRadiusCorrections: false,
    revisionPolicy:
      "1=TEME pseudo-fixed fallback; 2=ICRF-to-fixed IAU2006 XYS branch",
    outputAllocationStable: true,
    sampleValidationTemporaryFree: true,
    sampleValidationPolicy:
      "WeakSet brand with fixed sealed output structure; no per-call descriptor/state records",
    thirdPartyTemporaryFree: true,
  }),
  timePolicy: Object.freeze({
    id: "cesium-julian-date-tai/simon1994-tdb/icrf-with-teme-fallback",
    inputTimeScale: "TAI",
    ephemerisDynamicalScale: "TDB_APPROXIMATION",
    primaryEarthRotation: "IAU2006_XYS",
    fallbackEarthRotation: "IAU1982_GMST_TEME_PSEUDO_FIXED",
  }),
});

export const C12_29_S5_SVS_DIAGNOSTIC_LIMITS = Object.freeze({
  arrayEntries: 512,
  cleanupEntries: 16,
  entryCharacters: 32_768,
  errorCharacters: 65_536,
  diagnosticErrorCount: 1_000_000,
  cleanupErrorCount: 1_000_000,
});

export function createSvsDiagnosticOverflowMarker(category, total, retained) {
  return `[SVS_OVERFLOW ${category} total=${total} retained=${retained} omitted=${total - retained}]`;
}

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
  ...C12_29_S5_SVS_ROWS.flatMap((row) => [
    `${row.role}-white`,
    `${row.role}-black`,
    `${row.role}-off`,
    `${row.role}-on`,
  ]),
  "noneclipse-control-white",
  "noneclipse-control-black",
  "noneclipse-control-off",
  "noneclipse-control-on",
]);

export const C12_29_S5_SVS_V4_CAPTURE_LABELS = Object.freeze([
  ...C12_29_S5_SVS_ROWS.flatMap((row) => [`${row.role}-off`, `${row.role}-on`]),
  "noneclipse-control-off",
  "noneclipse-control-on",
]);

export const C12_29_S5_SVS_CAPTURE_STATES = Object.freeze({
  white: Object.freeze({
    baseColor: Object.freeze([1, 1, 1, 1]),
    enableEclipse: false,
    enableEclipseGlobeShadow: false,
    eclipseAutoExposure: true,
    enableEclipseHorizonTwilight: false,
  }),
  black: Object.freeze({
    baseColor: Object.freeze([0, 0, 0, 1]),
    enableEclipse: false,
    enableEclipseGlobeShadow: false,
    eclipseAutoExposure: true,
    enableEclipseHorizonTwilight: false,
  }),
  off: Object.freeze({
    baseColor: Object.freeze([1, 1, 1, 1]),
    enableEclipse: false,
    enableEclipseGlobeShadow: false,
    eclipseAutoExposure: true,
    enableEclipseHorizonTwilight: false,
  }),
  on: Object.freeze({
    baseColor: Object.freeze([1, 1, 1, 1]),
    enableEclipse: true,
    enableEclipseGlobeShadow: true,
    eclipseAutoExposure: true,
    enableEclipseHorizonTwilight: false,
  }),
});

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
  verticalFovRadians: 0.9599310885968813,
  cameraHeightMeters: 556331.4678975162,
  pixelGroundFootprintKm: 0.6033496486927782,
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

/**
 * Independently reproduces the exact WGS84 cell-centre projection used by the
 * browser probe. It deliberately does not consume the browser-reported valid
 * IDs or cell-to-pixel array, so coordinated permutations and omissions cannot
 * become self-authenticating evidence.
 */
export function deriveSvsWgs84ProjectedLattice(expectedRow) {
  const bbox = expectedRow?.fixtureGeometry?.bbox;
  const centerLonLat = expectedRow?.sourceCenter;
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    bbox.some((value) => !Number.isFinite(value)) ||
    !Array.isArray(centerLonLat) ||
    centerLonLat.length !== 2 ||
    centerLonLat.some((value) => !Number.isFinite(value))
  ) {
    throw new TypeError("SVS projection row is malformed");
  }

  const semimajor = 6_378_137;
  const semiminor = 6_356_752.314245179;
  const radiiSquared = [
    semimajor * semimajor,
    semimajor * semimajor,
    semiminor * semiminor,
  ];
  const oneOverRadiiSquared = radiiSquared.map((value) => 1 / value);
  const dot = (left, right) =>
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  const subtract = (left, right) =>
    left.map((value, index) => value - right[index]);
  const cross = (left, right) => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
  const normalize = (value) => {
    const magnitude = Math.hypot(...value);
    if (!(magnitude > 0)) throw new TypeError("SVS projection basis is zero");
    return value.map((component) => component / magnitude);
  };
  // This is the same radii-squared/gamma construction used by
  // Ellipsoid.cartographicToCartesian, rather than a spherical shortcut.
  const cartesianFromDegrees = (longitudeDegrees, latitudeDegrees, height) => {
    const longitude = (longitudeDegrees * Math.PI) / 180;
    const latitude = (latitudeDegrees * Math.PI) / 180;
    const cosLatitude = Math.cos(latitude);
    const normal = [
      cosLatitude * Math.cos(longitude),
      cosLatitude * Math.sin(longitude),
      Math.sin(latitude),
    ];
    const scaled = normal.map(
      (component, index) => component * radiiSquared[index],
    );
    const gamma = Math.sqrt(dot(normal, scaled));
    return scaled.map(
      (component, index) => component / gamma + normal[index] * height,
    );
  };

  const surfaceCenter = cartesianFromDegrees(...centerLonLat, 0);
  const position = cartesianFromDegrees(
    ...centerLonLat,
    C12_29_S5_SVS_SCENE.cameraHeightMeters,
  );
  const direction = normalize(subtract(surfaceCenter, position));
  const surfaceNormal = normalize(
    surfaceCenter.map(
      (component, index) => component * oneOverRadiiSquared[index],
    ),
  );
  let right = normalize(cross([0, 0, 1], surfaceNormal));
  const up = normalize(cross(right, direction));
  right = normalize(cross(direction, up));

  const side = C12_29_S5_SVS_SCENE.latticeSide;
  const width = C12_29_S5_SVS_SCENE.viewport.width;
  const height = C12_29_S5_SVS_SCENE.viewport.height;
  const aspect = width / height;
  const tanHalfVerticalFov = Math.tan(
    C12_29_S5_SVS_SCENE.verticalFovRadians * 0.5,
  );
  const west = bbox[0] - C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const south = bbox[1] - C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const east = bbox[2] + C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const north = bbox[3] + C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const validProjectedCellIds = [];
  const projectedPixelIdByValidCell = [];
  const cellLonLat = [];
  const projected = new Set();
  let duplicateProjectedCellCount = 0;

  for (let y = 0; y < side; y++) {
    const latitude = north - ((y + 0.5) / side) * (north - south);
    for (let x = 0; x < side; x++) {
      const longitude = west + ((x + 0.5) / side) * (east - west);
      const id = y * side + x;
      const relative = subtract(
        cartesianFromDegrees(longitude, latitude, 0),
        position,
      );
      const forward = dot(relative, direction);
      if (!(forward > 0)) continue;
      const ndcX =
        dot(relative, right) / (forward * tanHalfVerticalFov * aspect);
      const ndcY = dot(relative, up) / (forward * tanHalfVerticalFov);
      const pixelX = Math.floor(((ndcX + 1) * width) / 2);
      const pixelY = Math.floor(((1 - ndcY) * height) / 2);
      if (pixelX < 0 || pixelY < 0 || pixelX >= width || pixelY >= height) {
        continue;
      }
      const projectedId = pixelY * width + pixelX;
      if (projected.has(projectedId)) {
        duplicateProjectedCellCount++;
        continue;
      }
      projected.add(projectedId);
      validProjectedCellIds.push(id);
      projectedPixelIdByValidCell.push(projectedId);
      cellLonLat.push([id, longitude, latitude]);
    }
  }
  return {
    validProjectedCellIds,
    projectedPixelIdByValidCell,
    cellLonLat,
    duplicateProjectedCellCount,
  };
}

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
  "packages/engine/Source/Core/Ellipsoid.js",
  "packages/engine/Source/Core/EllipsoidGeodesic.js",
  "packages/engine/Source/Core/JulianDate.js",
  "packages/engine/Source/Core/Math.js",
  "packages/engine/Source/Core/Matrix3.js",
  "packages/engine/Source/Core/TimeInterval.js",
  "packages/engine/Source/Core/VerticalExaggeration.js",
  "packages/engine/Source/Core/Visibility.js",
  "packages/engine/Source/Core/CelestialEphemerisProvider.js",
  "packages/engine/Source/Core/Simon1994EphemerisProvider.js",
  "packages/engine/Source/Core/Transforms.js",
  "packages/engine/Source/Core/Iau2006XysData.js",
  "packages/engine/Source/Core/Simon1994PlanetaryPositions.js",
  "packages/engine/Source/Core/CesiumTerrainProvider.js",
  "packages/engine/Source/Core/QuantizedMeshTerrainData.js",
  "packages/engine/Source/Scene/AtmosphericConditions.js",
  "packages/engine/Source/Scene/Camera.js",
  "packages/engine/Source/Scene/CameraHelpers.js",
  "packages/engine/Source/Scene/CameraInternals.js",
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
  "packages/engine/Source/Renderer/UniformStateComputations.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
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
  "packages/engine/Source/Scene/Moon.js",
  "packages/engine/Source/Renderer/FeatureRendererKey.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
  "packages/engine/Source/Widget/CesiumWidget.js",
]);

export const C12_29_S5_SVS_BUILD_SOURCE_FILES = Object.freeze(
  C12_29_S5_SVS_SOURCE_FILES.filter(
    (file) => !file.endsWith(".glsl") && !file.endsWith(".wgsl"),
  ),
);

const C12_29_S5_SVS_V5_SOURCE_ADDITIONS = new Set([
  "packages/engine/Source/Core/Ellipsoid.js",
  "packages/engine/Source/Scene/AtmosphericConditions.js",
  "packages/engine/Source/Scene/Camera.js",
  "packages/engine/Source/Scene/CameraHelpers.js",
  "packages/engine/Source/Scene/CameraInternals.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
]);

export const C12_29_S5_SVS_V4_SOURCE_FILES = Object.freeze(
  C12_29_S5_SVS_SOURCE_FILES.filter(
    (file) => !C12_29_S5_SVS_V5_SOURCE_ADDITIONS.has(file),
  ),
);

export const C12_29_S5_SVS_V4_BUILD_SOURCE_FILES = Object.freeze(
  C12_29_S5_SVS_V4_SOURCE_FILES.filter(
    (file) => !file.endsWith(".glsl") && !file.endsWith(".wgsl"),
  ),
);

const SVS_V5_SCHEMA_CONTRACT = Object.freeze({
  schema: C12_29_S5_SVS_SCHEMA,
  diagnosticsSchema: C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
  buildSourceFiles: C12_29_S5_SVS_BUILD_SOURCE_FILES,
  captureLabels: C12_29_S5_SVS_CAPTURE_LABELS,
  metricChannels: Object.freeze(["white", "black", "off", "on"]),
  requiresV5Evidence: true,
});

const SVS_V4_SCHEMA_CONTRACT = Object.freeze({
  schema: C12_29_S5_SVS_SUPERSEDED_V4_SCHEMA,
  diagnosticsSchema: C12_29_S5_SVS_SUPERSEDED_V4_DIAGNOSTICS_SCHEMA,
  buildSourceFiles: C12_29_S5_SVS_V4_BUILD_SOURCE_FILES,
  captureLabels: C12_29_S5_SVS_V4_CAPTURE_LABELS,
  metricChannels: Object.freeze(["off", "on"]),
  requiresV5Evidence: false,
});

export const C12_29_S5_SVS_BUILD_SOURCE_MAP =
  "Build/CesiumUnminified/index.js.map";

const SHA256 = /^[0-9a-f]{64}$/u;
const FINAL_STATUSES = new Set(["PASS", "FAIL", "STRUCTURAL", "ERROR"]);
const SVS_RUNTIME_CHECKPOINT_STAGES = new Set([
  "runtime-import",
  "viewer-contract",
  "runtime-ready",
  "phase-transition",
  "row-transition",
  "transition-readiness-complete",
  "lattice-projection",
  "lattice-membership-complete",
  "spatial-summary",
  "spatial-summary-complete",
  "motion-summary-complete",
]);
const SVS_SPATIAL_UNAVAILABLE_REASONS = new Set([
  "source-empty",
  "source-boundary-empty",
  "classified-empty",
  "classified-boundary-empty",
]);
const spatialMetricCache = new Map();
const latticeAnchorCache = new Map();

const finite = (value) => Number.isFinite(value);
const nonnegativeInteger = (value) =>
  Number.isInteger(value) && !Object.is(value, -0) && value >= 0;
const close = (left, right, epsilon = 1e-9) =>
  finite(left) && finite(right) && Math.abs(left - right) <= epsilon;

function isDegreeLonLat(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(finite) &&
    value.every((entry) => !Object.is(entry, -0)) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}

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
    exactArrayData(value, 1024) &&
    value.every((item) => /^\d+\/\d+\/\d+$/u.test(item)) &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

function sameJson(left, right) {
  return canonicalJsonIdentity(left) === canonicalJsonIdentity(right);
}

function canonicalJsonIdentity(value) {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, entry[key]]),
      );
    }
    return entry;
  });
}

function sameMembers(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function exactEnumerableDataObject(value) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      utilTypes.isProxy(value) ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable === true
      );
    });
  } catch {
    return false;
  }
}

function exactArrayData(value, maximumLength = 1_000_000) {
  try {
    if (
      utilTypes.isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return false;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      lengthDescriptor.enumerable !== false ||
      !nonnegativeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value > maximumLength
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== lengthDescriptor.value + 1 ||
      keys.at(-1) !== "length"
    ) {
      return false;
    }
    for (let index = 0; index < lengthDescriptor.value; index++) {
      const key = String(index);
      if (keys[index] !== key) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function exactObjectKeys(value, expected) {
  if (!exactEnumerableDataObject(value)) return false;
  try {
    const actual = Reflect.ownKeys(value);
    const sortedExpected = [...expected].sort();
    return (
      actual.length === expected.length &&
      [...actual].sort().every((key, index) => key === sortedExpected[index])
    );
  } catch {
    return false;
  }
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
  if (!isDegreeLonLat(left) || !isDegreeLonLat(right)) {
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

// The tolerant reader over the shared verdict-tier table: this gate resolves
// statuses read out of untrusted artifact data, where an unreadable tier means
// the artifact cannot vouch for what it saw.
export { exitCodeForSvsStatus };

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

export function validateSvsRunningArtifactShape(
  artifact,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
  const reasons = [];
  try {
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
      return reasons;
    }
    if (artifact?.schema !== schemaContract.schema) {
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
  } catch {
    reasons.push("RUNNING artifact could not be safely inspected");
    return reasons;
  }
}

export function validateSupersededSvsV4RunningArtifactShape(artifact) {
  return validateSvsRunningArtifactShape(artifact, SVS_V4_SCHEMA_CONTRACT);
}

function boundedSvsString(value, maximumLength, allowEmpty = false) {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximumLength
  );
}

function validateSvsDiagnosticStringArray(
  value,
  category,
  maximumEntries = C12_29_S5_SVS_DIAGNOSTIC_LIMITS.arrayEntries,
) {
  if (
    !exactArrayData(value, maximumEntries) ||
    value.length > maximumEntries ||
    !value.every((entry) =>
      boundedSvsString(
        entry,
        C12_29_S5_SVS_DIAGNOSTIC_LIMITS.entryCharacters,
        true,
      ),
    )
  ) {
    return false;
  }
  const overflowPrefix = `[SVS_OVERFLOW ${category} `;
  const overflowIndexes = value.flatMap((entry, index) =>
    entry.startsWith(overflowPrefix) ? [index] : [],
  );
  if (overflowIndexes.length === 0) return true;
  if (
    overflowIndexes.length !== 1 ||
    overflowIndexes[0] !== maximumEntries - 1 ||
    value.length !== maximumEntries
  ) {
    return false;
  }
  const match =
    /^\[SVS_OVERFLOW .+ total=(\d+) retained=(\d+) omitted=(\d+)\]$/u.exec(
      value.at(-1),
    );
  if (!match) return false;
  const total = Number(match[1]);
  const retained = Number(match[2]);
  const omitted = Number(match[3]);
  return (
    Number.isSafeInteger(total) &&
    total >= 0 &&
    retained === maximumEntries - 1 &&
    total > maximumEntries &&
    omitted === total - retained &&
    value.at(-1) ===
      createSvsDiagnosticOverflowMarker(category, total, retained)
  );
}

function validateSvsDiagnosticArrayCount(
  value,
  category,
  total,
  maximumEntries = C12_29_S5_SVS_DIAGNOSTIC_LIMITS.arrayEntries,
  maximumTotal = C12_29_S5_SVS_DIAGNOSTIC_LIMITS.diagnosticErrorCount,
) {
  if (
    !validateSvsDiagnosticStringArray(value, category, maximumEntries) ||
    !nonnegativeInteger(total) ||
    total > maximumTotal
  ) {
    return false;
  }
  const overflowPrefix = `[SVS_OVERFLOW ${category} `;
  if (total <= maximumEntries) {
    return (
      value.length === total &&
      !value.some((entry) => entry.startsWith(overflowPrefix))
    );
  }
  return (
    value.length === maximumEntries &&
    value.at(-1) ===
      createSvsDiagnosticOverflowMarker(category, total, maximumEntries - 1)
  );
}

function validateSvsCheckpointCentroid(value) {
  return (
    exactObjectKeys(value, ["available", "lonLat"]) &&
    typeof value.available === "boolean" &&
    (value.available
      ? exactArrayData(value.lonLat, 2) && isDegreeLonLat(value.lonLat)
      : value.lonLat === null)
  );
}

function validateSvsCheckpointTerrain(value) {
  if (
    !exactObjectKeys(value, [
      "transitionRole",
      "selectedTileIds",
      "preparedSelectedTileIds",
      "selectionRevision",
      "captureFrameNumber",
    ])
  ) {
    return false;
  }
  if (value.transitionRole === null) {
    return (
      exactArrayData(value.selectedTileIds, 1024) &&
      value.selectedTileIds.length === 0 &&
      exactArrayData(value.preparedSelectedTileIds, 1024) &&
      value.preparedSelectedTileIds.length === 0 &&
      value.selectionRevision === null &&
      value.captureFrameNumber === null
    );
  }
  const roles = new Set([
    ...C12_29_S5_SVS_ROWS.map((row) => row.role),
    C12_29_S5_SVS_CONTROL.role,
  ]);
  return (
    roles.has(value.transitionRole) &&
    exactSortedUniqueTileIds(value.selectedTileIds) &&
    value.selectedTileIds.length > 0 &&
    value.selectedTileIds.length <= 1024 &&
    exactSortedUniqueTileIds(value.preparedSelectedTileIds) &&
    value.preparedSelectedTileIds.length <= 1024 &&
    sameMembers(value.selectedTileIds, value.preparedSelectedTileIds) &&
    nonnegativeInteger(value.selectionRevision) &&
    nonnegativeInteger(value.captureFrameNumber)
  );
}

/** Validate the exact JSON-safe checkpoint retained inside a page ERROR. */
export function validateSvsRuntimeCheckpointShape(
  checkpoint,
  expectedRenderer,
  diagnosticsSchema = C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
) {
  const reasons = [];
  try {
    if (
      !exactObjectKeys(checkpoint, [
        "schema",
        "renderer",
        "sequence",
        "phase",
        "stage",
        "rowIndex",
        "role",
        "iso",
        "measurementKind",
        "counts",
        "sourceCentroid",
        "measuredCentroid",
        "boundary",
        "terrain",
      ])
    ) {
      reasons.push("runtime checkpoint keys are not exact");
      return reasons;
    }
    if (
      checkpoint.schema !== diagnosticsSchema ||
      !C12_29_S5_SVS_RENDERERS.includes(checkpoint.renderer) ||
      (expectedRenderer !== undefined &&
        checkpoint.renderer !== expectedRenderer) ||
      !nonnegativeInteger(checkpoint.sequence) ||
      checkpoint.sequence < 1 ||
      checkpoint.sequence > 1_000_000 ||
      !SVS_RUNTIME_CHECKPOINT_STAGES.has(checkpoint.stage) ||
      (checkpoint.phase !== null &&
        !C12_29_S5_SVS_PHASES.includes(checkpoint.phase))
    ) {
      reasons.push("runtime checkpoint identity/stage is invalid");
    }

    const expectedOwner = nonnegativeInteger(checkpoint.rowIndex)
      ? checkpoint.rowIndex >= 0 &&
        checkpoint.rowIndex < C12_29_S5_SVS_ROWS.length
        ? {
            ...C12_29_S5_SVS_ROWS[checkpoint.rowIndex],
            measurementKind: "event",
          }
        : checkpoint.rowIndex === C12_29_S5_SVS_ROWS.length
          ? { ...C12_29_S5_SVS_CONTROL, measurementKind: "control" }
          : undefined
      : checkpoint.rowIndex === null
        ? null
        : undefined;
    if (
      expectedOwner === undefined ||
      (expectedOwner === null
        ? checkpoint.role !== null ||
          checkpoint.iso !== null ||
          checkpoint.measurementKind !== null
        : checkpoint.role !== expectedOwner.role ||
          checkpoint.iso !== expectedOwner.iso ||
          checkpoint.measurementKind !== expectedOwner.measurementKind)
    ) {
      reasons.push("runtime checkpoint row/role/kind identity differs");
    }

    const counts = checkpoint.counts;
    const countKeys = [
      "valid",
      "nasa",
      "terrain",
      "classified",
      "sourceBoundary",
      "classifiedBoundary",
    ];
    const maximumCells = C12_29_S5_SVS_SCENE.latticeSide ** 2;
    const countValue = (value) =>
      value === null || (nonnegativeInteger(value) && value <= maximumCells);
    if (
      !exactObjectKeys(counts, countKeys) ||
      countKeys.some((key) => !countValue(counts?.[key]))
    ) {
      reasons.push("runtime checkpoint counts are invalid");
    } else {
      const membership = [
        counts.valid,
        counts.nasa,
        counts.terrain,
        counts.classified,
      ];
      const boundaries = [counts.sourceBoundary, counts.classifiedBoundary];
      const membershipNull = membership.every((value) => value === null);
      const membershipPresent = membership.every(Number.isInteger);
      const boundariesNull = boundaries.every((value) => value === null);
      const boundariesPresent = boundaries.every(Number.isInteger);
      if (
        (!membershipNull && !membershipPresent) ||
        (!boundariesNull && !boundariesPresent) ||
        (boundariesPresent && !membershipPresent) ||
        (membershipPresent &&
          (counts.nasa > counts.valid ||
            counts.terrain > counts.valid ||
            counts.classified > counts.terrain)) ||
        (boundariesPresent &&
          (counts.sourceBoundary > counts.nasa ||
            counts.classifiedBoundary > counts.classified))
      ) {
        reasons.push("runtime checkpoint count/null coherence differs");
      }
    }

    if (
      !validateSvsCheckpointCentroid(checkpoint.sourceCentroid) ||
      !validateSvsCheckpointCentroid(checkpoint.measuredCentroid) ||
      !exactObjectKeys(checkpoint.boundary, [
        "comparable",
        "unavailableReason",
      ]) ||
      typeof checkpoint.boundary?.comparable !== "boolean" ||
      (checkpoint.boundary?.unavailableReason !== null &&
        !SVS_SPATIAL_UNAVAILABLE_REASONS.has(
          checkpoint.boundary.unavailableReason,
        )) ||
      !validateSvsCheckpointTerrain(checkpoint.terrain)
    ) {
      reasons.push("runtime checkpoint spatial/terrain state is invalid");
    }

    const membershipPresent = [
      counts?.valid,
      counts?.nasa,
      counts?.terrain,
      counts?.classified,
    ].every(Number.isInteger);
    const boundariesPresent = [
      counts?.sourceBoundary,
      counts?.classifiedBoundary,
    ].every(Number.isInteger);
    const preSummarySpatial =
      checkpoint.sourceCentroid?.available === false &&
      checkpoint.sourceCentroid?.lonLat === null &&
      checkpoint.measuredCentroid?.available === false &&
      checkpoint.measuredCentroid?.lonLat === null &&
      checkpoint.boundary?.comparable === false &&
      checkpoint.boundary?.unavailableReason === null;
    const initialTerrain = checkpoint.terrain?.transitionRole === null;
    const measurementStages = new Set([
      "row-transition",
      "transition-readiness-complete",
      "lattice-projection",
      "lattice-membership-complete",
      "spatial-summary",
      "spatial-summary-complete",
    ]);
    if (
      measurementStages.has(checkpoint.stage) &&
      (expectedOwner === null ||
        checkpoint.phase !== C12_29_S5_SVS_PHASES[checkpoint.rowIndex + 2])
    ) {
      reasons.push("runtime checkpoint measurement phase/owner differs");
    }
    if (
      new Set(["runtime-import", "viewer-contract", "runtime-ready"]).has(
        checkpoint.stage,
      ) &&
      (expectedOwner !== null ||
        checkpoint.phase !== null ||
        !countKeys.every((key) => counts?.[key] === null) ||
        !preSummarySpatial ||
        !initialTerrain)
    ) {
      reasons.push("runtime checkpoint pre-page state differs");
    }
    if (
      checkpoint.stage === "row-transition" &&
      (expectedOwner === null ||
        !countKeys.every((key) => counts?.[key] === null) ||
        !preSummarySpatial ||
        !initialTerrain)
    ) {
      reasons.push("runtime checkpoint row-transition state differs");
    }
    if (
      checkpoint.stage === "transition-readiness-complete" &&
      (expectedOwner === null ||
        !countKeys.every((key) => counts?.[key] === null) ||
        !preSummarySpatial ||
        initialTerrain)
    ) {
      reasons.push("runtime checkpoint readiness-complete state differs");
    }
    if (
      checkpoint.stage === "lattice-projection" &&
      (expectedOwner === null ||
        ![
          counts?.valid,
          counts?.nasa,
          counts?.terrain,
          counts?.classified,
        ].every((value) => value === 0) ||
        counts?.sourceBoundary !== null ||
        counts?.classifiedBoundary !== null ||
        !preSummarySpatial ||
        initialTerrain)
    ) {
      reasons.push("runtime checkpoint lattice-projection state differs");
    }
    if (
      new Set(["lattice-membership-complete", "spatial-summary"]).has(
        checkpoint.stage,
      ) &&
      (expectedOwner === null ||
        !membershipPresent ||
        boundariesPresent ||
        !preSummarySpatial ||
        initialTerrain)
    ) {
      reasons.push("runtime checkpoint pre-summary state differs");
    }
    const completedSpatialStage = new Set([
      "spatial-summary-complete",
      "motion-summary-complete",
    ]).has(checkpoint.stage);
    if (completedSpatialStage && (!membershipPresent || !boundariesPresent)) {
      reasons.push("runtime checkpoint completed spatial counts differ");
    }
    if (
      checkpoint.stage === "spatial-summary-complete" &&
      expectedOwner === null
    ) {
      reasons.push("runtime checkpoint completed spatial owner is absent");
    }
    if (
      checkpoint.stage === "motion-summary-complete" &&
      (expectedOwner !== null ||
        checkpoint.phase !== C12_29_S5_SVS_PHASES[6] ||
        checkpoint.terrain?.transitionRole !== C12_29_S5_SVS_CONTROL.role)
    ) {
      reasons.push("runtime checkpoint motion state differs");
    }
    if (checkpoint.stage === "phase-transition") {
      const phaseIndex = C12_29_S5_SVS_PHASES.indexOf(checkpoint.phase);
      const initialPhase = phaseIndex === 0 || phaseIndex === 1;
      const eventPhase = phaseIndex >= 2 && phaseIndex <= 5;
      const controlPhase = phaseIndex === 6;
      const cleanupPhase = phaseIndex === 7;
      const expectedEventIndex = eventPhase ? phaseIndex - 2 : null;
      if (
        phaseIndex < 0 ||
        (initialPhase &&
          (expectedOwner !== null ||
            !countKeys.every((key) => counts?.[key] === null) ||
            !preSummarySpatial ||
            !initialTerrain)) ||
        (eventPhase &&
          (checkpoint.rowIndex !== expectedEventIndex ||
            expectedOwner?.role !==
              C12_29_S5_SVS_ROWS[expectedEventIndex].role ||
            !membershipPresent ||
            !boundariesPresent ||
            initialTerrain)) ||
        (controlPhase &&
          (checkpoint.rowIndex !== C12_29_S5_SVS_ROWS.length ||
            expectedOwner?.role !== C12_29_S5_SVS_CONTROL.role ||
            !membershipPresent ||
            !boundariesPresent ||
            initialTerrain)) ||
        (cleanupPhase &&
          (expectedOwner !== null ||
            !membershipPresent ||
            !boundariesPresent ||
            checkpoint.terrain?.transitionRole !== C12_29_S5_SVS_CONTROL.role))
      ) {
        reasons.push("runtime checkpoint phase-transition state differs");
      }
    }
    if (boundariesPresent) {
      const sourceAvailable = counts.nasa > 0;
      const measuredAvailable = counts.classified > 0;
      const comparable =
        counts.sourceBoundary > 0 && counts.classifiedBoundary > 0;
      const unavailableReason = comparable
        ? null
        : counts.nasa === 0
          ? "source-empty"
          : counts.sourceBoundary === 0
            ? "source-boundary-empty"
            : counts.classified === 0
              ? "classified-empty"
              : "classified-boundary-empty";
      if (
        checkpoint.sourceCentroid?.available !== sourceAvailable ||
        checkpoint.measuredCentroid?.available !== measuredAvailable ||
        checkpoint.boundary?.comparable !== comparable ||
        checkpoint.boundary?.unavailableReason !== unavailableReason
      ) {
        reasons.push(
          "runtime checkpoint spatial null/availability semantics differ",
        );
      }
    }
    if (
      expectedOwner &&
      checkpoint.stage !== "row-transition" &&
      checkpoint.terrain?.transitionRole !== expectedOwner.role
    ) {
      reasons.push("runtime checkpoint terrain/role identity differs");
    }
    return reasons;
  } catch {
    reasons.push("runtime checkpoint could not be safely inspected");
    return reasons;
  }
}

function validateSvsRuntimeCleanupShape(cleanup) {
  try {
    if (
      !exactObjectKeys(cleanup, [
        "pageCloseAttempted",
        "pageClosed",
        "pageCloseTimedOut",
        "contextCloseAttempted",
        "contextClosed",
        "contextCloseTimedOut",
        "requestLedgerDrainAttempted",
        "requestLedgerDrained",
        "errorCount",
        "errors",
      ])
    ) {
      return false;
    }
    const booleanKeys = [
      "pageCloseAttempted",
      "pageClosed",
      "pageCloseTimedOut",
      "contextCloseAttempted",
      "contextClosed",
      "contextCloseTimedOut",
      "requestLedgerDrainAttempted",
      "requestLedgerDrained",
    ];
    return (
      booleanKeys.every((key) => typeof cleanup[key] === "boolean") &&
      cleanup.pageCloseAttempted === true &&
      cleanup.contextCloseAttempted === true &&
      cleanup.requestLedgerDrainAttempted === true &&
      !(cleanup.pageClosed && cleanup.pageCloseTimedOut) &&
      !(cleanup.contextClosed && cleanup.contextCloseTimedOut) &&
      validateSvsDiagnosticArrayCount(
        cleanup.errors,
        "cleanup.errors",
        cleanup.errorCount,
        C12_29_S5_SVS_DIAGNOSTIC_LIMITS.cleanupEntries,
        C12_29_S5_SVS_DIAGNOSTIC_LIMITS.cleanupErrorCount,
      )
    );
  } catch {
    return false;
  }
}

/** Validate the exact bounded diagnostics union accepted by a v3 ERROR. */
export function validateSvsErrorDiagnosticsShape(
  diagnostics,
  {
    requireCleanup = true,
    diagnosticsSchema = C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
  } = {},
) {
  const reasons = [];
  try {
    if (
      !exactObjectKeys(diagnostics, [
        "schema",
        "kind",
        "renderer",
        "stage",
        "runtimeCheckpoint",
        "checkpointReadError",
        "pageErrorCount",
        "pageErrors",
        "consoleErrorCount",
        "consoleErrors",
        "cleanup",
        "originalError",
      ])
    ) {
      reasons.push("ERROR diagnostics keys are not exact");
      return reasons;
    }
    if (diagnostics.kind === "operational-pre-page-error") {
      if (
        diagnostics.schema !== diagnosticsSchema ||
        diagnostics.renderer !== null ||
        !new Set(["probe-before-page", "browser-watchdog-error"]).has(
          diagnostics.stage,
        ) ||
        diagnostics.runtimeCheckpoint !== null ||
        diagnostics.checkpointReadError !== null ||
        !validateSvsDiagnosticArrayCount(
          diagnostics.pageErrors,
          "pageErrors",
          diagnostics.pageErrorCount,
        ) ||
        diagnostics.pageErrorCount !== 0 ||
        !validateSvsDiagnosticArrayCount(
          diagnostics.consoleErrors,
          "consoleErrors",
          diagnostics.consoleErrorCount,
        ) ||
        diagnostics.consoleErrorCount !== 0 ||
        diagnostics.cleanup !== null ||
        !boundedSvsString(
          diagnostics.originalError,
          C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
        )
      ) {
        reasons.push("operational ERROR diagnostics are invalid");
      }
      return reasons;
    }
    if (diagnostics.kind === "runtime-session-cleanup-error") {
      if (
        diagnostics.schema !== diagnosticsSchema ||
        !C12_29_S5_SVS_RENDERERS.includes(diagnostics.renderer) ||
        diagnostics.stage !== "session-cleanup-error" ||
        diagnostics.runtimeCheckpoint !== null ||
        diagnostics.checkpointReadError !== null ||
        !validateSvsDiagnosticArrayCount(
          diagnostics.pageErrors,
          "pageErrors",
          diagnostics.pageErrorCount,
        ) ||
        !validateSvsDiagnosticArrayCount(
          diagnostics.consoleErrors,
          "consoleErrors",
          diagnostics.consoleErrorCount,
        ) ||
        !validateSvsRuntimeCleanupShape(diagnostics.cleanup) ||
        diagnostics.cleanup.errorCount < 1 ||
        !boundedSvsString(
          diagnostics.originalError,
          C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
        )
      ) {
        reasons.push("session-cleanup ERROR diagnostics are invalid");
      }
      return reasons;
    }
    if (
      diagnostics.schema !== diagnosticsSchema ||
      diagnostics.kind !== "runtime-page-session-error" ||
      !C12_29_S5_SVS_RENDERERS.includes(diagnostics.renderer) ||
      diagnostics.stage !== "page-session-error" ||
      !boundedSvsString(
        diagnostics.originalError,
        C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
      ) ||
      !validateSvsDiagnosticArrayCount(
        diagnostics.pageErrors,
        "pageErrors",
        diagnostics.pageErrorCount,
      ) ||
      !validateSvsDiagnosticArrayCount(
        diagnostics.consoleErrors,
        "consoleErrors",
        diagnostics.consoleErrorCount,
      ) ||
      (diagnostics.checkpointReadError !== null &&
        !boundedSvsString(
          diagnostics.checkpointReadError,
          C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
        ))
    ) {
      reasons.push("ERROR diagnostics identity/text is invalid");
    }
    if (diagnostics.runtimeCheckpoint === null) {
      // A navigation/import failure can precede the first page checkpoint.
    } else {
      reasons.push(
        ...validateSvsRuntimeCheckpointShape(
          diagnostics.runtimeCheckpoint,
          diagnostics.renderer,
          diagnosticsSchema,
        ).map((reason) => `ERROR diagnostics ${reason}`),
      );
      if (diagnostics.checkpointReadError !== null) {
        reasons.push("ERROR diagnostics retained a checkpoint and read error");
      }
    }
    if (diagnostics.cleanup === null) {
      if (requireCleanup)
        reasons.push("ERROR diagnostics cleanup facts are absent");
    } else if (!validateSvsRuntimeCleanupShape(diagnostics.cleanup)) {
      reasons.push("ERROR diagnostics cleanup facts are invalid");
    }
    return reasons;
  } catch {
    reasons.push("ERROR diagnostics could not be safely inspected");
    return reasons;
  }
}

/**
 * Accept only the exact bounded v2 ERROR envelope needed to retain the
 * original browser failure. It is preserved byte-for-byte but is never
 * interpreted as v3 or v4 certification.
 */
export function validateSupersededSvsV2FinalArtifactShape(artifact) {
  const reasons = [];
  try {
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
      reasons.push("superseded v2 ERROR artifact keys are not exact");
      return reasons;
    }
    if (
      artifact?.schema !== C12_29_S5_SVS_LEGACY_ERROR_SCHEMA ||
      !isUuidV4(artifact?.runId) ||
      !isCanonicalUtcTimestamp(artifact?.generatedAt) ||
      artifact?.status !== "ERROR" ||
      artifact?.exitCode !== exitCodeForSvsStatus("ERROR") ||
      artifact?.incomplete !== false ||
      !boundedSvsString(artifact?.error, 65_536) ||
      artifact?.diagnostics !== null
    ) {
      reasons.push("superseded v2 ERROR artifact envelope is invalid");
    }
    return reasons;
  } catch {
    reasons.push("superseded v2 ERROR artifact could not be safely inspected");
    return reasons;
  }
}

const C12_29_S5_SVS_V4_SOURCE_ADDITIONS = new Set([
  "packages/engine/Source/Core/CelestialEphemerisProvider.js",
  "packages/engine/Source/Core/Simon1994EphemerisProvider.js",
  "packages/engine/Source/Renderer/UniformStateComputations.js",
  "packages/engine/Source/Scene/Moon.js",
  "packages/engine/Source/Widget/CesiumWidget.js",
]);

function createSupersededSvsLineage(frameNumber, clockIso) {
  const sunPositionWC = { x: 149_000_000_000, y: 1_000_000, z: -2_000_000 };
  const moonPositionWC = { x: 384_400_000, y: -3_000_000, z: 1_000_000 };
  return {
    frameNumber,
    clockIso,
    provider: {
      constructor: C12_29_S5_SVS_EPHEMERIS.providerConstructor,
      id: C12_29_S5_SVS_EPHEMERIS.providerId,
      revision: C12_29_S5_SVS_EPHEMERIS.providerRevision,
      provenance: structuredClone(C12_29_S5_SVS_EPHEMERIS.provenance),
      timePolicy: structuredClone(C12_29_S5_SVS_EPHEMERIS.timePolicy),
      provenanceFrozen: true,
      timePolicyFrozen: true,
    },
    sample: {
      providerId: C12_29_S5_SVS_EPHEMERIS.providerId,
      providerRevision: C12_29_S5_SVS_EPHEMERIS.providerRevision,
      provenance: structuredClone(C12_29_S5_SVS_EPHEMERIS.provenance),
      timePolicy: structuredClone(C12_29_S5_SVS_EPHEMERIS.timePolicy),
      referenceFrame: C12_29_S5_SVS_EPHEMERIS.referenceFrame,
      units: C12_29_S5_SVS_EPHEMERIS.units,
      transformBranch: C12_29_S5_SVS_EPHEMERIS.transformBranch,
      outputAllocationStable: true,
      thirdPartyTemporaryFree: true,
      sunPositionWC: structuredClone(sunPositionWC),
      moonPositionWC: structuredClone(moonPositionWC),
    },
    independent: {
      method: C12_29_S5_SVS_EPHEMERIS.independentMethod,
      sunPositionWC: structuredClone(sunPositionWC),
      moonPositionWC: structuredClone(moonPositionWC),
      sunDeltaMeters: 0,
      moonDeltaMeters: 0,
    },
    eclipseState: {
      sunPositionWC: structuredClone(sunPositionWC),
      moonPositionWC: structuredClone(moonPositionWC),
      sunDeltaMeters: 0,
      moonDeltaMeters: 0,
      sunStorageDistinct: true,
      moonStorageDistinct: true,
    },
    identities: {
      providerIsSceneProvider: true,
      sampleIsFrameStateSample: true,
      sampleProvenanceIsProviderProvenance: true,
      sampleTimePolicyIsProviderTimePolicy: true,
    },
  };
}

function replaceSupersededSvsSchemas(value) {
  if (Array.isArray(value)) {
    for (const entry of value) replaceSupersededSvsSchemas(entry);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (value[key] === C12_29_S5_SVS_SUPERSEDED_SCHEMA) {
      value[key] = C12_29_S5_SVS_SUPERSEDED_V4_SCHEMA;
    } else if (value[key] === C12_29_S5_SVS_SUPERSEDED_DIAGNOSTICS_SCHEMA) {
      value[key] = C12_29_S5_SVS_SUPERSEDED_V4_DIAGNOSTICS_SCHEMA;
    } else {
      replaceSupersededSvsSchemas(value[key]);
    }
  }
}

function validateIncomingSupersededSvsV3Schemas(artifact) {
  const reasons = [];
  const expect = (actual, expected, label) => {
    if (actual !== expected) reasons.push(`${label} is not exact v3`);
  };
  expect(artifact?.schema, C12_29_S5_SVS_SUPERSEDED_SCHEMA, "artifact schema");
  if (artifact?.status === "ERROR") {
    expect(
      artifact?.diagnostics?.schema,
      C12_29_S5_SVS_SUPERSEDED_DIAGNOSTICS_SCHEMA,
      "ERROR diagnostics schema",
    );
    if (artifact?.diagnostics?.runtimeCheckpoint !== null) {
      expect(
        artifact?.diagnostics?.runtimeCheckpoint?.schema,
        C12_29_S5_SVS_SUPERSEDED_DIAGNOSTICS_SCHEMA,
        "ERROR runtime checkpoint schema",
      );
    }
    return reasons;
  }
  expect(
    artifact?.report?.schema,
    C12_29_S5_SVS_SUPERSEDED_SCHEMA,
    "report schema",
  );
  expect(
    artifact?.report?.lifecycle?.runningReceipt?.schema,
    C12_29_S5_SVS_SUPERSEDED_SCHEMA,
    "running receipt schema",
  );
  expect(
    artifact?.report?.lifecycle?.finalReceipt?.schema,
    C12_29_S5_SVS_SUPERSEDED_SCHEMA,
    "final receipt schema",
  );
  const sessions = artifact?.report?.sessions;
  if (!Array.isArray(sessions)) {
    reasons.push("session diagnostics schemas are absent");
  } else {
    sessions.forEach((session, index) =>
      expect(
        session?.schema,
        C12_29_S5_SVS_SUPERSEDED_DIAGNOSTICS_SCHEMA,
        `session ${index} diagnostics schema`,
      ),
    );
  }
  return reasons;
}

function upgradeSupersededSvsV3Artifact(artifact) {
  const upgraded = structuredClone(artifact);
  replaceSupersededSvsSchemas(upgraded);
  if (upgraded.status === "ERROR") return upgraded;

  const v3BuildFiles = C12_29_S5_SVS_V4_BUILD_SOURCE_FILES.filter(
    (file) => !C12_29_S5_SVS_V4_SOURCE_ADDITIONS.has(file),
  );
  const identity = upgraded?.report?.provenance?.buildSourceIdentity;
  if (
    !Array.isArray(identity?.entries) ||
    identity.entries.length !== v3BuildFiles.length
  ) {
    return null;
  }
  const entryByRelative = new Map();
  for (const entry of identity.entries) {
    const relative = v3BuildFiles.find(
      (file) => entry?.file === file || entry?.file?.endsWith(`/${file}`),
    );
    if (relative === undefined || entryByRelative.has(relative)) return null;
    entryByRelative.set(relative, entry);
  }
  if (v3BuildFiles.some((file) => !entryByRelative.has(file))) return null;
  const template = entryByRelative.get(v3BuildFiles[0]);
  const prefix = template.file.slice(0, -v3BuildFiles[0].length);
  identity.entries = C12_29_S5_SVS_V4_BUILD_SOURCE_FILES.map((file) =>
    entryByRelative.has(file)
      ? entryByRelative.get(file)
      : {
          ...structuredClone(template),
          file: `${prefix}${file}`,
          sourceMapEntry: `../../${file}`,
        },
  );

  for (const session of upgraded.report.sessions ?? []) {
    for (const row of session.rows ?? []) {
      if (row.ephemeris !== undefined) return null;
      row.ephemeris = createSupersededSvsLineage(
        row?.terrainTuple?.captureFrameNumber,
        row?.iso,
      );
    }
    if (session?.ephemeris?.rowLineages !== undefined) return null;
    session.ephemeris.rowLineages = (session.rows ?? []).map((row) => ({
      role: row.role,
      iso: row.iso,
      captureFrameNumber: row.terrainTuple.captureFrameNumber,
      lineage: structuredClone(row.ephemeris),
    }));
  }
  return upgraded;
}

/**
 * Validate a complete v3 final by upgrading only the five newly frozen source
 * entries and the newly required per-row default-Simon lineage. This does not
 * make the predecessor a v4 certification; it only proves that the retained
 * bytes were a complete v3 final before they are superseded.
 */
export function validateSupersededSvsV3FinalArtifactShape(artifact) {
  const reasons = [];
  try {
    const incomingSchemaReasons =
      validateIncomingSupersededSvsV3Schemas(artifact);
    if (incomingSchemaReasons.length > 0) {
      reasons.push(
        ...incomingSchemaReasons.map((reason) => `superseded v3 ${reason}`),
      );
      return reasons;
    }
    const upgraded = upgradeSupersededSvsV3Artifact(artifact);
    if (upgraded === null) {
      reasons.push("superseded v3 boundary or lineage shape differs");
      return reasons;
    }
    reasons.push(
      ...validateSvsFinalArtifactShape(upgraded, SVS_V4_SCHEMA_CONTRACT).map(
        (reason) => `superseded v3 ${reason}`,
      ),
    );
    return reasons;
  } catch {
    reasons.push("superseded v3 artifact could not be safely inspected");
    return reasons;
  }
}

/**
 * Validate retained v4 bytes against their frozen historical contract. The
 * validator does not synthesize v5 screenshot-state or pipeline evidence and
 * never re-emits the predecessor bytes.
 */
export function validateSupersededSvsV4FinalArtifactShape(artifact) {
  const reasons = [];
  try {
    if (artifact?.schema !== C12_29_S5_SVS_SUPERSEDED_V4_SCHEMA) {
      reasons.push("superseded v4 artifact schema differs");
      return reasons;
    }
    reasons.push(
      ...validateSvsFinalArtifactShape(artifact, SVS_V4_SCHEMA_CONTRACT).map(
        (reason) => `superseded v4 ${reason}`,
      ),
    );
    if (artifact?.status !== "ERROR") {
      for (const session of artifact?.report?.sessions ?? []) {
        if (Object.hasOwn(session?.errors ?? {}, "gpuCompletion")) {
          reasons.push(
            "superseded v4 contains v5-only GPU completion evidence",
          );
        }
        const owners = [...(session?.rows ?? []), session?.control];
        const tuples = [
          ...(session?.terrain?.providerReadiness?.observations ?? []).map(
            (observation) => observation?.tuple,
          ),
        ];
        for (const owner of owners) {
          if (
            Object.hasOwn(owner ?? {}, "variantReadiness") ||
            Object.hasOwn(owner?.cameraFrame ?? {}, "basisProof") ||
            Object.hasOwn(
              owner?.lattice ?? {},
              "projectedPixelIdByValidCell",
            ) ||
            Object.hasOwn(owner ?? {}, "imageDerivedPrimitives") ||
            (owner === session?.control &&
              Object.hasOwn(owner ?? {}, "ephemeris"))
          ) {
            reasons.push("superseded v4 contains v5-only owner evidence");
          }
          tuples.push(
            owner?.terrainTuple,
            ...(owner?.transitionReadiness?.observations ?? []).map(
              (observation) => observation?.tuple,
            ),
            ...(owner?.captureTerrainProofs ?? []).map((proof) => {
              if (
                Object.hasOwn(proof ?? {}, "requested") ||
                Object.hasOwn(proof ?? {}, "observed") ||
                Object.hasOwn(proof ?? {}, "backendDrawWitness")
              ) {
                reasons.push(
                  "superseded v4 contains v5-only capture proof evidence",
                );
              }
              return proof?.tuple;
            }),
          );
        }
        if (
          tuples.some(
            (tuple) =>
              Object.hasOwn(tuple ?? {}, "drawWitness") ||
              Object.hasOwn(tuple ?? {}, "captureStateObservation"),
          ) ||
          (session?.ephemeris?.xysFiles ?? []).some(
            (entry) =>
              Object.hasOwn(entry?.localStart ?? {}, "file") ||
              Object.hasOwn(entry?.localEnd ?? {}, "file"),
          )
        ) {
          reasons.push("superseded v4 contains v5-only runtime evidence");
        }
      }
    }
    return reasons;
  } catch {
    reasons.push("superseded v4 artifact could not be safely inspected");
    return reasons;
  }
}

export function validateSvsFinalArtifactShape(
  artifact,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
  const reasons = [];
  try {
    if (!exactEnumerableDataObject(artifact)) {
      reasons.push("artifact is not an exact enumerable-data object");
      return reasons;
    }
    if (artifact?.schema !== schemaContract.schema) {
      reasons.push("artifact schema is not the frozen SVS schema");
    }
    if (!isUuidV4(artifact?.runId))
      reasons.push("artifact runId is not UUIDv4");
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
      if (
        !boundedSvsString(
          artifact?.error,
          C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
        )
      ) {
        reasons.push("ERROR artifact has no error diagnostic");
      }
      if (artifact?.diagnostics === null) {
        reasons.push("ERROR artifact diagnostics are absent");
      } else {
        reasons.push(
          ...validateSvsErrorDiagnosticsShape(artifact.diagnostics, {
            diagnosticsSchema: schemaContract.diagnosticsSchema,
          }).map((reason) => `ERROR artifact ${reason}`),
        );
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
        folded = foldSvsReport(artifact?.report, schemaContract);
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
  } catch {
    reasons.push("artifact could not be safely inspected");
    return reasons;
  }
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

function validateProvenance(
  provenance,
  reasons,
  buildSourceFiles = C12_29_S5_SVS_BUILD_SOURCE_FILES,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
  if (
    schemaContract.requiresV5Evidence === true &&
    (provenance?.ok !== true ||
      !Array.isArray(provenance?.reasons) ||
      provenance.reasons.length !== 0)
  ) {
    reasons.push("provenance assessment is not an exact green result");
  }
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
    buildEntries.length !== buildSourceFiles.length ||
    buildEntries.some((entry, index) => {
      const relative = buildSourceFiles[index];
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

function derivedSvsFixedCameraHeightMeters() {
  const expected = C12_29_S5_SVS_SCENE;
  const usablePixels =
    expected.viewport.width - 2 * expected.minimumMarginPixels;
  return Math.max(
    ...C12_29_S5_SVS_ROWS.map((row) => {
      const [fixtureWest, fixtureSouth, fixtureEast, fixtureNorth] =
        row.fixtureGeometry.bbox;
      const northSouthMeters =
        (fixtureNorth - fixtureSouth + 2 * expected.cameraGuardDegrees) *
        111_320;
      const eastWestMeters =
        (fixtureEast - fixtureWest + 2 * expected.cameraGuardDegrees) *
        111_320 *
        Math.cos((row.sourceCenter[1] * Math.PI) / 180);
      return (
        (Math.max(northSouthMeters, eastWestMeters) *
          expected.viewport.height) /
        (2 * usablePixels * Math.tan(expected.verticalFovRadians * 0.5))
      );
    }),
  );
}

function validateSceneContract(
  scene,
  renderer,
  reasons,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
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
  if (
    schemaContract.requiresV5Evidence === true &&
    (expected.cameraHeightMeters !== derivedSvsFixedCameraHeightMeters() ||
      expected.pixelGroundFootprintKm !==
        (2 *
          expected.cameraHeightMeters *
          Math.tan(expected.verticalFovRadians * 0.5)) /
          expected.viewport.height /
          1000 ||
      scene?.cameraHeightMeters !== expected.cameraHeightMeters ||
      scene?.verticalFovRadians !== expected.verticalFovRadians)
  ) {
    reasons.push(`${renderer}: exact production camera derivation differs`);
  }
}

function svsVec3(value) {
  return (
    exactObjectKeys(value, ["x", "y", "z"]) &&
    finite(value.x) &&
    finite(value.y) &&
    finite(value.z)
  );
}

function svsDistance3(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function svsExactVec3(left, right) {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

/**
 * Validate the complete same-frame default-Simon provider -> sample ->
 * EclipseState lineage captured by the fused on-shot.
 */
export function validateSvsEphemerisLineage(
  lineage,
  expectedFrameNumber,
  expectedIso,
) {
  const provider = lineage?.provider;
  const sample = lineage?.sample;
  const independent = lineage?.independent;
  const eclipse = lineage?.eclipseState;
  const identities = lineage?.identities;
  if (
    !exactObjectKeys(lineage, [
      "frameNumber",
      "clockIso",
      "provider",
      "sample",
      "independent",
      "eclipseState",
      "identities",
    ]) ||
    lineage.frameNumber !== expectedFrameNumber ||
    lineage.clockIso !== expectedIso ||
    !exactObjectKeys(provider, [
      "constructor",
      "id",
      "revision",
      "provenance",
      "timePolicy",
      "provenanceFrozen",
      "timePolicyFrozen",
    ]) ||
    provider.constructor !== C12_29_S5_SVS_EPHEMERIS.providerConstructor ||
    provider.id !== C12_29_S5_SVS_EPHEMERIS.providerId ||
    provider.revision !== C12_29_S5_SVS_EPHEMERIS.providerRevision ||
    !sameJson(provider.provenance, C12_29_S5_SVS_EPHEMERIS.provenance) ||
    !sameJson(provider.timePolicy, C12_29_S5_SVS_EPHEMERIS.timePolicy) ||
    provider.provenanceFrozen !== true ||
    provider.timePolicyFrozen !== true ||
    !exactObjectKeys(sample, [
      "providerId",
      "providerRevision",
      "provenance",
      "timePolicy",
      "referenceFrame",
      "units",
      "transformBranch",
      "outputAllocationStable",
      "thirdPartyTemporaryFree",
      "sunPositionWC",
      "moonPositionWC",
    ]) ||
    sample.providerId !== C12_29_S5_SVS_EPHEMERIS.providerId ||
    sample.providerRevision !== C12_29_S5_SVS_EPHEMERIS.providerRevision ||
    !sameJson(sample.provenance, C12_29_S5_SVS_EPHEMERIS.provenance) ||
    !sameJson(sample.timePolicy, C12_29_S5_SVS_EPHEMERIS.timePolicy) ||
    sample.referenceFrame !== C12_29_S5_SVS_EPHEMERIS.referenceFrame ||
    sample.units !== C12_29_S5_SVS_EPHEMERIS.units ||
    sample.transformBranch !== C12_29_S5_SVS_EPHEMERIS.transformBranch ||
    sample.outputAllocationStable !== true ||
    sample.thirdPartyTemporaryFree !== true ||
    !svsVec3(sample.sunPositionWC) ||
    !svsVec3(sample.moonPositionWC) ||
    !exactObjectKeys(independent, [
      "method",
      "sunPositionWC",
      "moonPositionWC",
      "sunDeltaMeters",
      "moonDeltaMeters",
    ]) ||
    independent.method !== C12_29_S5_SVS_EPHEMERIS.independentMethod ||
    !svsVec3(independent.sunPositionWC) ||
    !svsVec3(independent.moonPositionWC) ||
    !exactObjectKeys(eclipse, [
      "sunPositionWC",
      "moonPositionWC",
      "sunDeltaMeters",
      "moonDeltaMeters",
      "sunStorageDistinct",
      "moonStorageDistinct",
    ]) ||
    !svsVec3(eclipse.sunPositionWC) ||
    !svsVec3(eclipse.moonPositionWC) ||
    eclipse.sunStorageDistinct !== true ||
    eclipse.moonStorageDistinct !== true ||
    !exactObjectKeys(identities, [
      "providerIsSceneProvider",
      "sampleIsFrameStateSample",
      "sampleProvenanceIsProviderProvenance",
      "sampleTimePolicyIsProviderTimePolicy",
    ]) ||
    Object.values(identities).some((value) => value !== true)
  ) {
    return false;
  }
  const sunDelta = svsDistance3(
    independent.sunPositionWC,
    sample.sunPositionWC,
  );
  const moonDelta = svsDistance3(
    independent.moonPositionWC,
    sample.moonPositionWC,
  );
  const eclipseSunDelta = svsDistance3(
    eclipse.sunPositionWC,
    sample.sunPositionWC,
  );
  const eclipseMoonDelta = svsDistance3(
    eclipse.moonPositionWC,
    sample.moonPositionWC,
  );
  return (
    finite(independent.sunDeltaMeters) &&
    finite(independent.moonDeltaMeters) &&
    independent.sunDeltaMeters === sunDelta &&
    independent.moonDeltaMeters === moonDelta &&
    sunDelta <= C12_29_S5_SVS_EPHEMERIS.maximumIndependentDeltaMeters &&
    moonDelta <= C12_29_S5_SVS_EPHEMERIS.maximumIndependentDeltaMeters &&
    svsExactVec3(eclipse.sunPositionWC, sample.sunPositionWC) &&
    svsExactVec3(eclipse.moonPositionWC, sample.moonPositionWC) &&
    eclipse.sunDeltaMeters === eclipseSunDelta &&
    eclipse.moonDeltaMeters === eclipseMoonDelta &&
    eclipseSunDelta === 0 &&
    eclipseMoonDelta === 0
  );
}

function validateIcrf(
  ephemeris,
  renderer,
  reasons,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
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
  const xysFingerprintsByRoute = new Map();
  let repeatedRoutesAreExact = true;
  if (Array.isArray(xys)) {
    for (const entry of xys) {
      const fingerprint = canonicalJsonIdentity({
        status: entry?.status,
        byteLength: entry?.byteLength,
        sha256: entry?.sha256,
        localStart: entry?.localStart,
        localEnd: entry?.localEnd,
      });
      const prior = xysFingerprintsByRoute.get(entry?.route);
      if (prior !== undefined && prior !== fingerprint) {
        repeatedRoutesAreExact = false;
      } else if (prior === undefined) {
        xysFingerprintsByRoute.set(entry?.route, fingerprint);
      }
    }
  }
  if (
    !Array.isArray(xys) ||
    xys.length === 0 ||
    (schemaContract.requiresV5Evidence !== true &&
      new Set(xysRoutes).size !== xysRoutes.length) ||
    JSON.stringify(xysRoutes) !== JSON.stringify([...xysRoutes].sort()) ||
    (schemaContract.requiresV5Evidence === true &&
      repeatedRoutesAreExact !== true) ||
    xys.some((entry) => {
      const localIsExact = (local) =>
        local?.exists === true &&
        local.byteLength === entry?.byteLength &&
        local.sha256 === entry?.sha256;
      const v5KeysAreExact =
        schemaContract.requiresV5Evidence !== true ||
        (exactObjectKeys(entry, [
          "route",
          "status",
          "byteLength",
          "sha256",
          "localStart",
          "localEnd",
        ]) &&
          exactObjectKeys(entry?.localStart, [
            "file",
            "exists",
            "byteLength",
            "sha256",
          ]) &&
          exactObjectKeys(entry?.localEnd, [
            "file",
            "exists",
            "byteLength",
            "sha256",
          ]) &&
          String(entry.localStart.file)
            .replaceAll("\\", "/")
            .endsWith(entry.route) &&
          entry.localStart.file === entry.localEnd.file);
      return (
        !/^\/Build\/CesiumUnminified\/Assets\/IAU2006_XYS\/IAU2006_XYS_\d+\.json$/u.test(
          entry?.route ?? "",
        ) ||
        entry?.status !== 200 ||
        !(entry?.byteLength > 0) ||
        !SHA256.test(entry?.sha256 ?? "") ||
        !localIsExact(entry?.localStart) ||
        !localIsExact(entry?.localEnd) ||
        !v5KeysAreExact
      );
    })
  ) {
    reasons.push(
      `${renderer}: IAU2006 XYS response fingerprints are absent, malformed, or inconsistent`,
    );
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
    !sameJson(
      fixture?.manifestRecordIdentities,
      C12_29_S5_SVS_ROWS.map((row) => ({
        sourceIndexZeroBased: row.sourceIndexZeroBased,
        sourceRecordNumber: row.sourceRecordNumber,
        outputRecordNumber: row.outputRecordNumber,
      })),
    ) ||
    !sameJson(
      fixture?.recordIdentities,
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

function validateImage(
  image,
  expectedLabel,
  runId,
  renderer,
  reasons,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
  const expectedFile = `${C12_29_S5_SVS_ARTIFACT_PREFIX}.${runId}.${image?.imageId}.${renderer}.${expectedLabel}.png`;
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
    (schemaContract.requiresV5Evidence === true
      ? image.file !== expectedFile
      : !image.file.includes(runId))
  ) {
    reasons.push(`${renderer}/${expectedLabel}: capture identity is invalid`);
  }
}

function validateMetricImageBindings(
  owner,
  images,
  renderer,
  label,
  reasons,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
  for (const channel of schemaContract.metricChannels) {
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

export const C12_29_S5_SVS_IMAGE_VERIFIER_METHOD =
  "node-sharp-immutable-png-rgba+independent-wgs84-row-major-projection+raw-code-classifier-v1";

function validateSvsImageDerivedPrimitives(
  owner,
  expectedRow,
  images,
  renderer,
  label,
  measurementKind,
  reasons,
) {
  const proof = owner?.imageDerivedPrimitives;
  const projection = proof?.projection;
  const raw = proof?.rawClassifier;
  const channels = ["white", "black", "off", "on"];
  const expectedProjection = deriveSvsWgs84ProjectedLattice(expectedRow);
  const expectedRaw = {
    terrainCellIds: owner?.lattice?.terrainCellIds,
    classifiedCellIds: owner?.lattice?.classifiedCellIds,
    offBrightTerrainCellIds: owner?.mask?.offBrightTerrainCellIds,
    oneCodeBoundaryCellIds: owner?.mask?.oneCodeBoundaryCellIds,
    terrainPixelCount: owner?.mask?.terrainPixelCount,
    classifiedCellCount: owner?.mask?.classifiedCellCount,
    strictlyClassifiedCellCount: owner?.mask?.strictlyClassifiedCellCount,
    offBrightTerrainPixelCount: owner?.mask?.offBrightTerrainPixelCount,
    oneCodeBoundaryCount: owner?.mask?.oneCodeBoundaryCount,
    allClassifiedMeetOffMinimum: owner?.mask?.allClassifiedMeetOffMinimum,
    allClassifiedMeetOnOffRatio: owner?.mask?.allClassifiedMeetOnOffRatio,
    classificationAppliedOnlyInsideTerrainMask:
      owner?.mask?.classificationAppliedOnlyInsideTerrainMask,
  };
  const expectedProofWithoutDigest = {
    method: C12_29_S5_SVS_IMAGE_VERIFIER_METHOD,
    measurementKind,
    sources: proof?.sources,
    projection: expectedProjection,
    rawClassifier: expectedRaw,
  };
  const expectedDigest = createHash("sha256")
    .update(canonicalJsonIdentity(expectedProofWithoutDigest))
    .digest("hex");
  const sourcesAreExact =
    exactObjectKeys(proof?.sources, channels) &&
    channels.every((channel) => {
      const source = proof.sources[channel];
      const binding = owner?.metricImageBindings?.[channel];
      const expectedLabel = `${label}-${channel}`;
      const image = images.find(
        (candidate) =>
          candidate?.imageId === binding?.imageId &&
          candidate?.label === expectedLabel,
      );
      return (
        exactObjectKeys(source, [
          "imageId",
          "sha256",
          "byteLength",
          "width",
          "height",
        ]) &&
        source.imageId === image?.imageId &&
        source.sha256 === image?.sha256 &&
        source.byteLength === image?.byteLength &&
        source.width === image?.width &&
        source.height === image?.height
      );
    });
  if (
    !exactObjectKeys(proof, [
      "method",
      "measurementKind",
      "sources",
      "projection",
      "rawClassifier",
      "verificationSha256",
    ]) ||
    proof.method !== C12_29_S5_SVS_IMAGE_VERIFIER_METHOD ||
    proof.measurementKind !== measurementKind ||
    !sourcesAreExact ||
    !exactObjectKeys(projection, [
      "validProjectedCellIds",
      "projectedPixelIdByValidCell",
      "cellLonLat",
      "duplicateProjectedCellCount",
    ]) ||
    !sameJson(projection, expectedProjection) ||
    !exactObjectKeys(raw, Object.keys(expectedRaw)) ||
    !sameJson(raw, expectedRaw) ||
    proof.verificationSha256 !== expectedDigest
  ) {
    reasons.push(
      `${renderer}/${label}: decoded immutable PNG verifier primitives differ`,
    );
  }
}

function validateLattice(
  row,
  expected,
  renderer,
  reasons,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
  const lattice = row?.lattice;
  const cells = C12_29_S5_SVS_SCENE.latticeSide ** 2;
  const geometry = validateFixtureGeometry(row, expected, renderer, reasons);
  let independentlyProjected;
  if (schemaContract.requiresV5Evidence) {
    try {
      independentlyProjected = deriveSvsWgs84ProjectedLattice(expected);
    } catch {
      reasons.push(
        `${renderer}/${row?.role}: independent WGS84 projection failed`,
      );
    }
  }
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
  const projectedPixels = lattice?.projectedPixelIdByValidCell;
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
    schemaContract.requiresV5Evidence &&
    (!exactArrayData(projectedPixels, valid.length) ||
      projectedPixels.length !== valid.length ||
      projectedPixels.some(
        (id) =>
          !Number.isInteger(id) ||
          id < 0 ||
          id >=
            C12_29_S5_SVS_SCENE.viewport.width *
              C12_29_S5_SVS_SCENE.viewport.height,
      ) ||
      new Set(projectedPixels).size !== projectedPixels.length)
  ) {
    reasons.push(
      `${renderer}/${row?.role}: projected pixel binding is not exact`,
    );
  }
  if (
    schemaContract.requiresV5Evidence &&
    independentlyProjected &&
    (!sameJson(valid, independentlyProjected.validProjectedCellIds) ||
      !sameJson(
        projectedPixels,
        independentlyProjected.projectedPixelIdByValidCell,
      ) ||
      !sameJson(lattice?.cellLonLat, independentlyProjected.cellLonLat) ||
      lattice?.duplicateProjectedCellCount !==
        independentlyProjected.duplicateProjectedCellCount)
  ) {
    reasons.push(
      `${renderer}/${row?.role}: projected lattice is not independently derived from WGS84/camera state`,
    );
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
    ) ||
    (schemaContract.requiresV5Evidence &&
      (row?.cameraFrame?.heightMeters !==
        C12_29_S5_SVS_SCENE.cameraHeightMeters ||
        row?.cameraFrame?.verticalFovRadians !==
          C12_29_S5_SVS_SCENE.verticalFovRadians ||
        lattice?.pixelGroundFootprintKm !==
          C12_29_S5_SVS_SCENE.pixelGroundFootprintKm))
  ) {
    reasons.push(
      `${renderer}/${row?.role}: lattice/pixel quantizers are not derived`,
    );
  }
}

/**
 * Derives JSON-safe spatial summaries from primitive lattice membership.
 *
 * This function is intentionally self-contained. The browser probe evaluates
 * this exact function body in the page and supplies Cesium's strict WGS84
 * distance callback; Node policy supplies the independent Vincenty callback.
 * Empty measured classifications are explicit unavailable product results,
 * never non-finite coordinates passed to a geodesic constructor.
 */
export function summarizeSvsSpatialMetrics(primitives, distanceKm) {
  const isFiniteNumber = (value) =>
    Number.isFinite(value) && !Object.is(value, -0);
  const isDegreeLonLat = (value) =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(isFiniteNumber) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90;
  const fail = (detail) => {
    throw new TypeError(`SVS primitive spatial inputs are invalid: ${detail}`);
  };
  const cleanZero = (value) => (value === 0 ? 0 : value);
  const side = primitives?.side;
  const qKm = primitives?.qKm;
  const measurementKind = primitives?.measurementKind;
  const valid = primitives?.validProjectedCellIds;
  const nasa = primitives?.nasaInsideCellIds;
  const classified = primitives?.classifiedCellIds;
  const cellLonLat = primitives?.cellLonLat;
  if (
    !Number.isInteger(side) ||
    side < 2 ||
    !isFiniteNumber(qKm) ||
    qKm < 0 ||
    !new Set(["event", "control"]).has(measurementKind) ||
    typeof distanceKm !== "function" ||
    !Array.isArray(valid) ||
    !Array.isArray(nasa) ||
    !Array.isArray(classified) ||
    !Array.isArray(cellLonLat)
  ) {
    fail("shape");
  }
  const validSet = new Set(valid);
  const exactIds = (ids) =>
    ids.every(
      (id, index) =>
        Number.isInteger(id) &&
        id >= 0 &&
        id < side ** 2 &&
        (index === 0 || id > ids[index - 1]) &&
        validSet.has(id),
    );
  if (
    validSet.size !== valid.length ||
    !exactIds(valid) ||
    !exactIds(nasa) ||
    !exactIds(classified) ||
    cellLonLat.length !== valid.length
  ) {
    fail("membership");
  }
  const points = new Map();
  for (let index = 0; index < cellLonLat.length; index++) {
    const entry = cellLonLat[index];
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      entry[0] !== valid[index] ||
      !isDegreeLonLat([entry[1], entry[2]]) ||
      points.has(entry[0])
    ) {
      fail(`cellLonLat[${index}]`);
    }
    points.set(entry[0], [entry[1], entry[2]]);
  }
  const checkedDistanceKm = (left, right, stage) => {
    if (!isDegreeLonLat(left) || !isDegreeLonLat(right)) {
      fail(`${stage} coordinate`);
    }
    const result = distanceKm(left, right, stage);
    if (!isFiniteNumber(result) || result < 0) {
      fail(`${stage} distance`);
    }
    return result;
  };
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
  const distanceTo = (id, boundary, stage) => {
    if (boundary.length === 0) return null;
    const point = points.get(id);
    if (!point) fail(`${stage} source`);
    let minimum = null;
    for (const otherId of boundary) {
      const other = points.get(otherId);
      if (!other) fail(`${stage} boundary`);
      const distance = checkedDistanceKm(point, other, stage);
      minimum = minimum === null ? distance : Math.min(minimum, distance);
    }
    return minimum;
  };
  const nasaDistance = new Map(
    valid.map((id) => [
      id,
      distanceTo(id, nasaBoundary, "source-boundary-distance"),
    ]),
  );
  const boundaryComparable =
    nasaBoundary.length > 0 && classifiedBoundary.length > 0;
  const boundaryDistances = boundaryComparable
    ? [
        ...classifiedBoundary.map((id) =>
          distanceTo(id, nasaBoundary, "classified-to-source-boundary"),
        ),
        ...nasaBoundary.map((id) =>
          distanceTo(id, classifiedBoundary, "source-to-classified-boundary"),
        ),
      ].sort((left, right) => left - right)
    : [];
  const withinQ = (distance) => distance !== null && distance <= qKm;
  const qBoundaryBandCellIds = valid.filter((id) =>
    withinQ(nasaDistance.get(id)),
  );
  const dilated = valid.filter(
    (id) => nasaSet.has(id) || withinQ(nasaDistance.get(id)),
  );
  const eroded = nasa.filter((id) => {
    const distance = nasaDistance.get(id);
    return distance !== null && distance > qKm;
  });
  const centroid = (ids) => {
    if (ids.length === 0) return null;
    const sum = ids.reduce(
      (value, id) => {
        const point = points.get(id);
        if (!point) fail("centroid membership");
        return [value[0] + point[0], value[1] + point[1]];
      },
      [0, 0],
    );
    const result = [
      cleanZero(sum[0] / ids.length),
      cleanZero(sum[1] / ids.length),
    ];
    if (!isDegreeLonLat(result)) fail("centroid coordinate");
    return result;
  };
  const sourceLonLat = centroid(nasa);
  const measuredLonLat = centroid(classified);
  const centroidComparable = sourceLonLat !== null && measuredLonLat !== null;
  const centroidDistanceKm = centroidComparable
    ? checkedDistanceKm(sourceLonLat, measuredLonLat, "centroid")
    : null;
  const intersection = classified.filter((id) => nasaSet.has(id)).length;
  const union = new Set([...classified, ...nasa]).size;
  const sourceRatio = (numerator) =>
    nasa.length > 0 ? cleanZero(numerator / nasa.length) : null;
  const boundaryUnavailableReason = boundaryComparable
    ? null
    : nasa.length === 0
      ? "source-empty"
      : nasaBoundary.length === 0
        ? "source-boundary-empty"
        : classified.length === 0
          ? "classified-empty"
          : "classified-boundary-empty";
  const centroidUnavailableReason = centroidComparable
    ? null
    : sourceLonLat === null
      ? "source-empty"
      : "classified-empty";
  return {
    measurementKind,
    qBoundaryBandCellIds,
    boundary: {
      comparable: boundaryComparable,
      unavailableReason: boundaryUnavailableReason,
      sourceBoundaryCellCount: nasaBoundary.length,
      classifiedBoundaryCellCount: classifiedBoundary.length,
      p95Km: boundaryComparable
        ? boundaryDistances[
            Math.min(
              boundaryDistances.length - 1,
              Math.floor(boundaryDistances.length * 0.95),
            )
          ]
        : null,
      maximumKm: boundaryComparable ? boundaryDistances.at(-1) : null,
      classifiedOutsideDilatedCount: classified.filter(
        (id) => !dilated.includes(id),
      ).length,
      erodedOutsideClassifiedCount: eroded.filter(
        (id) => !classifiedSet.has(id),
      ).length,
      erodedNasaCellCount: eroded.length,
      dilatedNasaCellCount: dilated.length,
      areaRatio: sourceRatio(classified.length),
      minimumAreaRatio: sourceRatio(eroded.length),
      maximumAreaRatio: sourceRatio(dilated.length),
      rawIou: union > 0 ? cleanZero(intersection / union) : 0,
    },
    centroid: {
      comparable: centroidComparable,
      unavailableReason: centroidUnavailableReason,
      measuredLonLat,
      sourceLonLat,
      errorKm: centroidDistanceKm,
      longitudeResidualDegrees: centroidComparable
        ? cleanZero(measuredLonLat[0] - sourceLonLat[0])
        : null,
      latitudeResidualDegrees: centroidComparable
        ? cleanZero(measuredLonLat[1] - sourceLonLat[1])
        : null,
    },
  };
}

export function deriveSvsSpatialMetrics(row) {
  const lattice = row?.lattice;
  const primitives = {
    side: lattice?.side,
    qKm: row?.budget?.qKm,
    measurementKind: row?.spatialMeasurementKind ?? "event",
    validProjectedCellIds: lattice?.validProjectedCellIds ?? [],
    nasaInsideCellIds: lattice?.nasaInsideCellIds ?? [],
    classifiedCellIds: lattice?.classifiedCellIds ?? [],
    cellLonLat: lattice?.cellLonLat ?? [],
  };
  const cacheKey = JSON.stringify(primitives);
  const cached = spatialMetricCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const result = summarizeSvsSpatialMetrics(
    primitives,
    wgs84GeodesicDistanceKm,
  );
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
    row?.spatialMeasurementKind !== "event" ||
    derived.measurementKind !== "event" ||
    !sameMembers(
      row?.lattice?.qBoundaryBandCellIds,
      derived.qBoundaryBandCellIds,
    ) ||
    !sameJson(boundary, derived.boundary)
  ) {
    structural.push(
      `${renderer}/${row?.role}: morphology summary is not derived`,
    );
  }
  if (boundary?.comparable !== true) {
    failures.push(
      `${renderer}/${row?.role}: boundary comparison is unavailable`,
    );
  } else if (
    !finite(boundary?.p95Km) ||
    !finite(boundary?.maximumKm) ||
    boundary.p95Km > expected.boundaryP95LimitKm ||
    boundary.maximumKm > expected.boundaryMaximumLimitKm ||
    boundary.classifiedOutsideDilatedCount !== 0 ||
    boundary.erodedOutsideClassifiedCount !== 0 ||
    row?.mask?.classifiedCellCount < boundary.erodedNasaCellCount ||
    row?.mask?.classifiedCellCount > boundary.dilatedNasaCellCount ||
    !close(
      boundary.areaRatio,
      row?.mask?.classifiedCellCount / row?.lattice?.nasaInsideCount,
      1e-12,
    ) ||
    !close(
      boundary.minimumAreaRatio,
      boundary.erodedNasaCellCount / row?.lattice?.nasaInsideCount,
      1e-12,
    ) ||
    !close(
      boundary.maximumAreaRatio,
      boundary.dilatedNasaCellCount / row?.lattice?.nasaInsideCount,
      1e-12,
    ) ||
    boundary.areaRatio < boundary.minimumAreaRatio ||
    boundary.areaRatio > boundary.maximumAreaRatio
  ) {
    failures.push(`${renderer}/${row?.role}: boundary/area morphology is red`);
  }
  // Raw IoU is diagnostic only, but must be honestly bounded and reported.
  if (!finite(boundary?.rawIou) || boundary.rawIou < 0 || boundary.rawIou > 1) {
    structural.push(`${renderer}/${row?.role}: raw IoU is malformed`);
  }
  const centroid = row?.centroid;
  if (!sameJson(centroid, derived.centroid)) {
    structural.push(
      `${renderer}/${row?.role}: centroid summary is not derived`,
    );
  }
  if (centroid?.comparable !== true) {
    failures.push(`${renderer}/${row?.role}: absolute centroid is unavailable`);
  } else if (
    !finite(centroid.errorKm) ||
    centroid.errorKm > expected.centroidLimitKm ||
    !finite(centroid.longitudeResidualDegrees) ||
    !finite(centroid.latitudeResidualDegrees)
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

function validateSvsDrawWitness(tuple, renderer, label, structural) {
  const witness = tuple?.drawWitness;
  const commonValid =
    exactObjectKeys(witness, [
      "renderer",
      "frameNumber",
      "commandCount",
      "ownerTileIds",
      "webgl",
      "webgpu",
    ]) &&
    witness.renderer === renderer &&
    witness.frameNumber === tuple?.captureFrameNumber &&
    Number.isInteger(witness.commandCount) &&
    witness.commandCount >= 1 &&
    witness.commandCount === tuple?.preparedCommandCount &&
    exactSortedUniqueTileIds(witness.ownerTileIds) &&
    sameMembers(witness.ownerTileIds, tuple?.preparedSelectedTileIds);
  const backendValid =
    renderer === "webgpu"
      ? witness?.webgl === null &&
        exactObjectKeys(witness?.webgpu, [
          "allCommandsAreWebGpu",
          "allPipelinesPresent",
          "allIndexCountsPositive",
          "allBindGroupCountsExact",
          "allDynamicOffsetCountsExact",
        ]) &&
        Object.values(witness.webgpu).every((value) => value === true)
      : witness?.webgpu === null &&
        exactObjectKeys(witness?.webgl, ["allCommandsAreWebGl"]) &&
        witness.webgl.allCommandsAreWebGl === true;
  if (!commonValid || !backendValid) {
    structural.push(`${renderer}/${label}: current-frame draw witness differs`);
  }
}

function validateSvsTupleStateObservation(tuple, renderer, label, structural) {
  const observed = tuple?.captureStateObservation;
  const state = observed?.eclipseState;
  const shadow = observed?.eclipseGlobeShadow;
  if (
    !exactObjectKeys(observed, [
      "frameNumber",
      "baseColor",
      "enableEclipse",
      "enableEclipseGlobeShadow",
      "eclipseAutoExposure",
      "enableEclipseHorizonTwilight",
      "atmosphericConditionsIdentity",
      "eclipseState",
      "eclipseSceneLightFactor",
      "eclipseGlobeShadowPrepared",
      "eclipseGlobeShadow",
      "mainViewShadowMatches",
    ]) ||
    observed.frameNumber !== tuple?.captureFrameNumber ||
    !Array.isArray(observed.baseColor) ||
    observed.baseColor.length !== 4 ||
    observed.baseColor.some((value) => !finite(value)) ||
    typeof observed.enableEclipse !== "boolean" ||
    typeof observed.enableEclipseGlobeShadow !== "boolean" ||
    observed.eclipseAutoExposure !== true ||
    observed.enableEclipseHorizonTwilight !== false ||
    observed.atmosphericConditionsIdentity !== true ||
    observed.eclipseGlobeShadowPrepared !== true ||
    observed.mainViewShadowMatches !== true ||
    !exactObjectKeys(state, [
      "enabled",
      "autoExposure",
      "horizonTwilightEnabled",
      "valid",
      "sunVisibleFraction",
      "earthOcclusionFraction",
      "moonObscuration",
      "sunAngularRadius",
      "earthAngularRadius",
      "moonAngularRadius",
      "earthSeparation",
      "moonSeparation",
      "eclipseMagnitude",
    ]) ||
    state.autoExposure !== true ||
    state.horizonTwilightEnabled !== false ||
    !exactObjectKeys(shadow, [
      "active",
      "revision",
      "sceneLightDimmed",
      "gate",
      "inverseSceneLightFactor",
    ]) ||
    typeof shadow.active !== "boolean" ||
    !Number.isInteger(shadow.revision) ||
    shadow.revision < 0 ||
    typeof shadow.sceneLightDimmed !== "boolean" ||
    !finite(shadow.gate) ||
    !finite(shadow.inverseSceneLightFactor) ||
    !finite(observed.eclipseSceneLightFactor)
  ) {
    structural.push(`${renderer}/${label}: observed lighting state differs`);
  }
}

function validateTerrainTuple(
  tuple,
  renderer,
  label,
  structural,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
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
  const expectedIdentity = canonicalJsonIdentity({
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
  if (schemaContract.requiresV5Evidence) {
    validateSvsDrawWitness(tuple, renderer, label, structural);
    validateSvsTupleStateObservation(tuple, renderer, label, structural);
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
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
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
      schemaContract,
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

function validateSvsCaptureStateProof(
  proof,
  captureLabel,
  measurementKind,
  renderer,
  label,
  structural,
) {
  const requested = C12_29_S5_SVS_CAPTURE_STATES[captureLabel];
  const observed = proof?.observed;
  const state = observed?.eclipseState;
  const shadow = observed?.eclipseGlobeShadow;
  const neutral = captureLabel !== "on";
  const eventOn = captureLabel === "on" && measurementKind === "event";
  const controlOn = captureLabel === "on" && measurementKind === "control";
  const physicsKeys = [
    "sunVisibleFraction",
    "earthOcclusionFraction",
    "moonObscuration",
    "sunAngularRadius",
    "earthAngularRadius",
    "moonAngularRadius",
    "earthSeparation",
    "moonSeparation",
    "eclipseMagnitude",
  ];
  const fractionsArePhysical = [
    state?.sunVisibleFraction,
    state?.earthOcclusionFraction,
    state?.moonObscuration,
  ].every((value) => finite(value) && value >= 0 && value <= 1);
  const radiiArePhysical = [
    state?.sunAngularRadius,
    state?.earthAngularRadius,
    state?.moonAngularRadius,
  ].every((value) => finite(value) && value > 0);
  const separationsArePhysical = [
    state?.earthSeparation,
    state?.moonSeparation,
  ].every((value) => finite(value) && value >= 0);
  const visibleFractionIsDerived = close(
    state?.sunVisibleFraction,
    (1 - state?.earthOcclusionFraction) * (1 - state?.moonObscuration),
    1e-12,
  );
  const noneclipsePhysicsIsExact =
    measurementKind !== "control" ||
    (state?.sunVisibleFraction === 1 &&
      state?.earthOcclusionFraction === 0 &&
      state?.moonObscuration === 0 &&
      state?.eclipseMagnitude === 0 &&
      state?.moonSeparation >=
        state?.sunAngularRadius + state?.moonAngularRadius);
  if (
    !sameJson(proof?.requested, requested) ||
    !sameJson(observed, proof?.tuple?.captureStateObservation) ||
    !sameJson(proof?.backendDrawWitness, proof?.tuple?.drawWitness) ||
    !sameJson(observed?.baseColor, requested?.baseColor) ||
    observed?.enableEclipse !== requested?.enableEclipse ||
    observed?.enableEclipseGlobeShadow !==
      requested?.enableEclipseGlobeShadow ||
    observed?.eclipseAutoExposure !== requested?.eclipseAutoExposure ||
    observed?.enableEclipseHorizonTwilight !==
      requested?.enableEclipseHorizonTwilight ||
    state?.enabled !== requested?.enableEclipse ||
    state?.autoExposure !== requested?.eclipseAutoExposure ||
    state?.horizonTwilightEnabled !== requested?.enableEclipseHorizonTwilight ||
    state?.valid !== true ||
    physicsKeys.some((key) => !finite(state?.[key])) ||
    !fractionsArePhysical ||
    !radiiArePhysical ||
    !separationsArePhysical ||
    !(state?.eclipseMagnitude >= 0) ||
    !visibleFractionIsDerived ||
    !noneclipsePhysicsIsExact ||
    (neutral &&
      (observed?.eclipseSceneLightFactor !== 1 ||
        shadow?.active !== false ||
        shadow?.sceneLightDimmed !== false ||
        shadow?.gate !== 0 ||
        shadow?.inverseSceneLightFactor !== 1)) ||
    (eventOn &&
      (!(observed?.eclipseSceneLightFactor > 0) ||
        !(observed.eclipseSceneLightFactor < 1) ||
        shadow?.active !== true ||
        shadow?.sceneLightDimmed !== true ||
        shadow?.gate !== 2 ||
        !close(
          shadow?.inverseSceneLightFactor,
          1 / observed.eclipseSceneLightFactor,
          1e-5,
        ))) ||
    (controlOn &&
      (observed?.eclipseSceneLightFactor !== 1 ||
        shadow?.active !== false ||
        shadow?.sceneLightDimmed !== false ||
        shadow?.gate !== 0 ||
        shadow?.inverseSceneLightFactor !== 1))
  ) {
    structural.push(`${renderer}/${label}: ${captureLabel} shot state differs`);
  }
}

function validateVariantReadiness(
  owner,
  renderer,
  label,
  expectedRole,
  expectedIso,
  measurementKind,
  structural,
  schemaContract,
) {
  if (!schemaContract.requiresV5Evidence) return;
  const variant = owner?.variantReadiness;
  const expectedLegs = [
    ["neutral", "off"],
    ["enabled", "on"],
    ["restored-neutral", "off"],
  ];
  const legs = variant?.legs;
  if (
    variant?.method !==
      "neutral-disabled+enabled-hot+restored-neutral-three-frame-main-globe-readiness" ||
    variant?.transitionRole !== expectedRole ||
    variant?.transitionIso !== expectedIso ||
    !Array.isArray(legs) ||
    legs.length !== expectedLegs.length
  ) {
    structural.push(`${renderer}/${label}: variant readiness differs`);
    return;
  }
  let priorFrame = -1;
  let finalReadiness;
  expectedLegs.forEach(([role, captureLabel], index) => {
    const leg = legs[index];
    const readinessTuple = validateTransitionReadiness(
      leg?.readiness,
      renderer,
      `${label}/${role}`,
      expectedRole,
      expectedIso,
      C12_29_S5_SVS_SCENE.transitionReadinessMaxFrames,
      structural,
      schemaContract,
    );
    if (
      leg?.role !== role ||
      leg?.captureLabel !== captureLabel ||
      !readinessTuple ||
      leg.readiness.lastFrameNumber <= priorFrame ||
      !sameJson(leg?.requested, C12_29_S5_SVS_CAPTURE_STATES[captureLabel]) ||
      !sameJson(leg?.observed, readinessTuple?.captureStateObservation) ||
      !sameJson(leg?.backendDrawWitness, readinessTuple?.drawWitness)
    ) {
      structural.push(`${renderer}/${label}: ${role} readiness leg differs`);
    }
    for (const observation of leg?.readiness?.observations ?? []) {
      validateSvsCaptureStateProof(
        {
          requested: C12_29_S5_SVS_CAPTURE_STATES[captureLabel],
          observed: observation?.tuple?.captureStateObservation,
          backendDrawWitness: observation?.tuple?.drawWitness,
          tuple: observation?.tuple,
        },
        captureLabel,
        measurementKind,
        renderer,
        `${label}/${role}/readiness-observation`,
        structural,
      );
    }
    validateSvsCaptureStateProof(
      {
        requested: leg?.requested,
        observed: leg?.observed,
        backendDrawWitness: leg?.backendDrawWitness,
        tuple: readinessTuple,
      },
      captureLabel,
      measurementKind,
      renderer,
      `${label}/${role}`,
      structural,
    );
    priorFrame = leg?.readiness?.lastFrameNumber ?? priorFrame;
    finalReadiness = leg?.readiness;
  });
  if (
    variant?.productCaptureStartsAfterFrame !== priorFrame ||
    !sameJson(owner?.transitionReadiness, finalReadiness)
  ) {
    structural.push(
      `${renderer}/${label}: product capture did not follow restored-neutral readiness`,
    );
  }
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
  measurementKind = "event",
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
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
      schemaContract,
    );
    if (schemaContract.requiresV5Evidence) {
      validateSvsCaptureStateProof(
        proof,
        proof?.label,
        measurementKind,
        renderer,
        label,
        structural,
      );
    }
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
  if (schemaContract.requiresV5Evidence) {
    const physics = proofs.map((proof) => {
      const state = proof?.observed?.eclipseState;
      return {
        valid: state?.valid,
        sunVisibleFraction: state?.sunVisibleFraction,
        earthOcclusionFraction: state?.earthOcclusionFraction,
        moonObscuration: state?.moonObscuration,
        sunAngularRadius: state?.sunAngularRadius,
        earthAngularRadius: state?.earthAngularRadius,
        moonAngularRadius: state?.moonAngularRadius,
        earthSeparation: state?.earthSeparation,
        moonSeparation: state?.moonSeparation,
        eclipseMagnitude: state?.eclipseMagnitude,
      };
    });
    if (physics.some((entry) => !sameJson(entry, physics[0]))) {
      structural.push(
        `${renderer}/${label}: shot toggles changed eclipse physics`,
      );
    }
  }
}

function validateSvsCameraBasis(cameraFrame, renderer, label, structural) {
  const proof = cameraFrame?.basisProof;
  const vector = (value) =>
    Array.isArray(value) && value.length === 3 && value.every(finite)
      ? value
      : undefined;
  const position = vector(proof?.positionWC);
  const center = vector(proof?.surfaceCenterWC);
  const direction = vector(proof?.directionWC);
  const up = vector(proof?.upWC);
  const right = vector(proof?.rightWC);
  if (!position || !center || !direction || !up || !right) {
    structural.push(`${renderer}/${label}: camera basis vectors are invalid`);
    return;
  }
  const dot = (left, rightValue) =>
    left[0] * rightValue[0] + left[1] * rightValue[1] + left[2] * rightValue[2];
  const magnitude = (value) => Math.hypot(...value);
  const cross = (left, rightValue) => [
    left[1] * rightValue[2] - left[2] * rightValue[1],
    left[2] * rightValue[0] - left[0] * rightValue[2],
    left[0] * rightValue[1] - left[1] * rightValue[0],
  ];
  const normalize = (value) => {
    const length = magnitude(value);
    return value.map((component) => component / length);
  };
  const lonLat = cameraFrame?.centerLonLat;
  const height = cameraFrame?.heightMeters;
  const longitude = Array.isArray(lonLat) ? (lonLat[0] * Math.PI) / 180 : NaN;
  const latitude = Array.isArray(lonLat) ? (lonLat[1] * Math.PI) / 180 : NaN;
  const semimajor = 6_378_137;
  const semiminor = 6_356_752.314245179;
  const eccentricitySquared =
    1 - (semiminor * semiminor) / (semimajor * semimajor);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const primeVertical =
    semimajor / Math.sqrt(1 - eccentricitySquared * sinLatitude * sinLatitude);
  const expectedCartesian = (altitude) => [
    (primeVertical + altitude) * cosLatitude * cosLongitude,
    (primeVertical + altitude) * cosLatitude * sinLongitude,
    (primeVertical * (1 - eccentricitySquared) + altitude) * sinLatitude,
  ];
  const expectedCenter = expectedCartesian(0);
  const expectedPosition = expectedCartesian(height);
  const expectedDirection = normalize(
    expectedCenter.map((value, index) => value - expectedPosition[index]),
  );
  const geodeticNormal = [
    cosLatitude * cosLongitude,
    cosLatitude * sinLongitude,
    sinLatitude,
  ];
  const expectedRight = normalize(cross([0, 0, 1], geodeticNormal));
  const expectedUp = normalize(cross(expectedRight, expectedDirection));
  const vectorClose = (left, rightValue, epsilon) =>
    left.every((value, index) => close(value, rightValue[index], epsilon));
  const targetRaw = center.map((value, index) => value - position[index]);
  const targetMagnitude = magnitude(targetRaw);
  const target = targetRaw.map((value) => value / targetMagnitude);
  const derived = {
    directionMagnitude: magnitude(direction),
    upMagnitude: magnitude(up),
    rightMagnitude: magnitude(right),
    directionUpDot: dot(direction, up),
    directionRightDot: dot(direction, right),
    upRightDot: dot(up, right),
    handedness: dot(direction, cross(up, right)),
    targetResidual: Math.abs(1 - dot(target, direction)),
  };
  if (
    !isDegreeLonLat(lonLat) ||
    !finite(height) ||
    !(height > 0) ||
    !(targetMagnitude > 0) ||
    !vectorClose(center, expectedCenter, 1e-5) ||
    !vectorClose(position, expectedPosition, 1e-5) ||
    !vectorClose(direction, expectedDirection, 1e-12) ||
    !vectorClose(up, expectedUp, 1e-12) ||
    !vectorClose(right, expectedRight, 1e-12) ||
    proof?.capturedAfterSceneRender !== true ||
    Object.entries(derived).some(
      ([key, value]) =>
        !finite(proof?.[key]) || !close(proof[key], value, 1e-12),
    ) ||
    Math.abs(derived.directionMagnitude - 1) > 1e-12 ||
    Math.abs(derived.upMagnitude - 1) > 1e-12 ||
    Math.abs(derived.rightMagnitude - 1) > 1e-12 ||
    Math.abs(derived.directionUpDot) > 1e-12 ||
    Math.abs(derived.directionRightDot) > 1e-12 ||
    Math.abs(derived.upRightDot) > 1e-12 ||
    Math.abs(derived.handedness - 1) > 1e-12 ||
    derived.targetResidual > 1e-9 ||
    !close(cameraFrame?.nadirAlignment, derived.targetResidual, 1e-12)
  ) {
    structural.push(`${renderer}/${label}: exact WC camera basis differs`);
  }
}

function expectedSvsCameraIdentity(cameraFrame) {
  const proof = cameraFrame?.basisProof;
  if (
    !Array.isArray(proof?.positionWC) ||
    !Array.isArray(proof?.directionWC) ||
    !Array.isArray(proof?.upWC) ||
    !Array.isArray(proof?.rightWC) ||
    !finite(cameraFrame?.verticalFovRadians)
  ) {
    return undefined;
  }
  return JSON.stringify({
    position: proof.positionWC,
    direction: proof.directionWC,
    up: proof.upWC,
    right: proof.rightWC,
    fov: cameraFrame.verticalFovRadians,
  });
}

function validateSvsOwnerCameraIdentity(owner, renderer, label, structural) {
  const expectedIdentity = expectedSvsCameraIdentity(owner?.cameraFrame);
  const readiness = [
    owner?.transitionReadiness,
    ...(owner?.variantReadiness?.legs ?? []).map((leg) => leg?.readiness),
  ];
  const tuples = [
    owner?.terrainTuple,
    ...(owner?.captureTerrainProofs ?? []).map((proof) => proof?.tuple),
    ...readiness.flatMap((entry) =>
      (entry?.observations ?? []).map((observation) => observation?.tuple),
    ),
  ];
  if (
    typeof expectedIdentity !== "string" ||
    readiness.some((entry) => entry?.cameraIdentity !== expectedIdentity) ||
    tuples.some(
      (tuple) =>
        tuple?.cameraIdentity !== expectedIdentity ||
        tuple?.expectedCameraIdentity !== expectedIdentity,
    )
  ) {
    structural.push(
      `${renderer}/${label}: camera identity is not derived from retained camera state`,
    );
  }
}

function validateSvsEventRawClassifier(row, renderer, label, structural) {
  const lattice = row?.lattice;
  const mask = row?.mask;
  const valid = lattice?.validProjectedCellIds ?? [];
  const terrain = lattice?.terrainCellIds ?? [];
  const classified = lattice?.classifiedCellIds ?? [];
  const offBright = mask?.offBrightTerrainCellIds;
  const oneCode = mask?.oneCodeBoundaryCellIds;
  const validSet = new Set(valid);
  const terrainSet = new Set(terrain);
  const offBrightSet = new Set(offBright ?? []);
  const classifiedSet = new Set(classified);
  if (
    !exactSortedUniqueIntegers(offBright) ||
    !exactSortedUniqueIntegers(oneCode) ||
    mask?.terrainPixelCount !== terrain.length ||
    mask?.classifiedCellCount !== classified.length ||
    mask?.strictlyClassifiedCellCount !== classified.length ||
    mask?.offBrightTerrainPixelCount !== offBright?.length ||
    mask?.oneCodeBoundaryCount !== oneCode?.length ||
    terrain.length < C12_29_S5_SVS_SCENE.minimumUniqueValidProjectedCells ||
    offBright.length < C12_29_S5_SVS_SCENE.minimumUniqueValidProjectedCells ||
    !isSubsetOf(terrain, validSet) ||
    !isSubsetOf(offBright, terrainSet) ||
    !isSubsetOf(classified, terrainSet) ||
    !isSubsetOf(classified, offBrightSet) ||
    !isSubsetOf(oneCode, terrainSet) ||
    oneCode.some((id) => classifiedSet.has(id)) ||
    mask?.allClassifiedMeetOffMinimum !== true ||
    mask?.allClassifiedMeetOnOffRatio !== true ||
    mask?.classificationAppliedOnlyInsideTerrainMask !== true
  ) {
    structural.push(`${renderer}/${label}: raw classifier primitives differ`);
  }
}

function validateRow(
  row,
  expected,
  renderer,
  failures,
  structural,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
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
  if (schemaContract.requiresV5Evidence) {
    validateSvsCameraBasis(
      row?.cameraFrame,
      renderer,
      expected.role,
      structural,
    );
    validateSvsOwnerCameraIdentity(row, renderer, expected.role, structural);
    validateSvsEventRawClassifier(row, renderer, expected.role, structural);
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
    !validateSvsEphemerisLineage(
      row?.ephemeris,
      row?.terrainTuple?.captureFrameNumber,
      expected.iso,
    )
  ) {
    structural.push(
      `${renderer}/${expected.role}: fused on-shot ephemeris lineage differs`,
    );
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
    !(row.cameraFrame.verticalFovRadians < Math.PI) ||
    (schemaContract.requiresV5Evidence &&
      (row.cameraFrame.heightMeters !==
        C12_29_S5_SVS_SCENE.cameraHeightMeters ||
        row.cameraFrame.verticalFovRadians !==
          C12_29_S5_SVS_SCENE.verticalFovRadians))
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
    row.mask.classifiedCellCount < 0 ||
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
  if (
    Number.isInteger(row?.mask?.classifiedCellCount) &&
    row.mask.classifiedCellCount < C12_29_S5_SVS_SCENE.minimumNasaInsideCells
  ) {
    failures.push(
      `${renderer}/${expected.role}: eclipse classification is empty or under-covered`,
    );
  }
  validateTerrainTuple(
    row?.terrainTuple,
    renderer,
    expected.role,
    structural,
    schemaContract,
  );
  validateVariantReadiness(
    row,
    renderer,
    expected.role,
    expected.role,
    expected.iso,
    "event",
    structural,
    schemaContract,
  );
  const readinessTuple = validateTransitionReadiness(
    row?.transitionReadiness,
    renderer,
    expected.role,
    expected.role,
    expected.iso,
    C12_29_S5_SVS_SCENE.transitionReadinessMaxFrames,
    structural,
    schemaContract,
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
    "event",
    schemaContract,
  );
  validateLattice(row, expected, renderer, structural, schemaContract);
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
  const comparable = isDegreeLonLat(beforePoint) && isDegreeLonLat(afterPoint);
  let derivedMeasurement = {
    comparable: false,
    unavailableReason: "measured-centroid-unavailable",
    measuredDirectionEast: null,
    measuredDirectionNorth: null,
    vectorErrorKm: null,
    measuredSpeedKmPerHour: null,
  };
  if (comparable) {
    const measuredDistanceKm = wgs84GeodesicDistanceKm(beforePoint, afterPoint);
    const radians = Math.PI / 180;
    const deltaLongitude = (afterPoint[0] - beforePoint[0]) * radians;
    const beforeLatitude = beforePoint[1] * radians;
    const afterLatitude = afterPoint[1] * radians;
    const measuredHeading = Math.atan2(
      Math.sin(deltaLongitude) * Math.cos(afterLatitude),
      Math.cos(beforeLatitude) * Math.sin(afterLatitude) -
        Math.sin(beforeLatitude) *
          Math.cos(afterLatitude) *
          Math.cos(deltaLongitude),
    );
    derivedMeasurement = {
      comparable: true,
      unavailableReason: null,
      measuredDirectionEast: Math.sin(measuredHeading) > 0,
      measuredDirectionNorth: Math.cos(measuredHeading) > 0,
      vectorErrorKm: Math.hypot(
        measuredDistanceKm * Math.sin(measuredHeading) -
          C12_29_S5_SVS_SOURCE_MOTION.eastKm,
        measuredDistanceKm * Math.cos(measuredHeading) -
          C12_29_S5_SVS_SOURCE_MOTION.northKm,
      ),
      measuredSpeedKmPerHour:
        (measuredDistanceKm / C12_29_S5_SVS_SOURCE_MOTION.seconds) * 3600,
    };
  }
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
    !sameJson(
      {
        comparable: motion?.comparable,
        unavailableReason: motion?.unavailableReason,
        measuredDirectionEast: motion?.measuredDirectionEast,
        measuredDirectionNorth: motion?.measuredDirectionNorth,
        vectorErrorKm: motion?.vectorErrorKm,
        measuredSpeedKmPerHour: motion?.measuredSpeedKmPerHour,
      },
      derivedMeasurement,
    )
  ) {
    structural.push(
      `${session?.renderer}: motion budget/source vector differs`,
    );
    return;
  }
  if (motion?.comparable !== true) {
    failures.push(
      `${session?.renderer}: 10-second source motion is unavailable`,
    );
  } else if (
    motion.measuredDirectionEast !== true ||
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

function validateControl(
  control,
  renderer,
  cameraSource,
  structural,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
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

  if (schemaContract.requiresV5Evidence) {
    validateSvsCameraBasis(
      control?.cameraFrame,
      renderer,
      C12_29_S5_SVS_CONTROL.role,
      structural,
    );
    validateSvsOwnerCameraIdentity(
      control,
      renderer,
      C12_29_S5_SVS_CONTROL.role,
      structural,
    );
    if (
      !validateSvsEphemerisLineage(
        control?.ephemeris,
        control?.terrainTuple?.captureFrameNumber,
        C12_29_S5_SVS_CONTROL.iso,
      )
    ) {
      structural.push(
        `${renderer}: noneclipse fused on-shot ephemeris lineage differs`,
      );
    }
  }

  validateTerrainTuple(
    control?.terrainTuple,
    renderer,
    C12_29_S5_SVS_CONTROL.role,
    structural,
    schemaContract,
  );
  validateVariantReadiness(
    control,
    renderer,
    C12_29_S5_SVS_CONTROL.role,
    C12_29_S5_SVS_CONTROL.role,
    C12_29_S5_SVS_CONTROL.iso,
    "control",
    structural,
    schemaContract,
  );
  const readinessTuple = validateTransitionReadiness(
    control?.transitionReadiness,
    renderer,
    C12_29_S5_SVS_CONTROL.role,
    C12_29_S5_SVS_CONTROL.role,
    C12_29_S5_SVS_CONTROL.iso,
    C12_29_S5_SVS_SCENE.transitionReadinessMaxFrames,
    structural,
    schemaContract,
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
    "control",
    schemaContract,
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
  const projectedPixels = lattice?.projectedPixelIdByValidCell;
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
  if (
    schemaContract.requiresV5Evidence &&
    (!exactArrayData(projectedPixels, valid.length) ||
      projectedPixels.length !== valid.length ||
      projectedPixels.some(
        (id) =>
          !Number.isInteger(id) ||
          id < 0 ||
          id >=
            C12_29_S5_SVS_SCENE.viewport.width *
              C12_29_S5_SVS_SCENE.viewport.height,
      ) ||
      new Set(projectedPixels).size !== projectedPixels.length ||
      !sameJson(projectedPixels, sourceLattice?.projectedPixelIdByValidCell))
  ) {
    structural.push(
      `${renderer}: noneclipse projected-pixel binding differs from camera source`,
    );
  }

  let controlSpatial;
  try {
    controlSpatial = deriveSvsSpatialMetrics({
      spatialMeasurementKind: control?.spatialMeasurementKind,
      budget: cameraSource?.budget,
      lattice,
    });
  } catch {
    structural.push(`${renderer}: noneclipse spatial recomputation failed`);
  }
  if (
    control?.spatialMeasurementKind !== "control" ||
    controlSpatial?.measurementKind !== "control" ||
    controlSpatial?.boundary?.comparable !== false ||
    controlSpatial?.boundary?.unavailableReason !== "classified-empty" ||
    controlSpatial?.centroid?.comparable !== false ||
    controlSpatial?.centroid?.unavailableReason !== "classified-empty" ||
    controlSpatial?.centroid?.measuredLonLat !== null ||
    !sameJson(control?.boundary, controlSpatial?.boundary) ||
    !sameJson(control?.centroid, controlSpatial?.centroid)
  ) {
    structural.push(
      `${renderer}: noneclipse spatial unavailability is not explicit`,
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
    oneCode?.some((id) => classified.includes(id)) ||
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

function validateSession(
  session,
  renderer,
  runId,
  failures,
  structural,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
  if (
    session?.schema !== schemaContract.diagnosticsSchema ||
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
    session?.errors?.deviceLost !== false ||
    (schemaContract.requiresV5Evidence &&
      (renderer === "webgpu"
        ? session?.errors?.gpuCompletion?.required !== true ||
          session?.errors?.gpuCompletion?.method !==
            "GPUQueue.onSubmittedWorkDone+two-event-turns" ||
          session?.errors?.gpuCompletion?.queueSettled !== true ||
          session?.errors?.gpuCompletion?.postSubmitTurns !== 2 ||
          session?.errors?.gpuCompletion?.timeoutMs !==
            C12_29_S5_SVS_SCENE.cleanupCloseTimeoutMs
        : session?.errors?.gpuCompletion?.required !== false ||
          session?.errors?.gpuCompletion?.method !== "not-applicable" ||
          session?.errors?.gpuCompletion?.queueSettled !== null ||
          session?.errors?.gpuCompletion?.postSubmitTurns !== 0 ||
          session?.errors?.gpuCompletion?.timeoutMs !== null))
  ) {
    structural.push(`${renderer}: session/runtime error surface is invalid`);
  }
  if (!sameMembers(session?.phaseOrder, C12_29_S5_SVS_PHASES)) {
    structural.push(`${renderer}: A-H phase order/cardinality differs`);
  }
  validateSceneContract(session?.scene, renderer, structural, schemaContract);
  validateIcrf(session?.ephemeris, renderer, structural, schemaContract);
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
    schemaContract,
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
  if (schemaContract.requiresV5Evidence && rows[0]) {
    validateSvsOwnerCameraIdentity(
      {
        cameraFrame: rows[0].cameraFrame,
        transitionReadiness: session?.terrain?.providerReadiness,
        captureTerrainProofs: [],
        variantReadiness: { legs: [] },
        terrainTuple: providerReadinessTuple,
      },
      renderer,
      "terrain-provider",
      structural,
    );
  }
  const rowLineages = session?.ephemeris?.rowLineages;
  if (
    !exactArrayData(rowLineages, C12_29_S5_SVS_ROWS.length) ||
    rowLineages.length !== C12_29_S5_SVS_ROWS.length ||
    rowLineages.some((entry, index) => {
      const row = rows[index];
      const expected = C12_29_S5_SVS_ROWS[index];
      return (
        !exactObjectKeys(entry, [
          "role",
          "iso",
          "captureFrameNumber",
          "lineage",
        ]) ||
        entry.role !== expected.role ||
        entry.iso !== expected.iso ||
        entry.captureFrameNumber !== row?.terrainTuple?.captureFrameNumber ||
        !sameJson(entry.lineage, row?.ephemeris) ||
        !validateSvsEphemerisLineage(
          entry.lineage,
          entry.captureFrameNumber,
          entry.iso,
        )
      );
    })
  ) {
    structural.push(`${renderer}: per-row ephemeris aggregate differs`);
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
    const budget = validateRow(
      row,
      expected,
      renderer,
      failures,
      structural,
      schemaContract,
    );
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
    schemaContract,
  );
  const images = Array.isArray(session?.images) ? session.images : [];
  if (images.length !== schemaContract.captureLabels.length) {
    structural.push(
      `${renderer}: expected ${schemaContract.captureLabels.length} captures`,
    );
  }
  schemaContract.captureLabels.forEach((label, index) =>
    validateImage(
      images[index],
      label,
      runId,
      renderer,
      structural,
      schemaContract,
    ),
  );
  C12_29_S5_SVS_ROWS.forEach((row, index) =>
    validateMetricImageBindings(
      rows[index],
      images,
      renderer,
      row.role,
      structural,
      schemaContract,
    ),
  );
  if (schemaContract.requiresV5Evidence) {
    C12_29_S5_SVS_ROWS.forEach((expected, index) =>
      validateSvsImageDerivedPrimitives(
        rows[index],
        expected,
        images,
        renderer,
        expected.role,
        "event",
        structural,
      ),
    );
    const controlSource = C12_29_S5_SVS_ROWS.find(
      (row) => row.role === C12_29_S5_SVS_CONTROL.projectionSourceRole,
    );
    validateSvsImageDerivedPrimitives(
      session?.control,
      controlSource,
      images,
      renderer,
      C12_29_S5_SVS_CONTROL.role,
      "control",
      structural,
    );
  }
  validateMetricImageBindings(
    session?.control,
    images,
    renderer,
    C12_29_S5_SVS_CONTROL.role,
    structural,
    schemaContract,
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

function validateCrossBackend(
  cross,
  sessions,
  failures,
  structural,
  schemaContract = SVS_V5_SCHEMA_CONTRACT,
) {
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
    const glCentroid = gl?.centroid?.measuredLonLat;
    const gpuCentroid = gpu?.centroid?.measuredLonLat;
    const centroidComparable =
      isDegreeLonLat(glCentroid) && isDegreeLonLat(gpuCentroid);
    const derivedDistance = centroidComparable
      ? wgs84GeodesicDistanceKm(glCentroid, gpuCentroid)
      : null;
    if (
      row?.role !== expected.role ||
      !exactSortedUniqueIntegers(row?.differingCellIds) ||
      row?.differingCellCount !== row?.differingCellIds?.length ||
      row?.allDifferingCellsWithinUnionQBoundaryBands !== true ||
      row?.centroidDistanceMethod !== "WGS84-Vincenty-inverse" ||
      !close(row?.centroidLimitKm, 2 * qKm, 1e-9) ||
      row?.centroidComparable !== centroidComparable ||
      row?.centroidUnavailableReason !==
        (centroidComparable ? null : "measured-centroid-unavailable")
    ) {
      structural.push(`${expected.role}: cross-backend proof is malformed`);
    }
    if (
      !sameMembers(row?.differingCellIds, derivedDiffering) ||
      (centroidComparable
        ? !close(row?.centroidDistanceKm, derivedDistance, 1e-9)
        : row?.centroidDistanceKm !== null)
    ) {
      structural.push(`${expected.role}: cross-backend summary is not derived`);
    }
    if (!centroidComparable) {
      failures.push(`${expected.role}: cross-backend centroid is unavailable`);
    } else if (
      !finite(row?.centroidDistanceKm) ||
      row.centroidDistanceKm > 2 * qKm
    ) {
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
    if (schemaContract.requiresV5Evidence) {
      if (
        !sameJson(
          gl?.lattice?.validProjectedCellIds,
          gpu?.lattice?.validProjectedCellIds,
        ) ||
        !sameJson(
          gl?.lattice?.projectedPixelIdByValidCell,
          gpu?.lattice?.projectedPixelIdByValidCell,
        )
      ) {
        structural.push(
          `${expected.role}: cross-backend projected-pixel binding differs`,
        );
      }
      const cpuState = (proof) => ({
        requested: proof?.requested,
        baseColor: proof?.observed?.baseColor,
        enableEclipse: proof?.observed?.enableEclipse,
        enableEclipseGlobeShadow: proof?.observed?.enableEclipseGlobeShadow,
        eclipseAutoExposure: proof?.observed?.eclipseAutoExposure,
        enableEclipseHorizonTwilight:
          proof?.observed?.enableEclipseHorizonTwilight,
        atmosphericConditionsIdentity:
          proof?.observed?.atmosphericConditionsIdentity,
        eclipseState: proof?.observed?.eclipseState,
        eclipseSceneLightFactor: proof?.observed?.eclipseSceneLightFactor,
        eclipseGlobeShadowPrepared: proof?.observed?.eclipseGlobeShadowPrepared,
        eclipseGlobeShadow: {
          active: proof?.observed?.eclipseGlobeShadow?.active,
          sceneLightDimmed:
            proof?.observed?.eclipseGlobeShadow?.sceneLightDimmed,
          gate: proof?.observed?.eclipseGlobeShadow?.gate,
          inverseSceneLightFactor:
            proof?.observed?.eclipseGlobeShadow?.inverseSceneLightFactor,
        },
        mainViewShadowMatches: proof?.observed?.mainViewShadowMatches,
      });
      const glProofs = gl?.captureTerrainProofs ?? [];
      const gpuProofs = gpu?.captureTerrainProofs ?? [];
      if (
        ["white", "black", "off", "on"].some((captureLabel) => {
          const glProof = glProofs.find(
            (proof) => proof?.label === captureLabel,
          );
          const gpuProof = gpuProofs.find(
            (proof) => proof?.label === captureLabel,
          );
          return !sameJson(cpuState(glProof), cpuState(gpuProof));
        })
      ) {
        structural.push(
          `${expected.role}: cross-backend CPU lighting/physics state differs`,
        );
      }
    }
  });
  if (schemaContract.requiresV5Evidence) {
    const normalizedControlStates = sessions.map((session) =>
      (session?.control?.captureTerrainProofs ?? []).map((proof) => ({
        label: proof?.label,
        requested: proof?.requested,
        baseColor: proof?.observed?.baseColor,
        enableEclipse: proof?.observed?.enableEclipse,
        enableEclipseGlobeShadow: proof?.observed?.enableEclipseGlobeShadow,
        eclipseState: proof?.observed?.eclipseState,
        eclipseSceneLightFactor: proof?.observed?.eclipseSceneLightFactor,
        active: proof?.observed?.eclipseGlobeShadow?.active,
        sceneLightDimmed: proof?.observed?.eclipseGlobeShadow?.sceneLightDimmed,
        gate: proof?.observed?.eclipseGlobeShadow?.gate,
        inverseSceneLightFactor:
          proof?.observed?.eclipseGlobeShadow?.inverseSceneLightFactor,
      })),
    );
    if (!sameJson(normalizedControlStates[0], normalizedControlStates[1])) {
      structural.push("noneclipse-control: cross-backend CPU state differs");
    }
    if (
      !sameJson(
        sessions[0]?.control?.ephemeris,
        sessions[1]?.control?.ephemeris,
      )
    ) {
      structural.push(
        "noneclipse-control: cross-backend ephemeris lineage differs",
      );
    }
    const normalizedXys = sessions.map((session) => {
      const byRoute = new Map();
      for (const entry of session?.ephemeris?.xysFiles ?? []) {
        if (!byRoute.has(entry?.route)) {
          byRoute.set(entry?.route, {
            route: entry?.route,
            status: entry?.status,
            byteLength: entry?.byteLength,
            sha256: entry?.sha256,
            localStart: entry?.localStart,
            localEnd: entry?.localEnd,
          });
        }
      }
      return [...byRoute.values()].sort((left, right) =>
        String(left.route).localeCompare(String(right.route)),
      );
    });
    if (
      normalizedXys.some((entries) => entries.length === 0) ||
      !sameJson(normalizedXys[0], normalizedXys[1])
    ) {
      structural.push(
        "cross-backend IAU2006 XYS route/fingerprint sets differ or are incomplete",
      );
    }
  }
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
function foldSvsReport(report, schemaContract) {
  const structuralReasons = [];
  const failures = [];
  if (report?.schema !== schemaContract.schema || !isUuidV4(report?.runId)) {
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
    validateSvsRunningArtifactShape(lifecycle?.runningReceipt, schemaContract)
      .length !== 0 ||
    lifecycle?.runningReceipt?.runId !== report?.runId ||
    lifecycle?.finalReceipt?.schema !== schemaContract.schema ||
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
  validateProvenance(
    report?.provenance,
    structuralReasons,
    schemaContract.buildSourceFiles,
    schemaContract,
  );
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
      schemaContract,
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
    schemaContract,
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

/** Fold one complete current-schema report. STRUCTURAL precedes product FAIL. */
export function foldC1229S5SvsGate(report) {
  return foldSvsReport(report, SVS_V5_SCHEMA_CONTRACT);
}

/** Fold one retained v4 report without synthesizing any v5 evidence. */
export function foldSupersededC1229S5SvsV4Gate(report) {
  return foldSvsReport(report, SVS_V4_SCHEMA_CONTRACT);
}

export default {
  C12_29_S5_SVS_ARTIFACT_PREFIX,
  C12_29_S5_SVS_SCHEMA,
  C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
  C12_29_S5_SVS_SUPERSEDED_SCHEMA,
  C12_29_S5_SVS_LEGACY_ERROR_SCHEMA,
  C12_29_S5_SVS_EPHEMERIS,
  C12_29_S5_SVS_IMAGE_VERIFIER_METHOD,
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
  C12_29_S5_SVS_SUPERSEDED_DIAGNOSTICS_SCHEMA,
  C12_29_S5_SVS_SOURCE_FILES,
  C12_29_S5_SVS_BUILD_SOURCE_FILES,
  C12_29_S5_SVS_BUILD_SOURCE_MAP,
  computeSvsFootprintBudget,
  deriveSvsWgs84ProjectedLattice,
  summarizeSvsSpatialMetrics,
  deriveSvsSpatialMetrics,
  validateSvsRunningArtifactShape,
  validateSvsRuntimeCheckpointShape,
  validateSvsErrorDiagnosticsShape,
  validateSupersededSvsV2FinalArtifactShape,
  validateSupersededSvsV3FinalArtifactShape,
  wgs84GeodesicDistanceKm,
  foldC1229S5SvsGate,
};
