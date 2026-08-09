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
  // Retired: the ground atmosphere is computed inside GlobeTerrain.wgsl by
  // `csm_computeGroundAtmosphereScattering` against `WebGPUAtmosphereLUT`,
  // with its parameters in the globe camera and tile uniform buffers, matching
  // WebGL's in-GlobeFS integration. Keys are positional, so slot 29 stays
  // reserved and the number is never reused.
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

  // ── Ground polyline classifier ──
  // WebGPU equivalent of GroundPolylinePrimitive's classification path.
  // Same depth-texture sampling plumbing as GROUND_PRIMITIVE, plus
  // five-plane fragment-side intersection tests: start, end and right miter
  // planes, and aligned-plane checks for the texture coordinate.
  GROUND_POLYLINE: 41,

  // ── Vector 3D Tile classification renderers ──
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
  // CLASSIFICATION_PRIMITIVE: standalone
  // ClassificationPrimitive is a real renderer — its `createCommands`
  // is `WebGPUGroundPrimitiveRenderer.createWebGPUGroundPrimitiveCommands`,
  // which walks the depth-2 wrapping chain (ClassificationPrimitive →
  // ._primitive (Primitive) → ._webgpuGeometryData) and emits the same
  // depth-sample classification commands GroundPrimitive uses. It honors
  // `classificationType` (TERRAIN / CESIUM_3D_TILE / BOTH). NOT a marker
  // no-op. (Vector3DTile classification still has its own per-tile FRs above.)
  DEPTH_PLANE: 45,
  CLASSIFICATION_PRIMITIVE: 46,

  // ── NPR Outlines ──
  // Cheap post-process pass that reads G-buffer normal-roughness +
  // depth to detect silhouette / crease edges and paints them as
  // a configurable edge color. Opt-in via `scene.enableNPROutlines`;
  // off by default because hard outlines clash with the photorealistic
  // globe default.
  NPR_OUTLINES: 47,

  // ── Contact Shadows ──
  // Screen-space contact shadows. For each fragment, reads the
  // G-buffer normal + depth, unprojects to eye-space, then ray-marches
  // a short distance toward the sun direction sampling the depth
  // buffer at each step. If an occluder is found, the fragment is
  // darkened to simulate the contact shadow that a full shadow map
  // would also produce at finer detail. Cheap silhouette darkening
  // for grounded objects (foliage, ground vehicles, building bases).
  // Opt-in via `scene.enableContactShadows`.
  CONTACT_SHADOWS: 48,

  // ── GPU-resident compute-instance collection ──
  // `ComputeInstanceCollection` routes here; the orbital catalog that once
  // owned this slot was generalized into this feature-agnostic system, with
  // its orbital math moved out of the engine into Sandcastle demo content.
  // The renderer keeps per-instance data GPU-resident: parameter
  // floats upload once to a storage buffer, a USER-SUPPLIED WGSL kernel
  // (composed with `ComputeInstanceScaffold.wgsl`) repopulates an instance
  // record buffer each frame via compute, and the instanced draw
  // vertex-pulls `instances[instance_index]` — positions never leave the
  // GPU; the CPU uploads only the simulation time per frame. WebGPU-only
  // for now; a WebGL2 fallback would need a worker or WASM kernel host.
  COMPUTE_INSTANCE_COLLECTION: 49,

  // ── Entity-cluster GPU bin/count ──
  // `EntityCluster` (screen-space proximity declutter of billboard/label/
  // point entities) routes its binning half here on WebGPU. The dispatcher
  // (`WebGPUEntityClusterDispatcher`) runs `EntityClusterGridGPU.wgsl`: a
  // single O(N) compute pass hashes every visible screen-space point into a
  // uniform grid whose cell edge equals the merge radius (pixelRange) and
  // accumulates per-cell occupancy + a per-cell representative point index.
  // The SEQUENTIAL representative-selection + 3×3-neighbourhood merge stays on
  // the CPU but iterates the (far smaller) non-empty-cell set rather than every
  // point — replacing the per-frame KDBush build that doesn't scale to 50k+
  // markers. WebGL2 keeps the full CPU KDBush path.
  ENTITY_CLUSTER_GPU: 50,

  // ── Bright-star catalog starfield ──
  // `StarField` (owned by SkyBox) routes here on BOTH backends. The
  // renderers (`WebGPUStarFieldRenderer` for WGSL, `WebGLStarFieldRenderer`
  // for GLSL) upload the Yale Bright Star Catalog subset (RA/Dec/magnitude/
  // B−V) once to a per-instance vertex buffer and draw it as HDR point
  // sprites into the scene framebuffer with premultiplied-additive blend,
  // so the existing bloom post-process makes bright stars glow. Per-star
  // intensity follows the Pogson magnitude scale; per-star color is derived
  // from the B−V index via a blackbody approximation. The inertial
  // (TEME/J2000) catalog directions are rotated into the Earth-fixed frame
  // by the same TEME→pseudo-fixed matrix SkyBox uses, so constellations
  // land at the correct RA/Dec for the scene clock. The catalog data +
  // intensity/color/fade math are backend-neutral (`Scene/BrightStarCatalog`
  // + `Scene/StarFieldMath`) and reused by both renderers; only the draw
  // path differs.
  STAR_FIELD: 51,

  // ── GPU flow-field wind particles ──
  // `FlowFieldWindLayer` routes here. WebGPU-only (documented no-op on
  // WebGL — the layer simply renders nothing when no FR resolves). A
  // ping-pong compute pass advects N particles across a velocity field
  // supplied as an RGBA8 imagery texture (R=u, G=v, normalized against the
  // sidecar min/max), and an instanced point draw vertex-pulls each
  // particle's lon/lat → RTE-split ellipsoid position. Opt-in, default-off:
  // nothing is allocated until a layer with `show===true` and a loaded
  // velocity source is updated. See WebGPUFlowFieldRenderer.ts. Reference
  // port: mapbox/webgl-wind (ISC) + Cesium GPU-wind blog (RaymanNg,
  // MIT) — technique only; GFS sample data is NOAA public domain.
  FLOW_FIELD: 52,

  // ── GPU FFT spectral ocean ──
  // `OceanSurfacePrimitive` routes here. WebGPU-only (documented no-op on
  // WebGL — the primitive renders nothing when no FR resolves). A per-frame
  // compute chain (initial-spectrum → twiddle → time-evolve → inverse FFT →
  // merge) synthesizes an animated displacement + foam map from a Tessendorf/
  // Phillips spectrum; a camera-anchored RTE ENU grid patch samples it. Opt-in,
  // default-off: nothing is allocated until an enabled OceanSurfacePrimitive is
  // updated. See WebGPUOceanRenderer.ts. License: gasgiant/FFT-Ocean +
  // Popov72/OceanDemo + WebTide (all MIT) FFT/packing; Phillips spectrum derived
  // from Tessendorf's published notes.
  FFT_OCEAN: 53,

  // There is no `DEFERRED_GBUFFER` slot: nothing ever registered or consumed
  // one, and the lookup array stays dense. A deferred path would append after
  // GPU_SORT_KEYS rather than reclaim an interior index.

  /**
   * Total number of feature renderer keys (excluding COUNT itself).
   * Must equal the highest enum value + 1. Update when adding new keys.
   * Used to pre-allocate the internal array in GraphicsContext.
   * @type {number}
   */
  COUNT: 54,
};

export default Object.freeze(FeatureRendererKey);
