import { createRepresentativeTilesetRequestLedger } from "./representative-tileset-request-ledger.mjs";

export const REPRESENTATIVE_CONTENT_PROFILE = "local-procedural-terrain-assets";
export const REPRESENTATIVE_CONTENT = "terrain-models-tiles";

const representativeSanFranciscoCenter = {
  longitude: (-122.42 * Math.PI) / 180.0,
  latitude: (37.785 * Math.PI) / 180.0,
};
const representativeSanFranciscoNormalizationRadius = (2.0 * Math.PI) / 180.0;
const representativeSanFranciscoHeightReduction = 340.0;

const requiredPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const requiredFiniteNumber = (value) => Number.isFinite(value);
const isLocalSampleDataUrl = (value) =>
  typeof value === "string" && value.startsWith("/Apps/SampleData/");

/**
 * Validate the serializable representative-workload configuration before it
 * reaches Cesium. Keeping this separate from scene setup gives malformed
 * manifests a deterministic failure instead of a partial benchmark.
 *
 * @param {object} config
 * @returns {string[]}
 */
export function validateRepresentativeConfig(config) {
  const failures = [];
  if (!config || typeof config !== "object") {
    return ["representativeConfig must be an object"];
  }

  const terrain = config.terrain;
  if (!terrain || typeof terrain !== "object") {
    failures.push("terrain configuration is missing");
  } else {
    if (
      !requiredPositiveInteger(terrain.heightmapWidth) ||
      terrain.heightmapWidth < 3 ||
      terrain.heightmapWidth > 129
    ) {
      failures.push("terrain.heightmapWidth must be an integer from 3 to 129");
    }
    if (
      !requiredPositiveInteger(terrain.waterMaskWidth) ||
      terrain.waterMaskWidth < 2 ||
      terrain.waterMaskWidth > 256
    ) {
      failures.push("terrain.waterMaskWidth must be an integer from 2 to 256");
    }
    if (
      !Number.isInteger(terrain.maximumLevel) ||
      terrain.maximumLevel < 1 ||
      terrain.maximumLevel > 16
    ) {
      failures.push("terrain.maximumLevel must be an integer from 1 to 16");
    }
    if (
      !requiredPositiveInteger(terrain.tileCacheSize) ||
      terrain.tileCacheSize > 8192
    ) {
      failures.push("terrain.tileCacheSize must be an integer from 1 to 8192");
    }
  }

  for (const [name, grid] of [
    ["models", config.models],
    ["tilesets", config.tilesets],
  ]) {
    if (!grid || typeof grid !== "object") {
      failures.push(`${name} configuration is missing`);
      continue;
    }
    if (!isLocalSampleDataUrl(grid.url)) {
      failures.push(`${name}.url must reference /Apps/SampleData/`);
    }
    const maximumGridSide = name === "models" ? 32 : 8;
    if (!requiredPositiveInteger(grid.rows) || grid.rows > maximumGridSide) {
      failures.push(
        `${name}.rows must be an integer from 1 to ${maximumGridSide}`,
      );
    }
    if (
      !requiredPositiveInteger(grid.columns) ||
      grid.columns > maximumGridSide
    ) {
      failures.push(
        `${name}.columns must be an integer from 1 to ${maximumGridSide}`,
      );
    }
    for (const property of [
      "originLongitude",
      "originLatitude",
      "longitudeSpacing",
      "latitudeSpacing",
    ]) {
      if (!requiredFiniteNumber(grid[property])) {
        failures.push(`${name}.${property} must be finite`);
      }
    }
  }

  if (
    config.models &&
    (!requiredFiniteNumber(config.models.heightAboveTerrain) ||
      config.models.heightAboveTerrain <= 0 ||
      !requiredFiniteNumber(config.models.scale) ||
      config.models.scale <= 0)
  ) {
    failures.push(
      "positive models.heightAboveTerrain and models.scale are required",
    );
  }

  if (config.tilesets) {
    for (const property of [
      "sourceLongitude",
      "sourceLatitude",
      "sourceHeight",
      "targetHeightOffset",
      "maximumScreenSpaceError",
    ]) {
      if (!requiredFiniteNumber(config.tilesets[property])) {
        failures.push(`tilesets.${property} must be finite`);
      }
    }
    if (config.tilesets.maximumScreenSpaceError <= 0) {
      failures.push("tilesets.maximumScreenSpaceError must be positive");
    }
    if (config.tilesets.targetHeightOffset <= 0) {
      failures.push("tilesets.targetHeightOffset must be positive");
    }
  }

  if (
    !requiredPositiveInteger(config.primeStableFrames) ||
    config.primeStableFrames > 30
  ) {
    failures.push(
      "primeStableFrames must be a positive integer no greater than 30",
    );
  }
  if (
    typeof config.validationWaypoint !== "string" ||
    config.validationWaypoint.length < 1
  ) {
    failures.push("validationWaypoint must be a non-empty string");
  }
  if (
    config.measurementTerrainMode !== "streaming" &&
    config.measurementTerrainMode !== "resident"
  ) {
    failures.push("measurementTerrainMode must be streaming or resident");
  }
  if (
    !Number.isInteger(config.routePrimeSamples) ||
    config.routePrimeSamples < 0 ||
    config.routePrimeSamples > 2048
  ) {
    failures.push("routePrimeSamples must be an integer from 0 to 2048");
  }
  if (
    !Number.isFinite(config.maximumPairWorkDeltaRatio) ||
    config.maximumPairWorkDeltaRatio < 0 ||
    config.maximumPairWorkDeltaRatio > 1
  ) {
    failures.push("maximumPairWorkDeltaRatio must be between 0 and 1");
  }
  if (
    config.measurementTerrainMode === "resident" &&
    config.routePrimeSamples < 2
  ) {
    failures.push(
      "resident terrain measurement requires at least two route prime samples",
    );
  }

  return failures;
}

/**
 * Continuous, deterministic global height field. The frequencies are high
 * enough to retain measurable relief at the bounded maximum LOD, while using
 * only longitude/latitude keeps shared tile edges bit-for-bit consistent.
 */
export function sampleRepresentativeHeight(longitude, latitude) {
  const broadRelief =
    680.0 * Math.sin(longitude * 5.0) * Math.cos(latitude * 7.0);
  const ridges =
    420.0 *
    Math.abs(Math.sin(longitude * 37.0 + latitude * 23.0)) *
    Math.cos(latitude * 11.0);
  const localRelief = 160.0 * Math.sin(longitude * 113.0 - latitude * 97.0);
  const rawHeight = 180.0 + broadRelief + ridges + localRelief;
  const longitudeDistance =
    (longitude - representativeSanFranciscoCenter.longitude) *
    Math.cos(representativeSanFranciscoCenter.latitude);
  const latitudeDistance = latitude - representativeSanFranciscoCenter.latitude;
  const normalizedDistance = Math.min(
    1.0,
    Math.hypot(longitudeDistance, latitudeDistance) /
      representativeSanFranciscoNormalizationRadius,
  );
  const influence = 1.0 - normalizedDistance;
  const smoothInfluence = influence * influence * (3.0 - 2.0 * influence);
  return (
    rawHeight - representativeSanFranciscoHeightReduction * smoothInfluence
  );
}

export function representativeGeometricError(
  level,
  maximumLevel,
  levelZeroMaximumGeometricError,
) {
  return level >= maximumLevel
    ? 0
    : levelZeroMaximumGeometricError / 2 ** level;
}

function waterValue(longitude, latitude) {
  const longitudeDegrees = (longitude * 180.0) / Math.PI;
  const latitudeDegrees = (latitude * 180.0) / Math.PI;

  // Put a continuous synthetic coast beside the San Francisco route so the
  // representative close-range frames exercise mixed land/water textures.
  if (
    longitudeDegrees >= -126.0 &&
    longitudeDegrees <= -119.0 &&
    latitudeDegrees >= 34.0 &&
    latitudeDegrees <= 42.0
  ) {
    const coastLongitude = -122.48 + (latitudeDegrees - 37.75) * 0.08;
    const signedDistance = coastLongitude - longitudeDegrees;
    return Math.round(
      255.0 * Math.min(1.0, Math.max(0.0, signedDistance / 0.025 + 0.5)),
    );
  }

  const field =
    Math.sin(longitude * 3.0) +
    0.65 * Math.cos(latitude * 5.0) +
    0.35 * Math.sin((longitude + latitude) * 17.0);
  return Math.round(255.0 * Math.min(1.0, Math.max(0.0, 0.5 - field)));
}

/**
 * Create the actual TerrainData water-mask payload. Uniform tiles use Cesium's
 * one-byte shared-texture forms; shoreline tiles retain the full square mask.
 */
