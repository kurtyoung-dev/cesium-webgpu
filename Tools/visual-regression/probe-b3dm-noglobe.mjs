// @purpose Minimal check that the BatchTableHierarchy b3dm tileset renders on WebGPU with the globe removed from the picture.
// @status INVESTIGATION

import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("PROBE:")) console.log(t);
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
const res = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    scene = v.scene;
  const ts = await C.Cesium3DTileset.fromUrl(
    "/Apps/SampleData/Cesium3DTiles/Hierarchy/BatchTableHierarchy/tileset.json",
  );
  scene.primitives.add(ts);
  for (let i = 0; i < 60; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const bs = ts.boundingSphere,
    cart = C.Cartographic.fromCartesian(bs.center);
  v.camera.setView({
    destination: C.Cartesian3.fromRadians(
      cart.longitude,
      cart.latitude,
      cart.height + bs.radius * 2.5,
    ),
    orientation: { heading: 0, pitch: -1.5708, roll: 0 },
  });
  for (let i = 0; i < 30; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  // Hide globe + sky so ONLY the building (if it renders) shows.
  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  scene.backgroundColor = C.Color.BLACK;
  for (let i = 0; i < 30; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  // sample center region for any non-black pixels
  const canvas = scene.canvas;
  const c2 = document.createElement("canvas");
  c2.width = canvas.width;
  c2.height = canvas.height;
  const ctx = c2.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  const w = canvas.width,
    h = canvas.height,
    cx = Math.floor(w / 2),
    cy = Math.floor(h / 2);
  let nonBlack = 0,
    maxLum = 0;
  const region = 200;
  const img = ctx.getImageData(
    cx - region,
    cy - region,
    region * 2,
    region * 2,
  ).data;
  for (let i = 0; i < img.length; i += 4) {
    const lum = img[i] + img[i + 1] + img[i + 2];
    if (lum > 15) nonBlack++;
    if (lum > maxLum) maxLum = lum;
  }
  return {
    nonBlackPixels: nonBlack,
    maxLum,
    sampledPixels: region * 2 * (region * 2),
    centerPix: [
      img[(region * 2 * region + region) * 4],
      img[(region * 2 * region + region) * 4 + 1],
      img[(region * 2 * region + region) * 4 + 2],
    ],
  };
});
console.log(JSON.stringify(res, null, 2));
const buf = await page.screenshot();
const fs = await import("fs");
fs.writeFileSync("Tools/visual-regression/output/probe-b3dm-noglobe.png", buf);
console.log("PNG bytes:", buf.length);
await browser.close();
