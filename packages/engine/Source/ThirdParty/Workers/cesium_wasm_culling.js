/* @ts-self-types="./cesium_wasm_culling.d.ts" */

/**
 * Allocates a contiguous buffer in WASM linear memory.
 * Returns a raw pointer that JS can use with Float32Array views.
 *
 * The returned pointer is valid until `free_buffer()` or the next
 * `alloc_buffer()` call that triggers reallocation.
 *
 * In threaded WASM contexts, callers must ensure that no other thread
 * is reading/writing the buffer when this function is called.
 * @param {number} size_bytes
 * @returns {number}
 */
export function alloc_buffer(size_bytes) {
  const ret = wasm.alloc_buffer(size_bytes);
  return ret >>> 0;
}

/**
 * Frees the shared buffer. Call when the WASM module is being torn down.
 */
export function free_buffer() {
  wasm.free_buffer();
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
    "./cesium_wasm_culling_bg.js": import0,
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
    module_or_path = new URL("cesium_wasm_culling_bg.wasm", import.meta.url);
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
