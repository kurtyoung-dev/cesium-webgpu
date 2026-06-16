/**
 * Central registry of preprocessor defines consumed by the `//>>ifdef`
 * system in Cesium-authored WGSL shaders, plus stable numeric identity
 * for each shader source file. Both tables are pure data — no runtime
 * state — and are looked up by the preprocessor + shader module cache
 * to produce compact Uint32 cache keys.
 *
 * # How the cache key is packed
 *
 * The shader module cache (see `WebGPUShaderModuleCache`) keys its
 * `Map<number, GPUShaderModule>` by a Uint32 computed as
 * `(sourceId & 0xff) | ((defines & 0xffffff) << 8)`. That gives
 * 8 bits for source IDs (256 shader files — plenty) and 24 bits for
 * active defines (24 possible defines engine-wide). If we ever approach
 * either limit we migrate the scheme, but it's comfortable for the
 * foreseeable variant space.
 *
 * # Add-only rule
 *
 * Both tables are **add-only**. Never reorder, renumber, or remove an
 * entry even if its last consumer disappears. Reordering silently
 * aliases cached modules across rebuilds; removal breaks any pipeline
 * that still references the bit. Deprecated entries should be marked
 * in a comment and left in place.
 *
 * @private
 * @module WebGPUShaderDefines
 */

/**
 * Preprocessor defines exposed via `//>>ifdef FLAG_NAME` in Cesium-
 * authored WGSL. Each entry occupies one bit of a Uint32 bitmask.
 *
 * **Add-only; never reorder or remove.**
 */
