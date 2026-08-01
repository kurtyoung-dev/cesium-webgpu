/**
 * Central registry of preprocessor defines consumed by the `//>>ifdef`
 * system in Cesium-authored WGSL shaders, plus stable numeric identity
 * for each shader source file. Both tables are pure data — no runtime
 * state — and are looked up by the preprocessor + shader module cache
 * to produce compact, exact cache keys.
 *
 * # How the cache key is packed
 *
 * The shader module cache (see `WebGPUShaderModuleCache.getOrCreate`)
 * keys modules by the exact 40-bit safe integer
 * `((defines >>> 0) * 0x100) + sourceId`. That reserves 8 bits for
 * source IDs and retains the complete 32-bit lo-word define mask.
 * JavaScript numbers represent every such key exactly (the maximum is
 * `2^40 - 1`), so all 32 lo-word bits participate without string
 * allocation on the common path. `keySalt` remains available only for
 * sources whose WGSL text is generated dynamically and therefore needs
 * an additional content fingerprint beyond `(sourceId, defines)`.
 *
 * # Two-word (lo/hi) widening — C11-149
 *
 * The lo-word `ShaderDefine` registry is EXHAUSTED: bits 0-30 are all
 * occupied, and bit 31 is deliberately left unclaimed (it was
 * historically squatted by the collections' `noDepthTest`
 * pipeline-key fold — see `pipelineKeyWithDepthFlag` in
 * `WebGPUCollectionRendererBase` — and stays reserved so any stale
 * folded value can never alias a real define). New specialization
 * axes claim bits in the **`ShaderDefineHi`** registry instead: a
 * DISTINCT second-word namespace threaded through
 * `preprocess(source, defines, definesHi)` and the module cache's
 * two-level `(definesHi → loKey)` map. Hi-word bit 31 is likewise
 * reserved (never claim it). The branded `ShaderDefineHiMask` type
 * makes passing a hi-word bit where a lo-word mask is expected a
 * compile error in TypeScript; the reverse direction (a lo bit passed
 * as a `definesHi` argument) is not compile-checked — reviewers must
 * watch for it at hi-word call sites.
 *
 * # Add-only rule
 *
 * All three tables (`ShaderDefine`, `ShaderDefineHi`, `ShaderSourceId`)
 * are **add-only**. Never reorder, renumber, or remove an
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
 * authored WGSL. Each entry occupies one bit of the LO-word Uint32
 * bitmask.
 *
 * **FULL** as of C11-149: bits 0-30 are all claimed and bit 31 is
 * permanently reserved (historically aliased by the collections'
 * noDepthTest pipeline-key fold; keeping it unclaimed guarantees no
 * stale folded key can ever alias a real define). New defines go in
 * {@link ShaderDefineHi}.
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
   * terrain pipeline layout needs 28 fragment-stage sampled textures
   * (16 imagery + 5 water/ocean/material/cloud + 7 globe effects), which exceeds
   * the WebGPU spec floor `maxSampledTexturesPerShaderStage = 16`
   * (SwiftShader CI, compat-mode adapters, low-end mobile). When set,
   * `GlobeTerrain.wgsl` strips the `dayTexture4..15` declarations and the
   * per-layer composite blocks for slots 4..15 — leaving four imagery slots
   * (`dayTexture0..3`; `texSampler` stays at `@binding(16)` so the bind-group
   * layout shape is shared). 12 non-imagery + 4 imagery = 16 sampled textures,
   * fitting the spec floor exactly.
   *
   * Multi-layer tiles still render every layer: the CPU-side multi-pass
   * slicing in `WebGPUGlobeSurfaceRenderer.createTileCommands` uses the
   * per-device `_imagerySlotCount` (4 when this bit is active) as the
   * pass width, so N layers become ceil(N/4) blend passes instead of one
   * 16-wide pass. Capable adapters (limit ≥ 28) never set this bit and
   * keep the full single-pass layout — zero regression.
   *
   * Per-device selection: `computeGlobeImagerySlotCount(device.limits)`
   * in `WebGPUGlobeSurfaceTypes.ts`, captured once at renderer
   * `initialize()`. The bit participates in the shader-module cache key,
   * the renderer's pipeline cache keys, and the central pipeline cache
   * (via an imagery-slot marker in the descriptor name).
   *
   * Consumer: `GlobeTerrain.wgsl`.
   */
  GLOBE_IMAGERY_REDUCED: 1 << 16,

  /**
   * C2-25 ENV-SCENE-CAPTURE (Batch 446). Single-color-target globe fragment
   * variant for the dynamic-environment-map scene-capture pass. The on-screen
   * globe pipeline emits a 2-location `FragOutput { @location(0) color,
   * @location(1) normalRoughness }` into the scene G-buffer (color + MRT
   * normal). A capture pass renders one cube face into a SINGLE `rgba8unorm` /
   * `rgba16float` color attachment (no G-buffer slot-1, no MSAA, no stencil) —
   * declaring the slot-1 `@location(1)` output without a matching target would
   * be a WebGPU validation error, and vice-versa. When this bit is set,
   * `GlobeTerrain.wgsl`'s `FragOutput` struct + `makeFragOutput` helper drop the
   * `@location(1) normalRoughness` member so the fragment stage matches the
   * single-target capture pipeline.
   *
   * Per-pass selection: only the capture sibling
   * (`getOrCreateCaptureTileCommands` → the capture pipeline branch in
   * `WebGPUGlobeSurfacePipelines`) ORs this bit in; the on-screen pipeline never
   * does. So at `defines=0` (and every on-screen variant) the preprocessor emits
   * the `//>>else` branch byte-for-byte equal to today's source → the on-screen
   * shader-module hash is unchanged → no on-screen pipeline rebuild.
   *
   * Consumer: `GlobeTerrain.wgsl` (FragOutput / makeFragOutput).
   */
  CAPTURE_MODE: 1 << 17,

  /**
   * Model has EXT_structural_metadata that maps to the shader (DP-H46a,
   * first increment of the DP-H46 metadata epic). When set,
   * `ModelPBRComplete.wgsl` activates the `//>>ifdef MODEL_HAS_METADATA`
   * blocks: a `struct Metadata` declaration, a `fn initializeMetadata()`
   * initializer, a flat-interpolated `metadataValue` varying carrying a
   * scalar property-attribute value from the vertex stage to the
   * fragment stage, and (when `material.metadataDebug != 0`) a debug
   * fragment-color override that paints the scalar metadata value so the
   * data path is visually verifiable. When clear, every one of those
   * blocks is stripped at preprocess time and the shader is
   * byte-identical to the pre-DP-H46a source — the `//>>else` branches
   * are empty / the historical (absent) code, so a non-metadata model's
   * compiled module hash is unchanged.
   *
   * In DP-H46a this is the STUB increment: the struct is a single
   * `_placeholder` plus the proven scalar field, and `initializeMetadata`
   * is a no-op pass-through of the varying. DP-H46b replaces the stub
   * with a generated WGSL chunk (one field per property + a real
   * `initializeMetadata` that samples textures / reads varyings /
   * `textureLoad`s the property-table). The generated chunk is prepended
   * at the single injection point in
   * `WebGPUModelPipelineCache._getOrCreateShaderModule` and REPLACES the
   * stub only when this bit is set.
   *
   * Per-primitive selection: `WebGPUModelRenderer` sets this bit only
   * when `model.structuralMetadata` is defined AND the primitive maps to
   * at least one property-ATTRIBUTE (the same presence predicate
   * `MetadataPipelineStage` uses for property attributes). The bit also
   * discriminates the vertex layout (an extra metadata vertex slot at
   * `shaderLocation = 9`), so it participates in the model pipeline cache
   * key the same way `MODEL_HAS_FEATURE_ID_0` does.
   *
   * Consumer: `ModelPBRComplete.wgsl`.
   */
  MODEL_HAS_METADATA: 1 << 18,

  /**
   * Model has EXT_structural_metadata property TEXTURES that map to the
   * shader (DP-H46c). When set, the model material BGL gains a contiguous
   * block of property-texture (sampled `texture_2d<f32>`) + sampler
   * bindings starting at group-1 binding 39 (the
   * `PROPERTY_TEXTURE_BINDING_BASE` in `WebGPUModelPipelineCache`), and the
   * GENERATED metadata WGSL chunk
   * (`MetadataWGSLPipelineStage.generateMetadataWGSL`) declares those
   * bindings + emits `textureSample(...)` accessors inside
   * `initializeMetadata` for each GPU-compatible property-texture property
   * (channel swizzle + `czm_unpackTexture*` unpack + class offset/scale,
   * mirroring `MetadataPipelineStage.addPropertyTexturePropertyMetadata`).
   *
   * Unlike property ATTRIBUTES (`MODEL_HAS_METADATA`, vertex-buffer
   * transport), property textures are sampled in the FRAGMENT stage at the
   * property's interpolated `texCoord` — so this bit changes only the
   * material BGL / pipeline layout (a NEW `materialBGL` variant) + the
   * fragment-stage codegen, NOT the vertex layout. Non-property-texture
   * models (plain glTF OR attribute-only-metadata) never set the bit, keep
   * the minimal BGL, and stay byte-identical: the `//>>else` of every gated
   * block is the historical (absent) code, and the prepended chunk declares
   * no property-texture bindings.
   *
   * Per-primitive selection: `WebGPUModelRenderer` sets this bit only when
   * `model.structuralMetadata` is defined AND the primitive maps to ≥1
   * GPU-compatible property-texture property (the same predicate
   * `MetadataPipelineStage.getPropertyTexturesInfo` uses). The bit
   * participates in the model material BGL / pipeline / shader-module cache
   * key (folded into `MATERIAL_DEFINE_MASK`).
   *
   * Consumers: `ModelPBRComplete.wgsl` (metadata debug call site) + the
   * GENERATED metadata chunk.
   */
  MODEL_HAS_PROPERTY_TEXTURES: 1 << 19,

  /**
   * Model has EXT_structural_metadata property TABLES that map to the shader
   * (DP-H46d). A property table packs each GPU-compatible class property into
   * one ROW of a tightly-packed RGBA8 texture (built once by the loader,
   * `parseStructuralMetadata.createTextureForPropertyTable`): row =
   * `propertyInfoIndex` (index among GPU-compatible class properties), column =
   * feature ID. When set, the model material BGL gains ONE sampled
   * `texture_2d<f32>` binding for the table at group-1 binding
   * {@link PROPERTY_TABLE_BINDING} (in `WebGPUModelMetadata` /
   * `WebGPUModelPipelineCache`), and the GENERATED metadata WGSL chunk
   * (`MetadataWGSLPipelineStage.generateMetadataWGSL`) emits a
   * `textureLoad(propertyTableTexture, vec2<i32>(featureId, propertyInfoIndex), 0)`
   * accessor inside `initializeMetadata` for each GPU-compatible property
   * (RGBA→u32 little-endian unpack + bit-reinterpret/normalize + class
   * offset/scale, mirroring
   * `MetadataPipelineStage.addPropertyTablePropertyMetadata`). The feature ID is
   * the per-vertex `_FEATURE_ID_0` attribute (flat-interpolated to the FS) — the
   * SAME variable `MODEL_HAS_FEATURE_ID_0` carries, so a property-table primitive
   * also sets `MODEL_HAS_FEATURE_ID_0`.
   *
   * Like property TEXTURES (`MODEL_HAS_PROPERTY_TEXTURES`), this bit changes
   * only the material BGL / pipeline layout (a NEW `materialBGL` variant: one
   * extra sampled texture + one shared sampler) + the codegen, NOT the vertex
   * layout (the feature-ID slot is owned by `MODEL_HAS_FEATURE_ID_0`).
   * Non-property-table models (plain glTF, attribute-only, OR
   * property-texture-only metadata) never set the bit, keep the minimal BGL, and
   * stay byte-identical: the prepended chunk declares no table binding and emits
   * no `textureLoad`, and the gated material-BGL block is absent.
   *
   * Per-primitive selection: `WebGPUModelRenderer` sets this bit only when
   * `model.structuralMetadata` is defined AND the primitive maps to ≥1
   * GPU-compatible property-table property reachable via a feature-ID set (the
   * same predicate `MetadataPipelineStage.getPropertyTablesInfo` uses). The bit
   * participates in the model material BGL / pipeline / shader-module cache key
   * (folded into `MATERIAL_DEFINE_MASK`).
   *
   * Consumers: `ModelPBRComplete.wgsl` (metadata debug call site) + the
   * GENERATED metadata chunk.
   */
  MODEL_HAS_PROPERTY_TABLES: 1 << 20,

  /**
   * Metadata-pick producer for `scene.pickMetadata` on WebGPU (DP-H46e). This
   * is the WGSL sibling of the GLSL `MetadataPickingPipelineStage` +
   * `DerivedCommand.createPickMetadataDerivedCommand`. When set,
   * `ModelPBRComplete.wgsl` activates its `//>>ifdef METADATA_PICKING_ENABLED`
   * fragment entry (`fragmentPickMetadataMain`), which calls the GENERATED
   * `metadataPickingStage(metadata)` — appended to the metadata WGSL chunk by
   * `MetadataWGSLPipelineStage.generateMetadataPickWGSL` — and writes the
   * selected property's components (offset/scale + normalization UN-applied,
   * mirroring `getSourceValueStringComponent`) into the pick-FBO RGBA8 channels
   * that `MetadataPicking.decodeMetadataValues` decodes back to the value.
   *
   * Like `CAPTURE_MODE` and `LOG_DEPTH`, this bit is a render-MODE bit
   * intentionally OUTSIDE `MATERIAL_DEFINE_MASK`: it does NOT add a material
   * binding, change the vertex layout, or alter the pipeline layout — it only
   * forks the shader MODULE (the extra fragment entry + the appended
   * `metadataPickingStage`). `WebGPUModelPipelineCache._getOrCreateShaderModule`
   * preserves it from the raw `materialDefines` arg (like the capture bit) so
   * the pick-metadata pipeline gets a module that compiles the entry, while
   * on-screen / display callers never set it and keep a byte-identical module.
   *
   * The pick-metadata module is additionally keyed by a hash that folds in the
   * picked property name (via `_metadataClassHash`), so the module is cached
   * per (base-class, picked-property) — a single compiled module serves every
   * pick of that property regardless of pick coordinate (no per-component
   * pipeline explosion).
   *
   * Consumers: `ModelPBRComplete.wgsl` (`fragmentPickMetadataMain`) + the
   * GENERATED metadata-pick chunk.
   */
  METADATA_PICKING_ENABLED: 1 << 21,

  /**
   * Point-cloud Eye-Dome Lighting depth-writing variant
   * (PARITY-PC-EDL). When set, the point-cloud draw shader
   * (`PointCloud/PointCloudEDLDepth.wgsl`) emits a SECOND color output at
   * `@location(1)` carrying the point's linear eye-space depth packed into
   * RGBA8 (`csm_packDepth`), in addition to the normal `@location(0)` color.
   * This dual-output variant is compiled and rendered ONLY into the EDL
   * off-screen framebuffer (color + packed-depth attachments) when the user
   * turns on `pointCloudShading.eyeDomeLighting`; the neighbor-depth blend
   * pass (`Advanced/PointCloudEDL.wgsl`) then samples the packed-depth
   * attachment to darken depth-discontinuity edges and composites the result
   * back to the scene framebuffer.
   *
   * When clear (the default, and every non-EDL point-cloud draw), the
   * `//>>else` branch of the gated block strips the `@location(1)` output
   * declaration + the pack-depth write so the shader is byte-identical to the
   * single-target color shader — the off-screen framebuffer is never
   * allocated, the depth pipeline is never built, and the blend pass never
   * runs. So `defines=0` (and every on-screen point-cloud variant) preprocesses
   * to the historical source and the on-screen module hash is unchanged.
   *
   * Per-pass selection: only `WebGPUPointCloudEyeDomeLighting` ORs this bit in
   * when it builds the off-screen depth pipeline. The scene-FB color pipeline
   * in `WebGPUPointCloudRenderer` never sets it.
   *
   * Consumer: `PointCloud/PointCloudEDLDepth.wgsl`.
   */
  POINT_CLOUD_EDL_DEPTH: 1 << 22,

  /**
   * Model has a NATIVE-WGSL {@link CustomShader} (PARITY-CUSTOM-SHADER-WGSL).
   * When set, `ModelPBRComplete.wgsl` activates its `//>>ifdef
   * MODEL_HAS_WGSL_CUSTOM_SHADER` blocks: the fragment stage builds a
   * `czm_customModelMaterial` bridge from the computed lit color, calls the
   * GENERATED `czm_customFragmentMain` (the user's inlined
   * `wgslFragmentShaderText`), and writes the returned diffuse/alpha back into
   * the output color. The GENERATED chunk
   * (`CustomShaderWGSLPipelineStage.generateCustomShaderWGSL`) — declaring the
   * `CustomShaderUniforms` UBO (group-1 binding 50), any custom texture/sampler
   * pairs (bindings 51+), the bridge structs, and the inlined user body — is
   * prepended at the SAME single injection point in
   * `WebGPUModelPipelineCache._getOrCreateShaderModule` that the metadata chunk
   * uses.
   *
   * Like `MODEL_HAS_PROPERTY_TEXTURES`, this bit adds material-BGL bindings (the
   * customShader UBO + custom textures) and a distinct module, so it
   * participates in the model material BGL / pipeline / shader-module cache key
   * (folded into `MATERIAL_DEFINE_MASK`). When clear (the common case, and every
   * GLSL-only or no-customShader model), the `//>>else` of each gated block is
   * the historical (absent) code, the prepended chunk is empty, and the
   * preprocessed WGSL + compiled-module hash are byte-identical to the
   * pre-customShader path.
   *
   * Per-model selection: `WebGPUModelRenderer` sets this bit only when
   * `model.customShader` is defined AND carries `wgslFragmentShaderText` (a
   * GLSL-only customShader keeps the warn + no-op path — WGSL transpile is
   * deferred by design).
   *
   * Consumer: `ModelPBRComplete.wgsl`.
   */
  MODEL_HAS_WGSL_CUSTOM_SHADER: 1 << 23,

  /**
   * Model's NATIVE-WGSL {@link CustomShader} additionally supplies
   * `wgslVertexShaderText` (PARITY-CUSTOM-SHADER-WGSL). Independent of
   * `MODEL_HAS_WGSL_CUSTOM_SHADER` (fragment): a WGSL customShader may supply
   * only a fragment body, only a vertex body, or both. When set,
   * `ModelPBRComplete.wgsl` activates its `//>>ifdef MODEL_HAS_WGSL_CUSTOM_VERTEX`
   * block in `vertexMain`, which calls the GENERATED `czm_customVertexMain` (the
   * user's inlined `wgslVertexShaderText`). When clear, the block is stripped →
   * the vertex stage is byte-identical for fragment-only + non-customShader
   * models.
   *
   * Set by `WebGPUModelRenderer` only when `model.customShader.wgslVertexShaderText`
   * is defined. Folded into `MATERIAL_DEFINE_MASK` alongside the fragment bit so
   * distinct vertex bodies get distinct pipelines/modules.
   *
   * Consumer: `ModelPBRComplete.wgsl` (`vertexMain`).
   */
  MODEL_HAS_WGSL_CUSTOM_VERTEX: 1 << 24,

  /**
   * Voxel ray-march applies the voxel {@link CustomShader} colour mapping +
   * WebGL-matching front-to-back accumulation (PARITY-VOXEL-COLOR-PARITY).
   * When set, `WebGPUVoxelRenderer`'s inline `VOXEL_WGSL` fragment stage
   * activates its `//>>ifdef VOXEL_CUSTOM_SHADER_COLOR` block: instead of the
   * historical "output the raw sampled RGBA scaled by `s.a * stepSize`"
   * accumulation, each ray-march sample is turned into a `material.diffuse` /
   * `material.alpha` pair via the DEFAULT voxel customShader mapping (the same
   * `material.diffuse = property.rgb; material.alpha = property.a` that
   * `buildVoxelCustomShader`'s VEC4 branch emits for an un-styled
   * VoxelBox3DTiles), then blended with Cesium's premultiplied-alpha
   * front-to-back integral (`colorAccum += (1 - colorAccum.a) *
   * vec4(diffuse * alpha, alpha)`) and normalised by `ALPHA_ACCUM_MAX = 0.98`
   * exactly as `Shaders/Voxels/VoxelFS.glsl` does. This makes an un-styled
   * WebGPU voxel box match the WebGL colour (gray for VoxelBox3DTiles) instead
   * of the previous raw-texel green/teal.
   *
   * Per-primitive selection: `WebGPUVoxelRenderer` ORs this bit into the COLOR
   * pipeline's shader-module + pipeline cache keys ONLY when a real voxel
   * provider's root tile has been uploaded (`cache.usingRealData === true`).
   * The pick + velocity pipelines never set it. When clear (the placeholder /
   * no-provider off-gate, and every pick/velocity variant) the `//>>else`
   * branch of the gated block is the historical accumulation source
   * byte-for-byte, so `preprocess(VOXEL_WGSL, 0)` is unchanged and the
   * placeholder module hash + off-gate render are byte-identical to Batch 475.
   *
   * Consumer: `WebGPUVoxelRenderer.ts` (inline `VOXEL_WGSL` fragmentMain).
   */
  VOXEL_CUSTOM_SHADER_COLOR: 1 << 25,

  /**
   * Model split-screen rendering (WIRE-MODEL-SPLITTER) — the glTF-model
   * sibling of the collections' `SPLIT_ENABLED` bit, matching WebGL's
   * `ModelSplitterPipelineStage` / `ModelSplitterStageFS.glsl`. When set,
   * `ModelPBRComplete.wgsl` activates its `//>>ifdef MODEL_SPLIT_ENABLED`
   * fragment blocks (fragmentMain + fragmentPickMain): the FS discards
   * fragments on the wrong side of the split slider —
   *   `splitDirection < 0` (LEFT)  → discard when `fragCoord.x > czm_splitPosition`
   *   `splitDirection > 0` (RIGHT) → discard when `fragCoord.x < czm_splitPosition`
   * The two scalars ride the material UB's historical pad lanes (floats
   * 38/39, `_pad_end2`/`_pad_end3` — splitDirection and
   * `frameState.splitPosition * drawingBufferWidth` in framebuffer pixels),
   * so the struct layout / BGL / pipeline layout are unchanged — this is a
   * render-MODE bit like `LOG_DEPTH`, intentionally OUTSIDE
   * `MATERIAL_DEFINE_MASK`.
   *
   * Per-model selection: `WebGPUModelRenderer` mirrors
   * `model.splitDirection !== SplitDirection.NONE` into the per-model
   * pipeline cache via `maybeUpdateForSplit()` (the `maybeUpdateForLogDepth`
   * pattern — a flip wipes pipelines so modules recompile with/without the
   * bit). When clear (the default), every gated block is stripped and the
   * preprocessed module is byte-identical to the pre-splitter source.
   *
   * The shader-module cache retains the full Uint32 define mask, so this
   * high bit directly distinguishes split and non-split modules.
   *
   * Consumer: `ModelPBRComplete.wgsl`.
   */
  MODEL_SPLIT_ENABLED: 1 << 26,

  /**
   * Model colour blend (WIRE-MODEL-COLOR) — the WebGPU sibling of WebGL's
   * `ModelColorPipelineStage` / `ModelColorStageFS.glsl`. When set,
   * `ModelPBRComplete.wgsl` activates its `//>>ifdef MODEL_HAS_COLOR`
   * blocks: a module-scope `applyModelColor()` helper plus call sites in
   * `fragmentMain` (main lit path, after the customShader hook — matching
   * WebGL's ModelFS.glsl stage order lightingStage → cpuStylingStage →
   * modelColorStage — and the unlit early-out) that blend `model.color`
   * into the display-space colour with the exact GLSL math:
   *   diffuse  = mix(diffuse, model_color.rgb, model_colorBlend);
   *   diffuse *= mix(model_color.rgb, vec3(1.0), ceil(model_colorBlend));
   *   alpha   *= model_color.a;
   * where `model_colorBlend` is `ColorBlendMode.getColorBlend(mode, amount)`
   * (0 = HIGHLIGHT, 1 = REPLACE, (0,1] = MIX amount).
   *
   * The two uniforms ride the material UB's historical reserved lanes
   * (floats 184-187 `_pad_reserved8` = model.color RGBA, float 175
   * `motionFlags.w` = colorBlend), so the struct layout / BGL / pipeline
   * layout are unchanged — this is a render-MODE bit like
   * `MODEL_SPLIT_ENABLED`, intentionally OUTSIDE `MATERIAL_DEFINE_MASK`.
   *
   * Per-model selection: `WebGPUModelRenderer` mirrors
   * `defined(model.color)` into the per-model pipeline cache via
   * `maybeUpdateForModelColor()` (the `maybeUpdateForSplit` pattern — a
   * flip wipes pipelines so modules recompile with/without the bit). When
   * clear (the default — `model.color` undefined), every gated block is
   * stripped and the preprocessed module is byte-identical to the
   * pre-model-color source.
   *
   * The shader-module cache retains the full Uint32 define mask, so this
   * high bit directly distinguishes colour and non-colour modules.
   *
   * Consumer: `ModelPBRComplete.wgsl`.
   */
  MODEL_HAS_COLOR: 1 << 27,

  /**
   * Model silhouette rendering (WIRE-MODEL-SILHOUETTE) — the WebGPU
   * sibling of WebGL's `ModelSilhouettePipelineStage` /
   * `ModelSilhouetteStageVS/FS.glsl` + `ModelDrawCommand`'s
   * `deriveSilhouetteModelCommand` / `deriveSilhouetteColorCommand`
   * stencil two-pass. When set:
   *   - `WebGPUModelPipelineCache._getOrCreateShaderModule` prepends the
   *     `ModelSilhouetteStage.wgsl` chunk (the inflate + colour helpers).
   *   - `ModelPBRComplete.wgsl` activates its `//>>ifdef MODEL_SILHOUETTE`
   *     blocks: a VS call site that inflates clip-space `position.xy`
   *     along the eye-space normal, and an FS early-return (after the
   *     alpha-mask discard, matching WebGL's cutout behaviour) that
   *     emits the silhouette colour.
   *   - Both blocks gate at runtime on `material._pad_tt2 > 0.5` (the
   *     "silhouette pass" flag), so the BASE command (stencil-write pass,
   *     flag 0) renders the model normally while the DERIVED colour
   *     command (stencil not-equal pass, flag 1) draws the inflated rim.
   *
   * Uniform lanes (material UB historical pads — struct layout / BGL /
   * pipeline layout unchanged; render-MODE bit like `MODEL_HAS_COLOR`,
   * intentionally OUTSIDE `MATERIAL_DEFINE_MASK`):
   *   - float 105 `_pad_tt0` = expandX (proj[0][0] · silhouetteSize ·
   *     pixelRatio / drawingBufferWidth — WebGL's per-vertex scale
   *     pre-folded on the CPU)
   *   - float 106 `_pad_tt1` = expandY (proj[1][1] · same scale)
   *   - float 107 `_pad_tt2` = silhouette-pass flag (0 base / 1 colour)
   *   - floats 112-115 `_pad_cc0` = silhouetteColor RGBA
   *
   * Per-model selection: `WebGPUModelRenderer` mirrors the WebGL
   * `Model.hasSilhouette()` predicate (`silhouetteSize > 0 &&
   * silhouetteColor.alpha > 0 && !classificationType`) into the
   * per-model pipeline cache via `maybeUpdateForSilhouette()` (the
   * `maybeUpdateForModelColor` pattern). When clear (the default —
   * `silhouetteSize === 0`), every gated block is stripped, the chunk
   * is not prepended, and the preprocessed module is byte-identical to
   * the pre-silhouette source.
   *
   * The shader-module cache retains the full Uint32 define mask, so this
   * high bit directly distinguishes silhouette and base modules.
   *
   * Consumers: `ModelPBRComplete.wgsl`, `ModelSilhouetteStage.wgsl`.
   */
  MODEL_SILHOUETTE: 1 << 28,

  /**
   * Voxel ray-march runs a USER-supplied native-WGSL {@link CustomShader}
   * (VOXEL-USER-CUSTOMSHADER) instead of the default gray mapping. When set,
   * the `//>>ifdef VOXEL_USER_CUSTOM_SHADER` block NESTED inside
   * `VOXEL_CUSTOM_SHADER_COLOR`'s parity march (see `WebGPUVoxelRenderer`'s
   * inline `VOXEL_WGSL`) replaces the default-shader material derivation with
   * a call to the GENERATED `czm_voxelCustomFragmentMain` — the user's
   * `wgslFragmentShaderText` inlined by
   * `WebGPUVoxelCustomShaderCodegen.generateVoxelUserShaderChunk`, which maps
   * the sampled megatexture texel onto `fsInput.metadata.<propertyName>`
   * (typed per the provider's first metadata property) and accumulates the
   * user's `material.diffuse` / `material.alpha` with the SAME
   * premultiplied-alpha front-to-back integral WebGL's VoxelFS.glsl uses.
   *
   * Per-primitive selection: `WebGPUVoxelRenderer` ORs this bit into the
   * COLOR module's defines ONLY when a real voxel provider's root tile has
   * uploaded AND the primitive carries a NON-default customShader with
   * `wgslFragmentShaderText` and no uniforms (uniform/texture support is a
   * documented follow-up — such shaders warn + fall back to the default gray
   * path, as do GLSL-only voxel customShaders). When clear the nested
   * `//>>else` branch is the Batch 476 default-gray block byte-for-byte, so
   * both `preprocess(VOXEL_WGSL, 0)` and
   * `preprocess(VOXEL_WGSL, VOXEL_CUSTOM_SHADER_COLOR)` are unchanged —
   * off-gate byte-identical.
   *
   * The define bit participates directly in the full Uint32 cache key. The
   * generated chunk's FNV-1a hash remains the `keySalt` only to disambiguate
   * DIFFERENT user shader bodies sharing the same `(sourceId, defines)`.
   *
   * Consumer: `WebGPUVoxelRenderer.ts` (inline `VOXEL_WGSL` fragmentMain).
   */
  VOXEL_USER_CUSTOM_SHADER: 1 << 29,

  /**
   * Model's transported EXT_structural_metadata property ATTRIBUTE is a
   * MAT3/MAT4 — full 9/16-component transport (NEW-MODEL-METADATA-MAT3-MAT4).
   * The base `MODEL_HAS_METADATA` transport is ONE `float32x4` vertex
   * attribute at shader location 9 (vertex buffer slot appended last), which
   * carries at most four components; MAT3 (9) / MAT4 (16) properties
   * previously zero-filled everything past the first four. When THIS bit is
   * set (always alongside `MODEL_HAS_METADATA`), the slot-9 vertex buffer
   * widens to `arrayStride = 64` carrying FOUR `float32x4` attributes at
   * shader locations 9-12 (offsets 0/16/32/48 — 16 floats per vertex,
   * column-major matrix elements, MAT3 zero-pads elements 9..15), and
   * `ModelPBRComplete.wgsl` activates the nested
   * `//>>ifdef MODEL_METADATA_MAT_TRANSPORT` blocks: `metadataValue1..3`
   * vertex inputs (locations 10-12), flat varyings (locations 13-15), and the
   * extended 7-arg `initializeMetadata(metadataValue, metadataValue1,
   * metadataValue2, metadataValue3, texCoord0, texCoord1, featureId)` call.
   * The GENERATED chunk (`MetadataWGSLPipelineStage.generateMetadataWGSL`)
   * emits the matching extended signature and reassembles the full matrix in
   * `constructFromTransport` (per-element offset/scale still baked).
   *
   * Per-primitive selection: `WebGPUModelRenderer` sets the pipeline cache's
   * sticky `metadataMatTransport` state (NOT a `materialDefines` bit — bit 30
   * would overflow `computeKey`'s `md << 3` pipeline-key packing) from the
   * codegen's `matTransport` result, which is true only when the transported
   * first property attribute is MAT3/MAT4 AND the CPU pack
   * (`WebGPUModelMetadata.resolvePropertyAttributeVec4`) widened to 16
   * floats/vertex for the SAME property — both sides derive from the same
   * resolve, so layout and codegen can never disagree. When clear (every
   * scalar/VEC/MAT2 metadata model and every non-metadata model), all gated
   * blocks strip to the historical source and the module/pipeline keys are
   * byte-identical to the pre-MAT-transport path.
   *
   * The define bit participates directly in the full Uint32 shader-module
   * cache key; the generated metadata class still supplies `keySalt` for its
   * dynamic source content. The pipeline maps append a `:m34` key suffix.
   *
   * Consumers: `ModelPBRComplete.wgsl` + the GENERATED metadata chunk.
   */
  MODEL_METADATA_MAT_TRANSPORT: 1 << 30,
} as const);

