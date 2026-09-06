#!/usr/bin/env node
/**
 * Probe: DISPLAY-CONDITIONS-GLOBEDEPTH (rows AR-890 / AR-887).
 * @purpose Looped acceptance for display-conditions-dev on WebGPU: per-run occurrence counts of the GlobeDepth-DepthCopy destroyed-texture submit fault plus a capture matching WebGL, aggregated into a hit rate over N runs.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * ── WHAT IT ANSWERS ────────────────────────────────────────────────────────
 *
 * The 2026-09-04 Sandcastle2 WebGPU sweep (Éowyn job 3 leg 2b) reported, on
 * `display-conditions-dev`:
 *
 *   [WebGPU:GlobePass] GPU VALIDATION ERROR: Destroyed texture
 *   [Texture "GlobeDepth-DepthCopy_color_rgba8unorm"] used in a submit.
 *    - While calling [Queue].Submit([[CommandBuffer from CommandEncoder
 *      "Scene Frame Command Encoder"]
 *
 * so the whole scene frame's command buffer was rejected. `AR-887` owns the
 * defect; this probe is its acceptance (R-2026-08-29-1). Two clauses:
 *
 *   (a) zero `Destroyed texture` / `GPUValidationError` occurrences on the
 *       WebGPU leg, and
 *   (b) the WebGPU capture matches the WebGL capture at the demo's camera.
 *
 * ── WHY IT LOOPS, AND WHY N IS 12 ──────────────────────────────────────────
 *
 * The fault is intermittent. Two page loads of this demo have been observed:
 * job 3 hit it (frameNumber 32, `SANDCASTLE_SETTLE_MS` at its 8000 default,
 * tree `40341305f4`) and job 5 did not (frameNumber 371, a targeted run at a
 * DIAGNOSTIC `SANDCASTLE_SETTLE_MS=25000`, tree `22af08f698`). One hit in two
 * loads under two different settle regimes is not a rate; it is a reason to
 * measure one.
 *
 * N = 12 is chosen from the detection arithmetic, not for looks. For a
 * per-run hit probability p, the chance that N independent runs all miss is
 * (1 - p)^N, so N runs detect a rate of p or higher with 95 % confidence when
 * N >= ln(0.05) / ln(1 - p): p = 0.25 needs 11 runs, p = 0.221 needs 12,
 * p = 0.20 needs 14, p = 0.10 needs 29. Twelve runs therefore catch anything
 * at or above a 22.1 % per-run rate with 95 % confidence, which brackets the
 * only estimate the evidence supports (1 hit in 2 observed loads), and cost
 * about 25 minutes of Edge wall time on both backends. Read the converse
 * honestly: **12 clean runs bound the rate at p < 0.221 with 95 % confidence
 * and do NOT exclude a rarer fault.** Closing `AR-887` at a lower rate needs
 * a larger `--runs` or a deterministic reproduction, and the receipt says so.
 *
 * The runtime gives each run its own Edge browser, so no run inherits the
 * previous run's warm shader cache — the confound that would make a
 * timing-dependent race fire only on run 1.
 *
 * ── WHY IT COUNTS OCCURRENCES, NOT A DE-DUPLICATED SET ─────────────────────
 *
 * `sandcastle-smoke.mjs` folds a demo's errors through `new Set(errors)`
 * (`:553`, published at `:563`), so its receipt states no per-frame rate. That
 * is only half the reason. The engine's own reporter for this message is
 * ONE-SHOT: `WebGPUSceneRenderer._executeGlobePass` pushes a single validation
 * error scope on the first globe pass, guarded by `_globeValidationDone`, and
 * pops it in a microtask (`WebGPUSceneRenderer.ts:2267-2285`). It can fire at
 * most once per page load no matter how the harness collects, and the frame it
 * covers is the FIRST globe-command frame — not the `frameNumber` a settle
 * gate reads afterwards.
 *
 * So this probe reads two sources and keeps them apart:
 *
 *   * the page console (`attachConsoleErrorGate`), which sees the engine's
 *     one-shot print and Dawn's own scoped prints, and
 *   * `device.onuncapturederror` (`errorGateInit` / `armWebGPUDevices`), a
 *     PERSISTENT per-device handler that appends every later occurrence once
 *     the engine's one-shot scope has closed.
 *
 * Neither array de-duplicates. The receipt reports occurrences per run and per
 * phase, and the aggregate is a hit RATE over runs — never a set union across
 * the loop, which is exactly the limitation the row says not to inherit.
 *
 * ── THE THREE PHASES OF A RUN ──────────────────────────────────────────────
 *
 *   1. `steady` — the demo's own default state under the real rAF render loop.
 *      `Sandcastle.addToolbarMenu` installs `options[0].onselect` as
 *      `defaultAction` and the bucket invokes it on load
 *      (`packages/sandcastle/templates/Sandcastle.ts:245-247`, `:106-109`), so
 *      the shipped default is `addBillboardAndPrimitive` — the billboard and
 *      the translucent rectangle, both under a `DistanceDisplayCondition`. The
 *      sweep harness never touches the toolbar, so the second menu entry is
 *      not part of what job 3 measured and is not reproduced here.
 *
 *   2. `resize` — the same scene across three viewport changes and back.
 *      `WebGPUGlobeDepth.update` recreates and DESTROYS its targets, the
 *      `GlobeDepth-DepthCopy` colour texture among them, whenever width,
 *      height, sample count, HDR or device change
 *      (`WebGPUGlobeDepth.ts:270-278` -> `_destroyTargets` at `:678-690`), and
 *      the pre-existing owner of this error class,
 *      `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`
 *      (`QUEUE_2026-07-15_CAMPAIGN9.md:124`, NOT STARTED), names the
 *      `GlobeDepth-DepthCopy` destroyed-texture follow-on as occurring "under
 *      resize". This phase reproduces that stated condition. It is NOT a
 *      diagnosis of `AR-887` — the row is symptom-only and this probe does not
 *      make it otherwise. The two phases are counted separately, and the
 *      `resize` phase does NOT gate the verdict: counting it would make
 *      `AR-890`'s "zero after `AR-887`" clause depend on a DIFFERENT row's
 *      fix (that owner is P0 and NOT STARTED), which would make the clause
 *      structurally unreachable. Resize hits are reported as ATTRIBUTION —
 *      in the receipt, in the per-run table and in a named line of the
 *      summary — so a reader can tell a shipped-configuration hit from a
 *      stressed one and route the stressed one to its own owner.
 *
 *   3. `capture` — the loop is stopped, the clock pinned and a fixed number of
 *      frames rendered by hand, so clause (b) compares two deterministic
 *      frames rather than two rAF races.
 *
 * ── DELIBERATE DEVIATIONS FROM THE SHIPPED DEMO, AND WHY ───────────────────
 *
 *   * The scene is TRANSCRIBED from `packages/sandcastle/gallery/
 *     display-conditions-dev/main.js` onto the shared runtime's single served
 *     origin rather than loaded through Sandcastle2, which needs a second
 *     bucket origin and a separately built app. This is the shape
 *     `probe-primitive-texture-bindgroup.mjs` already established for
 *     `frustum-dev`.
 *   * The base imagery is the repository's own Natural Earth II tiles instead
 *     of the default ion layer, so both backends sample identical bytes with
 *     no network. Clause (b) is a cross-backend comparison; a streaming layer
 *     would make it a measurement of tile arrival order. The substitution
 *     changes which textures the globe samples and nothing about the
 *     depth-copy target's lifetime, which is the code under acceptance.
 *
 * Both deviations are recorded in the receipt so a reader never has to
 * reconstruct them from this comment.
 *
 * ── PRECONDITIONS ──────────────────────────────────────────────────────────
 *
 *   * `npx gulp build`, then `node server.js --port 8094 --serve-built`
 *     (use `localhost`, not `127.0.0.1` — the dev server binds IPv6).
 *   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
 *   * The target page, `Apps/CesiumViewer/index.html`, loads its app as an ES
 *     module and so publishes `window.viewer` but NO `window.Cesium`. The
 *     scene build below imports the namespace from the same module URL the app
 *     itself imports; see the comment there for why the identity matters. A
 *     probe that reads `window.Cesium` on this page refuses on run 0, leg 0.
 *
 * Run:
 *   node Tools/visual-regression/probe-display-conditions-globedepth.mjs --port 8094 --runs 12
 * Out:
 *   Tools/visual-regression/output/display-conditions-globedepth/
 *
 * ── HOW TO READ THE EXIT CODE ──────────────────────────────────────────────
 *
 *   0 — the loop completed and every verdict passed: the shipped-configuration
 *       hit rate is 0/N and every capture matched WebGL. This is what `AR-887`
 *       owes.
 *   1 — the loop completed and a verdict failed. Read the summary: a
 *       shipped-configuration hit, a capture drift, a degenerate canvas, a lost
 *       device, or the WebGL control firing.
 *   3 — REFUSAL. The loop did NOT complete — a scene build failed, or a run
 *       tripped the six-minute watchdog. A `ProbeRefusal` from any leg
 *       propagates out of the run loop, so there is NO hit rate at all and the
 *       partial runs are not a measurement. **Exit 3 must never be read as
 *       "the fault fired"**; it means the instrument did not produce a number.
 */
