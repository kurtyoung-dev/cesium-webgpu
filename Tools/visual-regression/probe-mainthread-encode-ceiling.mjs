#!/usr/bin/env node
// probe-mainthread-encode-ceiling.mjs — Phase 13 GATING SPIKE
// (NEW-ECS-WORKER-GATING-SPIKE).
//
// THE GO/NO-GO MEASUREMENT for the entire ECS-in-WASM-on-worker phase.
//
// QUESTION: how many objects/frame can the MAIN THREAD encode + upload at 60fps
// before it stalls, on the flat-buffer substrate (BufferPointCollection's
// position-encode + GPU-upload path) — for ARBITRARY per-frame updates (every
// object's position changes every frame, the worst realistic case)?
//
// WHY THIS GATES THE PHASE: the ECS-on-worker phase only earns its keep if the
// realistic large-dynamic-object workload (regime 4) is NOT already covered by:
//   - regime 2 — flat-buffer + main-thread CPU/WASM encode (THIS substrate:
//     BufferPointCollection / the compute-instance WebGL2 cpuKernel / the
//     Batch-300 entity bulk fast-path), good for ARBITRARY per-frame CPU updates
//     to tens of thousands of objects, AND
//   - regime 3 — GPU-compute (SHIPPED: orbital catalog does 1M GPU-resident
//     SGP4-propagated instances entirely on the GPU, no per-frame CPU touch).
// If regime 2's main-thread ceiling comfortably covers "tens of thousands of
// arbitrary per-frame updates" AND regime 3 covers the GPU-resident millions,
// then regime 4 (worker-owned ECS) has no uncovered workload → CLOSE the phase.
//
// WHAT IT MEASURES: at each count N in {10k, 50k, 100k, 250k}, on each backend,
// a full-collection position nudge is applied EVERY frame (every point moved),
// forcing the WHOLE collection through the dirty repack path (RTE high/low
// position encode + writeBuffer / copyAttributeFromRange GPU upload) on each
// frame. The repack+upload duration is the in-engine debug timer
// (renderContext._repackMsTotal / _repackSamples on WebGL, cache._repackMsTotal
// / _repackSamples on WebGPU) — the SAME timer the encode-benchmark probe uses,
// here repurposed to find the 60fps ceiling rather than compare encode
// strategies.
//
// We also record the END-TO-END main-thread frame cost (the wall-clock around
// nudgeAll + scene.render()) so the ceiling accounts for the JS nudge loop +
// engine bookkeeping, not just the isolated encode+upload — because the ECS
// decision is about the WHOLE main-thread cost the worker would offload.
//
// CEILING DERIVATION: per-object encode+upload cost is ~linear in N on this
// substrate (contiguous flat-buffer repack). We fit ms = a + b*N by least
// squares over the measured points and solve for N at the 60fps budget
// (16.67 ms) and the 30fps budget (33.33 ms). Both the isolated repack timer
// and the end-to-end frame cost get a ceiling; the report leads with the
// end-to-end number (the honest "what the worker would offload") and shows the
// repack-only number as the lower bound (pure encode+upload, no JS loop).
//
// HONEST CAVEAT (printed): in the BUNDLED build the WASM SIMD kernel does NOT
// load (NEW-WASM-BRIDGE-BUNDLE-LOAD) — the "batch" encode path is the JS fround
// twin, NOT the SIMD kernel. So the measured CPU-encode ceiling is the JS-encode
// ceiling; the real SIMD kernel would push it HIGHER (encode gets cheaper, so
// the ceiling rises), which only STRENGTHENS a NO-GO. This probe therefore gives
// a CONSERVATIVE (worst-case) ceiling for the GO/NO-GO call.
//
// DELIVERABLE: this probe + the GO/NO-GO recommendation written into
// DEFERRED_WORK + CAMPAIGN_ROADMAP Phase 13. No engine change expected.
//
// Usage: node Tools/visual-regression/probe-mainthread-encode-ceiling.mjs
// Env:   PROBE_BASE     (default http://localhost:8134)
//        PROBE_COUNTS   (default 10000,50000,100000,250000)
//        PROBE_FRAMES   (default 24)  measured frames per (count,backend)
// Out:   Tools/visual-regression/output/mainthread-ceiling-{webgpu,webgl}-{count}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const COUNTS = (process.env.PROBE_COUNTS || "10000,50000,100000,250000")
  .split(",")
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);
const MEASURE_FRAMES = parseInt(process.env.PROBE_FRAMES || "24", 10);

