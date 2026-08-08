#!/usr/bin/env node
// Probe (C13-10 OWED EDGE LEGS B / C / D, machine lane): the march-emitted
// reconstruction depth and its FIRST CONSUMER.
//
// C13-09 shipped the attachment set PRODUCED BUT NOT CONSUMED, and its
// acceptance leg could therefore demand byte identity. C13-10 is the row where
// that stops being true: the half-resolution march compiles the emission
// variant and writes contract slot 1 from its own per-sample accumulation, the
// producer READS that target instead of estimating it (dropping the slot from
// its MRT — `producerTargets` 3 → 2, the counter that proves ownership MOVED),
// and the temporal resolve validates history against the set. The composite MAY
// therefore differ. This probe measures the counters, the lifecycle and the
// cost; it puts NO pass/fail bar on the visual delta on its first run — it
// records the pixel-diff percentages and writes the PNGs for the orchestrator.
//
// PRE-REGISTERED LEGS (QUEUE_2026-07-23_CAMPAIGN13.md, C13-10 row, Batch 939):
//
//   LEG B  `CesiumDebug.cloudReconstruction(true)` in the march-ACTIVE window:
//          `emission.requested` (RESIDENT) / `emitted` / `consumed` all true,
//          `producerTargets === 2` measured against the attachments-only
//          state's 3 IN THE SAME PAGE, `attachments.liveBytes` UNCHANGED at
//          w*h*24, the cloud pass topology UNCHANGED (no new pass), zero
//          device/validation errors. Composite MAY differ: three element
//          screenshots (off / attachments-only / consume) with their diffs
//          RECORDED, plus a same-state self-diff so the delta is interpretable
//          against this page's own floor.
//
//   LEG C  Lifecycle under consume-on: a canvas resize advances the generation
//          MONOTONICALLY, `consumed` returns true inside a bounded frame
//          window, `liveBytes` tracks the new size exactly, and no stale
//          bind-group / destroyed-texture validation error appears. Tier flip
//          low → high → low: the FULL-RESOLUTION tier produces nothing (the
//          documented C13-09/C13-10 residual — the emitting march needs a
//          half-res target and the consuming resolve needs a temporal tier),
//          and returning to low re-engages inside the bounded window.
//          ★ DEVICE LOSS IS OUT OF SCOPE for this probe. Forcing a real device
//          loss from Playwright would tear down the page's whole WebGPU state
//          mid-run and make every later leg unattributable; the generation's
//          device-swap branch is executed as a unit in
//          `cloud-reconstruction-attachments.spec.mjs` B3/B4 instead.
//
//   LEG D  Cost, INTERLEAVED A/B MANDATORY (the C13-39 protocol — a blocked
//          "all of A then all of B" run reads session drift as signal). N
//          iterations, each one attachments-only (A) window and one consume-on
//          (B) window, with the ORDER alternating so both orderings occur.
//          `ProceduralClouds half-res pass` and `CloudReconstructionAttachments
//          pass` are reported SEPARATELY (plus the resolve, which the consume
//          variant also changes, and the upscale as an untouched drift
//          control). NO pass/fail bar on timing: the numbers feed the C13-39
//          occupancy question. Expectations, DERIVED not measured: the emitting
//          march carries ~4 more live f32 (so ≥ the historical march, and any
//          large regression is the occupancy cliff C13-39 measured); the
//          emitting producer should be CHEAPER (it skips up to six
//          `rayEllipsoidIntersectRTE` calls and nine log-bearing estimator
//          evaluations in exchange for ten rg32float loads).
//
// NOT THIS PROBE'S ARMS. Leg 0's "default byte-identical to the pre-change
// build" and Leg A's full C13-09 survival are discharged by
// `probe-cloud-reconstruction-attachments.mjs`, whose cross-build method (a
// same-build cross-page noise floor plus a derived bound) is the only form that
// arm can physically take. What IS covered here is the half those legs share
// with this one: the off-state `emission.requested === false`, and the
// attachments-only `producerTargets === 3` that leg B's 3-vs-2 comparison needs.
//
// ── WHAT CHANGED AFTER THE BATCH-944 FIRST RUN (CO-32) ───────────────────────
//
// The first run's leg B core was green 15/15 and stands. Its VISUAL numbers and
// its whole leg C / leg D were instrument artifacts of ONE mechanism, now fixed
// here and documented in `lib/cloud-refresh-skip.mjs`: `?offline=true` forces
// `requestRenderMode: true`, the clock is pinned, and Batch 942 restored the
// temporal resolve — so once the cloud lane converges, `scene.render(t)`
// executes NOTHING and the published counters freeze. Every window in this
// probe counted render calls, and render calls had stopped being frames.
//
//   1. PER-PHASE STATIONARITY GATES. Each captured state (off /
//      attachments-only / consume / consume+8) now converges under its OWN
//      bounded stationarity gate — two screenshots `STATIONARITY_GAP_EXECUTES`
//      REAL executes apart must be byte-equal — before its screenshot counts. A
//      diff is marked `interpretable` only when BOTH endpoints converged. The
//      Batch-944 `off → attachments` figure of 34.5% against a 0.0000%
//      same-state floor was exactly this: the off capture was taken ~21 frames
//      in, mid-convergence, and the floor pair was taken converged.
//
//   2. RESIZE. The Batch-944 leg C recorded "the resize never took". The report
//      refutes that: `canvasSize` read 1024x640 while the attachments stayed
//      400x250 at generation 1. The viewport change DID reach the canvas; the
//      probe never waited for the ENGINE to act on it, because `until:
//      "consumed"` was ALREADY TRUE in the pre-resize state and its coherence
//      check was ALREADY SATISFIED by the pre-resize numbers, so the phase
//      returned after one render call carrying a stale snapshot. (The survival
//      probe's rider "worked" by luck: its frozen state had `liveBytes === 0`,
//      which failed coherence and forced two more frames.) The repair is
//      condition-based: wait for the canvas backing store to CHANGE, then run a
//      `until: "resized"` window whose arrival requires the attachment dims to
//      differ from the pre-resize dims AND the generation to have advanced —
//      a condition the stale state cannot satisfy.
//
//   3. LEG D KEEP-LIVE + TIMING ARM. All ten windows reported
//      `attemptedFrameCount: 0` — the profiler was armed and never saw a frame
//      — and exactly the five A-windows "held their arm" because the frozen
//      snapshot was an A-state snapshot. Every span now keeps the lane live,
//      the timestamp surface is re-armed per window immediately before the
//      measured span, and a window whose TIMING arm did not hold is
//      DISCARDED-AND-NAMED rather than folded into a median.
//
// INSTRUMENT DOCTRINE INHERITED FROM THE C13-09 CERTIFIED RUN (Batch 936):
//   * Canvas pixels come from Playwright ELEMENT SCREENSHOTS. An in-page
//     `drawImage` from a WebGPU canvas copies transparent black even in the
//     same task.
//   * The published cloud counters lag cache truth by 1-2 frames (resident
//     figures publish at frame start). Every counter read goes through a
//     BOUNDED consistency window and records the observed latency
//     (`publishLagExecutes`); a counter that never publishes still fails at the
//     bound rather than being waited for forever.
//   * Readiness gates on `marchPixels > 0`, never on a fixed warm-up count —
//     the async noise bake races fixed counts.
//   * Counters are read in the SAME TASK as a `scene.render`.
//   * A zeroed timing block must NEVER read as a measurement (C11-146):
//     `readPassTiming` returns null, and null routes to STRUCTURAL.
//
// Usage:
//   node Tools/visual-regression/probe-cloud-reconstruction-consume.mjs
//   node Tools/visual-regression/probe-cloud-reconstruction-consume.mjs --perf
// Env:
//   PROBE_BASE            default http://localhost:8080
//   C13_10_PERF_ITERATIONS  default 5   (interleaved A/B pairs, clamped 1..24)
//   C13_10_PERF_FRAMES      default 60  (measured frames per window)
//
// Exit: 0 = every requested arm ran and every predicate is green;
//       1 = a pre-registered predicate is RED (outranks structural);
//       2 = watchdog or an unexpected throw (the harness broke);
//       3 = STRUCTURAL — an arm could not run or did not see its subject
//           (including a run without `--perf`, whose Leg D DID NOT RUN).

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
  ARM_A,
  ARM_B,
  PASS_MARCH,
  PASS_PRODUCER,
  PASS_RESOLVE,
  PASS_UPSCALE,
  PERF_PASS_NAMES,
  buildInterleavedSchedule,
  describeInterleave,
  foldExit,
  pairedDeltas,
  readPassTiming,
  summarize,
} from "./lib/cloud-reconstruction-consume.mjs";
import {
  REFRESH_SKIP_BOUNDS,
  classifyExecuteWindow,
  diffInterpretable,
  foldStationarity,
  renderCallBudget,
  starvedWindowReasons,
} from "./lib/cloud-refresh-skip.mjs";

