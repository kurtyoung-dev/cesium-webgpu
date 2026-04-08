/**
 * Shared utility for WASM feature detection and version checking.
 *
 * Provides SIMD support detection via WebAssembly.validate(),
 * version compatibility checking, and common WASM loading helpers.
 * All WASM bridges should use this module rather than implementing
 * detection logic independently.
 *
 * @private
 */

let _simdSupported = null;
let _wasmSupported = null;

/**
 * Expected WASM module version — must match `version()` from lib.rs.
 * Bump when the Rust WASM API changes.
 * - v1: initial frustum cull + radix sort
 * - v2: terrain/RTE/matrix/point-cloud additions
 * - v3: FORK-45 per-bridge arena slots (alloc_buffer_slot family)
 * @type {number}
 */
const EXPECTED_WASM_VERSION = 3;

/**
 * SIMD test bytes — a minimal valid WASM module using v128:
 * (module (func (result v128) v128.const i32x4 0 0 0 0))
 * @type {Uint8Array}
 * @private
 */
const SIMD_TEST_BYTES = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d, // magic: \0asm
  0x01,
  0x00,
  0x00,
  0x00, // version: 1
  0x01,
  0x05,
  0x01,
  0x60, // type section: 1 func type, () -> v128
  0x00,
  0x01,
  0x7b,
  0x03,
  0x02,
  0x01,
  0x00, // function section: 1 function, type 0
  0x0a,
  0x0a,
  0x01,
  0x08, // code section
  0x00,
  0x41,
  0x00,
  0xfd, // v128.const i32x4 0 0 0 0
  0x0f,
  0xfd,
  0x62,
  0x0b,
]);

/**
 * Check if WASM SIMD128 is supported in this browser.
 * Uses WebAssembly.validate() with a minimal SIMD module.
 * Result is cached after first call.
 *
 * @returns {boolean} True if SIMD128 is supported.
 */
function checkSIMDSupport() {
  if (_simdSupported !== null) {
    return _simdSupported;
  }

  try {
    _simdSupported =
      typeof WebAssembly !== "undefined" &&
      typeof WebAssembly.validate === "function" &&
      WebAssembly.validate(SIMD_TEST_BYTES);
  } catch (e) {
    _simdSupported = false;
  }

  return _simdSupported;
}

/**
 * Check if WebAssembly is supported at all.
 * Result is cached after first call.
 *
 * @returns {boolean} True if WebAssembly is available.
 */
function checkWasmSupport() {
  if (_wasmSupported !== null) {
    return _wasmSupported;
  }

  try {
    _wasmSupported =
      typeof WebAssembly !== "undefined" &&
      typeof WebAssembly.instantiate === "function";
  } catch (e) {
    _wasmSupported = false;
  }

  return _wasmSupported;
}

/**
 * Verify the loaded WASM module version matches what the JS bridges expect.
 * Logs a warning on mismatch but does NOT prevent usage — the module may
 * still be partially compatible.
 *
 * @param {object} wasmModule - The loaded WASM module with a version() export.
 * @param {string} bridgeName - Name of the calling bridge (for log messages).
 * @returns {boolean} True if versions match.
 */
function checkVersionMatch(wasmModule, bridgeName) {
  if (typeof wasmModule.version !== "function") {
    console.warn(
      `[CesiumJS:WASM:${bridgeName}] Module has no version() export — cannot verify compatibility.`,
    );
    return false;
  }

  const actual = wasmModule.version();
  if (actual !== EXPECTED_WASM_VERSION) {
    console.warn(
      `[CesiumJS:WASM:${bridgeName}] Version mismatch: expected ${EXPECTED_WASM_VERSION}, got ${actual}. ` +
        `Some features may not work correctly.`,
    );
    return false;
  }

  return true;
}

/**
 * Check WASM module SIMD support at runtime (calls has_simd() on the module).
 * This confirms the WASM binary was compiled with SIMD, complementing
 * the browser-side SIMD check from checkSIMDSupport().
 *
 * @param {object} wasmModule - The loaded WASM module.
 * @param {string} bridgeName - Name of the calling bridge.
 * @returns {boolean} True if module was compiled with SIMD.
 */
function checkModuleSIMD(wasmModule, bridgeName) {
  if (typeof wasmModule.has_simd !== "function") {
    return false;
  }

  const hasSIMD = wasmModule.has_simd();
  const browserSIMD = checkSIMDSupport();

  if (hasSIMD && !browserSIMD) {
    console.warn(
      `[CesiumJS:WASM:${bridgeName}] Module compiled with SIMD but browser does not support it. ` +
        `Falling back to JS.`,
    );
  }

  return hasSIMD && browserSIMD;
}

/**
 * Safe wrapper for calling free_buffer() on a WASM module.
 * Handles cases where the module may not have this export.
 *
 * @param {object} wasmModule - The WASM module instance.
 */
function freeBuffer(wasmModule) {
  if (wasmModule && typeof wasmModule.free_buffer === "function") {
    try {
      wasmModule.free_buffer();
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
}

const WasmFeatureDetection = {
  EXPECTED_WASM_VERSION,
  checkSIMDSupport,
  checkWasmSupport,
  checkVersionMatch,
  checkModuleSIMD,
  freeBuffer,
};

export default WasmFeatureDetection;
