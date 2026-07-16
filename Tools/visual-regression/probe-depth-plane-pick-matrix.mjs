#!/usr/bin/env node
/**
 * C9-02A/C9-02B physical depth-plane scene/pick attachment matrix.
 *
 * Exercises the same live WebGPU depth plane through SDR/HDR, MSAA 1/4,
 * viewport resize, and the renderer's device-invalidation rebuild seam. It
 * records the dynamic uniform offsets used by every natural-frustum scene and
 * pick draw and fails any GPU/page/attachment error.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(toolDirectory, "..", "..");
const baseUrl =
  process.env.CESIUM_VIEWER_URL ||
  "http://localhost:8080/Apps/CesiumViewer/index.html";
const outputPath = resolve(
  process.argv[2] ||
    resolve(
      toolDirectory,
      "output",
      "performance",
      "campaign9-c9-02a-depth-plane-pick-matrix-2026-07-16.json",
    ),
);
const initialViewport = { width: 960, height: 640 };
const resizedViewport = { width: 1112, height: 702 };

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function runtimeBundleIdentity() {
  const path = resolve(repositoryDirectory, "Build/CesiumUnminified/Cesium.js");
  const bytes = await readFile(path);
  return {
    path: "Build/CesiumUnminified/Cesium.js",
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function expectedOffsets(count, stride) {
  return Array.from({ length: count }, (_unused, index) => index * stride);
}

function validatePhase(phase, failures) {
  const prefix = phase.label;
  if (!phase.pipelineReady.scene || !phase.pipelineReady.pick) {
    failures.push(`${prefix}: scene/pick pipelines were not both ready`);
  }
  if (phase.actual.hdr !== phase.requested.hdr) {
    failures.push(`${prefix}: HDR request was not applied`);
  }
  if (phase.actual.msaa !== phase.requested.msaa) {
    failures.push(
      `${prefix}: expected MSAA ${phase.requested.msaa}, got ${phase.actual.msaa}`,
    );
  }
  if (phase.actual.depthPlaneColorFormat !== phase.actual.scenePipelineFormat) {
    failures.push(`${prefix}: depth-plane scene color format drift`);
  }
  if (phase.actual.depthPlaneDepthFormat !== phase.actual.contextDepthFormat) {
    failures.push(`${prefix}: depth-plane depth format drift`);
  }
  if (phase.actual.depthPlaneSampleCount !== phase.actual.msaa) {
    failures.push(`${prefix}: depth-plane sample-count drift`);
  }
  if (!phase.actual.depthPlanePickFormat) {
    failures.push(`${prefix}: depth-plane pick format is undeclared`);
  }
  const sceneExpected = expectedOffsets(
    phase.frustums.scene,
    phase.uniformStride,
  );
  const pickExpected = expectedOffsets(
    phase.frustums.pick,
    phase.uniformStride,
  );
  if (JSON.stringify(phase.offsets.scene) !== JSON.stringify(sceneExpected)) {
    failures.push(
      `${prefix}: scene offsets ${JSON.stringify(phase.offsets.scene)} != ${JSON.stringify(sceneExpected)}`,
    );
  }
  if (JSON.stringify(phase.offsets.pick) !== JSON.stringify(pickExpected)) {
    failures.push(
      `${prefix}: pick offsets ${JSON.stringify(phase.offsets.pick)} != ${JSON.stringify(pickExpected)}`,
    );
  }
  if (phase.reservations.scene !== phase.frustums.scene) {
    failures.push(
      `${prefix}: scene reserved ${phase.reservations.scene} draws for ` +
        `${phase.frustums.scene} frustums`,
    );
  }
  if (phase.reservations.pick !== phase.frustums.pick) {
    failures.push(
      `${prefix}: pick reserved ${phase.reservations.pick} draws for ` +
        `${phase.frustums.pick} frustums`,
    );
  }
  if (
    phase.uniformCapacity <
    Math.max(phase.frustums.scene, phase.frustums.pick)
  ) {
    failures.push(`${prefix}: uniform ring capacity is below frustum demand`);
  }
  if (phase.pickResultId !== "depth-plane-matrix-center") {
    failures.push(`${prefix}: center point pick did not survive depth-plane draw`);
  }
  if (phase.newGateErrors.length) {
    failures.push(`${prefix}: ${phase.newGateErrors.length} GPU gate errors`);
  }
  if (phase.invalidation.requested) {
    if (!phase.invalidation.callbackAvailable) {
      failures.push(`${prefix}: device-invalidation callback seam unavailable`);
    }
    if (!phase.invalidation.clearedDepthPlane) {
      failures.push(`${prefix}: invalidation did not clear the depth plane`);
    }
    if (!phase.invalidation.recreatedDepthPlane) {
      failures.push(`${prefix}: invalidation did not rebuild the depth plane`);
    }
  }
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const context = await browser.newContext({
  viewport: initialViewport,
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const gpuConsoleErrors = attachConsoleErrorGate(page);
const pageErrors = [];
const externalRequests = [];
const localOrigin = new URL(baseUrl).origin;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("request", (request) => {
  const requestUrl = new URL(request.url());
  if (
    (requestUrl.protocol === "http:" || requestUrl.protocol === "https:") &&
    requestUrl.origin !== localOrigin
  ) {
    externalRequests.push(request.url());
  }
});
await page.addInitScript(errorGateInit);

const url = new URL(baseUrl);
url.searchParams.set("renderer", "webgpu");
url.searchParams.set("offline", "true");
await page.goto(url.href, { waitUntil: "load", timeout: 60_000 });
await page.waitForFunction(
  () => globalThis.viewer?.scene?._frameState?.frameNumber > 0,
  undefined,
  { timeout: 60_000 },
);
const armed = await armWebGPUDevices(page);

const setup = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  scene.taaEnabled = false;
  scene.globe.show = true;
  scene.globe.depthTestAgainstTerrain = false;
  scene.globe.translucency.enabled = false;

  const points = new C.PointPrimitiveCollection();
  const point = points.add({
    id: "depth-plane-matrix-center",
    position: C.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000.0),
    color: C.Color.LIME,
    pixelSize: 28,
    disableDepthTestDistance: 0,
  });
  globalThis.__depthPlaneMatrixPointPosition = point.position;
  scene.primitives.add(points);
  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(-122.4194, 37.7749, 100000.0),
    orientation: {
      heading: 0.0,
      pitch: C.Math.toRadians(-90.0),
      roll: 0.0,
    },
  });

  for (let i = 0; i < 30; i++) {
    scene.render(viewer.clock.currentTime);
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
  }
  return {
    actualRenderer: scene.context.rendererType,
    pointCount: points.length,
    mode: scene.mode,
  };
});

async function runPhase(configuration) {
  return page.evaluate(async (requested) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = globalThis.viewer;
    const scene = viewer.scene;
    const context = scene.context;
    const renderer = scene._alternateSceneRenderer;
    scene.highDynamicRange = requested.hdr;
    scene.msaaSamples = requested.msaa;
    viewer.resize();
    const gateStart = globalThis.__webgpuGate?.errors?.length ?? 0;

    const invalidation = {
      requested: requested.invalidate === true,
      callbackAvailable: false,
      clearedDepthPlane: false,
      recreatedDepthPlane: false,
    };
    let depthPlaneBeforeInvalidation = null;
    if (invalidation.requested) {
      depthPlaneBeforeInvalidation = renderer?._depthPlane ?? null;
      invalidation.callbackAvailable =
        typeof context._fireDeviceInvalidated === "function";
      context._fireDeviceInvalidated?.();
      invalidation.clearedDepthPlane = renderer?._depthPlane === null;
    }

    let depthPlane = null;
    for (let i = 0; i < 240; i++) {
      scene.render(viewer.clock.currentTime);
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      depthPlane = renderer?._depthPlane ?? null;
      if (depthPlane?._pipeline && depthPlane?._pickPipeline) {
        break;
      }
    }

    const pointPosition = globalThis.__depthPlaneMatrixPointPosition;
    const projectPoint = () => {
      const projected = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        pointPosition,
      );
      return projected
        ? new C.Cartesian2(Math.round(projected.x), Math.round(projected.y))
        : undefined;
    };

    // Record the public API's cold result separately. PointPrimitive pick
    // variants compile lazily today, so a first call can legitimately expose
    // the queued NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT defect.
    // This matrix warms that unrelated producer before it uses the point as a
    // depth-plane occlusion oracle; the cold result remains explicit evidence.
    let coldPickResult;
    const coldPosition = projectPoint();
    if (coldPosition) {
      coldPickResult = await scene.pickAsync(coldPosition, 9, 9);
    }
    let warmPickResult = coldPickResult;
    let pickWarmupAttempts = 1;
    while (
      warmPickResult?.id !== "depth-plane-matrix-center" &&
      pickWarmupAttempts < 60
    ) {
      scene.render(viewer.clock.currentTime);
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const warmPosition = projectPoint();
      if (warmPosition) {
        warmPickResult = await scene.pickAsync(warmPosition, 9, 9);
      }
      pickWarmupAttempts++;
    }

    // Pick warmup may have crossed the async depth-plane pipeline deadline or
    // a device-invalidation rebuild, so observe the current owner instance.
    depthPlane = renderer?._depthPlane ?? depthPlane;
    invalidation.recreatedDepthPlane =
      invalidation.requested &&
      depthPlane !== null &&
      depthPlane !== depthPlaneBeforeInvalidation;

    const offsets = { scene: [], pick: [] };
    const passRecords = [];
    let activePassRecord = null;
    const originalExecute = depthPlane?.execute;
    const originalBeginDepthPlanePass = renderer?._beginDepthPlanePass;
    if (renderer && typeof originalBeginDepthPlanePass === "function") {
      renderer._beginDepthPlanePass = function (config, maximumDraws) {
        activePassRecord = {
          kind: config.picking ? "pick" : "scene",
          maximumDraws,
          offsets: [],
        };
        passRecords.push(activePassRecord);
        return originalBeginDepthPlanePass.call(this, config, maximumDraws);
      };
    }
    if (depthPlane && typeof originalExecute === "function") {
      depthPlane.execute = function (renderPass, passKind) {
        const pipeline =
          passKind === "pick" ? this._pickPipeline : this._pipeline;
        const willDraw = Boolean(
          this._enabled &&
            pipeline &&
            this._vertexBuffer &&
            this._bindGroup &&
            this._vertexCount > 0,
        );
        const result = originalExecute.call(this, renderPass, passKind);
        if (willDraw) {
          offsets[passKind].push(this._currentUniformOffset);
          if (activePassRecord?.kind === passKind) {
            activePassRecord.offsets.push(this._currentUniformOffset);
          }
        }
        return result;
      };
    }

    scene.render(viewer.clock.currentTime);
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    const sceneFrustums = scene._view.frustumCommandsList.length;

    const pickPosition = projectPoint();
    const pickResult =
      pickPosition && typeof scene.pickAsync === "function"
        ? await scene.pickAsync(pickPosition, 9, 9)
        : pickPosition
          ? await scene.pickHoverAsync(pickPosition, 9, 9)
          : undefined;
    const pickFrustums = scene._view.frustumCommandsList.length;
    await context._device?.queue?.onSubmittedWorkDone?.();
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));

    if (depthPlane && depthPlane.execute !== originalExecute) {
      depthPlane.execute = originalExecute;
    }
    if (
      renderer &&
      renderer._beginDepthPlanePass !== originalBeginDepthPlanePass
    ) {
      renderer._beginDepthPlanePass = originalBeginDepthPlanePass;
    }
    const currentPlane = renderer?._depthPlane ?? depthPlane;
    const sceneRecord = passRecords.findLast(
      (record) => record.kind === "scene",
    );
    const pickRecord = passRecords.findLast(
      (record) => record.kind === "pick",
    );
    const gateErrors = globalThis.__webgpuGate?.errors ?? [];
    return {
      label: requested.label,
      requested: { hdr: requested.hdr, msaa: requested.msaa },
      actual: {
        hdr: scene.highDynamicRange,
        msaa: context._msaaSamples,
        canvasWidth: scene.canvas.width,
        canvasHeight: scene.canvas.height,
        scenePipelineFormat: context.scenePipelineFormat,
        contextDepthFormat: context.depthFormat,
        depthPlaneColorFormat: currentPlane?._colorFormat ?? null,
        depthPlaneDepthFormat: currentPlane?._depthFormat ?? null,
        depthPlaneSampleCount: currentPlane?._sampleCount ?? null,
        depthPlanePickFormat: currentPlane?._pickColorFormat ?? null,
      },
      pipelineReady: {
        scene: Boolean(currentPlane?._pipeline),
        pick: Boolean(currentPlane?._pickPipeline),
      },
      frustums: { scene: sceneFrustums, pick: pickFrustums },
      reservations: {
        scene: sceneRecord?.maximumDraws ?? 0,
        pick: pickRecord?.maximumDraws ?? 0,
      },
      offsets,
      uniformStride: currentPlane?._uniformStride ?? 0,
      uniformCapacity: currentPlane?._uniformCapacity ?? 0,
      uniformBufferBytes: currentPlane?._uniformBuffer?.size ?? 0,
      pickResultId: pickResult?.id ?? null,
      coldPickResultId: coldPickResult?.id ?? null,
      warmedPickResultId: warmPickResult?.id ?? null,
      pickWarmupAttempts,
      invalidation,
      newGateErrors: gateErrors.slice(gateStart),
    };
  }, configuration);
}

const phases = [];
for (const requested of [
  { label: "sdr-msaa1", hdr: false, msaa: 1 },
  { label: "sdr-msaa4", hdr: false, msaa: 4 },
  { label: "hdr-msaa1", hdr: true, msaa: 1 },
  { label: "hdr-msaa4", hdr: true, msaa: 4 },
]) {
  phases.push(await runPhase(requested));
}

await page.setViewportSize(resizedViewport);
phases.push(
  await runPhase({ label: "resize-hdr-msaa4", hdr: true, msaa: 4 }),
);
phases.push(
  await runPhase({
    label: "device-invalidation-rebuild",
    hdr: false,
    msaa: 1,
    invalidate: true,
  }),
);

const gate = await collectGateErrors(page);
const failures = [];
if (setup.actualRenderer !== "webgpu") {
  failures.push(`expected webgpu renderer, got ${setup.actualRenderer}`);
}
if (armed.found < 1 || gate.armedDevices < 1) {
  failures.push("WebGPU error gate did not arm a live device");
}
if (pageErrors.length) failures.push(`${pageErrors.length} page errors`);
if (gpuConsoleErrors.length) {
  failures.push(`${gpuConsoleErrors.length} GPU console errors`);
}
if (gate.errors.length) failures.push(`${gate.errors.length} GPU gate errors`);
if (gate.deviceLost) failures.push(gate.deviceLost);
if (externalRequests.length) {
  failures.push(`${externalRequests.length} external requests`);
}
for (const phase of phases) validatePhase(phase, failures);

const resizePhase = phases.find((phase) => phase.label === "resize-hdr-msaa4");
if (
  resizePhase?.actual.canvasWidth !== resizedViewport.width ||
  resizePhase?.actual.canvasHeight !== resizedViewport.height
) {
  failures.push(
    `resize: expected ${resizedViewport.width}x${resizedViewport.height}, got ` +
      `${resizePhase?.actual.canvasWidth}x${resizePhase?.actual.canvasHeight}`,
  );
}

const report = {
  schemaVersion: 1,
  kind: "depth-plane-pick-attachment-and-uniform-matrix",
  generatedAt: new Date().toISOString(),
  runtimeBundle: await runtimeBundleIdentity(),
  browserVersion: browser.version(),
  initialViewport,
  resizedViewport,
  setup,
  armed,
  phases,
  gate,
  gpuConsoleErrors,
  pageErrors,
  externalRequests,
  failures,
  result: failures.length ? "fail" : "pass",
  recoveryScope:
    "The deterministic matrix fires the same device-invalidation subscriber seam used after recovery and proves resource recreation. It does not claim a physical adapter/device-loss event.",
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
await context.close();
await browser.close();
console.log(
  JSON.stringify(
    {
      result: report.result,
      failures: report.failures,
      bundle: report.runtimeBundle,
      phases: report.phases.map((phase) => ({
        label: phase.label,
        actual: phase.actual,
        frustums: phase.frustums,
        reservations: phase.reservations,
        offsets: phase.offsets,
        pickResultId: phase.pickResultId,
        coldPickResultId: phase.coldPickResultId,
        pickWarmupAttempts: phase.pickWarmupAttempts,
        invalidation: phase.invalidation,
      })),
      output: outputPath,
    },
    null,
    2,
  ),
);
process.exitCode = report.result === "pass" ? 0 : 1;
