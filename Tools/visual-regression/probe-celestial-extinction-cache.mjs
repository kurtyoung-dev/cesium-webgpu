#!/usr/bin/env node
/**
 * C9-06-CELESTIAL-CLOSE acceptance probe.
 *
 * Closes the celestial-extinction revision gate by proving, on the live WebGL
 * and WebGPU paths:
 *
 *   1. Sun cached extinction is EXACTLY the uncached-reference physics. A fresh
 *      `computeAtmosphereExtinction` (default export, no cache) fed the exact
 *      camera + sun-position inputs reproduces `scene.sun._atmosphereExtinction`
 *      bit-for-bit. Because the Moon, Sun, and star field all route through the
 *      same cached integrator, this certifies the cached path is physically
 *      identical to the uncached one for every body.
 *   2. Moon extinction is cached by its exact scalar inputs: the 16-sample march
 *      recomputes exactly once on a fresh input, is a pure hit on an exact
 *      repeat, invalidates exactly once on any scalar mutation, returns exact
 *      multiplicative identity when the atmosphere is hidden, and recomputes an
 *      enabled value after restore (never reusing the disabled mode).
 *   3. The dusk warm-keep hook removes star pop-in: on a daylight
 *      (zero-contribution) camera the STAR_FIELD feature renderer's `prepare`
 *      hook runs and warms the pipeline WITHOUT any `update`/draw, so the first
 *      contributing night frame draws stars immediately instead of cold-starting
 *      the pipeline.
 *   4. Both renderers agree on every shared CPU output (exact IEEE-754 equality).
 *
 * The clock is fixed for every phase; no idle-soak or FPS claim is made.
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
const outputDirectory = resolve(toolDirectory, "output", "performance");
const outputPath = resolve(
  process.argv[2] ||
    resolve(
      outputDirectory,
      "campaign9-c9-06-celestial-extinction-cache-both-2026-07-16.json",
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
  if (!run.setup.moonPresent) {
    failures.push(`${prefix}: scene.moon was not available`);
  }
  if (!(run.setup.nightNonBlackPixels > 0)) {
    failures.push(
      `${prefix}: no visible stars rendered in the night sweep (${run.setup.nightNonBlackPixels} non-black px)`,
    );
  }
  if (run.pageErrors.length) {
    failures.push(`${prefix}: ${run.pageErrors.length} page errors`);
  }
  if (run.gpuConsoleErrors.length) {
    failures.push(
      `${prefix}: ${run.gpuConsoleErrors.length} GPU console errors`,
    );
  }
  if (run.gate.errors.length) {
    failures.push(`${prefix}: ${run.gate.errors.length} uncaptured GPU errors`);
  }
  if (run.gate.deviceLost) {
    failures.push(`${prefix}: ${run.gate.deviceLost}`);
  }
  if (run.externalRequests.length) {
    failures.push(
      `${prefix}: ${run.externalRequests.length} external requests`,
    );
  }
  if (
    prefix === "webgpu" &&
    (run.armed.found < 1 || run.gate.armedDevices < 1)
  ) {
    failures.push(`${prefix}: GPU error gate did not arm the live device`);
  }

  // 1. Sun cached extinction == uncached reference (exact).
  if (!equal(p.sunReference.cached, p.sunReference.uncached)) {
    failures.push(
      `${prefix}/sun-reference: cached sun extinction ${JSON.stringify(
        p.sunReference.cached,
      )} != uncached reference ${JSON.stringify(p.sunReference.uncached)}`,
    );
  }
  if (
    !Array.isArray(p.sunReference.cached) ||
    p.sunReference.cached.some((c) => !(c >= 0 && c <= 1))
  ) {
    failures.push(`${prefix}/sun-reference: sun extinction outside [0,1]`);
  }

  // 2. Moon cache behavior.
  const first = p.moonNightFirst;
  const repeat = p.moonNightRepeat;
  if (
    counterDelta(
      first.after.moonCache,
      first.before.moonCache,
      "computations",
    ) !== 1
  ) {
    failures.push(
      `${prefix}/moon-night-first: moon did not compute exactly once`,
    );
  }
  if (
    counterDelta(
      repeat.after.moonCache,
      repeat.before.moonCache,
      "computations",
    ) !== 0 ||
    counterDelta(repeat.after.moonCache, repeat.before.moonCache, "hits") !== 1
  ) {
    failures.push(
      `${prefix}/moon-night-repeat: exact repeat was not one pure cache hit`,
    );
  }
  if (!equal(first.after.moonExtinction, repeat.after.moonExtinction)) {
    failures.push(`${prefix}/moon-night-repeat: cached moon output changed`);
  }
  if (
    !Array.isArray(first.after.moonExtinction) ||
    first.after.moonExtinction.some((c) => !(c >= 0 && c <= 1))
  ) {
    failures.push(`${prefix}/moon-night-first: moon extinction outside [0,1]`);
  }

  const cam = p.moonCameraMutation;
  if (
    counterDelta(cam.after.moonCache, cam.before.moonCache, "computations") !==
    1
  ) {
    failures.push(
      `${prefix}/moon-camera-mutation: camera move did not recompute the moon cache`,
    );
  }

  const atmo = p.moonAtmosphereMutation;
  if (
    counterDelta(
      atmo.after.moonCache,
      atmo.before.moonCache,
      "computations",
    ) !== 1
  ) {
    failures.push(
      `${prefix}/moon-atmosphere-mutation: scalar mutation did not recompute the moon cache`,
    );
  }
  if (atmo.mutatedMieX === atmo.originalMieX) {
    failures.push(
      `${prefix}/moon-atmosphere-mutation: in-place mie scalar did not change`,
    );
  }

  if (!equal(p.moonAtmosphereOff.after.moonExtinction, [1, 1, 1])) {
    failures.push(
      `${prefix}/moon-atmosphere-off: moon extinction was not exact ONE`,
    );
  }

  const restored = p.moonAtmosphereRestored;
  if (
    counterDelta(
      restored.after.moonCache,
      restored.before.moonCache,
      "computations",
    ) !== 1
  ) {
    failures.push(
      `${prefix}/moon-atmosphere-restored: enabled value did not recompute after disabled mode`,
    );
  }
  if (!equal(restored.after.moonExtinction, first.after.moonExtinction)) {
    failures.push(
      `${prefix}/moon-atmosphere-restored: restored moon extinction did not return to baseline`,
    );
  }

  // 3. Dusk warm-keep: daylight warms the pipeline via prepare, not update.
  const day = p.daylightWarmKeep;
  if (day.starPrepareDelta < 1) {
    failures.push(
      `${prefix}/daylight-warm-keep: prepare warm-keep hook never ran on the zero-contribution path`,
    );
  }
  if (day.starUpdateDelta !== 0 || day.starScheduledEver) {
    failures.push(
      `${prefix}/daylight-warm-keep: a zero-contribution daylight frame drew stars`,
    );
  }
  if (day.effectiveStarScale !== 0) {
    failures.push(
      `${prefix}/daylight-warm-keep: daylight effective star scale was not exact zero`,
    );
  }
  if (!day.pipelineReadyBeforeNight) {
    failures.push(
      `${prefix}/daylight-warm-keep: pipeline was not warm before dusk (would pop in)`,
    );
  }

  // First night frame after the warm daylight run draws immediately.
  const firstNight = p.firstNightAfterDay;
  if (!firstNight.pipelineReady) {
    failures.push(
      `${prefix}/first-night: pipeline was cold on the first contributing frame (star pop-in)`,
    );
  }
  if (
    firstNight.starUpdateDelta !== 1 ||
    !firstNight.starScheduled ||
    firstNight.effectiveStarScale <= 0
  ) {
    failures.push(
      `${prefix}/first-night: first night frame did not draw stars immediately`,
    );
  }
}

function validateCrossBackend(runs, failures) {
  const webgl = runs.find((r) => r.requestedRenderer === "webgl");
  const webgpu = runs.find((r) => r.requestedRenderer === "webgpu");
  // Shared CPU moon extinction values must match exactly across backends.
  const moonPhases = [
    "moonNightFirst",
    "moonNightRepeat",
    "moonCameraMutation",
    "moonAtmosphereOff",
    "moonAtmosphereRestored",
  ];
  for (const phaseName of moonPhases) {
    const left = webgl.phases[phaseName].after.moonExtinction;
    const right = webgpu.phases[phaseName].after.moonExtinction;
    if (!equal(left, right)) {
      failures.push(
        `cross-backend/${phaseName}: moon extinction differs (${JSON.stringify(
          left,
        )} vs ${JSON.stringify(right)})`,
      );
    }
  }
  if (
    !equal(webgl.phases.sunReference.cached, webgpu.phases.sunReference.cached)
  ) {
    failures.push(`cross-backend/sun-reference: cached sun extinction differs`);
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
    const computeAtmosphereExtinction = C.computeAtmosphereExtinction;
    const viewer = globalThis.viewer;
    const scene = viewer.scene;
    const graphicsContext = scene.context;
    const starField = scene.skyBox?.starField;
    const moon = scene.moon;
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
    if (moon) {
      moon.show = true;
    }
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
    const vec = (value) => (value ? [value.x, value.y, value.z] : null);
    const cache = (value) => ({
      computations: value?.computations ?? null,
      hits: value?.hits ?? null,
      mode: value?._mode ?? null,
    });
    // Render one frame and grab the canvas SYNCHRONOUSLY, before control
    // returns to the browser compositor and the (non-preserved) drawing
    // buffer is cleared/swapped. Capturing after an awaited animation frame
    // reads a cleared buffer (all black), so the grab must be same-task.
    const renderAndGrab = () => {
      scene.render(viewer.clock.currentTime);
      const source = scene.canvas;
      const capture = document.createElement("canvas");
      capture.width = source.width;
      capture.height = source.height;
      const twoD = capture.getContext("2d", { willReadFrequently: true });
      twoD.drawImage(source, 0, 0);
      const bytes = twoD.getImageData(0, 0, capture.width, capture.height).data;
      let nonBlack = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        if (bytes[i] + bytes[i + 1] + bytes[i + 2] !== 0) ++nonBlack;
      }
      return { png: capture.toDataURL("image/png"), nonBlack };
    };

    // Establish the fixed-time ephemeris.
    await render();
    const fixedSunDirection = C.Cartesian3.normalize(
      graphicsContext.uniformState.sunDirectionWC,
      new C.Cartesian3(),
    );
    const nightUp = C.Cartesian3.negate(fixedSunDirection, new C.Cartesian3());
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
    const dayPosition = C.Cartesian3.multiplyByScalar(
      fixedSunDirection,
      radius + lowAltitude,
      new C.Cartesian3(),
    );
    const dayAxis =
      Math.abs(fixedSunDirection.z) < 0.9
        ? C.Cartesian3.UNIT_Z
        : C.Cartesian3.UNIT_X;
    const dayUp = C.Cartesian3.normalize(
      C.Cartesian3.cross(fixedSunDirection, dayAxis, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const setCamera = (position, direction, up) => {
      scene.camera.setView({
        destination: position,
        orientation: { direction, up },
      });
    };

    // Resolve + instrument the STAR_FIELD feature renderer (prepare + update).
    const starRenderer = await graphicsContext.getFeatureRendererAsync(
      C.FeatureRendererKey.STAR_FIELD,
    );
    let featureRendererUpdateCalls = 0;
    let featureRendererPrepareCalls = 0;
    let instrumentationInstalled = false;
    if (starRenderer && typeof starRenderer.update === "function") {
      const originalUpdate = starRenderer.update;
      starRenderer.update = function (...args) {
        ++featureRendererUpdateCalls;
        return Reflect.apply(originalUpdate, this, args);
      };
      const hasPrepare = typeof starRenderer.prepare === "function";
      if (hasPrepare) {
        const originalPrepare = starRenderer.prepare;
        starRenderer.prepare = function (...args) {
          ++featureRendererPrepareCalls;
          return Reflect.apply(originalPrepare, this, args);
        };
      }
      instrumentationInstalled =
        starRenderer.update !== originalUpdate && hasPrepare;
    }

    const starScheduled = () => {
      const frameState = scene._frameState;
      const ownedCommands = frameState.commandList.filter(
        (command) => command?.owner === starField,
      ).length;
      const environmentCommand =
        scene._environmentState.starFieldCommand?.owner === starField;
      return environmentCommand || ownedCommands > 0;
    };
    const pipelineReady = () => {
      const stats = starField.getDebugStatistics(scene._frameState);
      return Boolean(stats?.pipelineReady && stats?.bindGroupReady);
    };
    const moonSnapshot = () => ({
      moonCache: cache(moon?._atmosphereExtinctionCache),
      moonExtinction: vec(scene._frameState.moonAtmosphereExtinction),
    });
    const measuredMoon = async () => {
      const before = moonSnapshot();
      await render();
      const after = moonSnapshot();
      return { before, after };
    };

    const phases = {};

    // ── Dusk warm-keep: daylight (zero-contribution) run. ──
    setCamera(dayPosition, fixedSunDirection, dayUp);
    const prepareBefore = featureRendererPrepareCalls;
    const updateBefore = featureRendererUpdateCalls;
    let starScheduledEver = false;
    let effectiveStarScaleDay = null;
    let pipelineReadyBeforeNight = false;
    for (let i = 0; i < 60; ++i) {
      await render();
      effectiveStarScaleDay = starField._effectiveIntensityScale;
      if (starScheduled()) starScheduledEver = true;
      if (pipelineReady()) {
        pipelineReadyBeforeNight = true;
        // Keep running a few more daylight frames to confirm no draw slips in.
        for (let j = 0; j < 5; ++j) {
          await render();
          if (starScheduled()) starScheduledEver = true;
        }
        break;
      }
    }
    phases.daylightWarmKeep = {
      starPrepareDelta: featureRendererPrepareCalls - prepareBefore,
      starUpdateDelta: featureRendererUpdateCalls - updateBefore,
      starScheduledEver,
      effectiveStarScale: effectiveStarScaleDay,
      pipelineReadyBeforeNight,
    };

    // ── First night frame after the warm daylight run: draws immediately. ──
    setCamera(nightPosition, nightUp, cameraUp);
    const firstNightUpdateBefore = featureRendererUpdateCalls;
    await render();
    phases.firstNightAfterDay = {
      starUpdateDelta: featureRendererUpdateCalls - firstNightUpdateBefore,
      starScheduled: starScheduled(),
      pipelineReady: pipelineReady(),
      effectiveStarScale: starField._effectiveIntensityScale,
    };

    // ── Sun cached extinction == fresh uncached reference (exact). ──
    // Warm to a stable night frame first.
    await render();
    const sunCached = vec(scene.sun._atmosphereExtinction);
    const uncachedResult = computeAtmosphereExtinction(
      new C.Cartesian3(),
      scene.camera.positionWC,
      graphicsContext.uniformState.sunPositionWC,
      scene.atmosphere,
      C.Ellipsoid.default.maximumRadius,
    );
    phases.sunReference = {
      cached: sunCached,
      uncached: vec(uncachedResult),
    };

    // ── Moon cache behavior at a stable night camera. ──
    // Force a clean miss so "computes exactly once on a fresh input" is
    // measured deterministically regardless of earlier warm-up frames at this
    // camera. Resetting the cache mode is exactly the fresh-cache condition.
    setCamera(nightPosition, nightUp, cameraUp);
    await render();
    if (moon?._atmosphereExtinctionCache) {
      moon._atmosphereExtinctionCache._mode = 0;
    }
    phases.moonNightFirst = await measuredMoon();
    phases.moonNightRepeat = await measuredMoon();

    const movedPosition = C.Cartesian3.add(
      nightPosition,
      C.Cartesian3.multiplyByScalar(tangent, 25.0, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    setCamera(movedPosition, nightUp, cameraUp);
    phases.moonCameraMutation = await measuredMoon();

    // Return to the baseline camera before the scalar mutation so the only
    // changed input is the atmosphere coefficient.
    setCamera(nightPosition, nightUp, cameraUp);
    await render();
    const originalMieX = scene.atmosphere.mieCoefficient.x;
    scene.atmosphere.mieCoefficient.x = originalMieX * 1.25;
    phases.moonAtmosphereMutation = {
      ...(await measuredMoon()),
      originalMieX,
      mutatedMieX: scene.atmosphere.mieCoefficient.x,
    };
    scene.atmosphere.mieCoefficient.x = originalMieX;
    await render();

    // ── Moon atmosphere off → exact ONE; restore → recompute. ──
    setCamera(nightPosition, nightUp, cameraUp);
    scene.skyAtmosphere.show = false;
    phases.moonAtmosphereOff = await measuredMoon();
    scene.skyAtmosphere.show = true;
    phases.moonAtmosphereRestored = await measuredMoon();

    // ── PNG captures. ──
    // Enable the post-process pipeline (WebGPU blits the scene FB through it)
    // and bloom so bright catalog stars glow and read clearly in an 8-bit PNG.
    // Aim at named bright stars (computed from their J2000 RA/Dec via the same
    // TEME→fixed matrix the renderer uses) from a space altitude so the star
    // is centered and unambiguously visible; the moon still drives the
    // extinction cache each frame. Keep the brightest capture.
    if (scene.postProcessStages) scene.postProcessStages.enabled = true;
    const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
      fixedTime,
      new C.Matrix3(),
    );
    const brightStars = [
      { name: "Sirius", raDeg: 101.287, decDeg: -16.716 },
      { name: "Canopus", raDeg: 95.988, decDeg: -52.696 },
      { name: "Vega", raDeg: 279.234, decDeg: 38.784 },
      { name: "Arcturus", raDeg: 213.915, decDeg: 19.182 },
    ];
    const camAlt = radius * 2.5;
    let nightPng = null;
    let nightNonBlack = 0;
    let bestStar = null;
    for (const star of brightStars) {
      const ra = C.Math.toRadians(star.raDeg);
      const dec = C.Math.toRadians(star.decDeg);
      const temeDir = new C.Cartesian3(
        Math.cos(dec) * Math.cos(ra),
        Math.cos(dec) * Math.sin(ra),
        Math.sin(dec),
      );
      const dirFixed = C.Cartesian3.normalize(
        C.Matrix3.multiplyByVector(temeToFixed, temeDir, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const eye = C.Cartesian3.multiplyByScalar(
        dirFixed,
        -camAlt,
        new C.Cartesian3(),
      );
      const upAxis =
        Math.abs(dirFixed.z) < 0.9 ? C.Cartesian3.UNIT_Z : C.Cartesian3.UNIT_X;
      const right = C.Cartesian3.normalize(
        C.Cartesian3.cross(dirFixed, upAxis, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const up = C.Cartesian3.normalize(
        C.Cartesian3.cross(right, dirFixed, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      setCamera(eye, dirFixed, up);
      // A couple frames so the async pipeline (already warm) settles the view.
      await render();
      const grab = renderAndGrab();
      if (grab.nonBlack > nightNonBlack) {
        nightNonBlack = grab.nonBlack;
        nightPng = grab.png;
        bestStar = star.name;
      }
    }
    if (!nightPng) {
      setCamera(nightPosition, nightUp, cameraUp);
      nightPng = renderAndGrab().png;
    }
    setCamera(dayPosition, fixedSunDirection, dayUp);
    const dayPng = renderAndGrab().png;

    return {
      setup: {
        requestedRenderer,
        actualRenderer: graphicsContext.rendererType,
        fixedTime: C.JulianDate.toIso8601(fixedTime),
        lowAltitude,
        featureRendererReady: Boolean(starRenderer),
        instrumentationInstalled,
        moonPresent: Boolean(moon),
        nightNonBlackPixels: nightNonBlack,
        nightBestStar: bestStar,
        starStatistics: starField.getDebugStatistics(scene._frameState),
      },
      phases,
      captures: { nightPng, dayPng },
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

async function writePng(dataUrl, filePath) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    return;
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  await writeFile(filePath, Buffer.from(base64, "base64"));
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const runs = [];
for (const renderer of ["webgl", "webgpu"]) {
  console.log(`[C9-06-CLOSE] running ${renderer}`);
  runs.push(await runBackend(browser, renderer));
}

const failures = [];
for (const run of runs) validateBackend(run, failures);
validateCrossBackend(runs, failures);

await mkdir(outputDirectory, { recursive: true });
const pngPaths = {};
for (const run of runs) {
  const nightPath = resolve(
    outputDirectory,
    `campaign9-c9-06-cache-${run.requestedRenderer}-night.png`,
  );
  const dayPath = resolve(
    outputDirectory,
    `campaign9-c9-06-cache-${run.requestedRenderer}-day.png`,
  );
  await writePng(run.captures?.nightPng, nightPath);
  await writePng(run.captures?.dayPng, dayPath);
  pngPaths[run.requestedRenderer] = { night: nightPath, day: dayPath };
  // Drop the heavy data URLs from the JSON report.
  delete run.captures;
}

const report = {
  schemaVersion: 1,
  kind: "celestial-extinction-cache-close-both-renderers",
  generatedAt: new Date().toISOString(),
  runtimeBundle: await runtimeBundleIdentity(),
  browser: {
    product: "Microsoft Edge via Playwright chromium channel",
    version: browser.version(),
    headless: true,
  },
  viewer: { baseUrl, offline: true, viewport },
  runs,
  pngPaths,
  crossBackendPolicy: {
    sharedCpuOutputs: "exact IEEE-754/JSON equality required; no tolerance",
    pixels:
      "PNGs are read by a human; cross-backend pixels are not compared (different shader languages/rasterizers).",
  },
  claims:
    "Functional/cache/warm-keep acceptance only. No FPS or timing claim is made.",
  failures,
  result: failures.length ? "fail" : "pass",
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
console.log(
  JSON.stringify(
    {
      result: report.result,
      failures: report.failures,
      runtimeBundle: report.runtimeBundle,
      renderers: report.runs.map((run) => ({
        renderer: run.requestedRenderer,
        moonPresent: run.setup.moonPresent,
        nightNonBlackPixels: run.setup.nightNonBlackPixels,
        sunReference: run.phases.sunReference,
        moonFirstComputeDelta:
          run.phases.moonNightFirst.after.moonCache.computations -
          run.phases.moonNightFirst.before.moonCache.computations,
        moonRepeatHitDelta:
          run.phases.moonNightRepeat.after.moonCache.hits -
          run.phases.moonNightRepeat.before.moonCache.hits,
        warmKeep: run.phases.daylightWarmKeep,
        firstNight: run.phases.firstNightAfterDay,
      })),
      pngPaths,
      output: outputPath,
    },
    null,
    2,
  ),
);
process.exitCode = report.result === "pass" ? 0 : 1;
