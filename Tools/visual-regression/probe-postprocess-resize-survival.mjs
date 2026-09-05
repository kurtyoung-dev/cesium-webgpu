#!/usr/bin/env node
/**
 * Probe: AR-M06 — post-process effect survival across a resize and an HDR toggle.
 * @purpose AR-M06 acceptance for AR-009: with Bloom, AO and DoF enabled, captures either side of a viewer.resize() and either side of a highDynamicRange toggle must match, and the effect slots must still be live afterwards.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
 *
 * `WebGPUPostProcessPipeline.initialize()` destroys and nulls all eleven
 * built-in effect slots on every real recreate — a size change or an HDR
 * toggle. That is correct: each effect owns intermediates sized AND formatted
 * against `_intermediateFormat`. The other half of the protocol is that
 * `configureWebGPUPostProcessPipeline` re-adds each one on the next frame, and
 * for seven of the eleven that half was gated on a sticky `cache.*Initialized`
 * latch which fires once and never again. Bloom, AO, DoF, GodRay, HeatShimmer,
 * ColdOptics and AerialPerspective were therefore destroyed by the first resize
 * and unrevivable for the life of the viewer.
 *
 * The user-visible consequence is that resizing the window silently turns the
 * enabled effects off and nothing turns them back on.
 *
 * ── THE TWO LEGS, AND WHY THE CAPTURES ARE COMPARABLE ───────────────────────
 *
 * A capture taken at one size cannot be pixel-diffed against one taken at
 * another. Both legs therefore return to the ORIGINAL state before the second
 * capture, so the diff is over identical dimensions and the only thing that
 * differs between them is whether the effects survived the round trip:
 *
 *   resize leg : capture at A -> resize to B -> resize back to A -> capture.
 *   hdr leg    : capture with HDR on -> toggle off -> toggle on -> capture.
 *
 * The HDR leg is not redundant with the resize leg: it is the path that
 * changes `_intermediateFormat`, which a same-size resize never does.
 *
 * The size change is driven by resizing the viewer's CONTAINER and calling
 * `viewer.resize()`, not by moving the browser viewport. That is what an
 * application does, it keeps the whole leg inside one page task, and it means
 * the canonical same-task capture block below is embedded exactly once.
 *
 * ── MULTI-METRIC, PER THE MAINTAINER RULE ───────────────────────────────────
 *
 * A mismatch percentage alone cannot distinguish "the effects came back" from
 * "the effects were never on". Three families are reported together:
 *
 *   mismatchPercent  — the acceptance statistic, < 0.5 % per the row.
 *                      NOISE: a live globe is not frame-deterministic; terrain
 *                      streaming moves this by a few tenths of a percent
 *                      between runs. The clock is pinned and the scene settled
 *                      before every capture to hold it down, but treat anything
 *                      under ~0.2 % as indistinguishable from zero rather than
 *                      as signal. A BROKEN run is not marginal — with bloom and
 *                      AO gone the figure is whole percent.
 *   slots.*          — `pipeline.bloomEffect` and its ten siblings, read after
 *                      each step. NOISE: none. These are boolean reads of live
 *                      object slots, deterministic for a given code path; a
 *                      changed reading between runs of one build is a finding,
 *                      not scatter.
 *   pipelineBuilds   — `createRenderPipeline` / `createShaderModule` calls the
 *                      device saw across ONE resize, counted by a wrapper
 *                      installed before Cesium loads. This is the LIGHT-6 cost
 *                      figure. NOISE: deterministic for a fixed enable set and
 *                      independent of machine load. It DOES move with which
 *                      effects are enabled and with `useShaderF16`, so it is
 *                      only comparable across runs with the same enable set.
 *
 * The slot readings are what make the mismatch figure interpretable. A run
 * reporting 0 % with every slot null would mean the effects rendered in NEITHER
 * capture — passing the diff for a reason unrelated to the fix — so the verdict
 * requires a sub-tolerance diff AND live slots AND a non-black capture.
 *
 * ── WHAT THE SHARED RUNTIME OWNS ────────────────────────────────────────────
 *
 * Argument parsing, the single-Edge-slot lock, the Edge launch, the
 * served-build preflight, receipt serialization and the exit-code table live in
 * `lib/probe-runtime.mjs`. What is here is this probe's own: the enable set,
 * the two legs, the diff math and the verdicts. The pixel reads go through the
 * canonical same-task capture block from `lib/same-task-capture.mjs`, embedded
 * verbatim — a deferred read of a WebGPU swap-chain texture is invalid, and
 * that block is the fleet's one sanctioned reader.
 *
 * ── PRECONDITIONS ───────────────────────────────────────────────────────────
 *
 *   * `npx gulp build` has run, so `/Build/CesiumUnminified/` is current.
 *   * `node server.js --port 8094 --serve-built` is running. Use `localhost`,
 *     not `127.0.0.1` — the dev server binds IPv6. Without `--serve-built` the
 *     default server serves a live esbuild of the SOURCE tree and the run
 *     cannot say which engine it measured.
 *   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
 *   * The target page, `Apps/CesiumViewer/index.html`, loads its app as an ES
 *     module and so publishes `window.viewer` but NO `window.Cesium`. The
 *     enable step below imports the namespace from the same module URL the app
 *     itself imports; see the comment there for why the identity matters.
 *
 * Run:
 *   node Tools/visual-regression/probe-postprocess-resize-survival.mjs
 *   node Tools/visual-regression/probe-postprocess-resize-survival.mjs --headed
 *   node Tools/visual-regression/probe-postprocess-resize-survival.mjs --mismatch-tolerance-pct 0.5
 */

