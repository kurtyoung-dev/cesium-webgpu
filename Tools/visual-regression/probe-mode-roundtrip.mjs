#!/usr/bin/env node
// Probe: verify SCENE3D still renders correctly AFTER round-tripping
// through SCENE2D and COLUMBUS_VIEW. Reproduces the user-reported bug:
// @purpose Regression: SCENE3D renders correctly after round-trips through 2D/Columbus (user-reported split-globe artifact on return to 3D).
// @status ACTIVE
//
// "When leaving the 2d or columbus views and returning to 3d the globe
// looks like this" (half-broken split-globe artifact).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const TRIPS = [
  { name: "fresh-3d", path: [3] },
  { name: "3d-cv-3d", path: [3, 1, 3] },
  { name: "3d-2d-3d", path: [3, 2, 3] },
  { name: "3d-cv-2d-3d", path: [3, 1, 2, 3] },
];

async function captureTrip(rendererArg, label, modePath) {
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
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async (modePath) => {
    const v = window.viewer;
    for (const mode of modePath) {
      if (mode === 1) v.scene.morphToColumbusView(0);
      else if (mode === 2) v.scene.morphTo2D(0);
      else v.scene.morphTo3D(0);
      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
  }, modePath);

  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `probe-roundtrip-${label}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log(`  saved ${out}`);
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${errs.length} errors`);
    errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const trip of TRIPS) {
    console.log(`[probe-mode-roundtrip] ${trip.name} via WebGPU…`);
    await captureTrip("webgpu", `${trip.name}-webgpu`, trip.path);
  }
  console.log("[probe-mode-roundtrip] done");
})();
