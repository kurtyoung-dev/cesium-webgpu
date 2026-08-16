#!/usr/bin/env node
// probe-entity-bulk.mjs — Phase 10 Entity bulk fast-path (Batch 300).
// @purpose BulkPointVisualizer fast lane: tens of thousands of static points render on both backends, pick returns the Entity, per-frame cost drops.
// @status ACTIVE
//
// Validates BulkPointVisualizer: adding tens of thousands of *static*
// homogeneous `point` entities via a DataSource/EntityCollection must
//   (1) render on BOTH WebGL and WebGPU,
//   (2) route the static majority through the write-once flat-buffer fast lane
//       (staticCount ≈ N, fallbackCount ≈ 0) and cost materially less per
//       FRAME than the per-entity (dynamic) path — instrumented as an
//       entity-count vs per-frame DataSourceDisplay.update() comparison,
//   (3) preserve the Entity API: scene.pick over a point returns the Entity.
//
// Out: output/entity-bulk-{webgl,webgpu}.png + a console table.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const COUNTS = [1000, 5000, 20000];
const LON = -75.0;
const LAT = 40.0;

async function run(rendererArg) {
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
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ counts, lon, lat }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.requestRenderMode = false;
      const display = v.dataSourceDisplay;

      // Spread points in a grid around (lon,lat) at a fixed altitude.
      function makeStaticDS(n, color) {
        const ds = new C.CustomDataSource(`static-${n}`);
        const side = Math.ceil(Math.sqrt(n));
        const span = 2.0; // degrees
        for (let i = 0; i < n; i++) {
          const r = Math.floor(i / side);
          const c = i % side;
          const dlon = (c / side - 0.5) * span;
          const dlat = (r / side - 0.5) * span;
          ds.entities.add({
            position: C.Cartesian3.fromDegrees(lon + dlon, lat + dlat, 0),
            point: {
              pixelSize: 6,
              color: color, // ConstantProperty → static
            },
          });
        }
        return ds;
      }

      // A *dynamic* equivalent: a CallbackProperty color forces every entity
      // into the per-frame fallback lane (the legacy per-entity cost).
      function makeDynamicDS(n) {
        const ds = new C.CustomDataSource(`dyn-${n}`);
        const side = Math.ceil(Math.sqrt(n));
        const span = 2.0;
        const cb = new C.CallbackProperty(() => C.Color.CYAN, false);
        for (let i = 0; i < n; i++) {
          const r = Math.floor(i / side);
          const c = i % side;
          const dlon = (c / side - 0.5) * span;
          const dlat = (r / side - 0.5) * span;
          ds.entities.add({
            position: C.Cartesian3.fromDegrees(lon + dlon, lat + dlat, 0),
            point: { pixelSize: 6, color: cb },
          });
        }
        return ds;
      }

      function findBulkVisualizer(ds) {
        // The BulkPointVisualizer exposes a `staticCount`, but its flat-buffer
        // `_collection` is allocated LAZILY (Batch 335) — only once a static
        // point entity exists — so a fully-dynamic (or zero-static) data source
        // keeps every entity in the fallback lane and never allocates a
        // collection. Match on the VISUALIZER CLASS NAME (regex-tolerant of
        // esbuild's `_`-prefix / numeric suffix in the bundled, unminified
        // build), NOT on `_collection`, so the dynamic-DS visualizer is still
        // found (dynFallback/dynStatic report correctly instead of -1/-1).
        const re = /BulkPointVisualizer/i;
        const vis = ds._visualizers || [];
        return vis
          .filter((x) => typeof x.staticCount === "number")
          .find((x) => re.test(x.constructor.name));
      }

      const time = v.clock.currentTime;

      // Warm up render once.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 600000.0),
      });
      scene.render();

      const rows = [];
      for (const n of counts) {
        // ---- STATIC (bulk fast-path) ----
        const t0 = performance.now();
        const sds = makeStaticDS(n, C.Color.YELLOW);
        await v.dataSources.add(sds);
        const setupStatic = performance.now() - t0;

        // Force one display update so the visualizers process the new entities.
        display.update(time);
        scene.render();

        const bulkVis = findBulkVisualizer(sds);
        const staticCount = bulkVis ? bulkVis.staticCount : -1;
        const fallbackCount = bulkVis ? bulkVis.fallbackCount : -1;

        // Per-frame update cost for the static set (averaged).
        let staticUpdateMs = 0;
        const ITERS = 20;
        for (let k = 0; k < ITERS; k++) {
          const u0 = performance.now();
          display.update(time);
          staticUpdateMs += performance.now() - u0;
        }
        staticUpdateMs /= ITERS;

        await v.dataSources.remove(sds, true);
        display.update(time);

        // ---- DYNAMIC (legacy per-entity path) ----
        const d0 = performance.now();
        const dds = makeDynamicDS(n);
        await v.dataSources.add(dds);
        const setupDyn = performance.now() - d0;
        display.update(time);
        scene.render();

        const dynVis = findBulkVisualizer(dds);
        const dynFallback = dynVis ? dynVis.fallbackCount : -1;
        const dynStatic = dynVis ? dynVis.staticCount : -1;

        let dynUpdateMs = 0;
        for (let k = 0; k < ITERS; k++) {
          const u0 = performance.now();
          display.update(time);
          dynUpdateMs += performance.now() - u0;
        }
        dynUpdateMs /= ITERS;

        await v.dataSources.remove(dds, true);
        display.update(time);

        rows.push({
          n,
          setupStatic: +setupStatic.toFixed(2),
          setupDyn: +setupDyn.toFixed(2),
          staticUpdateMs: +staticUpdateMs.toFixed(3),
          dynUpdateMs: +dynUpdateMs.toFixed(3),
          staticCount,
          fallbackCount,
          dynFallback,
          dynStatic,
        });
      }

      // ---- Render + pixel check + pick (use the largest static set) ----
      const renderDS = makeStaticDS(20000, C.Color.YELLOW);
      // Add one big static point exactly at the camera target so the pick test
      // has a deterministic on-screen target (the bulk grid is sparse at this
      // altitude and a small pick window can land between 6px points).
      const pickEntity = renderDS.entities.add({
        position: C.Cartesian3.fromDegrees(lon, lat, 0),
        point: { pixelSize: 40, color: C.Color.ORANGE },
      });
      await v.dataSources.add(renderDS);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 600000.0),
      });
      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const cv = scene.canvas;
      const off = document.createElement("canvas");
      off.width = cv.width;
      off.height = cv.height;
      const ctx = off.getContext("2d");
      ctx.drawImage(cv, 0, 0);
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let yellow = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] < 120) yellow++;
      }

      // Pick: walk a small window around centre until we hit one of our points
      // (the dedicated 40px ORANGE point sits at screen centre).
      let pickedIsEntity = false;
      let pickedHasPoint = false;
      let pickedIsPickEntity = false;
      const cxp = Math.floor(cv.clientWidth / 2);
      const cyp = Math.floor(cv.clientHeight / 2);
      const renderEntities = renderDS.entities;
      outer: for (let dy = -20; dy <= 20 && !pickedIsEntity; dy += 2) {
        for (let dx = -20; dx <= 20; dx += 2) {
          const picked = scene.pick(new C.Cartesian2(cxp + dx, cyp + dy));
          if (picked && picked.id) {
            const id = picked.id;
            // id should be the Entity itself.
            if (renderEntities.contains(id)) {
              pickedIsEntity = true;
              pickedHasPoint = !!id.point;
              pickedIsPickEntity = id === pickEntity;
              break outer;
            }
          }
        }
      }

      const bulkVis = findBulkVisualizer(renderDS);

      return {
        mode: scene.mode,
        rows,
        yellow,
        pickedIsEntity,
        pickedHasPoint,
        pickedIsPickEntity,
        renderStaticCount: bulkVis ? bulkVis.staticCount : -1,
        dataUrl: cv.toDataURL("image/png"),
      };
    },
    { counts: COUNTS, lon: LON, lat: LAT },
  );

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `entity-bulk-${rendererArg}.png`);
  fs.writeFileSync(out, Buffer.from(result.dataUrl.split(",")[1], "base64"));
  await browser.close();

  console.log(`\n=== ${rendererArg.toUpperCase()} ===`);
  console.log(
    "  n      setupStatic  setupDyn   updStatic  updDyn    speedup  static/fb",
  );
  for (const r of result.rows) {
    const speedup =
      r.dynUpdateMs > 0
        ? (r.dynUpdateMs / Math.max(r.staticUpdateMs, 1e-6)).toFixed(1)
        : "n/a";
    console.log(
      `  ${String(r.n).padEnd(6)} ${String(r.setupStatic).padEnd(11)} ${String(
        r.setupDyn,
      ).padEnd(9)} ${String(r.staticUpdateMs).padEnd(10)} ${String(
        r.dynUpdateMs,
      ).padEnd(
        9,
      )} ${String(speedup + "x").padEnd(8)} ${r.staticCount}/${r.fallbackCount} (dyn fb=${r.dynFallback})`,
    );
  }
  console.log(
    `  render: yellow=${result.yellow} staticCount=${result.renderStaticCount} pickEntity=${result.pickedIsEntity} pickHasPoint=${result.pickedHasPoint} pickIsTarget=${result.pickedIsPickEntity} errs=${errors.length}`,
  );
  errors.slice(0, 4).forEach((e) => console.log(`     ERR: ${e}`));
  return { rendererArg, ...result, errors };
}

