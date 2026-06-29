#!/usr/bin/env node
// Single-session MS toggle probe (Batch 440 diagnostic). Loads ONE page, settles
// the fog, captures MS-OFF, then flips multiScatter ON in the SAME session,
// re-renders, captures MS-ON. Eliminates cross-session tile-streaming
// nondeterminism so any fog difference is purely the MS feature.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const octaves = parseInt(process.argv[2] || "3", 10);

async function run() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const ac = scene.globe.atmosphericConditions;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T16:40:00Z");
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(7.6, 45.9, 2400),
      orientation: { heading: C.Math.toRadians(20), pitch: C.Math.toRadians(-14), roll: 0 },
    });
    ac.volumetricFog.enabled = true;
    ac.volumetricFog.quality = "medium";
    ac.volumetricFog.density = 0.5;
    ac.volumetricFog.falloff = 0.0022;
    ac.volumetricFog.maxDistance = 26000;
    ac.volumetricFog.ambientStrength = 0.06;
    ac.volumetricFog.fogAnisotropy = 0.5;
    ac.volumetricFog.enableScatteringOcclusion = true;
    ac.volumetricFog.multiScatter = false;
    ac.volumetricFog.msOctaves = 1;
    window.__ac = ac;
    for (let i = 0; i < 420; i++) { scene.render(); await new Promise((r) => requestAnimationFrame(r)); }
  });

  async function grab(label) {
    const el = await page.$("canvas.cesium-widget-scene-canvas, .cesium-widget canvas, canvas");
    const buf = await el.screenshot();
    fs.writeFileSync(path.join(OUT_DIR, `fog-ms-toggle-${label}-canvas.png`), buf);
    return buf;
  }

  await grab("off");

  // Flip MS ON in the SAME session, re-render the same number of settle frames.
  const echo = await page.evaluate(async (oct) => {
    const v = window.viewer;
    const ac = window.__ac;
    ac.volumetricFog.multiScatter = true;
    ac.volumetricFog.msOctaves = oct;
    for (let i = 0; i < 120; i++) { v.scene.render(); await new Promise((r) => requestAnimationFrame(r)); }
    return { multiScatter: ac.volumetricFog.multiScatter, msOctaves: ac.volumetricFog.msOctaves };
  }, octaves);

  await grab("on");
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  console.log(`[probe-fog-ms-toggle] octaves=${octaves} echo=${JSON.stringify(echo)} errors=${errs.length}`);
  errs.slice(0, 6).forEach((e) => console.log(`  ${e.t}: ${e.text}`));
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  await run();
})();
