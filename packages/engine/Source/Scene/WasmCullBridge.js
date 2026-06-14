import SOABoundingSphereLayout from "./SOABoundingSphereLayout.js";
import WasmFeatureDetection from "../Core/WasmFeatureDetection.js";
import { WasmArenaSlot, allocFromSlot, freeSlot } from "./WasmArenaSlots.js";
import resolveWasmGlueUrl from "./resolveWasmGlueUrl.js";

// Shared WASM module state — loaded once, reused across all bridge instances.
let _wasmModule = null;
let _wasmLoading = null;
let _simdActive = false;

/**
 * JavaScript bridge for WASM-accelerated frustum culling using SIMD.
 *
 * Manages a SharedArrayBuffer-backed SOA layout for bounding sphere data
 * and frustum planes. When a WASM module is loaded, culling is dispatched
 * to WASM SIMD for ~10x speedup over JS. Falls back to JS implementation.
 *
 * @alias WasmCullBridge
 * @private
 */
class WasmCullBridge {
  /**
   * @param {object} [options] Configuration options.
   * @param {number} [options.capacity=65536] Maximum bounding spheres.
   * @param {boolean} [options.useSharedMemory=false] Use SharedArrayBuffer.
   * @param {number} [options.threshold=500] Min spheres for WASM activation.
   */
  constructor(options) {
    options = options ?? {};

    /**
     * SOA bounding sphere layout for SIMD batch processing.
     * @type {SOABoundingSphereLayout}
     */
    this.soaLayout = new SOABoundingSphereLayout(
      options.capacity ?? 65536,
      options.useSharedMemory ?? false,
    );

    /**
     * Frustum planes buffer (6 planes × 4 floats = 24 floats).
     * @type {Float32Array}
     * @private
     */
    this._frustumPlanes = new Float32Array(24);

    /**
     * Minimum sphere count for WASM activation.
     * @type {number}
     */
    this.threshold = options.threshold ?? 500;

    /**
     * Per-frame statistics.
     * @type {object}
     * @private
     */
    this._stats = {
      spheresTested: 0,
      spheresVisible: 0,
      cullTimeMs: 0,
      usedWasm: false,
    };

    this._isDestroyed = false;
  }

  /**
   * Whether WASM culling is available.
   * @type {boolean}
   * @readonly
   */
  get isAvailable() {
    return _wasmModule !== null;
  }

  /**
   * Whether the WASM module is loaded and ready. Alias of {@link WasmCullBridge#isAvailable}
   * that matches the `wasmReady` accessor on the other Wasm*Bridge classes so a
   * single load-state probe works uniformly across all bridges.
   * @type {boolean}
   * @readonly
   */
  get wasmReady() {
    return _wasmModule !== null;
  }

  /**
   * Per-frame statistics.
   * @type {object}
   * @readonly
   */
  get stats() {
    return this._stats;
  }

  /**
   * Packs frustum planes from a CullingVolume into the flat float32 buffer.
   * @param {CullingVolume} cullingVolume The camera frustum.
   */
  packFrustumPlanes(cullingVolume) {
    const planes = cullingVolume.planes;
    for (let i = 0; i < 6 && i < planes.length; i++) {
      const plane = planes[i];
      const offset = i * 4;
      this._frustumPlanes[offset] = plane.normal.x;
      this._frustumPlanes[offset + 1] = plane.normal.y;
      this._frustumPlanes[offset + 2] = plane.normal.z;
      this._frustumPlanes[offset + 3] = plane.distance;
    }
  }

  /**
   * Performs batch frustum culling on all populated bounding spheres.
   * Uses WASM SIMD when available, falls back to JS.
   *
   * @param {CullingVolume} cullingVolume The camera frustum.
   * @param {Array} commands The command list (for SOA population).
   * @returns {Array} Array of visible command indices.
   */
  cullCommands(cullingVolume, commands) {
    const startTime = performance.now();

    if (commands.length > this.soaLayout.capacity) {
      this.soaLayout.resize(commands.length * 2);
    }

    this.soaLayout.populate(commands);
    this.packFrustumPlanes(cullingVolume);

    const count = this.soaLayout.count;
    this._stats.spheresTested = count;

    if (_wasmModule && count >= this.threshold) {
      this._cullWasm(count);
      this._stats.usedWasm = true;
    } else {
      this._cullJS(count);
      this._stats.usedWasm = false;
    }

    const visibleIndices = [];
    const visibility = this.soaLayout.visibility;
    const commandIndices = this.soaLayout.commandIndices;
    for (let i = 0; i < count; i++) {
      if (visibility[i] === 1) {
        visibleIndices.push(commandIndices[i]);
      }
    }

    this._stats.spheresVisible = visibleIndices.length;
    this._stats.cullTimeMs = performance.now() - startTime;

    return visibleIndices;
  }

  /**
   * JS fallback frustum culling — tests each sphere against 6 planes.
   * @param {number} count Number of spheres to test.
   * @private
   */
  _cullJS(count) {
    const cx = this.soaLayout.centerX;
    const cy = this.soaLayout.centerY;
    const cz = this.soaLayout.centerZ;
    const r = this.soaLayout.radius;
    const vis = this.soaLayout.visibility;
    const planes = this._frustumPlanes;

    for (let i = 0; i < count; i++) {
      const x = cx[i];
      const y = cy[i];
      const z = cz[i];
      const radius = r[i];
      let visible = 1;

      for (let p = 0; p < 6; p++) {
        const offset = p * 4;
        const dot =
          planes[offset] * x +
          planes[offset + 1] * y +
          planes[offset + 2] * z +
          planes[offset + 3];

        if (dot < -radius) {
          visible = 0;
          break;
        }
      }

      vis[i] = visible;
    }
  }

