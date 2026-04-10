/* @ts-self-types="./cesium_wasm.d.ts" */

/**
 * Legacy single-arena API. Forwards to slot 0 so existing JS bridges
 * that haven't been migrated to the per-slot API keep working without
 * any change. New bridges should call `alloc_buffer_slot` directly.
 * @param {number} size_bytes
 * @returns {number}
 */
export function alloc_buffer(size_bytes) {
  const ret = wasm.alloc_buffer(size_bytes);
  return ret >>> 0;
}

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
 * @param {number} slot
 * @param {number} size_bytes
 * @returns {number}
 */
export function alloc_buffer_slot(slot, size_bytes) {
  const ret = wasm.alloc_buffer_slot(slot, size_bytes);
  return ret >>> 0;
}

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
 * @param {number} center_x
 * @param {number} center_y
 * @param {number} center_z
 * @param {number} half_x
 * @param {number} half_y
 * @param {number} half_z
 * @param {number} planes
 * @param {number} count
 * @param {number} visibility
 * @returns {number}
 */
export function batch_aabb_frustum_test(
  center_x,
  center_y,
  center_z,
  half_x,
  half_y,
  half_z,
  planes,
  count,
  visibility,
) {
  const ret = wasm.batch_aabb_frustum_test(
    center_x,
    center_y,
    center_z,
    half_x,
    half_y,
    half_z,
    planes,
    count,
    visibility,
  );
  return ret >>> 0;
}

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
 * @param {number} points_x
 * @param {number} points_y
 * @param {number} points_z
 * @param {number} cam_x
 * @param {number} cam_y
 * @param {number} cam_z
 * @param {number} count
 * @param {number} out_dist_sq
 */
export function batch_distance_squared(
  points_x,
  points_y,
  points_z,
  cam_x,
  cam_y,
  cam_z,
  count,
  out_dist_sq,
) {
  wasm.batch_distance_squared(
    points_x,
    points_y,
    points_z,
    cam_x,
    cam_y,
    cam_z,
    count,
    out_dist_sq,
  );
}

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
 * @param {number} a_matrices
 * @param {number} b_matrix
 * @param {number} count
 * @param {number} out_matrices
 */
export function batch_mat4_multiply(a_matrices, b_matrix, count, out_matrices) {
  wasm.batch_mat4_multiply(a_matrices, b_matrix, count, out_matrices);
}

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
 * @param {number} values
 * @param {number} count
 * @param {number} out_high
 * @param {number} out_low
 */
export function batch_rte_encode(values, count, out_high, out_low) {
  wasm.batch_rte_encode(values, count, out_high, out_low);
}

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
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} count
 * @param {number} out_hx
 * @param {number} out_hy
 * @param {number} out_hz
 * @param {number} out_lx
 * @param {number} out_ly
 * @param {number} out_lz
 */
export function batch_rte_encode_soa(
  x,
  y,
  z,
  count,
  out_hx,
  out_hy,
  out_hz,
  out_lx,
  out_ly,
  out_lz,
) {
  wasm.batch_rte_encode_soa(
    x,
    y,
    z,
    count,
    out_hx,
    out_hy,
    out_hz,
    out_lx,
    out_ly,
    out_lz,
  );
}

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
 * @param {number} pos_hx
 * @param {number} pos_hy
 * @param {number} pos_hz
 * @param {number} pos_lx
 * @param {number} pos_ly
 * @param {number} pos_lz
 * @param {number} cam_hx
 * @param {number} cam_hy
 * @param {number} cam_hz
 * @param {number} cam_lx
 * @param {number} cam_ly
 * @param {number} cam_lz
 * @param {number} count
 * @param {number} out_x
 * @param {number} out_y
 * @param {number} out_z
 */
export function batch_rte_to_eye(
  pos_hx,
  pos_hy,
  pos_hz,
  pos_lx,
  pos_ly,
  pos_lz,
  cam_hx,
  cam_hy,
  cam_hz,
  cam_lx,
  cam_ly,
  cam_lz,
  count,
  out_x,
  out_y,
  out_z,
) {
  wasm.batch_rte_to_eye(
    pos_hx,
    pos_hy,
    pos_hz,
    pos_lx,
    pos_ly,
    pos_lz,
    cam_hx,
    cam_hy,
    cam_hz,
    cam_lx,
    cam_ly,
    cam_lz,
    count,
    out_x,
    out_y,
    out_z,
  );
}

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
 * @param {number} matrices
 * @param {number} points_x
 * @param {number} points_y
 * @param {number} points_z
 * @param {number} count
 * @param {number} out_x
 * @param {number} out_y
 * @param {number} out_z
 */
