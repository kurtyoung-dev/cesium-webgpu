#!/usr/bin/env node
// Probe (C13-09 OWED EDGE ACCEPTANCE, machine lane): the reconstruction
// attachment set is opt-in scaffolding — resident and producing when asked,
// invisible in pixels AND cost when not (and even when asked, because nothing
// reads it yet; the consumers are C13-10/12).
// @purpose C13-09 edge acceptance: opt-in reconstruction attachments produce with pixel-inert output and exact liveBytes; cross-page noise-band method
// @status ACTIVE
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
//     as a cross-build byte compare. It is discharged by: same-page pixel
//     inertness across the toggle + a cross-build PIXEL DIFF judged against
//     the instrument's own same-build CROSS-PAGE BAND (measured in the same
//     run, calibrated in the same run — see the CO-33 note below; it used to
//     be `max(2 x floor, 0.1%)` over a single reading, which at the measured
//     29.2% floor was a 58% bound) + the structural spec pins (no attachment
//     sampler in resolve/upscale; composite source unchanged). Active-window
//     pixel-inertness rests on those structural pins — a live A/B of the same
//     frame index on one timeline is not constructible.
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
// ── WHAT CHANGED AFTER THE BATCH-953 RUN (CO-33) — THE VISUAL ARM ────────
//
// ★ TWO PREDICATE MEANINGS CHANGED IN THIS PROBE. Read this before comparing
// a new run against an old one.
//
// The Batch-953 run had every counter and lifecycle predicate green and the
// two settled-byte-identity predicates RED — on a FAILED stationarity
// precondition. Eight rounds of eight real executes never produced two
// byte-equal captures, and the structural block said so in the same output
// that reported the reds. A predicate that fires red on a precondition it
// declared broken is an instrument fault, not a finding: the C13-09 subject
// was never given a chance to pass or fail.
//
//   1. `settledByteIdentityOffOn` / `settledByteIdentityOnOff` are now
//      TRI-STATE. They keep their exact meaning WHEN THEY APPLY — two
//      byte-stationary captures must be byte-equal — and read NULL, with a
//      named structural reason, when the stationarity precondition fails.
//      Null routes to STRUCTURAL, never to green (the consume probe's own
//      pattern, now shared).
//
//   2. NEW `pixelInertOffOnWithinBand` / `pixelInertOnOffWithinBand` — the
//      LIVE-frame form of the same claim, and the reason this is a REDESIGN
//      rather than a gate. Under keep-live the frame genuinely never settles:
//      a jittered half-res march feeding a temporal resolve orbits, it does
//      not converge, so byte identity tests a property the subject does not
//      have. These predicates instead measure each state's OWN frame-to-frame
//      fluctuation, derive a band from it (`max + range + floor`, FIRST-PASS
//      DERIVED), pool the two endpoint states' fluctuation, and require the
//      cross-state difference to sit inside. The band is calibrated IN-RUN by
//      an injected control ladder: the smallest perturbation it rejects is the
//      published sensitivity of the claim, and a band that rejects NOTHING is
//      named `BAND NOT DISCRIMINATING` and yields null rather than green.
//      Full derivation and every rejected alternative: `cloud-refresh-skip.mjs`
//      section 3.
//
// The C2 and C3 captures are now converged through the same per-state gate C1
// always used, so all three endpoints contribute fluctuation samples, and the
// cross-build arm's bound is likewise a cross-PAGE band rather than a doubled
// single reading (a 29.2% floor doubled is a 58% bound — a number that could
// not fail).
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
  BAND_BOUNDS,
  COARSE_DELTA_LEVELS,
  CONTROL_LADDER,
  REFRESH_SKIP_BOUNDS,
  TIER_BAND,
  TIER_NONE,
  TIER_STATIONARY,
  classifyExecuteWindow,
  deriveFluctuationBand,
  describeBand,
  describeDetection,
  describeInertness,
  foldDetectionLimit,
  foldPixelInertness,
  foldStationarity,
  ladderBlock,
  pixelInertnessReasons,
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
const BAND_SAMPLE_CAP = BAND_BOUNDS.sampleCap;
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

