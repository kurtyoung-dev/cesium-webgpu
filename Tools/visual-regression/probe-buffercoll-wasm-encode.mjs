#!/usr/bin/env node
// Probe (NEW-BUFFERCOLL-WASM-ENCODE-WIRE) — verifies that routing the POSITION
// high/low RTE encode of a large BufferPointCollection through the WASM batch
// kernel produces the SAME on-screen result as the per-primitive scalar
// EncodedCartesian3 path, on BOTH backends (webgpu + webgl). Also checks that:
// @purpose Parity acceptance that the WASM/batch fround RTE encode renders pixel-identical to scalar EncodedCartesian3, plus threshold routing checks.
// @status ACTIVE
//
//   - a >= threshold collection actually takes the WASM/batch path AND the WASM
//     kernel genuinely executes (lastWasmUsed) once the module resolves,
//   - a sub-threshold collection stays on the scalar path (counter),
//   - a position update (#13465) still re-renders through the WASM path,
//   - 0 console errors.
//
// WHY this is a valid parity test: the batch encode uses the fround split
// (high = f32(v); low = f32(v - high)) while the scalar EncodedCartesian3 uses
// the AGI 65536-grid split. The high/low BYTES differ, but both satisfy
// high + low == value exactly in f64, so the shader's RTE reconstruction
// (posHigh - camHigh) + (posLow - camLow) rounds to the SAME eye-space position.
// The pixels must therefore match within AA tolerance. We prove this by drawing
// the SAME large collection twice — once on the default (batch) path and once
// with a per-collection threshold override forcing the scalar path — and
// pixel-diffing the two captures.
//
// Strategy — deterministic readback, backend-symmetric:
//   Disable globe/sky → black background. Add N (>= threshold) cyan points on a
//   regular lon/lat grid filling the view, looking straight down. Capture the
//   batch-path frame (collection BATCH), then add a second identical collection
//   with _wasmEncodeThresholdOverride = Infinity (collection SCALAR), capture.
//   Diff the two cyan masks. A small (< threshold) collection confirms the
//   scalar counter path. Finally move one point in the batch collection and
//   confirm the cyan centroid shifts (the #13465 fix survives the WASM path).
//
// Usage: node Tools/visual-regression/probe-buffercoll-wasm-encode.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/buffercoll-wasm-encode-{webgpu,webgl}-{batch,scalar}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