const EXIT = Object.freeze({
  PASS: 0,
  FAIL: 1,
  HARNESS: 2,
  STRUCTURAL: 3,
});

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const PERF = process.argv.includes("--perf");
const OUTPUT_DIR =
  "Tools/visual-regression/output/cloud-reconstruction-consume";
const BYTES_PER_TEXEL_OWNED = 24;
const PHASE_EXECUTES = 24;
const PUBLISH_LAG_MAX = REFRESH_SKIP_BOUNDS.publishLagExecutes;
const STATIONARITY_GAP_EXECUTES = REFRESH_SKIP_BOUNDS.stationarityGapExecutes;
const STATIONARITY_MAX_ROUNDS = REFRESH_SKIP_BOUNDS.stationarityMaxRounds;
const VIEWPORT = { width: 800, height: 500 };
const RESIZED = { width: 1024, height: 640 };
const PERF_ITERATIONS = Number(process.env.C13_10_PERF_ITERATIONS ?? 5);
const PERF_MEASURE_FRAMES = Math.max(
  8,
  Math.min(240, Number(process.env.C13_10_PERF_FRAMES ?? 60)),
);
const PERF_WARM_FRAMES = 24;
const PERF_VERIFY_FRAMES = 8;

// Bounded EXECUTE budgets for every `until` condition. Nothing in this probe
// loops without one, and every one of them is denominated in engine executes
// rather than in render calls — see `lib/cloud-refresh-skip.mjs`.
const UNTIL_LIMITS = Object.freeze({
  produced: 60,
  consumed: 90,
  released: 12,
  notEmitting: 60,
  resized: 30,
});