// ============================================================================
// Hi-word registry (C11-149 / NEW-WEBGPU-SHADERDEFINE-WIDTH-EXPANSION)
// ============================================================================

declare const shaderDefineHiBrand: unique symbol;

/**
 * Branded numeric type for a HI-word define bit or mask. The brand is a
 * compile-time-only property (erased at runtime — values are plain
 * numbers, allocation-free); its purpose is directional safety: a
 * `ShaderDefineHiMask` is NOT assignable to {@link ShaderDefineLoMask},
 * so passing a hi-word bit where a lo-word `defines` mask is expected is
 * a COMPILE ERROR instead of a silent `defines & BIT === 0` that would
 * quietly emit the `//>>else` branch of the gated block (wrong shader,
 * no throw — the dominant failure mode this type exists to prevent).
 */
export type ShaderDefineHiMask = number & {
  readonly [shaderDefineHiBrand]: "ShaderDefineHi";
};

/**
 * "Flavored" lo-word mask type: every plain `number` (including all
 * `ShaderDefine` bits and any bitwise combination of them) is assignable,
 * but a branded {@link ShaderDefineHiMask} is REJECTED at compile time.
 * Use this as the parameter type of any API that consumes a lo-word
 * defines mask (`preprocess`, `WebGPUShaderModuleCache.getOrCreate`).
 *
 * Limitation (documented, not enforceable without breaking every
 * existing call site): the REVERSE mistake — a lo-word bit passed as a
 * `definesHi` argument — cannot be compile-checked, because lo bits are
 * plain numbers. Hi-word parameters are named `definesHi` everywhere so
 * the mistake is at least greppable/reviewable.
 */
