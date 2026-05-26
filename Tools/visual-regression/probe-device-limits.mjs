#!/usr/bin/env node
// Probe-device-limits — diagnostic for Batch 152.
//
// Spawn a fresh browser, query the adapter's reported limits +
// the actual device's negotiated limits. Tells us what the
// platform's hard ceiling on `maxBindGroups` actually is.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
  // Try WITHOUT forcing Vulkan — use Chromium's default WebGPU backend
  // (D3D12 on Windows, which typically supports maxBindGroups = 8).
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 400, height: 300 },
  });
  page.on("console", (m) => console.log(`>> ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => console.log(`>> pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  // Wait up to 5s for viewer (might fail to construct).
  try {
    await page.waitForFunction(() => !!window.viewer, { timeout: 5000 });
  } catch {
    console.log("viewer never appeared");
  }

  const result = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    const adapterLimits = {};
    for (const key of ["maxBindGroups", "maxBindGroupsPlusVertexBuffers", "maxSampledTexturesPerShaderStage"]) {
      adapterLimits[key] = adapter?.limits?.[key];
    }
    // Try creating a device requesting maxBindGroups=5.
    let directDevTest = null;
    try {
      const dev = await adapter.requestDevice({
        requiredLimits: { maxBindGroups: 5 },
      });
      directDevTest = { ok: true, maxBindGroups: dev.limits.maxBindGroups };
    } catch (e) {
      directDevTest = { ok: false, err: String(e?.message ?? e) };
    }
    return {
      adapterFound: !!adapter,
      adapterLimits,
      directDevTest,
      viewerExists: !!window.viewer,
      viewerDeviceLimits:
        window.viewer?.scene?.context?._device?.limits?.maxBindGroups ?? null,
    };
  });

  console.log("\nresult:", JSON.stringify(result, null, 2));
  await browser.close();
})();
