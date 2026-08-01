// C-R9 control: does the BatchTableHierarchy b3dm render on WebGL vs WebGPU at
// the SAME view, with EXPLICIT ellipsoid terrain (so real Cesium World Terrain
// elevation can't legitimately occlude the sample buildings)? Principle 8 — the
// "b3dm invisible on WebGPU" claim must be checked against WebGL at the same
// view, and against ellipsoid terrain, before assuming a WebGPU depth bug.
import { chromium } from "playwright";
import fs from "fs";
const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT = "Tools/visual-regression/output";

async function run(renderer, useEllipsoid) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  page.on("pageerror", (e) =>
    console.log(`>> [${renderer}] pageerror: ${e.message.slice(0, 160)}`),
  );
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(async (useEll) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      scene = v.scene;
    if (useEll) {
      v.terrainProvider = new C.EllipsoidTerrainProvider();
    }
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
    for (let i = 0; i < 250; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (scene.globe.tilesLoaded && i > 40) break;
    }
    // Building = grayish boxes (low chroma, mid tone). Count in center region.
    const cv = scene.canvas;
    const c2 = document.createElement("canvas");
    c2.width = cv.width;
    c2.height = cv.height;
    const cx = c2.getContext("2d");
    cx.drawImage(cv, 0, 0);
    const W = cv.width,
      H = cv.height;
    const d = cx.getImageData(0, 0, W, H).data;
    let gray = 0,
      total = 0;
    for (let y = (H * 0.3) | 0; (y < H * 0.7) | 0; y += 2) {
      for (let x = (W * 0.35) | 0; (x < W * 0.65) | 0; x += 2) {
        const i = (y * W + x) * 4;
        const r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        total++;
        if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r > 110 && r < 205)
          gray++;
      }
    }
    return {
      grayBuildingPx: gray,
      total,
      camHeight: v.camera.positionCartographic.height,
    };
  }, useEllipsoid);

  const buf = await page.screenshot();
  const tag = `${renderer}-${useEllipsoid ? "ellipsoid" : "default"}`;
  fs.writeFileSync(`${OUT}/c-r9-cmp-${tag}.png`, buf);
  await browser.close();
  return { renderer, useEllipsoid, ...info };
}

const results = [];
for (const useEll of [true, false]) {
  for (const r of ["webgl", "webgpu"]) {
    results.push(await run(r, useEll));
  }
}
console.log(JSON.stringify(results, null, 2));
console.log("PNGs: c-r9-cmp-{webgl,webgpu}-{ellipsoid,default}.png");
