#!/usr/bin/env node
/**
 * WASM batch RTE encode CPU micro-benchmark (NEW-BUFFERCOLL-ENCODE-BENCHMARK).
 * @purpose Node CPU micro-benchmark of the WASM batch_rte_encode kernel vs the scalar JS fround twin, with byte-identity and fallback trip-wire asserts.
 * @status ACTIVE
 *
 * Measures the *CPU encode cost only* of the BufferPoint repack's POSITION
 * high/low split: the scalar JS fround loop (`WasmRTEBridge._encodeRangeJS`,
 * the byte-identical twin of the per-primitive `EncodedCartesian3` loop in the
 * real hot paths) vs the WASM `batch_rte_encode` kernel (`_encodeRangeWasm`),
 * at 10k / 50k / 100k positions.
 *
 * WHY a Node micro-benchmark for the WASM half: the bundled build cannot load
 * the WASM glue today (the dynamic import 404s for every Wasm*Bridge —
 * NEW-WASM-BRIDGE-BUNDLE-LOAD), so a Playwright probe that drives the real
 * BufferPointCollection through the browser measures JS-fallback-vs-JS-fallback
 * for the "WASM" path — it CANNOT compare the genuine SIMD kernel. The only
 * place the real kernel runs is under raw Node via the same loader+fetch-shim
 * harness `wasm-subrange-encode-check.mjs` already uses. So:
 *
 *   - This Node benchmark isolates the CPU encode (real kernel vs real scalar).
 *   - The Playwright probe (probe-buffercoll-encode-benchmark.mjs) measures the
 *     end-to-end repack+writeBuffer cost in the browser (where the GPU upload
 *     may dominate) and proves no visual regression — but its "batch" path is
 *     the JS fround twin, not WASM, until the bundle-load blocker is fixed.
 *
 * Reading the two together gives an honest picture: if WASM does not beat
 * scalar on CPU encode here, OR the upload dominates in the browser probe, the
 * threshold stays at its conservative default (or Infinity) and we say so.
 *
 * The benchmark also asserts byte-identity (WASM output == scalar output) at
 * every count, so the timing comparison is apples-to-apples on the SAME encode,
 * and a trip-wire fails if the bridge silently fell back to JS (which would make
 * the "WASM" column a second scalar measurement).
 *
 * Usage:  node Tools/wasm-encode-benchmark.mjs [--counts 10000,50000,100000] [--iters auto] [--json]
 * Exit:   0 = ran clean, 1 = a correctness assertion or the fallback trip-wire failed.
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

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const jsonOut = argv.includes("--json");
function argVal(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}
const COUNTS = argVal("--counts", "10000,50000,100000")
  .split(",")
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0);

let failures = 0;
function assert(name, cond, detail) {
  if (!cond) {
    failures++;
    console.error(`  ASSERT-FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Reuse the subrange-check fetch shim verbatim so the glue's fetch(URL) resolves
// the on-disk .wasm bytes under Node (file:// fetch is unsupported by undici).
function installWasmFetchShim(wasmBytes) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" ? input : (input?.href ?? String(input));
    if (url.includes("cesium_wasm_bg.wasm")) {
      return new Response(wasmBytes, {
        headers: { "Content-Type": "application/wasm" },
      });
    }
    if (realFetch) {
      return realFetch(input);
    }
    throw new Error(`Unexpected fetch in benchmark: ${url}`);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** Deterministic ECEF-scale positions with sub-meter fractions (stresses the split). */
function makePositions(n) {
  const a = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = -6378137.123456789 + i * 12.3456789;
    a[i * 3 + 1] = 1234567.987654321 - i * 9.87654321;
    a[i * 3 + 2] = (i % 2 === 0 ? 1 : -1) * (5500000.25 + i * 0.0625);
  }
  return a;
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

/** Median of an array of numbers. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Time `fn` over `reps` reps, return median ms per rep. Warms up first so the
 * JIT has compiled both the JS loop and the WASM-call wrapper before measuring.
 */
function timeFn(fn, reps, warmup) {
  for (let i = 0; i < warmup; i++) {
    fn();
  }
  const samples = new Array(reps);
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    samples[i] = performance.now() - t0;
  }
  return { median: median(samples), min: Math.min(...samples) };
}

