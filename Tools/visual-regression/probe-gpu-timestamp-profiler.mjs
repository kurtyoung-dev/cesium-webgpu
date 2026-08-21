// Node/Playwright integration probe for the opt-in WebGPU timestamp profiler.
// @purpose Certification lane for GPU-timestamp unique-sample accounting: drained readbacks, closed sample ledger, coverage+unprofiled ratios reconstruct 1.0
// @status ACTIVE
//
// Requires the local Cesium server on http://localhost:8080.
//
// C11-140 — this probe is the CERTIFICATION lane for GPU-timestamp unique-sample
// accounting, which every later C11 GPU-lane perf claim depends on. It asserts:
//
//   * the readback tail is DRAINED at capture end (`drainPendingReadbacks`), so
//     the final frames of a capture are reported instead of silently dropped;
//   * the sample ledger CLOSES — sampled + skipped + empty + failed + lost +
//     pending equals the attempts, with no unaccounted frame;
//   * every GPU nanosecond is attributed exactly once —
//     `coverageRatio + unprofiledRatio ≈ 1`, and `overlapMs` (the excess of the
//     naive pass sum over the union) is reported rather than clamped away.
//
// Idle capture is not a valid certification (charter: idle-soak is invalid under
// request-render mode), so the probe flies a bounded moving-altitude arc and
// certifies over several reps. The result is written as a JSON artifact other
// items can cite instead of re-deriving.
//
// Run: node Tools/visual-regression/probe-gpu-timestamp-profiler.mjs
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const VIEWER_URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true";

/** Reps of the moving arc. A single rep is not a timing certification. */
const REPETITIONS = 5;
/** Frames captured per rep. Bounded so the probe cannot spin indefinitely. */
const FRAMES_PER_REP = 60;
/** Absolute per-rep deadline, independent of the frame budget. */
const REP_TIMEOUT_MS = 20_000;
/** Ratios must reconstruct 1.0 to within this much to count as balanced. */
const RATIO_TOLERANCE = 1e-6;

const artifactPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "gpu-timestamp-accounting-certification.json",
);

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
const localOrigin = new URL(VIEWER_URL).origin;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
});
page.on("request", (request) => {
  const requestUrl = new URL(request.url());
  if (
    (requestUrl.protocol === "http:" || requestUrl.protocol === "https:") &&
    requestUrl.origin !== localOrigin
  ) {
    externalRequests.push(request.url());
  }
});

