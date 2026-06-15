#!/usr/bin/env node
// TEMP probe: measure the CPU cost of the inline globe render-bundle
// build/encode/finish in executeGlobeDispatch. We patch the perf manager
// config at runtime to toggle the bundle path on/off and compare median
// frame CPU time (scene.render wall-clock) over a settled window. This
// tells us whether the per-frame bundle is paying its build cost — the
// decision input for NEW-GLOBE-RENDERBUNDLE-CACHE (cache vs drop).
//
// Usage: node Tools/visual-regression/probe-globe-bundle-cost.mjs
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

  // Low-altitude view → many globe tile commands (>> threshold of 8).
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-122.4, 37.6, 600000.0),
    orientation: { heading: 0, pitch: -C.Math.PI_OVER_FOUR, roll: 0 },
  });
  // Settle.
  for (let i = 0; i < 240; i++) {
    await oncePostRender();
    if (scene.globe.tilesLoaded && i > 90) break;
  }

  const perfMgr = scene.context?.performanceManager;
  const tilesToRender = scene.globe._surface?._tilesToRender?.length ?? 0;

  // Measure median scene.render() CPU wall-clock over N frames.
  const measure = async (frames) => {
    const samples = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      scene.render();
      const t1 = performance.now();
      samples.push(t1 - t0);
      await oncePostRender();
    }
    samples.sort((a, b) => a - b);
    return {
      median: samples[Math.floor(samples.length / 2)],
      min: samples[0],
      p90: samples[Math.floor(samples.length * 0.9)],
    };
  };

  // Warmup.
  await measure(20);

  // Bundle ON (default).
  if (perfMgr?.config) perfMgr.config.renderBundleThreshold = 8;
  const withBundle = await measure(80);

  // Bundle OFF (raise threshold above tile count so executeBatch is used).
  if (perfMgr?.config) perfMgr.config.renderBundleThreshold = 1e9;
  const withoutBundle = await measure(80);

  // Restore.
  if (perfMgr?.config) perfMgr.config.renderBundleThreshold = 8;

  return {
    tilesToRender,
    hasPerfMgr: !!perfMgr,
    withBundle,
    withoutBundle,
  };
});
await browser.close();

console.log("tilesToRender:", out.tilesToRender, "hasPerfMgr:", out.hasPerfMgr);
console.log("WITH bundle:   ", JSON.stringify(out.withBundle));
console.log("WITHOUT bundle:", JSON.stringify(out.withoutBundle));
const delta = out.withBundle.median - out.withoutBundle.median;
console.log(
  `median delta (bundle - nobundle) = ${delta.toFixed(3)} ms ` +
    `(${delta > 0 ? "bundle SLOWER" : "bundle faster"})`,
);
console.log("errors:", errors.length);
errors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 200)));
process.exit(0);
