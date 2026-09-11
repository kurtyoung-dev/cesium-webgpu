#!/usr/bin/env node
/**
 * C11-213 (`UP144-VECTOR-LAYER-WGSL`) — terrain-draped vector polylines and
 * polygon fills, browser acceptance probe.
 * @purpose C11-213 acceptance for terrain-draped vector polylines and polygon fills: backend/placement/material/Jacobian/polygon/cleanup gates with STRUCTURAL verdicts.
 * @status ACTIVE
 *
 * `vector-layer-draping.spec.mjs` (pure Node) proves the ARITHMETIC: the
 * `WebGPUVectorTileResources.packVectorTileWords` word layout agrees with
 * `GlobeTerrain.wgsl::vectorPolylineRender` and `::vectorPolygonRender`, and
 * ten named mutations break it.
 * What a CPU equivalence proof structurally cannot show is that the packed
 * buffer is BOUND, that the storage-buffer read reaches a real fragment, or
 * that the composite survives tile churn. Those are this probe's job.
 *
 * Vehicle: `scene.primitives`, with a CLAMPING height reference. `Scene`'s
 * `markVectorCollections` walks that subtree every frame and calls
 * `vectorProvider.markForFrame` for each drapeable collection it finds, and
 * `GlobeSurfaceTileProvider.initialize` then bakes one `VectorTileData` per
 * RENDERED tile. That mark is PER-FRAME, not a registration: `_beginFrame`
 * prunes every collection that was not marked again in the new frame
 * (`Core/VectorProvider.js:242-256`), so the collection has to stay in
 * `scene.primitives` for the whole run and a one-shot registration at setup
 * could never have kept a drape alive. A clamped collection never draws itself
 * (`BufferPrimitiveCollection#_isRendered` is false for a clamp), so the frames
 * below still measure only the drape.
 *
 * (Until this batch these lanes called `scene.globe.vectorProvider.add(...)`,
 * the pre-1.145 API. The CesiumJS 1.145 sync replaced it with `markForFrame`
 * and there is no `add` on `VectorProvider` any more, so every lane threw and
 * every gate here was unrunnable. Fixed with gate G, below.)
 *
 * Two `BufferPolylineCollection` primitives, `allowPicking: true`, with
 * deliberately asymmetric materials:
 *
 *     primitive 0 — pure RED,  width  4 px, meridian lon -105.0
 *     primitive 1 — pure BLUE, width 16 px, meridian lon -104.0
 *
 * Equal on-screen length, 4x width ratio, opposite colour channels. That pairing
 * is what makes the two most likely silent packer defects observable in pixels:
 *
 *   * an RGBA/BGRA order flip (`unpack4x8unorm` is low-byte-first) renders the
 *     THIN line blue and the THICK line red, which inverts the blue:red changed
 *     pixel ratio — a colour-only check would still see "one red, one blue" and
 *     pass;
 *   * a dropped segment→primitive indirection collapses both lines onto one
 *     material, so exactly one colour class survives.
 *
 * GATES (each printed predicted-vs-measured)
 *   A BACKEND      `scene.context.rendererType` equals the requested backend on
 *                  BOTH lanes. A silent WebGL fallback must HARD-FAIL: a probe
 *                  that scores a WebGL frame as a WebGPU pass is a false green.
 *   B PLACEMENT    changed-pixel centroid / bbox / count agree across backends.
 *                  A blank WebGPU pane is the pre-fix symptom and fails here.
 *   C MATERIAL     both colour classes present AND blue:red changed-pixel ratio
 *                  tracks the 4x width ratio (predicted ~4, gate >= 2).
 *   D JACOBIAN     grazing view: the thick line's PERPENDICULAR screen width is
 *                  constant near vs far. `screenFromUv` exists precisely so an
 *                  anisotropically foreshortened tile keeps a pixel-space width;
 *                  a hoisted/incorrect derivative shows up here, not head-on.
 *   E CLEAN        zero console / uncaptured-device errors across the whole run,
 *                  specifically no "Destroyed buffer used in a submit" after
 *                  panning tiles out of and back into view (that path is
 *                  `VectorPipeline.freeResources` → `rendererResources.destroy()`
 *                  racing the next submit).
 *   F NON-REGRESS  a vector-free globe is byte-identical before the collections
 *                  are added and after they are removed (the placeholder
 *                  early-out claims to be free), and — when a baseline recorded
 *                  on a pre-change build is present — identical to that too.
 *   G PICK         the C-05 acceptance. `scene.pick` on the thick line returns
 *                  that line (primitive index 1) and on the thin one returns
 *                  index 0, on BOTH backends; a pick one full stroke width to
 *                  the side returns nothing on the default globe. With
 *                  `globe.pickable` set — honored by WebGPU only — the same
 *                  off-line point returns the Globe and the on-line point still
 *                  returns the line, so the draped composite is an addition to
 *                  the globe's own answer rather than a replacement for it.
 *                  Asserting the INDEX is what makes a pick word read from the
 *                  wrong record fail: a shifted or mis-strided pick run answers
 *                  with the other primitive rather than with nothing.
 *   H POLYGON      the polygon fills (v1.144, re-gated in v1.145). A pure-GREEN
 *                  clamped `BufferPolygonCollection` area, wider than a tile at
 *                  this level so it must survive
 *                  per-tile clipping and the cell-grouped even-odd walk:
 *                  painted-fill pixel COUNT and BBOX agree across backends at
 *                  nadir AND oblique, and one MIXED frame carries the fill plus
 *                  BOTH strokes — a fill composited over the lines instead of
 *                  under them collapses the stroke classes.
 *
 * STRUCTURAL, never FAIL, when a leg cannot see its own subject: if the WebGL
 * reference lane itself draped nothing, gates B/C/D/H are measuring an empty
 * frame. Scoring that as FAIL files a phantom defect against WebGPU; scoring it
 * as PASS is a false green. It reports STRUCTURAL and says what is missing.
 *
 * Gate A covers H: a silent WebGL fallback HARD-FAILS the run before any
 * cross-backend number below is read, the polygon leg's included.
 *
 * READINESS is binned `Pass.GLOBE` commands reaching `view.frustumCommandsList`
 * plus a WALL-CLOCK settle budget — never `tilesLoaded` alone and never a frame
 * count. A cold globe pipeline variant has measured ~2674 ms to compile, which
 * a 60-frame budget silently under-runs.
 *
 * Usage:
 *   node Tools/visual-regression/probe-vector-draping.mjs
 *   node Tools/visual-regression/probe-vector-draping.mjs --update-baseline
 * Env:
 *   PROBE_BASE     default http://localhost:8080
 *   PROBE_TERRAIN  "world" attaches Cesium World Terrain (needs Ion + network).
 *                  Default is the offline ellipsoid globe: the drape bake is
 *                  per SURFACE TILE and independent of terrain heights, so the
 *                  storage-buffer path is exercised either way and the frames
 *                  stay deterministic enough for the byte-identity gate.
 * Out:
 *   Tools/visual-regression/output/vector-draping/*.png + manifest.json
 * Exit:
 *   0 every gate decided and passed | 1 a real product FAIL |
 *   2 watchdog or exception | 3 no FAIL but a gate had no subject to
 *     measure (acceptance INCOMPLETE, not green)
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

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/vector-draping";
const VIEW = { width: 1024, height: 768 };
const USE_WORLD_TERRAIN = process.env.PROBE_TERRAIN === "world";
const UPDATE_BASELINE =
  process.argv.includes("--update-baseline") ||
  process.env.PROBE_UPDATE_BASELINE === "1";

const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(`STRUCTURAL: probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

// ── Predictions. Every gate prints predicted vs measured so a red is
// diagnosable from the log alone, without a second run.
const PREDICT = {
  // Equal-length lines, widths 4 and 16 px.
  widthRatio: 4.0,
  widthRatioMin: 2.0,
  // Line width is a PIXEL quantity on both backends, so foreshortening must
  // not change it.
  jacobianRatio: 1.0,
  jacobianBand: [0.4, 2.5],
  // Cross-backend placement agreement.
  centroidMaxDelta: 8.0,
  bboxMaxDelta: 16.0,
  countRatioBand: [0.6, 1.67],
  // Below this the reference lane drew nothing worth measuring.
  minChangedPixels: 400,
  // Rows needed in each depth third before the Jacobian leg has an opinion.
  minJacobianRows: 8,
  // Fraction of the polyline-only frame's stroke pixels that must survive when
  // a fill is draped under them in the same frame. Not 1.0: the fill changes
  // what the anti-aliased stroke edges blend against, so a few boundary pixels
  // legitimately fall out of the stroke colour classes. A fill composited OVER
  // the strokes (the wrong order) takes this to near zero.
  mixedStrokeSurvivalMin: 0.6,
};

/**
 * Everything below runs INSIDE the page. `page.evaluate` serializes the
 * function source and drops the surrounding closure, so every helper this lane
 * needs is defined here rather than imported — the recorded trap from the
 * shared-helper work.
 */
