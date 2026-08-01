// Regression probe for WebGPU multi-frustum object picking.
//
// Two overlapping boxes are placed on the camera center ray far enough apart
// to occupy different Cesium frustum slices. The near object must win while it
// is shown; after hiding it, the far object must be returned. TAA stays enabled
// so the probe also catches accidental coupling between the private pick depth
// attachment and normal-frame history/depth resources.
//
// Usage:
//   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-pick-multifrustum.mjs
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const RENDERERS = (process.env.PROBE_RENDERERS || "webgpu,webgl")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

async function runRenderer(browser, renderer) {
  console.log(`[probe-pick-multifrustum] starting ${renderer}`);
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const pageErrors = [];
  const deviceErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(
    async ({ renderer }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const localDeviceErrors = [];
      const device = scene.context?._device;
      if (device) {
        device.addEventListener("uncapturederror", (event) => {
          localDeviceErrors.push(event.error?.message ?? String(event.error));
        });
      }

      viewer.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.primitives.removeAll();
      scene.globe.show = false;
      if (scene.skyBox) {
        scene.skyBox.show = false;
      }
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.show = false;
      }
      if (scene.sun) {
        scene.sun.show = false;
      }
      if (scene.moon) {
        scene.moon.show = false;
      }
      scene.logarithmicDepthBuffer = false;
      scene.farToNearRatio = 1000.0;
      scene.requestRenderMode = false;
      scene.msaaSamples = 1;
      scene.taaEnabled = true;

      const cameraOrigin = new C.Cartesian3(7_000_000.0, 0.0, 0.0);
      viewer.camera.setView({
        destination: cameraOrigin,
        orientation: {
          direction: C.Cartesian3.UNIT_Y,
          up: C.Cartesian3.UNIT_Z,
        },
      });
      viewer.camera.frustum.near = 1.0;
      viewer.camera.frustum.far = 100_000_000.0;

      function addBox(id, distance, size, color) {
        return scene.primitives.add(
          new C.Primitive({
            geometryInstances: new C.GeometryInstance({
              geometry: C.BoxGeometry.fromDimensions({
                vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
                dimensions: new C.Cartesian3(size, size, size),
              }),
              modelMatrix: C.Matrix4.fromTranslation(
                new C.Cartesian3(cameraOrigin.x, distance, cameraOrigin.z),
              ),
              attributes: {
                color: C.ColorGeometryInstanceAttribute.fromColor(color),
              },
              id,
            }),
            appearance: new C.PerInstanceColorAppearance({ closed: true }),
            asynchronous: false,
          }),
        );
      }

      // Both boxes subtend roughly the same angle and overlap at screen center,
      // but their distance ratio guarantees separate far/near slices.
      const farBox = addBox("far-box", 10_000_000.0, 1_000_000.0, C.Color.BLUE);
      const nearBox = addBox("near-box", 1_000.0, 100.0, C.Color.RED);

      async function renderFrames(count) {
        for (let i = 0; i < count; i++) {
          scene.render();
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }

      await renderFrames(12);
      const frustums = scene._view.frustumCommandsList.map((frustum) => ({
        near: frustum.near,
        far: frustum.far,
        commandCount: frustum.indices.reduce((sum, count) => sum + count, 0),
      }));
      const center = new C.Cartesian2(
        Math.floor(scene.canvas.clientWidth * 0.5),
        Math.floor(scene.canvas.clientHeight * 0.5),
      );

      const taa =
        scene._alternateSceneRenderer?._postProcess?.taaEffect ?? null;
      const taaBefore = taa?.getStatistics?.().resolveCount ?? null;
      async function pickWithTimeout() {
        return await Promise.race([
          scene.pickAsync(center, 3, 3),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("pickAsync timed out")), 20000),
          ),
        ]);
      }
      const nearHit = await pickWithTimeout();
      await renderFrames(4);

      nearBox.show = false;
      await renderFrames(4);
      const farHit = await pickWithTimeout();
      await renderFrames(4);
      const taaAfter = taa?.getStatistics?.().resolveCount ?? null;

      // Keep both variables live through the pick sequence. PrimitiveCollection
      // owns them, but this also makes accidental probe simplification obvious.
      void farBox;

      return {
        renderer,
        frustums,
        nearHit: nearHit?.id ?? null,
        farHit: farHit?.id ?? null,
        taaEnabled: scene.taaEnabled,
        taaResolveBefore: taaBefore,
        taaResolveAfter: taaAfter,
        deviceErrors: localDeviceErrors,
      };
    },
    { renderer },
  );

  result.pageErrors = pageErrors;
  result.deviceErrors.push(...deviceErrors);
  await page.close();
  console.log(`[probe-pick-multifrustum] completed ${renderer}`);
  return result;
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

try {
  const report = {};
  for (const renderer of RENDERERS) {
    report[renderer] = await runRenderer(browser, renderer);
  }
  console.log(JSON.stringify(report, null, 2));

  const rendererPasses = Object.values(report).map(
    (result) =>
      result.frustums.length >= 2 &&
      result.nearHit === "near-box" &&
      result.farHit === "far-box" &&
      result.pageErrors.length === 0 &&
      result.deviceErrors.length === 0,
  );
  const webgpu = report.webgpu;
  const taaPass =
    !webgpu ||
    (webgpu.taaEnabled === true &&
      webgpu.taaResolveAfter !== null &&
      webgpu.taaResolveAfter > webgpu.taaResolveBefore);
  if (!rendererPasses.every(Boolean) || !taaPass) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
