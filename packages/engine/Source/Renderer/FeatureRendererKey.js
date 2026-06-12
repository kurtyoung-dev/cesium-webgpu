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
  // RETIRED (Batch 239) — superseded by in-GlobeTerrain.wgsl ground
  // atmosphere (csm_computeGroundAtmosphereScattering + WebGPUAtmosphereLUT,
  // params in the globe camera/tile uniform buffers), matching WebGL's
  // in-GlobeFS integration. The separate-pass WebGPUGroundAtmosphereRenderer
  // was deleted (full Nishita reference in git history at 05b6da60d1).
  // Keys are positional — keep slot 29 reserved; do NOT reuse the number.
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

  // ── Volumetric fog (Phase 5: froxel-grid participating media) ──
  // Allocates a 3D texture pair (scattered light + transmittance),
  // runs three compute passes per frame (density injection, light
  // scattering, ray-march integration), and composites into the
  // scene color before post-processing. See
  // CELESTIAL_ATMOSPHERE_DESIGN.md §4.8.
  VOLUMETRIC_FOG: 37,

  // ── Hi-Z occlusion culling (Phase 3: activated 2026-04-09) ──
  // Builds the Hi-Z pyramid from the previous frame's depth buffer,
  // then tests each command's bounding sphere against the pyramid to
  // decide visibility. Owned by `WebGPUHiZOcclusionDispatcher` on the
  // WebGPU side; consumed by `Scene/OcclusionCulling.js` on the
  // Scene side via the feature renderer registry so Scene code
  // doesn't have to import from `Renderer/WebGPU/`.
  HI_Z_OCCLUSION: 38,

  // ── GPU sort keys (Phase 3: dispatcher landed 2026-04-09) ──
  // Produces packed 64-bit sort keys for >50K draw commands so the
  // subsequent sort pass can reorder commands without a CPU
  // comparator. Owned by `WebGPUGPUSortKeysDispatcher`. Infrastructure
  // only — RenderScheduler still uses the JS multi-level comparator
  // for the common <50K case because the encoder → submit → readback
  // round trip dominates for small command counts.
  GPU_SORT_KEYS: 39,

  // ── GPU point cloud sort (Phase 3: dispatcher landed 2026-04-09) ──
  // Bitonic sort of point cloud distance-squared arrays on the GPU.
  // Gated by `WasmPointCloudBridge.useGPUSort` (default false);
  // only useful when a GPU-side consumer (indirect draw) exists so the
  // sorted indices don't need a readback to CPU.
  POINT_CLOUD_SORT: 40,

  // ── Ground polyline classifier (Migration Session 4, 2026-04-28) ──
  // WebGPU equivalent of GroundPolylinePrimitive's classification path.
  // Same depth-texture sampling plumbing as GROUND_PRIMITIVE +
  // 5-plane fragment-side intersection tests (start/end/right miter
  // planes, plus aligned-plane checks for tex coord). Renderer
  // skeleton lands in Batch 84; the full WGSL VS/FS port of
  // PolylineShadowVolumeVS/FS.glsl is tracked as Session 4b in
  // DEFERRED_WORK.md (~250 LOC of plane-distance math + per-vertex
  // volume extrusion).
  GROUND_POLYLINE: 41,

  // ── Vector 3D Tile classification renderers (Batch 112) ──
  // WebGPU classifiers for the three Vector3DTile* feature families that
  // ride the depth-sample architecture (ADR-2026-04-28) alongside
  // GROUND_PRIMITIVE / GROUND_POLYLINE:
  //   - VECTOR_3DTILE_PRIMITIVE        — extruded polygon classification
  //     (building footprints, admin boundaries).
  //   - VECTOR_3DTILE_POLYLINE         — non-clamped 3D polylines.
  //   - VECTOR_3DTILE_CLAMPED_POLYLINE — terrain-clamped polylines (uses
  //     the same depth-source plumbing as GROUND_POLYLINE).
  // Each renderer emits per-batch DrawCommands for the existing dispatch
  // path; the consumer scene file delegates to the FR via the standard
  // `getFeatureRenderer(...).createCommands(primitive, frameState)` shape.
  VECTOR_3DTILE_PRIMITIVE: 42,
  VECTOR_3DTILE_POLYLINE: 43,
  VECTOR_3DTILE_CLAMPED_POLYLINE: 44,

  // ── Backend-handoff marker keys (audit 2026-05-02) ──
  // These two slots host MARKER FeatureRenderers — they exist so scene
  // primitives can use the FR-key check pattern (CLAUDE.md §2) instead
  // of branching on `context.isWebGPU`. The marker's actual rendering
  // happens elsewhere (or is intentionally a no-op until the full
  // renderer ships).
  //
  // DEPTH_PLANE: `WebGPUDepthPlane` runs inside `WebGPUSceneRenderer`
  // (not via the FR-dispatch loop). The marker FR lets `Scene/DepthPlane.js`
  // skip the WebGL-only `ShaderProgram.fromCache` setup without checking
  // backend identity.
  //
  // CLASSIFICATION_PRIMITIVE: no full WebGPU renderer exists yet for
  // standalone ClassificationPrimitive (Vector3DTile classification has
  // its own per-tile FRs above). The marker FR is a bridge — same visual
  // outcome as today (nothing renders standalone ClassificationPrimitive
  // on WebGPU), but the §2 violation in `Scene/ClassificationPrimitive.js`
  // is gone. Replace with a real renderer when ported (DEFERRED_WORK).
  DEPTH_PLANE: 45,
  CLASSIFICATION_PRIMITIVE: 46,

  // ── NPR Outlines (Slice 5c-B Batch 123) ──
  // Cheap post-process pass that reads G-buffer normal-roughness +
  // depth to detect silhouette / crease edges and paints them as
  // a configurable edge color. Opt-in via `scene.enableNPROutlines`;
  // off by default because hard outlines clash with the photorealistic
  // globe default.
  NPR_OUTLINES: 47,

  // ── Contact Shadows (Slice 5c-B Batch 133) ──
  // Screen-space contact shadows. For each fragment, reads the
  // G-buffer normal + depth, unprojects to eye-space, then ray-marches
  // a short distance toward the sun direction sampling the depth
  // buffer at each step. If an occluder is found, the fragment is
  // darkened to simulate the contact shadow that a full shadow map
  // would also produce at finer detail. Cheap silhouette darkening
  // for grounded objects (foliage, ground vehicles, building bases).
  // Opt-in via `scene.enableContactShadows`.
  CONTACT_SHADOWS: 48,

  // ── GPU-resident compute-instance collection (Phase 3, Batch 231) ──
  // `ComputeInstanceCollection` routes here. Renamed from
  // ORBITAL_CATALOG_COLLECTION (Batch 230) in Batch 231 — same slot 49;
  // the orbital catalog was generalized into this feature-agnostic system
  // and the orbital math moved out of the engine into Sandcastle demo
  // content. The renderer keeps per-instance data GPU-resident: parameter
  // floats upload once to a storage buffer, a USER-SUPPLIED WGSL kernel
  // (composed with `ComputeInstanceScaffold.wgsl`) repopulates an instance
  // record buffer each frame via compute, and the instanced draw
  // vertex-pulls `instances[instance_index]` — positions never leave the
  // GPU; the CPU uploads only the simulation time per frame. WebGPU-only
  // for now — the WebGL2 fallback (worker/WASM kernel host) is tracked as
  // NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK in DEFERRED_WORK.md.
  COMPUTE_INSTANCE_COLLECTION: 49,

  // NOTE: a `DEFERRED_GBUFFER` slot was reserved at index 33 in earlier
  // sessions for a planned deferred renderer. It was never registered and
  // never consumed by any scene code, so it was removed and the subsequent
  // keys were shifted down by one to keep the lookup array dense. If a
  // deferred path is added in the future, append it after GPU_SORT_KEYS.

  /**
   * Total number of feature renderer keys (excluding COUNT itself).
   * Must equal the highest enum value + 1. Update when adding new keys.
   * Used to pre-allocate the internal array in GraphicsContext.
   * @type {number}
   */
  COUNT: 50,
};

export default Object.freeze(FeatureRendererKey);