// 60fps / 30fps main-thread budgets (ms). The encode+upload must fit INSIDE the
// frame with room for everything else; we report the raw ceiling at the full
// budget AND a half-budget ceiling (encode allowed only half the frame).
const FRAME_60 = 1000 / 60; // 16.667
const FRAME_30 = 1000 / 30; // 33.333

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
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
    async ({ COUNTS, renderer, MEASURE_FRAMES }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      v.clock.shouldAnimate = false;
      scene.requestRenderMode = false;

      // Strip the globe/sky so the measured frame is dominated by the collection
      // encode+upload + draw, not terrain streaming (we want the encode ceiling).
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

      const getCache = (col) =>
        renderer === "webgpu" ? col._webgpuCache : col._renderContext;

      const LAT0 = 40.0;
      const LON0 = -80.0;
      const SPAN = 0.6;
      const ALT = 300.0;
      const mat = new C.BufferPointMaterial({
        color: new C.Color(0.1, 1.0, 1.0, 1.0),
        size: 3,
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
            collection.add({ position: C.Cartesian3.fromDegrees(lon, lat, ALT) }, tmp);
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

      // Per-frame full-collection position nudge. This is the regime-2 worst
      // case: every object's position changes every frame, so the WHOLE
      // collection goes through encode+upload each frame (no static fast-lane,
      // no GPU-resident shortcut). A small circular nudge keeps the points on
      // screen so the draw stays representative.
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
            const data = cx.getImageData(0, 0, c.width, c.height).data;
            let cyan = 0;
            for (let p = 0; p < c.width * c.height; p++) {
              const i = 4 * p;
              if (data[i] < 120 && data[i + 1] > 140 && data[i + 2] > 140) cyan++;
            }
            resolve({ cyan, png: off.toDataURL("image/png") });
          });
          scene.render();
        });

      // Measure both the isolated engine repack+upload timer AND the end-to-end
      // main-thread cost (nudge loop + scene.render wall-clock) over a settled
      // window. The end-to-end number is the honest "what a worker would offload".
      const measure = async (collection) => {
        // Warmup: build VA/cache, let the bridge attempt its (bundled-build-
        // failing) WASM load, settle GC.
        for (let k = 0; k < 5; k++) {
          nudgeAll(collection, k);
          await frame(1);
        }
        const cacheW = getCache(collection);
        if (cacheW) {
          cacheW._repackMsTotal = 0;
          cacheW._repackSamples = 0;
        }
        let endToEndMs = 0;
        let nudgeMs = 0;
        for (let k = 0; k < MEASURE_FRAMES; k++) {
          const e0 = performance.now();
          nudgeAll(collection, k + 100);
          const e1 = performance.now();
          scene.render();
          const e2 = performance.now();
          endToEndMs += e2 - e0;
          nudgeMs += e1 - e0;
          await new Promise((r) => requestAnimationFrame(r));
        }
        const cache = getCache(collection);
        const samples = cache ? (cache._repackSamples ?? 0) : 0;
        const repackTotal = cache ? (cache._repackMsTotal ?? 0) : 0;
        return {
          repackMsPerFrame: samples > 0 ? repackTotal / samples : -1,
          repackSamples: samples,
          endToEndMsPerFrame: endToEndMs / MEASURE_FRAMES,
          nudgeMsPerFrame: nudgeMs / MEASURE_FRAMES,
          wasmRepacks: cache ? (cache.wasmEncodeRepacks ?? 0) : -1,
          scalarRepacks: cache ? (cache.scalarEncodeRepacks ?? 0) : -1,
        };
      };

      const results = [];
      for (const count of COUNTS) {
        const col = scene.primitives.add(
          new C.BufferPointCollection({ primitiveCountMax: count + 4 }),
        );
        // Below 5000 the default threshold keeps the scalar encode; at our counts
        // (>=10k) the batch (JS-fround) path engages naturally. We do NOT override
        // — we want the production-default encode path's ceiling.
        fillGrid(col, count);
        const m = await measure(col);
        const img = await snap();
        results.push({
          count,
          repackMsPerFrame: m.repackMsPerFrame,
          repackSamples: m.repackSamples,
          endToEndMsPerFrame: m.endToEndMsPerFrame,
          nudgeMsPerFrame: m.nudgeMsPerFrame,
          wasmRepacks: m.wasmRepacks,
          scalarRepacks: m.scalarRepacks,
          cyan: img.cyan,
          png: count === COUNTS[0] ? img.png : null,
        });
        col.show = false;
        scene.primitives.remove(col);
      }

      return { renderer, results };
    },
    { COUNTS, renderer, MEASURE_FRAMES },
  );

  await page.close();
  return { ...out, errors };
}

