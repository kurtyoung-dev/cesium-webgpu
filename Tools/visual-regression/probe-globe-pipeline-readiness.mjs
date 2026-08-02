#!/usr/bin/env node
// probe-globe-pipeline-readiness.mjs — does the WebGPU globe's async
// pipeline-resolution skip produce user-visible holes with a HEALTHY event
// loop, and does WebGL diverge from it?
//
// ── THE MECHANISM, TRACED IN SOURCE AT BATCH 766 (2c37a3db03) ───────────────
//
// A WebGPU globe tile whose pipeline variant is not already resident in the
// central cache is NOT DRAWN AT ALL that frame:
//
//   1. `WebGPUGlobeSurfacePipelines.selectPipeline` (NOT
//      `getOrCreateTilePipeline` — no such function exists) builds a
//      renderer-local key and hands the entry to `resolveGlobePipelineEntry`
//      (same file, ~L612-647).
//   2. `resolveGlobePipelineEntry` calls
//      `pipelineCache.getPipelineSync(entry.descriptor)`. That is a pure
//      `cache.get(key)` (`WebGPURenderPipelineCache` ~L495-510) — it never
//      creates. On a miss it sets `entry.pending`, kicks off the async
//      `getPipeline()`, and RETURNS NULL. The synchronous
//      `device.createRenderPipeline` fallback below it is reachable only when
//      `host._centralPipelineCache` is absent, which is not the normal case.
//   3. `createRenderPipelineAsync` (~L531) is the only creation path.
//   4. `WebGPUGlobeSurfaceRenderer` then hits `if (!pipeline) { continue; }`
//      (~L1460) and the tile contributes nothing.
//
// WebGL has no analogue — `ShaderProgram` compiles synchronously on first use
// and there is no per-tile not-ready skip, so it draws every resident tile.
// There is no WebGPU-side fallback: no last-good pipeline, no sync fast path in
// the normal configuration, no hold-previous-frame. `Scene`'s
// `pendingAsyncResources > 0` term (~L4110-4121) forces ANOTHER frame while
// creation is inflight; that is a keep-rendering-until-they-land gate, not a
// do-not-draw-a-hole gate. The designed behaviour is "draw the hole now,
// re-render when it lands" — normally one flashed frame.
//
// ── THE QUESTION SOURCE READING CANNOT SETTLE ───────────────────────────────
//
// All of that only bites if a camera move requests a variant that is NOT
// already cached. The renderer-local key is
//   `${Q|U}${N|X}${M|G}${B|O}_${stride}${_CD?}${_NC?}|${definesHex}`
// and which of those dimensions a given camera move crosses is not determinable
// statically. So: measure it, with a healthy event loop, on both backends.
//
// This probe exists because an acceptance probe whose settle loops were fully
// SYNCHRONOUS blocked the event loop permanently — the async pipeline promise
// could never settle, so the momentary skip became a permanent one and the
// captures showed exactly the predicted transparent planet. That probe bug is
// fixed separately. The open question is reachability with a healthy loop, and
// lane (d) below reproduces the blocked-loop configuration DELIBERATELY, as a
// labelled control, to prove this instrument can see the symptom at all.
//
// ── LANES ───────────────────────────────────────────────────────────────────
//
//   (c) cold-start        BOTH backends, fresh page, cold cache by construction.
//                         The first N frames after the globe becomes visible.
//   (a) transitions       BOTH backends, healthy loop, identical scripted
//                         camera sequences:
//                           home -> 9,000 km nadir over Mexico  (the reported
//                             transition)
//                           ground (2 km) -> orbital (20,000 km)
//                           3,000 km -> 60 km  (crosses terrain/imagery LOD
//                             boundaries)
//                           globe translucency ON — flips `isBlend` AND
//                             `disableCulling` together, so it is a GUARANTEED
//                             brand-new variant pair via a public setter. It is
//                             the positive control for the variant-miss lane:
//                             if even this does not produce a miss, the local
//                             cache is being pre-warmed somewhere and the
//                             camera lanes' silence means nothing.
//   (b) parity            The same lanes, frame-index aligned across backends.
//                         Confirmed if WebGPU's globe coverage dips below
//                         WebGL's DURING a transition and recovers after.
//   (c2) invalidation     WebGPU only, healthy loop. Clears the central and
//                         renderer-local caches — the "a shader edit / define
//                         change invalidated the cache" scenario — then
//                         measures recovery frame by frame.
//   (d) CONTROL           WebGPU only. Clears the caches and then renders
//                         WITHOUT yielding. The async promise cannot settle, so
//                         the skip is permanent. If this lane does not report a
//                         coverage collapse, the instrument cannot detect the
//                         symptom and every other lane's "no divergence" is
//                         worthless — so a control that fails to arm is
//                         STRUCTURAL, never a pass.
//
// ── THE COVERAGE METRIC, AND ITS DENOMINATOR ────────────────────────────────
//
// `globeFrac` in `probe-brightness-ratio.mjs` divides by a fixed centre box, so
// its denominator includes sky and moves with the camera. Here the denominator
// is the planet's GEOMETRIC disc, recomputed every measured frame from
// `camera.pickEllipsoid` on the sample grid — a purely geometric predicate that
// does not care what was rendered. Coverage is then the fraction of those
// disc cells whose luma clears a floor. A skipped tile leaves space/starfield
// where terrain belongs, which reads as a coverage drop with the denominator
// held fixed.
//
// The sanity floor is derived from a SAME-BACKEND, SAME-LANE control — the
// settled pre-transition frame — not from an inherited constant. A settled
// globe that does not fill its own geometric disc means the metric is not
// measuring the globe, which is an unusable instrument and is reported
// STRUCTURALLY, naming that cause.
//
// ── PROBE RULES (fleet convention, all earned) ──────────────────────────────
// EVERY helper used inside a `page.evaluate` callback is defined INSIDE that
// callback — `page.evaluate` serializes the FUNCTION, not its closure.
// EVERY render loop yields (`await new Promise(r => requestAnimationFrame(r))`)
// — that is the entire point of this probe, and a synchronous loop starves both
// tile fetches and async pipeline creation.
// Readiness flags are GATES, not recorded fields.
// Canvas is read as a canvas ELEMENT in the SAME task as the render.
// Output artifacts are deleted BEFORE the run.
// Backend identity is verified (`rendererType`, `isWebGPU`, `hasDevice`).
// Lanes assert non-vacuity — a lane must be unable to pass without having been
// in the condition it claims to test.
// Bounded loops; unref'd watchdog; try/finally close; exit 0 pass / 1 gate fail
// / 2 structural.
//
// Usage: node Tools/visual-regression/probe-globe-pipeline-readiness.mjs
//   (requires the dev server on localhost:8080 and a current gulp build)

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import {
  CENTRAL_CACHE_KEY_COMPONENTS,
  MECHANISM_PINS,
  assertLaneNonVacuous,
  compareCoverageSeries,
  diffVariantKeys,
  summarizeLaneFrames,
} from "./lib/globe-pipeline-readiness.mjs";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const REPORT = path.join(OUT_DIR, "globe-pipeline-readiness-report.json");
const SHOT_PREFIX = "globe-pipeline-readiness-";

