#!/usr/bin/env node
/**
 * `C15-G1..G3` — Gaussian-splat probe harness, WebGL reference leg, and the
 * `--expect-webgpu` flip.
 *
 * This is the instrument every later GSPLAT row's exit gate runs through, and
 * it is deliberately DUAL-MODE. The same probe has to do two opposite jobs at
 * two different points in the track:
 *
 *   DEFAULT (C15-G1..G2): the WebGPU splat path rendered NOTHING. That was the
 *   documented `C15-G0` baseline. The probe certified the absence honestly —
 *   it printed the greppable marker `WEBGPU-SPLATS-ABSENT (expected until
 *   C15-G3)` and the overall run stayed exit 0 — but ONLY when the absence was
 *   ATTRIBUTABLE to a named, observed blocker in the scaffolded path. A blank
 *   canvas is also what a broken probe, a dead device, or an unloaded tileset
 *   looks like, so an unattributed absence exits 3, not 0.
 *
 *   `--expect-webgpu` (C15-G3+, and the mode this row's exit gate is written
 *   against): absence is a real product FAIL (exit 1), and presence is scored
 *   against the product criteria.
 *
 * WHERE THE STAGE STANDS NOW (C15-G3)
 * -----------------------------------
 * `C15-G3` retired the last two named blockers, which empties `STAGE.required`.
 * An empty required set is itself a contract: there is no absence this stage
 * knows how to certify, so a DEFAULT run is structural
 * (`webgpu:stage-requires-expect-webgpu`) no matter what it measures. The
 * probe stays dual-mode — it still collects and prints every blocker — it just
 * cannot call the result green. Run it with `--expect-webgpu`.
 *
 * THE ABSENCE CONTRACT IS STAGED, NOT A STANDING "at least one blocker"
 * -------------------------------------------------------------------
 * `C15-G2` moved the splat data pipeline above the backend branch and gave the
 * primitive a `show` accessor, which RETIRED two of the four blockers the
 * default mode used to accept; `C15-G3` retired the other two by committing
 * the WASM record into a storage buffer. A gate that only asked "was any known
 * blocker seen?" would keep printing the same green marker for a strictly
 * smaller reason and never say so. So `STAGE` in the model names both sets: a
 * retired blocker observed again is a REGRESSION (structural), and a required
 * blocker NOT observed means the absence has some other cause (also
 * structural). The stage is printed on every run next to what was measured.
 *
 * THE PARITY DIFF IS MEASURED BUT NOT GATED AT C15-G3
 * ---------------------------------------------------
 * The WGSL has NO spherical-harmonics term until `C15-G5`, and BOTH gate
 * tilesets are SH degree 3 — every splat carries a view-dependent colour the
 * WebGPU leg cannot reproduce yet. A cross-backend diff at this stage
 * therefore scores the MISSING SH, not the record decode this row ships, and
 * cannot come in under 1% / 3% however correct the decode is. So the diff is
 * still computed, still printed, still written to disk as a PNG (its magnitude
 * is the SH signal `C15-G5` has to remove) — and deliberately not folded into
 * the verdict. What gates `C15-G3` instead is the reference leg's OWN
 * structure battery applied to the WEBGPU leg — added fraction, edge fraction,
 * luminance spread, the 10x negative-control margin — plus splat-count
 * equality. The `C15-G8` thresholds are UNCHANGED; `C15-G5` flips
 * `STAGE.parity.scored` and they become the gate again.
 *
 * The flip is the whole point of the row: one instrument that cannot be
 * satisfied by the wrong world. Two blank canvases diff to 0.000% — the
 * tightest parity number this gate can print — so the parity leg REFUSES to
 * produce a number unless the WebGPU leg actually showed splats. That refusal
 * lives in `lib/gsplat-parity-model.mjs`, is executable without a browser, and
 * `gsplat-harness.spec.mjs` runs it against the plausible wrong implementation
 * of every rule.
 *
 * WHAT THE REFERENCE LEG MEASURES (and why it is not vacuous)
 * ----------------------------------------------------------
 * Not "non-black pixels" — pixels the tileset ADDED, measured against the same
 * settled scene with `tileset.show = false`. Differencing makes the metric
 * blind to a widget, a clear-colour change, or a fog band that has nothing to
 * do with splats. On top of that:
 *
 *   * NEGATIVE CONTROL, two-sided. The hidden-tileset frame must be blank, AND
 *     hiding the tileset a second time must return to that frame, AND the ON
 *     measurement must beat the control by 10x using the SAME metric on the
 *     SAME reference frame. A control that is merely "small" proves nothing
 *     when the signal is also small.
 *   * STRUCTURE. A flood fill (wrong clear colour, a full-screen quad, a
 *     composite blitting garbage) satisfies "2% of the canvas changed" while
 *     being exactly the failure this gate exists to catch. The added pixels
 *     must also carry a boundary (edge fraction) and a luminance spread.
 *   * DETERMINISM. Two captures of the same settled frame bracket the scored
 *     gap. Without that, "the tileset added N pixels" is not a resolvable
 *     measurement and every threshold below it is noise.
 *
 * WHAT `CO-12` ADDED, AND WHY THE ROW EXISTED
 * -------------------------------------------
 * `C15-G5` certified on ONE framed camera with NEITHER of the two controls its
 * own exit gate declared mandatory, and `C15-G8`'s gate text asks for lanes
 * this probe could not run at all. Three lanes close that:
 *
 *   * THREE AZIMUTHS. The same tileset orbited to headings 0 / 120 / 240 deg,
 *     each with its own hidden-tileset reference frame, its own sort
 *     quiescence and its own back-to-back determinism pair. Two anti-vacuity
 *     guards run before any mismatch is read: the recorded view directions must
 *     be the DERIVED 97.181 deg apart, and the picture must actually change
 *     between adjacent azimuths. Three captures at one camera would otherwise
 *     agree perfectly and look like the strongest possible result.
 *   * SH-OFF VACUITY CONTROL. `primitive._sphericalHarmonicsDegree` is driven
 *     to 0, which is the seam the engine already has: `resolveSplatShSource`
 *     reports `enabled: false`, `activeShEnabled` flips, and the renderer
 *     recompiles the `//>>else` variant with no SH term — the pre-`C15-G5`
 *     renderer. The cross-backend mismatch must climb back to the recorded
 *     2.574%. A run that stays at 0.000% with SH off proves the 0.000% was
 *     never measuring SH.
 *   * CORRUPTED-COVARIANCE VACUITY CONTROL. A COPY of the packed payload with
 *     one splat's covariance triple scaled 4x (and a second copy with every
 *     other splat's) is published as a new payload object, which is the
 *     engine's own producer-identity dirty signal. The picture must move. Both
 *     controls are withdrawn afterwards and the withdrawal is itself gated:
 *     an irreversible control invalidates every reading taken before it.
 *
 * Both controls are GATES at every stage, while the azimuth mismatch stays
 * recorded-not-gated until `C15-G8` — see `STAGE.controls` for why a floor and
 * a ceiling do not arm together.
 *
 * CONVENTIONS (fleet doctrine, all load-bearing)
 * ----------------------------------------------
 *   * Watchdog armed at 600 s; exceeding it exits 2, never 0.
 *   * Readiness is WALL CLOCK, never frame counts. A splat tileset round-trips
 *     two WASM workers (`gaussianSplatTextureGenerator`, `gaussianSplatSorter`)
 *     on top of a cold pipeline compile that has measured ~2674 ms on this fork.
 *   * Same-task capture: render and read the canvas element with no yield in
 *     between. A read across a rAF yield is invalid on BOTH backends.
 *   * Every helper the lane needs is defined INSIDE `page.evaluate` — the
 *     serializer drops the surrounding closure.
 *   * Warm-up capture taken and discarded before anything is scored.
 *   * Structural exit 3 for every precondition that fails: server down, tileset
 *     404, backend not the one requested, readiness budget exceeded, camera
 *     framing broken, reference frame polluted, captures non-deterministic.
 *
 * THE WEBGPU LEG'S BUDGET IS DERIVED, NOT ASSERTED
 * ------------------------------------------------
 * The WebGL leg runs first and records how long its data commit actually took.
 * The WebGPU leg then gets 4x that (floor 30 s, cap the configured budget), so
 * the absence claim reads "WebGPU was given four times the wall clock WebGL
 * needed and still committed nothing" rather than "we waited an arbitrary
 * number we picked".
 *
 * Usage (at C15-G3, always pass --expect-webgpu; default mode is structural):
 *   node Tools/visual-regression/probe-gsplat-parity.mjs --expect-webgpu
 *   node Tools/visual-regression/probe-gsplat-parity.mjs --expect-webgpu --asset=tower
 *   node Tools/visual-regression/probe-gsplat-parity.mjs --expect-webgpu --asset=both
 * Env:
 *   PROBE_BASE                  default http://localhost:8080
 *   PROBE_GSPLAT_WATCHDOG_MS    default 1200000 (raise for --asset=both)
 * Out:
 *   Tools/visual-regression/output/gsplat-parity/*.png + manifest.json
 * Exit:
 *   0 every leg decided and passed (in default mode this INCLUDES the
 *     documented WebGPU absence) | 1 a real product FAIL | 2 watchdog or
 *     exception | 3 no FAIL, but a leg could not see its subject
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  ABSENT_MARKER,
  ASSETS,
  AZIMUTH_HEADINGS,
  EXIT_CODE,
  PREDICT,
  STAGE,
  evaluateAzimuthLane,
  evaluateCovarianceControl,
  evaluateParity,
  evaluateReferenceLeg,
  evaluateShOffControl,
  evaluateWebgpuLeg,
  foldGsplatVerdict,
  fractionOf,
} from "./lib/gsplat-parity-model.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/gsplat-parity";
const VIEW = { width: 1024, height: 768 };

const EXPECT_WEBGPU = process.argv.includes("--expect-webgpu");
const HEADED = process.argv.includes("--headed");

/**
 * Camera derivation constants. The camera is derived from the tileset's OWN
 * bounding sphere — no hardcoded ECEF positions — so the same code frames a
 * 87 m unit cube at the geocentre and a 40 m georeferenced tower in Minnesota.
 */
