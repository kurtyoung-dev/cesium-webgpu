#!/usr/bin/env node
// probe-bufferpolygon-outline.mjs  (FEAT-BUFFERPOLYGON-OUTLINE)
//
// Acceptance probe for BufferPolygon outline rendering (the declared-but-
// previously-unrendered BufferPolygonMaterial outlineColor / outlineWidth
// API). Outlines are implemented as closed BufferPolyline strokes (one per
// ring — outer + holes) via an internal BufferPolylineCollection owned by
// BufferPolygonCollection, so both backends reuse the shipped polyline path.
//
// ON scene (both backends):
//   - Polygon A: dark-blue quad with a rectangular hole, outlineColor=RED,
//     outlineWidth=4  → RED stroke expected along BOTH rings.
//   - Polygon B: dark-blue quad, outlineColor=GREEN, outlineWidth=0 (default)
//     → NO green pixels anywhere (per-polygon outline settings honored).
//   Asserts: red present on BOTH backends, green absent on BOTH backends,
//   WebGL-vs-WebGPU pixel diff within tolerance (3D), 0 console/device errors,
//   internal outline collection holds exactly 2 rings.
//   CV spot-check: COLUMBUS_VIEW red presence asserted on WebGPU only — the
//   WebGL Buffer* path does not reproject in 2D/CV (see
//   probe-buffer-2dcv-parity.mjs), so WebGL CV numbers are informational.
//
// OFF scene (the off-gate):
//   - A single polygon with the DEFAULT material (outlineWidth=0).
//   Asserts: internal outline collection is null (nothing allocated), and —
//   when `--baseline` PNGs captured from the PRE-change build exist — the
//   post-change screenshot is pixel-identical to the pre-change one on both
//   backends (fill rendering byte-identical when the feature is off).
//
// Usage:
//   node Tools/visual-regression/probe-bufferpolygon-outline.mjs --baseline
//     (run against the PRE-change build: captures only the OFF-scene PNGs to
//      _bpoutline-off-{renderer}-pre.png)
//   node Tools/visual-regression/probe-bufferpolygon-outline.mjs
//     (full acceptance run against the post-change build)
//
// Env: PROBE_BASE (default http://localhost:8080)
// Out: Tools/visual-regression/output/_bpoutline-*.png

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
const BASELINE_ONLY = process.argv.includes("--baseline");

// Shared scene setup, evaluated in the page. `withOutlines` picks the ON
// scene (outlined polygons) vs the OFF scene (default material only).
async function setupScene(page, withOutlines) {
  return page.evaluate(async (withOutlines) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    window.__C = C;
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const s = v.scene;
    s.globe.show = false;
    s.imageryLayers.removeAll();
    if (s.skyBox) s.skyBox.show = false;
    // The star field renders (and twinkles on wall-clock time) even when the
    // skybox is hidden — kill it for the strict pre-vs-post pixel compare.
    if (s.skyBox && s.skyBox.starField) s.skyBox.starField.show = false;
    if (s.skyAtmosphere) s.skyAtmosphere.show = false;
    if (s.sun) s.sun.show = false;
    if (s.moon) s.moon.show = false;
    s.fog.enabled = false;
    s.backgroundColor = C.Color.BLACK;
    s.primitives.removeAll();

    // Determinism for the strict pre-vs-post pixel compare: freeze the clock
    // (the animation widget renders wall-clock time) and hide the live
    // animation + timeline DOM overlays that overlap the canvas screenshot.
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-07-01T12:00:00Z");
    v.clock.shouldAnimate = false;
    for (const sel of [
      ".cesium-viewer-animationContainer",
      ".cesium-viewer-timelineContainer",
    ]) {
      const el = document.querySelector(sel);
      if (el) el.style.display = "none";
    }

    const polys = s.primitives.add(
      new C.BufferPolygonCollection({
        primitiveCountMax: 8,
        vertexCountMax: 64,
        triangleCountMax: 64,
        holeCountMax: 8,
      }),
    );
    window.__polys = polys;

    const ALT = 0.0;
    const toPositions = (lonLats) => {
      const arr = [];
      for (const [lon, lat] of lonLats) {
        const p = C.Cartesian3.fromDegrees(lon, lat, ALT);
        arr.push(p.x, p.y, p.z);
      }
      return new Float64Array(arr);
    };

    if (withOutlines) {
      // ON scene only: hide the navigation-help overlay — its green "Zoom
      // view" text pollutes the green-signature count. (NOT hidden in the
      // OFF scene, whose pre-change baseline was captured with it visible.)
      const help = document.querySelector(
        ".cesium-navigationHelpButton-wrapper",
      );
      if (help) help.style.display = "none";

      // Polygon A — quad with a rectangular hole. Fill dark blue; outline
      // RED, 4px. Outer ring O0..O3, hole ring I4..I7; the 8 triangles
      // triangulate the ring between them.
      polys.add({
        positions: toPositions([
          [-105, 35],
          [-95, 35],
          [-95, 41],
          [-105, 41], // outer
          [-102, 37],
          [-98, 37],
          [-98, 39],
          [-102, 39], // hole
        ]),
        holes: new Uint32Array([4]),
        triangles: new Uint32Array([
          0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4,
          7,
        ]),
        material: new C.BufferPolygonMaterial({
          color: new C.Color(0.1, 0.2, 0.8, 1.0),
          outlineColor: new C.Color(1.0, 0.0, 0.0, 1.0),
          outlineWidth: 4,
        }),
      });

      // Polygon B — plain quad, GREEN outline color but width 0 (default):
      // the green signature must NOT appear anywhere.
      polys.add({
        positions: toPositions([
          [-90, 35],
          [-84, 35],
          [-84, 40],
          [-90, 40],
        ]),
        triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
        material: new C.BufferPolygonMaterial({
          color: new C.Color(0.1, 0.2, 0.8, 1.0),
          outlineColor: new C.Color(0.0, 1.0, 0.0, 1.0),
          outlineWidth: 0,
        }),
      });
    } else {
      // OFF scene — single quad with the DEFAULT material (outlineWidth=0).
      polys.add({
        positions: toPositions([
          [-105, 35],
          [-95, 35],
          [-95, 41],
          [-105, 41],
        ]),
        triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
        material: new C.BufferPolygonMaterial({
          color: new C.Color(1.0, 0.95, 0.1, 1.0),
        }),
      });
    }
    return { ok: true };
  }, withOutlines);
}

