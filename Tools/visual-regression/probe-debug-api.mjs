#!/usr/bin/env node
// Verify the new CesiumDebug.globeFragmentDebug() API end-to-end.
// @purpose End-to-end smoke of CesiumDebug.globeFragmentDebug: registry populated, each mode enables, screenshots captured.
// @status ACTIVE
//
// Loads CesiumViewer, calls the API to enable each mode, captures screenshot.

import { chromium } from "playwright";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

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
  const consoleMessages = [];
  page.on("console", (m) => consoleMessages.push(`${m.type()}: ${m.text()}`));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Wait for CesiumDebug to load
  await page.waitForFunction(() => !!window.CesiumDebug, { timeout: 5000 });

  // Render a frame so the registry gets published
  await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  // Verify the registry is populated
  const modeCount = await page.evaluate(() => {
    return globalThis.__webgpuGlobeFragmentDebugRegistry?.length || 0;
  });
  console.log(`[probe-debug-api] Registry mode count: ${modeCount}`);

  // Test list mode (no args)
  await page.evaluate(() => window.CesiumDebug.globeFragmentDebug());

  // Test setting a known mode
  await page.evaluate(() =>
    window.CesiumDebug.globeFragmentDebug("post-composite-color"),
  );
  await page.evaluate(async () => {
    for (let i = 0; i < 600; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(2500);

  const out = path.join(OUT_DIR, "debug-api-post-composite-color.png");
  await page.screenshot({ path: out });
  console.log(`  Screenshot: ${out}`);

  // Test setting an unknown mode (should warn once)
  await page.evaluate(() =>
    window.CesiumDebug.globeFragmentDebug("bogus-mode-name"),
  );
  await page.evaluate(async () => {
    for (let i = 0; i < 30; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  // Clear mode
  await page.evaluate(() => window.CesiumDebug.globeFragmentDebug(null));
  await page.evaluate(async () => {
    for (let i = 0; i < 300; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(1500);

  const outCleared = path.join(OUT_DIR, "debug-api-cleared.png");
  await page.screenshot({ path: outCleared });
  console.log(`  Cleared screenshot: ${outCleared}`);

  await browser.close();

  console.log("\nConsole messages:");
  const relevantMessages = consoleMessages
    .filter(
      (m) =>
        m.includes("CesiumDebug") ||
        m.includes("globeFragmentDebug") ||
        m.includes("bogus") ||
        m.toLowerCase().includes("unknown"),
    )
    .slice(0, 30);
  for (const m of relevantMessages) console.log(`  ${m}`);
})();