import fs from "node:fs";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { decodePng, diffPixels, frameStats } from "../lib/png-decode.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

/** See the header: 12 runs detect a per-run rate of 22.1 % or higher at 95 %. */
export const DEFAULT_RUNS = 12;

export const VIEWPORT = Object.freeze({ width: 800, height: 600 });

/**
 * The resize phase's viewport sequence, ending back at {@link VIEWPORT} so the
 * capture phase compares two frames of the same size.
 */
export const RESIZE_STEPS = Object.freeze([
  { width: 900, height: 620 },
  { width: 760, height: 540 },
  { width: VIEWPORT.width, height: VIEWPORT.height },
]);

/** Wall-clock milliseconds the real render loop runs in each phase step. */
export const STEADY_MS = 3000;
export const RESIZE_STEP_MS = 700;
/** Frames rendered by hand once the loop is stopped, before the capture. */
export const CAPTURE_FRAMES = 30;

/** The demo's clock, pinned so both backends light the scene identically. */
export const CLOCK_ISO = "2026-06-21T18:00:00Z";

/**
 * The fault this probe exists to count, verbatim enough to be specific and
 * loose enough to survive Dawn's punctuation and the engine's `[WebGPU:...]`
 * prefix. A different validation error must not satisfy it, which is why the
 * destroyed-texture family is matched separately from the general one.
 */
