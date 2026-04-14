import WasmFeatureDetection from "../Core/WasmFeatureDetection.js";

/**
 * JavaScript bridge for WASM-accelerated batch RTE encoding.
 *
 * Splits f64 ECEF positions into high/low f32 pairs for GPU precision.
 * Also provides batch eye-space computation from RTE-encoded positions.
 *
 * WASM functions: batch_rte_encode, batch_rte_encode_soa, batch_rte_to_eye
 * Expected speedup: 2-3x over JS for >100 positions.
 *
 * @private
 */

let _wasmModule = null;
let _wasmLoading = null;
let _wasmReady = false;
let _simdActive = false;

class WasmRTEBridge {
  constructor() {
    this._threshold = 100;
    this._lastWasmUsed = false;
    this._encodeCount = 0;
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
        WasmFeatureDetection.checkVersionMatch(module, "rte");
        _simdActive = WasmFeatureDetection.checkModuleSIMD(module, "rte");
        _wasmModule = module;
        _wasmReady = true;
        return true;
      } catch (e) {
        console.warn("[CesiumJS:WASM:rte] Load failed:", e.message);
        return false;
      }
    })();
    return _wasmLoading;
  }

  /**
   * Batch encode interleaved f64 XYZ positions into high/low f32 pairs.
   *
   * @param {Float64Array} positions - Interleaved [x0,y0,z0,x1,y1,z1,...] f64
   * @param {number} count - Number of 3D positions
   * @param {Float32Array} outHigh - Output high parts (count*3)
   * @param {Float32Array} outLow - Output low parts (count*3)
   */
  batchEncode(positions, count, outHigh, outLow) {
    this._encodeCount++;
    if (_wasmReady && count >= this._threshold) {
      this._lastWasmUsed = true;
      this._encodeWasm(positions, count, outHigh, outLow);
      return;
    }
    this._lastWasmUsed = false;
    this._encodeJS(positions, count, outHigh, outLow);
  }

  /** @private */
  _encodeWasm(positions, count, outHigh, outLow) {
    const total = count * 3;
    const inputBytes = total * 8;
    const outputBytes = total * 4 * 2;

    try {
      const ptr = _wasmModule.alloc_buffer(inputBytes + outputBytes);
      if (ptr === 0) {
        this._encodeJS(positions, count, outHigh, outLow);
        return;
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const buf = memory.buffer;

      new Float64Array(buf, ptr, total).set(positions.subarray(0, total));
      const highPtr = ptr + inputBytes;
      const lowPtr = highPtr + total * 4;

      _wasmModule.batch_rte_encode(ptr, count, highPtr, lowPtr);

      outHigh.set(new Float32Array(buf, highPtr, total));
      outLow.set(new Float32Array(buf, lowPtr, total));
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:rte] encode failed, using JS fallback:",
        e.message,
      );
      this._encodeJS(positions, count, outHigh, outLow);
    }
  }

  /** @private */
  _encodeJS(positions, count, outHigh, outLow) {
    const total = count * 3;
    for (let i = 0; i < total; i++) {
      const val = positions[i];
      const high = Math.fround(val);
      outHigh[i] = high;
      outLow[i] = Math.fround(val - high);
    }
  }

  /**
   * Batch compute eye-space positions from RTE-encoded data and camera.
   *
   * @param {Float32Array} posHigh - Position high parts (SOA: hx,hy,hz arrays concatenated)
   * @param {Float32Array} posLow - Position low parts
   * @param {object} cameraHigh - {x,y,z} camera high f32
   * @param {object} cameraLow - {x,y,z} camera low f32
   * @param {number} count - Number of positions
   * @param {Float32Array} outEye - Output eye-space positions (count*3 interleaved)
   */
  batchToEye(posHigh, posLow, cameraHigh, cameraLow, count, outEye) {
    if (_wasmReady && count >= this._threshold) {
      this._toEyeWasm(posHigh, posLow, cameraHigh, cameraLow, count, outEye);
      return;
    }
    this._toEyeJS(posHigh, posLow, cameraHigh, cameraLow, count, outEye);
  }

  /** @private */
  _toEyeJS(posHigh, posLow, camHigh, camLow, count, out) {
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      out[i3] = posHigh[i3] - camHigh.x + (posLow[i3] - camLow.x);
      out[i3 + 1] = posHigh[i3 + 1] - camHigh.y + (posLow[i3 + 1] - camLow.y);
      out[i3 + 2] = posHigh[i3 + 2] - camHigh.z + (posLow[i3 + 2] - camLow.z);
    }
  }

  /** @private */
  _toEyeWasm(posHigh, posLow, camHigh, camLow, count, out) {
    const arrayBytes = count * 4;
    const totalBytes = arrayBytes * 9;

    try {
      const ptr = _wasmModule.alloc_buffer(totalBytes);
      if (ptr === 0) {
        this._toEyeJS(posHigh, posLow, camHigh, camLow, count, out);
        return;
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const buf = memory.buffer;

      // Deinterleave to SOA for WASM
      const hx = new Float32Array(buf, ptr, count);
      const hy = new Float32Array(buf, ptr + arrayBytes, count);
      const hz = new Float32Array(buf, ptr + arrayBytes * 2, count);
      const lx = new Float32Array(buf, ptr + arrayBytes * 3, count);
      const ly = new Float32Array(buf, ptr + arrayBytes * 4, count);
      const lz = new Float32Array(buf, ptr + arrayBytes * 5, count);

      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        hx[i] = posHigh[i3];
        hy[i] = posHigh[i3 + 1];
        hz[i] = posHigh[i3 + 2];
        lx[i] = posLow[i3];
        ly[i] = posLow[i3 + 1];
        lz[i] = posLow[i3 + 2];
      }

      const oxPtr = ptr + arrayBytes * 6;
      const oyPtr = ptr + arrayBytes * 7;
      const ozPtr = ptr + arrayBytes * 8;

      _wasmModule.batch_rte_to_eye(
        ptr,
        ptr + arrayBytes,
        ptr + arrayBytes * 2,
        ptr + arrayBytes * 3,
        ptr + arrayBytes * 4,
        ptr + arrayBytes * 5,
        camHigh.x,
        camHigh.y,
        camHigh.z,
        camLow.x,
        camLow.y,
        camLow.z,
        count,
        oxPtr,
        oyPtr,
        ozPtr,
      );

      // Re-interleave output
      const ox = new Float32Array(buf, oxPtr, count);
      const oy = new Float32Array(buf, oyPtr, count);
      const oz = new Float32Array(buf, ozPtr, count);
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        out[i3] = ox[i];
        out[i3 + 1] = oy[i];
        out[i3 + 2] = oz[i];
      }
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:rte] toEye failed, using JS fallback:",
        e.message,
      );
      this._toEyeJS(posHigh, posLow, camHigh, camLow, count, out);
    }
  }

  getDiagnostics() {
    return {
      wasmReady: _wasmReady,
      simdActive: _simdActive,
      threshold: this._threshold,
      lastWasmUsed: this._lastWasmUsed,
      encodeCount: this._encodeCount,
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

export default WasmRTEBridge;
