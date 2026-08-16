#!/usr/bin/env node
/**
 * C13-39 — GPU-timestamp A/B lanes for the density-LOD / domain-transform hoist.
 * @purpose C13-39 GPU-timestamp A/B lanes for the density-LOD/domain hoist; codifies the repo's mandatory interleaved bundle-swap GPU-timing protocol
 * @status ACTIVE
 *
 * WHAT THIS MEASURES
 * ------------------
 * The C13-39 queue row's acceptance requires per-pass GPU timing for the baked
 * view march, the LIVE escape route, the single and cascaded cloud shadow maps,
 * and the environment/IBL leg. Every cloud pass now carries `timestampWrites`
 * (see `timedCloudPass` in WebGPUProceduralCloudRenderer.ts and the
 * `DynEnvMap Sky Fill` compute pass), so `CesiumDebug.gpuPassCost(true)` can
 * attribute GPU time to each of them by pass LABEL.
 *
 * This probe is TIMING ONLY. Visual/morphology equivalence is gated separately
 * by the C13-37 morphology oracle lanes and the baked-vs-live periodicity probe;
 * the per-lane canvas fingerprint recorded here is only a sanity anchor proving
 * the two runs rendered the same scene, NOT the equivalence gate.
 *
 * HOW TO RUN THE A/B (orchestrator, serial — never two Edge instances at once)
 * ---------------------------------------------------------------------------
 * *** MANDATORY: INTERLEAVED BUNDLE SWAP. ***
 *
 * Do NOT run "build A, measure A, do other work, build B, measure B". GPU
 * timings drift across a session (thermal state, driver/compositor residency,
 * background load), and that drift is large enough to invent results. The
 * 2026-07-24 non-interleaved attempt on this very probe produced IMPOSSIBLE
 * bidirectional deltas on shaders the change never touched — CloudTemporalResolve
 * -59% and live-escape +98% with ~40 minutes between the two captures. Those
 * numbers were drift, not signal.
 *
 * The protocol that produced trustworthy numbers:
 *   1. Build BOTH bundles ONCE, up front, and keep them side by side (e.g.
 *      `Build/CesiumUnminified` swapped from two saved copies). Never rebuild
 *      between measurements — the manifest's `runtimeBundle.sha256` is what
 *      pairs a capture to a binary, so a rebuild mid-session invalidates it.
 *   2. Within ONE session, ALTERNATE: pre, post, pre, post — swapping only the
 *      bundle between runs, a few minutes apart, never tens of minutes.
 *   3. N >= 2 full rounds, and run at least one round in the REVERSE order
 *      (post first). A real effect reproduces in both orderings; drift does not.
 *   4. Cross-check the untouched-shader lanes and the per-lane occupancy
 *      fingerprints. `CloudTemporalResolve` / `CloudUpscale` shaders are not
 *      modified by this task, and the fingerprints should be byte-identical
 *      pre/post — if either moves materially, the session is drifting and the
 *      round must be discarded, not interpreted.
 *
 * Command shape for each leg (swap the bundle, then run):
 *   C13_39_PAIR_ID=2026-07-24-c13-39 TAG=pre  node Tools/visual-regression/probe-cloud-lod-hoist-perf.mjs
 *   C13_39_PAIR_ID=2026-07-24-c13-39 TAG=post node Tools/visual-regression/probe-cloud-lod-hoist-perf.mjs
 *
 * This requirement is not specific to C13-39 — any future GPU-timing A/B in
 * this repo should inherit it.
 *
 * The second run finds the first run's manifest and prints the per-lane,
 * per-pass delta table plus a direction check against each lane's declared
 * expectation. Both manifests land in `Tools/visual-regression/output/`.
 *
 * `TAG=pre` is GREEN when every lane is VALID — a missing companion is the
 * normal state of the first half of an A/B. `TAG=post` additionally REQUIRES a
 * comparable `pre` manifest, because without one it cannot answer the
 * acceptance question.
 *
 * STRUCTURAL GATES (a lane goes INVALID rather than recording a number):
 *   - the density field the lane exists to time must be realized AND visible
 *     before measurement starts (see `OCCUPANCY_MAX_FRAMES`);
 *   - a lane whose consumer is edge-triggered must show its pass actually
 *     executing in at least `minPresentRepeats` of the repeats;
 *   - a lane that opts into a context flag must prove the flag took effect.
 *
 * COMPARABILITY GUARDS
 * --------------------
 * The comparison refuses to run unless both manifests share the manifest
 * version, pair id, adapter, browser build, canvas size, and per-lane
 * configuration truth, AND the two runtime bundles differ by sha256 (otherwise
 * the "A/B" is the same binary measured twice).
 *
 * DETERMINISM
 * -----------
 * Every lane pins its camera and its clock. Lanes that must re-trigger an
 * edge-triggered consumer (the environment cube fill) advance the clock by a
 * FIXED number of seconds per frame instead of using wall time, so the frame
 * sequence is byte-reproducible across runs.
 *
 * Env:
 *   TAG                       pre | post           (required, default "pre")
 *   C13_39_PAIR_ID            opaque pairing id    (required to compare)
 *   PROBE_BASE                default http://localhost:8080
 *   C13_39_REPEATS            default 5            (median-of-N)
 *   C13_39_LANES              comma-separated lane id filter (default: all)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

// ── HARD watchdog: force-exit if anything hangs (machine safety) ──
// Unbounded awaits inside page.evaluate (rAF settles, onSubmittedWorkDone)
// could otherwise leave headless Edge alive forever on a GPU hang. Unref'd so
// it never keeps an otherwise-finished process alive.
// Budget: 6 lanes x (up to 300 bounded occupancy frames + 40 warm + 5 x 60
// measured + 4 x 8 warm + screenshot) — every loop in this file has a constant
// bound, so the watchdog only ever fires on a GPU/driver hang.
const HARD_LIMIT_MS = 1_200_000; // 1200s
const watchdog = setTimeout(() => {
  console.error("[c13-39-perf] WATCHDOG FIRED (1200s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const MANIFEST_VERSION = "c13-39-lod-hoist/1";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "pre";
const PAIR_ID = process.env.C13_39_PAIR_ID || null;
const REPEATS = Math.max(1, Number(process.env.C13_39_REPEATS ?? 5));
const LANE_FILTER = (process.env.C13_39_LANES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = "Tools/visual-regression/output";
const W = 1024;
const H = 768;

// Fixed evidence view, shared by every lane: below the deck looking up through
// sparse cloud so rays cross both occupied and empty space (the empty span is
// what the occupancy deferrals act on).
const CAMERA = Object.freeze({
  lon: -95.0,
  lat: 39.0,
  alt: 800.0,
  headingDeg: 90.0,
  pitchDeg: 25.0,
});
const CLOCK_ISO = "2026-06-21T18:20:00Z";

// Rolling window inside WebGPUTimestampProfiler is 60 frames; measure exactly
// that many so every sample in the reported average is a measured frame.
const WARM_FRAMES = 40;
const REPEAT_WARM_FRAMES = 8;
const MEASURE_FRAMES = 60;

// P1 — `awaitProceduralReady` only proves the feature renderer initialized and
// executed once (it returned at waitedFrames=1 on the 2026-07-24 pre-run). The
// 3D noise bake plus its C13-37 mip chain is a multi-frame GPU process, so the
// first frames march an EMPTY density field and time a workload that is not the
// one under test. Every lane therefore runs a bounded render-measure-check loop
// until the canvas ACTUALLY contains cloud, and baked lanes additionally require
// the realized quality flags to show the planet-domain BAKED branch is live.
// On timeout the lane is marked INVALID (structural) rather than recording a
// meaningless timing.
const OCCUPANCY_MAX_FRAMES = 300;
const OCCUPANCY_MIN_CELLS = 3000;

// Bounds for the env-map owner load and the fill-arming/diagnosis loop.
const ENV_OWNER_MAX_FRAMES = 600;
const ENV_FILL_MAX_FRAMES = 240;

// Quality-flag bits, from WebGPUCloudTierPresets.ts. Read off the live
// `cache.uniformData[74]` so readiness proves what the SHADER took, not what
// the config asked for.
const QF_NOISE_BAKED = 1 << 0;
const QF_PLANET_DENSITY = 1 << 13;

if (!["pre", "post"].includes(TAG)) {
  throw new Error("TAG must be pre or post");
}

/**
 * Lane table. `passes` are GPU render/compute pass LABELS as emitted by the
 * renderer; the profiler keys its results by exactly those strings.
 *
 * `expect` records the direction C13-39 predicts, so the A/B report can flag a
 * lane that moved the wrong way instead of silently reporting a number:
 *   "faster"        — the hoist removes per-sample work here; require < -2%
 *   "unchanged"     — the shader is untouched; require |delta| <= 2%
 *   "no-regression" — the density evaluation is untouched but the pass shares a
 *                     hoisted setup, so it may improve; require <= +2%
 */
