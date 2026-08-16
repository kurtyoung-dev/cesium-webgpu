#!/usr/bin/env node
// probe-bulk-vs-legacy-perf.mjs — Settle the design question with DATA:
// @purpose Benchmark settling bulk static-lane vs legacy per-frame visualizer: setup and steady per-frame cost per entity count, point path isolated.
// @status ACTIVE
//
//   Is the Entity bulk static-lane fast-path (BulkPointVisualizer, and by
//   extension BulkBillboard/BulkLabel from Batch 333) an UPGRADE over the
//   legacy per-frame visualizer for FEW items, or only for many?
//
// Measures, on the WebGPU viewer, for static-entity counts
//   [1,5,10,25,50,100,250,500,1000,2000]:
//
//   BULK path  (the default DataSourceDisplay wiring):
//     - setup_ms  = entities added -> first settled visualizer.update()
//     - per_frame = steady-state bulkVis.update(time) avg over >=60 frames
//       (warmed up). For static entities this only runs the wrapped legacy
//       fallback over an EMPTY item list, so it should be ~0.
//
//   LEGACY path (TRUE isolation):
//     - We instantiate a raw PointVisualizer directly on the SAME
//       entityCollection + entityCluster as the DataSource. The legacy
//       visualizer subscribes to collectionChanged in its ctor and seeds
//       _items with EVERY point entity, so it processes all N per frame —
//       exactly the pre-bulk behavior. We measure legacyVis.update(time).
//     - setup_ms  = ctor (seeds _items) + first update().
//
// Isolating ONLY the point visualizer (not the whole display.update()) keeps
// billboard/label/geometry/model/path/polyline visualizer overhead out of the
// number so the bulk-vs-legacy delta is attributable to the point path alone.
//
// As of the lazy-alloc fix (Batch 335), the bulk visualizer DEFERS its
// PointPrimitiveCollection allocation to the first static-lane add, so a data
// source with zero static points pays nothing. For n>=1 static points the (now
// lazy) collection allocation is still recorded as part of setup — re-run this
// probe to confirm the low-count setup_delta dropped vs the pre-335 baseline.
//
// Out: console table + JSON to output/bulk-vs-legacy-perf.json

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const COUNTS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000];
const LON = -75.0;
const LAT = 40.0;
const RENDERER = process.env.PROBE_RENDERER || "webgpu";

