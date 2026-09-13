#!/usr/bin/env node
/**
 * Probe: `sample-height-from-3d-tiles` — the most-detailed height query on both backends.
 * @purpose Score `Scene.clampToHeightMostDetailed` by what it RETURNS, not by whether the demo happened to throw, and report the rate over N runs per renderer.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. The wave-end Sandcastle2 sweep scores this demo through its
 * symptom: the demo feeds the clamp result straight into a polyline, so a run
 * where the clamp yields `undefined` entries dies in `Cartesian3.pack` and the
 * sweep reports FAIL, while a run where the clamp promise NEVER SETTLES adds no
 * entities at all, throws nothing, and the sweep reports PASS. Two different
 * failures, one of them scored green. This probe reads the API's own result —
 * how many of the 30 points came back undefined, and whether the promise
 * settled at all — so the two are distinguishable and a rate means something.
 *
 * It has two modes:
 *   --mode=rate  (default) N runs per renderer, outcome per run, rate summary.
 *   --mode=diag  one run per renderer with the pick path instrumented from the
 *                PAGE side (no engine edit): every `PickDepth.getDepth` the
 *                offscreen most-detailed ray pick makes is recorded with the
 *                state that decides its answer.
 *
 * Usage:
 *   node Tools/visual-regression/probe-sample-height-webgpu.mjs \
 *     --base=http://localhost:8080 --sandcastle=http://localhost:8082 \
 *     --renderers=webgpu,webgl --runs=10 --settle=25000 --mode=rate
 *
 * Env: PROBE_BASE, PROBE_SANDCASTLE_BASE, SANDCASTLE_SETTLE_MS are honoured as
 * defaults so the invocation matches the sweep's.
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openSandcastle2Url,
  evaluateWithDeadline,
  EVALUATE_TIMEOUT,
} from "./lib/sandcastle2-renderer-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const BASE = arg("base", process.env.PROBE_BASE || "http://localhost:8080");
const BUCKET = arg(
  "sandcastle",
  process.env.PROBE_SANDCASTLE_BASE ||
    `http://localhost:${Number(new URL(BASE).port) + 1}`,
);
const RENDERERS = arg("renderers", "webgpu,webgl").split(",").filter(Boolean);
const RUNS = parseInt(arg("runs", "10"), 10);
const SETTLE_MS = parseInt(
  arg("settle", process.env.SANDCASTLE_SETTLE_MS || "25000"),
  10,
);
const MODE = arg("mode", "rate");
const LABEL = arg("label", MODE);
const OUT_DIR = arg(
  "out",
  path.join(__dirname, "output", "sample-height-webgpu"),
);
const DEMO_ID = "sample-height-from-3d-tiles";
const READ_TIMEOUT_MS = parseInt(arg("read-timeout", "20000"), 10);

/**
 * Installed in every frame BEFORE demo code runs. It waits for the demo's
 * viewer, then wraps the two things worth knowing:
 *
 *  - `Scene.prototype.clampToHeightMostDetailed`: did the promise settle, how
 *    long did it take, and how many of its results are undefined. This is the
 *    behaviour the demo actually depends on.
 *  - the offscreen most-detailed ray pick's `PickDepth.getDepth` (diag mode):
 *    what the depth query saw. `hasAsyncTexture` is the decisive field — it is
 *    `PickDepth._asyncDepthTexture`, which is set only by `PickDepth.update`,
 *    and on the asynchronous-readback backend `update` is called only on
 *    NON-picking frames. An offscreen pick render is a picking frame.
 */
