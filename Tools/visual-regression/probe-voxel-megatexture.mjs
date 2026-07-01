// PARITY-VOXEL-MEGATEXTURE-UPLOAD acceptance probe.
//
// Loads VoxelBox3DTiles on the WebGPU renderer, adds a VoxelPrimitive, and
// ray-marches the volume. Asserts that the REAL per-tile 'a' VEC4 property
// data was uploaded into the 3D megatexture (replacing the 4x4x4 gradient
// placeholder) AND that the volume renders non-empty pixels.
//
// Discriminators the probe checks:
//   1. cache.usingRealData === true and dataUpload.phase === 'done'
//      (the renderer swapped the placeholder for real tile content).
//   2. The uploaded texture dimensions match the tileset's [2,4,3] dims
//      (NOT the placeholder's 4x4x4).
//   3. The ray-march produces non-black pixels (the volume is visible).
//
// A FAIL/partial is reported honestly if only the placeholder still renders.
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const consoleErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") consoleErrors.push(t);
  if (t.startsWith("PROBE:")) console.log(t);
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const res = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  if (!C.VoxelPrimitive || !C.Cesium3DTilesVoxelProvider) {
    return { error: "VoxelPrimitive / provider not exported" };
  }

  const provider = await C.Cesium3DTilesVoxelProvider.fromUrl(
    "/Apps/SampleData/Cesium3DTiles/Voxel/VoxelBox3DTiles/tileset.json",
  );
  const providerDims = {
    x: provider.dimensions.x,
    y: provider.dimensions.y,
    z: provider.dimensions.z,
  };
  // The WebGPU voxel renderer draws a [-0.5,0.5] proxy cube transformed by
  // `primitive.modelMatrix` (the full shape/OBB-transform wiring is a separate
  // WebGPU increment). To make the ray-marched REAL-data volume visible with a
  // normal camera, place + scale the proxy cube via modelMatrix. This does NOT
  // affect the data-upload path being tested — it only positions the cube so
  // the ray-march has screen coverage.
  const SCALE = 500000.0; // 500 km cube — comfortably fills the view.
  const center = C.Cartesian3.fromDegrees(0.0, 0.0, SCALE * 0.5);
  const enu = C.Transforms.eastNorthUpToFixedFrame(center);
  const scaleM = C.Matrix4.fromUniformScale(SCALE, new C.Matrix4());
  const modelMatrix = C.Matrix4.multiply(enu, scaleM, new C.Matrix4());

  const prim = new C.VoxelPrimitive({ provider, modelMatrix });
  scene.primitives.add(prim);

  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  scene.backgroundColor = C.Color.BLACK;

  // Aim the camera at the cube center from a few cube-widths away.
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(0.0, 0.0, SCALE * 3.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });

  // Render many frames so the async root-tile request → glTF process → upload
  // state machine completes and the real-data bind group is swapped in.
  for (let i = 0; i < 300; i++) {
    scene.render();
    await new Promise((r) => setTimeout(r, 16));
  }

  // Inspect the WebGPU cache to confirm real data was uploaded.
  const cache = prim._webgpuCache || {};
  const du = cache.dataUpload || {};
  const upDims = du.texture
    ? {
        w: du.texture.width,
        h: du.texture.height,
        d: du.texture.depthOrArrayLayers,
      }
    : null;
  const upFormat = du.texture ? du.texture.format : null;
  const canvas = scene.canvas;

  return {
    providerDims,
    usingRealData: cache.usingRealData === true,
    uploadPhase: du.phase ?? null,
    uploadDims: upDims,
    uploadFormat: upFormat,
    canvasW: canvas.width,
    canvasH: canvas.height,
  };
});

console.log(JSON.stringify(res, null, 2));

const buf = await page.screenshot();
fs.writeFileSync(
  "Tools/visual-regression/output/probe-voxel-megatexture.png",
  buf,
);
console.log("PNG bytes:", buf.length);
console.log("Console errors:", consoleErrors.length);
if (consoleErrors.length) {
  console.log(consoleErrors.slice(0, 8).join("\n"));
}

// Decode the screenshot PNG back into the page (WebGPU canvases don't read
// reliably via drawImage without preserveDrawingBuffer, but the composited
// Playwright screenshot always contains the rendered frame). Sample the
// center region where the ray-marched cube sits.
const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
const px = await page.evaluate(async (url) => {
  const img = new Image();
  await new Promise((r) => {
    img.onload = r;
    img.src = url;
  });
  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const w = img.width;
  const h = img.height;
  // Sample a centered region (avoids the top toolbar + right help panel).
  const rx = Math.floor(w * 0.28);
  const ry = Math.floor(h * 0.28);
  const rw = Math.floor(w * 0.4);
  const rh = Math.floor(h * 0.4);
  const d = ctx.getImageData(rx, ry, rw, rh).data;
  let nonBlack = 0;
  let maxLum = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const colorSet = new Set();
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] + d[i + 1] + d[i + 2];
    if (lum > 12) {
      nonBlack++;
      sumR += d[i];
      sumG += d[i + 1];
      sumB += d[i + 2];
      colorSet.add(`${d[i] >> 4}_${d[i + 1] >> 4}_${d[i + 2] >> 4}`);
    }
    if (lum > maxLum) maxLum = lum;
  }
  const n = Math.max(1, nonBlack);
  return {
    nonBlackPixels: nonBlack,
    sampled: (d.length / 4) | 0,
    maxLum,
    avgColor: [
      Math.round(sumR / n),
      Math.round(sumG / n),
      Math.round(sumB / n),
    ],
    distinctColors: colorSet.size,
  };
}, dataUrl);
console.log("Pixel analysis:", JSON.stringify(px));

// Verdict. The placeholder gradient (rgba8unorm R=x/G=y/B=z, alpha≈0.5) would
// render a smooth multi-hue ramp; the real 'a' data (rgba32float, dims 2x4x3,
// min[0,0,0,1]..max[1,1,1,1]) renders the actual property structure. We assert
// the uploaded texture is the REAL tile (dims match + phase done + real-data
// flag) AND the ray-march produced visible pixels.
const pass =
  !res.error &&
  res.usingRealData === true &&
  res.uploadPhase === "done" &&
  res.uploadDims &&
  res.uploadDims.w === res.providerDims.x &&
  res.uploadDims.h === res.providerDims.y &&
  res.uploadDims.d === res.providerDims.z &&
  px.nonBlackPixels > 500 &&
  consoleErrors.length === 0;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");

await browser.close();
process.exit(pass ? 0 : 1);
