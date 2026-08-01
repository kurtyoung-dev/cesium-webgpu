#!/usr/bin/env node
// Probe (NEW-STARS-BRIGHT-CATALOG-WEBGL-FALLBACK, Batch 324): the WebGL
// bright-star catalog starfield renders the SAME physical stars as WebGPU.
//
// What it verifies:
//   (A) WebGL now renders star pixels with the catalog ON (non-black star
//       points present) and ~0 with it OFF — i.e. the new WebGL STAR_FIELD
//       feature renderer actually draws (before this change WebGL kept only
//       the static SkyBox cubemap and StarField.update was an inert no-op).
//   (B) The WebGL star pattern MATCHES the WebGPU star pattern: aimed at the
//       same celestial direction (Sirius) for the same pinned scene time,
//       the bright-star clusters land in the same screen regions on both
//       backends (positional IoU of bright pixels above a tolerance), and
//       both put a bright cluster near frame center.
//
// To compare the catalog ALONE (not the cubemap), the SkyBox cubemap is
// turned OFF on both backends so only the physically-placed catalog stars
// render. Atmosphere / sun / moon / globe are disabled so the sky is dark.
//
// Reads the output PNGs (Principle 8): writes
//   output/starfield-webgl-parity/{webgl,webgpu}-{off,on}.png
//
// Usage: PROBE_BASE=http://localhost:8080 \
//        node Tools/visual-regression/probe-starfield-webgl-parity.mjs
// Use Edge (Chrome/Firefox won't do WebGPU).

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "starfield-webgl-parity",
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
    // positions are deterministic across backends.
    const time = C.JulianDate.fromIso8601("2026-06-21T00:00:00Z");
    v.clock.currentTime = time;

    // Dark scene: no sun/atmosphere wash, no globe, no moon.
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.fog.enabled = false;
    if (scene.globe) scene.globe.show = false;
    v.imageryLayers.removeAll();

    const hasStarField = !!(scene.skyBox && scene.skyBox.starField);
    // Turn the cubemap OFF so we compare the CATALOG alone (the cubemap
    // texture is identical on both backends and would dominate the diff).
    if (scene.skyBox) scene.skyBox.show = false;

    scene.morphTo3D(0);
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

    // Aim the camera toward an Earth-fixed unit direction (look toward the
    // stars). Camera placed far from Earth (globe hidden anyway).
    const aimAt = (dirFixed) => {
      const eye = C.Cartesian3.multiplyByScalar(
        dirFixed,
        -camAlt,
        new C.Cartesian3(),
      );
      const dir = C.Cartesian3.clone(dirFixed);
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

    // Sirius J2000: RA 101.287°, Dec −16.716°. Compute its Earth-fixed
    // direction for the pinned time — same math as the renderer.
    const ra = C.Math.toRadians(101.287);
    const dec = C.Math.toRadians(-16.716);
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

    aimAt(siriusFixed);
    // Warm up: WebGPU async pipeline + WebGL lazy FR import both settle.
    await renderFrames(30);

    // Catalog OFF baseline.
    scene.skyBox.starField.show = false;
    await renderFrames(8);
    const imgOff = await grab();

    // Catalog ON.
    scene.skyBox.starField.show = true;
    await renderFrames(12);
    const imgOn = await grab();

    let stats;
    try {
      stats = scene.skyBox.starField.getDebugStatistics(scene.frameState);
    } catch (e) {
      stats = { error: String(e) };
    }

    return { imgOff, imgOn, hasStarField, stats };
  });

  await page.close();
  return { ...out, errors };
}

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

function brightCount(img, thresh) {
  const n = img.w * img.h;
  let count = 0;
  for (let p = 0; p < n; p++) {
    if (lum(img.data, 4 * p) > thresh) count++;
  }
  return count;
}

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

