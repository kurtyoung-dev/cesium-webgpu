/// <reference types="@webgpu/types" />
/**
 * WebGPU realization of a terrain tile's
 * clamped vector lookup tables — polylines and polygon fills.
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
 * v1.144 added the polygon-fill half of the same feature (v1.145 only re-gated
 * it behind `HAS_VECTOR_POLYGONS`): `packPolygonGrid`
 * bakes a second, INDEPENDENTLY sized grid whose per-cell edges were clipped to
 * the cell on the CPU, and `VectorCommon.glsl::vectorPolygonRender` casts an
 * even-odd horizontal ray over them. Its three tables (edges, edge→primitive,
 * grid header) are three more `sampler2D`s on WebGL and three more runs in the
 * same storage buffer here. The two families share ONE primitive index space,
 * so they share the single `primitives` run below.
 *
 * WebGPU has read-only storage buffers, so the WGSL twins
 * (`GlobeTerrain.wgsl::vectorPolylineRender` / `::vectorPolygonRender`) read ONE
 * buffer instead of eight textures. That is a forced choice, not a stylistic
 * one: the globe pipeline
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
 *   [8] polygonGridWidth             [9] polygonGridHeight
 *  [10] polygonEdgeCount            [11] polygonCellEndOffsetsBase
 *  [12] polygonEdgesBase            [13] polygonEdgePrimitiveIndicesBase
 *   cell end offsets  : gridWidth * gridHeight  u32
 *   segments          : segmentCount * 4        f32  (ax, ay, bx, by) tile UV
 *   segment→primitive : segmentCount            u32
 *   primitives        : primitiveCount * VECTOR_PRIMITIVE_STRIDE
 *                       +0 f32 signed lineWidth
 *                       +1 u32 RGBA8 material color, low byte first
 *                       +2 u32 RGBA8 pick color,     low byte first
 *   polygon cell ends : polygonGridWidth * polygonGridHeight  u32
 *   polygon edges     : polygonEdgeCount * 4    f32  (ax, ay, bx, by) tile UV
 *   polygon edge→prim : polygonEdgeCount        u32
 * ```
 *
 * The pick word is what lets `scene.pick` return a draped primitive rather than
 * the globe: `GlobeTerrain.wgsl::vectorPickColorOver` composites it over
 * `camera.pickColor` in the pick pass, the way `VectorCommon.glsl`'s function
 * of the same name composites `u_vectorPickColorTexture` over WebGL's. It is
 * zero when the collection was built without `allowPicking`, which the shader
 * reads as "leave the surface's own answer alone".
 *
 * Words `[0..7]` keep the indices and the meanings v1.144 gave them; the
 * polygon family was APPENDED at `[8]` and its runs after the primitives run,
 * so a reader written against the older header still resolves every polyline
 * word it knew about.
 *
 * Each family carries its OWN grid dimensions because `packPolylineGrid` and
 * `packPolygonGrid` size their grids from their own geometry counts and can
 * disagree on the same tile. `gridWidth === 0` and `polygonGridWidth === 0` are
 * the per-family "nothing draped here" sentinels the shader gates on, which is
 * also what the all-zero placeholder buffer reads as on both. A polygons-only
 * tile therefore has `gridWidth === 0` in a buffer that is NOT a placeholder —
 * the sentinel is per family, never a whole-buffer verdict.
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
export const VECTOR_TILE_POLYGON_GRID_WIDTH = 8;
export const VECTOR_TILE_POLYGON_GRID_HEIGHT = 9;
export const VECTOR_TILE_POLYGON_EDGE_COUNT = 10;
export const VECTOR_TILE_POLYGON_CELL_END_BASE = 11;
export const VECTOR_TILE_POLYGON_EDGES_BASE = 12;
export const VECTOR_TILE_POLYGON_EDGE_PRIMITIVE_BASE = 13;
/** Number of header words preceding the first variable-length run. */
export const VECTOR_TILE_HEADER_WORDS = 14;
/**
 * Words per record in the primitives run. Mirrored by
 * `VECTOR_PRIMITIVE_STRIDE` in `GlobeTerrain.wgsl`, which is what the shader
 * strides by; the two are a matched pair and neither may change alone.
 * Declared once here and used everywhere this module addresses the run.
 */
