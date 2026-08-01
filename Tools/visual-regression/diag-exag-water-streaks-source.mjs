#!/usr/bin/env node
// DIAGNOSTIC (NEW-WEBGPU-EXAG-WATER-STREAKS): the bright-blue streaks over the
// exaggerated Himalayas are NOT from computeEnhancedOcean (zeroing its
// contribution left them). This isolates whether fog / ground-atmosphere /
// sky-atmosphere is the source by capturing WebGPU with them ON vs OFF — no
// rebuild, just scene toggles.
//
// Usage: node Tools/visual-regression/diag-exag-water-streaks-source.mjs

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function capture(label, killAtmosphere) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  const url = await page.evaluate(async (killAtmo) => {
    const v = window.viewer,
      s = v.scene,
      c = v.camera;
    s.verticalExaggeration = 10;
    if (killAtmo) {
      s.fog.enabled = false;
      if (s.skyAtmosphere) s.skyAtmosphere.show = false;
      s.globe.showGroundAtmosphere = false;
    }
    const ell = s.ellipsoid ?? s.globe.ellipsoid;
    const dest = ell.cartographicToCartesian({
      longitude: (86.9 * Math.PI) / 180,
      latitude: (27.0 * Math.PI) / 180,
      height: 250000,
    });
    c.setView({
      destination: dest,
      orientation: { heading: 0, pitch: -0.45, roll: 0 },
    });
    for (let i = 0; i < 300; i++) {
      s.initializeFrame();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    c.setView({
      destination: dest,
      orientation: { heading: 0, pitch: -0.45, roll: 0 },
    });
    for (let i = 0; i < 60; i++) {
      s.initializeFrame();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return s.canvas.toDataURL("image/png");
  }, killAtmosphere);
  writeFileSync(
    join(OUT, `exag-streaks-${label}.png`),
    Buffer.from(url.split(",")[1], "base64"),
  );
  await page.close();
  console.log(`saved exag-streaks-${label}.png`);
}

await capture("atmo-on", false);
await capture("atmo-off", true);
await browser.close();
