#!/usr/bin/env node
// ENV-MOON-SLIVER acceptance probe — WebGL vs WebGPU moon parity.
//
// Repro context (user report 2026-07-02): in the default WebGPU scene the
// moon rendered as a white sliver at the wrong screen position instead of a
// textured disc. Root cause: Moon.wgsl fed a WORLD-space RTE offset to an
// mvpRTE whose linear part includes the moon's IAU rotation (model-space
// matrix), so the center−camera offset was wrongly rotated by the moon's
// orientation. Fixed by switching to a model-space RTE split (camera
// position in moon model coords, high/low encoded).
//
// Method: for each backend, load the default CesiumViewer, pin the clock to
// the user's reported simulation time (2026-07-02T16:22Z), read the moon's
// world position from Moon's ellipsoid-primitive model matrix, park the
// camera on the Earth→moon line 20,000 km short of the moon (disc spans
// ~190 px), aim straight at it, and screenshot a center crop via Playwright
// (in-page drawImage of a WebGPU canvas can grab a stale frame — the
// composited screenshot is authoritative for both backends).
//
// Metrics on the center crop (canvas-decoded in a scratch page):
//   litCount   — pixels with luminance > 18 (disc footprint; stars are dim)
//   stddevLum  — texture variance across lit pixels (craters ⇒ > ~6;
//                a flat white/gray disc or missing texture ⇒ ~0)
//   bbox       — lit-pixel bounding box (size + position parity)
//   diffPct    — per-pixel RGB diff (threshold 60/765) between backends
// PASS = litRatio(gpu/gl) in [0.8, 1.25], both stddev > 6, disc centers
// within 40 px, diffPct < 15%.
//
// Usage: node Tools/visual-regression/probe-env-moon.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const ISO = "2026-07-02T16:22:00Z";
const CROP = 420; // center crop size in px
const VIEW = { width: 1280, height: 720 };

async function capture(renderer) {
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

  const info = await page.evaluate(async (iso) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    // Pin the user's reported simulation time.
    const t = C.JulianDate.fromIso8601(iso);
    try {
      await C.Transforms.preloadIcrfFixed(
        new C.TimeInterval({
          start: C.JulianDate.addDays(t, -1, new C.JulianDate()),
          stop: C.JulianDate.addDays(t, 1, new C.JulianDate()),
        }),
      );
    } catch (e) {
      /* fallback transform is fine — identical on both backends */
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

    // Let Moon.update run so its model matrix reflects the pinned time.
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
    // Camera on the Earth→moon line, 20,000 km short of the moon center.
    const camPos = C.Cartesian3.multiplyByScalar(
      dir,
      dist - 2.0e7,
      new C.Cartesian3(),
    );
    // Deterministic up vector perpendicular to dir.
    let up = C.Cartesian3.cross(dir, C.Cartesian3.UNIT_Z, new C.Cartesian3());
    if (C.Cartesian3.magnitude(up) < 1e-6) {
      up = C.Cartesian3.cross(dir, C.Cartesian3.UNIT_X, up);
    }
    C.Cartesian3.normalize(up, up);
    v.camera.setView({
      destination: camPos,
      orientation: { direction: dir, up: up },
    });

    // Render + wait for the async moon texture (moonSmall.jpg) to load.
    for (let i = 0; i < 90; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const stats =
      typeof v.scene.moon.getDebugStatistics === "function"
        ? v.scene.moon.getDebugStatistics(v.scene)
        : null;
    return { moonDistanceKm: dist / 1000, debugStats: stats };
  }, ISO);

  const cropPath = path.join(OUT_DIR, `env-moon-${renderer}.png`);
  await page.screenshot({
    path: cropPath,
    clip: {
      x: VIEW.width / 2 - CROP / 2,
      y: VIEW.height / 2 - CROP / 2,
      width: CROP,
      height: CROP,
    },
  });
  await page.screenshot({
    path: path.join(OUT_DIR, `env-moon-${renderer}-full.png`),
  });
  await browser.close();
  return { info, errs, cropPath };
}

// Decode both crop PNGs in a scratch page (Playwright canvas decode — no
// Node PNG dep) and compute per-image disc metrics + a pixel diff.
async function analyze(pathA, pathB) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(pathA).toString("base64");
  const bb = fs.readFileSync(pathB).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const metrics = (im) => {
        let litCount = 0;
        let sum = 0;
        let sumSq = 0;
        let minX = im.w,
          minY = im.h,
          maxX = -1,
          maxY = -1;
        for (let i = 0; i < im.data.length; i += 4) {
          const lum =
            0.299 * im.data[i] +
            0.587 * im.data[i + 1] +
            0.114 * im.data[i + 2];
          if (lum > 18) {
            litCount++;
            sum += lum;
            sumSq += lum * lum;
            const px = (i / 4) % im.w;
            const py = Math.floor(i / 4 / im.w);
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
        }
        const mean = litCount > 0 ? sum / litCount : 0;
        const variance = litCount > 0 ? sumSq / litCount - mean * mean : 0;
        return {
          litCount,
          meanLum: mean,
          stddevLum: Math.sqrt(Math.max(0, variance)),
          bbox:
            maxX >= 0
              ? {
                  minX,
                  minY,
                  maxX,
                  maxY,
                  w: maxX - minX + 1,
                  h: maxY - minY + 1,
                }
              : null,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      let mismatch = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > 60) mismatch++;
      }
      return {
        a: metrics(a),
        b: metrics(b),
        diffPct: (100 * mismatch) / (a.w * a.h),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const crops = {};
  for (const renderer of ["webgl", "webgpu"]) {
    const { info, errs, cropPath } = await capture(renderer);
    crops[renderer] = cropPath;
    console.log(
      `[${renderer}] moonDist=${info.moonDistanceKm.toFixed(0)}km consoleErrs=${errs.length}`,
    );
    if (errs.length > 0) console.log(`  first err: ${errs[0]}`);
    if (info.debugStats)
      console.log(`  debugStats: ${JSON.stringify(info.debugStats)}`);
  }

  const r = await analyze(crops.webgl, crops.webgpu);
  if (r.error) {
    console.log(`analyze error: ${r.error}`);
    process.exit(1);
  }
  for (const [name, m] of [
    ["webgl", r.a],
    ["webgpu", r.b],
  ]) {
    const b = m.bbox;
    console.log(
      `[${name}] lit=${m.litCount} meanLum=${m.meanLum.toFixed(1)} ` +
        `stddev=${m.stddevLum.toFixed(1)} bbox=${b ? `${b.w}x${b.h}@(${b.minX},${b.minY})` : "none"}`,
    );
  }
  const ratio = r.a.litCount > 0 ? r.b.litCount / r.a.litCount : 0;
  const centerDist =
    r.a.bbox && r.b.bbox
      ? Math.hypot(
          (r.a.bbox.minX + r.a.bbox.maxX) / 2 -
            (r.b.bbox.minX + r.b.bbox.maxX) / 2,
          (r.a.bbox.minY + r.a.bbox.maxY) / 2 -
            (r.b.bbox.minY + r.b.bbox.maxY) / 2,
        )
      : Infinity;
  console.log(
    `\nlitRatio(gpu/gl)=${ratio.toFixed(3)} centerDist=${centerDist.toFixed(1)}px cropDiff=${r.diffPct.toFixed(2)}%`,
  );
  const pass =
    ratio > 0.8 &&
    ratio < 1.25 &&
    r.a.stddevLum > 6 &&
    r.b.stddevLum > 6 &&
    centerDist < 40 &&
    r.diffPct < 15;
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