// Longer than the eclipse probe's 420 s: this one runs 6 lanes x 2 backends,
// and each lane settles the globe before it can take its warm baseline.
const HARD_LIMIT_MS = 900000;
const watchdog = setTimeout(() => {
  console.error(
    "[probe-globe-pipeline-readiness] WATCHDOG FIRED (900s) — forcing exit",
  );
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

const r3 = (x) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? null
    : Math.round(x * 1000) / 1000;

// ── Measurement constants, shared with the page as DATA ─────────────────────
const CFG = {
  // Sample grid. 64x36 = 2304 cells: one `pickEllipsoid` per cell per measured
  // frame (~2300 cheap ray-ellipsoid solves, well under a millisecond) and one
  // downscaled `getImageData` per frame instead of a full-resolution readback.
  gridW: 64,
  gridH: 36,
  // A disc cell counts as covered above this luma. A skipped tile shows space
  // or starfield, which averages far below it after the 20x downscale; drawn
  // terrain sits far above.
  coverageLumaMin: 16 / 255,
  // Frames measured per transition, after the camera is retargeted.
  transitionFrames: 90,
  // Frames measured from the moment the globe first becomes visible.
  coldFrames: 60,
  // Frames measured after a deliberate cache invalidation.
  invalidationFrames: 60,
  // Iterations of the blocked-loop CONTROL. No yields, so this is not a frame
  // count in the wall-clock sense.
  controlIterations: 40,
  // Bounded settle budgets.
  settleFrames: 300,
  // Coverage deficit (WebGL minus WebGPU) that counts as a divergence.
  minDivergence: 0.1,
  // Tail deficit allowed while still calling the divergence "recovered".
  recoveryTolerance: 0.05,
  // The same-frame-control floor: a settled globe must fill at least this much
  // of its own geometric disc or the metric is not measuring the globe.
  settledCoverageFloor: 0.5,
  // A lane needs at least this many disc cells or its denominator is too thin
  // to divide by.
  minDiscCells: 200,
};

// ── Mechanism + build provenance (Node side) ────────────────────────────────

/**
 * The mechanism pins assert the code still has the SHAPE this probe is aimed
 * at. A failure here is not "stale build" — it means someone changed or fixed
 * the traced path and the instrument's premise is gone.
 */
function checkMechanism() {
  const results = [];
  for (const pin of MECHANISM_PINS) {
    let present = false;
    let readError = null;
    try {
      present = pin.pattern.test(fs.readFileSync(pin.file, "utf8"));
    } catch (e) {
      readError = String((e && e.message) || e);
    }
    results.push({
      file: pin.file,
      name: pin.name,
      why: pin.why,
      present,
      readError,
    });
  }
  return { results, ok: results.every((r) => r.present) };
}

/**
 * Build freshness. This probe adds NO engine code, so there are no new tokens
 * to look for — the only thing that matters is that the bundle the page loads
 * is not older than the engine sources whose behaviour is being measured.
 */
function checkBuildFreshness() {
  const watched = MECHANISM_PINS.map((p) => p.file);
  let newestSourceMs = 0;
  for (const p of watched) {
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > newestSourceMs) {
        newestSourceMs = m;
      }
    } catch {
      return { ok: false, reason: `cannot stat ${p}` };
    }
  }
  const bundleDir = "Build/CesiumUnminified";
  const entry = path.join(bundleDir, "index.js");
  if (!fs.existsSync(entry)) {
    return { ok: false, reason: `${entry} missing — no build to measure` };
  }
  let newestBundleMs = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith(".js")) {
        const m = fs.statSync(full).mtimeMs;
        if (m > newestBundleMs) {
          newestBundleMs = m;
        }
      }
    }
  };
  walk(bundleDir);
  const chunks = path.join(bundleDir, "chunks");
  if (fs.existsSync(chunks)) {
    walk(chunks);
  }
  const entryMs = fs.statSync(entry).mtimeMs;
  return {
    ok: newestBundleMs >= newestSourceMs,
    newestSourceMs,
    newestBundleMs,
    entryMs,
    reason:
      newestBundleMs >= newestSourceMs
        ? null
        : "engine sources are newer than the build — rebuild before measuring",
  };
}