import fs from "node:fs";
import path from "node:path";

import {
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const VIEWPORT = { width: 1024, height: 768 };
// The container size the viewer is driven to and back from. Different enough
// from the starting extent that `resize()` cannot early-return unchanged.
const RESIZED = { width: 720, height: 520 };
const WATCHDOG_BUDGET_MS = 300000;

/**
 * Installed before Cesium loads. Counts the pipeline and shader-module
 * creations the device is asked for, which is the compile cost a resize pays
 * and the figure the LIGHT-6 decision is weighed on.
 */
const COUNTER_INIT = `(() => {
  window.__ar009Counts = {
    renderPipelines: 0,
    shaderModules: 0,
    computePipelines: 0,
    instrumented: false,
  };
  // A page without WebGPU leaves every counter at its initial zero, and a zero
  // is indistinguishable from "this resize compiled nothing" — which is the
  // reading the LIGHT-6 decision turns on. Record whether the wrapper was
  // really installed, so the caller can refuse rather than report a fabricated
  // zero as a measurement.
  if (typeof GPUDevice === "undefined") return;
  window.__ar009Counts.instrumented = true;
  if (GPUDevice.__ar009Patched) return;
  GPUDevice.__ar009Patched = true;
  const proto = GPUDevice.prototype;
  const pairs = [
    ["createRenderPipeline", "renderPipelines"],
    ["createShaderModule", "shaderModules"],
    ["createComputePipeline", "computePipelines"],
  ];
  for (const [method, key] of pairs) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function (...args) {
      window.__ar009Counts[key]++;
      return original.apply(this, args);
    };
  }
})();`;

/**
 * Runs both legs inside one page task and returns every metric. Kept as a
 * single `page.evaluate` so the canonical capture block is embedded once and
 * so no leg is split across a Node round trip that could let the swap chain be
 * presented between a render and its read.
 *
 * @param {object} page The Playwright page.
 * @param {object} sizes The two container extents.
 * @returns {Promise<object>} Both legs' readings.
 */
async function runLegs(page, sizes) {
  return page.evaluate(async ({ resized }) => {
    // ==BEGIN same-task-capture==
    const makeSameTaskCapture = (scene, canvas, timeFn) => {
      const renderNow = () => scene.render(timeFn());
      const tmp = document.createElement("canvas");
      const ctx = tmp.getContext("2d", { willReadFrequently: true });
      const decodeSnapshot = async (snapshot) => {
        const image = new Image();
        const loaded = new Promise((resolve, reject) => {
          const decodeFailed = "same-task PNG decode failed";
          image.onload = resolve;
          image.onerror = () => reject(new Error(decodeFailed));
        });
        image.src = snapshot;
        await loaded;
        tmp.width = image.naturalWidth;
        tmp.height = image.naturalHeight;
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, tmp.width, tmp.height);
      };
      const snapshotNow = () => {
        renderNow();
        return canvas.toDataURL("image/png");
      };
      const captureNow = () => {
        const snapshot = snapshotNow();
        return decodeSnapshot(snapshot);
      };
      const grabNow = snapshotNow;
      const settleThen = async (maxFrames, done, capture) => {
        let settled = false;
        for (let k = 0; k < maxFrames; k++) {
          if (typeof done === "function" && done() === true) {
            settled = true;
            break;
          }
          renderNow();
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (!settled && typeof done === "function") {
          settled = done() === true;
        }
        const hasCapture = typeof capture === "function";
        const result = hasCapture ? await capture() : undefined;
        return { settled, result };
      };
      return { renderNow, captureNow, grabNow, settleThen };
    };
    // ==END same-task-capture==

    const viewer = window.viewer;
    const scene = viewer.scene;
    const timeFn = () => viewer.clock.currentTime;
    const { captureNow, grabNow, settleThen } = makeSameTaskCapture(
      scene,
      scene.canvas,
      timeFn,
    );

    const container = viewer.container;
    const startWidth = container.clientWidth;
    const startHeight = container.clientHeight;
    const setSize = (width, height) => {
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
      viewer.resize();
    };

    // `Scene` stores the backend renderer built from the SCENE_RENDERER
    // feature renderer on `_alternateSceneRenderer` (Scene.js:468), and the
    // WebGPU one owns the post-process pipeline
    // (WebGPUSceneRendererEnsureResources.ts:458). That is the accessor the
    // rest of the fleet reads it through — diag-taa-black.mjs:70,
    // diag-stars-hdr-autoexposure.mjs:74, canvas-black-readback.mjs:56.
    // `scene.context` holds no scene renderer of its own.
    const pipelineNow = () =>
      scene._alternateSceneRenderer?._postProcess ?? null;
    const slotsNow = () => {
      const pipeline = pipelineNow();
      const slot = (name) => Boolean(pipeline?.[name]);
      return {
        present: Boolean(pipeline),
        bloom: slot("bloomEffect"),
        ambientOcclusion: slot("ambientOcclusionEffect"),
        depthOfField: slot("depthOfFieldEffect"),
        godRay: slot("godRayEffect"),
        heatShimmer: slot("heatShimmerEffect"),
        coldOptics: slot("coldOpticsEffect"),
        aerialPerspective: slot("aerialPerspectiveEffect"),
        taa: slot("taaEffect"),
        motionBlur: slot("motionBlurEffect"),
        sunHalo: slot("sunHaloEffect"),
        sunBloom: slot("sunBloomEffect"),
      };
    };

    // Two pixels count as equal below this per-channel delta: dithering and
    // tonemap rounding move the low bits without changing the image.
    const CHANNEL_TOLERANCE = 8;
    const compare = (before, after) => {
      if (before.width !== after.width || before.height !== after.height) {
        return { sizeMismatch: true };
      }
      const a = before.data;
      const b = after.data;
      const total = before.width * before.height;
      let mismatched = 0;
      let black = 0;
      for (let i = 0; i < total; i++) {
        const o = i * 4;
        const dr = Math.abs(a[o] - b[o]);
        const dg = Math.abs(a[o + 1] - b[o + 1]);
        const db = Math.abs(a[o + 2] - b[o + 2]);
        if (
          dr > CHANNEL_TOLERANCE ||
          dg > CHANNEL_TOLERANCE ||
          db > CHANNEL_TOLERANCE
        ) {
          mismatched++;
        }
        if (b[o] < 8 && b[o + 1] < 8 && b[o + 2] < 8) {
          black++;
        }
      }
      return {
        sizeMismatch: false,
        total,
        mismatched,
        mismatchPercent: (mismatched / total) * 100,
        blackFraction: black / total,
      };
    };

    // ── instrument checks, after one settled frame ──────────────────────────
    // The pipeline is built during `ensureResources`, i.e. on the first render,
    // so these run after the settle rather than before it.
    //
    // Both THROW rather than reporting a status. A reading this probe cannot
    // take means the run measured nothing, and an errored run is the honest
    // outcome: a status object here would invite a later `if (ok)` that skips
    // the check and still writes a receipt claiming the effects were lost.
    await settleThen(40, null);
    if (!pipelineNow()) {
      throw new Error(
        "probe-postprocess-resize-survival: scene._alternateSceneRenderer._postProcess " +
          "is not reachable after the first settle, so every effect-slot reading would " +
          "be a false `false` and both legs would report a loss the engine did not cause",
      );
    }
    if (window.__ar009Counts?.instrumented !== true) {
      throw new Error(
        "probe-postprocess-resize-survival: the GPUDevice creation counters were never " +
          "installed, so the per-resize compile count would be a fabricated zero rather " +
          "than the LIGHT-6 measurement",
      );
    }

    // ── resize leg ──────────────────────────────────────────────────────────
    const resizeBefore = await captureNow();
    const resizeBeforePng = grabNow();
    const resizeSlotsBefore = slotsNow();
    const countsBefore = { ...window.__ar009Counts };

    setSize(resized.width, resized.height);
    await settleThen(25, null);
    const resizeSlotsAtResized = slotsNow();
    const countsAfterResize = { ...window.__ar009Counts };

    setSize(startWidth, startHeight);
    await settleThen(40, null);
    const resizeAfter = await captureNow();
    const resizeAfterPng = grabNow();
    const resizeSlotsAfter = slotsNow();

    // ── hdr leg ─────────────────────────────────────────────────────────────
    await settleThen(30, null);
    const hdrBefore = await captureNow();
    const hdrBeforePng = grabNow();
    const hdrSlotsBefore = slotsNow();

    scene.highDynamicRange = false;
    await settleThen(25, null);
    const hdrSlotsAtToggled = slotsNow();

    scene.highDynamicRange = true;
    await settleThen(30, null);
    const hdrAfter = await captureNow();
    const hdrAfterPng = grabNow();
    const hdrSlotsAfter = slotsNow();

    return {
      resize: {
        leg: "resize",
        comparison: compare(resizeBefore, resizeAfter),
        slotsBefore: resizeSlotsBefore,
        slotsAtResized: resizeSlotsAtResized,
        slotsAfter: resizeSlotsAfter,
        // The LIGHT-6 figure: what ONE resize costs in device builds.
        pipelineBuilds:
          countsAfterResize.renderPipelines - countsBefore.renderPipelines,
        shaderBuilds:
          countsAfterResize.shaderModules - countsBefore.shaderModules,
        computeBuilds:
          countsAfterResize.computePipelines - countsBefore.computePipelines,
        png: { before: resizeBeforePng, after: resizeAfterPng },
      },
      hdr: {
        leg: "hdr",
        comparison: compare(hdrBefore, hdrAfter),
        slotsBefore: hdrSlotsBefore,
        slotsAtToggled: hdrSlotsAtToggled,
        slotsAfter: hdrSlotsAfter,
        png: { before: hdrBeforePng, after: hdrAfterPng },
      },
    };
  }, sizes);
}

/**
 * The namespace members the enable step needs in the page. Passed into the
 * evaluate so a namespace that resolves without one of them is refused by name,
 * rather than surfacing as a TypeError from whichever line happened to use it
 * first.
 */
const REQUIRED_NAMESPACE_MEMBERS = [
  "Cartesian3",
  "JulianDate",
  "Math",
  "PostProcessStageLibrary",
];

/**
 * Enables Bloom, ambient occlusion and depth of field the way a user does, and
 * pins the clock and camera so the only difference between the two captures of
 * a leg is the recreate under test. Depth of field has no dedicated collection
 * slot upstream, so it is added as the named composite the bridge looks for.
 *
 * @param {object} page The Playwright page.
 * @returns {Promise<object>} The enable readback.
 */
async function enableEffects(page) {
  return page.evaluate(async (required) => {
    // `Apps/CesiumViewer/index.html` loads `CesiumViewer.js` with
    // `type="module"`, and module scope is not global scope: the page defines
    // `window.viewer` and `window.CesiumDebug` but never `window.Cesium`, so a
    // bare `Cesium` reference here is a ReferenceError.
    //
    // Import the same URL the app imports — `CesiumViewer.js` resolves
    // `../../Build/CesiumUnminified/index.js` against `/Apps/CesiumViewer/` to
    // exactly this absolute path. The module map is keyed by URL, so this hands
    // back the SAME module instance the running viewer was built from, and the
    // classes below are identity-equal to the ones already in the scene. A
    // second copy would supply a second `JulianDate`, and the clock and camera
    // writes would then cross an identity boundary. Harness pages that DO
    // publish `window.Cesium` (the split-screen and Sandcastle pages) are
    // honoured first, so this probe can be pointed at one without a change.
    const fromGlobal = window.Cesium !== undefined;
    const C = fromGlobal
      ? window.Cesium
      : await import("/Build/CesiumUnminified/index.js");
    const missing = required.filter((name) => C?.[name] === undefined);
    if (missing.length > 0) {
      // Thrown, not reported. A namespace this probe cannot drive means the run
      // enables nothing and measures nothing; an errored run is the honest
      // outcome. Returning a status object would invite a later `if (ok)` that
      // skips the enable and still writes a receipt.
      throw new Error(
        `probe-postprocess-resize-survival: the Cesium namespace resolved from ` +
          `${fromGlobal ? "window.Cesium" : "/Build/CesiumUnminified/index.js"} is ` +
          `missing ${missing.join(", ")}, so the enable step cannot run`,
      );
    }

    const viewer = window.viewer;
    const scene = viewer.scene;
    const stages = scene.postProcessStages;

    viewer.clock.shouldAnimate = false;
    viewer.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T15:00:00Z");
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-119.55, 37.62, 9000),
      orientation: { heading: 0, pitch: C.Math.toRadians(-25), roll: 0 },
    });

    stages.bloom.enabled = true;
    stages.ambientOcclusion.enabled = true;
    const named = (list, name) =>
      Array.isArray(list) ? list.find((s) => s && s.name === name) : undefined;
    if (!named(stages._stages, "czm_depth_of_field")) {
      const dof = C.PostProcessStageLibrary.createDepthOfFieldStage();
      dof.enabled = true;
      stages.add(dof);
    }
    scene.highDynamicRange = true;

    return {
      bloom: stages.bloom.enabled,
      ambientOcclusion: stages.ambientOcclusion.enabled,
      depthOfField: Boolean(
        named(stages._stages, "czm_depth_of_field")?.enabled,
      ),
      highDynamicRange: scene.highDynamicRange,
      namespaceSource: fromGlobal
        ? "window.Cesium"
        : "/Build/CesiumUnminified/index.js",
    };
  }, REQUIRED_NAMESPACE_MEMBERS);
}