export const VECTOR_PRIMITIVE_STRIDE = 3;
/** Size of the shared all-zero "no vector data" buffer, in bytes. */
export const VECTOR_TILE_PLACEHOLDER_BYTES = VECTOR_TILE_HEADER_WORDS * 4;

/**
 * The CPU-side stage-2 product of `VectorPipeline.packPolylineGrid` and
 * `packPolygonGrid`, plus the per-primitive material bytes collected by
 * `packPolylineSegments` / `packPolygonRings`. Declared structurally:
 * `VectorTileData` is a JSDoc typedef on an untyped JS module, and this file
 * must stay importable by a pure-Node spec.
 */
export interface VectorTileCpuData {
  /** Packed RGBA line segments (ax, ay, bx, by) in tile UV space, -1 filled. */
  polylineSegmentTexels?: Float32Array;
  /** Primitive index per packed segment, -1 filled. */
  polylineSegmentPrimitiveIndicesTexels?: Float32Array;
  /** `[gridWidth, gridHeight, ...per-cell end offsets]`. */
  polylineGridCellIndices?: Uint32Array;
  /**
   * Packed RGBA polygon ring edges (ax, ay, bx, by) in tile UV space, clipped
   * per grid cell so each cell's edges close, -1 filled.
   */
  polygonEdgeTexels?: Float32Array;
  /** Primitive index per packed polygon edge, -1 filled. */
  polygonEdgePrimitiveIndicesTexels?: Float32Array;
  /** `[gridWidth, gridHeight, ...per-cell end offsets]` for the polygon grid. */
  polygonGridCellIndices?: Uint32Array;
  /**
   * Whether the stage-1 bake found polyline geometry on this tile. Set by
   * `VectorProvider.requestTileData` from the collected geometry, so it is an
   * INDEPENDENT statement of what the tile owes — the claim check below reads
   * it against what was actually packed.
   */
  hasPolylines?: boolean;
  /** Whether the stage-1 bake found polygon geometry on this tile. */
  hasPolygons?: boolean;
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
  /**
   * Per-collection primitive pick-color RGBA bytes, in collection order —
   * `VectorPipeline._writePickColor` writing each primitive's registered pick
   * id. All zero for a collection built without `allowPicking`, and absent
   * entirely on a bake old enough to predate the field, which packs as zero.
   */
  pickColors?: Uint8Array[];
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
 * One geometry family's stage-2 tables, measured. The polyline and polygon
 * bakes have the SAME shape — a `[gridWidth, gridHeight, ...cell end offsets]`
 * header, an RGBA f32 run of (ax, ay, bx, by) primitives-in-UV, and a parallel
 * primitive-index run — so one measurement serves both.
 */
interface VectorFamilyRun {
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly cellCount: number;
  /** Entries the CPU grid actually packed, clamped to what the texels supply. */
  readonly entryCount: number;
  readonly grid: Uint32Array;
  readonly geometryTexels: Float32Array;
  readonly primitiveIndexTexels: Float32Array;
}

/**
 * Measure one family's tables, or return `null` when it has nothing packable.
 *
 * `null` covers both "this bake has no such family" and "its grid is empty",
 * which the caller must distinguish from "the family exists and was DROPPED" —
 * see {@link claimCoversDeclaredFamilies}.
 */
function measureFamilyRun(
  grid: Uint32Array | undefined,
  geometryTexels: Float32Array | undefined,
  primitiveIndexTexels: Float32Array | undefined,
): VectorFamilyRun | null {
  if (!grid || !geometryTexels || !primitiveIndexTexels) {
    return null;
  }

  const gridWidth = grid[0] >>> 0;
  const gridHeight = grid[1] >>> 0;
  const cellCount = gridWidth * gridHeight;
  // `gridCellIndices` is [gridWidth, gridHeight, end0 … end(cellCount-1)].
  if (gridWidth === 0 || gridHeight === 0 || grid.length < cellCount + 2) {
    return null;
  }

  // The last cell's end offset IS the total packed (entry, cell) pair count.
  // Clamp against what the texel arrays can actually supply so a truncated or
  // stale bake can never make the shader walk past the run it was given.
  const entryCount = Math.min(
    grid[cellCount + 1] >>> 0,
    geometryTexels.length >>> 2,
    primitiveIndexTexels.length,
  );
  if (entryCount === 0) {
    return null;
  }

  return {
    gridWidth,
    gridHeight,
    cellCount,
    entryCount,
    grid,
    geometryTexels,
    primitiveIndexTexels,
  };
}

/**
 * Write one family's three runs at `cellEndBase`, and return the word index one
 * past the last one written. Shared by both families so a fix to the clamping
 * rules cannot land on one and miss the other.
 */
function writeFamilyRuns(
  words: Uint32Array,
  floats: Float32Array,
  run: VectorFamilyRun,
  primitiveCount: number,
  cellEndBase: number,
): number {
  const geometryBase = cellEndBase + run.cellCount;
  const primitiveIndexBase = geometryBase + run.entryCount * 4;

  for (let i = 0; i < run.cellCount; i++) {
    // Monotone-clamp each cell end into [0, entryCount] so the shader's
    // `[start, end)` walk stays inside the run even if the bake and the texel
    // arrays disagree.
    words[cellEndBase + i] = Math.min(run.grid[i + 2] >>> 0, run.entryCount);
  }

  for (let i = 0; i < run.entryCount * 4; i++) {
    floats[geometryBase + i] = run.geometryTexels[i];
  }

  for (let i = 0; i < run.entryCount; i++) {
    const raw = run.primitiveIndexTexels[i];
    // -1 is the fill value; anything out of range would read another
    // primitive's material, so clamp instead of trusting the bake.
    const index = Number.isFinite(raw) ? Math.trunc(raw) : 0;
    words[primitiveIndexBase + i] = Math.min(
      Math.max(index, 0),
      primitiveCount - 1,
    );
  }

  return primitiveIndexBase + run.entryCount;
}

/**
 * Pack a baked `VectorTileData` into the flat word array the WGSL reads.
 *
 * Both geometry families are optional and independent: a polylines-only bake, a
 * polygons-only bake and a mixed bake each produce a buffer carrying exactly
 * the families the bake holds. Only a bake with NEITHER family — no grid, an
 * empty grid, zero packed entries on both sides, or no primitives at all —
 * returns `null`, and the caller then binds the placeholder buffer.
 *
 * Pure: no device, no allocation beyond the returned array, deterministic for
 * a given input.
 */
export function packVectorTileWords(
  data: VectorTileCpuData | null | undefined,
): Uint32Array | null {
  const primitiveCount = Math.max(0, Math.trunc(data?.primitiveCount ?? 0));
  if (primitiveCount === 0) {
    return null;
  }

  const polylines = measureFamilyRun(
    data?.polylineGridCellIndices,
    data?.polylineSegmentTexels,
    data?.polylineSegmentPrimitiveIndicesTexels,
  );
  const polygons = measureFamilyRun(
    data?.polygonGridCellIndices,
    data?.polygonEdgeTexels,
    data?.polygonEdgePrimitiveIndicesTexels,
  );
  if (!polylines && !polygons) {
    return null;
  }

  // Run bases are computed for BOTH families whether or not each is present.
  // An absent family contributes zero words, so its bases coincide with the
  // next run's start — in range, and never read, because its count header word
  // is 0 and the shader gates on that first.
  const cellEndBase = VECTOR_TILE_HEADER_WORDS;
  const segmentCount = polylines?.entryCount ?? 0;
  const segmentsBase = cellEndBase + (polylines?.cellCount ?? 0);
  const segmentPrimitiveBase = segmentsBase + segmentCount * 4;
  const primitivesBase = segmentPrimitiveBase + segmentCount;

  const polygonEdgeCount = polygons?.entryCount ?? 0;
  const polygonCellEndBase =
    primitivesBase + primitiveCount * VECTOR_PRIMITIVE_STRIDE;
  const polygonEdgesBase = polygonCellEndBase + (polygons?.cellCount ?? 0);
  const polygonEdgePrimitiveBase = polygonEdgesBase + polygonEdgeCount * 4;
  const totalWords = polygonEdgePrimitiveBase + polygonEdgeCount;

  const words = new Uint32Array(totalWords);
  const floats = new Float32Array(words.buffer);

  words[VECTOR_TILE_GRID_WIDTH] = polylines?.gridWidth ?? 0;
  words[VECTOR_TILE_GRID_HEIGHT] = polylines?.gridHeight ?? 0;
  words[VECTOR_TILE_SEGMENT_COUNT] = segmentCount;
  words[VECTOR_TILE_PRIMITIVE_COUNT] = primitiveCount;
  words[VECTOR_TILE_CELL_END_BASE] = cellEndBase;
  words[VECTOR_TILE_SEGMENTS_BASE] = segmentsBase;
  words[VECTOR_TILE_SEGMENT_PRIMITIVE_BASE] = segmentPrimitiveBase;
  words[VECTOR_TILE_PRIMITIVES_BASE] = primitivesBase;
  words[VECTOR_TILE_POLYGON_GRID_WIDTH] = polygons?.gridWidth ?? 0;
  words[VECTOR_TILE_POLYGON_GRID_HEIGHT] = polygons?.gridHeight ?? 0;
  words[VECTOR_TILE_POLYGON_EDGE_COUNT] = polygonEdgeCount;
  words[VECTOR_TILE_POLYGON_CELL_END_BASE] = polygonCellEndBase;
  words[VECTOR_TILE_POLYGON_EDGES_BASE] = polygonEdgesBase;
  words[VECTOR_TILE_POLYGON_EDGE_PRIMITIVE_BASE] = polygonEdgePrimitiveBase;

  if (polylines) {
    writeFamilyRuns(words, floats, polylines, primitiveCount, cellEndBase);
  }

  // The primitive run is SHARED: `packPolygonCollectionData` appends its
  // colours into the same collection-ordered arrays the polyline bake uses, so
  // one record serves a segment and an edge that name the same index.
  const widthValues = concatNumbers(data?.widths ?? []);
  const colorBytes = concatByteArrays(data?.colors ?? []);
  // Concatenated in the SAME collection order as the colors above, which is
  // the order `VectorPipeline.packPolylineSegments` assigned primitive indices
  // in. A bake predating the field concatenates to an empty run and every pick
  // word packs zero, which the shader reads as "no pick data here".
  const pickColorBytes = concatByteArrays(data?.pickColors ?? []);
  for (let i = 0; i < primitiveCount; i++) {
    const p = primitivesBase + i * VECTOR_PRIMITIVE_STRIDE;
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
    // The pick color is a packed pick-ID KEY, not an opacity: all four bytes
    // are payload, alpha included, and dropping any of them would alias two
    // ids onto one object (the 32-bit key contract `GraphicsContext`'s
    // `_pickColorToKey` decodes on the way back).
    const pr = pickColorBytes[i * 4] ?? 0;
    const pg = pickColorBytes[i * 4 + 1] ?? 0;
    const pb = pickColorBytes[i * 4 + 2] ?? 0;
    const pa = pickColorBytes[i * 4 + 3] ?? 0;
    words[p + 2] = (pr | (pg << 8) | (pb << 16) | (pa << 24)) >>> 0;
  }

  if (polygons) {
    writeFamilyRuns(
      words,
      floats,
      polygons,
      primitiveCount,
      polygonCellEndBase,
    );
  }

  return words;
}

/**
 * Whether a claim on this bake would realize every geometry family the bake
 * DECLARES.
 *
 * `hasPolylines` / `hasPolygons` are set by `VectorProvider.requestTileData`
 * from the stage-1 geometry, before any backend is offered the tile, so they
 * are an independent statement of what the tile owes; `words` is what this
 * module actually produced. A family that is owed but carries a zero count in
 * the packed header was DROPPED, and claiming it would render bare terrain on
 * WebGPU while also suppressing the WebGL texture fallback.
 *
 * A declared family whose own stage-2 grid packed nothing (every ring clipped
 * away, say) is not a drop: the WebGL twin reads the same empty grid and paints
 * nothing either. That case is admitted by measuring the CPU tables rather than
 * by trusting the flag alone.
 */
function claimCoversDeclaredFamilies(
  data: VectorTileCpuData,
  words: Uint32Array | null,
): boolean {
  const covers = (
    declared: boolean,
    grid: Uint32Array | undefined,
    geometryTexels: Float32Array | undefined,
    primitiveIndexTexels: Float32Array | undefined,
    packedCount: number,
  ): boolean => {
    if (!declared) {
      return true;
    }
    if (!grid || !geometryTexels || !primitiveIndexTexels) {
      // Declared by stage 1, but stage 2 left no tables at all. Nothing here
      // can realize it, so the claim would be a silent drop.
      return false;
    }
    if (measureFamilyRun(grid, geometryTexels, primitiveIndexTexels) === null) {
      // Tables present, grid packed nothing. The WebGL twin reads the same
      // empty grid and paints nothing, so an empty run is the honest answer.
      return true;
    }
    return packedCount > 0;
  };

  return (
    covers(
      data.hasPolylines === true,
      data.polylineGridCellIndices,
      data.polylineSegmentTexels,
      data.polylineSegmentPrimitiveIndicesTexels,
      words === null ? 0 : words[VECTOR_TILE_SEGMENT_COUNT],
    ) &&
    covers(
      data.hasPolygons === true,
      data.polygonGridCellIndices,
      data.polygonEdgeTexels,
      data.polygonEdgePrimitiveIndicesTexels,
      words === null ? 0 : words[VECTOR_TILE_POLYGON_EDGE_COUNT],
    )
  );
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
 * Returns `true` whenever the WebGPU backend has taken ownership — including
 * the "nothing to drape" case, where no buffer is created and the globe binds
 * its shared placeholder. Returning `false` for that would fall through to the
 * WebGL texture path and allocate GL textures the WebGPU globe never reads.
 *
 * It returns `false` for exactly one thing: a bake declaring a geometry family
 * this module did not realize. A claim is a statement of complete ownership
 * (`VectorPipeline.packPrimitiveTextures`: "callers must not construct WebGL
 * textures"), so claiming a family that was dropped renders bare terrain AND
 * suppresses the fallback that would have drawn it. Declining is loud —
 * `VectorProvider` then builds the WebGL textures — and it cannot happen for
 * any bake this packer understands, so the `console.error` beside it is a
 * permanent sentinel for a packer/bake mismatch, not a live path.
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
  if (!claimCoversDeclaredFamilies(data, words)) {
    // A real bug producing broken output: the tile drapes on WebGL and shows
    // bare terrain here. Never pragma-wrapped — this is the message that makes
    // the drop reportable instead of invisible.
    console.error(
      "[CesiumJS:webgpu] Declining a draped-vector tile whose declared " +
        "geometry families were not packed " +
        `(hasPolylines=${data.hasPolylines === true}, ` +
        `hasPolygons=${data.hasPolygons === true}, ` +
        `segments=${words === null ? 0 : words[VECTOR_TILE_SEGMENT_COUNT]}, ` +
        `polygonEdges=${words === null ? 0 : words[VECTOR_TILE_POLYGON_EDGE_COUNT]}); ` +
        "falling back to the WebGL texture path.",
    );
    return false;
  }

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