export function batch_transform_per_entity(
  matrices,
  points_x,
  points_y,
  points_z,
  count,
  out_x,
  out_y,
  out_z,
) {
  wasm.batch_transform_per_entity(
    matrices,
    points_x,
    points_y,
    points_z,
    count,
    out_x,
    out_y,
    out_z,
  );
}

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
 * @param {number} matrix
 * @param {number} points_x
 * @param {number} points_y
 * @param {number} points_z
 * @param {number} count
 * @param {number} out_x
 * @param {number} out_y
 * @param {number} out_z
 */
export function batch_transform_points(
  matrix,
  points_x,
  points_y,
  points_z,
  count,
  out_x,
  out_y,
  out_z,
) {
  wasm.batch_transform_points(
    matrix,
    points_x,
    points_y,
    points_z,
    count,
    out_x,
    out_y,
    out_z,
  );
}

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
 * @param {number} visibility
 * @param {number} count
 * @param {number} out_indices
 * @returns {number}
 */
export function compact_visible(visibility, count, out_indices) {
  const ret = wasm.compact_visible(visibility, count, out_indices);
  return ret >>> 0;
}

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
 * @param {number} raw_bytes
 * @param {number} byte_count
 * @param {number} bytes_per_element
 * @param {boolean} is_big_endian
 * @param {number} height_scale
 * @param {number} height_offset
 * @param {number} out_heights
 * @returns {number}
 */
export function decode_heightmap(
  raw_bytes,
  byte_count,
  bytes_per_element,
  is_big_endian,
  height_scale,
  height_offset,
  out_heights,
) {
  const ret = wasm.decode_heightmap(
    raw_bytes,
    byte_count,
    bytes_per_element,
    is_big_endian,
    height_scale,
    height_offset,
    out_heights,
  );
  return ret >>> 0;
}

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
 * @param {number} encoded
 * @param {number} index_count
 * @param {boolean} is_32bit
 * @param {number} out_indices
 * @returns {number}
 */
export function decode_indices(encoded, index_count, is_32bit, out_indices) {
  const ret = wasm.decode_indices(encoded, index_count, is_32bit, out_indices);
  return ret >>> 0;
}

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
 * @param {number} encoded_u
 * @param {number} encoded_v
 * @param {number} encoded_h
 * @param {number} vertex_count
 * @param {number} out_u
 * @param {number} out_v
 * @param {number} out_h
 * @returns {number}
 */
export function decode_quantized_mesh(
  encoded_u,
  encoded_v,
  encoded_h,
  vertex_count,
  out_u,
  out_v,
  out_h,
) {
  const ret = wasm.decode_quantized_mesh(
    encoded_u,
    encoded_v,
    encoded_h,
    vertex_count,
    out_u,
    out_v,
    out_h,
  );
  return ret >>> 0;
}

/**
 * Legacy single-arena API. Forwards to slot 0.
 */
export function free_buffer() {
  wasm.free_buffer();
}

/**
 * Frees the requested slot's arena. Call when the JS-side bridge
 * for this slot is being torn down. Bridges that share `DEFAULT_SLOT`
 * must coordinate the free — typically the last living bridge calls it.
 * @param {number} slot
 */
export function free_buffer_slot(slot) {
  wasm.free_buffer_slot(slot);
}

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
 * @param {number} center_x
 * @param {number} center_y
 * @param {number} center_z
 * @param {number} radii
 * @param {number} planes
 * @param {number} visibility
 * @param {number} count
 * @returns {number}
 */
export function frustum_cull_batch(
  center_x,
  center_y,
  center_z,
  radii,
  planes,
  visibility,
  count,
) {
  const ret = wasm.frustum_cull_batch(
    center_x,
    center_y,
    center_z,
    radii,
    planes,
    visibility,
    count,
  );
  return ret >>> 0;
}

/**
 * Returns whether SIMD is supported in this build.
 * When compiled with target-feature=+simd128, this returns true.
 * JS bridge can use this to confirm SIMD acceleration is active.
 * @returns {boolean}
 */
