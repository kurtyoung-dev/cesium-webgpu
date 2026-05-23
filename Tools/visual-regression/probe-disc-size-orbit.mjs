#!/usr/bin/env node
// Capture WebGL vs WebGPU at orbit altitude with ALL atmosphere disabled,
// then measure the visible Earth disc bounds (left/right/top/bottom pixel
// extents) on each backend. If the bounds differ by more than 1-2 pixels,
// there is a projection-precision / RTE-camera-offset gap at large camera
// positions.
//
// Batch 63 noted the WebGPU globe disc appears ~10% smaller at orbit.
// This probe quantifies that.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEWS = [
  { name: "orbit-12mm-northpole", lon: 0, lat: 80, height: 12_000_000 },
  { name: "orbit-12mm-equator", lon: 0, lat: 0, height: 12_000_000 },
  { name: "orbit-20mm-equator", lon: 0, lat: 0, height: 20_000_000 },
];

async function captureAndMeasure(renderer, view) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const cameraDump = await page.evaluate(
    async ({ view }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "").toLowerCase().includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      // Pin the clock for cross-session reproducibility (Batch 70).
      // Even though lighting is disabled below, day/night-shading
      // defines can still fire on certain imagery providers, so the
      // safe default is to pin everywhere.
      const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
      // Kill ALL atmosphere/lighting so only the globe disc is visible.
      v.scene.skyAtmosphere.show = false;
      v.scene.globe.showGroundAtmosphere = false;
      v.scene.skyBox.show = false;
      v.scene.fog.enabled = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      v.scene.globe.enableLighting = false;
      v.scene.backgroundColor = C.Color.BLACK;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
      const cam = v.camera;
      return {
        positionWC: [cam.positionWC.x, cam.positionWC.y, cam.positionWC.z],
        directionWC: [cam.directionWC.x, cam.directionWC.y, cam.directionWC.z],
        upWC: [cam.upWC.x, cam.upWC.y, cam.upWC.z],
        fovy: cam.frustum.fovy,
        aspectRatio: cam.frustum.aspectRatio,
        near: cam.frustum.near,
        far: cam.frustum.far,
        distFromCenter: Math.sqrt(
          cam.positionWC.x ** 2 +
            cam.positionWC.y ** 2 +
            cam.positionWC.z ** 2,
        ),
      };
    },
    { view },
  );

  await page.waitForTimeout(800);
  const pngPath = path.join(OUT_DIR, `disc-${view.name}-${renderer}.png`);
  await page.screenshot({ path: pngPath });

  // Decode the screenshot inside the page and measure the disc bounds.
  // "Earth pixel" = any pixel with at least one channel ≥ 20 (above pure
  // black space). The bounds give us the visible disc extent in pixels.
  const measurement = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    // Avoid UI chrome top-right + bottom: clip the sample region.
    const xLo = 0,
      xHi = Math.floor(img.width * 0.78);
    const yLo = Math.floor(img.height * 0.06),
      yHi = Math.floor(img.height * 0.9);
    let minX = img.width,
      maxX = 0,
      minY = img.height,
      maxY = 0;
    let earthPixels = 0;
    for (let y = yLo; y < yHi; y++) {
      for (let x = xLo; x < xHi; x++) {
        const i = (y * img.width + x) * 4;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        if (r >= 20 || g >= 20 || b >= 20) {
          earthPixels++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      width: img.width,
      height: img.height,
      sampleRegion: { xLo, xHi, yLo, yHi },
      earthBounds: { minX, maxX, minY, maxY },
      discWidth: maxX - minX,
      discHeight: maxY - minY,
      earthPixels,
    };
  }, fs.readFileSync(pngPath).toString("base64"));

  await browser.close();
  return { cameraDump, measurement };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[disc-size-orbit] atmosphere disabled, both backends");
  console.log();
  for (const view of VIEWS) {
    console.log(`=== ${view.name} ===`);
    const wgl = await captureAndMeasure("webgl", view);
    const wgpu = await captureAndMeasure("webgpu", view);
    const diff = {
      width: wgpu.measurement.discWidth - wgl.measurement.discWidth,
      height: wgpu.measurement.discHeight - wgl.measurement.discHeight,
      area: wgpu.measurement.earthPixels - wgl.measurement.earthPixels,
    };
    const pctW =
      ((diff.width / wgl.measurement.discWidth) * 100).toFixed(2) + "%";
    const pctH =
      ((diff.height / wgl.measurement.discHeight) * 100).toFixed(2) + "%";
    const pctA =
      ((diff.area / wgl.measurement.earthPixels) * 100).toFixed(2) + "%";
    console.log(
      `  WebGL  disc: w=${wgl.measurement.discWidth} h=${wgl.measurement.discHeight} pixels=${wgl.measurement.earthPixels}`,
    );
    console.log(
      `  WebGPU disc: w=${wgpu.measurement.discWidth} h=${wgpu.measurement.discHeight} pixels=${wgpu.measurement.earthPixels}`,
    );
    console.log(
      `  Δ: dw=${diff.width} (${pctW}) dh=${diff.height} (${pctH}) dpix=${diff.area} (${pctA})`,
    );
    // Compare camera state across backends.
    const camDelta = {
      pos: wgpu.cameraDump.positionWC.map(
        (x, i) => x - wgl.cameraDump.positionWC[i],
      ),
      dir: wgpu.cameraDump.directionWC.map(
        (x, i) => x - wgl.cameraDump.directionWC[i],
      ),
    };
    const posSame = camDelta.pos.every((d) => Math.abs(d) < 1e-3);
    const dirSame = camDelta.dir.every((d) => Math.abs(d) < 1e-9);
    console.log(
      `  camera identical: pos=${posSame} dir=${dirSame} dist=${wgpu.cameraDump.distFromCenter.toFixed(0)}m`,
    );
    if (!posSame) console.log(`    posΔ=${camDelta.pos.map((x) => x.toFixed(3))}`);
    if (!dirSame) console.log(`    dirΔ=${camDelta.dir}`);
    console.log();
  }
})();