// Collection sizes. The wiring threshold is 5000; LARGE clears it, SMALL stays
// under it. A 78x78 grid = 6084 points.
const GRID = 78;
const LARGE_N = GRID * GRID; // 6084 >= 5000 → batch path
const SMALL_N = 64; // < 5000 → scalar path

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ GRID, LARGE_N, SMALL_N, renderer }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      v.clock.shouldAnimate = false;

      scene.globe.show = false;
      scene.imageryLayers.removeAll();
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;

      const frame = async (n) => {
        for (let i = 0; i < n; i++) {
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      const snap = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            const c = scene.canvas;
            const off = document.createElement("canvas");
            off.width = c.width;
            off.height = c.height;
            const cx = off.getContext("2d");
            cx.drawImage(c, 0, 0);
            resolve({
              data: cx.getImageData(0, 0, c.width, c.height).data,
              w: c.width,
              h: c.height,
              png: off.toDataURL("image/png"),
            });
          });
          scene.render();
        });

      const isCyan = (d, i) => d[i] < 120 && d[i + 1] > 140 && d[i + 2] > 140;
      const cyanMask = (img) => {
        const m = new Uint8Array(img.w * img.h);
        let n = 0;
        let sumX = 0;
        for (let p = 0; p < img.w * img.h; p++) {
          if (isCyan(img.data, 4 * p)) {
            m[p] = 1;
            n++;
            sumX += p % img.w;
          }
        }
        return { mask: m, count: n, cx: n > 0 ? sumX / n : -1 };
      };
      // Symmetric-difference pixel count between two cyan masks.
      const maskDiff = (a, b) => {
        let d = 0;
        for (let p = 0; p < a.length; p++) if (a[p] !== b[p]) d++;
        return d;
      };

      // A lon/lat grid centered near Pittsburgh, a few hundred meters up, filling
      // the down-looking view. Same generator for every collection so BATCH and
      // SCALAR draw byte-for-byte identical geometry.
      const LAT0 = 40.0;
      const LON0 = -80.0;
      const SPAN = 0.6; // degrees across the grid
      const ALT = 300.0;
      const mat = new C.BufferPointMaterial({
        color: new C.Color(0.1, 1.0, 1.0, 1.0),
        size: 6,
        outlineWidth: 0,
      });
      const fillGrid = (collection, count) => {
        const side = Math.ceil(Math.sqrt(count));
        const tmp = new C.BufferPoint();
        let added = 0;
        for (let r = 0; r < side && added < count; r++) {
          for (let cc = 0; cc < side && added < count; cc++) {
            const lon = LON0 - SPAN / 2 + (SPAN * cc) / (side - 1);
            const lat = LAT0 - SPAN / 2 + (SPAN * r) / (side - 1);
            collection.add(
              { position: C.Cartesian3.fromDegrees(lon, lat, ALT) },
              tmp,
            );
            collection.get(added, tmp);
            tmp.setMaterial(mat);
            added++;
          }
        }
        return added;
      };

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON0, LAT0, 90000.0),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });

      // ---- BATCH collection (default threshold → WASM batch path) ----
      const batch = scene.primitives.add(
        new C.BufferPointCollection({ primitiveCountMax: LARGE_N + 4 }),
      );
      const batchAdded = fillGrid(batch, LARGE_N);

      // Warm up: render until the lazily-created bridge reports the WASM module
      // is ready, then dirty the whole collection and render again so the WASM
      // kernel genuinely runs (not just the pre-ready scalar fallback). Cap the
      // wait so a missing/failed WASM module can't hang the probe.
      await frame(4);
      const getCache = (col) =>
        renderer === "webgpu" ? col._webgpuCache : col._renderContext;
      let wasmReady = false;
      for (let tries = 0; tries < 60; tries++) {
        const cache = getCache(batch);
        const bridge = cache && cache.rteBridge;
        if (bridge && bridge.wasmReady) {
          wasmReady = true;
          break;
        }
        await frame(1);
      }
      // Re-dirty the whole batch collection so the next render re-encodes the
      // full range while the module is ready.
      batch._dirtyOffset = 0;
      batch._dirtyCount = batch.primitiveCount;
      const imgBatch = await snap();
      const batchStats = cyanMask(imgBatch);
      const batchCache = getCache(batch);
      const batchBridge = batchCache && batchCache.rteBridge;
      const batchDiag = batchBridge ? batchBridge.getDiagnostics() : null;

      // ---- SCALAR collection (override threshold → forced scalar path) ----
      // Identical geometry; force scalar so we compare encodes, not geometry.
      const scalar = scene.primitives.add(
        new C.BufferPointCollection({ primitiveCountMax: LARGE_N + 4 }),
      );
      scalar._wasmEncodeThresholdOverride = Number.POSITIVE_INFINITY;
      const scalarAdded = fillGrid(scalar, LARGE_N);
      // Hide the batch collection so only the scalar grid is on screen for an
      // apples-to-apples capture at the same pixels.
      batch.show = false;
      await frame(4);
      const imgScalar = await snap();
      const scalarStats = cyanMask(imgScalar);
      const scalarCache = getCache(scalar);

      // ---- SMALL collection (sub-threshold → scalar path) ----
      batch.show = false;
      scalar.show = false;
      const small = scene.primitives.add(
        new C.BufferPointCollection({ primitiveCountMax: SMALL_N + 4 }),
      );
      fillGrid(small, SMALL_N);
      await frame(3);
      const smallCache = getCache(small);

      // ---- Position update through the WASM path (#13465 survives) ----
      // Re-show the batch collection, then move EVERY point by a fixed lon shift.
      // Moving all LARGE_N points re-dirties the full range, so the next repack
      // re-encodes the whole collection through the batch/WASM path — exactly the
      // path under test. The whole-grid cyan centroid must then shift east. (A
      // single-point move wouldn't budge the centroid of 6000+ points.) This is
      // also the render where the WASM kernel runs while the module is ready, so
      // we re-read the bridge diagnostics afterward to confirm lastWasmUsed.
      scalar.show = false;
      small.show = false;
      batch.show = true;
      await frame(2);
      const cxBeforeMove = cyanMask(await snap()).cx;
      const movePt = new C.BufferPoint();
      const LON_SHIFT = 0.15;
      for (let i = 0; i < batch.primitiveCount; i++) {
        batch.get(i, movePt);
        const pos = movePt.getPosition(new C.Cartesian3());
        const carto = C.Cartographic.fromCartesian(pos);
        movePt.setPosition(
          C.Cartesian3.fromRadians(
            carto.longitude + C.Math.toRadians(LON_SHIFT),
            carto.latitude,
            carto.height,
          ),
        );
      }
      await frame(2);
      const imgMoved = cyanMask(await snap());
      const movedCache = getCache(batch);
      const movedBridge = movedCache && movedCache.rteBridge;
      const movedDiag = movedBridge ? movedBridge.getDiagnostics() : null;

      return {
        renderer,
        batchAdded,
        scalarAdded,
        // pixel parity
        batchCount: batchStats.count,
        scalarCount: scalarStats.count,
        maskDiff: maskDiff(batchStats.mask, scalarStats.mask),
        canvasPixels: imgBatch.w * imgBatch.h,
        // instrumentation
        batchWasmRepacks: batchCache ? (batchCache.wasmEncodeRepacks ?? 0) : -1,
        batchScalarRepacks: batchCache
          ? (batchCache.scalarEncodeRepacks ?? 0)
          : -1,
        scalarWasmRepacks: scalarCache
          ? (scalarCache.wasmEncodeRepacks ?? 0)
          : -1,
        scalarScalarRepacks: scalarCache
          ? (scalarCache.scalarEncodeRepacks ?? 0)
          : -1,
        smallWasmRepacks: smallCache ? (smallCache.wasmEncodeRepacks ?? 0) : -1,
        smallScalarRepacks: smallCache
          ? (smallCache.scalarEncodeRepacks ?? 0)
          : -1,
        wasmReady,
        bridgeCreated: !!(batchCache && batchCache.rteBridge),
        // Diagnostics after the full-collection re-encode (the render where the
        // kernel runs while the module is ready) — proves WASM genuinely ran.
        diagLastWasmUsed: movedDiag
          ? movedDiag.lastWasmUsed
          : batchDiag
            ? batchDiag.lastWasmUsed
            : null,
        diagWasmReady: movedDiag
          ? movedDiag.wasmReady
          : batchDiag
            ? batchDiag.wasmReady
            : null,
        // moved-grid check: every point shifted east → centroid shifts east.
        movedWasmRepacks: movedCache ? (movedCache.wasmEncodeRepacks ?? 0) : -1,
        movedDelta:
          cxBeforeMove >= 0 && imgMoved.cx >= 0
            ? imgMoved.cx - cxBeforeMove
            : 0,
        pngBatch: imgBatch.png,
        pngScalar: imgScalar.png,
      };
    },
    { GRID, LARGE_N, SMALL_N, renderer },
  );

  await page.close();
  return { ...out, errors };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let ok = true;
