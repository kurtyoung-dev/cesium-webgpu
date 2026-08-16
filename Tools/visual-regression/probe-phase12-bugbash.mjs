#!/usr/bin/env node
// Probe (Batch 304 — Phase 12 med/low bug-bash gate). Verifies the four
// shipped fixes do not regress globe / billboard / atmosphere rendering
// on WebGPU and that the new observability path stays quiet on a healthy
// device:
// @purpose Gate for four B304 fixes: imagery-projection single-source, uploadImageSource observability, raySphere precision, billboard updateMode order
// @status ACTIVE
//
//   NEW-USEWEBMERCATORT-SINGLE-SOURCE — the imagery projection decision
//     is now resolved once (`resolveImageryProjection`) and consumed by
//     both the texture binding and the tile-UB `useWebMercatorTLayer`
//     flag. Regression shape: a misprojected imagery strip / wrong-V
//     sampling shows up as reduced imagery color diversity or a banded
//     globe. We gate on the globe rendering with healthy imagery color
//     diversity at a Mercator-imagery saved view (Bing/default uses the
//     WebMercator tiling scheme → useWebMercatorT=true tiles).
//
//   NEW-UPLOADIMAGESOURCE-OBSERVABILITY — uploadImageSource now emits a
//     permanent `[CesiumJS:webgpu] uploadImageSource failed` console.error
//     on the unexpected catch. On a healthy device that path must NOT
//     fire — we assert ZERO such errors across a full tile-streaming pan
//     (the error is for genuine faults, not the normal undecoded-image
//     retry which returns early before the try).
//
//   NEW-RAYSPHERE-PRECISION-BACKPORT — the GLSL builtin now scales the
//     ray origin by 1/radius. The sky atmosphere (which routes through
//     czm_raySphereIntersectionInterval via computeScattering) must still
//     render a coherent limb at orbital altitude — gated as a non-black
//     atmosphere band above the globe horizon with no NaN/black wedge.
//
//   NEW-BILLBOARD-UPDATEMODE-ORDERING — the redundant second updateMode
//     call was dropped. Billboards must still render and their bounding
//     volume (which `updateMode` seeds via `_baseVolume`) must keep them
//     visible — gated as visible billboard pixels.
//
// Usage: node Tools/visual-regression/probe-phase12-bugbash.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
const uploadErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") {
    const t = m.text();
    errors.push(t);
    if (t.includes("uploadImageSource failed")) uploadErrors.push(t);
  }
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
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });
  const renderN = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.requestRender();
      await oncePostRender();
    }
  };

  // ── Globe + Mercator imagery, straight-down mid-latitude view so the
  //    globe fills the frame (useWebMercatorT tiles in frame). A limb
  //    view is captured in a second pass for the atmosphere check. ──
  scene.globe.show = true;
  scene.skyAtmosphere.show = true;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95.0, 40.0, 3_500_000.0),
    orientation: {
      heading: 0.0,
      pitch: -C.Math.PI_OVER_TWO,
      roll: 0.0,
    },
  });

  // Let imagery stream in.
  for (let i = 0; i < 120; i++) {
    scene.requestRender();
    await oncePostRender();
  }

  // ── Add a billboard cluster centered on the view so the dropped second
  //    updateMode is gated (must still render + be inside the bounding
  //    volume `updateMode` seeds). ──
  const bbCollection = scene.primitives.add(new C.BillboardCollection());
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff00ff";
  ctx.fillRect(0, 0, 16, 16);
  for (let lon = -105; lon <= -85; lon += 2) {
    for (let lat = 32; lat <= 48; lat += 2) {
      bbCollection.add({
        position: C.Cartesian3.fromDegrees(lon, lat, 0.0),
        image: canvas,
        scale: 1.0,
      });
    }
  }
  await renderN(25);

  // ── Sample pixels (top-down: globe + imagery + billboards) ──
  const cv = scene.canvas;
  const W = cv.width;
  const H = cv.height;
  const sample = () => {
    const tmp = document.createElement("canvas");
    tmp.width = W;
    tmp.height = H;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(cv, 0, 0);
    return tctx.getImageData(0, 0, W, H).data;
  };
  const px = sample();

  const buckets = new Set();
  let nonBlack = 0;
  let magenta = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      if (r + g + b > 24) nonBlack++;
      buckets.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4));
      if (r > 180 && g < 80 && b > 180) magenta++;
    }
  }
  const sampled = (W / 2) * (H / 2);

  return {
    nonBlackPct: (nonBlack / sampled) * 100,
    distinctColors: buckets.size,
    magenta,
    rendererIsWebGPU: !!scene.context.isWebGPU,
  };
});

// ── NEW-RAYSPHERE-PRECISION-BACKPORT lives in the GLSL builtin, which the
//    WebGL renderer compiles (the WebGPU renderer uses the already-fixed
//    WGSL). Verify the modified path on WebGL: the sky atmosphere (which
//    routes through czm_raySphereIntersectionInterval via
//    computeScattering) must render a coherent blue limb at a horizon
//    view from orbit, with no NaN/black wedge. ──
const wglPage = await browser.newPage({
  viewport: { width: 1024, height: 768 },
});
const wglErrors = [];
wglPage.on("console", (m) => {
  if (m.type() === "error") wglErrors.push(m.text());
});
wglPage.on("pageerror", (e) => wglErrors.push(`pageerror: ${e.message}`));
await wglPage.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
  waitUntil: "networkidle",
});
await wglPage.waitForFunction(() => !!window.viewer);

