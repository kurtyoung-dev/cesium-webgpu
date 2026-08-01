// Quick: open the standalone CesiumViewer with renderer=webgpu and
// capture pixel sample. Bypasses the split-screen page.

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await context.newPage();

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning")
    errors.push(`[${msg.type()}] ${msg.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

console.log(
  "[probe] navigating to standalone CesiumViewer with renderer=webgpu",
);
await page.goto(URL, { waitUntil: "networkidle" });

// Wait for window.viewer
await page.waitForFunction(() => !!window.viewer, { timeout: 30_000 });

// Render for 3 seconds
await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      function tick() {
        if (n++ > 180) r();
        else requestAnimationFrame(tick);
      }
      tick();
    }),
);

const result = await page.evaluate(() => {
  const v = window.viewer;
  if (!v) return { error: "no viewer" };
  const canvas = v.scene.canvas;
  // Inspect the post-process pipeline state.
  const sceneAny = v.scene;
  const renderer = sceneAny._alternateSceneRenderer;
  const pp = renderer?._postProcess;
  // Sample the SCENE FRAMEBUFFER color texture directly via
  // `copyTextureToBuffer` → readback. If THIS is non-zero but the
  // canvas is black, the bug is in the blit. If THIS is also
  // black, the bug is in the scene rendering itself.
  // Easier: just check that `colorTarget` exists.
  const sceneFB = renderer?._sceneFramebuffer;
  const sceneFBState = sceneFB
    ? {
        hasColorTarget: !!sceneFB.colorTarget,
        width: sceneFB._width,
        height: sceneFB._height,
        colorTexCount: sceneFB.colorTarget?.getColorTextureViewCount?.() ?? 0,
      }
    : null;
  const ppState = pp
    ? {
        hasActiveStages: pp.hasActiveStages,
        tonemap: pp._tonemapStage?.enabled,
        colorGrading: pp._colorGradingStage?.enabled,
        fxaa: pp._fxaaStage?.enabled,
        hdrOutputMode: pp._hdrOutputMode,
        width: pp._width,
        height: pp._height,
        intermediateFormat: pp._intermediateFormat,
        canvasFormat: pp._canvasFormat,
        hdr: pp._hdr,
        hasIdentityPipeline: !!pp._identityPipeline,
        pingTexture: !!pp._pingTexture,
        pongTexture: !!pp._pongTexture,
      }
    : null;
  const dataUrl = canvas.toDataURL("image/png");
  // Decode + sample center pixel
  return new Promise((resolve) => {
    const img = new Image();
    img.src = dataUrl;
    img.onload = () => {
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const samples = [];
      for (let i = 0; i < 25; i++) {
        const x = Math.floor((i * 47) % canvas.width);
        const y = Math.floor((i * 71) % canvas.height);
        const px = ctx.getImageData(x, y, 1, 1).data;
        samples.push([px[0], px[1], px[2]]);
      }
      resolve({
        canvasSize: [canvas.width, canvas.height],
        rendererType: v.scene.context.rendererType,
        frameNumber: v.scene._frameState?.frameNumber,
        dataUrlLen: dataUrl.length,
        nonBlackSamples: samples.filter((s) => s[0] + s[1] + s[2] > 30).length,
        firstFewSamples: samples.slice(0, 5),
        ppState,
        sceneFBState,
      });
    };
  });
});

console.log("\n[probe] standalone-webgpu result:");
console.log(JSON.stringify(result, null, 2));

if (errors.length > 0) {
  console.log("\n[probe] errors / warnings:");
  for (const e of errors.slice(0, 30)) console.log("  " + e);
}

await browser.close();