/**
 * Writes one `data:image/png;base64,...` capture out as a file.
 *
 * @param {string} dataUrl The capture.
 * @param {string} file Absolute destination.
 */
function writeDataUrl(dataUrl, file) {
  const comma = String(dataUrl ?? "").indexOf(",");
  if (comma < 0) return;
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(comma + 1), "base64"));
}

/**
 * The three effects the row's acceptance names. The other four dropped ones are
 * reported but not gated here, because enabling them needs scene flags a
 * default viewer does not set.
 */
const GATED_SLOTS = ["bloom", "ambientOcclusion", "depthOfField"];

/**
 * Turns one leg into a verdict.
 *
 * @param {object} leg The leg result.
 * @param {number} tolerancePercent The mismatch bar.
 * @returns {object} The verdict.
 */
function decideLegVerdict(leg, tolerancePercent) {
  const comparison = leg.comparison ?? {};
  const slotsLive = GATED_SLOTS.every(
    (name) => leg.slotsAfter?.[name] === true,
  );
  const withinTolerance =
    comparison.sizeMismatch === false &&
    comparison.mismatchPercent < tolerancePercent;
  // A pair of black frames diffs to zero. The captures must have had content,
  // or the diff passed for a reason unrelated to the effects.
  const hasContent = comparison.blackFraction < 0.98;
  return {
    id: leg.leg,
    claim:
      leg.leg === "resize"
        ? "AR-M06 — Bloom, AO and DoF survive a viewer.resize() round trip"
        : "AR-M06 — Bloom, AO and DoF survive a highDynamicRange toggle",
    mismatchPercent: comparison.mismatchPercent ?? null,
    blackFraction: comparison.blackFraction ?? null,
    tolerancePercent,
    slotsAfter: leg.slotsAfter,
    slotsLive,
    hasContent,
    pass: Boolean(slotsLive && withinTolerance && hasContent),
  };
}

