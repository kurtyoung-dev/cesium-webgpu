// NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM regression guard.
//
// The WebGPU globe used to render blank at regional 2D zoom (~2.4 Mm) while
// rendering fine at full-globe zoom. Root cause (Batch 167): the globe
// command's per-command frustum cull used the tile's 3D-ECEF bounding volume,
// which a 2D PROJECTED frustum rejects at regional zoom. Fix: drop the 3D
// bounding volume in non-3D modes (the QuadtreePrimitive already culls).
//
// This probe renders the globe nadir over Lake Superior at 2.4 Mm in SCENE2D
// on both backends and counts non-dark globe pixels. WebGPU must render a
// comparable amount to WebGL (was ~0 before the fix). Also checks full-globe
// 2D to guard against a regression there.

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function litPixels(renderer, view) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  await page.goto(`${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(async (view) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const s = v.scene;
    s.skyBox.show = false;
    s.skyAtmosphere.show = false;
    s.morphTo2D(0);
    s.completeMorph();
    if (view === "full") {
      v.camera.setView({ destination: C.Rectangle.fromDegrees(-170, -80, 170, 80) });
    } else {
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-87.5, 47.7, 2_400_000),
        orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      });
    }
    for (let i = 0; i < 220; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, view);
  const out = `${OUT_DIR}/2dglobe-${view}-${renderer}.png`;
  await page.screenshot({ path: out });
  // Count non-dark pixels in the globe region (exclude top-right UI panel).
  const lit = await page.evaluate(async (durl) => {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let y = 60; y < c.height - 40; y++) {
          for (let xx = 20; xx < c.width - 280; xx++) {
            const i = (y * c.width + xx) * 4;
            if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
          }
        }
        res(n);
      };
      img.src = durl;
    });
  }, `data:image/png;base64,${(await fs.promises.readFile(out)).toString("base64")}`);
  await browser.close();
  return { lit, errs: errs.length, out };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let pass = true;
  for (const view of ["full", "regional"]) {
    const wgl = await litPixels("webgl", view);
    const wgpu = await litPixels("webgpu", view);
    const ratio = wgl.lit > 0 ? wgpu.lit / wgl.lit : 0;
    const ok = ratio >= 0.5 && wgpu.errs === 0; // WebGPU within 2x of WebGL coverage
    console.log(`\n[${view} 2D]`);
    console.log(`  webgl  lit px: ${wgl.lit}`);
    console.log(`  webgpu lit px: ${wgpu.lit}  errs: ${wgpu.errs}`);
    console.log(`  ratio webgpu/webgl: ${ratio.toFixed(2)}  → ${ok ? "OK" : "FAIL"}`);
    if (!ok) pass = false;
  }
  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