export function createRepresentativeWaterMask(rectangle, width) {
  const values = new Uint8Array(width * width);
  let minimum = 255;
  let maximum = 0;
  for (let row = 0; row < width; row++) {
    const latitude =
      rectangle.north +
      (rectangle.south - rectangle.north) * (row / (width - 1));
    for (let column = 0; column < width; column++) {
      const longitude =
        rectangle.west +
        (rectangle.east - rectangle.west) * (column / (width - 1));
      const value = waterValue(longitude, latitude);
      values[row * width + column] = value;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }

  if (maximum === 0) {
    return { kind: "land", data: new Uint8Array([0]) };
  }
  if (minimum === 255) {
    return { kind: "water", data: new Uint8Array([255]) };
  }
  return { kind: "mixed", data: values };
}

export function createRepresentativeTerrain(C, config) {
  const validationFailures = validateRepresentativeConfig(config);
  if (validationFailures.length > 0) {
    throw new Error(validationFailures.join("; "));
  }

  const terrainConfig = config.terrain;
  const tilingScheme = new C.GeographicTilingScheme();
  const uniqueTiles = new Set();
  const generatedTileKeys = new Set();
  const tilePayloads = new Map();
  const issuedTerrainData = new WeakSet();
  const diagnostics = {
    requestCount: 0,
    cacheHitCount: 0,
    tileGenerationCount: 0,
    requestsByLevel: {},
    generationsByLevel: {},
    maximumRequestedLevel: -1,
    nonFlatTilesGenerated: 0,
    waterMasksGenerated: {
      land: 0,
      water: 0,
      mixed: 0,
    },
  };
  const levelZeroMaximumGeometricError =
    C.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      tilingScheme.ellipsoid,
      terrainConfig.heightmapWidth,
      tilingScheme.getNumberOfXTilesAtLevel(0),
    );
  const errorEvent = new C.Event();

  const provider = {
    tilingScheme,
    errorEvent,
    credit: undefined,
    hasWaterMask: true,
    hasVertexNormals: false,
    availability: undefined,
    requestTileGeometry(x, y, level) {
      diagnostics.requestCount++;
      diagnostics.requestsByLevel[level] =
        (diagnostics.requestsByLevel[level] || 0) + 1;
      diagnostics.maximumRequestedLevel = Math.max(
        diagnostics.maximumRequestedLevel,
        level,
      );
      const key = `${level}/${x}/${y}`;
      uniqueTiles.add(key);

      let payload = tilePayloads.get(key);
      if (payload) {
        diagnostics.cacheHitCount++;
      } else {
        const rectangle = tilingScheme.tileXYToRectangle(x, y, level);
        const width = terrainConfig.heightmapWidth;
        const buffer = new Float32Array(width * width);
        let minimumHeight = Number.POSITIVE_INFINITY;
        let maximumHeight = Number.NEGATIVE_INFINITY;
        for (let row = 0; row < width; row++) {
          const latitude =
            rectangle.north +
            (rectangle.south - rectangle.north) * (row / (width - 1));
          for (let column = 0; column < width; column++) {
            const longitude =
              rectangle.west +
              (rectangle.east - rectangle.west) * (column / (width - 1));
            const height = sampleRepresentativeHeight(longitude, latitude);
            buffer[row * width + column] = height;
            minimumHeight = Math.min(minimumHeight, height);
            maximumHeight = Math.max(maximumHeight, height);
          }
        }
        if (maximumHeight - minimumHeight > 1.0) {
          diagnostics.nonFlatTilesGenerated++;
        }

        const waterMask = createRepresentativeWaterMask(
          rectangle,
          terrainConfig.waterMaskWidth,
        );
        diagnostics.waterMasksGenerated[waterMask.kind]++;
        diagnostics.tileGenerationCount++;
        diagnostics.generationsByLevel[level] =
          (diagnostics.generationsByLevel[level] || 0) + 1;
        generatedTileKeys.add(key);
        payload = {
          buffer,
          waterMask: waterMask.data,
        };
        tilePayloads.set(key, payload);
      }

      const terrainData = new C.HeightmapTerrainData({
        // HeightmapTerrainData releases its buffer after mesh creation. Give
        // each request a fresh wrapper around cached deterministic payloads
        // so quadtree eviction cannot mutate the provider cache.
        buffer: payload.buffer.slice(),
        width: terrainConfig.heightmapWidth,
        height: terrainConfig.heightmapWidth,
        childTileMask: level < terrainConfig.maximumLevel ? 15 : 0,
        waterMask: payload.waterMask.slice(),
      });
      issuedTerrainData.add(terrainData);
      return Promise.resolve(terrainData);
    },
    getLevelMaximumGeometricError(level) {
      // Cesium can continue creating upsampled descendants after a terrain
      // provider's child mask reaches zero. Advertising zero residual error
      // at the final real-data level prevents that synthetic refinement, so
      // the representative lane has a hard and observable LOD bound.
      return representativeGeometricError(
        level,
        terrainConfig.maximumLevel,
        levelZeroMaximumGeometricError,
      );
    },
    getTileDataAvailable(x, y, level) {
      return level <= terrainConfig.maximumLevel;
    },
    loadTileDataAvailability() {
      return undefined;
    },
  };

  return {
    provider,
    ownsTerrainData(terrainData) {
      return issuedTerrainData.has(terrainData);
    },
    snapshotDiagnostics(options = {}) {
      return {
        requestCount: diagnostics.requestCount,
        cacheHitCount: diagnostics.cacheHitCount,
        tileGenerationCount: diagnostics.tileGenerationCount,
        requestsByLevel: { ...diagnostics.requestsByLevel },
        generationsByLevel: { ...diagnostics.generationsByLevel },
        ...(options.includeGeneratedTileKeys
          ? { generatedTileKeys: [...generatedTileKeys].sort() }
          : {}),
        uniqueTileCount: uniqueTiles.size,
        maximumLevel: terrainConfig.maximumLevel,
        maximumRequestedLevel: diagnostics.maximumRequestedLevel,
        nonFlatTilesGenerated: diagnostics.nonFlatTilesGenerated,
        waterMasksGenerated: { ...diagnostics.waterMasksGenerated },
      };
    },
  };
}

export function diffRepresentativeTerrainDiagnostics(start, end) {
  if (!start || !end) {
    return null;
  }
  const generatedAtStart = new Set(start.generatedTileKeys || []);
  return {
    requestCount: end.requestCount - start.requestCount,
    cacheHitCount: end.cacheHitCount - start.cacheHitCount,
    tileGenerationCount: end.tileGenerationCount - start.tileGenerationCount,
    requestsByLevel: diffLevelCounts(
      start.requestsByLevel,
      end.requestsByLevel,
    ),
    generationsByLevel: diffLevelCounts(
      start.generationsByLevel,
      end.generationsByLevel,
    ),
    generatedTileKeys: (end.generatedTileKeys || []).filter(
      (key) => !generatedAtStart.has(key),
    ),
    uniqueTileCount: end.uniqueTileCount - start.uniqueTileCount,
    maximumRequestedLevel: end.maximumRequestedLevel,
    nonFlatTilesGenerated:
      end.nonFlatTilesGenerated - start.nonFlatTilesGenerated,
    waterMasksGenerated: Object.fromEntries(
      Object.keys(end.waterMasksGenerated).map((kind) => [
        kind,
        end.waterMasksGenerated[kind] - (start.waterMasksGenerated[kind] || 0),
      ]),
    ),
  };
}

/**
 * C11-205 — per-frame residency evidence for the tracked 3D Tilesets.
 *
 * The resident route contract already proved that terrain needed no work. It
 * said nothing about 3D Tiles content, which is why a resident pair could end
 * with the legs holding different ready sets: the tilesets were still
 * streaming during the measured window and each backend reached readiness on
 * its own frames. `tilesLoaded` alone is not enough — a tileset can report
 * loaded on a frame it also unloaded content on — so the sample carries the
 * cumulative load counter and resident byte totals as well.
 *
 * @param {object[]} tilesets
 * @returns {object}
 */
export function sampleRepresentativeTilesetResidency(tilesets) {
  const list = Array.isArray(tilesets) ? tilesets : [];
  const sample = {
    tilesetCount: list.length,
    allTilesLoaded: list.length > 0,
    pendingRequests: 0,
    tilesProcessing: 0,
    attemptedRequests: 0,
    loadedTilesTotal: 0,
    contentByteLength: 0,
  };
  for (const tileset of list) {
    const statistics = tileset?.statistics;
    if (tileset?.tilesLoaded !== true) {
      sample.allTilesLoaded = false;
    }
    // A tileset without readable statistics cannot state residency. Report the
    // sample as not-loaded rather than silently scoring it as quiescent.
    if (!statistics) {
      sample.allTilesLoaded = false;
      continue;
    }
    sample.pendingRequests += statistics.numberOfPendingRequests || 0;
    sample.tilesProcessing += statistics.numberOfTilesProcessing || 0;
    sample.attemptedRequests += statistics.numberOfAttemptedRequests || 0;
    sample.loadedTilesTotal += statistics.numberOfLoadedTilesTotal || 0;
    sample.contentByteLength +=
      (statistics.geometryByteLength || 0) +
      (statistics.texturesByteLength || 0) +
      (statistics.batchTableByteLength || 0);
  }
  return sample;
}

/**
 * Accumulate {@link sampleRepresentativeTilesetResidency} over a route pass or
 * a measured window. `observe` is called once per rendered frame; the first
 * observation fixes the baseline the cumulative deltas are read against.
 *
 * @param {object[]} tilesets
 * @returns {{observe: Function, summarize: Function}}
 */
export function createRepresentativeTilesetResidencyAccumulator(tilesets) {
  let frames = 0;
  let notLoadedFrames = 0;
  let pendingRequestFrames = 0;
  let processingFrames = 0;
  let attemptedRequestFrames = 0;
  let start = null;
  let end = null;
  return {
    observe(sample = sampleRepresentativeTilesetResidency(tilesets)) {
      frames++;
      start ??= sample;
      end = sample;
      if (sample.allTilesLoaded !== true) {
        notLoadedFrames++;
      }
      if (sample.pendingRequests > 0) {
        pendingRequestFrames++;
      }
      if (sample.tilesProcessing > 0) {
        processingFrames++;
      }
      if (sample.attemptedRequests > 0) {
        attemptedRequestFrames++;
      }
    },
    summarize() {
      return {
        schemaVersion: 1,
        tilesetCount: end?.tilesetCount ?? 0,
        frames,
        notLoadedFrames,
        pendingRequestFrames,
        processingFrames,
        attemptedRequestFrames,
        loadedTilesTotalDelta:
          start === null ? null : end.loadedTilesTotal - start.loadedTilesTotal,
        contentByteLengthDelta:
          start === null
            ? null
            : end.contentByteLength - start.contentByteLength,
        start,
        end,
      };
    },
  };
}

/**
 * Decide whether a residency summary describes a window in which the tracked
 * 3D Tiles content was already fully resident and stayed that way.
 *
 * Fail-closed: missing, empty, or subject-free evidence is NOT quiescent. A
 * resident comparison that cannot see its 3D Tiles content is not a resident
 * comparison.
 *
 * @param {object} residency
 * @returns {{quiescent: boolean, reasons: string[]}}
 */
export function summarizeRepresentativeTilesetResidency(residency) {
  const reasons = [];
  if (!residency || typeof residency !== "object") {
    return {
      quiescent: false,
      reasons: ["3D Tiles residency evidence is missing"],
    };
  }
  if (!Number.isInteger(residency.frames) || residency.frames <= 0) {
    reasons.push("3D Tiles residency evidence observed no frames");
  }
  if (
    !Number.isInteger(residency.tilesetCount) ||
    residency.tilesetCount <= 0
  ) {
    reasons.push("3D Tiles residency evidence tracked no tilesets");
  }
  for (const [name, description] of [
    ["notLoadedFrames", "frames with an unloaded tileset"],
    ["pendingRequestFrames", "frames with a pending content request"],
    ["processingFrames", "frames with content still processing"],
    ["attemptedRequestFrames", "frames that attempted a content request"],
  ]) {
    const value = residency[name];
    if (!Number.isInteger(value)) {
      reasons.push(`3D Tiles residency ${name} is missing`);
    } else if (value !== 0) {
      reasons.push(`${value} ${description}`);
    }
  }
  for (const [name, description] of [
    ["loadedTilesTotalDelta", "tiles were loaded during the window"],
    ["contentByteLengthDelta", "resident content bytes changed"],
  ]) {
    const value = residency[name];
    if (!Number.isInteger(value)) {
      reasons.push(`3D Tiles residency ${name} is missing`);
    } else if (value !== 0) {
      reasons.push(`${description} (${name}=${value})`);
    }
  }
  return { quiescent: reasons.length === 0, reasons };
}

/**
 * A resident route is causal only when the complete measured camera sequence
 * needs no terrain requests or generation, never observes an incomplete globe
 * selection, and holds its 3D Tiles content fully resident throughout.
 * Route-start staging belongs outside this pass.
 */
export function isRepresentativeResidentRoutePassQuiescent(pass) {
  return (
    pass?.requestCount === 0 &&
    pass?.tileGenerationCount === 0 &&
    pass?.globeTilesNotLoadedFrames === 0 &&
    summarizeRepresentativeTilesetResidency(pass?.tilesetResidency)
      .quiescent === true
  );
}

function diffLevelCounts(start = {}, end = {}) {
  return Object.fromEntries(
    [...new Set([...Object.keys(start), ...Object.keys(end)])]
      .sort((left, right) => Number(left) - Number(right))
      .map((level) => [level, (end[level] || 0) - (start[level] || 0)])
      .filter(([, count]) => count !== 0),
  );
}

function gridCoordinate(grid, row, column) {
  return {
    longitude: grid.originLongitude + column * grid.longitudeSpacing,
    latitude: grid.originLatitude + row * grid.latitudeSpacing,
  };
}