export const DESTROYED_TEXTURE_RE =
  /destroyed texture\s*\[texture "GlobeDepth-DepthCopy/i;

/**
 * The wider family clause (a) also counts: any WebGPU validation error,
 * however it reached us — Dawn's console print, the engine's popped error
 * scope, or the gate's `onuncapturederror` tag.
 */
export const VALIDATION_RE =
  /GPUValidationError|GPU VALIDATION ERROR|uncaptured GPU error/i;

/** Clause (b): the cross-backend band this fork's globe scenes already meet. */
export const MAX_MISMATCH_PCT = 2.0;
export const DIFF_TOLERANCE = 12;

/**
 * "Nothing drew" canary. A run whose canvas is one flat colour has not
 * measured clause (b) at all, and an invalidated command buffer is exactly how
 * that happens here, so a degenerate capture fails rather than passing quietly.
 */
export const MIN_DISTINCT_COARSE_COLORS = 3;

// Machine safety: kill a hung Edge or device rather than wedge the box. A
// `ProbeRefusal` reaches exit 3 through the runtime's exit-code table and lets
// the runtime's `finally` close the browser, instead of killing the process
// out from under an open GPU device.
const WATCHDOG_BUDGET_MS = 6 * 60 * 1000;

/**
 * Count fault occurrences in a list of collected messages.
 *
 * Every element is examined and every match is counted. There is no set, no
 * key and no first-match short circuit: a message that arrives three times
 * counts three times, because a per-frame rate is the number `AR-890` exists
 * to produce and a de-duplicated set structurally cannot state one.
 *
 * @param {string[]} messages Collected console / gate messages, in order.
 * @returns {{destroyedTexture: number, validation: number, total: number, samples: string[]}}
 *   Per-family occurrence counts, the number of messages matching either
 *   family, and up to five verbatim samples for the receipt.
 */
export function countFaultOccurrences(messages) {
  let destroyedTexture = 0;
  let validation = 0;
  let total = 0;
  const samples = [];
  for (const message of messages ?? []) {
    const text = String(message);
    const isDestroyed = DESTROYED_TEXTURE_RE.test(text);
    const isValidation = VALIDATION_RE.test(text);
    if (isDestroyed) {
      destroyedTexture += 1;
    }
    if (isValidation) {
      validation += 1;
    }
    if (isDestroyed || isValidation) {
      total += 1;
      if (samples.length < 5) {
        samples.push(text.slice(0, 240));
      }
    }
  }
  return { destroyedTexture, validation, total, samples };
}

/**
 * The phases that are this probe's own stressor rather than the shipped
 * configuration job 3 measured. Their occurrences are recorded and reported
 * but never gate a verdict — see the header's phase-2 note.
 */
export const STRESSOR_PHASES = Object.freeze(["resize"]);

/**
 * Split one leg's phase records into the shipped-configuration half, which
 * decides the verdict, and the stressor half, which is attribution only.
 *
 * @param {Array<{phase: string, occurrences: object}>} phases Phase records.
 * @returns {{all: object, shipped: object, stressor: object}} The three sums.
 */
export function partitionOccurrences(phases) {
  const list = phases ?? [];
  return {
    all: sumPhaseOccurrences(list),
    shipped: sumPhaseOccurrences(
      list.filter((phase) => !STRESSOR_PHASES.includes(phase.phase)),
    ),
    stressor: sumPhaseOccurrences(
      list.filter((phase) => STRESSOR_PHASES.includes(phase.phase)),
    ),
  };
}

/**
 * Merge the per-phase counts of one leg into that leg's totals.
 *
 * @param {Array<{occurrences: {destroyedTexture: number, validation: number, total: number}}>} phases Phase records.
 * @returns {{destroyedTexture: number, validation: number, total: number}} Summed counts.
 */
export function sumPhaseOccurrences(phases) {
  const sum = { destroyedTexture: 0, validation: 0, total: 0 };
  for (const phase of phases ?? []) {
    const o = phase.occurrences ?? {};
    sum.destroyedTexture += o.destroyedTexture ?? 0;
    sum.validation += o.validation ?? 0;
    sum.total += o.total ?? 0;
  }
  return sum;
}

/**
 * Decide one run's verdict from its two legs.
 *
 * The clauses are independent and all must hold: a run with a clean capture
 * and one destroyed-texture occurrence FAILS, and so does a run with zero
 * occurrences whose capture has drifted off WebGL.
 *
 * The occurrence clause reads the SHIPPED-phase counts only. The `resize`
 * phase is this probe's own stressor and reproduces a condition a different,
 * NOT STARTED row already owns, so gating on it would make `AR-890`'s "zero
 * after `AR-887`" clause depend on that row's fix. Both counts reach the
 * receipt; only the shipped one decides.
 *
 * A leg record that carries no shipped-phase count fails CLOSED — a missing
 * measurement is not a clean one.
 *
 * The WebGL leg is a real control, not a claim: its shipped-phase occurrences
 * are asserted here. Neither fault family can be produced by a WebGL context,
 * so a hit on that leg means the instrument, not the backend, is wrong.
 *
 * @param {object} cell One run's record.
 * @returns {{id: string, pass: boolean, reasons: string[]}} The verdict.
 */
export function decideRunVerdict(cell) {
  const reasons = [];
  const webgpu = cell.legs?.webgpu;
  const webgl = cell.legs?.webgl;
  if (webgpu) {
    const shipped = webgpu.shippedOccurrences;
    if (!shipped) {
      reasons.push(
        "webgpu: leg record carries no shipped-phase occurrence count",
      );
    } else if (shipped.total > 0) {
      reasons.push(
        `webgpu: ${shipped.total} validation occurrence(s) in the shipped phases, ` +
          `${shipped.destroyedTexture} of them GlobeDepth-DepthCopy destroyed-texture`,
      );
    }
    if (webgpu.deviceLost) {
      reasons.push(`webgpu: device lost — ${webgpu.deviceLost}`);
    }
    if (webgpu.distinctCoarseColors < MIN_DISTINCT_COARSE_COLORS) {
      reasons.push(
        `webgpu: capture has ${webgpu.distinctCoarseColors} distinct coarse colours — nothing drew`,
      );
    }
  }
  if (webgl) {
    const control = webgl.shippedOccurrences;
    if (!control) {
      reasons.push(
        "webgl control: leg record carries no shipped-phase occurrence count",
      );
    } else if (control.total > 0) {
      reasons.push(
        `webgl control: ${control.total} validation occurrence(s) in the shipped phases — ` +
          `a WebGL context cannot produce this family, so the instrument is wrong`,
      );
    }
  }
  if (webgpu && webgl) {
    if (webgpu.diff?.comparable !== true) {
      reasons.push(
        `capture not comparable with webgl: ${webgpu.diff?.reason ?? "no diff"}`,
      );
    } else if (webgpu.diff.mismatchPct > MAX_MISMATCH_PCT) {
      reasons.push(
        `capture differs from webgl by ${webgpu.diff.mismatchPct.toFixed(2)} % ` +
          `(max ${MAX_MISMATCH_PCT} %)`,
      );
    }
  }
  return { id: `run-${cell.run}`, pass: reasons.length === 0, reasons };
}

/**
 * The number the seat needs: how often the fault fired across the loop.
 *
 * `hitRate` is runs-with-at-least-one-occurrence over runs, counting every
 * phase — the measurement. `shippedHitRate` counts only the phases that
 * reproduce the shipped configuration — the number `AR-890`'s exit code
 * reads. `runsWithStressorHit` is the difference, and it belongs to
 * `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`, not to `AR-887`.
 *
 * `occurrences` is the un-deduplicated sum, which can exceed `runsWithHit`
 * when a run fires more than once — the distinction the row asks this probe to
 * preserve.
 *
 * @param {Array<object>} cells One record per run.
 * @returns {{runs: number, runsWithHit: number, hitRate: number, runsWithShippedHit: number, shippedHitRate: number, runsWithStressorHit: number, occurrences: number, destroyedTextureOccurrences: number, shippedOccurrences: number, shippedDestroyedTextureOccurrences: number, stressorOccurrences: number, perRun: Array<object>}} The aggregate.
 */
export function aggregateHitRate(cells) {
  const perRun = [];
  let runsWithHit = 0;
  let runsWithShippedHit = 0;
  let runsWithStressorHit = 0;
  let occurrences = 0;
  let destroyedTextureOccurrences = 0;
  let shippedOccurrences = 0;
  let shippedDestroyedTextureOccurrences = 0;
  let stressorOccurrences = 0;
  for (const cell of cells ?? []) {
    const webgpu = cell.legs?.webgpu;
    const total = webgpu?.occurrences?.total ?? 0;
    const destroyed = webgpu?.occurrences?.destroyedTexture ?? 0;
    const shippedTotal = webgpu?.shippedOccurrences?.total ?? 0;
    const shippedDestroyed = webgpu?.shippedOccurrences?.destroyedTexture ?? 0;
    const stressorTotal = webgpu?.stressorOccurrences?.total ?? 0;
    if (total > 0) {
      runsWithHit += 1;
    }
    if (shippedTotal > 0) {
      runsWithShippedHit += 1;
    }
    if (stressorTotal > 0) {
      runsWithStressorHit += 1;
    }
    occurrences += total;
    destroyedTextureOccurrences += destroyed;
    shippedOccurrences += shippedTotal;
    shippedDestroyedTextureOccurrences += shippedDestroyed;
    stressorOccurrences += stressorTotal;
    perRun.push({
      run: cell.run,
      occurrences: total,
      destroyedTexture: destroyed,
      shipped: shippedTotal,
      stressor: stressorTotal,
      pass: cell.verdict?.pass === true,
    });
  }
  const runs = perRun.length;
  return {
    runs,
    runsWithHit,
    hitRate: runs === 0 ? 0 : runsWithHit / runs,
    runsWithShippedHit,
    shippedHitRate: runs === 0 ? 0 : runsWithShippedHit / runs,
    runsWithStressorHit,
    occurrences,
    destroyedTextureOccurrences,
    shippedOccurrences,
    shippedDestroyedTextureOccurrences,
    stressorOccurrences,
    perRun,
  };
}

/**
 * The loop's own verdict, so a fix is accepted against the whole loop rather
 * than against one lucky frame.
 *
 * It gates on the SHIPPED-phase hit rate. A run that fired only under this
 * probe's own resize stressor is reported through `attribution`, which does
 * not fail the loop — that condition is stated by
 * `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`
 * (`QUEUE_2026-07-15_CAMPAIGN9.md:124`, P0, NOT STARTED), and making
 * `AR-890` gate on it would put `AR-887`'s exit behind another row's fix.
 *
 * @param {Array<object>} cells One record per run.
 * @returns {{id: string, pass: boolean, reasons: string[], aggregate: object, attribution: (string|null)}} The verdict.
 */
export function decideAggregateVerdict(cells) {
  const aggregate = aggregateHitRate(cells);
  const reasons = [];
  if (aggregate.runs === 0) {
    reasons.push("no run produced a WebGPU leg");
  }
  if (aggregate.runsWithShippedHit > 0) {
    reasons.push(
      `shipped-configuration hit rate ${aggregate.runsWithShippedHit}/${aggregate.runs} ` +
        `(${aggregate.shippedOccurrences} occurrence(s), ` +
        `${aggregate.shippedDestroyedTextureOccurrences} GlobeDepth-DepthCopy)`,
    );
  }
  const attribution =
    aggregate.runsWithStressorHit > 0
      ? `${aggregate.runsWithStressorHit}/${aggregate.runs} run(s) also fired under this probe's ` +
        `own resize stressor (${aggregate.stressorOccurrences} occurrence(s)). That condition is ` +
        `owned by NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION ` +
        `(QUEUE_2026-07-15_CAMPAIGN9.md:124, P0, NOT STARTED), not by AR-887, and it does not ` +
        `gate this verdict.`
      : null;
  return {
    id: "aggregate-hit-rate",
    pass: reasons.length === 0,
    reasons,
    aggregate,
    attribution,
  };
}

/**
 * Build the transcribed demo scene in the page and start the real render loop.
 *
 * @param {import("playwright").Page} page The page.
 * @param {string} renderer Backend name.
 * @returns {Promise<{ok: boolean, error: (string|null)}>} Build outcome.
 */
async function buildScene(page, renderer) {
  return await page.evaluate(
    async ({ renderer: backend, clockIso }) => {
      const w = /** @type {any} */ (window);
      // `Apps/CesiumViewer/index.html` loads `CesiumViewer.js` with
      // `type="module"`, and module scope is not global scope: the page
      // publishes `window.viewer`, `window.switchRenderer` and
      // `window.CesiumDebug` but NEVER `window.Cesium`. So import the URL the
      // app itself imports — `CesiumViewer.js` resolves
      // `../../Build/CesiumUnminified/index.js` against `/Apps/CesiumViewer/`
      // to exactly this absolute path, and the module map is keyed by URL, so
      // this hands back the SAME instance the running viewer was built from.
      // A second copy would supply a second `JulianDate` and the clock write
      // below would cross an identity boundary. Harness pages that DO publish
      // `window.Cesium` (split-screen, Sandcastle) are honoured first so this
      // probe can be pointed at one without a change.
      let C;
      try {
        C = w.Cesium ?? (await import("/Build/CesiumUnminified/index.js"));
      } catch (error) {
        return {
          ok: false,
          error: `/Build/CesiumUnminified/index.js did not import: ${String(
            error?.message ?? error,
          )}`,
        };
      }
      if (!C?.Viewer) {
        return {
          ok: false,
          error:
            "no Cesium namespace: window.Cesium is unset and /Build/CesiumUnminified/index.js exported no Viewer",
        };
      }
      if (w.viewer && !w.viewer.isDestroyed()) {
        w.viewer.destroy();
      }
      let container = document.getElementById("cesiumContainer");
      if (!container) {
        container = document.createElement("div");
        container.id = "cesiumContainer";
        document.body.appendChild(container);
      }
      container.innerHTML = "";
      Object.assign(container.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
      });

      let viewer;
      try {
        viewer = await C.Viewer.createAsync("cesiumContainer", {
          contextOptions: { renderer: backend },
          // The repository's own tiles: identical bytes on both backends, no
          // network. See the module header's deviation note.
          baseLayer: C.ImageryLayer.fromProviderAsync(
            C.TileMapServiceImageryProvider.fromUrl(
              C.buildModuleUrl("Assets/Textures/NaturalEarthII"),
            ),
          ),
          baseLayerPicker: false,
          geocoder: false,
          timeline: false,
          animation: false,
          fullscreenButton: false,
          navigationHelpButton: false,
          homeButton: false,
          sceneModePicker: false,
          infoBox: false,
          selectionIndicator: false,
          shouldAnimate: false,
        });
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      w.viewer = viewer;
      // Arm the gate on THIS device before the render loop draws a frame. The
      // engine's own reporter for the fault is a one-shot error scope opened on
      // the first globe pass, so anything after it is only visible through
      // `onuncapturederror`; arming from Node after this evaluate returns would
      // leave the first frames uncovered by the persistent half of the
      // instrument.
      const device = viewer.scene?.context?._device;
      if (device && typeof w.__armWebGPUDevice === "function") {
        w.__armWebGPUDevice(device, backend);
      }
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.fromIso8601(clockIso);

      const scene = viewer.scene;
      // `packages/sandcastle/gallery/display-conditions-dev/main.js`, the
      // `addBillboardAndPrimitive` entry, transcribed. It is the demo's
      // `defaultAction` and therefore what a bare page load runs.
      const billboards = scene.primitives.add(new C.BillboardCollection());
      billboards.add({
        image: "/packages/sandcastle/public/images/facility.gif",
        position: C.Cartesian3.fromDegrees(-77, 40.5),
        distanceDisplayCondition: new C.DistanceDisplayCondition(5.5e6),
      });
      scene.primitives.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.RectangleGeometry({
              rectangle: C.Rectangle.fromDegrees(-80.5, 39.7, -75.1, 42.0),
              vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: C.ColorGeometryInstanceAttribute.fromColor(
                new C.Color(1.0, 0.0, 0.0, 0.5),
              ),
              distanceDisplayCondition:
                new C.DistanceDisplayConditionGeometryInstanceAttribute(
                  0.0,
                  5.5e6,
                ),
            },
          }),
          appearance: new C.PerInstanceColorAppearance({ closed: true }),
        }),
      );
      return { ok: true, error: null };
    },
    { renderer, clockIso: CLOCK_ISO },
  );
}