export const descriptor = {
  name: "ppresize",
  title: "AR-M06 — post-process survival across resize and HDR toggle",
  outputSubdirectory: "postprocess-resize-survival",
  receiptEnvelope: "probe-owned",
  // The defect and the slots it is read through are WebGPU-only: the WebGL
  // post-process path reallocates its framebuffers on resize and never nulls a
  // stage, and `_sceneRenderer._postProcess` does not exist there.
  args: {
    defaults: { renderers: ["webgpu"] },
    extraOptions: [
      {
        flag: "--mismatch-tolerance-pct",
        key: "mismatchTolerancePct",
        kind: "non-negative-number",
        default: 0.5,
      },
    ],
  },
  async cells({ browser, origin, outputDirectory, options }) {
    if (options.renderers.length !== 1 || options.renderers[0] !== "webgpu") {
      throw new ProbeRefusal(
        "renderer-not-webgpu",
        `probe-postprocess-resize-survival only measures webgpu (the effect slots it reads exist only on the WebGPU pipeline); got --renderer ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    fs.mkdirSync(outputDirectory, { recursive: true });

    let page = null;
    const work = (async () => {
      page = await browser.newPage({ viewport: VIEWPORT });
      const consoleErrors = attachConsoleErrorGate(page);
      await page.addInitScript(errorGateInit);
      await page.addInitScript({ content: COUNTER_INIT });
      await page.goto(
        `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu`,
        {
          waitUntil: "networkidle",
          timeout: 90000,
        },
      );
      await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

      const enabled = await enableEffects(page);
      if (
        !enabled.bloom ||
        !enabled.ambientOcclusion ||
        !enabled.depthOfField
      ) {
        throw new ProbeRefusal(
          "effects-not-enabled",
          "the probe could not enable Bloom, ambient occlusion and depth of field, so a survival measurement would be vacuous",
          enabled,
        );
      }

      const legs = await runLegs(page, { resized: RESIZED });
      const gateErrors = await collectGateErrors(page, consoleErrors);

      const produced = [];
      for (const key of ["resize", "hdr"]) {
        const leg = legs[key];
        writeDataUrl(
          leg.png?.before,
          path.join(outputDirectory, `${key}-before.png`),
        );
        writeDataUrl(
          leg.png?.after,
          path.join(outputDirectory, `${key}-after.png`),
        );
        // The data URLs are megabytes each and their only job was to reach
        // disk; keeping them would put them in the JSON receipt too.
        delete leg.png;
        produced.push({ ...leg, enabled, gateErrors });
      }
      return produced;
    })();
    // A watchdog loss leaves `work` running against a page the runtime is about
    // to close; that trailing rejection has no reader, so it is swallowed here
    // rather than surfacing as an unhandled rejection after this returns.
    work.catch(() => {});

    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-postprocess-resize-survival exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              { budgetMs: WATCHDOG_BUDGET_MS },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
      if (page) {
        await page.close().catch(() => {});
      }
    }
  },
  verdicts(cells, { options }) {
    return cells.map((cell) =>
      decideLegVerdict(cell, options.mismatchTolerancePct),
    );
  },
  receipt(cells, context) {
    const legs = {};
    for (const cell of cells) {
      legs[cell.leg] = cell;
    }
    return {
      base: context.origin,
      generatedAt: context.generatedAt,
      legs,
      verdicts: context.verdicts,
    };
  },
  summary(receipt) {
    const lines = [
      "# AR-M06 — post-process survival across resize and HDR toggle",
      "",
      `Base: \`${receipt.base}\``,
      "",
      "| Leg | mismatch % | bar | Bloom | AO | DoF | pass |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const verdict of receipt.verdicts) {
      const pct =
        typeof verdict.mismatchPercent === "number"
          ? verdict.mismatchPercent.toFixed(3)
          : "n/a";
      lines.push(
        `| ${verdict.id} | ${pct} | < ${verdict.tolerancePercent} | ` +
          `${verdict.slotsAfter?.bloom} | ${verdict.slotsAfter?.ambientOcclusion} | ` +
          `${verdict.slotsAfter?.depthOfField} | ${verdict.pass} |`,
      );
    }
    const resize = receipt.legs?.resize;
    if (resize) {
      lines.push(
        "",
        "Device builds across ONE resize (the LIGHT-6 cost): " +
          `${resize.pipelineBuilds} render pipelines, ${resize.shaderBuilds} shader modules, ` +
          `${resize.computeBuilds} compute pipelines.`,
      );
    }
    lines.push("");
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