function instrumentInit({ diag }) {
  const state = {
    clamp: null,
    getDepthCalls: [],
    // Per depth read: the depth byte-value and BOTH candidate frames it could
    // be encoded against — the slice the reconstruction uses, and the offscreen
    // camera's own fixed frustum. Only one of them reproduces WebGL's height.
    recon: [],
    // Every `UniformState.updateFrustum` the offscreen pick render makes, with
    // the near/far it was handed and the projection depth-row that came out.
    // This separates "the slice near/far never reached the CPU projection"
    // from "it reached the CPU projection but not the GPU".
    frustumUpdates: [],
    getPickDepthCalls: 0,
    contextInfo: null,
    installed: false,
    error: null,
  };
  globalThis.__oromeDiag = state;

  const wrapScene = (scene) => {
    if (!scene || scene.__oromeWrapped) {
      return false;
    }
    scene.__oromeWrapped = true;
    const context = scene.context;
    state.contextInfo = {
      rendererType: String(context?.rendererType),
      supportsSynchronousReadback: !!context?.supportsSynchronousReadback,
      depthTexture: !!context?.depthTexture,
      clampToHeightSupported: !!scene.clampToHeightSupported,
      useDepthPicking: !!scene.useDepthPicking,
    };

    const originalClamp = scene.clampToHeightMostDetailed.bind(scene);
    scene.clampToHeightMostDetailed = function (cartesians, ...rest) {
      const started = performance.now();
      const record = {
        requested: cartesians.length,
        settled: false,
        ms: null,
        undefinedCount: null,
        definedCount: null,
        rejected: null,
        // Where the requested points land on the canvas AT CALL TIME. The
        // live-view route can only answer for a point that has a pixel, so
        // this is the ceiling on what that route can resolve for this demo —
        // measured, not assumed.
        onScreen: null,
        offScreen: null,
        canvas: null,
      };
      try {
        const transforms = globalThis.Cesium?.SceneTransforms;
        if (transforms) {
          let onScreen = 0;
          let offScreen = 0;
          for (const cartesian of cartesians) {
            const window = transforms.worldToWindowCoordinates(
              scene,
              cartesian,
            );
            const inside =
              !!window &&
              window.x >= 0 &&
              window.y >= 0 &&
              window.x <= scene.canvas.clientWidth &&
              window.y <= scene.canvas.clientHeight;
            if (inside) {
              onScreen++;
            } else {
              offScreen++;
            }
          }
          record.onScreen = onScreen;
          record.offScreen = offScreen;
          record.canvas = [scene.canvas.clientWidth, scene.canvas.clientHeight];
        }
      } catch (error) {
        record.projectionError = String(error?.message ?? error);
      }
      state.clamp = record;
      console.log(`[orome] clamp start n=${cartesians.length}`);
      return originalClamp(cartesians, ...rest).then(
        (result) => {
          record.settled = true;
          record.ms = Math.round(performance.now() - started);
          record.undefinedCount = result.filter((c) => c === undefined).length;
          record.definedCount = result.length - record.undefinedCount;
          // The clamped positions themselves, so the two backends can be
          // compared point by point rather than only pass/fail.
          record.positions = result.map((c) =>
            c === undefined ? null : [c.x, c.y, c.z],
          );
          console.log(
            `[orome] clamp settled ms=${record.ms} undefined=${record.undefinedCount}/${record.requested}`,
          );
          return result;
        },
        (error) => {
          record.settled = true;
          record.ms = Math.round(performance.now() - started);
          record.rejected = String(error?.message ?? error);
          throw error;
        },
      );
    };

    if (diag) {
      // Count the offscreen renders a batch drives, and trace each awaited
      // readback. An unbounded render count is a drill loop that never
      // terminates; a readback that starts and never resolves is a stalled
      // mapAsync. The two failures look identical from outside the frame.
      let pickRenders = 0;
      const originalExecute = scene.updateAndExecuteCommands.bind(scene);
      scene.updateAndExecuteCommands = function (...args) {
        if (!scene.frameState?.passes?.pick) {
          return originalExecute(...args);
        }
        pickRenders++;
        const outcome = originalExecute(...args);
        if (pickRenders <= 3) {
          // What the offscreen ray render actually had to draw. A cleared depth
          // attachment and a drawn-but-unpublished one both read back as the
          // packer's no-surface sentinel, and only this tells them apart.
          const offscreen = scene._picking?._pickOffscreenView;
          const list = offscreen?.frustumCommandsList ?? [];
          const perPass = list.map((f) => {
            const indices = f?.indices ?? {};
            return Object.keys(indices)
              .filter((k) => (indices[k] ?? 0) > 0)
              .map((k) => `p${k}:${indices[k]}`)
              .join(" ");
          });
          const slices = list
            .map((f) => `${f?.near?.toFixed?.(2)}..${f?.far?.toFixed?.(0)}`)
            .join(",");
          console.log(
            `[orome] pick render ${pickRenders} frustums=${list.length} passes=[${perPass.join(" | ")}] slices=[${slices}] useLogDepth=${scene.frameState?.useLogDepth} ortho=${scene.camera?.frustum?.width !== undefined}`,
          );
        }
        return outcome;
      };
      const uniformState = scene.context?.uniformState;
      if (uniformState && typeof uniformState.updateFrustum === "function") {
        const originalUpdateFrustum =
          uniformState.updateFrustum.bind(uniformState);
        uniformState.updateFrustum = function (frustum) {
          const outcome = originalUpdateFrustum(frustum);
          try {
            if (
              scene.frameState?.passes?.pick === true &&
              state.frustumUpdates.length < 200
            ) {
              const projection = uniformState.projection;
              state.frustumUpdates.push({
                inNear: frustum?.near ?? null,
                inFar: frustum?.far ?? null,
                // UniformState's own record of the range it just published.
                curNear: uniformState.currentFrustum?.x ?? null,
                curFar: uniformState.currentFrustum?.y ?? null,
                // Column-major [10] and [14] are the depth row of an
                // orthographic projection: z_clip = p10 * z_eye + p14.
                p10: projection ? projection[10] : null,
                p14: projection ? projection[14] : null,
                sceneFrameNear: scene.frameState?.near ?? null,
                sceneFrameFar: scene.frameState?.far ?? null,
                offscreen: scene.view !== scene.defaultView,
              });
            }
          } catch (error) {
            state.frustumUpdates.push({ error: String(error) });
          }
          return outcome;
        };
      }
      const picking = scene._picking;
      const reconSnapshot = (index, depth) => {
        try {
          const offscreen = picking._pickOffscreenView;
          const camera = offscreen?.camera;
          const camFrustum = camera?.frustum ?? {};
          const slice = offscreen?.frustumCommandsList?.[index] ?? {};
          let originHeight = null;
          try {
            const carto = scene.ellipsoid?.cartesianToCartographic(
              camera.positionWC,
            );
            originHeight = carto ? carto.height : null;
          } catch (error) {
            originHeight = `ERR ${error?.message ?? error}`;
          }
          state.recon.push({
            index,
            depth,
            camNear: camFrustum.near ?? null,
            camFar: camFrustum.far ?? null,
            camWidth: camFrustum.width ?? null,
            sliceNear: slice.near ?? null,
            sliceFar: slice.far ?? null,
            originHeight,
          });
        } catch (error) {
          state.recon.push({ index, depth, error: String(error) });
        }
      };
      const originalGetPickDepth = picking.getPickDepth.bind(picking);
      picking.getPickDepth = function (sceneArg, index) {
        state.getPickDepthCalls++;
        const pickDepth = originalGetPickDepth(sceneArg, index);
        if (!pickDepth.__oromeWrapped) {
          pickDepth.__oromeWrapped = true;
          if (typeof pickDepth.readDepthAsync === "function") {
            const originalReadAsync = pickDepth.readDepthAsync.bind(pickDepth);
            let readbackSeq = 0;
            pickDepth.readDepthAsync = function (context, x, y) {
              const seq = ++readbackSeq;
              console.log(`[orome] readback ${seq} start idx=${index}`);
              return originalReadAsync(context, x, y).then(
                (value) => {
                  console.log(`[orome] readback ${seq} -> ${value}`);
                  reconSnapshot(index, value);
                  return value;
                },
                (error) => {
                  console.log(`[orome] readback ${seq} REJECTED ${error}`);
                  throw error;
                },
              );
            };
          }
          const originalGetDepth = pickDepth.getDepth.bind(pickDepth);
          pickDepth.getDepth = function (context, x, y) {
            const before = {
              index,
              offscreenView: sceneArg.view !== sceneArg.defaultView,
              hasFramebuffer: !!pickDepth.framebuffer,
              hasAsyncTexture: !!pickDepth._asyncDepthTexture,
              cachedValue: pickDepth._lastDepthValue,
              cachedX: pickDepth._lastDepthX,
              cachedY: pickDepth._lastDepthY,
              cacheStamp: pickDepth._lastDepthStamp,
              updateCount: pickDepth._updateCount,
              pending: !!pickDepth._pendingReadback,
              x,
              y,
            };
            const depth = originalGetDepth(context, x, y);
            reconSnapshot(index, depth);
            if (state.getDepthCalls.length < 400) {
              state.getDepthCalls.push({ ...before, depth });
            }
            return depth;
          };
        }
        return pickDepth;
      };
    }
    state.installed = true;
    console.log(
      `[orome] instrument installed on ${state.contextInfo.rendererType}`,
    );
    return true;
  };

  const timer = setInterval(() => {
    try {
      const instances = globalThis.__sandcastleInstances ?? [];
      for (const instance of instances) {
        if (wrapScene(instance?.scene)) {
          clearInterval(timer);
          return;
        }
      }
    } catch (error) {
      state.error = String(error?.message ?? error);
      clearInterval(timer);
    }
  }, 10);
  setTimeout(() => clearInterval(timer), 60000);
}