export type ShaderDefineLoMask = number & {
  readonly [shaderDefineHiBrand]?: never;
};

/**
 * Construct a hi-word define bit. Bits 0..30 only — hi-word bit 31 is
 * reserved (mirroring the lo word, where bit 31 was historically aliased
 * by an out-of-band pipeline-key fold; keeping the sign bit of BOTH
 * words permanently unclaimed means `mask | 0` / `mask >>> 0`
 * normalization can never change which defines a mask names).
 */
function hiDefineBit(bitIndex: number): ShaderDefineHiMask {
  if (!Number.isInteger(bitIndex) || bitIndex < 0 || bitIndex > 30) {
    throw new RangeError(
      `ShaderDefineHi bits must use bit indices 0..30 (got ${bitIndex}); hi-word bit 31 is reserved`,
    );
  }
  return ((1 << bitIndex) >>> 0) as ShaderDefineHiMask;
}

/**
 * HI-word preprocessor defines — the second Uint32 of the widened
 * `(defines, definesHi)` pair (C11-149). A DISTINCT namespace from
 * {@link ShaderDefine}: names must be unique across BOTH tables (asserted
 * at module load), and a hi-word `//>>ifdef FLAG` resolves against the
 * `definesHi` argument of `preprocess`, never against the lo word.
 *
 * Claim bits here for every NEW specialization axis (the lo word is
 * full): enhanced-ocean (C11-158), model uber-shader axes
 * (C11-81/88/89/92), tiles (C11-131), etc. Bits 0-30 of this word are
 * claimable; bit 31 stays reserved.
 *
 * **Add-only; never reorder or remove.**
 */
