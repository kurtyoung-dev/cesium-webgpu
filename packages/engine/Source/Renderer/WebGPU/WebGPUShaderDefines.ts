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
