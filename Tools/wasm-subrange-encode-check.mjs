#!/usr/bin/env node
/**
 * WASM Sub-Range RTE Encode Check (NEW-WASMRTE-SUBRANGE-ENCODE)
 * @purpose Standalone Node check that WasmRTEBridge.batchEncodeRange's WASM and JS paths are byte-identical, placement exact, outside bytes preserved.
 * @status ACTIVE
 *
 * Standalone node unit check for WasmRTEBridge.batchEncodeRange — the
 * sub-range variant of batchEncode that encodes a contiguous
 * [srcOffset, srcOffset+count) slice of f64 positions into a
 * [dstOffset, ..) window of the high/low f32 output arrays in place.
 *
 * What it proves:
 *   1. The WASM path and the scalar JS fallback produce BYTE-IDENTICAL
 *      high/low output for the same sub-range (fround split is exact vs
 *      the wasm32 batch_rte_encode kernel — both round-to-nearest f32).
 *   2. The dst-offset placement is correct: the encoded slice lands at
 *      [dstOffset*3, (dstOffset+count)*3) and nowhere else.
 *   3. Bytes OUTSIDE the written window are preserved (sentinel-filled
 *      before the call, asserted unchanged after).
 *   4. batchEncodeRange over the FULL array equals batchEncode over the
 *      whole array (semantic equivalence of the sub-range generalization).
 *
 * Implementation note: the sub-range is JS-side pointer arithmetic over
 * the EXISTING batch_rte_encode kernel (offset the input copy + output
 * read-back). NO new Rust export was added — see WasmRTEBridge.js.
 *
 * The real bridge is driven end-to-end: loadWasm() is made to work under
 * node by shimming globalThis.fetch to return the on-disk wasm bytes, so
 * the actual _encodeRangeWasm pointer math is exercised (not a re-impl).
 *
 * Usage:  node Tools/wasm-subrange-encode-check.mjs
 * Exit:   0 = pass, 1 = fail.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const bridgePath = path.join(
  repoRoot,
  "packages",
  "engine",
  "Source",
  "Scene",
  "WasmRTEBridge.js",
);
const wasmBinPath = path.join(
  repoRoot,
  "packages",
  "engine",
  "Source",
  "ThirdParty",
  "Workers",
  "cesium_wasm_bg.wasm",
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Shim globalThis.fetch so the wasm-bindgen glue's `fetch(URL)` resolves
 * the .wasm bytes from disk. Returns a minimal Response-like object that
 * the glue's __wbg_load path accepts (it checks `instanceof Response`,
 * which fails here, so it falls through to `await module.arrayBuffer()`).
 *
 * Node 20 ships a global Response/fetch (undici); fetching file:// is not
 * supported, hence the shim. We only intercept the cesium wasm URL.
 */
function installWasmFetchShim(wasmBytes) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" ? input : (input?.href ?? String(input));
    if (url.includes("cesium_wasm_bg.wasm")) {
      // Plain object (NOT a real Response) so the glue's
      // `module instanceof Response` check is false and it takes the
      // `WebAssembly.instantiate(module, imports)` branch on the
      // resolved value... but __wbg_load awaits the module first, so we
      // must resolve to something whose arrayBuffer() yields the bytes.
      // Returning a real Response built from the bytes is simplest.
      return new Response(wasmBytes, {
        headers: { "Content-Type": "application/wasm" },
      });
    }
    if (realFetch) {
      return realFetch(input);
    }
    throw new Error(`Unexpected fetch in unit check: ${url}`);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** Deterministic spread of f64 positions covering +/-, large, and fractional. */
function makePositions(n) {
  const a = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    // ECEF-scale magnitudes with sub-meter fraction to stress the split.
    a[i * 3] = -6378137.123456789 + i * 12345.6789;
    a[i * 3 + 1] = 1234567.987654321 - i * 9876.54321;
    a[i * 3 + 2] = (i % 2 === 0 ? 1 : -1) * (8888888.25 + i * 333.0625);
  }
  return a;
}