// ── In-page: the whole measurement for one backend ──────────────────────────
//
// One `page.evaluate` for the entire run on a backend, so every lane shares one
// warm page, one context, one device — and so the cold-start lane genuinely is
// the first thing that happens.
//
// EVERY helper below is defined INSIDE this callback. Module-scope bindings do
// not cross the serialization boundary; `cfg` and `lanes` arrive as arguments.
const MEASURE = async ({ cfg, lanes }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  // Deterministic frame pacing: the probe owns the loop.
  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  scene.requestRenderMode = false;
  scene.backgroundColor = C.Color.BLACK;

  // A pinned clock, so nothing in the scene animates between the two backends'
  // runs and frame index `i` is the same scene state on both sides.
  const PINNED = C.JulianDate.fromIso8601("2026-07-01T12:00:00Z");
  viewer.clock.currentTime = C.JulianDate.clone(PINNED);
  const T = () => viewer.clock.currentTime;

  const out = {
    rendererType: scene.context.rendererType ?? null,
    isWebGPU: scene.context.isWebGPU === true,
    hasDevice: null,
    instrument: { available: false, reason: null },
    centralKeyComponentsObserved: null,
    lanes: {},
    shots: {},
    structuralError: null,
  };

  // ── The variant instrument ────────────────────────────────────────────────
  //
  // `WebGPUGlobeSurfaceRenderer._pipelineCache` is `public` and holds
  // `{descriptor, pipeline, pending}` per variant. An entry with a null
  // `pipeline` is EXACTLY the state in which `selectPipeline` returns null and
  // the renderer `continue`s past the tile — so this is not a proxy for the
  // skip, it is the skip's own precondition read directly.
  //
  // No engine hook is added and none is needed for THAT. What genuinely does
  // not exist is a count of how many TILES were skipped: the `continue` at
  // `WebGPUGlobeSurfaceRenderer` ~L1460 increments nothing, and
  // `GlobeSurfaceTileProvider._debug.tilesRendered` counts tiles SELECTED (it
  // is incremented in `showTileThisFrame`, shared scene logic, on both
  // backends), not tiles drawn. So the probe reports selected-tile count as an
  // UPPER BOUND on tiles skipped and says so everywhere it appears.
  //
  // BOTH handles are resolved LAZILY, per call. The globe-surface feature
  // renderer and the central pipeline cache are each created on demand during
  // the first render, and this callback runs BEFORE the probe has rendered
  // anything (the viewer's own loop was suppressed at assignment time — see
  // `addInitScript` in the driver). Capturing either one up front would capture
  // `null` and silently disable every WebGPU lane, which would read as "the
  // instrument is unavailable on WebGPU" — the most misleading failure this
  // probe could produce.
  const GLOBE_SURFACE_KEY = C.FeatureRendererKey?.GLOBE_SURFACE ?? 12;
  const getLocalCache = () => {
    if (typeof scene.context.getFeatureRenderer !== "function") {
      return null;
    }
    let renderer;
    try {
      renderer = scene.context.getFeatureRenderer(GLOBE_SURFACE_KEY);
    } catch {
      return null;
    }
    return renderer && renderer._pipelineCache instanceof Map
      ? renderer._pipelineCache
      : null;
  };
  const getCentralCache = () => scene.context._webgpuPipelineCache ?? null;

  if (out.isWebGPU) {
    out.hasDevice = !!(scene.context._device ?? scene.context.device);
  } else {
    out.instrument.reason =
      "WebGL backend — the pipeline-variant instrument is WebGPU-only by " +
      "construction; this backend contributes the coverage series only";
  }

  const variantSnapshot = () => {
    const localCache = getLocalCache();
    if (localCache === null) {
      return { keys: [], notReady: 0, pending: 0, central: null };
    }
    const keys = [];
    let notReady = 0;
    let pending = 0;
    for (const [k, entry] of localCache) {
      keys.push(k);
      if (!entry || entry.pipeline === null || entry.pipeline === undefined) {
        notReady++;
      }
      if (entry && entry.pending === true) {
        pending++;
      }
    }
    let central = null;
    const centralCache = getCentralCache();
    if (centralCache && typeof centralCache.getStats === "function") {
      try {
        const s = centralCache.getStats();
        central = {
          hits: s.hits,
          misses: s.misses,
          created: s.created,
          pending: s.pending,
          size: s.size,
          evicted: s.evicted,
        };
      } catch {
        central = null;
      }
    }
    return { keys, notReady, pending, central };
  };

  // ── Coverage: geometric disc denominator, rendered-luma numerator ─────────
  const canvas = scene.canvas;
  const grid = document.createElement("canvas");
  grid.width = cfg.gridW;
  grid.height = cfg.gridH;
  const gridCtx = grid.getContext("2d", { willReadFrequently: true });
  const ellipsoid = scene.globe ? scene.globe.ellipsoid : C.Ellipsoid.WGS84;
  const pickScratch2 = new C.Cartesian2();
  const pickScratch3 = new C.Cartesian3();

  const measureCoverage = () => {
    // Denominator: which grid cells are over the planet's geometric disc.
    // `pickEllipsoid` takes CSS pixels and is independent of what rendered.
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const mask = new Uint8Array(cfg.gridW * cfg.gridH);
    let discCells = 0;
    for (let gy = 0; gy < cfg.gridH; gy++) {
      const yCss = ((gy + 0.5) / cfg.gridH) * ch;
      for (let gx = 0; gx < cfg.gridW; gx++) {
        pickScratch2.x = ((gx + 0.5) / cfg.gridW) * cw;
        pickScratch2.y = yCss;
        const hit = scene.camera.pickEllipsoid(
          pickScratch2,
          ellipsoid,
          pickScratch3,
        );
        if (hit) {
          mask[gy * cfg.gridW + gx] = 1;
          discCells++;
        }
      }
    }
    if (discCells === 0) {
      return { discCells: 0, coverage: null, discMeanLuma: null };
    }
    // Numerator: the rendered canvas, box-averaged down to the same grid in one
    // GPU-side downscale, then one small readback. Same task as the render.
    gridCtx.clearRect(0, 0, cfg.gridW, cfg.gridH);
    gridCtx.drawImage(
      canvas,
      0,
      0,
      canvas.width,
      canvas.height,
      0,
      0,
      cfg.gridW,
      cfg.gridH,
    );
    const data = gridCtx.getImageData(0, 0, cfg.gridW, cfg.gridH).data;
    let covered = 0;
    let lumaSum = 0;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      if (mask[i] === 0) {
        continue;
      }
      const luma =
        (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
      lumaSum += luma;
      if (luma > cfg.coverageLumaMin) {
        covered++;
      }
    }
    return {
      discCells,
      coverage: covered / discCells,
      discMeanLuma: lumaSum / discCells,
    };
  };

  const tilesSelected = () => {
    const surface = scene.globe?._surface;
    const arr = surface?._tilesToRender;
    return Array.isArray(arr) ? arr.length : null;
  };

  const sampleFrame = () => {
    const v = variantSnapshot();
    const cov = measureCoverage();
    return {
      t: performance.now(),
      notReady: v.notReady,
      pending: v.pending,
      variantCount: v.keys.length,
      central: v.central,
      tilesSelected: tilesSelected(),
      discCells: cov.discCells,
      coverage: cov.coverage,
      discMeanLuma: cov.discMeanLuma,
    };
  };

  const yieldFrame = () => new Promise((r) => requestAnimationFrame(r));

  const grabCanvas = () => {
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  };

  // ── Settle: a GATE, not a recorded field ─────────────────────────────────
  // Returns whether the globe reached a settled state within budget. Callers
  // treat `false` as structural for their lane and say why.
  const settle = async () => {
    for (let k = 0; k < cfg.settleFrames; k++) {
      scene.render(T());
      await yieldFrame();
      if (scene.globe && scene.globe.tilesLoaded === true && k > 12) {
        // Two extra settled frames so any pipeline kicked off by the final
        // tile batch has a chance to land before the warm baseline is taken.
        scene.render(T());
        await yieldFrame();
        scene.render(T());
        await yieldFrame();
        return true;
      }
    }
    return false;
  };

  const applyView = (view) => {
    if (view.kind === "home") {
      scene.camera.flyHome(0.0);
      return;
    }
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      orientation: {
        heading: 0.0,
        pitch: C.Math.toRadians(view.pitchDeg ?? -90.0),
        roll: 0.0,
      },
    });
  };

  // Consistent, comparable scene across backends. Kept minimal: this probe is
  // about the DEFAULT globe path, so imagery and terrain are left as the viewer
  // configured them.
  scene.sunBloom = false;
  if (scene.globe) {
    scene.globe.show = true;
  }

  // ═══ LANE (c): COLD START ════════════════════════════════════════════════
  //
  // A fresh page's pipeline cache is empty — but ONLY if nothing rendered
  // before this callback ran. The viewer starts its own render loop at
  // construction, and `page.evaluate` cannot run until well after that, so
  // "fresh page" alone does NOT give a cold cache: by the time this code
  // executes the default loop would normally have rendered dozens of frames and
  // warmed every variant the home view needs. The driver therefore intercepts
  // the `window.viewer` assignment and kills the default loop synchronously,
  // BEFORE the first animation frame.
  //
  // That is a best-effort mechanism, so its success is MEASURED, not assumed.
  // The gate below asserts both that the interception fired and that the
  // central cache is genuinely empty. A lane that starts warm is marked vacuous
  // and says so — it must never read as "cold start produced no holes".
  {
    const suppressed = window.__probeSuppressedRenderLoop === true;
    const centralAtStart = getCentralCache();
    const centralSizeAtStart =
      centralAtStart && typeof centralAtStart.getStats === "function"
        ? centralAtStart.getStats().size
        : 0;
    const localAtStart = getLocalCache();
    const localSizeAtStart = localAtStart === null ? 0 : localAtStart.size;
    out.coldness = {
      renderLoopSuppressedBeforeFirstFrame: suppressed,
      centralCacheSizeAtStart: centralSizeAtStart,
      localVariantCountAtStart: localSizeAtStart,
      genuinelyCold:
        suppressed && centralSizeAtStart === 0 && localSizeAtStart === 0,
    };

    applyView(lanes.coldStartView);
    const frames = [];
    let becameVisible = false;
    for (let k = 0; k < cfg.settleFrames && !becameVisible; k++) {
      scene.render(T());
      await yieldFrame();
      const cov = measureCoverage();
      if (cov.discCells >= cfg.minDiscCells) {
        becameVisible = true;
      }
    }
    if (!becameVisible) {
      out.structuralError =
        "the planet disc never occupied enough of the viewport to measure — " +
        "the cold-start lane has no denominator";
    } else {
      const before = variantSnapshot().keys;
      for (let k = 0; k < cfg.coldFrames; k++) {
        scene.render(T());
        frames.push(sampleFrame());
        if (k === 0) {
          out.shots.coldFirstFrame = grabCanvas();
        }
        await yieldFrame();
      }
      out.lanes.coldStart = {
        kind: "cold-start",
        coldness: out.coldness,
        variantsBefore: before,
        variantsAfter: variantSnapshot().keys,
        frames,
      };
      out.shots.coldSettled = grabCanvas();
    }
  }

  // ═══ LANE (a): TRANSITIONS ═══════════════════════════════════════════════
  // Each transition: settle at the FROM view (this is the warm baseline and the
  // same-frame control for the sanity floor), snapshot the resident variants,
  // retarget the camera, then measure a fixed number of yielding frames.
  for (const tr of lanes.transitions) {
    if (out.structuralError !== null) {
      break;
    }
    applyView(tr.from);
    const settled = await settle();
    const baseline = sampleFrame();
    const before = variantSnapshot().keys;

    // `translucency` is a public setter that flips `isBlend` AND
    // `disableCulling` together — the guaranteed-new-variant positive control.
    // Restored at the end of the lane so it cannot leak into the next one.
    let restoreTranslucency = null;
    if (tr.enableTranslucency === true && scene.globe?.translucency) {
      restoreTranslucency = {
        enabled: scene.globe.translucency.enabled,
        frontFaceAlpha: scene.globe.translucency.frontFaceAlpha,
      };
      scene.globe.translucency.enabled = true;
      scene.globe.translucency.frontFaceAlpha = 0.5;
    }
    if (tr.to) {
      applyView(tr.to);
    }

    const frames = [];
    for (let k = 0; k < cfg.transitionFrames; k++) {
      scene.render(T());
      frames.push(sampleFrame());
      if (k === 0) {
        out.shots[`${tr.name}-first`] = grabCanvas();
      }
      await yieldFrame();
    }
    out.shots[`${tr.name}-last`] = grabCanvas();

    if (restoreTranslucency !== null) {
      scene.globe.translucency.enabled = restoreTranslucency.enabled;
      scene.globe.translucency.frontFaceAlpha =
        restoreTranslucency.frontFaceAlpha;
      scene.render(T());
      await yieldFrame();
    }

    out.lanes[tr.name] = {
      kind: "transition",
      settled,
      baseline,
      variantsBefore: before,
      variantsAfter: variantSnapshot().keys,
      frames,
    };
  }

  // ═══ LANE (c2) + (d): WEBGPU-ONLY CACHE-INVALIDATION LANES ═══════════════
  // Instrument availability is decided HERE, after the transition lanes have
  // rendered — by which point both lazily-created handles exist if they are
  // ever going to. Deciding it at callback entry (before any render) would
  // always have said "unavailable".
  const centralCache = getCentralCache();
  const localCache = getLocalCache();
  if (out.isWebGPU) {
    if (localCache === null) {
      out.instrument.reason =
        "WebGPU context exposes no globe-surface renderer _pipelineCache Map " +
        "even after rendering — the variant instrument cannot be read without " +
        "an engine hook";
    } else if (centralCache === null) {
      out.instrument.reason =
        "WebGPU context exposes no _webgpuPipelineCache even after rendering — " +
        "the invalidation and control lanes cannot arm";
    } else {
      out.instrument.available = true;
    }
  }
  if (out.instrument.available && out.structuralError === null) {
    // Both lanes start from the same settled state so their baselines are
    // comparable with each other.
    const armFrom = lanes.invalidationView;

    // ── (c2) invalidation with a HEALTHY loop ──────────────────────────────
    // This is the "a shader edit or define change wiped the cache" scenario,
    // reproduced through the caches' own public `clear()` rather than by
    // editing engine code. Both caches must go: clearing only the central one
    // leaves the renderer-local entries holding already-resolved
    // `GPURenderPipeline` handles, and `resolveGlobePipelineEntry` returns
    // `entry.pipeline` before it ever consults the central cache.
    applyView(armFrom);
    const settledA = await settle();
    const baselineA = sampleFrame();
    const beforeA = variantSnapshot().keys;
    centralCache.clear();
    localCache.clear();
    const framesA = [];
    for (let k = 0; k < cfg.invalidationFrames; k++) {
      scene.render(T());
      framesA.push(sampleFrame());
      if (k === 0) {
        out.shots["invalidation-first"] = grabCanvas();
      }
      await yieldFrame();
    }
    out.shots["invalidation-last"] = grabCanvas();
    out.lanes.invalidation = {
      kind: "invalidation",
      settled: settledA,
      baseline: baselineA,
      variantsBefore: beforeA,
      variantsAfter: variantSnapshot().keys,
      frames: framesA,
    };

    // ── (d) CONTROL: the blocked event loop ────────────────────────────────
    // DELIBERATELY SYNCHRONOUS. This is the ONE loop in this file that does not
    // yield, and it is the configuration that produced the original transparent
    // -planet captures: with the event loop starved, the
    // `createRenderPipelineAsync` promise can never settle, so the momentary
    // skip becomes permanent.
    //
    // Its job is to prove this instrument CAN see the symptom. A lane that
    // reports "no divergence" without the instrument ever having demonstrated
    // it can detect one proves nothing — so if this control does not collapse,
    // the whole run is structural.
    //
    // Readback is same-task and synchronous (`drawImage` + `getImageData`), so
    // it works without yielding.
    applyView(armFrom);
    const settledB = await settle();
    const baselineB = sampleFrame();
    centralCache.clear();
    localCache.clear();
    const framesB = [];
    for (let k = 0; k < cfg.controlIterations; k++) {
      scene.render(T());
      framesB.push(sampleFrame());
    }
    out.shots["control-blocked"] = grabCanvas();
    out.lanes.controlBlockedLoop = {
      kind: "control",
      control: true,
      settled: settledB,
      baseline: baselineB,
      frames: framesB,
    };

    // Recovery after the control, WITH yields — proves the collapse was the
    // blocked loop and not a permanently broken context, which would otherwise
    // contaminate nothing (the control is last) but would still be worth
    // knowing.
    const framesC = [];
    for (let k = 0; k < cfg.invalidationFrames; k++) {
      scene.render(T());
      framesC.push(sampleFrame());
      await yieldFrame();
    }
    out.shots["control-recovered"] = grabCanvas();
    out.lanes.controlRecovery = {
      kind: "control-recovery",
      control: true,
      frames: framesC,
    };
  }

  // Record the central cache's key-component surface as OBSERVED, so the report
  // states the real list rather than a remembered one.
  const finalCentral = getCentralCache();
  if (
    finalCentral &&
    typeof finalCentral.getCachedPipelineNames === "function"
  ) {
    try {
      const names = finalCentral.getCachedPipelineNames();
      out.centralKeyComponentsObserved = {
        cachedPipelineNameSample: names.filter((n) =>
          String(n).startsWith("Globe terrain"),
        ),
      };
    } catch {
      out.centralKeyComponentsObserved = null;
    }
  }

  return out;
};

