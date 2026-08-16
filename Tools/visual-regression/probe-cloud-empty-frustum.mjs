#!/usr/bin/env node
/**
 * Campaign 13 empty-frustum environmental scheduling acceptance probe.
 * @purpose C13 acceptance: zero-frustum frames still schedule cloud/post/env work when demanded, while the true-empty fast path still skips it all
 * @status ACTIVE
 *
 * Reproduces the command-empty view that previously skipped procedural clouds:
 * an offline globe camera below the cloud deck, looking upward into a black sky
 * with sky/atmosphere/celestial effects disabled. The probe proves three bounded
 * control-flow contracts on the same camera and authored JulianDate:
 *
 *   1. Managed volumetric clouds ON: numFrustums remains zero while the WebGPU
 *      scene renderer still initializes resources, runs post-processing and
 *      environmental effects, calls PROCEDURAL_CLOUDS, marks canvas content,
 *      and produces visible cloud pixels.
 *   2. Managed volumetric clouds OFF plus a real user-owned VOLUMETRIC
 *      CloudCollection: its per-frame context request is the sole demand source
 *      and reaches the same procedural/environment/canvas work.
 *   3. Both cloud sources OFF: numFrustums remains zero and the existing
 *      true-empty fast path skips all of that work.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-empty-frustum.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

// ── HARD watchdog: force-exit if anything hangs (machine safety) ──
// The browser lifetime is already try/finally-guarded below, but a GPU hang
// inside an await could still stall the process; this unref'd force-exit timer
// guarantees headless Edge (--enable-unsafe-webgpu) can never stay alive forever.
const HARD_LIMIT_MS = 300000; // 300s
const watchdog = setTimeout(() => {
  console.error("[cloud-empty-frustum] WATCHDOG FIRED (300s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
const OUT_DIR = "Tools/visual-regression/output/cloud-empty-frustum";
const JSON_PATH = path.join(OUT_DIR, "cloud-empty-frustum-truth.json");
const ACTIVE_PNG_PATH = path.join(OUT_DIR, "cloud-empty-frustum-active.png");
const USER_OWNED_PNG_PATH = path.join(
  OUT_DIR,
  "cloud-empty-frustum-user-owned.png",
);
const DISABLED_PNG_PATH = path.join(
  OUT_DIR,
  "cloud-empty-frustum-disabled.png",
);
const WIDTH = 1024;
const HEIGHT = 768;
const MEASURED_FRAMES = 8;

function command(name, args) {
  try {
    return execFileSync(name, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function imageStats(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let luminanceSum = 0;
  let cloudCells = 0;
  let nonBlackPixels = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const luminance =
      0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    luminanceSum += luminance;
    if (luminance > 150) {
      cloudCells++;
    }
    if (luminance > 1) {
      nonBlackPixels++;
    }
  }
  const pixelCount = info.width * info.height;
  return {
    width: info.width,
    height: info.height,
    meanLuminance: +(luminanceSum / pixelCount).toFixed(4),
    cloudCells,
    nonBlackPixels,
    sha256: createHash("sha256").update(png).digest("hex"),
  };
}

async function imageDelta(activePng, disabledPng) {
  const [active, disabled] = await Promise.all([
    sharp(activePng).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(disabledPng)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  if (
    active.info.width !== disabled.info.width ||
    active.info.height !== disabled.info.height ||
    active.info.channels !== disabled.info.channels
  ) {
    throw new Error("active and disabled cloud captures have different shapes");
  }

  let changedPixels = 0;
  let totalAbsRgbDelta = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < active.data.length; i += active.info.channels) {
    const dr = Math.abs(active.data[i] - disabled.data[i]);
    const dg = Math.abs(active.data[i + 1] - disabled.data[i + 1]);
    const db = Math.abs(active.data[i + 2] - disabled.data[i + 2]);
    totalAbsRgbDelta += dr + dg + db;
    maxChannelDelta = Math.max(maxChannelDelta, dr, dg, db);
    if (dr + dg + db > 18) {
      changedPixels++;
    }
  }
  const pixelCount = active.info.width * active.info.height;
  return {
    changedPixels,
    changedFraction: +(changedPixels / pixelCount).toFixed(6),
    meanAbsRgbDelta: +(totalAbsRgbDelta / (pixelCount * 3)).toFixed(4),
    maxChannelDelta,
  };
}

async function setupScene(page) {
  return page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = globalThis.viewer;
    const scene = viewer.scene;
    const context = scene.context;
    const frameTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");

    viewer.useDefaultRenderLoop = false;
    viewer.clock.shouldAnimate = false;
    viewer.clock.currentTime = frameTime;
    scene.requestRenderMode = false;
    scene.globe.show = true;
    scene.globe.enableLighting = false;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    if (scene.sun) {
      scene.sun.show = false;
    }
    if (scene.moon) {
      scene.moon.show = false;
    }
    scene.backgroundColor = C.Color.BLACK;

    const cameraView = {
      destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 800.0),
      orientation: {
        heading: C.Math.toRadians(90.0),
        pitch: C.Math.toRadians(25.0),
        roll: 0.0,
      },
    };
    viewer.camera.setView(cameraView);

    const requestedVolumetric = {
      cloudCoverage: 0.35,
      cloudWeatherMap: false,
      cloudDensity: 0.7,
      cloudQuality: 128,
      cloudWindSpeed: 0,
    };
    const configTruth = globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: requestedVolumetric,
    });
    const readiness = await globalThis.__cloudProbe.awaitProceduralReady({
      featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
      frameTime,
    });
    const cloudCollectionFeatureRenderer =
      await context.getFeatureRendererAsync(
        C.FeatureRendererKey.CLOUD_COLLECTION,
      );
    if (!cloudCollectionFeatureRenderer) {
      throw new Error("user CloudCollection feature renderer is unavailable");
    }
    // The shared readiness helper restores its entry pose; author the exact
    // acceptance camera again so the evidence does not depend on warm-up motion.
    viewer.camera.setView(cameraView);

    const sceneRenderer = scene._alternateSceneRenderer;
    const proceduralRenderer = context.getFeatureRenderer(
      C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    );
    if (!sceneRenderer || !proceduralRenderer?.execute) {
      throw new Error(
        "required WebGPU scene/procedural renderer is unavailable",
      );
    }

    const requiredHooks = [
      [sceneRenderer, "executeCommands"],
      [sceneRenderer, "_ensureResources"],
      [sceneRenderer, "_runPostProcessing"],
      [sceneRenderer, "_executeEnvironmentalEffects"],
      [proceduralRenderer, "execute"],
      [context, "markCanvasContentWritten"],
      [context, "requestVolumetricClouds"],
    ];
    for (const [owner, name] of requiredHooks) {
      if (typeof owner[name] !== "function") {
        throw new Error(`required empty-frustum trace hook ${name} is missing`);
      }
    }

    const state = {
      C,
      viewer,
      scene,
      context,
      frameTime,
      cameraView,
      requestedVolumetric,
      sceneRenderer,
      proceduralRenderer,
      originals: [],
      counts: {},
      lastCloudConfig: null,
      lastVolumetricRequest: null,
      userCollection: null,
    };
    const wrap = (owner, name, counter, observe) => {
      const original = owner[name];
      state.originals.push({ owner, name, original });
      owner[name] = function (...args) {
        state.counts[counter] = (state.counts[counter] ?? 0) + 1;
        observe?.(args);
        return Reflect.apply(original, this, args);
      };
    };

    wrap(sceneRenderer, "executeCommands", "executeCommands", () => {
      if (context.hasVolumetricCloudRequest === true) {
        state.counts.volumetricDemandAtExecute =
          (state.counts.volumetricDemandAtExecute ?? 0) + 1;
      }
    });
    wrap(sceneRenderer, "_ensureResources", "ensureResources");
    wrap(sceneRenderer, "_runPostProcessing", "postProcess");
    wrap(sceneRenderer, "_executeEnvironmentalEffects", "environmentalEffects");
    wrap(proceduralRenderer, "execute", "proceduralClouds", (args) => {
      const cloudConfig = args[5];
      state.lastCloudConfig = cloudConfig
        ? {
            enabled: cloudConfig.enabled,
            cloudCoverage: cloudConfig.cloudCoverage,
            cloudDensity: cloudConfig.cloudDensity,
            cloudQuality: cloudConfig.cloudQuality,
            cloudWeatherMap: cloudConfig.cloudWeatherMap,
          }
        : null;
    });
    wrap(context, "markCanvasContentWritten", "canvasContentMarks");
    wrap(context, "requestVolumetricClouds", "volumetricRequests", (args) => {
      const request = args[0];
      state.lastVolumetricRequest = request
        ? {
            enabled: request.enabled,
            cloudCoverage: request.cloudCoverage,
            cloudDensity: request.cloudDensity,
            cloudQuality: request.cloudQuality,
            cloudWeatherMap: request.cloudWeatherMap,
          }
        : null;
    });

    globalThis.__cloudEmptyFrustum = state;
    return {
      configTruth,
      readiness,
      cloudCollectionRendererReady: true,
      adapterInfo: context.adapter?.info
        ? {
            vendor: context.adapter.info.vendor || "",
            architecture: context.adapter.info.architecture || "",
            device: context.adapter.info.device || "",
            description: context.adapter.info.description || "",
          }
        : null,
      effectiveTimeIso: C.JulianDate.toIso8601(frameTime),
      camera: {
        longitude: -95,
        latitude: 39,
        height: 800,
        headingDegrees: 90,
        pitchDegrees: 25,
      },
    };
  });
}

async function awaitStableEmptyFrustums(page) {
  return page.evaluate(async () => {
    const state = globalThis.__cloudEmptyFrustum;
    const { scene, context, frameTime } = state;
    let consecutiveZero = 0;
    const samples = [];
    for (let frame = 0; frame < 240; frame++) {
      scene.render(frameTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const numFrustums = scene._view.frustumCommandsList.length;
      samples.push(numFrustums);
      consecutiveZero = numFrustums === 0 ? consecutiveZero + 1 : 0;
      if (consecutiveZero >= 4) {
        await context.device?.queue?.onSubmittedWorkDone?.();
        return {
          reached: true,
          waitedFrames: frame + 1,
          consecutiveZero,
          tail: samples.slice(-12),
        };
      }
    }
    return {
      reached: false,
      waitedFrames: samples.length,
      consecutiveZero,
      tail: samples.slice(-12),
    };
  });
}

async function measurePhase(page, mode) {
  return page.evaluate(
    async ({ mode, frameCount }) => {
      const state = globalThis.__cloudEmptyFrustum;
      const { C, scene, context, frameTime, requestedVolumetric } = state;
      const managedCollection = scene.globe.defaultCloudCollection;

      if (state.userCollection) {
        scene.primitives.remove(state.userCollection);
        state.userCollection = null;
      }
      managedCollection.enableVolumetric = mode === "managed";
      if (mode === "user-owned") {
        const userCollection = new C.CloudCollection({
          enableVolumetric: true,
        });
        for (const [key, value] of Object.entries(requestedVolumetric)) {
          userCollection.volumetric[key] = value;
        }
        state.userCollection = scene.primitives.add(userCollection);
      }

      state.counts = {};
      state.lastCloudConfig = null;
      state.lastVolumetricRequest = null;

      const frameNumberBefore = scene._frameState.frameNumber;
      const realizationBefore = globalThis.__cloudProbe.proceduralRealization();
      const numFrustums = [];
      for (let frame = 0; frame < frameCount; frame++) {
        scene.requestRender();
        scene.render(frameTime);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        numFrustums.push(scene._view.frustumCommandsList.length);
      }
      await context.device?.queue?.onSubmittedWorkDone?.();
      const realization = globalThis.__cloudProbe.proceduralRealization();
      const userCollection = state.userCollection;

      return {
        mode,
        measuredFrames: frameCount,
        frameNumberBefore,
        frameNumberAfter: scene._frameState.frameNumber,
        numFrustums,
        allFrustumsEmpty: numFrustums.every((count) => count === 0),
        counts: {
          executeCommands: state.counts.executeCommands ?? 0,
          ensureResources: state.counts.ensureResources ?? 0,
          postProcess: state.counts.postProcess ?? 0,
          environmentalEffects: state.counts.environmentalEffects ?? 0,
          proceduralClouds: state.counts.proceduralClouds ?? 0,
          canvasContentMarks: state.counts.canvasContentMarks ?? 0,
          volumetricRequests: state.counts.volumetricRequests ?? 0,
          volumetricDemandAtExecute:
            state.counts.volumetricDemandAtExecute ?? 0,
        },
        lastCloudConfig: state.lastCloudConfig,
        lastVolumetricRequest: state.lastVolumetricRequest,
        managedCollection: {
          renderMode: managedCollection.renderMode,
          volumetricEnabled: managedCollection.volumetric.enabled,
          cloudQuality: managedCollection.volumetric.cloudQuality,
        },
        userCollection: userCollection
          ? {
              present: true,
              show: userCollection.show,
              renderMode: userCollection.renderMode,
              volumetricEnabled: userCollection.volumetric.enabled,
              cloudQuality: userCollection.volumetric.cloudQuality,
            }
          : { present: false },
        realizationBefore,
        realization,
        cacheFrameDelta:
          realization.frameCounter - realizationBefore.frameCounter,
      };
    },
    { mode, frameCount: MEASURED_FRAMES },
  );
}

async function restoreHooks(page) {
  await page.evaluate(() => {
    const state = globalThis.__cloudEmptyFrustum;
    if (!state) {
      return;
    }
    for (const { owner, name, original } of state.originals) {
      owner[name] = original;
    }
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runtimeBundle = fs.readFileSync("Build/CesiumUnminified/Cesium.js");
  const source = {
    commit: command("git", ["rev-parse", "HEAD"]),
    dirty: Boolean(command("git", ["status", "--porcelain"])),
    runtimeBundle: {
      path: "Build/CesiumUnminified/Cesium.js",
      byteLength: runtimeBundle.byteLength,
      sha256: createHash("sha256").update(runtimeBundle).digest("hex"),
    },
  };

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const browserVersion = browser.version();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
  });
  const pageErrors = [];
  const gpuConsoleErrors = attachConsoleErrorGate(page);
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(`pageerror: ${error.message}`);
  });

  let setup;
  let emptyFrustumReadiness;
  let active;
  let userOwned;
  let disabled;
  let activePng;
  let userOwnedPng;
  let disabledPng;
  let gpuGate;
  let armState;
  try {
    await page.addInitScript(errorGateInit);
    await installCloudProbeHarnessOnPage(page);
    await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForFunction(() => !!globalThis.viewer, { timeout: 90_000 });
    armState = await armWebGPUDevices(page);
    await page.addStyleTag({
      content: `
        #rendererToolbar,
        .cesium-viewer-toolbar,
        .cesium-viewer-animationContainer,
        .cesium-viewer-timelineContainer,
        .cesium-viewer-fullscreenContainer,
        .cesium-viewer-bottom,
        .cesium-navigation-help {
          display: none !important;
        }
      `,
    });

    setup = await setupScene(page);
    emptyFrustumReadiness = await awaitStableEmptyFrustums(page);
    active = await measurePhase(page, "managed");
    activePng = await page
      .locator(".cesium-widget canvas")
      .first()
      .screenshot();
    fs.writeFileSync(ACTIVE_PNG_PATH, activePng);

    userOwned = await measurePhase(page, "user-owned");
    userOwnedPng = await page
      .locator(".cesium-widget canvas")
      .first()
      .screenshot();
    fs.writeFileSync(USER_OWNED_PNG_PATH, userOwnedPng);

    disabled = await measurePhase(page, "disabled");
    disabledPng = await page
      .locator(".cesium-widget canvas")
      .first()
      .screenshot();
    fs.writeFileSync(DISABLED_PNG_PATH, disabledPng);
    gpuGate = await collectGateErrors(page);
    await restoreHooks(page);
  } finally {
    await browser.close();
  }

  const [activeImage, userOwnedImage, disabledImage, delta, userOwnedDelta] =
    await Promise.all([
      imageStats(activePng),
      imageStats(userOwnedPng),
      imageStats(disabledPng),
      imageDelta(activePng, disabledPng),
      imageDelta(userOwnedPng, disabledPng),
    ]);
  const errors = [
    ...pageErrors,
    ...gpuConsoleErrors,
    ...(gpuGate?.errors ?? []),
    ...(gpuGate?.deviceLost ? [gpuGate.deviceLost] : []),
    ...(armState?.found < 1 ? ["WebGPU error gate did not find a device"] : []),
  ].filter(
    (error) =>
      !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(error),
  );
  const uniqueErrors = [...new Set(errors)];

  const checks = {
    webgpuConfigured:
      setup.configTruth.ok === true &&
      setup.configTruth.rendererType === "webgpu",
    proceduralRendererReady:
      setup.readiness.ok === true && setup.readiness.executeCalls > 0,
    cloudCollectionRendererReady: setup.cloudCollectionRendererReady === true,
    stableEmptyFrustumsReached: emptyFrustumReadiness.reached === true,
    activeFrustumsStayEmpty: active.allFrustumsEmpty === true,
    activeSceneRendererReached:
      active.counts.executeCommands === active.measuredFrames,
    activeResourcesReached:
      active.counts.ensureResources === active.measuredFrames,
    activePostProcessReached:
      active.counts.postProcess === active.measuredFrames,
    activeEnvironmentReached:
      active.counts.environmentalEffects === active.measuredFrames,
    activeProceduralReached:
      active.counts.proceduralClouds === active.measuredFrames,
    activeCanvasMarked:
      active.counts.canvasContentMarks >= active.measuredFrames,
    activeManagedConfigReachedRenderer:
      active.managedCollection.renderMode === 1 &&
      active.managedCollection.volumetricEnabled === true &&
      active.lastCloudConfig?.enabled === true &&
      active.lastCloudConfig?.cloudQuality === 128,
    activeCacheAdvancedModulo:
      ((active.realization.frameCounter -
        active.realizationBefore.frameCounter) &
        15) ===
      (active.measuredFrames & 15),
    activeCloudPixelsVisible:
      activeImage.cloudCells > 3000 && activeImage.nonBlackPixels > 10000,
    userOwnedFrustumsStayEmpty: userOwned.allFrustumsEmpty === true,
    userOwnedManagedDefaultOff:
      userOwned.managedCollection.renderMode === 0 &&
      userOwned.managedCollection.volumetricEnabled === false,
    userOwnedCollectionActive:
      userOwned.userCollection.present === true &&
      userOwned.userCollection.show === true &&
      userOwned.userCollection.renderMode === 1 &&
      userOwned.userCollection.volumetricEnabled === true,
    userOwnedRequestPublished:
      userOwned.counts.volumetricRequests === userOwned.measuredFrames &&
      userOwned.lastVolumetricRequest?.enabled === true &&
      userOwned.lastVolumetricRequest?.cloudQuality === 128,
    userOwnedRequestDrivesEmptyFrame:
      userOwned.counts.volumetricDemandAtExecute === userOwned.measuredFrames,
    userOwnedSceneRendererReached:
      userOwned.counts.executeCommands === userOwned.measuredFrames,
    userOwnedResourcesReached:
      userOwned.counts.ensureResources === userOwned.measuredFrames,
    userOwnedPostProcessReached:
      userOwned.counts.postProcess === userOwned.measuredFrames,
    userOwnedEnvironmentReached:
      userOwned.counts.environmentalEffects === userOwned.measuredFrames,
    userOwnedProceduralReached:
      userOwned.counts.proceduralClouds === userOwned.measuredFrames,
    userOwnedCanvasMarked:
      userOwned.counts.canvasContentMarks >= userOwned.measuredFrames,
    userOwnedConfigReachedRenderer:
      userOwned.lastCloudConfig?.enabled === true &&
      userOwned.lastCloudConfig?.cloudCoverage === 0.35 &&
      userOwned.lastCloudConfig?.cloudDensity === 0.7 &&
      userOwned.lastCloudConfig?.cloudQuality === 128,
    userOwnedCacheAdvancedModulo:
      userOwned.realization.initialized === true &&
      userOwned.realization.pipelineReady === true &&
      userOwned.realization.maxSteps === 128 &&
      ((userOwned.realization.frameCounter -
        userOwned.realizationBefore.frameCounter) &
        15) ===
        (userOwned.measuredFrames & 15),
    userOwnedCloudPixelsVisible:
      userOwnedImage.cloudCells > 3000 && userOwnedImage.nonBlackPixels > 10000,
    disabledFrustumsStayEmpty: disabled.allFrustumsEmpty === true,
    disabledSceneRendererReached:
      disabled.counts.executeCommands === disabled.measuredFrames,
    disabledResourcesSkipped: disabled.counts.ensureResources === 0,
    disabledPostProcessSkipped: disabled.counts.postProcess === 0,
    disabledEnvironmentSkipped: disabled.counts.environmentalEffects === 0,
    disabledProceduralSkipped: disabled.counts.proceduralClouds === 0,
    disabledCanvasMarkSkipped: disabled.counts.canvasContentMarks === 0,
    disabledRequestsSkipped:
      disabled.counts.volumetricRequests === 0 &&
      disabled.counts.volumetricDemandAtExecute === 0,
    disabledUserCollectionRemoved: disabled.userCollection.present === false,
    disabledCacheUnchanged: disabled.cacheFrameDelta === 0,
    disabledManagedDeckOff:
      disabled.managedCollection.renderMode === 0 &&
      disabled.managedCollection.volumetricEnabled === false,
    activeDiffersFromDisabled:
      delta.changedPixels > 3000 &&
      activeImage.cloudCells > disabledImage.cloudCells + 3000,
    userOwnedDiffersFromDisabled:
      userOwnedDelta.changedPixels > 3000 &&
      userOwnedImage.cloudCells > disabledImage.cloudCells + 3000,
    gpuGateClean: uniqueErrors.length === 0,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const manifest = {
    probeVersion: "c13-empty-frustum-02",
    url: URL,
    browserVersion,
    source,
    setup,
    emptyFrustumReadiness,
    active: { ...active, image: activeImage },
    userOwned: { ...userOwned, image: userOwnedImage },
    disabled: { ...disabled, image: disabledImage },
    delta,
    userOwnedDelta,
    gpuGate: { ...gpuGate, armState },
    errors: uniqueErrors,
    checks,
    failedChecks,
    artifacts: {
      manifest: JSON_PATH,
      activePng: ACTIVE_PNG_PATH,
      userOwnedPng: USER_OWNED_PNG_PATH,
      disabledPng: DISABLED_PNG_PATH,
    },
    pass: failedChecks.length === 0,
  };
  fs.writeFileSync(JSON_PATH, JSON.stringify(manifest, null, 2));

  console.log(`Manifest: ${JSON_PATH}`);
  console.log(
    `Active: frustums=${active.numFrustums.join(",")} ` +
      `exec/env/cloud/canvas=${active.counts.executeCommands}/` +
      `${active.counts.environmentalEffects}/` +
      `${active.counts.proceduralClouds}/` +
      `${active.counts.canvasContentMarks} ` +
      `cloudCells=${activeImage.cloudCells}`,
  );
  console.log(
    `User-owned: frustums=${userOwned.numFrustums.join(",")} ` +
      `requests/demand=${userOwned.counts.volumetricRequests}/` +
      `${userOwned.counts.volumetricDemandAtExecute} ` +
      `exec/env/cloud/canvas=${userOwned.counts.executeCommands}/` +
      `${userOwned.counts.environmentalEffects}/` +
      `${userOwned.counts.proceduralClouds}/` +
      `${userOwned.counts.canvasContentMarks} ` +
      `cloudCells=${userOwnedImage.cloudCells}`,
  );
  console.log(
    `Disabled: frustums=${disabled.numFrustums.join(",")} ` +
      `exec/env/cloud/canvas=${disabled.counts.executeCommands}/` +
      `${disabled.counts.environmentalEffects}/` +
      `${disabled.counts.proceduralClouds}/` +
      `${disabled.counts.canvasContentMarks}`,
  );
  console.log(
    `Delta: changed=${delta.changedPixels} ` +
      `fraction=${delta.changedFraction} meanAbsRgb=${delta.meanAbsRgbDelta}`,
  );
  console.log(
    `User delta: changed=${userOwnedDelta.changedPixels} ` +
      `fraction=${userOwnedDelta.changedFraction} ` +
      `meanAbsRgb=${userOwnedDelta.meanAbsRgbDelta}`,
  );
  console.log(
    `RESULT: ${manifest.pass ? "GREEN" : "RED"}` +
      (failedChecks.length ? ` — ${failedChecks.join(", ")}` : ""),
  );
  process.exitCode = manifest.pass ? 0 : 1;
}

await main();
