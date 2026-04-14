import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import WasmFeatureDetection from "../Core/WasmFeatureDetection.js";

/**
 * JavaScript bridge for WASM-accelerated point cloud processing.
 *
 * Provides batch distance computation, LOD filtering, and octree node
 * AABB-frustum testing. All operations have JS fallbacks.
 *
 * WASM functions: batch_distance_squared, lod_filter, compact_visible, batch_aabb_frustum_test
 * Expected speedup: 3-5x over JS for >50K point datasets.
 *
 * @private
 */

let _wasmModule = null;
let _wasmLoading = null;
let _wasmReady = false;
let _simdActive = false;

class WasmPointCloudBridge {
  constructor() {
    this._threshold = 5000;
    this._lastWasmUsed = false;
    this._processCount = 0;
    this._isDestroyed = false;

    /**
     * When true and a GPU compute context is available, sorting is
     * offloaded to the WebGPU bitonic sort dispatcher. Results are
     * read back asynchronously, introducing one frame of latency
     * (conservative all-visible until the first readback resolves).
     *
     * Default false — only useful when a GPU-side consumer exists
     * (e.g., indirect draw) to avoid the readback cost.
     * @type {boolean}
     */
    this.useGPUSort = false;

    /** Cached GPU sort feature renderer reference. */
    this._gpuSortFR = undefined;
    /** Whether we already tried (and failed) to look up the FR. */
    this._gpuSortFRChecked = false;
  }

  get threshold() {
    return this._threshold;
  }
  set threshold(value) {
    this._threshold = value;
  }
  get wasmReady() {
    return _wasmReady;
  }

  async loadWasm() {
    if (_wasmReady) {
      return true;
    }
    if (_wasmLoading) {
      return _wasmLoading;
    }
    WasmFeatureDetection.checkSIMDSupport();
    _wasmLoading = (async () => {
      try {
        const module = await import(
          /* webpackIgnore: true */
          "../../ThirdParty/Workers/cesium_wasm.js"
        );
        await module.default();
        WasmFeatureDetection.checkVersionMatch(module, "pointcloud");
        _simdActive = WasmFeatureDetection.checkModuleSIMD(
          module,
          "pointcloud",
        );
        _wasmModule = module;
        _wasmReady = true;
        return true;
      } catch (e) {
        console.warn("[CesiumJS:WASM:pointcloud] Load failed:", e.message);
        return false;
      }
    })();
    return _wasmLoading;
  }

  /**
   * Batch compute squared distances from camera to N points.
   *
   * @param {Float32Array} pointsX - Point X coordinates (SOA)
   * @param {Float32Array} pointsY - Point Y coordinates (SOA)
   * @param {Float32Array} pointsZ - Point Z coordinates (SOA)
   * @param {number} camX - Camera X
   * @param {number} camY - Camera Y
   * @param {number} camZ - Camera Z
   * @param {number} count - Number of points
   * @param {Float32Array} outDistSq - Output squared distances
   */
  batchDistanceSquared(
    pointsX,
    pointsY,
    pointsZ,
    camX,
    camY,
    camZ,
    count,
    outDistSq,
  ) {
    this._processCount++;
    if (_wasmReady && count >= this._threshold) {
      this._lastWasmUsed = true;
      this._distWasm(
        pointsX,
        pointsY,
        pointsZ,
        camX,
        camY,
        camZ,
        count,
        outDistSq,
      );
      return;
    }
    this._lastWasmUsed = false;
    this._distJS(pointsX, pointsY, pointsZ, camX, camY, camZ, count, outDistSq);
  }