// ── Playwright driver ───────────────────────────────────────────────────────
async function runBackend(browser, renderer, lanes) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  // Kill the viewer's own render loop at the instant it is published, BEFORE
  // any animation frame runs. `Apps/CesiumViewer/CesiumViewer.js` publishes via
  // a plain `window.viewer = ...` assignment, so a property setter installed
  // here intercepts it synchronously. Without this the cold-start lane is not
  // cold: `page.evaluate` cannot run until long after the viewer has been
  // constructed, by which point the default loop has already warmed the cache
  // for the home view. The lane MEASURES whether this worked (`__probeSuppressed
  // RenderLoop`) rather than assuming it.
  await page.addInitScript(() => {
    let stored;
    window.__probeSuppressedRenderLoop = false;
    Object.defineProperty(window, "viewer", {
      configurable: true,
      get: () => stored,
      set: (next) => {
        stored = next;
        try {
          next.useDefaultRenderLoop = false;
          next.scene.requestRenderMode = false;
          window.__probeSuppressedRenderLoop = true;
        } catch {
          window.__probeSuppressedRenderLoop = false;
        }
      },
    });
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });
  const out = { renderer, consoleErrors };
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );

    out.measured = await page.evaluate(MEASURE, { cfg: CFG, lanes });

    // Write the in-task canvas grabs from Node.
    out.shotsWritten = [];
    for (const [key, dataUrl] of Object.entries(out.measured?.shots ?? {})) {
      if (
        typeof dataUrl !== "string" ||
        !dataUrl.startsWith("data:image/png")
      ) {
        continue;
      }
      const file = path.join(OUT_DIR, `${SHOT_PREFIX}${renderer}-${key}.png`);
      fs.writeFileSync(
        file,
        Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
      );
      out.shotsWritten.push(file.replaceAll("\\", "/"));
    }
    if (out.measured) {
      delete out.measured.shots;
    }

    // Backend identity — a silent WebGL fallback would make the parity lane
    // read as passing.
    const t = out.measured?.rendererType;
    if (t !== renderer) {
      out.backendMismatch = `requested ${renderer}, context reports ${t}`;
    }
    if (renderer === "webgpu") {
      if (out.measured?.isWebGPU !== true) {
        out.backendMismatch =
          (out.backendMismatch ? `${out.backendMismatch}; ` : "") +
          "context.isWebGPU is not true";
      }
      if (out.measured?.hasDevice !== true) {
        out.backendMismatch =
          (out.backendMismatch ? `${out.backendMismatch}; ` : "") +
          "no GPUDevice on the context";
      }
    }
    return out;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 400);
    return out;
  } finally {
    await context.close().catch(() => {});
  }
}