const RANGE_SCALE = 2.0;
const PITCH_DEGREES = -30.0;
/** 8-bit channel value above which a pixel counts as non-background. */
const BACKGROUND_LEVEL = 16;

// CO-12 raised the default from 600 s: the WebGPU leg now walks three azimuths
// and two controls, and the SH-off control forces one COLD WGSL variant compile
// (~2674 ms measured on this fork) that no earlier run paid. The watchdog is a
// safety net, not a budget — every loop inside the lane carries its own.
const WATCHDOG_MS = Number(process.env.PROBE_GSPLAT_WATCHDOG_MS ?? 1_200_000);
const watchdog = setTimeout(() => {
  console.error(
    `STRUCTURAL: probe exceeded ${WATCHDOG_MS} ms — raise PROBE_GSPLAT_WATCHDOG_MS for --asset=both`,
  );
  process.exit(EXIT_CODE.ERROR);
}, WATCHDOG_MS);
watchdog.unref?.();

function resolveAssets() {
  const flag = process.argv.find((argument) => argument.startsWith("--asset="));
  const requested = flag ? flag.slice("--asset=".length) : "sh_unit_cube";
  if (requested === "both") {
    return [ASSETS.sh_unit_cube, ASSETS.tower];
  }
  const asset = ASSETS[requested];
  if (!asset) {
    throw new Error(
      `unknown --asset=${requested}; expected one of ${Object.keys(ASSETS).join(", ")} or "both"`,
    );
  }
  return [asset];
}

/**
 * Everything below runs INSIDE the page. `page.evaluate` serializes the
 * function source and drops the surrounding closure, so every helper the lane
 * needs is defined here rather than imported.
 */