function pct(fraction) {
  return fraction === null || fraction === undefined
    ? "n/a"
    : `${(fraction * 100).toFixed(4)}%`;
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
  // ★ THE ROUNDS ARE ALSO THE BAND'S SAMPLES. When the state does converge the
  // gate returns early and these are unused; when it does NOT — the live regime
  // — consecutive rounds separated by real executes ARE this state's own
  // frame-to-frame fluctuation, which is the only honest baseline a cross-state
  // diff can be judged against. The LAST `BAND_SAMPLE_CAP` are kept: a gate's
  // early rounds are still on the convergence curve, and the tail is the orbit.
  const samples = [{ png: previousPng, sha: previousSha, executesRun: 0 }];
  let executesObserved = 0;
  const keep = (sample) => {
    samples.push(sample);
    if (samples.length > BAND_SAMPLE_CAP) {
      samples.shift();
    }
  };
  for (let round = 0; round < STATIONARITY_MAX_ROUNDS; round++) {
    const gap = await phase(page, {
      label: `${label}:stationarity:${round}`,
      executes: STATIONARITY_GAP_EXECUTES,
    });
    const png = await screenshotCanvas(page);
    const digest = sha(png);
    const equal = digest === previousSha;
    executesObserved = gap.executesRun;
    keep({ png, sha: digest, executesRun: gap.executesRun });
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
        samples,
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
    samples,
  };
}

// ── PIXEL COMPARISON KERNEL — pinned BYTE-IDENTICAL across both cloud
// reconstruction probes by cloud-refresh-skip.spec.mjs (section G). Edit both
// copies or neither: a silent divergence would leave the two probes' bands
// incomparable while every printed number still looked plausible. ────────────

/**
 * Decode two PNGs on a scratch page and return the statistic profile of their
 * difference — optionally after applying a DECLARED control perturbation to the
 * second image.
 *
 * The perturbation is what calibrates a band's detection limit, and it is
 * applied HERE, riding on a real same-state pair rather than on a pristine
 * copy: a control laid over a zero baseline answers an easier question than the
 * one a cross-state comparison asks. The sign is chosen away from the clamp
 * (`v > 127 ? -amp : +amp`) so every touched pixel really moves by the declared
 * amplitude instead of saturating against 0 or 255.
 *
 * THREE statistics come out of ONE pass over the same pixels — footprint,
 * coarse footprint, magnitude. `lib/cloud-refresh-skip.mjs` section 3 records
 * why a single one of them is not enough at a 30% dither floor.
 */
async function comparePngs(page, { a, b, perturb = null }) {
  return page.evaluate(
    async ({ a, b, perturb, coarseDelta }) => {
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
        return {
          mismatchFraction: 1,
          coarseFraction: 1,
          meanNormalizedDelta: 1,
          maxDelta: 255,
          width: ia.width,
          height: ia.height,
          sizeMismatch: true,
        };
      }
      const da = ia.data;
      const db = ib.data;
      if (perturb) {
        for (let row = perturb.y; row < perturb.y + perturb.h; row++) {
          for (let col = perturb.x; col < perturb.x + perturb.w; col++) {
            const at = (row * ib.width + col) * 4;
            for (let c = 0; c < 3; c++) {
              const v = db[at + c];
              db[at + c] =
                v > 127 ? v - perturb.amplitude : v + perturb.amplitude;
            }
          }
        }
      }
      let mismatched = 0;
      let coarse = 0;
      let sum = 0;
      let maxDelta = 0;
      for (let i = 0; i < da.length; i += 4) {
        const dr = Math.abs(da[i] - db[i]);
        const dg = Math.abs(da[i + 1] - db[i + 1]);
        const dbl = Math.abs(da[i + 2] - db[i + 2]);
        const d = Math.max(dr, dg, dbl);
        if (d >= 1) {
          mismatched++;
        }
        if (d > coarseDelta) {
          coarse++;
        }
        sum += d;
        if (d > maxDelta) {
          maxDelta = d;
        }
      }
      const total = ia.width * ia.height;
      return {
        mismatchFraction: mismatched / total,
        coarseFraction: coarse / total,
        meanNormalizedDelta: sum / total / 255,
        maxDelta,
        width: ia.width,
        height: ia.height,
        sizeMismatch: false,
      };
    },
    {
      a: a.toString("base64"),
      b: b.toString("base64"),
      perturb,
      coarseDelta: COARSE_DELTA_LEVELS,
    },
  );
}

