/* tslint:disable */
/* eslint-disable */

/**
 * Legacy single-arena API. Forwards to slot 0 so existing JS bridges
 * that haven't been migrated to the per-slot API keep working without
 * any change. New bridges should call `alloc_buffer_slot` directly.
 */
export function alloc_buffer(size_bytes: number): number;

/**
 * Allocates a contiguous buffer in the requested slot's arena.
 * Returns a raw pointer that JS can use with Float32Array views.
 * Returns 0 (null) on allocation failure (OOM, or invalid slot)
 * so callers can fall back to JS.
 *
 * The returned pointer is valid until `free_buffer_slot(slot)` or
 * the next `alloc_buffer_slot(slot, ..)` call on the same slot that
 * triggers reallocation. Slots are independent — allocating on one
 * slot does NOT invalidate pointers handed out from any other slot,
 * which is the whole point of FORK-45.
 */
export function alloc_buffer_slot(slot: number, size_bytes: number): number;

/**
 * Batch octree node AABB-frustum test.
 *
 * Tests N axis-aligned bounding boxes against 6 frustum planes.
 * Each AABB is defined by center + half-extents.
 * This is the octree node visibility test used during traversal.
 *
 * # Parameters
 * - `center_x/y/z`: AABB center coordinates (f32, count elements)
 * - `half_x/y/z`: AABB half-extents (f32, count elements)
 * - `planes`: 6 frustum planes (24 f32: [nx,ny,nz,d] × 6)
 * - `count`: Number of AABBs
 * - `visibility`: Output u8 (1=visible, 0=culled)
 *
 * # Returns
 * Number of visible nodes.
 */
export function batch_aabb_frustum_test(
  center_x: number,
  center_y: number,
  center_z: number,
  half_x: number,
  half_y: number,
  half_z: number,
  planes: number,
  count: number,
  visibility: number,
): number;

/**
 * Batch compute squared distances from a camera position to N points.
 *
 * Used for LOD selection — points beyond a distance threshold are culled
 * or rendered at lower detail. Squared distance avoids sqrt.
 *
 * # Parameters
 * - `points_x/y/z`: Point positions (SOA, f32, count elements)
 * - `cam_x/y/z`: Camera position (f32)
 * - `count`: Number of points
 * - `out_dist_sq`: Output squared distances (f32, count elements)
 */
export function batch_distance_squared(
  points_x: number,
  points_y: number,
  points_z: number,
  cam_x: number,
  cam_y: number,
  cam_z: number,
  count: number,
  out_dist_sq: number,
): void;

/**
 * Batch multiply two 4×4 matrices: result = A × B for N matrix pairs.
 *
 * Used for computing modelView = view × model for each entity.
 *
 * # Parameters
 * - `a_matrices`: N column-major 4×4 matrices (16*N floats)
 * - `b_matrix`: Single column-major 4×4 matrix (16 floats) — applied to all
 * - `count`: Number of A matrices
 * - `out_matrices`: Output N column-major 4×4 matrices (16*N floats)
 */
export function batch_mat4_multiply(
  a_matrices: number,
  b_matrix: number,
  count: number,
  out_matrices: number,
): void;

/**
 * Batch encode f64 positions into high/low f32 pairs for RTE rendering.
 *
 * For each input f64 value, computes:
 *   high = (f32)value
 *   low  = (f32)(value - (f64)high)
 *
 * This is the same algorithm as CesiumJS EncodedCartesian3.encode() but
 * applied to N values at once. The SIMD benefit comes from the f32
 * subtraction and store operations.
 *
 * # Parameters
 * - `values`: Pointer to f64 input values (interleaved XYZ: x0,y0,z0,x1,y1,z1,...)
 * - `count`: Number of 3D positions (values array has count*3 elements)
 * - `out_high`: Output f32 array for high parts (interleaved XYZ, count*3 elements)
 * - `out_low`: Output f32 array for low parts (interleaved XYZ, count*3 elements)
 */
export function batch_rte_encode(
  values: number,
  count: number,
  out_high: number,
  out_low: number,
): void;

/**
 * Batch encode f64 positions into SOA (Structure-of-Arrays) high/low f32 pairs.
 *
 * Input: separate X, Y, Z f64 arrays (SOA layout, as used by SOABoundingSphereLayout).
 * Output: separate high_x, high_y, high_z, low_x, low_y, low_z f32 arrays.
 *
 * This avoids the interleaved→SOA transpose that would be needed if using
 * batch_rte_encode with interleaved data.
 *
 * # Parameters
 * - `x`, `y`, `z`: Input f64 SOA position arrays (count elements each)
 * - `count`: Number of positions
 * - `out_hx`, `out_hy`, `out_hz`: Output f32 high parts (count elements each)
 * - `out_lx`, `out_ly`, `out_lz`: Output f32 low parts (count elements each)
 */