export async function createRepresentativeAssets(C, scene, config) {
  const modelPromises = [];
  let minimumModelTerrainClearance = Number.POSITIVE_INFINITY;
  for (let row = 0; row < config.models.rows; row++) {
    for (let column = 0; column < config.models.columns; column++) {
      const coordinate = gridCoordinate(config.models, row, column);
      const position = C.Cartesian3.fromDegrees(
        coordinate.longitude,
        coordinate.latitude,
        sampleRepresentativeHeight(
          C.Math.toRadians(coordinate.longitude),
          C.Math.toRadians(coordinate.latitude),
        ) + config.models.heightAboveTerrain,
      );
      minimumModelTerrainClearance = Math.min(
        minimumModelTerrainClearance,
        config.models.heightAboveTerrain,
      );
      modelPromises.push(
        C.Model.fromGltfAsync({
          url: config.models.url,
          modelMatrix: C.Transforms.eastNorthUpToFixedFrame(position),
          scale: config.models.scale,
        }),
      );
    }
  }
  const models = await Promise.all(modelPromises);
  for (const model of models) {
    scene.primitives.add(model);
  }

  const sourceFrame = C.Transforms.eastNorthUpToFixedFrame(
    C.Cartesian3.fromDegrees(
      config.tilesets.sourceLongitude,
      config.tilesets.sourceLatitude,
      config.tilesets.sourceHeight,
    ),
  );
  const inverseSourceFrame = C.Matrix4.inverseTransformation(
    sourceFrame,
    new C.Matrix4(),
  );
  const tilesetPromises = [];
  let minimumTilesetTerrainClearance = Number.POSITIVE_INFINITY;
  for (let row = 0; row < config.tilesets.rows; row++) {
    for (let column = 0; column < config.tilesets.columns; column++) {
      const coordinate = gridCoordinate(config.tilesets, row, column);
      const terrainHeight = sampleRepresentativeHeight(
        C.Math.toRadians(coordinate.longitude),
        C.Math.toRadians(coordinate.latitude),
      );
      const targetFrame = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(
          coordinate.longitude,
          coordinate.latitude,
          terrainHeight + config.tilesets.targetHeightOffset,
        ),
      );
      minimumTilesetTerrainClearance = Math.min(
        minimumTilesetTerrainClearance,
        config.tilesets.targetHeightOffset,
      );
      const modelMatrix = C.Matrix4.multiply(
        targetFrame,
        inverseSourceFrame,
        new C.Matrix4(),
      );
      tilesetPromises.push(
        C.Cesium3DTileset.fromUrl(config.tilesets.url, {
          modelMatrix,
          maximumScreenSpaceError: config.tilesets.maximumScreenSpaceError,
        }),
      );
    }
  }
  const tilesets = await Promise.all(tilesetPromises);
  for (const tileset of tilesets) {
    scene.primitives.add(tileset);
  }

  return {
    models,
    tilesets,
    placement: {
      minimumModelTerrainClearance,
      minimumTilesetTerrainClearance,
    },
  };
}

const tilesetLifecycleEventLimit = 4096;
const tilesetLifecycleFrameLimit = 2048;
const tilesetLifecycleIdentityListLimit = 128;
const tilesetLifecycleByteTotalNames = Object.freeze([
  "transferBytes",
  "encodedBodyBytes",
  "decodedBodyBytes",
]);

/**
 * Membership test for the resident 3D Tiles content set.
 *
 * This mirrors the exact condition under which the engine increments
 * `statistics.numberOfTilesWithContentReady` (`Cesium3DTile.process`): content
 * that actually loaded, excluding empty, external-tileset, and implicit
 * placeholder tiles. Keeping one predicate matters because the certifying
 * workload fingerprint and the attribution-only lifecycle diagnostics are read
 * together — a rejection produced from one definition must never be explained
 * with identities collected under a different one.
 */
export function isRepresentativeContentReadyTile(tile) {
  return (
    tile?.contentReady === true &&
    tile.hasEmptyContent !== true &&
    tile.hasTilesetContent !== true &&
    tile.hasImplicitContent !== true
  );
}

function createRepresentativeTileIdentityRegistry(tilesets) {
  const identities = new WeakMap();

  const register = (tile, tilesetIndex, path) => {
    if (!tile || identities.has(tile)) {
      return;
    }
    identities.set(tile, {
      tilesetIndex,
      path,
      id: `tileset-${tilesetIndex}/${path}`,
    });
    const children = tile.children || [];
    for (let index = 0; index < children.length; index++) {
      register(children[index], tilesetIndex, `${path}/${index}`);
    }
  };

  const refresh = () => {
    for (let index = 0; index < tilesets.length; index++) {
      register(tilesets[index]?._root, index, "root");
    }
  };

  const get = (tile) => {
    if (!tile) {
      return null;
    }
    let identity = identities.get(tile);
    if (identity) {
      return identity;
    }
    const parent = tile.parent;
    const parentIdentity = get(parent);
    if (parentIdentity) {
      const childIndex = (parent.children || []).indexOf(tile);
      if (childIndex >= 0) {
        register(
          tile,
          parentIdentity.tilesetIndex,
          `${parentIdentity.path}/${childIndex}`,
        );
        identity = identities.get(tile);
      }
    }
    return identity || null;
  };

  refresh();
  return { get, refresh };
}

function collectRepresentativeTiles(root, result) {
  if (!root) {
    return;
  }
  result.push(root);
  const children = root.children || [];
  for (let index = 0; index < children.length; index++) {
    collectRepresentativeTiles(children[index], result);
  }
}