export const ShaderDefine = Object.freeze({
  /**
   * Terrain vertex stride includes `geodeticSurfaceNormal: vec3<f32>`
   * at `@location(2)`. Exaggeration math in `processVertex` uses the
   * true WGS84 geodetic normal instead of the ellipsocentric
   * `normalize(position3D)` fallback (DP-H25).
   */
  GEODETIC_NORMAL: 1 << 0,

  /**
   * Per-primitive depth-test override (DP-H42). When active, the
   * vertex stage reads the per-instance `disableDepthTestDistance`
   * attribute, falls back to the frame-wide
   * `camera.minimumDisableDepthTestDistance` when the per-instance
   * value is zero, and — if the camera is within the configured
   * distance of the primitive — forces `out.position.z = out.position.w`
   * so the rasterizer always passes depth. Matches the WebGL
   * `#ifdef DISABLE_DEPTH_DISTANCE` path in BillboardCollectionVS /
   * LabelCollectionVS / PointPrimitiveCollectionVS. Consumers:
   * BillboardCollection, PointPrimitiveCollection,
   * PointPrimitiveCollectionPick (and LabelCollection through Billboard).
   */
  DISABLE_DEPTH_DISTANCE: 1 << 1,

  /**
   * Split-screen rendering (DP-H40). When active, the vertex stage
   * forwards `splitDirection` to the fragment stage and the fragment
   * stage discards pixels on the wrong side of
   * `frameState.splitPosition`. `splitDirection` interpretation:
   *   -1  — render only when `fragCoord.x < splitPosition * viewport`
   *    0  — render unconditionally
   *   +1  — render only when `fragCoord.x > splitPosition * viewport`
   * Matches the WebGL `czm_splitPosition` path applied per-primitive.
   * Consumers: BillboardCollection, LabelCollection,
   * PointPrimitiveCollection, PolylineCollection (Batch 22).
   */
  SPLIT_ENABLED: 1 << 2,

  /**
   * GPU-side compressed-vertex decode (DP-H19-SHADER-DECODE, Batch 27).
   *
   * When this bit is set, the vertex stage accepts the
   * `compressedAttributes: vec4<f32>` input emitted by
   * `GeometryPipeline.compressVertices()` and decodes oct-packed
   * normal/tangent/bitangent + bit-packed UVs on-GPU using the
   * helpers in `chunks/functions/csm_decodeCompressedVertex.wgsl`.
   *
   * When the bit is clear, the vertex stage reads the plain
   * `normal`/`st`/`tangent`/`bitangent` attributes that
   * `ensureUncompressedAttributes` reconstructs on the CPU path
   * (this stays the default — the CPU path is correct and universal).
   *
   * The opt-in is per-shader: a material shader chooses to advertise
   * GPU-decode support via its entry in the `supportsShaderDecode`
   * table in `WebGPUPrimitiveShaders`. When that advertisement exists
   * AND the geometry carries `compressedAttributes`, the pipeline key
   * flips this bit and `WebGPUPrimitiveCommands` emits the compressed
   * vertex buffer instead of the decompressed one.
   *
   * Consumers: Primitive family (material shaders that add the
   * `//>>ifdef COMPRESSED_VERTICES` branches).
   */
  COMPRESSED_VERTICES: 1 << 3,

  /**
   * Per-primitive distance display gating (AUDIT_2026_05_02 A.14, Batch 135).
   * When active, the vertex stage reads a per-instance
   * `distanceDisplayCondition` (nearSq, farSq) and pushes the vertex
   * behind the near plane (`positionEC.xyz = vec3(0.0)`) when the
   * camera-to-primitive squared eye distance falls outside the
   * configured `[nearSq, farSq]` window. Mirrors WebGL's
   * `#ifdef DISTANCE_DISPLAY_CONDITION` branch in
   * BillboardCollectionVS / LabelCollectionVS / PointPrimitiveCollectionVS.
   *
   * Consumers: BillboardCollection.wgsl (Batch 135),
   * PolylineCollection.wgsl + PointPrimitiveColor.wgsl (Batch 136).
   * Label inherits via Billboard (LabelCollection renders glyphs as
   * billboards under the hood).
   */
  DISTANCE_DISPLAY_CONDITION: 1 << 4,

  /**
   * Per-primitive `translucencyByDistance` ramp (AUDIT_2026_05_02 A.14,
   * Batch 136). Reads a per-instance NearFarScalar
   * (`(near, nearAlpha, far, farAlpha)`) and computes
   * `czm_nearFarScalar(translucencyByDistance, lengthSq)` to scale
   * the fragment alpha. Vertex pushed behind near plane when result
   * is exactly 0 (matches WebGL's `if (translucency == 0.0)` clip).
   *
   * Consumers: BillboardCollection.wgsl, PolylineCollection.wgsl,
   * PointPrimitiveColor.wgsl. Label inherits via Billboard.
   */
  EYE_DISTANCE_TRANSLUCENCY: 1 << 5,

  /**
   * Per-primitive `pixelOffsetScaleByDistance` ramp (AUDIT_2026_05_02
   * A.14, Batch 136). Reads a per-instance NearFarScalar and scales
   * the per-billboard pixelOffset by the resulting scalar. Used by
   * KML/GeoJSON entities that want labels to drift toward / away from
   * their pinned position based on camera distance.
   *
   * Consumers: BillboardCollection.wgsl. Label inherits via Billboard.
   * Polyline + Point have no pixelOffset attribute and skip this gate.
   */
  EYE_DISTANCE_PIXEL_OFFSET: 1 << 6,

  /**
   * Per-primitive `scaleByDistance` ramp (AUDIT_2026_05_02 A.14, Batch
   * 136). Reads a per-instance NearFarScalar and scales the
   * billboard / point quad size by the resulting scalar. Vertex pushed
   * behind near plane when scale is exactly 0.
   *
   * Consumers: BillboardCollection.wgsl, PointPrimitiveColor.wgsl.
   * Label inherits via Billboard. Polyline has no quad scale and
   * skips this gate.
   */
  EYE_DISTANCE_SCALING: 1 << 7,

  /**
   * Three-point globe-depth occlusion check for clamp-to-ground
   * billboards / labels (Batch 138). Mirrors WebGL's
   * `VS_THREE_POINT_DEPTH_CHECK` define: when active, the vertex
   * stage samples the globe depth texture at three "key points" of
   * the quad (origin, top, top-right) and collapses the vertex to a
   * degenerate clip-pos when ALL three are occluded by terrain. The
   * 3-point pattern is deliberate — labels that span over hills
   * remain visible if any anchor pokes above the terrain.
   *
   * Activated by the JS-side `_shaderClampToGround` flag, which
   * `BillboardCollection` flips when any billboard has
   * `heightReference !== HeightReference.NONE`.
   *
   * Consumers: BillboardCollection.wgsl, BillboardCollectionSDF.wgsl
   * (label glyph path). Pick paths intentionally do NOT consume this
   * — pick-through-terrain matches WebGL behavior.
   */
  VS_THREE_POINT_DEPTH_CHECK: 1 << 8,

  /**
   * Model material BGL/shader variant — KHR-extension textures + sampler
   * (bindings 12-25 of the model material BGL). When set, the shader
   * declares all 14 KHR texture/sampler slots and the FS samples them
   * inside `if (hasFlag(flags, FLAG_HAS_*))` blocks; the renderer pairs
   * this with the full (37-binding) `materialBGL` and full pipeline
   * layout. When clear, all KHR declarations + sampling sites are
   * stripped from the shader source — the basic shader has 23 bindings
   * (10 sampled textures), well under the WebGPU spec floor of 16
   * `maxSampledTexturesPerShaderStage`. The renderer pairs this with
   * `materialBGL_basic` + the basic pipeline layout, so model
   * rendering works on devices that only expose the spec floor (mobile
   * WebGPU, "compatibility" featureLevel) for materials that don't use
   * any KHR extensions.
   *
   * Per-primitive selection: `WebGPUModelRenderer` checks the
   * material's `flags` for any KHR-extension bit (`FLAG_HAS_CLEARCOAT`,
   * `FLAG_HAS_SPECULAR_EXT`, `FLAG_HAS_ANISOTROPY`, `FLAG_HAS_IRIDESCENCE`,
   * `FLAG_HAS_SHEEN`, `FLAG_HAS_TRANSMISSION`) and routes through the
   * full variant if any is set, else through the basic variant.
   *
   * Consumer: `ModelPBRComplete.wgsl`.
   */
  MODEL_HAS_KHR_TEXTURES: 1 << 9,

  /**
   * Stochastic / dithered alpha-test for translucent rendering
   * (Batch 192, C-R9-MODEL-PICK-TRANSLUCENT second slice). When set,
   * the fragment stage discards translucent fragments based on a
   * blue-noise threshold lookup keyed by `fragCoord % 256` against the
   * fragment's effective alpha (`baseColor.a × batchColor.a`).
   * Probability of survival = effective alpha; multi-frame averaging
   * converges to the true alpha-weighted appearance.
   *
   * Used by:
   *   - Stochastic translucent pick (`scene.pickHover()` path) —
   *     guaranteed stutter-free at 60fps hover frequency. Single-pass,
   *     no extra render passes, no extra MRT targets.
   *   - Future: foliage / particle alpha-test rendering, translucent
   *     shadow casts (CSM cube depth), voxel ray-march acceleration.
   *
   * The blue noise texture lives at `@group(N) @binding(M)` per
   * consumer — the variant doesn't dictate the binding slot, only
   * that the FS reads the threshold and discards. Consumers wire the
   * texture via their own bind-group layout.
   *
   * Consumers (Batch 192): ModelPBRComplete.wgsl pick FS variant.
   * Future consumers: PrimitivePhongTexturedColor.wgsl (foliage),
   * voxel ray-march, CSM cast shaders.
   */
  STOCHASTIC_DITHER_ALPHA: 1 << 10,

  /**
   * Stencil-based pick winner-selection (Batch 192,
   * C-R9-MODEL-PICK-TRANSLUCENT precise path). When set, the fragment
   * stage participates in a 2-pipeline single-render-pass coordination
   * where:
   *   - Pipeline 1 writes stencil = 1 + depth (closest translucent
   *     fragment per pixel; depth-write enabled, depth-compare less).
   *   - Pipeline 2 (same render pass) writes pickColor where stencil
   *     == 1 AND depth == current (depth-compare equal, depth-write
   *     disabled).
   *
   * Used by `scene.pickPrecise()` for deterministic "geometrically-
   * closest translucent fragment wins" pick semantics. Pays a 2×
   * pipeline-switch cost but reuses a single render-pass setup.
   * Click-pick frequency makes the cost invisible to UX.
   *
   * Consumers (Batch 192): ModelPBRComplete.wgsl precise pick FS
   * variant; future translucent geometry primitives.
   */
  STENCIL_PICK_WINNER: 1 << 11,

  /**
   * Model has TEXCOORD_1 vertex attribute (Session 62 NEW-VR-VERTEX-BUFFER-VARIANT
   * fix). When set, `ModelPBRComplete.wgsl` declares
   * `@location(7) texCoord1: vec2<f32>` in the FragmentInput struct AND
   * the pipeline binds a buffer at vertex slot 7. When clear, slot 7 is
   * absent — the WGSL preprocessor strips the location declaration and
   * any reads of `input.texCoord1`, and the JS pipeline cache returns
   * a layout with only 8 vertex buffer slots (positionMC, normalMC,
   * tangentMC, texCoord0, color0, joints0, weights0, featureId0).
   *
   * Why: Edge's WebGPU adapter caps `maxVertexBuffers` at 8. The full
   * model layout (positionMC, normalMC, tangentMC, texCoord0, color0,
   * joints0, weights0, texCoord1, featureId0) is 9 slots — unable to
   * compile on Edge. Most batched 3D Tiles + standard glTF models
   * don't use TEXCOORD_1 (it's for KHR_materials_occlusion and
   * clearcoat-normal); making it variant-conditional reduces the
   * common-case layout to 8 slots, fitting the adapter limit.
   *
   * Per-primitive selection: `WebGPUModelRenderer` reads the
   * primitive's TEXCOORD_1 accessor presence and sets this bit when
   * non-null. The full pipeline cache key now includes this bit so
   * a given model with mixed primitives (some texCoord1, some not)
   * gets two distinct pipelines.
   *
   * Consumer: `ModelPBRComplete.wgsl`.
   */
  MODEL_HAS_TEXCOORD_1: 1 << 12,
  /**
   * Set when the primitive carries an actual `_FEATURE_ID_0` / `_BATCHID`
   * attribute that the renderer needs to forward to the FS for batched
   * tile picking or per-feature styling. When unset, the vertex layout
   * omits slot 8 (the f32 featureId0) and the vertex shader assigns
   * `output.featureId0 = 0.0` directly.
   *
   * Why variant-conditional (Session 65, Batch follow-up to NEW-VR-VERTEX-BUFFER-VARIANT):
   * the full Model PBR layout had 9 vertex slots (position, normal,
   * tangent, texCoord0, color, joints, weights, texCoord1, featureId0).
   * Session 62's `MODEL_HAS_TEXCOORD_1` made slot 7 conditional,
   * dropping the common case to 8. But primitives that ALSO carry a
   * feature ID (every batched 3D Tiles tileset — BIM, AEC, Photogrammetry,
   * Clipping Planes etc.) still hit 9 and refuse to compile on Edge's
   * 8-slot adapter limit. Dropping slot 8 for primitives without a
   * feature ID brings the most-common case (standard glTF models with
   * no batch table) to 7 slots; primitives with feature IDs but no
   * texCoord1 land at 8; primitives with both stay at 9 (a small
   * sub-cluster — multi-UV models that are also batched — still needs
   * the deeper restructure noted in DEFERRED_WORK).
   *
   * Per-primitive selection: `WebGPUModelRenderer` checks the loaded
   * primitive for a `_FEATURE_ID_0` accessor (or its legacy `_BATCHID`
   * alias) and sets this bit when present. The full pipeline cache key
   * includes this bit so a given model with mixed primitives (some
   * batched, some not) compiles distinct pipelines per variant.
   *
   * Consumer: `ModelPBRComplete.wgsl`.
   */
  MODEL_HAS_FEATURE_ID_0: 1 << 13,

  /**
   * Globe `czm_getMaterial` hook (Session 65 Cluster 3 — parallel WGSL
   * fabric API). When set, `GlobeTerrain.wgsl` activates the
   * `//>>ifdef MATERIAL_APPLY` block in its fragment shader: it builds
   * a `czm_MaterialInput` from per-fragment values (st, normalEC,
   * slope/height/aspect) and calls `czm_getMaterial(materialInput)` —
   * whose body is the WGSL emitted by `MaterialHelpers.createWGSLMethodDefinition`
   * from the fabric's `wgsl: { source, components }` declaration —
   * then alpha-blends the result over the imagery composite.
   *
   * Per-tile selection: `WebGPUGlobeSurfacePipelines` sets this bit
   * when `tileProvider.material` is non-null AND the material declares
   * a valid `wgslShaderSource`. The pipeline cache key includes both
   * this bit and a material-hash, so each unique `globe.material` gets
   * its own pipeline variant.
   *
   * Consumer: `GlobeTerrain.wgsl` FS material composite block.
   */
  MATERIAL_APPLY: 1 << 14,

  /**
   * Renderer-wide logarithmic depth (Approach A for
   * NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION). When set, a depth-writing
   * fragment shader emits `@builtin(frag_depth)` via
   * `csm_writeLogDepth(depthFromNearPlusOne, oneOverLog2FarDepthFromNearPlusOne)`
   * and its vertex stage interpolates `csm_vertexLogDepth(clipPos, near)` +
   * applies `csm_updatePositionDepth`. Depth CONSUMERS (classifier eye-space
   * reconstruct, pick, SSAO/SSR/DoF/TAA/etc.) reverse it via
   * `csm_reverseLogDepth` / `csm_reverseLogDepthToEyeDistance`. This puts ALL
   * geometry into one logarithmic depth space (matching WebGL's
   * `#ifdef LOG_DEPTH`), eliminating the 24-bit hyperbolic-NDC precision crush
   * that makes textured-material classification and far-distance pick imprecise.
   *
   * Gating (single flip point): the define is set when
   * `isWebGPULogDepthActive(context, frameState)` is true — i.e.
   * `context._logDepthWriteEnabled && frameState.useLogDepth`. The
   * `_logDepthWriteEnabled` master switch now defaults TRUE — Batch 251
   * (NEW-COLLECTIONS-LOG-DEPTH master-switch) flipped it on, so renderer-wide
   * log depth is LIVE by default. It historically defaulted FALSE while the
   * epic was landed slice-by-slice (every producer/consumer change was inert
   * until the flip); the switch survives as a one-line kill switch. See
   * `WebGPULogDepth.ts`.
   *
   * Consumers (rolled out across the epic): GlobeTerrain.wgsl + every other
   * depth-writing WGSL producer; the 4 depth-sample classifiers; pick;
   * post-process eye-space reconstructors.
   */
  LOG_DEPTH: 1 << 15,

  /**
   * Reduced globe imagery layout for default-limit adapters
   * (NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT, Batch 246). The full globe
   * terrain pipeline layout needs 31 fragment-stage sampled textures
   * (16 imagery + 4 water/ocean/material + 11 effects), which exceeds
   * the WebGPU spec floor `maxSampledTexturesPerShaderStage = 16`
   * (SwiftShader CI, compat-mode adapters, low-end mobile). When set,
   * `GlobeTerrain.wgsl` strips the `dayTexture1..15` declarations, the
   * per-layer composite blocks for slots 1..15, and the two layer-1
   * debug-sentinel blocks — leaving exactly ONE imagery slot
   * (`dayTexture0`; `texSampler` stays at `@binding(16)` so the
   * bind-group layout shape is shared). 31 - 15 = 16 sampled textures →
   * fits the spec floor exactly.
   *
   * Multi-layer tiles still render every layer: the CPU-side multi-pass
   * slicing in `WebGPUGlobeSurfaceRenderer.createTileCommands` uses the
   * per-device `_imagerySlotCount` (1 when this bit is active) as the
   * pass width, so N layers become N blend passes instead of one
   * 16-wide pass. Capable adapters (limit ≥ 31) never set this bit and
   * keep the full single-pass layout — zero regression.
   *
   * Per-device selection: `computeGlobeImagerySlotCount(device.limits)`
   * in `WebGPUGlobeSurfaceTypes.ts`, captured once at renderer
   * `initialize()`. The bit participates in the shader-module cache key,
   * the renderer's pipeline cache keys, and the central pipeline cache
   * (via an `imagery1` marker in the descriptor name).
   *
   * Consumer: `GlobeTerrain.wgsl`.
   */
  GLOBE_IMAGERY_REDUCED: 1 << 16,
} as const);

