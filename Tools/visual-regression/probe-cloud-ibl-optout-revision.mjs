#!/usr/bin/env node
// C13-38 runtime gate — cloud animation must not refresh dynamic-environment
// resources while the full reflected-cloud march is opted out.
//
// The manager records `lastCloudRevision` only after the expensive cube fill,
// IBL prefilter, and SH projection branch runs. This probe holds every other
// refresh input stable, advances only the publisher-owned cloud revision, and
// verifies:
//   1. opt-out leaves the new revision unconsumed;
//   2. opt-in consumes the newest revision and enables the full march;
//   3. ON -> OFF performs one teardown refresh; and
//   4. later opt-out revisions again remain unconsumed until the next opt-in.
//
// Usage: node Tools/visual-regression/probe-cloud-ibl-optout-revision.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUTPUT_DIR =
  "Tools/visual-regression/output/cloud-ibl-optout-revision";
const SOURCE_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts";
const BUILD_FILE = "Build/CesiumUnminified/index.js";
const SOURCE_MAP_FILE = "Build/CesiumUnminified/index.js.map";

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sourceBuildProvenance() {
  const sourceMapBytes = readFileSync(SOURCE_MAP_FILE);
  const sourceMap = JSON.parse(sourceMapBytes.toString("utf8"));
  const normalizedSource = SOURCE_FILE.replaceAll("\\", "/");
  const sourceIndex = sourceMap.sources.findIndex((entry) =>
    entry.replaceAll("\\", "/").endsWith(normalizedSource),
  );
  if (
    sourceIndex < 0 ||
    typeof sourceMap.sourcesContent?.[sourceIndex] !== "string"
  ) {
    throw new Error(
      `missing embedded source for ${SOURCE_FILE} in ${SOURCE_MAP_FILE}`,
    );
  }
  const source = sha256(SOURCE_FILE);
  const embedded = createHash("sha256")
    .update(sourceMap.sourcesContent[sourceIndex])
    .digest("hex");
  return {
    source,
    embedded,
    sourceBuildExact: source === embedded,
    build: sha256(BUILD_FILE),
    sourceMap: createHash("sha256").update(sourceMapBytes).digest("hex"),
  };
}

