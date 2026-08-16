#!/usr/bin/env node
// NS-MOON-MATTE-NOT-SUNLIT acceptance / regression probe.
// @purpose Regression pin: the moon shows sun-relative shading (limb darkening, graded terminator, displaced lit centroid) on both backends.
// @status ACTIVE
//
// User report (2026-07-06, split-screen WebGL vs WebGPU): "the moon renders
// matte/flat — it does not visibly show sun-relative shading (lit hemisphere,
// terminator, phase, limb darkening); it looks like a flat/dark object."
//
// PREMISE VERIFICATION RESULT (2026-07-05): STALE. B505 (model-space RTE
// placement) + B517 (crescent-phase terminator) already ship correct
// sun-relative shading on BOTH backends. This probe pins that down with
// two quantitative diagnostics that a genuinely matte/flat disc would fail:
//
//   Diagnostic 1 — LIMB DARKENING at (near-)full phase. A flat/emissive disc
//   has uniform luminance to the rim; a sun-lit Lambert sphere darkens toward
//   the limb (N·L falls off). We measure edgeMean/centerMean over the disc
//   (center ring r<0.3R vs rim ring 0.7R<r<0.95R). A lit sphere gives a low
//   ratio; a matte disc gives ~1.0. GATE: ratio < 0.6 on both backends.
//
//   Diagnostic 2 — GRADED TERMINATOR + SUN-FACING LIT HEMISPHERE at ~half
//   phase. A flat disc is either fully lit or fully dark; a sun-lit sphere
//   shows a lit hemisphere whose centroid is displaced toward the sunlit limb
//   with a smooth (graded, multi-tone) terminator, not a hard step. We check
//   (a) partialFrac = litArea(half)/litArea(full) in (0.15, 0.85) — a real
//   terminator bisects the disc; (b) the lit centroid is displaced from the
//   geometric disc center by > 0.08*R toward the sunlit side; (c) the
//   terminator scanline has intermediate mid-tones (graded, not a 2-level
//   step) — >= 3 distinct luminance buckets in the transition band.
//
// Cross-backend: both backends must match (per-pixel diffPct < 15% on the
// center crop) at both phases — this is a both-backends-correct bug, so parity
// is necessary but not sufficient; the per-backend shading gates above are the
// real content.
//
// Method mirrors probe-env-moon.mjs: pin the clock, read the moon world
// position from its ellipsoid-primitive model matrix, park the camera on the
// Earth->moon line 20,000 km short of the moon (disc ~190px), aim at it,
// screenshot a center crop, decode + analyze in a scratch page (no Node PNG
// dep). Uses Edge (msedge) — Playwright Firefox has no WebGPU.
//
// Usage: node Tools/visual-regression/probe-moon-sunlit.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const ISO_FULL = "2026-07-02T16:22:00Z"; // near-full (illumFrac ~0.94)
const ISO_HALF = "2026-07-08T12:00:00Z"; // ~half/crescent (illumFrac ~0.43)
const CROP = 420;
const VIEW = { width: 1280, height: 720 };

