import WasmFeatureDetection from "../Core/WasmFeatureDetection.js";
import { WasmArenaSlot, allocFromSlot } from "./WasmArenaSlots.js";
// AUDIT_2026_05_02 B.19 / FORK-45 — claim per-bridge arena slot.

/**
 * JavaScript bridge for WASM-accelerated quantized mesh terrain decoding.
 *
 * Quantized mesh tiles use zigzag + delta encoding for vertex compression.
 * WASM SIMD accelerates the normalization step (4 vertices per cycle).
 *
 * WASM functions: decode_quantized_mesh, decode_indices
 * Expected speedup: 3-8x over JS for typical quantized mesh tiles.
 *
 * @private
 */

let _wasmModule = null;
let _wasmLoading = null;
let _wasmReady = false;
let _simdActive = false;

class WasmQuantizedMeshBridge {
  constructor() {
    this._threshold = 256; // Min vertices to use WASM
    this._lastWasmUsed = false;
    this._decodeCount = 0;
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
  get simdActive() {
    return _simdActive;
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
        WasmFeatureDetection.checkVersionMatch(module, "qmesh");
        _simdActive = WasmFeatureDetection.checkModuleSIMD(module, "qmesh");
        _wasmModule = module;
        _wasmReady = true;
        return true;
      } catch (e) {
        console.warn("[CesiumJS:WASM:qmesh] Load failed:", e.message);
        return false;
      }
    })();
    return _wasmLoading;
  }

  /**
   * Decode zigzag+delta encoded quantized mesh vertices.
   *
   * @param {Uint16Array} encodedU - Encoded U coordinates
   * @param {Uint16Array} encodedV - Encoded V coordinates
   * @param {Uint16Array} encodedH - Encoded height values
   * @param {Float32Array} outU - Normalized U output [0,1]
   * @param {Float32Array} outV - Normalized V output [0,1]
   * @param {Float32Array} outH - Normalized height output [0,1]
   * @returns {number} Vertex count
   */
  decodeVertices(encodedU, encodedV, encodedH, outU, outV, outH) {
    const count = encodedU.length;
    this._decodeCount++;

    if (_wasmReady && count >= this._threshold) {
      this._lastWasmUsed = true;
      return this._decodeWasm(
        encodedU,
        encodedV,
        encodedH,
        count,
        outU,
        outV,
        outH,
      );
    }

    this._lastWasmUsed = false;
    return this._decodeJS(
      encodedU,
      encodedV,
      encodedH,
      count,
      outU,
      outV,
      outH,
    );
  }

  /** @private */
  _decodeWasm(eu, ev, eh, count, outU, outV, outH) {
    const inputBytes = count * 2 * 3;
    const outputBytes = count * 4 * 3;
    const totalBytes = inputBytes + outputBytes;

    try {
      const ptr = allocFromSlot(
        _wasmModule,
        WasmArenaSlot.QUANTIZED_MESH,
        totalBytes,
      );
      if (ptr === 0) {
        return this._decodeJS(eu, ev, eh, count, outU, outV, outH);
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const buf = memory.buffer;

      const euPtr = ptr;
      const evPtr = ptr + count * 2;
      const ehPtr = ptr + count * 4;
      new Uint16Array(buf, euPtr, count).set(eu);
      new Uint16Array(buf, evPtr, count).set(ev);
      new Uint16Array(buf, ehPtr, count).set(eh);

      const outBase = ptr + inputBytes;
      const ouPtr = outBase;
      const ovPtr = outBase + count * 4;
      const ohPtr = outBase + count * 8;

      _wasmModule.decode_quantized_mesh(
        euPtr,
        evPtr,
        ehPtr,
        count,
        ouPtr,
        ovPtr,
        ohPtr,
      );

      outU.set(new Float32Array(buf, ouPtr, count));
      outV.set(new Float32Array(buf, ovPtr, count));
      outH.set(new Float32Array(buf, ohPtr, count));

      return count;
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:qmesh] decode failed, using JS fallback:",
        e.message,
      );
      return this._decodeJS(eu, ev, eh, count, outU, outV, outH);
    }
  }

  /** @private */
  _decodeJS(eu, ev, eh, count, outU, outV, outH) {
    const norm = 1.0 / 32767.0;
    let uAcc = 0,
      vAcc = 0,
      hAcc = 0;

    for (let i = 0; i < count; i++) {
      uAcc += zigzagDecode(eu[i]);
      vAcc += zigzagDecode(ev[i]);
      hAcc += zigzagDecode(eh[i]);
      outU[i] = uAcc * norm;
      outV[i] = vAcc * norm;
      outH[i] = hAcc * norm;
    }
    return count;
  }

  getDiagnostics() {
    return {
      wasmReady: _wasmReady,
      threshold: this._threshold,
      lastWasmUsed: this._lastWasmUsed,
      decodeCount: this._decodeCount,
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

function zigzagDecode(val) {
  return (val >> 1) ^ -(val & 1);
}

export default WasmQuantizedMeshBridge;