function froundEncode(positions, srcOffset, count, outHigh, outLow, dstOffset) {
  const total = count * 3;
  const s3 = srcOffset * 3;
  const d3 = dstOffset * 3;
  for (let i = 0; i < total; i++) {
    const v = positions[s3 + i];
    const high = Math.fround(v);
    outHigh[d3 + i] = high;
    outLow[d3 + i] = Math.fround(v - high);
  }
}

function f32BytesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) {
      return false;
    }
  }
  return true;
}

async function main() {
  // Redirect the bridge's build-layout-relative wasm glue import to the
  // canonical glue so the REAL bridge runs under raw node.
  register(
    "./wasm-subrange-loader.mjs",
    pathToFileURL(__dirname + path.sep).href,
  );

  const wasmBytes = await readFile(wasmBinPath);
  const restoreFetch = installWasmFetchShim(wasmBytes);

  const { default: WasmRTEBridge } = await import(
    pathToFileURL(bridgePath).href
  );

  const bridge = new WasmRTEBridge();
  const ok = await bridge.loadWasm();
  check("WASM module loaded (loadWasm resolved true)", ok === true);
  check("bridge reports wasmReady", bridge.wasmReady === true);

  if (!bridge.wasmReady) {
    console.error(
      "WASM did not load — cannot validate WASM vs JS byte-identity. Run `npm run build-wasm` first.",
    );
    restoreFetch();
    process.exit(1);
  }

  // Trip-wire: the bridge's WASM path catches internal failures and silently
  // falls back to JS (logging a "using JS fallback" warning). If that fires
  // during a "WASM path" test, byte-identity is JS-vs-JS and proves nothing.
  // Fail loudly instead.
  const realWarn = console.warn.bind(console);
  let sawFallbackWarn = false;
  console.warn = (...args) => {
    const msg = args.join(" ");
    if (msg.includes("using JS fallback")) {
      sawFallbackWarn = true;
    }
    realWarn(...args);
  };

  // Force the WASM path for the range tests regardless of slice size.
  bridge.threshold = 1;

  const N = 256;
  const positions = makePositions(N);

  // ---- Test 1: WASM vs JS byte-identity over an interior sub-range -------
  {
    const srcOffset = 37;
    const count = 100;
    const dstOffset = 200;
    const len = (dstOffset + count) * 3;

    const SENT_H = 7.5;
    const SENT_L = -3.25;
    const wasmHigh = new Float32Array(len).fill(SENT_H);
    const wasmLow = new Float32Array(len).fill(SENT_L);
    const jsHigh = new Float32Array(len).fill(SENT_H);
    const jsLow = new Float32Array(len).fill(SENT_L);

    bridge.threshold = 1; // WASM path
    bridge.batchEncodeRange(
      positions,
      srcOffset,
      count,
      wasmHigh,
      wasmLow,
      dstOffset,
    );
    check("Test1: WASM path actually used", bridge._lastWasmUsed === true);

    bridge.threshold = 1e9; // JS path
    bridge.batchEncodeRange(
      positions,
      srcOffset,
      count,
      jsHigh,
      jsLow,
      dstOffset,
    );
    check("Test1: JS path actually used", bridge._lastWasmUsed === false);

    check(
      "Test1: WASM high == JS high (byte-identical)",
      f32BytesEqual(wasmHigh, jsHigh),
    );
    check(
      "Test1: WASM low == JS low (byte-identical)",
      f32BytesEqual(wasmLow, jsLow),
    );

    // Reference fround encode for absolute correctness, not just self-agreement.
    const refHigh = new Float32Array(len).fill(SENT_H);
    const refLow = new Float32Array(len).fill(SENT_L);
    froundEncode(positions, srcOffset, count, refHigh, refLow, dstOffset);
    check(
      "Test1: WASM high == reference fround high",
      f32BytesEqual(wasmHigh, refHigh),
    );
    check(
      "Test1: WASM low == reference fround low",
      f32BytesEqual(wasmLow, refLow),
    );

    // dst-offset placement: encoded window is exactly [d3, d3+count*3).
    const d3 = dstOffset * 3;
    const total = count * 3;
    let placedCorrectly = true;
    for (let i = 0; i < total; i++) {
      const v = positions[srcOffset * 3 + i];
      const high = Math.fround(v);
      if (
        wasmHigh[d3 + i] !== high ||
        wasmLow[d3 + i] !== Math.fround(v - high)
      ) {
        placedCorrectly = false;
        break;
      }
    }
    check("Test1: encoded slice placed at dstOffset window", placedCorrectly);

    // Untouched bytes preserved everywhere outside [d3, d3+total).
    let preserved = true;
    for (let i = 0; i < len; i++) {
      if (i >= d3 && i < d3 + total) {
        continue;
      }
      if (wasmHigh[i] !== SENT_H || wasmLow[i] !== SENT_L) {
        preserved = false;
        break;
      }
    }
    check("Test1: bytes outside dst window preserved (WASM)", preserved);
  }

  // ---- Test 2: srcOffset != dstOffset, both nonzero, small slice ---------
  {
    const srcOffset = 5;
    const count = 3; // small slice still works on WASM path (threshold=1)
    const dstOffset = 0;
    const len = N * 3;

    const wasmHigh = new Float32Array(len).fill(42);
    const wasmLow = new Float32Array(len).fill(-42);
    const jsHigh = new Float32Array(len).fill(42);
    const jsLow = new Float32Array(len).fill(-42);

    bridge.threshold = 1;
    bridge.batchEncodeRange(
      positions,
      srcOffset,
      count,
      wasmHigh,
      wasmLow,
      dstOffset,
    );
    bridge.threshold = 1e9;
    bridge.batchEncodeRange(
      positions,
      srcOffset,
      count,
      jsHigh,
      jsLow,
      dstOffset,
    );

    check(
      "Test2: src!=dst small slice WASM==JS high",
      f32BytesEqual(wasmHigh, jsHigh),
    );
    check(
      "Test2: src!=dst small slice WASM==JS low",
      f32BytesEqual(wasmLow, jsLow),
    );

    // Source slice from index 5 must land at dst index 0.
    let correct = true;
    for (let i = 0; i < count * 3; i++) {
      const v = positions[srcOffset * 3 + i];
      if (wasmHigh[i] !== Math.fround(v)) {
        correct = false;
        break;
      }
    }
    check("Test2: src-offset slice relocated to dst index 0", correct);
  }

  // ---- Test 3: full-array range == whole-array batchEncode ---------------
  {
    const len = N * 3;
    const rangeHigh = new Float32Array(len);
    const rangeLow = new Float32Array(len);
    const wholeHigh = new Float32Array(len);
    const wholeLow = new Float32Array(len);

    bridge.threshold = 1;
    bridge.batchEncodeRange(positions, 0, N, rangeHigh, rangeLow, 0);
    bridge.batchEncode(positions, N, wholeHigh, wholeLow);

    check(
      "Test3: full-range batchEncodeRange high == batchEncode high",
      f32BytesEqual(rangeHigh, wholeHigh),
    );
    check(
      "Test3: full-range batchEncodeRange low == batchEncode low",
      f32BytesEqual(rangeLow, wholeLow),
    );
  }

  // ---- Test 4: default dstOffset === srcOffset --------------------------
  {
    const srcOffset = 64;
    const count = 32;
    const len = N * 3;
    const a = new Float32Array(len).fill(0);
    const b = new Float32Array(len).fill(0);
    const c = new Float32Array(len).fill(0);
    const d = new Float32Array(len).fill(0);

    bridge.threshold = 1;
    // omit dstOffset -> defaults to srcOffset
    bridge.batchEncodeRange(positions, srcOffset, count, a, b);
    bridge.batchEncodeRange(positions, srcOffset, count, c, d, srcOffset);

    check("Test4: default dstOffset==srcOffset high", f32BytesEqual(a, c));
    check("Test4: default dstOffset==srcOffset low", f32BytesEqual(b, d));
  }

  check(
    "No silent WASM->JS fallback occurred (kernel genuinely ran)",
    sawFallbackWarn === false,
    "a 'using JS fallback' warning fired — WASM path did not execute",
  );

  console.warn = realWarn;
  bridge.destroy();
  restoreFetch();

  console.log("");
  if (failures === 0) {
    console.log("ALL CHECKS PASSED");
    process.exit(0);
  } else {
    console.error(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unit check threw:", e);
  process.exit(1);
});
