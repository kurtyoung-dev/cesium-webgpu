#!/usr/bin/env node
/**
 * Campaign 13 planetary cloud oracle. WebGPU-only.
 *
 * Unlike the older bright-pixel heuristic, this probe renders every checkpoint
 * twice at the same camera and authored JulianDate: volumetric clouds OFF, then
 * ON. The resulting raw-canvas delta isolates cloud contribution from terrain,
 * atmosphere, and sky color. Camera checkpoints are visited in route order, so
 * the renderer also experiences antimeridian crossings, pole approaches, and
 * altitude transitions instead of certifying disconnected static screenshots.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-planetary.mjs
 *   CLOUD_PLANETARY_ROUTES=antimeridian,north-pole node Tools/visual-regression/probe-cloud-planetary.mjs
 *   CLOUD_RTE_MODE=on node Tools/visual-regression/probe-cloud-planetary.mjs
 *   CLOUD_PLANETARY_TRANSITION_FRAMES=12 node Tools/visual-regression/probe-cloud-planetary.mjs
 *
 * CLOUD_RTE_MODE:
 *   default  Do not author cloudHighPrecision; certify the public default.
 *   on       Explicitly exercise the high/low RTE path.
 *   off      Explicitly exercise the retained legacy A/B fallback.
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
const OUT_DIR = "Tools/visual-regression/output/cloud-planetary";
const RTE_MODE = process.env.CLOUD_RTE_MODE || "default";
const ONLY_ROUTES = (process.env.CLOUD_PLANETARY_ROUTES || "")
  .split(",")
  .filter(Boolean);
const TRANSITION_FRAMES = Number.parseInt(
  process.env.CLOUD_PLANETARY_TRANSITION_FRAMES || "12",
  10,
);

if (!["default", "on", "off"].includes(RTE_MODE)) {
  throw new Error(
    `Unknown CLOUD_RTE_MODE=${RTE_MODE}; expected default, on, or off`,
  );
}
if (!Number.isInteger(TRANSITION_FRAMES) || TRANSITION_FRAMES < 1) {
  throw new Error("CLOUD_PLANETARY_TRANSITION_FRAMES must be a positive integer");
}

const ROUTES = [
  {
    name: "antimeridian",
    description: "continuous eastbound crossing through +180 degrees",
    checkpoints: [
      { lon: 179.2, lat: 10, height: 9000, heading: 90, pitch: -5 },
      { lon: 179.8, lat: 10, height: 9000, heading: 90, pitch: -5 },
      { lon: 180.2, lat: 10, height: 9000, heading: 90, pitch: -5 },
      { lon: 180.8, lat: 10, height: 9000, heading: 90, pitch: -5 },
    ],
  },
  {
    name: "north-pole",
    description: "north-pole approach plus longitude wrap near the pole",
    checkpoints: [
      { lon: 45, lat: 84, height: 20000, heading: 0, pitch: -30 },
      { lon: 45, lat: 88, height: 20000, heading: 0, pitch: -30 },
      { lon: 45, lat: 89.5, height: 20000, heading: 0, pitch: -30 },
      { lon: 135, lat: 89.5, height: 20000, heading: 90, pitch: -30 },
      { lon: 225, lat: 89.5, height: 20000, heading: 180, pitch: -30 },
      { lon: 315, lat: 89.5, height: 20000, heading: 270, pitch: -30 },
    ],
  },
  {
    name: "south-pole",
    description: "south-pole approach plus longitude wrap near the pole",
    checkpoints: [
      { lon: -45, lat: -84, height: 20000, heading: 180, pitch: -30 },
      { lon: -45, lat: -88, height: 20000, heading: 180, pitch: -30 },
      { lon: -45, lat: -89.5, height: 20000, heading: 180, pitch: -30 },
      { lon: -135, lat: -89.5, height: 20000, heading: 270, pitch: -30 },
      { lon: -225, lat: -89.5, height: 20000, heading: 0, pitch: -30 },
      { lon: -315, lat: -89.5, height: 20000, heading: 90, pitch: -30 },
    ],
  },
  {
    name: "altitude",
    description: "ground, inside-deck, above-deck, regional, and orbit views",
    checkpoints: [
      { lon: -95, lat: 39, height: 800, heading: 0, pitch: 10 },
      { lon: -95, lat: 39, height: 2200, heading: 0, pitch: 0 },
      { lon: -95, lat: 39, height: 9000, heading: 20, pitch: -25 },
      { lon: -95, lat: 39, height: 200000, heading: 20, pitch: -40 },
      {
        lon: -95,
        lat: 39,
        height: 18000000,
        heading: 0,
        pitch: -90,
        minChangedPixels: 16,
      },
    ],
  },
];

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

function selectedRoutes() {
  const unknown = ONLY_ROUTES.filter(
    (name) => !ROUTES.some((route) => route.name === name),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown CLOUD_PLANETARY_ROUTES: ${unknown.join(", ")}`);
  }
  return ONLY_ROUTES.length
    ? ROUTES.filter((route) => ONLY_ROUTES.includes(route.name))
    : ROUTES;
}

async function configureScene(page) {
  return page.evaluate(
    async ({ rteMode }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = globalThis.viewer;
      const scene = viewer.scene;
      const frameTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");

      viewer.useDefaultRenderLoop = false;
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = frameTime;
      scene.requestRenderMode = false;
      scene.globe.show = true;
      scene.globe.enableLighting = true;
      scene.skyBox.show = true;
      scene.sun.show = true;
      scene.skyAtmosphere.show = true;

      const volumetric = {
        cloudCoverage: 0.65,
        cloudDensity: 0.9,
        cloudLayerBottom: 1500,
        cloudLayerTop: 4000,
        cloudVolumetricQuality: "high",
        cloudWeatherMap: false,
        cloudWindSpeed: 0,
      };
      if (rteMode !== "default") {
        volumetric.cloudHighPrecision = rteMode === "on";
      }
      const configTruth = globalThis.__cloudProbe.configure({
        requireWebGPU: true,
        volumetric,
      });

      globalThis.__cloudPlanetary = {
        C,
        viewer,
        scene,
        frameTime,
        volumetric,
      };

      const readiness = await globalThis.__cloudProbe.awaitProceduralReady({
        featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
        frameTime,
      });

      return {
        configTruth,
        readiness,
        effectiveCloudHighPrecision:
          scene.globe.defaultCloudCollection.volumetric.cloudHighPrecision,
        effectiveTimeIso: C.JulianDate.toIso8601(frameTime),
      };
    },
    { rteMode: RTE_MODE },
  );
}

async function measureCheckpoint(page, checkpoint, previousCheckpoint) {
  return page.evaluate(async (inputs) => {
    const { checkpoint, previousCheckpoint, transitionFrames } = inputs;
    const state = globalThis.__cloudPlanetary;
    const { C, viewer, scene, frameTime, volumetric } = state;

    const collection = scene.globe.defaultCloudCollection;
    const renderFrames = async (count) => {
      for (let i = 0; i < count; i++) {
        scene.render(frameTime);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };
    const setCamera = (view) => {
      viewer.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon,
          view.lat,
          view.height,
        ),
        orientation: {
          heading: C.Math.toRadians(view.heading),
          pitch: C.Math.toRadians(view.pitch),
          roll: 0,
        },
      });
    };
    const shortestDegrees = (from, to) =>
      ((((to - from) % 360) + 540) % 360) - 180;
    const interpolateHeight = (from, to, amount) =>
      Math.exp(
        Math.log(Math.max(1, from + 1)) * (1 - amount) +
          Math.log(Math.max(1, to + 1)) * amount,
      ) - 1;

    // Keep the cloud pass active while traversing every route segment. This is
    // deterministic setView interpolation rather than a collection of
    // disconnected teleport screenshots, so antimeridian/pole/altitude math is
    // exercised on the intermediate frames as well as at the checkpoints.
    collection.enableVolumetric = true;
    if (previousCheckpoint) {
      const lonDelta = shortestDegrees(
        previousCheckpoint.lon,
        checkpoint.lon,
      );
      const headingDelta = shortestDegrees(
        previousCheckpoint.heading,
        checkpoint.heading,
      );
      for (let frame = 1; frame <= transitionFrames; frame++) {
        const linear = frame / transitionFrames;
        const amount = linear * linear * (3 - 2 * linear);
        setCamera({
          lon: previousCheckpoint.lon + lonDelta * amount,
          lat:
            previousCheckpoint.lat +
            (checkpoint.lat - previousCheckpoint.lat) * amount,
          height: interpolateHeight(
            previousCheckpoint.height,
            checkpoint.height,
            amount,
          ),
          heading: previousCheckpoint.heading + headingDelta * amount,
          pitch:
            previousCheckpoint.pitch +
            (checkpoint.pitch - previousCheckpoint.pitch) * amount,
        });
        await renderFrames(1);
      }
    } else {
      setCamera(checkpoint);
    }

    const readCanvas = async () => {
      scene.render(frameTime);
      const canvas = scene.canvas;
      const dataUrl = canvas.toDataURL("image/png");
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context2d = copy.getContext("2d");
      context2d.drawImage(image, 0, 0);
      return {
        dataUrl,
        pixels: context2d.getImageData(
          0,
          0,
          copy.width,
          copy.height,
        ).data,
        width: copy.width,
        height: copy.height,
      };
    };

    // Settle the final camera before the paired OFF/ON contribution capture.
    await renderFrames(8);

    collection.enableVolumetric = false;
    await renderFrames(2);
    const off = await readCanvas();

    const truth = globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric,
    });
    await renderFrames(8);
    const on = await readCanvas();

    let changedPixels = 0;
    let totalAbsDelta = 0;
    let maxChannelDelta = 0;
    for (let i = 0; i < on.pixels.length; i += 4) {
      const dr = Math.abs(on.pixels[i] - off.pixels[i]);
      const dg = Math.abs(on.pixels[i + 1] - off.pixels[i + 1]);
      const db = Math.abs(on.pixels[i + 2] - off.pixels[i + 2]);
      const sum = dr + dg + db;
      totalAbsDelta += sum;
      maxChannelDelta = Math.max(maxChannelDelta, dr, dg, db);
      if (sum > 18) {
        changedPixels++;
      }
    }

    const camera = viewer.camera.positionCartographic;
    return {
      truth,
      requested: checkpoint,
      transition: {
        kind: previousCheckpoint ? "interpolated" : "initial-set",
        frames: previousCheckpoint ? transitionFrames : 0,
        from: previousCheckpoint,
      },
      realized: {
        longitudeDegrees: C.Math.toDegrees(camera.longitude),
        latitudeDegrees: C.Math.toDegrees(camera.latitude),
        height: camera.height,
      },
      width: on.width,
      height: on.height,
      changedPixels,
      changedFraction: changedPixels / Math.max(1, on.width * on.height),
      meanAbsRgbDelta:
        totalAbsDelta / Math.max(1, on.width * on.height * 3),
      maxChannelDelta,
      onDataUrl: on.dataUrl,
      offDataUrl: off.dataUrl,
    };
  }, { checkpoint, previousCheckpoint, transitionFrames: TRANSITION_FRAMES });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runtimeBundlePath = "Build/CesiumUnminified/Cesium.js";
  const runtimeBundle = fs.readFileSync(runtimeBundlePath);
  const source = {
    commit: command("git", ["rev-parse", "HEAD"]),
    dirty: Boolean(command("git", ["status", "--porcelain"])),
    runtimeBundle: {
      path: runtimeBundlePath,
      byteLength: runtimeBundle.byteLength,
      sha256: createHash("sha256").update(runtimeBundle).digest("hex"),
    },
  };
  const routes = selectedRoutes();
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const routeSet = ONLY_ROUTES.length
    ? routes.map((route) => route.name).join("_")
    : "all";
  const artifactSet = `${RTE_MODE}-${routeSet}`;
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
  await page.addInitScript(errorGateInit);
  await installCloudProbeHarnessOnPage(page);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(() => !!globalThis.viewer, { timeout: 90_000 });
  const armState = await armWebGPUDevices(page);
  const setup = await configureScene(page);

  const results = [];
  for (const route of routes) {
    console.log(`\n--- ${route.name}: ${route.description} ---`);
    let previousCheckpoint;
    for (let index = 0; index < route.checkpoints.length; index++) {
      const checkpoint = route.checkpoints[index];
      const measured = await measureCheckpoint(
        page,
        checkpoint,
        previousCheckpoint,
      );
      previousCheckpoint = checkpoint;
      const minChangedPixels = checkpoint.minChangedPixels ?? 250;
      const visible = measured.changedPixels >= minChangedPixels;
      const baseName = `cloud-planetary-${artifactSet}-${route.name}-${String(
        index,
      ).padStart(2, "0")}`;
      fs.writeFileSync(
        path.join(OUT_DIR, `${baseName}-on.png`),
        Buffer.from(measured.onDataUrl.split(",")[1], "base64"),
      );
      fs.writeFileSync(
        path.join(OUT_DIR, `${baseName}-off.png`),
        Buffer.from(measured.offDataUrl.split(",")[1], "base64"),
      );
      delete measured.onDataUrl;
      delete measured.offDataUrl;
      results.push({
        route: route.name,
        index,
        minChangedPixels,
        visible,
        ...measured,
      });
      console.log(
        `  ${index}: lon=${measured.realized.longitudeDegrees.toFixed(3)} lat=${measured.realized.latitudeDegrees.toFixed(3)} h=${measured.realized.height.toFixed(1)}m delta=${measured.changedPixels}px mean=${measured.meanAbsRgbDelta.toFixed(3)} visible=${visible}`,
      );
    }
  }

  const gpuGate = await collectGateErrors(page);
  await browser.close();

  const errors = [
    ...pageErrors,
    ...gpuConsoleErrors,
    ...gpuGate.errors,
    ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
    ...(armState.found < 1 ? ["WebGPU error gate did not find a device"] : []),
  ].filter((error) => !/AtmosphereLUT|default layout|favicon/.test(error));
  const uniqueErrors = [...new Set(errors)];
  const failedCheckpoints = results.filter(
    (result) => !result.visible || !result.truth.ok,
  );
  const manifest = {
    probeVersion: "c13-03",
    rteMode: RTE_MODE,
    artifactSet,
    transitionFrames: TRANSITION_FRAMES,
    url: URL,
    source,
    setup,
    gpuGate: { ...gpuGate, armState },
    errors: uniqueErrors,
    routes: routes.map(({ name, description }) => ({ name, description })),
    results,
    pass: uniqueErrors.length === 0 && failedCheckpoints.length === 0,
  };
  const manifestPath = path.join(
    OUT_DIR,
    `cloud-planetary-${artifactSet}-truth.json`,
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nTruth manifest: ${manifestPath}`);
  console.log(
    `RESULT: ${manifest.pass ? "GREEN" : "RED"} (${failedCheckpoints.length} checkpoint failures, ${uniqueErrors.length} errors)`,
  );
  if (failedCheckpoints.length > 0) {
    console.log(
      `Failed checkpoints: ${failedCheckpoints
        .map((result) => `${result.route}[${result.index}]`)
        .join(", ")}`,
    );
  }
  if (uniqueErrors.length > 0) {
    console.log(`Errors: ${uniqueErrors.slice(0, 8).join("\n")}`);
  }
  process.exitCode = manifest.pass ? 0 : 1;
}

await main();