// ── Lane definitions (data — crosses the serialization boundary) ────────────
const LANES = {
  coldStartView: { kind: "home" },
  transitions: [
    {
      // The reported transition, verbatim.
      name: "home-to-mexico-nadir",
      from: { kind: "home" },
      to: {
        kind: "geo",
        lon: -102.0,
        lat: 23.0,
        height: 9_000_000,
        pitchDeg: -90,
      },
    },
    {
      name: "ground-to-orbital",
      from: {
        kind: "geo",
        lon: -102.0,
        lat: 23.0,
        height: 2_000,
        pitchDeg: -35,
      },
      to: {
        kind: "geo",
        lon: -102.0,
        lat: 23.0,
        height: 20_000_000,
        pitchDeg: -90,
      },
    },
    {
      // Descends through many terrain/imagery LOD boundaries at once.
      name: "lod-descend",
      from: {
        kind: "geo",
        lon: -102.0,
        lat: 23.0,
        height: 3_000_000,
        pitchDeg: -90,
      },
      to: {
        kind: "geo",
        lon: -102.0,
        lat: 23.0,
        height: 60_000,
        pitchDeg: -90,
      },
    },
    {
      // Positive control for the variant instrument: `translucency.enabled`
      // flips `isBlend` and `disableCulling` together, so a brand-new variant
      // pair is requested with certainty. The camera does not move.
      name: "translucency-toggle",
      from: {
        kind: "geo",
        lon: -102.0,
        lat: 23.0,
        height: 9_000_000,
        pitchDeg: -90,
      },
      to: null,
      enableTranslucency: true,
    },
  ],
  invalidationView: {
    kind: "geo",
    lon: -102.0,
    lat: 23.0,
    height: 9_000_000,
    pitchDeg: -90,
  },
};

