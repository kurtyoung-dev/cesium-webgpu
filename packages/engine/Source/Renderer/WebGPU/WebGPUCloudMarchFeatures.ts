import { ShaderDefineHi } from "./WebGPUShaderDefines.js";

/**
 * The variant of the cloud march a pipeline request compiles. Each optional
 * feature turns on one high-word shader define; a request that names no
 * feature compiles the march without its optional cache bindings.
 *
 * @private
 */
export interface CloudMarchFeatures {
  /**
   * Draws the progressive-startup preview lighting. The preview compiles no
   * optional feature, whatever the other fields say.
   */
  preview?: boolean;
  /**
   * Reuses the primary integral of the march variant whose high-word defines
   * this carries. The reuse pipeline compiles exactly those defines.
   */
  primaryReuseDefinesHi?: number;
  /** Samples the density moments (`CLOUD_DENSITY_MOMENTS`). */
  moments?: boolean;
  /** Skips empty space with the occupancy grid (`CLOUD_SPATIAL_OCCUPANCY`). */
  spatial?: boolean;
}

/**
 * The cloud cache state that decides which optional march features are live.
 *
 * @private
 */
export interface CloudMarchResourceState {
  densityMomentsEnabled?: boolean;
  spatialOccupancyActive?: boolean;
}

/**
 * The optional march features the cache's resources currently support.
 *
 * @private
 */
export function cloudMarchActiveFeatures(
  cache: CloudMarchResourceState,
): CloudMarchFeatures {
  return {
    moments: cache.densityMomentsEnabled ?? false,
    spatial: cache.spatialOccupancyActive ?? false,
  };
}

/**
 * The high-word defines of the optional features a request names. The preview
 * and the primary-reuse fields select other variants and contribute no bit
 * here.
 *
 * @private
 */
export function cloudMarchFeatureDefines(features: CloudMarchFeatures): number {
  return (
    (features.moments ? ShaderDefineHi.CLOUD_DENSITY_MOMENTS : 0) |
    (features.spatial ? ShaderDefineHi.CLOUD_SPATIAL_OCCUPANCY : 0)
  );
}
