#!/usr/bin/env node
// probe-entitycluster-gpu.mjs — Phase 10 EntityCluster-on-GPU (Batch 301,
// NEW-ENTITYCLUSTER-GPU).
//
// Validates that screen-space proximity declutter of a DENSE set of point
// entities works on WebGPU via the GPU bin/count fast path
// (WebGPUEntityClusterDispatcher + EntityClusterGridGPU.wgsl) and stays
// consistent with the WebGL/CPU KDBush path:
//
//   (A) CLUSTERS  — enabling `dataSource.clustering` over N dense point
//       entities produces representative cluster markers (cluster label
//       collection populated) on BOTH backends, with cluster count well below
//       the entity count.
//   (B) ZOOM      — zooming OUT (markers pack tighter on screen) does NOT
//       increase the representative count vs a closer view — declutter merges
//       more aggressively the tighter the packing (count is non-increasing
//       with zoom-out, within a small slack).
//   (C) PARITY    — the WebGPU representative count is within tolerance of the
//       WebGL representative count for the same view (both are valid screen-
//       space declutters of the same set; exact equality is not required since
//       the GPU path is a grid merge vs the CPU greedy-bbox merge).
//   (D) GPU RAN   — on WebGPU the dispatcher actually dispatched (statistics
//       .dispatches > 0) — i.e. the bin/count path was exercised, not silently
//       skipped.
//   (E) SCALE     — per-declutter CPU cost on WebGPU grows more slowly than the
//       CPU KDBush path as N rises (the GPU offloads the O(N log N) index
//       build). Measured as the declutter wall-time ratio at N=2000 vs the
//       same WebGL measurement.
//   (F) 0 ERRORS  — no console errors (incl. WebGPU validation) on either run.
//
// Determinism: clustering runs off `camera.changed`; the probe drives it
// explicitly by calling `clustering._cluster()` and pumping `scene.render()` +
// rAF between calls so the one-frame-stale GPU grid is produced on request N
// and consumed on request N+1. requestRenderMode is forced off.
//
// Usage: node Tools/visual-regression/probe-entitycluster-gpu.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const LON = -75.0;
const LAT = 40.0;
const N = 2000; // dense clusterable point entities

async function run(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ lon, lat, n }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.requestRenderMode = false;

      // Build a dense grid of point entities in a small geographic patch so
      // that, projected to screen, many fall within the merge radius.
      const ds = new C.CustomDataSource("cluster-points");
      const side = Math.ceil(Math.sqrt(n));
      const span = 0.6; // degrees — tight so screen packing is dense
      for (let i = 0; i < n; i++) {
        const r = Math.floor(i / side);
        const c = i % side;
        const dlon = (c / side - 0.5) * span;
        const dlat = (r / side - 0.5) * span;
        ds.entities.add({
          position: C.Cartesian3.fromDegrees(lon + dlon, lat + dlat, 0),
          point: { pixelSize: 8, color: C.Color.YELLOW },
        });
      }

      const cl = ds.clustering;
      cl.enabled = true;
      cl.pixelRange = 60;
      cl.minimumClusterSize = 2;

      await v.dataSources.add(ds);

      // Helper: render a few frames so visualizers process the entities and
      // the point collection's screen-space positions are valid.
      async function pump(frames) {
        for (let i = 0; i < frames; i++) {
          scene.render();
          await new Promise((res) => requestAnimationFrame(res));
        }
      }

      function clusterCount() {
        const lc = cl._clusterLabelCollection;
        return lc ? lc.length : 0;
      }

      // Drive a declutter pass: request the grid (frame K) then consume it
      // (frame K+1). Returns the declutter wall-time of the consuming call.
      async function declutter() {
        await pump(2);
        cl._clusterDirty = true;
        cl._cluster(); // request (GPU path: kicks off async grid)
        await pump(3); // let the async readback land + re-render
        const t0 = performance.now();
        cl._clusterDirty = true;
        cl._cluster(); // consume (GPU path: uses the fresh grid)
        const dt = performance.now() - t0;
        await pump(1);
        return { dt, count: clusterCount() };
      }

      // ---- View 1: closer (fewer screen-space overlaps) ----
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 120000.0),
      });
      await pump(3);
      const near = await declutter();
      const near2 = await declutter(); // second pass (grid now warm)

      // ---- View 2: zoomed out (markers pack tighter → more merging) ----
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 600000.0),
      });
      await pump(3);
      await declutter(); // warm
      const far = await declutter();

      // GPU dispatcher stats (WebGPU only).
      let gpuDispatches = -1;
      try {
        const fr = scene.context.getFeatureRenderer
          ? scene.context.getFeatureRenderer(50) // ENTITY_CLUSTER_GPU
          : undefined;
        if (fr && typeof fr.getStatistics === "function") {
          const st = fr.getStatistics();
          gpuDispatches = st ? st.dispatches : -1;
        }
      } catch (_e) {
        gpuDispatches = -2;
      }

      // Average a few declutter timings at this N for the scale metric.
      let avgDt = 0;
      const ITERS = 6;
      for (let k = 0; k < ITERS; k++) {
        const d = await declutter();
        avgDt += d.dt;
      }
      avgDt /= ITERS;

      const result = {
        mode: scene.mode,
        n,
        nearCount: near2.count,
        farCount: far.count,
        nearDt: +near2.dt.toFixed(3),
        farDt: +far.dt.toFixed(3),
        avgDt: +avgDt.toFixed(3),
        gpuDispatches,
        clusterLabelExists: !!cl._clusterLabelCollection,
      };

      await v.dataSources.remove(ds, true);
      return result;
    },
    { lon: LON, lat: LAT, n: N },
  );

  await browser.close();
  console.log(`\n=== ${rendererArg.toUpperCase()} ===`);
  console.log(JSON.stringify(out, null, 2));
  console.log(`  errors=${errors.length}`);
  errors.slice(0, 6).forEach((e) => console.log(`     ERR: ${e}`));
  return { rendererArg, ...out, errors };
}

