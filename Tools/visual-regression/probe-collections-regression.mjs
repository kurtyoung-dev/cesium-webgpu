#!/usr/bin/env node
// Probe (NEW-COLLECTION-RETOUCH-PROBE — THE consolidated collections gate):
// @purpose THE consolidated collections gate: five collections render, settled scenes upload nothing, mutations repaint in 2 frames, 0 errors.
// @status ACTIVE
//
// all five collections (Billboard, Label, PointPrimitive, Polyline, Cloud)
// in ONE scene at a close camera (~11 km, inside the depth-precision
// envelope — see the GEOMETRY NOTE in probe-billboard-partial-write.mjs),
// globe/sky hidden so per-collection saturated-color pixel counts are
// deterministic against black. Five checks:
//
//   (1) RENDER — every collection produces saturated pixels of ITS color:
//       billboard=MAGENTA, point=CYAN, label=YELLOW, polyline=RED,
//       cloud=GREEN (CumulusCloud.color tints the noise FS, so cloud
//       pixels are exactly (0, g, 0) over black).
//   (2) SETTLED RE-TOUCH — monkeypatch each collection's per-primitive
//       dirty entry point (_updateBillboard / glyph+background
//       _updateBillboard for labels / _updatePointPrimitive /
//       _updatePolyline / _updateCloud) → 0 calls TOTAL over 20 settled
//       frames. This is the Phase-0 dirty-consume contract (Batches
//       226-228): a static scene must stop re-touching primitives.
//   (3) UPLOAD GATE — the resident-instance managers' debug counters
//       (billboard + point `_webgpuCache.instanceManager`, label
//       `_webgpuLabelCache.sdfInstanceManager`) show 0 full rebuilds,
//       0 partial writes, 0 bytes over the same 20 settled frames
//       (Batch 229/232 manager wirings — settled scenes upload NOTHING).
//   (4) MUTATE — move/repoint one primitive of EACH kind into its own
//       empty screen window → its color appears there within 2 frames
//       (no stale renders; the dirty lifecycle re-arms after consume).
//   (5) 0 console errors (incl. WebGPU validation errors — a count=1
//       pipeline in the MSAA scene pass kills the whole pass, so any
//       per-collection pipeline regression surfaces here).
//
// This probe is THE collections regression gate: run it after ANY change
// near the collection renderers, the dirty lifecycle, or the
// resident-instance manager.
//
// Usage: node Tools/visual-regression/probe-collections-regression.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/collections-regression-{before,after}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  v.clock.shouldAnimate = false;

  // Black background — saturated-color thresholds with no imagery noise.
  scene.globe.show = false;
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
  // Deterministic readback INSIDE scene.postRender — present clears the
  // WebGPU canvas texture, so readback in a later task is racy.
  const snap = (withPng) =>
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
          png: withPng ? off.toDataURL("image/png") : null,
        });
      });
      scene.render();
    });

  // Per-collection color predicates — mutually exclusive by construction:
  //   magenta: r+b high, g low      cyan: g+b high, r low
  //   yellow: r+g high, b low (SDF antialiasing dims label cores — lower floor)
  //   red: r high, g+b low          green: g only (cloud FS emits (0,g,0)*alpha)
  const isMagenta = (d, i) => d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 90;
  const isCyan = (d, i) => d[i + 1] > 180 && d[i + 2] > 180 && d[i] < 90;
  const isYellow = (d, i) => d[i] > 140 && d[i + 1] > 140 && d[i + 2] < 90;
  const isRed = (d, i) => d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90;
  const isGreen = (d, i) => d[i + 1] > 60 && d[i] < 40 && d[i + 2] < 40;
  const countAll = (img, pred) => {
    let n = 0;
    for (let p = 0; p < img.w * img.h; p++) {
      if (pred(img.data, 4 * p)) n++;
    }
    return n;
  };
  const countIn = (img, pred, x0, y0, x1, y1) => {
    let n = 0;
    const xa = Math.max(0, Math.floor(x0));
    const ya = Math.max(0, Math.floor(y0));
    const xb = Math.min(img.w, Math.ceil(x1));
    const yb = Math.min(img.h, Math.ceil(y1));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        if (pred(img.data, 4 * (y * img.w + x))) n++;
      }
    }
    return n;
  };

  // ---- Scene: five collections in distinct screen bands ----------------
  // Camera at (-74.985, 40.012, 11 km) looking straight down. Footprint
  // ~0.149 deg lon x ~0.078 deg lat. South band: billboard/point/label
  // clusters; north band: polylines; top band: clouds; the middle band
  // (~lat 40.005-40.016) stays EMPTY — it's the mutation destination area.
  const LON = -75.0;
  const LAT = 40.0;

  // Billboards — 100 magenta (16x16 white canvas tinted).
  const img16 = document.createElement("canvas");
  img16.width = 16;
  img16.height = 16;
  img16.getContext("2d").fillStyle = "#ffffff";
  img16.getContext("2d").fillRect(0, 0, 16, 16);
  const bbs = scene.primitives.add(new C.BillboardCollection());
  for (let i = 0; i < 100; i++) {
    bbs.add({
      position: C.Cartesian3.fromDegrees(
        LON - 0.05 + 0.0008 * (i % 10),
        LAT - 0.02 + 0.0006 * Math.floor(i / 10),
        1000.0,
      ),
      image: img16,
      color: C.Color.MAGENTA,
    });
  }

  // Points — 100 cyan.
  const pts = scene.primitives.add(new C.PointPrimitiveCollection());
  for (let i = 0; i < 100; i++) {
    pts.add({
      position: C.Cartesian3.fromDegrees(
        LON - 0.005 + 0.0008 * (i % 10),
        LAT - 0.02 + 0.0006 * Math.floor(i / 10),
        1000.0,
      ),
      pixelSize: 8,
      color: C.Color.CYAN,
    });
  }

  // Labels — 36 yellow digits (small glyph set so the SDF atlas settles).
  const labels = scene.primitives.add(new C.LabelCollection());
  for (let i = 0; i < 36; i++) {
    labels.add({
      position: C.Cartesian3.fromDegrees(
        LON + 0.038 + 0.002 * (i % 6),
        LAT - 0.02 + 0.0012 * Math.floor(i / 6),
        1000.0,
      ),
      text: String(i % 10),
      font: "24px sans-serif",
      fillColor: C.Color.YELLOW,
      outlineWidth: 0,
      style: C.LabelStyle.FILL,
      verticalOrigin: C.VerticalOrigin.CENTER,
      horizontalOrigin: C.HorizontalOrigin.LEFT,
    });
  }

  // Polylines — 4 red lines spanning the view in the north-middle band.
  const pls = scene.primitives.add(new C.PolylineCollection());
  for (let i = 0; i < 4; i++) {
    pls.add({
      positions: [
        C.Cartesian3.fromDegrees(LON - 0.05, LAT + 0.018 + 0.003 * i, 1000.0),
        C.Cartesian3.fromDegrees(LON + 0.06, LAT + 0.018 + 0.003 * i, 1000.0),
      ],
      width: 6,
      material: C.Material.fromType("Color", { color: C.Color.RED }),
    });
  }

  // Clouds — 3 green-tinted cumulus, top band LEFT half. NOTE the
  // altitude-dependent frustum: at 5 km altitude (6 km from the camera)
  // the visible footprint shrinks to ~lat 40.012±0.021 / lon -74.985
  // ±0.041 — cloud lat/lon must stay INSIDE that, not the ground
  // footprint (first iteration put them at lat 40.044 → cut off at the
  // top edge and the mutation window clamped to nothing).
  const clouds = scene.primitives.add(new C.CloudCollection());
  for (let i = 0; i < 3; i++) {
    clouds.add({
      position: C.Cartesian3.fromDegrees(-75.018 + 0.012 * i, 40.028, 5000.0),
      scale: new C.Cartesian2(150, 100),
      color: C.Color.GREEN,
    });
  }

  scene.morphTo3D(0);
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-74.985, 40.012, 11000.0),
    orientation: { heading: 0.0, pitch: -Math.PI / 2, roll: 0.0 },
  });

  // ---- Warmup / settle --------------------------------------------------
  // Atlas + SDF rasterization, cloud noise texture, async pipeline resolve,
  // readiness dirty churn. Settle = all three managers exist, their
  // counters AND the cloud instance-buffer identity are stable for 10
  // consecutive frames, and every billboard image is ready (cap 300).
  let bbMgr = null;
  let ptMgr = null;
  let lblMgr = null;
  let settled = 0;
  let last = null;
  let lastCloudBuf = null;
  let warmupFrames = 0;
  for (; warmupFrames < 300 && settled < 10; warmupFrames++) {
    await frame(1);
    bbMgr = bbs._webgpuCache?.instanceManager ?? null;
    ptMgr = pts._webgpuCache?.instanceManager ?? null;
    lblMgr = labels._webgpuLabelCache?.sdfInstanceManager ?? null;
    if (!bbMgr || !ptMgr || !lblMgr) continue;
    const cloudBuf = clouds._webgpuCache?.instanceBuffer ?? null;
    const cur = [
      bbMgr._fullRebuilds,
      bbMgr._partialWrites,
      ptMgr._fullRebuilds,
      ptMgr._partialWrites,
      lblMgr._fullRebuilds,
      lblMgr._partialWrites,
    ].join(",");
    if (cur === last && cloudBuf === lastCloudBuf && bbs._allBillboardsReady) {
      settled++;
    } else {
      settled = 0;
      last = cur;
      lastCloudBuf = cloudBuf;
    }
  }
  if (!bbMgr) return { fatal: "billboard instanceManager never appeared" };
  if (!ptMgr) return { fatal: "point instanceManager never appeared" };
  if (!lblMgr) return { fatal: "label sdfInstanceManager never appeared" };
  if (settled < 10) return { fatal: `never settled (warmup=${warmupFrames})` };

  // ---- (2)+(3): settled re-touch + upload gate over 20 frames -----------
  const counts = { billboard: 0, label: 0, point: 0, polyline: 0, cloud: 0 };
  const glyphs = labels._glyphBillboardCollection;
  const bgs = labels._backgroundBillboardCollection;
  const origs = [
    [bbs, "_updateBillboard", "billboard"],
    [glyphs, "_updateBillboard", "label"],
    [bgs, "_updateBillboard", "label"],
    [pts, "_updatePointPrimitive", "point"],
    [pls, "_updatePolyline", "polyline"],
    [clouds, "_updateCloud", "cloud"],
  ].map(([obj, name, key]) => {
    const orig = obj[name].bind(obj);
    obj[name] = function (...args) {
      counts[key]++;
      return orig(...args);
    };
    return [obj, name, orig];
  });

  const u0 = {
    bbFull: bbMgr._fullRebuilds,
    bbPartial: bbMgr._partialWrites,
    bbBytes: bbMgr._bytesUploaded,
    ptFull: ptMgr._fullRebuilds,
    ptPartial: ptMgr._partialWrites,
    ptBytes: ptMgr._bytesUploaded,
    lblFull: lblMgr._fullRebuilds,
    lblPartial: lblMgr._partialWrites,
    lblBytes: lblMgr._bytesUploaded,
  };
  await frame(20);
  const uploads = {
    bbFull: bbMgr._fullRebuilds - u0.bbFull,
    bbPartial: bbMgr._partialWrites - u0.bbPartial,
    bbBytes: bbMgr._bytesUploaded - u0.bbBytes,
    ptFull: ptMgr._fullRebuilds - u0.ptFull,
    ptPartial: ptMgr._partialWrites - u0.ptPartial,
    ptBytes: ptMgr._bytesUploaded - u0.ptBytes,
    lblFull: lblMgr._fullRebuilds - u0.lblFull,
    lblPartial: lblMgr._partialWrites - u0.lblPartial,
    lblBytes: lblMgr._bytesUploaded - u0.lblBytes,
  };
  for (const [obj, name, orig] of origs) {
    obj[name] = orig;
  }

  // ---- (1): render check + before-mutation window baselines -------------
  const before = await snap(true);
  const renders = {
    billboard: countAll(before, isMagenta),
    point: countAll(before, isCyan),
    label: countAll(before, isYellow),
    polyline: countAll(before, isRed),
    cloud: countAll(before, isGreen),
  };

  // Mutation destinations — middle band, far apart on screen.
  const destBB = C.Cartesian3.fromDegrees(-75.045, 40.008, 1000.0);
  const destPT = C.Cartesian3.fromDegrees(-75.0, 40.008, 1000.0);
  const destLBL = C.Cartesian3.fromDegrees(-74.955, 40.008, 1000.0);
  const destPLmid = C.Cartesian3.fromDegrees(-74.985, 40.012, 1000.0);
  const destCLOUD = C.Cartesian3.fromDegrees(-74.96, 40.028, 5000.0);
  const winOf = (pos) => scene.cartesianToCanvasCoordinates(pos);
  const windows = {
    billboard: { pos: destBB, pred: isMagenta, hx: 25, hy: 25 },
    point: { pos: destPT, pred: isCyan, hx: 25, hy: 25 },
    label: { pos: destLBL, pred: isYellow, hx0: 10, hx: 60, hy: 30 },
    polyline: { pos: destPLmid, pred: isRed, hx: 25, hy: 25 },
    cloud: { pos: destCLOUD, pred: isGreen, hx: 40, hy: 40 },
  };
  const winCount = (img, w) => {
    const c = winOf(w.pos);
    if (!c) return -1;
    return countIn(
      img,
      w.pred,
      c.x - (w.hx0 ?? w.hx),
      c.y - w.hy,
      c.x + w.hx,
      c.y + w.hy,
    );
  };
  const beforeWin = {};
  for (const k of Object.keys(windows))
    beforeWin[k] = winCount(before, windows[k]);

  // ---- (4): mutate one primitive of each kind → updated within 2 frames -
  bbs.get(0).position = destBB;
  pts.get(0).position = destPT;
  labels.get(0).position = destLBL;
  pls.get(0).positions = [
    C.Cartesian3.fromDegrees(-75.05, 40.012, 1000.0),
    C.Cartesian3.fromDegrees(-74.92, 40.012, 1000.0),
  ];
  clouds.get(0).position = destCLOUD;

  await frame(1);
  const after = await snap(true); // snap renders frame 2 post-mutation
  const afterWin = {};
  for (const k of Object.keys(windows))
    afterWin[k] = winCount(after, windows[k]);

  return {
    warmupFrames,
    visible: {
      billboard: bbMgr.lastVisibleCount,
      point: ptMgr.lastVisibleCount,
      labelGlyphs: lblMgr.lastVisibleCount,
    },
    counts,
    uploads,
    renders,
    beforeWin,
    afterWin,
    pngBefore: before.png,
    pngAfter: after.png,
  };
});

