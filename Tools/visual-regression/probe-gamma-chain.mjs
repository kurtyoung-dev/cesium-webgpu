#!/usr/bin/env node
// Probe the actual gamma chain on both backends. Reports:
// @purpose Read-only dump of the gamma/output chain on both backends: canvas attrs, WebGPU presentation format, active PP stages, HDR/tonemapper state
// @status INVESTIGATION
//
//  - WebGL canvas attributes (alpha, premultipliedAlpha, etc.)
//  - WebGPU presentation format + colorSpace
//  - Active post-process stages on each backend
//  - scene.highDynamicRange / Tonemapper state
//
// This is read-only — no fix attempts. Just data.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

async function introspect(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const info = await page.evaluate(async () => {
    const v = window.viewer;
    const canvas = v.canvas;
    const scene = v.scene;

    // Active backend
    const ctxType =
      canvas.getContext?.constructor?.name ??
      scene.context?.rendererType ??
      "?";

    // WebGL attributes (if WebGL backend)
    let glAttrs = null;
    try {
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (gl && typeof gl.getContextAttributes === "function") {
        glAttrs = gl.getContextAttributes();
      }
    } catch {}

    // WebGPU canvas configure
    let wgpuConfig = null;
    try {
      const gpuCtx = canvas.getContext("webgpu");
      if (gpuCtx) {
        // GPUCanvasContext doesn't expose the configuration back directly,
        // but the context object has internal fields we can grab.
        wgpuConfig = {
          preferred: navigator.gpu?.getPreferredCanvasFormat?.(),
          // We can't introspect the configuration after the fact, so just
          // grab the presentation format from the engine
          presentationFormat: scene.context?._presentationFormat,
          hdrCanvasOutput: scene.context?._hdrCanvasOutput,
        };
      }
    } catch {}

    // Post-process stage info
    const ppStages = [];
    try {
      const coll = scene.postProcessStages;
      const propsToShow = ["name", "enabled", "ready"];
      if (coll && coll.length !== undefined) {
        for (let i = 0; i < coll.length; i++) {
          const stage = coll.get(i);
          const o = {};
          for (const p of propsToShow) o[p] = stage[p];
          ppStages.push(o);
        }
      }
      // Specific named stages
      if (coll?.tonemap) {
        ppStages.push({
          name: "tonemap (built-in)",
          enabled: coll.tonemap.enabled,
        });
      }
      if (coll?.fxaa) {
        ppStages.push({
          name: "fxaa (built-in)",
          enabled: coll.fxaa.enabled,
        });
      }
      if (coll?.ambientOcclusion) {
        ppStages.push({
          name: "ao (built-in)",
          enabled: coll.ambientOcclusion.enabled,
        });
      }
      if (coll?.bloom) {
        ppStages.push({
          name: "bloom (built-in)",
          enabled: coll.bloom.enabled,
        });
      }
    } catch (e) {
      ppStages.push({ error: e.message });
    }

    return {
      ctxType,
      glAttrs,
      wgpuConfig,
      ppStages,
      hdr: scene.highDynamicRange,
      tonemapper: scene.tonemapper,
      gamma: scene.gamma,
      cesiumGamma: window.Cesium?.UniformState ? "via UniformState" : "?",
    };
  });

  await browser.close();
  return info;
}

(async () => {
  console.log("=".repeat(60));
  console.log("[gamma-chain] WebGL introspection");
  console.log("=".repeat(60));
  const webgl = await introspect("webgl");
  console.log(JSON.stringify(webgl, null, 2));

  console.log();
  console.log("=".repeat(60));
  console.log("[gamma-chain] WebGPU introspection");
  console.log("=".repeat(60));
  const webgpu = await introspect("webgpu");
  console.log(JSON.stringify(webgpu, null, 2));
})();
