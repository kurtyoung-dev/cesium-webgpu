#!/usr/bin/env node
// C11-212 real-GPU multi-frustum snap-occlusion acceptance probe.
// @purpose C11-212 multi-frustum snap occlusion: far snappable model hidden/revealed by a near primitive across slices; no stale far-slice payload.
// @status ACTIVE
//
// A far, snappable Model and a near, snapless Primitive overlap at the query
// pixel while Cesium renders them in different frustum slices. The far model
// must be returned while the near primitive is hidden, must disappear after
// the near primitive contributes depth, and must return after the primitive is
// hidden again. This specifically detects stale far-slice snap payload that
// survives a nearer slice's depth clear/rebuild.
//
// The WebGPU API returns only a completed readback whose immutable view still
// matches the current query. Polling is therefore bounded by wall-clock time;
// no individual cold result is interpreted as the final answer.
//
// Usage:
//   PROBE_BASE=http://localhost:8080 \
//   PROBE_RENDERERS=webgpu,webgl \
//   node Tools/visual-regression/probe-snap-multifrustum.mjs

import fs from "node:fs";
import { chromium } from "playwright";

// Machine-safety watchdog (Batch 861+ fleet sweep). A probe that wedges holds a
// headless Edge + GPU process alive indefinitely; `unref` keeps the timer from
// extending a healthy run.
const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-snap-multifrustum] watchdog fired after ${WATCHDOG_MS} ms`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const RENDERERS = (process.env.PROBE_RENDERERS ?? "webgpu,webgl")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const OUTPUT_DIRECTORY = "Tools/visual-regression/output";

async function runRenderer(browser, renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const setup = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = window.viewer;
    const scene = viewer.scene;
    const deviceErrors = [];
    const device = scene.context?._device;
    if (device) {
      device.addEventListener("uncapturederror", (event) => {
        deviceErrors.push(event.error?.message ?? String(event.error));
      });
    }

    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.primitives.removeAll();
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.requestRenderMode = false;
    scene.msaaSamples = 1;
    scene.taaEnabled = true;

    const cameraOrigin = new C.Cartesian3(7_000_000.0, 0.0, 0.0);
    const farPlacement = new C.Cartesian3(cameraOrigin.x, 10_000_000.0, 0.0);
    const farModel = scene.primitives.add(
      await C.Model.fromGltfAsync({
        url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
        modelMatrix: C.Matrix4.fromTranslation(farPlacement),
        scale: 250_000.0,
        id: "far-model",
      }),
    );

    for (let i = 0; i < 240 && !farModel.ready; i++) {
      scene.render();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (!farModel.ready) {
      return { error: "far Model did not become ready", deviceErrors };
    }

    // A glTF's local origin is not guaranteed to be its visual center. At this
    // deliberately huge scale the MilkTruck's local-center offset projects to
    // many screen pixels, so aiming at modelMatrix translation would create a
    // false miss on both backends. Build the camera/occluder ray from the
    // resolved world-space bounding sphere instead.
    const farCenter = C.Cartesian3.clone(farModel.boundingSphere.center);
    const viewDirection = C.Cartesian3.normalize(
      C.Cartesian3.subtract(farCenter, cameraOrigin, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const nearCenter = C.Cartesian3.add(
      cameraOrigin,
      C.Cartesian3.multiplyByScalar(viewDirection, 1_000.0, new C.Cartesian3()),
      new C.Cartesian3(),
    );

    // Keep the near box hidden while the far payload is first proven. Its
    // angular extent is larger than the far model, so showing it later fully
    // covers the center query while remaining a snapless depth producer.
    const nearPrimitive = scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: C.BoxGeometry.fromDimensions({
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
            dimensions: new C.Cartesian3(300.0, 300.0, 300.0),
          }),
          modelMatrix: C.Matrix4.fromTranslation(nearCenter),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.RED),
          },
          id: "near-snapless-box",
        }),
        appearance: new C.PerInstanceColorAppearance({ closed: true }),
        asynchronous: false,
        show: false,
      }),
    );

    viewer.camera.setView({
      destination: cameraOrigin,
      orientation: {
        direction: viewDirection,
        up: C.Cartesian3.UNIT_Z,
      },
    });
    viewer.camera.frustum.near = 1.0;
    viewer.camera.frustum.far = 100_000_000.0;
    scene.logarithmicDepthFarToNearRatio = 1000.0;

    async function renderFrames(count) {
      for (let i = 0; i < count; i++) {
        scene.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }

    const center = new C.Cartesian2(
      Math.floor(scene.canvas.clientWidth * 0.5),
      Math.floor(scene.canvas.clientHeight * 0.5),
    );

    function isFarModelHit(hit) {
      const object = hit?.object;
      return (
        object === farModel ||
        object?.primitive === farModel ||
        object?.detail?.model === farModel
      );
    }

    async function pollSnap(expected, timeoutMs = 8_000) {
      const deadline = performance.now() + timeoutMs;
      const samples = [];
      let consecutiveMatches = 0;
      let lastHit;
      while (performance.now() < deadline) {
        lastHit = scene.snap(center, { width: 3, height: 3 });
        const object = lastHit?.object;
        const farModelHit = isFarModelHit(lastHit);
        const matched = expected === "far-model" ? farModelHit : !lastHit;
        samples.push({
          hit: !!lastHit,
          farModelHit,
          isEdge: lastHit?.isEdge ?? null,
          objectId:
            object === undefined || object === null
              ? null
              : String(object.id ?? object),
        });
        consecutiveMatches = matched ? consecutiveMatches + 1 : 0;
        // Requiring three completed observations prevents one transient cached
        // result from deciding either side of the occlusion transition.
        if (consecutiveMatches >= 3) {
          return {
            matched: true,
            sampleCount: samples.length,
            samples: samples.slice(-12),
            lastHit,
          };
        }
        scene.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return {
        matched: false,
        sampleCount: samples.length,
        samples: samples.slice(-12),
        lastHit,
      };
    }

    await renderFrames(16);
    const farVisible = await pollSnap("far-model");
    const initialFrustums = scene._view.frustumCommandsList.map((frustum) => ({
      near: frustum.near,
      far: frustum.far,
      commandCount: frustum.indices.reduce((sum, count) => sum + count, 0),
    }));

    nearPrimitive.show = true;
    await renderFrames(8);
    const nearOccludes = await pollSnap("miss");
    const occludedFrustums = scene._view.frustumCommandsList.map((frustum) => ({
      near: frustum.near,
      far: frustum.far,
      commandCount: frustum.indices.reduce((sum, count) => sum + count, 0),
    }));

    function ownerSlices(owner) {
      const slices = [];
      for (let i = 0; i < scene._view.frustumCommandsList.length; i++) {
        const frustum = scene._view.frustumCommandsList[i];
        let found = false;
        for (let pass = 0; pass < frustum.commands.length && !found; pass++) {
          const commands = frustum.commands[pass];
          const count = frustum.indices[pass];
          for (let commandIndex = 0; commandIndex < count; commandIndex++) {
            if (commands[commandIndex]?.owner === owner) {
              found = true;
              break;
            }
          }
        }
        if (found) {
          slices.push(i);
        }
      }
      return slices;
    }

    const farModelSlices = ownerSlices(farModel);
    const nearPrimitiveSlices = ownerSlices(nearPrimitive);
    const ownersOccupyDistinctSlices =
      farModelSlices.length > 0 &&
      nearPrimitiveSlices.length > 0 &&
      farModelSlices.every(
        (farSlice) => !nearPrimitiveSlices.includes(farSlice),
      );

    nearPrimitive.show = false;
    await renderFrames(8);
    const farReturns = await pollSnap("far-model");

    return {
      renderer: scene.context?._device ? "webgpu" : "webgl",
      farVisible: farVisible.matched,
      nearOccludes: nearOccludes.matched,
      farReturns: farReturns.matched,
      farSampleCount: farVisible.sampleCount,
      occludedSampleCount: nearOccludes.sampleCount,
      returnSampleCount: farReturns.sampleCount,
      farSamples: farVisible.samples,
      occludedSamples: nearOccludes.samples,
      returnSamples: farReturns.samples,
      initialFrustums,
      occludedFrustums,
      numberOfFrustums: scene.numberOfFrustums,
      farModelSlices,
      nearPrimitiveSlices,
      ownersOccupyDistinctSlices,
      farBoundingRadius: farModel.boundingSphere.radius,
      taaEnabled: scene.taaEnabled,
      deviceErrors,
    };
  });

  const canvas = page.locator(".cesium-widget canvas").first();
  await canvas.screenshot({
    path: `${OUTPUT_DIRECTORY}/snap-multifrustum-${renderer}.png`,
  });
  await page.close();

  return { ...setup, consoleErrors, pageErrors };
}

fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
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
  fs.writeFileSync(
    `${OUTPUT_DIRECTORY}/snap-multifrustum-report.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));

  const pass = Object.values(report).every(
    (result) =>
      !result.error &&
      result.farVisible === true &&
      result.nearOccludes === true &&
      result.farReturns === true &&
      result.occludedFrustums?.length >= 2 &&
      result.ownersOccupyDistinctSlices === true &&
      result.deviceErrors?.length === 0 &&
      result.consoleErrors?.length === 0 &&
      result.pageErrors?.length === 0,
  );
  console.log(
    `C11-212 multi-frustum snap occlusion: ${pass ? "PASS" : "FAIL"}`,
  );
  if (!pass) process.exitCode = 1;
} finally {
  await browser.close();
}