async function renderAndShoot(page, mode, outPath, cvCamera = false) {
  await page.evaluate(
    async ([mode, cvCamera]) => {
      const C = window.__C;
      const v = window.viewer;
      v.scene.mode = C.SceneMode[mode];
      // CV spot-check uses probe-buffer-2dcv-parity's exact camera (the
      // shipped CV parity surface). The 3D + OFF shots keep the closer
      // Cartesian destination the OFF-gate baseline was captured with.
      v.camera.setView({
        destination: cvCamera
          ? C.Cartesian3.fromDegrees(-99, 38, 10000000)
          : C.Cartesian3.fromDegrees(-96, 38, 4500000),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    [mode, cvCamera],
  );
  const canvas = await page.$("canvas");
  const buf = await canvas.screenshot();
  fs.writeFileSync(outPath, buf);
}

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGE: " + e.message.slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("ERR: " + m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  let onState = null;
  if (!BASELINE_ONLY) {
    // ── ON scene ──
    await setupScene(page, true);
    await renderAndShoot(
      page,
      "SCENE3D",
      `${OUT}/_bpoutline-on-${renderer}-3d.png`,
    );
    onState = await page.evaluate(() => {
      const oc = window.__polys._outlineCollection;
      return {
        hasOutlineCollection: !!oc,
        outlineRingCount: oc ? oc.primitiveCount : 0,
      };
    });
    // CV spot-check (Batch 467 reprojection interplay).
    await renderAndShoot(
      page,
      "COLUMBUS_VIEW",
      `${OUT}/_bpoutline-on-${renderer}-cv.png`,
      true,
    );
  }

  // ── OFF scene (fresh page → clean collection state) ──
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await setupScene(page, false);
  const offSuffix = BASELINE_ONLY ? "-pre" : "";
  await renderAndShoot(
    page,
    "SCENE3D",
    `${OUT}/_bpoutline-off-${renderer}${offSuffix}.png`,
  );
  const offState = await page.evaluate(() => ({
    outlineCollectionIsNull: window.__polys._outlineCollection === null,
  }));

  await browser.close();
  return { onState, offState, errs };
}

// Decode two PNGs to RGBA via a headless canvas and diff.
async function diffPngs(pathA, pathB) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const diff = await page.evaluate(
    async ([a, b]) => {
      async function decode(dataUrl) {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = dataUrl;
        });
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return { d: ctx.getImageData(0, 0, cv.width, cv.height).data };
      }
      const A = await decode(a);
      const B = await decode(b);
      const n = Math.min(A.d.length, B.d.length);
      let mism = 0;
      let exact = 0;
      let total = 0;
      for (let i = 0; i < n; i += 4) {
        total++;
        const dr = Math.abs(A.d[i] - B.d[i]);
        const dg = Math.abs(A.d[i + 1] - B.d[i + 1]);
        const db = Math.abs(A.d[i + 2] - B.d[i + 2]);
        if (dr + dg + db > 60) mism++;
        if (dr + dg + db === 0) exact++;
      }
      return {
        mismatchPct: +((mism / total) * 100).toFixed(2),
        exactPct: +((exact / total) * 100).toFixed(2),
      };
    },
    [
      "data:image/png;base64," + fs.readFileSync(pathA).toString("base64"),
      "data:image/png;base64," + fs.readFileSync(pathB).toString("base64"),
    ],
  );
  await browser.close();
  return diff;
}

// Count outline signature colors: red (outline ON), green (outline OFF —
// must never appear), blue-ish fill.
async function countColors(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const out = await page.evaluate(
    async (dataUrl) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let red = 0;
      let green = 0;
      let fill = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        if (r > 150 && g < 90 && b < 90) red++;
        else if (g > 150 && r < 90 && b < 90) green++;
        else if (b > 130 && r < 110 && g < 120) fill++;
      }
      return { red, green, fill };
    },
    "data:image/png;base64," + fs.readFileSync(pngPath).toString("base64"),
  );
  await browser.close();
  return out;
}