const RUN_LANE = async ({ renderer, view, useWorldTerrain, predict }) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;

  const rendererType = String(scene.context?.rendererType ?? "").toLowerCase();

  // ── Deterministic scene. Anything that animates on its own would make the
  // byte-identity gate (F) meaningless.
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  const frameTime = C.JulianDate.fromIso8601("2026-06-01T18:00:00Z");
  viewer.clock.currentTime = frameTime;
  scene.globe.show = true;
  scene.globe.imageryLayers.removeAll();
  scene.globe.baseColor = C.Color.fromBytes(64, 64, 64);
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.depthTestAgainstTerrain = true;
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

  let terrainAttached = "ellipsoid";
  if (useWorldTerrain && typeof C.createWorldTerrainAsync === "function") {
    try {
      scene.terrainProvider = await C.createWorldTerrainAsync();
      terrainAttached = "cesium-world-terrain";
    } catch {
      terrainAttached = "ellipsoid (world terrain unavailable)";
    }
  }

  // ── Same-task capture: render and read the canvas element without yielding
  // in between. A read across a rAF yield is invalid on BOTH backends.
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
    let frames = 0;
    while (performance.now() < deadline) {
      renderNow();
      frames++;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return frames;
  };

  // ── Readiness: binned Pass.GLOBE commands, never `tilesLoaded` alone.
  // `tilesLoaded` can go true while the globe's pipeline variant is still
  // compiling, which is exactly the window a frame-count budget lands in.
  if (!C.Pass || !Number.isInteger(C.Pass.GLOBE)) {
    throw new Error("Pass.GLOBE is not exported; readiness cannot be binned");
  }
  const binnedGlobeCommands = () => {
    const frustums = scene._view?.frustumCommandsList ?? [];
    let total = 0;
    for (const frustum of frustums) {
      total += frustum?.indices ? frustum.indices[C.Pass.GLOBE] | 0 : 0;
    }
    return total;
  };
  const awaitGlobeReady = async (minimumSettleMs, budgetMs) => {
    const start = performance.now();
    let binned = 0;
    let firstBinnedMs = null;
    while (performance.now() - start < budgetMs) {
      renderNow();
      binned = binnedGlobeCommands();
      if (binned > 0 && firstBinnedMs === null) {
        firstBinnedMs = performance.now() - start;
      }
      // WALL CLOCK, not frames: a cold pipeline variant has measured ~2674 ms
      // to compile and a frame budget silently under-runs it.
      if (
        firstBinnedMs !== null &&
        performance.now() - start >= minimumSettleMs
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return {
      binnedGlobeCommands: binned,
      firstBinnedMs,
      elapsedMs: performance.now() - start,
      tilesLoaded: scene.globe.tilesLoaded === true,
    };
  };

  // ── Pixel helpers.
  const hashPixels = (data) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      hash ^= data[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  const changedPixelCount = (a, b) => {
    if (a.width !== b.width || a.height !== b.height) {
      return a.width * a.height;
    }
    let changed = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (
        a.data[i] !== b.data[i] ||
        a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] ||
        a.data[i + 3] !== b.data[i + 3]
      ) {
        changed++;
      }
    }
    return changed;
  };

  /**
   * Classify every pixel the vector layer ADDED. Classification reads the ON
   * frame's own channels, so a colour swap moves pixels between classes rather
   * than merely dimming a mean.
   */
  const analyzeChanged = (onFrame, offFrame) => {
    const { width, height, data } = onFrame;
    const off = offFrame.data;
    let changed = 0;
    let red = 0;
    let blue = 0;
    // The polygon leg's fill colour. Classified on the same dominant-channel
    // rule as the two line colours, so a mixed frame reports all three classes
    // from one pass and a fill that swallowed its strokes is visible as the
    // line classes collapsing rather than as a single "changed" number moving.
    let green = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    // Per-row contiguous runs of BLUE (the thick line) — the Jacobian leg's
    // raw material. Meridional lines run vertically on screen in both views,
    // so a row run IS the line's perpendicular screen width.
    const blueRowRun = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      let run = 0;
      let best = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const delta =
          Math.abs(data[i] - off[i]) +
          Math.abs(data[i + 1] - off[i + 1]) +
          Math.abs(data[i + 2] - off[i + 2]);
        if (delta === 0) {
          run = 0;
          continue;
        }
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
        if (r > b + 30 && r > g + 30) {
          red++;
          run = 0;
        } else if (b > r + 30 && b > g + 30) {
          blue++;
          run++;
          if (run > best) best = run;
        } else if (g > r + 30 && g > b + 30) {
          green++;
          run = 0;
        } else {
          run = 0;
        }
      }
      blueRowRun[y] = best;
    }
    return {
      width,
      height,
      changed,
      red,
      blue,
      green,
      centroid:
        changed > 0
          ? [sumX / changed, sumY / changed]
          : [Number.NaN, Number.NaN],
      bbox: maxX < 0 ? null : [minX, minY, maxX, maxY],
      blueRowRun: Array.from(blueRowRun),
    };
  };

  // ── Views. Meridional lines render VERTICALLY on screen under a north-facing
  // camera in both the nadir and the grazing view, which is what makes a
  // per-row horizontal run equal the line's perpendicular screen width.
  // ~90 km apart at this latitude: far enough that the two lines stay resolved
  // even at the FAR end of the grazing view, where they converge toward the
  // vanishing point. If they merged there, red pixels would break the blue
  // runs and bias the Jacobian ratio downward for reasons that have nothing to
  // do with the derivative under test.
  const LON_RED = -105.0;
  const LON_BLUE = -104.0;
  const LAT_SOUTH = 36.0;
  const LAT_NORTH = 41.0;
  // Mid-line, well inside both meridians, and a lateral offset of one full
  // stroke width of the THICK line — twice its 8 px half-extent.
  const PICK_LAT = 38.5;
  const PICK_OFFSET_PX = 16;
  const nadirView = () =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-104.5, 38.5, 700_000.0),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
    });
  // Grazing: the far end of each line is ~700 km out at an 80 km eye height, so
  // the along-line axis is compressed hard while the across-line axis is not.
  // That anisotropy is exactly what `screenFromUv` is for.
  const obliqueView = () =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-104.5, 34.4, 80_000.0),
      orientation: { heading: 0, pitch: C.Math.toRadians(-10), roll: 0 },
    });
  const awayView = () =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(121.0, -28.0, 3_000_000.0),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
    });

  const meridian = (longitude) => {
    const positions = [];
    for (let lat = LAT_SOUTH; lat <= LAT_NORTH + 1e-9; lat += 0.05) {
      const p = C.Cartesian3.fromDegrees(longitude, lat, 0.0);
      positions.push(p.x, p.y, p.z);
    }
    return new Float64Array(positions);
  };

  // ── The POLYGON leg's subject: one clamped filled AREA, pure GREEN so it
  // classifies away from both line colours in `analyzeChanged`. It brackets
  // both meridians and is deliberately WIDER than a tile at this level, so the
  // fill has to survive per-tile clipping and the cell-grouped even-odd walk
  // rather than landing inside one cell of one tile. Densified along each side
  // for the same reason the meridians are: a four-vertex ring in geodetic
  // degrees does not follow the ellipsoid between its corners.
  const AREA_WEST = -105.6;
  const AREA_EAST = -103.4;
  const AREA_SOUTH = 36.6;
  const AREA_NORTH = 40.4;
  const clampedArea = () => {
    const ring = [];
    const push = (longitude, latitude) => {
      const p = C.Cartesian3.fromDegrees(longitude, latitude, 0.0);
      ring.push(p.x, p.y, p.z);
    };
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      push(AREA_WEST + ((AREA_EAST - AREA_WEST) * i) / steps, AREA_SOUTH);
    }
    for (let i = 0; i < steps; i++) {
      push(AREA_EAST, AREA_SOUTH + ((AREA_NORTH - AREA_SOUTH) * i) / steps);
    }
    for (let i = 0; i < steps; i++) {
      push(AREA_EAST - ((AREA_EAST - AREA_WEST) * i) / steps, AREA_NORTH);
    }
    for (let i = 0; i < steps; i++) {
      push(AREA_WEST, AREA_NORTH - ((AREA_NORTH - AREA_SOUTH) * i) / steps);
    }
    return new Float64Array(ring);
  };
  const makeAreaCollection = () => {
    const areas = new C.BufferPolygonCollection({
      primitiveCountMax: 4,
      vertexCountMax: 512,
      holeCountMax: 4,
      triangleCountMax: 512,
      heightReference: C.HeightReference.CLAMP_TO_TERRAIN,
    });
    areas.add({
      positions: clampedArea(),
      material: new C.BufferPolygonMaterial({
        color: new C.Color(0.0, 1.0, 0.0, 1.0),
      }),
    });
    return areas;
  };

  nadirView();
  const readiness = await awaitGlobeReady(3000, 90_000);

  // Vector-free reference, captured twice with a camera excursion in between:
  // the second capture is the DETERMINISM control for gate F. If the renderer
  // cannot reproduce a frame byte-for-byte, "exactly 0 changed pixels" is not a
  // resolvable measurement and F reports STRUCTURAL rather than FAIL.
  // Extra settle before the FIRST reference frame: `awaitGlobeReady` returns as
  // soon as its wall-clock budget is met, and a frame captured on that boundary
  // can still be one LOD step behind, which would show up as a false
  // determinism miss in gate F rather than as anything about vectors.
  await settleMs(1500);
  const freeA = captureNow();
  obliqueView();
  await settleMs(1500);
  const obliqueFree = captureNow();
  nadirView();
  await settleMs(1500);
  const freeB = captureNow();
  const determinismChanged = changedPixelCount(freeA.image, freeB.image);

  // ── Drape. The collection goes into `scene.primitives` with a CLAMPING
  // height reference, which is the only vehicle there is: `Scene`'s
  // `markVectorCollections` walks that subtree each frame and calls
  // `vectorProvider.markForFrame` for every drapeable collection it finds
  // (`BufferPrimitiveCollection#heightReference`: "Draping requires that the
  // collection has been added to Scene#primitives"). A clamped collection does
  // not draw itself — `_isRendered` is false for a clamp — so what the frames
  // below measure is still only the drape.
  //
  // This probe used to call `scene.globe.vectorProvider.add(collection)`, which
  // was the API before the CesiumJS 1.145 sync replaced it with `markForFrame`.
  // There is no `add` on `VectorProvider` at HEAD, so that line threw and every
  // gate in this file has been unrunnable since the sync landed.
  //
  // `allowPicking` is what makes the pick leg have a subject:
  // `BufferPrimitiveCollection#update` allocates a pick id per primitive only
  // when it is set, and `VectorPipeline._writePickColor` bakes those ids into
  // the per-primitive pick colours both backends composite in the pick pass.
  const collection = new C.BufferPolylineCollection({
    primitiveCountMax: 8,
    vertexCountMax: 1024,
    allowPicking: true,
    heightReference: C.HeightReference.CLAMP_TO_GROUND,
  });
  collection.add({
    positions: meridian(LON_RED),
    material: new C.BufferPolylineMaterial({
      color: new C.Color(1.0, 0.0, 0.0, 1.0),
      width: 4,
    }),
  });
  collection.add({
    positions: meridian(LON_BLUE),
    material: new C.BufferPolylineMaterial({
      color: new C.Color(0.0, 0.0, 1.0, 1.0),
      width: 16,
    }),
  });
  scene.primitives.add(collection);

  await settleMs(3000);
  const nadirOn = captureNow();
  const nadirMetrics = analyzeChanged(nadirOn.image, freeB.image);

  obliqueView();
  await settleMs(3000);
  const obliqueOn = captureNow();
  const obliqueMetrics = analyzeChanged(obliqueOn.image, obliqueFree.image);

  // ── Tile churn. Panning the drape region out of view releases each tile's
  // `VectorTileData` (`GlobeSurfaceTile.freeResources` → `VectorPipeline
  // .freeResources` → `rendererResources.destroy()`), and panning back re-bakes
  // it. A buffer destroyed while a submitted command still references it
  // surfaces as "Destroyed buffer used in a submit" on the device error scope.
  let churnCycles = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    awayView();
    await settleMs(1200);
    nadirView();
    await settleMs(1200);
    churnCycles++;
  }
  await settleMs(2000);
  const nadirOnAfterChurn = captureNow();
  const churnMetrics = analyzeChanged(nadirOnAfterChurn.image, freeB.image);
  const churnStability = changedPixelCount(
    nadirOn.image,
    nadirOnAfterChurn.image,
  );

  // ── Pick (gate G). `scene.pick` at a canvas point ON the thick line's
  // centreline, and at one a full stroke width to the side of it. The blue
  // line is 16 px wide, so its half-extent is 8 px and a 16 px lateral offset
  // is unambiguously off it while still being on the same tiles.
  //
  // Measured at the nadir view, where a meridian runs vertically down the
  // screen, so a lateral offset is a pure +x step in canvas space.
  nadirView();
  await settleMs(1500);
  renderNow();

  const classifyPick = (picked) => {
    if (picked === undefined || picked === null) return "none";
    if (picked.collection === collection) return `vector:${picked.index}`;
    if (picked.primitive === scene.globe || picked.id === scene.globe) {
      return "globe";
    }
    return "other";
  };
  const pickAt = (longitude, offsetPixels) => {
    const carto = C.Cartesian3.fromDegrees(longitude, PICK_LAT, 0.0);
    const screen = scene.cartesianToCanvasCoordinates(carto);
    if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) {
      return { resolved: false, why: `no canvas coordinate at ${longitude}` };
    }
    const point = new C.Cartesian2(
      Math.round(screen.x + offsetPixels),
      Math.round(screen.y),
    );
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= canvas.clientWidth ||
      point.y >= canvas.clientHeight
    ) {
      return {
        resolved: false,
        why: `pick point (${point.x}, ${point.y}) is off-canvas`,
      };
    }
    let picked;
    try {
      picked = scene.pick(point);
    } catch (error) {
      return { resolved: false, why: `scene.pick threw: ${error.message}` };
    }
    return {
      resolved: true,
      x: point.x,
      y: point.y,
      what: classifyPick(picked),
    };
  };

  // `globe.pickable` is false by default on both backends, which is the state
  // every app starts in: a pick that misses the line must NOT come back as the
  // draped primitive, and on the default globe it comes back as nothing.
  const pick = {
    globePickableDefault: scene.globe.pickable === true,
    onThickLine: pickAt(LON_BLUE, 0),
    offThickLine: pickAt(LON_BLUE, PICK_OFFSET_PX),
    onThinLine: pickAt(LON_RED, 0),
  };
  // With the globe opted in, the same off-line point must answer "globe" —
  // the draped composite must not have taken that answer away from it. The
  // flag is honored by the WebGPU backend only (`Globe#pickable`), so the
  // WebGL lane records what it says without being gated on it.
  scene.globe.pickable = true;
  await settleMs(600);
  renderNow();
  pick.onThickLinePickableGlobe = pickAt(LON_BLUE, 0);
  pick.offThickLinePickableGlobe = pickAt(LON_BLUE, PICK_OFFSET_PX);
  scene.globe.pickable = false;
  await settleMs(600);

  // ── MIXED leg (gate H). Both families draped in ONE frame, which is the case
  // the shared primitive index space and the composite order both bear on: the
  // strokes must still be there ON TOP of the fill, so all three colour classes
  // survive. A fill that swallowed its strokes shows up as the line classes
  // collapsing, not as a changed-pixel total moving. It runs HERE, ahead of the
  // polyline teardown, because `PrimitiveCollection.remove` DESTROYS what it
  // removes under default ownership: the strokes can only be measured while the
  // collection carrying them is still alive. The view is nadir on exit from the
  // churn loop, so `freeB` is the matching vector-free reference — the same one
  // `nadirMetrics` and `churnMetrics` use.
  const mixedAreas = makeAreaCollection();
  scene.primitives.add(mixedAreas);
  await settleMs(3000);
  const nadirMixed = captureNow();
  const nadirMixedMetrics = analyzeChanged(nadirMixed.image, freeB.image);

  // Provider first, then the scene: `VectorProvider.remove` needs a live object
  // and `PrimitiveCollection.remove` destroys it.
  scene.globe.vectorProvider.remove(mixedAreas);
  scene.primitives.remove(mixedAreas);

  // ── Removal → the vector-free globe must come back byte-identical.
  // `VectorProvider#remove` drops the collection immediately and dirties its
  // region; the primitive removal that follows destroys the collection, and
  // the provider must not be holding a destroyed collection when it next
  // reads a bounding volume.
  scene.globe.vectorProvider.remove(collection);
  scene.primitives.remove(collection);
  await settleMs(3000);
  const freeC = captureNow();
  const removalChanged = changedPixelCount(freeA.image, freeC.image);

  // ── POLYGON leg (gate H). The globe is vector-free again here, so `freeC`
  // (nadir) and `obliqueFree` are the references the fill is measured against.
  // Painted-fill pixel COUNT and BBOX are the two numbers compared across
  // backends: a count alone cannot tell a correctly placed fill from one
  // shifted by a cell, and a bbox alone cannot tell a solid fill from its
  // outline. A FRESH collection — the mixed leg destroyed its own.
  const areas = makeAreaCollection();
  scene.primitives.add(areas);
  await settleMs(3000);
  const nadirPolygon = captureNow();
  const nadirPolygonMetrics = analyzeChanged(nadirPolygon.image, freeC.image);

  obliqueView();
  await settleMs(3000);
  const obliquePolygon = captureNow();
  const obliquePolygonMetrics = analyzeChanged(
    obliquePolygon.image,
    obliqueFree.image,
  );

  nadirView();
  scene.globe.vectorProvider.remove(areas);
  scene.primitives.remove(areas);
  await settleMs(3000);
  const freeD = captureNow();
  const polygonRemovalChanged = changedPixelCount(freeA.image, freeD.image);

  // ── Jacobian: perpendicular screen width of the thick line, near vs far.
  const jacobian = (() => {
    const runs = obliqueMetrics.blueRowRun;
    const occupied = [];
    for (let y = 0; y < runs.length; y++) {
      if (runs[y] > 0) occupied.push(y);
    }
    if (occupied.length < predict.minJacobianRows * 3) {
      return {
        resolved: false,
        why: `only ${occupied.length} screen rows carry the thick line; a near/far split needs at least ${predict.minJacobianRows * 3}`,
        occupiedRows: occupied.length,
      };
    }
    const third = Math.floor(occupied.length / 3);
    // Screen-down is toward the camera in a north-facing grazing view, so the
    // LAST third of occupied rows is the NEAR end.
    const farRows = occupied.slice(0, third);
    const nearRows = occupied.slice(occupied.length - third);
    const mean = (rows) =>
      rows.reduce((sum, y) => sum + runs[y], 0) / Math.max(rows.length, 1);
    const nearWidth = mean(nearRows);
    const farWidth = mean(farRows);
    if (
      nearRows.length < predict.minJacobianRows ||
      farRows.length < predict.minJacobianRows ||
      nearWidth <= 0 ||
      farWidth <= 0
    ) {
      return {
        resolved: false,
        why: `near/far row counts ${nearRows.length}/${farRows.length} or widths ${nearWidth}/${farWidth} are too thin to compare`,
        occupiedRows: occupied.length,
      };
    }
    return {
      resolved: true,
      occupiedRows: occupied.length,
      nearWidth,
      farWidth,
      ratio: farWidth / nearWidth,
    };
  })();

  const dropRowRuns = (metrics) => {
    const { blueRowRun: _rows, ...rest } = metrics;
    return rest;
  };

  const pngs = {
    [`${renderer}-nadir-vectorfree`]: freeA.png,
    [`${renderer}-nadir-vector`]: nadirOn.png,
    [`${renderer}-nadir-vector-after-churn`]: nadirOnAfterChurn.png,
    [`${renderer}-oblique-vectorfree`]: obliqueFree.png,
    [`${renderer}-oblique-vector`]: obliqueOn.png,
    [`${renderer}-nadir-vectorfree-after-removal`]: freeC.png,
    [`${renderer}-nadir-polygon`]: nadirPolygon.png,
    [`${renderer}-oblique-polygon`]: obliquePolygon.png,
    [`${renderer}-nadir-mixed`]: nadirMixed.png,
    [`${renderer}-nadir-vectorfree-after-polygon-removal`]: freeD.png,
  };

  return {
    rendererType,
    terrainAttached,
    readiness,
    viewport: { width: view.width, height: view.height },
    canvasSize: { width: canvas.width, height: canvas.height },
    determinismChanged,
    removalChanged,
    pick,
    polygonRemovalChanged,
    churnCycles,
    churnStability,
    // `blueRowRun` is a per-row array only the Jacobian leg needs; it is
    // already reduced into `jacobian` above, so it is dropped from the record.
    nadir: dropRowRuns(nadirMetrics),
    churn: dropRowRuns(churnMetrics),
    oblique: dropRowRuns(obliqueMetrics),
    nadirPolygon: dropRowRuns(nadirPolygonMetrics),
    obliquePolygon: dropRowRuns(obliquePolygonMetrics),
    nadirMixed: dropRowRuns(nadirMixedMetrics),
    jacobian,
    hashes: {
      vectorFreeBefore: hashPixels(freeA.image.data),
      vectorFreeAfterRemoval: hashPixels(freeC.image.data),
      vectorOn: hashPixels(nadirOn.image.data),
    },
    pngs,
  };
};

function attachPageErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(`console.error: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function filteredErrors(errors) {
  return [...new Set(errors)].filter(
    // Deliberately narrow. A broad filter (e.g. "Failed to load
    // resource") would mask exactly the class of error these gates exist to
    // catch.
    (error) => !/favicon|Ion access token/i.test(error),
  );
}

async function runBackend(browser, renderer) {
  const page = await browser.newPage({ viewport: VIEW });
  const pageErrors = attachPageErrors(page);
  const consoleGate = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}${
        USE_WORLD_TERRAIN ? "" : "&offline=true"
      }`,
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer?.scene, null, {
      timeout: 90_000,
    });
    if (renderer === "webgpu") {
      await armWebGPUDevices(page);
    }
    const result = await page.evaluate(RUN_LANE, {
      renderer,
      view: VIEW,
      useWorldTerrain: USE_WORLD_TERRAIN,
      predict: PREDICT,
    });
    const gate = await collectGateErrors(page);
    const errors = filteredErrors([
      ...pageErrors,
      ...consoleGate,
      ...(gate.errors ?? []),
      ...(gate.deviceLost ? [gate.deviceLost] : []),
    ]);
    return { requested: renderer, ...result, errors };
  } finally {
    await page.close().catch(() => {});
  }
}

function writePngs(record) {
  for (const [name, dataUrl] of Object.entries(record.pngs ?? {})) {
    const comma = dataUrl.indexOf(",");
    fs.writeFileSync(
      path.join(OUT, `${name}.png`),
      Buffer.from(dataUrl.slice(comma + 1), "base64"),
    );
  }
}

