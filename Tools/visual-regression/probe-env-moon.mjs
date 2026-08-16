#!/usr/bin/env node
// ENV-MOON-SLIVER acceptance probe — WebGL vs WebGPU moon parity.
// @purpose Moon parity: full-disc position/texture-variance/bbox/diff gates for the model-space RTE fix, plus a crescent-phase terminator lane.
// @status ACTIVE
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
//   centroid   — lit-pixel centroid (terminator-side parity for phases)
//   diffPct    — per-pixel RGB diff (threshold 60/765) between backends
// Full-disc PASS = litRatio(gpu/gl) in [0.8, 1.25], both stddev > 6, disc
// centers within 40 px, diffPct < 15%.
//
// Crescent-phase pass (NEW-ENV-MOON-CRESCENT-PROBE): a second capture at a
// ~half/crescent lunar phase (clock near last quarter) verifies the B505
// phase-terminator shading cross-backend. From the same Earth→moon vantage
// only the sun-facing part of the disc is lit, so litCount shrinks vs the
// full-disc pass. Gates:
//   partialFrac = litCount(phase)/litCount(full) in (0.15, 0.85) per backend
//     — proves a terminator exists (not a full disc, not a vanished moon);
//   litRatio(gpu/gl) in [0.8, 1.25] — same lit area both backends;
//   centroidDist < 25 px — terminator on the same side (lit-pixel centroid
//     shifts toward the sunlit limb identically);
//   diffPct < 15% on the phase crop.
// The expected illuminated fraction k = (1+cos(phaseAngle))/2 from
// Simon1994PlanetaryPositions is logged for context (not a hard gate — the
// luminance threshold clips near-terminator Lambertian falloff).
//
// Usage: node Tools/visual-regression/probe-env-moon.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const ISO = "2026-07-02T16:22:00Z";
// Near last quarter (new moon ~2026-07-14): waning ~half/crescent phase.
const ISO_PHASE = "2026-07-08T12:00:00Z";
const CROP = 420; // center crop size in px
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

    // Expected illuminated fraction k = (1+cos(phaseAngle))/2, where the
    // phase angle is at the moon between the sun and the Earth (the camera
    // sits on the Earth→moon line, so Earth ≈ observer direction).
    let illumFraction = null;
    try {
      const sunI =
        C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
          t,
          new C.Cartesian3(),
        );
      const moonI =
        C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
          t,
          new C.Cartesian3(),
        );
      const moonToSun = C.Cartesian3.subtract(sunI, moonI, new C.Cartesian3());
      const moonToEarth = C.Cartesian3.negate(moonI, new C.Cartesian3());
      const phaseAngle = C.Cartesian3.angleBetween(moonToSun, moonToEarth);
      illumFraction = (1 + Math.cos(phaseAngle)) / 2;
    } catch (e) {
      /* logging-only metric — gates don't depend on it */
    }
    return { moonDistanceKm: dist / 1000, debugStats: stats, illumFraction };
  }, iso);

  const cropPath = path.join(OUT_DIR, `env-moon-${tag}${renderer}.png`);
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
    path: path.join(OUT_DIR, `env-moon-${tag}${renderer}-full.png`),
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
        let sumX = 0;
        let sumY = 0;
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
            sumX += px;
            sumY += py;
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
          centroid:
            litCount > 0 ? { x: sumX / litCount, y: sumY / litCount } : null,
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

async function runPass(iso, tag, label) {
  const crops = {};
  for (const renderer of ["webgl", "webgpu"]) {
    const { info, errs, cropPath } = await capture(renderer, iso, tag);
    crops[renderer] = cropPath;
    console.log(
      `[${label}:${renderer}] moonDist=${info.moonDistanceKm.toFixed(0)}km ` +
        `expectedIllumFrac=${info.illumFraction === null ? "n/a" : info.illumFraction.toFixed(3)} ` +
        `consoleErrs=${errs.length}`,
    );
    if (errs.length > 0) console.log(`  first err: ${errs[0]}`);
    if (info.debugStats)
      console.log(`  debugStats: ${JSON.stringify(info.debugStats)}`);
  }
  const r = await analyze(crops.webgl, crops.webgpu);
  if (r.error) {
    console.log(`[${label}] analyze error: ${r.error}`);
    process.exit(1);
  }
  for (const [name, m] of [
    ["webgl", r.a],
    ["webgpu", r.b],
  ]) {
    const b = m.bbox;
    const c = m.centroid;
    console.log(
      `[${label}:${name}] lit=${m.litCount} meanLum=${m.meanLum.toFixed(1)} ` +
        `stddev=${m.stddevLum.toFixed(1)} bbox=${b ? `${b.w}x${b.h}@(${b.minX},${b.minY})` : "none"} ` +
        `centroid=${c ? `(${c.x.toFixed(1)},${c.y.toFixed(1)})` : "none"}`,
    );
  }
  return r;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // --- Pass 1: full-disc parity (original ENV-MOON-SLIVER gates) ---
  const full = await runPass(ISO, "", "full");
  const ratio = full.a.litCount > 0 ? full.b.litCount / full.a.litCount : 0;
  const centerDist =
    full.a.bbox && full.b.bbox
      ? Math.hypot(
          (full.a.bbox.minX + full.a.bbox.maxX) / 2 -
            (full.b.bbox.minX + full.b.bbox.maxX) / 2,
          (full.a.bbox.minY + full.a.bbox.maxY) / 2 -
            (full.b.bbox.minY + full.b.bbox.maxY) / 2,
        )
      : Infinity;
  console.log(
    `\n[full] litRatio(gpu/gl)=${ratio.toFixed(3)} centerDist=${centerDist.toFixed(1)}px cropDiff=${full.diffPct.toFixed(2)}%`,
  );
  const fullPass =
    ratio > 0.8 &&
    ratio < 1.25 &&
    full.a.stddevLum > 6 &&
    full.b.stddevLum > 6 &&
    centerDist < 40 &&
    full.diffPct < 15;
  console.log(fullPass ? "[full] PASS" : "[full] FAIL");

  // --- Pass 2: crescent/half phase (NEW-ENV-MOON-CRESCENT-PROBE gates) ---
  const ph = await runPass(ISO_PHASE, "crescent-", "phase");
  const phRatio = ph.a.litCount > 0 ? ph.b.litCount / ph.a.litCount : 0;
  const partialFracGl =
    full.a.litCount > 0 ? ph.a.litCount / full.a.litCount : 0;
  const partialFracGpu =
    full.b.litCount > 0 ? ph.b.litCount / full.b.litCount : 0;
  const centroidDist =
    ph.a.centroid && ph.b.centroid
      ? Math.hypot(
          ph.a.centroid.x - ph.b.centroid.x,
          ph.a.centroid.y - ph.b.centroid.y,
        )
      : Infinity;
  console.log(
    `\n[phase] litRatio(gpu/gl)=${phRatio.toFixed(3)} ` +
      `partialFrac gl=${partialFracGl.toFixed(3)} gpu=${partialFracGpu.toFixed(3)} ` +
      `centroidDist=${centroidDist.toFixed(1)}px cropDiff=${ph.diffPct.toFixed(2)}%`,
  );
  const phasePass =
    phRatio > 0.8 &&
    phRatio < 1.25 &&
    partialFracGl > 0.15 &&
    partialFracGl < 0.85 &&
    partialFracGpu > 0.15 &&
    partialFracGpu < 0.85 &&
    centroidDist < 25 &&
    ph.diffPct < 15;
  console.log(phasePass ? "[phase] PASS" : "[phase] FAIL");

  const pass = fullPass && phasePass;
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
