#!/usr/bin/env node
/**
 * C13-36 cloud ray-start jitter quality oracle. WebGPU-only.
 *
 * This is a visual-quality probe, not a frame-time or performance benchmark.
 * It captures the same authored scene with volumetric clouds OFF, on the first
 * deterministic authored frame, and after 32 deterministic frames.
 * The OFF image is subtracted from each ON image so terrain/background edges do
 * not masquerade as cloud-ray banding.
 *
 * Run a provenance-locked pair against two separately built source states:
 *
 *   TAG=before CLOUD_BANDING_PAIR_ID=c13-36-001 \
 *     node Tools/visual-regression/probe-cloud-banding.mjs
 *   TAG=after CLOUD_BANDING_PAIR_ID=c13-36-001 \
 *     node Tools/visual-regression/probe-cloud-banding.mjs
 *   CLOUD_BANDING_QUALITY=high \
 *     node Tools/visual-regression/probe-cloud-banding.mjs
 *
 * A run without CLOUD_BANDING_PAIR_ID records a valid characterization artifact
 * but does not claim an A/B result. A requested pair fails closed when its
 * companion is absent, stale, built from the same cloud sources, or captured on
 * a different browser/adapter/canvas/configuration.
 *
 * Output:
 *   Tools/visual-regression/output/cloud-banding/
 *     cloud-banding-<quality>-{before,after}-{off,single,settled}.png
 *     cloud-banding-<quality>-{before,after}.json
 *
 * The coherent-band metric intentionally low-passes the cloud-only contribution
 * before finding connected luminance jumps. Isolated high-frequency IGN dither
 * is therefore not mislabeled as a long contour. The provisional 50% reduction
 * gate must remain paired with manual PNG inspection; it does not prove that all
 * cloud morphology or baked-noise periodicity is fixed. The settled image also
 * includes today's half-resolution Bayer sampling and temporal history resolve;
 * this probe cannot attribute every settled-frame delta to IGN alone. Cloud-aware
 * god rays are disabled, so their separate full-resolution cloud-mask march is
 * explicitly outside this oracle.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
const TAG = process.env.TAG || "after";
const PAIR_ID = process.env.CLOUD_BANDING_PAIR_ID || null;
const QUALITY = process.env.CLOUD_BANDING_QUALITY || "low";
const OUT_DIR = "Tools/visual-regression/output/cloud-banding";
const PROBE_VERSION = "c13-36-v2";
const WIDTH = 1024;
const HEIGHT = 768;
const FIXED_TIME = "2026-06-21T18:20:00Z";
const HALF_RES_BIT = 1 << 1;
const TEMPORAL_BIT = 1 << 2;
const JITTER_BIT = 1 << 3;

if (!["before", "after"].includes(TAG)) {
  throw new Error(`TAG must be before or after; received ${TAG}`);
}
if (!["low", "high"].includes(QUALITY)) {
  throw new Error(
    `CLOUD_BANDING_QUALITY must be low or high; received ${QUALITY}`,
  );
}

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

function fileFingerprint(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    path: filePath.replaceAll("\\", "/"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sourceProvenance() {
  const workerDir = "Build/CesiumUnminified/Workers";
  const cloudWorkers = fs
    .readdirSync(workerDir)
    .filter((name) => /^WebGPUProceduralCloudRenderer-.*\.js$/.test(name))
    .sort();
  if (cloudWorkers.length !== 1) {
    throw new Error(
      `expected one built WebGPUProceduralCloudRenderer worker, found ${cloudWorkers.length}: ${cloudWorkers.join(", ")}`,
    );
  }

  const files = [
    "Build/CesiumUnminified/Cesium.js",
    path.join(workerDir, cloudWorkers[0]),
    "Build/CesiumUnminified/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
    "Build/CesiumUnminified/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl",
    "Build/CesiumUnminified/Shaders/WebGPU/Environment/CloudUpscale.wgsl",
  ].map(fileFingerprint);
  const buildFingerprint = createHash("sha256");
  for (const file of files) {
    buildFingerprint.update(file.path);
    buildFingerprint.update("\0");
    buildFingerprint.update(file.sha256);
    buildFingerprint.update("\0");
  }

  return {
    commit: command("git", ["rev-parse", "HEAD"]),
    dirty: Boolean(command("git", ["status", "--porcelain"])),
    buildFingerprint: buildFingerprint.digest("hex"),
    files,
  };
}

const CAPTURE_SCENE = async ({ fixedTime, quality }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  const globe = scene.globe;
  const collection = globe.defaultCloudCollection;
  const frameTime = C.JulianDate.fromIso8601(fixedTime);

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = frameTime;
  scene.requestRenderMode = false;
  globe.show = true;
  globe.enableLighting = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.fog) scene.fog.enabled = false;
  scene.backgroundColor = C.Color.BLACK;
  viewer.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95, 39, 800),
    orientation: {
      heading: C.Math.toRadians(90),
      pitch: C.Math.toRadians(25),
      roll: 0,
    },
  });

  const volumetric = {
    cloudCoverage: 0.6,
    cloudDensity: 0.85,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudVolumetricQuality: quality,
    cloudWeatherMap: false,
    cloudWindSpeed: 0,
  };
  const configTruth = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric,
  });
  const readiness = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime,
  });

  const renderFrames = async (count) => {
    for (let frame = 0; frame < count; frame++) {
      scene.render(frameTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  const capture = () => {
    // Render and copy in the same task. Reading a relinquished WebGPU
    // presentation texture later can produce a misleading all-zero PNG.
    scene.render(frameTime);
    return scene.canvas.toDataURL("image/png");
  };

  collection.enableVolumetric = false;
  await renderFrames(2);
  const off = capture();

  const onTruth = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric,
  });
  const cache = scene.context._cloudCache;
  if (!cache) {
    throw new Error("cloud renderer cache disappeared after readiness");
  }

  // Both old (&15) and new (&63) counter expressions advance -1 to phase 0.
  // firstFrame makes the temporal resolve emit the freshly marched image rather
  // than stale warm-up history.
  cache.frameCounter = -1;
  cache.temporalFirstFrame = true;
  const single = capture();
  const singleRealization = globalThis.__cloudProbe.proceduralRealization();

  // Including `single`, the settled capture is the 32nd authored cloud frame.
  await renderFrames(30);
  const settled = capture();
  const realization = globalThis.__cloudProbe.proceduralRealization();
  const device = scene.context.device || scene.context._device;
  if (device) {
    await device.queue.onSubmittedWorkDone();
  }

  return {
    off,
    single,
    settled,
    configTruth,
    onTruth,
    readiness,
    singleRealization,
    realization,
    effectiveTimeIso: C.JulianDate.toIso8601(frameTime),
    hasDevice: Boolean(device),
    adapterInfo: scene.context.adapter?.info
      ? {
          vendor: scene.context.adapter.info.vendor || "",
          architecture: scene.context.adapter.info.architecture || "",
          device: scene.context.adapter.info.device || "",
          description: scene.context.adapter.info.description || "",
        }
      : null,
    canvas: {
      width: scene.canvas.width,
      height: scene.canvas.height,
    },
  };
};

const ANALYZE_IMAGES = async ({ current, other, currentTag }) => {
  const decode = async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  };

  const cloudSignal = (on, off) => {
    if (on.width !== off.width || on.height !== off.height) {
      throw new Error("ON/OFF cloud images have different dimensions");
    }
    const signal = new Float32Array(on.width * on.height);
    for (let pixel = 0; pixel < signal.length; pixel++) {
      const offset = pixel * 4;
      const onLuma =
        (0.2126 * on.pixels[offset] +
          0.7152 * on.pixels[offset + 1] +
          0.0722 * on.pixels[offset + 2]) /
        255;
      const offLuma =
        (0.2126 * off.pixels[offset] +
          0.7152 * off.pixels[offset + 1] +
          0.0722 * off.pixels[offset + 2]) /
        255;
      signal[pixel] = Math.abs(onLuma - offLuma);
    }
    return signal;
  };

  const boxBlur = (source, width, height, radius) => {
    const stride = width + 1;
    const integral = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      for (let x = 0; x < width; x++) {
        rowSum += source[y * width + x];
        integral[(y + 1) * stride + x + 1] =
          integral[y * stride + x + 1] + rowSum;
      }
    }

    const blurred = new Float32Array(source.length);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width - 1, x + radius);
        const sum =
          integral[(y1 + 1) * stride + x1 + 1] -
          integral[y0 * stride + x1 + 1] -
          integral[(y1 + 1) * stride + x0] +
          integral[y0 * stride + x0];
        blurred[y * width + x] =
          sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
      }
    }
    return blurred;
  };

  const buildMasks = (signal, width, height) => {
    const raw = new Uint8Array(signal.length);
    const body = new Uint8Array(signal.length);
    const threshold = 6 / 255;
    for (let index = 0; index < signal.length; index++) {
      raw[index] = signal[index] > threshold ? 1 : 0;
    }

    // Remove a two-pixel silhouette band so the cloud boundary itself cannot
    // dominate the ray-step contour score.
    const radius = 2;
    for (let y = radius; y < height - radius; y++) {
      for (let x = radius; x < width - radius; x++) {
        let inside = true;
        for (let oy = -radius; oy <= radius && inside; oy++) {
          for (let ox = -radius; ox <= radius; ox++) {
            if (raw[(y + oy) * width + x + ox] === 0) {
              inside = false;
              break;
            }
          }
        }
        if (inside) body[y * width + x] = 1;
      }
    }
    return { raw, body };
  };

  const summarize = (on, off) => {
    const width = on.width;
    const height = on.height;
    const signal = cloudSignal(on, off);
    const { raw, body } = buildMasks(signal, width, height);
    const blurred = boxBlur(signal, width, height, 2);
    const jumps = new Uint8Array(signal.length);
    const jumpThreshold = 12 / 255;
    let bodyPixels = 0;
    let rawMaskPixels = 0;
    let signalSum = 0;
    let highFrequencySum = 0;

    for (let index = 0; index < signal.length; index++) {
      if (raw[index]) rawMaskPixels++;
      if (!body[index]) continue;
      bodyPixels++;
      signalSum += signal[index];
      highFrequencySum += Math.abs(signal[index] - blurred[index]);
    }
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const index = y * width + x;
        if (!body[index]) continue;
        const dx = Math.abs(blurred[index + 1] - blurred[index]);
        const dy = Math.abs(blurred[index + width] - blurred[index]);
        if (Math.max(dx, dy) > jumpThreshold) jumps[index] = 1;
      }
    }

    // Connected low-pass jumps distinguish a long ordered contour from isolated
    // per-pixel dither. Eight-connectivity retains diagonal/radial bands.
    const visited = new Uint8Array(signal.length);
    const queue = new Int32Array(signal.length);
    let coherentJumpPixels = 0;
    let coherentComponents = 0;
    let largestComponent = 0;
    for (let start = 0; start < jumps.length; start++) {
      if (!jumps[start] || visited[start]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const neighbor = ny * width + nx;
            if (jumps[neighbor] && !visited[neighbor]) {
              visited[neighbor] = 1;
              queue[tail++] = neighbor;
            }
          }
        }
      }
      largestComponent = Math.max(largestComponent, tail);
      if (tail >= 8) {
        coherentComponents++;
        coherentJumpPixels += tail;
      }
    }

    return {
      width,
      height,
      bodyPixels,
      rawMaskPixels,
      meanCloudSignal: bodyPixels ? signalSum / bodyPixels : 0,
      highFrequencyEnergy: bodyPixels ? highFrequencySum / bodyPixels : 0,
      coherentJumpPixels,
      coherentComponents,
      largestComponent,
      coherentJumpDensity: bodyPixels
        ? coherentJumpPixels / bodyPixels
        : 0,
      rawMask: raw,
    };
  };

  const decodeSet = async (set) => {
    const [off, single, settled] = await Promise.all([
      decode(set.off),
      decode(set.single),
      decode(set.settled),
    ]);
    return {
      off,
      single,
      settled,
      singleSummary: summarize(single, off),
      settledSummary: summarize(settled, off),
    };
  };
  const publicSummary = (summary) => {
    const publicFields = { ...summary };
    delete publicFields.rawMask;
    return publicFields;
  };
  const compareFrames = (left, right) => {
    if (left.width !== right.width || left.height !== right.height) {
      throw new Error("compared cloud frames have different dimensions");
    }
    let differentPixels = 0;
    let absoluteChannelDelta = 0;
    let maxChannelDelta = 0;
    for (let offset = 0; offset < left.pixels.length; offset += 4) {
      let pixelDiffers = false;
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(
          left.pixels[offset + channel] - right.pixels[offset + channel],
        );
        absoluteChannelDelta += delta;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        pixelDiffers ||= delta !== 0;
      }
      if (pixelDiffers) differentPixels++;
    }
    return {
      differentPixels,
      differentPixelFraction:
        differentPixels / (left.width * left.height),
      meanAbsoluteChannelDelta:
        absoluteChannelDelta / left.pixels.length / 255,
      maxChannelDelta,
    };
  };
  const currentDecoded = await decodeSet(current);
  const result = {
    current: {
      single: publicSummary(currentDecoded.singleSummary),
      settled: publicSummary(currentDecoded.settledSummary),
      singleToSettled: compareFrames(
        currentDecoded.single,
        currentDecoded.settled,
      ),
    },
    comparison: null,
  };
  if (!other) return result;

  const otherDecoded = await decodeSet(other);
  const before =
    currentTag === "before" ? currentDecoded : otherDecoded;
  const after =
    currentTag === "after" ? currentDecoded : otherDecoded;
  const beforeMask = before.settledSummary.rawMask;
  const afterMask = after.settledSummary.rawMask;
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < beforeMask.length; index++) {
    if (beforeMask[index] && afterMask[index]) intersection++;
    if (beforeMask[index] || afterMask[index]) union++;
  }

  const singleRatio =
    after.singleSummary.coherentJumpDensity /
    Math.max(before.singleSummary.coherentJumpDensity, 1e-9);
  const settledRatio =
    after.settledSummary.coherentJumpDensity /
    Math.max(before.settledSummary.coherentJumpDensity, 1e-9);
  const settledHighFrequencyRatio =
    after.settledSummary.highFrequencyEnergy /
    Math.max(before.settledSummary.highFrequencyEnergy, 1e-9);
  const silhouetteJaccard = intersection / Math.max(union, 1);
  const meanSignalDelta = Math.abs(
    after.settledSummary.meanCloudSignal -
      before.settledSummary.meanCloudSignal,
  );
  const checks = [
    {
      name: "single-frame coherent band density falls by at least 50%",
      passed: singleRatio <= 0.5,
      value: singleRatio,
      limit: 0.5,
    },
    {
      name: "settled coherent band density does not regress",
      passed: settledRatio <= 1.0,
      value: settledRatio,
      limit: 1.0,
    },
    {
      name: "cloud contribution silhouette is preserved",
      passed: silhouetteJaccard >= 0.95,
      value: silhouetteJaccard,
      limit: 0.95,
    },
    {
      name: "settled mean cloud signal remains bounded",
      passed: meanSignalDelta <= 0.03,
      value: meanSignalDelta,
      limit: 0.03,
    },
    {
      name: "settled high-frequency residue remains bounded",
      passed:
        after.settledSummary.highFrequencyEnergy <=
        Math.max(
          before.settledSummary.highFrequencyEnergy * 1.25,
          before.settledSummary.highFrequencyEnergy + 0.002,
        ),
      value: settledHighFrequencyRatio,
      limit: 1.25,
    },
  ];
  result.comparison = {
    before: {
      single: publicSummary(before.singleSummary),
      settled: publicSummary(before.settledSummary),
    },
    after: {
      single: publicSummary(after.singleSummary),
      settled: publicSummary(after.settledSummary),
    },
    singleCoherentDensityRatio: singleRatio,
    settledCoherentDensityRatio: settledRatio,
    settledHighFrequencyRatio,
    silhouetteJaccard,
    meanSignalDelta,
    checks,
    passed: checks.every((check) => check.passed),
  };
  return result;
};

function dataUrlFromFile(filePath) {
  return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function artifactPath(tag, phase) {
  return path.join(
    OUT_DIR,
    `cloud-banding-${QUALITY}-${tag}-${phase}.png`,
  );
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const source = sourceProvenance();
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
    if (message.type() === "error") pageErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(`pageerror: ${error.message}`);
  });
  await page.addInitScript(errorGateInit);
  await installCloudProbeHarnessOnPage(page);
  await page.goto(URL, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(
    () => Boolean(globalThis.viewer),
    undefined,
    { timeout: 90_000 },
  );
  const armState = await armWebGPUDevices(page);
  const capture = await page.evaluate(CAPTURE_SCENE, {
    fixedTime: FIXED_TIME,
    quality: QUALITY,
  });

  for (const phase of ["off", "single", "settled"]) {
    fs.writeFileSync(
      artifactPath(TAG, phase),
      Buffer.from(capture[phase].split(",")[1], "base64"),
    );
  }
  const artifactFingerprints = Object.fromEntries(
    ["off", "single", "settled"].map((phase) => [
      phase,
      fileFingerprint(artifactPath(TAG, phase)),
    ]),
  );

  const currentImages = {
    off: capture.off,
    single: capture.single,
    settled: capture.settled,
  };
  const currentAnalysis = await page.evaluate(ANALYZE_IMAGES, {
    current: currentImages,
    other: null,
    currentTag: TAG,
  });

  const otherTag = TAG === "before" ? "after" : "before";
  const otherJsonPath = path.join(
    OUT_DIR,
    `cloud-banding-${QUALITY}-${otherTag}.json`,
  );
  let otherRecord = null;
  let comparison = {
    status: PAIR_ID === null ? "not-requested" : "missing-companion",
    pairId: PAIR_ID,
    otherTag,
  };
  if (fs.existsSync(otherJsonPath)) {
    otherRecord = JSON.parse(fs.readFileSync(otherJsonPath, "utf8"));
    const requiredOtherArtifacts = ["off", "single", "settled"].map((phase) =>
      artifactPath(otherTag, phase),
    );
    const reasons = [];
    if (PAIR_ID === null) reasons.push("no CLOUD_BANDING_PAIR_ID requested");
    if (otherRecord.probeVersion !== PROBE_VERSION)
      reasons.push("probe version differs");
    if (otherRecord.pairId !== PAIR_ID) reasons.push("pair ID differs");
    if (
      JSON.stringify(otherRecord.configTruth?.config) !==
      JSON.stringify(capture.configTruth.config)
    ) {
      reasons.push("cloud configuration differs");
    }
    if (
      JSON.stringify(otherRecord.adapterInfo) !==
      JSON.stringify(capture.adapterInfo)
    ) {
      reasons.push("GPU adapter differs");
    }
    if (otherRecord.browserVersion !== browserVersion)
      reasons.push("browser version differs");
    if (
      JSON.stringify(otherRecord.canvas) !== JSON.stringify(capture.canvas)
    ) {
      reasons.push("canvas dimensions differ");
    }
    if (
      otherRecord.source?.buildFingerprint === source.buildFingerprint
    ) {
      reasons.push("cloud build fingerprint is identical");
    }
    if (!requiredOtherArtifacts.every((filePath) => fs.existsSync(filePath))) {
      reasons.push("companion PNG set is incomplete");
    } else {
      for (const [phase, filePath] of [
        ["off", requiredOtherArtifacts[0]],
        ["single", requiredOtherArtifacts[1]],
        ["settled", requiredOtherArtifacts[2]],
      ]) {
        const recorded = otherRecord.artifacts?.[phase];
        const actual = fileFingerprint(filePath);
        if (
          recorded?.sha256 !== actual.sha256 ||
          recorded?.byteLength !== actual.byteLength
        ) {
          reasons.push(`companion ${phase} PNG differs from its manifest`);
        }
      }
    }

    if (reasons.length === 0) {
      const pairedAnalysis = await page.evaluate(ANALYZE_IMAGES, {
        current: currentImages,
        other: {
          off: dataUrlFromFile(artifactPath(otherTag, "off")),
          single: dataUrlFromFile(artifactPath(otherTag, "single")),
          settled: dataUrlFromFile(artifactPath(otherTag, "settled")),
        },
        currentTag: TAG,
      });
      comparison = {
        status: "compared",
        pairId: PAIR_ID,
        otherTag,
        ...pairedAnalysis.comparison,
      };
    } else if (PAIR_ID !== null) {
      comparison = {
        status: "noncomparable-companion",
        pairId: PAIR_ID,
        otherTag,
        reasons,
      };
    }
  }

  const gpuGate = await collectGateErrors(page);
  await browser.close();
  const errors = [
    ...pageErrors,
    ...gpuConsoleErrors,
    ...gpuGate.errors,
    ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
    ...(armState.found < 1
      ? ["WebGPU error gate did not find a device"]
      : []),
  ].filter(
    (error) =>
      !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(error),
  );
  const uniqueErrors = [...new Set(errors)];
  const flags = Math.trunc(capture.realization.qualityFlags ?? 0);
  const halfResEnabled = (flags & HALF_RES_BIT) !== 0;
  const temporalEnabled = (flags & TEMPORAL_BIT) !== 0;
  const jitterEnabled = (flags & JITTER_BIT) !== 0;
  const expectedJitterEnabled = TAG === "after";
  const temporalQuality = QUALITY === "low";
  const artifactValid =
    capture.configTruth.ok === true &&
    capture.onTruth.ok === true &&
    capture.readiness.ok === true &&
    capture.readiness.executeCalls > 0 &&
    capture.realization.initialized === true &&
    capture.realization.pipelineReady === true &&
    capture.realization.maxSteps === (temporalQuality ? 24 : 96) &&
    capture.realization.halfWidth ===
      (temporalQuality ? capture.canvas.width * 0.5 : 0) &&
    capture.realization.halfHeight ===
      (temporalQuality ? capture.canvas.height * 0.5 : 0) &&
    capture.realization.temporalWidth ===
      (temporalQuality ? capture.canvas.width * 0.5 : 0) &&
    capture.realization.temporalHeight ===
      (temporalQuality ? capture.canvas.height * 0.5 : 0) &&
    halfResEnabled === temporalQuality &&
    temporalEnabled === temporalQuality &&
    (temporalQuality ||
      currentAnalysis.current.singleToSettled.differentPixels === 0) &&
    currentAnalysis.current.single.bodyPixels > 5000 &&
    currentAnalysis.current.settled.bodyPixels > 5000 &&
    jitterEnabled === expectedJitterEnabled &&
    capture.hasDevice &&
    capture.adapterInfo !== null &&
    uniqueErrors.length === 0;
  const comparisonPassed =
    comparison.status === "compared"
      ? comparison.passed === true &&
        artifactValid &&
        otherRecord?.artifactValid === true
      : null;

  const record = {
    probeVersion: PROBE_VERSION,
    measurementKind: "visual-quality-cloud-ray-banding",
    explicitlyNotPerformanceEvidence: true,
    pairId: PAIR_ID,
    tag: TAG,
    quality: QUALITY,
    source,
    artifacts: artifactFingerprints,
    browserVersion,
    adapterInfo: capture.adapterInfo,
    canvas: capture.canvas,
    fixedTime: capture.effectiveTimeIso,
    configTruth: capture.configTruth,
    onTruth: capture.onTruth,
    readiness: capture.readiness,
    singleRealization: capture.singleRealization,
    realization: capture.realization,
    expectedJitterEnabled,
    halfResEnabled,
    temporalEnabled,
    jitterEnabled,
    metrics: currentAnalysis.current,
    comparison,
    limitations: [
      "The first-frame capture forces cache.frameCounter=-1 and temporalFirstFrame=true; it isolates a deterministic sample but does not certify production history invalidation.",
      temporalQuality
        ? "The settled low-quality capture includes the current half-resolution Bayer UV sequence, temporal reprojection, history clamp, and blend; it cannot attribute every settled-frame difference to IGN alone."
        : "The high-quality route is full-resolution and temporal-off; it characterizes static spatial IGN but not temporal reconstruction.",
      "For high quality, exact single/settled identity certifies only this fixed-camera, fixed-time, zero-wind full-resolution route.",
      "Cloud-aware god rays are disabled, so fragmentCloudMaskMain and its intentionally unjittered mask march are not exercised.",
      "The coherent-contour metric is a provisional banding oracle and does not certify baked-noise periodicity, regional variety, or complete cloud appearance.",
      "No CPU/GPU duration is measured; these artifacts are not performance evidence.",
    ],
    gpuGate: {
      ...gpuGate,
      armState,
    },
    errors: uniqueErrors,
    artifactValid,
  };
  const jsonPath = path.join(
    OUT_DIR,
    `cloud-banding-${QUALITY}-${TAG}.json`,
  );
  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2));

  console.log(
    `[cloud-banding:${QUALITY}:${TAG}] artifact=${artifactValid ? "VALID" : "INVALID"} ` +
      `jitter=${jitterEnabled} expected=${expectedJitterEnabled} ` +
      `singleDensity=${record.metrics.single.coherentJumpDensity.toFixed(6)} ` +
      `settledDensity=${record.metrics.settled.coherentJumpDensity.toFixed(6)}`,
  );
  console.log(
    `[cloud-banding:${QUALITY}:${TAG}] comparison=${comparison.status} manifest=${jsonPath}`,
  );
  if (comparison.status === "compared") {
    for (const check of comparison.checks) {
      console.log(
        `  [${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.value}`,
      );
    }
    console.log(
      `BANDING RESULT: ${comparisonPassed ? "GREEN" : "RED"} (manual PNG inspection still required)`,
    );
  } else if (comparison.status !== "not-requested") {
    console.log(
      `BANDING RESULT: RED (${comparison.status}; requested pairs fail closed)`,
    );
  } else {
    console.log(
      "BANDING RESULT: characterization only (no paired improvement claim)",
    );
  }

  const processPassed =
    artifactValid &&
    (PAIR_ID === null ||
      (comparison.status === "compared" && comparisonPassed === true));
  process.exitCode = processPassed ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
