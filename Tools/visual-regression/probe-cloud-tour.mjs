#!/usr/bin/env node
/**
 * Cloud tour — a reusable, data-driven camera-tour harness that captures BOTH of
 * this fork's cloud systems across cloud "types", planet locations, view angles,
 * and times of day. Procedural clouds are WebGPU-only; billboard clouds are
 * captured on both WebGPU and WebGL for renderer parity.
 *
 * TWO CLOUD SYSTEMS:
 *   - "procedural": the Schneider volumetric raymarcher (globe.defaultCloudCollection.enableVolumetric,
 *     ProceduralClouds.wgsl). Cloud "type" is shaped by coverage / density /
 *     layer-altitude — scattered-cumulus → broken → overcast-stratus presets.
 *   - "billboard": a CloudCollection of CumulusCloud puffs (CloudCollection.wgsl)
 *     — discrete placed volumetric-FS cloud billboards.
 *
 * TIME OF DAY drives the sun direction (viewer.clock.currentTime), which the
 * raymarcher reads as cloud.sunDirection — so dawn/noon/dusk change cloud
 * lighting. Per-scene UTC time is chosen to land the target LOCAL solar time at
 * that scene's longitude (utcHour ≈ localHour − lon/15).
 *
 * DESIGN NOTE — toward the long-term weather-recreation goal: SCENES is a flat
 * data array, so future work can add real cloud-formation presets (stratus,
 * cirrus, cumulonimbus…) or data-driven historical-weather scenes without
 * touching the capture loop. This harness is also a general camera-tour
 * template reusable for non-cloud features.
 *
 * OUTPUT: one PNG per (scene × backend) under output/cloud-tour/, plus a console
 * summary table of cloud-pixel metrics. Re-run after a cloud change (e.g. a
 * tuned 379a Perlin-Worley) to compare.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-tour.mjs
 *   (optional) TOUR_SCENES=proc-scattered-noon-up,billboard-cumulus-dusk  # subset
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

// ── HARD watchdog: force-exit if anything hangs (machine safety) ──
// runBackend launches Edge twice and awaits rAF settles / onSubmittedWorkDone
// inside page.evaluate; a GPU hang could otherwise leave headless Edge
// (--enable-unsafe-webgpu) alive forever. Unref'd so it never keeps an
// otherwise-finished process alive.
const HARD_LIMIT_MS = 300000; // 300s
const watchdog = setTimeout(() => {
  console.error("[cloud-tour] WATCHDOG FIRED (300s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const ONLY = (process.env.TOUR_SCENES || "").split(",").filter(Boolean);

// ── Scene matrix ──────────────────────────────────────────────────────────
// Each scene: a named (system × type × location × angle × time) combination.
// camera: { lon, lat, height, heading, pitch }. proc: procedural-cloud knobs.
const SCENES = [
  // ---- Procedural volumetric: cloud "types" via coverage/density/layer ----
  {
    name: "proc-scattered-noon-up",
    system: "procedural",
    desc: "scattered cumulus, plains, look-up, noon",
    proc: { coverage: 0.4, density: 0.7, bottom: 1500, top: 3500 },
    camera: { lon: -95, lat: 39, height: 800, heading: 0, pitch: 10 },
    timeIso: "2026-06-21T18:20:00Z",
  },
  {
    name: "proc-broken-noon-oblique",
    system: "procedural",
    desc: "broken clouds, ocean, oblique-from-above, noon",
    proc: { coverage: 0.6, density: 0.9, bottom: 1500, top: 4000 },
    camera: { lon: -150, lat: 25, height: 9000, heading: 20, pitch: -25 },
    timeIso: "2026-06-21T22:00:00Z",
  },
  {
    name: "proc-overcast-noon-horizon",
    system: "procedural",
    desc: "overcast stratus (thin layer), mountains, horizon, noon",
    proc: { coverage: 0.85, density: 1.0, bottom: 1500, top: 2300 },
    camera: { lon: 86.9, lat: 27, height: 3000, heading: 0, pitch: -2 },
    timeIso: "2026-06-21T06:13:00Z",
  },
  {
    name: "proc-scattered-dawn-up",
    system: "procedural",
    desc: "scattered cumulus, plains, look-up, DAWN (low orange sun)",
    proc: { coverage: 0.4, density: 0.7, bottom: 1500, top: 3500 },
    camera: { lon: -95, lat: 39, height: 800, heading: 90, pitch: 10 },
    timeIso: "2026-06-21T12:50:00Z",
  },
  {
    name: "proc-scattered-dusk-up",
    system: "procedural",
    desc: "scattered cumulus, plains, look-up, DUSK",
    proc: { coverage: 0.4, density: 0.7, bottom: 1500, top: 3500 },
    camera: { lon: -95, lat: 39, height: 800, heading: 270, pitch: 10 },
    timeIso: "2026-06-22T00:50:00Z",
  },
  {
    name: "proc-fromspace-noon",
    system: "procedural",
    desc: "cloud layer from altitude, plains, look-down, noon",
    proc: { coverage: 0.5, density: 0.85, bottom: 1500, top: 4000 },
    camera: { lon: -95, lat: 37, height: 200000, heading: 0, pitch: -40 },
    timeIso: "2026-06-21T18:20:00Z",
  },
  {
    name: "proc-dateline-east-horizon",
    system: "procedural",
    desc: "broken clouds, east side of dateline, horizon",
    proc: { coverage: 0.6, density: 0.85, bottom: 1500, top: 4000 },
    minCloudish: 1000,
    camera: { lon: 179.8, lat: 10, height: 9000, heading: 90, pitch: -5 },
    timeIso: "2026-06-21T00:00:00Z",
  },
  {
    name: "proc-dateline-west-horizon",
    system: "procedural",
    desc: "broken clouds, west side of dateline, horizon",
    proc: { coverage: 0.6, density: 0.85, bottom: 1500, top: 4000 },
    minCloudish: 1000,
    camera: { lon: -179.8, lat: 10, height: 9000, heading: 270, pitch: -5 },
    timeIso: "2026-06-21T00:00:00Z",
  },
  {
    name: "proc-north-pole-oblique",
    system: "procedural",
    desc: "broken clouds, near north pole, oblique",
    proc: { coverage: 0.6, density: 0.85, bottom: 1500, top: 4000 },
    minCloudish: 1000,
    camera: { lon: 45, lat: 88, height: 20000, heading: 0, pitch: -30 },
    timeIso: "2026-06-21T12:00:00Z",
  },
  {
    name: "proc-south-pole-oblique",
    system: "procedural",
    desc: "broken clouds, near south pole, oblique",
    proc: { coverage: 0.6, density: 0.85, bottom: 1500, top: 4000 },
    minCloudish: 1000,
    camera: { lon: -45, lat: -88, height: 20000, heading: 180, pitch: -30 },
    timeIso: "2026-06-21T12:00:00Z",
  },
  // ---- Billboard CumulusCloud puffs ----
  {
    name: "billboard-cumulus-noon",
    system: "billboard",
    desc: "CumulusCloud puff cluster, plains, oblique, noon",
    minCloudish: 1000,
    camera: { lon: -95.02, lat: 39, height: 6000, heading: 10, pitch: -18 },
    timeIso: "2026-06-21T18:20:00Z",
  },
  {
    name: "billboard-cumulus-dusk",
    system: "billboard",
    desc: "CumulusCloud puff cluster, plains, oblique, DUSK",
    minCloudish: 1000,
    camera: { lon: -95.02, lat: 39, height: 6000, heading: 10, pitch: -18 },
    timeIso: "2026-06-22T00:50:00Z",
  },
];

async function setupAndCapture(page, scene) {
  return page.evaluate(async (scene) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    v.useDefaultRenderLoop = false;

    // Reset cloud state between scenes and keep requestRenderMode disabled so
    // every capture exercises live rendering rather than an idle frame.
    let configTruth = globalThis.__cloudProbe.configure({
      enableVolumetric: false,
    });
    let readiness = null;
    // Remove any prior CloudCollection.
    const prims = s.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === "CloudCollection")
        prims.remove(p);
    }

    s.skyBox.show = true;
    s.sun.show = true;
    s.skyAtmosphere.show = true;
    s.backgroundColor = C.Color.BLACK;
    s.globe.show = true;

    // Time of day → sun direction.
    v.clock.shouldAnimate = false;
    const frameTime = C.JulianDate.fromIso8601(scene.timeIso);
    v.clock.currentTime = frameTime;

    if (scene.system === "procedural") {
      configTruth = globalThis.__cloudProbe.configure({
        requireWebGPU: true,
        volumetric: {
          cloudCoverage: scene.proc.coverage,
          cloudDensity: scene.proc.density,
          cloudLayerBottom: scene.proc.bottom,
          cloudLayerTop: scene.proc.top,
        },
      });
      readiness = await globalThis.__cloudProbe.awaitProceduralReady({
        featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
        frameTime,
      });
    } else {
      // Billboard CumulusCloud cluster around the camera target.
      const clouds = prims.add(new C.CloudCollection());
      const base = scene.camera;
      const jitter = [
        [0, 0, 0],
        [0.03, 0.02, 200],
        [-0.025, 0.03, -100],
        [0.05, -0.02, 300],
        [-0.04, -0.03, 0],
        [0.01, 0.05, 150],
        [-0.06, 0.0, -50],
      ];
      for (const [dlon, dlat, dh] of jitter) {
        clouds.add({
          position: C.Cartesian3.fromDegrees(
            base.lon + dlon,
            base.lat + dlat,
            1800 + dh,
          ),
          scale: new C.Cartesian2(1800.0, 1100.0),
          maximumSize: new C.Cartesian3(2000.0, 1300.0, 1300.0),
          slice: -1.0,
        });
      }
    }

    // Camera.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        scene.camera.lon,
        scene.camera.lat,
        scene.camera.height,
      ),
      orientation: {
        heading: C.Math.toRadians(scene.camera.heading),
        pitch: C.Math.toRadians(scene.camera.pitch),
        roll: 0.0,
      },
    });

    for (let i = 0; i < 150; i++) {
      s.render(frameTime);
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Capture the raw Cesium canvas before returning to Playwright. Reading
    // the WebGPU presentation canvas through drawImage can produce an all-zero
    // buffer after the current texture has been presented, even though a page
    // screenshot visibly contains the frame. A PNG snapshot gives the metric
    // and saved artifact the same stable source.
    const captureRawCanvas = async () => {
      s.render(frameTime);
      const canvas = s.canvas;
      const dataUrl = canvas.toDataURL("image/png");
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const cx = tmp.getContext("2d");
      cx.drawImage(image, 0, 0);
      return {
        dataUrl,
        width: tmp.width,
        height: tmp.height,
        pixels: cx.getImageData(0, 0, tmp.width, tmp.height).data,
      };
    };

    const onCapture = await captureRawCanvas();
    const px = onCapture.pixels;
    let cloudish = 0,
      lumSum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        gg = px[i + 1],
        b = px[i + 2];
      const mx = Math.max(r, gg, b),
        mn = Math.min(r, gg, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      if (mx > 150 && sat < 0.2) {
        cloudish++;
        lumSum += mx;
      }
    }

    // Neutral/bright-pixel classification is useful for the billboard parity
    // lane but is not a valid procedural visibility oracle: physically lit
    // polar or dusk clouds can be strongly colored. Isolate procedural cloud
    // contribution with a same-camera, same-time OFF/ON delta instead.
    let contributionPixels = null;
    let meanContributionDelta = null;
    if (scene.system === "procedural") {
      globalThis.__cloudProbe.configure({ enableVolumetric: false });
      for (let i = 0; i < 3; i++) {
        s.render(frameTime);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const offCapture = await captureRawCanvas();
      let totalDelta = 0;
      contributionPixels = 0;
      for (let i = 0; i < px.length; i += 4) {
        const sum =
          Math.abs(px[i] - offCapture.pixels[i]) +
          Math.abs(px[i + 1] - offCapture.pixels[i + 1]) +
          Math.abs(px[i + 2] - offCapture.pixels[i + 2]);
        totalDelta += sum;
        if (sum > 18) {
          contributionPixels++;
        }
      }
      meanContributionDelta =
        totalDelta / Math.max(1, onCapture.width * onCapture.height * 3);
    }

    return {
      renderer: s.context?.rendererType,
      configTruth,
      readiness,
      cloudish,
      cloudMeanLum: cloudish ? Math.round(lumSum / cloudish) : 0,
      contributionPixels,
      meanContributionDelta,
      width: onCapture.width,
      height: onCapture.height,
      effectiveTimeIso: C.JulianDate.toIso8601(frameTime),
      dataUrl: onCapture.dataUrl,
    };
  }, scene);
}

async function runBackend(renderer, scenes, fs) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 768 },
    });
    const errs = [];
    const gpuConsoleErrors =
      renderer === "webgpu" ? attachConsoleErrorGate(page) : [];
    page.on("console", (m) => {
      if (m.type() === "error") errs.push(m.text());
    });
    page.on("pageerror", (error) => errs.push(`pageerror: ${error.message}`));
    if (renderer === "webgpu") {
      await page.addInitScript(errorGateInit);
    }
    await installCloudProbeHarnessOnPage(page);
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      {
        waitUntil: "networkidle",
        timeout: 90_000,
      },
    );
    await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
    const armState =
      renderer === "webgpu"
        ? await armWebGPUDevices(page)
        : { armed: 0, found: 0, total: 0 };

    const results = {};
    for (const scene of scenes) {
      const captured = await setupAndCapture(page, scene);
      const { dataUrl, ...res } = captured;
      const out = `Tools/visual-regression/output/cloud-tour/${scene.name}-${renderer}.png`;
      fs.writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
      const evidencePixels =
        scene.system === "procedural" ? res.contributionPixels : res.cloudish;
      res.visibility = {
        metric:
          scene.system === "procedural"
            ? "same-camera-off-on-delta"
            : "bright-neutral-pixels",
        minCloudish: scene.minCloudish ?? 0,
        evidencePixels,
        pass: evidencePixels >= (scene.minCloudish ?? 0),
      };
      results[scene.name] = res;
      console.log(
        `  [${renderer}] ${scene.name}: cloudish=${res.cloudish} contribution=${res.contributionPixels ?? "n/a"} meanLum=${res.cloudMeanLum} visible=${res.visibility.pass} config=${JSON.stringify(res.configTruth.config)} → ${out}`,
      );
    }
    const gpuGate =
      renderer === "webgpu"
        ? await collectGateErrors(page)
        : { errors: [], deviceLost: null, armedDevices: 0 };
    const fatalErrors = [
      ...errs,
      ...gpuConsoleErrors,
      ...gpuGate.errors,
      ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
      ...(renderer === "webgpu" && armState.found < 1
        ? ["WebGPU error gate did not find a device"]
        : []),
    ];
    await browser.close();
    return {
      results,
      errs: [...new Set(fatalErrors)].filter(
        (e) => !/AtmosphereLUT|default layout/.test(e),
      ),
      gpuGate: {
        ...gpuGate,
        armState,
      },
    };
  } finally {
    // Guarantee headless Edge teardown even if capture/analysis throws
    // (pairs with the force-exit watchdog above).
    await browser.close().catch(() => {});
  }
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output/cloud-tour", {
    recursive: true,
  });
  const unknownScenes = [
    ...new Set(
      ONLY.filter((name) => !SCENES.some((scene) => scene.name === name)),
    ),
  ];
  if (unknownScenes.length > 0) {
    throw new Error(`Unknown TOUR_SCENES: ${unknownScenes.join(", ")}`);
  }
  const scenes = ONLY.length
    ? SCENES.filter((s) => ONLY.includes(s.name))
    : SCENES;
  if (scenes.length === 0) {
    throw new Error("Cloud tour selected zero scenes");
  }

  const billboardScenes = scenes.filter(
    (scene) => scene.system === "billboard",
  );
  console.log(
    `=== Cloud tour: ${scenes.length} WebGPU scenes; ${billboardScenes.length} billboard parity scenes ===`,
  );
  console.log("\n--- WEBGPU ---");
  const wgpu = await runBackend("webgpu", scenes, fs);
  const wgl = billboardScenes.length
    ? await (async () => {
        console.log("\n--- WEBGL (billboard parity) ---");
        return runBackend("webgl", billboardScenes, fs);
      })()
    : { results: {}, errs: [] };

  console.log(
    "\n=== SUMMARY (visibility-evidence px / neutral-cloud mean lum) ===",
  );
  console.log(
    "scene".padEnd(30),
    "webgpu".padEnd(18),
    "webgl".padEnd(18),
    "desc",
  );
  for (const sc of scenes) {
    const a = wgpu.results[sc.name],
      b = wgl.results[sc.name];
    console.log(
      sc.name.padEnd(30),
      `${a.visibility.evidencePixels}/${a.cloudMeanLum}`.padEnd(18),
      (b ? `${b.visibility.evidencePixels}/${b.cloudMeanLum}` : "n/a").padEnd(
        18,
      ),
      sc.desc,
    );
  }
  if (wgpu.errs.length)
    console.log("\nwebgpu NEW errs:", wgpu.errs.slice(0, 4));
  if (wgl.errs.length) console.log("\nwebgl NEW errs:", wgl.errs.slice(0, 4));
  const truthPath =
    "Tools/visual-regression/output/cloud-tour/cloud-tour-truth.json";
  fs.writeFileSync(
    truthPath,
    JSON.stringify(
      {
        probeVersion: "c13-01",
        webgpu: wgpu,
        webglBillboardParity: wgl,
      },
      null,
      2,
    ),
  );
  console.log(`Truth manifest: ${truthPath}`);
  console.log(
    "\nPNGs: Tools/visual-regression/output/cloud-tour/<scene>-<backend>.png",
  );
  process.exitCode =
    wgpu.errs.length === 0 &&
    wgl.errs.length === 0 &&
    Object.values(wgpu.results).every((result) => result.configTruth.ok) &&
    Object.values(wgl.results).every((result) => result.configTruth.ok) &&
    Object.values(wgpu.results).every((result) => result.visibility.pass) &&
    Object.values(wgl.results).every((result) => result.visibility.pass)
      ? 0
      : 1;
})();
