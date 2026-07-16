// Node/Playwright integration probe for the opt-in WebGPU timestamp profiler.
// Requires the local Cesium server on http://localhost:8080.
import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") {
    // The default Viewer can report blocked external imagery/terrain requests
    // in an offline benchmark environment. Preserve that diagnostic without
    // turning unrelated network availability into a timestamp-profiler
    // failure. Uncaught page errors remain certifying failures below.
    consoleErrors.push(message.text());
  }
});

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => globalThis.viewer?.scene, {
    timeout: 30000,
  });

  const result = await page.evaluate(async () => {
    const scene = globalThis.viewer.scene;
    const context = scene._context;
    const originalRequestRenderMode = scene.requestRenderMode;
    const featureAvailable = context.hasFeature?.("timestamp-query") === true;

    if (featureAvailable) {
      globalThis.CesiumDebug.gpuPassCost(true);
      scene.requestRenderMode = false;

      let frameCount = 0;
      const removeListener = scene.postRender.addEventListener(() => {
        frameCount++;
      });
      const deadline = performance.now() + 10000;
      while (frameCount < 30 && performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      removeListener();

      // mapAsync is non-blocking and may settle just after postRender.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const profiler = context.timestampProfiler;
    const results = profiler?.getResults?.() ?? null;
    if (featureAvailable) {
      globalThis.CesiumDebug.gpuPassCost(false);
    }
    scene.requestRenderMode = originalRequestRenderMode;

    return {
      backend: context.isWebGPU ? "webgpu" : "webgl",
      featureAvailable,
      results,
      passNames: results ? Object.keys(results.passes) : [],
    };
  });

  console.log(
    JSON.stringify({ ...result, pageErrors, consoleErrors }, null, 2),
  );

  const failures = [];
  if (result.backend !== "webgpu") {
    failures.push(`expected WebGPU, got ${result.backend}`);
  }
  if (pageErrors.length > 0) {
    failures.push(`${pageErrors.length} uncaught page error(s)`);
  }
  if (result.featureAvailable) {
    if (!result.results?.enabled) failures.push("profiler was not enabled");
    if ((result.results?.frameCount ?? 0) < 1) {
      failures.push("no timestamp frame resolved");
    }
    if (result.passNames.length < 1) failures.push("no pass samples resolved");
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
