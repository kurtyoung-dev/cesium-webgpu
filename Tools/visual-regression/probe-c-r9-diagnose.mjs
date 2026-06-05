// C-R9 diagnosis with the new depth tooling. Loads the BatchTableHierarchy
// b3dm tileset on terrain (globe shown) and captures three frames:
//   1. baseline  — normal render (building expected occluded by the globe)
//   2. skipplane — scene.debugSkipDepthPlane=true (the bisect: if the building
//                  reappears, the ellipsoid depth plane is the occluder)
//   3. depthwin  — windowed Turbo depth overlay around the building distance
//                  (to see the depth structure that the plain overlay collapses)
// Reads a gray-building-pixel count in the center region for each; the PNGs are
// for visual confirmation (Principle 8).
import { chromium } from "playwright";
import fs from "fs";
const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT = "Tools/visual-regression/output";

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

// Setup: load tileset, frame at ~188 m nadir, settle.
const info = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    scene = v.scene;
  // The depth-as-color overlay needs a single-sample scene framebuffer
  // (depthSampleableView is null under MSAA). The default viewer enables MSAA.
  scene.msaaSamples = 1;
  const ts = await C.Cesium3DTileset.fromUrl(
    "/Apps/SampleData/Cesium3DTiles/Hierarchy/BatchTableHierarchy/tileset.json",
  );
  scene.primitives.add(ts);
  window.__ts = ts;
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
  const env = scene._environmentState ?? {};
  return {
    camHeight: v.camera.positionCartographic.height,
    radius: bs.radius,
    depthTestAgainstTerrain: scene.globe.depthTestAgainstTerrain,
    clearGlobeDepth: env.clearGlobeDepth,
    useDepthPlane: env.useDepthPlane,
    msaaSamples: scene.msaaSamples,
  };
});

// Count grayish (building) pixels in the center region of a PNG buffer.
async function grayCount(tag) {
  const png = await page.screenshot();
  fs.writeFileSync(`${OUT}/c-r9-${tag}.png`, png);
  return await page.evaluate(async (durl) => {
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        const W = img.width,
          H = img.height;
        const x0 = (W * 0.35) | 0,
          x1 = (W * 0.65) | 0,
          y0 = (H * 0.3) | 0,
          y1 = (H * 0.7) | 0;
        const d = cx.getImageData(0, 0, W, H).data;
        let gray = 0,
          total = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const i = (y * W + x) * 4;
            const r = d[i],
              g = d[i + 1],
              b = d[i + 2];
            total++;
            // Building = grayish (low chroma) mid-tone; terrain = brown/green.
            if (
              Math.abs(r - g) < 18 &&
              Math.abs(g - b) < 18 &&
              r > 70 &&
              r < 210
            )
              gray++;
          }
        }
        resolve({ gray, total });
      };
      img.src = durl;
    });
  }, `data:image/png;base64,${png.toString("base64")}`);
}

const baseline = await grayCount("baseline");

// Bisect: skip the ellipsoid depth plane.
const skipEnv = await page.evaluate(async () => {
  const v = window.viewer;
  v.scene.debugSkipDepthPlane = true;
  for (let i = 0; i < 30; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const env = v.scene._environmentState ?? {};
  return { useDepthPlaneAfterSkip: env.useDepthPlane, clearGlobeDepth: env.clearGlobeDepth };
});
const skipplane = await grayCount("skipplane");

// Windowed Turbo depth overlay around the building distance (~188 m).
await page.evaluate(async () => {
  const v = window.viewer;
  v.scene.debugSkipDepthPlane = false;
  v.scene.debugShowDepthAsColor = true;
  v.scene.debugDepthWindowMin = 150;
  v.scene.debugDepthWindowMax = 230;
  v.scene.debugDepthWindowTurbo = true;
  for (let i = 0; i < 30; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
});
const depthwin = await grayCount("depthwin");

console.log(
  JSON.stringify(
    {
      setup: info,
      skipEnv,
      baseline_gray: baseline,
      skipplane_gray: skipplane,
      verdict:
        skipplane.gray > baseline.gray * 3
          ? "DEPTH PLANE IS THE OCCLUDER (building reappears when skipped)"
          : "depth plane NOT the (sole) occluder — investigate clear/depth-value",
      note: "PNGs: c-r9-{baseline,skipplane,depthwin}.png",
    },
    null,
    2,
  ),
);
await browser.close();
