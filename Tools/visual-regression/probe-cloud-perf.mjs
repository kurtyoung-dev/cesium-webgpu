#!/usr/bin/env node
/**
 * W5 — Adaptive coarse→fine raymarch (empty-space skipping). WebGPU-only.
 * @purpose W5 adaptive-march A/B with pair-ID provenance: image within ~2% of the fixed march and a faster GPU-synced frame from empty-space skipping
 * @status ACTIVE
 *
 * Verifies the adaptive march (a) preserves the image vs the old fixed-step
 * march and (b) is cheaper (skips empty space). Because the lighting/composite
 * math is byte-identical and only the stepping cadence changed, the rigorous
 * test is a TRUE A/B against the pre-W5 build:
 *
 *   Run 1 (W5 build present):        TAG=adaptive node probe-cloud-perf.mjs
 *   Run 2 (fixed-march build, via
 *          `git stash` of the WGSL): TAG=fixed    node probe-cloud-perf.mjs
 *
 * Each run captures the cloud image + a GPU-synced frame time under its tag.
 * When BOTH tags exist, the second run computes:
 *   • image mismatch (mean-abs luminance) — must be ≤ ~2% (equal quality), and
 *     cloud-cell (lum>150) count within ±6% (no thinned tops / lost silhouette).
 *   • frame-time delta — adaptive should be FASTER (empty-space skip pays off).
 *
 * Scene mirrors the lighting probes: clouds on, moderate coverage with lots of
 * empty space along rays, high step budget (so the march dominates frame cost),
 * black sky, sun/atmosphere off, fixed sun via manual render(jd).
 *
 * Usage:
 *   CLOUD_PERF_PAIR_ID=2026-07-23-w5 TAG=adaptive PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-perf.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import { resolveCloudPerfPass } from "./lib/cloud-perf-evidence.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

// ── HARD watchdog: force-exit if anything hangs (machine safety) ──
// Unbounded awaits inside page.evaluate (rAF settles, onSubmittedWorkDone) could
// otherwise leave headless Edge (--enable-unsafe-webgpu) alive forever on a GPU
// hang. Unref'd so it never keeps an otherwise-finished process alive.
const HARD_LIMIT_MS = 300000; // 300s
const watchdog = setTimeout(() => {
  console.error("[cloud-perf] WATCHDOG FIRED (300s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "adaptive";
const PAIR_ID = process.env.CLOUD_PERF_PAIR_ID || null;
const W = 1024,
  H = 768;
const LON = -95.0,
  LAT = 39.0,
  ALT = 800.0; // below the layer, looking up through sparse clouds (real empty
//             space along rays for the skip to exploit — not the cloud-saturated
//             inside-layer grazing view, which has nothing to skip)
const NOON = "2026-06-21T18:20:00Z";
const OUT = "Tools/visual-regression/output";

if (!["adaptive", "fixed"].includes(TAG)) {
  throw new Error("TAG must be adaptive or fixed");
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

const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  v.useDefaultRenderLoop = false;
  const configTruth = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: {
      cloudCoverage: 0.35, // sparse → ~65% empty along rays
      cloudWeatherMap: false,
      cloudDensity: 0.7,
      cloudQuality: 128, // non-default → used verbatim (high budget)
    },
  });
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(25.0), // look up through the layer (crosses puffs + gaps)
      roll: 0.0,
    },
  });
  return configTruth;
};

const RENDER_AND_TIME = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  const device = s.context.device;
  const readiness = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime: jd,
  });
  // Warm up (compile pipelines, settle clouds).
  for (let i = 0; i < 40; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (device) await device.queue.onSubmittedWorkDone();

  // Time M frames back-to-back, then sync on GPU completion.
  const M = 150;
  const t0 = performance.now();
  for (let i = 0; i < M; i++) {
    s.render(jd);
  }
  if (device) await device.queue.onSubmittedWorkDone();
  const t1 = performance.now();
  // Render one unmeasured frame for the Playwright canvas screenshot taken
  // after this function returns. Do not use canvas.toDataURL here: the WebGPU
  // presentation texture may already have been relinquished and decode as an
  // all-zero image despite a visible composited frame.
  s.render(jd);

  return {
    readiness,
    realization: globalThis.__cloudProbe.proceduralRealization(),
    msPerFrame: +((t1 - t0) / M).toFixed(4),
    hasDevice: !!device,
    adapterInfo: s.context.adapter?.info
      ? {
          vendor: s.context.adapter.info.vendor || "",
          architecture: s.context.adapter.info.architecture || "",
          device: s.context.adapter.info.device || "",
          description: s.context.adapter.info.description || "",
        }
      : null,
    canvas: {
      width: s.canvas.width,
      height: s.canvas.height,
    },
  };
};

async function decodeRgb(png) {
  return sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function lumStats(png) {
  const { data, info } = await decodeRgb(png);
  let sum = 0;
  let cells = 0;
  const n = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
    if (lum > 150) cells++;
  }
  return { meanLum: +(sum / n).toFixed(3), cloudCells: cells };
}

// Mean-abs luminance mismatch between two same-size PNGs.
async function imageMismatch(pngA, pngB) {
  const [a, b] = await Promise.all([decodeRgb(pngA), decodeRgb(pngB)]);
  if (
    a.info.width !== b.info.width ||
    a.info.height !== b.info.height ||
    a.info.channels !== b.info.channels
  ) {
    throw new Error("cloud perf A/B images have different dimensions");
  }
  let acc = 0;
  const n = a.info.width * a.info.height;
  for (let i = 0; i < a.data.length; i += a.info.channels) {
    const la =
      0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
    const lb =
      0.299 * b.data[i] + 0.587 * b.data[i + 1] + 0.114 * b.data[i + 2];
    acc += Math.abs(la - lb);
  }
  return +(acc / n).toFixed(3); // 0..255
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
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
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const gpuConsoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await installCloudProbeHarnessOnPage(page);
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      {
        waitUntil: "networkidle",
        timeout: 90_000,
      },
    );
    await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
    const armState = await armWebGPUDevices(page);
    const configTruth = await page.evaluate(SETUP, { LON, LAT, ALT });

    const r = await page.evaluate(RENDER_AND_TIME, { iso: NOON });
    // Element screenshots include visually overlapping siblings. Hide Cesium's
    // controls before clipping to the canvas so UI text cannot satisfy the
    // cloud-pixel liveness gate.
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
    const pngBuffer = await page
      .locator(".cesium-widget canvas")
      .first()
      .screenshot();
    const png = `${OUT}/cloud-perf-${TAG}.png`;
    fs.writeFileSync(png, pngBuffer);
    const stats = await lumStats(pngBuffer);

    const gate = await collectGateErrors(page);
    const newErrs = [
      ...new Set([
        ...gpuConsoleErrors,
        ...(gate.errors || []),
        ...(gate.deviceLost ? [gate.deviceLost] : []),
        ...(armState.found < 1
          ? ["WebGPU error gate did not find a device"]
          : []),
      ]),
    ].filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));

    const rec = {
      probeVersion: "c13-01",
      measurementKind: "gpu-queue-drain-max-throughput",
      pairId: PAIR_ID,
      tag: TAG,
      msPerFrame: r.msPerFrame,
      hasDevice: r.hasDevice,
      adapterInfo: r.adapterInfo,
      browserVersion: browser.version(),
      canvas: r.canvas,
      source,
      ...stats,
      configTruth,
      readiness: r.readiness,
      realization: r.realization,
      gpuGate: {
        ...gate,
        armState,
      },
      errors: newErrs,
    };
    // If the OTHER tag exists, compare.
    const other = TAG === "adaptive" ? "fixed" : "adaptive";
    const otherJson = `${OUT}/cloud-perf-${other}.json`;
    const currentArtifactValid =
      configTruth.ok &&
      r.readiness.ok === true &&
      r.readiness.executeCalls > 0 &&
      r.realization.initialized === true &&
      r.realization.pipelineReady === true &&
      r.realization.maxSteps === 128 &&
      r.realization.halfWidth === 0 &&
      r.realization.halfHeight === 0 &&
      r.realization.temporalWidth === 0 &&
      r.realization.temporalHeight === 0 &&
      newErrs.length === 0 &&
      stats.cloudCells > 3000 &&
      r.hasDevice &&
      r.adapterInfo !== null;
    let comparison = {
      status: PAIR_ID === null ? "not-requested" : "missing-companion",
      pairId: PAIR_ID,
      otherTag: other,
    };
    let comparisonPassed = null;
    if (fs.existsSync(otherJson)) {
      const o = JSON.parse(fs.readFileSync(otherJson, "utf8"));
      const comparable =
        o.probeVersion === rec.probeVersion &&
        o.measurementKind === rec.measurementKind &&
        rec.pairId !== null &&
        o.pairId === rec.pairId &&
        JSON.stringify(o.configTruth?.config) ===
          JSON.stringify(rec.configTruth.config) &&
        JSON.stringify(o.adapterInfo) === JSON.stringify(rec.adapterInfo) &&
        o.browserVersion === rec.browserVersion &&
        JSON.stringify(o.canvas) === JSON.stringify(rec.canvas) &&
        typeof o.source?.runtimeBundle?.sha256 === "string" &&
        typeof rec.source.runtimeBundle.sha256 === "string" &&
        o.source.runtimeBundle.sha256 !== rec.source.runtimeBundle.sha256 &&
        fs.existsSync(`${OUT}/cloud-perf-${other}.png`);
      if (comparable) {
        const otherPng = fs.readFileSync(`${OUT}/cloud-perf-${other}.png`);
        const mismatch = await imageMismatch(pngBuffer, otherPng);
        const cellRatio = stats.cloudCells / Math.max(1, o.cloudCells);
        const adaptive = TAG === "adaptive" ? rec : o;
        const fixed = TAG === "fixed" ? rec : o;
        const speedup = +(
          fixed.msPerFrame / Math.max(0.0001, adaptive.msPerFrame)
        ).toFixed(3);
        const otherArtifactValid =
          o.configTruth?.ok === true &&
          o.readiness?.ok === true &&
          o.readiness?.executeCalls > 0 &&
          o.realization?.initialized === true &&
          o.realization?.pipelineReady === true &&
          o.realization?.maxSteps === 128 &&
          o.realization?.halfWidth === 0 &&
          o.realization?.halfHeight === 0 &&
          o.realization?.temporalWidth === 0 &&
          o.realization?.temporalHeight === 0 &&
          Array.isArray(o.errors) &&
          o.errors.length === 0 &&
          o.cloudCells > 3000 &&
          o.hasDevice === true &&
          o.adapterInfo !== null &&
          !o.gpuGate?.deviceLost;

        console.log("\n=== A/B (adaptive vs fixed) ===");
        console.log(
          `  image mean-abs luma mismatch: ${mismatch}/255 (${((mismatch / 255) * 100).toFixed(2)}%)`,
        );
        console.log(
          `  cloud-cell ratio ${TAG}/${other}: ${cellRatio.toFixed(3)}`,
        );
        console.log(
          `  frame time  adaptive ${adaptive.msPerFrame}ms  fixed ${fixed.msPerFrame}ms  speedup ×${speedup}`,
        );

        const checks = [
          [
            `current artifact is valid and visibly contains clouds (${stats.cloudCells} cells)`,
            currentArtifactValid,
          ],
          [
            "paired artifact is valid and visibly contains clouds",
            otherArtifactValid,
          ],
          [
            `image preserved (mismatch ${mismatch} ≤ 5.1/255 ≈2%)`,
            mismatch <= 5.1,
          ],
          [
            `cloud silhouette preserved (cell ratio ${cellRatio.toFixed(3)} in 0.94-1.06)`,
            cellRatio >= 0.94 && cellRatio <= 1.06,
          ],
          [
            `adaptive faster than fixed (speedup ×${speedup} > 1.05)`,
            speedup > 1.05,
          ],
          ["no NEW device errors (this run)", newErrs.length === 0],
          ["probe configuration round-tripped", configTruth.ok],
        ];
        console.log("\n=== ANALYSIS ===");
        comparisonPassed = checks.every(([, ok]) => ok);
        for (const [n, ok] of checks) {
          console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
        }
        comparison = {
          status: "compared",
          pairId: PAIR_ID,
          otherTag: other,
          imageMeanAbsoluteLumaMismatch: mismatch,
          cloudCellRatio: cellRatio,
          speedup,
          checks: checks.map(([name, ok]) => ({ name, ok })),
        };
      } else {
        comparison = {
          status: "noncomparable-companion",
          pairId: PAIR_ID,
          otherTag: other,
        };
        console.log(
          `(existing ${other} capture is stale, unpaired, from the same bundle, or configured differently — rerun both builds with the same CLOUD_PERF_PAIR_ID before comparing)`,
        );
      }
    } else {
      console.log(`(no ${other} capture yet — run the other build to compare)`);
    }

    const pass = resolveCloudPerfPass({
      currentArtifactValid,
      pairId: PAIR_ID,
      comparisonStatus: comparison.status,
      comparisonPassed,
    });
    rec.comparison = comparison;
    fs.writeFileSync(
      `${OUT}/cloud-perf-${TAG}.json`,
      JSON.stringify(rec, null, 2),
    );
    console.log(`[${TAG}]`, JSON.stringify(rec));
    if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 2));
    console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
    await browser.close();
    process.exitCode = pass ? 0 : 1;
  } finally {
    // Guarantee headless Edge teardown even if capture/analysis throws
    // (pairs with the force-exit watchdog above).
    await browser.close().catch(() => {});
  }
}
run();