async function runOnce(browser, renderer, attempt, diag) {
  const startedAt = performance.now();
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) =>
    errors.push(`pageerror: ${String(e?.message ?? e)}`),
  );
  const trace = [];
  page.on("console", (m) => {
    const text = m.text();
    if (text.startsWith("[orome]") || text.startsWith("[WebGPU:RayPick]")) {
      trace.push(`${Math.round(performance.now() - startedAt)}ms ${text}`);
    }
    if (m.type() === "error") {
      errors.push(`console.error: ${text.slice(0, 400)}`);
    }
  });
  await page.addInitScript(instrumentInit, { diag });

  const result = {
    renderer,
    attempt,
    outcome: "UNKNOWN",
    errors: [],
    diag: null,
    frameNumbers: [],
  };
  try {
    const { bucketFrame } = await openSandcastle2Url(
      page,
      { base: BASE, bucketBase: BUCKET, id: DEMO_ID, renderer },
      { timeoutMs: 60000 },
    );
    await page.waitForTimeout(SETTLE_MS);
    const read = await evaluateWithDeadline(
      bucketFrame,
      () => {
        const frameNumbers = [];
        for (const instance of globalThis.__sandcastleInstances ?? []) {
          const n = instance?.scene?.frameState?.frameNumber;
          if (typeof n === "number") {
            frameNumbers.push(n);
          }
        }
        const contexts = [];
        const registry = globalThis.Cesium?.GraphicsContext?.registry;
        if (registry?.all) {
          for (const c of registry.all.values()) {
            contexts.push(String(c.rendererType));
          }
        }
        // A promise that never settles has two candidate causes and this
        // separates them: rays still queued means the most-detailed PRELOAD
        // never reported ready; zero queued means every pick ran and the
        // failure is downstream of the preload.
        let pendingRayPicks = null;
        let tilesetsReady = null;
        for (const instance of globalThis.__sandcastleInstances ?? []) {
          const picking = instance?.scene?._picking;
          if (picking) {
            pendingRayPicks = picking._mostDetailedRayPicks?.length ?? null;
          }
          const primitives = instance?.scene?.primitives;
          if (primitives) {
            tilesetsReady = [];
            for (let i = 0; i < primitives.length; ++i) {
              const p = primitives.get(i);
              if (p?.isCesium3DTileset) {
                tilesetsReady.push({
                  tilesLoaded: !!p.tilesLoaded,
                  statistics: {
                    numberOfTilesTotal: p.statistics?.numberOfTilesTotal,
                    numberOfPendingRequests:
                      p.statistics?.numberOfPendingRequests,
                  },
                });
              }
            }
          }
        }
        return {
          frameNumbers,
          contexts,
          pendingRayPicks,
          tilesetsReady,
          diag: JSON.parse(JSON.stringify(globalThis.__oromeDiag ?? null)),
        };
      },
      READ_TIMEOUT_MS,
    );
    if (read === EVALUATE_TIMEOUT) {
      result.outcome = "WEDGED";
      result.errors = errors.slice(0, 8);
      result.trace = trace;
      return result;
    }
    result.frameNumbers = read.frameNumbers;
    result.contexts = read.contexts;
    result.pendingRayPicks = read.pendingRayPicks;
    result.tilesetsReady = read.tilesetsReady;
    result.diag = read.diag;
    result.errors = errors.slice(0, 8);
    result.trace = trace;

    const clamp = read.diag?.clamp;
    const renderingStopped = errors.some((e) =>
      /Rendering has stopped/.test(e),
    );
    if (!clamp) {
      result.outcome = "NO_CLAMP_CALL";
    } else if (!clamp.settled) {
      result.outcome = "UNSETTLED";
    } else if (clamp.rejected) {
      result.outcome = "REJECTED";
    } else if (clamp.undefinedCount > 0) {
      result.outcome = "UNDEFINED_ENTRIES";
    } else {
      result.outcome = "PASS";
    }
    if (renderingStopped && result.outcome === "PASS") {
      result.outcome = "RENDER_STOPPED";
    }
    return result;
  } catch (error) {
    result.outcome = "PROBE_ERROR";
    result.errors = [String(error?.message ?? error), ...errors].slice(0, 8);
    return result;
  } finally {
    await context.close().catch(() => {});
  }
}

