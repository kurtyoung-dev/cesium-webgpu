/**
 * Enumerated keys for feature renderer lookups.
 *
 * Using numeric enum values instead of string keys enables O(1) array-index
 * lookups in {@link GraphicsContext#getFeatureRenderer} — faster than
 * string-keyed Map lookups which require hashing.
 *
 * Scene code uses these constants instead of magic strings:
 * ```javascript
 * import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
 * const fr = context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION);
 * ```
 *
 * @enum {number}
 * @see GraphicsContext
 * @see WebGPUFeatureRenderers
 */
const FeatureRendererKey = {
  // ── Collections ──
  BILLBOARD_COLLECTION: 0,
  POINT_PRIMITIVE_COLLECTION: 1,
  POLYLINE_COLLECTION: 2,
  CLOUD_COLLECTION: 3,

  // ── Primitive system ──
  PRIMITIVE: 4,

  // ── Environment ──
  SUN: 5,
  MOON: 6,
  SKY_ATMOSPHERE: 7,
  FOG: 8,
  CUBE_MAP_PANORAMA: 9,

  // ── Shadow / Ground ──
  SHADOW_MAP: 10,
  GROUND_PRIMITIVE: 11,

  // ── Globe / Terrain ──
  GLOBE_SURFACE: 12,
  GLOBE_TRANSLUCENCY: 13,

  // ── Model ──
  MODEL: 14,

  // ── Advanced features ──
  ELLIPSOID_PRIMITIVE: 15,
  GAUSSIAN_SPLAT: 16,
  POINT_CLOUD: 17,
  POINT_CLOUD_EDL: 18,
  VOXEL_PRIMITIVE: 19,
  INVERT_CLASSIFICATION: 20,

  // ── IBL / Lighting ──
  BRDF_LUT: 21,
  IMAGE_BASED_LIGHTING: 22,
  DYNAMIC_ENVIRONMENT_MAP: 23,

  // ── Clipping ──
  CLIPPING_PLANES: 24,
  CLIPPING_POLYGONS: 25,

  // ── Post-processing ──
  POST_PROCESS_COLLECTION: 26,

  // ── Scene orchestration ──
  SCENE_RENDERER: 27,

  // ── Imagery ──
  IMAGERY_REPROJECTION: 28,

  // ── Atmosphere ──
  GROUND_ATMOSPHERE: 29,

  // ── Screen-space effects ──
  SCREEN_SPACE_REFLECTIONS: 30,

  // ── Weather ──
  WEATHER_PARTICLES: 31,

  // ── Procedural environment ──
  PROCEDURAL_CLOUDS: 32,

  // ── Buffer Primitive collections (v1.140 vector tiles) ──
  BUFFER_POINT_COLLECTION: 33,
  BUFFER_POLYLINE_COLLECTION: 34,
  BUFFER_POLYGON_COLLECTION: 35,

  // ── Label rendering (SDF text) ──
  LABEL_COLLECTION: 36,

  // NOTE: a `DEFERRED_GBUFFER` slot was reserved at index 33 in earlier
  // sessions for a planned deferred renderer. It was never registered and
  // never consumed by any scene code, so it was removed and the subsequent
  // keys were shifted down by one to keep the lookup array dense. If a
  // deferred path is added in the future, append it after LABEL_COLLECTION.

  /**
   * Total number of feature renderer keys (excluding COUNT itself).
   * Must equal the highest enum value + 1. Update when adding new keys.
   * Used to pre-allocate the internal array in GraphicsContext.
   * @type {number}
   */
  COUNT: 37,
};

export default Object.freeze(FeatureRendererKey);
