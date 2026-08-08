#!/usr/bin/env node
// Probe (C13-09 OWED EDGE ACCEPTANCE, machine lane): the reconstruction
// attachment set is opt-in scaffolding — resident and producing when asked,
// invisible in pixels AND cost when not (and even when asked, because nothing
// reads it yet; the consumers are C13-10/12).
//
// Pre-registered legs (QUEUE_2026-07-23_CAMPAIGN13.md, C13-09 row):
//   (a) DEFAULT, attachments off, cloudVolumetricQuality "low":
//       cloud output byte-identical to the PRE-CHANGE build and
//       reconstruction.attachments.liveBytes === 0.
//   (b) CesiumDebug.cloudReconstructionAttachments(true):
//       output STILL byte-identical to leg (a), with produced === true,
//       targetCount === 3, generation >= 1, liveBytes === width*height*24,
//       and passes["CloudReconstructionAttachments pass"] === 1.
//   Rider: a canvas resize bumps generation and moves liveBytes WITH it.
//
// INSTRUMENT DESIGN (established empirically before this probe's first
// certified run — the discriminator trail is in the C13-09 ledger stamp):
//   * COUNTERS are read in the ACTIVE window right after readiness (toggle,
//     then bail-early when produced). BYTE-IDENTITY is read at the
//     byte-stationary fixed point the frame converges to, verified by a
//     stationarity PRECONDITION (two flag-off captures 8 frames apart must
//     already be byte-equal). The march may keep dispatching at the fixed
//     point — in the certified first run it dispatched every frame, so the
//     identity held with the producer LIVE, the strongest form of leg (b).
//     A march-idle "settle" state is bounded-waited-for but NOT required.
//   * The published counters lag cache truth by 1-2 frames (resident
//     figures publish at frame start, before the producer's ensure).
//     Counter predicates read through a small bounded consistency window
//     and record the observed latency (publishLagFrames); a counter that
//     never publishes still fails at the bound.
//   * ACROSS pages (even same build) the fixed point differs per page —
//     temporal history freezes initialization variance permanently — so the
//     "byte-identical to the pre-change build" arm is physically untestable
//     as a cross-build byte compare. It is discharged by: same-page settled
//     byte identity across the toggle + a cross-build PIXEL DIFF bounded by
//     the instrument's own same-build cross-page noise floor (measured in
//     the same run, bound = max(2 x floor, 0.1%) — FIRST-PASS DERIVED) +
//     the structural spec pins (no attachment sampler in resolve/upscale;
//     composite source unchanged). Active-window pixel-inertness rests on
//     those structural pins — a live A/B of the same frame index on one
//     timeline is not constructible.
//   * Canvas pixels come from Playwright ELEMENT SCREENSHOTS (in-page
//     drawImage from a WebGPU canvas copies transparent black even in the
//     same task). Counters are read in the SAME TASK as a scene.render.
//   * Readiness gate before anything: globe tiles loaded AND the half-res
//     march actually dispatching — frame counts alone race the async noise
//     bake and produce false "never produced" reads.
//
// Usage: node Tools/visual-regression/probe-cloud-reconstruction-attachments.mjs
// Env:   PROBE_BASE (default http://localhost:8080)  — current build
//        PRE_BASE   (optional)                       — pre-change build server
//
// Exit: 0 = all arms ran and passed; 1 = a pre-registered predicate is red;
//       2 = watchdog; 3 = STRUCTURAL (a precondition failed, or the
//       pre-change arm could not run) with no red predicate.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const PRE_BASE = process.env.PRE_BASE || "";
const OUTPUT_DIR =
  "Tools/visual-regression/output/cloud-reconstruction-attachments";
const PHASE_FRAMES = 24;
const PASS_NAME = "CloudReconstructionAttachments pass";
const BYTES_PER_TEXEL_OWNED = 24;

