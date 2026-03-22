//! # cesium-wasm-culling
//!
//! WASM SIMD spatial acceleration for CesiumJS rendering pipeline.
//! Provides high-performance frustum culling and radix sort for draw commands.
//!
//! ## Architecture
//!
//! JS (main thread) populates SOA Float32Arrays with bounding sphere data,
//! passes pointers to WASM functions, and reads back visibility/sort results.
//!
//! All spatial data uses float32 for SIMD (4-wide f32x4). The JS side uses
//! float64 ECEF for precise spatial queries; WASM handles the batch hot paths.
//!
//! ## Thread Safety
//!
//! WASM supports threading via SharedArrayBuffer. The arena allocator uses
//! a Mutex to ensure safe concurrent access. In single-threaded contexts
//! (browsers without SharedArrayBuffer support), Mutex locking has near-zero
//! overhead (atomic bool check only).
//!
//! ## Functions
//!
//! - `frustum_cull_batch`: SIMD batch frustum culling (6-plane sphere test)
//! - `radix_sort_keys`: O(N) radix sort on packed 64-bit sort keys
//! - `alloc_buffer` / `free_buffer`: Thread-safe allocator for shared memory

mod frustum_cull;
mod radix_sort;

use std::sync::Mutex;
use wasm_bindgen::prelude::*;

// Re-export public API
pub use frustum_cull::frustum_cull_batch;
pub use radix_sort::radix_sort_keys;

/// Thread-safe arena allocator for shared memory between JS and WASM.
/// Uses Mutex for safe concurrent access when WASM threading is enabled.
/// JS calls alloc_buffer() to get a pointer, writes data, then calls
/// the processing function with the same pointer.
///
/// This avoids copying data across the JS/WASM boundary — JS writes
/// directly into WASM linear memory via the returned pointer.
static ARENA: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// Allocates a contiguous buffer in WASM linear memory.
/// Returns a raw pointer that JS can use with Float32Array views.
///
/// The returned pointer is valid until `free_buffer()` or the next
/// `alloc_buffer()` call that triggers reallocation.
///
/// In threaded WASM contexts, callers must ensure that no other thread
/// is reading/writing the buffer when this function is called.
#[wasm_bindgen]
pub fn alloc_buffer(size_bytes: usize) -> *mut u8 {
    let mut arena = ARENA.lock().unwrap_or_else(|e| e.into_inner());
    arena.resize(size_bytes, 0);
    arena.as_mut_ptr()
}

/// Frees the shared buffer. Call when the WASM module is being torn down.
#[wasm_bindgen]
pub fn free_buffer() {
    let mut arena = ARENA.lock().unwrap_or_else(|e| e.into_inner());
    arena.clear();
    arena.shrink_to_fit();
}

/// Returns the WASM module version for compatibility checking.
/// JS bridge uses this to verify WASM/JS API compatibility.
#[wasm_bindgen]
pub fn version() -> u32 {
    1
}

/// Returns whether SIMD is supported in this build.
/// When compiled with target-feature=+simd128, this returns true.
/// JS bridge can use this to confirm SIMD acceleration is active.
#[wasm_bindgen]
pub fn has_simd() -> bool {
    cfg!(target_feature = "simd128")
}

/// Returns whether this build supports threading.
/// When compiled with -C target-feature=+atomics,+bulk-memory,+mutable-globals,
/// this returns true. JS bridge uses this to decide whether to use
/// SharedArrayBuffer for cross-thread data sharing.
#[wasm_bindgen]
pub fn has_threads() -> bool {
    cfg!(target_feature = "atomics")
}