// Build a downsampled bright-pixel mask (block grid) so sub-pixel sprite
// offsets between backends don't tank the overlap. Returns a Set of block
// indices that contain >=1 bright pixel.
function brightBlockMask(img, thresh, block) {
  const cols = Math.ceil(img.w / block);
  const rows = Math.ceil(img.h / block);
  const mask = new Set();
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (lum(img.data, 4 * (y * img.w + x)) > thresh) {
        const bx = (x / block) | 0;
        const by = (y / block) | 0;
        mask.add(by * cols + bx);
      }
    }
  }
  return { mask, cols, rows };
}

// Intersection-over-union of two block masks.
function maskIoU(a, b) {
  let inter = 0;
  for (const k of a.mask) if (b.mask.has(k)) inter++;
  const uni = a.mask.size + b.mask.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}

console.log("=== WebGL pass ===");
const gl = await runBackend("webgl");
console.log("=== WebGPU pass ===");
const gpu = await runBackend("webgpu");

savePng("webgl-off.png", gl.imgOff);
savePng("webgl-on.png", gl.imgOn);
savePng("webgpu-off.png", gpu.imgOff);
savePng("webgpu-on.png", gpu.imgOn);

const THRESH = 40; // luminance threshold for a "star" pixel over dark sky
const BLOCK = 12; // block grid edge (px) for tolerant positional overlap

const glOff = brightCount(gl.imgOff, THRESH);
const glOn = brightCount(gl.imgOn, THRESH);
const gpuOff = brightCount(gpu.imgOff, THRESH);
const gpuOn = brightCount(gpu.imgOn, THRESH);

const glCenter = brightCountCenter(gl.imgOn, THRESH, 0.12);
const gpuCenter = brightCountCenter(gpu.imgOn, THRESH, 0.12);

const glMask = brightBlockMask(gl.imgOn, THRESH, BLOCK);
const gpuMask = brightBlockMask(gpu.imgOn, THRESH, BLOCK);
const iou = maskIoU(glMask, gpuMask);

console.log(
  `WebGL  starField present=${gl.hasStarField} stats=${JSON.stringify(gl.stats)}`,
);
console.log(
  `WebGPU starField present=${gpu.hasStarField} stats=${JSON.stringify(gpu.stats)}`,
);
console.log(
  `bright pixels (lum>${THRESH}): WebGL off=${glOff} on=${glOn} | WebGPU off=${gpuOff} on=${gpuOn}`,
);
console.log(`center-box bright pixels: WebGL=${glCenter} WebGPU=${gpuCenter}`);
console.log(
  `bright-block IoU (block=${BLOCK}px): ${iou.toFixed(3)} ` +
    `(WebGL blocks=${glMask.mask.size}, WebGPU blocks=${gpuMask.mask.size})`,
);
console.log(
  `console errors: WebGL=${gl.errors.length} WebGPU=${gpu.errors.length}`,
);
gl.errors.slice(0, 5).forEach((e) => console.log("  GL ERR:", e.slice(0, 200)));
gpu.errors
  .slice(0, 5)
  .forEach((e) => console.log("  GPU ERR:", e.slice(0, 200)));

// (A) WebGL now renders stars: ON adds many bright pixels vs ~0 OFF.
const aOK = glOn > 200 && glOn > glOff * 5 + 100;
// (B1) WebGL puts a bright cluster near center (Sirius), like WebGPU.
const b1OK = glCenter > 20 && gpuCenter > 20;
// (B2) WebGL star pattern matches WebGPU positionally (tolerant IoU).
const b2OK = iou > 0.3;

console.log(`(A) WebGL renders stars (was ~0): ${aOK ? "OK" : "FAIL"}`);
console.log(
  `(B1) both put a bright cluster near center: ${b1OK ? "OK" : "FAIL"}`,
);
console.log(
  `(B2) WebGL pattern matches WebGPU (IoU>0.30): ${b2OK ? "OK" : "FAIL"}`,
);
console.log(`PNGs: ${OUT_DIR}`);

const pass = aOK && b1OK && b2OK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