//
// SCENE VALUES. The four pinned BAKED lanes use the C13-37 acceptance probe's
// proven baked-path scene (`probe-cloud-density-domain.mjs`: coverage 0.6,
// density 0.85, wind 0, same camera). The 2026-07-24 pre-run measured
// cloudCells=0 on every baked lane while `live-escape` (coverage 0.35 /
// density 0.7, inherited from `probe-cloud-perf.mjs`, which is tuned for the
// LIVE escape hatch) rendered 7139 — the BAKED field's base response at this
// view is sparser than the LIVE one's, so the sparse config could never satisfy
// the occupancy gate no matter how long readiness waited. Wind is pinned to 0
// on the clock-pinned lanes so nothing advects; the `ibl` lane keeps live wind
// because its edge-triggered consumer needs the field to move.
const LANES = [
  {
    id: "baked-straight",
    description:
      "T3 cinematic: planet-domain BAKED density, full-res march, STRAIGHT " +
      "light march, high-precision RTE view route. The primary view-march lane.",
    volumetric: {
      cloudVolumetricQuality: "high",
      cloudCoverage: 0.6,
      cloudDensity: 0.85,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
    },
    clockStepSeconds: 0,
    requireBakedDensity: true,
    passes: ["ProceduralClouds pass"],
    expect: { "ProceduralClouds pass": "faster" },
  },
  {
    id: "baked-cone",
    description:
      "T2 medium: planet-domain BAKED density with the Schneider CONE light " +
      "march, half-res target and temporal reconstruction. The cone's five " +
      "short taps are where the erosion-tap deferral removes the most work.",
    volumetric: {
      cloudVolumetricQuality: "medium",
      cloudCoverage: 0.6,
      cloudDensity: 0.85,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
    },
    clockStepSeconds: 0,
    requireBakedDensity: true,
    passes: [
      "ProceduralClouds half-res pass",
      "CloudTemporalResolve pass",
      "CloudUpscale composite pass",
    ],
    expect: {
      "ProceduralClouds half-res pass": "faster",
      "CloudTemporalResolve pass": "unchanged",
      "CloudUpscale composite pass": "unchanged",
    },
  },
  {
    id: "live-escape",
    description:
      "cloudQuality != 64 forces the power-user escape hatch: LIVE noise, no " +
      "reconstruction, straight light march. C13-39 did not touch the frozen " +
      "legacy density route (`legacyCloudDensity` / `legacyCloudBaseDensity` " +
      "are hash-frozen by cloud-density-domain.spec.mjs), so the CONTROL claim " +
      "is that this lane must not regress. It may improve slightly because the " +
      "light march's sun direction, shell reciprocals and step count are now " +
      "hoisted per deck for BOTH routes.",
    volumetric: {
      cloudQuality: 96,
      cloudCoverage: 0.35,
      cloudDensity: 0.7,
      cloudWeatherMap: false,
    },
    clockStepSeconds: 0,
    // LIVE noise by construction — the baked-density flags are expected to be
    // CLEAR here, so this lane only requires visible occupancy.
    requireBakedDensity: false,
    passes: ["ProceduralClouds pass"],
    expect: { "ProceduralClouds pass": "no-regression" },
  },
  {
    id: "shadow-single",
    description:
      "T3 plus the single sun-view beer shadow map. `cloudShadowMain` hoists " +
      "its LOD bundle and wind offset out of the per-step column loop.",
    volumetric: {
      cloudVolumetricQuality: "high",
      cloudCoverage: 0.6,
      cloudDensity: 0.85,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudCastShadows: true,
    },
    clockStepSeconds: 0,
    requireBakedDensity: true,
    passes: ["CloudShadow map pass", "ProceduralClouds pass"],
    expect: {
      "CloudShadow map pass": "faster",
      "ProceduralClouds pass": "faster",
    },
  },
  {
    id: "shadow-cascaded",
    description:
      "T3 plus the 3-tile cascade atlas. Same entry point as the single map, " +
      "so the per-step hoist applies three more times per frame.",
    volumetric: {
      cloudVolumetricQuality: "high",
      cloudCoverage: 0.6,
      cloudDensity: 0.85,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudCastShadows: true,
      cloudShadowCascades: true,
    },
    clockStepSeconds: 0,
    requireBakedDensity: true,
    passes: [
      "CloudShadow cascade atlas pass",
      "CloudShadow map pass",
      "ProceduralClouds pass",
    ],
    expect: {
      "CloudShadow cascade atlas pass": "faster",
      "CloudShadow map pass": "faster",
      "ProceduralClouds pass": "faster",
    },
  },
  {
    id: "ibl",
    description:
      "T3 plus cloud contribution to the dynamic environment map. THREE " +
      "conditions must hold or `DynEnvMap Sky Fill` never runs; the " +
      "2026-07-24 pre-runs tripped two of them in sequence.\n" +
      "  (1) AN OWNER MUST EXIST. `DynamicEnvironmentMapManager.update()` is " +
      "called ONLY from `Model.update()` (Model.js:2316) and " +
      "`Cesium3DTileset.update()` (Cesium3DTileset.js:1422) — there is no " +
      "scene-level owner. A globe-and-clouds scene with no model and no " +
      "tileset never calls the manager at all, so the C13-38 relevance gate " +
      "and the C13-37 revision debounce are both downstream of a call that " +
      "does not happen. This is why the second pre-run verified " +
      "`cloudsInReflections active=true` and `publishedIblCoverage=0.574` " +
      "(both produced by the cloud renderer's publish side, which runs " +
      "unconditionally) and STILL measured 0/5. The lane therefore adds a " +
      "minimal local glTF as the env-map owner.\n" +
      "  (2) THE RELEVANCE GATE MUST BE OPEN. `wantMarch` is " +
      "`context.cloudsInReflections === true && publishedCloudIblCoverage > 0` " +
      "(WebGPUDynamicEnvironmentMapManager.ts:531). `cloudsInReflections` is a " +
      "read-only getter over `context._options.webgpu`, so the lane pokes that " +
      "backing store and VERIFIES the getter flipped.\n" +
      "  (3) AN INPUT MUST CROSS ITS DEBOUNCE. With live wind at 15 m/s and a " +
      "30 s/frame clock step, the C13-37 advection debounce sees " +
      "15 * 30 = 450 m of displacement per frame against a 64 m threshold " +
      "(`advectionMoved`, WebGPUProceduralCloudRenderer.ts), so the revision " +
      "advances every frame with ~7x margin. Wind is deliberately left at its " +
      "default here (the pinned lanes set it to 0).\n" +
      "The lane arms and DIAGNOSES all three before measuring, and requires " +
      "the fill present in at least 3 repeats.",
    volumetric: {
      cloudVolumetricQuality: "high",
      cloudCoverage: 0.6,
      cloudDensity: 0.85,
      cloudWeatherMap: false,
      cloudContributesIBL: true,
    },
    clockStepSeconds: 30,
    requireBakedDensity: true,
    cloudsInReflections: true,
    // Minimal self-contained glTF (4 KB, base64-embedded buffers → one
    // request, offline-safe). Its own draw cost is identical pre and post and
    // is not part of the measured `DynEnvMap Sky Fill` pass.
    envMapOwnerModel: "/Apps/SampleData/models/BoxUnlit/BoxUnlit.gltf",
    requireEnvFills: 2,
    minPresentRepeats: { "DynEnvMap Sky Fill": 3 },
    passes: ["DynEnvMap Sky Fill", "ProceduralClouds pass"],
    expect: {
      "DynEnvMap Sky Fill": "faster",
      "ProceduralClouds pass": "faster",
    },
  },
];

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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : +((sorted[mid - 1] + sorted[mid]) / 2).toFixed(6);
}

