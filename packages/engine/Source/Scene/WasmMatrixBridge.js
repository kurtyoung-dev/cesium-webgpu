import WasmFeatureDetection from "../Core/WasmFeatureDetection.js";

/**
 * JavaScript bridge for WASM-accelerated batch matrix operations.
 *
 * Batches Matrix4 × Vector4 multiply across N entities using WASM SIMD.
 * Common case: one model matrix applied to many vertices, or per-entity
 * model matrices each applied to one vertex.
 *
 * WASM functions: batch_transform_points, batch_transform_per_entity, batch_mat4_multiply
 * Expected speedup: 2-4x over JS Matrix4.multiplyByPoint for >100 entities.
 *
 * @private
 */

let _wasmModule = null;
let _wasmLoading = null;
let _wasmReady = false;
let _simdActive = false;

class WasmMatrixBridge {
  constructor() {
    this._threshold = 100;
    this._lastWasmUsed = false;
    this._transformCount = 0;
    this._isDestroyed = false;
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
        WasmFeatureDetection.checkVersionMatch(module, "matrix");
        _simdActive = WasmFeatureDetection.checkModuleSIMD(module, "matrix");
        _wasmModule = module;
        _wasmReady = true;
        return true;
      } catch (e) {
        console.warn("[CesiumJS:WASM:matrix] Load failed:", e.message);
        return false;
      }
    })();
    return _wasmLoading;
  }

  /**
   * Batch transform N points by a single 4×4 matrix.
   *
   * @param {Float32Array} matrix - 16-element column-major matrix
   * @param {Float32Array} pointsX - Input X coordinates (SOA)
   * @param {Float32Array} pointsY - Input Y coordinates (SOA)
   * @param {Float32Array} pointsZ - Input Z coordinates (SOA)
   * @param {number} count - Number of points
   * @param {Float32Array} outX - Output X coordinates
   * @param {Float32Array} outY - Output Y coordinates
   * @param {Float32Array} outZ - Output Z coordinates
   */
  batchTransformPoints(
    matrix,
    pointsX,
    pointsY,
    pointsZ,
    count,
    outX,
    outY,
    outZ,
  ) {
    this._transformCount++;
    if (_wasmReady && count >= this._threshold) {
      this._lastWasmUsed = true;
      this._transformWasm(
        matrix,
        pointsX,
        pointsY,
        pointsZ,
        count,
        outX,
        outY,
        outZ,
      );
      return;
    }
    this._lastWasmUsed = false;
    this._transformJS(
      matrix,
      pointsX,
      pointsY,
      pointsZ,
      count,
      outX,
      outY,
      outZ,
    );
  }

  /** @private */
  _transformWasm(matrix, px, py, pz, count, ox, oy, oz) {
    const matBytes = 16 * 4;
    const arrayBytes = count * 4;
    const totalBytes = matBytes + arrayBytes * 6;

    try {
      const ptr = _wasmModule.alloc_buffer(totalBytes);
      if (ptr === 0) {
        this._transformJS(matrix, px, py, pz, count, ox, oy, oz);
        return;
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const buf = memory.buffer;

      new Float32Array(buf, ptr, 16).set(matrix);
      const pxPtr = ptr + matBytes;
      const pyPtr = pxPtr + arrayBytes;
      const pzPtr = pyPtr + arrayBytes;
      new Float32Array(buf, pxPtr, count).set(px.subarray(0, count));
      new Float32Array(buf, pyPtr, count).set(py.subarray(0, count));
      new Float32Array(buf, pzPtr, count).set(pz.subarray(0, count));

      const oxPtr = pzPtr + arrayBytes;
      const oyPtr = oxPtr + arrayBytes;
      const ozPtr = oyPtr + arrayBytes;

      _wasmModule.batch_transform_points(
        ptr,
        pxPtr,
        pyPtr,
        pzPtr,
        count,
        oxPtr,
        oyPtr,
        ozPtr,
      );

      ox.set(new Float32Array(buf, oxPtr, count));
      oy.set(new Float32Array(buf, oyPtr, count));
      oz.set(new Float32Array(buf, ozPtr, count));
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:matrix] transform failed, using JS fallback:",
        e.message,
      );
      this._transformJS(matrix, px, py, pz, count, ox, oy, oz);
    }
  }

  /** @private */
  _transformJS(matrix, px, py, pz, count, ox, oy, oz) {
    // Column-major: m[col*4 + row]
    const m00 = matrix[0],
      m01 = matrix[4],
      m02 = matrix[8],
      m03 = matrix[12];
    const m10 = matrix[1],
      m11 = matrix[5],
      m12 = matrix[9],
      m13 = matrix[13];
    const m20 = matrix[2],
      m21 = matrix[6],
      m22 = matrix[10],
      m23 = matrix[14];

    for (let i = 0; i < count; i++) {
      const x = px[i],
        y = py[i],
        z = pz[i];
      ox[i] = m00 * x + m01 * y + m02 * z + m03;
      oy[i] = m10 * x + m11 * y + m12 * z + m13;
      oz[i] = m20 * x + m21 * y + m22 * z + m23;
    }
  }

  /**
   * Batch multiply N matrices by a single view matrix: result[i] = view × model[i]
   *
   * @param {Float32Array} modelMatrices - N×16 packed column-major matrices
   * @param {Float32Array} viewMatrix - Single 16-element column-major view matrix
   * @param {number} count - Number of model matrices
   * @param {Float32Array} outMatrices - Output N×16 packed result matrices
   */
  batchMultiplyMatrices(modelMatrices, viewMatrix, count, outMatrices) {
    if (_wasmReady && count >= this._threshold) {
      this._multiplyWasm(modelMatrices, viewMatrix, count, outMatrices);
      return;
    }
    this._multiplyJS(modelMatrices, viewMatrix, count, outMatrices);
  }

  /** @private */
  _multiplyWasm(models, view, count, out) {
    const matBytes = count * 16 * 4;
    const viewBytes = 16 * 4;
    const totalBytes = matBytes + viewBytes + matBytes;

    try {
      const ptr = _wasmModule.alloc_buffer(totalBytes);
      if (ptr === 0) {
        this._multiplyJS(models, view, count, out);
        return;
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const buf = memory.buffer;

      new Float32Array(buf, ptr, count * 16).set(
        models.subarray(0, count * 16),
      );
      const viewPtr = ptr + matBytes;
      new Float32Array(buf, viewPtr, 16).set(view);
      const outPtr = viewPtr + viewBytes;

      _wasmModule.batch_mat4_multiply(ptr, viewPtr, count, outPtr);
      out.set(new Float32Array(buf, outPtr, count * 16));
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:matrix] multiply failed, using JS fallback:",
        e.message,
      );
      this._multiplyJS(models, view, count, out);
    }
  }

  /** @private */
  _multiplyJS(models, view, count, out) {
    for (let i = 0; i < count; i++) {
      const aOff = i * 16;
      const oOff = i * 16;
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            sum += models[aOff + k * 4 + row] * view[col * 4 + k];
          }
          out[oOff + col * 4 + row] = sum;
        }
      }
    }
  }

  getDiagnostics() {
    return {
      wasmReady: _wasmReady,
      simdActive: _simdActive,
      threshold: this._threshold,
      lastWasmUsed: this._lastWasmUsed,
      transformCount: this._transformCount,
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

export default WasmMatrixBridge;
