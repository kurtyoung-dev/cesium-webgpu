#!/usr/bin/env node
// Probe (NEW-WASM-BRIDGE-BUNDLE-LOAD) — proves the WASM kernel ACTUALLY LOADS
// and EXECUTES in the real bundled build for ALL SEVEN Wasm*Bridge files, with
// NO silent JS fallback.
//
// Background: in the bundled build the dynamic import of the wasm-bindgen glue
// (ThirdParty/Workers/cesium_wasm.js) used to 404 — two failure shapes:
//   (a) the 5 bridges that kept "../../ThirdParty/Workers/cesium_wasm.js"
//       external resolved `../../` to /Build/ThirdParty (glue 404), and
//   (b) the 2 bridges (Cull/Sort) that imported a bare "../ThirdParty/..." got
//       the glue INLINED, whose `new URL("cesium_wasm_bg.wasm", import.meta.url)`
//       then resolved to the bundle root (binary 404).
// Either way the kernel never ran and every bridge silently used its
// byte-identical JS twin. Batch 274 routes all 7 through a shared
// buildModuleUrl-backed resolver (resolveWasmGlueUrl.js) so the glue loads from
// /Build/<variant>/ThirdParty/Workers/ in EVERY format and the glue's sibling
// .wasm URL is also correct.
//
// What this probe asserts (against the REAL bundle, in a real browser):
//   1. For each of the 7 bridges: loadWasm() resolves true AND wasmReady===true.
//   2. ZERO network 404s for any cesium_wasm* request (glue + binary loaded).
//   3. The RTE kernel GENUINELY EXECUTES (no fallback): batchEncodeRange on the
//      WASM path (threshold=1) is byte-identical to the JS path (threshold huge)
//      AND _lastWasmUsed===true AND no "using JS fallback" warning fired. RTE is
//      representative — all 7 bridges share the SAME glue + binary, so if RTE's
//      kernel executes, the shared module loaded for the whole set.
//   4. 0 rendering console errors.
//
// This is a build-system change, so the probe loads the EMITTED bundle (not
// source) — it is the browser counterpart of the node-only
// Tools/wasm-subrange-encode-check.mjs.
//
// Usage: node Tools/visual-regression/probe-wasm-bundle-load.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
// `--iife` exercises the IIFE bundle (Build/Cesium/Cesium.js) instead of the
// ESM bundle. The IIFE path differs: `import.meta` is shimmed, so the glue URL
// must come from buildModuleUrl's getBaseUrlFromCesiumScript() / CESIUM_BASE_URL
// branch — exactly the cross-format case the resolver has to get right.
const IIFE_MODE = process.argv.includes("--iife");

const BRIDGES = [
  "WasmRTEBridge",
  "WasmCullBridge",
  "WasmSortBridge",
  "WasmMatrixBridge",
  "WasmQuantizedMeshBridge",
  "WasmPointCloudBridge",
  "WasmHeightmapBridge",
];

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

const consoleErrors = [];
const fallbackWarns = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") consoleErrors.push(t);
  if (t.includes("using JS fallback")) fallbackWarns.push(t);
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

// Track every cesium_wasm* request + its HTTP status so a 404 on the glue or
// the binary is caught even if the bridge swallows it into a JS fallback.
const wasmRequests = [];
page.on("response", (resp) => {
  const url = resp.url();
  if (/cesium_wasm/.test(url)) {
    wasmRequests.push({ url, status: resp.status() });
  }
});
page.on("requestfailed", (req) => {
  const url = req.url();
  if (/cesium_wasm/.test(url)) {
    wasmRequests.push({ url, status: "FAILED", error: req.failure()?.errorText });
  }
});

// In IIFE mode, generate an ephemeral HTML page (served by the dev server)
// that loads Build/Cesium/Cesium.js as a classic <script> + sets
// CESIUM_BASE_URL so buildModuleUrl resolves the glue relative to the bundle
// dir. We expose the loaded global as `window.__Cesium` for the evaluate step.
let tempHtmlPath = null;
if (IIFE_MODE) {
  const baseUrl = "/Build/Cesium/";
  const html = `<!doctype html><html><head><meta charset="utf-8" />
<script>
  window.CESIUM_BASE_URL = new URL(${JSON.stringify(baseUrl)}, window.location.href).href;
</script>
<script src="${baseUrl}Cesium.js"></script>
<script>window.__Cesium = window.Cesium;</script>
</head><body></body></html>`;
  tempHtmlPath = path.resolve("Tools/visual-regression/__wasm-iife-probe.html");
  fs.writeFileSync(tempHtmlPath, html);
  await page.goto(`${BASE}/Tools/visual-regression/__wasm-iife-probe.html`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.__Cesium);
} else {
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
}