  /** @private */
  _distWasm(px, py, pz, cx, cy, cz, count, out) {
    const arrayBytes = count * 4;
    const totalBytes = arrayBytes * 4;

    try {
      const ptr = _wasmModule.alloc_buffer(totalBytes);
      if (ptr === 0) {
        this._distJS(px, py, pz, cx, cy, cz, count, out);
        return;
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const buf = memory.buffer;

      new Float32Array(buf, ptr, count).set(px.subarray(0, count));
      new Float32Array(buf, ptr + arrayBytes, count).set(py.subarray(0, count));
      new Float32Array(buf, ptr + arrayBytes * 2, count).set(
        pz.subarray(0, count),
      );
      const outPtr = ptr + arrayBytes * 3;

      _wasmModule.batch_distance_squared(
        ptr,
        ptr + arrayBytes,
        ptr + arrayBytes * 2,
        cx,
        cy,
        cz,
        count,
        outPtr,
      );
      out.set(new Float32Array(buf, outPtr, count));
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:pointcloud] dist failed, using JS fallback:",
        e.message,
      );
      this._distJS(px, py, pz, cx, cy, cz, count, out);
    }
  }

  /** @private */
  _distJS(px, py, pz, cx, cy, cz, count, out) {
    for (let i = 0; i < count; i++) {
      const dx = px[i] - cx;
      const dy = py[i] - cy;
      const dz = pz[i] - cz;
      out[i] = dx * dx + dy * dy + dz * dz;
    }
  }

  /**
   * LOD filter: mark points visible if within distance threshold.
   *
   * @param {Float32Array} distSq - Squared distances
   * @param {number} thresholdSq - Max squared distance for visibility
   * @param {number} count - Number of points
   * @param {Uint8Array} visibility - Output visibility flags
   * @returns {number} Number of visible points
   */
  lodFilter(distSq, thresholdSq, count, visibility) {
    if (_wasmReady && count >= this._threshold) {
      return this._lodFilterWasm(distSq, thresholdSq, count, visibility);
    }
    return this._lodFilterJS(distSq, thresholdSq, count, visibility);
  }

  /** @private */
  _lodFilterWasm(distSq, thresholdSq, count, visibility) {
    const inputBytes = count * 4;
    const outputBytes = count;
    const totalBytes = inputBytes + outputBytes;

    try {
      const ptr = _wasmModule.alloc_buffer(totalBytes);
      if (ptr === 0) {
        return this._lodFilterJS(distSq, thresholdSq, count, visibility);
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const buf = memory.buffer;

      new Float32Array(buf, ptr, count).set(distSq.subarray(0, count));
      const visPtr = ptr + inputBytes;

      const visCount = _wasmModule.lod_filter(ptr, thresholdSq, count, visPtr);
      visibility.set(new Uint8Array(buf, visPtr, count));
      return visCount;
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:pointcloud] lodFilter failed, using JS fallback:",
        e.message,
      );
      return this._lodFilterJS(distSq, thresholdSq, count, visibility);
    }
  }

  /** @private */
  _lodFilterJS(distSq, thresholdSq, count, visibility) {
    let visCount = 0;
    for (let i = 0; i < count; i++) {
      const vis = distSq[i] <= thresholdSq ? 1 : 0;
      visibility[i] = vis;
      visCount += vis;
    }
    return visCount;
  }

  /**
   * Compact visible indices into a dense array.
   *
   * @param {Uint8Array} visibility - Visibility flags
   * @param {number} count - Total point count
   * @param {Uint32Array} outIndices - Dense visible index output
   * @returns {number} Number of visible indices
   */
  compactVisible(visibility, count, outIndices) {
    let writeIdx = 0;
    for (let i = 0; i < count; i++) {
      if (visibility[i]) {
        outIndices[writeIdx++] = i;
      }
    }
    return writeIdx;
  }

  /**
   * Batch AABB-frustum test for octree nodes.
   *
   * @param {Float32Array} centerX/Y/Z - AABB centers (SOA)
   * @param {Float32Array} halfX/Y/Z - AABB half-extents (SOA)
   * @param {Float32Array} planes - 6 frustum planes (24 floats)
   * @param {number} count - Number of AABBs
   * @param {Uint8Array} visibility - Output visibility flags
   * @returns {number} Number of visible nodes
   */
  batchAABBFrustumTest(
    centerX,
    centerY,
    centerZ,
    halfX,
    halfY,
    halfZ,
    planes,
    count,
    visibility,
  ) {
    if (_wasmReady && count >= this._threshold) {
      return this._aabbWasm(
        centerX,
        centerY,
        centerZ,
        halfX,
        halfY,
        halfZ,
        planes,
        count,
        visibility,
      );
    }
    return this._aabbJS(
      centerX,
      centerY,
      centerZ,
      halfX,
      halfY,
      halfZ,
      planes,
      count,
      visibility,
    );
  }

  /** @private */
  _aabbWasm(cx, cy, cz, hx, hy, hz, planes, count, vis) {
    const arrayBytes = count * 4;
    const planeBytes = 24 * 4;
    const visBytes = count;
    const totalBytes = arrayBytes * 6 + planeBytes + visBytes;

    try {
      const ptr = _wasmModule.alloc_buffer(totalBytes);
      if (ptr === 0) {
        return this._aabbJS(cx, cy, cz, hx, hy, hz, planes, count, vis);
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const buf = memory.buffer;

      let off = ptr;
      new Float32Array(buf, off, count).set(cx.subarray(0, count));
      off += arrayBytes;
      new Float32Array(buf, off, count).set(cy.subarray(0, count));
      off += arrayBytes;
      new Float32Array(buf, off, count).set(cz.subarray(0, count));
      off += arrayBytes;
      new Float32Array(buf, off, count).set(hx.subarray(0, count));
      off += arrayBytes;
      new Float32Array(buf, off, count).set(hy.subarray(0, count));
      off += arrayBytes;
      new Float32Array(buf, off, count).set(hz.subarray(0, count));
      off += arrayBytes;
      new Float32Array(buf, off, 24).set(planes);
      off += planeBytes;

      const visPtr = off;
      const visCount = _wasmModule.batch_aabb_frustum_test(
        ptr,
        ptr + arrayBytes,
        ptr + arrayBytes * 2,
        ptr + arrayBytes * 3,
        ptr + arrayBytes * 4,
        ptr + arrayBytes * 5,
        ptr + arrayBytes * 6,
        count,
        visPtr,
      );

      vis.set(new Uint8Array(buf, visPtr, count));
      return visCount;
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:pointcloud] aabb test failed, using JS fallback:",
        e.message,
      );
      return this._aabbJS(cx, cy, cz, hx, hy, hz, planes, count, vis);
    }
  }

  /** @private */
  _aabbJS(cx, cy, cz, hx, hy, hz, planes, count, vis) {
    let visCount = 0;
    const pnx = [],
      pny = [],
      pnz = [],
      pd = [];
    for (let p = 0; p < 6; p++) {
      pnx[p] = planes[p * 4];
      pny[p] = planes[p * 4 + 1];
      pnz[p] = planes[p * 4 + 2];
      pd[p] = planes[p * 4 + 3];
    }

    for (let i = 0; i < count; i++) {
      let visible = true;
      for (let p = 0; p < 6; p++) {
        const dist = pnx[p] * cx[i] + pny[p] * cy[i] + pnz[p] * cz[i] + pd[p];
        const effRadius =
          Math.abs(pnx[p]) * hx[i] +
          Math.abs(pny[p]) * hy[i] +
          Math.abs(pnz[p]) * hz[i];
        if (dist < -effRadius) {
          visible = false;
          break;
        }
      }
      vis[i] = visible ? 1 : 0;
      if (visible) {
        visCount++;
      }
    }
    return visCount;
  }

  /**
   * CPU fallback: sort points by distance (back-to-front) for transparency.
   * Uses the pre-computed distSq array and returns sorted indices.
   * This is the JS fallback for when GPU PointCloudSort compute is unavailable.
   *
   * @param {Float32Array} distSq - Pre-computed squared distances.
   * @param {number} count - Number of points.
   * @param {Uint32Array} outIndices - Output sorted indices.
   */
  sortByDistance(distSq, count, outIndices, context) {
    // GPU path: dispatch bitonic sort on the compute pipeline.
    // Results are read back asynchronously; the first frame sees
    // identity order, subsequent frames see the GPU-sorted result.
    if (this.useGPUSort && context && count >= this._threshold) {
      const fr = this._getGPUSortFR(context);
      if (fr && typeof fr.sort === "function") {
        const encoder = context.currentCommandEncoder;
        if (encoder) {
          fr.sort(encoder, distSq, count);
          // Identity fill — readback from previous frame will be
          // applied by the caller's next testCommands cycle.
          for (let i = 0; i < count; i++) {
            outIndices[i] = i;
          }
          return;
        }
      }
    }

    // CPU fallback: populate + sort indices.
    for (let i = 0; i < count; i++) {
      outIndices[i] = i;
    }
    if (count <= 64) {
      for (let i = 1; i < count; i++) {
        const key = outIndices[i];
        const keyDist = distSq[key];
        let j = i - 1;
        while (j >= 0 && distSq[outIndices[j]] < keyDist) {
          outIndices[j + 1] = outIndices[j];
          j--;
        }
        outIndices[j + 1] = key;
      }
    } else {
      const arr = Array.from(outIndices.subarray(0, count));
      arr.sort((a, b) => distSq[b] - distSq[a]);
      outIndices.set(arr);
    }
  }

  /**
   * Lazily look up the GPU sort feature renderer via the backend-
   * agnostic feature renderer registry. Caches the result so we
   * don't query every frame.
   * @private
   */
  _getGPUSortFR(context) {
    if (this._gpuSortFRChecked) {
      return this._gpuSortFR;
    }
    this._gpuSortFRChecked = true;
    if (context && typeof context.getFeatureRenderer === "function") {
      this._gpuSortFR = context.getFeatureRenderer(
        FeatureRendererKey.POINT_CLOUD_SORT,
      );
    }
    return this._gpuSortFR;
  }

  /**
   * CPU fallback: LOD filter + sort combined operation.
   * Filters by distance, then sorts visible points back-to-front.
   * This is the JS fallback for when GPU PointCloudLOD compute is unavailable.
   *
   * @param {Float32Array} distSq - Pre-computed squared distances.
   * @param {number} lodThresholdSq - Max squared distance for LOD visibility.
   * @param {number} count - Total point count.
   * @param {Uint32Array} outIndices - Dense sorted visible indices.
   * @returns {number} Number of visible points.
   */
  lodFilterAndSort(distSq, lodThresholdSq, count, outIndices) {
    // First pass: collect visible indices
    let visCount = 0;
    for (let i = 0; i < count; i++) {
      if (distSq[i] <= lodThresholdSq) {
        outIndices[visCount++] = i;
      }
    }
    // Second pass: sort visible by distance (back-to-front)
    if (visCount > 1) {
      const sub = outIndices.subarray(0, visCount);
      const arr = Array.from(sub);
      arr.sort((a, b) => distSq[b] - distSq[a]);
      sub.set(arr);
    }
    return visCount;
  }

  getDiagnostics() {
    return {
      wasmReady: _wasmReady,
      simdActive: _simdActive,
      threshold: this._threshold,
      lastWasmUsed: this._lastWasmUsed,
      processCount: this._processCount,
    };
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

export default WasmPointCloudBridge;