const RUN_LANE = async ({
  renderer,
  asset,
  predict,
  dataBudgetMs,
  rangeScale,
  pitchDegrees,
  backgroundLevel,
  azimuthHeadings,
  runControls,
}) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const rendererType = String(scene.context?.rendererType ?? "").toLowerCase();

  // ── Deterministic scene. Anything that animates on its own would make the
  // determinism control unresolvable, and with it every threshold below it.
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  const frameTime = C.JulianDate.fromIso8601("2026-06-01T18:00:00Z");
  viewer.clock.currentTime = frameTime;
  // The globe is HIDDEN, not merely un-imaged: the ADDED-pixel metric needs a
  // background it can prove is blank, and `sh_unit_cube` is not georeferenced —
  // its bounding volume sits a few tens of metres from the geocentre, i.e.
  // inside the ellipsoid. Splats composited over a globe are C15-G6's subject
  // (multifrustum depth compose), and that row owns its own scene.
  scene.globe.show = false;
  scene.globe.imageryLayers.removeAll();
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.fog) scene.fog.enabled = false;
  scene.backgroundColor = C.Color.BLACK;
  for (const selector of [
    ".cesium-viewer-timelineContainer",
    ".cesium-viewer-animationContainer",
    ".cesium-viewer-bottom",
    ".cesium-viewer-toolbar",
    ".cesium-viewer-fullscreenContainer",
    ".cesium-viewer-navigationContainer",
    ".cesium-navigation-help",
    ".cesium-renderer-toggle",
  ]) {
    const element = document.querySelector(selector);
    if (element) element.style.display = "none";
  }

  const record = {
    requested: renderer,
    rendererType,
    asset: asset.name,
    navigationOk: true,
    // `frustum.indices[undefined] | 0` is 0. If `Pass` ever stops being
    // exported, every splat-command count silently reads zero and the probe
    // MANUFACTURES the absence it is supposed to observe.
    passEnumOk: !!C.Pass && Number.isInteger(C.Pass.GAUSSIAN_SPLATS),
    passGaussianSplats: C.Pass?.GAUSSIAN_SPLATS ?? null,
    tilesetFetchOk: false,
    tilesetFetchStatus: null,
    tilesetError: null,
    contentReady: false,
    contentReadyMs: null,
    dataReady: false,
    dataReadyMs: null,
    dataBudgetMs,
    // C15-G3b — the renderer-side commit, tracked apart from the shared data
    // commit. `null` on the WebGL leg, which has no WebGPU cache to wait for.
    rendererCommitted: false,
    rendererCommitMs: null,
    numSplats: 0,
    isStable: null,
    indexesLength: null,
    sorter: null,
    splatPassCommands: 0,
    commandListSplatCommands: 0,
    cacheSplatCount: null,
    // C15-G3 diagnostics — which attribute-record layout the renderer's cache
    // committed, and how many bytes per splat it believes it holds. A packed
    // commit that somehow reported the legacy stride is the single most
    // likely way this row goes wrong (the cloud would decode at half rate),
    // and it is invisible in the pixel metrics.
    cacheLayoutPacked: null,
    cacheSplatRecordBytes: null,
    cacheSortedIndexCount: null,
    // C15-G4 — the row's exit gate is a NEGATIVE ("the synchronous main-thread
    // comparator never runs on production content"), so it needs an observable
    // rather than an inference. `cacheComparatorSorts` counts the sorts that
    // ACTUALLY executed and must read 0 on both assets;
    // `cacheProvidedSortUploads` is its liveness partner — 0 there would mean
    // the comparator was idle because nothing sorted at all.
    // `cacheSupersededSortUploads` counts out-of-order resolutions the
    // sequence guard refused at the buffer-upload boundary.
    cacheComparatorSorts: null,
    cacheProvidedSortUploads: null,
    cacheSupersededSortUploads: null,
    // C15-G5 - the SH observables. The row's failure mode is silent: if
    // the SH variant never compiles, the colour residual stays exactly
    // where it was and the run looks like an unimproved port rather than
    // an unexecuted one. These name the difference.
    cacheShEnabled: null,
    cacheShDegree: null,
    primitiveShDegree: null,
    primitiveShWords: null,
    packedPayloadWords: null,
    featureRendererKind: null,
    absenceBlockers: [],
    framing: null,
    canvasPixels: canvas.width * canvas.height,
    canvasSize: { width: canvas.width, height: canvas.height },
    captureLivenessForeground: null,
    captureLivenessMean: null,
    backgroundForeground: null,
    determinismChanged: null,
    // C15-G4b — was the splat sort quiet when the determinism pair was taken,
    // and what did its provenance read at that moment. `sortQuiesced === false`
    // is a STRUCTURAL refusal, not a soft warning: a scene still re-ordering
    // itself cannot be scored for reproducibility.
    sortQuiesced: null,
    sortQuiesceMs: null,
    sortSignatureAtCapture: null,
    negativeControlChanged: null,
    added: null,
    // CO-12 — one entry per orbit position. Entry 0 IS the historical single
    // camera (heading 0), reported both here and in the flat fields above, so
    // every number `C15-G1..G5` recorded stays directly comparable.
    azimuths: [],
    // CO-12 — WebGPU-only vacuity controls. `supported: false` with a `why` is
    // a first-class outcome: the model turns it into a named STRUCTURAL, never
    // into silence.
    shOffControl: { supported: false, why: "not requested on this lane" },
    covarianceControl: { supported: false, why: "not requested on this lane" },
    pngs: {},
  };

  // ── Same-task capture. Render and read the canvas element with no yield in
  // between; a read across a rAF yield is invalid on BOTH backends.
  const scratch = document.createElement("canvas");
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
  const renderNow = () => scene.render(frameTime);
  const captureNow = () => {
    renderNow();
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    scratchContext.drawImage(canvas, 0, 0);
    return {
      image: scratchContext.getImageData(0, 0, canvas.width, canvas.height),
      png: canvas.toDataURL("image/png"),
    };
  };
  const settleMs = async (milliseconds) => {
    const deadline = performance.now() + milliseconds;
    while (performance.now() < deadline) {
      renderNow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /**
   * CO-12 — render until `predicate()` holds or the wall-clock budget expires.
   * Wall clock, never a frame count, for the same reason every other budget in
   * this file is: the conditions it waits on are pipeline-variant compiles and
   * queue-ordered buffer writes, and neither is denominated in frames. Bounded
   * by construction; the caller records the `ok` flag and the controls turn a
   * false into a named STRUCTURAL rather than proceeding on stale state.
   */
  const waitForCondition = async (predicate, budgetMs) => {
    const start = performance.now();
    while (performance.now() - start < budgetMs) {
      renderNow();
      if (predicate()) {
        return { ok: true, ms: performance.now() - start };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { ok: false, ms: performance.now() - start };
  };

  // ── C15-G4b — splat-sort quiescence.
  //
  // Everything that can change this scene between two renders is asynchronous:
  // the clock is pinned, the camera is set once and never touched, TAA and HDR
  // are off, the globe/sky/sun/moon are hidden. What remains is the splat
  // pipeline's WASM workers, and their results land on event-loop yields.
  //
  // The signature is deliberately BACKEND-NEUTRAL. `_indexesSortSequence` and
  // `_indexesDataGeneration` are the provenance `C15-G4` stamps onto the
  // published permutation, so a change in them IS a resolved sort on either
  // backend — the WebGL leg has no `_webgpuCache` to read. The WebGPU
  // consumer-side upload counter rides along when present, and the in-flight
  // promise flags are what separate "nothing has resolved yet" from "nothing is
  // left to resolve".
  const sortSignature = () => {
    const p = tileset?.gaussianSplatPrimitive;
    return [
      p?._indexesSortSequence ?? -1,
      p?._indexesDataGeneration ?? -1,
      p?._sortRequestId ?? -1,
      p?._indexes?.length ?? -1,
      p?._webgpuCache?.providedSortUploads ?? -1,
      p?._webgpuCache?.comparatorSorts ?? -1,
    ].join("/");
  };
  const sortInFlight = () => {
    const p = tileset?.gaussianSplatPrimitive;
    return (
      p?._sorterPromise !== undefined ||
      p?._pendingSortPromise !== undefined ||
      p?._pendingSnapshot !== undefined
    );
  };
  /**
   * Render until the sort signature has held steady for a full `windowMs` with
   * nothing in flight. Returns without quiescing when `budgetMs` expires — the
   * caller records that and the `sort-quiesced` precondition refuses the run,
   * because scoring a scene that is still re-ordering itself is exactly the
   * failure this exists to stop.
   */
  const waitForSortQuiescence = async (windowMs, budgetMs) => {
    const start = performance.now();
    let signature = sortSignature();
    let stableSince = start;
    while (performance.now() - start < budgetMs) {
      renderNow();
      const next = sortSignature();
      if (next !== signature || sortInFlight()) {
        signature = next;
        stableSince = performance.now();
      } else if (performance.now() - stableSince >= windowMs) {
        return {
          quiesced: true,
          ms: performance.now() - start,
          signature: signature,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return {
      quiesced: false,
      ms: performance.now() - start,
      signature: sortSignature(),
    };
  };

  // ── Pixel helpers.
  const changedPixelCount = (a, b) => {
    if (a.width !== b.width || a.height !== b.height) {
      return a.width * a.height;
    }
    let changed = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (
        a.data[i] !== b.data[i] ||
        a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]
      ) {
        changed++;
      }
    }
    return changed;
  };
  const foregroundCount = (frame) => {
    let count = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      if (
        frame.data[i] > backgroundLevel ||
        frame.data[i + 1] > backgroundLevel ||
        frame.data[i + 2] > backgroundLevel
      ) {
        count++;
      }
    }
    return count;
  };

  /**
   * Classify every pixel the tileset ADDED relative to `offFrame`.
   *
   * `edgeFraction` and `luminanceStdDev` are what separate a splat cloud from
   * a flood fill: a solid full-canvas region has O(sqrt(N)) boundary and no
   * luminance spread, and would otherwise satisfy the added-pixel floor.
   */
  const analyzeAdded = (onFrame, offFrame) => {
    const { width, height, data } = onFrame;
    const off = offFrame.data;
    const mask = new Uint8Array(width * height);
    let changed = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let lumSum = 0;
    let lumSquareSum = 0;
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i = p * 4;
        if (
          data[i] === off[i] &&
          data[i + 1] === off[i + 1] &&
          data[i + 2] === off[i + 2]
        ) {
          continue;
        }
        mask[p] = 1;
        changed++;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        rSum += r;
        gSum += g;
        bSum += b;
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumSum += luminance;
        lumSquareSum += luminance * luminance;
      }
    }
    if (changed === 0) {
      return {
        changed: 0,
        centroid: [Number.NaN, Number.NaN],
        bbox: null,
        edgeFraction: Number.NaN,
        luminanceMean: Number.NaN,
        luminanceStdDev: Number.NaN,
        meanColor: [Number.NaN, Number.NaN, Number.NaN],
      };
    }
    let edges = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (mask[p] === 0) continue;
        const boundary =
          x === 0 ||
          y === 0 ||
          x === width - 1 ||
          y === height - 1 ||
          mask[p - 1] === 0 ||
          mask[p + 1] === 0 ||
          mask[p - width] === 0 ||
          mask[p + width] === 0;
        if (boundary) edges++;
      }
    }
    const mean = lumSum / changed;
    const variance = Math.max(lumSquareSum / changed - mean * mean, 0);
    return {
      changed,
      centroid: [sumX / changed, sumY / changed],
      bbox: [minX, minY, maxX, maxY],
      edgeFraction: edges / changed,
      luminanceMean: mean,
      luminanceStdDev: Math.sqrt(variance),
      meanColor: [rSum / changed, gSum / changed, bSum / changed],
    };
  };

  // ── Load the tileset. A fetch failure here is a STRUCTURAL precondition,
  // reported as data rather than thrown, so the fold can name it.
  let tileset;
  try {
    const probeResponse = await fetch(asset.url, { cache: "no-store" });
    record.tilesetFetchStatus = probeResponse.status;
    record.tilesetFetchOk = probeResponse.ok;
    if (!probeResponse.ok) {
      return record;
    }
    tileset = await C.Cesium3DTileset.fromUrl(asset.url, {
      maximumScreenSpaceError: 1,
      cullRequestsWhileMoving: false,
    });
  } catch (error) {
    record.tilesetError = String(error?.message ?? error);
    return record;
  }
  scene.primitives.add(tileset);

  // ── Camera derived from the tileset's OWN bounding sphere.
  //
  // CO-12 — parameterized by heading so the orbit lane reuses the SAME
  // derivation at every azimuth. The range is computed once, from the sphere as
  // it stands when the lane frames its first camera, so the three orbit
  // positions differ ONLY in heading — a range that drifted with streaming
  // would change the projected size and contaminate the per-azimuth comparison.
  const sphere = tileset.boundingSphere;
  const range = Math.max(sphere.radius * rangeScale, 10.0);
  const frameCameraAt = (headingDegrees) => {
    scene.camera.lookAt(
      tileset.boundingSphere.center,
      new C.HeadingPitchRange(
        C.Math.toRadians(headingDegrees),
        C.Math.toRadians(pitchDegrees),
        range,
      ),
    );
    // Bake the world-space pose and release the bounding-sphere reference
    // frame, so nothing later in the lane is interpreted in a local frame.
    scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
  };
  const viewDirectionNow = () => {
    const d = scene.camera.directionWC;
    return [d.x, d.y, d.z];
  };
  frameCameraAt(azimuthHeadings[0]);

  // ── Readiness: wall clock, never frame counts.
  const contentStart = performance.now();
  while (performance.now() - contentStart < predict.contentReadyBudgetMs) {
    renderNow();
    if (tileset.tilesLoaded === true && tileset.root?.contentReady === true) {
      record.contentReady = true;
      record.contentReadyMs = performance.now() - contentStart;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // The splat data commit is a SEPARATE budget. On WebGPU at HEAD it is
  // expected to expire — that expiry IS the measurement, not a probe failure.
  const dataStart = performance.now();
  while (performance.now() - dataStart < dataBudgetMs) {
    renderNow();
    const primitive = tileset.gaussianSplatPrimitive;
    if (primitive && primitive._numSplats > 0 && primitive.isStable === true) {
      record.dataReady = true;
      record.dataReadyMs = performance.now() - dataStart;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ── C15-G3b — the renderer-side commit is a THIRD budget.
  //
  // Batch 881 measured `cache.splatCount = 0` on a run whose scored frame drew
  // 61% of the canvas. The two are not contradictory: the loop above waits on
  // the SHARED pipeline (`_numSplats`), which lands in the same frame the
  // snapshot commits, while the renderer-owned cache is populated by the
  // feature renderer — and at that instant the splat pipeline was still
  // compiling, so `updateWebGPUGaussianSplats` returned early. Sampling a
  // renderer-owned signal the frame the SHARED signal goes true reads the
  // renderer before it has run. `C15-G3b` hoisted the buffer commit above the
  // pipeline gate on the engine side; this budget is the instrument half, and
  // it stays because "the renderer has committed" will never be the same event
  // as "the data exists" and a probe must not assume it is.
  const sampleRendererStats = () => {
    const p = tileset.gaussianSplatPrimitive;
    record.cacheSplatCount = p?._webgpuCache?.splatCount ?? null;
    record.cacheLayoutPacked = p?._webgpuCache?.layoutPacked ?? null;
    record.cacheSplatRecordBytes = p?._webgpuCache?.splatRecordBytes ?? null;
    record.cacheSortedIndexCount = p?._webgpuCache?.sortedIndexCount ?? null;
    record.cacheComparatorSorts = p?._webgpuCache?.comparatorSorts ?? null;
    record.cacheProvidedSortUploads =
      p?._webgpuCache?.providedSortUploads ?? null;
    record.cacheSupersededSortUploads =
      p?._webgpuCache?.supersededSortUploads ?? null;
    record.packedPayloadWords =
      p?._packedSplatTextureData?.data?.length ?? null;
    // C15-G5 — the SH observables. Without these, "the SH variant silently
    // never compiled" and "SH is implemented and the colours still differ" are
    // the same reading: an unchanged mismatch. `shDegree` is the RENDERER's
    // resident degree, `primitiveShDegree` is what the shared pipeline
    // committed — they disagree only if the consumer refused the payload (a
    // short buffer), which is exactly the case worth naming.
    record.cacheShEnabled = p?._webgpuCache?.shEnabled ?? null;
    record.cacheShDegree = p?._webgpuCache?.shDegree ?? null;
    record.primitiveShDegree = p?._sphericalHarmonicsDegree ?? null;
    record.primitiveShWords = p?._shData?.length ?? null;
  };
  if (rendererType === "webgpu") {
    const commitStart = performance.now();
    while (performance.now() - commitStart < dataBudgetMs) {
      renderNow();
      if ((tileset.gaussianSplatPrimitive?._webgpuCache?.splatCount ?? 0) > 0) {
        record.rendererCommitted = true;
        record.rendererCommitMs = performance.now() - commitStart;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } else {
    // Backend-neutral bookkeeping: the WebGL leg has no `_webgpuCache` and
    // never will, so waiting on one would burn the whole budget every run.
    record.rendererCommitted = null;
  }

  const primitive = tileset.gaussianSplatPrimitive;
  record.numSplats = primitive?._numSplats ?? 0;
  record.isStable = primitive?.isStable ?? null;
  record.indexesLength = primitive?._indexes?.length ?? null;
  // What the WASM sorter reports, if reachable at all.
  record.sorter = {
    sorterState: primitive?._sorterState ?? null,
    pendingSnapshotState: primitive?._pendingSnapshot?.state ?? null,
    snapshotNumSplats: primitive?._snapshot?.numSplats ?? null,
    sphericalHarmonicsDegree: primitive?._sphericalHarmonicsDegree ?? null,
  };
  sampleRendererStats();
  try {
    // FeatureRendererKey.GAUSSIAN_SPLAT === 16. The primitive's own update
    // kicks this lazy loader every frame, so reading it is idempotent here.
    record.featureRendererKind =
      scene.context?.getFeatureRendererReadiness?.(16)?.kind ?? null;
  } catch (error) {
    record.featureRendererKind = `error: ${String(error?.message ?? error)}`;
  }

  // Named, observed blockers in the scaffolded WebGPU path. These are what
  // make an absence ATTRIBUTABLE instead of merely blank.
  // These four observations are collected UNCONDITIONALLY and unchanged across
  // the track; which of them are expected to fire at the current stage is the
  // model's job (`STAGE`), not the page's. A probe that stopped LOOKING for a
  // retired blocker could not report its return.
  if (primitive) {
    if (typeof primitive.show === "undefined") {
      // `WebGPUGaussianSplatRenderer.updateWebGPUGaussianSplats` opens with
      // `if (!primitive.show) return;`. Before C15-G2, GaussianSplatPrimitive
      // defined no `show` at all and the renderer exited at its first
      // statement; C15-G2 added a read-only accessor proxying `tileset.show`,
      // so this should no longer fire. If it does, that accessor is gone.
      record.absenceBlockers.push("primitive-show-undefined");
    }
    if (
      primitive._splatData === undefined &&
      primitive._renderResources?.splatBuffer === undefined &&
      primitive._splatCount === undefined &&
      // C15-G3 — the PRODUCTION source. The renderer consumes the WASM
      // `generate_splat_texture` output verbatim (8 u32/splat) off
      // `_packedSplatTextureData`; the legacy 16-f32 trio above stays
      // unassigned by design (Option B forks no worker format), so testing
      // only those three would keep reporting this blocker forever on a
      // healthy engine. The blocker means "no splat bytes reach the renderer
      // in ANY layout it can consume", and all four fields are what that is.
      primitive._packedSplatTextureData === undefined
    ) {
      record.absenceBlockers.push("no-splat-data-fields");
    }
    if ((primitive._numSplats ?? 0) === 0) {
      // Before C15-G2 the splat data pipeline sat below the feature-renderer
      // dispatch and never ran on this backend. It is now shared, so on a
      // healthy post-G2 engine this reads the same count as the WebGL leg.
      record.absenceBlockers.push("primitive-numsplats-zero");
    }
    if (
      primitive._webgpuCache &&
      (primitive._webgpuCache.splatCount ?? 0) === 0
    ) {
      // Reachable only once the renderer gets past its visibility guard, which
      // is why this could not be observed before C15-G2: `_webgpuCache` was
      // never allocated and `cacheSplatCount` read `null`, not `0`.
      record.absenceBlockers.push("cache-splat-count-zero");
    }
  }

  // ── Camera framing precondition. Measured AFTER readiness so it reflects the
  // pose the scored frames were captured at. Without this, "no pixels" is
  // unattributable: a mis-derived camera and a dead renderer look identical.
  {
    const centerWindow = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      tileset.boundingSphere.center,
    );
    const edge = C.Cartesian3.add(
      tileset.boundingSphere.center,
      C.Cartesian3.multiplyByScalar(
        scene.camera.rightWC,
        tileset.boundingSphere.radius,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const edgeWindow = C.SceneTransforms.worldToWindowCoordinates(scene, edge);
    const cssWidth = canvas.clientWidth || canvas.width;
    const cssHeight = canvas.clientHeight || canvas.height;
    record.framing = {
      centerOnScreen:
        !!centerWindow &&
        centerWindow.x >= 0 &&
        centerWindow.x <= cssWidth &&
        centerWindow.y >= 0 &&
        centerWindow.y <= cssHeight,
      radiusPx:
        centerWindow && edgeWindow
          ? Math.hypot(
              edgeWindow.x - centerWindow.x,
              edgeWindow.y - centerWindow.y,
            )
          : Number.NaN,
      centerWindow: centerWindow
        ? { x: centerWindow.x, y: centerWindow.y }
        : null,
      cssSize: { width: cssWidth, height: cssHeight },
      boundingSphereRadius: tileset.boundingSphere.radius,
      cameraRange: range,
    };
  }

  // ── CAPTURE LIVENESS. Independent of splats entirely: paint the scene a
  // known non-black colour and require the readback to see it.
  //
  // This exists because the failure it catches is otherwise indistinguishable
  // from a product defect. Cesium's canvases run with
  // `preserveDrawingBuffer: false`, and the historical trap on this fork
  // (`capture-and-diff.mjs`, Batch 227) is a readback path that returns solid
  // black post-present. If that happened here, `numSplats === 27` would still
  // hold, the camera would still be framed, the background would still read
  // "blank" — and the probe would file `reference:addedPixels` as a WebGL
  // defect that does not exist. With this control, a dead readback is what it
  // actually is: the instrument, reported STRUCTURAL.
  tileset.show = false;
  scene.backgroundColor = C.Color.fromBytes(64, 128, 192, 255);
  await settleMs(predict.settleMs);
  const liveness = captureNow();
  record.captureLivenessForeground = foregroundCount(liveness.image);
  record.captureLivenessMean = (() => {
    const { data } = liveness.image;
    let r = 0;
    let g = 0;
    let b = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    return [r / pixels, g / pixels, b / pixels];
  })();
  scene.backgroundColor = C.Color.BLACK;

  // ── Warm-up capture, discarded. The first read after a readiness loop (or
  // after the liveness repaint) can still land one LOD/pipeline step behind.
  await settleMs(predict.settleMs);
  captureNow();

  // ── Reference frame: the SAME scene with the tileset hidden.
  await settleMs(predict.settleMs);
  const offA = captureNow();
  record.backgroundForeground = foregroundCount(offA.image);

  // ── The scored ON frame, plus its repeat capture (determinism).
  //
  // C15-G4b — the pair is taken BACK-TO-BACK IN ONE TASK. There is no `await`
  // between `onA` and `onB`, so no promise continuation, worker message or
  // timer can interleave: the JS execution model, not a hope about timing, is
  // what makes the two frames comparable. The previous form put
  // `await settleMs(2000)` between them — thousands of yields, every one of
  // them a landing site for a resolved WASM radix sort, whose new permutation
  // re-orders an order-dependent premultiplied blend. That is what made the
  // WebGL leg read 0.052% on `tower` at Batch 890 (410 px of a ~32,000 px
  // footprint) while `sh_unit_cube` read 0.000%: the defect scaled with splat
  // COUNT, not with footprint area.
  //
  // The temporal-stability check the old window provided is NOT lost — it moved
  // into `waitForSortQuiescence` below, which requires the sort provenance to
  // hold steady across a full settle window before either capture is taken.
  // The 0.050% bar is untouched.
  tileset.show = true;
  await settleMs(predict.settleMs);
  // Bounded well inside the 600 s watchdog rather than inheriting the full data
  // budget: quiescence normally lands one settle window after the first render,
  // and a leg that cannot go quiet in 30 s is going to be refused by the
  // precondition anyway — burning 120 s per leg to reach the same verdict would
  // put `--asset=both` at risk of a watchdog exit 2, which reports nothing.
  const quiesceBudgetMs = Math.min(dataBudgetMs, 30_000);
  const quiescence = await waitForSortQuiescence(
    predict.settleMs,
    quiesceBudgetMs,
  );
  record.sortQuiesced = quiescence.quiesced;
  record.sortQuiesceMs = quiescence.ms;
  record.sortSignatureAtCapture = quiescence.signature;

  const onA = captureNow();
  const onB = captureNow();
  record.determinismChanged = changedPixelCount(onA.image, onB.image);

  // Everything below runs in the SAME task as both captures — `analyzeAdded` is
  // a 786k-pixel loop and the C15-G3b lesson is that the renderer-owned stats
  // must describe the frame that was actually scored, not one read later.
  record.added = analyzeAdded(onA.image, offA.image);
  record.splatPassCommands = (() => {
    const frustums = scene._view?.frustumCommandsList ?? [];
    let total = 0;
    for (const frustum of frustums) {
      total += frustum?.indices
        ? frustum.indices[C.Pass.GAUSSIAN_SPLATS] | 0
        : 0;
    }
    return total;
  })();
  record.commandListSplatCommands = (
    scene.frameState?.commandList ?? []
  ).filter((command) => command?.pass === C.Pass.GAUSSIAN_SPLATS).length;
  // C15-G3b — RE-SAMPLE the renderer-owned stats here, same task as the scored
  // capture and the command counts. This is the sample the verdict uses: a
  // number read minutes of wall clock earlier describes a different frame than
  // the one that was measured, and `classifyWebgpuPresence` folds this exact
  // field in as its `dataCommitted` signal. Batch 881 exited 1 on precisely
  // that mismatch — 61% of the canvas painted by a renderer the verdict
  // believed had committed nothing.
  sampleRendererStats();

  // ── Negative control, second side: hide the tileset again and require the
  // SAME metric against the SAME reference frame to collapse.
  tileset.show = false;
  await settleMs(predict.settleMs);
  const offB = captureNow();
  record.negativeControlChanged = analyzeAdded(offB.image, offA.image).changed;
  tileset.show = true;

  record.pngs = {
    [`${asset.name}-${renderer}-on`]: onA.png,
    [`${asset.name}-${renderer}-off`]: offA.png,
    [`${asset.name}-${renderer}-off-after`]: offB.png,
    [`${asset.name}-${renderer}-capture-liveness`]: liveness.png,
  };

  // ══ CO-12 — THE ORBIT ══════════════════════════════════════════════════
  //
  // Entry 0 is the frame already scored above, recorded rather than re-taken:
  // re-capturing it would make the primary reading and the orbit's first
  // reading two different measurements of the same claim, and the track's
  // recorded numbers are all against THIS one.
  const cleanFrames = [onA];
  record.azimuths.push({
    headingDegrees: azimuthHeadings[0],
    pngKey: `${asset.name}-${renderer}-on`,
    viewDirection: viewDirectionNow(),
    canvasPixels: record.canvasPixels,
    backgroundForeground: record.backgroundForeground,
    added: record.added,
    determinismChanged: record.determinismChanged,
    sortQuiesced: record.sortQuiesced,
    sortQuiesceMs: record.sortQuiesceMs,
    changedVsPrevious: null,
  });

  for (let i = 1; i < azimuthHeadings.length; i++) {
    const heading = azimuthHeadings[i];
    frameCameraAt(heading);
    // Each azimuth gets its OWN hidden-tileset reference frame. The background
    // is black and everything else in the scene is hidden, so all three SHOULD
    // be blank — which is exactly why measuring them separately costs nothing
    // and catches the case where one of them is not.
    tileset.show = false;
    await settleMs(predict.settleMs);
    const off = captureNow();
    tileset.show = true;
    await settleMs(predict.settleMs);
    // A 120 deg camera move is precisely what `shouldStartSteadySort` exists to
    // notice, so every orbit position re-enters the sort pipeline and has to
    // re-quiesce before its determinism pair. Skipping this would reintroduce
    // the C15-G4b defect at azimuths 1 and 2 while azimuth 0 stayed clean.
    const quiesce = await waitForSortQuiescence(
      predict.settleMs,
      quiesceBudgetMs,
    );
    const a = captureNow();
    const b = captureNow();
    cleanFrames.push(a);
    const pngKey = `${asset.name}-${renderer}-az${heading}-on`;
    record.pngs[pngKey] = a.png;
    record.azimuths.push({
      headingDegrees: heading,
      pngKey: pngKey,
      viewDirection: viewDirectionNow(),
      canvasPixels: record.canvasPixels,
      backgroundForeground: foregroundCount(off.image),
      added: analyzeAdded(a.image, off.image),
      determinismChanged: changedPixelCount(a.image, b.image),
      sortQuiesced: quiesce.quiesced,
      sortQuiesceMs: quiesce.ms,
      // The anti-vacuity number: how much the picture changed relative to the
      // PREVIOUS orbit position. A camera that moved on paper and not on screen
      // leaves this at the determinism floor.
      changedVsPrevious: changedPixelCount(a.image, cleanFrames[i - 1].image),
    });
  }

  if (!runControls) {
    record.shOffControl = {
      supported: false,
      why: "controls run only on the WebGPU leg under --expect-webgpu",
    };
    record.covarianceControl = {
      supported: false,
      why: "controls run only on the WebGPU leg under --expect-webgpu",
    };
    return record;
  }

  const controlled = tileset.gaussianSplatPrimitive;
  const controlCache = controlled?._webgpuCache;

  // ══ CO-12 — SH-OFF VACUITY CONTROL ═════════════════════════════════════
  //
  // The seam is the engine's own: `resolveSplatShSource` reports
  // `enabled: false` for a degree below 1, `activeShEnabled` follows it,
  // `shFlipped` invalidates the pipeline resources and the renderer recompiles
  // the `//>>else` variant — a WGSL module with no SH term at all. That is a
  // stronger control than clearing a uniform: a uniform-level switch would
  // leave the SH code path compiled and could be defeated by the same defect
  // it is meant to detect.
  {
    const originalDegree = controlled?._sphericalHarmonicsDegree ?? 0;
    if (!controlled || !controlCache || !(originalDegree >= 1)) {
      record.shOffControl = {
        supported: false,
        why: `no SH to switch off (primitive=${!!controlled} cache=${!!controlCache} degree=${originalDegree}) — both in-tree gate assets are SH degree 3, so this is itself a finding`,
      };
    } else {
      controlled._sphericalHarmonicsDegree = 0;
      const flipped = await waitForCondition(
        () =>
          controlled._webgpuCache?.resourcesShEnabled === false &&
          !!controlled._webgpuCache?.pipeline,
        predict.controlSettleBudgetMs,
      );
      if (!flipped.ok) {
        record.shOffControl = {
          supported: false,
          why: `the renderer did not recompile the no-SH variant within ${predict.controlSettleBudgetMs} ms (resourcesShEnabled=${controlled._webgpuCache?.resourcesShEnabled})`,
        };
        controlled._sphericalHarmonicsDegree = originalDegree;
      } else {
        const azimuths = [];
        for (let i = 0; i < azimuthHeadings.length; i++) {
          const heading = azimuthHeadings[i];
          frameCameraAt(heading);
          await settleMs(predict.settleMs);
          await waitForSortQuiescence(predict.settleMs, quiesceBudgetMs);
          const shot = captureNow();
          const pngKey = `${asset.name}-${renderer}-shoff-az${heading}`;
          record.pngs[pngKey] = shot.png;
          azimuths.push({
            headingDegrees: heading,
            pngKey: pngKey,
            // Same-backend: SH-off vs the SH-on frame at the SAME camera. This
            // is the C15-G5 row's literal wording. The cross-backend half is
            // computed on the Node side against the WebGL leg's PNG, because
            // that is the comparison the 2.574% figure was recorded from.
            sameBackendChanged: changedPixelCount(
              shot.image,
              cleanFrames[i].image,
            ),
          });
        }
        // Withdraw the control and require the picture to come back.
        controlled._sphericalHarmonicsDegree = originalDegree;
        const restoredFlip = await waitForCondition(
          () =>
            controlled._webgpuCache?.resourcesShEnabled === true &&
            !!controlled._webgpuCache?.pipeline,
          predict.controlSettleBudgetMs,
        );
        frameCameraAt(azimuthHeadings[0]);
        await settleMs(predict.settleMs);
        await waitForSortQuiescence(predict.settleMs, quiesceBudgetMs);
        const restoredShot = captureNow();
        record.shOffControl = {
          supported: true,
          why: "",
          canvasPixels: record.canvasPixels,
          originalDegree,
          flipMs: flipped.ms,
          azimuths,
          restored: restoredFlip.ok,
          restoredChanged: changedPixelCount(
            restoredShot.image,
            cleanFrames[0].image,
          ),
        };
      }
    }
  }

  // ══ CO-12 — CORRUPTED-COVARIANCE VACUITY CONTROL ═══════════════════════
  //
  // Words 4-6 of each 8-u32 packed record hold the six unique symmetric
  // covariance terms as three `unpackHalf2x16` pairs (`C15-G0` 6a(A)). The
  // corruption is applied in the HALF-FLOAT EXPONENT — +2 is an exact x4 for
  // every normal half — and clamped short of the Inf/NaN encoding, so a
  // corrupted splat is a WRONGLY-SIZED splat rather than a degenerate quad that
  // could satisfy this control for reasons unrelated to the covariance.
  {
    const payload = controlled?._packedSplatTextureData;
    const numSplats = controlled?._numSplats ?? 0;
    if (!payload?.data || numSplats <= 0 || !controlCache) {
      record.covarianceControl = {
        supported: false,
        why: `no packed payload to corrupt (data=${!!payload?.data} numSplats=${numSplats} cache=${!!controlCache})`,
      };
    } else {
      const expDelta = Math.round(Math.log2(predict.covarianceScaleFactor));
      const scaleHalf = (bits) => {
        const sign = bits & 0x8000;
        const exponent = (bits >> 10) & 0x1f;
        const mantissa = bits & 0x03ff;
        // Zero / denormal (0) and Inf / NaN (31) are left alone: neither has an
        // exponent that can be shifted without changing what the value MEANS.
        if (exponent === 0 || exponent === 0x1f) {
          return bits;
        }
        const shifted = Math.min(30, Math.max(1, exponent + expDelta));
        return (sign | (shifted << 10) | mantissa) >>> 0;
      };
      const scalePair = (word) =>
        ((scaleHalf((word >>> 16) & 0xffff) << 16) |
          scaleHalf(word & 0xffff)) >>>
        0;
      const corrupt = (firstSplat, stride) => {
        // A COPY. The original payload object and its bytes are never written,
        // so the restore step is a reference swap and cannot leave residue.
        const data = payload.data.slice();
        let corrupted = 0;
        for (let s = firstSplat; s < numSplats; s += stride) {
          const base = s * 8;
          for (let w = 4; w <= 6; w++) {
            data[base + w] = scalePair(data[base + w]);
          }
          corrupted++;
        }
        return { payload: { ...payload, data: data }, corrupted };
      };
      const publish = async (nextPayload) => {
        controlled._packedSplatTextureData = nextPayload;
        // The engine's OWN dirty signal is producer identity, so waiting on the
        // resident token is waiting on the upload the corruption is supposed to
        // cause — not on a frame count that might beat it.
        const uploaded = await waitForCondition(
          () => controlled._webgpuCache?.splatSourceToken === nextPayload,
          predict.controlSettleBudgetMs,
        );
        await settleMs(predict.settleMs);
        await waitForSortQuiescence(predict.settleMs, quiesceBudgetMs);
        return uploaded;
      };

      frameCameraAt(azimuthHeadings[0]);
      await settleMs(predict.settleMs);
      await waitForSortQuiescence(predict.settleMs, quiesceBudgetMs);

      const single = corrupt(predict.covarianceSingleSplatIndex, numSplats + 1);
      const singleUploaded = await publish(single.payload);
      const singleShot = captureNow();
      record.pngs[`${asset.name}-${renderer}-corrupt-single`] = singleShot.png;

      const bulk = corrupt(0, predict.covarianceBulkStride);
      const bulkUploaded = await publish(bulk.payload);
      const bulkShot = captureNow();
      record.pngs[`${asset.name}-${renderer}-corrupt-bulk`] = bulkShot.png;

      const restoredUpload = await publish(payload);
      const restoredShot = captureNow();

      record.covarianceControl = {
        supported: singleUploaded.ok && bulkUploaded.ok,
        why:
          singleUploaded.ok && bulkUploaded.ok
            ? ""
            : `the corrupted payload never became resident (single=${singleUploaded.ok} bulk=${bulkUploaded.ok}) within ${predict.controlSettleBudgetMs} ms`,
        canvasPixels: record.canvasPixels,
        splatsCorruptedSingle: single.corrupted,
        splatsCorruptedBulk: bulk.corrupted,
        numSplats,
        cleanAddedChanged: record.added?.changed ?? null,
        singleChanged: changedPixelCount(
          singleShot.image,
          cleanFrames[0].image,
        ),
        bulkChanged: changedPixelCount(bulkShot.image, cleanFrames[0].image),
        restored: restoredUpload.ok,
        restoredChanged: changedPixelCount(
          restoredShot.image,
          cleanFrames[0].image,
        ),
      };
    }
  }

  return record;
};

/** Decode two canvas PNGs in a scratch page and diff them. */
const DIFF_IN_PAGE = async ({ a, b, threshold }) => {
  const decode = async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = off.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  };
  const imageA = await decode(a);
  const imageB = await decode(b);
  if (imageA.width !== imageB.width || imageA.height !== imageB.height) {
    return {
      mismatchFraction: null,
      why: `size mismatch ${imageA.width}x${imageA.height} vs ${imageB.width}x${imageB.height}`,
    };
  }
  const total = imageA.width * imageA.height;
  const diff = new ImageData(imageA.width, imageA.height);
  let mismatched = 0;
  for (let i = 0; i < imageA.data.length; i += 4) {
    const delta =
      Math.abs(imageA.data[i] - imageB.data[i]) +
      Math.abs(imageA.data[i + 1] - imageB.data[i + 1]) +
      Math.abs(imageA.data[i + 2] - imageB.data[i + 2]);
    const over = delta > threshold;
    if (over) mismatched++;
    diff.data[i] = over ? 255 : 0;
    diff.data[i + 1] = over ? 0 : Math.min(imageA.data[i + 1], 64);
    diff.data[i + 2] = 0;
    diff.data[i + 3] = 255;
  }
  const canvas = new OffscreenCanvas(imageA.width, imageA.height);
  canvas.getContext("2d").putImageData(diff, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const png = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  return {
    mismatchFraction: mismatched / total,
    mismatched,
    total,
    width: imageA.width,
    height: imageA.height,
    png,
  };
};

function attachPageErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function filteredErrors(errors) {
  return [...new Set(errors)].filter(
    // Deliberately narrow: a broad filter would mask exactly the class of
    // error the clean-run criterion exists to catch.
    (error) => !/favicon|Ion access token/i.test(error),
  );
}

async function runBackend(browser, renderer, asset, dataBudgetMs, runControls) {
  const page = await browser.newPage({ viewport: VIEW });
  const pageErrors = attachPageErrors(page);
  const consoleGate = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  try {
    try {
      await page.goto(
        `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
        { waitUntil: "domcontentloaded", timeout: 90_000 },
      );
      await page.waitForFunction(() => !!window.viewer?.scene, null, {
        timeout: 90_000,
      });
    } catch (error) {
      return {
        requested: renderer,
        asset: asset.name,
        rendererType: null,
        navigationOk: false,
        navigationError: String(error?.message ?? error),
        errors: filteredErrors([...pageErrors, ...consoleGate]),
      };
    }
    if (renderer === "webgpu") {
      await armWebGPUDevices(page);
    }
    const result = await page.evaluate(RUN_LANE, {
      renderer,
      asset,
      predict: PREDICT,
      dataBudgetMs,
      rangeScale: RANGE_SCALE,
      pitchDegrees: PITCH_DEGREES,
      backgroundLevel: BACKGROUND_LEVEL,
      azimuthHeadings: AZIMUTH_HEADINGS,
      runControls: runControls === true,
    });
    const gate = await collectGateErrors(page);
    const errors = filteredErrors([
      ...pageErrors,
      ...consoleGate,
      ...(gate.errors ?? []),
      ...(gate.deviceLost ? [gate.deviceLost] : []),
    ]);
    return { ...result, errors };
  } finally {
    await page.close().catch(() => {});
  }
}

function writePngs(record) {
  for (const [name, dataUrl] of Object.entries(record?.pngs ?? {})) {
    const comma = dataUrl.indexOf(",");
    fs.writeFileSync(
      path.join(OUT, `${name}.png`),
      Buffer.from(dataUrl.slice(comma + 1), "base64"),
    );
  }
}

function withoutPngs(record) {
  if (!record) return record;
  const { pngs: _pngs, ...rest } = record;
  return rest;
}

const pct = (value) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(3)}%` : "n/a";

function describeLane(lane) {
  const addedFraction = fractionOf(lane?.added?.changed, lane?.canvasPixels);
  return (
    `${String(lane?.requested).padEnd(6)} rendererType=${lane?.rendererType ?? "none"} ` +
    `content=${lane?.contentReady}@${
      lane?.contentReadyMs === null || lane?.contentReadyMs === undefined
        ? "never"
        : `${Math.round(lane.contentReadyMs)}ms`
    } ` +
    `data=${lane?.dataReady}@${
      lane?.dataReadyMs === null || lane?.dataReadyMs === undefined
        ? `never/${Math.round(lane?.dataBudgetMs ?? 0)}ms budget`
        : `${Math.round(lane.dataReadyMs)}ms`
    } ` +
    `numSplats=${lane?.numSplats} indexes=${lane?.indexesLength ?? "n/a"} ` +
    `splatCmds=${lane?.splatPassCommands}/${lane?.commandListSplatCommands} ` +
    `added=${lane?.added?.changed ?? "n/a"} (${pct(addedFraction)}) ` +
    `edge=${
      Number.isFinite(lane?.added?.edgeFraction)
        ? lane.added.edgeFraction.toFixed(3)
        : "n/a"
    } ` +
    `lumSd=${
      Number.isFinite(lane?.added?.luminanceStdDev)
        ? lane.added.luminanceStdDev.toFixed(1)
        : "n/a"
    } ` +
    `errs=${lane?.errors?.length ?? 0}`
  );
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const assets = resolveAssets();

  // ── Node-side preflight. A dev server that is not running is a STRUCTURAL
  // precondition, and finding that out before launching a browser keeps the
  // failure legible.
  const preflight = [];
  for (const asset of assets) {
    try {
      const response = await fetch(`${BASE}${asset.url}`, {
        cache: "no-store",
      });
      preflight.push({
        asset: asset.name,
        ok: response.ok,
        status: response.status,
      });
    } catch (error) {
      preflight.push({
        asset: asset.name,
        ok: false,
        status: null,
        error: String(error?.message ?? error),
      });
    }
  }
  const unreachable = preflight.filter((entry) => !entry.ok);
  if (unreachable.length > 0) {
    console.log("=== C15-G1 Gaussian-splat harness ===");
    for (const entry of unreachable) {
      console.log(
        `[STRUCTURAL] ${entry.asset}: ${BASE}${ASSETS[entry.asset].url} → ${
          entry.error ?? `HTTP ${entry.status}`
        }`,
      );
    }
    console.log(
      "\nGATE INCOMPLETE (structural) — the dev server did not serve the in-tree splat tilesets. " +
        "Start it with `node server.js` from the repo root (it statics the repo root, so no Ion token " +
        "and no network are needed) and re-run.",
    );
    process.exitCode = EXIT_CODE.STRUCTURAL;
    return;
  }

  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });

  const runs = [];
  try {
    for (const asset of assets) {
      // WebGL first: its measured data-commit time DERIVES the WebGPU leg's
      // budget, so the absence claim is "4x what the reference needed".
      const webgl = await runBackend(
        browser,
        "webgl",
        asset,
        PREDICT.dataReadyBudgetMs,
        // The controls are WebGPU-only by construction: the WebGL leg uploads
        // the packed payload into a `Texture` and keeps no CPU copy, and it is
        // the REFERENCE — corrupting it would be corrupting the thing the
        // measurement is against.
        false,
      );
      const derivedBudget = Number.isFinite(webgl?.dataReadyMs)
        ? Math.min(
            PREDICT.dataReadyBudgetMs,
            Math.max(30_000, 4 * webgl.dataReadyMs),
          )
        : PREDICT.dataReadyBudgetMs;
      const webgpu = await runBackend(
        browser,
        "webgpu",
        asset,
        derivedBudget,
        EXPECT_WEBGPU,
      );
      runs.push({ asset, webgl, webgpu, derivedBudget });
    }

    // Parity diffs are only requested in flip mode, and only when both legs
    // produced an ON frame. Decoding two 1024x768 PNGs per asset is not free.
    if (EXPECT_WEBGPU) {
      const page = await browser.newPage({ viewport: VIEW });
      try {
        await page.goto("about:blank");
        for (const run of runs) {
          const a = run.webgl?.pngs?.[`${run.asset.name}-webgl-on`];
          const b = run.webgpu?.pngs?.[`${run.asset.name}-webgpu-on`];
          if (!a || !b) continue;
          run.diff = await page.evaluate(DIFF_IN_PAGE, {
            a,
            b,
            threshold: 3 * BACKGROUND_LEVEL,
          });

          // CO-12 — the per-azimuth cross-backend diffs, and the SH-off leg's
          // cross-backend diffs, both scored against the WebGL leg at the SAME
          // heading. Pairing by HEADING rather than by array position is what
          // makes a lane that captured its orbit in a different order (or
          // dropped one) show up as a missing pair instead of a silently
          // mismatched comparison.
          const referenceByHeading = new Map(
            (run.webgl?.azimuths ?? []).map((entry) => [
              entry.headingDegrees,
              run.webgl?.pngs?.[entry.pngKey],
            ]),
          );
          run.azimuthDiffs = [];
          for (const entry of run.webgpu?.azimuths ?? []) {
            const referencePng = referenceByHeading.get(entry.headingDegrees);
            const webgpuPng = run.webgpu?.pngs?.[entry.pngKey];
            if (!referencePng || !webgpuPng) continue;
            const measured = await page.evaluate(DIFF_IN_PAGE, {
              a: referencePng,
              b: webgpuPng,
              threshold: 3 * BACKGROUND_LEVEL,
            });
            run.azimuthDiffs.push({
              headingDegrees: entry.headingDegrees,
              mismatchFraction: measured.mismatchFraction,
              mismatched: measured.mismatched,
              total: measured.total,
              png: measured.png,
            });
          }
        }
        // Re-walk for the SH-off cross-backend halves: they need one diff per
        // azimuth against the WebGL leg, and keeping them out of the loop above
        // stops a missing SH-off leg from skipping the azimuth diffs with it.
        for (const run of runs) {
          const shOff = run.webgpu?.shOffControl;
          if (shOff?.supported !== true) continue;
          const referenceByHeading = new Map(
            (run.webgl?.azimuths ?? []).map((entry) => [
              entry.headingDegrees,
              run.webgl?.pngs?.[entry.pngKey],
            ]),
          );
          for (const entry of shOff.azimuths ?? []) {
            entry.sameBackendMismatch = fractionOf(
              entry.sameBackendChanged,
              run.webgpu?.canvasPixels,
            );
            const referencePng = referenceByHeading.get(entry.headingDegrees);
            const shOffPng = run.webgpu?.pngs?.[entry.pngKey];
            if (!referencePng || !shOffPng) {
              entry.crossBackendMismatch = Number.NaN;
              continue;
            }
            const measured = await page.evaluate(DIFF_IN_PAGE, {
              a: referencePng,
              b: shOffPng,
              threshold: 3 * BACKGROUND_LEVEL,
            });
            entry.crossBackendMismatch = measured.mismatchFraction;
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Evidence first: if anything below throws, the PNGs are already on disk and
  // the run can still be read by eye.
  for (const run of runs) {
    writePngs(run.webgl);
    writePngs(run.webgpu);
    if (run.diff?.png) {
      const comma = run.diff.png.indexOf(",");
      fs.writeFileSync(
        path.join(OUT, `${run.asset.name}-parity-diff.png`),
        Buffer.from(run.diff.png.slice(comma + 1), "base64"),
      );
    }
    // CO-12 — one diff PNG per orbit position. The row's exit gate says "PNGs
    // read by the author", and an azimuth whose number the author cannot look
    // at is a number nobody checked.
    for (const entry of run.azimuthDiffs ?? []) {
      if (!entry.png) continue;
      const comma = entry.png.indexOf(",");
      fs.writeFileSync(
        path.join(
          OUT,
          `${run.asset.name}-parity-diff-az${entry.headingDegrees}.png`,
        ),
        Buffer.from(entry.png.slice(comma + 1), "base64"),
      );
    }
  }

  console.log("=== C15-G1 Gaussian-splat harness ===");
  console.log(
    `base=${BASE} mode=${
      EXPECT_WEBGPU ? "--expect-webgpu (parity)" : "default (current-state)"
    } viewport=${VIEW.width}x${VIEW.height} camera=boundingSphere*${RANGE_SCALE} pitch=${PITCH_DEGREES}deg`,
  );

  const allFailures = [];
  const allStructural = [];
  const allNotes = [];

  for (const run of runs) {
    const { asset, webgl, webgpu } = run;
    console.log(
      `\n--- ${asset.name} (${asset.expectedSplats} splats, SH degree ${asset.shDegree}) ---`,
    );
    console.log(`  ${describeLane(webgl)}`);
    console.log(`  ${describeLane(webgpu)}`);

    const reference = evaluateReferenceLeg(webgl, asset, PREDICT);
    const webgpuLeg = evaluateWebgpuLeg(webgpu, asset, PREDICT, {
      expectWebgpu: EXPECT_WEBGPU,
    });
    const parity = evaluateParity({
      expectWebgpu: EXPECT_WEBGPU,
      referenceBlind: reference.blind,
      presenceState: webgpuLeg.presence.state,
      mismatchFraction: run.diff?.mismatchFraction,
      asset,
    });
    // CO-12 — the three added lanes. Each takes the SAME two gatekeepers the
    // parity leg does (reference blindness, WebGPU presence) so a run that
    // could not see its subject cannot produce an orbit or a control verdict
    // either.
    const azimuth = evaluateAzimuthLane({
      expectWebgpu: EXPECT_WEBGPU,
      referenceBlind: reference.blind,
      presenceState: webgpuLeg.presence.state,
      asset,
      reference: webgl,
      webgpu: webgpu,
      diffs: run.azimuthDiffs ?? [],
    });
    const shOff = evaluateShOffControl({
      expectWebgpu: EXPECT_WEBGPU,
      referenceBlind: reference.blind,
      presenceState: webgpuLeg.presence.state,
      asset,
      control: webgpu?.shOffControl,
    });
    const covariance = evaluateCovarianceControl({
      expectWebgpu: EXPECT_WEBGPU,
      referenceBlind: reference.blind,
      presenceState: webgpuLeg.presence.state,
      asset,
      control: webgpu?.covarianceControl,
    });
    run.evaluation = {
      reference,
      webgpu: webgpuLeg,
      parity,
      controls: [azimuth, shOff, covariance],
    };

    const addedFraction = fractionOf(
      webgl?.added?.changed,
      webgl?.canvasPixels,
    );
    console.log(
      `  [REFERENCE]  predicted numSplats=${asset.expectedSplats}, >=1 Pass.GAUSSIAN_SPLATS command, added >= ${pct(
        PREDICT.minAddedFraction,
      )} with structure; measured numSplats=${webgl?.numSplats}, cmds=${
        webgl?.splatPassCommands
      }, added=${pct(addedFraction)}  ${
        reference.blind
          ? "STRUCTURAL"
          : reference.failures.length
            ? "FAIL"
            : "PASS"
      }`,
    );
    if (reference.criteria) {
      console.log(
        `               criteria ${Object.entries(reference.criteria)
          .map(([name, ok]) => `${name}=${ok ? "ok" : "RED"}`)
          .join(" ")}`,
      );
    }
    console.log(
      `  [NEG CTRL]   predicted hidden-tileset frame blank and the metric returns to it; measured blank=${
        webgl?.backgroundForeground
      } px, return=${webgl?.negativeControlChanged} px, determinism=${
        webgl?.determinismChanged
      } px (webgl) / ${webgpu?.determinismChanged} px (webgpu)`,
    );
    console.log(
      `  [QUIESCE]    predicted the splat sort is quiet before the BACK-TO-BACK determinism pair; measured quiesced=${
        webgl?.sortQuiesced
      }@${
        webgl?.sortQuiesceMs === null || webgl?.sortQuiesceMs === undefined
          ? "n/a"
          : `${Math.round(webgl.sortQuiesceMs)}ms`
      } sig=${webgl?.sortSignatureAtCapture ?? "n/a"} (webgl) / quiesced=${
        webgpu?.sortQuiesced
      }@${
        webgpu?.sortQuiesceMs === null || webgpu?.sortQuiesceMs === undefined
          ? "n/a"
          : `${Math.round(webgpu.sortQuiesceMs)}ms`
      } sig=${webgpu?.sortSignatureAtCapture ?? "n/a"} (webgpu)`,
    );
    console.log(
      `  [LIVENESS]   predicted >= ${pct(PREDICT.minLivenessFraction)} of the canvas reads back non-background when the scene is painted a known colour; measured ${pct(
        fractionOf(webgl?.captureLivenessForeground, webgl?.canvasPixels),
      )} (webgl) / ${pct(
        fractionOf(webgpu?.captureLivenessForeground, webgpu?.canvasPixels),
      )} (webgpu)`,
    );
    console.log(
      `  [WEBGPU]     presence=${webgpuLeg.presence.state}; ${webgpuLeg.presence.why}`,
    );
    console.log(
      `               blockers=[${(webgpu?.absenceBlockers ?? []).join(", ")}] frKind=${
        webgpu?.featureRendererKind
      } cache.splatCount=${webgpu?.cacheSplatCount} numSplats=${webgpu?.numSplats}`,
    );
    console.log(
      `               layout=${
        webgpu?.cacheLayoutPacked === null ||
        webgpu?.cacheLayoutPacked === undefined
          ? "n/a"
          : webgpu.cacheLayoutPacked
            ? "packed-wasm(32B)"
            : "legacy-record(64B)"
      } recordBytes=${webgpu?.cacheSplatRecordBytes ?? "n/a"} sortedIdx=${
        webgpu?.cacheSortedIndexCount ?? "n/a"
      } packedWords=${webgpu?.packedPayloadWords ?? "n/a"} (predicted ${
        asset.expectedSplats * 8
      } minimum for ${asset.expectedSplats} splats)`,
    );
    console.log(
      `               sort: comparatorSorts=${
        webgpu?.cacheComparatorSorts ?? "n/a"
      } (C15-G4 exit gate: 0) providedUploads=${
        webgpu?.cacheProvidedSortUploads ?? "n/a"
      } (liveness: > 0, else nothing sorted at all) superseded=${
        webgpu?.cacheSupersededSortUploads ?? "n/a"
      } (out-of-order resolutions refused at the upload boundary)`,
    );
    console.log(
      `                 sh: enabled=${webgpu?.cacheShEnabled ?? "n/a"} degree=${
        webgpu?.cacheShDegree ?? "n/a"
      } (C15-G5: both in-tree assets are degree 3) primitiveDegree=${
        webgpu?.primitiveShDegree ?? "n/a"
      } shWords=${webgpu?.primitiveShWords ?? "n/a"} (predicted ${
        asset.expectedSplats * 30
      } for ${asset.expectedSplats} splats at degree 3 = dims 15 x 2 u32). ` +
        `enabled=false with a positive primitiveDegree means the consumer ` +
        `REFUSED the payload - read the console for the short-payload error`,
    );
    console.log(
      `               rendererCommit=${webgpu?.rendererCommitted}@${
        webgpu?.rendererCommitMs === null ||
        webgpu?.rendererCommitMs === undefined
          ? `never/${Math.round(run.derivedBudget ?? 0)}ms budget`
          : `${Math.round(webgpu.rendererCommitMs)}ms`
      } (renderer-owned; separate from the shared data commit above — the ` +
        `feature renderer can lag it by a cold pipeline compile)`,
    );
    console.log(
      `               stage=${STAGE.id} requires=[${
        STAGE.required.join(", ") || "none — default mode cannot certify"
      }] forbids=[${STAGE.retired.join(", ")}]`,
    );
    console.log(`  [PARITY]     ${parity.reason}`);
    console.log(
      `  [AZIMUTH]    predicted ${AZIMUTH_HEADINGS.join("/")} deg, adjacent view directions ${PREDICT.azimuthSeparationDegrees.toFixed(
        3,
      )} deg apart (DERIVED) and each orbit step changing >= ${
        PREDICT.azimuthDistinctnessFactor
      }x the added fraction; ${azimuth.reason || "not scored"}`,
    );
    for (const entry of webgpu?.azimuths ?? []) {
      console.log(
        `               ${String(entry.headingDegrees).padStart(3)}deg webgpu added=${pct(
          fractionOf(entry.added?.changed, entry.canvasPixels),
        )} det=${entry.determinismChanged} quiesced=${entry.sortQuiesced} vsPrev=${
          entry.changedVsPrevious ?? "n/a"
        }`,
      );
    }
    console.log(
      `  [SH-OFF]     predicted the cross-backend mismatch rises back to about ${pct(
        PREDICT.shOffPreG5CubeMismatchFraction,
      )} (recorded pre-C15-G5) at >= ${PREDICT.shOffMinAzimuths} of ${
        AZIMUTH_HEADINGS.length
      } azimuths; ${shOff.reason || "not scored"}${
        webgpu?.shOffControl?.supported === true
          ? ` [flip ${Math.round(webgpu.shOffControl.flipMs)}ms, degree ${webgpu.shOffControl.originalDegree} -> 0 -> ${webgpu.shOffControl.originalDegree}]`
          : ""
      }`,
    );
    console.log(
      `  [COV-CTRL]   predicted one covariance triple x${
        PREDICT.covarianceScaleFactor
      } is visible and every ${PREDICT.covarianceBulkStride}th splat breaches the ${pct(
        asset.parityThresholdFraction,
      )} gate; ${covariance.reason || "not scored"}${
        webgpu?.covarianceControl?.supported === true
          ? ` [corrupted ${webgpu.covarianceControl.splatsCorruptedSingle}/${webgpu.covarianceControl.splatsCorruptedBulk} of ${webgpu.covarianceControl.numSplats}]`
          : ""
      }`,
    );

    for (const note of webgpuLeg.notes) console.log(`  ${note}`);
    for (const lane of run.evaluation.controls) {
      for (const note of lane.notes) console.log(`  [LANE]       ${note}`);
      for (const item of lane.structural) {
        console.log(`  [STRUCTURAL] ${asset.name}: ${item}`);
      }
      for (const item of lane.failures) {
        console.log(`  [FAIL]       ${asset.name}: ${item}`);
      }
    }
    for (const item of [...reference.structural, ...webgpuLeg.structural]) {
      console.log(`  [STRUCTURAL] ${asset.name}: ${item}`);
    }
    for (const item of [...reference.failures, ...webgpuLeg.failures]) {
      console.log(`  [FAIL]       ${asset.name}: ${item}`);
    }

    const folded = foldGsplatVerdict(run.evaluation);
    allFailures.push(...folded.failures.map((f) => `${asset.name}/${f}`));
    allStructural.push(...folded.structural.map((s) => `${asset.name}/${s}`));
    allNotes.push(...folded.notes.map((n) => `${asset.name}: ${n}`));
  }

  const manifestPath = path.join(OUT, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        mode: EXPECT_WEBGPU ? "expect-webgpu" : "current-state",
        viewport: VIEW,
        camera: {
          rangeScale: RANGE_SCALE,
          pitchDegrees: PITCH_DEGREES,
          azimuthHeadings: AZIMUTH_HEADINGS,
        },
        predictions: PREDICT,
        runs: runs.map((run) => ({
          asset: run.asset.name,
          expectedSplats: run.asset.expectedSplats,
          derivedWebgpuDataBudgetMs: run.derivedBudget,
          webgl: withoutPngs(run.webgl),
          webgpu: withoutPngs(run.webgpu),
          diff: run.diff ? { ...run.diff, png: undefined } : null,
          azimuthDiffs: (run.azimuthDiffs ?? []).map((entry) => ({
            ...entry,
            png: undefined,
          })),
          evaluation: run.evaluation,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nmanifest: ${manifestPath}`);
  console.log(`PNGs: ${OUT}/*.png`);

  const verdict = foldGsplatVerdict({
    reference: { failures: allFailures, structural: allStructural },
    webgpu: { failures: [], structural: [], notes: allNotes },
  });
  console.log(
    `\nGATE ${
      verdict.verdict === "FAIL"
        ? "FAIL"
        : verdict.verdict === "STRUCTURAL"
          ? "INCOMPLETE (structural)"
          : "PASS"
    }` +
      (verdict.verdict === "STRUCTURAL"
        ? " — one or more legs could not see their subject. Those are instrument gaps owed as follow-up, NOT product verdicts, and NOT a pass: exit 3 so a structural run can never be mistaken for a green one."
        : ""),
  );
  if (verdict.verdict === "PASS" && !EXPECT_WEBGPU) {
    console.log(
      `The run is green ON THE CURRENT-STATE CONTRACT: the WebGL reference renders splats and ${ABSENT_MARKER}. ` +
        `It is NOT evidence that WebGPU splats work. Re-run with --expect-webgpu — ` +
        `that mode turns this same absence into exit 1.`,
    );
  }
  // C15-G3 — the stage has no required blockers left, so a DEFAULT run can no
  // longer be green on the absence contract. Say so explicitly at the bottom
  // of the log rather than leaving the reader to infer it from a structural
  // line, and say it whether the run went structural or (impossibly) green.
  if (!EXPECT_WEBGPU && STAGE.required.length === 0) {
    console.log(
      `NOTE: ${STAGE.id} retired every named absence blocker, so DEFAULT mode is no longer a certification ` +
        `mode — WebGPU is expected to render splats. Run with --expect-webgpu; that is the mode this row's ` +
        `exit gate is written against.`,
    );
  }
  if (EXPECT_WEBGPU && STAGE.parity?.scored === false) {
    console.log(
      `NOTE: the cross-backend parity diff is MEASURED and PRINTED above but NOT GATED at ${STAGE.id} — ` +
        `${STAGE.parity.reason}. The per-asset thresholds are unchanged and become the gate again at ` +
        `${STAGE.parity.deferredTo}. This run gates on the WebGPU leg's own structure battery + count equality.`,
    );
  }
  process.exitCode = verdict.exitCode;
}

main()
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = EXIT_CODE.ERROR;
  })
  .finally(() => clearTimeout(watchdog));