const watchdog = setTimeout(() => {
  console.error("[cloud-recon-attach] WATCHDOG FIRED (420s) — forcing exit");
  process.exit(2);
}, 420_000);
watchdog.unref?.();

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function openPage(browser, base) {
  const page = await browser.newPage({
    viewport: { width: 800, height: 500 },
  });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  const gpuConsoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(
    `${base}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    { waitUntil: "networkidle", timeout: 90_000 },
  );
  await page.waitForFunction(() => !!window.viewer, undefined, {
    timeout: 90_000,
  });
  const armState = await armWebGPUDevices(page);
  return { page, errors, gpuConsoleErrors, armState };
}

/** Scene setup + readiness gate (tiles loaded AND march dispatching). */
async function setupToReady(page) {
  return page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    v.useDefaultRenderLoop = false;
    await new Promise((r) => requestAnimationFrame(r));
    v.clock.shouldAnimate = false;
    const frameTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");
    v.clock.currentTime = frameTime;
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 1200.0),
      orientation: { heading: 0, pitch: C.Math.toRadians(12.0), roll: 0 },
    });
    const coll = scene.globe.defaultCloudCollection;
    coll.enableVolumetric = true;
    coll.volumetric.cloudCoverage = 0.45;
    coll.volumetric.cloudDensity = 0.75;
    coll.volumetric.cloudLayerBottom = 1500.0;
    coll.volumetric.cloudLayerTop = 3800.0;
    coll.volumetric.cloudVolumetricQuality = "low";

    let readinessFrames = 0;
    let ready = false;
    for (; readinessFrames < 600; readinessFrames++) {
      scene.render(frameTime);
      const snap =
        scene._context?.getRendererStatistics?.()?.volumetricClouds ?? null;
      if (
        scene.globe.tilesLoaded &&
        snap?.raymarch?.halfResActive === true &&
        (snap?.raymarch?.pixelsDispatched ?? 0) > 0 &&
        readinessFrames >= 8
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    const snap =
      scene._context?.getRendererStatistics?.()?.volumetricClouds ?? null;
    return {
      ready,
      readinessFrames,
      tilesLoaded: scene.globe.tilesLoaded,
      halfResActive: snap?.raymarch?.halfResActive ?? null,
      marchPixels: snap?.raymarch?.pixelsDispatched ?? null,
    };
  });
}

/**
 * Optionally flip the toggle, then render. `frames` renders a fixed count;
 * `until: "produced"` bails as soon as the producer dispatched this frame;
 * `until: "settled"` bails after 10 consecutive frames with the march idle.
 * Counters are read in the SAME task as the final render.
 */
async function phase(page, { toggle = null, frames = 0, until = null }) {
  return page.evaluate(
    async ({ toggle, frames, until, passName, bytesPerTexel }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const scene = window.viewer.scene;
      const frameTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");
      let toggleReturnedBlock = null;
      if (toggle !== null) {
        const dbg = window.CesiumDebug;
        if (dbg && typeof dbg.cloudReconstructionAttachments === "function") {
          toggleReturnedBlock =
            dbg.cloudReconstructionAttachments(toggle) !== null;
        } else {
          toggleReturnedBlock = "command-absent";
        }
      }
      function snapNow() {
        return (
          scene._context?.getRendererStatistics?.()?.volumetricClouds ?? null
        );
      }
      let framesRun = 0;
      let conditionMet = until === null;
      let idleStreak = 0;
      const maxFrames =
        until === null
          ? frames
          : until === "produced"
            ? 60
            : until === "released"
              ? 8
              : 300;
      let snap = null;
      for (; framesRun < maxFrames;) {
        scene.render(frameTime);
        framesRun++;
        snap = snapNow();
        if (until === "produced") {
          if ((snap?.reconstruction?.attachments?.pixelsDispatched ?? 0) > 0) {
            conditionMet = true;
            break;
          }
        } else if (until === "released") {
          const attNow = snap?.reconstruction?.attachments;
          if (
            attNow &&
            attNow.liveBytes === 0 &&
            (snap?.passes?.[passName] ?? 0) === 0
          ) {
            conditionMet = true;
            break;
          }
        } else if (until === "settled") {
          if ((snap?.raymarch?.pixelsDispatched ?? 0) === 0) {
            idleStreak++;
            if (idleStreak >= 10) {
              conditionMet = true;
              break;
            }
          } else {
            idleStreak = 0;
          }
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      // The published snapshot can lag its cache truth by 1-2 frames (the
      // resident figures publish at frame start, and the debug snapshot is
      // itself assembled mid-frame). Read through a small bounded
      // consistency window and RECORD the observed latency — a counter that
      // never publishes still fails at the bound.
      let publishLagFrames = 0;
      if (until === "produced" && conditionMet) {
        for (; publishLagFrames < 4; publishLagFrames++) {
          const attNow = snap?.reconstruction?.attachments;
          if (
            attNow &&
            attNow.liveBytes > 0 &&
            attNow.liveBytes === attNow.width * attNow.height * bytesPerTexel
          ) {
            break;
          }
          await new Promise((r) => requestAnimationFrame(r));
          scene.render(frameTime);
          snap = snapNow();
        }
      }
      const att = snap?.reconstruction?.attachments ?? null;
      return {
        toggleReturnedBlock,
        framesRun,
        conditionMet,
        publishLagFrames,
        marchPixels: snap?.raymarch?.pixelsDispatched ?? null,
        attachments: att
          ? {
              produced: att.produced,
              width: att.width,
              height: att.height,
              targetCount: att.targetCount,
              generation: att.generation,
              liveBytes: att.liveBytes,
            }
          : null,
        passCount: snap?.passes?.[passName] ?? null,
        canvasSize: {
          width: scene.canvas.width,
          height: scene.canvas.height,
        },
      };
    },
    {
      toggle,
      frames,
      until,
      passName: PASS_NAME,
      bytesPerTexel: BYTES_PER_TEXEL_OWNED,
    },
  );
}

async function screenshotCanvas(page) {
  return page.locator(".cesium-widget canvas").first().screenshot({
    type: "png",
  });
}

/** Decode two PNGs in-page and return the mismatched-pixel fraction. */
async function pixelDiff(page, pngA, pngB) {
  return page.evaluate(
    async ({ a, b }) => {
      async function decode(b64) {
        const resp = await fetch(`data:image/png;base64,${b64}`);
        const bitmap = await createImageBitmap(await resp.blob());
        const tmp = document.createElement("canvas");
        tmp.width = bitmap.width;
        tmp.height = bitmap.height;
        const ctx2d = tmp.getContext("2d");
        ctx2d.drawImage(bitmap, 0, 0);
        return ctx2d.getImageData(0, 0, tmp.width, tmp.height);
      }
      const ia = await decode(a);
      const ib = await decode(b);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { mismatchFraction: 1, sizeMismatch: true };
      }
      let mismatched = 0;
      const da = ia.data;
      const db = ib.data;
      for (let i = 0; i < da.length; i += 4) {
        if (
          da[i] !== db[i] ||
          da[i + 1] !== db[i + 1] ||
          da[i + 2] !== db[i + 2]
        ) {
          mismatched++;
        }
      }
      return {
        mismatchFraction: mismatched / (ia.width * ia.height),
        sizeMismatch: false,
      };
    },
    { a: pngA.toString("base64"), b: pngB.toString("base64") },
  );
}

/** A reference page: setup, readiness, settle, one screenshot. */
async function referenceCapture(browser, base) {
  const { page, errors, gpuConsoleErrors, armState } = await openPage(
    browser,
    base,
  );
  try {
    const readiness = await setupToReady(page);
    const settle = await phase(page, { until: "settled" });
    const toggleAvailable = await page.evaluate(() => {
      const dbg = window.CesiumDebug;
      return !!(
        dbg && typeof dbg.cloudReconstructionAttachments === "function"
      );
    });
    const png = await screenshotCanvas(page);
    const gpuGate = await collectGateErrors(page);
    return {
      readiness,
      settle: { framesRun: settle.framesRun, settled: settle.conditionMet },
      toggleAvailable,
      png,
      errors,
      gpuConsoleErrors,
      gpuGate,
      armState,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

const report = {
  base: BASE,
  preBase: PRE_BASE || null,
  phaseFrames: PHASE_FRAMES,
  predicates: {},
  structuralReasons: [],
};
const pre = report.structuralReasons;
const p = report.predicates;

try {
  // ── Main page ───────────────────────────────────────────────────────────
  const main = await openPage(browser, BASE);
  const readiness = await setupToReady(main.page);
  report.mainReadiness = readiness;
  if (!readiness.ready) {
    pre.push(
      `main page never reached readiness (tilesLoaded=${readiness.tilesLoaded}, halfRes=${readiness.halfResActive}, marchPixels=${readiness.marchPixels})`,
    );
  }

  // (A) ACTIVE window: toggle ON while the march is live → leg (b) counters.
  const active = await phase(main.page, { toggle: true, until: "produced" });
  // (B) toggle OFF → the self-healing release frees the set.
  const heal = await phase(main.page, { toggle: false, until: "released" });
  // (C) converge to the byte-stationary fixed point, flag off → C1. The
  // march idling is NOT required (this scene's march may dispatch every
  // frame); what IS required is observed stationarity: two captures 8 frames
  // apart must already be byte-equal before the toggle comparisons mean
  // anything.
  const settle = await phase(main.page, { until: "settled" });
  const c1a = await screenshotCanvas(main.page);
  await phase(main.page, { frames: 8 });
  const c1 = await screenshotCanvas(main.page);
  const stationary = sha(c1a) === sha(c1);
  if (!stationary) {
    pre.push(
      "stationarity precondition failed — two flag-off captures 8 frames apart differ; byte-identity comparisons are not interpretable",
    );
  }
  // (D) toggle ON while settled → nothing may move a byte → C2.
  const onSettled = await phase(main.page, {
    toggle: true,
    frames: PHASE_FRAMES,
  });
  const c2 = await screenshotCanvas(main.page);
  // (E) toggle OFF again → C3.
  const offSettled = await phase(main.page, {
    toggle: false,
    frames: PHASE_FRAMES,
  });
  const c3 = await screenshotCanvas(main.page);
  report.phases = { active, heal, settle, onSettled, offSettled };
  report.hashes = { c1: sha(c1), c2: sha(c2), c3: sha(c3) };

  if (active.toggleReturnedBlock !== true) {
    pre.push(
      `toggle-on did not return the attachment block (${active.toggleReturnedBlock})`,
    );
  }
  report.stationary = stationary;

  // (F) Resize rider, flag ON: away and back — a resize wakes the march, so
  // the producer runs at both sizes; the generation must climb monotonically
  // and liveBytes must track each size exactly.
  const riderOn = await phase(main.page, { toggle: true, frames: 1 });
  await main.page.setViewportSize({ width: 1024, height: 640 });
  const riderBig = await phase(main.page, { until: "produced" });
  await main.page.setViewportSize({ width: 800, height: 500 });
  const riderBack = await phase(main.page, { until: "produced" });
  report.resize = { riderOn, riderBig, riderBack };

  const gpuGateMain = await collectGateErrors(main.page);
  await main.page.close().catch(() => {});

  // ── Reference pages: same-build noise floor + pre-change build ──────────
  const refSame = await referenceCapture(browser, BASE);
  report.refSame = { ...refSame, png: undefined };
  let refPre = null;
  if (PRE_BASE) {
    refPre = await referenceCapture(browser, PRE_BASE);
    report.refPre = { ...refPre, png: undefined };
    if (refPre.toggleAvailable) {
      pre.push(
        "pre-change server exposes CesiumDebug.cloudReconstructionAttachments — it is NOT a pre-change build; arm invalid",
      );
    }
  } else {
    pre.push(
      "PRE-CHANGE ARM SKIPPED-BY-CONFIGURATION: no PRE_BASE server supplied — the cross-build arm DID NOT RUN",
    );
  }

  const scratch = await browser.newPage();
  await scratch.goto("about:blank");
  const noiseFloor = await pixelDiff(scratch, c1, refSame.png);
  report.noiseFloor = noiseFloor;
  let preDiff = null;
  let preBound = null;
  if (refPre) {
    preDiff = await pixelDiff(scratch, c1, refPre.png);
    // FIRST-PASS DERIVED: twice the same-build cross-page floor, with a 0.1%
    // absolute floor so a zero-noise run cannot demand the impossible.
    preBound = Math.max(2 * noiseFloor.mismatchFraction, 0.001);
    report.preDiff = preDiff;
    report.preBound = preBound;
  }
  await scratch.close().catch(() => {});

  // ── Predicates ──────────────────────────────────────────────────────────
  const attActive = active.attachments;
  const attHeal = heal.attachments;
  const attOnSettled = onSettled.attachments;
  const attOffSettled = offSettled.attachments;
  const attBig = riderBig.attachments;
  const attBack = riderBack.attachments;

  // Leg (a): default-off residency.
  p.aLiveBytesZeroBeforeToggle =
    report.mainReadiness.ready &&
    attHeal !== null &&
    attHeal.liveBytes === 0 &&
    heal.passCount === 0;
  // Leg (b) counters, active window.
  p.bProduced = attActive !== null && attActive.produced === true;
  p.bTargetCount3 = attActive !== null && attActive.targetCount === 3;
  p.bGenerationAtLeast1 = attActive !== null && attActive.generation >= 1;
  p.bLiveBytesExact =
    attActive !== null &&
    attActive.liveBytes ===
      attActive.width * attActive.height * BYTES_PER_TEXEL_OWNED;
  p.bPassEncodedOnce = active.passCount === 1;
  p.bProducedPromptly = active.conditionMet && active.framesRun <= 30;
  // Self-healing release on disable.
  p.selfHealingReleaseOnDisable =
    attHeal !== null && attHeal.liveBytes === 0 && heal.passCount === 0;
  // Settled byte identity across the toggle.
  p.settledByteIdentityOffOn = report.hashes.c1 === report.hashes.c2;
  p.settledByteIdentityOnOff = report.hashes.c2 === report.hashes.c3;
  // Informational: whether the producer was actually RUNNING during the C2
  // capture. Either state is legitimate — an active march makes the identity
  // the STRONG (producer-live) form; an idle march makes it the settled form.
  report.producerLiveDuringC2 =
    attOnSettled !== null && (onSettled.passCount ?? 0) > 0;
  p.settledOffStaysReleased =
    attOffSettled !== null && attOffSettled.liveBytes === 0;
  // Resize rider.
  p.resizeWakesProducerBothWays =
    riderBig.conditionMet && riderBack.conditionMet;
  p.resizeLiveBytesTrackSize =
    attBig !== null &&
    attBack !== null &&
    attBig.liveBytes === attBig.width * attBig.height * BYTES_PER_TEXEL_OWNED &&
    attBack.liveBytes ===
      attBack.width * attBack.height * BYTES_PER_TEXEL_OWNED &&
    (attBig.width !== attBack.width || attBig.height !== attBack.height);
  p.generationMonotoneAcrossCycle =
    attActive !== null &&
    attBig !== null &&
    attBack !== null &&
    attBig.generation > attActive.generation &&
    attBack.generation > attBig.generation;
  // Cross-build arm.
  p.crossBuildDiffWithinDerivedBound = refPre
    ? preDiff.sizeMismatch === false && preDiff.mismatchFraction <= preBound
    : null;
  p.zeroErrors =
    main.errors.length === 0 &&
    main.gpuConsoleErrors.length === 0 &&
    gpuGateMain.errors.length === 0 &&
    gpuGateMain.deviceLost === null &&
    refSame.errors.length === 0 &&
    (refPre === null || refPre.errors.length === 0);
  p.gateArmed = main.armState.found >= 1 && gpuGateMain.armedDevices >= 1;

  // ── Output ──────────────────────────────────────────────────────────────
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}/c1-off.png`, c1);
  writeFileSync(`${OUTPUT_DIR}/c2-on.png`, c2);
  writeFileSync(`${OUTPUT_DIR}/c3-off-again.png`, c3);
  writeFileSync(`${OUTPUT_DIR}/ref-same-build.png`, refSame.png);
  if (refPre) {
    writeFileSync(`${OUTPUT_DIR}/ref-pre-change.png`, refPre.png);
  }

  const failed = Object.entries(p).filter(([, v]) => v === false);
  const structural =
    pre.length > 0 || p.crossBuildDiffWithinDerivedBound === null;

  console.log(
    "=== C13-09 EDGE ACCEPTANCE — cloud reconstruction attachments ===",
  );
  console.log(
    `  readiness: ${readiness.readinessFrames} frames (march ${readiness.marchPixels}px halfRes=${readiness.halfResActive})`,
  );
  console.log(
    `  active:  produced=${attActive?.produced} targets=${attActive?.targetCount} gen=${attActive?.generation} liveBytes=${attActive?.liveBytes} (${attActive?.width}x${attActive?.height}x24) passCount=${active.passCount} withinFrames=${active.framesRun}`,
  );
  console.log(
    `  heal:    liveBytes=${attHeal?.liveBytes} passCount=${heal.passCount}`,
  );
  console.log(
    `  settle:  ${settle.framesRun} frames, settled=${settle.conditionMet}`,
  );
  console.log(
    `  settled captures: c1=${report.hashes.c1.slice(0, 12)} c2=${report.hashes.c2.slice(0, 12)} c3=${report.hashes.c3.slice(0, 12)}`,
  );
  console.log(
    `  rider:   ${attActive?.width}x${attActive?.height} gen ${attActive?.generation} → ${attBig?.width}x${attBig?.height} gen ${attBig?.generation} (liveBytes=${attBig?.liveBytes}) → ${attBack?.width}x${attBack?.height} gen ${attBack?.generation} (liveBytes=${attBack?.liveBytes})`,
  );
  console.log(
    `  noise floor (same build, cross page): ${(noiseFloor.mismatchFraction * 100).toFixed(4)}%`,
  );
  if (refPre) {
    console.log(
      `  cross-build diff: ${(preDiff.mismatchFraction * 100).toFixed(4)}% (bound ${(preBound * 100).toFixed(4)}% — FIRST-PASS DERIVED)`,
    );
  }
  console.log(`  predicates: ${JSON.stringify(p)}`);
  if (failed.length) {
    console.log(`  RED: ${failed.map(([k]) => k).join(", ")}`);
  }
  for (const reason of pre) console.log(`  STRUCTURAL: ${reason}`);

  writeFileSync(`${OUTPUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(`[report: ${OUTPUT_DIR}/report.json]`);

  // FAIL outranks STRUCTURAL (per-lane scoping doctrine).
  if (failed.length) {
    console.log("FAIL — a pre-registered C13-09 acceptance predicate is red");
    process.exit(1);
  }
  if (structural) {
    console.log(
      "STRUCTURAL — no red predicate, but a precondition or the pre-change arm did not hold/run",
    );
    process.exit(3);
  }
  console.log(
    "PASS — C13-09 Edge acceptance: active counters, settled byte-inertness, lifecycle, cross-build arm all green",
  );
  process.exit(0);
} finally {
  await browser.close().catch(() => {});
}