try {
  await page.goto(VIEWER_URL, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => globalThis.viewer?.scene, {
    timeout: 30000,
  });

  const result = await page.evaluate(
    async ({ repetitions, framesPerRep, repTimeoutMs }) => {
      const scene = globalThis.viewer.scene;
      const camera = scene.camera;
      const context = scene._context;
      const originalRequestRenderMode = scene.requestRenderMode;
      const featureAvailable = context.hasFeature?.("timestamp-query") === true;
      const reps = [];

      if (featureAvailable) {
        globalThis.CesiumDebug.gpuPassCost(true);
        scene.requestRenderMode = false;

        // Altitude step sized from the starting height so the arc is a real
        // altitude change on any default view. Camera-API only: the viewer page
        // exposes no `Cesium` global to construct positions with.
        const altitudeStep =
          (camera.positionCartographic.height * 0.4) / framesPerRep;

        for (let rep = 0; rep < repetitions; rep++) {
          const profiler = context.timestampProfiler;
          profiler?.reset?.();

          let frameCount = 0;
          const removeListener = scene.postRender.addEventListener(() => {
            frameCount++;
          });
          const deadline = performance.now() + repTimeoutMs;
          // Moving-altitude arc: a static camera lets the renderer skip work a
          // real capture would do, so the coverage it certifies is not the
          // coverage a perf claim would rely on.
          while (frameCount < framesPerRep && performance.now() < deadline) {
            // Descend for the first half, climb back for the second, so the rep
            // both starts and ends near the same altitude and reps compare.
            if (frameCount * 2 < framesPerRep) {
              camera.zoomIn(altitudeStep);
            } else {
              camera.zoomOut(altitudeStep);
            }
            camera.rotateRight(0.0005);
            scene.requestRender();
            await new Promise((resolveFrame) =>
              requestAnimationFrame(resolveFrame),
            );
          }
          removeListener();

          // Readback is asynchronous: the frames still in flight here are real
          // samples. Drain them (bounded) instead of dropping them.
          const drain = (await profiler?.drainPendingReadbacks?.(2000)) ?? null;
          reps.push({
            rep,
            renderedFrames: frameCount,
            drain,
            results: profiler?.getResults?.() ?? null,
          });
        }

        globalThis.CesiumDebug.gpuPassCost(false);
      }

      scene.requestRenderMode = originalRequestRenderMode;

      const lastResults = reps[reps.length - 1]?.results ?? null;
      return {
        backend: context.isWebGPU ? "webgpu" : "webgl",
        adapterInfo: context.adapterInfo ?? null,
        featureAvailable,
        reps,
        passNames: lastResults ? Object.keys(lastResults.passes) : [],
      };
    },
    {
      repetitions: REPETITIONS,
      framesPerRep: FRAMES_PER_REP,
      repTimeoutMs: REP_TIMEOUT_MS,
    },
  );

  const failures = [];
  if (result.backend !== "webgpu") {
    failures.push(`expected WebGPU, got ${result.backend}`);
  }
  if (pageErrors.length > 0) {
    failures.push(`${pageErrors.length} uncaught page error(s)`);
  }
  if (consoleErrors.length > 0) {
    failures.push(`${consoleErrors.length} console error(s)`);
  }
  if (externalRequests.length > 0) {
    failures.push(`${externalRequests.length} external request(s)`);
  }

  if (result.featureAvailable) {
    if (result.reps.length !== REPETITIONS) {
      failures.push(
        `expected ${REPETITIONS} reps, captured ${result.reps.length}`,
      );
    }
    for (const rep of result.reps) {
      const label = `rep ${rep.rep}`;
      const results = rep.results;
      if (!results?.enabled) {
        failures.push(`${label}: profiler was not enabled`);
        continue;
      }
      if ((results.frameCount ?? 0) < 1) {
        failures.push(`${label}: no timestamp frame resolved`);
      }
      if (Object.keys(results.passes ?? {}).length < 1) {
        failures.push(`${label}: no pass samples resolved`);
      }

      // No sample silently lost.
      if (!results.sampleLedgerBalanced) {
        failures.push(
          `${label}: sample ledger does not close (${results.unaccountedSampleCount} unaccounted of ${results.attemptedFrameCount} attempts)`,
        );
      }
      if ((results.pendingReadbackCount ?? 0) > 0) {
        failures.push(
          `${label}: ${results.pendingReadbackCount} readback(s) still pending after the drain`,
        );
      }
      if (rep.drain?.timedOut) {
        failures.push(
          `${label}: drain timed out with ${rep.drain.undrained} tail sample(s) undrained`,
        );
      }
      if ((results.lostSampleCount ?? 0) > 0) {
        failures.push(
          `${label}: ${results.lostSampleCount} sample(s) lost before readback`,
        );
      }

      // Every GPU nanosecond attributed exactly once.
      if (!results.coverageBalanced) {
        failures.push(`${label}: covered + unprofiled != frame span`);
      }
      const { coverageRatio, unprofiledRatio } = results;
      if (coverageRatio === null || unprofiledRatio === null) {
        failures.push(`${label}: degenerate frame span, coverage unmeasurable`);
      } else if (
        Math.abs(coverageRatio + unprofiledRatio - 1) > RATIO_TOLERANCE
      ) {
        failures.push(
          `${label}: coverageRatio + unprofiledRatio = ${(coverageRatio + unprofiledRatio).toFixed(9)}, expected 1`,
        );
      }
    }
  }

  const certification = {
    item: "C11-140 NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING",
    capturedAt: new Date().toISOString(),
    route: "moving-altitude arc (bounded)",
    repetitions: REPETITIONS,
    framesPerRep: FRAMES_PER_REP,
    certified: failures.length === 0 && result.featureAvailable,
    featureAvailable: result.featureAvailable,
    adapterInfo: result.adapterInfo,
    backend: result.backend,
    reps: result.reps,
    failures,
    structuralReasons: result.featureAvailable
      ? []
      : ["timestamp-query is unavailable on the resolved WebGPU adapter"],
    pageErrors,
    consoleErrors,
    externalRequests,
  };
  await writeFile(
    artifactPath,
    `${JSON.stringify(certification, undefined, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(certification, undefined, 2));
  console.log(`certification artifact: ${artifactPath}`);

  if (!result.featureAvailable) {
    console.error(
      "STRUCTURAL: timestamp-query is unavailable; C11-140 remains uncertified",
    );
    process.exitCode = 3;
  } else if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
