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
//! a Mutex per slot to ensure safe concurrent access. In single-threaded
//! contexts (browsers without SharedArrayBuffer support), Mutex locking has
//! near-zero overhead (atomic bool check only).
//!
//! ## Per-bridge arena slots (FORK-45)
//!
//! Each JS bridge gets a dedicated `Mutex<Vec<u8>>` slot indexed by an
//! integer ID. Slots are independent: an `alloc_buffer_slot(slot, n)`
//! call from one bridge cannot invalidate pointers handed out from any
//! other slot. This makes the arena safe for parallel-frame futures
//! where two bridges may run concurrently on different worker threads.
//!
//! Slot ID assignment is owned by the JS side — see the `WasmArenaSlot`
//! enum exposed from `Source/Scene/WasmArenaSlots.js`. Bridges that
//! still call the legacy `alloc_buffer` / `free_buffer` keep working
//! and share slot 0; new bridges should claim a dedicated slot.
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

/// Number of independent arena slots. One per JS bridge plus headroom.
///
/// FORK-45: Originally there was a single global `ARENA: Mutex<Vec<u8>>`
/// shared by every bridge. That worked only because the bridges run
/// sequentially today. As soon as anything calls into two bridges from
/// different threads (workers, parallel frames), one bridge's resize
/// can invalidate another bridge's pointer between alloc and read.
///
/// Per-slot arenas eliminate that interaction: each bridge gets its
/// own `Mutex<Vec<u8>>` and a stable slot index, so two bridges can
/// run concurrently on a worker pool without contending for the same
/// underlying buffer.
///
/// Slot IDs are JS-side constants (see `WasmArenaSlot` in the bridges).
/// Slot 0 is the legacy "default" slot used by `alloc_buffer` /
/// `free_buffer` so existing call sites that haven't migrated to the
/// per-slot API keep working unchanged.
pub const NUM_SLOTS: usize = 8;

/// Convenience: legacy bridges that haven't migrated to a dedicated
/// slot end up here.
const DEFAULT_SLOT: usize = 0;

/// Thread-safe per-slot arena allocators for shared memory between
/// JS and WASM. JS calls `alloc_buffer_slot(slot, n)` to get a pointer,
/// writes data, then calls the processing function with the same
/// pointer.
///
/// This avoids copying data across the JS/WASM boundary — JS writes
/// directly into WASM linear memory via the returned pointer.
///
/// `Mutex::new(Vec::new())` is `const fn` since Rust 1.63, so the
/// array can be initialized in static scope without `lazy_static`
/// or `OnceLock` ceremony. We spell out 8 entries explicitly because
/// `[Mutex::new(Vec::new()); NUM_SLOTS]` requires `Copy`, which
/// `Mutex` is not.
static ARENAS: [Mutex<Vec<u8>>; NUM_SLOTS] = [
    Mutex::new(Vec::new()),
    Mutex::new(Vec::new()),
    Mutex::new(Vec::new()),
    Mutex::new(Vec::new()),
    Mutex::new(Vec::new()),
    Mutex::new(Vec::new()),
    Mutex::new(Vec::new()),
    Mutex::new(Vec::new()),
];

/// Allocates a contiguous buffer in the requested slot's arena.
/// Returns a raw pointer that JS can use with Float32Array views.
/// Returns 0 (null) on allocation failure (OOM, or invalid slot)
/// so callers can fall back to JS.
///
/// The returned pointer is valid until `free_buffer_slot(slot)` or
/// the next `alloc_buffer_slot(slot, ..)` call on the same slot that
/// triggers reallocation. Slots are independent — allocating on one
/// slot does NOT invalidate pointers handed out from any other slot,
/// which is the whole point of FORK-45.
#[wasm_bindgen]
pub fn alloc_buffer_slot(slot: usize, size_bytes: usize) -> *mut u8 {
    if slot >= NUM_SLOTS {
        return std::ptr::null_mut();
    }

    let mut arena = ARENAS[slot].lock().unwrap_or_else(|e| e.into_inner());

    // If we need more capacity, try to reserve it — returns Err on OOM.
    //
    // The `arena.len()` is hoisted into a local because `try_reserve`
    // takes `&mut self` and the borrow checker rejects the in-line
    // `arena.try_reserve(size_bytes - arena.len())` form (immutable +
    // mutable borrow in the same expression).
    if size_bytes > arena.capacity() {
        let current_len = arena.len();
        if arena.try_reserve(size_bytes - current_len).is_err() {
            // OOM: return null pointer so JS bridge can fall back
            return std::ptr::null_mut();
        }
    }

    // Safe to resize now — capacity is sufficient, no panic possible
    arena.resize(size_bytes, 0);
    arena.as_mut_ptr()
}

/// Frees the requested slot's arena. Call when the JS-side bridge
/// for this slot is being torn down. Bridges that share `DEFAULT_SLOT`
/// must coordinate the free — typically the last living bridge calls it.
#[wasm_bindgen]
pub fn free_buffer_slot(slot: usize) {
    if slot >= NUM_SLOTS {
        return;
    }
    let mut arena = ARENAS[slot].lock().unwrap_or_else(|e| e.into_inner());
    arena.clear();
    arena.shrink_to_fit();
}

/// Legacy single-arena API. Forwards to slot 0 so existing JS bridges
/// that haven't been migrated to the per-slot API keep working without
/// any change. New bridges should call `alloc_buffer_slot` directly.
#[wasm_bindgen]
pub fn alloc_buffer(size_bytes: usize) -> *mut u8 {
    alloc_buffer_slot(DEFAULT_SLOT, size_bytes)
}

/// Legacy single-arena API. Forwards to slot 0.
#[wasm_bindgen]
pub fn free_buffer() {
    free_buffer_slot(DEFAULT_SLOT);
}

/// Returns the number of arena slots compiled into this WASM build.
/// JS bridges can call this once at startup to verify the build is
/// FORK-45-aware (returns NUM_SLOTS) versus the legacy single-arena
/// build (function is missing → ReferenceError on the JS side).
#[wasm_bindgen]
pub fn num_arena_slots() -> usize {
    NUM_SLOTS
}

/// Returns the WASM module version for compatibility checking.
/// JS bridge uses this to verify WASM/JS API compatibility.
/// - v1: initial frustum cull + radix sort
/// - v2: terrain/RTE/matrix/point-cloud additions
/// - v3: FORK-45 per-bridge arena slots (alloc_buffer_slot,
///   free_buffer_slot, num_arena_slots). Legacy alloc_buffer /
///   free_buffer still work and forward to slot 0.
#[wasm_bindgen]
pub fn version() -> u32 {
    3
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