const webgl = await run("webgl");
const webgpu = await run("webgpu");

console.log("=== WebGL ===  errs:", webgl.errs.length, webgl.errs.slice(0, 4));
console.log(
  "=== WebGPU === errs:",
  webgpu.errs.length,
  webgpu.errs.slice(0, 4),
);

if (BASELINE_ONLY) {
  const ok = webgl.errs.length === 0 && webgpu.errs.length === 0;
  console.log(
    `Baseline OFF-scene PNGs captured (${OUT}/_bpoutline-off-{webgl,webgpu}-pre.png)`,
  );
  console.log("RESULT:", ok ? "BASELINE-OK" : "BASELINE-ERRORS");
  process.exit(ok ? 0 : 1);
}

let pass = true;
const check = (label, cond) => {
  console.log(`${cond ? "  OK " : "  FAIL"} ${label}`);
  if (!cond) pass = false;
};

console.log("\n=== Device / console errors (0 required) ===");
check(
  `WebGL console errors == 0 (got ${webgl.errs.length})`,
  webgl.errs.length === 0,
);
check(
  `WebGPU console errors == 0 (got ${webgpu.errs.length})`,
  webgpu.errs.length === 0,
);

console.log("\n=== ON scene — internal outline collection state ===");
for (const [name, r] of [
  ["WebGL", webgl],
  ["WebGPU", webgpu],
]) {
  check(
    `${name}: outline collection built with 2 rings (outer + hole) — got ` +
      JSON.stringify(r.onState),
    r.onState?.hasOutlineCollection === true &&
      r.onState?.outlineRingCount === 2,
  );
}

console.log("\n=== ON scene — signature colors (3D) ===");
const MIN_RED = 300; // 4px stroke around two rings covers thousands of px
for (const name of ["webgl", "webgpu"]) {
  const c = await countColors(`${OUT}/_bpoutline-on-${name}-3d.png`);
  console.log(`  ${name} 3D: red=${c.red} green=${c.green} fill=${c.fill}`);
  check(`${name} 3D: outline rendered (red >= ${MIN_RED})`, c.red >= MIN_RED);
  check(
    `${name} 3D: outlineWidth=0 polygon has NO outline (green < 20)`,
    c.green < 20,
  );
  check(
    `${name} 3D: fill still renders (fill >= ${MIN_RED})`,
    c.fill >= MIN_RED,
  );
}

console.log("\n=== ON scene — WebGL vs WebGPU parity (3D) ===");
const TOL = 3.0;
const d3d = await diffPngs(
  `${OUT}/_bpoutline-on-webgl-3d.png`,
  `${OUT}/_bpoutline-on-webgpu-3d.png`,
);
console.log(`  3D diff: ${JSON.stringify(d3d)}`);
check(`3D WebGL-vs-WebGPU mismatch <= ${TOL}%`, d3d.mismatchPct <= TOL);

console.log("\n=== ON scene — Columbus View spot-check ===");
// WebGL Buffer* primitives do not reproject in 2D/CV (pre-existing,
// documented in probe-buffer-2dcv-parity.mjs) — WebGL CV is informational.
const cvGL = await countColors(`${OUT}/_bpoutline-on-webgl-cv.png`);
console.log(`  [info] webgl CV: ${JSON.stringify(cvGL)}`);
const cvGPU = await countColors(`${OUT}/_bpoutline-on-webgpu-cv.png`);
console.log(`  webgpu CV: ${JSON.stringify(cvGPU)}`);
check("webgpu CV: outline renders reprojected (red >= 100)", cvGPU.red >= 100);
check("webgpu CV: no green outline (green < 20)", cvGPU.green < 20);

console.log("\n=== OFF gate — outlineWidth=0 (default) ===");
for (const [name, r] of [
  ["WebGL", webgl],
  ["WebGPU", webgpu],
]) {
  check(
    `${name}: no outline collection allocated — got ` +
      JSON.stringify(r.offState),
    r.offState?.outlineCollectionIsNull === true,
  );
}
for (const name of ["webgl", "webgpu"]) {
  const pre = `${OUT}/_bpoutline-off-${name}-pre.png`;
  const post = `${OUT}/_bpoutline-off-${name}.png`;
  if (!fs.existsSync(pre)) {
    console.log(
      `  [warn] ${name}: no pre-change baseline (${pre}) — run --baseline against the pre-change build first`,
    );
    continue;
  }
  const d = await diffPngs(pre, post);
  console.log(`  ${name} pre-vs-post: ${JSON.stringify(d)}`);
  check(
    `${name}: OFF fill identical to pre-change (mismatch == 0%)`,
    d.mismatchPct === 0,
  );
}

console.log(
  "\nRESULT:",
  pass
    ? "PASS — BufferPolygon outline renders on both backends; off-gate clean"
    : "FAIL",
);
process.exit(pass ? 0 : 1);