export function batch_rte_encode_soa(
  x: number,
  y: number,
  z: number,
  count: number,
  out_hx: number,
  out_hy: number,
  out_hz: number,
  out_lx: number,
  out_ly: number,
  out_lz: number,
): void;

/**
 * Batch compute RTE eye-space positions from high/low encoded data and camera.
 *
 * For each position, computes:
 *   eye = (posHigh - camHigh) + (posLow - camLow)
 *
 * This is the CPU-side equivalent of the csm_translateRelativeToEye WGSL function.
 * Useful for CPU-side visibility testing with RTE precision.
 *
 * # Parameters
 * - `pos_hx/hy/hz`: Position high parts (f32, count elements)
 * - `pos_lx/ly/lz`: Position low parts (f32, count elements)
 * - `cam_hx/hy/hz`: Camera position high (single f32 value)
 * - `cam_lx/ly/lz`: Camera position low (single f32 value)
 * - `count`: Number of positions
 * - `out_x/y/z`: Output eye-space positions (f32, count elements)
 */
export function batch_rte_to_eye(
  pos_hx: number,
  pos_hy: number,
  pos_hz: number,
  pos_lx: number,
  pos_ly: number,
  pos_lz: number,
  cam_hx: number,
  cam_hy: number,
  cam_hz: number,
  cam_lx: number,
  cam_ly: number,
  cam_lz: number,
  count: number,
  out_x: number,
  out_y: number,
  out_z: number,
): void;

/**
 * Batch multiply N different 4×4 matrices by their corresponding 3D points.
 *
 * Each entity has its own model matrix. This processes them all at once.
 * Matrices are packed contiguously: [mat0(16 floats), mat1(16 floats), ...]
 *
 * # Parameters
 * - `matrices`: Pointer to N×16 f32 values (N column-major matrices packed)
 * - `points_x/y/z`: Input point coordinates (count elements each)
 * - `count`: Number of point/matrix pairs
 * - `out_x/y/z`: Output transformed coordinates (count elements each)
 */
export function batch_transform_per_entity(
  matrices: number,
  points_x: number,
  points_y: number,
  points_z: number,
  count: number,
  out_x: number,
  out_y: number,
  out_z: number,
): void;

/**
 * Batch multiply a single 4×4 matrix by N 3D points (w=1 implied).
 *
 * This is the common case: one model matrix applied to many vertices.
 * Output is 3D (xyz), discarding the w component.
 *
 * # Parameters
 * - `matrix`: Pointer to 16 f32 values (column-major, matching CesiumJS Matrix4)
 * - `points_x/y/z`: Input point coordinates (SOA layout, count elements each)
 * - `count`: Number of points
 * - `out_x/y/z`: Output transformed coordinates (count elements each)
 */
export function batch_transform_points(
  matrix: number,
  points_x: number,
  points_y: number,
  points_z: number,
  count: number,
  out_x: number,
  out_y: number,
  out_z: number,
): void;

/**
 * Compact visible point indices into a dense output array.
 *
 * After LOD filtering, this gathers only the visible point indices
 * into a contiguous array for efficient rendering.
 *
 * # Parameters
 * - `visibility`: Visibility flags (from lod_filter)
 * - `count`: Total number of points
 * - `out_indices`: Output array of visible point indices
 *
 * # Returns
 * Number of visible indices written.
 */
export function compact_visible(
  visibility: number,
  count: number,
  out_indices: number,
): number;

/**
 * Batch decode multi-element heightmap with endianness handling.
 *
 * Decodes raw heightmap bytes into f32 height values, handling:
 * - Multi-byte element types (1, 2, 4 bytes per element)
 * - Big/little endian byte order
 * - Height scale and bias: decoded_height = raw * scale + bias
 *
 * # Parameters
 * - `raw_bytes`: Raw heightmap byte buffer
 * - `byte_count`: Total bytes in raw_bytes
 * - `bytes_per_element`: 1, 2, or 4
 * - `is_big_endian`: true for big-endian, false for little-endian
 * - `height_scale`: Multiply factor
 * - `height_offset`: Additive bias
 * - `out_heights`: Output f32 height array
 *
 * # Returns
 * Number of height samples decoded.
 */
export function decode_heightmap(
  raw_bytes: number,
  byte_count: number,
  bytes_per_element: number,
  is_big_endian: boolean,
  height_scale: number,
  height_offset: number,
  out_heights: number,
): number;

