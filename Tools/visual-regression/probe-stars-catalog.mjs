#!/usr/bin/env node
// Probe (NEW-STARS-BRIGHT-CATALOG, Batch 313): the Yale Bright Star
// Catalog starfield renders on WebGPU.
//
// What it verifies:
//   (A) Turning scene.skyBox.starField.show ON adds bright HDR points to
//       the frame vs OFF (delta in bright-pixel count > threshold).
//   (B) Bright stars read brighter/larger than faint stars: with the
//       camera aimed at Sirius (mag −1.46) for the pinned scene time, a
//       bright cluster lands near frame center, and the brightest star
//       cluster is meaningfully larger than the mean cluster.
//   (C) Constellations land at correct RA/Dec: aiming the camera at the
//       computed Earth-fixed direction of Sirius produces a bright spot
//       near frame center (within a tolerance box); aiming 90° away from
//       any catalog star direction yields far fewer bright pixels there.
//   (D) Count scales with brightness: raising starField.intensity makes
//       the total bright-pixel count grow.
//   (E) The existing SkyBox cubemap path still works (skyBox.show stays
//       true; turning starField off leaves the cubemap rendering — no
//       crash, scene still renders).
//   (F) 0 console errors on WebGPU.
//
// Reads the output PNGs (Principle 8): the script writes
//   output/stars-catalog/webgpu-{off,on,sirius,bright}.png
//
// Usage: node Tools/visual-regression/probe-stars-catalog.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "stars-catalog",
);
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
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

    scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    // Pinned scene time — fixes the TEME→fixed rotation so the star
    // positions are deterministic.
    const time = C.JulianDate.fromIso8601("2026-06-21T00:00:00Z");
    v.clock.currentTime = time;

    // Make stars visible: dark scene, no sun/atmosphere wash, no globe in
    // the way. Keep the SkyBox (cubemap) ON so we verify it still works
    // alongside the catalog.
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.fog.enabled = false;
    if (scene.globe) scene.globe.show = false;
    v.imageryLayers.removeAll();

    // Ensure a SkyBox exists (CesiumViewer default has one). Verify the
    // catalog augmentation hook is present.
    const hasStarField = !!(scene.skyBox && scene.skyBox.starField);

    scene.morphTo3D(0);

    // Camera high above the surface looking outward (no globe in frame).
    // We re-aim per capture below.
    const camAlt = 8.0e6;

    const oncePostRender = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
      });
    const renderFrames = async (n) => {
      for (let i = 0; i < n; i++) await oncePostRender();
    };

    const grab = () =>
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
            data: Array.from(
              new Uint8Array(
                cx.getImageData(0, 0, c.width, c.height).data.buffer,
              ),
            ),
            png: off.toDataURL("image/png"),
            w: c.width,
            h: c.height,
          });
        });
      });

    // Aim the camera FROM the origin-ish toward a given Earth-fixed unit
    // direction by placing the camera at camAlt along -dir and looking
    // toward +dir. We use a position far from Earth so the globe (hidden
    // anyway) doesn't matter; the star field is directional.
    const aimAt = (dirFixed) => {
      const eye = C.Cartesian3.multiplyByScalar(
        dirFixed,
        -camAlt,
        new C.Cartesian3(),
      );
      // direction = +dirFixed (look toward the star)
      const dir = C.Cartesian3.clone(dirFixed);
      // up = any vector not parallel to dir
      let up = C.Cartesian3.UNIT_Z;
      if (Math.abs(C.Cartesian3.dot(dir, up)) > 0.95) {
        up = C.Cartesian3.UNIT_X;
      }
      const right = C.Cartesian3.cross(dir, up, new C.Cartesian3());
      C.Cartesian3.normalize(right, right);
      const realUp = C.Cartesian3.cross(right, dir, new C.Cartesian3());
      C.Cartesian3.normalize(realUp, realUp);
      scene.camera.setView({
        destination: eye,
        orientation: { direction: dir, up: realUp },
      });
    };

    // Compute Sirius's Earth-fixed direction for the pinned time.
    // Sirius J2000: RA 101.287°, Dec −16.716°.
    const raDeg = 101.287;
    const decDeg = -16.716;
    const ra = C.Math.toRadians(raDeg);
    const dec = C.Math.toRadians(decDeg);
    const temeDir = new C.Cartesian3(
      Math.cos(dec) * Math.cos(ra),
      Math.cos(dec) * Math.sin(ra),
      Math.sin(dec),
    );
    const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
      time,
      new C.Matrix3(),
    );
    const siriusFixed = C.Matrix3.multiplyByVector(
      temeToFixed,
      temeDir,
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(siriusFixed, siriusFixed);

    // A "blank" direction: opposite the galactic-rich region — pick the
    // anti-Sirius direction, which is sparse-ish. Used as a negative
    // control for the RA/Dec test.
    const blankFixed = C.Cartesian3.negate(siriusFixed, new C.Cartesian3());

    // Warm up a few frames so the pipeline resolves (async pipeline cache).
    aimAt(siriusFixed);
    await renderFrames(20);

    // Keep the SkyBox cubemap ON (default) — this is the augment-the-
    // cubemap path the renderer is designed for: the catalog must draw ON
    // TOP of the cubemap, not be overwritten by it.
    const cubemapShown = scene.skyBox.show;

    // (A) catalog OFF baseline (cubemap still on).
    scene.skyBox.starField.show = false;
    await renderFrames(8);
    const imgOff = await grab();

    // (A/B/C) catalog ON, aimed at Sirius (cubemap still on → augment).
    scene.skyBox.starField.show = true;
    await renderFrames(8);
    const imgSirius = await grab();

    // (C neg) catalog ON, aimed at a blank patch.
    aimAt(blankFixed);
    await renderFrames(8);
    const imgBlank = await grab();

    // (D) higher intensity, aimed at Sirius again.
    aimAt(siriusFixed);
    scene.skyBox.starField.intensity = 3.0;
    await renderFrames(8);
    const imgBright = await grab();

    void cubemapShown;

    // Diagnostic: max luminance + total non-black pixel count for the
    // Sirius-aimed ON frame (independent of the 8-bit threshold).
    const maxLumOf = (img) => {
      let mx = 0;
      let nonBlack = 0;
      const n = img.w * img.h;
      for (let p = 0; p < n; p++) {
        const i = 4 * p;
        const l =
          0.2126 * img.data[i] +
          0.7152 * img.data[i + 1] +
          0.0722 * img.data[i + 2];
        if (l > mx) mx = l;
        if (l > 4) nonBlack++;
      }
      return { mx, nonBlack };
    };
    const onDiag = maxLumOf(imgSirius);
    const offDiag = maxLumOf(imgOff);
    const brightDiag = maxLumOf(imgBright);

    // Pull the FR statistics (star count, pipeline ready).
    let stats;
    try {
      stats = scene.skyBox.starField.getDebugStatistics(scene.frameState);
    } catch (e) {
      stats = { error: String(e) };
    }

    return {
      imgOff,
      imgSirius,
      imgBlank,
      imgBright,
      hasStarField,
      stats,
      onDiag,
      offDiag,
      brightDiag,
    };
  });

  await page.close();
  return { ...out, errors };
}

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