if (out.fatal) {
  console.log(`FATAL: ${out.fatal}`);
  await browser.close();
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, png] of [
  ["before", out.pngBefore],
  ["after", out.pngAfter],
]) {
  fs.writeFileSync(
    path.join(OUT_DIR, `collections-regression-${name}.png`),
    Buffer.from(png.replace(/^data:image\/png;base64,/, ""), "base64"),
  );
}

const r = out.renders;
// cloud gate re-baselined 100->50 in Batch 366 (NEW-WEBGPU-CLOUD-SIZE-PARITY):
// the cloud quad was 2x too wide, so the old gate was calibrated against an
// oversized cloud. With the *0.5 half-extent fix the 3 small clouds now render
// ~85 green px (correct, WebGL-matching size); 50 keeps a "clouds render" gate
// with margin while reflecting the corrected footprint.
const renderMin = {
  billboard: 500,
  point: 300,
  label: 150,
  polyline: 500,
  cloud: 50,
};
const c1 = Object.keys(renderMin).every((k) => r[k] > renderMin[k]);
const c2 = Object.values(out.counts).every((n) => n === 0);
const c3 = Object.values(out.uploads).every((n) => n === 0);
const mutMin = { billboard: 20, point: 8, label: 5, polyline: 10, cloud: 15 };
const c4 = Object.keys(mutMin).every(
  (k) => out.beforeWin[k] === 0 && out.afterWin[k] > mutMin[k],
);
const relevantErrors = errors.filter(
  (message) =>
    message !== "RequestErrorEvent" &&
    !message.includes("net::ERR_NETWORK_ACCESS_DENIED"),
);
const c5 = relevantErrors.length === 0;

