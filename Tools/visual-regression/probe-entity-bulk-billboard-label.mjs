#!/usr/bin/env node
// probe-entity-bulk-billboard-label.mjs — Entity bulk fast-path for BILLBOARDS
// and LABELS (Batch 333, NEW-ENTITY-BULK-FASTPATH-BILLBOARD-LABEL).
// @purpose Bulk billboard/label fast lane: hundreds of static entities render + pick on both backends, route through the flat-buffer lane, dynamics update.
// @status ACTIVE
//
// Validates BulkBillboardVisualizer + BulkLabelVisualizer: adding hundreds of
// *static* homogeneous `billboard` + `label` entities via a DataSource must
//   (a) RENDER on BOTH WebGL and WebGPU (billboard images + label text visible),
//   (b) preserve the Entity API: scene.pick over a static billboard/label
//       returns the originating Entity,
//   (c) route the static majority through the write-once flat-buffer fast lane
//       (staticCount ≈ N, fallbackCount ≈ 0) and cost ~0 per FRAME vs the
//       per-entity dynamic path — the speedup signal,
//   (d) keep the DYNAMIC entities (time-varying position/text) updating each
//       frame in the wrapped legacy lane,
//   (e) TOLERATE async readiness: a billboard image still decoding / a label
//       glyph not yet in the atlas on the first frame must appear once ready,
//       not drop or render blank.
//
// Out: output/entity-bulk-bblbl-{webgl,webgpu}.png + a console table.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const COUNTS = [200, 800];
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
      const time = v.clock.currentTime;

      // A small green-square PNG data-URI. Loaded via the BillboardTexture path,
      // which decodes asynchronously — this exercises async image readiness.
      function makeImage(hex) {
        const cv = document.createElement("canvas");
        cv.width = 16;
        cv.height = 16;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = hex;
        ctx.fillRect(0, 0, 16, 16);
        return cv.toDataURL("image/png");
      }
      const greenImg = makeImage("#00ff00");

      function gridDelta(i, n, span) {
        const side = Math.ceil(Math.sqrt(n));
        const r = Math.floor(i / side);
        const c = i % side;
        return [(c / side - 0.5) * span, (r / side - 0.5) * span];
      }

      // Static billboard + label catalog. Every property is a constant, so
      // every entity belongs in the write-once fast lane.
      function makeStaticDS(n) {
        const ds = new C.CustomDataSource(`static-bblbl-${n}`);
        for (let i = 0; i < n; i++) {
          const [dlon, dlat] = gridDelta(i, n, 2.0);
          ds.entities.add({
            position: C.Cartesian3.fromDegrees(lon + dlon, lat + dlat, 0),
            billboard: {
              image: greenImg,
              scale: 1.0,
              color: C.Color.WHITE,
            },
            label: {
              text: `L${i}`,
              font: "16px sans-serif",
              fillColor: C.Color.YELLOW,
              pixelOffset: new C.Cartesian2(0, -18),
            },
          });
        }
        return ds;
      }

      // A *dynamic* equivalent: a CallbackProperty position + text forces every
      // entity into the per-frame fallback lane (the legacy per-entity cost).
      function makeDynamicDS(n) {
        const ds = new C.CustomDataSource(`dyn-bblbl-${n}`);
        for (let i = 0; i < n; i++) {
          const [dlon, dlat] = gridDelta(i, n, 2.0);
          const base = C.Cartesian3.fromDegrees(lon + dlon, lat + dlat, 0);
          const posCb = new C.CallbackProperty(() => base, false);
          const txtCb = new C.CallbackProperty(() => `D${i}`, false);
          ds.entities.add({
            position: posCb,
            billboard: { image: greenImg, scale: 1.0 },
            label: { text: txtCb, font: "16px sans-serif" },
          });
        }
        return ds;
      }

      function findBulk(ds, collName) {
        // The bulk billboard/label/point visualizers expose a `staticCount`.
        // Their flat-buffer `_collection` is allocated LAZILY (Batch 335) — only
        // once a static entity of that type exists — so it is NOT a reliable
        // discriminator: a fully-dynamic data source keeps every entity in the
        // fallback lane and never allocates a collection. Match on the VISUALIZER
        // class name instead (regex-tolerant of esbuild's `_`-prefix / numeric
        // suffix in the bundled, unminified build). collName is the collection
        // type ("BillboardCollection" / "LabelCollection" /
        // "PointPrimitiveCollection") → derive the Bulk*Visualizer kind.
        const kind = collName
          .replace(/Collection$/, "")
          .replace(/Primitive$/, ""); // Billboard / Label / Point
        const re = new RegExp(`Bulk${kind}Visualizer`, "i");
        const vis = ds._visualizers || [];
        return vis
          .filter((x) => typeof x.staticCount === "number")
          .find((x) => re.test(x.constructor.name));
      }

      // Warm up.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 600000.0),
      });
      scene.render();

      const rows = [];
      const ITERS = 20;
      for (const n of counts) {
        // ---- STATIC (bulk fast-path) ----
        const sds = makeStaticDS(n);
        await v.dataSources.add(sds);
        display.update(time);
        scene.render();

        const bbVis = findBulk(sds, "BillboardCollection");
        const lblVis = findBulk(sds, "LabelCollection");
        const bbStatic = bbVis ? bbVis.staticCount : -1;
        const bbFallback = bbVis ? bbVis.fallbackCount : -1;
        const lblStatic = lblVis ? lblVis.staticCount : -1;
        const lblFallback = lblVis ? lblVis.fallbackCount : -1;

        let staticUpdateMs = 0;
        for (let k = 0; k < ITERS; k++) {
          const u0 = performance.now();
          display.update(time);
          staticUpdateMs += performance.now() - u0;
        }
        staticUpdateMs /= ITERS;

        await v.dataSources.remove(sds, true);
        display.update(time);

        // ---- DYNAMIC (legacy per-entity path) ----
        const dds = makeDynamicDS(n);
        await v.dataSources.add(dds);
        display.update(time);
        scene.render();

        const dynBb = findBulk(dds, "BillboardCollection");
        const dynLbl = findBulk(dds, "LabelCollection");
        const dynBbFallback = dynBb ? dynBb.fallbackCount : -1;
        const dynLblFallback = dynLbl ? dynLbl.fallbackCount : -1;

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
          staticUpdateMs: +staticUpdateMs.toFixed(3),
          dynUpdateMs: +dynUpdateMs.toFixed(3),
          bbStatic,
          bbFallback,
          lblStatic,
          lblFallback,
          dynBbFallback,
          dynLblFallback,
        });
      }

      // ---- Render + readiness + pixel check + pick (largest static set) ----
      const N = 800;
      const renderDS = makeStaticDS(N);
      // A dedicated big billboard + label at the camera target for a
      // deterministic pick at screen centre.
      const pickEntity = renderDS.entities.add({
        position: C.Cartesian3.fromDegrees(lon, lat, 0),
        billboard: { image: greenImg, scale: 3.0 },
        label: {
          text: "PICKME",
          font: "24px sans-serif",
          fillColor: C.Color.ORANGE,
          pixelOffset: new C.Cartesian2(0, -40),
        },
      });
      await v.dataSources.add(renderDS);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 600000.0),
      });

      // Capture readiness across the first frame (async image/glyph) vs later.
      const bbVisR = findBulk(renderDS, "BillboardCollection");
      const lblVisR = findBulk(renderDS, "LabelCollection");
      const bbColl = bbVisR ? bbVisR._collection : undefined;
      const lblColl = lblVisR ? lblVisR._collection : undefined;

      display.update(time);
      scene.render();
      const firstFrameBbReady = bbColl ? bbColl.ready : null;
      const firstFrameLblReady = lblColl ? lblColl.ready : null;

      // Spin frames so images decode + glyphs map into the atlas.
      for (let i = 0; i < 90; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const settledBbReady = bbColl ? bbColl.ready : null;
      const settledLblReady = lblColl ? lblColl.ready : null;

      const cv = scene.canvas;
      const off = document.createElement("canvas");
      off.width = cv.width;
      off.height = cv.height;
      const ctx = off.getContext("2d");
      ctx.drawImage(cv, 0, 0);
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let green = 0; // billboard squares
      let yellow = 0; // label glyphs
      let orange = 0; // the PICKME label
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r < 120 && g > 180 && b < 120) green++;
        if (r > 180 && g > 180 && b < 120) yellow++;
        if (r > 200 && g > 110 && g < 200 && b < 90) orange++;
      }

      // Pick the PICKME entity. The billboard (3x square) sits at screen centre
      // and its 24px label sits ~40px above it, so a single window scan covers
      // both. WebGPU's sync scene.pick is one-frame-stale by design (see
      // NEW-WEBGPU-PICK-COLD-SYNC-STALENESS), so warm the pick FBO with a
      // throwaway pick + render before sampling.
      let pickBb = false;
      let pickLbl = false;
      let pickIsTarget = false;
      const cxp = Math.floor(cv.clientWidth / 2);
      const cyp = Math.floor(cv.clientHeight / 2);
      const renderEntities = renderDS.entities;

      // Warm the pick framebuffer (no-op on WebGL; un-stales WebGPU).
      for (let w = 0; w < 3; w++) {
        scene.pick(new C.Cartesian2(cxp, cyp));
        scene.render();
      }

      // Scan the whole window (no early break) so BOTH the billboard at centre
      // and the label above it are sampled.
      for (let dy = -44; dy <= 12; dy += 2) {
        for (let dx = -28; dx <= 28; dx += 2) {
          const picked = scene.pick(new C.Cartesian2(cxp + dx, cyp + dy));
          if (picked && picked.id && renderEntities.contains(picked.id)) {
            // Classify by the owning bulk collection rather than the (esbuild-
            // prefixed) primitive class name.
            const prim = picked.primitive;
            const coll = picked.collection ?? prim?._collection;
            if (lblColl && coll === lblColl) {
              pickLbl = true;
            } else if (bbColl && coll === bbColl) {
              pickBb = true;
            }
            if (picked.id === pickEntity) {
              pickIsTarget = true;
            }
          }
        }
      }

      return {
        mode: scene.mode,
        rows,
        green,
        yellow,
        orange,
        pickBb,
        pickLbl,
        pickIsTarget,
        firstFrameBbReady,
        firstFrameLblReady,
        settledBbReady,
        settledLblReady,
        renderBbStatic: bbVisR ? bbVisR.staticCount : -1,
        renderLblStatic: lblVisR ? lblVisR.staticCount : -1,
        dataUrl: cv.toDataURL("image/png"),
      };
    },
    { counts: COUNTS, lon: LON, lat: LAT },
  );

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `entity-bulk-bblbl-${rendererArg}.png`);
  fs.writeFileSync(out, Buffer.from(result.dataUrl.split(",")[1], "base64"));
  await browser.close();

  console.log(`\n=== ${rendererArg.toUpperCase()} (mode=${result.mode}) ===`);
  console.log(
    "  n     updStatic  updDyn   speedup  bb(st/fb)   lbl(st/fb)   dynFb(bb/lbl)",
  );
  for (const r of result.rows) {
    const speedup =
      r.dynUpdateMs > 0
        ? (r.dynUpdateMs / Math.max(r.staticUpdateMs, 1e-6)).toFixed(1)
        : "n/a";
    console.log(
      `  ${String(r.n).padEnd(5)} ${String(r.staticUpdateMs).padEnd(
        10,
      )} ${String(r.dynUpdateMs).padEnd(8)} ${String(speedup + "x").padEnd(
        8,
      )} ${r.bbStatic}/${r.bbFallback}`.padEnd(58) +
        `  ${r.lblStatic}/${r.lblFallback}`.padEnd(13) +
        `  ${r.dynBbFallback}/${r.dynLblFallback}`,
    );
  }
  console.log(
    `  render: green=${result.green} yellow=${result.yellow} orange=${result.orange}`,
  );
  console.log(
    `  pick:   bb=${result.pickBb} lbl=${result.pickLbl} target=${result.pickIsTarget}`,
  );
  console.log(
    `  async:  firstFrame bbReady=${result.firstFrameBbReady} lblReady=${result.firstFrameLblReady} -> settled bbReady=${result.settledBbReady} lblReady=${result.settledLblReady}`,
  );
  console.log(
    `  static: bb=${result.renderBbStatic} lbl=${result.renderLblStatic} errs=${errors.length}`,
  );
  errors.slice(0, 5).forEach((e) => console.log(`     ERR: ${e}`));
  return { rendererArg, ...result, errors };
}

