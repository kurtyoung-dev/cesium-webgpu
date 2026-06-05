// Diagnostic: does terrain-flush b3dm render with the globe SHOWN after the
// logDepthWriteActive multi-frustum fix? Dumps the render frustum partition and
// captures a globe-ON screenshot at the same 188 m nadir camera where
// probe-b3dm-noglobe.mjs shows the buildings render with the globe hidden.
import { chromium } from "playwright";
import fs from "fs";
const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 200)));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(async () => {
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
  for (let i = 0; i < 200; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (scene.globe.tilesLoaded && i > 40) break;
  }
  // HYPOTHESIS TEST: if the globe depth is what occludes the building, then
  // turning OFF depthTestAgainstTerrain (→ globe depth cleared before 3D Tiles)
  // should make the building appear with the globe still shown.
  scene.globe.depthTestAgainstTerrain = false;
  for (let i = 0; i < 40; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const fcl = scene._view?.frustumCommandsList ?? [];
  return {
    useLogDepth: scene.frameState.useLogDepth,
    numFrustums: fcl.length,
    frustums: fcl.map((f) => ({ near: f.near, far: f.far })),
    tilesetRadius: bs.radius,
    depthTestAgainstTerrainNowOff: scene.globe.depthTestAgainstTerrain,
  };
});
console.log(JSON.stringify(out, null, 2));
const buf = await page.screenshot();
fs.writeFileSync("Tools/visual-regression/output/diag-b3dm-globeon.png", buf);
console.log("globe-on PNG bytes:", buf.length);
await browser.close();