const runs = MODE === "diag" ? 1 : RUNS;

// The load-bearing half of the probe contract. This probe holds the machine's
// single Edge slot for as long as it runs, and the defect it exists to measure
// presents as a HANG — a clamp promise that never settles — so a run that wedges
// is the expected failure, not a surprise. Budget: a fixed startup allowance
// plus, per run, the settle it was asked for, the in-page read timeout, and a
// margin for tileset load and browser teardown. `--watchdog=` overrides.
const WATCHDOG_MS = parseInt(
  arg(
    "watchdog",
    String(
      180_000 +
        runs * RENDERERS.length * (SETTLE_MS + READ_TIMEOUT_MS + 120_000),
    ),
  ),
  10,
);
const watchdog = setTimeout(() => {
  console.error(
    `[sample-height-probe] WATCHDOG: no verdict after ${WATCHDOG_MS} ms; ` +
      `ending the run so the Edge slot is not held open`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

const browser = await chromium.launch({ channel: "msedge", headless: true });
await fs.mkdir(OUT_DIR, { recursive: true });
const all = [];
try {
  for (let attempt = 1; attempt <= runs; ++attempt) {
    for (const renderer of RENDERERS) {
      const r = await runOnce(browser, renderer, attempt, MODE === "diag");
      all.push(r);
      const clamp = r.diag?.clamp;
      console.log(
        `[${r.outcome}] ${renderer} attempt ${attempt} — frames ${r.frameNumbers.join("/")} — clamp ${
          clamp
            ? `settled=${clamp.settled} ms=${clamp.ms} undefined=${clamp.undefinedCount}/${clamp.requested}`
            : "not called"
        }${r.trace?.length ? ` — trace: ${r.trace.join(" | ")}` : ""}`,
      );
      await fs.writeFile(
        path.join(OUT_DIR, `${LABEL}-results.json`),
        JSON.stringify(
          {
            base: BASE,
            bucket: BUCKET,
            settleMs: SETTLE_MS,
            mode: MODE,
            results: all,
          },
          null,
          2,
        ),
      );
    }
  }
} finally {
  // In a `finally` so a throw anywhere in the loop still releases the Edge slot
  // rather than leaving an orphaned renderer holding gigabytes — the failure
  // this lane's own baseline ran into (six parent-dead renderers, 14.5 GB).
  await browser.close();
}
clearTimeout(watchdog);

const tally = {};
for (const r of all) {
  tally[r.renderer] ??= {};
  tally[r.renderer][r.outcome] = (tally[r.renderer][r.outcome] ?? 0) + 1;
}
console.log(`\n=== ${LABEL} (settle ${SETTLE_MS} ms, ${BASE}) ===`);
let clean = true;
for (const [renderer, counts] of Object.entries(tally)) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pass = counts.PASS ?? 0;
  if (pass !== total) {
    clean = false;
  }
  console.log(
    `${renderer}: ${total - pass}/${total} fail — ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
}
console.log(`${clean ? "PASS" : "FAIL"}: sample-height probe`);
process.exitCode = clean ? 0 : 1;
