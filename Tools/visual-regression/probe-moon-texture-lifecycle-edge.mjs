#!/usr/bin/env node
/**
 * C12-35 L5 — live Edge certification for the shared Moon decoded-source
 * cache and backend-owned WebGL/WebGPU texture lifecycles.
 * @purpose C12-35 L5 cert: the shared moon decoded-source cache coalesces same-realm WebGL+WebGPU viewers; toggles + A/B supersession without churn.
 * @status ACTIVE
 *
 * The dedicated split comparison app is intentional: it constructs one WebGL
 * Viewer and one WebGPU Viewer in the SAME page/JavaScript realm. That is the
 * production shape in which the renderer-neutral decoded-source singleton can
 * coalesce the two backends. Two independent pages would have two realms and
 * therefore could not prove cross-backend coalescing.
 *
 * The probe exercises:
 *   1. real bundled albedo + normal loads on both renderers;
 *   2. normal strength 1 -> 0 -> 1 without texture/source churn;
 *   3. an in-flight A -> delayed B -> A supersession for both channels;
 *   4. the shared WebGPU validation/device-loss gate.
 *
 * No engine object is monkey-patched. All diagnostics are read through
 * Moon.getDebugStatistics(); private WebGL Texture references are only retained
 * by the harness for strict identity comparison across the off/on toggle.
 *
 * Usage:
 *   node Tools/visual-regression/probe-moon-texture-lifecycle-edge.mjs
 *
 * Environment:
 *   PROBE_BASE=http://localhost:8080
 *   PROBE_HEADED=1
 *   C12_MOON_B_DELAY_MS=1800
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

// Machine-safety watchdog (Batch 861+ fleet sweep). A probe that wedges holds a
// headless Edge + GPU process alive indefinitely; `unref` keeps the timer from
// extending a healthy run.
const WATCHDOG_MS = 600_000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-moon-texture-lifecycle-edge] watchdog fired after ${WATCHDOG_MS} ms`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(toolDirectory, "..", "..");
const base = process.env.PROBE_BASE ?? "http://localhost:8080";
const viewerUrlObject = new URL(
  "/Apps/WebGPUTest/split-screen-comparison.html",
  base,
);
viewerUrlObject.searchParams.set("baseLayer", "false");
const viewerUrl = viewerUrlObject.href;
const headed = process.env.PROBE_HEADED === "1";
const bDelayMs = Number(process.env.C12_MOON_B_DELAY_MS ?? 1800);
const outputPath = resolve(
  process.argv[2] ??
    resolve(
      toolDirectory,
      "output",
      "performance",
      "campaign12-c12-35-l5-moon-texture-lifecycle-edge.json",
    ),
);
const evidenceStem = outputPath.replace(/\.json$/i, "");

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function delta(after, before, key) {
  return (after?.[key] ?? 0) - (before?.[key] ?? 0);
}

async function analyzePng(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let illuminatedPixels = 0;
  let maxLuminance = 0;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      const luminance = Math.max(
        data[offset],
        data[offset + 1],
        data[offset + 2],
      );
      maxLuminance = Math.max(maxLuminance, luminance);
      if (luminance > 24) {
        illuminatedPixels++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    width: info.width,
    height: info.height,
    sha256: createHash("sha256").update(buffer).digest("hex").toUpperCase(),
    maxLuminance,
    illuminatedPixels,
    illuminatedFraction: illuminatedPixels / (info.width * info.height),
    illuminatedBounds: maxX >= minX ? { minX, minY, maxX, maxY } : null,
  };
}

async function comparePng(leftBuffer, rightBuffer) {
  const left = await sharp(leftBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const right = await sharp(rightBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    left.info.width !== right.info.width ||
    left.info.height !== right.info.height ||
    left.info.channels !== right.info.channels
  ) {
    return { dimensionsMatch: false };
  }
  let absoluteError = 0;
  let changedPixels = 0;
  const pixelCount = left.info.width * left.info.height;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * left.info.channels;
    let pixelError = 0;
    for (let channel = 0; channel < 3; channel++) {
      pixelError = Math.max(
        pixelError,
        Math.abs(left.data[offset + channel] - right.data[offset + channel]),
      );
      absoluteError += Math.abs(
        left.data[offset + channel] - right.data[offset + channel],
      );
    }
    if (pixelError > 8) {
      changedPixels++;
    }
  }
  return {
    dimensionsMatch: true,
    meanAbsoluteChannelError: absoluteError / (pixelCount * 3),
    changedPixels,
    changedPixelFraction: changedPixels / pixelCount,
  };
}

async function captureMoonEvidence(page, label) {
  const panes = {};
  for (const [backend, selector] of [
    ["webgl", "#leftViewer canvas"],
    ["webgpu", "#rightViewer canvas"],
  ]) {
    const buffer = await page.locator(selector).first().screenshot();
    const path = `${evidenceStem}-${label}-${backend}.png`;
    await writeFile(path, buffer);
    panes[backend] = {
      path,
      analysis: await analyzePng(buffer),
      buffer,
    };
  }
  return panes;
}

function serializeEvidence(evidence) {
  return Object.fromEntries(
    Object.entries(evidence).map(([backend, value]) => [
      backend,
      { path: value.path, analysis: value.analysis },
    ]),
  );
}

function webglChannel(snapshot, name) {
  return snapshot?.webgl?.moon?.lifecycle?.[name];
}

function webgpuMoon(snapshot) {
  return snapshot?.webgpu?.moon;
}

function realizedPair(snapshot, pair) {
  const glAlbedo = webglChannel(snapshot, "albedo");
  const glNormal = webglChannel(snapshot, "normal");
  const gpu = webgpuMoon(snapshot);
  return (
    glAlbedo?.currentUrl === pair.albedo &&
    glNormal?.currentUrl === pair.normal &&
    glAlbedo?.pendingUrl === null &&
    glNormal?.pendingUrl === null &&
    gpu?.moonTextureUrl === pair.albedo &&
    gpu?.normalMapUrl === pair.normal &&
    gpu?.albedoPendingUrl === null &&
    gpu?.normalPendingUrl === null
  );
}

function publishedPair(snapshot, pair) {
  const glAlbedo = webglChannel(snapshot, "albedo");
  const glNormal = webglChannel(snapshot, "normal");
  const gpu = webgpuMoon(snapshot);
  return (
    glAlbedo?.currentUrl === pair.albedo &&
    glNormal?.currentUrl === pair.normal &&
    gpu?.moonTextureUrl === pair.albedo &&
    gpu?.normalMapUrl === pair.normal
  );
}

function currentPair(snapshot, pair) {
  const glAlbedo = webglChannel(snapshot, "albedo");
  const glNormal = webglChannel(snapshot, "normal");
  const gpu = webgpuMoon(snapshot);
  return (
    realizedPair(snapshot, pair) &&
    glAlbedo?.state === "current" &&
    glNormal?.state === "current" &&
    gpu?.albedoRequestState === "current" &&
    gpu?.normalRequestState === "current"
  );
}

function pendingPair(snapshot, pair) {
  const glAlbedo = webglChannel(snapshot, "albedo");
  const glNormal = webglChannel(snapshot, "normal");
  const gpu = webgpuMoon(snapshot);
  return (
    glAlbedo?.pendingUrl === pair.albedo &&
    glNormal?.pendingUrl === pair.normal &&
    gpu?.albedoPendingUrl === pair.albedo &&
    gpu?.normalPendingUrl === pair.normal
  );
}

async function runtimeBundleIdentity() {
  const bundlePath = resolve(
    repositoryDirectory,
    "Build",
    "CesiumUnminified",
    "Cesium.js",
  );
  const bytes = await readFile(bundlePath);
  return {
    path: "Build/CesiumUnminified/Cesium.js",
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  };
}

async function renderAndSnapshot(page, frames = 1, delayMs = 0) {
  return await page.evaluate(
    async ({ frames, delayMs }) => {
      const harness = globalThis.__c12MoonLifecycleProbe;
      await harness.renderFrames(frames, delayMs);
      return harness.snapshot();
    },
    { frames, delayMs },
  );
}

async function waitForSnapshot(page, label, predicate, timeoutMs = 30_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await renderAndSnapshot(page, 2, 8);
    if (predicate(last)) {
      return last;
    }
  }
  throw new Error(
    `${label} timed out after ${timeoutMs} ms; last snapshot=${JSON.stringify(last)}`,
  );
}

function validate(report) {
  const failures = [];
  const inconclusive = [];
  const { phases, pairs, network } = report;
  const baseline = phases.baselineA;
  const off = phases.normalOff;
  const on = phases.normalOn;
  const pendingB = phases.pendingB;
  const wakeB = phases.wakeB;
  const currentB = phases.currentB;
  const pendingC = phases.pendingC;
  const final = phases.finalB;

  if (baseline.webgl.rendererType !== "webgl") {
    failures.push(`split left renderer was ${baseline.webgl.rendererType}`);
  }
  if (baseline.webgpu.rendererType !== "webgpu") {
    failures.push(`split right renderer was ${baseline.webgpu.rendererType}`);
  }
  if (!report.sameJavaScriptRealm) {
    inconclusive.push("split viewers were not proven to share one JS realm");
  }
  if (!currentPair(baseline, pairs.a)) {
    failures.push(
      "baseline A albedo/normal pair was not current on both backends",
    );
  }
  if (
    baseline.webgl.moon?.normalTextureLoaded !== true ||
    baseline.webgl.moon?.normalTextureBound !== true ||
    baseline.webgpu.moon?.normalMapLoaded !== true
  ) {
    failures.push(
      "baseline real normal map was not loaded/bound on both backends",
    );
  }

  const baselineCache = baseline.webgl.moon?.sourceCache;
  if (
    !baselineCache ||
    !equal(baselineCache, baseline.webgpu.moon?.sourceCache)
  ) {
    inconclusive.push(
      "backend source-cache diagnostics were missing or diverged",
    );
  } else {
    if (baselineCache.fetches !== 2 || baselineCache.decodes !== 2) {
      failures.push(
        `initial two-source realization used fetches=${baselineCache.fetches}, decodes=${baselineCache.decodes}; expected one each per albedo/normal URL`,
      );
    }
    if (baselineCache.misses !== 2 || baselineCache.acquisitions < 4) {
      failures.push(
        `initial shared-cache ownership was misses=${baselineCache.misses}, acquisitions=${baselineCache.acquisitions}; expected 2 misses and >=4 backend leases`,
      );
    }
  }

  const glBaseNormal = webglChannel(baseline, "normal");
  const glOffNormal = webglChannel(off, "normal");
  const glOnNormal = webglChannel(on, "normal");
  const gpuBase = webgpuMoon(baseline);
  const gpuOff = webgpuMoon(off);
  const gpuOn = webgpuMoon(on);

  if (
    off.webgl.moon?.normalTextureLoaded !== true ||
    off.webgl.moon?.normalTextureBound !== false ||
    glOffNormal?.demanded !== false ||
    gpuOff?.normalMapLoaded !== true ||
    gpuOff?.normalRequestDemanded !== false ||
    gpuOff?.normalMapStrength !== 0
  ) {
    failures.push(
      "normal-off did not retain the real texture while removing demand/binding",
    );
  }
  if (
    on.webgl.moon?.normalTextureBound !== true ||
    glOnNormal?.demanded !== true ||
    gpuOn?.normalRequestDemanded !== true ||
    gpuOn?.normalMapStrength !== 1
  ) {
    failures.push("normal-on did not restore demand/binding at strength 1");
  }
  if (
    !off.webgl.textureIdentity?.normalMatchesBaseline ||
    !on.webgl.textureIdentity?.normalMatchesBaseline ||
    !off.webgl.textureIdentity?.albedoMatchesBaseline ||
    !on.webgl.textureIdentity?.albedoMatchesBaseline
  ) {
    failures.push("WebGL Texture identity changed across normal off/on");
  }
  if (
    glOffNormal?.gpuRealizations !== glBaseNormal?.gpuRealizations ||
    glOnNormal?.gpuRealizations !== glBaseNormal?.gpuRealizations ||
    glOffNormal?.publications !== glBaseNormal?.publications ||
    glOnNormal?.publications !== glBaseNormal?.publications ||
    gpuOff?.normalPublications !== gpuBase?.normalPublications ||
    gpuOn?.normalPublications !== gpuBase?.normalPublications ||
    glOnNormal?.requestSerial !== glBaseNormal?.requestSerial ||
    gpuOn?.normalRequestSerial !== gpuBase?.normalRequestSerial
  ) {
    failures.push(
      "normal off/on caused request, realization, or publication churn",
    );
  }
  if (
    delta(on.webgl.moon?.sourceCache, baselineCache, "fetches") !== 0 ||
    delta(on.webgl.moon?.sourceCache, baselineCache, "decodes") !== 0 ||
    delta(on.webgl.moon?.sourceCache, baselineCache, "acquisitions") !== 0
  ) {
    failures.push("normal off/on touched the decoded-source cache");
  }

  if (!pendingPair(pendingB, pairs.b)) {
    failures.push("did not observe both backends pending the delayed B pair");
  }
  if (
    wakeB?.renderRequested?.webgl !== true ||
    wakeB?.renderRequested?.webgpu !== true
  ) {
    failures.push(
      "request-render mode did not wake both scenes after B source/upload readiness",
    );
  }
  if (!publishedPair(wakeB?.snapshot, pairs.a)) {
    failures.push(
      "asynchronous B readiness mutated a live publication before the frame-owned commit",
    );
  }
  if (!currentPair(currentB, pairs.b)) {
    failures.push("B did not publish after the explicit-render wakeup");
  }

  const currentBCache = currentB.webgl.moon?.sourceCache;
  if (
    !currentBCache ||
    !equal(currentBCache, currentB.webgpu.moon?.sourceCache)
  ) {
    inconclusive.push("B source-cache diagnostics were missing or diverged");
  } else if (
    delta(currentBCache, baselineCache, "fetches") !== 2 ||
    delta(currentBCache, baselineCache, "decodes") !== 2 ||
    delta(currentBCache, baselineCache, "misses") !== 2
  ) {
    failures.push(
      `B shared realization used fetch/decode/miss deltas ${delta(currentBCache, baselineCache, "fetches")}/${delta(currentBCache, baselineCache, "decodes")}/${delta(currentBCache, baselineCache, "misses")}; expected 2/2/2`,
    );
  }

  if (!pendingPair(pendingC, pairs.c)) {
    failures.push("did not observe both backends pending the delayed C pair");
  }
  if (!currentPair(final, pairs.b)) {
    failures.push(
      "final B pair was not current and quiescent after C supersession",
    );
  }
  for (const [backend, moon] of [
    ["webgl", final.webgl.moon],
    ["webgpu", final.webgpu.moon],
  ]) {
    const albedoCancellations =
      backend === "webgl"
        ? moon?.lifecycle?.albedo?.cancellations
        : moon?.albedoRequestCancellations;
    const normalCancellations =
      backend === "webgl"
        ? moon?.lifecycle?.normal?.cancellations
        : moon?.normalRequestCancellations;
    if (!(albedoCancellations > 0) || !(normalCancellations > 0)) {
      failures.push(
        `${backend} did not record C supersession for both channels`,
      );
    }
  }

  const finalCache = final.webgl.moon?.sourceCache;
  if (!finalCache || !equal(finalCache, final.webgpu.moon?.sourceCache)) {
    inconclusive.push(
      "final shared-cache diagnostics were missing or diverged",
    );
  } else {
    if (
      delta(finalCache, currentBCache, "fetches") !== 2 ||
      delta(finalCache, currentBCache, "misses") !== 2
    ) {
      failures.push(
        `delayed C used fetch delta=${delta(finalCache, currentBCache, "fetches")}, miss delta=${delta(finalCache, currentBCache, "misses")}; expected one shared load per C URL`,
      );
    }
    if (
      delta(finalCache, currentBCache, "abortedLoads") !== 2 ||
      delta(finalCache, currentBCache, "decodes") !== 0
    ) {
      failures.push(
        `C retirement used aborted-load delta=${delta(finalCache, currentBCache, "abortedLoads")}, decode delta=${delta(finalCache, currentBCache, "decodes")}; expected two pre-decode aborts`,
      );
    }
    if (
      finalCache.entries.some((entry) => entry.exactUrl.includes("c12l5=C"))
    ) {
      failures.push(
        "a superseded C source remained in the final decoded cache",
      );
    }
  }

  for (const label of ["B", "C", "D"]) {
    const requests = network.moonRequests.filter((request) =>
      request.url.includes(`c12l5=${label}`),
    );
    const uniqueRequests = new Set(requests.map((request) => request.url));
    if (requests.length !== 2 || uniqueRequests.size !== 2) {
      failures.push(
        `browser issued ${requests.length} delayed-${label} Moon requests (${uniqueRequests.size} unique); expected one albedo and one normal request shared by both renderers`,
      );
    }
  }

  const beforeDestroyCache = phases.pendingDestroyD?.webgl?.moon?.sourceCache;
  const teardown = phases.postDestroy;
  const afterDestroyCache = teardown?.sourceCache;
  if (!pendingPair(phases.pendingDestroyD, pairs.d)) {
    failures.push("did not observe both backends pending D before teardown");
  }
  if (
    !beforeDestroyCache ||
    beforeDestroyCache.activeLeases < 4 ||
    beforeDestroyCache.activePendingEntries !== 2
  ) {
    failures.push("D teardown did not begin with four live backend leases");
  }
  if (
    teardown?.webglViewerDestroyed !== true ||
    teardown?.webgpuViewerDestroyed !== true ||
    teardown?.webglLifecycleRetired !== true ||
    teardown?.webgpuLifecycleRetired !== true
  ) {
    failures.push("viewer destruction did not retire both Moon lifecycles");
  }
  if (
    !afterDestroyCache ||
    afterDestroyCache.activeLeases !== 0 ||
    afterDestroyCache.activePendingEntries !== 0 ||
    afterDestroyCache.pendingEntries !== 0 ||
    afterDestroyCache.entries.some((entry) =>
      entry.exactUrl.includes("c12l5=D"),
    )
  ) {
    failures.push("viewer destruction left a D lease or pending cache entry");
  } else if (
    delta(afterDestroyCache, beforeDestroyCache, "abortedLoads") !== 2
  ) {
    failures.push(
      `viewer destruction aborted ${delta(afterDestroyCache, beforeDestroyCache, "abortedLoads")} D loads; expected 2`,
    );
  }

  for (const backend of ["webgl", "webgpu"]) {
    const reference = report.visualEvidence?.currentB?.[backend]?.analysis;
    const finalEvidence = report.visualEvidence?.finalB?.[backend]?.analysis;
    const comparison = report.visualEvidence?.comparison?.[backend];
    if (
      !reference ||
      !finalEvidence ||
      reference.illuminatedFraction < 0.001 ||
      finalEvidence.illuminatedFraction < 0.001
    ) {
      failures.push(
        `${backend} Moon was not materially visible in pixel evidence`,
      );
    }
    if (
      comparison?.dimensionsMatch !== true ||
      comparison.meanAbsoluteChannelError > 1.0 ||
      comparison.changedPixelFraction > 0.02
    ) {
      failures.push(
        `${backend} final B pixels diverged after C cancellation: ${JSON.stringify(comparison)}`,
      );
    }
  }

  const gpuFaults = [
    ...report.gpuConsoleErrors,
    ...report.gpuGate.errors,
    ...(report.gpuGate.deviceLost ? [report.gpuGate.deviceLost] : []),
  ];
  if (gpuFaults.length > 0) {
    failures.push(`${gpuFaults.length} WebGPU validation/device fault(s)`);
  }
  if (report.gpuGate.armedDevices < 1 || report.gpuGateArm.found < 1) {
    inconclusive.push("WebGPU validation gate did not arm a live device");
  }
  if (report.gpuDrain?.completed !== true) {
    inconclusive.push(
      "WebGPU queue completion was not drained before teardown",
    );
  }
  if (report.pageErrors.length > 0) {
    failures.push(`${report.pageErrors.length} uncaught page error(s)`);
  }
  const consoleErrors = report.consoleMessages.filter(
    (message) => message.type === "error",
  );
  if (consoleErrors.length > 0) {
    failures.push(`${consoleErrors.length} console error(s)`);
  }

  return {
    verdict:
      failures.length > 0
        ? "FAIL"
        : inconclusive.length > 0
          ? "INCONCLUSIVE"
          : "PASS",
    failures,
    inconclusive,
    gpuFaults,
  };
}

await mkdir(dirname(outputPath), { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: !headed,
  args: ["--enable-unsafe-webgpu"],
});

let context;
try {
  context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);

  const gpuConsoleErrors = attachConsoleErrorGate(page);
  const pageErrors = [];
  const consoleMessages = [];
  const moonRequests = [];
  const moonRequestFailures = [];
  const delayedRoutes = { B: 0, C: 0, D: 0 };

  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({
        type: message.type(),
        text: message.text(),
      });
    }
  });
  page.on("request", (request) => {
    if (/Moon|moonSmall/i.test(request.url())) {
      moonRequests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
      });
    }
  });
  page.on("requestfailed", (request) => {
    if (/Moon|moonSmall/i.test(request.url())) {
      moonRequestFailures.push({
        url: request.url(),
        errorText: request.failure()?.errorText ?? null,
      });
    }
  });
  await page.route("**/*", async (route) => {
    let url;
    try {
      url = new URL(route.request().url());
    } catch (_error) {
      await route.continue();
      return;
    }
    const delayedLabel = url.searchParams.get("c12l5");
    if (Object.hasOwn(delayedRoutes, delayedLabel)) {
      delayedRoutes[delayedLabel]++;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, bDelayMs));
    }
    try {
      await route.continue();
    } catch (_error) {
      // Expected when Resource cancellation aborts the delayed B request before
      // the harness releases the Playwright route.
    }
  });
  await page.addInitScript(errorGateInit);

  await page.goto(viewerUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.locator("#btnLaunch").click();
  await page.waitForFunction(
    () => globalThis.webglViewer && globalThis.webgpuViewer,
    undefined,
    { timeout: 90_000 },
  );
  const gpuGateArm = await armWebGPUDevices(page);

  const setup = await page.evaluate(async () => {
    const C = globalThis.Cesium;
    const webgl = globalThis.webglViewer;
    const webgpu = globalThis.webgpuViewer;
    const fixedTime = C.JulianDate.fromIso8601("2026-01-15T04:00:00Z");
    const a = {
      albedo: C.Moon.getVariantTextureUrl(C.Moon.Variant.LROC_COLOR_2K),
      normal: C.Moon.getVariantNormalMapUrl(C.Moon.Variant.LROC_COLOR_2K),
    };
    const withProbeQuery = (source, label) => {
      const url = new URL(source, location.href);
      url.searchParams.set("c12l5", label);
      return url.href;
    };
    const b = {
      // The smaller bundled albedo is intentionally distinct from A so the
      // browser evidence can prove that final pixels retained the requested
      // publication instead of merely comparing two URL aliases of one file.
      albedo: withProbeQuery(
        C.Moon.getVariantTextureUrl(C.Moon.Variant.SMALL),
        "B",
      ),
      normal: withProbeQuery(a.normal, "B"),
    };
    const c = {
      albedo: withProbeQuery(a.albedo, "C"),
      normal: withProbeQuery(a.normal, "C"),
    };
    const d = {
      albedo: withProbeQuery(a.albedo, "D"),
      normal: withProbeQuery(a.normal, "D"),
    };

    for (const viewer of [webgl, webgpu]) {
      viewer.useDefaultRenderLoop = false;
      viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
      viewer.clock.shouldAnimate = false;
      viewer.clock.multiplier = 0;
      const scene = viewer.scene;
      scene.requestRenderMode = true;
      scene.globe.show = false;
      scene.imageryLayers.removeAll();
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.sun.show = false;
      scene.moon.show = true;
      scene.moon.textureUrl = a.albedo;
      scene.moon.normalMapUrl = a.normal;
      scene.moon.normalMapStrength = 1;
    }

    const identity = new WeakMap();
    let nextIdentity = 1;
    const token = (value) => {
      if (
        !value ||
        (typeof value !== "object" && typeof value !== "function")
      ) {
        return null;
      }
      if (!identity.has(value)) identity.set(value, nextIdentity++);
      return identity.get(value);
    };
    const harness = {
      a,
      b,
      c,
      d,
      webglBaselineAlbedo: undefined,
      webglBaselineNormal: undefined,
      async renderFrames(count, delayMs) {
        for (let i = 0; i < count; i++) {
          webgl.scene.requestRender();
          webgpu.scene.requestRender();
          webgl.scene.render(webgl.clock.currentTime);
          webgpu.scene.render(webgpu.clock.currentTime);
          await new Promise((resolveFrame) =>
            requestAnimationFrame(resolveFrame),
          );
          if (delayMs > 0) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, delayMs),
            );
          }
        }
      },
      setNormalStrength(value) {
        webgl.scene.moon.normalMapStrength = value;
        webgpu.scene.moon.normalMapStrength = value;
      },
      setPair(pair) {
        for (const viewer of [webgl, webgpu]) {
          viewer.scene.moon.textureUrl = pair.albedo;
          viewer.scene.moon.normalMapUrl = pair.normal;
        }
      },
      frameMoonCamera() {
        const direction = webgl.scene._frameState.moonDirectionWC;
        if (!direction) {
          return false;
        }
        const right = new C.Cartesian3();
        C.Cartesian3.cross(direction, C.Cartesian3.UNIT_Z, right);
        if (C.Cartesian3.magnitudeSquared(right) < 0.01) {
          C.Cartesian3.cross(direction, C.Cartesian3.UNIT_Y, right);
        }
        C.Cartesian3.normalize(right, right);
        const up = C.Cartesian3.cross(right, direction, new C.Cartesian3());
        C.Cartesian3.normalize(up, up);
        for (const viewer of [webgl, webgpu]) {
          viewer.camera.setView({
            orientation: { direction, up },
          });
          if ("fov" in viewer.camera.frustum) {
            viewer.camera.frustum.fov = C.Math.toRadians(1.5);
          }
        }
        return true;
      },
      renderRequested() {
        return {
          webgl: webgl.scene._renderRequested === true,
          webgpu: webgpu.scene._renderRequested === true,
        };
      },
      async drainGpu() {
        const device = webgpu.scene.context._device;
        if (!device?.queue?.onSubmittedWorkDone) {
          return { completed: false };
        }
        await device.queue.onSubmittedWorkDone();
        return { completed: true };
      },
      markWebGLBaseline() {
        this.webglBaselineAlbedo = webgl.scene.moon._albedoMapTexture;
        this.webglBaselineNormal = webgl.scene.moon._normalMapTexture;
      },
      snapshot() {
        const backend = (viewer) => {
          const moon = viewer.scene.moon;
          return {
            rendererType: viewer.scene.context.rendererType,
            resourceGeneration: viewer.scene.context.resourceGeneration,
            frameNumber: viewer.scene._frameState.frameNumber,
            moon: moon.getDebugStatistics(viewer.scene),
          };
        };
        const gl = backend(webgl);
        gl.textureIdentity = {
          albedo: token(webgl.scene.moon._albedoMapTexture),
          normal: token(webgl.scene.moon._normalMapTexture),
          albedoMatchesBaseline:
            this.webglBaselineAlbedo !== undefined &&
            webgl.scene.moon._albedoMapTexture === this.webglBaselineAlbedo,
          normalMatchesBaseline:
            this.webglBaselineNormal !== undefined &&
            webgl.scene.moon._normalMapTexture === this.webglBaselineNormal,
        };
        return JSON.parse(
          JSON.stringify({
            webgl: gl,
            webgpu: backend(webgpu),
          }),
        );
      },
      async destroyAndSnapshot(settleDelayMs) {
        const webglMoon = webgl.scene.moon;
        const webgpuMoon = webgpu.scene.moon;
        const getDebugStatistics = webglMoon.getDebugStatistics;
        const webglLifecycle = webglMoon._webglMoonTextureLifecycle;
        const webgpuLifecycle = webgpuMoon._webgpuCache?._moonTextureLifecycle;

        // Use the comparison app's public teardown control so its lexical
        // viewer references and camera/clock synchronization loop retire in
        // the same operation as the two Viewer owners.
        document.getElementById("btnDestroy").click();
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, settleDelayMs),
        );

        // Invoke the original resource-free diagnostic closure with the
        // retired lifecycle solely to read the realm-shared source cache.
        // No destroyed Scene/context method or GPU object is exposed.
        const diagnostics = getDebugStatistics.call(
          { _webglMoonTextureLifecycle: webglLifecycle },
          { context: { getFeatureRenderer: () => undefined } },
        );
        return JSON.parse(
          JSON.stringify({
            webglViewerDestroyed: webgl.isDestroyed(),
            webgpuViewerDestroyed: webgpu.isDestroyed(),
            webglLifecycleRetired: webglLifecycle?.retired === true,
            webgpuLifecycleRetired: webgpuLifecycle?.retired === true,
            webglPendingRequest:
              webglLifecycle?.channels?.albedo?.request !== undefined ||
              webglLifecycle?.channels?.normal?.request !== undefined,
            webgpuPendingRequest:
              webgpuLifecycle?.channels?.albedo?.request !== undefined ||
              webgpuLifecycle?.channels?.normal?.request !== undefined,
            sourceCache: diagnostics?.sourceCache ?? null,
          }),
        );
      },
    };
    globalThis.__c12MoonLifecycleProbe = harness;
    return {
      pairs: { a, b, c, d },
      sameJavaScriptRealm:
        webgl.scene.canvas.ownerDocument.defaultView ===
        webgpu.scene.canvas.ownerDocument.defaultView,
    };
  });

  await waitForSnapshot(
    page,
    "baseline A realization",
    (snapshot) => currentPair(snapshot, setup.pairs.a),
    45_000,
  );
  const cameraFramed = await page.evaluate(() =>
    globalThis.__c12MoonLifecycleProbe.frameMoonCamera(),
  );
  if (!cameraFramed) {
    throw new Error("Moon camera direction was unavailable after baseline");
  }
  await page.evaluate(() =>
    globalThis.__c12MoonLifecycleProbe.markWebGLBaseline(),
  );
  const markedBaseline = await renderAndSnapshot(page, 24, 4);

  await page.evaluate(() =>
    globalThis.__c12MoonLifecycleProbe.setNormalStrength(0),
  );
  const normalOff = await renderAndSnapshot(page, 8, 4);

  await page.evaluate(() =>
    globalThis.__c12MoonLifecycleProbe.setNormalStrength(1),
  );
  const normalOn = await renderAndSnapshot(page, 8, 4);

  await page.evaluate(
    (pair) => globalThis.__c12MoonLifecycleProbe.setPair(pair),
    setup.pairs.b,
  );
  const pendingB = await renderAndSnapshot(page, 1, 0);
  await page.waitForFunction(
    () => {
      const requested = globalThis.__c12MoonLifecycleProbe?.renderRequested();
      return requested?.webgl === true && requested?.webgpu === true;
    },
    undefined,
    { timeout: bDelayMs + 30_000 },
  );
  const wakeB = await page.evaluate(() => ({
    renderRequested: globalThis.__c12MoonLifecycleProbe.renderRequested(),
    snapshot: globalThis.__c12MoonLifecycleProbe.snapshot(),
  }));
  await waitForSnapshot(
    page,
    "B publication after explicit-render wake",
    (snapshot) => currentPair(snapshot, setup.pairs.b),
    30_000,
  );
  const currentB = await renderAndSnapshot(page, 24, 4);
  const currentBEvidence = await captureMoonEvidence(page, "current-b");

  await page.evaluate(
    (pair) => globalThis.__c12MoonLifecycleProbe.setPair(pair),
    setup.pairs.c,
  );
  const pendingC = await renderAndSnapshot(page, 1, 0);
  await page.evaluate(
    (pair) => globalThis.__c12MoonLifecycleProbe.setPair(pair),
    setup.pairs.b,
  );
  await renderAndSnapshot(page, 2, 4);
  // Cross the delayed-response horizon and keep rendering so any forbidden
  // late C settlement has a chance to reveal itself.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, bDelayMs + 250));
  const finalB = await renderAndSnapshot(page, 24, 8);
  const finalBEvidence = await captureMoonEvidence(page, "final-b");
  const visualComparison = {
    webgl: await comparePng(
      currentBEvidence.webgl.buffer,
      finalBEvidence.webgl.buffer,
    ),
    webgpu: await comparePng(
      currentBEvidence.webgpu.buffer,
      finalBEvidence.webgpu.buffer,
    ),
  };

  const gpuDrain = await page.evaluate(() =>
    globalThis.__c12MoonLifecycleProbe.drainGpu(),
  );

  await page.evaluate(
    (pair) => globalThis.__c12MoonLifecycleProbe.setPair(pair),
    setup.pairs.d,
  );
  const pendingDestroyD = await renderAndSnapshot(page, 1, 0);
  const postDestroy = await page.evaluate(
    (settleDelayMs) =>
      globalThis.__c12MoonLifecycleProbe.destroyAndSnapshot(settleDelayMs),
    bDelayMs + 250,
  );

  const gpuGate = await collectGateErrors(page);
  const report = {
    schemaVersion: 2,
    campaign: "C12-35-L5",
    capturedAt: new Date().toISOString(),
    viewerUrl,
    browser: {
      channel: "msedge",
      version: await browser.version(),
      headed,
    },
    runtimeBundle: await runtimeBundleIdentity(),
    sameJavaScriptRealm: setup.sameJavaScriptRealm,
    pairs: setup.pairs,
    delayMs: bDelayMs,
    phases: {
      baselineA: markedBaseline,
      normalOff,
      normalOn,
      pendingB,
      wakeB,
      currentB,
      pendingC,
      finalB,
      pendingDestroyD,
      postDestroy,
    },
    visualEvidence: {
      currentB: serializeEvidence(currentBEvidence),
      finalB: serializeEvidence(finalBEvidence),
      comparison: visualComparison,
    },
    network: {
      moonRequests,
      moonRequestFailures,
      delayedRoutes,
    },
    gpuDrain,
    gpuGateArm,
    gpuGate,
    gpuConsoleErrors,
    pageErrors,
    consoleMessages,
  };
  report.result = validate(report);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify(report, null, 2));
  console.error(
    `[C12-35 L5] ${report.result.verdict} — ${outputPath} ` +
      `(failures=${report.result.failures.length}, inconclusive=${report.result.inconclusive.length})`,
  );
  if (report.result.verdict === "FAIL") {
    process.exitCode = 1;
  } else if (report.result.verdict === "INCONCLUSIVE") {
    process.exitCode = 2;
  }
} finally {
  await context?.close();
  await browser.close();
}