export const ShaderDefineHi = Object.freeze({
  /**
   * Permanently-reserved validation probe (C11-149). Consumed ONLY by
   * the widening specs (`WebGPUShaderDefinesSpec`,
   * `WebGPUShaderPreprocessorHiSpec`, `WebGPUShaderModuleCacheSpec`) to
   * exercise the hi-word resolve → preprocess → cache-key path
   * end-to-end against a REAL registry entry; no production renderer
   * ever sets it and no shipped WGSL gates on it. Kept forever per the
   * add-only rule — without it the hi path would only be testable
   * against an empty table (i.e., not at all).
   */
  HI_WORD_PROBE: hiDefineBit(0),

  /**
   * Globe enhanced-ocean STYLING variant (C11-158 /
   * NEW-WEBGPU-ENHANCED-OCEAN-DEFAULT-PARITY-TOGGLE). The FIRST production
   * consumer of the hi-word registry. When set, `GlobeTerrain.wgsl`'s
   * `computeEnhancedOcean` emits its `//>>ifdef ENHANCED_OCEAN` branch — the
   * WebGPU-only enhanced ocean look (foam whitecaps layered over the
   * full-strength wave-perturbed diffuse / non-diffuse / Phong-specular
   * highlight composite). When clear (the DEFAULT, matching WebGL), it emits
   * the `//>>else` branch: a faithful port of WebGL's classic
   * `computeWaterColor` (GlobeFS.glsl L807-878) — imagery preserved, the same
   * wave-diffuse + non-diffuse + Phong-specular highlights added on top, but
   * NO foam / SSS / GGX / deep-colour styling.
   *
   * The gate is STYLING-ONLY. The shared wave-normal march
   * (`sampleOceanWaveNormals` → perturbed `waterNormal` / `tsPerturbationRatio`)
   * runs UNCONDITIONALLY and feeds BOTH branches, so the toggle never touches
   * the waves — those stay parity-preserving under the same default-true
   * `globe.showWaterEffect` on both backends. Only how the perturbed surface
   * is coloured changes.
   *
   * Gating (single flip point): OR'd in when `host._enhancedOceanEnabled` is
   * true, mirrored each frame from `Globe.enableEnhancedOcean` (default
   * FALSE → classic WebGL-parity water). The bit participates in the
   * shader-module cache's hi-word level (`getOrCreate(..., definesHi)`) and the
   * globe pipeline's descriptor-name cache key; a runtime flip wipes the
   * renderer-local globe pipeline caches so the module + pipeline re-resolve
   * without a reload.
   *
   * Consumer: `GlobeTerrain.wgsl` (`computeEnhancedOcean`).
   */
  ENHANCED_OCEAN: hiDefineBit(1),
} as const);