/**
 * Stop the render loop, pin the clock and render a fixed number of frames, so
 * the capture compared across backends is deterministic.
 *
 * @param {import("playwright").Page} page The page.
 * @returns {Promise<void>} Resolves when the frames are drawn.
 */
async function freezeAndRender(page) {
  await page.evaluate(async (frames) => {
    const w = /** @type {any} */ (window);
    const viewer = w.viewer;
    viewer.useDefaultRenderLoop = false;
    // One animation frame so the loop's in-flight callback retires before the
    // hand-driven frames begin; otherwise the two render paths interleave and
    // the "fixed number of frames" is not fixed.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    for (let i = 0; i < frames; i++) {
      viewer.render();
    }
  }, CAPTURE_FRAMES);
}

/**
 * Run one (run, renderer) leg through the three phases and read it back.
 *
 * @param {object} options Leg inputs.
 * @param {object} options.browser Playwright browser.
 * @param {string} options.origin Served origin.
 * @param {number} options.run Zero-based run index.
 * @param {string} options.renderer Backend name.
 * @param {string} options.outputDirectory Where captures are written.
 * @param {Array<object>} options.captures Runtime capture sink.
 * @returns {Promise<object>} The leg's evidence.
 */
async function runLeg({
  browser,
  origin,
  run,
  renderer,
  outputDirectory,
  captures,
}) {
  const page = await browser.newPage({ viewport: { ...VIEWPORT } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  try {
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    // On `Apps/CesiumViewer` only the second disjunct can ever become true (the
    // page defines no `window.Cesium`), so this waits for the app's own viewer
    // — which is also the point at which `/Build/CesiumUnminified/index.js` is
    // in the module map for `buildScene` to re-import. The first disjunct keeps
    // the probe pointable at a harness page that does publish the namespace.
    await page.waitForFunction(() => !!window.Cesium || !!window.viewer, {
      timeout: 90000,
    });

    const built = await buildScene(page, renderer);
    if (!built.ok) {
      throw new ProbeRefusal(
        "scene-build-failed",
        `display-conditions-dev failed to build on ${renderer}: ${built.error}`,
        { renderer, run, error: built.error },
      );
    }
    await armWebGPUDevices(page);

    // Phase boundaries are recorded as cursors into the two collectors. Both
    // are append-only and neither de-duplicates, so a phase's occurrences are
    // the slice between its cursors. The console array is filled from Node as
    // messages arrive, so its boundary is approximate to within one message —
    // which is why the per-phase split is reported as attribution and the
    // per-run total is what the verdict reads.
    const phases = [];
    let consoleCursor = consoleErrors.length;
    let gateCursor = 0;

    const endPhase = async (name, detail) => {
      const gate = await collectGateErrors(page);
      const messages = [
        ...consoleErrors.slice(consoleCursor),
        ...gate.errors.slice(gateCursor),
      ];
      consoleCursor = consoleErrors.length;
      gateCursor = gate.errors.length;
      phases.push({
        phase: name,
        ...detail,
        occurrences: countFaultOccurrences(messages),
      });
      return gate;
    };

    await page.waitForTimeout(STEADY_MS);
    await endPhase("steady", { settleMs: STEADY_MS });

    for (const step of RESIZE_STEPS) {
      await page.setViewportSize({ ...step });
      await page.waitForTimeout(RESIZE_STEP_MS);
      await endPhase("resize", { viewport: { ...step } });
    }

    await freezeAndRender(page);
    const gate = await endPhase("capture", { frames: CAPTURE_FRAMES });

    const capture = await captureElement({
      page,
      selector: "#cesiumContainer canvas",
      index: 0,
      name: `run${String(run).padStart(2, "0")}-${renderer}`,
      outputDirectory,
      captures,
    });
    const image = decodePng(capture.buffer);
    const stats = frameStats(image);
    const split = partitionOccurrences(phases);
    return {
      renderer,
      capture: capture.path,
      sha256: capture.sha256,
      image,
      phases,
      occurrences: split.all,
      shippedOccurrences: split.shipped,
      stressorOccurrences: split.stressor,
      deviceLost: gate.deviceLost,
      armedDevices: gate.armedDevices,
      nonBlackPct: stats.nonBlackPct,
      meanLuminance: stats.meanLuminance,
      distinctCoarseColors: stats.distinctCoarseColors,
    };
  } finally {
    await page.close();
  }
}

const descriptor = {
  name: "display-conditions-globedepth",
  title:
    "display-conditions-dev GlobeDepth-DepthCopy lifetime (AR-890 / AR-887)",
  outputSubdirectory: "display-conditions-globedepth",
  args: { defaults: { runs: DEFAULT_RUNS } },
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const work = (async () => {
      const legs = {};
      for (const renderer of options.renderers) {
        legs[renderer] = await runLeg({
          browser,
          origin,
          run,
          renderer,
          outputDirectory,
          captures,
        });
      }
      if (legs.webgpu && legs.webgl) {
        legs.webgpu.diff = diffPixels(
          legs.webgl.image,
          legs.webgpu.image,
          DIFF_TOLERANCE,
        );
      }
      // The decoded pixel buffers are working data, not receipt data.
      for (const leg of Object.values(legs)) {
        delete leg.image;
      }
      const cell = { run, legs };
      cell.verdict = decideRunVerdict(cell);
      return [cell];
    })();
    work.catch(() => {});
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-display-conditions-globedepth run ${run} exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              { budgetMs: WATCHDOG_BUDGET_MS, run },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
    }
  },
  receipt(cells, context) {
    const loop = decideAggregateVerdict(cells);
    return {
      base: context.origin,
      demo: "display-conditions-dev",
      gates: {
        maxMismatchPct: MAX_MISMATCH_PCT,
        diffTolerance: DIFF_TOLERANCE,
        minDistinctCoarseColors: MIN_DISTINCT_COARSE_COLORS,
      },
      deviations: [
        "scene transcribed from packages/sandcastle/gallery/display-conditions-dev/main.js onto the served CesiumViewer origin (Sandcastle2 needs a second bucket origin)",
        "base imagery is Assets/Textures/NaturalEarthII, not the default ion layer, so both backends sample identical bytes with no network",
      ],
      aggregate: loop.aggregate,
      attribution: loop.attribution,
      confidence: {
        runs: cells.length,
        detects95pct:
          cells.length === 0
            ? null
            : 1 - Math.pow(0.05, 1 / Math.max(cells.length, 1)),
        note: "a clean loop bounds the per-run rate below detects95pct at 95 % confidence; it does not exclude a rarer fault",
      },
      runs: cells,
    };
  },
  verdicts(cells) {
    return [
      ...cells.map((cell) => cell.verdict),
      decideAggregateVerdict(cells),
    ];
  },
  summary(receipt) {
    const aggregate = receipt.aggregate;
    const lines = [
      "# display-conditions-dev GlobeDepth-DepthCopy lifetime (AR-890 / AR-887)",
      "",
      `Hit rate (all phases): **${aggregate.runsWithHit}/${aggregate.runs}** ` +
        `(${(aggregate.hitRate * 100).toFixed(1)} %), ` +
        `${aggregate.occurrences} occurrence(s), ` +
        `${aggregate.destroyedTextureOccurrences} GlobeDepth-DepthCopy destroyed-texture.`,
      "",
      "Shipped-configuration hit rate (**this is what AR-890's exit code reads**): " +
        `**${aggregate.runsWithShippedHit}/${aggregate.runs}** ` +
        `(${(aggregate.shippedHitRate * 100).toFixed(1)} %), ` +
        `${aggregate.shippedOccurrences} occurrence(s), ` +
        `${aggregate.shippedDestroyedTextureOccurrences} GlobeDepth-DepthCopy destroyed-texture.`,
      "",
      "Resize-stressor hit rate (attribution only, does NOT gate): " +
        `${aggregate.runsWithStressorHit}/${aggregate.runs} ` +
        `(${aggregate.stressorOccurrences} occurrence(s)). A hit that appears ONLY in this ` +
        "column belongs to NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION " +
        "(QUEUE_2026-07-15_CAMPAIGN9.md:124, P0, NOT STARTED), which already states this fault " +
        '"under resize" — not to AR-887.',
      "",
      "| run | shipped (steady+capture) | resize (attribution) | all phases | of which destroyed-texture | webgl control | mismatch % vs webgl | pass |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const cell of receipt.runs) {
      const webgpu = cell.legs?.webgpu ?? {};
      const webgl = cell.legs?.webgl ?? {};
      lines.push(
        `| ${cell.run} | ${webgpu.shippedOccurrences?.total ?? "-"} | ` +
          `${webgpu.stressorOccurrences?.total ?? "-"} | ` +
          `${webgpu.occurrences?.total ?? "-"} | ` +
          `${webgpu.occurrences?.destroyedTexture ?? "-"} | ` +
          `${webgl.shippedOccurrences?.total ?? "-"} | ` +
          `${webgpu.diff?.mismatchPct?.toFixed(2) ?? "-"} | ` +
          `${cell.verdict?.pass ? "PASS" : "FAIL"} |`,
      );
    }
    lines.push("");
    if (receipt.attribution) {
      lines.push(`> ATTRIBUTION: ${receipt.attribution}`);
      lines.push("");
    }
    for (const cell of receipt.runs) {
      if (cell.verdict && !cell.verdict.pass) {
        lines.push(`- run ${cell.run}: ${cell.verdict.reasons.join("; ")}`);
      }
    }
    lines.push("");
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