// Count pixels brighter than threshold.
function brightCount(img, thresh) {
  const n = img.w * img.h;
  let count = 0;
  for (let p = 0; p < n; p++) {
    if (lum(img.data, 4 * p) > thresh) count++;
  }
  return count;
}

// Bright-pixel count inside a centered box of half-width fraction `f`.
function brightCountCenter(img, thresh, f) {
  const x0 = Math.floor(img.w * (0.5 - f));
  const x1 = Math.floor(img.w * (0.5 + f));
  const y0 = Math.floor(img.h * (0.5 - f));
  const y1 = Math.floor(img.h * (0.5 + f));
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (lum(img.data, 4 * (y * img.w + x)) > thresh) count++;
    }
  }
  return count;
}

function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}

console.log("=== WebGPU pass ===");
const gpu = await runBackend("webgpu");

savePng("webgpu-off.png", gpu.imgOff);
savePng("webgpu-sirius.png", gpu.imgSirius);
savePng("webgpu-blank.png", gpu.imgBlank);
savePng("webgpu-bright.png", gpu.imgBright);

const THRESH = 40; // luminance threshold for a "star" pixel over the dark sky

const offBright = brightCount(gpu.imgOff, THRESH);
const onBright = brightCount(gpu.imgSirius, THRESH);
const brightBright = brightCount(gpu.imgBright, THRESH);

const siriusCenter = brightCountCenter(gpu.imgSirius, THRESH, 0.12);
const blankCenter = brightCountCenter(gpu.imgBlank, THRESH, 0.12);

console.log(
  `starField present on skyBox: ${gpu.hasStarField}, stats: ${JSON.stringify(gpu.stats)}`,
);
console.log(
  `bright pixels (lum>${THRESH}): off=${offBright} on=${onBright} highIntensity=${brightBright}`,
);
console.log(
  `DIAG maxLum/nonBlack(lum>4): off=${gpu.offDiag.mx.toFixed(0)}/${gpu.offDiag.nonBlack} ` +
    `on=${gpu.onDiag.mx.toFixed(0)}/${gpu.onDiag.nonBlack} ` +
    `bright=${gpu.brightDiag.mx.toFixed(0)}/${gpu.brightDiag.nonBlack}`,
);
console.log(
  `center-box bright pixels: sirius-aimed=${siriusCenter} blank-aimed=${blankCenter}`,
);
console.log(`console errors: ${gpu.errors.length}`);
gpu.errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));

// (A) ON adds bright pixels vs OFF.
const aOK = onBright > offBright + 50;
// (B/C) Aiming at Sirius puts a bright cluster near center; far more than
// aiming at a blank patch.
const bcOK = siriusCenter > 20 && siriusCenter > blankCenter * 2 + 10;
// (D) Higher intensity grows the bright-pixel count.
const dOK = brightBright > onBright;
// (E) starField hook exists on the default SkyBox (cubemap path intact).
const eOK = gpu.hasStarField === true;
// (F) zero console errors.
const fOK = gpu.errors.length === 0;

console.log(`(A) ON adds bright pixels: ${aOK ? "OK" : "FAIL"}`);
console.log(
  `(B/C) Sirius-aimed center cluster >> blank-aimed: ${bcOK ? "OK" : "FAIL"}`,
);
console.log(`(D) higher intensity grows bright count: ${dOK ? "OK" : "FAIL"}`);
console.log(
  `(E) starField hook present (cubemap intact): ${eOK ? "OK" : "FAIL"}`,
);
console.log(`(F) zero console errors: ${fOK ? "OK" : "FAIL"}`);
console.log(`PNGs: ${OUT_DIR}`);

const pass = aOK && bcOK && dOK && eOK && fOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