async function run() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ counts, lon, lat }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.requestRenderMode = false;
      const display = v.dataSourceDisplay;
      const time = v.clock.currentTime;

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 600000.0),
      });
      scene.render();

      function gridDelta(i, n, span) {
        const side = Math.ceil(Math.sqrt(n));
        const r = Math.floor(i / side);
        const c = i % side;
        return [(c / side - 0.5) * span, (r / side - 0.5) * span];
      }

      // Build a CustomDataSource with N static point entities.
      function makeStaticDS(n, color, tag) {
        const ds = new C.CustomDataSource(`${tag}-${n}`);
        for (let i = 0; i < n; i++) {
          const [dlon, dlat] = gridDelta(i, n, 2.0);
          ds.entities.add({
            position: C.Cartesian3.fromDegrees(lon + dlon, lat + dlat, 0),
            point: { pixelSize: 6, color: color }, // ConstantProperty => static
          });
        }
        return ds;
      }

      function findBulkPointVis(ds) {
        const vis = ds._visualizers || [];
        // NOTE: BulkBillboardVisualizer and BulkLabelVisualizer ALSO expose
        // staticCount, and BulkBillboard comes first in the array. Match the
        // POINT one explicitly by constructor name.
        return vis.find((x) => x.constructor.name === "BulkPointVisualizer");
      }

      // Average update() cost over `iters` settled frames after `warm` warmups.
      function avgUpdate(fn, warm, iters) {
        for (let k = 0; k < warm; k++) fn();
        let total = 0;
        for (let k = 0; k < iters; k++) {
          const t0 = performance.now();
          fn();
          total += performance.now() - t0;
        }
        return total / iters;
      }

      const WARM = 20;
      const ITERS = 80; // >=60 settled frames
      const rows = [];

      for (const n of counts) {
        // ===== BULK PATH (default wiring) =====
        // Setup: add DS (ctor allocates flat-buffer PointPrimitiveCollection +
        // classifies all N into the static lane via _onCollectionChanged) then
        // first settled display.update — but we want the POINT visualizer's
        // own first-update cost isolated.
        const bs0 = performance.now();
        const sds = makeStaticDS(n, C.Color.YELLOW, "bulk");
        await v.dataSources.add(sds);
        const bulkVis = findBulkPointVis(sds);
        // First settled update of the bulk point visualizer.
        bulkVis.update(time);
        const bulkSetupMs = performance.now() - bs0;

        const staticCount = bulkVis ? bulkVis.staticCount : -1;
        const fallbackCount = bulkVis ? bulkVis.fallbackCount : -1;

        // Steady-state per-frame: bulk point visualizer update only.
        const bulkPerFrame = avgUpdate(() => bulkVis.update(time), WARM, ITERS);

        // Flat-buffer footprint (observable): number of point primitives held
        // by the bulk collection (each ~ a few floats of vertex/instance data).
        let bulkPrimCount;
        try {
          bulkPrimCount = bulkVis._collection ? bulkVis._collection.length : -1;
        } catch (e) {
          bulkPrimCount = -1;
        }

        await v.dataSources.remove(sds, true);
        display.update(time);

        // ===== LEGACY PATH (true isolation) =====
        // Add a fresh DS of the SAME N static entities, then instantiate a raw
        // legacy PointVisualizer directly on that DS's entityCollection +
        // entityCluster. The DS still gets its own bulk visualizer, but we do
        // NOT measure that — we measure ONLY our hand-built legacy visualizer,
        // whose ctor seeds _items with every point entity and whose update()
        // re-reads ~10 properties per entity per frame (the pre-bulk behavior).
        const lds = makeStaticDS(n, C.Color.LIME, "legacy");
        await v.dataSources.add(lds);
        display.update(time); // let the DS settle (bulk lane etc.)

        const ls0 = performance.now();
        const legacyVis = new C.PointVisualizer(
          lds.clustering, // EntityCluster
          lds.entities, // EntityCollection (already populated)
        );
        // ctor already seeded _items via collectionChanged + initial sweep.
        legacyVis.update(time); // first settled update
        const legacySetupMs = performance.now() - ls0;

        const legacyItemCount = legacyVis._items ? legacyVis._items.length : -1;

        const legacyPerFrame = avgUpdate(
          () => legacyVis.update(time),
          WARM,
          ITERS,
        );

        legacyVis.destroy();
        await v.dataSources.remove(lds, true);
        display.update(time);

        rows.push({
          n,
          bulkPerFrame: +bulkPerFrame.toFixed(4),
          legacyPerFrame: +legacyPerFrame.toFixed(4),
          bulkSetupMs: +bulkSetupMs.toFixed(3),
          legacySetupMs: +legacySetupMs.toFixed(3),
          staticCount,
          fallbackCount,
          bulkPrimCount,
          legacyItemCount,
        });
      }

      return { mode: scene.mode, rows };
    },
    { counts: COUNTS, lon: LON, lat: LAT },
  );

  await browser.close();

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, "bulk-vs-legacy-perf.json"),
    JSON.stringify({ renderer: RENDERER, ...result, errors }, null, 2),
  );

  console.log(`\n=== ${RENDERER.toUpperCase()} (sceneMode=${result.mode}) ===`);
  console.log(
    "  n     bulk/frame  legacy/frame  bulk_setup  legacy_setup  setup_delta  payback(frames)  static/fb",
  );
  for (const r of result.rows) {
    const setupDelta = r.bulkSetupMs - r.legacySetupMs;
    const perFrameWin = r.legacyPerFrame - r.bulkPerFrame; // >0 means bulk wins/frame
    const payback =
      perFrameWin > 1e-5 ? (setupDelta / perFrameWin).toFixed(0) : "never";
    console.log(
      `  ${String(r.n).padEnd(5)} ${String(r.bulkPerFrame).padEnd(11)} ${String(
        r.legacyPerFrame,
      ).padEnd(13)} ${String(r.bulkSetupMs).padEnd(11)} ${String(
        r.legacySetupMs,
      ).padEnd(13)} ${String(setupDelta.toFixed(3)).padEnd(12)} ${String(
        payback,
      ).padEnd(16)} ${r.staticCount}/${r.fallbackCount}`,
    );
  }
  console.log(`\n  errors=${errors.length}`);
  errors.slice(0, 6).forEach((e) => console.log(`    ERR: ${e}`));

  return result;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
