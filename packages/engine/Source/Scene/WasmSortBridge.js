import defined from "../Core/defined.js";
import WasmFeatureDetection from "../Core/WasmFeatureDetection.js";
import {
  DEFAULT_COMMAND_SORT_LAYER,
  DEFAULT_COMMAND_SORT_PRIORITY,
  normalizeCommandMaterialSortId,
  normalizeCommandSortByte,
} from "../Renderer/CommandOrdering.js";
import { WasmArenaSlot, allocFromSlot } from "./WasmArenaSlots.js";
import resolveWasmGlueUrl from "./resolveWasmGlueUrl.js";

// Shared WASM module state — loaded once, shared with other bridges.
let _wasmModule = null;
let _wasmLoading = null;
let _simdActive = false;

// Scratch buffers for float32 ↔ uint32 reinterpretation
const _scratchArrayBuffer = new ArrayBuffer(4);
const _scratchFloat32 = new Float32Array(_scratchArrayBuffer);
const _scratchUint32 = new Uint32Array(_scratchArrayBuffer);

/**
 * JavaScript bridge for WASM-accelerated radix sort of structured sort keys.
 *
 * When WASM is available and command count exceeds the threshold, this bridge
 * packs multi-level sort keys (layer, priority, material, distance) into
 * 64-bit integers and uses O(N) radix sort instead of O(N log N) comparison sort.
 *
 * The 64-bit packed key layout:
 * ```
 * ┌──────────┬───────────┬───────────┬──────────────────────┐
 * │ Layer    │ Priority  │ Material  │ Distance (float32)   │
 * │ (8 bits) │ (8 bits)  │ (16 bits) │ (32 bits)            │
 * └──────────┴───────────┴───────────┴──────────────────────┘
 * ```
 *
 * @alias WasmSortBridge
 * @private
 */
class WasmSortBridge {
  /**
   * @param {object} [options] Configuration options.
   * @param {number} [options.threshold=5000] Minimum commands to activate WASM.
   * @param {number} [options.capacity=65536] Maximum commands to sort.
   */
  constructor(options) {
    options = options ?? {};

    /**
     * Minimum command count before WASM sort activates.
     * @type {number}
     * @default 5000
     */
    this.threshold = options.threshold ?? 5000;

    /**
     * Maximum sortable commands.
     * @type {number}
     */
    this.capacity = options.capacity ?? 65536;

    /**
     * Packed sort key buffer — high 32 bits (layer + priority + material).
     * @type {Uint32Array}
     * @private
     */
    this._keysHigh = new Uint32Array(this.capacity);

    /**
     * Packed sort key buffer — low 32 bits (distance as float32 bits).
     * @type {Uint32Array}
     * @private
     */
    this._keysLow = new Uint32Array(this.capacity);

    /**
     * Index array — sorted indices output.
     * @type {Uint32Array}
     * @private
     */
    this._indices = new Uint32Array(this.capacity);

    /**
     * Per-frame statistics.
     * @type {object}
     * @private
     */
    this._stats = {
      sortTimeMs: 0,
      commandCount: 0,
      usedWasm: false,
    };

    this._isDestroyed = false;
  }

  /**
   * Whether WASM radix sort is available.
   * @type {boolean}
   * @readonly
   */
  get isAvailable() {
    return _wasmModule !== null;
  }

  /**
   * Whether the WASM module is loaded and ready. Alias of {@link WasmSortBridge#isAvailable}
   * that matches the `wasmReady` accessor on the other Wasm*Bridge classes so a
   * single load-state probe works uniformly across all bridges.
   * @type {boolean}
   * @readonly
   */
  get wasmReady() {
    return _wasmModule !== null;
  }

  /**
   * Per-frame sort statistics.
   * @type {object}
   * @readonly
   */
  get stats() {
    return this._stats;
  }

