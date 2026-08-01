#!/usr/bin/env node
// Probe (NEW-BUFFERCOLL-ENCODE-BENCHMARK) — end-to-end repack+upload benchmark
// for the BufferPointCollection POSITION encode, on BOTH backends (webgpu +
// webgl), at 10k / 50k / 100k points, PLUS a visual no-regression assertion
// (WebGPU vs WebGL point coverage parity) at each count (Principle 8).
//
// WHAT IT MEASURES: a full-collection position update is applied EVERY frame
// (every point nudged), forcing the whole collection through the repack path
// (position encode + writeBuffer / copyAttributeFromRange upload) on each frame.
// The repack+upload duration is recorded by a debug-pragma timer in both hot
// paths (WebGPUBufferPointRenderer.repackPointDirty+uploadPointBuffers /
// Scene/renderBufferPointCollection.js), exposed as cache `_repackMsTotal` /
// `_repackSamples`. We average over a settled window for the BATCH-encode path
// (default threshold) and the forced-SCALAR path (_wasmEncodeThresholdOverride =
// Infinity) and print a per-count, per-backend ms/frame table.
//
// HONEST CAVEAT (printed in the table): in the BUNDLED build the WASM kernel
// does NOT load (NEW-WASM-BRIDGE-BUNDLE-LOAD), so the "batch" path here is the
// JS fround twin, NOT the SIMD kernel. This probe therefore compares two CPU
// encode STRATEGIES (batch fround vs per-primitive AGI EncodedCartesian3) WITH
// the GPU upload in the picture — which is exactly what tells us whether the
// upload dominates. For the real-kernel scalar-vs-WASM CPU number, see the Node
// micro-benchmark Tools/wasm-encode-benchmark.mjs.
//
// Usage: node Tools/visual-regression/probe-buffercoll-encode-benchmark.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
//        PROBE_COUNTS (default 10000,50000,100000)
// Out:   Tools/visual-regression/output/buffercoll-encode-bench-{webgpu,webgl}-{count}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const COUNTS = (process.env.PROBE_COUNTS || "10000,50000,100000")
  .split(",")
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0);
// Crossover analysis: force the batch path on below the default 5000 threshold
// so the batch-vs-scalar strategy can be compared at any count. Default off
// (committed runs respect the real threshold).
const FORCE_BATCH = process.env.PROBE_FORCE_BATCH === "1";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// Run all counts for one backend in a single page (one viewer warmup).
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
    async ({ COUNTS, renderer, forceBatch }) => {
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
      const cyanCount = (img) => {
        let n = 0;
        for (let p = 0; p < img.w * img.h; p++) {
          if (isCyan(img.data, 4 * p)) n++;
        }
        return n;
      };

      const getCache = (col) =>
        renderer === "webgpu" ? col._webgpuCache : col._renderContext;

      const LAT0 = 40.0;
      const LON0 = -80.0;
      const SPAN = 0.6;
      const ALT = 300.0;
      const mat = new C.BufferPointMaterial({
        color: new C.Color(0.1, 1.0, 1.0, 1.0),
        size: 4,
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

      // Apply a per-frame full-collection position nudge that forces the whole
      // collection through the repack path every frame. Nudge in a tiny circle
      // so the points stay on-screen (no drift off the frustum over the window).
      const scratch = new C.BufferPoint();
      const cart = new C.Cartesian3();
      const carto = new C.Cartographic();
      const nudgeAll = (collection, k) => {
        const dLon = C.Math.toRadians(0.0006 * Math.cos(k * 0.4));
        const dLat = C.Math.toRadians(0.0006 * Math.sin(k * 0.4));
        const n = collection.primitiveCount;
        for (let i = 0; i < n; i++) {
          collection.get(i, scratch);
          scratch.getPosition(cart);
          C.Cartographic.fromCartesian(cart, undefined, carto);
          scratch.setPosition(
            C.Cartesian3.fromRadians(
              carto.longitude + dLon,
              carto.latitude + dLat,
              carto.height,
            ),
          );
        }
      };

      // Measure ms/frame over `measureFrames` frames where EVERY frame applies a
      // full-collection nudge → full-range repack+upload. Reset the cache timer
      // accumulator after warmup so only the steady-state window is averaged.
      const measure = async (collection, measureFrames) => {
        // Warmup: build VA/cache + let the (browser) bridge attempt its load.
        for (let k = 0; k < 4; k++) {
          nudgeAll(collection, k);
          await frame(1);
        }
        const cache = getCache(collection);
        if (cache) {
          cache._repackMsTotal = 0;
          cache._repackSamples = 0;
        }
        for (let k = 0; k < measureFrames; k++) {
          nudgeAll(collection, k + 100);
          await frame(1);
        }
        const c2 = getCache(collection);
        const samples = c2 ? (c2._repackSamples ?? 0) : 0;
        const totalMs = c2 ? (c2._repackMsTotal ?? 0) : 0;
        return {
          msPerFrame: samples > 0 ? totalMs / samples : -1,
          samples,
          wasmRepacks: c2 ? (c2.wasmEncodeRepacks ?? 0) : -1,
          scalarRepacks: c2 ? (c2.scalarEncodeRepacks ?? 0) : -1,
        };
      };

      const results = [];
      const MEASURE_FRAMES = 20;

      for (const count of COUNTS) {
        // ---- BATCH-encode collection (default threshold) ----
        const batch = scene.primitives.add(
          new C.BufferPointCollection({ primitiveCountMax: count + 4 }),
        );
        // forceBatch (crossover analysis) drops the override to 0 so the batch
        // path engages BELOW the default 5000 threshold too; default leaves the
        // real threshold in effect.
        if (forceBatch) {
          batch._wasmEncodeThresholdOverride = 0;
        }
        fillGrid(batch, count);
        const batchM = await measure(batch, MEASURE_FRAMES);
        const batchImg = await snap();
        const batchCyan = cyanCount(batchImg);
        batch.show = false;

        // ---- forced-SCALAR collection (override = Infinity) ----
        const scalar = scene.primitives.add(
          new C.BufferPointCollection({ primitiveCountMax: count + 4 }),
        );
        scalar._wasmEncodeThresholdOverride = Number.POSITIVE_INFINITY;
        fillGrid(scalar, count);
        const scalarM = await measure(scalar, MEASURE_FRAMES);
        const scalarImg = await snap();
        const scalarCyan = cyanCount(scalarImg);
        scalar.show = false;

        // Cleanup so the next count starts clean (and memory stays bounded).
        scene.primitives.remove(batch);
        scene.primitives.remove(scalar);

        results.push({
          count,
          batchMsPerFrame: batchM.msPerFrame,
          scalarMsPerFrame: scalarM.msPerFrame,
          batchSamples: batchM.samples,
          scalarSamples: scalarM.samples,
          batchWasmRepacks: batchM.wasmRepacks,
          batchScalarRepacks: batchM.scalarRepacks,
          scalarWasmRepacks: scalarM.wasmRepacks,
          scalarScalarRepacks: scalarM.scalarRepacks,
          batchCyan,
          scalarCyan,
          canvasPixels: batchImg.w * batchImg.h,
          pngBatch: count === COUNTS[0] ? batchImg.png : null,
        });
      }

      return { renderer, results };
    },
    { COUNTS, renderer, forceBatch: FORCE_BATCH },
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

const byBackend = {};
for (const renderer of ["webgpu", "webgl"]) {
  console.log(`\n== ${renderer} ==`);
  const r = await runBackend(renderer);
  byBackend[renderer] = r;

  // Save the smallest-count batch PNG per backend for the visual record.
  const first = r.results.find((x) => x.pngBatch);
  if (first) {
    fs.writeFileSync(
      path.join(
        OUT_DIR,
        `buffercoll-encode-bench-${renderer}-${first.count}.png`,
      ),
      Buffer.from(first.pngBatch.split(",")[1], "base64"),
    );
  }

  console.log(
    "  count     batch(ms/f)  scalar(ms/f)   ratio   batchPath   visible(px)",
  );
  for (const x of r.results) {
    const ratio =
      x.scalarMsPerFrame > 0 ? x.batchMsPerFrame / x.scalarMsPerFrame : NaN;
    const pathTag = x.batchWasmRepacks > 0 ? "batch" : "scalar(<thr or no-f64)";
    console.log(
      `  ${String(x.count).padStart(7)}   ${x.batchMsPerFrame
        .toFixed(3)
        .padStart(9)}   ${x.scalarMsPerFrame.toFixed(3).padStart(9)}   ${ratio
        .toFixed(2)
        .padStart(5)}   ${pathTag.padEnd(22)}  ${x.batchCyan}`,
    );

    // (A) the BATCH collection engaged the batch path. With the default
    // threshold this requires count >= 5000; in forceBatch crossover mode the
    // override drops it to 0 so any count batches. Below-threshold counts in the
    // default mode legitimately stay scalar, so only assert when count clears
    // the threshold (or forceBatch is on).
    const expectBatch = FORCE_BATCH || x.count >= 5000;
    check(
      `${renderer}-${x.count}-path`,
      (expectBatch ? x.batchWasmRepacks > 0 : x.batchScalarRepacks > 0) &&
        x.scalarWasmRepacks === 0,
      `batch path ${expectBatch ? "engaged" : "correctly scalar (sub-threshold)"} + forced-scalar stayed scalar (batchWasm=${x.batchWasmRepacks} batchScalar=${x.batchScalarRepacks} scalarWasm=${x.scalarWasmRepacks})`,
    );
    // (B) timer produced real samples (instrumentation works).
    check(
      `${renderer}-${x.count}-timed`,
      x.batchSamples >= 15 && x.batchMsPerFrame >= 0,
      `repack timer sampled ${x.batchSamples} frames @ ${x.batchMsPerFrame.toFixed(3)} ms/frame`,
    );
    // (C) the moving grid is actually visible (not culled/black).
    check(
      `${renderer}-${x.count}-visible`,
      x.batchCyan > 1000 && x.scalarCyan > 1000,
      `moving grid visible: batchCyan=${x.batchCyan} scalarCyan=${x.scalarCyan} (> 1000)`,
    );
  }
}

// ---- Visual no-regression: WebGPU vs WebGL point coverage parity per count --
// Both backends draw the SAME generated grid through the SAME (batch) encode
// strategy. The two renderers will not be pixel-identical (point sprite raster
// differs), but the visible cyan coverage must be in the same ballpark — a gross
// divergence (one backend dropping the whole collection, or a precision blow-up
// scattering points) shows up as a large coverage ratio. Tolerance is generous
// because point-sprite AA + rounding differ across backends.
console.log("\n== visual no-regression (WebGPU vs WebGL coverage) ==");
for (const count of COUNTS) {
  const g = byBackend.webgpu.results.find((x) => x.count === count);
  const l = byBackend.webgl.results.find((x) => x.count === count);
  if (!g || !l) continue;
  const hi = Math.max(g.batchCyan, l.batchCyan);
  const lo = Math.min(g.batchCyan, l.batchCyan);
  const ratio = lo > 0 ? hi / lo : Infinity;
  check(
    `parity-${count}`,
    ratio <= 1.6 && lo > 1000,
    `coverage parity webgpu=${g.batchCyan} webgl=${l.batchCyan} ratio=${ratio.toFixed(2)} (<= 1.6)`,
  );
}

// ---- 0 console errors (excluding the known wasm-load 404 blocker) -----------
for (const renderer of ["webgpu", "webgl"]) {
  const realErrors = byBackend[renderer].errors.filter(
    (e) =>
      !/Failed to load resource.*404|cesium_wasm.*\.wasm|404 \(Not Found\)/i.test(
        e,
      ),
  );
  check(
    `${renderer}-errors`,
    realErrors.length === 0,
    `console errors (excl. known wasm-load 404): ${realErrors.length} (total ${byBackend[renderer].errors.length})`,
  );
  if (realErrors.length)
    for (const e of realErrors.slice(0, 6)) console.log(`    ERR: ${e}`);
}

console.log("");
console.log(
  "NOTE: 'batch' path here is the JS fround encode twin — the WASM kernel does",
);
console.log(
  "NOT load in the bundle (NEW-WASM-BRIDGE-BUNDLE-LOAD). This table compares the",
);
console.log(
  "batch-vs-scalar CPU encode STRATEGY *with the GPU upload included*. For the",
);
console.log(
  "real-kernel scalar-vs-WASM CPU encode number, run Tools/wasm-encode-benchmark.mjs.",
);
console.log("");
console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