export function has_simd() {
  const ret = wasm.has_simd();
  return ret !== 0;
}

/**
 * Returns whether this build supports threading.
 * When compiled with -C target-feature=+atomics,+bulk-memory,+mutable-globals,
 * this returns true. JS bridge uses this to decide whether to use
 * SharedArrayBuffer for cross-thread data sharing.
 * @returns {boolean}
 */
export function has_threads() {
  const ret = wasm.has_threads();
  return ret !== 0;
}

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
 * @param {number} heights
 * @param {number} width
 * @param {number} height
 * @param {number} west
 * @param {number} south
 * @param {number} east
 * @param {number} north
 * @param {number} out_x
 * @param {number} out_y
 * @param {number} out_z
 * @param {number} out_min_height
 * @param {number} out_max_height
 * @returns {number}
 */
export function heightmap_to_ecef(
  heights,
  width,
  height,
  west,
  south,
  east,
  north,
  out_x,
  out_y,
  out_z,
  out_min_height,
  out_max_height,
) {
  const ret = wasm.heightmap_to_ecef(
    heights,
    width,
    height,
    west,
    south,
    east,
    north,
    out_x,
    out_y,
    out_z,
    out_min_height,
    out_max_height,
  );
  return ret >>> 0;
}

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
 * @param {number} dist_sq
 * @param {number} threshold_sq
 * @param {number} count
 * @param {number} visibility
 * @returns {number}
 */
export function lod_filter(dist_sq, threshold_sq, count, visibility) {
  const ret = wasm.lod_filter(dist_sq, threshold_sq, count, visibility);
  return ret >>> 0;
}

/**
 * Returns the number of arena slots compiled into this WASM build.
 * JS bridges can call this once at startup to verify the build is
 * FORK-45-aware (returns NUM_SLOTS) versus the legacy single-arena
 * build (function is missing → ReferenceError on the JS side).
 * @returns {number}
 */
export function num_arena_slots() {
  const ret = wasm.num_arena_slots();
  return ret >>> 0;
}

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
 * @param {number} layer
 * @param {number} priority
 * @param {number} material
 * @param {number} distance
 * @param {boolean} back_to_front
 * @param {number} out_high
 * @param {number} out_low
 */
export function pack_sort_key(
  layer,
  priority,
  material,
  distance,
  back_to_front,
  out_high,
  out_low,
) {
  wasm.pack_sort_key(
    layer,
    priority,
    material,
    distance,
    back_to_front,
    out_high,
    out_low,
  );
}

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
 * @param {number} indices
 * @param {number} keys_high
 * @param {number} keys_low
 * @param {number} count
 * @param {number} temp
 */
export function radix_sort_keys(indices, keys_high, keys_low, count, temp) {
  wasm.radix_sort_keys(indices, keys_high, keys_low, count, temp);
}

/**
 * Returns the WASM module version for compatibility checking.
 * JS bridge uses this to verify WASM/JS API compatibility.
 * - v1: initial frustum cull + radix sort
 * - v2: terrain/RTE/matrix/point-cloud additions
 * - v3: FORK-45 per-bridge arena slots (alloc_buffer_slot,
 *   free_buffer_slot, num_arena_slots). Legacy alloc_buffer /
 *   free_buffer still work and forward to slot 0.
 * @returns {number}
 */
export function version() {
  const ret = wasm.version();
  return ret >>> 0;
}

function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
  };
  return {
    __proto__: null,
    "./cesium_wasm_bg.js": import0,
  };
}

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  wasmModule = module;
  return wasm;
}

async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type);

        if (
          validResponse &&
          module.headers.get("Content-Type") !== "application/wasm"
        ) {
          console.warn(
            "`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",
            e,
          );
        } else {
          throw e;
        }
      }
    }

    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm;

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn(
        "using deprecated parameters for `initSync()`; pass a single object instead",
      );
    }
  }

  const imports = __wbg_get_imports();
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm;

  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn(
        "using deprecated parameters for the initialization function; pass a single object instead",
      );
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL("cesium_wasm_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();

  if (
    typeof module_or_path === "string" ||
    (typeof Request === "function" && module_or_path instanceof Request) ||
    (typeof URL === "function" && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path);
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports);

  return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