console.log(
  `settle: ${out.warmupFrames} warmup frames; visible bb=${out.visible.billboard} pt=${out.visible.point} glyphs=${out.visible.labelGlyphs}`,
);
console.log(
  `(1) renders: bb(magenta)=${r.billboard}/${renderMin.billboard} pt(cyan)=${r.point}/${renderMin.point} lbl(yellow)=${r.label}/${renderMin.label} pl(red)=${r.polyline}/${renderMin.polyline} cloud(green)=${r.cloud}/${renderMin.cloud} ${c1 ? "OK" : "FAIL"}`,
);
console.log(
  `(2) settled re-touch over 20 frames: bb=${out.counts.billboard} lbl=${out.counts.label} pt=${out.counts.point} pl=${out.counts.polyline} cloud=${out.counts.cloud} (all must be 0) ${c2 ? "OK" : "FAIL"}`,
);
const u = out.uploads;
console.log(
  `(3) upload gate over same 20 frames: bb full/partial/bytes=${u.bbFull}/${u.bbPartial}/${u.bbBytes} pt=${u.ptFull}/${u.ptPartial}/${u.ptBytes} lbl=${u.lblFull}/${u.lblPartial}/${u.lblBytes} (all 0) ${c3 ? "OK" : "FAIL"}`,
);
console.log(
  `(4) mutation lands within 2 frames (window before->after): bb=${out.beforeWin.billboard}->${out.afterWin.billboard} pt=${out.beforeWin.point}->${out.afterWin.point} lbl=${out.beforeWin.label}->${out.afterWin.label} pl=${out.beforeWin.polyline}->${out.afterWin.polyline} cloud=${out.beforeWin.cloud}->${out.afterWin.cloud} ${c4 ? "OK" : "FAIL"}`,
);
console.log(
  `(5) console errors: ${relevantErrors.length} ${c5 ? "OK" : "FAIL"}` +
    ` (ignored Viewer boot network errors: ${errors.length - relevantErrors.length})`,
);
relevantErrors
  .slice(0, 8)
  .forEach((e) => console.log("  ERR:", e.slice(0, 220)));

const pass = c1 && c2 && c3 && c4 && c5;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