/**
 * Decode triangle indices with high-watermark encoding.
 *
 * Quantized mesh uses delta+high-watermark encoding for triangle indices.
 * This is sequential but benefits from WASM's integer arithmetic speed.
 *
 * # Parameters
 * - `encoded`: Pointer to encoded Uint16/Uint32 index data
 * - `index_count`: Number of indices (must be multiple of 3)
 * - `is_32bit`: true if indices are Uint32, false for Uint16
 * - `out_indices`: Output Uint32 decoded indices
 *
 * # Returns
 * Number of indices decoded.
 */
export function decode_indices(
  encoded: number,
  index_count: number,
  is_32bit: boolean,
  out_indices: number,
): number;

/**
 * Decode quantized mesh vertex data with zigzag + delta encoding.
 *
 * Input is three Uint16Arrays (u, v, height) with zigzag+delta encoding.
 * Output is three Float32Arrays with normalized values in [0, 1] range.
 *
 * # Parameters
 * - `encoded_u`: Pointer to Uint16 zigzag+delta encoded U coordinates
 * - `encoded_v`: Pointer to Uint16 zigzag+delta encoded V coordinates
 * - `encoded_h`: Pointer to Uint16 zigzag+delta encoded height values
 * - `vertex_count`: Number of vertices
 * - `out_u`: Output f32 array for normalized U [0,1]
 * - `out_v`: Output f32 array for normalized V [0,1]
 * - `out_h`: Output f32 array for normalized height [0,1]
 *
 * # Returns
 * Number of vertices decoded.
 */
export function decode_quantized_mesh(
  encoded_u: number,
  encoded_v: number,
  encoded_h: number,
  vertex_count: number,
  out_u: number,
  out_v: number,
  out_h: number,
): number;

/**
 * Legacy single-arena API. Forwards to slot 0.
 */
export function free_buffer(): void;

/**
 * Frees the requested slot's arena. Call when the JS-side bridge
 * for this slot is being torn down. Bridges that share `DEFAULT_SLOT`
 * must coordinate the free — typically the last living bridge calls it.
 */
export function free_buffer_slot(slot: number): void;

/**
 * Batch frustum culling with WASM SIMD.
 *
 * # Parameters
 * - `center_x`: Pointer to f32 array of sphere center X coords (ECEF)
 * - `center_y`: Pointer to f32 array of sphere center Y coords (ECEF)
 * - `center_z`: Pointer to f32 array of sphere center Z coords (ECEF)
 * - `radii`: Pointer to f32 array of sphere radii
 * - `planes`: Pointer to f32 array of 24 floats (6 planes × [nx, ny, nz, d])
 * - `visibility`: Pointer to u8 output array (0 = culled, 1 = visible)
 * - `count`: Number of spheres to test
 *
 * # Returns
 * Number of visible spheres.
 *
 * # Safety
 * All pointers must be valid and point to arrays of at least `count` elements.
 * `planes` must point to at least 24 f32 values.
 */
export function frustum_cull_batch(
  center_x: number,
  center_y: number,
  center_z: number,
  radii: number,
  planes: number,
  visibility: number,
  count: number,
): number;

/**
 * Returns whether SIMD is supported in this build.
 * When compiled with target-feature=+simd128, this returns true.
 * JS bridge can use this to confirm SIMD acceleration is active.
 */
export function has_simd(): boolean;

/**
 * Returns whether this build supports threading.
 * When compiled with -C target-feature=+atomics,+bulk-memory,+mutable-globals,
 * this returns true. JS bridge uses this to decide whether to use
 * SharedArrayBuffer for cross-thread data sharing.
 */
export function has_threads(): boolean;

/**
 * Batch decode heightmap samples and compute ECEF positions.
 *
 * Takes a flat array of height samples (f32) and tile geographic bounds,
 * computes ECEF XYZ positions for each sample using the WGS84 ellipsoid.
 *
 * # Parameters
 * - `heights`: Pointer to f32 height samples (row-major, width × height)
 * - `width`: Tile width in samples
 * - `height`: Tile height in samples
 * - `west`: Western longitude bound (radians)
 * - `south`: Southern latitude bound (radians)
 * - `east`: Eastern longitude bound (radians)
 * - `north`: Northern latitude bound (radians)
 * - `out_x`: Output f32 array for ECEF X coordinates
 * - `out_y`: Output f32 array for ECEF Y coordinates
 * - `out_z`: Output f32 array for ECEF Z coordinates
 * - `min_height`: Output minimum height encountered
 * - `max_height`: Output maximum height encountered
 *
 * # Returns
 * Number of vertices processed.
 */