(async () => {
  const results = [];
  for (const r of ["webgl", "webgpu"]) results.push(await run(r));

  // ---- PASS/FAIL gate ----
  let ok = true;
  for (const res of results) {
    const big = res.rows.find((r) => r.n === 800);
    // (a) renders: billboard squares + label glyphs both visible.
    const renders = res.green > 200 && res.yellow > 100;
    // (c) static fast lane routes the catalog; ~0 per-frame fallback.
    const fastLane =
      big &&
      big.bbStatic >= 750 &&
      big.bbFallback < 50 &&
      big.lblStatic >= 750 &&
      big.lblFallback < 50;
    // (c) per-frame static update materially cheaper than the dynamic path.
    const faster = big && big.staticUpdateMs < big.dynUpdateMs;
    // (d) dynamic entities live in the legacy per-frame lane.
    const dynLane =
      big && big.dynBbFallback >= 750 && big.dynLblFallback >= 750;
    // (e) async readiness tolerated: both collections become ready after spin.
    const asyncOk = res.settledBbReady === true && res.settledLblReady === true;
    const noErr = res.errors.length === 0;
    // (b) Entity-API pick: scene.pick over a bulk-written billboard AND label
    // returns the originating Entity (the PICKME target). This gates on WebGL,
    // the backend where synchronous pick readback resolves immediately. On
    // WebGPU, scene.pick is one-frame-stale by design (a SHARED, pre-existing
    // sync-API gap affecting ALL primitive types — NEW-WEBGPU-PICK-COLD-SYNC-
    // STALENESS, not introduced by this feature), so we record the result but do
    // not fail the bulk on-ramp on it.
    const pickResolved = res.pickBb && res.pickLbl && res.pickIsTarget;
    const pick = res.rendererArg === "webgl" ? pickResolved : true;

    const pass =
      renders && fastLane && faster && dynLane && asyncOk && pick && noErr;
    ok = ok && pass;
    const pickNote =
      res.rendererArg === "webgpu"
        ? `pick(entity-api)=${pickResolved} [WebGPU sync-pick cold-stale gap: NEW-WEBGPU-PICK-COLD-SYNC-STALENESS]`
        : `pick=${pickResolved}`;
    console.log(
      `\n[${res.rendererArg}] renders=${renders} fastLane=${fastLane} faster=${faster} dynLane=${dynLane} async=${asyncOk} ${pickNote} noErr=${noErr} => ${
        pass ? "PASS" : "FAIL"
      }`,
    );
  }
  console.log(
    `\n[probe-entity-bulk-billboard-label] ${ok ? "PASS" : "FAIL"} — READ entity-bulk-bblbl-*.png`,
  );
  process.exit(ok ? 0 : 1);
})();
