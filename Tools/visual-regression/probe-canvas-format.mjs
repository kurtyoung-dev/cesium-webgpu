#!/usr/bin/env node
// Check the WebGPU canvas format and post-process state.

import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);
await page.evaluate(async () => {
  for (let i = 0; i < 60; i++) {
    window.viewer.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
});

const info = await page.evaluate(() => {
  const v = window.viewer;
  const ctx = v.scene._context;
  const renderer = v.scene._alternateSceneRenderer;
  const pp = renderer?._postProcess;
  return {
    preferredCanvasFormat: navigator.gpu?.getPreferredCanvasFormat?.(),
    presentationFormat: ctx?._presentationFormat,
    hdrCanvasOutput: ctx?._hdrCanvasOutput,
    highDynamicRange: v.scene.highDynamicRange,
    postProcess: pp
      ? {
          hasActiveStages: pp.hasActiveStages,
          tonemapEnabled: pp._tonemapStage?.enabled,
          tonemapOperator: pp._tonemapStage?.tonemapOperator,
          fxaaEnabled: pp._fxaaStage?.enabled,
          taaEnabled: pp._taaEffect?.enabled,
          autoExposure: !!pp._autoExposureStage,
          autoExposureEnabled: pp._autoExposureStage?.enabled,
          colorGradingEnabled: pp._colorGradingStage?.enabled,
        }
      : null,
    sceneFramebuffer: !!renderer?._sceneFramebuffer,
    sceneFramebufferFormat: renderer?._sceneFramebuffer?._colorAttachmentFormat,
    sceneFramebufferIsHdr: renderer?._sceneFramebuffer?._isHdr,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