const atmo = await wglPage.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;
  scene.skyAtmosphere.show = true;
  scene.globe.show = true;

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

  // Full-disc view from deep orbit: the whole globe + the atmosphere ring
  // around its limb sit in frame. The ring is produced by the
  // sky-atmosphere fragment shader, which intersects the view ray with
  // the atmosphere shell via czm_raySphereIntersectionInterval (the
  // modified builtin). A ray-sphere precision failure paints a black/
  // garbled wedge instead of a smooth blue ring.
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95.0, 20.0, 22_000_000.0),
    orientation: {
      heading: 0.0,
      pitch: -C.Math.PI_OVER_TWO,
      roll: 0.0,
    },
  });
  for (let i = 0; i < 120; i++) {
    scene.requestRender();
    await oncePostRender();
  }

  // WebGL canvas: readback via gl.readPixels.
  const gl = scene.context._originalGLContext || scene.context._gl;
  const W = scene.canvas.width;
  const H = scene.canvas.height;
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  // Count blue-dominant atmosphere pixels across the whole frame (the
  // ring + the scattering disc). A ray-sphere NaN would collapse this.
  let limbBlue = 0;
  let limbSamples = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      limbSamples++;
      // Atmosphere scatter is blue-dominant and non-black.
      if (b > 40 && b >= r && b > g * 0.8 && r + g + b > 50) limbBlue++;
    }
  }
  return {
    limbBluePct: (limbBlue / Math.max(limbSamples, 1)) * 100,
    isWebGPU: !!scene.context.isWebGPU,
  };
});

await browser.close();

// ── Assertions ──
let ok = true;
const fail = (m) => {
  ok = false;
  console.log(`  FAIL ${m}`);
};
const pass = (m) => console.log(`  ${m} OK`);

console.log("Phase-12 bug-bash probe:");
console.log(
  `  [webgpu] renderer=webgpu:${out.rendererIsWebGPU} nonBlack=${out.nonBlackPct.toFixed(
    1,
  )}% distinct=${out.distinctColors} magenta=${out.magenta}`,
);
console.log(
  `  [webgl]  isWebGPU:${atmo.isWebGPU} limbBlue=${atmo.limbBluePct.toFixed(1)}%`,
);

if (!out.rendererIsWebGPU) fail("WebGPU scene is not WebGPU");
if (atmo.isWebGPU) fail("WebGL scene unexpectedly reports WebGPU");

// (1) NEW-USEWEBMERCATORT-SINGLE-SOURCE — globe + Mercator imagery renders
//     with healthy color diversity (a wrong-V / misprojected strip would
//     collapse diversity or blank the globe).
if (out.nonBlackPct >= 25 && out.distinctColors >= 80) {
  pass(
    `(1) globe+imagery renders (single-source useWebMercatorT): nonBlack=${out.nonBlackPct.toFixed(
      1,
    )}% distinct=${out.distinctColors}`,
  );
} else {
  fail(
    `(1) globe imagery diversity too low: nonBlack=${out.nonBlackPct.toFixed(
      1,
    )}% distinct=${out.distinctColors}`,
  );
}

// (2) NEW-UPLOADIMAGESOURCE-OBSERVABILITY — no upload errors on healthy device.
if (uploadErrors.length === 0) {
  pass(`(2) no uploadImageSource errors on healthy device (count=0)`);
} else {
  fail(`(2) unexpected uploadImageSource errors: ${uploadErrors.length}`);
}

// (3) NEW-RAYSPHERE-PRECISION-BACKPORT — WebGL sky atmosphere ring (the
//     path that compiles the modified GLSL builtin) renders a blue ring.
if (atmo.limbBluePct >= 10) {
  pass(
    `(3) WebGL atmosphere ring renders (ray-sphere GLSL): limbBlue=${atmo.limbBluePct.toFixed(1)}%`,
  );
} else {
  fail(
    `(3) WebGL atmosphere ring too dark/garbled: limbBlue=${atmo.limbBluePct.toFixed(1)}%`,
  );
}

// (4) NEW-BILLBOARD-UPDATEMODE-ORDERING — billboards visible after single updateMode.
if (out.magenta >= 30) {
  pass(`(4) billboards render after updateMode dedup: magenta=${out.magenta}`);
} else {
  fail(
    `(4) billboards missing (updateMode/bounding-volume regression): magenta=${out.magenta}`,
  );
}

// (5) no console errors at all (both backends).
if (errors.length === 0 && wglErrors.length === 0) {
  pass(`(5) console errors: 0 (webgpu) 0 (webgl)`);
} else {
  fail(
    `(5) console errors: webgpu=${errors.length} webgl=${wglErrors.length} — ${[
      ...errors,
      ...wglErrors,
    ]
      .slice(0, 3)
      .join(" | ")}`,
  );
}

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