// Namespace-collision boot assertion: a name living in BOTH tables would
// make `//>>ifdef NAME` ambiguous (lo test vs hi test). Fails loudly at
// module load, which is effectively compile time for the bundle.
for (const name of Object.keys(ShaderDefineHi)) {
  if (name in ShaderDefine) {
    throw new Error(
      `WebGPUShaderDefines: "${name}" is declared in BOTH ShaderDefine (lo) ` +
        `and ShaderDefineHi (hi) — flag names must be unique across the two ` +
        `registries or //>>ifdef resolution is ambiguous.`,
    );
  }
}

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
  // PARITY-PC-EDL. Point-cloud Eye-Dome Lighting depth-writing draw
  // shader (`PointCloud/PointCloudEDLDepth.wgsl`, source 38) + the
  // neighbor-depth blend/composite shader
  // (`Advanced/PointCloudEDL.wgsl`, source 39). Both compile ONLY when
  // the user enables `pointCloudShading.eyeDomeLighting`; add-only.
  POINT_CLOUD_EDL_DEPTH: 38,
  POINT_CLOUD_EDL_BLEND: 39,
  // C6-FLOWFIELD-WIND (Campaign 6). The instanced storage-buffer-vertex-pull
  // wind-particle render shader (`FlowFieldRender.wgsl`). Resolves through the
  // module cache so its `//>>ifdef LOG_DEPTH` blocks preprocess and the
  // log-depth color/depth-write variant dedupes per (sourceId, defines).
  // The advection compute module (`FlowFieldAdvect.wgsl`) has no ifdef blocks
  // and is created directly by the renderer, so it needs no source id.
  // Add-only.
  FLOW_FIELD_RENDER: 40,
  // C6-FFT-OCEAN (Campaign 6/7). The displaced ocean-surface render shader
  // (`Ocean/OceanSurface.wgsl`). Resolves through the module cache so its
  // `//>>ifdef LOG_DEPTH` blocks preprocess and the log-depth variant dedupes
  // per (sourceId, defines). The FFT compute modules (initial-spectrum, twiddle,
  // time-evolve, IFFT, merge) have no ifdef blocks and are created directly by
  // the renderer, so they need no source id. Add-only.
  OCEAN_SURFACE: 41,
} as const);

