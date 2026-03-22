/* tslint:disable */
/* eslint-disable */

/**
 * Allocates a contiguous buffer in WASM linear memory.
 * Returns a raw pointer that JS can use with Float32Array views.
 *
 * The returned pointer is valid until `free_buffer()` or the next
 * `alloc_buffer()` call that triggers reallocation.
 *
 * In threaded WASM contexts, callers must ensure that no other thread
 * is reading/writing the buffer when this function is called.
 */
export function alloc_buffer(size_bytes: number): number;

/**
 * Frees the shared buffer. Call when the WASM module is being torn down.
 */
export function free_buffer(): void;

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
  readonly free_buffer: () => void;
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