/** The plain, unperturbed comparison every RECORDED diff goes through. */
async function pixelDiff(page, pngA, pngB) {
  return comparePngs(page, { a: pngA, b: pngB, perturb: null });
}

/**
 * One state's own frame-to-frame fluctuation: consecutive same-state captures,
 * each pair carrying the REAL executes that ran between them.
 */
async function sampleFluctuation(page, capture) {
  const samples = Array.isArray(capture?.samples) ? capture.samples : [];
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const stats = await pixelDiff(page, samples[i - 1].png, samples[i].png);
    out.push({
      label: `${capture.label}:${i - 1}->${i}`,
      executes: samples[i].executesRun,
      stats,
    });
  }
  return out;
}

/**
 * Run the declared control ladder against a state's LAST same-state pair.
 *
 * Every rung's profile therefore has the same fluctuation baseline a real
 * cross-state comparison has, which is what makes "this band rejects rung N"
 * a statement about the band rather than about the perturbation.
 */
async function ladderFor(page, capture) {
  const samples = Array.isArray(capture?.samples) ? capture.samples : [];
  if (samples.length < 2) {
    return [];
  }
  const a = samples[samples.length - 2].png;
  const b = samples[samples.length - 1].png;
  const base = await pixelDiff(page, a, b);
  if (base.sizeMismatch) {
    return [];
  }
  const rungs = [];
  for (const rung of CONTROL_LADDER) {
    const block = ladderBlock(rung, base.width, base.height);
    const stats = await comparePngs(page, {
      a,
      b,
      perturb: { ...block, amplitude: rung.amplitudeLevels },
    });
    rungs.push({ ...rung, block, stats });
  }
  return rungs;
}

/** A report-safe view of a capture: hashes and execute counts, never pixels. */
function describeCapture(capture) {
  return {
    label: capture?.label ?? null,
    sha: capture?.sha ?? null,
    stationary: capture?.stationary === true,
    rounds: capture?.rounds ?? [],
    executesObserved: capture?.executesObserved ?? null,
    samples: (capture?.samples ?? []).map((s) => ({
      sha: s.sha,
      executesRun: s.executesRun,
    })),
  };
}
// ── END PIXEL COMPARISON KERNEL ─────────────────────────────────────────────

