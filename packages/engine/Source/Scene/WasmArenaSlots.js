/**
 * Per-bridge WASM arena slot IDs (FORK-45).
 *
 * The Rust crate exposes 8 independent `Mutex<Vec<u8>>` arena slots
 * (see packages/wasm/src/lib.rs::ARENAS). Each JS bridge claims a
 * dedicated slot so that two bridges running concurrently on a worker
 * pool cannot stomp on each other's allocations.
 *
 * The legacy `wasm.alloc_buffer(n)` / `wasm.free_buffer()` API is
 * preserved and forwards to slot 0, so a bridge that hasn't migrated
 * keeps working unchanged. Migrating a bridge means:
 *
 * 1. Pick a slot ID from the enum below (or add a new one if needed).
 * 2. Replace `wasm.alloc_buffer(n)` with `wasm.alloc_buffer_slot(slot, n)`.
 * 3. Replace `wasm.free_buffer()` with `wasm.free_buffer_slot(slot)`.
 * 4. Add a `_arenaSlot` field to the bridge constructor for traceability.
 *
 * Slot IDs are stable across builds. If you reorder these constants,
 * old WASM modules in the wild may end up with the wrong slot — only
 * append new entries; never reuse a freed ID without bumping the
 * `version()` exported from the Rust crate.
 *
 * Capacity: NUM_SLOTS = 8 in the Rust side. The current 7 bridges fit
 * in slots 0-6 with one spare. Adding more bridges past 7 requires
 * bumping `NUM_SLOTS` in lib.rs and rebuilding.
 *
 * @private
 */
const WasmArenaSlot = Object.freeze({
  /**
   * Slot 0 is the legacy/default slot used by `wasm.alloc_buffer()`
   * and `wasm.free_buffer()`. Bridges that haven't been migrated to
   * the per-slot API land here. Don't rely on slot 0 being yours.
   */
  DEFAULT: 0,

  /** WasmCullBridge — 6-plane SIMD frustum culling. */
  CULL: 1,

  /** WasmSortBridge — radix sort on packed 64-bit keys. */
  SORT: 2,

  /** WasmHeightmapBridge — heightmap decode + ECEF conversion. */
  HEIGHTMAP: 3,

  /** WasmQuantizedMeshBridge — quantized mesh vertex reconstruction. */
  QUANTIZED_MESH: 4,

  /** WasmRTEBridge — batch RTE high/low encoding. */
  RTE: 5,

  /** WasmMatrixBridge — batch Matrix4 × Vector ops. */
  MATRIX: 6,

  /** WasmPointCloudBridge — point cloud LOD + distance culling. */
  POINT_CLOUD: 7,
});

/**
 * Detects whether the loaded WASM module exposes the per-slot arena
 * API (FORK-45). Returns false for older WASM builds where bridges
 * must continue using the legacy alloc_buffer / free_buffer pair.
 *
 * @param {object} wasmModule The wasm-bindgen instantiated module.
 * @returns {boolean} True if alloc_buffer_slot is callable.
 */
function hasArenaSlots(wasmModule) {
  return (
    wasmModule !== null &&
    wasmModule !== undefined &&
    typeof wasmModule.alloc_buffer_slot === "function"
  );
}

/**
 * Allocates `sizeBytes` from the requested slot if the per-slot API is
 * available, otherwise falls back to the legacy single-arena
 * `alloc_buffer` for compatibility with older WASM builds.
 *
 * Returns 0 on OOM or unknown-slot, matching the underlying contract.
 *
 * @param {object} wasmModule The wasm-bindgen instantiated module.
 * @param {number} slot       A WasmArenaSlot value.
 * @param {number} sizeBytes  Allocation size in bytes.
 * @returns {number} Pointer (0 on failure).
 */
function allocFromSlot(wasmModule, slot, sizeBytes) {
  if (hasArenaSlots(wasmModule)) {
    return wasmModule.alloc_buffer_slot(slot, sizeBytes);
  }
  return wasmModule.alloc_buffer(sizeBytes);
}

/**
 * Frees the requested slot if the per-slot API is available, otherwise
 * frees the legacy single arena.
 *
 * @param {object} wasmModule The wasm-bindgen instantiated module.
 * @param {number} slot       A WasmArenaSlot value.
 */
function freeSlot(wasmModule, slot) {
  if (hasArenaSlots(wasmModule)) {
    wasmModule.free_buffer_slot(slot);
    return;
  }
  wasmModule.free_buffer();
}

export { WasmArenaSlot, hasArenaSlots, allocFromSlot, freeSlot };
export default WasmArenaSlot;
