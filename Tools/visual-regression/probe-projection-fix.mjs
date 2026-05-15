#!/usr/bin/env node
// Batch 46 probe: verify imagery renders correctly at orbit altitude
// after the useWebMercatorT / textureTranslationAndScale reprojection fix.
//
// Captures WebGPU + WebGL screenshots at the same camera position at
// ~12 Mm altitude over North America — the view where the user
// originally reported "stretched away from poles, squished at equator".

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEWS = [
  // Centered over the continental US, looking straight down from ~12 Mm.
  { name: "northam", lon: -100, lat: 40, height: 12_000_000 },
  // Polar view — where Mercator distortion is most severe.
  { name: "arctic", lon: 0, lat: 80, height: 8_000_000 },
  // Equator — where geographic and Mercator V coords disagree least but
  // any vertical offset is most visible.
  { name: "equator", lon: 0, lat: 0, height: 8_000_000 },
];

async function captureFrame(rendererArg, label, cam) {
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
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async (cam) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
    });
    // Let imagery load + render
    for (let i = 0; i < 360; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, cam);

  // Wait extra for imagery/reprojection
  await page.waitForTimeout(2000);

  const out = path.join(OUT_DIR, `probe-projection-${label}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log(`  saved ${out}`);
  return { messages };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const v of VIEWS) {
    console.log(`[probe-projection-fix] view=${v.name} capturing WebGPU…`);
    await captureFrame("webgpu", `${v.name}-webgpu`, v);
    console.log(`[probe-projection-fix] view=${v.name} capturing WebGL…`);
    await captureFrame("webgl", `${v.name}-webgl`, v);
  }
  console.log("[probe-projection-fix] done");
})();
