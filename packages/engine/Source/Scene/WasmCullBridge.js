import SOABoundingSphereLayout from "./SOABoundingSphereLayout.js";

// Shared WASM module state — loaded once, reused across all bridge instances.
// The generated JS glue caches internally, so multiple init() calls are no-ops.
let _wasmLoading = null;

/**
 * JavaScript bridge for WASM-accelerated frustum culling using SIMD.
 *
 * Manages a SharedArrayBuffer-backed SOA layout for bounding sphere data
 * and frustum planes. When a WASM module is loaded, culling is dispatched
 * to WASM SIMD for ~10x speedup over JS. Falls back to JS implementation.
 *
 * WASM SIMD frustum culling algorithm:
 * 1. Load 4 sphere centers into f32x4 registers
 * 2. For each frustum plane: dot(normal, center) + d > -radius → inside
 * 3. Bitwise AND of all 6 plane results → visible if all pass
 * 4. Write visibility to result buffer
 *
 * Performance expectations:
 * - JS: ~0.3μs/sphere (300μs for 1000 spheres)
 * - WASM SIMD: ~0.03μs/sphere (30μs for 1000 spheres, ~10x speedup)
 *
 * @param {object} [options] Configuration options.
 * @param {number} [options.capacity=65536] Maximum bounding spheres.
 * @param {boolean} [options.useSharedMemory=false] Use SharedArrayBuffer.
 * @param {number} [options.threshold=500] Min spheres for WASM activation.
 *
 * @alias WasmCullBridge
 * @constructor
 * @private
 */
function WasmCullBridge(options) {
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
   * Layout: [nx, ny, nz, d] per plane.
   * @type {Float32Array}
   * @private
   */
  this._frustumPlanes = new Float32Array(24);

  /**
   * Whether the WASM module is loaded and ready.
   * @type {boolean}
   * @private
   */
  this._wasmReady = false;

  /**
   * WASM module instance.
   * @private
   */
  this._wasmInstance = undefined;

  /**
   * Minimum sphere count for WASM activation.
   * @type {number}
   */
  this.threshold = options.threshold ?? 500;

  /**
   * Per-frame statistics.
   * @type {object}
   */
  this._stats = {
    spheresTested: 0,
    spheresVisible: 0,
    cullTimeMs: 0,
    usedWasm: false,
  };
}

Object.defineProperties(WasmCullBridge.prototype, {
  /**
   * Whether WASM culling is available.
   * @memberof WasmCullBridge.prototype
   * @type {boolean}
   * @readonly
   */
  isAvailable: {
    get: function () {
      return this._wasmReady;
    },
  },

  /**
   * Per-frame statistics.
   * @memberof WasmCullBridge.prototype
   * @type {object}
   * @readonly
   */
  stats: {
    get: function () {
      return this._stats;
    },
  },
});

/**
 * Packs frustum planes from a CullingVolume into the flat float32 buffer.
 *
 * @param {CullingVolume} cullingVolume The camera frustum.
 */
WasmCullBridge.prototype.packFrustumPlanes = function (cullingVolume) {
  const planes = cullingVolume.planes;
  for (let i = 0; i < 6 && i < planes.length; i++) {
    const plane = planes[i];
    const offset = i * 4;
    this._frustumPlanes[offset] = plane.normal.x;
    this._frustumPlanes[offset + 1] = plane.normal.y;
    this._frustumPlanes[offset + 2] = plane.normal.z;
    this._frustumPlanes[offset + 3] = plane.distance;
  }
};

/**
 * Performs batch frustum culling on all populated bounding spheres.
 * Uses WASM SIMD when available, falls back to JS.
 *
 * @param {CullingVolume} cullingVolume The camera frustum.
 * @param {Array} commands The command list (for SOA population).
 * @returns {Array} Array of visible command indices.
 */
WasmCullBridge.prototype.cullCommands = function (cullingVolume, commands) {
  const startTime = performance.now();

  // Resize if needed
  if (commands.length > this.soaLayout.capacity) {
    this.soaLayout.resize(commands.length * 2);
  }

  // Populate SOA from commands
  this.soaLayout.populate(commands);
  this.packFrustumPlanes(cullingVolume);

  const count = this.soaLayout.count;
  this._stats.spheresTested = count;

  // Use WASM or JS fallback
  if (this._wasmReady && count >= this.threshold) {
    this._cullWasm(count);
    this._stats.usedWasm = true;
  } else {
    this._cullJS(count);
    this._stats.usedWasm = false;
  }

  // Collect visible indices
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
};

