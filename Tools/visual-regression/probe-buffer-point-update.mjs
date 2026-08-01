#!/usr/bin/env node
// Probe (NEW-UPSTREAM-13465-BUFFERPOINT-STALENESS) — verifies that changing a
// BufferPoint's position AFTER it has already been rendered re-renders the point
// at its new screen location, on BOTH backends (webgpu + webgl).
//
// Root cause (upstream #13465): BufferPoint.setPosition() wrote the new position
// into the collection's separate _positionView buffer and called
// _makeDirtyBoundingVolume(), but never set the primitive's _dirty flag. The
// repack pass in BOTH renderers iterates only [_dirtyOffset, _dirtyOffset +
// _dirtyCount) and skips any primitive whose _dirty is false, so a position-only
// change on an already-rendered point was never re-encoded into the GPU position
// buffers — the point stayed frozen at its original location. The fix adds
// `this._dirty = true;` to setPosition() (and the equivalent BufferPolygon /
// BufferPolyline geometry setters).
//
// Strategy — backend-symmetric, deterministic readback:
//   For each renderer we load a fresh viewer page, disable the globe/sky so the
//   scene is a black background with a single cyan BufferPoint. We place the
//   point at lon0 and snapshot the cyan-pixel centroid (frame A). We then move
//   the SAME point to lon1 (a clearly different screen column) WITHOUT re-adding
//   it, render exactly 2 frames, and snapshot again (frame B). The fix requires
//   the centroid to shift by more than a generous threshold; pre-fix the centroid
//   would not move at all (the GPU buffer kept the stale encoded position).
//
// Checks per backend:
//   (1) the point is visible at lon0 (cyanA >= MIN pixels) and at lon1
//       (cyanB >= MIN pixels) — i.e. it didn't vanish.
//   (2) the cyan centroid X shifted by >= MOVE_MIN px within 2 frames of the
//       position change — the moved point actually re-rendered.
//   (3) 0 console errors (incl. WebGPU validation errors).
//
// Usage: node Tools/visual-regression/probe-buffer-point-update.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/buffer-point-update-{webgpu,webgl}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

const CYAN_MIN = 60; // a ~18px point quad covers well over this many pixels
const MOVE_MIN = 80; // px of centroid X shift expected between lon0 and lon1

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 700 },
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

  const out = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    v.clock.shouldAnimate = false;

    // Black background, no globe/sky — isolate the single point.
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

    const isCyan = (d, i) => d[i] < 110 && d[i + 1] > 150 && d[i + 2] > 150;
    const isRed = (d, i) => d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110;
    // {count, cx} — pixel count and centroid X for a color predicate.
    const stats = (img, pred) => {
      let n = 0;
      let sumX = 0;
      for (let p = 0; p < img.w * img.h; p++) {
        if (pred(img.data, 4 * p)) {
          n++;
          sumX += p % img.w;
        }
      }
      return { count: n, cx: n > 0 ? sumX / n : -1 };
    };

    const LAT = 40.0;
    const LON0 = -75.2;
    const LON1 = -74.8; // ~0.4deg east — a clearly different screen column
    // A few hundred meters above the ellipsoid. At ALT=0 with the globe off the
    // WebGL BufferPoint sits exactly on the surface and is culled at this camera
    // distance (a WebGL-only near-plane/depth-plane interaction unrelated to the
    // staleness fix); 300 m renders cleanly on BOTH backends.
    const ALT = 300.0;

    // Two points in ONE collection: a STATIC red anchor (south of the camera
    // axis) and a MOVING cyan point. A single-point gl.POINTS collection has a
    // pre-existing WebGL degeneracy where the lone vertex can drop out on a
    // sub-data update; using >= 2 points exercises the real dynamic-geometry
    // path that the staleness fix targets, on both backends. The red anchor
    // doubles as a control: it must NOT move when only the cyan point changes.
    const points = scene.primitives.add(
      new C.BufferPointCollection({ primitiveCountMax: 8 }),
    );
    const cyanMat = new C.BufferPointMaterial({
      color: new C.Color(0.1, 1.0, 1.0, 1.0),
      size: 22,
      outlineWidth: 0,
    });
    const redMat = new C.BufferPointMaterial({
      color: new C.Color(1.0, 0.1, 0.1, 1.0),
      size: 22,
      outlineWidth: 0,
    });
    const movingPoint = new C.BufferPoint();
    points.add(
      { position: C.Cartesian3.fromDegrees(LON0, LAT, ALT) },
      movingPoint,
    );
    movingPoint.setMaterial(cyanMat);
    const anchor = new C.BufferPoint();
    points.add(
      { position: C.Cartesian3.fromDegrees(LON0, LAT - 0.3, ALT) },
      anchor,
    );
    anchor.setMaterial(redMat);

    // Look straight down at the midpoint between the two longitudes so both
    // lon0 and lon1 are comfortably on-screen and horizontally separated.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        (LON0 + LON1) / 2,
        LAT - 0.15,
        120000.0,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });

    // Render the cyan point at lon0 to a stable, fully-repacked state.
    await frame(8);
    const imgA = await snap(true);
    const cyanA = stats(imgA, isCyan);
    const redA = stats(imgA, isRed);

    // Move the SAME, already-rendered cyan point (index 0). The fix must flip
    // _dirty so the repack re-encodes it. Render exactly 2 frames (the stage's
    // "within 2 frames" bound) before snapshotting. get() rebinds the flyweight
    // to the collection's index-0 record before we mutate it.
    points.get(0, movingPoint);
    movingPoint.setPosition(C.Cartesian3.fromDegrees(LON1, LAT, ALT));
    await frame(2);
    const imgB = await snap(true);
    const cyanB = stats(imgB, isCyan);
    const redB = stats(imgB, isRed);

    return {
      cyanA: cyanA.count,
      cxA: cyanA.cx,
      cyanB: cyanB.count,
      cxB: cyanB.cx,
      redShift: redA.cx >= 0 && redB.cx >= 0 ? Math.abs(redB.cx - redA.cx) : -1,
      redCount: Math.min(redA.count, redB.count),
      pngA: imgA.png,
      pngB: imgB.png,
    };
  });

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
  if (r.pngB)
    fs.writeFileSync(
      path.join(OUT_DIR, `buffer-point-update-${renderer}.png`),
      Buffer.from(r.pngB.split(",")[1], "base64"),
    );

  const moved = Math.abs(r.cxB - r.cxA);
  check(
    `${renderer}-1`,
    r.cyanA >= CYAN_MIN && r.cyanB >= CYAN_MIN,
    `moving point visible before AND after move: cyanA=${r.cyanA}/${CYAN_MIN} cyanB=${r.cyanB}/${CYAN_MIN}`,
  );
  check(
    `${renderer}-2`,
    moved >= MOVE_MIN,
    `cyan centroid X shifted >= ${MOVE_MIN}px within 2 frames of setPosition: |${r.cxB.toFixed(1)} - ${r.cxA.toFixed(1)}| = ${moved.toFixed(1)}px (pre-fix this is ~0 — stale GPU position)`,
  );
  check(
    `${renderer}-3`,
    r.redCount >= CYAN_MIN && r.redShift >= 0 && r.redShift <= 3,
    `static red anchor stays put (control): redCount=${r.redCount} redShift=${r.redShift.toFixed(2)}px (<= 3)`,
  );
  check(
    `${renderer}-4`,
    r.errors.length === 0,
    `console errors: ${r.errors.length}`,
  );
  if (r.errors.length)
    for (const e of r.errors.slice(0, 6)) console.log(`    ERR: ${e}`);
}

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