(async () => {
  const results = [];
  for (const r of ["webgl", "webgpu"]) results.push(await run(r));

  // ---- PASS/FAIL gate ----
  // The bulk fast-path itself (render + per-frame perf + static-lane routing +
  // Entity-API pick) must pass on every backend that SUPPORTS point picking.
  // WebGPU `scene.pick` over a PointPrimitiveCollection is a SEPARATE, pre-
  // existing gap (the renderer pushes a pick command, but the pick readback
  // returns null for instanced point quads — tracked as
  // NEW-WEBGPU-POINT-COLLECTION-PICK in DEFERRED_WORK). It is NOT introduced by
  // this feature and applies equally to a raw PointPrimitiveCollection added to
  // scene.primitives, so it does not gate the bulk on-ramp here.
  let ok = true;
  for (const res of results) {
    const big = res.rows.find((r) => r.n === 20000);
    const renders = res.yellow > 200;
    const fastLane = big && big.staticCount >= 19000 && big.fallbackCount < 100;
    const dynLane = big && big.dynFallback >= 19000;
    const faster = big && big.staticUpdateMs < big.dynUpdateMs;
    const noErr = res.errors.length === 0;
    // Pick-returns-Entity only gates on WebGL (the backend where point picking
    // works). On WebGPU we record the gap but do not fail the on-ramp.
    const pick =
      res.rendererArg === "webgl"
        ? res.pickedIsEntity && res.pickedHasPoint
        : true;
    const pass = renders && fastLane && dynLane && faster && pick && noErr;
    ok = ok && pass;
    const pickNote =
      res.rendererArg === "webgpu"
        ? `pick(entity-api)=${res.pickedIsEntity} [WebGPU point-collection pick gap: NEW-WEBGPU-POINT-COLLECTION-PICK]`
        : `pick=${res.pickedIsEntity}`;
    console.log(
      `\n[${res.rendererArg}] renders=${renders} fastLane=${fastLane} dynLane=${dynLane} faster=${faster} ${pickNote} noErr=${noErr} => ${pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(
    `\n[probe-entity-bulk] ${ok ? "PASS" : "FAIL"} — READ entity-bulk-*.png`,
  );
  process.exit(ok ? 0 : 1);
})();
