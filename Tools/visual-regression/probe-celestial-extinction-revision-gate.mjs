#!/usr/bin/env node
/**
 * C9-06 celestial-extinction revision-gate acceptance probe.
 *
 * Proves, on the live WebGL and WebGPU paths, that the shared Sun/star
 * extinction work is cached by its exact physical inputs and that the daytime
 * star gate exits before feature-renderer, cache, and draw work. The clock is
 * fixed for every phase except the explicitly labelled time-mutation phase.
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
      "campaign9-c9-06-celestial-extinction-revision-gate-both-2026-07-16.json",
    ),
);
const viewport = { width: 960, height: 540 };

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

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function counterDelta(after, before, name) {
  return after[name] - before[name];
}

function validateBackend(run, failures) {
  const prefix = run.requestedRenderer;
  const p = run.phases;
  if (run.setup.actualRenderer !== run.requestedRenderer) {
    failures.push(
      `${prefix}: expected renderer ${run.requestedRenderer}, got ${run.setup.actualRenderer}`,
    );
  }
  if (!run.setup.featureRendererReady || !run.setup.instrumentationInstalled) {
    failures.push(`${prefix}: STAR_FIELD renderer was not safely instrumented`);
  }
  if (!run.setup.pipelineReady) {
    failures.push(`${prefix}: STAR_FIELD pipeline did not warm before measurement`);
  }
  if (run.pageErrors.length) failures.push(`${prefix}: ${run.pageErrors.length} page errors`);
  if (run.gpuConsoleErrors.length) {
    failures.push(`${prefix}: ${run.gpuConsoleErrors.length} GPU console errors`);
  }
  if (run.gate.errors.length) {
    failures.push(`${prefix}: ${run.gate.errors.length} uncaptured GPU errors`);
  }
  if (run.gate.deviceLost) failures.push(`${prefix}: ${run.gate.deviceLost}`);
  if (run.externalRequests.length) {
    failures.push(`${prefix}: ${run.externalRequests.length} external requests`);
  }
  if (
    prefix === "webgpu" &&
    (run.armed.found < 1 || run.gate.armedDevices < 1)
  ) {
    failures.push(`${prefix}: GPU error gate did not arm the live device`);
  }

  const first = p.stableNightFirst;
  const repeat = p.stableNightRepeat;
  if (
    counterDelta(first.after.sunCache, first.before.sunCache, "computations") !== 1 ||
    counterDelta(first.after.starCache, first.before.starCache, "computations") !== 1
  ) {
    failures.push(`${prefix}/stable-night-first: Sun and star did not each compute exactly once`);
  }
  if (
    counterDelta(repeat.after.sunCache, repeat.before.sunCache, "computations") !== 0 ||
    counterDelta(repeat.after.starCache, repeat.before.starCache, "computations") !== 0 ||
    counterDelta(repeat.after.sunCache, repeat.before.sunCache, "hits") !== 1 ||
    counterDelta(repeat.after.starCache, repeat.before.starCache, "hits") !== 1
  ) {
    failures.push(`${prefix}/stable-night-repeat: exact repeat was not one cache hit per body`);
  }
  if (
    !equal(first.after.sunExtinction, repeat.after.sunExtinction) ||
    !equal(first.after.starZenithTransmittance, repeat.after.starZenithTransmittance) ||
    first.after.pixelFingerprint.sha256 !== repeat.after.pixelFingerprint.sha256
  ) {
    failures.push(`${prefix}/stable-night-repeat: output or pixel fingerprint changed`);
  }
  if (!first.after.draw.starScheduled || first.after.effectiveStarScale <= 0) {
    failures.push(`${prefix}/stable-night-first: night star draw was not scheduled`);
  }

  for (const [label, phase] of [
    ["camera-mutation", p.cameraMutation],
    ["atmosphere-mutation", p.atmosphereMutation],
  ]) {
    if (
      counterDelta(phase.after.sunCache, phase.before.sunCache, "computations") !== 1 ||
      counterDelta(phase.after.starCache, phase.before.starCache, "computations") !== 1
    ) {
      failures.push(`${prefix}/${label}: exact input mutation did not recompute both caches`);
    }
  }
  if (p.atmosphereMutation.mutatedRayleighX === p.atmosphereMutation.originalRayleighX) {
    failures.push(`${prefix}/atmosphere-mutation: in-place scalar did not change`);
  }

  if (!equal(p.atmosphereOff.after.sunExtinction, [1, 1, 1])) {
    failures.push(`${prefix}/atmosphere-off: Sun extinction was not exact ONE`);
  }
  if (p.atmosphereOff.after.starZenithTransmittance !== null) {
    failures.push(`${prefix}/atmosphere-off: star publication was not undefined`);
  }

  const restored = p.atmosphereRestored;
  if (
    counterDelta(restored.after.sunCache, restored.before.sunCache, "computations") !== 1 ||
    counterDelta(restored.after.starCache, restored.before.starCache, "computations") !== 1
  ) {
    failures.push(`${prefix}/atmosphere-restored: enabled values did not recompute after disabled mode`);
  }
  if (
    !equal(restored.after.sunExtinction, first.after.sunExtinction) ||
    !equal(
      restored.after.starZenithTransmittance,
      first.after.starZenithTransmittance,
    ) ||
    restored.after.pixelFingerprint.sha256 !== first.after.pixelFingerprint.sha256
  ) {
    failures.push(`${prefix}/atmosphere-restored: exact values or pixels did not return to baseline`);
  }

  const time = p.timeMutation;
  if (
    counterDelta(time.after.sunCache, time.before.sunCache, "computations") !== 1 ||
    counterDelta(time.after.starCache, time.before.starCache, "computations") !== 0 ||
    counterDelta(time.after.starCache, time.before.starCache, "hits") !== 1
  ) {
    failures.push(`${prefix}/time-mutation: Sun invalidation and independent star hit diverged`);
  }
  if (
    equal(time.before.sunPositionWC, time.after.sunPositionWC) ||
    equal(time.before.temeToPseudoFixed, time.after.temeToPseudoFixed)
  ) {
    failures.push(`${prefix}/time-mutation: celestial body/orientation state did not advance`);
  }
  if (
    time.after.featureRendererUpdateCalls - time.before.featureRendererUpdateCalls !== 1 ||
    !time.after.draw.starScheduled
  ) {
    failures.push(`${prefix}/time-mutation: star orientation/update did not reach its renderer/draw`);
  }

  const day = p.sunFacingDay;
  if (day.after.effectiveStarScale !== 0) {
    failures.push(`${prefix}/sun-facing-day: effective star scale was not exact zero`);
  }
  if (day.after.starZenithTransmittance !== null) {
    failures.push(`${prefix}/sun-facing-day: stale star extinction remained published`);
  }
  if (
    counterDelta(day.after.starCache, day.before.starCache, "computations") !== 0 ||
    counterDelta(day.after.starCache, day.before.starCache, "hits") !== 0 ||
    day.after.featureRendererUpdateCalls !== day.before.featureRendererUpdateCalls ||
    day.after.draw.starScheduled
  ) {
    failures.push(`${prefix}/sun-facing-day: star cache, feature renderer, or draw work was not zero`);
  }

  const finalNight = p.finalNightRestore;
  if (
    finalNight.after.effectiveStarScale <= 0 ||
    finalNight.after.starZenithTransmittance === null ||
    finalNight.after.featureRendererUpdateCalls -
        finalNight.before.featureRendererUpdateCalls !==
      1 ||
    !finalNight.after.draw.starScheduled
  ) {
    failures.push(`${prefix}/final-night: night star publication/render work did not restore`);
  }
  if (
    !equal(finalNight.after.sunExtinction, first.after.sunExtinction) ||
    !equal(
      finalNight.after.starZenithTransmittance,
      first.after.starZenithTransmittance,
    ) ||
    finalNight.after.pixelFingerprint.sha256 !== first.after.pixelFingerprint.sha256
  ) {
    failures.push(`${prefix}/final-night: exact night values or pixels did not restore`);
  }
}

function validateCrossBackend(runs, failures) {
  const webgl = runs.find((run) => run.requestedRenderer === "webgl");
  const webgpu = runs.find((run) => run.requestedRenderer === "webgpu");
  const phaseNames = [
    "stableNightFirst",
    "stableNightRepeat",
    "cameraMutation",
    "atmosphereMutation",
    "atmosphereOff",
    "atmosphereRestored",
    "timeMutation",
    "timeRestoreNight",
    "sunFacingDay",
    "finalNightRestore",
  ];
  for (const phaseName of phaseNames) {
    for (const field of [
      "sunExtinction",
      "starZenithTransmittance",
      "effectiveStarScale",
    ]) {
      const left = webgl.phases[phaseName].after[field];
      const right = webgpu.phases[phaseName].after[field];
      if (!equal(left, right)) {
        failures.push(
          `cross-backend/${phaseName}: shared CPU ${field} differs (${JSON.stringify(left)} vs ${JSON.stringify(right)})`,
        );
      }
    }
  }
}

async function runBackend(browser, renderer) {
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
  url.searchParams.set("renderer", renderer);
  url.searchParams.set("offline", "true");
  await page.goto(url.href, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(
    () => globalThis.viewer?.scene?._frameState?.frameNumber > 0,
    undefined,
    { timeout: 60_000 },
  );
  const armed = await armWebGPUDevices(page);

  const runtime = await page.evaluate(async (requestedRenderer) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = globalThis.viewer;
    const scene = viewer.scene;
    const graphicsContext = scene.context;
    const starField = scene.skyBox?.starField;
    const fixedTime = C.JulianDate.fromIso8601("2026-01-15T04:00:00Z");
    const lowAltitude = 1_000.0;
    const radius = C.Ellipsoid.WGS84.maximumRadius;

    viewer.useDefaultRenderLoop = false;
    scene.requestRenderMode = false;
    scene.taaEnabled = false;
    scene.highDynamicRange = false;
    if (scene.postProcessStages) scene.postProcessStages.enabled = false;
    if (scene.fog) scene.fog.enabled = false;
    if (scene.globe) scene.globe.show = false;
    scene.backgroundColor = C.Color.BLACK;
    scene.sun.show = true;
    scene.skyAtmosphere.show = true;
    if ("useScatteringLut" in scene.skyAtmosphere) {
      scene.skyAtmosphere.useScatteringLut = false;
    }
    if ("multipleScattering" in scene.skyAtmosphere) {
      scene.skyAtmosphere.multipleScattering = false;
    }
    scene.skyBox.show = false;
    starField.show = true;
    starField.intensity = 12.0;
    viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
    viewer.clock.startTime = C.JulianDate.clone(fixedTime);
    viewer.clock.stopTime = C.JulianDate.clone(fixedTime);
    viewer.clock.shouldAnimate = false;
    viewer.clock.multiplier = 0;

    const nextFrame = () =>
      new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    const render = async () => {
      scene.render(viewer.clock.currentTime);
      await nextFrame();
    };
    const vec = (value) =>
      value ? [value.x, value.y, value.z] : null;
    const cache = (value) => ({
      computations: value?.computations ?? null,
      hits: value?.hits ?? null,
      mode: value?._mode ?? null,
    });
    const matrix = (value) => (value ? Array.from(value) : null);
    const pixelFingerprint = async () => {
      const source = scene.canvas;
      const capture = document.createElement("canvas");
      capture.width = source.width;
      capture.height = source.height;
      const twoD = capture.getContext("2d", { willReadFrequently: true });
      twoD.drawImage(source, 0, 0);
      const bytes = twoD.getImageData(0, 0, capture.width, capture.height).data;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      let nonBlackPixels = 0;
      let rgbSum = 0;
      for (let index = 0; index < bytes.length; index += 4) {
        const sum = bytes[index] + bytes[index + 1] + bytes[index + 2];
        rgbSum += sum;
        if (sum !== 0) ++nonBlackPixels;
      }
      return {
        sha256: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        )
          .join("")
          .toUpperCase(),
        width: capture.width,
        height: capture.height,
        nonBlackPixels,
        rgbSum,
      };
    };

    // Establish the fixed-time ephemeris before deriving surface locations.
    await render();
    const fixedSunDirection = C.Cartesian3.normalize(
      graphicsContext.uniformState.sunDirectionWC,
      new C.Cartesian3(),
    );
    const nightUp = C.Cartesian3.negate(
      fixedSunDirection,
      new C.Cartesian3(),
    );
    const axis =
      Math.abs(nightUp.z) < 0.9 ? C.Cartesian3.UNIT_Z : C.Cartesian3.UNIT_X;
    const tangent = C.Cartesian3.normalize(
      C.Cartesian3.cross(axis, nightUp, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const cameraUp = C.Cartesian3.normalize(
      C.Cartesian3.cross(nightUp, tangent, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const nightPosition = C.Cartesian3.multiplyByScalar(
      nightUp,
      radius + lowAltitude,
      new C.Cartesian3(),
    );
    const warmUp = C.Cartesian3.normalize(
      C.Cartesian3.add(
        nightUp,
        C.Cartesian3.multiplyByScalar(tangent, 0.02, new C.Cartesian3()),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const warmPosition = C.Cartesian3.multiplyByScalar(
      warmUp,
      radius + lowAltitude,
      new C.Cartesian3(),
    );
    const setCamera = (position, direction, up) => {
      scene.camera.setView({
        destination: position,
        orientation: { direction, up },
      });
    };

    // Resolve and warm the renderer/pipeline at a different physical cache key.
    const starRenderer = await graphicsContext.getFeatureRendererAsync(
      C.FeatureRendererKey.STAR_FIELD,
    );
    setCamera(warmPosition, warmUp, cameraUp);
    let pipelineReady = false;
    let warmFrames = 0;
    for (; warmFrames < 60; ++warmFrames) {
      await render();
      const stats = starField.getDebugStatistics(scene._frameState);
      if (stats?.pipelineReady && stats?.bindGroupReady) {
        pipelineReady = true;
        break;
      }
    }

    let featureRendererUpdateCalls = 0;
    let instrumentationInstalled = false;
    if (starRenderer && typeof starRenderer.update === "function") {
      const originalUpdate = starRenderer.update;
      starRenderer.update = function (...args) {
        ++featureRendererUpdateCalls;
        return Reflect.apply(originalUpdate, this, args);
      };
      instrumentationInstalled = starRenderer.update !== originalUpdate;
    }

    const snapshot = async () => {
      const frameState = scene._frameState;
      const sunCache = scene.sun._atmosphereExtinctionCache;
      const starCache = starField._atmosphereExtinctionCache;
      const ownedCommands = frameState.commandList.filter(
        (command) => command?.owner === starField,
      ).length;
      const environmentCommand =
        scene._environmentState.starFieldCommand?.owner === starField;
      return {
        sunCache: cache(sunCache),
        starCache: cache(starCache),
        sunExtinction: vec(scene.sun._atmosphereExtinction),
        frameSunExtinction: vec(frameState.sunAtmosphereExtinction),
        starZenithTransmittance: vec(starField._zenithTransmittance),
        frameStarZenithTransmittance: vec(
          frameState.starZenithTransmittance,
        ),
        effectiveStarScale: starField._effectiveIntensityScale,
        featureRendererUpdateCalls,
        draw: {
          environmentCommand,
          commandListOwnerCount: ownedCommands,
          wasBinned: starField.wasBinned,
          starScheduled: environmentCommand || ownedCommands > 0,
        },
        sunPositionWC: vec(graphicsContext.uniformState.sunPositionWC),
        temeToPseudoFixed: matrix(
          graphicsContext.uniformState.temeToPseudoFixedMatrix,
        ),
        cameraPositionWC: vec(scene.camera.positionWC),
        pixelFingerprint: await pixelFingerprint(),
      };
    };
    const measuredRender = async () => {
      const before = await snapshot();
      await render();
      const after = await snapshot();
      return { before, after };
    };

    const phases = {};
    setCamera(nightPosition, nightUp, cameraUp);
    phases.stableNightFirst = await measuredRender();
    phases.stableNightRepeat = await measuredRender();

    const movedPosition = C.Cartesian3.add(
      nightPosition,
      C.Cartesian3.multiplyByScalar(tangent, 25.0, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    setCamera(movedPosition, nightUp, cameraUp);
    phases.cameraMutation = await measuredRender();

    const originalRayleighX = scene.atmosphere.rayleighCoefficient.x;
    scene.atmosphere.rayleighCoefficient.x = originalRayleighX * 1.125;
    phases.atmosphereMutation = {
      ...(await measuredRender()),
      originalRayleighX,
      mutatedRayleighX: scene.atmosphere.rayleighCoefficient.x,
    };

    // Restore the exact physical inputs while extinction is disabled. The
    // subsequent enable must not reuse the disabled cache mode.
    scene.atmosphere.rayleighCoefficient.x = originalRayleighX;
    setCamera(nightPosition, nightUp, cameraUp);
    scene.skyAtmosphere.show = false;
    phases.atmosphereOff = await measuredRender();
    scene.skyAtmosphere.show = true;
    phases.atmosphereRestored = await measuredRender();

    const mutatedTime = C.JulianDate.addSeconds(
      fixedTime,
      900.0,
      new C.JulianDate(),
    );
    viewer.clock.currentTime = C.JulianDate.clone(mutatedTime);
    phases.timeMutation = await measuredRender();

    viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
    phases.timeRestoreNight = await measuredRender();

    const restoredSunDirection = C.Cartesian3.normalize(
      graphicsContext.uniformState.sunDirectionWC,
      new C.Cartesian3(),
    );
    const dayPosition = C.Cartesian3.multiplyByScalar(
      restoredSunDirection,
      radius + lowAltitude,
      new C.Cartesian3(),
    );
    const dayAxis =
      Math.abs(restoredSunDirection.z) < 0.9
        ? C.Cartesian3.UNIT_Z
        : C.Cartesian3.UNIT_X;
    const dayUp = C.Cartesian3.normalize(
      C.Cartesian3.cross(
        restoredSunDirection,
        dayAxis,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    setCamera(dayPosition, restoredSunDirection, dayUp);
    phases.sunFacingDay = await measuredRender();

    setCamera(nightPosition, nightUp, cameraUp);
    phases.finalNightRestore = await measuredRender();

    return {
      setup: {
        requestedRenderer,
        actualRenderer: graphicsContext.rendererType,
        fixedTime: C.JulianDate.toIso8601(fixedTime),
        explicitTimeMutationSeconds: 900,
        lowAltitude,
        featureRendererReady: Boolean(starRenderer),
        instrumentationInstalled,
        pipelineReady,
        warmFrames: warmFrames + 1,
        starStatistics: starField.getDebugStatistics(scene._frameState),
        nightPosition: vec(nightPosition),
        dayPosition: vec(dayPosition),
      },
      phases,
    };
  }, renderer);

  const gate = await collectGateErrors(page);
  const result = {
    requestedRenderer: renderer,
    ...runtime,
    armed,
    gate,
    gpuConsoleErrors: gpuConsoleErrors.slice(),
    pageErrors,
    externalRequests,
  };
  await context.close();
  return result;
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const runs = [];
for (const renderer of ["webgl", "webgpu"]) {
  console.log(`[C9-06] running ${renderer}`);
  runs.push(await runBackend(browser, renderer));
}

const failures = [];
for (const run of runs) validateBackend(run, failures);
validateCrossBackend(runs, failures);

const report = {
  schemaVersion: 1,
  kind: "celestial-extinction-revision-gate-both-renderers",
  generatedAt: new Date().toISOString(),
  runtimeBundle: await runtimeBundleIdentity(),
  browser: {
    product: "Microsoft Edge via Playwright chromium channel",
    version: browser.version(),
    headless: true,
  },
  viewer: {
    baseUrl,
    offline: true,
    viewport,
  },
  runs,
  crossBackendPolicy: {
    sharedCpuOutputs: "exact IEEE-754/JSON equality required; no tolerance",
    pixelFingerprints:
      "Exact within each backend. Cross-backend pixels are intentionally not compared because WebGL and WebGPU use different shader languages, rasterizers, and presentation paths.",
  },
  claims:
    "Functional/cache acceptance only. This probe makes no FPS or timing claim.",
  failures,
  result: failures.length ? "fail" : "pass",
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
console.log(
  JSON.stringify(
    {
      result: report.result,
      failures: report.failures,
      runtimeBundle: report.runtimeBundle,
      browser: report.browser,
      renderers: report.runs.map((run) => ({
        renderer: run.requestedRenderer,
        pipelineReady: run.setup.pipelineReady,
        stableFingerprint:
          run.phases.stableNightFirst.after.pixelFingerprint.sha256,
        stableComputations: {
          sun:
            run.phases.stableNightFirst.after.sunCache.computations -
            run.phases.stableNightFirst.before.sunCache.computations,
          star:
            run.phases.stableNightFirst.after.starCache.computations -
            run.phases.stableNightFirst.before.starCache.computations,
        },
        daytime: {
          effectiveScale: run.phases.sunFacingDay.after.effectiveStarScale,
          featureRendererDelta:
            run.phases.sunFacingDay.after.featureRendererUpdateCalls -
            run.phases.sunFacingDay.before.featureRendererUpdateCalls,
          starCacheComputationDelta:
            run.phases.sunFacingDay.after.starCache.computations -
            run.phases.sunFacingDay.before.starCache.computations,
          starScheduled: run.phases.sunFacingDay.after.draw.starScheduled,
        },
      })),
      output: outputPath,
    },
    null,
    2,
  ),
);
process.exitCode = report.result === "pass" ? 0 : 1;
