import { chromium } from "playwright";
const BASE = "http://localhost:8080";
(async () => {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "networkidle", timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const tileset = await C.Cesium3DTileset.fromUrl(
      "/Apps/SampleData/Cesium3DTiles/Batched/BatchedWithBatchTable/tileset.json",
    );
    v.scene.primitives.add(tileset);
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const bs = tileset.boundingSphere;
    const cart = C.Cartographic.fromCartesian(bs.center);
    v.camera.setView({
      destination: C.Cartesian3.fromRadians(
        cart.longitude, cart.latitude, cart.height + bs.radius * 2.5,
      ),
      orientation: { heading: 0, pitch: -1.5708, roll: 0 },
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const w = v.canvas.width, h = v.canvas.height;
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    const picked = v.scene.pick(new C.Cartesian2(cx, cy));
    let foundOffset = null;
    let res = picked;
    if (!picked) {
      for (let r = 50; r < 350 && !res; r += 50) {
        for (let a = 0; a < 6; a++) {
          const dx = Math.round(Math.cos(a) * r), dy = Math.round(Math.sin(a) * r);
          const p = v.scene.pick(new C.Cartesian2(cx + dx, cy + dy));
          if (p) { res = p; foundOffset = [dx, dy]; break; }
        }
      }
    }
    return {
      featuresLoaded: tileset.statistics.numberOfFeaturesLoaded,
      pickedDefined: !!res,
      pickedKeys: res ? Object.keys(res) : null,
      hasPrimitive: !!res?.primitive,
      hasFeature: typeof res?.getProperty === "function",
      foundOffset,
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