const result = await page.evaluate(async ({ BRIDGES, IIFE_MODE }) => {
  const C = IIFE_MODE
    ? window.__Cesium
    : await import("/Build/CesiumUnminified/index.js");

  const out = { perBridge: {}, rte: null, missingExports: [] };

  // ---- (1) Every bridge loads its WASM module --------------------------
  for (const name of BRIDGES) {
    const Ctor = C[name];
    if (typeof Ctor !== "function") {
      out.missingExports.push(name);
      continue;
    }
    const bridge = new Ctor();
    let loaded = false;
    let err = null;
    try {
      loaded = await bridge.loadWasm();
    } catch (e) {
      err = String(e && e.message ? e.message : e);
    }
    out.perBridge[name] = {
      loadResolvedTrue: loaded === true,
      wasmReady: bridge.wasmReady === true,
      error: err,
    };
  }

  // ---- (3) RTE kernel genuinely executes (byte-identity + no fallback) --
  const RTE = C.WasmRTEBridge;
  if (typeof RTE === "function") {
    const bridge = new RTE();
    const ok = await bridge.loadWasm();

    // Deterministic ECEF-scale positions that stress the high/low split.
    const N = 256;
    const positions = new Float64Array(N * 3);
    for (let i = 0; i < N; i++) {
      positions[i * 3] = -6378137.123456789 + i * 12345.6789;
      positions[i * 3 + 1] = 1234567.987654321 - i * 9876.54321;
      positions[i * 3 + 2] = (i % 2 === 0 ? 1 : -1) * (8888888.25 + i * 333.0625);
    }
    const srcOffset = 37;
    const count = 100;
    const dstOffset = 0;
    const len = count * 3;

    const wasmHigh = new Float32Array(len);
    const wasmLow = new Float32Array(len);
    const jsHigh = new Float32Array(len);
    const jsLow = new Float32Array(len);

    bridge.threshold = 1; // force WASM path
    bridge.batchEncodeRange(positions, srcOffset, count, wasmHigh, wasmLow, dstOffset);
    const wasmPathUsed = bridge._lastWasmUsed === true;

    bridge.threshold = 1e9; // force JS path
    bridge.batchEncodeRange(positions, srcOffset, count, jsHigh, jsLow, dstOffset);
    const jsPathUsed = bridge._lastWasmUsed === false;

    // Byte-level identity over the f32 outputs.
    const ua = new Uint8Array(wasmHigh.buffer);
    const ub = new Uint8Array(jsHigh.buffer);
    const la = new Uint8Array(wasmLow.buffer);
    const lb = new Uint8Array(jsLow.buffer);
    let highEqual = ua.length === ub.length;
    for (let i = 0; highEqual && i < ua.length; i++) if (ua[i] !== ub[i]) highEqual = false;
    let lowEqual = la.length === lb.length;
    for (let i = 0; lowEqual && i < la.length; i++) if (la[i] !== lb[i]) lowEqual = false;

    // Q16 (WASM-BRIDGE-BUNDLE-LOAD) off-gate: not merely "the kernel loaded"
    // but "the SIMD kernel actually loads" — assert the module was compiled with
    // SIMD AND the browser supports it, so the SIMD lane (not just a scalar wasm
    // build) is live. simdActive === (module.has_simd() && browser SIMD support).
    const diag = bridge.getDiagnostics();

    out.rte = {
      loaded: ok === true,
      wasmReady: bridge.wasmReady === true,
      wasmPathUsed,
      jsPathUsed,
      highEqual,
      lowEqual,
      simdActive: diag.simdActive === true,
    };
  }

  return out;
}, { BRIDGES, IIFE_MODE });

console.log(
  `\n=== NEW-WASM-BRIDGE-BUNDLE-LOAD probe (${IIFE_MODE ? "IIFE Build/Cesium" : "ESM Build/CesiumUnminified"}) ===\n`,
);

check(
  "all 7 bridges are exported from the bundle",
  result.missingExports.length === 0,
  `missing: ${result.missingExports.join(", ")}`,
);

for (const name of BRIDGES) {
  const r = result.perBridge[name];
  if (!r) continue;
  check(
    `${name}: loadWasm() resolved true`,
    r.loadResolvedTrue,
    r.error ? `error: ${r.error}` : "loadWasm returned false (glue/binary did not load)",
  );
  check(`${name}: wasmReady === true`, r.wasmReady);
}

// (2) network: no 404 / failure for any cesium_wasm* request, and the glue +
// binary were actually requested.
const wasmBad = wasmRequests.filter(
  (r) => r.status === 404 || r.status === "FAILED",
);
check(
  "0 cesium_wasm* 404s / failed requests",
  wasmBad.length === 0,
  wasmBad.map((r) => `${r.status} ${r.url}`).join(" | "),
);
const sawGlue = wasmRequests.some((r) => /cesium_wasm\.js(\?|$)/.test(r.url));
const sawBinary = wasmRequests.some((r) => /cesium_wasm_bg\.wasm(\?|$)/.test(r.url));
check("glue module (cesium_wasm.js) was fetched OK", sawGlue);
check("binary (cesium_wasm_bg.wasm) was fetched OK", sawBinary);

// (3) RTE kernel executed with no silent fallback.
if (result.rte) {
  const r = result.rte;
  check("RTE: loadWasm() resolved true", r.loaded);
  check("RTE: wasmReady === true", r.wasmReady);
  check("RTE: WASM path actually used (_lastWasmUsed)", r.wasmPathUsed);
  check("RTE: JS path actually used for the twin", r.jsPathUsed);
  check("RTE: WASM high == JS high (byte-identical)", r.highEqual);
  check("RTE: WASM low == JS low (byte-identical)", r.lowEqual);
  check(
    "RTE: SIMD kernel actually loaded (simdActive)",
    r.simdActive,
    "module.has_simd() && browser SIMD support — SIMD lane is not live",
  );
} else {
  check("RTE kernel executed", false, "RTE bridge not exported");
}

check(
  "no 'using JS fallback' warning fired (no silent fallback)",
  fallbackWarns.length === 0,
  fallbackWarns.join(" | "),
);

check(
  "0 rendering console errors",
  consoleErrors.length === 0,
  consoleErrors.slice(0, 5).join(" | "),
);

console.log("\n--- cesium_wasm* network requests ---");
for (const r of wasmRequests) {
  console.log(`  ${r.status}  ${r.url}`);
}

await browser.close();
if (tempHtmlPath) {
  try {
    fs.unlinkSync(tempHtmlPath);
  } catch {
    /* best effort */
  }
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
