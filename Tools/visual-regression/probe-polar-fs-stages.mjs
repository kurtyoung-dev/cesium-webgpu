#!/usr/bin/env node
// Batch 62 — at south-pole-close, walk every meaningful FS debug stage and
// capture the screenshot. Goal: identify the exact stage where imagery
// composite drops to black.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT = "Tools/visual-regression/output";

const STAGES = [
  "uv",
  "alpha",
  "layer-count",
  "sample0",
  "tex0-alpha",
  "post-composite-color",
  "post-composite-alpha",
];

async function capture(stage) {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.waitForFunction(() => !!window.CesiumDebug, { timeout: 5000 });

  await page.evaluate(async ({ stage }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"),
    );
    if (wgs84) vm.selectedTerrain = wgs84;
    window.CesiumDebug.globeFragmentDebug(stage);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, -89, 3_000_000),
    });
    for (let i = 0; i < 1200; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 200) break;
    }
  }, { stage });
  await page.waitForTimeout(1500);
  const out = path.join(OUT, `polar-stage-${stage}-webgpu.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  console.log("[polar-fs-stages] @ south-pole-close (0,-89,3Mm) WGS84");
  for (const stage of STAGES) {
    const f = await capture(stage);
    console.log(`  ${stage} → ${f}`);
  }
})();