  /**
   * Packs a command's multi-level sort properties into a 64-bit key
   * (stored as two 32-bit integers).
   *
   * @param {object} command A DrawCommand.
   * @param {number} distanceSquared Squared distance to camera.
   * @param {boolean} backToFront Whether to sort back-to-front.
   * @param {number} index Index into the key arrays.
   * @private
   */
  _packKey(command, distanceSquared, backToFront, index) {
    const layer = normalizeCommandSortByte(
      command.sortLayer,
      DEFAULT_COMMAND_SORT_LAYER,
    );
    const priority = normalizeCommandSortByte(
      command.sortPriority,
      DEFAULT_COMMAND_SORT_PRIORITY,
    );
    const material = normalizeCommandMaterialSortId(command.materialSortId);

    this._keysHigh[index] = (layer << 24) | (priority << 16) | material;

    const distance = Math.sqrt(distanceSquared);
    const distFloat32 = Math.fround(distance);

    _scratchFloat32[0] = distFloat32;
    let distBits = _scratchUint32[0];

    if (backToFront) {
      distBits = ~distBits >>> 0;
    }

    this._keysLow[index] = distBits;
  }

  /**
   * Packs all commands' sort keys and performs radix sort.
   *
   * @param {Array} commands Array of DrawCommands to sort.
   * @param {object} cameraPosition Camera position for distance.
   * @param {boolean} backToFront Sort direction.
   * @returns {Uint32Array} Sorted indices (length = commands.length).
   */
  sortWithPackedKeys(commands, cameraPosition, backToFront) {
    const startTime = performance.now();
    const count = Math.min(commands.length, this.capacity);

    for (let i = 0; i < count; i++) {
      const cmd = commands[i];
      const dist = defined(cmd.boundingVolume)
        ? cmd.boundingVolume.distanceSquaredTo(cameraPosition)
        : 0;
      this._packKey(cmd, dist, backToFront, i);
      this._indices[i] = i;
    }

    if (_wasmModule && count >= this.threshold) {
      this._sortWasm(count);
      this._stats.usedWasm = true;
    } else {
      radixSortByKey(this._indices, this._keysHigh, this._keysLow, count);
      this._stats.usedWasm = false;
    }

    this._stats.sortTimeMs = performance.now() - startTime;
    this._stats.commandCount = count;

    return this._indices;
  }

  /**
   * Asynchronously loads the WASM sorting module.
   * Performs SIMD feature detection and version checking.
   *
   * @returns {Promise<boolean>} True if WASM loaded successfully.
   */
  loadWasm() {
    if (_wasmModule) {
      return Promise.resolve(true);
    }

    if (_wasmLoading !== null) {
      return _wasmLoading.then(() => _wasmModule !== null);
    }

    WasmFeatureDetection.checkSIMDSupport();

    // NEW-WASM-BRIDGE-BUNDLE-LOAD (Batch 274): route through the shared
    // buildModuleUrl-backed resolver + keep the import EXTERNAL (webpackIgnore)
    // so esbuild no longer INLINES the glue (the inlined glue's
    // `new URL("cesium_wasm_bg.wasm", import.meta.url)` resolved to the bundle
    // root and 404'd the binary). See resolveWasmGlueUrl.js.
    _wasmLoading = import(/* webpackIgnore: true */ resolveWasmGlueUrl())
      .then((glue) => glue.default())
      .then((wasm) => {
        // glue.default() (__wbg_init) returns the instance exports (incl.
        // `.memory`) — `_wasmModule` therefore already exposes linear memory.
        WasmFeatureDetection.checkVersionMatch(wasm, "sort");
        _simdActive = WasmFeatureDetection.checkModuleSIMD(wasm, "sort");
        _wasmModule = wasm;
        return true;
      })
      .catch((err) => {
        console.warn(
          "[CesiumJS:WasmSortBridge] WASM load failed, using JS fallback:",
          err.message ?? err,
        );
        _wasmLoading = null;
        return false;
      });

    return _wasmLoading;
  }