// ── Verdict ─────────────────────────────────────────────────────────────────
function judgeBackend(measured) {
  const v = { lanes: {}, structuralReasons: [] };
  if (!measured || !measured.lanes) {
    v.structuralReasons.push("backend produced no lane data");
    return v;
  }
  for (const [name, lane] of Object.entries(measured.lanes)) {
    const summary = summarizeLaneFrames(lane.frames);
    const variantDiff = diffVariantKeys(
      lane.variantsBefore ?? [],
      lane.variantsAfter ?? [],
    );

    // Denominator gate — a lane whose disc left the viewport cannot measure.
    const minDisc = (lane.frames ?? []).reduce(
      (m, f) => (Number.isFinite(f?.discCells) ? Math.min(m, f.discCells) : m),
      Infinity,
    );
    if (Number.isFinite(minDisc) && minDisc < CFG.minDiscCells) {
      v.structuralReasons.push(
        `${name}: the planet disc shrank to ${minDisc} sample cells (floor ` +
          `${CFG.minDiscCells}) — the coverage denominator is too thin to ` +
          `divide by, so this lane's numbers are not measurements`,
      );
    }

    // Sanity floor from the SAME-LANE, SAME-BACKEND settled control, not an
    // inherited constant. A settled globe that does not fill its own geometric
    // disc means the metric is not measuring the globe.
    if (lane.baseline && Number.isFinite(lane.baseline.coverage)) {
      if (lane.baseline.coverage < CFG.settledCoverageFloor) {
        v.structuralReasons.push(
          `${name}: settled baseline coverage ${r3(lane.baseline.coverage)} is ` +
            `below ${CFG.settledCoverageFloor} — a fully-settled globe is not ` +
            `filling its own geometric disc, so the coverage metric is not ` +
            `measuring the globe and this lane is unusable as an instrument`,
        );
      }
    }
    if (lane.settled === false) {
      v.structuralReasons.push(
        `${name}: the globe never reached tilesLoaded before the transition — ` +
          `the pre-transition variant snapshot is not a warm baseline`,
      );
    }

    // The cold-start lane is the one lane whose precondition cannot be
    // arranged, only observed. If the render loop was not suppressed in time,
    // or a cache was already populated, the lane started WARM — and a warm lane
    // reporting "no holes" says nothing about a cold start. Reported as
    // vacuous, never as a clean result.
    if (lane.kind === "cold-start") {
      v.coldness = lane.coldness ?? null;
      if (lane.coldness && lane.coldness.genuinelyCold !== true) {
        v.lanes[name] = { kind: lane.kind, summary, vacuous: true };
        v.coldStartVacuousBecause =
          `the lane did not start from a cold cache (loop suppressed: ` +
          `${lane.coldness.renderLoopSuppressedBeforeFirstFrame}, central ` +
          `cache size at start: ${lane.coldness.centralCacheSizeAtStart}, ` +
          `resident globe variants at start: ` +
          `${lane.coldness.localVariantCountAtStart}) — its result cannot be ` +
          `read as evidence about cold-start behaviour`;
        continue;
      }
    }

    v.lanes[name] = {
      kind: lane.kind,
      summary,
      variantDiff: {
        added: variantDiff.added,
        addedParsed: variantDiff.addedParsed,
        unparsed: variantDiff.unparsed,
        beforeCount: variantDiff.beforeCount,
        afterCount: variantDiff.afterCount,
      },
      baselineCoverage: r3(lane.baseline?.coverage),
    };
  }
  return v;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Delete this probe's artifacts BEFORE the run. A stale PNG read as fresh
  // produced a confident false conclusion in this campaign; nothing that
  // survives from a previous run may be read as evidence from this one.
  const removed = [];
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name.startsWith(SHOT_PREFIX) || name === path.basename(REPORT)) {
      fs.rmSync(path.join(OUT_DIR, name), { force: true });
      removed.push(name);
    }
  }

  const mechanism = checkMechanism();
  if (!mechanism.ok) {
    console.error(
      "[probe-globe-pipeline-readiness] MECHANISM PIN FAILURE — the traced " +
        "code path no longer has the shape this probe measures. Either it was " +
        "fixed (in which case this probe's premise is gone and it needs " +
        "rewriting) or it was refactored (in which case re-verify and update " +
        "the pins). Results from this run would be meaningless.\n" +
        JSON.stringify(
          mechanism.results.filter((r) => !r.present),
          null,
          2,
        ),
    );
    process.exit(2);
  }
  const freshness = checkBuildFreshness();
  if (!freshness.ok) {
    console.error(
      "[probe-globe-pipeline-readiness] BUILD FRESHNESS FAILURE:",
      JSON.stringify(freshness, null, 2),
    );
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let gl, gpu;
  try {
    gl = await runBackend(browser, "webgl", LANES);
    gpu = await runBackend(browser, "webgpu", LANES);
  } finally {
    await browser.close().catch(() => {});
  }

  const structuralReasons = [];
  for (const side of [gl, gpu]) {
    if (side?.error) {
      structuralReasons.push(`${side.renderer}: ${side.error}`);
    }
    if (side?.backendMismatch) {
      structuralReasons.push(`${side.renderer}: ${side.backendMismatch}`);
    }
    if (side?.measured?.structuralError) {
      structuralReasons.push(
        `${side.renderer}: ${side.measured.structuralError}`,
      );
    }
  }
  // Without the WebGPU variant instrument there is no control lane, no
  // invalidation lane, and no attribution for any parity row — the run cannot
  // answer its own question. Said plainly here rather than surfacing later as a
  // confusing "the control did not collapse".
  if (
    structuralReasons.length === 0 &&
    gpu?.measured?.instrument?.available !== true
  ) {
    structuralReasons.push(
      `webgpu: the pipeline-variant instrument is unavailable (` +
        `${gpu?.measured?.instrument?.reason ?? "no reason recorded"}) — ` +
        `without it the control cannot arm and no coverage deficit can be ` +
        `attributed, so this run cannot answer its question`,
    );
  }

  const verdicts = {};
  if (structuralReasons.length === 0) {
    verdicts.webgl = judgeBackend(gl.measured);
    verdicts.webgpu = judgeBackend(gpu.measured);
    structuralReasons.push(...verdicts.webgl.structuralReasons);
    structuralReasons.push(...verdicts.webgpu.structuralReasons);
  }

  let anyFail = false;
  if (structuralReasons.length === 0) {
    // ── (d) THE CONTROL DECIDES WHETHER ANYTHING ELSE COUNTS ───────────────
    // If the deliberately-blocked lane did not collapse, this instrument has
    // not demonstrated it can detect the symptom, and every "no divergence"
    // elsewhere is unearned. That is structural, not a pass and not a fail.
    const ctl = verdicts.webgpu.lanes.controlBlockedLoop;
    const ctlNonVacuous = assertLaneNonVacuous(
      ctl?.summary,
      ctl?.variantDiff ?? { added: [] },
      { requireSkipFrame: true },
    );
    const ctlBaseline =
      gpu.measured?.lanes?.controlBlockedLoop?.baseline?.coverage ?? null;
    const ctlWorst = ctl?.summary?.minCoverage ?? null;
    const controlCollapsed =
      Number.isFinite(ctlBaseline) &&
      Number.isFinite(ctlWorst) &&
      ctlBaseline - ctlWorst >= CFG.minDivergence;
    verdicts.control = {
      baselineCoverage: r3(ctlBaseline),
      worstCoverage: r3(ctlWorst),
      collapse: r3(
        Number.isFinite(ctlBaseline) && Number.isFinite(ctlWorst)
          ? ctlBaseline - ctlWorst
          : null,
      ),
      skipFramesObserved: ctl?.summary?.skipFrames ?? null,
      peakNotReady: ctl?.summary?.peakNotReady ?? null,
      nonVacuous: ctlNonVacuous,
      collapsed: controlCollapsed,
      recoveredAfterYielding: r3(
        verdicts.webgpu.lanes.controlRecovery?.summary?.finalCoverage,
      ),
    };
    if (!controlCollapsed || !ctlNonVacuous.nonVacuous) {
      structuralReasons.push(
        "the blocked-event-loop CONTROL did not produce a coverage collapse " +
          "(or never observed an unresolved pipeline entry) — this instrument " +
          "has not demonstrated it can detect the symptom, so no other lane's " +
          "silence can be trusted: " +
          JSON.stringify(verdicts.control),
      );
    }
  }

  // ── (b) PARITY: frame-index aligned coverage, per shared lane ─────────────
  if (structuralReasons.length === 0) {
    verdicts.parity = {};
    for (const name of Object.keys(gl.measured.lanes)) {
      const a = gl.measured.lanes[name]?.frames;
      const b = gpu.measured.lanes[name]?.frames;
      if (!a || !b) {
        continue;
      }
      // A lane the judge marked vacuous carries no summary/variantDiff and must
      // not be compared — a warm "cold start" would otherwise contribute a
      // clean parity row it never earned.
      if (
        verdicts.webgpu.lanes[name]?.vacuous === true ||
        verdicts.webgl.lanes[name]?.vacuous === true
      ) {
        verdicts.parity[name] = {
          skipped: true,
          reason:
            verdicts.webgpu.coldStartVacuousBecause ??
            verdicts.webgl.coldStartVacuousBecause ??
            "lane marked vacuous",
        };
        continue;
      }
      const cmp = compareCoverageSeries(a, b, {
        minDivergence: CFG.minDivergence,
        recoveryTolerance: CFG.recoveryTolerance,
      });
      if (!cmp.aligned) {
        structuralReasons.push(`parity ${name}: ${cmp.reason}`);
        continue;
      }
      // Non-vacuity for the WebGPU side of a variant lane: a transition that
      // requested no new variant cannot speak to the mechanism, and must NOT
      // read as "measured, no divergence".
      const gpuLane = verdicts.webgpu.lanes[name];
      const armed = assertLaneNonVacuous(
        gpuLane?.summary,
        gpuLane?.variantDiff,
        {
          requireVariantMiss: name === "translucency-toggle",
        },
      );
      // ── ATTRIBUTION ────────────────────────────────────────────────────────
      // A coverage deficit is NOT automatically this mechanism. The two
      // backends run in separate page loads, so their tile streaming is on
      // independent network timelines and a lane that retargets the camera to a
      // fresh region will show coverage differences driven purely by which side
      // happened to get its tiles first. That is a race in the FIXTURE, not a
      // finding about pipeline readiness.
      //
      // The deficit is attributable to the traced skip only if the WebGPU side
      // actually held an unresolved pipeline entry while it was behind. Without
      // that overlap the row is reported as "unattributed" and cannot fail the
      // gate — it is tile-streaming noise until something says otherwise.
      const skipFrames = gpuLane?.summary?.skipFrames ?? 0;
      const skipFirst = gpuLane?.summary?.firstSkipFrameIndex ?? null;
      const skipLast = gpuLane?.summary?.lastSkipFrameIndex ?? null;
      const worstIdx = cmp.worstFrameIndex;
      const overlaps =
        skipFrames > 0 &&
        worstIdx !== null &&
        skipFirst !== null &&
        skipLast !== null &&
        worstIdx >= skipFirst &&
        worstIdx <= skipLast;
      verdicts.parity[name] = {
        ...cmp,
        worstDeficit: r3(cmp.worstDeficit),
        tailWebglCoverage: r3(cmp.tailWebglCoverage),
        tailWebgpuCoverage: r3(cmp.tailWebgpuCoverage),
        webgpuVariantsAdded: gpuLane?.variantDiff?.added?.length ?? 0,
        webgpuVariantsAddedKeys: gpuLane?.variantDiff?.added ?? [],
        webgpuSkipFrames: skipFrames,
        webgpuFirstSkipFrameIndex: skipFirst,
        webgpuLastSkipFrameIndex: skipLast,
        webgpuLongestSkipRun: gpuLane?.summary?.longestSkipRun ?? null,
        webgpuLongestSkipRunMs: r3(gpuLane?.summary?.longestSkipRunMs),
        webgpuPeakTilesAtRiskUpperBound:
          gpuLane?.summary?.peakTilesAtRisk ?? null,
        attributableToPipelineSkip: overlaps,
        attribution: overlaps
          ? "the worst-deficit frame falls inside the window in which WebGPU " +
            "held an unresolved globe pipeline entry"
          : skipFrames > 0
            ? "WebGPU did hold unresolved entries, but NOT at the worst-deficit " +
              "frame — the deficit is more likely tile-streaming timing"
            : "WebGPU never held an unresolved entry in this lane — any deficit " +
              "here is tile-streaming timing between two independent page loads, " +
              "not the pipeline-readiness skip",
        laneArmed: armed,
      };
      // The positive control for the variant instrument MUST arm. If flipping
      // translucency does not request a new variant, the local cache is being
      // pre-warmed somewhere and the camera lanes' silence means nothing.
      if (name === "translucency-toggle" && !armed.nonVacuous) {
        structuralReasons.push(
          `parity translucency-toggle: ${armed.reasons.join("; ")}`,
        );
      }
      if (cmp.persistentDivergence && overlaps) {
        // A deficit that never recovers is NOT the traced mechanism — that one
        // is transient by construction. Failed here only when it is ALSO
        // attributable, so a tile-streaming race cannot manufacture a failure.
        anyFail = true;
      }
    }
  }

  const structural = structuralReasons.length > 0;
  const GATE = structural ? "STRUCTURAL" : anyFail ? "FAIL" : "PASS";

  const report = {
    probe: "probe-globe-pipeline-readiness",
    question:
      "with a healthy event loop, does a camera transition request an uncached " +
      "globe pipeline variant often enough that WebGPU's per-tile skip produces " +
      "a visible coverage deficit against WebGL?",
    removedStaleArtifacts: removed,
    mechanism: mechanism.results,
    buildFreshness: freshness,
    centralCacheKeyComponents: CENTRAL_CACHE_KEY_COMPONENTS,
    config: CFG,
    lanes: LANES,
    backends: {
      webgl: {
        rendererType: gl?.measured?.rendererType ?? null,
        isWebGPU: gl?.measured?.isWebGPU ?? null,
        instrument: gl?.measured?.instrument ?? null,
        consoleErrors: (gl?.consoleErrors ?? []).slice(0, 8),
        shotsWritten: gl?.shotsWritten ?? [],
      },
      webgpu: {
        rendererType: gpu?.measured?.rendererType ?? null,
        isWebGPU: gpu?.measured?.isWebGPU ?? null,
        hasDevice: gpu?.measured?.hasDevice ?? null,
        instrument: gpu?.measured?.instrument ?? null,
        consoleErrors: (gpu?.consoleErrors ?? []).slice(0, 8),
        shotsWritten: gpu?.shotsWritten ?? [],
      },
    },
    verdicts,
    structuralReasons,
    // Full per-frame series, so a reader can re-derive every summary above.
    raw: {
      webgl: gl?.measured?.lanes ?? null,
      webgpu: gpu?.measured?.lanes ?? null,
    },
    GATE,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        GATE,
        structuralReasons,
        control: verdicts.control ?? null,
        parity: verdicts.parity ?? null,
        report: REPORT.replaceAll("\\", "/"),
      },
      null,
      2,
    ),
  );

  const exitCode = structural ? 2 : anyFail ? 1 : 0;
  console.log(`EXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-globe-pipeline-readiness] STRUCTURAL:", e);
  process.exit(2);
});
