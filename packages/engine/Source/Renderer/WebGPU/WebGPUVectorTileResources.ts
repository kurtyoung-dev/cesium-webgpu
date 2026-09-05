/// <reference types="@webgpu/types" />
/**
 * WebGPU realization of a terrain tile's
 * clamped vector-polyline lookup tables.
 *
 * Upstream v1.144 (PR #13577) drapes `BufferPolylineCollection` geometry onto
 * terrain by baking, per surface tile, a grid-indexed segment lookup
 * (`VectorPipeline` → `VectorTileData`) and reading it back from the globe
 * fragment shader. On WebGL that lookup is five `sampler2D`s consumed by
 * `VectorCommon.glsl` with `texelFetch` — nearest sampling, integer
 * coordinates, power-of-two padding, no filtering. `texelFetch` there is not
 * texture sampling; it is WebGL2's only way to random-access a buffer from a
 * fragment shader.
 *
 * WebGPU has read-only storage buffers, so the WGSL twin
 * (`GlobeTerrain.wgsl::vectorPolylineRender`) reads ONE buffer instead of five
 * textures. That is a forced choice, not a stylistic one: the globe pipeline
 * layout is budgeted at `GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES` (12) fragment
 * sampled textures besides the imagery slots, and on a default-limit adapter
 * (`maxSampledTexturesPerShaderStage` = 16, the WebGPU spec floor) the reduced
 * 4-slot imagery layout already sits at exactly 16. Adding five more sampled
 * textures would break the globe outright on those devices; a storage buffer
 * costs zero sampled-texture budget.
 *
 * WORD LAYOUT (matched pair with `GlobeTerrain.wgsl` — neither side may change
 * alone; `Tools/visual-regression/vector-layer-draping.spec.mjs` pins them
 * against each other):
 *
 * ```
 *   [0] gridWidth        [1] gridHeight
 *   [2] segmentCount     [3] primitiveCount
 *   [4] cellEndOffsetsBase           [5] segmentsBase
 *   [6] segmentPrimitiveIndicesBase  [7] primitivesBase
 *   cell end offsets  : gridWidth * gridHeight  u32
 *   segments          : segmentCount * 4        f32  (ax, ay, bx, by) tile UV
 *   segment→primitive : segmentCount            u32
 *   primitives        : primitiveCount * 2      (f32 lineWidth, u32 RGBA8)
 * ```
 *
 * `gridWidth === 0` is the "nothing draped here" sentinel the shader gates on,
 * which is also what the 32-byte all-zero placeholder buffer reads as.
 *
 * @module WebGPUVectorTileResources
 */

/** Header word indices. Mirrored by `VECTOR_TILE_*` consts in the WGSL. */
export const VECTOR_TILE_GRID_WIDTH = 0;
export const VECTOR_TILE_GRID_HEIGHT = 1;
export const VECTOR_TILE_SEGMENT_COUNT = 2;
export const VECTOR_TILE_PRIMITIVE_COUNT = 3;
export const VECTOR_TILE_CELL_END_BASE = 4;
export const VECTOR_TILE_SEGMENTS_BASE = 5;
export const VECTOR_TILE_SEGMENT_PRIMITIVE_BASE = 6;
export const VECTOR_TILE_PRIMITIVES_BASE = 7;
/** Number of header words preceding the first variable-length run. */
export const VECTOR_TILE_HEADER_WORDS = 8;
/** Size of the shared all-zero "no vector data" buffer, in bytes. */
export const VECTOR_TILE_PLACEHOLDER_BYTES = VECTOR_TILE_HEADER_WORDS * 4;

/**
 * The CPU-side stage-2 product of `VectorPipeline.packPolylineGrid`, plus the
 * per-primitive material bytes collected by `packPolylineSegments`. Declared
 * structurally: `VectorTileData` is a JSDoc typedef on an untyped JS module,
 * and this file must stay importable by a pure-Node spec.
 */
export interface VectorTileCpuData {
  /** Packed RGBA line segments (ax, ay, bx, by) in tile UV space, -1 filled. */
  polylineSegmentTexels?: Float32Array;
  /** Primitive index per packed segment, -1 filled. */
  polylineSegmentPrimitiveIndicesTexels?: Float32Array;
  /** `[gridWidth, gridHeight, ...per-cell end offsets]`. */
  polylineGridCellIndices?: Uint32Array;
  /**
   * Per-collection primitive widths, in collection order. Signed since
   * CesiumJS 1.145: a negative magnitude marks a width in meters on the
   * ground, a positive one a width in screen pixels. Typed loosely because
   * `VectorPipeline` moved these from `Uint8Array` to signed `Float32Array`
   * in that release, while older bakes and this packer's specs still supply
   * bytes.
   */
  widths?: ArrayLike<number>[];
  /** Per-collection primitive RGBA bytes, in collection order. */
  colors?: Uint8Array[];
  /** Total primitive count across every contributing collection. */
  primitiveCount?: number;
}

/**
 * Backend-owned GPU resources hung off a `VectorTileData` by
 * {@link prepareWebGPUVectorTileData}. `VectorPipeline.freeResources` calls
 * `destroy()` when the tile's vector data is released.
 */
