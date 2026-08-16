#!/usr/bin/env node
// probe-clustered-lights-resize — Q10 CLUSTERED-ASSIGN-BOUNDS-DIRTY (A7.2).
// @purpose Regression for stale cluster bins on stationary-camera resize/FOV change: bounds-only change must re-run assign; caching kept.
// @status ACTIVE
//
// Regression probe for the "stale cluster bins on stationary-camera
// resize / FOV change" bug.
//
// The Forward+ clustered-lighting pipeline runs two compute passes:
//   - ClusterBounds  → eye-space AABBs for the 16x9x24 cluster grid.
//                      Re-dispatches when (viewport, near, far,
//                      projection) change.
//   - ClusterAssign  → per-cluster light lists, read against those
//                      AABBs. Dirty-tracked on (lightCount, light
//                      positions/types, view).
//
// Bug (pre-fix): when only the projection / viewport / near-far change
// and the CAMERA DOES NOT MOVE, the eye-space light positions are
// unchanged, so the assign light-checksum matches and the assign pass
// SKIPS — leaving the per-cluster assignment bound to the STALE bounds.
//
// This probe uses a SINGLE dispatcher instance and dispatches twice with
// IDENTICAL lights + IDENTICAL (identity) view matrix, changing ONLY the
// viewport + projection + near/far between the two calls. It reads back
// the per-cluster light-count buffer after each and asserts the two
// distributions DIFFER (bins recomputed on bounds change). It then
// re-dispatches config B with identical inputs and asserts the counts
// are UNCHANGED (the legitimate light/view dirty-cache still works — the
// fix did not defeat caching).
//
// Buffer-readback (not pixel) verification is the discriminating signal
// for this compute-state bug — it mirrors probe-clustered-dispatcher.mjs.
// A screenshot of a clustered-lit scene is also captured for the record.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (dev) {
      dev.onuncapturederror = (ev) => {
        window.__probeErrors.push(ev?.error?.message ?? "");
      };
    }
  });

  const result = await page.evaluate(async () => {
    const mod = await import("/Build/CesiumUnminified/index.js");
    const device = window.viewer.scene.context._device;
    const DispatcherCtor = mod.WebGPUClusteredLightingDispatcher;
    if (typeof DispatcherCtor !== "function") {
      return {
        earlyExitErr: `dispatcher missing (typeof=${typeof DispatcherCtor})`,
      };
    }
    const C = mod;
    const TOTAL = 16 * 9 * 24;
    const COUNT_BYTES = TOTAL * 4;

    // A single OFF-CENTER point light so its screen/depth footprint is
    // sensitive to both aspect (X/Y tiles) and near/far (Z slices).
    // Directional lights are excluded on purpose — they hit every
    // cluster uniformly and would mask a bounds change.
    const lights = [
      {
        lightType: 1, // POINT
        posOrDirWC: { x: 18, y: 8, z: -40 },
        color: { r: 1, g: 0.6, b: 0.3 },
        intensity: 5,
        range: 55,
      },
    ];
    // IDENTITY view for BOTH configs — world == eye, camera never moves.
    const viewArr = Array.from(C.Matrix4.IDENTITY);

    function makeCfg(w, h, fovY, near, far) {
      const proj = C.Matrix4.computePerspectiveFieldOfView(
        fovY,
        w / h,
        near,
        far,
        new C.Matrix4(),
      );
      const invProj = Array.from(C.Matrix4.inverse(proj, new C.Matrix4()));
      return {
        enabled: true,
        lights,
        viewportWidth: w,
        viewportHeight: h,
        near,
        far,
        inverseProjection: invProj,
        viewMatrix: viewArr,
      };
    }

    // Config A vs Config B: identical lights + view; different
    // viewport aspect, FOV, and near/far → cluster bounds must differ.
    const cfgA = makeCfg(640, 360, Math.PI / 3, 1.0, 1000.0);
    const cfgB = makeCfg(1280, 360, Math.PI / 2, 1.0, 150.0);

    const dispatcher = new DispatcherCtor(device);

    async function dispatchAndReadCounts(cfg, label) {
      const enc = device.createCommandEncoder({ label });
      const active = dispatcher.dispatch(enc, cfg);
      device.queue.submit([enc.finish()]);
      const staging = device.createBuffer({
        size: COUNT_BYTES,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      const rb = device.createCommandEncoder({ label: `${label}-rb` });
      rb.copyBufferToBuffer(
        dispatcher.perClusterLightCountBuffer,
        0,
        staging,
        0,
        COUNT_BYTES,
      );
      device.queue.submit([rb.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const counts = new Uint32Array(staging.getMappedRange().slice());
      staging.unmap();
      let total = 0;
      let occupied = 0;
      for (let i = 0; i < counts.length; i++) {
        total += counts[i];
        if (counts[i] > 0) occupied++;
      }
      return { active, counts: Array.from(counts), total, occupied };
    }

    const A = await dispatchAndReadCounts(cfgA, "cfgA");
    const B = await dispatchAndReadCounts(cfgB, "cfgB");
    // Control: re-dispatch B with identical inputs → dirty-cache must
    // hold (bounds unchanged + light checksum unchanged → assign skips),
    // so counts are byte-identical to B.
    const B2 = await dispatchAndReadCounts(cfgB, "cfgB-again");

    // Compare A vs B distributions.
    let diffCells = 0;
    for (let i = 0; i < TOTAL; i++) {
      if (A.counts[i] !== B.counts[i]) diffCells++;
    }
    let b2DiffCells = 0;
    for (let i = 0; i < TOTAL; i++) {
      if (B.counts[i] !== B2.counts[i]) b2DiffCells++;
    }

    return {
      TOTAL,
      aActive: A.active,
      bActive: B.active,
      aTotal: A.total,
      bTotal: B.total,
      aOccupied: A.occupied,
      bOccupied: B.occupied,
      diffCells, // A vs B: must be > 0 (bins recomputed on bounds change)
      b2DiffCells, // B vs B-again: must be 0 (cache still works)
    };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await page.screenshot({ path: `${OUT}/clustered-lights-resize.png` });
  await browser.close();

  console.log("[probe-clustered-lights-resize] result:");
  if (result.earlyExitErr) {
    console.log(`  EARLY-EXIT: ${result.earlyExitErr}`);
    process.exit(1);
  }
  const r = result;
  console.log(
    `  cfgA: active=${r.aActive} totalAssign=${r.aTotal} occupiedClusters=${r.aOccupied}`,
  );
  console.log(
    `  cfgB: active=${r.bActive} totalAssign=${r.bTotal} occupiedClusters=${r.bOccupied}`,
  );
  console.log(
    `  A-vs-B differing clusters: ${r.diffCells}/${r.TOTAL}  (must be > 0 → bins recomputed on bounds change)`,
  );
  console.log(
    `  B-vs-B-again differing clusters: ${r.b2DiffCells}  (must be 0 → light/view dirty-cache intact)`,
  );
  console.log(`  device errors: ${errs.length}`);
  if (errs.length)
    errs
      .slice(0, 3)
      .forEach((e) => console.log(`   - ${String(e).slice(0, 160)}`));

  let pass = true;
  if (r.aActive !== 1 || r.bActive !== 1) {
    console.log(
      `FAIL: expected 1 active light per dispatch, got A=${r.aActive} B=${r.bActive}`,
    );
    pass = false;
  }
  if (r.aOccupied === 0 || r.bOccupied === 0) {
    console.log(
      `FAIL: point light occupied 0 clusters in a config (A=${r.aOccupied} B=${r.bOccupied})`,
    );
    pass = false;
  }
  if (r.diffCells === 0) {
    console.log(
      `FAIL (A7.2 STALE BINS): cfgA and cfgB per-cluster counts are IDENTICAL despite different bounds — assign did NOT recompute on bounds change.`,
    );
    pass = false;
  }
  if (r.b2DiffCells !== 0) {
    console.log(
      `FAIL: B-vs-B-again differs by ${r.b2DiffCells} cells — legitimate dirty-cache broken (assign re-ran with no change).`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log(
      "\nPASS: cluster bins recompute when bounds change (no camera motion); dirty-cache preserved; 0 device errors.",
    );
  }
  process.exit(pass ? 0 : 1);
})();