function withoutPngs(record) {
  const { pngs: _pngs, ...rest } = record;
  return rest;
}

function verdict(value) {
  if (value === null) return "STRUCTURAL";
  return value ? "PASS" : "FAIL";
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });

  let webgl;
  let webgpu;
  try {
    webgl = await runBackend(browser, "webgl");
    webgpu = await runBackend(browser, "webgpu");
  } finally {
    await browser.close().catch(() => {});
  }
  writePngs(webgl);
  writePngs(webgpu);

  console.log("=== C11-213 vector draping acceptance ===");
  console.log(
    `terrain: ${webgl.terrainAttached} / ${webgpu.terrainAttached}  (PROBE_TERRAIN=world attaches Cesium World Terrain)`,
  );
  for (const lane of [webgl, webgpu]) {
    console.log(
      `${lane.requested.padEnd(6)} rendererType=${lane.rendererType} ` +
        `readiness{binnedGlobe=${lane.readiness.binnedGlobeCommands} firstBinnedMs=${
          lane.readiness.firstBinnedMs === null
            ? "never"
            : Math.round(lane.readiness.firstBinnedMs)
        } elapsedMs=${Math.round(lane.readiness.elapsedMs)} tilesLoaded=${lane.readiness.tilesLoaded}} ` +
        `changed=${lane.nadir.changed} red=${lane.nadir.red} blue=${lane.nadir.blue} errs=${lane.errors.length}`,
    );
  }

  // ── Gate A — backend identity. Checked FIRST: every other number below is
  // meaningless if the WebGPU lane silently fell back to WebGL.
  const gateA =
    webgl.rendererType === "webgl" && webgpu.rendererType === "webgpu";
  console.log(
    `\n[A BACKEND]    predicted webgl/webgpu  measured ${webgl.rendererType}/${webgpu.rendererType}  ${verdict(gateA)}`,
  );

  // Blind-leg precondition: if the REFERENCE backend draped nothing, gates
  // B/C/D are measuring an empty frame on both sides.
  const referenceDrew = webgl.nadir.changed >= PREDICT.minChangedPixels;
  const blindWhy = `WebGL reference draped ${webgl.nadir.changed} changed px (floor ${PREDICT.minChangedPixels}) — the vector bake never reached the reference frame, so this leg measured an empty scene (instrument gap, NOT a product verdict)`;

  // ── Gate B — cross-backend placement.
  let gateB = null;
  let bDetail = blindWhy;
  if (referenceDrew) {
    const dx = Math.abs(webgl.nadir.centroid[0] - webgpu.nadir.centroid[0]);
    const dy = Math.abs(webgl.nadir.centroid[1] - webgpu.nadir.centroid[1]);
    const countRatio = webgpu.nadir.changed / Math.max(webgl.nadir.changed, 1);
    const bboxDelta =
      webgl.nadir.bbox && webgpu.nadir.bbox
        ? Math.max(
            ...webgl.nadir.bbox.map((v, i) =>
              Math.abs(v - webgpu.nadir.bbox[i]),
            ),
          )
        : Number.POSITIVE_INFINITY;
    gateB =
      dx <= PREDICT.centroidMaxDelta &&
      dy <= PREDICT.centroidMaxDelta &&
      bboxDelta <= PREDICT.bboxMaxDelta &&
      countRatio >= PREDICT.countRatioBand[0] &&
      countRatio <= PREDICT.countRatioBand[1];
    bDetail =
      `centroid dx/dy predicted <=${PREDICT.centroidMaxDelta} measured ${dx.toFixed(1)}/${dy.toFixed(1)}; ` +
      `bbox delta predicted <=${PREDICT.bboxMaxDelta} measured ${bboxDelta === Number.POSITIVE_INFINITY ? "n/a" : bboxDelta}; ` +
      `count ratio predicted ~1.0 in [${PREDICT.countRatioBand}] measured ${countRatio.toFixed(3)} ` +
      `(webgl ${webgl.nadir.changed} vs webgpu ${webgpu.nadir.changed})`;
  }
  console.log(`[B PLACEMENT]  ${bDetail}  ${verdict(gateB)}`);

  // ── Gate C — per-primitive colour AND width, on both lanes.
  let gateC = null;
  let cDetail = blindWhy;
  if (referenceDrew) {
    const rows = [webgl, webgpu].map((lane) => {
      const ratio = lane.nadir.blue / Math.max(lane.nadir.red, 1);
      const bothClasses = lane.nadir.red > 0 && lane.nadir.blue > 0;
      return {
        lane: lane.requested,
        red: lane.nadir.red,
        blue: lane.nadir.blue,
        ratio,
        ok: bothClasses && ratio >= PREDICT.widthRatioMin,
      };
    });
    gateC = rows.every((row) => row.ok);
    cDetail =
      `blue:red predicted ~${PREDICT.widthRatio.toFixed(1)} (>=${PREDICT.widthRatioMin}), both classes non-empty; ` +
      rows
        .map(
          (row) =>
            `${row.lane} red=${row.red} blue=${row.blue} ratio=${row.ratio.toFixed(2)}`,
        )
        .join("; ");
  }
  console.log(`[C MATERIAL]   ${cDetail}  ${verdict(gateC)}`);

  // ── Gate D — screenFromUv Jacobian under grazing foreshortening.
  let gateD = null;
  let dDetail;
  if (!referenceDrew) {
    dDetail = blindWhy;
  } else if (!webgl.jacobian.resolved || !webgpu.jacobian.resolved) {
    dDetail = `unresolved — webgl: ${webgl.jacobian.why ?? "ok"}; webgpu: ${webgpu.jacobian.why ?? "ok"}`;
  } else {
    const rows = [webgl, webgpu].map((lane) => ({
      lane: lane.requested,
      near: lane.jacobian.nearWidth,
      far: lane.jacobian.farWidth,
      ratio: lane.jacobian.ratio,
      ok:
        lane.jacobian.ratio >= PREDICT.jacobianBand[0] &&
        lane.jacobian.ratio <= PREDICT.jacobianBand[1],
    }));
    gateD = rows.every((row) => row.ok);
    dDetail =
      `far/near thick-line screen width predicted ${PREDICT.jacobianRatio.toFixed(1)} in [${PREDICT.jacobianBand}]; ` +
      rows
        .map(
          (row) =>
            `${row.lane} near=${row.near.toFixed(1)}px far=${row.far.toFixed(1)}px ratio=${row.ratio.toFixed(2)}`,
        )
        .join("; ");
  }
  console.log(`[D JACOBIAN]   ${dDetail}  ${verdict(gateD)}`);

  // ── Gate E — clean run, with the destroyed-buffer class called out by name.
  const allErrors = [...webgl.errors, ...webgpu.errors];
  const destroyedBuffer = allErrors.filter((error) =>
    /destroyed buffer/i.test(error),
  );
  const gateE = allErrors.length === 0;
  console.log(
    `[E CLEAN]      predicted 0 errors after ${webgpu.churnCycles} pan-out/pan-in churn cycles; ` +
      `measured ${allErrors.length} (destroyed-buffer: ${destroyedBuffer.length}); ` +
      `re-bake stability: webgl ${webgl.churnStability} / webgpu ${webgpu.churnStability} px differ from the pre-churn frame  ${verdict(gateE)}`,
  );
  if (!gateE) console.log(`  ${allErrors.slice(0, 8).join("\n  ")}`);

  // ── Gate F — the placeholder early-out is free.
  const baselinePath = (renderer) =>
    path.join(OUT, `baseline-${renderer}-vectorfree.json`);
  if (UPDATE_BASELINE) {
    for (const lane of [webgl, webgpu]) {
      fs.writeFileSync(
        baselinePath(lane.requested),
        JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            renderer: lane.requested,
            terrain: lane.terrainAttached,
            canvasSize: lane.canvasSize,
            hash: lane.hashes.vectorFreeBefore,
          },
          null,
          2,
        ),
      );
    }
    console.log(
      `[F NON-REGRESS] baselines WRITTEN to ${OUT}/baseline-*-vectorfree.json — re-run WITHOUT --update-baseline on the post-change build to score this gate`,
    );
  }

  let gateF = null;
  const fNotes = [];
  const determinismResolved =
    webgl.determinismChanged === 0 && webgpu.determinismChanged === 0;
  if (!determinismResolved) {
    fNotes.push(
      `determinism control FAILED to resolve: re-capturing the SAME vector-free view changed ${webgl.determinismChanged} (webgl) / ${webgpu.determinismChanged} (webgpu) px, so "exactly 0" is not a measurable quantity in this scene`,
    );
  } else {
    // Both removals: `removalChanged` now covers the mixed leg's area
    // collection as well as the polylines (both are gone by `freeC`), and
    // `polygonRemovalChanged` covers the polygon leg's own. A family that
    // leaked a bound buffer or a stale header word shows up here as a globe
    // that never came back.
    const removalOk =
      webgl.removalChanged === 0 &&
      webgpu.removalChanged === 0 &&
      webgl.polygonRemovalChanged === 0 &&
      webgpu.polygonRemovalChanged === 0;
    fNotes.push(
      `predicted 0 changed px between the vector-free globe before add and after remove; measured ${webgl.removalChanged} (webgl) / ${webgpu.removalChanged} (webgpu) after the polyline and mixed legs, ${webgl.polygonRemovalChanged} / ${webgpu.polygonRemovalChanged} after the polygon leg`,
    );
    let baselineOk = true;
    let baselineSeen = 0;
    for (const lane of [webgl, webgpu]) {
      const file = baselinePath(lane.requested);
      if (!fs.existsSync(file)) continue;
      baselineSeen++;
      const recorded = JSON.parse(fs.readFileSync(file, "utf8"));
      const match = recorded.hash === lane.hashes.vectorFreeBefore;
      if (!match) baselineOk = false;
      fNotes.push(
        `${lane.requested} pre-change baseline ${recorded.hash} vs measured ${lane.hashes.vectorFreeBefore} → ${match ? "identical" : "DIFFERS"}`,
      );
    }
    if (baselineSeen === 0) {
      fNotes.push(
        `no pre-change baseline recorded (run --update-baseline on a build WITHOUT the change), so the cross-build half of this gate is unmeasured`,
      );
    }
    gateF =
      removalOk && baselineOk ? (baselineSeen === 0 ? null : true) : false;
    if (gateF === null && removalOk && baselineSeen === 0) {
      // In-build half passed; cross-build half has no subject to compare to.
      fNotes.push(
        "in-build half PASSED; leg reported STRUCTURAL only because the cross-build comparison has no baseline",
      );
    }
    if (!removalOk) gateF = false;
  }
  console.log(`[F NON-REGRESS] ${fNotes.join("; ")}  ${verdict(gateF)}`);

  // ── Gate G — draped-vector PICK, the C-05 acceptance.
  //
  // `scene.pick` over a draped line must return the LINE on both backends, and
  // a pick one stroke width to the side of it must not. On the default globe
  // (`globe.pickable` false, matching WebGL, where the globe has never had a
  // pick id) the off-line answer is "nothing"; with the globe opted in it is
  // the Globe, which the draped composite must not have taken away. That
  // second leg is scored on WebGPU only — `Globe#pickable` is honored by this
  // backend alone — and merely reported for WebGL.
  //
  // The primitives are added red-then-blue, so the thick blue line is index 1
  // and the thin red one is index 0. Asserting the INDEX, not just "something
  // was picked", is what makes a pick word read from the wrong record fail
  // here: a shifted or mis-strided pick run answers with the other primitive.
  let gateG = null;
  let gDetail;
  const pickLegs = [webgl, webgpu].map((lane) => ({
    lane: lane.requested,
    pick: lane.pick,
  }));
  const unresolved = pickLegs.filter(
    (row) =>
      !row.pick ||
      !row.pick.onThickLine?.resolved ||
      !row.pick.offThickLine?.resolved ||
      !row.pick.onThinLine?.resolved,
  );
  if (!referenceDrew) {
    gDetail = blindWhy;
  } else if (unresolved.length > 0) {
    gDetail =
      `unresolved — ` +
      unresolved
        .map(
          (row) =>
            `${row.lane}: ${
              row.pick?.onThickLine?.why ??
              row.pick?.offThickLine?.why ??
              row.pick?.onThinLine?.why ??
              "no pick record"
            }`,
        )
        .join("; ");
  } else {
    const rows = pickLegs.map((row) => {
      const pick = row.pick;
      const thickOk = pick.onThickLine.what === "vector:1";
      const thinOk = pick.onThinLine.what === "vector:0";
      const offOk = !pick.offThickLine.what.startsWith("vector:");
      // On the default globe both backends must answer "nothing" off the line.
      const offIsNothing = pick.offThickLine.what === "none";
      // Opted in, the WebGPU globe must answer for itself; WebGL ignores the
      // flag, so its value is reported and not gated.
      const pickableOk =
        row.lane !== "webgpu" ||
        (pick.offThickLinePickableGlobe?.what === "globe" &&
          pick.onThickLinePickableGlobe?.what === "vector:1");
      return {
        lane: row.lane,
        thick: pick.onThickLine.what,
        thin: pick.onThinLine.what,
        off: pick.offThickLine.what,
        offPickable: pick.offThickLinePickableGlobe?.what ?? "n/a",
        thickPickable: pick.onThickLinePickableGlobe?.what ?? "n/a",
        ok: thickOk && thinOk && offOk && offIsNothing && pickableOk,
      };
    });
    gateG = rows.every((row) => row.ok);
    gDetail =
      `predicted on-thick=vector:1 on-thin=vector:0 off(+${16}px)=none, ` +
      `and on webgpu with globe.pickable: off=globe on-thick=vector:1; measured ` +
      rows
        .map(
          (row) =>
            `${row.lane} thick=${row.thick} thin=${row.thin} off=${row.off} ` +
            `[pickable: off=${row.offPickable} thick=${row.thickPickable}]`,
        )
        .join("; ");
  }
  console.log(`[G PICK]       ${gDetail}  ${verdict(gateG)}`);

  // ── Gate H — POLYGON FILLS. `vector-layer-draping.spec.mjs` proves the
  // polygon word layout and the WGSL index arithmetic agree with
  // `VectorCommon.glsl`; what a CPU equivalence proof cannot show is that a
  // fill is BOUND, REACHED and PAINTED. Painted-fill pixel count and bbox on
  // both backends, at nadir and oblique, plus one mixed frame.
  //
  // The reference here is the WebGL lane's own fill, so a WebGL lane that
  // painted nothing reports STRUCTURAL — the same blind-leg discipline B/C/D
  // use, for the same reason.
  const polygonReferenceDrew =
    webgl.nadirPolygon.green >= PREDICT.minChangedPixels;
  let gateH = null;
  let hDetail = `WebGL reference painted ${webgl.nadirPolygon.green} fill px (floor ${PREDICT.minChangedPixels}) — the polygon bake never reached the reference frame, so this leg measured an empty scene (instrument gap, NOT a product verdict)`;
  if (polygonReferenceDrew) {
    const legs = [
      { name: "nadir", key: "nadirPolygon" },
      { name: "oblique", key: "obliquePolygon" },
    ].map(({ name, key }) => {
      const a = webgl[key];
      const b = webgpu[key];
      const countRatio = b.green / Math.max(a.green, 1);
      // `analyzeChanged` accumulates centroid and bbox over the CHANGED set,
      // not the GREEN set; on these two polygon-only legs the fill is the only
      // thing in the frame, so the two coincide. (The mixed frame's centroid is
      // therefore not a fill centroid — which is why gate H never reads it.)
      const dx = Math.abs(a.centroid[0] - b.centroid[0]);
      const dy = Math.abs(a.centroid[1] - b.centroid[1]);
      const bboxDelta =
        a.bbox && b.bbox
          ? Math.max(...a.bbox.map((v, i) => Math.abs(v - b.bbox[i])))
          : Number.POSITIVE_INFINITY;
      return {
        name,
        webglFill: a.green,
        webgpuFill: b.green,
        countRatio,
        dx,
        dy,
        bboxDelta,
        ok:
          b.green >= PREDICT.minChangedPixels &&
          countRatio >= PREDICT.countRatioBand[0] &&
          countRatio <= PREDICT.countRatioBand[1] &&
          dx <= PREDICT.centroidMaxDelta &&
          dy <= PREDICT.centroidMaxDelta &&
          bboxDelta <= PREDICT.bboxMaxDelta,
      };
    });

    // Mixed frame: fill AND both strokes, on both backends. The stroke classes
    // are compared against the polyline-only frame so a fill drawn OVER the
    // lines (the wrong composite order) shows up as them collapsing.
    const mixedRows = [webgl, webgpu].map((lane) => {
      const strokeRatio =
        (lane.nadirMixed.red + lane.nadirMixed.blue) /
        Math.max(lane.nadir.red + lane.nadir.blue, 1);
      return {
        lane: lane.requested,
        fill: lane.nadirMixed.green,
        red: lane.nadirMixed.red,
        blue: lane.nadirMixed.blue,
        strokeRatio,
        ok:
          lane.nadirMixed.green >= PREDICT.minChangedPixels &&
          lane.nadirMixed.red > 0 &&
          lane.nadirMixed.blue > 0 &&
          strokeRatio >= PREDICT.mixedStrokeSurvivalMin,
      };
    });

    gateH = legs.every((leg) => leg.ok) && mixedRows.every((row) => row.ok);
    hDetail =
      `fill count ratio predicted ~1.0 in [${PREDICT.countRatioBand}], centroid <=${PREDICT.centroidMaxDelta}, bbox <=${PREDICT.bboxMaxDelta}; ` +
      legs
        .map(
          (leg) =>
            `${leg.name} webgl=${leg.webglFill} webgpu=${leg.webgpuFill} ratio=${leg.countRatio.toFixed(3)} centroid=${leg.dx.toFixed(1)}/${leg.dy.toFixed(1)} bbox=${leg.bboxDelta === Number.POSITIVE_INFINITY ? "n/a" : leg.bboxDelta}`,
        )
        .join("; ") +
      `; mixed (fill + both strokes, stroke survival >=${PREDICT.mixedStrokeSurvivalMin}): ` +
      mixedRows
        .map(
          (row) =>
            `${row.lane} fill=${row.fill} red=${row.red} blue=${row.blue} strokes=${row.strokeRatio.toFixed(2)}`,
        )
        .join("; ");
  }
  console.log(`[H POLYGON]    ${hDetail}  ${verdict(gateH)}`);

  const manifestPath = path.join(OUT, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        predictions: PREDICT,
        webgl: withoutPngs(webgl),
        webgpu: withoutPngs(webgpu),
      },
      null,
      2,
    ),
  );
  console.log(`\nmanifest: ${manifestPath}`);
  console.log(`PNGs: ${OUT}/*.png`);

  const gates = [gateA, gateB, gateC, gateD, gateE, gateF, gateG, gateH];
  const failed = gates.some((gate) => gate === false);
  const structural = gates.some((gate) => gate === null);
  console.log(
    `\nGATE ${failed ? "FAIL" : structural ? "INCOMPLETE (structural)" : "PASS"}` +
      (structural
        ? " — one or more legs could not see their subject. Those are instrument gaps owed as follow-up, NOT product verdicts, and NOT a pass: exit 3 so a structural run can never be mistaken for a green one."
        : ""),
  );
  // Exit codes: 0 = every gate decided and passed. 1 = a real product FAIL.
  // 2 = watchdog or an exception. 3 = no FAIL, but at least one gate had no
  // subject to measure — acceptance is INCOMPLETE, not green.
  process.exitCode = failed ? 1 : structural ? 3 : 0;
}

main()
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  })
  .finally(() => clearTimeout(watchdog));