/**
 * Stable numeric identity for each Cesium-authored WGSL source file.
 * Combined with the active-defines bitmask as the shader module cache
 * key.
 *
 * **Add-only; never renumber.** Source ID 0 is intentionally unused
 * so cache keys of zero are distinguishable from "no source."
 */
export const ShaderSourceId = Object.freeze({
  GLOBE_TERRAIN: 1,
  BILLBOARD_COLLECTION: 2,
  BILLBOARD_COLLECTION_PICK: 3,
  BILLBOARD_COLLECTION_SDF: 4,
  POINT_PRIMITIVE_COLOR: 5,
  POINT_PRIMITIVE_PICK: 6,
  POLYLINE_COLLECTION: 7,
  POLYLINE_COLLECTION_PICK: 8,
  POLYLINE_ARROW: 9,
  POLYLINE_DASH: 10,
  POLYLINE_GLOW: 11,
  POLYLINE_OUTLINE: 12,
  // C-R7-SHADER-MODULE-DEDUP — Batch 72. Source IDs 13-15 cover the
  // first sweep of additional render-family adoption (Cloud + Voxel +
  // Weather render). Keep numbering monotonic; add-only.
  CLOUD_COLLECTION: 13,
  VOXEL_PRIMITIVE: 14,
  WEATHER_PARTICLE_RENDER: 15,
  /**
   * The compute-shader source feeding `WebGPUWeatherRenderer`'s reset /
   * update / emit pipelines. Compute pipelines themselves are NOT yet
   * routed through a central cache (no `WebGPUComputePipelineCache`
   * exists), but the underlying `GPUShaderModule` is still deduped via
   * `WebGPUShaderModuleCache.getOrCreate()` so two contexts with weather
   * enabled don't recompile the same WGSL.
   */
  WEATHER_PARTICLES_COMPUTE: 16,
  // C-R7-SHADER-MODULE-DEDUP — Batch 74. Source IDs 17-22 cover the
  // third sweep of additional render-family adoption (Environment +
  // VolumetricFog + PointCloud). Add-only; never renumber.
  ENVIRONMENT_SUN: 17,
  ENVIRONMENT_MOON: 18,
  /**
   * `VolumetricFog.wgsl` — single source feeding all three compute
   * entry points (densityInjection / lightScattering / integrate). As
   * with `WEATHER_PARTICLES_COMPUTE`, the compute pipelines stay on
   * direct `device.createComputePipeline()` until a
   * `WebGPUComputePipelineCache` exists; the module is deduped here.
   */
  VOLUMETRIC_FOG_COMPUTE: 19,
  VOLUMETRIC_FOG_COMPOSITE: 20,
  POINT_CLOUD: 21,
  POINT_CLOUD_LOD: 22,
  // C-R7-SHADER-MODULE-DEDUP — Batch 162 (2026-05-02). The combined
  // glTF model VS+FS PBR shader (`ModelPBRComplete.wgsl`). One
  // `WebGPUModelPipelineCache` is created per `Model` instance, so a
  // 100-glTF tileset previously compiled the same WGSL 100 times — this
  // ID reuses one `GPUShaderModule` across all model instances on a
  // device. Pipelines themselves stay per-cache (still need per-model
  // formats, `alphaMode`, `doubleSided` keys); only the module is shared.
  MODEL_PBR_COMPLETE: 23,
  // C-R7-SHADER-MODULE-DEDUP — Batch 163 (2026-05-02). Vector 3D Tile
  // family. WGSL is built inline in each `build*PipelineResources()`
  // function and is constant per build (only interpolates one chunk).
  // Each renderer creates its resources per-primitive, so a tileset
  // with N visible vector tiles previously compiled the same WGSL N
  // times — these IDs reuse one `GPUShaderModule` per device.
  VECTOR_3DTILE_PRIMITIVE: 24,
  VECTOR_3DTILE_POLYLINES: 25,
  VECTOR_3DTILE_CLAMPED_POLYLINES: 26,
  // C-R7-SHADER-MODULE-DEDUP — Batch 164 (2026-05-02). BufferPrimitive
  // family. Each `BufferPrimitiveCollection` builds its own cache and
  // compiles the same WGSL — small Sandcastle setups have multiple
  // collections (point + polyline + polygon) and re-add them on
  // re-bind. Deduping is a modest win per scene but free given the
  // pattern is already established.
  BUFFER_POINT_MATERIAL: 27,
  BUFFER_POLYLINE_MATERIAL: 28,
  BUFFER_POLYGON_MATERIAL: 29,
  // C-R7-SHADER-MODULE-DEDUP — Batch 185 (2026-05-06). Final low-win
  // remainders: GroundPrimitive + GroundPolyline classifier renderers
  // (typically few-per-scene, but we just touched both files in
  // Batches 180 and 183 so the ride-along has zero marginal cost),
  // SkyAtmosphere (singleton per scene; module cache is a no-op
  // optimization but unifies the pattern), and EllipsoidPrimitive
  // (few-per-scene; same rationale). Closes the C-R7-SHADER-MODULE-DEDUP
  // adoption sweep — every Cesium-authored WGSL source now resolves
  // through `WebGPUShaderModuleCache.getOrCreate`.
  GROUND_PRIMITIVE: 30,
  GROUND_POLYLINE: 31,
  SKY_ATMOSPHERE: 32,
  ELLIPSOID_PRIMITIVE: 33,
  // Phase 3 — GPU-resident compute-instance system (Batch 231,
  // NEW-COMPUTE-INSTANCE-SYSTEM). RENAMED in place from the Batch-230
  // ORBITAL_PROPAGATE_COMPUTE / ORBITAL_CATALOG_RENDER labels when the
  // orbital catalog was generalized and its domain math moved out of the
  // engine — numbers kept per the add-only registry rule; never renumber.
  // 34 labels the engine-side kernel scaffold
  // (`Compute/ComputeInstanceScaffold.wgsl`). NOTE: composed user-kernel
  // modules are NOT cached under this id — `WebGPUComputeInstanceRenderer`
  // caches them per composed-source string, because the (sourceId, defines)
  // key can't represent arbitrary user kernel strings. 35 is the instanced
  // storage-buffer-vertex-pull render shader
  // (`Compute/ComputeInstanceRender.wgsl`).
  COMPUTE_INSTANCE_SCAFFOLD: 34,
  COMPUTE_INSTANCE_RENDER: 35,
  // NEW-SPLAT-SORT-CONSUME-INDEXES / NEW-LOG-DEPTH-REMAINING-PRODUCERS-
  // POINTCLOUD-SPLAT (Batch 288). The inline Gaussian-splat WGSL
  // (`WebGPUGaussianSplatRenderer.ts` SPLAT_WGSL) now resolves through the
  // module cache so its `//>>ifdef LOG_DEPTH` blocks preprocess and the
  // log-depth color/depth-write variants dedupe per (sourceId, defines).
  GAUSSIAN_SPLAT: 36,
  // NEW-STARS-BRIGHT-CATALOG (Track V-C, Batch 313). The Yale Bright
  // Star Catalog starfield shader (`Catalog/StarField.wgsl`). One
  // `GPUShaderModule` per device — the starfield is a singleton per
  // scene (owned by SkyBox), so this is a no-op dedupe today, but it
  // keeps the every-Cesium-WGSL-source-resolves-through-the-cache
  // invariant intact (closed in Batch 185).
  STAR_FIELD_CATALOG: 37,
} as const);

/**
 * Debug helper: expand a defines bitmask back into the set of active
 * define names. Intended only for diagnostic output (cache dumps,
 * error messages). Do not call on the hot path — the cost is O(n) over
 * the registry and the allocation isn't free.
 */
export function defineKeyToNames(defines: number): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(ShaderDefine)) {
    if ((defines & (bit as number)) !== 0) names.push(name);
  }
  return names;
}

/**
 * Resolve a define flag name to its bit. Returns `undefined` for
 * unknown names so the preprocessor can produce a clear error.
 */
export function resolveDefineBit(name: string): number | undefined {
  return (ShaderDefine as Record<string, number>)[name];
}
