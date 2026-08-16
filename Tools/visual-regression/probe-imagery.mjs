#!/usr/bin/env node
// @purpose Diagnostic dump of imagery-layer/tile state (layers, skeletons, provider readiness) on the WebGPU viewer after a settle loop
// @status ACTIVE

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const scene = v.scene;
    const cam = scene.camera;
    const globe = scene.globe;
    const surface = globe._surface;
    const tp = surface._tileProvider;
    const layers = scene.imageryLayers;
    const layerInfo = [];
    for (let i = 0; i < layers.length; i++) {
      const L = layers.get(i);
      layerInfo.push({
        name: L.imageryProvider?.constructor?.name,
        ready: L.ready,
        show: L.show,
        rectangle: L.rectangle?.toString?.(),
      });
    }
    return {
      cameraPos: {
        x: cam.positionWC.x,
        y: cam.positionWC.y,
        z: cam.positionWC.z,
      },
      cameraHeight: cam.positionCartographic.height,
      cameraLat: C.Math.toDegrees(cam.positionCartographic.latitude),
      cameraLon: C.Math.toDegrees(cam.positionCartographic.longitude),
      mode: scene.mode,
      morphTime: scene.morphTime,
      globeShow: globe.show,
      tilesLoaded: tp._readyTiles ?? "?",
      layerCount: layers.length,
      layers: layerInfo,
      tilesActive: surface._activeTiles?.length ?? "?",
      tilesToRender: surface._tilesToRender?.length ?? 0,
    };
  });
  await browser.close();

  console.log(JSON.stringify(result, null, 2));
  console.log("\nFirst 30 console messages:");
  for (const m of messages.slice(0, 30)) {
    if (
      m.text.includes("WebGPU") ||
      m.text.includes("imagery") ||
      m.text.includes("Layer") ||
      m.text.includes("texture")
    )
      console.log(`  [${m.t}] ${m.text.slice(0, 250)}`);
  }
})();