function lifecycleIdentitySignature(identities) {
  let hash = fingerprintHashSeedA;
  for (const identity of identities) {
    for (let index = 0; index < identity.length; index++) {
      hash ^= identity.charCodeAt(index);
      hash = Math.imul(hash, fingerprintHashPrime) >>> 0;
    }
    hash = Math.imul(hash ^ 0xff, fingerprintHashPrime) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Install opt-in 3D Tiles request and route-replay diagnostics for the
 * performance harness. This deliberately patches Cesium3DTile only inside an
 * explicitly instrumented browser run; ordinary application and certification
 * paths do not execute even a diagnostic branch.
 *
 * The request chronology covers the complete representative prime/convergence
 * lifetime. Per-frame identity scans are invoked only by the post-measurement,
 * untimed deterministic replay.
 */
export function createRepresentativeTilesetLifecycleTracker(
  C,
  assets,
  options = {},
) {
  const tilesets = assets?.tilesets || [];
  const trackedTilesets = new Set(tilesets);
  const identities = createRepresentativeTileIdentityRegistry(tilesets);
  const performanceApi = options.performanceApi || globalThis.performance;
  const baseUrl =
    options.baseUrl || globalThis.location?.href || "http://localhost/";
  const eventLimit = options.eventLimit ?? tilesetLifecycleEventLimit;
  const frameLimit = options.frameLimit ?? tilesetLifecycleFrameLimit;
  const schemaVersion = options.schemaVersion ?? 1;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error(`Unsupported tileset lifecycle schema ${schemaVersion}`);
  }
  const requestContentPrototype = C.Cesium3DTile?.prototype;
  if (!requestContentPrototype) {
    throw new Error("Cesium3DTile prototype is unavailable");
  }

  const originalRequestContent = requestContentPrototype.requestContent;
  const originalCancelRequests = requestContentPrototype.cancelRequests;
  const multipleContentPrototype =
    schemaVersion === 2 ? C.Multiple3DTileContent?.prototype : null;
  const modelContentPrototype =
    schemaVersion === 2 ? C.Model3DTileContent?.prototype : null;
  if (
    schemaVersion === 2 &&
    (!multipleContentPrototype || !modelContentPrototype)
  ) {
    throw new Error(
      "Lifecycle schema 2 requires Multiple3DTileContent and Model3DTileContent",
    );
  }
  const originalRequestInnerContents =
    multipleContentPrototype?.requestInnerContents;
  const originalMultipleCancelRequests =
    multipleContentPrototype?.cancelRequests;
  const originalModelUpdate = modelContentPrototype?.update;
  const originalModelDestroy = modelContentPrototype?.destroy;
  const requestRecords = new WeakMap();
  const requestTimingCursors = new Map();
  const tileAttemptCounts = new WeakMap();
  const tileIssueCounts = new WeakMap();
  const lastIssuedRecords = new WeakMap();
  const cancelledRequests = new WeakSet();
  const settledRequests = new WeakSet();
  const slotAttemptCounts = new WeakMap();
  const slotIssueCounts = new WeakMap();
  const lastSlotRecords = new WeakMap();
  const multipleGroupCounts = new WeakMap();
  const contentIdentities = new WeakMap();
  const observedContentReady = new WeakSet();
  const observedModelReady = new WeakSet();
  const observedModelDestroyed = new WeakSet();
  const ambiguityObjects = new WeakSet();
  const events = [];
  const frames = [];
  const removeTileLoadListeners = [];
  let eventsTruncated = false;
  let framesTruncated = false;
  let active = true;
  let nextRequestId = 1;
  const totals = {
    requestAttempts: 0,
    requestsIssued: 0,
    requestSchedulingDeferrals: 0,
    requestsCancelled: 0,
    requestsReissued: 0,
    requestsReissuedAfterCancellation: 0,
    requestsCompleted: 0,
    requestsFailed: 0,
    requestsResolvedWithoutContent: 0,
    multipleContentRequestAttempts: 0,
    tileReadyEvents: 0,
    resourceTimingsMatched: 0,
    resourceTimingsMissing: 0,
    transferBytes: 0,
    encodedBodyBytes: 0,
    decodedBodyBytes: 0,
  };
  if (schemaVersion === 2) {
    Object.assign(totals, {
      contentCreatedEvents: 0,
      contentFactoryFailures: 0,
      requestCancellationNoops: 0,
      modelReadyEvents: 0,
      contentReadyEvents: 0,
      modelDestroyedBeforeReadyEvents: 0,
    });
  }

  const requestStateName = (state) => {
    for (const [name, value] of Object.entries(C.RequestState || {})) {
      if (value === state) {
        return name;
      }
    }
    return state == null ? null : `UNKNOWN_${state}`;
  };

  const contentStateName = (state) => {
    for (const [name, value] of Object.entries(
      C.Cesium3DTileContentState || {},
    )) {
      if (value === state) {
        return name;
      }
    }
    return state == null ? null : `UNKNOWN_${state}`;
  };

  const frameNumber = (tile) => tile?._tileset?._updatedVisibilityFrame ?? null;

  const tileIdentity = (tile) => {
    identities.refresh();
    return identities.get(tile)?.id ?? "unidentified";
  };

  const pushEvent = (event) => {
    if (!active) {
      return;
    }
    if (events.length >= eventLimit) {
      eventsTruncated = true;
      return;
    }
    events.push({
      sequence: events.length,
      timestampMs: performanceApi?.now?.() ?? null,
      ...event,
    });
  };

  const canonicalUrl = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    try {
      return new URL(value, baseUrl).href;
    } catch {
      return value;
    }
  };

  const canonicalResourceUrl = (tile) =>
    canonicalUrl(tile?._contentResource?.url);

  const canonicalInnerResourceUrl = (multipleContents, index) =>
    canonicalUrl(
      multipleContents?._innerContentResources?.[index]?.url ??
        multipleContents?._innerContentResources?.[index]?.getUrlComponent?.(
          true,
        ),
    );

  const contentKind = (tile) =>
    tile?.hasMultipleContents === true ? "multiple" : "single";

  const requestEventIdentity = (record, tile) => ({
    requestId: record?.requestId ?? null,
    tile: record?.tile ?? tileIdentity(tile),
    contentKind: record?.contentKind ?? contentKind(tile),
    contentSlot: record?.contentSlot ?? "single",
    requestSerial: record?.requestSerial ?? null,
    attemptSerial: record?.attemptSerial ?? null,
    ...(schemaVersion === 2
      ? {
          groupSerial: record?.groupSerial ?? null,
          groupSize: record?.groupSize ?? null,
        }
      : {}),
  });

  const getSlotCount = (registry, tile, contentSlot) =>
    registry.get(tile)?.get(contentSlot) ?? 0;

  const setSlotCount = (registry, tile, contentSlot, value) => {
    let counts = registry.get(tile);
    if (!counts) {
      counts = new Map();
      registry.set(tile, counts);
    }
    counts.set(contentSlot, value);
  };

  const getLastSlotRecord = (tile, contentSlot) =>
    lastSlotRecords.get(tile)?.get(contentSlot) ?? null;

  const setLastSlotRecord = (tile, contentSlot, record) => {
    let records = lastSlotRecords.get(tile);
    if (!records) {
      records = new Map();
      lastSlotRecords.set(tile, records);
    }
    records.set(contentSlot, record);
  };

  const primeResourceTimingCursor = (url) => {
    if (
      url &&
      !requestTimingCursors.has(url) &&
      typeof performanceApi?.getEntriesByName === "function"
    ) {
      requestTimingCursors.set(
        url,
        (performanceApi.getEntriesByName(url, "resource") || []).length,
      );
    }
  };

  // Ignore any resource entries that predate this opt-in tracker. The
  // representative tile payload URLs are shared by four relocated tilesets,
  // so one cursor per URL assigns same-URL completions deterministically.
  for (const tileset of tilesets) {
    const allTiles = [];
    collectRepresentativeTiles(tileset?._root, allTiles);
    for (const tile of allTiles) {
      const url = canonicalResourceUrl(tile);
      primeResourceTimingCursor(url);
    }
  }

  const consumeResourceTiming = (url) => {
    if (!url || typeof performanceApi?.getEntriesByName !== "function") {
      return null;
    }
    const entries = performanceApi.getEntriesByName(url, "resource") || [];
    const cursor = requestTimingCursors.get(url) ?? 0;
    if (cursor >= entries.length) {
      return null;
    }
    requestTimingCursors.set(url, cursor + 1);
    const entry = entries[cursor];
    return {
      transferBytes: Number.isFinite(entry.transferSize)
        ? entry.transferSize
        : null,
      encodedBodyBytes: Number.isFinite(entry.encodedBodySize)
        ? entry.encodedBodySize
        : null,
      decodedBodyBytes: Number.isFinite(entry.decodedBodySize)
        ? entry.decodedBodySize
        : null,
      durationMs: Number.isFinite(entry.duration) ? entry.duration : null,
      responseEndMs: Number.isFinite(entry.responseEnd)
        ? entry.responseEnd
        : null,
      deliveryType: entry.deliveryType || null,
    };
  };

  const emitAmbiguity = (object, tile, reason) => {
    if (object && ambiguityObjects.has(object)) {
      return;
    }
    if (object) {
      ambiguityObjects.add(object);
    }
    pushEvent({
      type: "instrumentation-ambiguity",
      tile: tileIdentity(tile),
      contentKind: contentKind(tile),
      contentSlot: "unknown",
      frameNumber: frameNumber(tile),
      reason,
    });
  };

  const stableModelIdentity = (identity) =>
    `${identity.record.tile}::${identity.record.contentSlot}::${identity.record.requestSerial}::${identity.modelPath}`;

  const registerContentTree = (content, record, path = "") => {
    if (!content || !record) {
      return [];
    }
    if (content instanceof C.Model3DTileContent) {
      const modelPath = path ? `${path}/model` : "model";
      contentIdentities.set(content, { record, modelPath });
      return [modelPath];
    }
    const innerContents = content.innerContents;
    if (!Array.isArray(innerContents)) {
      return [];
    }
    const modelPaths = [];
    for (let index = 0; index < innerContents.length; index++) {
      const childPath = path
        ? `${path}/composite/${index}`
        : `composite/${index}`;
      modelPaths.push(
        ...registerContentTree(innerContents[index], record, childPath),
      );
    }
    return modelPaths;
  };

  const recordContentOutcome = (tile, record, type, content = null) => {
    if (!active || !record || record.contentOutcomeObserved) {
      return;
    }
    record.contentOutcomeObserved = true;
    const modelPaths =
      type === "content-created"
        ? registerContentTree(content, record).sort()
        : [];
    if (type === "content-created") {
      totals.contentCreatedEvents++;
    } else if (type === "content-factory-failed") {
      totals.contentFactoryFailures++;
    }
    pushEvent({
      type,
      ...requestEventIdentity(record, tile),
      frameNumber: frameNumber(tile),
      contentType: content?.constructor?.name ?? null,
      modelPaths,
    });
  };

  const emitModelEvent = (type, content) => {
    const identity = contentIdentities.get(content);
    const tile = content?.tile ?? content?._tile;
    if (!identity) {
      emitAmbiguity(
        content,
        tile,
        `model ${type} could not be joined to an exact request generation`,
      );
      return;
    }
    const { record, modelPath } = identity;
    pushEvent({
      type,
      ...requestEventIdentity(record, tile),
      frameNumber: frameNumber(tile),
      modelPath,
      modelId: stableModelIdentity(identity),
    });
  };

  const recordCancellation = (tile, request, reason) => {
    if (!request) {
      return;
    }
    const record = requestRecords.get(request);
    // Request.cancel() marks even an already RECEIVED request as cancelled.
    // That is a transport no-op, not an effective cancellation transition.
    if (record?.terminalType != null || cancelledRequests.has(request)) {
      return;
    }
    cancelledRequests.add(request);
    totals.requestsCancelled++;
    if (record) {
      record.cancelled = true;
    }
    pushEvent({
      type: "cancelled",
      ...requestEventIdentity(record, tile),
      frameNumber: frameNumber(tile),
      requestState: requestStateName(request.state),
      reason,
    });
  };

  const recordCancellationNoop = (tile, request, reason) => {
    if (!active) {
      return;
    }
    const record = requestRecords.get(request);
    if (!record || record.terminalType == null || record.cancelNoopObserved) {
      return;
    }
    record.cancelNoopObserved = true;
    totals.requestCancellationNoops++;
    pushEvent({
      type: "cancel-requested-noop",
      ...requestEventIdentity(record, tile),
      frameNumber: frameNumber(tile),
      requestState: requestStateName(request.state),
      terminalType: record.terminalType,
      reason,
    });
  };

  const settleRequest = (tile, request, content, error, settleOptions = {}) => {
    if (!active || !request || settledRequests.has(request)) {
      return;
    }
    settledRequests.add(request);
    const record = requestRecords.get(request);
    const cancelled =
      request.cancelled === true || request.state === C.RequestState?.CANCELLED;
    const cancellationNoop =
      schemaVersion === 2 && cancelled && settleOptions.type === "completed";
    if (cancelled && !cancellationNoop) {
      recordCancellation(tile, request, "request-settled-cancelled");
    }
    const timing = consumeResourceTiming(record?.url ?? null);
    if (timing) {
      totals.resourceTimingsMatched++;
      for (const name of tilesetLifecycleByteTotalNames) {
        if (totals[name] === null) {
          continue;
        }
        const value = timing[name];
        totals[name] =
          Number.isFinite(value) && value >= 0 ? totals[name] + value : null;
      }
    } else {
      totals.resourceTimingsMissing++;
      for (const name of tilesetLifecycleByteTotalNames) {
        totals[name] = null;
      }
    }

    let type = settleOptions.type;
    if (type) {
      if (type === "failed") {
        totals.requestsFailed++;
      } else if (
        type === "cancelled-settled" ||
        type === "resolved-without-content"
      ) {
        totals.requestsResolvedWithoutContent++;
      } else if (type === "completed") {
        totals.requestsCompleted++;
      }
    } else if (error) {
      totals.requestsFailed++;
      type = "failed";
    } else if (content == null) {
      totals.requestsResolvedWithoutContent++;
      type = cancelled ? "cancelled-settled" : "resolved-without-content";
    } else {
      totals.requestsCompleted++;
      type = "completed";
    }
    if (record) {
      record.terminalType = type;
      if (
        type === "cancelled-settled" &&
        record.successor &&
        record.successor.reissueAfterCancellationCounted !== true
      ) {
        totals.requestsReissuedAfterCancellation++;
        record.successor.reissueAfterCancellationCounted = true;
      }
    }
    pushEvent({
      type,
      ...requestEventIdentity(record, tile),
      frameNumber: frameNumber(tile),
      requestState: requestStateName(request.state),
      contentState: contentStateName(tile?._contentState),
      bytes: timing,
      error: error ? String(error?.message || error) : null,
    });
    if (cancellationNoop) {
      recordCancellationNoop(tile, request, "request-settled-after-cancel");
    }
    if (
      schemaVersion === 2 &&
      type === "completed" &&
      settleOptions.contentCreated === true
    ) {
      recordContentOutcome(tile, record, "content-created", content);
    }
  };

  if (schemaVersion === 2) {
    multipleContentPrototype.requestInnerContents = function (...args) {
      if (!active || !trackedTilesets.has(this?._tileset)) {
        return originalRequestInnerContents.apply(this, args);
      }

      const tile = this._tile;
      const groupSerial = (multipleGroupCounts.get(tile) || 0) + 1;
      multipleGroupCounts.set(tile, groupSerial);
      const contentCount = this._innerContentHeaders?.length ?? 0;
      const attempts = [];
      for (let index = 0; index < contentCount; index++) {
        const contentSlot = `content-${index}`;
        const attemptSerial =
          getSlotCount(slotAttemptCounts, tile, contentSlot) + 1;
        setSlotCount(slotAttemptCounts, tile, contentSlot, attemptSerial);
        attempts.push({ contentSlot, attemptSerial });
        primeResourceTimingCursor(canonicalInnerResourceUrl(this, index));
      }

      const result = originalRequestInnerContents.apply(this, args);
      if (result == null) {
        for (const attempt of attempts) {
          totals.requestAttempts++;
          totals.requestSchedulingDeferrals++;
          totals.multipleContentRequestAttempts++;
          pushEvent({
            type: "scheduling-deferred",
            requestId: null,
            tile: tileIdentity(tile),
            contentKind: "multiple",
            contentSlot: attempt.contentSlot,
            requestSerial: null,
            attemptSerial: attempt.attemptSerial,
            groupSerial,
            groupSize: contentCount,
            frameNumber: frameNumber(tile),
            contentState: contentStateName(tile?._contentState),
          });
        }
        return result;
      }

      const groupRecords = new Array(contentCount);
      for (let index = 0; index < contentCount; index++) {
        const { contentSlot, attemptSerial } = attempts[index];
        const request = this._requests?.[index];
        const fetchPromise = this._arrayFetchPromises?.[index];
        totals.requestAttempts++;
        totals.multipleContentRequestAttempts++;
        if (fetchPromise == null) {
          totals.requestSchedulingDeferrals++;
          pushEvent({
            type: "scheduling-deferred",
            requestId: null,
            tile: tileIdentity(tile),
            contentKind: "multiple",
            contentSlot,
            requestSerial: null,
            attemptSerial,
            groupSerial,
            groupSize: contentCount,
            frameNumber: frameNumber(tile),
            requestState: requestStateName(request?.state),
            contentState: contentStateName(tile?._contentState),
          });
          continue;
        }

        const requestSerial =
          getSlotCount(slotIssueCounts, tile, contentSlot) + 1;
        setSlotCount(slotIssueCounts, tile, contentSlot, requestSerial);
        totals.requestsIssued++;
        const previousRecord = getLastSlotRecord(tile, contentSlot);
        if (requestSerial > 1) {
          totals.requestsReissued++;
          if (previousRecord?.terminalType === "cancelled-settled") {
            totals.requestsReissuedAfterCancellation++;
          }
        }
        const record = {
          requestId: nextRequestId++,
          tile: tileIdentity(tile),
          contentKind: "multiple",
          contentSlot,
          requestSerial,
          attemptSerial,
          groupSerial,
          groupSize: contentCount,
          url: canonicalInnerResourceUrl(this, index),
          cancelled: false,
          tileObject: tile,
          reissueAfterCancellationCounted:
            previousRecord?.terminalType === "cancelled-settled",
          requestObject: request,
        };
        if (previousRecord) {
          previousRecord.successor = record;
        }
        groupRecords[index] = record;
        if (request) {
          if (requestRecords.has(request)) {
            emitAmbiguity(
              request,
              tile,
              `multiple-content request object was reused for ${contentSlot}`,
            );
          } else {
            requestRecords.set(request, record);
          }
        }
        setLastSlotRecord(tile, contentSlot, record);
        pushEvent({
          type: requestSerial > 1 ? "reissued" : "issued",
          ...requestEventIdentity(record, tile),
          frameNumber: frameNumber(tile),
          requestState: requestStateName(request?.state),
          contentState: contentStateName(tile?._contentState),
          url: record.url,
          issueCount: requestSerial,
          requestObjectObserved: Boolean(request),
        });

        Promise.resolve(fetchPromise).then(
          (arrayBuffer) => {
            const cancelled =
              request?.cancelled === true ||
              request?.state === C.RequestState?.CANCELLED;
            const failed = request?.state === C.RequestState?.FAILED;
            settleRequest(tile, request, arrayBuffer, null, {
              type:
                arrayBuffer != null
                  ? "completed"
                  : failed
                    ? "failed"
                    : cancelled
                      ? "cancelled-settled"
                      : "resolved-without-content",
            });
          },
          (error) => settleRequest(tile, request, null, error),
        );
      }

      Promise.resolve(result).then(
        (contents) => {
          const indexedContents = Array.isArray(contents) ? contents : [];
          // Multiple3DTileContent returns an indexed array after content
          // factory completion. A fulfilled non-array result is its exact
          // generation-wide cancellation/discard signal, including scheduler-
          // initiated cancellation that bypasses cancelRequests().
          const groupDiscarded = !Array.isArray(contents);
          for (let index = 0; index < groupRecords.length; index++) {
            const record = groupRecords[index];
            if (!record) {
              continue;
            }
            const content = indexedContents[index];
            if (groupDiscarded) {
              const request = record.requestObject;
              if (
                record.terminalType === "completed" &&
                request &&
                (request.cancelled === true ||
                  request.state === C.RequestState?.CANCELLED)
              ) {
                recordCancellationNoop(
                  tile,
                  request,
                  "generation-discarded-after-completion",
                );
              }
              recordContentOutcome(tile, record, "content-discarded");
            } else if (content != null) {
              recordContentOutcome(tile, record, "content-created", content);
            } else if (record.terminalType === "completed") {
              recordContentOutcome(tile, record, "content-factory-failed");
            } else if (record.terminalType === "cancelled-settled") {
              recordContentOutcome(tile, record, "content-discarded");
            } else {
              recordContentOutcome(tile, record, "content-unavailable");
            }
          }
        },
        () => {
          for (const record of groupRecords) {
            if (record) {
              recordContentOutcome(tile, record, "content-unavailable");
            }
          }
        },
      );
      return result;
    };

    multipleContentPrototype.cancelRequests = function (...args) {
      if (!active || !trackedTilesets.has(this?._tileset)) {
        return originalMultipleCancelRequests.apply(this, args);
      }
      const tile = this._tile;
      const requests = [...(this._requests || [])];
      const result = originalMultipleCancelRequests.apply(this, args);
      for (const request of requests) {
        if (
          request &&
          (request.cancelled === true ||
            request.state === C.RequestState?.CANCELLED)
        ) {
          if (requestRecords.get(request)?.terminalType != null) {
            recordCancellationNoop(tile, request, "out-of-view-group");
          } else {
            recordCancellation(tile, request, "out-of-view-group");
          }
        }
      }
      return result;
    };

    modelContentPrototype.update = function (...args) {
      if (!active || !trackedTilesets.has(this?._tileset)) {
        return originalModelUpdate.apply(this, args);
      }
      const result = originalModelUpdate.apply(this, args);
      if (this?._model?.ready === true && !observedModelReady.has(this)) {
        observedModelReady.add(this);
        totals.modelReadyEvents++;
        emitModelEvent("model-ready", this);
      }
      if (this.ready === true && !observedContentReady.has(this)) {
        observedContentReady.add(this);
        totals.contentReadyEvents++;
        emitModelEvent("content-ready", this);
      }
      return result;
    };

    modelContentPrototype.destroy = function (...args) {
      if (
        active &&
        trackedTilesets.has(this?._tileset) &&
        this.ready !== true &&
        !observedModelDestroyed.has(this)
      ) {
        observedModelDestroyed.add(this);
        totals.modelDestroyedBeforeReadyEvents++;
        emitModelEvent("model-destroyed-before-ready", this);
      }
      return originalModelDestroy.apply(this, args);
    };
  }

  requestContentPrototype.requestContent = function (...args) {
    if (!active || !trackedTilesets.has(this?._tileset)) {
      return originalRequestContent.apply(this, args);
    }
    if (schemaVersion === 2 && this?.hasMultipleContents === true) {
      // Schema 2 observes the actual per-slot Request objects inside
      // Multiple3DTileContent. Recording this outer group as one request would
      // recreate the v1 blind spot and double-count every network operation.
      return originalRequestContent.apply(this, args);
    }
    totals.requestAttempts++;
    const currentContentKind = contentKind(this);
    if (currentContentKind === "multiple") {
      totals.multipleContentRequestAttempts++;
    }
    const attemptSerial = (tileAttemptCounts.get(this) || 0) + 1;
    tileAttemptCounts.set(this, attemptSerial);
    const result = originalRequestContent.apply(this, args);
    const request = this._request;
    if (result == null) {
      totals.requestSchedulingDeferrals++;
      pushEvent({
        type: "scheduling-deferred",
        requestId: null,
        tile: tileIdentity(this),
        contentKind: currentContentKind,
        contentSlot: "single",
        requestSerial: null,
        attemptSerial,
        frameNumber: frameNumber(this),
        requestState: requestStateName(request?.state),
        contentState: contentStateName(this._contentState),
      });
      return result;
    }

    const issueCount = (tileIssueCounts.get(this) || 0) + 1;
    tileIssueCounts.set(this, issueCount);
    totals.requestsIssued++;
    const previousRecord = lastIssuedRecords.get(this);
    if (issueCount > 1) {
      totals.requestsReissued++;
      if (previousRecord?.terminalType === "cancelled-settled") {
        totals.requestsReissuedAfterCancellation++;
      }
    }
    const record = {
      requestId: nextRequestId++,
      tile: tileIdentity(this),
      contentKind: currentContentKind,
      contentSlot: "single",
      requestSerial: issueCount,
      attemptSerial,
      ...(schemaVersion === 2
        ? {
            groupSerial: null,
            groupSize: null,
            tileObject: this,
            reissueAfterCancellationCounted:
              previousRecord?.terminalType === "cancelled-settled",
          }
        : {
            reissueAfterCancellationCounted:
              previousRecord?.terminalType === "cancelled-settled",
          }),
      url: canonicalResourceUrl(this),
      cancelled: false,
    };
    if (previousRecord) {
      previousRecord.successor = record;
    }
    if (request) {
      requestRecords.set(request, record);
    }
    lastIssuedRecords.set(this, record);
    if (schemaVersion === 2) {
      setLastSlotRecord(this, "single", record);
    }
    pushEvent({
      type: issueCount > 1 ? "reissued" : "issued",
      ...requestEventIdentity(record, this),
      frameNumber: frameNumber(this),
      requestState: requestStateName(request?.state),
      contentState: contentStateName(this._contentState),
      url: record.url,
      issueCount,
      requestObjectObserved: Boolean(request),
    });
    Promise.resolve(result).then(
      (content) =>
        settleRequest(this, request, content, null, {
          contentCreated: schemaVersion === 2 && content != null,
        }),
      (error) => settleRequest(this, request, null, error),
    );
    return result;
  };

  requestContentPrototype.cancelRequests = function (...args) {
    if (!active || !trackedTilesets.has(this?._tileset)) {
      return originalCancelRequests.apply(this, args);
    }
    const request = this._request;
    const result = originalCancelRequests.apply(this, args);
    recordCancellation(this, request, "out-of-view");
    return result;
  };

  for (const tileset of tilesets) {
    if (typeof tileset?.tileLoad?.addEventListener !== "function") {
      continue;
    }
    removeTileLoadListeners.push(
      // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
      tileset.tileLoad.addEventListener((tile) => {
        if (!active) {
          return;
        }
        totals.tileReadyEvents++;
        if (schemaVersion === 2) {
          const records = [...(lastSlotRecords.get(tile)?.values() || [])]
            .filter(Boolean)
            .sort((left, right) =>
              left.contentSlot.localeCompare(right.contentSlot),
            );
          if (records.length === 0) {
            emitAmbiguity(
              tile,
              tile,
              "tile-ready could not be joined to a request generation",
            );
          }
          pushEvent({
            type: "tile-ready",
            tile: tileIdentity(tile),
            contentKind: contentKind(tile),
            contentSlot: contentKind(tile) === "multiple" ? "group" : "single",
            frameNumber: frameNumber(tile),
            requests: records.map((record) => ({
              contentSlot: record.contentSlot,
              requestSerial: record.requestSerial,
              groupSerial: record.groupSerial,
            })),
            contentState: contentStateName(tile?._contentState),
            geometryBytes: tile?.content?.geometryByteLength ?? null,
            textureBytes: tile?.content?.texturesByteLength ?? null,
            batchTableBytes: tile?.content?.batchTableByteLength ?? null,
          });
        } else {
          pushEvent({
            type: "ready",
            ...requestEventIdentity(requestRecords.get(tile?._request), tile),
            frameNumber: frameNumber(tile),
            contentState: contentStateName(tile?._contentState),
            geometryBytes: tile?.content?.geometryByteLength ?? null,
            textureBytes: tile?.content?.texturesByteLength ?? null,
            batchTableBytes: tile?.content?.batchTableByteLength ?? null,
          });
        }
      }),
    );
  }

  return {
    sampleFrame(segmentIndex, routeProgress) {
      if (!active || frames.length >= frameLimit) {
        framesTruncated ||= active;
        return false;
      }
      identities.refresh();
      const tilesetFrames = [];
      const allSelected = [];
      const allReady = [];
      let identityListsTruncated = false;
      for (
        let tilesetIndex = 0;
        tilesetIndex < tilesets.length;
        tilesetIndex++
      ) {
        const tileset = tilesets[tilesetIndex];
        const allTiles = [];
        collectRepresentativeTiles(tileset?._root, allTiles);
        const ready = allTiles
          .filter(isRepresentativeContentReadyTile)
          .map((tile) => identities.get(tile)?.id ?? "unidentified")
          .sort();
        const selectedTiles = tileset?._selectedTiles || [];
        const selectedDetails = selectedTiles
          .map((tile) => ({
            id: identities.get(tile)?.id ?? "unidentified",
            ready: tile.contentReady === true,
            contentState: contentStateName(tile._contentState),
            requestState: requestStateName(tile._request?.state),
            selectedFrame: tile._selectedFrame ?? null,
            requestedFrame: tile._requestedFrame ?? null,
            touchedFrame: tile._touchedFrame ?? null,
            visible: tile._visible === true,
            screenSpaceError: Number.isFinite(tile._screenSpaceError)
              ? Number(tile._screenSpaceError.toFixed(6))
              : null,
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
        const selected = selectedDetails.map((entry) => entry.id);
        const requestedInFlight = (tileset?._requestedTilesInFlight || [])
          .map((tile) => identities.get(tile)?.id ?? "unidentified")
          .sort();
        const requestedThisFrame = (tileset?._requestedTiles || [])
          .map((tile) => identities.get(tile)?.id ?? "unidentified")
          .sort();
        const processing = (tileset?._processingQueue || [])
          .map((tile) => identities.get(tile)?.id ?? "unidentified")
          .sort();
        allSelected.push(...selected);
        allReady.push(...ready);
        identityListsTruncated ||=
          selected.length > tilesetLifecycleIdentityListLimit ||
          ready.length > tilesetLifecycleIdentityListLimit ||
          requestedInFlight.length > tilesetLifecycleIdentityListLimit ||
          requestedThisFrame.length > tilesetLifecycleIdentityListLimit ||
          processing.length > tilesetLifecycleIdentityListLimit;
        tilesetFrames.push({
          tilesetIndex,
          selectedCount: selected.length,
          selected: selected.slice(0, tilesetLifecycleIdentityListLimit),
          selectedDetails: selectedDetails.slice(
            0,
            tilesetLifecycleIdentityListLimit,
          ),
          readyCount: ready.length,
          ready: ready.slice(0, tilesetLifecycleIdentityListLimit),
          requestedInFlightCount: requestedInFlight.length,
          requestedInFlight: requestedInFlight.slice(
            0,
            tilesetLifecycleIdentityListLimit,
          ),
          requestedThisFrameCount: requestedThisFrame.length,
          requestedThisFrame: requestedThisFrame.slice(
            0,
            tilesetLifecycleIdentityListLimit,
          ),
          processingCount: processing.length,
          processing: processing.slice(0, tilesetLifecycleIdentityListLimit),
          statisticsSelected: tileset?.statistics?.selected ?? null,
          statisticsReady:
            tileset?.statistics?.numberOfTilesWithContentReady ?? null,
          tilesLoaded: tileset?.tilesLoaded === true,
        });
      }
      allSelected.sort();
      allReady.sort();
      frames.push({
        index: frames.length,
        segmentIndex,
        routeProgress,
        selectedIdentitySignature: lifecycleIdentitySignature(allSelected),
        readyIdentitySignature: lifecycleIdentitySignature(allReady),
        selectedCount: allSelected.length,
        readyCount: allReady.length,
        identityListsTruncated,
        tilesets: tilesetFrames,
      });
      return true;
    },

    snapshot(provenance = null) {
      const snapshot = {
        schemaVersion,
        enabled: true,
        nonCertifying: true,
        provenance,
        limits: {
          events: eventLimit,
          frames: frameLimit,
          identityList: tilesetLifecycleIdentityListLimit,
        },
        totals: { ...totals },
        eventsTruncated,
        framesTruncated,
        events: events.map((event) => ({ ...event })),
        frames: frames.map((frame) => structuredClone(frame)),
      };
      snapshot.requestLedger =
        createRepresentativeTilesetRequestLedger(snapshot);
      return snapshot;
    },

    destroy() {
      if (!active) {
        return;
      }
      active = false;
      requestContentPrototype.requestContent = originalRequestContent;
      requestContentPrototype.cancelRequests = originalCancelRequests;
      if (schemaVersion === 2) {
        multipleContentPrototype.requestInnerContents =
          originalRequestInnerContents;
        multipleContentPrototype.cancelRequests =
          originalMultipleCancelRequests;
        modelContentPrototype.update = originalModelUpdate;
        modelContentPrototype.destroy = originalModelDestroy;
      }
      for (const remove of removeTileLoadListeners) {
        remove();
      }
    },
  };
}

const representativeFingerprintMetricNames = Object.freeze([
  "terrainTilesToRender",
  "terrainMeshTiles",
  "terrainSelectionIdentityA",
  "terrainSelectionIdentityB",
  "terrainUnidentifiedTiles",
  "directModelInstancesConfigured",
  "directModelInstancesReady",
  "directModelIdentityA",
  "directModelIdentityB",
  "tilesetsWithSelection",
  "tilesetSelected",
  "tilesetSelectionIdentityA",
  "tilesetSelectionIdentityB",
  "tilesetSelectionCountMismatch",
  "tilesetUnidentifiedSelected",
  // C11-205 ready-tile identity. Selection alone cannot establish that two
  // renderer legs did the same work: the SF pair that failed on 2026-07-31 had
  // 710/571 ready tiles behind 15/12 selected. Ready identity is therefore an
  // ordinary member of the post-measurement fingerprint, not opt-in evidence.
  // Append-only — the per-metric hash salt is the array index.
  "tilesetsWithReadyContent",
  "tilesetContentReady",
  "tilesetReadyIdentityA",
  "tilesetReadyIdentityB",
  "tilesetReadyCountMismatch",
  "tilesetUnidentifiedReady",
]);

const fingerprintHashSeedA = 0x811c9dc5;
const fingerprintHashSeedB = 0x9e3779b9;
const fingerprintHashPrime = 0x01000193;
// Odd seed for the multiplicative ready-set hash. Odd residues mod 2^32 form a
// group under `Math.imul`, so the product can neither absorb to zero nor lose
// earlier factors however many tiles are folded in.
const fingerprintMultiplicativeSeed = 0x27d4eb2f;
// A malformed or cyclic tile graph must not be able to wedge the untimed
// replay. Truncating the walk leaves ready tiles unidentified, which the
// count-vs-set gate rejects — it never certifies a partial set.
const representativeTileWalkNodeLimit = 131072;

function mixFingerprintInteger(hash, value) {
  let result = hash >>> 0;
  const word = value >>> 0;
  for (let byteIndex = 0; byteIndex < 4; byteIndex++) {
    result ^= (word >>> (byteIndex * 8)) & 0xff;
    result = Math.imul(result, fingerprintHashPrime) >>> 0;
  }
  return result;
}

function createFingerprintBucket(segmentIndex = null) {
  return {
    segmentIndex,
    frameCount: 0,
    hashA: fingerprintHashSeedA,
    hashB: fingerprintHashSeedB,
    metrics: Object.fromEntries(
      representativeFingerprintMetricNames.map((name) => [
        name,
        {
          total: 0,
          min: Number.POSITIVE_INFINITY,
          max: Number.NEGATIVE_INFINITY,
        },
      ]),
    ),
  };
}

function observeFingerprintBucket(bucket, sample) {
  bucket.frameCount++;
  bucket.hashA = mixFingerprintInteger(bucket.hashA, sample.segmentIndex);
  bucket.hashB = mixFingerprintInteger(
    bucket.hashB,
    sample.segmentIndex ^ 0x85ebca6b,
  );
  for (
    let index = 0;
    index < representativeFingerprintMetricNames.length;
    index++
  ) {
    const name = representativeFingerprintMetricNames[index];
    const value = sample[name];
    bucket.hashA = mixFingerprintInteger(bucket.hashA, value);
    bucket.hashB = mixFingerprintInteger(
      bucket.hashB,
      value ^ Math.imul(index + 1, 0x27d4eb2d),
    );
    const metric = bucket.metrics[name];
    metric.total += value;
    metric.min = Math.min(metric.min, value);
    metric.max = Math.max(metric.max, value);
  }
}

function snapshotFingerprintBucket(bucket) {
  const hex = (value) => (value >>> 0).toString(16).padStart(8, "0");
  return {
    ...(bucket.segmentIndex === null
      ? {}
      : { segmentIndex: bucket.segmentIndex }),
    frameCount: bucket.frameCount,
    signature: `${hex(bucket.hashA)}-${hex(bucket.hashB)}`,
    metrics: Object.fromEntries(
      representativeFingerprintMetricNames.map((name) => {
        const metric = bucket.metrics[name];
        return [
          name,
          {
            total: metric.total,
            min: bucket.frameCount > 0 ? metric.min : null,
            max: bucket.frameCount > 0 ? metric.max : null,
          },
        ];
      }),
    ),
  };
}

/**
 * Build a bounded fingerprint of the renderer-neutral work selected on every
 * deterministic route-replay frame. The two rolling hashes preserve frame
 * order without retaining a per-frame object graph; per-segment totals make a
 * mismatch diagnosable in the JSON report.
 */
export function createRepresentativeWorkloadFingerprintAccumulator() {
  const overall = createFingerprintBucket();
  const segments = new Map();
  let invalidSampleCount = 0;
  let firstInvalidSampleReason = null;

  return {
    observe(sample) {
      if (
        !sample ||
        !Number.isInteger(sample.segmentIndex) ||
        sample.segmentIndex < 0
      ) {
        invalidSampleCount++;
        firstInvalidSampleReason ??=
          "segmentIndex must be a non-negative integer";
        return false;
      }
      for (const name of representativeFingerprintMetricNames) {
        if (!Number.isInteger(sample[name]) || sample[name] < 0) {
          invalidSampleCount++;
          firstInvalidSampleReason ??= `${name} must be a non-negative integer`;
          return false;
        }
      }

      let segment = segments.get(sample.segmentIndex);
      if (!segment) {
        segment = createFingerprintBucket(sample.segmentIndex);
        segments.set(sample.segmentIndex, segment);
      }
      observeFingerprintBucket(overall, sample);
      observeFingerprintBucket(segment, sample);
      return true;
    },

    snapshot() {
      const reasons = [];
      if (overall.frameCount < 1) {
        reasons.push(
          "no route-replay workload-fingerprint frames were observed",
        );
      }
      if (invalidSampleCount > 0) {
        reasons.push(
          `${invalidSampleCount} invalid workload-fingerprint samples` +
            (firstInvalidSampleReason ? ` (${firstInvalidSampleReason})` : ""),
        );
      }
      return {
        schemaVersion: 1,
        valid: reasons.length === 0,
        reasons,
        invalidSampleCount,
        ...snapshotFingerprintBucket(overall),
        segments: [...segments.values()]
          .sort((left, right) => left.segmentIndex - right.segmentIndex)
          .map(snapshotFingerprintBucket),
      };
    },
  };
}

export function createRepresentativeEvidenceTracker(scene, terrain, assets) {
  const directModels = new Set(assets.models);
  const directModelIdentities = new WeakMap(
    assets.models.map((model, index) => [
      model,
      {
        a: mixFingerprintInteger(fingerprintHashSeedA, index + 1),
        b: mixFingerprintInteger(fingerprintHashSeedB, index + 1),
      },
    ]),
  );
  const modelOwnersSeen = new Set();
  const tilesetsWithCommands = new Set();
  const tilesetsWithSelection = new Set();
  const tilesetsWithReadyContent = new Set();
  const tileIdentities = new WeakMap();
  // Both path recurrences are pure functions of (tilesetIndex, child-index
  // path), so the same tile earns the same identity on both renderer legs and
  // at any point during subtree loading. The B recurrence deliberately does NOT
  // read `children.length`: 3D Tiles children materialize as subtrees load, so
  // a sibling-count-dependent hash would give one tile two identities on two
  // legs that first observed it at different load states, and a false ready-set
  // rejection is just as wrong an answer as a false pass.
  const childPathHashA = (pathHash, childIndex) =>
    mixFingerprintInteger(pathHash, childIndex + 1);
  const childPathHashB = (pathHash, childIndex, depth) =>
    mixFingerprintInteger(
      pathHash,
      (Math.imul(childIndex + 1, 0x85ebca6b) ^ (depth + 1)) >>> 0,
    );
  // Re-walked on every sampled frame rather than only at construction, because
  // a tile that appeared after construction would otherwise be permanently
  // unidentified.
  const refreshTilesetTileIdentities = (tilesetIndex) => {
    const root = assets.tilesets[tilesetIndex]?._root;
    if (!root) {
      return;
    }
    const rootPathHash = tilesetIndex + 1;
    const stack = [
      {
        tile: root,
        pathHashA: rootPathHash,
        pathHashB: rootPathHash,
        depth: 0,
      },
    ];
    let visited = 0;
    while (stack.length > 0 && visited < representativeTileWalkNodeLimit) {
      const entry = stack.pop();
      visited++;
      tileIdentities.set(entry.tile, {
        a: mixFingerprintInteger(
          mixFingerprintInteger(fingerprintHashSeedA, tilesetIndex),
          entry.pathHashA,
        ),
        b: mixFingerprintInteger(
          mixFingerprintInteger(fingerprintHashSeedB, tilesetIndex),
          entry.pathHashB,
        ),
      });
      const children = entry.tile.children || [];
      for (let childIndex = 0; childIndex < children.length; childIndex++) {
        const child = children[childIndex];
        if (!child) continue;
        stack.push({
          tile: child,
          pathHashA: childPathHashA(entry.pathHashA, childIndex),
          pathHashB: childPathHashB(entry.pathHashB, childIndex, entry.depth),
          depth: entry.depth + 1,
        });
      }
    }
  };
  for (let index = 0; index < assets.tilesets.length; index++) {
    refreshTilesetTileIdentities(index);
  }
  const workloadFingerprint =
    createRepresentativeWorkloadFingerprintAccumulator();
  const workloadFingerprintSample = {
    segmentIndex: 0,
    terrainTilesToRender: 0,
    terrainMeshTiles: 0,
    terrainSelectionIdentityA: 0,
    terrainSelectionIdentityB: 0,
    terrainUnidentifiedTiles: 0,
    directModelInstancesConfigured: 0,
    directModelInstancesReady: 0,
    directModelIdentityA: 0,
    directModelIdentityB: 0,
    tilesetsWithSelection: 0,
    tilesetSelected: 0,
    tilesetSelectionIdentityA: 0,
    tilesetSelectionIdentityB: 0,
    tilesetSelectionCountMismatch: 0,
    tilesetUnidentifiedSelected: 0,
    tilesetsWithReadyContent: 0,
    tilesetContentReady: 0,
    tilesetReadyIdentityA: 0,
    tilesetReadyIdentityB: 0,
    tilesetReadyCountMismatch: 0,
    tilesetUnidentifiedReady: 0,
  };
  const terrainDiagnosticsStart = terrain.snapshotDiagnostics();
  const evidence = {
    sampledFrames: 0,
    terrainMeshFrames: 0,
    terrainWaterMaskTextureFrames: 0,
    terrainMixedWaterMaskFrames: 0,
    waterEffectFrames: 0,
    directModelCommandFrames: 0,
    tilesetCommandFrames: 0,
    allContentCommandFrames: 0,
    maximumTerrainTiles: 0,
    maximumSelectedTerrainLevel: -1,
    maximumDirectTerrainLevel: -1,
    maximumUpsampledTerrainLevel: -1,
    maximumTerrainHeightSpan: 0,
    maximumDirectModelCommands: 0,
    maximumTilesetCommands: 0,
    maximumTilesetSelected: 0,
    maximumTilesetContentReady: 0,
  };

  return {
    sampleWorkloadFingerprint(segmentIndex) {
      const terrainTiles = scene.globe?._surface?._tilesToRender || [];
      let terrainMeshTiles = 0;
      let terrainSelectionIdentityA = 0;
      let terrainSelectionIdentityB = 0;
      let terrainUnidentifiedTiles = 0;
      for (const tile of terrainTiles) {
        const surfaceTile = tile?.data;
        if (
          surfaceTile?.renderedMesh ||
          surfaceTile?.mesh ||
          surfaceTile?.fill?.mesh
        ) {
          terrainMeshTiles++;
        }
        if (
          Number.isInteger(tile?.x) &&
          Number.isInteger(tile?.y) &&
          Number.isInteger(tile?.level)
        ) {
          let tileIdentityA = mixFingerprintInteger(
            fingerprintHashSeedA,
            tile.level,
          );
          tileIdentityA = mixFingerprintInteger(tileIdentityA, tile.x);
          tileIdentityA = mixFingerprintInteger(tileIdentityA, tile.y);
          let tileIdentityB = mixFingerprintInteger(
            fingerprintHashSeedB,
            tile.y,
          );
          tileIdentityB = mixFingerprintInteger(tileIdentityB, tile.x);
          tileIdentityB = mixFingerprintInteger(tileIdentityB, tile.level);
          terrainSelectionIdentityA =
            (terrainSelectionIdentityA + tileIdentityA) >>> 0;
          terrainSelectionIdentityB =
            (terrainSelectionIdentityB + tileIdentityB) >>> 0;
        } else {
          terrainUnidentifiedTiles++;
        }
      }

      // Fingerprint the logical model instances supplied to both renderers,
      // not renderer-specific command emission. WebGPU deliberately rejects
      // off-frustum Models before producing commands while WebGL currently
      // leaves those commands for the later visibility stage; that is the
      // optimization this benchmark is intended to measure, not unequal input.
      let directModelInstancesReady = 0;
      let directModelIdentityA = 0;
      let directModelIdentityB = 0;
      for (const model of assets.models) {
        if (model.ready !== true) {
          continue;
        }
        directModelInstancesReady++;
        const identity = directModelIdentities.get(model);
        directModelIdentityA = (directModelIdentityA + identity.a) >>> 0;
        directModelIdentityB = (directModelIdentityB + identity.b) >>> 0;
      }

      // Readiness is the seam C11-205 exists to close, so it is measured from
      // three sources the engine maintains independently of each other: the
      // scalar `numberOfTilesWithContentReady` counter, the resident-content
      // cache list, and the tile graph the path identities are derived from.
      // A disagreement between any two of them is reported, never reconciled.
      //
      // Both aggregations are order-independent by construction because the
      // cache list is ordered by selection recency, which legitimately differs
      // between legs. They are also algebraically independent of each other —
      // an additive multiset hash over path hash A and a multiplicative one
      // over path hash B — so a collision in one cannot silently validate a
      // ready set that the other rejects.
      let tilesetsWithSelectionThisFrame = 0;
      let tilesetsWithReadyContentThisFrame = 0;
      let tilesetSelected = 0;
      let tilesetSelectionIdentityA = 0;
      let tilesetSelectionIdentityB = 0;
      let tilesetSelectionCountMismatch = 0;
      let tilesetUnidentifiedSelected = 0;
      let tilesetContentReady = 0;
      let tilesetReadyIdentityA = 0;
      let tilesetReadyIdentityB = fingerprintMultiplicativeSeed;
      let tilesetReadyCountMismatch = 0;
      let tilesetUnidentifiedReady = 0;
      for (
        let tilesetIndex = 0;
        tilesetIndex < assets.tilesets.length;
        tilesetIndex++
      ) {
        const tileset = assets.tilesets[tilesetIndex];
        refreshTilesetTileIdentities(tilesetIndex);

        let readyThisTileset = 0;
        let cacheNode = tileset._cache?._list?.head;
        let visitedCacheNodes = 0;
        while (
          cacheNode &&
          visitedCacheNodes < representativeTileWalkNodeLimit
        ) {
          visitedCacheNodes++;
          const readyTile = cacheNode.item;
          cacheNode = cacheNode.next;
          if (!isRepresentativeContentReadyTile(readyTile)) {
            continue;
          }
          readyThisTileset++;
          const identity = tileIdentities.get(readyTile);
          if (identity) {
            tilesetReadyIdentityA = (tilesetReadyIdentityA + identity.a) >>> 0;
            tilesetReadyIdentityB =
              Math.imul(tilesetReadyIdentityB, identity.b | 1) >>> 0;
          } else {
            tilesetUnidentifiedReady++;
          }
        }
        tilesetContentReady += readyThisTileset;
        tilesetReadyCountMismatch += Math.abs(
          (tileset.statistics?.numberOfTilesWithContentReady || 0) -
            readyThisTileset,
        );
        if (readyThisTileset > 0) tilesetsWithReadyContentThisFrame++;

        const selected = tileset.statistics?.selected || 0;
        const selectedTiles = tileset._selectedTiles || [];
        tilesetSelected += selected;
        tilesetSelectionCountMismatch += Math.abs(
          selected - selectedTiles.length,
        );
        for (const selectedTile of selectedTiles) {
          const identity = tileIdentities.get(selectedTile);
          if (identity) {
            tilesetSelectionIdentityA =
              (tilesetSelectionIdentityA + identity.a) >>> 0;
            tilesetSelectionIdentityB =
              (tilesetSelectionIdentityB + identity.b) >>> 0;
          } else {
            tilesetUnidentifiedSelected++;
          }
        }
        if (selected > 0) tilesetsWithSelectionThisFrame++;
      }

      workloadFingerprintSample.segmentIndex = segmentIndex;
      workloadFingerprintSample.terrainTilesToRender = terrainTiles.length;
      workloadFingerprintSample.terrainMeshTiles = terrainMeshTiles;
      workloadFingerprintSample.terrainSelectionIdentityA =
        terrainSelectionIdentityA;
      workloadFingerprintSample.terrainSelectionIdentityB =
        terrainSelectionIdentityB;
      workloadFingerprintSample.terrainUnidentifiedTiles =
        terrainUnidentifiedTiles;
      workloadFingerprintSample.directModelInstancesConfigured =
        assets.models.length;
      workloadFingerprintSample.directModelInstancesReady =
        directModelInstancesReady;
      workloadFingerprintSample.directModelIdentityA = directModelIdentityA;
      workloadFingerprintSample.directModelIdentityB = directModelIdentityB;
      workloadFingerprintSample.tilesetsWithSelection =
        tilesetsWithSelectionThisFrame;
      workloadFingerprintSample.tilesetSelected = tilesetSelected;
      workloadFingerprintSample.tilesetSelectionIdentityA =
        tilesetSelectionIdentityA;
      workloadFingerprintSample.tilesetSelectionIdentityB =
        tilesetSelectionIdentityB;
      workloadFingerprintSample.tilesetSelectionCountMismatch =
        tilesetSelectionCountMismatch;
      workloadFingerprintSample.tilesetUnidentifiedSelected =
        tilesetUnidentifiedSelected;
      workloadFingerprintSample.tilesetsWithReadyContent =
        tilesetsWithReadyContentThisFrame;
      workloadFingerprintSample.tilesetContentReady = tilesetContentReady;
      workloadFingerprintSample.tilesetReadyIdentityA = tilesetReadyIdentityA;
      workloadFingerprintSample.tilesetReadyIdentityB = tilesetReadyIdentityB;
      workloadFingerprintSample.tilesetReadyCountMismatch =
        tilesetReadyCountMismatch;
      workloadFingerprintSample.tilesetUnidentifiedReady =
        tilesetUnidentifiedReady;
      return workloadFingerprint.observe(workloadFingerprintSample);
    },

    sample() {
      evidence.sampledFrames++;
      const terrainTiles = scene.globe?._surface?._tilesToRender || [];
      let meshTiles = 0;
      let waterMaskTextures = 0;
      let mixedWaterMasks = 0;
      let maximumLevel = -1;
      let maximumDirectLevel = -1;
      let maximumUpsampledLevel = -1;
      let maximumHeightSpan = 0;
      for (const tile of terrainTiles) {
        const surfaceTile = tile?.data;
        const mesh =
          surfaceTile?.renderedMesh ||
          surfaceTile?.mesh ||
          surfaceTile?.fill?.mesh;
        if (mesh) {
          meshTiles++;
          const span = mesh.maximumHeight - mesh.minimumHeight;
          if (Number.isFinite(span)) {
            maximumHeightSpan = Math.max(maximumHeightSpan, span);
          }
        }
        if (surfaceTile?.waterMaskTexture) {
          waterMaskTextures++;
        }
        if (
          surfaceTile?.waterMaskTexture &&
          surfaceTile?.terrainData?.waterMask?.length > 1
        ) {
          mixedWaterMasks++;
        }
        const tileLevel = tile?.level ?? -1;
        maximumLevel = Math.max(maximumLevel, tileLevel);
        if (terrain.ownsTerrainData(surfaceTile?.terrainData)) {
          maximumDirectLevel = Math.max(maximumDirectLevel, tileLevel);
        } else if (
          surfaceTile?.terrainData?.wasCreatedByUpsampling?.() === true
        ) {
          maximumUpsampledLevel = Math.max(maximumUpsampledLevel, tileLevel);
        }
      }
      if (meshTiles > 0) evidence.terrainMeshFrames++;
      if (waterMaskTextures > 0) {
        evidence.terrainWaterMaskTextureFrames++;
      }
      if (mixedWaterMasks > 0) {
        evidence.terrainMixedWaterMaskFrames++;
      }
      if (scene.globe?._surface?.tileProvider?.showWaterEffect === true) {
        evidence.waterEffectFrames++;
      }
      evidence.maximumTerrainTiles = Math.max(
        evidence.maximumTerrainTiles,
        terrainTiles.length,
      );
      evidence.maximumSelectedTerrainLevel = Math.max(
        evidence.maximumSelectedTerrainLevel,
        maximumLevel,
      );
      evidence.maximumDirectTerrainLevel = Math.max(
        evidence.maximumDirectTerrainLevel,
        maximumDirectLevel,
      );
      evidence.maximumUpsampledTerrainLevel = Math.max(
        evidence.maximumUpsampledTerrainLevel,
        maximumUpsampledLevel,
      );
      evidence.maximumTerrainHeightSpan = Math.max(
        evidence.maximumTerrainHeightSpan,
        maximumHeightSpan,
      );

      let directModelCommands = 0;
      for (const command of scene.frameState?.commandList || []) {
        if (directModels.has(command?.owner)) {
          directModelCommands++;
          modelOwnersSeen.add(command.owner);
        }
      }
      if (directModelCommands > 0) {
        evidence.directModelCommandFrames++;
      }
      evidence.maximumDirectModelCommands = Math.max(
        evidence.maximumDirectModelCommands,
        directModelCommands,
      );

      let tilesetCommands = 0;
      let tilesetSelected = 0;
      let tilesetContentReady = 0;
      for (let index = 0; index < assets.tilesets.length; index++) {
        const tileset = assets.tilesets[index];
        const commandCount = tileset.statistics?.numberOfCommands || 0;
        const selectedCount = tileset.statistics?.selected || 0;
        const readyContentCount =
          tileset.statistics?.numberOfTilesWithContentReady || 0;
        tilesetCommands += commandCount;
        tilesetSelected += selectedCount;
        tilesetContentReady += readyContentCount;
        if (commandCount > 0) tilesetsWithCommands.add(index);
        if (selectedCount > 0) tilesetsWithSelection.add(index);
        if (readyContentCount > 0) {
          tilesetsWithReadyContent.add(index);
        }
      }
      if (tilesetCommands > 0) {
        evidence.tilesetCommandFrames++;
      }
      if (directModelCommands > 0 && tilesetCommands > 0 && meshTiles > 0) {
        evidence.allContentCommandFrames++;
      }
      evidence.maximumTilesetCommands = Math.max(
        evidence.maximumTilesetCommands,
        tilesetCommands,
      );
      evidence.maximumTilesetSelected = Math.max(
        evidence.maximumTilesetSelected,
        tilesetSelected,
      );
      evidence.maximumTilesetContentReady = Math.max(
        evidence.maximumTilesetContentReady,
        tilesetContentReady,
      );
    },
    snapshot(options = {}) {
      const phase = options.phase || "validation";
      const commandEvidenceRequired = phase !== "prime";
      const terrainDiagnostics = terrain.snapshotDiagnostics();
      terrainDiagnostics.sinceTrackerStart = {
        requestCount:
          terrainDiagnostics.requestCount -
          terrainDiagnosticsStart.requestCount,
        cacheHitCount:
          terrainDiagnostics.cacheHitCount -
          terrainDiagnosticsStart.cacheHitCount,
        tileGenerationCount:
          terrainDiagnostics.tileGenerationCount -
          terrainDiagnosticsStart.tileGenerationCount,
        uniqueTileCount:
          terrainDiagnostics.uniqueTileCount -
          terrainDiagnosticsStart.uniqueTileCount,
        nonFlatTilesGenerated:
          terrainDiagnostics.nonFlatTilesGenerated -
          terrainDiagnosticsStart.nonFlatTilesGenerated,
        waterMasksGenerated: Object.fromEntries(
          Object.keys(terrainDiagnostics.waterMasksGenerated).map((kind) => [
            kind,
            terrainDiagnostics.waterMasksGenerated[kind] -
              terrainDiagnosticsStart.waterMasksGenerated[kind],
          ]),
        ),
      };
      const readyModels = assets.models.filter((model) => model.ready).length;
      const loadedTilesets = assets.tilesets.filter(
        (tileset) => tileset.tilesLoaded,
      ).length;
      const failures = [];
      if (evidence.sampledFrames < 1) {
        failures.push("no representative frames were sampled");
      }
      if (
        terrainDiagnostics.requestCount < 1 ||
        terrainDiagnostics.uniqueTileCount < 2 ||
        terrainDiagnostics.nonFlatTilesGenerated < 1
      ) {
        failures.push(
          "procedural terrain requests did not produce real relief",
        );
      }
      if (
        evidence.terrainMeshFrames < 1 ||
        evidence.maximumTerrainHeightSpan <= 1.0 ||
        terrainDiagnostics.maximumRequestedLevel !==
          terrainDiagnostics.maximumLevel ||
        evidence.maximumDirectTerrainLevel !==
          terrainDiagnostics.maximumLevel ||
        evidence.maximumSelectedTerrainLevel >
          terrainDiagnostics.maximumLevel ||
        evidence.maximumUpsampledTerrainLevel >= 0
      ) {
        failures.push(
          "non-flat terrain meshes did not exercise the configured real-data LOD bound",
        );
      }
      if (
        terrainDiagnostics.waterMasksGenerated.mixed < 1 ||
        evidence.terrainWaterMaskTextureFrames < 1 ||
        evidence.terrainMixedWaterMaskFrames < 1 ||
        evidence.waterEffectFrames < 1
      ) {
        failures.push(
          "mixed terrain water-mask textures never reached the water render path",
        );
      }
      if (
        assets.placement.minimumModelTerrainClearance <= 0 ||
        assets.placement.minimumTilesetTerrainClearance <= 0 ||
        readyModels !== assets.models.length ||
        modelOwnersSeen.size !== assets.models.length
      ) {
        failures.push(
          "terrain-draped local models never became ready and command-producing",
        );
      }
      if (
        tilesetsWithReadyContent.size !== assets.tilesets.length ||
        tilesetsWithSelection.size !== assets.tilesets.length ||
        (commandEvidenceRequired &&
          tilesetsWithCommands.size !== assets.tilesets.length)
      ) {
        failures.push(
          commandEvidenceRequired
            ? "local 3D Tiles never became ready, selected, and command-producing"
            : "local 3D Tiles never became ready and selected during route priming",
        );
      }
      if (assets.placement.minimumTilesetTerrainClearance <= 0) {
        failures.push("local 3D Tiles were not placed above terrain");
      }
      if (commandEvidenceRequired && evidence.allContentCommandFrames < 1) {
        failures.push(
          "terrain, models, and 3D Tiles were never executable in the same frame",
        );
      }

      const workloadFingerprintSnapshot = workloadFingerprint.snapshot();
      return {
        phase,
        valid: failures.length === 0,
        failures,
        configured: {
          models: assets.models.length,
          tilesets: assets.tilesets.length,
        },
        ready: {
          models: readyModels,
          tilesetsLoadedAtSnapshot: loadedTilesets,
        },
        coverage: {
          modelOwnersWithCommands: modelOwnersSeen.size,
          tilesetsWithCommands: tilesetsWithCommands.size,
          tilesetsWithSelection: tilesetsWithSelection.size,
          tilesetsWithReadyContent: tilesetsWithReadyContent.size,
        },
        placement: { ...assets.placement },
        terrainDiagnostics,
        workloadFingerprint:
          workloadFingerprintSnapshot.frameCount > 0
            ? workloadFingerprintSnapshot
            : null,
        ...evidence,
      };
    },
  };
}