async function capture(renderer, iso, tag) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: VIEW });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async (iso) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const t = C.JulianDate.fromIso8601(iso);
    try {
      await C.Transforms.preloadIcrfFixed(
        new C.TimeInterval({
          start: C.JulianDate.addDays(t, -1, new C.JulianDate()),
          stop: C.JulianDate.addDays(t, 1, new C.JulianDate()),
        }),
      );
    } catch (e) {
      /* fallback transform is identical on both backends */
    }
    v.clock.currentTime = t.clone();
    v.clock.startTime = t.clone();
    v.clock.stopTime = t.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;
    for (const sel of [
      ".cesium-viewer-timelineContainer",
      ".cesium-viewer-animationContainer",
      ".cesium-viewer-bottom",
      ".cesium-viewer-toolbar",
      ".cesium-viewer-fullscreenContainer",
      ".cesium-viewer-navigationContainer",
      ".cesium-navigation-help",
      ".cesium-renderer-toggle",
    ]) {
      const el = document.querySelector(sel);
      if (el) el.style.display = "none";
    }
    for (let i = 0; i < 5; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const moonPos = C.Matrix4.getTranslation(
      v.scene.moon._ellipsoidPrimitive.modelMatrix,
      new C.Cartesian3(),
    );
    const dist = C.Cartesian3.magnitude(moonPos);
    const dir = C.Cartesian3.normalize(moonPos, new C.Cartesian3());
    const camPos = C.Cartesian3.multiplyByScalar(
      dir,
      dist - 2.0e7,
      new C.Cartesian3(),
    );
    let up = C.Cartesian3.cross(dir, C.Cartesian3.UNIT_Z, new C.Cartesian3());
    if (C.Cartesian3.magnitude(up) < 1e-6) {
      up = C.Cartesian3.cross(dir, C.Cartesian3.UNIT_X, up);
    }
    C.Cartesian3.normalize(up, up);
    v.camera.setView({
      destination: camPos,
      orientation: { direction: dir, up: up },
    });
    for (let i = 0; i < 90; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, iso);

  const cropPath = path.join(OUT_DIR, `moon-sunlit-${tag}-${renderer}.png`);
  await page.screenshot({
    path: cropPath,
    clip: {
      x: VIEW.width / 2 - CROP / 2,
      y: VIEW.height / 2 - CROP / 2,
      width: CROP,
      height: CROP,
    },
  });
  await browser.close();
  return { errs, cropPath };
}

// Decode a crop and compute sun-lit diagnostics + return raw data for diff.
async function analyzeOne(page, b64) {
  return await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const W = c.width,
      H = c.height;
    const lum = (x, y) => {
      const i = (y * W + x) * 4;
      return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    };
    // Disc bbox from lit pixels (lum>18; stars are dimmer).
    let minX = W,
      maxX = -1,
      minY = H,
      maxY = -1,
      litCount = 0,
      sumX = 0,
      sumY = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (lum(x, y) > 18) {
          litCount++;
          sumX += x;
          sumY += y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    if (maxX < 0) return { litCount: 0, data: Array.from(d), w: W, h: H };
    // Geometric disc center/radius = bbox (disc rim is where lum crosses 18,
    // and the disc spans the same footprint regardless of phase because the
    // ellipsoid silhouette is lit-independent... except at crescent the dark
    // limb drops below threshold. Use the FULL-phase-style max extent per
    // axis as radius proxy).
    const cx = (minX + maxX) / 2,
      cy = (minY + maxY) / 2;
    const R = Math.max(maxX - minX, maxY - minY) / 2;
    const litCentroid = { x: sumX / litCount, y: sumY / litCount };
    // Limb darkening: center ring vs rim ring over LIT pixels.
    let cent = 0,
      cn = 0,
      edge = 0,
      en = 0;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const L = lum(x, y);
        if (L <= 18) continue;
        const rr = Math.hypot((x - cx) / R, (y - cy) / R);
        if (rr < 0.3) {
          cent += L;
          cn++;
        } else if (rr > 0.7 && rr < 0.95) {
          edge += L;
          en++;
        }
      }
    const centerMean = cn ? cent / cn : 0;
    const edgeMean = en ? edge / en : 0;
    // Graded terminator: scan the horizontal line through cy across the disc,
    // count distinct luminance buckets (bucket = round(L/25)) among on-disc
    // samples. A hard binary step yields ~2 buckets; a graded ramp >=3.
    const buckets = new Set();
    for (let x = minX; x <= maxX; x++) {
      const L = lum(x, Math.round(cy));
      buckets.add(Math.round(L / 25));
    }
    return {
      litCount,
      w: W,
      h: H,
      cx,
      cy,
      R,
      litCentroid,
      centroidOffsetR: Math.hypot(litCentroid.x - cx, litCentroid.y - cy) / R,
      centerMean,
      edgeMean,
      limbRatio: centerMean > 0 ? edgeMean / centerMean : 1,
      gradedBuckets: buckets.size,
      data: Array.from(d),
    };
  }, b64);
}