// Budget: legs B+C ≈ 600 readiness + ~10 bounded phases ≤ 90 executes each +
// four stationarity gates ≤ 64 executes each; leg D ≈ 2 × iterations ×
// (24 warm + 8 verify + 60 measured) executes. At 24 iterations that is ~4500
// frames, so the watchdog only ever fires on a driver hang.
const WATCHDOG_MS = PERF ? 1_200_000 : 600_000;
const watchdog = setTimeout(() => {
  console.error(
    `[cloud-recon-consume] WATCHDOG FIRED (${WATCHDOG_MS / 1000}s) — forcing exit`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function pct(fraction) {
  return fraction === null || fraction === undefined
    ? "n/a"
    : `${(fraction * 100).toFixed(4)}%`;
}

function ms(value) {
  return value === null || value === undefined ? "n/a" : value.toFixed(4);
}

async function openPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
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
    `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    { waitUntil: "networkidle", timeout: 90_000 },
  );
  await page.waitForFunction(() => !!window.viewer, undefined, {
    timeout: 90_000,
  });
  const armState = await armWebGPUDevices(page);
  return { page, errors, gpuConsoleErrors, armState };
}

/**
 * Scene setup + readiness gate. Identical fixture to the C13-09 acceptance
 * probe (same camera, clock, deck and tier) so the two runs are comparable:
 * "low" is T1, the half-resolution TEMPORAL tier, which is the only shape in
 * which the march can emit AND the resolve can consume.
 *
 * The readiness loop is itself kept live, and the return records the two facts
 * the keep-live derivation rests on: this page really is in `requestRenderMode`
 * (so the fix is addressing the mechanism that exists), and snapshot mode is
 * NOT enabled (so `requestRender()`'s only side effect beyond the gate flag —
 * `markDirty` on a FROZEN snapshot — is provably unreachable).
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
      // The keep-live premise, read back rather than assumed.
      requestRenderMode: scene.requestRenderMode === true,
      maximumRenderTimeChange: scene.maximumRenderTimeChange ?? null,
      snapshotModeEnabled: scene.snapshotMode?.enabled === true,
      snapshotModeFrozen: scene.snapshotMode?.isFrozen === true,
      commands: {
        attachments:
          typeof window.CesiumDebug?.cloudReconstructionAttachments ===
          "function",
        reconstruction:
          typeof window.CesiumDebug?.cloudReconstruction === "function",
        gpuPassCost: typeof window.CesiumDebug?.gpuPassCost === "function",
      },
    };
  });
}

/** Set the cloud quality tier (T1 "low" / T2 "medium" / T3 "high"). */
async function setQuality(page, quality) {
  return page.evaluate((q) => {
    const coll = window.viewer.scene.globe.defaultCloudCollection;
    coll.volumetric.cloudVolumetricQuality = q;
    return coll.volumetric.cloudVolumetricQuality;
  }, quality);
}

/**
 * Pump KEPT-LIVE render calls until the canvas backing store leaves the size it
 * is at now, then report what it landed on.
 *
 * `Viewer.prototype.resize` is subscribed to `scene.postUpdate`, which fires
 * OUTSIDE the `shouldRender` block — so the first render call after a viewport
 * change reconfigures the canvas and calls `requestRender()` for the NEXT
 * frame. Waiting on the CHANGE rather than on an expected number keeps this
 * device-pixel-ratio agnostic.
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
 * Optionally flip the two opt-ins, then render KEPT-LIVE frames.
 *
 * `executes` renders until that many ENGINE EXECUTES have happened. `until`
 * renders until the named arrival condition holds (each with its own BOUNDED
 * execute budget), then keeps rendering through a small consistency window
 * until the published counters agree with each other — the 1-2 frame publish
 * lag the C13-09 run measured — recording the observed `publishLagExecutes`.
 * Counters are read in the SAME TASK as the final render.
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
      passNames,
      bytesPerTexel,
      executeBudget,
      callBudget,
      publishLagMax,
    }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const scene = window.viewer.scene;
      const frameTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");
      const dbg = window.CesiumDebug;
      const toggleResult = { attachments: null, reconstruction: null };
      // Attachments FIRST: `cloudReconstruction(true)` implies the attachment
      // set, so applying it second would undo an explicit attachments toggle.
      if (toggle && typeof toggle.attachments === "boolean") {
        toggleResult.attachments =
          typeof dbg?.cloudReconstructionAttachments === "function"
            ? dbg.cloudReconstructionAttachments(toggle.attachments) !== null
            : "command-absent";
      }
      if (toggle && typeof toggle.reconstruction === "boolean") {
        toggleResult.reconstruction =
          typeof dbg?.cloudReconstruction === "function"
            ? dbg.cloudReconstruction(toggle.reconstruction) !== null
            : "command-absent";
      }

      const snapNow = () =>
        scene._context?.getRendererStatistics?.()?.volumetricClouds ?? null;
      // ★ KEEP-LIVE. Neither debug toggle above calls `requestRender()`, and
      // under `requestRenderMode` a quiescent scene would swallow every render
      // call that follows — including the ones meant to APPLY the toggle.
      const renderLive = () => {
        scene.requestRender();
        scene.render(frameTime);
      };
      const arrived = (snap) => {
        const att = snap?.reconstruction?.attachments;
        const em = snap?.reconstruction?.emission;
        if (!att || !em) return false;
        if (until === "produced") return (att.pixelsDispatched ?? 0) > 0;
        if (until === "consumed") return em.consumed === true;
        if (until === "released") return att.liveBytes === 0;
        if (until === "notEmitting") return em.emitted === false;
        if (until === "resized") {
          // Deliberately NOT satisfiable by the pre-resize state: the dims must
          // have moved AND the generation must have advanced past the value the
          // caller measured before the viewport changed.
          return (
            att.width > 0 &&
            att.height > 0 &&
            (att.width !== expect?.previousWidth ||
              att.height !== expect?.previousHeight) &&
            att.generation > (expect?.previousGeneration ?? -1)
          );
        }
        return true;
      };
      const coherent = (snap) => {
        const att = snap?.reconstruction?.attachments;
        const em = snap?.reconstruction?.emission;
        if (!att || !em) return false;
        const bytesExact =
          att.liveBytes > 0 &&
          att.liveBytes === att.width * att.height * bytesPerTexel;
        if (until === "produced") return att.produced === true && bytesExact;
        if (until === "consumed") {
          return (
            em.emitted === true &&
            em.consumed === true &&
            em.producerTargets === 2 &&
            bytesExact
          );
        }
        if (until === "resized") {
          return arrived(snap) && bytesExact && em.consumed === true;
        }
        return arrived(snap);
      };

      const executesAtStart = snapNow()?.frames ?? 0;
      let renderCalls = 0;
      let executesRun = 0;
      let conditionMet = false;
      let snap = null;
      for (; renderCalls < callBudget && executesRun < executeBudget;) {
        renderLive();
        renderCalls++;
        snap = snapNow();
        executesRun = (snap?.frames ?? executesAtStart) - executesAtStart;
        if (until !== null && arrived(snap)) {
          conditionMet = true;
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      // A fixed-execute phase "arrives" by spending its whole budget — so a
      // starved one is classified starved instead of quietly reading green.
      if (until === null) {
        conditionMet = executesRun >= executeBudget;
      }

      let publishLagExecutes = 0;
      if (conditionMet) {
        for (; publishLagExecutes < publishLagMax; publishLagExecutes++) {
          if (coherent(snap)) break;
          await new Promise((r) => requestAnimationFrame(r));
          renderLive();
          renderCalls++;
          snap = snapNow();
        }
        executesRun = (snap?.frames ?? executesAtStart) - executesAtStart;
      }

      const att = snap?.reconstruction?.attachments ?? null;
      const em = snap?.reconstruction?.emission ?? null;
      const passes = {};
      for (const name of passNames) {
        passes[name] = snap?.passes?.[name] ?? null;
      }
      const activePassNames = Object.entries(snap?.passes ?? {})
        .filter(([, count]) => count > 0)
        .map(([name]) => name)
        .sort();
      return {
        toggleResult,
        renderCalls,
        executesRun,
        conditionMet,
        coherent: coherent(snap),
        publishLagExecutes,
        marchPixels: snap?.raymarch?.pixelsDispatched ?? null,
        halfResActive: snap?.raymarch?.halfResActive ?? null,
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
        emission: em
          ? {
              requested: em.requested,
              emitted: em.emitted,
              consumed: em.consumed,
              producerTargets: em.producerTargets,
            }
          : null,
        passes,
        activePassNames,
        passCount: snap?.passCount ?? null,
        canvasSize: { width: scene.canvas.width, height: scene.canvas.height },
      };
    },
    {
      toggle,
      until,
      expect,
      passNames: PERF_PASS_NAMES,
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
 * ★ THE PRECONDITION IS PER STATE. The Batch-944 run diffed a converged
 * attachments-only capture against an `off` capture taken ~21 executes in, and
 * read 34.5% — a number that describes where the temporal history happened to
 * be, not what the flag did. Each state is now given rounds of
 * `STATIONARITY_GAP_EXECUTES` real executes until two consecutive captures are
 * byte-equal, bounded at `STATIONARITY_MAX_ROUNDS`; a state that never
 * converges is NAMED and its diffs are marked not interpretable.
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
        windows: rounds.length,
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
    windows: rounds.length,
  };
}

/** Decode two PNGs on a scratch page and return the mismatched-pixel fraction. */
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
 * ONE interleaved perf window.
 *
 * Three spans, in order, and the split is the point:
 *   1. WARM — the arm is set and the frame is left to settle. The variant's
 *      pipelines and bind groups are built lazily on the first enabled frame,
 *      so sampling verdicts here would record the transition rather than the
 *      state.
 *   2. VERIFY — bounded, and every frame's verdicts are sampled. This is what
 *      makes the window's number attributable: a timing measured while the
 *      flag was still flipping is a number with the wrong label.
 *   3. MEASURE — timing surface RE-ARMED (which also resets the profiler), then
 *      exactly `measureFrames` kept-live renders at a pinned clock and NO
 *      snapshot reads. `getRendererStatistics()` is allocation-bearing by
 *      design, and per-frame snapshotting inside a timing window times the
 *      instrument.
 *
 * ★ EVERY SPAN IS KEPT LIVE. On the Batch-944 run all ten windows reported
 * `attemptedFrameCount: 0`: the profiler was armed correctly and simply never
 * saw a frame, because a converged cloud lane under `requestRenderMode` makes
 * `scene.render(t)` a no-op. `scene.requestRender()` before each render is the
 * minimal invalidation that fixes it — it touches only the `shouldRender` gate,
 * so the set of GPU passes encoded on a rendered frame is unchanged and the
 * timings keep their meaning. See `lib/cloud-refresh-skip.mjs` for the full
 * derivation and the rejected alternatives.
 *
 * ★ THE TIMING ARM IS RE-VERIFIED AFTER THE FACT. `gpuPassCost(true)` is issued
 * at window start (so timestamp resources are built during WARM, not inside the
 * measured span) and again immediately before MEASURE (to reset). The results
 * are then read back: `enabled`, and `attemptedFrameCount` — the count of
 * frames the profiler ARMED, which is 0 exactly when the lane was skipped.
 */
async function measurePerfWindow(page, arm) {
  return page.evaluate(
    async ({
      arm,
      armA,
      warmFrames,
      verifyFrames,
      measureFrames,
      passNames,
    }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const scene = window.viewer.scene;
      const ctx = scene._context;
      const dbg = window.CesiumDebug;
      const frameTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");
      const snapNow = () =>
        ctx?.getRendererStatistics?.()?.volumetricClouds ?? null;
      const renderLive = () => {
        scene.requestRender();
        scene.render(frameTime);
      };

      // An absent debug command means the lane cannot see its subject, which is
      // STRUCTURAL — so it is reported, not thrown.
      const commandsPresent =
        typeof dbg?.cloudReconstructionAttachments === "function" &&
        typeof dbg?.cloudReconstruction === "function" &&
        typeof dbg?.gpuPassCost === "function";
      if (commandsPresent) {
        dbg.cloudReconstructionAttachments(true);
        dbg.cloudReconstruction(arm !== armA);
        // Arm BEFORE the warm span so the query sets and readback buffers are
        // allocated outside the measured window.
        dbg.gpuPassCost(true);
      }
      const armedAtStart =
        ctx?.timestampProfiler?.getResults?.()?.enabled === true;

      const executesAtStart = snapNow()?.frames ?? 0;
      for (let i = 0; i < warmFrames; i++) {
        renderLive();
        await new Promise((r) => requestAnimationFrame(r));
      }

      let emittedFrames = 0;
      let consumedFrames = 0;
      let marchActiveFrames = 0;
      const producerTargetsSeen = [];
      for (let i = 0; i < verifyFrames; i++) {
        renderLive();
        const snap = snapNow();
        const em = snap?.reconstruction?.emission ?? null;
        if (em?.emitted === true) emittedFrames++;
        if (em?.consumed === true) consumedFrames++;
        if ((snap?.raymarch?.pixelsDispatched ?? 0) > 0) marchActiveFrames++;
        if (em && !producerTargetsSeen.includes(em.producerTargets)) {
          producerTargetsSeen.push(em.producerTargets);
        }
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Re-arm + reset immediately before the measured span. `gpuPassCost(true)`
      // resets the profiler and requests a render; `profiler.reset()` alone
      // would leave a dropped arm undetected.
      if (commandsPresent) {
        dbg.gpuPassCost(true);
      }
      const profiler = ctx?.timestampProfiler ?? null;
      const reArmed = profiler?.getResults?.()?.enabled === true;
      for (let i = 0; i < measureFrames; i++) {
        renderLive();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Same-task read of the final measured frame's verdicts.
      renderLive();
      const finalSnap = snapNow();
      const executesRun =
        (finalSnap?.frames ?? executesAtStart) - executesAtStart;

      const device = ctx?.device ?? null;
      if (device) {
        await device.queue.onSubmittedWorkDone();
      }
      // Readback is mapAsync-based and settles a few frames late: the frames
      // still in flight are REAL samples, so drain them (bounded) instead of
      // dropping them.
      const drain = (await profiler?.drainPendingReadbacks?.(2000)) ?? null;
      const raw = profiler?.getResults?.() ?? null;
      const passes = {};
      for (const name of passNames) {
        const timing = raw?.passes?.[name];
        passes[name] = timing
          ? {
              avgMs: timing.avgMs,
              minMs: timing.minMs,
              maxMs: timing.maxMs,
              lastMs: timing.lastMs,
            }
          : null;
      }
      return {
        arm,
        commandsPresent,
        timingArm: {
          armedAtStart,
          reArmed,
          enabledAfter: raw?.enabled === true,
          attemptedFrameCount: raw?.attemptedFrameCount ?? null,
          frameCount: raw?.frameCount ?? null,
          emptyFrameCount: raw?.emptyFrameCount ?? null,
        },
        verify: {
          frames: verifyFrames,
          emittedFrames,
          consumedFrames,
          marchActiveFrames,
          producerTargetsSeen,
        },
        executesRun,
        final: {
          emission: finalSnap?.reconstruction?.emission ?? null,
          produced: finalSnap?.reconstruction?.attachments?.produced ?? null,
          marchPixels: finalSnap?.raymarch?.pixelsDispatched ?? null,
        },
        drain,
        // Lean, and shaped exactly like `ProfilingResults` so the pure reader
        // in lib/ works on it unchanged.
        results: raw
          ? {
              enabled: raw.enabled,
              frameCount: raw.frameCount,
              attemptedFrameCount: raw.attemptedFrameCount,
              sampleLedgerBalanced: raw.sampleLedgerBalanced,
              unaccountedSampleCount: raw.unaccountedSampleCount,
              readbackSkipCount: raw.readbackSkipCount,
              failedReadbackCount: raw.failedReadbackCount,
              lostSampleCount: raw.lostSampleCount,
              pendingReadbackCount: raw.pendingReadbackCount,
              droppedPassCount: raw.droppedPassCount,
              overlapMs: raw.overlapMs,
              coverageRatio: raw.coverageRatio,
              observedPassNames: Object.keys(raw.passes ?? {}),
              passes,
            }
          : null,
      };
    },
    {
      arm,
      armA: ARM_A,
      warmFrames: PERF_WARM_FRAMES,
      verifyFrames: PERF_VERIFY_FRAMES,
      measureFrames: PERF_MEASURE_FRAMES,
      passNames: PERF_PASS_NAMES,
    },
  );
}

/**
 * Did this window's TIMING arm hold for its whole measured span?
 *
 * DERIVED, not chosen: with keep-live in place one render call is one engine
 * execute, and the profiler arms once per rendered frame, so a window that
 * actually ran its measured span must report `attemptedFrameCount >=
 * measureFrames`. A window reporting 0 (the entire Batch-944 leg D) never saw a
 * frame at all. `sampleLedgerBalanced` is the profiler's own C11-140 guarantee
 * that no sample vanished, and `frameCount > 0` is the C11-146 rule that a
 * zeroed block is not a measurement.
 *
 * @param {object} window One measured window.
 * @returns {{ok: boolean, reason: string|null}} Attributability verdict.
 */
function timingArmHeld(window) {
  const results = window?.results ?? null;
  const timing = window?.timingArm ?? null;
  if (window?.commandsPresent !== true) {
    return { ok: false, reason: "the debug commands were absent" };
  }
  if (!results || results.enabled !== true || timing?.reArmed !== true) {
    return { ok: false, reason: "the profiler was not armed for this window" };
  }
  if (!(results.attemptedFrameCount >= PERF_MEASURE_FRAMES)) {
    return {
      ok: false,
      reason: `the profiler armed only ${results.attemptedFrameCount} of ${PERF_MEASURE_FRAMES} measured frames`,
    };
  }
  if (results.sampleLedgerBalanced !== true) {
    return { ok: false, reason: "the GPU sample ledger did not close" };
  }
  if (!(results.frameCount > 0)) {
    return { ok: false, reason: "no frame resolved a timestamp" };
  }
  return { ok: true, reason: null };
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

const report = {
  base: BASE,
  perfRequested: PERF,
  phaseExecutes: PHASE_EXECUTES,
  refreshSkipBounds: REFRESH_SKIP_BOUNDS,
  perf: null,
  predicates: {},
  structuralReasons: [],
};
const structuralReasons = report.structuralReasons;
const p = report.predicates;
// A run that falls out of the block below without folding a verdict has not
// "passed by default" — it reports the harness tier until the fold overwrites
// it, which is also the value the catch path keeps.
let exitCode = EXIT.HARNESS;
let fatal = null;

try {
  // ── PAGE 1 — legs B and C ───────────────────────────────────────────────
  const main = await openPage(browser, VIEWPORT);
  const readiness = await setupToReady(main.page);
  report.readiness = readiness;
  if (!readiness.ready) {
    structuralReasons.push(
      `main page never reached readiness (tilesLoaded=${readiness.tilesLoaded}, halfRes=${readiness.halfResActive}, marchPixels=${readiness.marchPixels})`,
    );
  }
  if (!readiness.commands.reconstruction) {
    structuralReasons.push(
      "CesiumDebug.cloudReconstruction is ABSENT from this build — the C13-10 legs cannot be driven",
    );
  }
  // The keep-live derivation assumes `requestRender()`'s ONLY effect beyond the
  // gate flag is unreachable. Read that back instead of assuming it.
  if (readiness.snapshotModeEnabled || readiness.snapshotModeFrozen) {
    structuralReasons.push(
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

  // (B0) DEFAULT state: nothing toggled. Only the `requested === false` half of
  // Leg 0 is claimed here; the cross-build byte identity is the attachments
  // probe's arm.
  const off = track(
    await phase(main.page, { label: "off", executes: PHASE_EXECUTES }),
  );
  const offCapture = await captureStationary(main.page, "off");

  // (B1) ATTACHMENTS-ONLY — C13-09's state, which must SURVIVE C13-10. This is
  // also the comparison state leg B's 3 → 2 claim is measured against, and it
  // is measured IN THIS PAGE so no cross-page fixed point is involved.
  const attachmentsOnly = track(
    await phase(main.page, {
      label: "attachments-only",
      toggle: { attachments: true, reconstruction: false },
      until: "produced",
    }),
  );
  const attachmentsOnlySettled = track(
    await phase(main.page, {
      label: "attachments-only:settled",
      executes: PHASE_EXECUTES,
    }),
  );
  const attachmentsCapture = await captureStationary(
    main.page,
    "attachments-only",
  );

  // (B2) CONSUME ON — the first consumer the attachments have ever had.
  const consume = track(
    await phase(main.page, {
      label: "consume",
      toggle: { reconstruction: true },
      until: "consumed",
    }),
  );
  const consumeSettled = track(
    await phase(main.page, {
      label: "consume:settled",
      executes: PHASE_EXECUTES,
    }),
  );
  const consumeCapture = await captureStationary(main.page, "consume");
  // Same-state, same-page self-diff: this page's own frame-to-frame floor, so
  // the recorded consume delta is interpretable rather than a bare number.
  const consumeFloorWindow = track(
    await phase(main.page, {
      label: "consume:self-floor",
      executes: STATIONARITY_GAP_EXECUTES,
    }),
  );
  const pngOff = offCapture.png;
  const pngAttachments = attachmentsCapture.png;
  const pngConsume = consumeCapture.png;
  const pngConsumeAgain = await screenshotCanvas(main.page);

  const stationarity = foldStationarity([
    {
      label: "off",
      stationary: offCapture.stationary,
      rounds: offCapture.rounds,
      executesObserved: offCapture.executesObserved,
    },
    {
      label: "attachments-only",
      stationary: attachmentsCapture.stationary,
      rounds: attachmentsCapture.rounds,
      executesObserved: attachmentsCapture.executesObserved,
    },
    {
      label: "consume",
      stationary: consumeCapture.stationary,
      rounds: consumeCapture.rounds,
      executesObserved: consumeCapture.executesObserved,
    },
    {
      label: "consume+8",
      stationary: sha(pngConsume) === sha(pngConsumeAgain),
      rounds: [{ round: 0, executesRun: consumeFloorWindow.executesRun }],
      executesObserved: consumeFloorWindow.executesRun,
    },
  ]);
  report.stationarity = {
    gapExecutes: STATIONARITY_GAP_EXECUTES,
    maxRounds: STATIONARITY_MAX_ROUNDS,
    stationary: stationarity.stationary,
    captures: {
      off: { ...offCapture, png: undefined },
      attachments: { ...attachmentsCapture, png: undefined },
      consume: { ...consumeCapture, png: undefined },
    },
  };
  for (const reason of stationarity.reasons) {
    structuralReasons.push(reason);
  }

  report.legB = {
    off,
    attachmentsOnly,
    attachmentsOnlySettled,
    consume,
    consumeSettled,
  };

  // ── LEG C — lifecycle under consume-on ──────────────────────────────────
  // The pre-resize attachment state is what the `resized` arrival condition is
  // measured AGAINST; without it the stale snapshot satisfies the condition on
  // the first render call, which is exactly what happened at Batch 944. It is
  // read from the FRESHEST pre-resize window, and a degenerate reading (zero
  // dims or zero generation, i.e. a frame the producer did not run) is NAMED —
  // the condition `width !== 0 && generation > 0` is satisfiable by the stale
  // state, so a degenerate baseline would silently restore the defect.
  const preResize = consumeFloorWindow.attachments ?? consume.attachments;
  const beforeResize = {
    previousWidth: preResize?.width ?? 0,
    previousHeight: preResize?.height ?? 0,
    previousGeneration: preResize?.generation ?? 0,
  };
  if (
    !(beforeResize.previousWidth > 0) ||
    !(beforeResize.previousGeneration > 0)
  ) {
    structuralReasons.push(
      `RESIZE BASELINE DEGENERATE — the pre-resize attachment state read ${beforeResize.previousWidth}x${beforeResize.previousHeight} gen ${beforeResize.previousGeneration}; the resize arrival condition cannot discriminate against it`,
    );
  }
  await main.page.setViewportSize(RESIZED);
  const canvasUp = await awaitCanvasChange(main.page, {
    width: consumeFloorWindow.canvasSize?.width ?? VIEWPORT.width,
    height: consumeFloorWindow.canvasSize?.height ?? VIEWPORT.height,
  });
  const resizeUp = track(
    await phase(main.page, {
      label: "resize-up",
      until: "resized",
      expect: beforeResize,
    }),
  );
  const beforeResizeBack = {
    previousWidth: resizeUp.attachments?.width ?? 0,
    previousHeight: resizeUp.attachments?.height ?? 0,
    previousGeneration: resizeUp.attachments?.generation ?? 0,
  };
  await main.page.setViewportSize(VIEWPORT);
  const canvasBack = await awaitCanvasChange(main.page, {
    width: canvasUp.width,
    height: canvasUp.height,
  });
  const resizeBack = track(
    await phase(main.page, {
      label: "resize-back",
      until: "resized",
      expect: beforeResizeBack,
    }),
  );
  const tierHighSet = await setQuality(main.page, "high");
  const tierHigh = track(
    await phase(main.page, { label: "tier-high", until: "notEmitting" }),
  );
  const tierLowSet = await setQuality(main.page, "low");
  const tierLow = track(
    await phase(main.page, { label: "tier-low", until: "consumed" }),
  );
  report.legC = {
    canvasUp,
    canvasBack,
    resizeUp,
    resizeBack,
    tierHigh,
    tierLow,
    tierReadback: { high: tierHighSet, low: tierLowSet },
  };
  if (!canvasUp.changed || !canvasBack.changed) {
    structuralReasons.push(
      `RESIZE PLUMBING — the canvas backing store did not change within its bound (up=${canvasUp.changed} ${canvasUp.width}x${canvasUp.height}, back=${canvasBack.changed} ${canvasBack.width}x${canvasBack.height}); the resize legs did not see their subject`,
    );
  }

  for (const reason of starvedWindowReasons(windowLedger)) {
    structuralReasons.push(reason);
  }
  report.windowLedger = windowLedger;

  const gateMain = await collectGateErrors(main.page);
  report.gateMain = gateMain;
  report.consoleErrors = {
    page: main.errors,
    gpu: main.gpuConsoleErrors,
  };
  await main.page.close().catch(() => {});

  // ── Pixel diffs (scratch page — decode only, no WebGPU involved) ─────────
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}/b0-default-off.png`, pngOff);
  writeFileSync(`${OUTPUT_DIR}/b1-attachments-only.png`, pngAttachments);
  writeFileSync(`${OUTPUT_DIR}/b2-consume-on.png`, pngConsume);
  writeFileSync(`${OUTPUT_DIR}/b2-consume-on-plus8.png`, pngConsumeAgain);
  const scratch = await browser.newPage();
  await scratch.goto("about:blank");
  const diffs = {
    offVsAttachments: await pixelDiff(scratch, pngOff, pngAttachments),
    attachmentsVsConsume: await pixelDiff(scratch, pngAttachments, pngConsume),
    offVsConsume: await pixelDiff(scratch, pngOff, pngConsume),
    consumeSelfFloor: await pixelDiff(scratch, pngConsume, pngConsumeAgain),
  };
  // A diff is only interpretable when BOTH of its endpoints converged — the
  // Batch-944 34.5% was a converged capture minus a mid-convergence one.
  const interpretable = stationarity.stationary;
  diffs.offVsAttachments.interpretable = diffInterpretable(
    interpretable,
    "off",
    "attachments-only",
  );
  diffs.attachmentsVsConsume.interpretable = diffInterpretable(
    interpretable,
    "attachments-only",
    "consume",
  );
  diffs.offVsConsume.interpretable = diffInterpretable(
    interpretable,
    "off",
    "consume",
  );
  diffs.consumeSelfFloor.interpretable = diffInterpretable(
    interpretable,
    "consume",
    "consume+8",
  );
  await scratch.close().catch(() => {});
  report.hashes = {
    off: sha(pngOff),
    attachments: sha(pngAttachments),
    consume: sha(pngConsume),
    consumePlus8: sha(pngConsumeAgain),
  };
  report.diffs = diffs;

  // ── LEG D — interleaved A/B cost (only with --perf) ──────────────────────
  let perf = null;
  if (!PERF) {
    structuralReasons.push(
      "PERF ARM SKIPPED-BY-CONFIGURATION: `--perf` was not passed — Leg D DID NOT RUN",
    );
  } else {
    const perfPage = await openPage(browser, VIEWPORT);
    const perfReadiness = await setupToReady(perfPage.page);
    const support = await perfPage.page.evaluate(() => {
      const ctx = window.viewer.scene._context;
      const feature = ctx?.hasFeature?.("timestamp-query") === true;
      window.CesiumDebug?.gpuPassCost?.(true);
      const profiler = ctx?.timestampProfiler ?? null;
      return {
        feature,
        profilerPresent: !!profiler,
        enabled: profiler?.getResults?.()?.enabled === true,
      };
    });
    const schedule = buildInterleavedSchedule(PERF_ITERATIONS);
    const interleave = describeInterleave(schedule);
    const windows = [];
    if (!perfReadiness.ready) {
      structuralReasons.push(
        `perf page never reached readiness (marchPixels=${perfReadiness.marchPixels})`,
      );
    } else if (
      !support.feature ||
      !support.profilerPresent ||
      !support.enabled
    ) {
      // C11-146: a zeroed timing block must never read as a measurement. The
      // arm is named as STRUCTURAL instead of reporting zeros.
      structuralReasons.push(
        `PERF ARM STRUCTURAL — no usable GPU timestamp support (timestamp-query=${support.feature}, profiler=${support.profilerPresent}, enabled=${support.enabled}); NO timing was measured`,
      );
    } else {
      for (const slot of schedule) {
        windows.push({
          ...slot,
          ...(await measurePerfWindow(perfPage.page, slot.arm)),
        });
      }
    }
    await perfPage.page
      .evaluate(() => window.CesiumDebug?.gpuPassCost?.(false))
      .catch(() => {});
    const gatePerf = await collectGateErrors(perfPage.page);
    await perfPage.page.close().catch(() => {});

    // A window whose TIMING arm did not hold is DISCARDED-AND-NAMED: it never
    // enters a median, and it is reported by index and arm.
    const armVerdicts = windows.map((w, index) => ({
      index,
      iteration: w.iteration,
      arm: w.arm,
      ...timingArmHeld(w),
    }));
    const discarded = armVerdicts.filter((v) => !v.ok);
    const timedWindows = windows.filter((w, index) => armVerdicts[index].ok);
    for (const verdict of discarded) {
      structuralReasons.push(
        `PERF WINDOW DISCARDED — window ${verdict.index} (iteration ${verdict.iteration}, ${verdict.arm}): ${verdict.reason}`,
      );
    }

    // Per-arm summaries and PAIRED per-iteration deltas, per pass — built ONLY
    // from windows whose timing arm held.
    const perPass = {};
    for (const name of PERF_PASS_NAMES) {
      const byArm = { [ARM_A]: [], [ARM_B]: [] };
      const pairs = new Map();
      for (const w of timedWindows) {
        const timing = readPassTiming(w.results, name);
        const value = timing ? timing.avgMs : null;
        byArm[w.arm].push(value);
        const pair = pairs.get(w.iteration) ?? { iteration: w.iteration };
        pair[w.arm === ARM_A ? "a" : "b"] = value;
        pairs.set(w.iteration, pair);
      }
      perPass[name] = {
        attachmentsOnly: summarize(byArm[ARM_A]),
        consumeOn: summarize(byArm[ARM_B]),
        paired: pairedDeltas([...pairs.values()]),
      };
    }
    // Every surviving window must have SEEN both named passes, or the medians
    // above are built on a partial set.
    const blindWindows = timedWindows.filter(
      (w) =>
        readPassTiming(w.results, PASS_MARCH) === null ||
        readPassTiming(w.results, PASS_PRODUCER) === null,
    );
    if (timedWindows.length > 0 && blindWindows.length > 0) {
      structuralReasons.push(
        `PERF ARM PARTIAL — ${blindWindows.length} of ${timedWindows.length} timed windows produced no usable timing for one of the two named passes`,
      );
    }
    if (windows.length > 0 && timedWindows.length === 0) {
      structuralReasons.push(
        "PERF ARM BLIND — no window held its timing arm; NO occupancy number exists and none is quoted",
      );
    }
    // A window's number is attributable only if its declared arm held on EVERY
    // sampled verify frame — including `producerTargets`, which is per-frame and
    // reads 0 on any frame the producer did not run, so a mixed set is exactly
    // the "measured through a transition" failure this span exists to catch.
    const armsHeld = windows.filter((w) => {
      const expectEmit = w.arm === ARM_B;
      const v = w.verify;
      const em = w.final?.emission ?? null;
      return (
        w.commandsPresent === true &&
        v.marchActiveFrames === v.frames &&
        v.emittedFrames === (expectEmit ? v.frames : 0) &&
        v.consumedFrames === (expectEmit ? v.frames : 0) &&
        v.producerTargetsSeen.length === 1 &&
        v.producerTargetsSeen[0] === (expectEmit ? 2 : 3) &&
        em?.emitted === expectEmit &&
        em?.consumed === expectEmit
      );
    }).length;
    if (windows.length > 0 && armsHeld !== windows.length) {
      structuralReasons.push(
        `PERF ARM UNVERIFIED — only ${armsHeld} of ${windows.length} windows held their declared arm across every verify frame; those timings are not attributable`,
      );
    }
    const ledgerClean = timedWindows.every(
      (w) => w.results?.sampleLedgerBalanced === true,
    );
    if (timedWindows.length > 0 && !ledgerClean) {
      structuralReasons.push(
        "PERF ARM LEDGER — at least one window's GPU sample ledger did not close; those timings under-report",
      );
    }
    perf = {
      requestedIterations: PERF_ITERATIONS,
      measureFrames: PERF_MEASURE_FRAMES,
      warmFrames: PERF_WARM_FRAMES,
      verifyFrames: PERF_VERIFY_FRAMES,
      support,
      interleave,
      windowCount: windows.length,
      timedWindowCount: timedWindows.length,
      armVerdicts,
      discardedWindowCount: discarded.length,
      armsHeld,
      ledgerClean,
      blindWindowCount: blindWindows.length,
      perPass,
      gate: gatePerf,
      pageErrors: perfPage.errors,
      windows,
    };
    report.perf = perf;
  }

  // ── Predicates ──────────────────────────────────────────────────────────
  const attA = attachmentsOnly.attachments;
  const emA = attachmentsOnly.emission;
  const attB = consume.attachments;
  const emB = consume.emission;

  // Off-state half of Leg 0 (the byte-identity half is the attachments probe's).
  p.offRequestedFalse =
    off.emission !== null && off.emission.requested === false;
  p.offNothingResident =
    off.attachments !== null && off.attachments.liveBytes === 0;

  // The comparison state leg B is measured against.
  p.attachmentsOnlyProducerTargets3 = emA !== null && emA.producerTargets === 3;
  p.attachmentsOnlyNotConsuming =
    emA !== null && emA.emitted === false && emA.consumed === false;

  // LEG B.
  p.bRequestedResident = emB !== null && emB.requested === true;
  p.bEmitted = emB !== null && emB.emitted === true;
  p.bConsumed = emB !== null && emB.consumed === true;
  p.bProducerTargets2 = emB !== null && emB.producerTargets === 2;
  p.bProducerTargetsMovedThreeToTwo =
    emA !== null &&
    emB !== null &&
    emA.producerTargets === 3 &&
    emB.producerTargets === 2;
  p.bLiveBytesExact =
    attB !== null &&
    attB.liveBytes === attB.width * attB.height * BYTES_PER_TEXEL_OWNED;
  p.bLiveBytesUnchangedAcrossFlip =
    attA !== null && attB !== null && attA.liveBytes === attB.liveBytes;
  p.bGenerationUnchangedAcrossFlip =
    attA !== null && attB !== null && attA.generation === attB.generation;
  p.bPassTopologyUnchanged =
    attachmentsOnly.passCount !== null &&
    attachmentsOnly.passCount === consume.passCount &&
    attachmentsOnly.passes[PASS_MARCH] === 1 &&
    consume.passes[PASS_MARCH] === 1 &&
    attachmentsOnly.passes[PASS_PRODUCER] === 1 &&
    consume.passes[PASS_PRODUCER] === 1 &&
    attachmentsOnly.activePassNames.join("|") ===
      consume.activePassNames.join("|");
  p.bMarchLiveInBothWindows =
    (attachmentsOnly.marchPixels ?? 0) > 0 && (consume.marchPixels ?? 0) > 0;
  p.bConsumedPromptly = consume.conditionMet && consume.coherent;

  // LEG C.
  const attUp = resizeUp.attachments;
  const attBack = resizeBack.attachments;
  p.cResizeReengagesBothWays =
    resizeUp.conditionMet &&
    resizeBack.conditionMet &&
    resizeUp.emission?.consumed === true &&
    resizeBack.emission?.consumed === true;
  p.cGenerationMonotonic =
    attB !== null &&
    attUp !== null &&
    attBack !== null &&
    attUp.generation > attB.generation &&
    attBack.generation > attUp.generation;
  p.cLiveBytesTrackSize =
    attUp !== null &&
    attBack !== null &&
    attUp.liveBytes === attUp.width * attUp.height * BYTES_PER_TEXEL_OWNED &&
    attBack.liveBytes ===
      attBack.width * attBack.height * BYTES_PER_TEXEL_OWNED &&
    (attUp.width !== attBack.width || attUp.height !== attBack.height);
  // The documented residual: the full-resolution tier has no half-res march
  // target to emit into and no temporal history to validate.
  p.cFullResTierProducesNothing =
    tierHigh.conditionMet &&
    tierHigh.emission?.emitted === false &&
    tierHigh.emission?.consumed === false &&
    tierHigh.attachments?.produced === false;
  p.cReturnToLowReengages =
    tierLow.conditionMet &&
    tierLow.emission?.emitted === true &&
    tierLow.emission?.consumed === true;

  p.zeroErrors =
    main.errors.length === 0 &&
    main.gpuConsoleErrors.length === 0 &&
    gateMain.errors.length === 0 &&
    gateMain.deviceLost === null &&
    (perf === null ||
      (perf.pageErrors.length === 0 &&
        perf.gate.errors.length === 0 &&
        perf.gate.deviceLost === null));
  p.gateArmed = main.armState.found >= 1 && gateMain.armedDevices >= 1;

  // LEG D — the only RED predicate the perf lane owns is its own protocol
  // compliance. Timing has NO bar on this first run; everything else the lane
  // can fail at is STRUCTURAL (it makes no correctness claim — leg B is the
  // lane that certifies the verdicts).
  p.dInterleaveIsRealInterleave = PERF ? perf?.interleave?.ok === true : null;

  // ── Output ──────────────────────────────────────────────────────────────
  const fold = foldExit({ predicates: p, structuralReasons });
  exitCode = fold.exitCode;

  console.log("=== C13-10 EDGE ACCEPTANCE — march-emitted reconstruction ===");
  console.log(
    `  readiness: ${readiness.readinessFrames} frames (march ${readiness.marchPixels}px halfRes=${readiness.halfResActive}) requestRenderMode=${readiness.requestRenderMode} snapshotMode=${readiness.snapshotModeEnabled}/${readiness.snapshotModeFrozen} commands=${JSON.stringify(readiness.commands)}`,
  );
  console.log(
    `  OFF:        requested=${off.emission?.requested} liveBytes=${off.attachments?.liveBytes} (${off.executesRun}/${off.executeBudget} executes, ${off.outcome})`,
  );
  console.log(
    `  ATTACH-ONLY: produced=${attA?.produced} targets=${emA?.producerTargets} gen=${attA?.generation} liveBytes=${attA?.liveBytes} (${attA?.width}x${attA?.height}x24) emitted=${emA?.emitted} consumed=${emA?.consumed} lag=${attachmentsOnly.publishLagExecutes}e (${attachmentsOnly.executesRun} executes, ${attachmentsOnly.outcome})`,
  );
  console.log(
    `  CONSUME:     requested=${emB?.requested} emitted=${emB?.emitted} consumed=${emB?.consumed} targets=${emB?.producerTargets} gen=${attB?.generation} liveBytes=${attB?.liveBytes} withinExecutes=${consume.executesRun} lag=${consume.publishLagExecutes}e (${consume.outcome})`,
  );
  console.log(
    `  pass topology: passCount ${attachmentsOnly.passCount} → ${consume.passCount}; march ${attachmentsOnly.passes[PASS_MARCH]}→${consume.passes[PASS_MARCH]}, producer ${attachmentsOnly.passes[PASS_PRODUCER]}→${consume.passes[PASS_PRODUCER]}, resolve ${attachmentsOnly.passes[PASS_RESOLVE]}→${consume.passes[PASS_RESOLVE]}, upscale ${attachmentsOnly.passes[PASS_UPSCALE]}→${consume.passes[PASS_UPSCALE]}`,
  );
  console.log(
    `  STATIONARITY (${STATIONARITY_GAP_EXECUTES} executes/round, ≤${STATIONARITY_MAX_ROUNDS} rounds): off=${offCapture.stationary} in ${offCapture.windows} | attachments=${attachmentsCapture.stationary} in ${attachmentsCapture.windows} | consume=${consumeCapture.stationary} in ${consumeCapture.windows}`,
  );
  console.log(
    "  VISUAL (recorded, NO pass/fail bar this run — read the PNGs):",
  );
  console.log(
    `    off→attachments ${pct(diffs.offVsAttachments.mismatchFraction)} [interpretable=${diffs.offVsAttachments.interpretable}] | attachments→consume ${pct(diffs.attachmentsVsConsume.mismatchFraction)} [interpretable=${diffs.attachmentsVsConsume.interpretable}] | off→consume ${pct(diffs.offVsConsume.mismatchFraction)} | same-state floor ${pct(diffs.consumeSelfFloor.mismatchFraction)}`,
  );
  console.log(
    `  LEG C: canvas ${canvasUp.changed ? "changed" : "STUCK"} → ${canvasUp.width}x${canvasUp.height} in ${canvasUp.renderCalls} calls; attachments ${attB?.width}x${attB?.height} gen ${attB?.generation} → ${attUp?.width}x${attUp?.height} gen ${attUp?.generation} (${resizeUp.executesRun}e, liveBytes=${attUp?.liveBytes}, ${resizeUp.outcome}) → ${attBack?.width}x${attBack?.height} gen ${attBack?.generation} (${resizeBack.executesRun}e, liveBytes=${attBack?.liveBytes}, ${resizeBack.outcome})`,
  );
  console.log(
    `    tier high (readback ${tierHighSet}): emitted=${tierHigh.emission?.emitted} consumed=${tierHigh.emission?.consumed} produced=${tierHigh.attachments?.produced} halfRes=${tierHigh.halfResActive} liveBytes=${tierHigh.attachments?.liveBytes} (resident by design) | back to low (readback ${tierLowSet}): emitted=${tierLow.emission?.emitted} consumed=${tierLow.emission?.consumed} within ${tierLow.executesRun}/${tierLow.executeBudget} executes (${tierLow.outcome})`,
  );
  if (perf && perf.timedWindowCount > 0) {
    console.log(
      `  LEG D (interleaved A/B, ${perf.interleave.iterations} iterations × 2 windows, ${PERF_WARM_FRAMES} warm + ${PERF_VERIFY_FRAMES} verify + ${PERF_MEASURE_FRAMES} measured frames each, orders ${perf.interleave.ordersSeen.join("+")}, maxRun ${perf.interleave.maxRun}, armsHeld ${perf.armsHeld}/${perf.windowCount}, timed ${perf.timedWindowCount}/${perf.windowCount}, discarded ${perf.discardedWindowCount}, ledgerClean ${perf.ledgerClean}):`,
    );
    for (const name of PERF_PASS_NAMES) {
      const row = perf.perPass[name];
      console.log(
        `    ${name}: A median ${ms(row.attachmentsOnly?.median)}ms [${ms(row.attachmentsOnly?.min)}..${ms(row.attachmentsOnly?.max)}] n=${row.attachmentsOnly?.n ?? 0} | B median ${ms(row.consumeOn?.median)}ms [${ms(row.consumeOn?.min)}..${ms(row.consumeOn?.max)}] n=${row.consumeOn?.n ?? 0} | paired B−A median ${ms(row.paired.summary?.median)}ms (spread ${ms(row.paired.summary?.spread)}, dropped ${row.paired.droppedPairs})`,
      );
    }
    console.log(
      "    DERIVATION (expectations, not bars): emitting march carries ~4 more live f32 → ≥ historical march; emitting producer skips up to 6 ray-ellipsoid intersections + 9 log-bearing estimator evaluations for 10 rg32float loads → expected CHEAPER. The upscale is the untouched drift control.",
    );
  } else if (PERF) {
    console.log(
      "  LEG D: NO ATTRIBUTABLE WINDOWS — see the structural reasons; no timing is quoted.",
    );
  }
  console.log(`  predicates: ${JSON.stringify(p)}`);
  if (fold.failed.length) {
    console.log(`  RED: ${fold.failed.join(", ")}`);
  }
  if (fold.notRun.length) {
    console.log(`  NOT RUN: ${fold.notRun.join(", ")}`);
  }
  for (const reason of structuralReasons) {
    console.log(`  STRUCTURAL: ${reason}`);
  }

  writeFileSync(`${OUTPUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(`[report: ${OUTPUT_DIR}/report.json]`);

  if (exitCode === EXIT.FAIL) {
    console.log("FAIL — a pre-registered C13-10 acceptance predicate is red");
  } else if (exitCode === EXIT.STRUCTURAL) {
    console.log(
      "STRUCTURAL — no red predicate, but an arm did not run or could not see its subject",
    );
  } else {
    console.log(
      "PASS — C13-10 Edge acceptance: leg B counters, leg C lifecycle and leg D interleaved cost all ran",
    );
  }
} catch (error) {
  // `exitCode` is still the harness tier it was initialised to: a throw means
  // the instrument broke, which is exit 2 and never a verdict about C13-10.
  fatal = error;
  console.error(`[cloud-recon-consume] THREW: ${error?.stack ?? error}`);
} finally {
  await browser.close().catch(() => {});
}

clearTimeout(watchdog);
if (fatal) {
  process.exit(EXIT.HARNESS);
}
process.exit(exitCode);