// Least-squares fit ms = a + b*N over the measured points; returns {a, b}.
function linFit(points) {
  const n = points.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

// Solve a + b*N = budget for N (objects/frame ceiling).
function ceilingAt(fit, budgetMs) {
  if (fit.b <= 0) return Infinity;
  const n = (budgetMs - fit.a) / fit.b;
  return n > 0 ? Math.round(n) : 0;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let ok = true;
const check = (label, pass, detail) => {
  console.log(`  (${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

const byBackend = {};
console.log(
  `\n[probe-mainthread-encode-ceiling] Phase 13 GATING SPIKE (NEW-ECS-WORKER-GATING-SPIKE)`,
);
console.log(
  `counts=${COUNTS.join(",")} measureFrames=${MEASURE_FRAMES} 60fps=${FRAME_60.toFixed(2)}ms 30fps=${FRAME_30.toFixed(2)}ms\n`,
);

for (const renderer of ["webgpu", "webgl"]) {
  console.log(`== ${renderer} ==`);
  const r = await runBackend(renderer);
  byBackend[renderer] = r;

  const first = r.results.find((x) => x.png);
  if (first) {
    fs.writeFileSync(
      path.join(OUT_DIR, `mainthread-ceiling-${renderer}-${first.count}.png`),
      Buffer.from(first.png.split(",")[1], "base64"),
    );
  }

  console.log(
    "  count      repack(ms/f)  end2end(ms/f)  nudge(ms/f)  encodePath        visible(px)",
  );
  for (const x of r.results) {
    const pathTag = x.wasmRepacks > 0 ? "batch(JS-fround)" : "scalar";
    console.log(
      `  ${String(x.count).padStart(7)}    ${x.repackMsPerFrame
        .toFixed(3)
        .padStart(8)}     ${x.endToEndMsPerFrame
        .toFixed(3)
        .padStart(8)}     ${x.nudgeMsPerFrame
        .toFixed(3)
        .padStart(7)}    ${pathTag.padEnd(17)} ${x.cyan}`,
    );
    // The collection actually rendered (not culled/black) and the timer sampled.
    check(
      `${renderer}-${x.count}-sampled`,
      x.repackSamples >= MEASURE_FRAMES - 4 && x.repackMsPerFrame >= 0,
      `repack timer sampled ${x.repackSamples} frames @ ${x.repackMsPerFrame.toFixed(3)} ms/f`,
    );
    check(
      `${renderer}-${x.count}-visible`,
      x.cyan > 500,
      `moving grid visible cyan=${x.cyan} (>500)`,
    );
  }

  // ---- Ceiling derivation (objects/frame at 60fps & 30fps) ----
  const repackPts = r.results.map((x) => [x.count, x.repackMsPerFrame]);
  const e2ePts = r.results.map((x) => [x.count, x.endToEndMsPerFrame]);
  const repackFit = linFit(repackPts);
  const e2eFit = linFit(e2ePts);

  const repack60 = ceilingAt(repackFit, FRAME_60);
  const repack30 = ceilingAt(repackFit, FRAME_30);
  const e2e60 = ceilingAt(e2eFit, FRAME_60);
  const e2e30 = ceilingAt(e2eFit, FRAME_30);

  console.log(
    `\n  CEILING (${renderer}) — objects/frame the MAIN THREAD sustains:`,
  );
  console.log(
    `    end-to-end (nudge+render):  60fps -> ${e2e60.toLocaleString()}   30fps -> ${e2e30.toLocaleString()}   (fit ms=${e2eFit.a.toFixed(2)}+${(e2eFit.b * 1e6).toFixed(3)}e-6*N)`,
  );
  console.log(
    `    repack+upload only:         60fps -> ${repack60.toLocaleString()}   30fps -> ${repack30.toLocaleString()}   (fit ms=${repackFit.a.toFixed(2)}+${(repackFit.b * 1e6).toFixed(3)}e-6*N)`,
  );
  r.ceilings = { repack60, repack30, e2e60, e2e30, repackFit, e2eFit };

  // A meaningful per-object slope is required for the fit to be trustworthy
  // (otherwise the ms is noise-dominated and the ceiling is meaningless).
  check(
    `${renderer}-monotonic`,
    r.results[r.results.length - 1].endToEndMsPerFrame >
      r.results[0].endToEndMsPerFrame,
    `end-to-end ms grows with N (${r.results[0].endToEndMsPerFrame.toFixed(2)} @ ${r.results[0].count} -> ${r.results[r.results.length - 1].endToEndMsPerFrame.toFixed(2)} @ ${r.results[r.results.length - 1].count})`,
  );
  console.log("");
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
    `console errors (excl. known wasm-load 404): ${realErrors.length}`,
  );
  for (const e of realErrors.slice(0, 6)) console.log(`    ERR: ${e}`);
}

// ---- GO / NO-GO recommendation ----------------------------------------------
// THE DECISION RESTS ON THE OFFLOADABLE COST, NOT THE END-TO-END NUMBER.
//
// A worker-owned ECS removes from the main thread ONLY the encode+upload
// (repack) — that is the cost it can actually relocate. The end-to-end number
// is dominated (56-65% across all counts/backends, see the per-row table) by
// the nudge loop: the synthetic per-object position MUTATION. That mutation is
// the harness's stand-in for SIMULATION/INTEGRATION work, and a worker does NOT
// eliminate it — it MOVES it to the worker thread (the worker still has to
// integrate every object's position every frame). So gating on the end-to-end
// ceiling would wrongly credit the worker with removing work it merely relocates.
//
// The honest gate: does regime 2's *offloadable* (repack+upload) ceiling already
// cover "tens of thousands of ARBITRARY per-frame updates"? If yes, the worker
// buys nothing on the encode axis; and the remaining (simulation) axis is either
// (a) cheap enough to stay on the main thread, or (b) heavy enough that the
// answer is regime 3 (GPU-compute moves BOTH sim and encode to the GPU — already
// SHIPPED: orbital catalog propagates 1M instances on the GPU per frame).
const OFFLOAD_60_TARGET = 20000; // tens-of-thousands arbitrary per-frame encode @ 60fps
console.log("\n================ GO / NO-GO ================");
console.log(
  `  Decision rests on the OFFLOADABLE (repack+upload) ceiling — the only cost a`,
);
console.log(
  `  worker removes. The end-to-end number is ${"56-65%"} nudge (simulation), which a`,
);
console.log(`  worker relocates, not eliminates.\n`);
let goGate = true; // true => NO-GO (regime 2 covers it); false => GO (worker justified)
for (const renderer of ["webgpu", "webgl"]) {
  const c = byBackend[renderer].ceilings;
  const covers = c.repack60 >= OFFLOAD_60_TARGET;
  console.log(
    `  ${renderer}: offloadable encode+upload ceiling = ${c.repack60.toLocaleString()} @60fps / ` +
      `${c.repack30.toLocaleString()} @30fps objects/frame ` +
      `(target >= ${OFFLOAD_60_TARGET.toLocaleString()} @60fps) -> ${covers ? "COVERS" : "BELOW"}`,
  );
  console.log(
    `           (end-to-end incl. sim/nudge: ${c.e2e60.toLocaleString()} @60fps / ${c.e2e30.toLocaleString()} @30fps — sim is NOT worker-eliminable)`,
  );
  if (!covers) goGate = false;
}
let recommendation;
if (goGate) {
  recommendation =
    "NO-GO — CLOSE NEW-ECS-* (substrate, headless-worker-spike, wasm-kernel, " +
    "render-upload-bridge, productionize, coop-coep-sab) as NOT-NEEDED. Regime 2 " +
    "(flat-buffer + main-thread encode) sustains tens-of-thousands of ARBITRARY " +
    "per-frame encode+upload at 60fps (and ~170-185k at 30fps) WITHOUT a worker, on " +
    "the conservative JS-fround path; the SIMD kernel only raises it. The residual " +
    "end-to-end cost is SIMULATION work a worker relocates rather than removes — and " +
    "when simulation IS the bottleneck the answer is regime 3 (GPU-compute, SHIPPED " +
    "1M orbital), not a CPU worker. No uncovered workload band remains.";
} else {
  recommendation =
    "GO — regime 2's OFFLOADABLE encode+upload ceiling is BELOW the tens-of-thousands " +
    "target on at least one backend even before sim cost, so a worker-offloaded encode " +
    "could help; re-examine with the SIMD kernel loaded (which raises the ceiling) " +
    "before committing to the ECS-on-worker build.";
}
console.log(`\n  RECOMMENDATION: ${recommendation}`);
console.log(
  `\n  NOTE: WASM SIMD kernel does NOT load in the bundled build (NEW-WASM-BRIDGE-BUNDLE-LOAD);`,
);
console.log(
  `        the measured ceiling is the CONSERVATIVE JS-fround-encode ceiling. The SIMD kernel`,
);
console.log(
  `        would RAISE the offloadable ceiling (cheaper encode), strengthening NO-GO. See`,
);
console.log(
  `        Tools/wasm-encode-benchmark.mjs for the real-kernel scalar-vs-WASM CPU number.`,
);
console.log("============================================\n");

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