  /**
   * Asynchronously loads the WASM culling module.
   * Performs SIMD feature detection and version checking per .clinerules mandates.
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

    // Check browser SIMD support before attempting to load SIMD-enabled module
    if (!WasmFeatureDetection.checkSIMDSupport()) {
      console.warn(
        "[CesiumJS:WASM:cull] Browser does not support WASM SIMD. Using JS fallback.",
      );
    }

    // NEW-WASM-BRIDGE-BUNDLE-LOAD (Batch 274): route through the shared
    // buildModuleUrl-backed resolver + keep the import EXTERNAL (webpackIgnore)
    // so esbuild no longer INLINES the glue (the inlined glue's
    // `new URL("cesium_wasm_bg.wasm", import.meta.url)` resolved to the bundle
    // root and 404'd the binary). The glue now loads as its own module with the
    // correct sibling-binary URL. See resolveWasmGlueUrl.js.
    _wasmLoading = import(/* webpackIgnore: true */ resolveWasmGlueUrl())
      .then((glue) => glue.default())
      .then((wasm) => {
        // glue.default() (__wbg_init) returns the instance exports (incl.
        // `.memory`) — `_wasmModule` therefore already exposes linear memory.
        // Version check (mandated by .clinerules)
        WasmFeatureDetection.checkVersionMatch(wasm, "cull");
        // SIMD check
        _simdActive = WasmFeatureDetection.checkModuleSIMD(wasm, "cull");
        _wasmModule = wasm;
        return true;
      })
      .catch((err) => {
        console.warn(
          "[CesiumJS:WasmCullBridge] WASM load failed, using JS fallback:",
          err.message ?? err,
        );
        _wasmLoading = null;
        return false;
      });

    return _wasmLoading;
  }

  /**
   * WASM SIMD frustum culling — copies SOA data into WASM linear memory,
   * calls the SIMD batch function, reads visibility results back.
   * Uses try/finally to ensure free_buffer() is called after each operation.
   *
   * @param {number} count Number of spheres to test.
   * @private
   */
  _cullWasm(count) {
    const wasm = _wasmModule;
    if (!wasm) {
      this._cullJS(count);
      return;
    }

    const floatBytes = count * 4;
    const planesBytes = 24 * 4;
    const visBytes = count;
    const totalBytes = floatBytes * 4 + planesBytes + visBytes;

    try {
      // FORK-45: Allocate from this bridge's dedicated slot if the
      // WASM build is recent enough; otherwise fall through to the
      // legacy single arena. The shared-slot fallback is correct
      // because every bridge runs sequentially today; per-slot is
      // the future-proofing for parallel-frame execution.
      const basePtr = allocFromSlot(wasm, WasmArenaSlot.CULL, totalBytes);
      if (basePtr === 0) {
        // OOM in WASM arena — fall back to JS
        this._cullJS(count);
        return;
      }

      const cxPtr = basePtr;
      const cyPtr = basePtr + floatBytes;
      const czPtr = basePtr + floatBytes * 2;
      const rPtr = basePtr + floatBytes * 3;
      const plPtr = basePtr + floatBytes * 4;
      const visPtr = plPtr + planesBytes;

      const wasmF32 = new Float32Array(wasm.memory.buffer);
      wasmF32.set(this.soaLayout.centerX.subarray(0, count), cxPtr / 4);
      wasmF32.set(this.soaLayout.centerY.subarray(0, count), cyPtr / 4);
      wasmF32.set(this.soaLayout.centerZ.subarray(0, count), czPtr / 4);
      wasmF32.set(this.soaLayout.radius.subarray(0, count), rPtr / 4);
      wasmF32.set(this._frustumPlanes, plPtr / 4);

      wasm.frustum_cull_batch(cxPtr, cyPtr, czPtr, rPtr, plPtr, visPtr, count);

      const wasmVis = new Uint8Array(wasm.memory.buffer, visPtr, count);
      this.soaLayout.visibility.set(wasmVis);
    } catch (e) {
      // WASM operation failed — fall back to JS
      console.warn(
        "[CesiumJS:WasmCullBridge] WASM cull failed, using JS fallback:",
        e.message,
      );
      this._cullJS(count);
    }
  }

  /**
   * Returns diagnostic info.
   * @returns {string} Diagnostic string.
   */
  getDiagnostics() {
    return [
      `=== WasmCullBridge (WASM: ${_wasmModule ? "READY" : "NOT LOADED"}, SIMD: ${_simdActive}) ===`,
      `Threshold: ${this.threshold} spheres`,
      `Last cull: ${this._stats.spheresTested} tested, ${this._stats.spheresVisible} visible`,
      `Time: ${this._stats.cullTimeMs.toFixed(2)}ms`,
      `Used WASM: ${this._stats.usedWasm}`,
    ].join("\n");
  }

  /**
   * Releases WASM resources. Call from Viewer.destroy().
   * Frees the shared arena buffer and drops module references.
   */
  destroy() {
    if (this._isDestroyed) {
      return;
    }
    // FORK-45: free the dedicated slot first; the legacy free is a
    // no-op when the per-slot API is present, so calling both is
    // safe and keeps the bridge backwards-compatible with older WASM
    // builds where only `freeBuffer` exists.
    if (_wasmModule) {
      freeSlot(_wasmModule, WasmArenaSlot.CULL);
    }
    WasmFeatureDetection.freeBuffer(_wasmModule);
    this._isDestroyed = true;
  }
}

export default WasmCullBridge;