const watchdog = setTimeout(() => {
  console.error(
    "[cloud-ibl-optout-revision] WATCHDOG FIRED (120s) — forcing exit",
  );
  process.exit(2);
}, 120_000);
watchdog.unref?.();

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const provenanceBefore = sourceBuildProvenance();
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  let result;
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      {
        waitUntil: "networkidle",
        timeout: 90_000,
      },
    );
    await page.waitForFunction(() => !!window.viewer, undefined, {
      timeout: 90_000,
    });

    result = await page.evaluate(async () => {
      const Cesium = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const context = scene.context;
      const device = context.device;
      const collection = scene.globe.defaultCloudCollection;
      const volumetric = collection.volumetric;

      // Own the render loop so cloud revisions cannot advance concurrently
      // while the manager-only scheduling checks are in flight.
      viewer.useDefaultRenderLoop = false;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      viewer.clock.shouldAnimate = false;
      const frameTime = Cesium.JulianDate.fromIso8601(
        "2026-07-23T18:00:00Z",
      );
      viewer.clock.currentTime = frameTime;
      collection.enableVolumetric = true;
      volumetric.cloudContributesIBL = true;
      volumetric.cloudCoverage = 0.78;
      volumetric.cloudDensity = 0.62;
      volumetric.cloudVolumetricQuality = "medium";
      scene.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-105.0, 40.0, 1_000_000.0),
        orientation: {
          heading: 0.0,
          pitch: -Cesium.Math.PI_OVER_TWO,
          roll: 0.0,
        },
      });

      device.pushErrorScope("validation");
      let warmupFrames = 0;
      for (; warmupFrames < 180; warmupFrames++) {
        scene.render(frameTime);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const cloud = context._cloudCache;
        if (
          cloud?.noise?.shapeSampleView &&
          cloud?.noise?.detailSampleView &&
          cloud.iblCoverage > 0
        ) {
          break;
        }
      }

      if (!context._options) {
        context._options = {};
      }
      context._options.webgpu = Object.assign({}, context._options.webgpu, {
        cloudsInReflections: false,
        envMapTemporalAccumulation: false,
        sceneCaptureReflections: false,
      });

      // A small cube is sufficient for this scheduling/lifecycle gate and keeps
      // the opt-in proof fast. The production branch and resource graph are the
      // same as for the default 256px cube.
      const manager = new Cesium.DynamicEnvironmentMapManager({
        mipmapLevels: 3,
      });
      manager._cubemapSize = 32;
      manager.enabled = true;
      manager.shouldUpdate = true;
      manager._position = Cesium.Cartesian3.fromDegrees(-105.0, 40.0, 0.0);

      manager.update(scene._frameState);
      await device.queue.onSubmittedWorkDone();

      const cloud = context._cloudCache;
      const cache = manager._webgpuCache;
      const baseline = {
        liveRevision: cloud.iblRevision,
        consumedRevision: cache.lastCloudRevision,
        lastUsedCloudMarch: cache.lastUsedCloudMarch,
        needsUpdate: cache.needsUpdate,
        coverage: cloud.iblCoverage,
      };

      // Only the publisher revision changes. No render occurs here, so sun,
      // coverage, LUT availability, camera, and scene-capture cadence are fixed.
      cloud.iblRevision = baseline.liveRevision + 1;
      for (let i = 0; i < 4; i++) {
        manager.update(scene._frameState);
      }
      await device.queue.onSubmittedWorkDone();
      const animatedWhileOff = {
        liveRevision: cloud.iblRevision,
        consumedRevision: cache.lastCloudRevision,
        lastUsedCloudMarch: cache.lastUsedCloudMarch,
      };

      context._options.webgpu.cloudsInReflections = true;
      manager.update(scene._frameState);
      await device.queue.onSubmittedWorkDone();
      const firstOptIn = {
        liveRevision: cloud.iblRevision,
        consumedRevision: cache.lastCloudRevision,
        lastUsedCloudMarch: cache.lastUsedCloudMarch,
      };

      context._options.webgpu.cloudsInReflections = false;
      manager.update(scene._frameState);
      await device.queue.onSubmittedWorkDone();
      const teardown = {
        liveRevision: cloud.iblRevision,
        consumedRevision: cache.lastCloudRevision,
        lastUsedCloudMarch: cache.lastUsedCloudMarch,
      };

      cloud.iblRevision = teardown.liveRevision + 1;
      manager.update(scene._frameState);
      await device.queue.onSubmittedWorkDone();
      const postTeardownOff = {
        liveRevision: cloud.iblRevision,
        consumedRevision: cache.lastCloudRevision,
        lastUsedCloudMarch: cache.lastUsedCloudMarch,
      };

      context._options.webgpu.cloudsInReflections = true;
      manager.update(scene._frameState);
      await device.queue.onSubmittedWorkDone();
      const secondOptIn = {
        liveRevision: cloud.iblRevision,
        consumedRevision: cache.lastCloudRevision,
        lastUsedCloudMarch: cache.lastUsedCloudMarch,
      };

      const validationError = await device.popErrorScope();
      const deviceLost = await Promise.race([
        device.lost.then((info) => info.message || info.reason || "device lost"),
        new Promise((resolve) => setTimeout(() => resolve(null), 25)),
      ]);

      manager.destroy();
      return {
        warmupFrames,
        noiseReady: !!(
          cloud?.noise?.shapeSampleView && cloud?.noise?.detailSampleView
        ),
        baseline,
        animatedWhileOff,
        firstOptIn,
        teardown,
        postTeardownOff,
        secondOptIn,
        validationError: validationError?.message ?? null,
        deviceLost,
      };
    });
  } finally {
    await browser.close();
  }

  const provenanceAfter = sourceBuildProvenance();
  const checks = {
    noiseReady: result.noiseReady,
    initialOptOutSettled:
      result.baseline.liveRevision === result.baseline.consumedRevision &&
      result.baseline.lastUsedCloudMarch === false &&
      result.baseline.needsUpdate === false &&
      result.baseline.coverage > 0,
    animatedOptOutRevisionUnconsumed:
      result.animatedWhileOff.liveRevision !==
        result.animatedWhileOff.consumedRevision &&
      result.animatedWhileOff.consumedRevision ===
        result.baseline.consumedRevision &&
      result.animatedWhileOff.lastUsedCloudMarch === false,
    firstOptInConsumesLatest:
      result.firstOptIn.consumedRevision === result.firstOptIn.liveRevision &&
      result.firstOptIn.lastUsedCloudMarch === true,
    optOutTeardownRefreshesOnce:
      result.teardown.consumedRevision === result.teardown.liveRevision &&
      result.teardown.lastUsedCloudMarch === false,
    postTeardownRevisionUnconsumed:
      result.postTeardownOff.liveRevision !==
        result.postTeardownOff.consumedRevision &&
      result.postTeardownOff.consumedRevision ===
        result.teardown.consumedRevision &&
      result.postTeardownOff.lastUsedCloudMarch === false,
    secondOptInConsumesLatest:
      result.secondOptIn.consumedRevision ===
        result.secondOptIn.liveRevision &&
      result.secondOptIn.lastUsedCloudMarch === true,
    gpuValidationClean: result.validationError === null,
    deviceStable: result.deviceLost === null,
    consoleClean: errors.length === 0,
    sourceBuildExact:
      provenanceBefore.sourceBuildExact &&
      provenanceAfter.sourceBuildExact,
    sourceStable: provenanceBefore.source === provenanceAfter.source,
    buildStable:
      provenanceBefore.build === provenanceAfter.build &&
      provenanceBefore.sourceMap === provenanceAfter.sourceMap,
  };
  const passed = Object.values(checks).every(Boolean);
  const manifest = {
    probe: "C13-38 cloud IBL opt-out revision gate",
    base: BASE,
    generatedAt: new Date().toISOString(),
    provenance: {
      start: provenanceBefore,
      end: provenanceAfter,
    },
    result,
    checks,
    errors,
    passed,
  };
  const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify(manifest, null, 2));
  console.log(
    `\n${passed ? "PASS" : "FAIL"} — C13-38 cloud IBL opt-out revision gate`,
  );
  console.log(`manifest: ${manifestPath}`);
  clearTimeout(watchdog);
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  clearTimeout(watchdog);
  console.error(error);
  process.exitCode = 1;
});
