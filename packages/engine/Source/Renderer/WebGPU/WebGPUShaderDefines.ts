/**
 * @module WebGPUShaderDefines
 *
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