export function heightmap_to_ecef(
  heights: number,
  width: number,
  height: number,
  west: number,
  south: number,
  east: number,
  north: number,
  out_x: number,
  out_y: number,
  out_z: number,
  out_min_height: number,
  out_max_height: number,
): number;

/**
 * LOD selection: filter points by distance threshold.
 *
 * For each point, if dist² ≤ threshold², mark it visible (1), else culled (0).
 * Returns the number of visible points.
 *
 * # Parameters
 * - `dist_sq`: Squared distances (from batch_distance_squared)
 * - `threshold_sq`: Maximum squared distance for visibility
 * - `count`: Number of points
 * - `visibility`: Output u8 array (1=visible, 0=culled)
 *
 * # Returns
 * Number of visible points.
 */
export function lod_filter(
  dist_sq: number,
  threshold_sq: number,
  count: number,
  visibility: number,
): number;

/**
 * Returns the number of arena slots compiled into this WASM build.
 * JS bridges can call this once at startup to verify the build is
 * FORK-45-aware (returns NUM_SLOTS) versus the legacy single-arena
 * build (function is missing → ReferenceError on the JS side).
 */
export function num_arena_slots(): number;

/**
 * Packs a sort key from its components into high and low 32-bit words.
 * Utility function callable from JS for key preparation.
 *
 * # Parameters
 * - `layer`: 0-15 (4 bits)
 * - `priority`: 0-4095 (12 bits)
 * - `material`: 0-65535 (16 bits)
 * - `distance`: float32 distance to camera
 * - `back_to_front`: if true, flip distance bits for reverse sort
 *
 * # Returns
 * Packed key as [high_word, low_word] via output pointer.
 */
export function pack_sort_key(
  layer: number,
  priority: number,
  material: number,
  distance: number,
  back_to_front: boolean,
  out_high: number,
  out_low: number,
): void;

/**
 * Radix sort on packed 64-bit keys (high + low 32-bit words).
 *
 * Sorts the `indices` array in-place based on the corresponding key values.
 * Uses 8-bit radix (256 buckets) for 8 passes total.
 *
 * # Parameters
 * - `indices`: Pointer to u32 array of command indices to sort
 * - `keys_high`: Pointer to u32 array of high 32-bit key words
 * - `keys_low`: Pointer to u32 array of low 32-bit key words
 * - `count`: Number of elements to sort
 * - `temp`: Pointer to u32 scratch array (must be at least `count` elements)
 *
 * # Safety
 * All pointers must be valid and point to arrays of at least `count` elements.
 */
export function radix_sort_keys(
  indices: number,
  keys_high: number,
  keys_low: number,
  count: number,
  temp: number,
): void;

/**
 * Returns the WASM module version for compatibility checking.
 * JS bridge uses this to verify WASM/JS API compatibility.
 * - v1: initial frustum cull + radix sort
 * - v2: terrain/RTE/matrix/point-cloud additions
 * - v3: FORK-45 per-bridge arena slots (alloc_buffer_slot,
 *   free_buffer_slot, num_arena_slots). Legacy alloc_buffer /
 *   free_buffer still work and forward to slot 0.
 */
export function version(): number;

export type InitInput =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly alloc_buffer: (a: number) => number;
  readonly alloc_buffer_slot: (a: number, b: number) => number;
  readonly batch_aabb_frustum_test: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
  ) => number;
  readonly batch_distance_squared: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => void;
  readonly batch_mat4_multiply: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => void;
  readonly batch_rte_encode: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => void;
  readonly batch_rte_encode_soa: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
  ) => void;
  readonly batch_rte_to_eye: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: number,
    l: number,
    m: number,
    n: number,
    o: number,
    p: number,
  ) => void;
  readonly batch_transform_per_entity: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => void;
  readonly batch_transform_points: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => void;
  readonly compact_visible: (a: number, b: number, c: number) => number;
  readonly decode_heightmap: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
  ) => number;
  readonly decode_indices: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => number;
  readonly decode_quantized_mesh: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
  ) => number;
  readonly free_buffer: () => void;
  readonly free_buffer_slot: (a: number) => void;
  readonly frustum_cull_batch: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
  ) => number;
  readonly has_simd: () => number;
  readonly has_threads: () => number;
  readonly heightmap_to_ecef: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: number,
    l: number,
  ) => number;
  readonly lod_filter: (a: number, b: number, c: number, d: number) => number;
  readonly num_arena_slots: () => number;
  readonly pack_sort_key: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
  ) => void;
  readonly radix_sort_keys: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => void;
  readonly version: () => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(
  module: { module: SyncInitInput } | SyncInitInput,
): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>,
): Promise<InitOutput>;
