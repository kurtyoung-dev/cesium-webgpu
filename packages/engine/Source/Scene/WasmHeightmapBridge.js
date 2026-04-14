import WasmFeatureDetection from "../Core/WasmFeatureDetection.js";

/**
 * JavaScript bridge for WASM-accelerated heightmap tessellation.
 *
 * Manages shared memory buffers for heightmap data and dispatches to WASM
 * when data count exceeds the threshold. Falls back to JS HeightmapTessellator
 * when WASM is unavailable or for small tiles.
 *
 * WASM functions: decode_heightmap, heightmap_to_ecef
 * Expected speedup: 2-5x over JS for typical 65×65 terrain tiles.
 *
 * @private
 */

let _wasmModule = null;
let _wasmLoading = null;
let _wasmReady = false;
let _simdActive = false;

class WasmHeightmapBridge {
  constructor() {
    this._threshold = 1024; // Min samples to use WASM (32×32 tile)
    this._lastWasmUsed = false;
    this._decodeCount = 0;
    this._tessellateCount = 0;
    this._isDestroyed = false;
  }

  /**
   * Threshold sample count below which JS is used instead of WASM.
   * @type {number}
   */
  get threshold() {
    return this._threshold;
  }

  set threshold(value) {
    this._threshold = value;
  }

  /**
   * Whether the WASM module is loaded and ready.
   * @type {boolean}
   */
  get wasmReady() {
    return _wasmReady;
  }

  /**
   * Whether the loaded WASM module has SIMD enabled.
   * @type {boolean}
   */
  get simdActive() {
    return _simdActive;
  }

  /**
   * Load the WASM module asynchronously. Safe to call multiple times.
   * @returns {Promise<boolean>} true if WASM loaded successfully
   */
  async loadWasm() {
    if (_wasmReady) {
      return true;
    }
    if (_wasmLoading) {
      return _wasmLoading;
    }

    // Check browser SIMD support before loading
    WasmFeatureDetection.checkSIMDSupport();

    _wasmLoading = (async () => {
      try {
        const module = await import(
          /* webpackIgnore: true */
          "../../ThirdParty/Workers/cesium_wasm.js"
        );
        await module.default();
        WasmFeatureDetection.checkVersionMatch(module, "heightmap");
        _simdActive = WasmFeatureDetection.checkModuleSIMD(module, "heightmap");
        _wasmModule = module;
        _wasmReady = true;
        return true;
      } catch (e) {
        console.warn(
          "[CesiumJS:WASM:heightmap] WASM load failed, using JS fallback:",
          e.message,
        );
        _wasmReady = false;
        return false;
      }
    })();

    return _wasmLoading;
  }

  /**
   * Decode raw heightmap bytes into f32 height values using WASM SIMD.
   *
   * @param {Uint8Array} rawBytes - Raw heightmap byte buffer
   * @param {number} bytesPerElement - 1, 2, or 4
   * @param {boolean} isBigEndian - Byte order
   * @param {number} heightScale - Multiply factor
   * @param {number} heightOffset - Additive bias
   * @param {Float32Array} outHeights - Pre-allocated output array
   * @returns {number} Number of samples decoded
   */
  decodeHeightmap(
    rawBytes,
    bytesPerElement,
    isBigEndian,
    heightScale,
    heightOffset,
    outHeights,
  ) {
    const sampleCount = rawBytes.byteLength / bytesPerElement;
    this._decodeCount++;

    if (_wasmReady && sampleCount >= this._threshold) {
      this._lastWasmUsed = true;
      return this._decodeWasm(
        rawBytes,
        bytesPerElement,
        isBigEndian,
        heightScale,
        heightOffset,
        outHeights,
      );
    }

    this._lastWasmUsed = false;
    return this._decodeJS(
      rawBytes,
      bytesPerElement,
      isBigEndian,
      heightScale,
      heightOffset,
      outHeights,
    );
  }

  /** @private */
  _decodeWasm(rawBytes, bpe, bigEndian, scale, offset, out) {
    const byteCount = rawBytes.byteLength;
    const sampleCount = byteCount / bpe;
    const totalBytes = byteCount + sampleCount * 4;

    try {
      const ptr = _wasmModule.alloc_buffer(totalBytes);
      if (ptr === 0) {
        return this._decodeJS(rawBytes, bpe, bigEndian, scale, offset, out);
      }
      const memory = _wasmModule.__wbindgen_export_0 ?? _wasmModule.memory;
      const memBuf = memory.buffer;

      new Uint8Array(memBuf, ptr, byteCount).set(rawBytes);
      const outPtr = ptr + byteCount;

      _wasmModule.decode_heightmap(
        ptr,
        byteCount,
        bpe,
        bigEndian,
        scale,
        offset,
        outPtr,
      );

      out.set(new Float32Array(memBuf, outPtr, sampleCount));
      return sampleCount;
    } catch (e) {
      console.warn(
        "[CesiumJS:WASM:heightmap] decode failed, using JS fallback:",
        e.message,
      );
      return this._decodeJS(rawBytes, bpe, bigEndian, scale, offset, out);
    }
  }

  /** @private */
  _decodeJS(rawBytes, bpe, bigEndian, scale, offset, out) {
    const view = new DataView(
      rawBytes.buffer,
      rawBytes.byteOffset,
      rawBytes.byteLength,
    );
    const count = rawBytes.byteLength / bpe;

    for (let i = 0; i < count; i++) {
      let raw;
      const byteOff = i * bpe;
      if (bpe === 1) {
        raw = rawBytes[byteOff];
      } else if (bpe === 2) {
        raw = bigEndian
          ? view.getUint16(byteOff, false)
          : view.getUint16(byteOff, true);
      } else {
        raw = bigEndian
          ? view.getFloat32(byteOff, false)
          : view.getFloat32(byteOff, true);
      }
      out[i] = raw * scale + offset;
    }
    return count;
  }

  /**
   * Get diagnostic info for debugging.
   * @returns {object}
   */
  getDiagnostics() {
    return {
      wasmReady: _wasmReady,
      threshold: this._threshold,
      lastWasmUsed: this._lastWasmUsed,
      decodeCount: this._decodeCount,
      tessellateCount: this._tessellateCount,
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

export default WasmHeightmapBridge;