  /**
   * WASM radix sort — copies packed keys into WASM linear memory,
   * calls the O(N) radix sort, reads sorted indices back.
   *
   * @param {number} count Number of elements to sort.
   * @private
   */
  _sortWasm(count) {
    const wasm = _wasmModule;
    if (!wasm) {
      radixSortByKey(this._indices, this._keysHigh, this._keysLow, count);
      return;
    }

    const u32Bytes = count * 4;
    const totalBytes = u32Bytes * 4; // indices + keysHigh + keysLow + temp

    try {
      // AUDIT_2026_05_02 B.19 / FORK-45 — claim the dedicated SORT
      // arena slot so concurrent calls from other bridges (cull, RTE,
      // matrix, etc.) don't trample each other's allocations once
      // worker-pool work lands. Fallback path uses the legacy single
      // arena for backwards compatibility with older WASM builds.
      const basePtr = allocFromSlot(wasm, WasmArenaSlot.SORT, totalBytes);
      if (basePtr === 0) {
        radixSortByKey(this._indices, this._keysHigh, this._keysLow, count);
        return;
      }

      const idxPtr = basePtr;
      const highPtr = basePtr + u32Bytes;
      const lowPtr = basePtr + u32Bytes * 2;
      const tempPtr = basePtr + u32Bytes * 3;

      const wasmU32 = new Uint32Array(wasm.memory.buffer);
      wasmU32.set(this._indices.subarray(0, count), idxPtr / 4);
      wasmU32.set(this._keysHigh.subarray(0, count), highPtr / 4);
      wasmU32.set(this._keysLow.subarray(0, count), lowPtr / 4);

      wasm.radix_sort_keys(idxPtr, highPtr, lowPtr, count, tempPtr);

      const sortedView = new Uint32Array(wasm.memory.buffer, idxPtr, count);
      this._indices.set(sortedView);
    } catch (e) {
      console.warn(
        "[CesiumJS:WasmSortBridge] WASM sort failed, using JS fallback:",
        e.message,
      );
      radixSortByKey(this._indices, this._keysHigh, this._keysLow, count);
    }
  }

  /**
   * Returns diagnostic info.
   * @returns {string} Diagnostic string.
   */
  getDiagnostics() {
    return [
      `=== WasmSortBridge (WASM: ${_wasmModule ? "READY" : "NOT LOADED"}, SIMD: ${_simdActive}) ===`,
      `Threshold: ${this.threshold} commands`,
      `Last sort: ${this._stats.commandCount} commands in ${this._stats.sortTimeMs.toFixed(2)}ms`,
      `Used WASM: ${this._stats.usedWasm}`,
    ].join("\n");
  }

  /**
   * Releases WASM resources. Call from Viewer.destroy().
   */
  destroy() {
    if (this._isDestroyed) {
      return;
    }
    WasmFeatureDetection.freeBuffer(_wasmModule);
    this._isDestroyed = true;
  }
}

/**
 * 8-bit radix sort on packed 64-bit keys (high + low words).
 * Sorts indices array in-place based on key values.
 * 8 passes (4 bytes per word × 2 words), O(8N) = O(N).
 *
 * @param {Uint32Array} indices Index array to sort.
 * @param {Uint32Array} keysHigh High 32-bit key words.
 * @param {Uint32Array} keysLow Low 32-bit key words.
 * @param {number} count Number of elements.
 * @private
 */
function radixSortByKey(indices, keysHigh, keysLow, count) {
  const temp = new Uint32Array(count);
  const counts = new Uint32Array(256);

  // Sort by low word first (least significant), then high word
  for (let byte = 0; byte < 4; byte++) {
    const shift = byte * 8;
    counts.fill(0);

    for (let i = 0; i < count; i++) {
      const key = (keysLow[indices[i]] >>> shift) & 0xff;
      counts[key]++;
    }

    let sum = 0;
    for (let i = 0; i < 256; i++) {
      const c = counts[i];
      counts[i] = sum;
      sum += c;
    }

    for (let i = 0; i < count; i++) {
      const idx = indices[i];
      const key = (keysLow[idx] >>> shift) & 0xff;
      temp[counts[key]++] = idx;
    }

    for (let i = 0; i < count; i++) {
      indices[i] = temp[i];
    }
  }

  for (let byte = 0; byte < 4; byte++) {
    const shift = byte * 8;
    counts.fill(0);

    for (let i = 0; i < count; i++) {
      const key = (keysHigh[indices[i]] >>> shift) & 0xff;
      counts[key]++;
    }

    let sum = 0;
    for (let i = 0; i < 256; i++) {
      const c = counts[i];
      counts[i] = sum;
      sum += c;
    }

    for (let i = 0; i < count; i++) {
      const idx = indices[i];
      const key = (keysHigh[idx] >>> shift) & 0xff;
      temp[counts[key]++] = idx;
    }

    for (let i = 0; i < count; i++) {
      indices[i] = temp[i];
    }
  }
}

export default WasmSortBridge;
