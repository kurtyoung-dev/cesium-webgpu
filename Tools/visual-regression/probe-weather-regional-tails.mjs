#!/usr/bin/env node
/**
 * C13-08 rendered tails — cyclic CoverageJSON + WebGL regional regression.
 *
 * WebGPU ingests a real CoverageJSON response whose CRS84 longitude axis walks
 * east through +180/-180. Controls use the procedural weather map with no
 * provider. The regional run must become overcast at 178 E, 178 W, and across
 * a seam-centred frame, while a far-away view remains the same procedural fill.
 * This proves parser -> packer -> uploaded texture -> shader consumption; a
 * manually supplied wrapped bounds object would not exercise the parser bug.
 *
 * WebGL packs and attaches the same regional provider to a VOLUMETRIC-mode
 * CloudCollection. WebGL has no volumetric renderer, so its legacy billboard
 * pixels must stay unchanged and requestVolumetricClouds must remain unused.
 * The explicit provider pack proves the backend-neutral data API still works
 * without burdening the WebGL render path with volumetric work.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-regional-tails.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";
import {
  assessWebGLRegionalTail,
  assessWebGPURegionalTail,
  createAntimeridianCoverageJson,
} from "./lib/weather-regional-tail-evidence.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/weather-regional-tails";
const EDR_PATH = "/__c13-antimeridian-edr";
const COVERAGE = createAntimeridianCoverageJson();
const WATCHDOG_MS = 300_000;

const watchdog = setTimeout(() => {
  console.error(`STRUCTURAL: probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

const RUN_LANE = async ({ renderer, edrBase }) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;

  let frameTime = C.JulianDate.fromIso8601("2026-06-01T00:00:00Z");

  // ==BEGIN same-task-capture==
  const makeSameTaskCapture = (scene, canvas, timeFn) => {
    const renderNow = () => scene.render(timeFn());
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decodeSnapshot = async (snapshot) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        const decodeFailed = "same-task PNG decode failed";
        image.onload = resolve;
        image.onerror = () => reject(new Error(decodeFailed));
      });
      image.src = snapshot;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const snapshotNow = () => {
      renderNow();
      return canvas.toDataURL("image/png");
    };
    const captureNow = () => {
      const snapshot = snapshotNow();
      return decodeSnapshot(snapshot);
    };
    const grabNow = snapshotNow;
    const settleThen = async (maxFrames, done, capture) => {
      let settled = false;
      for (let k = 0; k < maxFrames; k++) {
        if (typeof done === "function" && done() === true) {
          settled = true;
          break;
        }
        renderNow();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!settled && typeof done === "function") {
        settled = done() === true;
      }
      const hasCapture = typeof capture === "function";
      const result = hasCapture ? await capture() : undefined;
      return { settled, result };
    };
    return { renderNow, captureNow, grabNow, settleThen };
  };
  // ==END same-task-capture==

  const capture = makeSameTaskCapture(scene, canvas, () => frameTime);

  const settle = async (frames) => {
    for (let i = 0; i < frames; i++) {
      capture.renderNow();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };

  const localNoon = (longitudeDegrees) => {
    const millis =
      Date.UTC(2026, 5, 1, 12, 0, 0) -
      (longitudeDegrees / 15.0) * 60 * 60 * 1000;
    return C.JulianDate.fromDate(new Date(millis));
  };

  const clonePackStats = (provider) => {
    const stats = provider?.getPackStats?.();
    return stats ? { ...stats } : null;
  };

  const summarizeImage = (image) => {
    const { width, height, data } = image;
    const x0 = Math.floor(width * 0.12);
    const x1 = Math.floor(width * 0.88);
    const y0 = Math.floor(height * 0.15);
    const y1 = Math.floor(height * 0.85);
    const midpoint = Math.floor((x0 + x1) / 2);
    let brightPixels = 0;
    let leftBrightPixels = 0;
    let rightBrightPixels = 0;
    let meanLuminance = 0;
    let samples = 0;
    let leftSamples = 0;
    let rightSamples = 0;
    const columnMeans = [];
    for (let x = x0; x < x1; x++) {
      let columnSum = 0;
      let columnSamples = 0;
      for (let y = y0; y < y1; y += 2) {
        const index = (y * width + x) * 4;
        const luminance = Math.max(
          data[index],
          data[index + 1],
          data[index + 2],
        );
        const bright = luminance > 120;
        brightPixels += bright ? 1 : 0;
        meanLuminance += luminance;
        samples++;
        columnSum += luminance;
        columnSamples++;
        if (x < midpoint) {
          leftBrightPixels += bright ? 1 : 0;
          leftSamples++;
        } else {
          rightBrightPixels += bright ? 1 : 0;
          rightSamples++;
        }
      }
      columnMeans.push(columnSamples ? columnSum / columnSamples : 0);
    }
    const steps = [];
    for (let i = 1; i < columnMeans.length; i++) {
      steps.push(Math.abs(columnMeans[i] - columnMeans[i - 1]));
    }
    const stepMid = Math.floor(steps.length / 2);
    const centerHalfWidth = Math.max(1, Math.floor(steps.length * 0.04));
    const centerSteps = steps.slice(
      stepMid - centerHalfWidth,
      stepMid + centerHalfWidth,
    );
    const outerSteps = steps
      .slice(0, stepMid - centerHalfWidth)
      .concat(steps.slice(stepMid + centerHalfWidth))
      .sort((a, b) => a - b);
    return {
      width,
      height,
      brightPixels,
      brightFraction: samples ? brightPixels / samples : 0,
      leftBrightFraction: leftSamples ? leftBrightPixels / leftSamples : 0,
      rightBrightFraction: rightSamples ? rightBrightPixels / rightSamples : 0,
      meanLuminance: samples ? meanLuminance / samples : 0,
      centerColumnStepMax: centerSteps.length ? Math.max(...centerSteps) : 0,
      columnStepP95: outerSteps.length
        ? outerSteps[Math.floor(outerSteps.length * 0.95)]
        : 0,
    };
  };

  const compareImages = (before, after) => {
    if (before.width !== after.width || before.height !== after.height) {
      return {
        exactMismatchFraction: 1,
        significantMismatchFraction: 1,
        meanAbsoluteRgbDelta: 255,
      };
    }
    let exact = 0;
    let significant = 0;
    let absolute = 0;
    const pixels = before.width * before.height;
    for (let i = 0; i < before.data.length; i += 4) {
      const delta =
        Math.abs(before.data[i] - after.data[i]) +
        Math.abs(before.data[i + 1] - after.data[i + 1]) +
        Math.abs(before.data[i + 2] - after.data[i + 2]);
      exact += delta > 0 ? 1 : 0;
      significant += delta > 12 ? 1 : 0;
      absolute += delta;
    }
    return {
      exactMismatchFraction: pixels ? exact / pixels : 0,
      significantMismatchFraction: pixels ? significant / pixels : 0,
      meanAbsoluteRgbDelta: pixels ? absolute / (3 * pixels) : 0,
    };
  };

  const fieldEvidence = { value: null };
  const edr = new C.EdrWeatherSource({
    baseUrl: edrBase,
    collection: "c13-antimeridian",
    parameterName: "TCDC",
    coverageUnits: "percent",
  });
  const source = {
    getCapabilities() {
      return edr.getCapabilities();
    },
    async fetchField(request) {
      const field = await edr.fetchField(request);
      const toDegrees = (radians) => (radians * 180.0) / Math.PI;
      fieldEvidence.value = {
        westDegrees: toDegrees(field.bounds.west),
        eastDegrees: toDegrees(field.bounds.east),
        southDegrees: toDegrees(field.bounds.south),
        northDegrees: toDegrees(field.bounds.north),
        registration: field.registration,
        gridWidth: field.gridWidth,
        gridHeight: field.gridHeight,
      };
      return field;
    },
  };

  const waitForProvider = async (provider, framesAlsoRender) => {
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      provider.getPackedTexture(256, 128);
      capture.renderNow();
      if (provider.hasData && provider.getPackStats()) {
        await settle(framesAlsoRender);
        return true;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
  };

  const publicCapture = (entry) => ({
    ...entry.metrics,
    packStats: entry.packStats,
  });

  if (renderer === "webgpu") {
    const globe = scene.globe;
    globe.show = true;
    globe.imageryLayers.removeAll();
    globe.baseColor = C.Color.fromBytes(20, 20, 25);
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.fog) scene.fog.enabled = false;
    scene.backgroundColor = C.Color.BLACK;

    const truth = globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: {
        cloudCoverage: 0.5,
        cloudDensity: 0.9,
        cloudLayerBottom: 1500,
        cloudLayerTop: 4000,
        cloudWindSpeed: 0,
        cloudQuality: 96,
        cloudWeatherMap: true,
        cloudCastShadows: false,
        cloudContributesIBL: false,
        weatherProvider: undefined,
      },
    });
    const volumetric = globe.defaultCloudCollection.volumetric;

    const positionView = (longitudeDegrees) => {
      frameTime = localNoon(longitudeDegrees);
      viewer.clock.currentTime = frameTime;
      scene.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          longitudeDegrees,
          -5.0,
          250_000.0,
        ),
        orientation: {
          heading: 0,
          pitch: C.Math.toRadians(-90),
          roll: 0,
        },
      });
    };

    const captureAt = async (longitudeDegrees, provider, settleFrames = 28) => {
      positionView(longitudeDegrees);
      await settle(settleFrames);
      const image = await capture.captureNow();
      const png = capture.grabNow();
      return {
        image,
        png,
        metrics: summarizeImage(image),
        packStats: clonePackStats(provider),
      };
    };

    positionView(180);
    const readiness = await globalThis.__cloudProbe.awaitProceduralReady({
      featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
      frameTime,
      maxFrames: 240,
    });
    await captureAt(0, null, 45); // discarded cold-path warm-up

    const control = {
      east: await captureAt(178, null),
      west: await captureAt(-178, null),
      seam: await captureAt(180, null),
      far: await captureAt(0, null),
    };

    const provider = new C.WeatherProvider(source);
    volumetric.weatherProvider = provider;
    positionView(180);
    const providerReady = await waitForProvider(provider, 24);
    if (!providerReady) {
      throw new Error(
        `regional WeatherProvider did not pack: ${String(provider.lastError)}`,
      );
    }

    const regional = {
      east: await captureAt(178, provider),
      west: await captureAt(-178, provider),
      seam: await captureAt(180, provider),
      far: await captureAt(0, provider),
    };

    return {
      renderer: String(scene.context.rendererType).toLowerCase(),
      truth,
      readiness,
      field: fieldEvidence.value,
      provider: {
        hasData: provider.hasData,
        version: provider.version,
        lastError: provider.lastError,
        packStats: clonePackStats(provider),
      },
      control: Object.fromEntries(
        Object.entries(control).map(([key, value]) => [
          key,
          publicCapture(value),
        ]),
      ),
      regional: Object.fromEntries(
        Object.entries(regional).map(([key, value]) => [
          key,
          publicCapture(value),
        ]),
      ),
      comparisons: {
        east: compareImages(control.east.image, regional.east.image),
        west: compareImages(control.west.image, regional.west.image),
        seam: compareImages(control.seam.image, regional.seam.image),
        far: compareImages(control.far.image, regional.far.image),
      },
      pngs: {
        "webgpu-control-east": control.east.png,
        "webgpu-control-west": control.west.png,
        "webgpu-control-seam": control.seam.png,
        "webgpu-control-far": control.far.png,
        "webgpu-regional-east": regional.east.png,
        "webgpu-regional-west": regional.west.png,
        "webgpu-regional-seam": regional.seam.png,
        "webgpu-regional-far": regional.far.png,
      },
    };
  }

  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = C.Color.BLACK;
  frameTime = C.JulianDate.fromIso8601("2026-06-01T12:00:00Z");
  viewer.clock.currentTime = frameTime;
  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95, 39, 15_000),
    orientation: {
      heading: 0,
      pitch: C.Math.toRadians(-90),
      roll: 0,
    },
  });

  const context = scene.context;
  const originalRequest = context.requestVolumetricClouds.bind(context);
  let volumetricRequestCount = 0;
  context.requestVolumetricClouds = function (config) {
    volumetricRequestCount++;
    return originalRequest(config);
  };

  const collection = scene.primitives.add(
    new C.CloudCollection({ enableVolumetric: true }),
  );
  for (const [lon, lat] of [
    [-95.02, 39],
    [-95, 39],
    [-94.98, 39],
    [-95, 39.02],
    [-95, 38.98],
  ]) {
    collection.add({
      position: C.Cartesian3.fromDegrees(lon, lat, 3000),
      scale: new C.Cartesian2(2000, 1300),
      maximumSize: new C.Cartesian3(2000, 1300, 900),
      brightness: 1,
    });
  }

  const billboardReady = await capture.settleThen(
    180,
    () => collection._ready === true,
  );
  if (!billboardReady.settled) {
    throw new Error("WebGL CloudCollection noise texture did not become ready");
  }
  await settle(12);
  const controlImage = await capture.captureNow();
  const controlPng = capture.grabNow();
  const control = summarizeImage(controlImage);

  const provider = new C.WeatherProvider(source);
  const providerReady = await waitForProvider(provider, 12);
  if (!providerReady) {
    throw new Error(
      `WebGL regional WeatherProvider did not pack: ${String(provider.lastError)}`,
    );
  }
  collection.volumetric.weatherProvider = provider;
  collection.volumetric.cloudWeatherMap = true;
  await settle(32);
  const regionalImage = await capture.captureNow();
  const regionalPng = capture.grabNow();
  const regional = summarizeImage(regionalImage);
  regional.packStats = clonePackStats(provider);

  context.requestVolumetricClouds = originalRequest;
  return {
    renderer: String(scene.context.rendererType).toLowerCase(),
    field: fieldEvidence.value,
    provider: {
      hasData: provider.hasData,
      version: provider.version,
      lastError: provider.lastError,
      packStats: clonePackStats(provider),
    },
    control,
    regional,
    comparison: compareImages(controlImage, regionalImage),
    volumetricRequestCount,
    billboardReadiness: billboardReady,
    pngs: {
      "webgl-billboard-control": controlPng,
      "webgl-billboard-regional": regionalPng,
    },
  };
};

function attachPageErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function filteredErrors(errors) {
  return [...new Set(errors)].filter(
    (error) => !/favicon|Ion access token/i.test(error),
  );
}

async function runBackend(browser, renderer) {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const pageErrors = attachPageErrors(page);
  await page.addInitScript(errorGateInit);
  await installCloudProbeHarnessOnPage(page);

  let routeRequests = 0;
  await page.route(`**${EDR_PATH}/**`, async (route) => {
    routeRequests++;
    await route.fulfill({
      status: 200,
      contentType: "application/prs.coverage+json",
      body: JSON.stringify(COVERAGE),
    });
  });

  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer?.scene, null, {
      timeout: 90_000,
    });
    if (renderer === "webgpu") {
      await armWebGPUDevices(page);
    }
    const result = await page.evaluate(RUN_LANE, {
      renderer,
      edrBase: `${BASE}${EDR_PATH}`,
    });
    const gate = await collectGateErrors(page);
    const errors = filteredErrors([
      ...pageErrors,
      ...(gate.errors ?? []),
      ...(gate.deviceLost ? [gate.deviceLost] : []),
    ]);
    return { ...result, routeRequests, errors, gpuGate: gate };
  } finally {
    await page.close().catch(() => {});
  }
}

function writePngs(record) {
  for (const [name, dataUrl] of Object.entries(record.pngs ?? {})) {
    const comma = dataUrl.indexOf(",");
    fs.writeFileSync(
      path.join(OUT, `${name}.png`),
      Buffer.from(dataUrl.slice(comma + 1), "base64"),
    );
  }
}

function withoutPngs(record) {
  const { pngs: _pngs, ...rest } = record;
  return rest;
}

function printAssessment(label, assessment) {
  console.log(`\n=== ${label} ===`);
  for (const [name, passed] of Object.entries(assessment.checks)) {
    console.log(`  [${passed ? "PASS" : "FAIL"}] ${name}`);
  }
  if (assessment.diagnostics) {
    console.log(`  diagnostics: ${JSON.stringify(assessment.diagnostics)}`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  try {
    const webgpu = await runBackend(browser, "webgpu");
    const webgl = await runBackend(browser, "webgl");
    writePngs(webgpu);
    writePngs(webgl);

    const webgpuAssessment = assessWebGPURegionalTail(webgpu);
    const webglAssessment = assessWebGLRegionalTail(webgl);
    printAssessment("WEBGPU ANTIMERIDIAN REGIONAL", webgpuAssessment);
    printAssessment("WEBGL REGIONAL REGRESSION", webglAssessment);

    const manifest = {
      generatedAt: new Date().toISOString(),
      base: BASE,
      browserVersion: browser.version(),
      coverage: COVERAGE,
      webgpu: withoutPngs(webgpu),
      webgl: withoutPngs(webgl),
      assessments: { webgpu: webgpuAssessment, webgl: webglAssessment },
    };
    const manifestPath = path.join(OUT, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nmanifest: ${manifestPath}`);
    console.log(`PNGs: ${OUT}/*.png`);

    const passed = webgpuAssessment.ok && webglAssessment.ok;
    console.log(`RESULT: ${passed ? "GREEN" : "RED"}`);
    process.exitCode = passed ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
    clearTimeout(watchdog);
  }
}

main().catch((error) => {
  clearTimeout(watchdog);
  console.error(error?.stack ?? String(error));
  process.exitCode = 2;
});
