#!/usr/bin/env node
/**
 * C9-02B WebGPU depth-plane horizon oracle.
 *
 * A deterministic ellipsoid scene places one point immediately before the
 * geometric horizon and another immediately beyond it. The normal production
 * path must keep the front point visible/pickable and occlude the back point.
 * `Scene.debugSkipDepthPlane` is then used only as an A/B diagnostic: the back
 * point must become visible and pickable while the skip is active, and become
 * occluded again after the normal feature is restored.
 *
 * The scene-color assertion is a direct GPUTexture -> GPUBuffer readback from
 * the WebGPU scene framebuffer. Public `Scene.pickAsync` supplies a second,
 * independent pick-path assertion; screenshots are not used as the oracle.
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
      "campaign9-c9-02b-depth-plane-horizon-oracle-2026-07-16.json",
    ),
);
const viewport = { width: 1120, height: 720 };
const altitudes = [
  { label: "near", heightMeters: 20_000 },
  { label: "middle", heightMeters: 500_000 },
  { label: "far", heightMeters: 5_000_000 },
];

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

function validateAltitude(result, failures) {
  const prefix = result.label;
  if (!result.geometry.frontBeforeHorizon) {
    failures.push(`${prefix}: front control is not before the geometric horizon`);
  }
  if (!result.geometry.backBeyondHorizon) {
    failures.push(`${prefix}: back marker is not beyond the geometric horizon`);
  }
  if (result.geometry.frontLineOfSightOccluded) {
    failures.push(`${prefix}: front control ray intersects the ellipsoid first`);
  }
  if (!result.geometry.backLineOfSightOccluded) {
    failures.push(`${prefix}: back marker ray does not intersect the ellipsoid first`);
  }
  if (!result.geometry.frontOnCanvas || !result.geometry.backOnCanvas) {
    failures.push(`${prefix}: one or more oracle points projected off-canvas`);
  }
  if (!result.pipelineReady.scene || !result.pipelineReady.pick) {
    failures.push(`${prefix}: scene/pick depth-plane pipelines were not ready`);
  }
  if (!result.logDepth.scene || !result.logDepth.frameState) {
    failures.push(`${prefix}: logarithmic depth was not active`);
  }
  if (!result.logDepth.depthPlaneVariant) {
    failures.push(`${prefix}: depth plane did not use its log-depth variant`);
  }
  if (result.pipelinePrewarm.frontPickId !== "depth-plane-front") {
    failures.push(`${prefix}: point pick pipeline did not prewarm on front control`);
  }
  if (!result.pipelinePrewarm.colorReady || !result.pipelinePrewarm.pickReady) {
    failures.push(`${prefix}: point color/pick pipelines were not ready before measurement`);
  }
  if (result.pipelinePrewarm.useDepthPlane) {
    failures.push(`${prefix}: point prewarm unexpectedly encoded the depth plane`);
  }

  const normal = result.phases.normal;
  const skipped = result.phases.diagnosticSkip;
  const restored = result.phases.restored;
  if (!normal.useDepthPlane || skipped.useDepthPlane || !restored.useDepthPlane) {
    failures.push(
      `${prefix}: useDepthPlane did not follow true -> false -> true diagnostic sequence`,
    );
  }
  for (const phase of [normal, restored]) {
    if (phase.depthPlaneDraws.scene < 1 || phase.depthPlaneDraws.pick < 1) {
      failures.push(
        `${prefix}/${phase.label}: actual scene and pick depth-plane draws were not both observed`,
      );
    }
  }
  if (
    skipped.depthPlaneDraws.scene !== 0 ||
    skipped.depthPlaneDraws.pick !== 0
  ) {
    failures.push(`${prefix}/diagnostic-skip: depth-plane draw was still encoded`);
  }

  for (const phase of [normal, skipped, restored]) {
    if (!phase.frontPickIds.every((id) => id === "depth-plane-front")) {
      failures.push(`${prefix}/${phase.label}: front-side pick control failed`);
    }
    if (phase.scenePixels.front.limeLike < 24) {
      failures.push(`${prefix}/${phase.label}: front-side scene control was not visible`);
    }
  }
  if (normal.backPickIds.includes("depth-plane-back")) {
    failures.push(`${prefix}/normal: beyond-horizon marker was pickable`);
  }
  if (!skipped.backPickIds.every((id) => id === "depth-plane-back")) {
    failures.push(`${prefix}/diagnostic-skip: beyond-horizon marker did not become pickable`);
  }
  if (restored.backPickIds.includes("depth-plane-back")) {
    failures.push(`${prefix}/restored: beyond-horizon marker remained pickable`);
  }

  const skipMagenta = skipped.scenePixels.back.magentaLike;
  const normalMagenta = normal.scenePixels.back.magentaLike;
  const restoredMagenta = restored.scenePixels.back.magentaLike;
  if (skipMagenta < 24) {
    failures.push(`${prefix}/diagnostic-skip: back marker did not appear in GPU readback`);
  }
  const occludedLimit = Math.max(4, Math.floor(skipMagenta * 0.1));
  if (normalMagenta > occludedLimit) {
    failures.push(
      `${prefix}/normal: back marker leaked through (${normalMagenta} magenta pixels)`,
    );
  }
  if (restoredMagenta > occludedLimit) {
    failures.push(
      `${prefix}/restored: back marker leaked after restoration (${restoredMagenta} magenta pixels)`,
    );
  }
  for (const phase of [normal, skipped, restored]) {
    if (phase.gateErrors.length) {
      failures.push(`${prefix}/${phase.label}: ${phase.gateErrors.length} GPU errors`);
    }
  }
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
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

let setup = null;
let results = [];
let armed = { armed: 0, found: 0, total: 0 };
let fatalError = null;
try {
  await page.goto(url.href, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(
    () => globalThis.viewer?.scene?._frameState?.frameNumber > 0,
    undefined,
    { timeout: 60_000 },
  );
  armed = await armWebGPUDevices(page);

  setup = await page.evaluate(async (configurations) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = globalThis.viewer;
    const scene = viewer.scene;
    viewer.useDefaultRenderLoop = false;
    scene.requestRenderMode = false;
    scene.highDynamicRange = false;
    scene.msaaSamples = 1;
    scene.taaEnabled = false;
    scene.logarithmicDepthBuffer = true;
    scene.globe.show = true;
    scene.globe.depthTestAgainstTerrain = false;
    scene.globe.translucency.enabled = false;
    viewer.terrainProvider = new C.EllipsoidTerrainProvider({
      ellipsoid: C.Ellipsoid.WGS84,
    });

    const ellipsoidRadius = C.Ellipsoid.WGS84.maximumRadius;
    const collections = {};
    for (const configuration of configurations) {
      const horizonAngle = Math.acos(
        ellipsoidRadius / (ellipsoidRadius + configuration.heightMeters),
      );
      const deltaAngle = horizonAngle * 0.35;
      const latitudeOffset = horizonAngle * 0.08;
      const points = new C.PointPrimitiveCollection();
      points.blendOption = C.BlendOption.OPAQUE;
      points.show = false;
      points.add({
        id: "depth-plane-front",
        position: C.Cartesian3.fromRadians(
          horizonAngle - deltaAngle,
          -latitudeOffset,
          250,
        ),
        color: C.Color.LIME,
        outlineColor: C.Color.BLACK,
        outlineWidth: 2,
        pixelSize: 42,
        disableDepthTestDistance: 0,
      });
      points.add({
        id: "depth-plane-back",
        position: C.Cartesian3.fromRadians(
          horizonAngle + deltaAngle,
          latitudeOffset,
          -250,
        ),
        color: C.Color.MAGENTA,
        outlineColor: C.Color.BLACK,
        outlineWidth: 2,
        pixelSize: 42,
        disableDepthTestDistance: 0,
      });
      collections[configuration.label] = points;
      scene.primitives.add(points);
    }

    // The scene's ordinary globe occluder can reject a fully back-facing draw
    // command on the CPU, before the GPU depth plane is exercised. This oracle
    // deliberately suppresses that CPU occluder for this isolated local scene;
    // frustum culling is still applied. The scene contains no other user
    // primitives, so the GPU plane must be the thing that hides
    // `depth-plane-back`.
    const originalIsVisible = scene.isVisible;
    scene.isVisible = function (cullingVolume, command, occluder) {
      return originalIsVisible.call(
        this,
        cullingVolume,
        command,
        undefined,
      );
    };

    // Scene.updateEnvironment honors debugSkipDepthPlane, but the current
    // WebGPUContext.updateAndClearFramebuffers recomputes useDepthPlane later
    // without that debug term. Bridge the diagnostic at that final config seam
    // in this page only. Normal and restored phases take the original result
    // byte-for-byte; only an explicit debug skip flips the final boolean.
    const graphicsContext = scene.context;
    const originalUpdateAndClearFramebuffers =
      graphicsContext.updateAndClearFramebuffers;
    graphicsContext.updateAndClearFramebuffers = function (...args) {
      const handled = originalUpdateAndClearFramebuffers.apply(this, args);
      const activeScene = args[0];
      if (activeScene?.debugSkipDepthPlane === true) {
        activeScene._environmentState.useDepthPlane = false;
      }
      return handled;
    };

    globalThis.__depthPlaneHorizon = {
      C,
      viewer,
      scene,
      collections,
      originalIsVisible,
      originalUpdateAndClearFramebuffers,
    };

    for (let i = 0; i < 24; i++) {
      scene.render(viewer.clock.currentTime);
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    }
    return {
      actualRenderer: scene.context.rendererType,
      terrainProvider: viewer.terrainProvider?.constructor?.name ?? null,
      pointCount: Object.values(collections).reduce(
        (count, points) => count + points.length,
        0,
      ),
      canvas: { width: scene.canvas.width, height: scene.canvas.height },
      sceneMode: scene.mode,
      colorFormat: scene.context.scenePipelineFormat,
      diagnosticBridges: {
        cpuOccluderBypassIsolatedScene: true,
        debugSkipAtFinalWebGPUConfigSeam: true,
      },
    };
  }, altitudes);

  for (const altitude of altitudes) {
    const result = await page.evaluate(async (configuration) => {
      const { C, viewer, scene, collections } =
        globalThis.__depthPlaneHorizon;
      const points = collections[configuration.label];
      for (const collection of Object.values(collections)) {
        collection.show = collection === points;
      }
      const renderer = scene._alternateSceneRenderer;
      const device = scene.context._device;
      const radius = C.Ellipsoid.WGS84.maximumRadius;
      const horizonAngle = Math.acos(
        radius / (radius + configuration.heightMeters),
      );
      const deltaAngle = horizonAngle * 0.35;
      const latitudeOffset = horizonAngle * 0.08;
      const frontAngle = horizonAngle - deltaAngle;
      const backAngle = horizonAngle + deltaAngle;
      const toDegrees = C.Math.toDegrees;
      const frontPosition = points.get(0).position;
      const backPosition = points.get(1).position;

      scene.camera.setView({
        destination: C.Cartesian3.fromRadians(
          0,
          0,
          configuration.heightMeters,
        ),
        orientation: {
          heading: C.Math.PI_OVER_TWO,
          pitch: -horizonAngle,
          roll: 0,
        },
      });

      async function renderFrames(count) {
        for (let i = 0; i < count; i++) {
          scene.render(viewer.clock.currentTime);
          await new Promise((resolveFrame) =>
            requestAnimationFrame(resolveFrame),
          );
        }
      }

      scene.debugSkipDepthPlane = false;
      let depthPlane = null;
      for (let i = 0; i < 180; i++) {
        await renderFrames(1);
        depthPlane = renderer?._depthPlane ?? null;
        if (
          depthPlane?._pipeline &&
          depthPlane?._pickPipeline &&
          scene._environmentState?.useDepthPlane === true
        ) {
          break;
        }
      }

      function project(position) {
        const value = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          position,
        );
        return value
          ? new C.Cartesian2(Math.round(value.x), Math.round(value.y))
          : undefined;
      }

      // Prove both point pipelines are materialized before a missing pick is
      // accepted as an occlusion result. The page-local diagnostic seam is
      // active only for this unmeasured warmup, then restored before phase 1.
      scene.debugSkipDepthPlane = true;
      let prewarmFrontPick;
      let prewarmAttempts = 0;
      for (; prewarmAttempts < 120; prewarmAttempts++) {
        await renderFrames(1);
        const frontWindow = project(frontPosition);
        prewarmFrontPick = frontWindow
          ? await scene.pickAsync(frontWindow, 7, 7)
          : undefined;
        if (
          prewarmFrontPick?.id === "depth-plane-front" &&
          points._webgpuCache?.pipeline &&
          points._webgpuCache?.pickPipeline
        ) {
          prewarmAttempts++;
          break;
        }
      }
      const pipelinePrewarm = {
        attempts: prewarmAttempts,
        frontPickId: prewarmFrontPick?.id ?? null,
        colorReady: Boolean(points._webgpuCache?.pipeline),
        pickReady: Boolean(points._webgpuCache?.pickPipeline),
        useDepthPlane: scene._environmentState?.useDepthPlane === true,
      };
      scene.debugSkipDepthPlane = false;
      await renderFrames(8);

      async function readScenePatch(position, radiusPixels = 24) {
        const sceneFramebuffer = renderer?._sceneFramebuffer;
        const texture = sceneFramebuffer?.colorTexture;
        const format = sceneFramebuffer?.colorFormat ?? "unknown";
        const width = scene.canvas.width;
        const height = scene.canvas.height;
        if (!texture || !device || !position) {
          return {
            available: false,
            format,
            limeLike: 0,
            magentaLike: 0,
            pixelCount: 0,
          };
        }
        const x = Math.max(
          0,
          Math.min(width - 1, Math.floor(position.x) - radiusPixels),
        );
        const y = Math.max(
          0,
          Math.min(height - 1, Math.floor(position.y) - radiusPixels),
        );
        const copyWidth = Math.max(
          1,
          Math.min(radiusPixels * 2 + 1, width - x),
        );
        const copyHeight = Math.max(
          1,
          Math.min(radiusPixels * 2 + 1, height - y),
        );
        const bytesPerRow = Math.ceil((copyWidth * 4) / 256) * 256;
        const buffer = device.createBuffer({
          label: `DepthPlane horizon oracle ${configuration.label}`,
          size: bytesPerRow * copyHeight,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = device.createCommandEncoder({
          label: `DepthPlane horizon readback ${configuration.label}`,
        });
        encoder.copyTextureToBuffer(
          { texture, origin: { x, y, z: 0 } },
          { buffer, bytesPerRow, rowsPerImage: copyHeight },
          { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(buffer.getMappedRange());
        const bgra = String(format).startsWith("bgra");
        let limeLike = 0;
        let magentaLike = 0;
        let nonBlack = 0;
        for (let row = 0; row < copyHeight; row++) {
          for (let column = 0; column < copyWidth; column++) {
            const offset = row * bytesPerRow + column * 4;
            const red = bytes[offset + (bgra ? 2 : 0)];
            const green = bytes[offset + 1];
            const blue = bytes[offset + (bgra ? 0 : 2)];
            if (green > 170 && red < 120 && blue < 120) limeLike++;
            if (red > 170 && green < 120 && blue > 170) magentaLike++;
            if (red > 8 || green > 8 || blue > 8) nonBlack++;
          }
        }
        buffer.unmap();
        buffer.destroy();
        return {
          available: true,
          format,
          origin: { x, y },
          size: { width: copyWidth, height: copyHeight },
          pixelCount: copyWidth * copyHeight,
          limeLike,
          magentaLike,
          nonBlack,
        };
      }

      async function pickIds(position, sampleCount = 3) {
        const ids = [];
        for (let i = 0; i < sampleCount; i++) {
          const picked = position
            ? await scene.pickAsync(position, 7, 7)
            : undefined;
          ids.push(picked?.id ?? null);
        }
        return ids;
      }

      const drawRecords = [];
      let activePhase = "setup";
      const originalExecute = depthPlane?.execute;
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
          const uniformOffset = this._currentUniformOffset;
          const result = originalExecute.call(this, renderPass, passKind);
          if (willDraw) {
            drawRecords.push({
              phase: activePhase,
              passKind,
              uniformOffset,
            });
          }
          return result;
        };
      }

      async function runPhase(label, diagnosticSkip) {
        activePhase = label;
        scene.debugSkipDepthPlane = diagnosticSkip;
        const gateStart = globalThis.__webgpuGate?.errors?.length ?? 0;
        const drawStart = drawRecords.length;
        await renderFrames(5);
        const frontWindow = project(frontPosition);
        const backWindow = project(backPosition);
        const scenePixels = {
          front: await readScenePatch(frontWindow),
          back: await readScenePatch(backWindow),
        };

        const frontPickIds = await pickIds(frontWindow, 3);
        const backPickIds = await pickIds(backWindow, 3);
        await device.queue.onSubmittedWorkDone();

        const phaseRecords = drawRecords.slice(drawStart);
        return {
          label,
          diagnosticSkip,
          useDepthPlane: scene._environmentState?.useDepthPlane === true,
          clearGlobeDepth:
            scene._environmentState?.clearGlobeDepth === true,
          frontWindow: frontWindow
            ? { x: frontWindow.x, y: frontWindow.y }
            : null,
          backWindow: backWindow
            ? { x: backWindow.x, y: backWindow.y }
            : null,
          scenePixels,
          frontPickIds,
          backPickIds,
          depthPlaneDraws: {
            scene: phaseRecords.filter((record) => record.passKind === "scene")
              .length,
            pick: phaseRecords.filter((record) => record.passKind === "pick")
              .length,
          },
          uniformOffsets: {
            scene: phaseRecords
              .filter((record) => record.passKind === "scene")
              .map((record) => record.uniformOffset),
            pick: phaseRecords
              .filter((record) => record.passKind === "pick")
              .map((record) => record.uniformOffset),
          },
          gateErrors: (globalThis.__webgpuGate?.errors ?? []).slice(gateStart),
        };
      }

      let phases;
      try {
        phases = {
          normal: await runPhase("normal", false),
          diagnosticSkip: await runPhase("diagnosticSkip", true),
          restored: await runPhase("restored", false),
        };
      } finally {
        scene.debugSkipDepthPlane = false;
        if (depthPlane && depthPlane.execute !== originalExecute) {
          depthPlane.execute = originalExecute;
        }
      }

      const frontWindow = phases.normal.frontWindow;
      const backWindow = phases.normal.backWindow;
      const canvasWidth = scene.canvas.width;
      const canvasHeight = scene.canvas.height;
      const isOnCanvas = (position) =>
        Boolean(
          position &&
            position.x >= 24 &&
            position.y >= 24 &&
            position.x < canvasWidth - 24 &&
            position.y < canvasHeight - 24,
        );
      const cameraPosition = scene.camera.positionWC;
      function lineOfSight(position) {
        const direction = C.Cartesian3.normalize(
          C.Cartesian3.subtract(
            position,
            cameraPosition,
            new C.Cartesian3(),
          ),
          new C.Cartesian3(),
        );
        const pointDistance = C.Cartesian3.distance(cameraPosition, position);
        const interval = C.IntersectionTests.rayEllipsoid(
          new C.Ray(cameraPosition, direction),
          C.Ellipsoid.WGS84,
        );
        const firstIntersectionDistance = interval?.start ?? null;
        return {
          pointDistance,
          firstIntersectionDistance,
          occluded:
            firstIntersectionDistance !== null &&
            firstIntersectionDistance < pointDistance - 1,
        };
      }
      const frontLineOfSight = lineOfSight(frontPosition);
      const backLineOfSight = lineOfSight(backPosition);
      return {
        label: configuration.label,
        heightMeters: configuration.heightMeters,
        cameraHeightMeters: scene.camera.positionCartographic.height,
        geometry: {
          ellipsoidRadiusMeters: radius,
          horizonAngleDegrees: toDegrees(horizonAngle),
          deltaAngleDegrees: toDegrees(deltaAngle),
          latitudeOffsetDegrees: toDegrees(latitudeOffset),
          frontCentralAngleDegrees: toDegrees(frontAngle),
          backCentralAngleDegrees: toDegrees(backAngle),
          frontBeforeHorizon: frontAngle < horizonAngle,
          backBeyondHorizon: backAngle > horizonAngle,
          frontOnCanvas: isOnCanvas(frontWindow),
          backOnCanvas: isOnCanvas(backWindow),
          frontLineOfSightOccluded: frontLineOfSight.occluded,
          backLineOfSightOccluded: backLineOfSight.occluded,
          frontPointDistanceMeters: frontLineOfSight.pointDistance,
          backPointDistanceMeters: backLineOfSight.pointDistance,
          frontFirstEllipsoidIntersectionMeters:
            frontLineOfSight.firstIntersectionDistance,
          backFirstEllipsoidIntersectionMeters:
            backLineOfSight.firstIntersectionDistance,
          frontHeightMeters: 250,
          backHeightMeters: -250,
        },
        pipelineReady: {
          scene: Boolean(depthPlane?._pipeline),
          pick: Boolean(depthPlane?._pickPipeline),
        },
        logDepth: {
          scene: scene.logarithmicDepthBuffer === true,
          frameState: scene._frameState?.useLogDepth === true,
          depthPlaneVariant: depthPlane?._logDepth === true,
        },
        frustumCount: scene._view?.frustumCommandsList?.length ?? 0,
        uniformStride: depthPlane?._uniformStride ?? 0,
        pipelinePrewarm,
        pointCommandDiagnostics: {
          visibleCount: points._webgpuCache?.visibleCount ?? null,
          hasColorCommand: Boolean(points._webgpuCache?.colorCommand),
          hasPickCommand: Boolean(points._webgpuCache?.pickCommand),
          colorCommandPass: points._webgpuCache?.colorCommand?.pass ?? null,
          colorCommandOcclude:
            points._webgpuCache?.colorCommand?.occlude ?? null,
          colorCommandCull: points._webgpuCache?.colorCommand?.cull ?? null,
          boundingVolume: points._webgpuCache?.colorCommand?.boundingVolume
            ? {
                center: {
                  x: points._webgpuCache.colorCommand.boundingVolume.center.x,
                  y: points._webgpuCache.colorCommand.boundingVolume.center.y,
                  z: points._webgpuCache.colorCommand.boundingVolume.center.z,
                },
                radius:
                  points._webgpuCache.colorCommand.boundingVolume.radius,
              }
            : null,
          frameCommandOwnerCount: scene._frameState.commandList.filter(
            (command) => command?.owner === points,
          ).length,
        },
        phases,
      };
    }, altitude);
    results.push(result);

    // Read-the-PNG evidence (CLAUDE.md Principle 8): capture the composited
    // canvas for this altitude with the plane active (normal path) and with
    // the debugSkipDepthPlane diagnostic, so the scene-side occlusion state
    // is visually inspectable alongside the GPU-readback assertions.
    const screenshotDirectory = resolve(toolDirectory, "output", "performance");
    await mkdir(screenshotDirectory, { recursive: true });
    const renderSettled = async (diagnosticSkip) => {
      await page.evaluate(async (skip) => {
        const { viewer, scene } = globalThis.__depthPlaneHorizon;
        scene.debugSkipDepthPlane = skip;
        for (let i = 0; i < 4; i++) {
          scene.render(viewer.clock.currentTime);
          await new Promise((resolveFrame) =>
            requestAnimationFrame(resolveFrame),
          );
        }
      }, diagnosticSkip);
    };
    await renderSettled(false);
    await page.screenshot({
      path: resolve(
        screenshotDirectory,
        `campaign9-c9-02b-horizon-${altitude.label}-plane-on.png`,
      ),
    });
    await renderSettled(true);
    await page.screenshot({
      path: resolve(
        screenshotDirectory,
        `campaign9-c9-02b-horizon-${altitude.label}-plane-off.png`,
      ),
    });
    await renderSettled(false);
  }
} catch (error) {
  fatalError = error instanceof Error ? error.stack || error.message : String(error);
}

const gate = await collectGateErrors(page).catch(() => ({
  errors: [],
  deviceLost: null,
  armedDevices: 0,
}));
const failures = [];
if (fatalError) failures.push(`fatal probe error: ${fatalError}`);
if (setup?.actualRenderer !== "webgpu") {
  failures.push(`expected webgpu renderer, got ${setup?.actualRenderer}`);
}
if (setup?.terrainProvider !== "EllipsoidTerrainProvider") {
  failures.push(`expected deterministic ellipsoid terrain, got ${setup?.terrainProvider}`);
}
if (armed.found < 1 || gate.armedDevices < 1) {
  failures.push("WebGPU error gate did not arm a live device");
}
if (results.length !== altitudes.length) {
  failures.push(`expected ${altitudes.length} altitude results, got ${results.length}`);
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
for (const result of results) validateAltitude(result, failures);

const report = {
  schemaVersion: 1,
  kind: "webgpu-depth-plane-horizon-scene-and-pick-oracle",
  generatedAt: new Date().toISOString(),
  runtimeBundle: await runtimeBundleIdentity(),
  browserVersion: browser.version(),
  viewerUrl: url.href,
  viewport,
  setup,
  armed,
  altitudes: results,
  gate,
  gpuConsoleErrors,
  pageErrors,
  externalRequests,
  fatalError,
  failures,
  result: failures.length ? "fail" : "pass",
  diagnosis: {
    expectedContract:
      "With log depth active, the depth plane must preserve the front-side control and reject the beyond-horizon marker identically in scene color and pick depth.",
    observedByAltitude: results.map((altitude) => ({
      label: altitude.label,
      heightMeters: altitude.heightMeters,
      frontRayOccluded: altitude.geometry.frontLineOfSightOccluded,
      backRayOccluded: altitude.geometry.backLineOfSightOccluded,
      normalSceneFrontLime:
        altitude.phases.normal.scenePixels.front.limeLike,
      normalSceneBackMagenta:
        altitude.phases.normal.scenePixels.back.magentaLike,
      diagnosticSkipSceneBackMagenta:
        altitude.phases.diagnosticSkip.scenePixels.back.magentaLike,
      normalFrontPickIds: altitude.phases.normal.frontPickIds,
      normalBackPickIds: altitude.phases.normal.backPickIds,
      diagnosticSkipFrontPickIds:
        altitude.phases.diagnosticSkip.frontPickIds,
      diagnosticSkipBackPickIds: altitude.phases.diagnosticSkip.backPickIds,
      restoredFrontPickIds: altitude.phases.restored.frontPickIds,
      restoredBackPickIds: altitude.phases.restored.backPickIds,
    })),
    currentSourceContractFindings: [
      "WebGPUContext.updateAndClearFramebuffers recomputes environmentState.useDepthPlane without Scene.debugSkipDepthPlane, overwriting Scene.updateEnvironment's debug result; this oracle bridges only that diagnostic seam in-page.",
      "PointPrimitivePick.wgsl has no LOG_DEPTH varying or @builtin(frag_depth) output even though computePointDefinesForFrame sets ShaderDefine.LOG_DEPTH, so pick compares hyperbolic point depth against logarithmic depth-plane depth.",
      "WebGPUDepthPlane.update packs uniformState.currentFrustum for log depth while PointPrimitive color packing deliberately prefers uniformState._logDepthEncodeNearFar, leaving the two scene-depth producers on different encode-frustum sources.",
      "PointPrimitiveCollection's WebGPU feature-renderer branch returns before synchronizing collection._blendOption; an explicitly OPAQUE test collection consequently reports Pass.TRANSLUCENT (9).",
    ],
    campaignStatusRecommendation:
      "Keep C9-02B IN PROGRESS. The uniform-ring mechanics are exercised, but semantic scene/pick horizon correctness is not satisfied at any tested altitude.",
  },
  oracleScope:
    "The normal WebGPU scene/pick path runs with useDepthPlane=true and logarithmic depth. The debug skip is used only for an in-process A/B oracle, then the feature is restored and re-verified. Scene visibility is read directly from the WebGPU scene-color texture; public async picking is an independent assertion.",
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
      altitudes: report.altitudes.map((altitude) => ({
        label: altitude.label,
        heightMeters: altitude.heightMeters,
        geometry: altitude.geometry,
        frustumCount: altitude.frustumCount,
        phases: Object.fromEntries(
          Object.entries(altitude.phases).map(([name, phase]) => [
            name,
            {
              useDepthPlane: phase.useDepthPlane,
              depthPlaneDraws: phase.depthPlaneDraws,
              frontPickIds: phase.frontPickIds,
              backPickIds: phase.backPickIds,
              frontPixels: phase.scenePixels.front,
              backPixels: phase.scenePixels.back,
            },
          ]),
        ),
      })),
      output: outputPath,
    },
    null,
    2,
  ),
);
process.exitCode = report.result === "pass" ? 0 : 1;