async function diffPct(a, b) {
  if (a.w !== b.w || a.h !== b.h) return 100;
  let mismatch = 0;
  const da = a.data,
    db = b.data;
  for (let i = 0; i < da.length; i += 4) {
    const dd =
      Math.abs(da[i] - db[i]) +
      Math.abs(da[i + 1] - db[i + 1]) +
      Math.abs(da[i + 2] - db[i + 2]);
    if (dd > 60) mismatch++;
  }
  return (100 * mismatch) / (a.w * a.h);
}

async function runPhase(tag, iso, label) {
  const crops = {};
  const errsAll = {};
  for (const renderer of ["webgl", "webgpu"]) {
    const { errs, cropPath } = await capture(renderer, iso, tag);
    crops[renderer] = cropPath;
    errsAll[renderer] = errs;
  }
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const gl = await analyzeOne(
    page,
    fs.readFileSync(crops.webgl).toString("base64"),
  );
  const gpu = await analyzeOne(
    page,
    fs.readFileSync(crops.webgpu).toString("base64"),
  );
  const dp = await diffPct(gl, gpu);
  await browser.close();
  for (const [n, m] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    console.log(
      `[${label}:${n}] lit=${m.litCount} centerMean=${m.centerMean?.toFixed(1)} ` +
        `edgeMean=${m.edgeMean?.toFixed(1)} limbRatio=${m.limbRatio?.toFixed(3)} ` +
        `centroidOffR=${m.centroidOffsetR?.toFixed(3)} gradedBuckets=${m.gradedBuckets} ` +
        `errs=${errsAll[n].length}`,
    );
  }
  console.log(`[${label}] cropDiff=${dp.toFixed(2)}%`);
  return { gl, gpu, dp };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Diagnostic 1 — limb darkening at near-full phase (matte disc would be ~1.0)
  const full = await runPhase("full", ISO_FULL, "full");
  const limbPass =
    full.gl.limbRatio < 0.6 &&
    full.gpu.limbRatio < 0.6 &&
    full.dp < 15 &&
    full.gl.litCount > 5000 &&
    full.gpu.litCount > 5000;
  console.log(
    `\n[LIMB-DARKENING] gl=${full.gl.limbRatio.toFixed(3)} gpu=${full.gpu.limbRatio.toFixed(3)} (want <0.6) => ${limbPass ? "PASS" : "FAIL"}`,
  );

  // Diagnostic 2 — graded terminator + sun-facing lit hemisphere at half phase
  const half = await runPhase("half", ISO_HALF, "half");
  const partialFracGl = full.gl.litCount
    ? half.gl.litCount / full.gl.litCount
    : 0;
  const partialFracGpu = full.gpu.litCount
    ? half.gpu.litCount / full.gpu.litCount
    : 0;
  const termPass =
    partialFracGl > 0.15 &&
    partialFracGl < 0.85 &&
    partialFracGpu > 0.15 &&
    partialFracGpu < 0.85 &&
    half.gl.centroidOffsetR > 0.08 &&
    half.gpu.centroidOffsetR > 0.08 &&
    half.gl.gradedBuckets >= 3 &&
    half.gpu.gradedBuckets >= 3 &&
    half.dp < 15;
  console.log(
    `\n[TERMINATOR] partialFrac gl=${partialFracGl.toFixed(3)} gpu=${partialFracGpu.toFixed(3)} ` +
      `centroidOffR gl=${half.gl.centroidOffsetR.toFixed(3)} gpu=${half.gpu.centroidOffsetR.toFixed(3)} ` +
      `gradedBuckets gl=${half.gl.gradedBuckets} gpu=${half.gpu.gradedBuckets} => ${termPass ? "PASS" : "FAIL"}`,
  );

  const pass = limbPass && termPass;
  console.log(
    `\n${pass ? "PASS" : "FAIL"} — moon reads as sun-lit on both backends`,
  );
  process.exit(pass ? 0 : 1);
})();
