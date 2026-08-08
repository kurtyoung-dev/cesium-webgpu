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
//     stationarity PRECONDITION (two flag-off captures 8 EXECUTES apart must
//     already be byte-equal). The march may keep dispatching at the fixed
//     point — in the certified first run it dispatched every frame, so the
//     identity held with the producer LIVE, the strongest form of leg (b).
//     A march-idle "settle" state is bounded-waited-for but NOT required.
//   * The published counters lag cache truth by 1-2 EXECUTES (resident
//     figures publish at frame start, before the producer's ensure).
//     Counter predicates read through a small bounded consistency window
//     and record the observed latency (publishLagExecutes); a counter that
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
// ── WHAT CHANGED AFTER THE RESOLVE CAME BACK (Batch 942 → CO-32) ─────────
//
// Three windows went red on the resolve-alive build —
// `aLiveBytesZeroBeforeToggle`, `bLiveBytesExact` and
// `selfHealingReleaseOnDisable` — and the cause was NOT the subject. Batch
// 942 restored the temporal resolve; with the resolve alive the cloud lane
// converges, and under `?offline=true` (which forces `requestRenderMode:
// true`) plus a pinned clock, `scene.render(t)` then executes NOTHING. Every
// window in this probe counted RENDER CALLS, and render calls had stopped
// being frames: the publish-lag window burned all 4 of its calls and the
// release window all 8 of its calls against a FROZEN published snapshot.
// The same freeze made `c1 === c2 === c3` green VACUOUSLY — nothing rendered
// between those captures at all.
//
// The repair is in `lib/cloud-refresh-skip.mjs` and is twofold: KEEP-LIVE
// (`scene.requestRender()` before every render — the minimal invalidation,
// derivation and rejected alternatives in that module) and EXECUTE-COUNTED
// BOUNDS (every budget denominated in `volumetricClouds.frames`, the engine's
// own execute counter). Predicate MEANINGS are unchanged; a counter that
// never publishes still fails at its bound. What changed is that the bound
// now measures engine frames instead of no-ops, the stationarity captures
// carry an ANTI-VACUITY check (byte-equality across zero executes is not
// evidence), and the resize rider waits on a condition the PRE-resize state
// cannot satisfy rather than on "produced", which it always could.
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
import {
  REFRESH_SKIP_BOUNDS,
  classifyExecuteWindow,
  foldStationarity,
  renderCallBudget,
  starvedWindowReasons,
} from "./lib/cloud-refresh-skip.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const PRE_BASE = process.env.PRE_BASE || "";
const OUTPUT_DIR =
  "Tools/visual-regression/output/cloud-reconstruction-attachments";
const PHASE_EXECUTES = 24;
const PASS_NAME = "CloudReconstructionAttachments pass";
const BYTES_PER_TEXEL_OWNED = 24;
const STATIONARITY_GAP_EXECUTES = REFRESH_SKIP_BOUNDS.stationarityGapExecutes;
const STATIONARITY_MAX_ROUNDS = REFRESH_SKIP_BOUNDS.stationarityMaxRounds;
const PUBLISH_LAG_MAX = REFRESH_SKIP_BOUNDS.publishLagExecutes;
const VIEWPORT = { width: 800, height: 500 };
const RESIZED = { width: 1024, height: 640 };

// Bounded EXECUTE budgets, re-derived for the resolve-alive build.
//
//   produced  — unchanged at 60; the producer runs on the first enabled
//               execute and this is 60x that.
//   released  — 8 render calls became 12 EXECUTES. The self-heal fires during
//               pack on the first execute after the flag clears, the producer
//               pass count drops on that same execute, and the resident byte
//               figure publishes within the measured 1-2 execute lag: 4
//               executes suffice, 12 is 3x that. The PREDICATE is untouched —
//               it still demands liveBytes === 0 AND passCount === 0.
//   settled   — 300 render calls became 60 EXECUTES, because in this fixture
//               `settled` is UNREACHABLE by construction: the half-res march
//               dispatches 100,000 px on every execute in every run on record,
//               so the 10-consecutive-idle condition can never hold. The phase
//               is a bounded warm-up and nothing more; the real convergence
//               proof is the stationarity gate that follows it, which is
//               condition-based and therefore does not need this to be large.
//   resized   — new. The resize rider used to wait on "produced", which the
//               PRE-resize state already satisfied; it now waits on a
//               condition only the POST-resize state can satisfy. 30 executes
//               is 15x the 2-execute publish lag measured after a resize.
const UNTIL_LIMITS = Object.freeze({
  produced: 60,
  released: 12,
  settled: 60,
  resized: 30,
});

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
    viewport: VIEWPORT,
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

