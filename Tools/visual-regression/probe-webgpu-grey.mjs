// Diagnostic probe: open the split-screen page, click Launch, capture
// console errors + the WebGPU viewer's debug snapshot. Used to track
// down the WebGPU all-grey regression observed after Batches 183-225.

import { chromium } from "playwright";

const BASE_URL =
  "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html";

const browser = await chromium.launch({
  headless: true,
  channel: "msedge",
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 800 },
});
const page = await context.newPage();

const consoleMessages = [];
page.on("console", (msg) => {
  consoleMessages.push({ type: msg.type(), text: msg.text() });
});
page.on("pageerror", (err) => {
  consoleMessages.push({ type: "pageerror", text: err.message });
});

console.log("[probe] navigating");
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForSelector("#btnLaunch", { timeout: 10_000 });
await page.click("#btnLaunch");

console.log("[probe] waiting for viewers");
await page.waitForFunction(() => !!(window.webglViewer && window.webgpuViewer), {
  timeout: 60_000,
});

// Let the scene render for ~3s
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

const snap = await page.evaluate(() => {
  const wgpu = window.webgpuViewer;
  if (!wgpu) return { error: "no webgpu viewer" };
  let debugSnap = null;
  try {
    debugSnap = wgpu.scene.getDebugSnapshot
      ? wgpu.scene.getDebugSnapshot()
      : null;
  } catch (e) {
    debugSnap = { error: String(e) };
  }
  // Read pixel sample via toDataURL → Image
  const canvas = wgpu.scene.canvas;
  const dataUrlLen = canvas.toDataURL("image/png").length;

  const result = {
    sceneFrameNumber: wgpu.scene._frameState?.frameNumber ?? null,
    backend: wgpu.scene._context?.rendererType ?? null,
    canvasSize: [canvas.width, canvas.height],
    canvasContextType: canvas.getContext ? "ok" : "missing",
    primitivesCount: wgpu.scene.primitives?.length ?? 0,
    hdrCanvasOutput: wgpu.scene._context?.hdrCanvasOutput ?? null,
    presentationFormat: wgpu.scene._context?._presentationFormat ?? null,
    dataUrlLen,
    debugSnap,
  };
  return result;
});

console.log("\n[probe] WebGPU snapshot:");
console.log(JSON.stringify(snap, null, 2));

// Print errors / warnings only
console.log("\n[probe] Console messages (errors + warnings only):");
for (const msg of consoleMessages) {
  if (msg.type === "error" || msg.type === "warning" || msg.type === "pageerror") {
    console.log(`  [${msg.type}] ${msg.text}`);
  }
}

console.log(
  `\n[probe] Total console messages: ${consoleMessages.length} (errors+warnings printed above)`,
);

await browser.close();