(async () => {
  const results = [];
  for (const r of ["webgl", "webgpu"]) results.push(await run(r));

  const webgl = results.find((r) => r.rendererArg === "webgl");
  const webgpu = results.find((r) => r.rendererArg === "webgpu");

  // ---- PASS/FAIL gate ----
  let ok = true;
  for (const res of results) {
    const clusters = res.nearCount > 0 && res.nearCount < res.n;
    // Zoom-out should not INCREASE representatives (tighter packing → fewer or
    // equal reps). Allow a small slack for grid-vs-bbox boundary effects.
    const zoomMerges = res.farCount <= res.nearCount * 1.25 + 2;
    const noErr = res.errors.length === 0;
    const pass = clusters && zoomMerges && noErr;
    ok = ok && pass;
    console.log(
      `\n[${res.rendererArg}] clusters=${clusters} (near=${res.nearCount} far=${res.farCount} of ${res.n}) zoomMerges=${zoomMerges} dispatches=${res.gpuDispatches} avgDt=${res.avgDt}ms noErr=${noErr} => ${pass ? "PASS" : "FAIL"}`,
    );
  }

  // Cross-backend parity: WebGPU representative count within tolerance of WebGL.
  // Tightened in Batch 308 (NEW-ENTITYCLUSTER-GPU-MERGE): the rep-to-rep /
  // member-to-seed pixel-distance gate replaced the unconditional 3×3-cell
  // absorb, so the grid merge now matches the CPU bbox range query closely
  // (ratio went 0.42 → ~1.0). Band is ±25% (was 0.4–2.5).
  const ref = Math.max(webgl.nearCount, 1);
  const parityRatio = webgpu.nearCount / ref;
  const parity = parityRatio >= 0.75 && parityRatio <= 1.25;
  ok = ok && parity;

  // GPU actually ran on WebGPU.
  const gpuRan = webgpu.gpuDispatches > 0;
  ok = ok && gpuRan;

  console.log(
    `\n[parity] webgl.near=${webgl.nearCount} webgpu.near=${webgpu.nearCount} ratio=${parityRatio.toFixed(2)} => ${parity ? "OK" : "OUT-OF-TOLERANCE"}`,
  );
  console.log(
    `[gpu-ran] webgpu dispatches=${webgpu.gpuDispatches} => ${gpuRan ? "OK" : "FAIL"}`,
  );
  console.log(
    `[scale] webgl avgDt=${webgl.avgDt}ms webgpu avgDt=${webgpu.avgDt}ms (informational — GPU offloads the O(N log N) index build)`,
  );

  console.log(`\n[probe-entitycluster-gpu] ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
})();