/**
 * Debug helper: expand a lo-word defines bitmask back into the set of
 * active define names. Intended only for diagnostic output (cache dumps,
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
 * Debug helper: hi-word sibling of {@link defineKeyToNames}. Diagnostic
 * output only.
 */
export function defineHiKeyToNames(definesHi: number): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(ShaderDefineHi)) {
    if ((definesHi & (bit as number)) !== 0) names.push(name);
  }
  return names;
}

/**
 * Resolve a LO-word define flag name to its bit. Returns `undefined` for
 * unknown names so the preprocessor can produce a clear error.
 *
 * C11-149 fail-loud rule: if `name` is a HI-word define
 * ({@link ShaderDefineHi}), this THROWS instead of returning `undefined`
 * — a legacy caller that resolved a hi name through the lo path and
 * tested the result against a lo mask would silently read the wrong bit
 * (and a silent `undefined` would misreport a REGISTERED define as
 * unknown). Callers that legitimately handle both words must check
 * {@link resolveDefineBitHi} FIRST (as the preprocessor does).
 */
export function resolveDefineBit(name: string): number | undefined {
  if ((ShaderDefineHi as Record<string, number>)[name] !== undefined) {
    throw new Error(
      `WebGPUShaderDefines: "${name}" is a HI-word define (ShaderDefineHi). ` +
        `Resolve it with resolveDefineBitHi and test it against a definesHi ` +
        `mask — testing it against the lo word would silently read the wrong bit.`,
    );
  }
  return (ShaderDefine as Record<string, number>)[name];
}

/**
 * Resolve a HI-word define flag name to its branded bit. Returns
 * `undefined` for names not in {@link ShaderDefineHi} (including lo-word
 * names — this resolver never throws, so the preprocessor can probe it
 * first and fall through to the lo path).
 */
export function resolveDefineBitHi(
  name: string,
): ShaderDefineHiMask | undefined {
  return (ShaderDefineHi as Record<string, ShaderDefineHiMask>)[name];
}
