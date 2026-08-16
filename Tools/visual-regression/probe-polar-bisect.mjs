#!/usr/bin/env node
// Bisect the polar-stretching artifact at 14 Mm orbit by stepping
// through globeFragmentDebug modes. Captures one screenshot per mode
// so we can see which intermediate has the streaking pattern.
// @purpose Polar-stretch diagnostic: steps through globeFragmentDebug FS modes at 14 Mm orbit, one screenshot per mode, to locate the streaking stage
// @status INVESTIGATION

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const MODES = [
  null, // production output
  "uv", // vertex UV — verify polar tile UVs are sane
  "alpha", // texCoordsRect mask
  "sample0", // raw layer 0 imagery sample
  "tex0-alpha", // layer 0 alpha channel
  "post-composite-color", // color after composite, before downstream
  "lod-magnitude", // mipmap LOD picked by textureSampleGrad
  "mip4", // explicit LOD=4 sample
  "view-dir", // viewDir per fragment (RTE camera reconstruction)
  "draped", // post-drape color
];

async function capture(mode) {
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  try {
    await page.waitForFunction(() => !!window.CesiumDebug, { timeout: 5000 });
  } catch {}

  await page.evaluate(
    async ({ mode }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-105, 50, 14_000_000),
      });
      if (mode && window.CesiumDebug) {
        window.CesiumDebug.globeFragmentDebug(mode);
      }
      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
    },
    { mode },
  );
  await page.waitForTimeout(2000);
  const out = path.join(OUT_DIR, `polar-bisect-${mode ?? "final"}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[polar-bisect] sweeping globeFragmentDebug modes at 14Mm WGS84");
  for (const mode of MODES) {
    console.log(`  ${mode ?? "final"}`);
    await capture(mode);
  }
})();