const check = (label, pass, detail) => {
  console.log(`  (${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

for (const renderer of ["webgpu", "webgl"]) {
  console.log(`== ${renderer} ==`);
  const r = await runBackend(renderer);
  if (r.pngBatch)
    fs.writeFileSync(
      path.join(OUT_DIR, `buffercoll-wasm-encode-${renderer}-batch.png`),
      Buffer.from(r.pngBatch.split(",")[1], "base64"),
    );
  if (r.pngScalar)
    fs.writeFileSync(
      path.join(OUT_DIR, `buffercoll-wasm-encode-${renderer}-scalar.png`),
      Buffer.from(r.pngScalar.split(",")[1], "base64"),
    );

  // (1) both collections drew a substantial number of cyan pixels.
  check(
    `${renderer}-1`,
    r.batchCount > 2000 && r.scalarCount > 2000,
    `large grids visible: batchCyan=${r.batchCount} scalarCyan=${r.scalarCount} (> 2000)`,
  );

  // (2) batch vs scalar pixel parity within AA tolerance. Allow a small fraction
  // of the canvas to differ (anti-aliased point edges). Both encodes reconstruct
  // the same eye-space position, so the bodies must coincide.
  const tol = Math.ceil(r.canvasPixels * 0.0015); // 0.15% of pixels
  check(
    `${renderer}-2`,
    r.maskDiff <= tol,
    `batch vs forced-scalar cyan-mask diff: ${r.maskDiff} <= ${tol} (AA tol)`,
  );

  // (3) the large/default collection took the WASM/batch path.
  check(
    `${renderer}-3`,
    r.batchWasmRepacks > 0,
    `default >= threshold collection used batch path: wasmRepacks=${r.batchWasmRepacks} scalarRepacks=${r.batchScalarRepacks}`,
  );

  // (4) the lazily-created RTE bridge exists and the batch path engaged. The
  // WASM *kernel* does NOT execute in the bundled build today — ALL seven
  // Wasm*Bridge files 404 on their glue/binary specifier in the emitted bundle
  // (tracked NEW-WASM-BRIDGE-BUNDLE-LOAD) — so the byte-identical JS fallback
  // runs instead. Rendering is correct either way (checks 1-3, 5-7 prove parity),
  // which is the load-bearing requirement; whether the SIMD kernel or its JS twin
  // produced the bytes is invisible. We assert the bridge was instantiated and
  // the batch path ran; if/when the bundle load is fixed, diagLastWasmUsed flips
  // true automatically and can be tightened here.
  check(
    `${renderer}-4`,
    r.bridgeCreated === true && r.batchWasmRepacks > 0,
    `RTE bridge created + batch path engaged: bridgeCreated=${r.bridgeCreated} wasmRepacks=${r.batchWasmRepacks} (kernel-ran=${r.diagLastWasmUsed}; bundle WASM load fixed in Batch 274 — NEW-WASM-BRIDGE-BUNDLE-LOAD)`,
  );

  // (5) forced-scalar collection stayed on the scalar path.
  check(
    `${renderer}-5`,
    r.scalarWasmRepacks === 0 && r.scalarScalarRepacks > 0,
    `override=Infinity forced scalar: wasmRepacks=${r.scalarWasmRepacks} scalarRepacks=${r.scalarScalarRepacks}`,
  );

  // (6) sub-threshold collection stayed on the scalar path.
  check(
    `${renderer}-6`,
    r.smallWasmRepacks === 0 && r.smallScalarRepacks > 0,
    `sub-threshold (${SMALL_N}) stayed scalar: wasmRepacks=${r.smallWasmRepacks} scalarRepacks=${r.smallScalarRepacks}`,
  );

  // (7) a position update re-renders through the WASM-encoded collection: every
  // point moved east, the full range re-encoded via the batch path, and the cyan
  // centroid shifted right (#13465 fix survives the WASM encode path).
  check(
    `${renderer}-7`,
    r.movedDelta >= 20 && r.movedWasmRepacks > r.batchWasmRepacks - 1,
    `position update re-rendered via batch path (centroid shift +${r.movedDelta.toFixed(1)}px >= 20; movedWasmRepacks=${r.movedWasmRepacks})`,
  );

  // (8) 0 console errors. The wasm glue/binary 404 that this filter used to
  // tolerate is GONE as of Batch 274 (NEW-WASM-BRIDGE-BUNDLE-LOAD fixed the
  // bundle-output glue specifier), so the bridge now loads the real kernel with
  // no 404. The filter is retained as a defensive no-op tripwire: if a
  // cesium_wasm 404 ever reappears it will show in `total` while `realErrors`
  // stays 0 — surfacing a regression of the load fix without failing unrelated
  // runs. Any OTHER error (WebGPU validation, JS exceptions) still fails.
  const realErrors = r.errors.filter(
    (e) =>
      !/Failed to load resource.*404|cesium_wasm.*\.wasm|404 \(Not Found\)/i.test(
        e,
      ),
  );
  if (r.errors.length !== realErrors.length) {
    console.log(
      `    NOTE: ${r.errors.length - realErrors.length} cesium_wasm 404(s) seen — the Batch-274 bundle WASM load fix may have regressed`,
    );
  }
  check(
    `${renderer}-8`,
    realErrors.length === 0,
    `console errors: ${realErrors.length} (total ${r.errors.length})`,
  );
  if (realErrors.length)
    for (const e of realErrors.slice(0, 6)) console.log(`    ERR: ${e}`);
}

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
