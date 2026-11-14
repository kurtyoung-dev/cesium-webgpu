import { ShaderDefineHi } from "./WebGPUShaderDefines.js";

/**
 * The variant of the cloud march a pipeline request compiles. Each optional
 * feature turns on one high-word shader define; a request that names no
 * feature compiles the march without its optional cache bindings. A request
 * that carries `primaryReuseDefinesHi` or `selectedDefinesHi` names an exact
 * recipe instead, and that recipe takes priority over the feature fields.
 *
 * @private
 */
export interface CloudMarchFeatures {
  /**
   * Draws the progressive-startup preview lighting. The preview compiles no
   * optional feature, whatever the feature fields say; an exact recipe in
   * `primaryReuseDefinesHi` or `selectedDefinesHi` takes priority over it.
   */
  preview?: boolean;
  /**
   * Reuses the primary integral of the march variant whose high-word defines
   * this carries. The reuse pipeline compiles exactly those defines.
   */
  primaryReuseDefinesHi?: number;
  /**
   * Exact high-word recipe of the selected ordinary march. An emitting request
   * reuses this family instead of reselecting features from active resources.
   * Like `primaryReuseDefinesHi`, it selects an exact recipe and takes priority
   * over `preview` and the feature fields; `primaryReuseDefinesHi` in turn takes
   * priority over it.
   */
  selectedDefinesHi?: number;
  /** Samples the density moments (`CLOUD_DENSITY_MOMENTS`). */
  moments?: boolean;
  /** Skips empty space with the occupancy grid (`CLOUD_SPATIAL_OCCUPANCY`). */
  spatial?: boolean;
  /** Also skips columns the weather map leaves empty; needs `spatial` (`CLOUD_WEATHER_VOLUME_BOUNDS`). */
  bounds?: boolean;
  /** Light rays read the filtered density cache (`CLOUD_DENSITY_SAMPLE_CACHE`). */
  density?: boolean;
  /** Lights samples with the directional light march (`CLOUD_DIRECTIONAL_LIGHTING`). */
  directional?: boolean;
  /** Directional lighting reads the deep shadow cache (`CLOUD_DEEP_SHADOW_CACHE`). */
  deep?: boolean;
  /** The primary march also reads the density cache; needs `density` (`CLOUD_PRIMARY_DENSITY_CACHE`). */
  primary?: boolean;
  /** Spends light-march steps by each sample's contribution (`CLOUD_CONTRIBUTION_LIGHTING`). */
  contribution?: boolean;
  /**
   * Blends the previous weather snapshot into the march while a new one fades in
   * (`CLOUD_WEATHER_TRANSITION`). The request drops it unless the noise is baked.
   */
  transition?: boolean;
  /** Reads the regional cloud-top plane of the weather map (`CLOUD_WEATHER_VERTICAL`). */
  vertical?: boolean;
  /** Marches the weather map's independent cloud populations (`CLOUD_WEATHER_POPULATIONS`). */
  populations?: boolean;
}

/**
 * The resource-independent shader recipe surrounding the optional features.
 *
 * @private
 */
export interface CloudMarchRecipe {
  preview: boolean;
  baseMorphology: boolean;
  bakedOnly: boolean;
  geographicWindRequested?: boolean;
  featureDefinesHi: number;
}

/**
 * Combines the noise, morphology, lighting and wind recipe around the features.
 *
 * @private
 */
export function cloudMarchRecipeDefines(recipe: CloudMarchRecipe): number {
  return (
    (recipe.baseMorphology ? ShaderDefineHi.CLOUD_MORPHOLOGY_BASE_ONLY : 0) |
    (recipe.bakedOnly ? ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY : 0) |
    (recipe.preview
      ? ShaderDefineHi.CLOUD_LIGHTING_PREVIEW
      : recipe.featureDefinesHi) |
    (recipe.geographicWindRequested && !recipe.preview
      ? ShaderDefineHi.CLOUD_GEOGRAPHIC_WIND
      : 0)
  );
}

/**
 * The cloud cache state that decides which optional march features are live.
 *
 * @private
 */
export interface CloudMarchResourceState {
  densityMomentsEnabled?: boolean;
  spatialOccupancyActive?: boolean;
  weatherBoundsActive?: boolean;
  densityCacheActive?: boolean;
  directionalLightingRequested?: boolean;
  deepShadowActive?: boolean;
  primaryDensityActive?: boolean;
  contributionLightingActive?: boolean;
  weatherTransitionRequested?: boolean;
  weatherVerticalRequested?: boolean;
  weatherPopulationsRequested?: boolean;
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
    bounds: cache.weatherBoundsActive ?? false,
    density: cache.densityCacheActive ?? false,
    directional: cache.directionalLightingRequested ?? false,
    deep: cache.deepShadowActive ?? false,
    primary: cache.primaryDensityActive ?? false,
    contribution: cache.contributionLightingActive ?? false,
    transition: cache.weatherTransitionRequested ?? false,
    vertical: cache.weatherVerticalRequested ?? false,
    populations: cache.weatherPopulationsRequested ?? false,
  };
}

/**
 * The high-word defines of the optional features a request names. The preview,
 * primary-reuse and selected-recipe fields select other variants and
 * contribute no bit here.
 *
 * @private
 */
export function cloudMarchFeatureDefines(features: CloudMarchFeatures): number {
  return (
    (features.moments ? ShaderDefineHi.CLOUD_DENSITY_MOMENTS : 0) |
    (features.spatial ? ShaderDefineHi.CLOUD_SPATIAL_OCCUPANCY : 0) |
    (features.spatial && features.bounds
      ? ShaderDefineHi.CLOUD_WEATHER_VOLUME_BOUNDS
      : 0) |
    (features.density ? ShaderDefineHi.CLOUD_DENSITY_SAMPLE_CACHE : 0) |
    (features.directional ? ShaderDefineHi.CLOUD_DIRECTIONAL_LIGHTING : 0) |
    (features.deep ? ShaderDefineHi.CLOUD_DEEP_SHADOW_CACHE : 0) |
    (features.density && features.primary
      ? ShaderDefineHi.CLOUD_PRIMARY_DENSITY_CACHE
      : 0) |
    (features.contribution ? ShaderDefineHi.CLOUD_CONTRIBUTION_LIGHTING : 0) |
    (features.transition ? ShaderDefineHi.CLOUD_WEATHER_TRANSITION : 0) |
    (features.vertical ? ShaderDefineHi.CLOUD_WEATHER_VERTICAL : 0) |
    (features.populations ? ShaderDefineHi.CLOUD_WEATHER_POPULATIONS : 0)
  );
}