async function lumStats(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let cells = 0;
  const pixels = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
    if (lum > 150) cells++;
  }
  return { meanLum: +(sum / pixels).toFixed(3), cloudCells: cells };
}

// ── Browser-side steps. Every helper lives INSIDE the evaluated function so
//    nothing depends on Node-side scope. ──

const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  v.useDefaultRenderLoop = false;
  const ctx = s.context;

  // P2 — opt this lane into the full reflected-cloud march BEFORE any cloud
  // config is applied, so the very first published coverage already sees the
  // flag. `WebGPUContext.cloudsInReflections` is a READ-ONLY getter over
  // `_options.webgpu`, so the only runtime route is the backing store; the
  // getter is then re-read to prove the opt-in actually took.
  let cloudsInReflectionsActive = ctx.cloudsInReflections === true;
  if (cfg.cloudsInReflections === true && !cloudsInReflectionsActive) {
    const options = ctx._options;
    if (options) {
      if (!options.webgpu) {
        options.webgpu = {};
      }
      options.webgpu.cloudsInReflections = true;
    }
    cloudsInReflectionsActive = ctx.cloudsInReflections === true;
  }

  const configTruth = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: cfg.volumetric,
  });
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(
      cfg.camera.lon,
      cfg.camera.lat,
      cfg.camera.alt,
    ),
    orientation: {
      heading: C.Math.toRadians(cfg.camera.headingDeg),
      pitch: C.Math.toRadians(cfg.camera.pitchDeg),
      roll: 0.0,
    },
  });
  // P2 round 2 — install the env-map OWNER. `DynamicEnvironmentMapManager` is
  // owned by models and tilesets, never by the Scene, so without one in the
  // primitive list `updateWebGPUDynamicEnvironmentMap` is never invoked and no
  // amount of revision/debounce tuning can produce a fill. Loaded and driven to
  // `ready` on the PINNED base epoch so this setup cannot perturb the measured
  // clock walk.
  const envOwner = {
    requested: typeof cfg.envMapOwnerModel === "string",
    ready: false,
    waitedFrames: 0,
    hasManager: false,
    managerEnabled: false,
    error: null,
  };
  if (envOwner.requested) {
    const baseTime = C.JulianDate.fromIso8601(cfg.iso);
    try {
      const model = await C.Model.fromGltfAsync({
        url: cfg.envMapOwnerModel,
        // Ground level, directly BELOW the camera. The evidence camera sits at
        // 800 m looking UP at pitch +25°, so the owner is out of frame and
        // cannot perturb the canvas occupancy fingerprint — it exists purely to
        // drive `environmentMapManager.update(frameState)`.
        modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(cfg.camera.lon, cfg.camera.lat, 0.0),
        ),
        scale: 1.0,
      });
      s.primitives.add(model);
      globalThis.__c13_39_envOwner = model;
      let waited = 0;
      for (; waited < cfg.envOwnerMaxFrames; waited++) {
        if (model.ready) break;
        s.render(baseTime);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      envOwner.waitedFrames = waited;
      envOwner.ready = model.ready === true;
      const manager = model.environmentMapManager;
      envOwner.hasManager = !!manager;
      if (manager) {
        manager.enabled = true;
        envOwner.managerEnabled = manager.enabled === true;
      }
    } catch (e) {
      envOwner.error = String(e);
    }
  }

  return {
    configTruth,
    cloudsInReflectionsRequested: cfg.cloudsInReflections === true,
    cloudsInReflectionsActive,
    envOwner,
    timestampSupported: ctx.hasFeature?.("timestamp-query") === true,
    adapterInfo: ctx.adapter?.info
      ? {
          vendor: ctx.adapter.info.vendor || "",
          architecture: ctx.adapter.info.architecture || "",
          device: ctx.adapter.info.device || "",
          description: ctx.adapter.info.description || "",
        }
      : null,
    canvas: { width: s.canvas.width, height: s.canvas.height },
  };
};