async function main() {
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
  assert("WASM module loaded", ok === true && bridge.wasmReady === true);
  if (!bridge.wasmReady) {
    console.error(
      "WASM did not load — run `npm run build-wasm` first. Cannot benchmark the real kernel.",
    );
    restoreFetch();
    process.exit(1);
  }

  // Trip-wire: a silent WASM->JS fallback makes the "WASM" column a second
  // scalar measurement. Fail loudly if it fires during a WASM-path timing.
  const realWarn = console.warn.bind(console);
  let sawFallbackWarn = false;
  console.warn = (...args) => {
    if (args.join(" ").includes("using JS fallback")) {
      sawFallbackWarn = true;
    }
    realWarn(...args);
  };

  const node = process.version;
  const rows = [];

  for (const count of COUNTS) {
    const positions = makePositions(count);
    const total = count * 3;
    const wasmHigh = new Float32Array(total);
    const wasmLow = new Float32Array(total);
    const jsHigh = new Float32Array(total);
    const jsLow = new Float32Array(total);

    // Byte-identity: same encode on both paths, so timing is apples-to-apples.
    bridge.threshold = 1; // WASM
    bridge.batchEncodeRange(positions, 0, count, wasmHigh, wasmLow, 0);
    assert(`${count}: WASM path used`, bridge._lastWasmUsed === true);
    bridge.threshold = 1e9; // JS
    bridge.batchEncodeRange(positions, 0, count, jsHigh, jsLow, 0);
    assert(`${count}: JS path used`, bridge._lastWasmUsed === false);
    assert(
      `${count}: WASM high == JS high (byte-identical)`,
      f32BytesEqual(wasmHigh, jsHigh),
    );
    assert(
      `${count}: WASM low == JS low (byte-identical)`,
      f32BytesEqual(wasmLow, jsLow),
    );

    // Scale reps inversely with count so each measurement does similar total
    // work (keeps tiny per-rep times out of the timer-resolution noise floor).
    const reps = Math.max(15, Math.round(3_000_000 / count));
    const warmup = Math.max(5, reps >> 2);

    bridge.threshold = 1e9; // force JS for the scalar timing
    const scalar = timeFn(
      () => bridge.batchEncodeRange(positions, 0, count, jsHigh, jsLow, 0),
      reps,
      warmup,
    );

    bridge.threshold = 1; // force WASM for the kernel timing
    const wasm = timeFn(
      () => bridge.batchEncodeRange(positions, 0, count, wasmHigh, wasmLow, 0),
      reps,
      warmup,
    );

    const speedup = scalar.median / wasm.median;
    rows.push({
      count,
      reps,
      scalarMs: scalar.median,
      wasmMs: wasm.median,
      speedup,
    });
  }

  assert(
    "no silent WASM->JS fallback during timing",
    sawFallbackWarn === false,
    "a 'using JS fallback' warning fired — the WASM column is not the real kernel",
  );
  console.warn = realWarn;

  // ---- report --------------------------------------------------------------
  if (jsonOut) {
    console.log(JSON.stringify({ node, rows, failures }, null, 2));
  } else {
    console.log("");
    console.log(
      `WASM batch RTE encode CPU micro-benchmark (real kernel, ${node})`,
    );
    console.log("  count      reps   scalar(ms)   wasm(ms)   speedup   winner");
    for (const r of rows) {
      const winner =
        r.speedup > 1.05 ? "WASM" : r.speedup < 0.95 ? "scalar" : "tie";
      console.log(
        `  ${String(r.count).padStart(8)}  ${String(r.reps).padStart(5)}   ` +
          `${r.scalarMs.toFixed(4).padStart(9)}   ${r.wasmMs
            .toFixed(4)
            .padStart(8)}   ${r.speedup.toFixed(2).padStart(6)}x   ${winner}`,
      );
    }
    console.log("");
    console.log(
      "  Note: CPU encode only (no GPU upload). The browser repack also pays a",
    );
    console.log(
      "  writeBuffer/copyAttributeFromRange upload that often dominates — see",
    );
    console.log(
      "  probe-buffercoll-encode-benchmark.mjs for the end-to-end ms/frame.",
    );
  }

  bridge.destroy();
  restoreFetch();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Benchmark threw:", e);
  process.exit(1);
});
