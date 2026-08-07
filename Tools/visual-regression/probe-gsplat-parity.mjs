#!/usr/bin/env node
/**
 * `C15-G1` — Gaussian-splat probe harness + WebGL reference leg.
 *
 * This is the instrument every later GSPLAT row's exit gate runs through, and
 * it is deliberately DUAL-MODE. The same probe has to do two opposite jobs at
 * two different points in the track:
 *
 *   DEFAULT (today, C15-G1..G2): the WebGPU splat path renders NOTHING. That is
 *   the documented `C15-G0` baseline. The probe certifies the absence honestly
 *   — it prints the greppable marker `WEBGPU-SPLATS-ABSENT (expected until
 *   C15-G3)` and the overall run stays exit 0 — but ONLY when the absence is
 *   ATTRIBUTABLE to a named, observed blocker in the scaffolded path. A blank
 *   canvas is also what a broken probe, a dead device, or an unloaded tileset
 *   looks like, so an unattributed absence exits 3, not 0.
 *
 *   `--expect-webgpu` (C15-G3+): absence becomes a real product FAIL (exit 1),
 *   and presence hands off to a cross-backend pixel-diff parity gate scored
 *   against the `C15-G8` thresholds (tower < 3%, sh_unit_cube < 1%).
 *
 * THE ABSENCE CONTRACT IS STAGED, NOT A STANDING "at least one blocker"
 * -------------------------------------------------------------------
 * `C15-G2` moved the splat data pipeline above the backend branch and gave the
 * primitive a `show` accessor, which RETIRED two of the four blockers the
 * default mode used to accept. A gate that only asked "was any known blocker
 * seen?" would keep printing the same green marker for a strictly smaller
 * reason and never say so. So `STAGE` in the model names both sets: a retired
 * blocker observed again is a REGRESSION (structural), and a required blocker
 * NOT observed means the absence has some other cause (also structural). The
 * stage is printed on every run next to what was measured.
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
 * Usage:
 *   node Tools/visual-regression/probe-gsplat-parity.mjs
 *   node Tools/visual-regression/probe-gsplat-parity.mjs --asset=tower
 *   node Tools/visual-regression/probe-gsplat-parity.mjs --asset=both
 *   node Tools/visual-regression/probe-gsplat-parity.mjs --expect-webgpu
 * Env:
 *   PROBE_BASE                  default http://localhost:8080
 *   PROBE_GSPLAT_WATCHDOG_MS    default 600000 (raise for --asset=both)
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
  EXIT_CODE,
  PREDICT,
  STAGE,
  evaluateParity,
  evaluateReferenceLeg,
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

const WATCHDOG_MS = Number(process.env.PROBE_GSPLAT_WATCHDOG_MS ?? 600_000);
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
    numSplats: 0,
    isStable: null,
    indexesLength: null,
    sorter: null,
    splatPassCommands: 0,
    commandListSplatCommands: 0,
    cacheSplatCount: null,
    featureRendererKind: null,
    absenceBlockers: [],
    framing: null,
    canvasPixels: canvas.width * canvas.height,
    canvasSize: { width: canvas.width, height: canvas.height },
    captureLivenessForeground: null,
    captureLivenessMean: null,
    backgroundForeground: null,
    determinismChanged: null,
    negativeControlChanged: null,
    added: null,
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
  const sphere = tileset.boundingSphere;
  const range = Math.max(sphere.radius * rangeScale, 10.0);
  scene.camera.lookAt(
    sphere.center,
    new C.HeadingPitchRange(0.0, C.Math.toRadians(pitchDegrees), range),
  );
  // Bake the world-space pose and release the bounding-sphere reference frame,
  // so nothing later in the lane is interpreted in a local frame.
  scene.camera.lookAtTransform(C.Matrix4.IDENTITY);

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
  record.cacheSplatCount = primitive?._webgpuCache?.splatCount ?? null;
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
      primitive._splatCount === undefined
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

  // ── The scored ON frame, bracketed by a repeat capture (determinism).
  tileset.show = true;
  await settleMs(predict.settleMs);
  const onA = captureNow();
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

  await settleMs(predict.settleMs);
  const onB = captureNow();
  record.determinismChanged = changedPixelCount(onA.image, onB.image);

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

async function runBackend(browser, renderer, asset, dataBudgetMs) {
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
      );
      const derivedBudget = Number.isFinite(webgl?.dataReadyMs)
        ? Math.min(
            PREDICT.dataReadyBudgetMs,
            Math.max(30_000, 4 * webgl.dataReadyMs),
          )
        : PREDICT.dataReadyBudgetMs;
      const webgpu = await runBackend(browser, "webgpu", asset, derivedBudget);
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
    run.evaluation = { reference, webgpu: webgpuLeg, parity };

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
      `               stage=${STAGE.id} requires=[${STAGE.required.join(
        ", ",
      )}] forbids=[${STAGE.retired.join(", ")}]`,
    );
    console.log(`  [PARITY]     ${parity.reason}`);

    for (const note of webgpuLeg.notes) console.log(`  ${note}`);
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
        camera: { rangeScale: RANGE_SCALE, pitchDegrees: PITCH_DEGREES },
        predictions: PREDICT,
        runs: runs.map((run) => ({
          asset: run.asset.name,
          expectedSplats: run.asset.expectedSplats,
          derivedWebgpuDataBudgetMs: run.derivedBudget,
          webgl: withoutPngs(run.webgl),
          webgpu: withoutPngs(run.webgpu),
          diff: run.diff ? { ...run.diff, png: undefined } : null,
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
        `It is NOT evidence that WebGPU splats work. When C15-G3 lands, re-run with --expect-webgpu — ` +
        `that mode turns this same absence into exit 1.`,
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