/**
 * JS fallback frustum culling — tests each sphere against 6 planes.
 * @param {number} count Number of spheres to test.
 * @private
 */
WasmCullBridge.prototype._cullJS = function (count) {
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

    // Test against 6 frustum planes
    for (let p = 0; p < 6; p++) {
      const offset = p * 4;
      const dot =
        planes[offset] * x +
        planes[offset + 1] * y +
        planes[offset + 2] * z +
        planes[offset + 3];

      if (dot < -radius) {
        visible = 0;
        break; // Outside this plane — definitively culled
      }
    }

    vis[i] = visible;
  }
};

/**
 * Asynchronously loads the WASM culling module.
 * Gracefully falls back to JS if WASM fails to load (missing binary,
 * browser doesn't support WASM SIMD, etc.).
 *
 * @returns {Promise<boolean>} True if WASM loaded successfully.
 */
WasmCullBridge.prototype.loadWasm = function () {
  if (this._wasmReady) {
    return Promise.resolve(true);
  }

  // Deduplicate loading — all instances share the same module
  if (_wasmLoading !== null) {
    return _wasmLoading.then((mod) => {
      if (mod) {
        this._wasmInstance = mod;
        this._wasmReady = true;
      }
      return this._wasmReady;
    });
  }

  _wasmLoading = import("../ThirdParty/Workers/cesium_wasm_culling.js")
    .then((glue) => glue.default())
    .then((wasm) => {
      this._wasmInstance = wasm;
      this._wasmReady = true;
      return wasm;
    })
    .catch((err) => {
      console.warn(
        "[CesiumJS:WasmCullBridge] WASM load failed, using JS fallback:",
        err.message ?? err,
      );
      _wasmLoading = null;
      return null;
    });

  return _wasmLoading.then(() => this._wasmReady);
};

/**
 * WASM SIMD frustum culling — copies SOA data into WASM linear memory,
 * calls the SIMD batch function, reads visibility results back.
 *
 * Memory layout in WASM linear memory (one contiguous allocation):
 *   [centerX: N×f32][centerY: N×f32][centerZ: N×f32]
 *   [radii: N×f32][planes: 24×f32][visibility: N×u8]
 *
 * @param {number} count Number of spheres to test.
 * @private
 */
WasmCullBridge.prototype._cullWasm = function (count) {
  const wasm = this._wasmInstance;
  if (!wasm) {
    this._cullJS(count);
    return;
  }

  const floatBytes = count * 4;
  const planesBytes = 24 * 4; // 6 planes × 4 floats × 4 bytes
  const visBytes = count;
  const totalBytes = floatBytes * 4 + planesBytes + visBytes;

  // Allocate contiguous WASM memory
  const basePtr = wasm.alloc_buffer(totalBytes);

  // Compute sub-offsets
  const cxPtr = basePtr;
  const cyPtr = basePtr + floatBytes;
  const czPtr = basePtr + floatBytes * 2;
  const rPtr = basePtr + floatBytes * 3;
  const plPtr = basePtr + floatBytes * 4;
  const visPtr = plPtr + planesBytes;

  // Copy SOA data into WASM memory
  const wasmF32 = new Float32Array(wasm.memory.buffer);
  wasmF32.set(this.soaLayout.centerX.subarray(0, count), cxPtr / 4);
  wasmF32.set(this.soaLayout.centerY.subarray(0, count), cyPtr / 4);
  wasmF32.set(this.soaLayout.centerZ.subarray(0, count), czPtr / 4);
  wasmF32.set(this.soaLayout.radius.subarray(0, count), rPtr / 4);
  wasmF32.set(this._frustumPlanes, plPtr / 4);

  // Call WASM SIMD frustum culling
  wasm.frustum_cull_batch(cxPtr, cyPtr, czPtr, rPtr, plPtr, visPtr, count);

  // Read visibility results back into JS SOA layout
  const wasmVis = new Uint8Array(wasm.memory.buffer, visPtr, count);
  this.soaLayout.visibility.set(wasmVis);
};

/**
 * Returns diagnostic info.
 * @returns {string} Diagnostic string.
 */
WasmCullBridge.prototype.getDiagnostics = function () {
  return [
    `=== WasmCullBridge (WASM: ${this._wasmReady ? "READY" : "NOT LOADED"}) ===`,
    `Threshold: ${this.threshold} spheres`,
    `Last cull: ${this._stats.spheresTested} tested, ${this._stats.spheresVisible} visible`,
    `Time: ${this._stats.cullTimeMs.toFixed(2)}ms`,
    `Used WASM: ${this._stats.usedWasm}`,
  ].join("\n");
};

export default WasmCullBridge;
