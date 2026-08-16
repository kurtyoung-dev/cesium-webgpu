// Use Cesium's getDebugSnapshot for a comprehensive scene state.
// @purpose Headless scene-state dump: tiles-to-render, pipeline-cache stats, and globe feature-renderer status from a settled viewer.
// @status ACTIVE
//
import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });
await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      (function tick() {
        if (n++ > 240) r();
        else requestAnimationFrame(tick);
      })();
    }),
);
const result = await page.evaluate(() => {
  const v = window.viewer;
  const scene = v.scene;
  const globe = scene.globe;
  const surface = globe?._surface;
  const tilesToRender = surface?._tilesToRender ?? [];
  const tileProvider = surface?._tileProvider;
  // Check the central pipeline cache
  const ctx = scene._context;
  const pcache = ctx?.webgpuPipelineCache;
  const pcacheStats = pcache?.stats ?? null;
  // Check feature renderer
  const fr = ctx?.getFeatureRenderer
    ? ctx.getFeatureRenderer(12 /* GLOBE_SURFACE */)
    : null;
  const frInitialized = fr?.RendererClass ? "has-class" : "no-class";
  return {
    tilesToRenderCount: tilesToRender.length,
    sampleTile: tilesToRender[0]
      ? {
          level: tilesToRender[0].level,
          x: tilesToRender[0].x,
          y: tilesToRender[0].y,
          hasMesh: !!tilesToRender[0].data?.mesh,
          hasRenderedMesh: !!tilesToRender[0].data?.renderedMesh,
          hasFill: !!tilesToRender[0].data?.fill,
        }
      : null,
    tileProviderShow: tileProvider?.show,
    globeShow: globe?.show,
    pcacheStats,
    frInitialized,
    frHasShaderCode: typeof fr?.getShaderCode === "function",
    frShaderCodeLen: fr?.getShaderCode
      ? (fr.getShaderCode()?.length ?? "?")
      : "n/a",
  };
});
console.log("[probe-debug-snapshot] result:");
console.log(JSON.stringify(result, null, 2));
await browser.close();
