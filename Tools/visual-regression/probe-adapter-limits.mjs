#!/usr/bin/env node
/**
 * Probe what bind-group / texture / binding limits the local WebGPU
 * adapter actually exposes. Runs across multiple Chromium launch
 * configurations to see which path produces the highest limits.
 */
import { chromium } from "playwright";
const BASE = "http://localhost:8080";

const configs = [
  { label: "default (DXGI on Windows)", args: ["--enable-unsafe-webgpu"] },
  {
    label: "explicit Vulkan",
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  },
  {
    label: "high-performance preference",
    args: ["--enable-unsafe-webgpu"],
    powerPreference: "high-performance",
  },
];

for (const cfg of configs) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: cfg.args,
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const limits = await page.evaluate(async (powerPreference) => {
    if (!navigator.gpu) return { error: "no navigator.gpu" };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (!adapter) return { error: "no adapter" };
    const result = {
      adapterInfo: {
        vendor: adapter.info?.vendor,
        architecture: adapter.info?.architecture,
        device: adapter.info?.device,
        description: adapter.info?.description,
      },
      keyLimits: {
        maxBindGroups: adapter.limits.maxBindGroups,
        maxBindGroupsPlusVertexBuffers:
          adapter.limits.maxBindGroupsPlusVertexBuffers,
        maxBindingsPerBindGroup: adapter.limits.maxBindingsPerBindGroup,
        maxSampledTexturesPerShaderStage:
          adapter.limits.maxSampledTexturesPerShaderStage,
        maxSamplersPerShaderStage: adapter.limits.maxSamplersPerShaderStage,
        maxStorageBuffersPerShaderStage:
          adapter.limits.maxStorageBuffersPerShaderStage,
        maxUniformBuffersPerShaderStage:
          adapter.limits.maxUniformBuffersPerShaderStage,
        maxVertexBuffers: adapter.limits.maxVertexBuffers,
      },
    };
    return result;
  }, cfg.powerPreference);

  console.log(`\n=== ${cfg.label} ===`);
  console.log(JSON.stringify(limits, null, 2));
  await browser.close();
}