/**
 * Scene setup + readiness gate (tiles loaded AND march dispatching).
 *
 * The loop is KEPT LIVE, and the return records the two facts the keep-live
 * derivation rests on: this page really is in `requestRenderMode` (so the fix
 * addresses a mechanism that exists), and snapshot mode is NOT enabled (so
 * `requestRender()`'s only effect beyond the gate flag is unreachable).
 */
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
      scene.requestRender();
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
      executes: snap?.frames ?? null,
      requestRenderMode: scene.requestRenderMode === true,
      snapshotModeEnabled: scene.snapshotMode?.enabled === true,
      snapshotModeFrozen: scene.snapshotMode?.isFrozen === true,
    };
  });
}

/**
 * Pump KEPT-LIVE render calls until the canvas backing store leaves the size it
 * is at now.
 *
 * `Viewer.prototype.resize` is subscribed to `scene.postUpdate`, which fires
 * OUTSIDE the `shouldRender` block, so the first render call after a viewport
 * change reconfigures the canvas and requests the NEXT frame. Waiting on the
 * CHANGE rather than on an expected number keeps this device-pixel-ratio
 * agnostic.
 */
async function awaitCanvasChange(page, previous) {
  const callBudget = renderCallBudget(UNTIL_LIMITS.resized);
  return page.evaluate(
    async ({ previous, callBudget }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const scene = window.viewer.scene;
      const frameTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");
      let renderCalls = 0;
      let changed = false;
      for (; renderCalls < callBudget;) {
        scene.requestRender();
        scene.render(frameTime);
        renderCalls++;
        if (
          scene.canvas.width !== previous.width ||
          scene.canvas.height !== previous.height
        ) {
          changed = true;
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        changed,
        renderCalls,
        width: scene.canvas.width,
        height: scene.canvas.height,
      };
    },
    { previous, callBudget },
  );
}

/**
 * Optionally flip the toggle, then render KEPT-LIVE frames.
 *
 * `executes` renders until that many ENGINE EXECUTES have happened;
 * `until: "produced"` bails as soon as the producer dispatched this frame;
 * `until: "released"` bails when the set is freed AND its pass is gone;
 * `until: "settled"` bails after 10 consecutive executes with the march idle;
 * `until: "resized"` bails only on a state the PRE-resize snapshot cannot
 * impersonate. Counters are read in the SAME task as the final render.
 *
 * ★ EXECUTES, NOT RENDER CALLS. `volumetricClouds.frames` is bumped by
 * `resetCloudFrameCounters` at the top of every `executeProceduralClouds`, so
 * it is the only counter that distinguishes a frame from a refresh-skipped
 * no-op. The render-call budget survives purely as a loop bound, and a window
 * that exhausts it without earning its executes is classified STARVED —
 * structural, never a finding.
 */
async function phase(
  page,
  { label = "phase", toggle = null, executes = 0, until = null, expect = null },
) {
  const executeBudget =
    until === null ? Math.max(1, executes) : UNTIL_LIMITS[until];
  const callBudget = renderCallBudget(executeBudget);
  const raw = await page.evaluate(
    async ({
      toggle,
      until,
      expect,
      passName,
      bytesPerTexel,
      executeBudget,
      callBudget,
      publishLagMax,
    }) => {
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
      // ★ KEEP-LIVE. `cloudReconstructionAttachments()` does not request a
      // render, and a converged scene under `requestRenderMode` would swallow
      // every render call that follows — including the ones meant to APPLY the
      // toggle.
      const renderLive = () => {
        scene.requestRender();
        scene.render(frameTime);
      };
      const executesAtStart = snapNow()?.frames ?? 0;
      let renderCalls = 0;
      let executesRun = 0;
      let conditionMet = false;
      let idleStreak = 0;
      let snap = null;
      for (; renderCalls < callBudget && executesRun < executeBudget;) {
        renderLive();
        renderCalls++;
        snap = snapNow();
        executesRun = (snap?.frames ?? executesAtStart) - executesAtStart;
        const attNow = snap?.reconstruction?.attachments;
        if (until === "produced") {
          if ((attNow?.pixelsDispatched ?? 0) > 0) {
            conditionMet = true;
            break;
          }
        } else if (until === "released") {
          if (
            attNow &&
            attNow.liveBytes === 0 &&
            (snap?.passes?.[passName] ?? 0) === 0
          ) {
            conditionMet = true;
            break;
          }
        } else if (until === "resized") {
          // Deliberately NOT satisfiable by the pre-resize state: the dims must
          // have moved AND the generation must have advanced past the value the
          // caller measured before the viewport changed.
          if (
            attNow &&
            attNow.width > 0 &&
            attNow.height > 0 &&
            (attNow.width !== expect?.previousWidth ||
              attNow.height !== expect?.previousHeight) &&
            attNow.generation > (expect?.previousGeneration ?? -1)
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
      // A fixed-execute phase "arrives" by spending its whole budget — so a
      // starved one is classified starved instead of quietly reading green.
      if (until === null) {
        conditionMet = executesRun >= executeBudget;
      }
      // The published snapshot can lag its cache truth by 1-2 EXECUTES (the
      // resident figures publish at frame start, and the debug snapshot is
      // itself assembled mid-frame). Read through a small bounded
      // consistency window and RECORD the observed latency — a counter that
      // never publishes still fails at the bound.
      let publishLagExecutes = 0;
      if ((until === "produced" || until === "resized") && conditionMet) {
        for (; publishLagExecutes < publishLagMax; publishLagExecutes++) {
          const attNow = snap?.reconstruction?.attachments;
          if (
            attNow &&
            attNow.liveBytes > 0 &&
            attNow.liveBytes === attNow.width * attNow.height * bytesPerTexel
          ) {
            break;
          }
          await new Promise((r) => requestAnimationFrame(r));
          renderLive();
          renderCalls++;
          snap = snapNow();
        }
        executesRun = (snap?.frames ?? executesAtStart) - executesAtStart;
      }
      const att = snap?.reconstruction?.attachments ?? null;
      return {
        toggleReturnedBlock,
        renderCalls,
        executesRun,
        conditionMet,
        publishLagExecutes,
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
      until,
      expect,
      passName: PASS_NAME,
      bytesPerTexel: BYTES_PER_TEXEL_OWNED,
      executeBudget,
      callBudget,
      publishLagMax: PUBLISH_LAG_MAX,
    },
  );
  return {
    ...raw,
    ...classifyExecuteWindow({
      conditionMet: raw.conditionMet,
      executesRun: raw.executesRun,
      renderCalls: raw.renderCalls,
      executeBudget,
      renderCallBudget: callBudget,
    }),
    label,
    until,
  };
}

async function screenshotCanvas(page) {
  return page.locator(".cesium-widget canvas").first().screenshot({
    type: "png",
  });
}

/**
 * Converge one state to its OWN byte-stationary fixed point, then capture it.
 *
 * Two screenshots `STATIONARITY_GAP_EXECUTES` REAL executes apart must be
 * byte-equal, retried up to `STATIONARITY_MAX_ROUNDS` times. The rounds turn
 * "assume it converged" into "observe that it converged, or say it did not",
 * and `executesObserved` is what makes the byte-equality mean anything at all:
 * two identical captures separated by ZERO executes — the shape this probe's
 * `c1 === c2 === c3` had on the resolve-alive build — prove nothing.
 */
async function captureStationary(page, label) {
  const rounds = [];
  let previousPng = await screenshotCanvas(page);
  let previousSha = sha(previousPng);
  let executesObserved = 0;
  for (let round = 0; round < STATIONARITY_MAX_ROUNDS; round++) {
    const gap = await phase(page, {
      label: `${label}:stationarity:${round}`,
      executes: STATIONARITY_GAP_EXECUTES,
    });
    const png = await screenshotCanvas(page);
    const digest = sha(png);
    const equal = digest === previousSha;
    executesObserved = gap.executesRun;
    rounds.push({
      round,
      executesRun: gap.executesRun,
      renderCalls: gap.renderCalls,
      outcome: gap.outcome,
      equal,
    });
    if (equal) {
      return {
        label,
        png,
        sha: digest,
        stationary: true,
        rounds,
        executesObserved,
      };
    }
    previousPng = png;
    previousSha = digest;
  }
  return {
    label,
    png: previousPng,
    sha: previousSha,
    stationary: false,
    rounds,
    executesObserved,
  };
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

/**
 * A reference page: setup, readiness, bounded warm-up, then a STATIONARY
 * capture.
 *
 * The stationarity gate matters here for a reason specific to this endpoint: an
 * unconverged reference INFLATES the same-build cross-page noise floor, and the
 * cross-build bound is `max(2 x floor, 0.1%)` — so a sloppy reference makes the
 * pre-change arm EASIER to pass. Gating it is the only way the derived bound
 * stays honest.
 */
async function referenceCapture(browser, base) {
  const { page, errors, gpuConsoleErrors, armState } = await openPage(
    browser,
    base,
  );
  try {
    const readiness = await setupToReady(page);
    const settle = await phase(page, { label: "ref:settle", until: "settled" });
    const toggleAvailable = await page.evaluate(() => {
      const dbg = window.CesiumDebug;
      return !!(
        dbg && typeof dbg.cloudReconstructionAttachments === "function"
      );
    });
    const capture = await captureStationary(page, `reference:${base}`);
    const gpuGate = await collectGateErrors(page);
    return {
      readiness,
      settle: {
        renderCalls: settle.renderCalls,
        executesRun: settle.executesRun,
        settled: settle.conditionMet,
        outcome: settle.outcome,
      },
      toggleAvailable,
      png: capture.png,
      capture: { ...capture, png: undefined },
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
  phaseExecutes: PHASE_EXECUTES,
  refreshSkipBounds: REFRESH_SKIP_BOUNDS,
  untilLimits: UNTIL_LIMITS,
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
  if (readiness.snapshotModeEnabled || readiness.snapshotModeFrozen) {
    pre.push(
      `KEEP-LIVE PREMISE BROKEN — snapshot mode is enabled=${readiness.snapshotModeEnabled} frozen=${readiness.snapshotModeFrozen}, so scene.requestRender() also marks a snapshot dirty and is no longer a pure gate flip`,
    );
  }

  const windowLedger = [];
  const track = (window) => {
    windowLedger.push({
      label: window.label,
      outcome: window.outcome,
      executesRun: window.executesRun,
      executeBudget: window.executeBudget,
      renderCalls: window.renderCalls,
      renderCallBudget: window.renderCallBudget,
    });
    return window;
  };

  // (A) ACTIVE window: toggle ON while the march is live → leg (b) counters.
  const active = track(
    await phase(main.page, {
      label: "active",
      toggle: true,
      until: "produced",
    }),
  );
  // (B) toggle OFF → the self-healing release frees the set.
  const heal = track(
    await phase(main.page, { label: "heal", toggle: false, until: "released" }),
  );
  // (C) converge to the byte-stationary fixed point, flag off → C1. The
  // march idling is NOT required (this scene's march may dispatch every
  // frame); what IS required is observed stationarity across REAL executes.
  const settle = track(
    await phase(main.page, { label: "settle", until: "settled" }),
  );
  const c1Capture = await captureStationary(main.page, "flag-off");
  const c1 = c1Capture.png;
  // (D) toggle ON while settled → nothing may move a byte → C2.
  const onSettled = track(
    await phase(main.page, {
      label: "on-settled",
      toggle: true,
      executes: PHASE_EXECUTES,
    }),
  );
  const c2 = await screenshotCanvas(main.page);
  // (E) toggle OFF again → C3.
  const offSettled = track(
    await phase(main.page, {
      label: "off-settled",
      toggle: false,
      executes: PHASE_EXECUTES,
    }),
  );
  const c3 = await screenshotCanvas(main.page);
  report.phases = { active, heal, settle, onSettled, offSettled };
  report.hashes = { c1: sha(c1), c2: sha(c2), c3: sha(c3) };

  if (active.toggleReturnedBlock !== true) {
    pre.push(
      `toggle-on did not return the attachment block (${active.toggleReturnedBlock})`,
    );
  }
  // The stationarity fold also carries the ANTI-VACUITY check: byte-equality
  // across zero engine executes is not evidence of anything.
  const stationarityFold = foldStationarity([
    {
      label: "flag-off",
      stationary: c1Capture.stationary,
      rounds: c1Capture.rounds,
      executesObserved: c1Capture.executesObserved,
    },
  ]);
  const stationary = stationarityFold.stationary["flag-off"] === true;
  if (!stationary) {
    pre.push(
      "stationarity precondition failed — two flag-off captures 8 EXECUTES apart never became byte-equal; byte-identity comparisons are not interpretable",
    );
    for (const reason of stationarityFold.reasons) {
      pre.push(reason);
    }
  }
  report.stationary = stationary;
  report.stationarityCapture = { ...c1Capture, png: undefined };

  // (F) Resize rider, flag ON: away and back — a resize wakes the march, so
  // the producer runs at both sizes; the generation must climb monotonically
  // and liveBytes must track each size exactly.
  //
  // ★ The arrival condition is `resized`, not `produced`. `produced` was
  // ALREADY TRUE before the viewport moved, so it could be satisfied by a
  // pre-resize snapshot; `resized` requires the dims to have MOVED and the
  // generation to have advanced past the pre-resize value.
  //
  // The re-enable runs for 4 EXECUTES rather than 1: the baseline the `resized`
  // condition discriminates against must be a frame the producer actually ran,
  // and the measured resident publish lag is 1-2 executes. A degenerate
  // baseline (zero dims or zero generation) would be satisfiable by the stale
  // state, so it is NAMED instead of quietly measured.
  const riderOn = track(
    await phase(main.page, { label: "rider-on", toggle: true, executes: 4 }),
  );
  const beforeBig = {
    previousWidth: riderOn.attachments?.width ?? 0,
    previousHeight: riderOn.attachments?.height ?? 0,
    previousGeneration: riderOn.attachments?.generation ?? 0,
  };
  if (!(beforeBig.previousWidth > 0) || !(beforeBig.previousGeneration > 0)) {
    pre.push(
      `RESIZE BASELINE DEGENERATE — the pre-resize attachment state read ${beforeBig.previousWidth}x${beforeBig.previousHeight} gen ${beforeBig.previousGeneration}; the resize arrival condition cannot discriminate against it`,
    );
  }
  await main.page.setViewportSize(RESIZED);
  const canvasBig = await awaitCanvasChange(main.page, {
    width: riderOn.canvasSize?.width ?? VIEWPORT.width,
    height: riderOn.canvasSize?.height ?? VIEWPORT.height,
  });
  const riderBig = track(
    await phase(main.page, {
      label: "rider-big",
      until: "resized",
      expect: beforeBig,
    }),
  );
  const beforeBack = {
    previousWidth: riderBig.attachments?.width ?? 0,
    previousHeight: riderBig.attachments?.height ?? 0,
    previousGeneration: riderBig.attachments?.generation ?? 0,
  };
  await main.page.setViewportSize(VIEWPORT);
  const canvasBack = await awaitCanvasChange(main.page, {
    width: canvasBig.width,
    height: canvasBig.height,
  });
  const riderBack = track(
    await phase(main.page, {
      label: "rider-back",
      until: "resized",
      expect: beforeBack,
    }),
  );
  report.resize = { riderOn, canvasBig, riderBig, canvasBack, riderBack };
  if (!canvasBig.changed || !canvasBack.changed) {
    pre.push(
      `RESIZE PLUMBING — the canvas backing store did not change within its bound (big=${canvasBig.changed} ${canvasBig.width}x${canvasBig.height}, back=${canvasBack.changed} ${canvasBack.width}x${canvasBack.height}); the rider did not see its subject`,
    );
  }

  const gpuGateMain = await collectGateErrors(main.page);
  await main.page.close().catch(() => {});

  // ── Reference pages: same-build noise floor + pre-change build ──────────
  const refSame = await referenceCapture(browser, BASE);
  report.refSame = { ...refSame, png: undefined };
  if (refSame.capture.stationary !== true) {
    pre.push(
      "same-build REFERENCE never became stationary — an unconverged reference INFLATES the noise floor, and the cross-build bound is derived from that floor",
    );
  }
  let refPre = null;
  if (PRE_BASE) {
    refPre = await referenceCapture(browser, PRE_BASE);
    report.refPre = { ...refPre, png: undefined };
    if (refPre.toggleAvailable) {
      pre.push(
        "pre-change server exposes CesiumDebug.cloudReconstructionAttachments — it is NOT a pre-change build; arm invalid",
      );
    }
    if (refPre.capture.stationary !== true) {
      pre.push(
        "pre-change REFERENCE never became stationary — the cross-build diff would measure convergence phase, not the build difference",
      );
    }
  } else {
    pre.push(
      "PRE-CHANGE ARM SKIPPED-BY-CONFIGURATION: no PRE_BASE server supplied — the cross-build arm DID NOT RUN",
    );
  }

  for (const reason of starvedWindowReasons(windowLedger)) {
    pre.push(reason);
  }
  report.windowLedger = windowLedger;

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
  p.bProducedPromptly = active.conditionMet && active.executesRun <= 30;
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
    `  readiness: ${readiness.readinessFrames} frames (march ${readiness.marchPixels}px halfRes=${readiness.halfResActive}) requestRenderMode=${readiness.requestRenderMode} snapshotMode=${readiness.snapshotModeEnabled}/${readiness.snapshotModeFrozen}`,
  );
  console.log(
    `  active:  produced=${attActive?.produced} targets=${attActive?.targetCount} gen=${attActive?.generation} liveBytes=${attActive?.liveBytes} (${attActive?.width}x${attActive?.height}x24) passCount=${active.passCount} withinExecutes=${active.executesRun} lag=${active.publishLagExecutes}e (${active.outcome})`,
  );
  console.log(
    `  heal:    liveBytes=${attHeal?.liveBytes} passCount=${heal.passCount} withinExecutes=${heal.executesRun}/${heal.executeBudget} (${heal.outcome})`,
  );
  console.log(
    `  settle:  ${settle.executesRun} executes in ${settle.renderCalls} calls, settled=${settle.conditionMet} (unreachable by design in this fixture)`,
  );
  console.log(
    `  stationarity: ${stationary} after ${c1Capture.rounds.length} rounds of ${STATIONARITY_GAP_EXECUTES} executes (observed ${c1Capture.executesObserved})`,
  );
  console.log(
    `  settled captures: c1=${report.hashes.c1.slice(0, 12)} c2=${report.hashes.c2.slice(0, 12)} c3=${report.hashes.c3.slice(0, 12)} producerLiveDuringC2=${report.producerLiveDuringC2}`,
  );
  console.log(
    `  rider:   ${attActive?.width}x${attActive?.height} gen ${attActive?.generation} → ${attBig?.width}x${attBig?.height} gen ${attBig?.generation} (liveBytes=${attBig?.liveBytes}, ${riderBig.executesRun}e, ${riderBig.outcome}) → ${attBack?.width}x${attBack?.height} gen ${attBack?.generation} (liveBytes=${attBack?.liveBytes}, ${riderBack.executesRun}e, ${riderBack.outcome})`,
  );
  console.log(
    `  noise floor (same build, cross page): ${(noiseFloor.mismatchFraction * 100).toFixed(4)}% (reference stationary=${refSame.capture.stationary})`,
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