/**
 * A reference page: setup, readiness, bounded warm-up, then a capture that is
 * converged if this build can converge and SAMPLED either way.
 *
 * ★ THE CROSS-BUILD BOUND CHANGED WITH THE VISUAL ARM (CO-33). It used to be
 * `max(2 x floor, 0.1%)` over a SINGLE cross-page reading — and on the
 * Batch-953 run that floor read 29.2%, i.e. a bound of 58% that no build
 * difference could ever have exceeded. A doubled single reading is not a bound;
 * it is one number wearing another number's clothes. The reference now returns
 * its own sample series, the cross-page floor is a DISTRIBUTION over
 * index-paired main-vs-reference captures, and the cross-build arm is judged
 * against a band derived from it — the same construction, and the same
 * anti-vacuity rules, as every other comparison in this probe.
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
      samples: capture.samples,
      capture: describeCapture(capture),
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
  // ★ C2 AND C3 ARE NOW CONVERGED-AND-SAMPLED, like C1. Two reasons, and both
  // are consequences of keep-live: a bare screenshot after a fixed window is a
  // point on whatever curve the state happens to be on (the exact defect that
  // produced the consume probe's uninterpretable 34.5%), and the band needs
  // every endpoint's OWN fluctuation samples, not just the reference state's.
  const c2Capture = await captureStationary(main.page, "flag-on");
  const c2 = c2Capture.png;
  // (E) toggle OFF again → C3.
  const offSettled = track(
    await phase(main.page, {
      label: "off-settled",
      toggle: false,
      executes: PHASE_EXECUTES,
    }),
  );
  const c3Capture = await captureStationary(main.page, "flag-off-again");
  const c3 = c3Capture.png;
  report.phases = { active, heal, settle, onSettled, offSettled };
  report.hashes = { c1: sha(c1), c2: sha(c2), c3: sha(c3) };

  if (active.toggleReturnedBlock !== true) {
    pre.push(
      `toggle-on did not return the attachment block (${active.toggleReturnedBlock})`,
    );
  }
  // The stationarity fold also carries the ANTI-VACUITY check: byte-equality
  // across zero engine executes is not evidence of anything.
  //
  // ★ ITS REASONS ARE NO LONGER PUSHED STRAIGHT TO STRUCTURAL. Under keep-live
  // a non-stationary state is the EXPECTED regime, not a fault: the byte-identity
  // tier simply does not apply, and the band tier takes over. The reasons are
  // recorded here and are QUOTED — not dropped — inside any comparison that ends
  // up with no usable tier at all.
  const stationarityFold = foldStationarity([
    {
      label: "flag-off",
      stationary: c1Capture.stationary,
      rounds: c1Capture.rounds,
      executesObserved: c1Capture.executesObserved,
    },
    {
      label: "flag-on",
      stationary: c2Capture.stationary,
      rounds: c2Capture.rounds,
      executesObserved: c2Capture.executesObserved,
    },
    {
      label: "flag-off-again",
      stationary: c3Capture.stationary,
      rounds: c3Capture.rounds,
      executesObserved: c3Capture.executesObserved,
    },
  ]);
  const stationary = stationarityFold.stationary["flag-off"] === true;
  report.stationary = stationary;
  report.stationarityFold = stationarityFold;
  report.stationarityCapture = describeCapture(c1Capture);
  report.captures = {
    c1: describeCapture(c1Capture),
    c2: describeCapture(c2Capture),
    c3: describeCapture(c3Capture),
  };

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

  // ── Reference pages: same-build cross-page band + pre-change build ──────
  const refSame = await referenceCapture(browser, BASE);
  report.refSame = { ...refSame, png: undefined, samples: undefined };
  let refPre = null;
  if (PRE_BASE) {
    refPre = await referenceCapture(browser, PRE_BASE);
    report.refPre = { ...refPre, png: undefined, samples: undefined };
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

  for (const reason of starvedWindowReasons(windowLedger)) {
    pre.push(reason);
  }
  report.windowLedger = windowLedger;

  // ── Bands (scratch page — PNG decode only, no WebGPU involved) ───────────
  const scratch = await browser.newPage();
  await scratch.goto("about:blank");

  // Each endpoint state's OWN frame-to-frame fluctuation, and its control
  // ladder. A cross-state band POOLS both endpoints, because the comparison it
  // judges has one endpoint in each state.
  const fluctuation = {
    c1: await sampleFluctuation(scratch, c1Capture),
    c2: await sampleFluctuation(scratch, c2Capture),
    c3: await sampleFluctuation(scratch, c3Capture),
  };
  const ladders = {
    c2: await ladderFor(scratch, c2Capture),
    c3: await ladderFor(scratch, c3Capture),
  };
  const bandOffOn = deriveFluctuationBand(
    [...fluctuation.c1, ...fluctuation.c2],
    { label: "flag-off+flag-on" },
  );
  const bandOnOff = deriveFluctuationBand(
    [...fluctuation.c2, ...fluctuation.c3],
    { label: "flag-on+flag-off-again" },
  );
  const detectOffOn = foldDetectionLimit(bandOffOn, ladders.c2, {
    label: "flag-off+flag-on",
  });
  const detectOnOff = foldDetectionLimit(bandOnOff, ladders.c3, {
    label: "flag-on+flag-off-again",
  });
  const diffOffOn = await pixelDiff(scratch, c1, c2);
  const diffOnOff = await pixelDiff(scratch, c2, c3);
  const inertOffOn = foldPixelInertness({
    label: "flag-off -> flag-on",
    bothEndpointsStationary:
      stationarityFold.stationary["flag-off"] === true &&
      stationarityFold.stationary["flag-on"] === true,
    identical: report.hashes.c1 === report.hashes.c2,
    band: bandOffOn,
    detection: detectOffOn,
    stats: diffOffOn,
    stationarityReasons: stationarityFold.reasons,
  });
  const inertOnOff = foldPixelInertness({
    label: "flag-on -> flag-off-again",
    bothEndpointsStationary:
      stationarityFold.stationary["flag-on"] === true &&
      stationarityFold.stationary["flag-off-again"] === true,
    identical: report.hashes.c2 === report.hashes.c3,
    band: bandOnOff,
    detection: detectOnOff,
    stats: diffOnOff,
    stationarityReasons: stationarityFold.reasons,
  });
  report.visual = {
    fluctuation,
    ladders,
    bands: { offOn: bandOffOn, onOff: bandOnOff },
    detection: { offOn: detectOffOn, onOff: detectOnOff },
    diffs: { offOn: diffOffOn, onOff: diffOnOff },
    inertness: { offOn: inertOffOn, onOff: inertOnOff },
  };
  for (const reason of pixelInertnessReasons([inertOffOn, inertOnOff])) {
    pre.push(reason);
  }

  // The cross-build arm's own band is CROSS-PAGE, because its comparison is:
  // the main page's C1 against a different page's capture. Index-paired
  // main-vs-reference captures give the distribution; the ladder rides the
  // reference's own last same-state pair, so the calibration keeps the same
  // shape as everywhere else.
  //
  // Each element of a cross-page pair is an ENDPOINT, not a gap, so the series'
  // very first capture — which has no preceding gap and therefore records zero
  // executes — is dropped here rather than being read as a frozen window. The
  // anti-vacuity rule still bites on everything else: a page that stopped
  // executing contributes samples with zero executes and poisons the band, by
  // name, exactly as it should.
  const mainSamples = c1Capture.samples.filter((s) => s.executesRun > 0);
  const referenceSamples = refSame.samples.filter((s) => s.executesRun > 0);
  const crossPagePairs = Math.min(mainSamples.length, referenceSamples.length);
  const crossPageSamples = [];
  for (let i = 0; i < crossPagePairs; i++) {
    const mine = mainSamples[mainSamples.length - crossPagePairs + i];
    const theirs =
      referenceSamples[referenceSamples.length - crossPagePairs + i];
    const stats = await pixelDiff(scratch, mine.png, theirs.png);
    crossPageSamples.push({
      label: `cross-page:${i}`,
      // Both endpoints advanced by their own gate's executes; the honest
      // separation to record is the smaller of the two, so a page that stalled
      // cannot be masked by one that did not.
      executes: Math.min(mine.executesRun, theirs.executesRun),
      stats,
    });
  }
  const crossPageBand = deriveFluctuationBand(crossPageSamples, {
    label: "cross-page (same build)",
  });
  const crossPageDetection = foldDetectionLimit(
    crossPageBand,
    await ladderFor(scratch, refSame),
    { label: "cross-page (same build)" },
  );
  const noiseFloor = await pixelDiff(scratch, c1, refSame.png);
  report.noiseFloor = noiseFloor;
  report.crossPage = {
    samples: crossPageSamples,
    band: crossPageBand,
    detection: crossPageDetection,
  };
  let preDiff = null;
  let crossBuild = null;
  if (refPre) {
    preDiff = await pixelDiff(scratch, c1, refPre.png);
    crossBuild = foldPixelInertness({
      label: "cross-build (pre-change -> current)",
      // ★ THE STATIONARY TIER MUST NEVER APPLY HERE, even when BOTH pages
      // converge. Cross-page byte identity is physically impossible on this
      // subject and has been since the C13-09 certified run: each page's
      // temporal history freezes its own initialization variance into a
      // DIFFERENT fixed point, and two same-build pages measured 37.26% apart.
      // Letting a stationary pair route to byte identity here would
      // manufacture a guaranteed red out of a known-impossible test — the
      // Batch-953 failure mode, one layer over.
      bothEndpointsStationary: false,
      identical: false,
      band: crossPageBand,
      detection: crossPageDetection,
      stats: preDiff,
      stationarityReasons: [
        `cross-build endpoints converged: c1=${c1Capture.stationary} pre=${refPre.capture.stationary} (recorded only — cross-page byte identity is not a test this subject can pass)`,
      ],
    });
    report.preDiff = preDiff;
    report.crossBuild = crossBuild;
    for (const reason of pixelInertnessReasons([crossBuild])) {
      pre.push(reason);
    }
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
  // ── PIXEL-INERTNESS ACROSS THE TOGGLE — TWO TIERS, MEANINGS CHANGED ─────
  //
  // TIER 1, byte identity at a byte-stationary fixed point. Same meaning it
  // always had, now TRI-STATE: it reads NULL, not red, when the stationarity
  // precondition it depends on has failed. A predicate that fires red on a
  // precondition its own output declares broken is an instrument fault — that
  // was the Batch-953 shape, and it is what CO-33 was dispatched to close.
  p.settledByteIdentityOffOn =
    inertOffOn.tier === TIER_STATIONARY ? inertOffOn.verdict : null;
  p.settledByteIdentityOnOff =
    inertOnOff.tier === TIER_STATIONARY ? inertOnOff.verdict : null;
  // TIER 2, the live-frame form: the cross-state difference must sit inside the
  // band the two endpoint states' OWN fluctuation defines, at a sensitivity the
  // in-run control ladder measured. Null when no discriminating band exists.
  p.pixelInertOffOnWithinBand =
    inertOffOn.tier === TIER_BAND ? inertOffOn.verdict : null;
  p.pixelInertOnOffWithinBand =
    inertOnOff.tier === TIER_BAND ? inertOnOff.verdict : null;
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
  // Cross-build arm — same two-tier fold, judged against the CROSS-PAGE band
  // (its comparison is cross-page by construction, so a same-page band would be
  // the wrong baseline).
  p.crossBuildDiffWithinDerivedBound =
    crossBuild === null || crossBuild.tier === TIER_NONE
      ? null
      : crossBuild.verdict;
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

  // A predicate that DID NOT RUN is `null` — structural, never green and never
  // red. With the visual arm now tiered, the two byte-identity predicates and
  // the two band predicates are null in each other's regime by construction, so
  // this list is expected to be non-empty on every run; what matters is that a
  // null is always accompanied by a NAMED reason.
  const failed = Object.entries(p).filter(([, v]) => v === false);
  const notRun = Object.entries(p)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  const structural = pre.length > 0 || notRun.length > 0;

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
    `  stationarity: flag-off=${stationary} flag-on=${c2Capture.stationary} flag-off-again=${c3Capture.stationary} (rounds of ${STATIONARITY_GAP_EXECUTES} executes; observed ${c1Capture.executesObserved}/${c2Capture.executesObserved}/${c3Capture.executesObserved})`,
  );
  console.log(
    `  settled captures: c1=${report.hashes.c1.slice(0, 12)} c2=${report.hashes.c2.slice(0, 12)} c3=${report.hashes.c3.slice(0, 12)} producerLiveDuringC2=${report.producerLiveDuringC2}`,
  );
  console.log(
    `  rider:   ${attActive?.width}x${attActive?.height} gen ${attActive?.generation} → ${attBig?.width}x${attBig?.height} gen ${attBig?.generation} (liveBytes=${attBig?.liveBytes}, ${riderBig.executesRun}e, ${riderBig.outcome}) → ${attBack?.width}x${attBack?.height} gen ${attBack?.generation} (liveBytes=${attBack?.liveBytes}, ${riderBack.executesRun}e, ${riderBack.outcome})`,
  );
  console.log("  PIXEL-INERTNESS (tiered; bands FIRST-PASS DERIVED):");
  console.log(`    ${describeBand(bandOffOn)}`);
  console.log(`    ${describeDetection(detectOffOn)}`);
  console.log(`    ${describeInertness(inertOffOn)}`);
  console.log(`    ${describeBand(bandOnOff)}`);
  console.log(`    ${describeDetection(detectOnOff)}`);
  console.log(`    ${describeInertness(inertOnOff)}`);
  console.log(
    `  noise floor (same build, cross page): ${pct(noiseFloor.mismatchFraction)} over ${crossPageSamples.length} index-paired captures; ${describeBand(crossPageBand)} | ${describeDetection(crossPageDetection)}`,
  );
  if (crossBuild) {
    console.log(`  cross-build: ${describeInertness(crossBuild)}`);
  }
  console.log(`  predicates: ${JSON.stringify(p)}`);
  if (failed.length) {
    console.log(`  RED: ${failed.map(([k]) => k).join(", ")}`);
  }
  if (notRun.length) {
    console.log(`  NOT RUN: ${notRun.join(", ")}`);
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
      "STRUCTURAL — no red predicate, but a precondition, a visual tier or the pre-change arm did not hold/run",
    );
    process.exit(3);
  }
  console.log(
    "PASS — C13-09 Edge acceptance: active counters, pixel-inertness (at its measured detection limit), lifecycle, cross-build arm all green",
  );
  process.exit(0);
} finally {
  await browser.close().catch(() => {});
}
