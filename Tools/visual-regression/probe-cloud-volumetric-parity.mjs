#!/usr/bin/env node
// Probe (NEW-CLOUD-IMPOSTOR-FS-PARITY): the WebGPU cloud FS was a flat 2D
// radial-noise impostor that filled most of the billboard quad, while WebGL's
// CloudCollectionFS raymarches a per-cloud ellipsoid (0.82 * maximumSize) with
// Gardner shading + worley erosion — so WebGPU drew a ~4-5x too-large blob.
// DEFERRED_WORK measured "281x183 px noise blob vs WebGL's 59x52 px raymarched
// core" at a 2000x1300 m cloud / 15 km nadir camera.
//
// This probe renders the SAME single-cloud scene on BOTH backends, measures
// each cloud's bright-pixel footprint (bounding box W x H + filled px), and
// saves both PNGs for visual inspection. After the port the WebGPU footprint
// should collapse toward the WebGL raymarched core instead of filling the quad.
//
// Usage: node Tools/visual-regression/probe-cloud-volumetric-parity.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function captureBackend(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      scene = v.scene;

    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK;

    const LON = -75.0,
      LAT = 40.0;
    const clouds = scene.primitives.add(new C.CloudCollection());
    clouds.add({
      position: C.Cartesian3.fromDegrees(LON, LAT, 5000.0),
      scale: new C.Cartesian2(2000, 1300),
      maximumSize: new C.Cartesian3(2000, 1300, 900),
    });
    scene.morphTo3D(0);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(LON, LAT, 15000.0),
    });

    const frame = () =>
      new Promise((r) => {
        scene.render();
        requestAnimationFrame(r);
      });
    for (let i = 0; i < 80; i++) await frame();

    // Capture inside postRender (present clears the WebGPU canvas texture).
    return new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        let count = 0,
          minX = c.width,
          minY = c.height,
          maxX = -1,
          maxY = -1;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (d[i] + d[i + 1] + d[i + 2] > 90) {
              count++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        resolve({
          png: off.toDataURL("image/png"),
          count,
          bboxW: maxX >= minX ? maxX - minX + 1 : 0,
          bboxH: maxY >= minY ? maxY - minY + 1 : 0,
          w: c.width,
          h: c.height,
        });
      });
      scene.render();
    });
  });

  writeFileSync(
    join(OUT, `cloud-volumetric-${renderer}.png`),
    Buffer.from(result.png.split(",")[1], "base64"),
  );
  await browser.close();
  return { ...result, errors };
}

const gl = await captureBackend("webgl");
const gpu = await captureBackend("webgpu");

console.log(
  `WebGL  cloud: filled=${gl.count}px  bbox=${gl.bboxW}x${gl.bboxH}  errors=${gl.errors.length}`,
);
console.log(
  `WebGPU cloud: filled=${gpu.count}px  bbox=${gpu.bboxW}x${gpu.bboxH}  errors=${gpu.errors.length}`,
);
gpu.errors
  .slice(0, 5)
  .forEach((e) => console.log("  GPU ERR:", e.slice(0, 160)));

// Parity heuristic: WebGPU footprint area within 2x of WebGL (was ~4-5x).
const glArea = gl.bboxW * gl.bboxH || 1;
const gpuArea = gpu.bboxW * gpu.bboxH || 1;
const ratio = gpuArea / glArea;
console.log(
  `bbox area ratio WebGPU/WebGL = ${ratio.toFixed(2)} (target <= 2.0)`,
);
console.log(
  "PNGs: output/cloud-volumetric-webgl.png, output/cloud-volumetric-webgpu.png",
);
