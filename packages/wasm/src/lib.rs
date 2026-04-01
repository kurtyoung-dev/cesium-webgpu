//! # cesium-wasm-culling
//!
//! WASM SIMD spatial acceleration for CesiumJS rendering pipeline.
//! Provides high-performance frustum culling, radix sort, terrain processing,
//! RTE encoding, matrix operations, and point cloud acceleration.
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
//! ## Modules
//!
//! - `frustum_cull`: SIMD batch frustum culling (6-plane sphere test)
//! - `radix_sort`: O(N) radix sort on packed 64-bit sort keys
//! - `heightmap_tessellator`: SIMD heightmap decode + ECEF conversion
//! - `quantized_mesh`: SIMD zigzag decode + quantized mesh vertex reconstruction
//! - `rte_encode`: Batch RTE (Relative-To-Eye) f64→f32 high/low splitting
//! - `matrix_batch`: SIMD batch Matrix4 × Vector operations
//! - `point_cloud`: SIMD point cloud LOD, distance, octree acceleration

mod frustum_cull;
mod radix_sort;
mod heightmap_tessellator;
mod quantized_mesh;
mod rte_encode;
mod matrix_batch;
mod point_cloud;

use std::sync::Mutex;
use wasm_bindgen::prelude::*;

// Re-export public API
pub use frustum_cull::frustum_cull_batch;
pub use radix_sort::radix_sort_keys;
pub use heightmap_tessellator::{heightmap_to_ecef, decode_heightmap};
pub use quantized_mesh::{decode_quantized_mesh, decode_indices};
pub use rte_encode::{batch_rte_encode, batch_rte_encode_soa, batch_rte_to_eye};
pub use matrix_batch::{batch_transform_points, batch_transform_per_entity, batch_mat4_multiply};
pub use point_cloud::{batch_distance_squared, lod_filter, compact_visible, batch_aabb_frustum_test};

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
/// Returns 0 (null) on allocation failure (OOM) — callers must check
/// the return value and fall back to JS if zero.
///
/// The returned pointer is valid until `free_buffer()` or the next
/// `alloc_buffer()` call that triggers reallocation.
///
/// In threaded WASM contexts, callers must ensure that no other thread
/// is reading/writing the buffer when this function is called.
#[wasm_bindgen]
pub fn alloc_buffer(size_bytes: usize) -> *mut u8 {
    let mut arena = ARENA.lock().unwrap_or_else(|e| e.into_inner());

    // If we need more capacity, try to reserve it — returns Err on OOM
    if size_bytes > arena.capacity() {
        if arena.try_reserve(size_bytes - arena.len()).is_err() {
            // OOM: return null pointer so JS bridge can fall back
            return std::ptr::null_mut();
        }
    }

    // Safe to resize now — capacity is sufficient, no panic possible
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
/// Bumped to 2 for the terrain/RTE/matrix/point-cloud additions.
#[wasm_bindgen]
pub fn version() -> u32 {
    2
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