export interface VectorTileRendererResources {
  /** The device the buffer belongs to — checked before binding (multi-context). */
  readonly device: GPUDevice;
  /** WebGPUContext recovery epoch owning every native handle in this record. */
  readonly resourceGeneration: number;
  /** Whether the retained CPU bake produced a non-placeholder buffer. */
  readonly hasVectorData: boolean;
  /** Null once destroyed. */
  buffer: GPUBuffer | null;
  /** Exact backend-ownership check used during pre-render tile preparation. */
  isCompatible(context: VectorTileDeviceContext): boolean;
  destroy(): void;
}

/** Minimal context shape: native ownership is the exact device/generation pair. */
interface VectorTileDeviceContext {
  readonly device?: GPUDevice | null;
  readonly resourceGeneration?: number;
}

/** `VectorTileData` with the optional backend slot this module writes. */
interface VectorTileDataWithResources extends VectorTileCpuData {
  rendererResources?: VectorTileRendererResources | undefined;
}

/**
 * Concatenate the per-collection byte runs in collection order. This must use
 * the SAME order `VectorPipeline.packPolylineSegments` used when it assigned
 * `segmentPrimitiveIndices` (running `result.primitiveCount + i` offsets),
 * otherwise a segment resolves to another collection's material.
 */
function concatByteArrays(arrays: Uint8Array[]): Uint8Array {
  let totalByteLength = 0;
  for (const array of arrays) {
    totalByteLength += array.length;
  }
  const result = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

/**
 * Concatenate per-collection numeric runs in collection order, preserving
 * each element's VALUE rather than its bytes. Widths crossed from
 * `Uint8Array` to signed `Float32Array` in CesiumJS 1.145 and this packer
 * mirrors the WebGL float texture exactly, so they cannot go through a byte
 * buffer.
 */
function concatNumbers(arrays: ArrayLike<number>[]): Float32Array {
  let total = 0;
  for (const array of arrays) {
    total += array.length;
  }
  const result = new Float32Array(total);
  let offset = 0;
  for (const array of arrays) {
    for (let i = 0; i < array.length; i++) {
      result[offset + i] = array[i];
    }
    offset += array.length;
  }
  return result;
}

/**
 * Pack a baked `VectorTileData` into the flat word array the WGSL reads.
 *
 * Returns `null` when the tile has nothing to drape (no grid, an empty grid,
 * or zero packed segments) — the caller then binds the placeholder buffer.
 * Pure: no device, no allocation beyond the returned array, deterministic for
 * a given input.
 */
export function packVectorTileWords(
  data: VectorTileCpuData | null | undefined,
): Uint32Array | null {
  const grid = data?.polylineGridCellIndices;
  const segmentTexels = data?.polylineSegmentTexels;
  const segmentPrimitiveTexels = data?.polylineSegmentPrimitiveIndicesTexels;
  if (!grid || !segmentTexels || !segmentPrimitiveTexels) {
    return null;
  }

  const gridWidth = grid[0] >>> 0;
  const gridHeight = grid[1] >>> 0;
  const cellCount = gridWidth * gridHeight;
  // `gridCellIndices` is [gridWidth, gridHeight, end0 … end(cellCount-1)].
  if (gridWidth === 0 || gridHeight === 0 || grid.length < cellCount + 2) {
    return null;
  }

  const primitiveCount = Math.max(0, Math.trunc(data?.primitiveCount ?? 0));
  if (primitiveCount === 0) {
    return null;
  }

  // The last cell's end offset IS the total packed (segment, cell) pair count.
  // Clamp against what the texel arrays can actually supply so a truncated or
  // stale bake can never make the shader walk past the run it was given.
  const segmentCount = Math.min(
    grid[cellCount + 1] >>> 0,
    segmentTexels.length >>> 2,
    segmentPrimitiveTexels.length,
  );
  if (segmentCount === 0) {
    return null;
  }

  const cellEndBase = VECTOR_TILE_HEADER_WORDS;
  const segmentsBase = cellEndBase + cellCount;
  const segmentPrimitiveBase = segmentsBase + segmentCount * 4;
  const primitivesBase = segmentPrimitiveBase + segmentCount;
  const totalWords = primitivesBase + primitiveCount * 2;

  const words = new Uint32Array(totalWords);
  const floats = new Float32Array(words.buffer);

  words[VECTOR_TILE_GRID_WIDTH] = gridWidth;
  words[VECTOR_TILE_GRID_HEIGHT] = gridHeight;
  words[VECTOR_TILE_SEGMENT_COUNT] = segmentCount;
  words[VECTOR_TILE_PRIMITIVE_COUNT] = primitiveCount;
  words[VECTOR_TILE_CELL_END_BASE] = cellEndBase;
  words[VECTOR_TILE_SEGMENTS_BASE] = segmentsBase;
  words[VECTOR_TILE_SEGMENT_PRIMITIVE_BASE] = segmentPrimitiveBase;
  words[VECTOR_TILE_PRIMITIVES_BASE] = primitivesBase;

  for (let i = 0; i < cellCount; i++) {
    // Monotone-clamp each cell end into [0, segmentCount] so the shader's
    // `[start, end)` walk stays inside the segment run even if the bake and
    // the texel arrays disagree.
    words[cellEndBase + i] = Math.min(grid[i + 2] >>> 0, segmentCount);
  }

  for (let i = 0; i < segmentCount * 4; i++) {
    floats[segmentsBase + i] = segmentTexels[i];
  }

  for (let i = 0; i < segmentCount; i++) {
    const raw = segmentPrimitiveTexels[i];
    // -1 is the fill value; anything out of range would read another
    // primitive's material, so clamp instead of trusting the bake.
    const index = Number.isFinite(raw) ? Math.trunc(raw) : 0;
    words[segmentPrimitiveBase + i] = Math.min(
      Math.max(index, 0),
      primitiveCount - 1,
    );
  }

  const widthValues = concatNumbers(data?.widths ?? []);
  const colorBytes = concatByteArrays(data?.colors ?? []);
  for (let i = 0; i < primitiveCount; i++) {
    const p = primitivesBase + i * 2;
    // The width crosses by VALUE, whatever element type the bake used.
    // Routing a 1.145 Float32Array through a byte buffer would truncate a
    // fractional width, wrap one above 255, and turn a negative (meters)
    // width into a large positive pixel one.
    floats[p] = widthValues[i] ?? 0;
    const r = colorBytes[i * 4] ?? 0;
    const g = colorBytes[i * 4 + 1] ?? 0;
    const b = colorBytes[i * 4 + 2] ?? 0;
    const a = colorBytes[i * 4 + 3] ?? 0;
    // Low byte first — the order `unpack4x8unorm` returns as (r, g, b, a).
    words[p + 1] = (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
  }

  return words;
}

/**
 * Realize a baked `VectorTileData` as a WebGPU storage buffer, hung off the
 * data object as `rendererResources`. Realization is idempotent for one exact
 * `(device, resourceGeneration)` pair. A recovery epoch or device change
 * destroys the stale buffer and re-uploads the retained stage-2 CPU bake once.
 *
 * Registered on the `GLOBE_SURFACE` feature-renderer descriptor as
 * `prepareVectorTileData`, so `VectorPipeline.packPrimitiveTextures` can hand
 * the bake to whichever backend is active without importing this module or
 * testing `isWebGPU` (CLAUDE.md Principle 2).
 *
 * Returns `true` whenever the WebGPU backend has taken ownership — INCLUDING
 * the "nothing to drape" case, where no buffer is created and the globe binds
 * its shared placeholder. Returning `false` would fall through to the WebGL
 * texture path and allocate five GL textures the WebGPU globe never reads.
 */
export function prepareWebGPUVectorTileData(
  context: VectorTileDeviceContext | null | undefined,
  data: VectorTileCpuData | null | undefined,
): boolean {
  const device = context?.device;
  if (!device || !data) {
    return false;
  }

  const target = data as VectorTileDataWithResources;
  const resourceGeneration = context?.resourceGeneration ?? 0;
  const existing = target.rendererResources;
  if (existing?.isCompatible(context)) {
    return true;
  }

  // The stage-2 arrays stay on VectorTileData after the first realization.
  // A recovered device/generation reuses that backend-neutral CPU bake here,
  // during tile preparation, rather than returning a placeholder from the
  // draw path or asking VectorProvider to rebuild geometry.
  existing?.destroy();
  target.rendererResources = undefined;

  const words = packVectorTileWords(data);
  let buffer: GPUBuffer | null = null;
  if (words) {
    buffer = device.createBuffer({
      label: "Globe vector tile lookup",
      size: words.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, words);
  }

  const resources: VectorTileRendererResources = {
    device,
    resourceGeneration,
    hasVectorData: words !== null,
    buffer,
    isCompatible(candidateContext) {
      return (
        candidateContext?.device === resources.device &&
        (candidateContext?.resourceGeneration ?? 0) ===
          resources.resourceGeneration &&
        (!resources.hasVectorData || resources.buffer !== null)
      );
    },
    destroy() {
      if (resources.buffer !== null) {
        resources.buffer.destroy();
        resources.buffer = null;
      }
    },
  };
  target.rendererResources = resources;
  return true;
}

/**
 * Resolve the storage buffer a tile's group-2 bind group should carry.
 * Falls back to `placeholder` when the tile has no vector data, when its
 * buffer was already destroyed, or when the data was realized on a DIFFERENT
 * device (split-screen / multi-context — binding another device's buffer is a
 * validation error, not a visual glitch). Device-generation reconciliation
 * deliberately happens earlier in `VectorProvider.updateTileData`; this draw
 * helper never allocates or uploads.
 */
export function resolveVectorTileBuffer(
  device: GPUDevice,
  vectorData: unknown,
  placeholder: GPUBuffer,
): GPUBuffer {
  const resources = (vectorData as VectorTileDataWithResources | null)
    ?.rendererResources;
  if (!resources || resources.device !== device || resources.buffer === null) {
    return placeholder;
  }
  return resources.buffer;
}