const MEASURE = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const ctx = s.context;
  const device = ctx.device;

  // Deterministic clock sequence. stepSeconds === 0 pins the clock outright;
  // a positive step advances scene time by a FIXED amount per frame so
  // edge-triggered consumers re-arm identically in both A/B runs.
  //
  // `frameOffset` is supplied by the caller from a FIXED schedule (a known
  // warm+measure frame budget per repeat), so the measured clock sequence is
  // monotonic across repeats and byte-reproducible between the pre and post
  // runs. The readiness/occupancy loop below deliberately renders at `base`
  // instead of advancing, so a run where the bake settles in 12 frames and a
  // run where it takes 80 still measure the IDENTICAL clock sequence.
  const base = C.JulianDate.fromIso8601(cfg.iso);
  const jdAt = (frameIndex) => {
    if (!(cfg.clockStepSeconds > 0)) {
      return base;
    }
    return C.JulianDate.addSeconds(
      base,
      (cfg.frameOffset + frameIndex) * cfg.clockStepSeconds,
      new C.JulianDate(),
    );
  };

  s.requestRenderMode = false;

  // SAME-TASK canvas measurement. `drawImage` from the WebGPU canvas into a 2D
  // canvas must run in the SAME task as `scene.render()`, with no intervening
  // await — after the task yields, the presentation texture can be relinquished
  // and the readback decodes as all-zero. Full resolution (no downsample) so the
  // cell count is directly comparable to the Node-side `sharp` gate, which uses
  // the same lum > 150 rule on the canvas-element screenshot.
  const probeCanvas = document.createElement("canvas");
  const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
  const measureCanvas = () => {
    const src = s.canvas;
    if (!probeCtx || !src.width || !src.height) {
      return { cells: 0, meanLum: 0, readable: false };
    }
    if (probeCanvas.width !== src.width) probeCanvas.width = src.width;
    if (probeCanvas.height !== src.height) probeCanvas.height = src.height;
    probeCtx.clearRect(0, 0, src.width, src.height);
    probeCtx.drawImage(src, 0, 0);
    const data = probeCtx.getImageData(0, 0, src.width, src.height).data;
    let cells = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      if (lum > 150) cells++;
    }
    const pixels = src.width * src.height;
    return { cells, meanLum: sum / pixels, readable: true };
  };

  // A fill's bookkeeping (`lastCloudRevision`, `lastSunDir*`,
  // `lastCloudCoverage`, `needsUpdate = false`) is written ONLY inside the
  // `runProceduralSkyFill` block (WebGPUDynamicEnvironmentMapManager.ts ~line
  // 620), so a change in this tuple between two frames is proof a fill executed
  // AND names which input the manager consumed.
  const envSnapshot = () => {
    const owner = globalThis.__c13_39_envOwner;
    const manager = owner?.environmentMapManager;
    const mc = manager?._webgpuCache;
    const cc = ctx._cloudCache;
    return {
      hasOwner: !!owner,
      ownerReady: owner?.ready === true,
      hasManager: !!manager,
      managerEnabled: manager?.enabled === true,
      managerShouldUpdate: manager?.shouldUpdate === true,
      hasManagerCache: !!mc,
      // consume side
      lastCloudRevision: mc?.lastCloudRevision ?? null,
      lastCloudCoverage: mc?.lastCloudCoverage ?? null,
      lastUsedCloudMarch: mc?.lastUsedCloudMarch ?? null,
      needsUpdate: mc?.needsUpdate ?? null,
      lastSunDirX: mc?.lastSunDirX ?? null,
      lastSunDirY: mc?.lastSunDirY ?? null,
      lastSunDirZ: mc?.lastSunDirZ ?? null,
      // publish side
      iblRevision: cc?.iblRevision ?? null,
      iblCoverage: cc?.iblCoverage ?? null,
    };
  };

  // Name the input that moved. `SUN_REFRESH_EPSILON_SQ` is 0.005^2 and
  // `CLOUD_COVERAGE_REFRESH_EPSILON` is 1/256 in the manager.
  const attributeFill = (before, after) => {
    const reasons = [];
    if (after.lastCloudRevision !== before.lastCloudRevision) {
      reasons.push(
        `cloud-revision ${before.lastCloudRevision}->${after.lastCloudRevision}`,
      );
    }
    const dx = (after.lastSunDirX ?? 0) - (before.lastSunDirX ?? 0);
    const dy = (after.lastSunDirY ?? 0) - (before.lastSunDirY ?? 0);
    const dz = (after.lastSunDirZ ?? 0) - (before.lastSunDirZ ?? 0);
    const sunDelta = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (sunDelta > 0) {
      reasons.push(`sun-delta ${sunDelta.toFixed(6)} (threshold 0.005)`);
    }
    if (after.lastCloudCoverage !== before.lastCloudCoverage) {
      reasons.push(
        `coverage ${before.lastCloudCoverage}->${after.lastCloudCoverage} (threshold ${1 / 256})`,
      );
    }
    if (before.needsUpdate === true && after.needsUpdate === false) {
      reasons.push("needsUpdate cleared (first fill)");
    }
    return { sunDelta: +sunDelta.toFixed(6), reasons };
  };

  const densityRealization = () => {
    const cache = ctx._cloudCache;
    const flags = Math.trunc(cache?.uniformData?.[74] ?? 0);
    return {
      flags,
      noiseBaked: cache?.noiseBaked === true,
      noiseResourcesPresent: !!cache?.noise,
      shapeMipLevelCount: cache?.noise?.shapeMipLevelCount ?? 0,
      detailMipLevelCount: cache?.noise?.detailMipLevelCount ?? 0,
      bakedBitSet: (flags & cfg.qfNoiseBaked) !== 0,
      planetDensityBitSet: (flags & cfg.qfPlanetDensity) !== 0,
      iblCoverage: cache?.iblCoverage ?? 0,
      iblRevision: cache?.iblRevision ?? 0,
    };
  };

  let readiness = null;
  let occupancy = null;
  let envFills = null;
  if (cfg.awaitReady) {
    readiness = await globalThis.__cloudProbe.awaitProceduralReady({
      featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
      frameTime: base,
    });
    // awaitProceduralReady drives the camera; restore the exact evidence pose.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        cfg.camera.lon,
        cfg.camera.lat,
        cfg.camera.alt,
      ),
      orientation: {
        heading: C.Math.toRadians(cfg.camera.headingDeg),
        pitch: C.Math.toRadians(cfg.camera.pitchDeg),
        roll: 0.0,
      },
    });

    // P1 — bounded render-measure-check. Exit as soon as the density field the
    // lane is supposed to time is BOTH realized (baked lanes: the shader's own
    // quality flags show the planet-domain BAKED branch, backed by realized
    // noise textures with a mip chain) and VISIBLE (the rendered canvas carries
    // real cloud). Never spin: `OCCUPANCY_MAX_FRAMES` caps it and the lane goes
    // structurally invalid instead of timing an empty march.
    let bestCells = 0;
    let bestMeanLum = 0;
    let anyReadable = false;
    let anyNonBlack = false;
    let waited = 0;
    let realized = densityRealization();
    for (; waited < cfg.occupancyMaxFrames; waited++) {
      // Pinned at `base` on EVERY lane: a variable readiness duration must not
      // shift the measured clock sequence (see `jdAt`).
      s.render(base);
      const shot = measureCanvas(); // same task as the render — do not await first
      realized = densityRealization();
      if (shot.readable) anyReadable = true;
      if (shot.meanLum > 0) anyNonBlack = true;
      if (shot.cells > bestCells) bestCells = shot.cells;
      if (shot.meanLum > bestMeanLum) bestMeanLum = shot.meanLum;
      const densityReady =
        !cfg.requireBakedDensity ||
        (realized.noiseBaked &&
          realized.noiseResourcesPresent &&
          realized.shapeMipLevelCount > 0 &&
          realized.detailMipLevelCount > 0 &&
          realized.bakedBitSet &&
          realized.planetDensityBitSet);
      if (densityReady && shot.cells >= cfg.occupancyMinCells) {
        break;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const ok = waited < cfg.occupancyMaxFrames;
    // Distinguish "the scene really is empty" from "the in-page readback is
    // broken", so a timeout is diagnosable without a second run.
    let reason = "ok";
    if (!ok) {
      if (!anyReadable) {
        reason = "canvas-readback-unavailable";
      } else if (!anyNonBlack) {
        reason = "canvas-readback-all-zero";
      } else if (bestCells < cfg.occupancyMinCells) {
        reason = "scene-never-occupied";
      } else {
        reason = "density-never-realized";
      }
    }
    occupancy = {
      ok,
      reason,
      waitedFrames: waited,
      maxFrames: cfg.occupancyMaxFrames,
      minCells: cfg.occupancyMinCells,
      bestCells,
      bestMeanLum: +bestMeanLum.toFixed(3),
      requireBakedDensity: cfg.requireBakedDensity === true,
      realization: realized,
    };
    if (device) await device.queue.onSubmittedWorkDone();

    // P2 round 2 — arm and DIAGNOSE the env-cube fill before measuring. Renders
    // (pinned at `base`, so the measured clock walk is untouched) until at
    // least `requireEnvFills` fills have demonstrably executed, recording which
    // input each one consumed. A future regression therefore names itself:
    // "no fill, hasOwner=false" is a missing owner, "no fill, lastUsedCloudMarch
    // =false" is the relevance gate, "no fill, iblRevision static" is the
    // publish-side debounce.
    if (cfg.requireEnvFills > 0) {
      let previous = envSnapshot();
      const observed = [];
      let armFrames = 0;
      for (; armFrames < cfg.envFillMaxFrames; armFrames++) {
        s.render(base);
        const current = envSnapshot();
        const changed =
          current.lastCloudRevision !== previous.lastCloudRevision ||
          current.lastSunDirX !== previous.lastSunDirX ||
          current.lastCloudCoverage !== previous.lastCloudCoverage ||
          (previous.needsUpdate === true && current.needsUpdate === false);
        if (changed) {
          observed.push({
            frame: armFrames,
            ...attributeFill(previous, current),
          });
        }
        previous = current;
        if (observed.length >= cfg.requireEnvFills) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      envFills = {
        ok: observed.length >= cfg.requireEnvFills,
        required: cfg.requireEnvFills,
        observedCount: observed.length,
        armFrames,
        maxFrames: cfg.envFillMaxFrames,
        observed,
        finalSnapshot: previous,
      };
      if (device) await device.queue.onSubmittedWorkDone();
    }
  }

  // Warm-up: compile pipelines, settle reconstruction history.
  for (let i = 0; i < cfg.warmFrames; i++) {
    s.render(jdAt(i));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (device) await device.queue.onSubmittedWorkDone();

  // Arm the opt-in timestamp profiler, then render exactly one rolling window.
  globalThis.CesiumDebug.gpuPassCost(true);
  for (let i = 0; i < cfg.measureFrames; i++) {
    s.render(jdAt(cfg.warmFrames + i));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (device) await device.queue.onSubmittedWorkDone();
  // Timestamp readback is mapAsync-based and settles a few frames late.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const results = ctx.timestampProfiler?.getResults?.() ?? null;
  globalThis.CesiumDebug.gpuPassCost(false);

  const passes = {};
  for (const name of cfg.passNames) {
    const timing = results?.passes?.[name];
    passes[name] = timing
      ? {
          avgMs: timing.avgMs,
          minMs: timing.minMs,
          maxMs: timing.maxMs,
          lastMs: timing.lastMs,
        }
      : null;
  }

  // Render one unmeasured frame so the Playwright canvas-element screenshot
  // taken after this call has live content. Never use canvas.toDataURL here —
  // the WebGPU presentation texture may already be relinquished.
  s.render(jdAt(cfg.warmFrames + cfg.measureFrames));

  return {
    readiness,
    occupancy,
    envFills,
    env: envSnapshot(),
    density: densityRealization(),
    realization: globalThis.__cloudProbe.proceduralRealization(),
    passes,
    profiler: results
      ? {
          enabled: results.enabled,
          frameCount: results.frameCount,
          attemptedFrameCount: results.attemptedFrameCount,
          droppedPassCount: results.droppedPassCount,
          readbackSkipCount: results.readbackSkipCount,
          failedReadbackCount: results.failedReadbackCount,
          coverageRatio: results.coverageRatio,
          observedPassNames: Object.keys(results.passes ?? {}),
        }
      : null,
    hasDevice: !!device,
  };
};

const HIDE_CHROME = `
  #rendererToolbar,
  .cesium-viewer-toolbar,
  .cesium-viewer-animationContainer,
  .cesium-viewer-timelineContainer,
  .cesium-viewer-fullscreenContainer,
  .cesium-viewer-bottom,
  .cesium-navigation-help {
    display: none !important;
  }
`;

async function runLane(browser, lane) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const gpuConsoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await installCloudProbeHarnessOnPage(page);
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      { waitUntil: "networkidle", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 60_000,
    });
    const armState = await armWebGPUDevices(page);
    const setup = await page.evaluate(SETUP, {
      volumetric: lane.volumetric,
      camera: CAMERA,
      iso: CLOCK_ISO,
      cloudsInReflections: lane.cloudsInReflections === true,
      envMapOwnerModel: lane.envMapOwnerModel ?? null,
      envOwnerMaxFrames: ENV_OWNER_MAX_FRAMES,
    });

    const repeatRecords = [];
    // FIXED clock schedule: repeat 0 consumes WARM_FRAMES + MEASURE_FRAMES + 1
    // (the final unmeasured screenshot frame), later repeats
    // REPEAT_WARM_FRAMES + MEASURE_FRAMES + 1. Derived from constants only —
    // never from how long readiness happened to take — so both A/B runs walk
    // the identical clock sequence.
    let frameOffset = 0;
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      const warmFrames = repeat === 0 ? WARM_FRAMES : REPEAT_WARM_FRAMES;
      repeatRecords.push(
        await page.evaluate(MEASURE, {
          iso: CLOCK_ISO,
          clockStepSeconds: lane.clockStepSeconds,
          frameOffset,
          camera: CAMERA,
          warmFrames,
          measureFrames: MEASURE_FRAMES,
          passNames: lane.passes,
          awaitReady: repeat === 0,
          requireBakedDensity: lane.requireBakedDensity === true,
          occupancyMaxFrames: OCCUPANCY_MAX_FRAMES,
          occupancyMinCells: OCCUPANCY_MIN_CELLS,
          qfNoiseBaked: QF_NOISE_BAKED,
          qfPlanetDensity: QF_PLANET_DENSITY,
          requireEnvFills: lane.requireEnvFills ?? 0,
          envFillMaxFrames: ENV_FILL_MAX_FRAMES,
        }),
      );
      frameOffset += warmFrames + MEASURE_FRAMES + 1;
    }

    await page.addStyleTag({ content: HIDE_CHROME });
    const pngBuffer = await page
      .locator(".cesium-widget canvas")
      .first()
      .screenshot();
    const pngPath = `${OUT}/c13-39-${TAG}-${lane.id}.png`;
    fs.writeFileSync(pngPath, pngBuffer);
    const fingerprint = { ...(await lumStats(pngBuffer)), png: pngPath };

    const gate = await collectGateErrors(page);
    const errors = [
      ...new Set([
        ...gpuConsoleErrors,
        ...(gate.errors || []),
        ...(gate.deviceLost ? [gate.deviceLost] : []),
        ...(armState.found < 1
          ? ["WebGPU error gate did not find a device"]
          : []),
      ]),
    ].filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));

    // Aggregate: median across repeats of each repeat's rolling-window average.
    const passes = {};
    for (const name of lane.passes) {
      const present = repeatRecords
        .map((r) => r.passes[name])
        .filter((p) => p !== null && p !== undefined);
      // P2 — a pass that never executed cannot be timed. Lanes whose consumer
      // is edge-triggered declare a floor so a silent 0/N (or a thin 1/N) is a
      // STRUCTURAL failure instead of a recorded number.
      const required = lane.minPresentRepeats?.[name] ?? 1;
      passes[name] = {
        medianAvgMs: median(present.map((p) => p.avgMs)),
        medianMinMs: median(present.map((p) => p.minMs)),
        medianMaxMs: median(present.map((p) => p.maxMs)),
        repeatAvgMs: repeatRecords.map((r) => r.passes[name]?.avgMs ?? null),
        presentRepeats: present.length,
        requiredRepeats: required,
        totalRepeats: REPEATS,
        sufficient: present.length >= required,
      };
    }

    const occupancy = repeatRecords[0]?.occupancy ?? null;
    const envFills = repeatRecords[0]?.envFills ?? null;
    const optInOk =
      lane.cloudsInReflections !== true ||
      (setup.cloudsInReflectionsActive === true &&
        (repeatRecords[0]?.density?.iblCoverage ?? 0) > 0);
    // The owner is the precondition for the relevance gate even mattering.
    const envOwnerOk =
      !lane.envMapOwnerModel ||
      (setup.envOwner?.ready === true &&
        setup.envOwner?.hasManager === true &&
        setup.envOwner?.managerEnabled === true);
    const envFillsOk = !(lane.requireEnvFills > 0) || envFills?.ok === true;

    return {
      id: lane.id,
      description: lane.description,
      volumetric: lane.volumetric,
      camera: CAMERA,
      clock: { iso: CLOCK_ISO, stepSeconds: lane.clockStepSeconds },
      expect: lane.expect,
      requireBakedDensity: lane.requireBakedDensity === true,
      timestampSupported: setup.timestampSupported,
      configTruth: setup.configTruth,
      cloudsInReflections: {
        requested: setup.cloudsInReflectionsRequested === true,
        active: setup.cloudsInReflectionsActive === true,
        publishedIblCoverage: repeatRecords[0]?.density?.iblCoverage ?? null,
        ok: optInOk,
      },
      envMapOwner: {
        requested: !!lane.envMapOwnerModel,
        url: lane.envMapOwnerModel ?? null,
        ...(setup.envOwner ?? {}),
        ok: envOwnerOk,
      },
      envFills,
      env: repeatRecords[repeatRecords.length - 1]?.env ?? null,
      readiness: repeatRecords[0]?.readiness ?? null,
      occupancy,
      density: repeatRecords[repeatRecords.length - 1]?.density ?? null,
      realization: repeatRecords[repeatRecords.length - 1]?.realization ?? null,
      profiler: repeatRecords.map((r) => r.profiler),
      fingerprint,
      passes,
      errors,
      valid:
        setup.timestampSupported === true &&
        setup.configTruth?.ok === true &&
        repeatRecords[0]?.readiness?.ok === true &&
        repeatRecords[0]?.hasDevice === true &&
        occupancy?.ok === true &&
        optInOk &&
        envOwnerOk &&
        envFillsOk &&
        errors.length === 0 &&
        fingerprint.cloudCells > OCCUPANCY_MIN_CELLS &&
        lane.passes.every((name) => passes[name].sufficient),
      adapterInfo: setup.adapterInfo,
      canvas: setup.canvas,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function compare(current, other) {
  const comparable =
    other.manifestVersion === current.manifestVersion &&
    current.pairId !== null &&
    other.pairId === current.pairId &&
    JSON.stringify(other.environment?.adapterInfo) ===
      JSON.stringify(current.environment.adapterInfo) &&
    other.environment?.browserVersion === current.environment.browserVersion &&
    JSON.stringify(other.environment?.canvas) ===
      JSON.stringify(current.environment.canvas) &&
    JSON.stringify(other.measurement) === JSON.stringify(current.measurement) &&
    typeof other.source?.runtimeBundle?.sha256 === "string" &&
    other.source.runtimeBundle.sha256 !== current.source.runtimeBundle.sha256;
  if (!comparable) {
    return {
      status: "noncomparable-companion",
      reason:
        "manifest version, pair id, adapter, browser, canvas, measurement " +
        "settings must match and the two runtime bundles must differ",
    };
  }

  const pre = current.tag === "pre" ? current : other;
  const post = current.tag === "post" ? current : other;
  const lanes = [];
  for (const postLane of post.lanes) {
    const preLane = pre.lanes.find((l) => l.id === postLane.id);
    if (!preLane) continue;
    const sameConfig =
      JSON.stringify(preLane.volumetric) ===
        JSON.stringify(postLane.volumetric) &&
      JSON.stringify(preLane.camera) === JSON.stringify(postLane.camera) &&
      JSON.stringify(preLane.clock) === JSON.stringify(postLane.clock);
    const passes = {};
    for (const name of Object.keys(postLane.passes)) {
      const a = preLane.passes[name]?.medianAvgMs ?? null;
      const b = postLane.passes[name]?.medianAvgMs ?? null;
      const expect = postLane.expect?.[name] ?? "unstated";
      if (a === null || b === null) {
        passes[name] = { preMs: a, postMs: b, expect, status: "missing" };
        continue;
      }
      const deltaMs = +(b - a).toFixed(6);
      const deltaPct = a > 0 ? +((deltaMs / a) * 100).toFixed(2) : null;
      // 2% band absorbs run-to-run GPU noise; a control lane must stay inside
      // it, a "faster" lane must fall below it, a "no-regression" lane must not
      // rise above it.
      let status = "unstated";
      if (expect === "unchanged") {
        status = Math.abs(deltaPct ?? 0) <= 2 ? "ok" : "moved";
      } else if (expect === "faster") {
        status = deltaPct !== null && deltaPct < -2 ? "ok" : "no-win";
      } else if (expect === "no-regression") {
        status = deltaPct !== null && deltaPct <= 2 ? "ok" : "regressed";
      }
      passes[name] = { preMs: a, postMs: b, deltaMs, deltaPct, expect, status };
    }
    lanes.push({
      id: postLane.id,
      sameConfig,
      bothValid: preLane.valid === true && postLane.valid === true,
      fingerprint: {
        preMeanLum: preLane.fingerprint.meanLum,
        postMeanLum: postLane.fingerprint.meanLum,
        preCloudCells: preLane.fingerprint.cloudCells,
        postCloudCells: postLane.fingerprint.cloudCells,
        cloudCellRatio: +(
          postLane.fingerprint.cloudCells /
          Math.max(1, preLane.fingerprint.cloudCells)
        ).toFixed(4),
      },
      passes,
    });
  }
  return { status: "compared", lanes };
}

async function run() {
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
  const selected = LANE_FILTER.length
    ? LANES.filter((l) => LANE_FILTER.includes(l.id))
    : LANES;
  if (selected.length === 0) {
    throw new Error(`C13_39_LANES matched no lane: ${LANE_FILTER.join(",")}`);
  }

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  try {
    const lanes = [];
    for (const lane of selected) {
      console.log(`[c13-39-perf:${TAG}] lane ${lane.id} ...`);
      lanes.push(await runLane(browser, lane));
    }

    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      tag: TAG,
      pairId: PAIR_ID,
      source,
      environment: {
        browserVersion: browser.version(),
        adapterInfo: lanes[0]?.adapterInfo ?? null,
        canvas: lanes[0]?.canvas ?? null,
        viewport: { width: W, height: H },
      },
      measurement: {
        kind: "webgpu-timestamp-query-per-pass",
        aggregate: "median-across-repeats-of-rolling-window-avgMs",
        warmFrames: WARM_FRAMES,
        measureFrames: MEASURE_FRAMES,
        repeats: REPEATS,
      },
      lanes,
    };

    const manifestPath = `${OUT}/c13-39-lod-hoist-${TAG}.json`;
    const otherTag = TAG === "pre" ? "post" : "pre";
    const otherPath = `${OUT}/c13-39-lod-hoist-${otherTag}.json`;

    let comparison = {
      status: PAIR_ID === null ? "not-requested" : "missing-companion",
      otherTag,
    };
    if (PAIR_ID !== null && fs.existsSync(otherPath)) {
      comparison = {
        ...compare(manifest, JSON.parse(fs.readFileSync(otherPath, "utf8"))),
        otherTag,
      };
    }
    manifest.comparison = comparison;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    console.log(`\n=== C13-39 lanes (${TAG}) ===`);
    for (const lane of lanes) {
      console.log(`  ${lane.id} [${lane.valid ? "VALID" : "INVALID"}]`);
      const occ = lane.occupancy;
      if (occ) {
        console.log(
          `    occupancy: ${occ.ok ? "OK" : `FAILED (${occ.reason})`} ` +
            `after ${occ.waitedFrames}/${occ.maxFrames} frames, ` +
            `bestCells ${occ.bestCells} (need ${occ.minCells}), ` +
            `bakedBit=${occ.realization.bakedBitSet} ` +
            `planetDensityBit=${occ.realization.planetDensityBitSet} ` +
            `mips ${occ.realization.shapeMipLevelCount}/${occ.realization.detailMipLevelCount}`,
        );
      }
      if (lane.cloudsInReflections.requested) {
        console.log(
          `    cloudsInReflections: active=${lane.cloudsInReflections.active} ` +
            `publishedIblCoverage=${lane.cloudsInReflections.publishedIblCoverage} ` +
            `[${lane.cloudsInReflections.ok ? "OK" : "FAILED"}]`,
        );
      }
      if (lane.envMapOwner?.requested) {
        console.log(
          `    envMapOwner: ${lane.envMapOwner.url} ready=${lane.envMapOwner.ready} ` +
            `(after ${lane.envMapOwner.waitedFrames} frames) ` +
            `hasManager=${lane.envMapOwner.hasManager} ` +
            `enabled=${lane.envMapOwner.managerEnabled} ` +
            `[${lane.envMapOwner.ok ? "OK" : "FAILED"}]` +
            `${lane.envMapOwner.error ? ` error=${lane.envMapOwner.error}` : ""}`,
        );
      }
      if (lane.envFills) {
        const f = lane.envFills;
        console.log(
          `    envFills: ${f.observedCount}/${f.required} in ${f.armFrames}/${f.maxFrames} frames ` +
            `[${f.ok ? "OK" : "FAILED"}]`,
        );
        for (const fill of f.observed.slice(0, 3)) {
          console.log(
            `      frame ${fill.frame}: ${fill.reasons.join("; ") || "(no attributable input)"}`,
          );
        }
        if (!f.ok) {
          const s = f.finalSnapshot ?? {};
          console.log(
            `      diagnosis: hasOwner=${s.hasOwner} hasManager=${s.hasManager} ` +
              `shouldUpdate=${s.managerShouldUpdate} hasManagerCache=${s.hasManagerCache} ` +
              `lastUsedCloudMarch=${s.lastUsedCloudMarch} ` +
              `iblRevision=${s.iblRevision} lastCloudRevision=${s.lastCloudRevision} ` +
              `iblCoverage=${s.iblCoverage}`,
          );
        }
      }
      console.log(
        `    canvas fingerprint: cloudCells ${lane.fingerprint.cloudCells}`,
      );
      for (const [name, stats] of Object.entries(lane.passes)) {
        console.log(
          `    ${name}: median ${stats.medianAvgMs}ms ` +
            `(min ${stats.medianMinMs} / max ${stats.medianMaxMs}, ` +
            `${stats.presentRepeats}/${stats.totalRepeats} repeats, ` +
            `need >=${stats.requiredRepeats})` +
            `${stats.sufficient ? "" : "  <-- INSUFFICIENT SAMPLES"}`,
        );
      }
      if (lane.errors.length) {
        console.log(`    errors: ${lane.errors.slice(0, 2).join(" | ")}`);
      }
    }

    let comparisonPassed = null;
    if (comparison.status === "compared") {
      console.log("\n=== A/B (post vs pre) ===");
      const checks = [];
      for (const lane of comparison.lanes) {
        console.log(`  ${lane.id}:`);
        checks.push([`${lane.id} configuration identical`, lane.sameConfig]);
        checks.push([`${lane.id} both captures valid`, lane.bothValid]);
        for (const [name, delta] of Object.entries(lane.passes)) {
          console.log(
            `    ${name}: ${delta.preMs} -> ${delta.postMs} ms ` +
              `(${delta.deltaPct ?? "n/a"}%) expect=${delta.expect} ` +
              `[${delta.status}]`,
          );
          checks.push([
            `${lane.id} / ${name} ${delta.expect}`,
            delta.status === "ok",
          ]);
        }
      }
      console.log("\n=== ANALYSIS ===");
      for (const [name, ok] of checks) {
        console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
      }
      comparisonPassed = checks.every(([, ok]) => ok);
    } else {
      console.log(
        `\n(no comparable ${otherTag} manifest: ${comparison.status}` +
          `${comparison.reason ? ` — ${comparison.reason}` : ""})`,
      );
    }

    // A missing companion is the NORMAL state of the first half of an A/B and
    // must not colour the run RED — the baseline run's only job is to produce
    // valid lanes. It IS an error for the second half: `TAG=post` without a
    // comparable `pre` manifest cannot answer the acceptance question.
    const capturesValid = lanes.every((lane) => lane.valid);
    const companionRequired = TAG === "post";
    const companionOk =
      comparison.status === "compared" ||
      (!companionRequired && comparison.status !== "noncomparable-companion");
    const pass =
      capturesValid &&
      companionOk &&
      (comparisonPassed === null || comparisonPassed);
    console.log(`\nmanifest: ${manifestPath}`);
    if (!capturesValid) {
      console.log(
        `  invalid lanes: ${lanes
          .filter((l) => !l.valid)
          .map((l) => l.id)
          .join(", ")}`,
      );
    }
    if (!companionOk) {
      console.log(
        `  companion manifest required for TAG=${TAG} but unusable: ${comparison.status}`,
      );
    }
    console.log(`RESULT: ${pass ? "GREEN" : "RED"}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

run();
