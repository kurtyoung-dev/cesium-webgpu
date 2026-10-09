#!/usr/bin/env node
// Probe: WGS84 ellipsoid + default imagery. Reproduces the
// "globe explodes into black wedges with RGB-streak tile edges"
// symptom reported when picking "WGS84 Ellipsoid" from the terrain
// picker on the WebGPU viewer, and is the wgs84 family's one live probe.
// @purpose Family-root WGS84-ellipsoid probe on the shared runtime: the home, close and polar views (rigs wgs84-home-orbit, wgs84-close-1mm, wgs84-polar-14mm) on both renderers, an optional globe-fragment debug mode, the per-tile mesh and imagery state, whole-frame channel means and the cross-renderer diff.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// `WGS84 Ellipsoid` uses EllipsoidTerrainProvider — unquantized, no
// normals, no webMercatorT — the simplest tile mesh format. The
// catastrophic rendering implied the WebGPU shader entry point for
// that format was mis-wired, or imagery sampling failed when no
// webMercatorT attribute is present. The three root causes are banked
// under Batch 56 in `migration_doc/WEBGPU_DEBUGGING_LOG.md`.
//
// ON THE SHARED RUNTIME (probe-kit harvest, wgs84 family, DX-108). The
// browser, the origin (`--port`, a governed port, never 8080), the
// served-build preflight, the Edge slot, the run deadline (`workBudgetMs`)
// and the receipt belong to `lib/probe-runtime.mjs`. Each view is a rig under
// `rigs/` and is imported here as data. Each frame is an element capture of
// the scene canvas through `captureElement`. Immediately before it, after the
// settle, `lib/strip-viewer-widgets.mjs` removes the viewer chrome and lists
// whatever is still stacked over the canvas; a list that is not empty, or a
// strip that returns no list, refuses the cell (`acceptChromeStrip`,
// `capture-chrome-over-canvas`), because an element capture composites
// anything over the element and both pixel figures below would score it. The
// archived captures were page screenshots and carried the toolbar, the help
// panel, the clock and the timeline. The channel means are `frameChannelMeans`
// (`lib/metrics/wgs84-channel-means.mjs`) and the cross-renderer mismatch is
// `diffImages`, both computed in Node from the banked PNGs.
//
// SCENES (`--scene`, comma-separated; default all three):
//   home  — rig `wgs84-home-orbit`: the page's own home view. The orbit view
//           of this probe and of the archived quick and debug-flag probes.
//   close — rig `wgs84-close-1mm`: straight down on 100 W, 40 N from 1,000 km.
//   polar — rig `wgs84-polar-14mm`: straight down on 105 W, 50 N from
//           14,000 km, the view of the archived polar-stretch probe.
//
// DEBUG MODES (`--debug-mode <name>`, WebGPU only). The globe-fragment debug
// registry (`WebGPUGlobeFragmentDebug.ts`) short-circuits the globe fragment
// shader to one intermediate; this probe selects the mode the way
// `CesiumDebug.globeFragmentDebug(name)` does and refuses when the registry is
// absent or does not know the name. The archived probes, and this file before
// the harvest, set `window._webgpuGlobe*Debug` flags instead. The registry
// reads `globalThis._webgpuGlobeDebugMode`; no file in the engine's
// `Renderer/WebGPU`, `Scene` or `Core` directories names any of the flags (a
// one-level search), and the banked 2026-07-02 frames that set them are the
// plain frame (see the harvest entry in the debugging log). Each flag names
// one mode by its `tile.time` sentinel: `LEGACY_DEBUG_FLAG_MODES` below.
//
// WHAT ELSE THE MIGRATION CHANGED. The clock is pinned to the rig's instant
// (`lib/determinism-kit.mjs`), and the settle runs until the tiles have stayed
// loaded for 30 frames, with the archived dwell as its floor and 1,200 frames
// as its cap. A terrain picker with no WGS84 entry now refuses instead of
// capturing the default terrain under a WGS84 label. Console warnings are
// recorded beside the errors, as the archived alphadbg probe echoed both. The
// URL is the kit's `captureUrlFor` plus the `renderer` query. The tile-state dump
// compared `readyImagery.state` against 8, which is no `ImageryState` value
// (READY is 4), so its `readyImageryReady` field and `riReady` bucket key
// always read false; they now read against `IMAGERY_STATE_READY`.
//
// Usage: node Tools/visual-regression/probe-wgs84.mjs [--port 8094]
//   [--scene home,close,polar] [--renderer both|webgl|webgpu] [--runs N]
//   [--renderer webgpu --debug-mode tex0-alpha]
// Outputs: Tools/visual-regression/output/wgs84/

import fs from "node:fs";
import path from "node:path";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { armWebGPUDevices, errorGateInit } from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { DET_BROWSER_SETUP } from "./lib/determinism-kit.mjs";
import { diffImages } from "./lib/image-diff.mjs";
import { frameChannelMeans } from "./lib/metrics/wgs84-channel-means.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import CLOSE_RIG from "./rigs/wgs84-close-1mm.mjs";
import HOME_RIG from "./rigs/wgs84-home-orbit.mjs";
import POLAR_RIG from "./rigs/wgs84-polar-14mm.mjs";

/** The family's three views, by `--scene` name. */
export const WGS84_SCENES = Object.freeze({
  home: HOME_RIG,
  close: CLOSE_RIG,
  polar: POLAR_RIG,
});

/** Every scene, in the order a run captures them. */
export const DEFAULT_SCENES = Object.freeze(["home", "close", "polar"]);

/**
 * The window flags the archived wgs84 probes set, and the globe-fragment debug
 * mode each one names. Matched by sentinel, not by spelling: each flag's
 * `tile.time` sentinel in the Batch 56 table of `WEBGPU_DEBUGGING_LOG.md`
 * equals exactly one mode's sentinel in `WebGPUGlobeFragmentDebug.ts`, and
 * `wgs84-probe.spec.mjs` re-derives the pairing from those two files.
 */
export const LEGACY_DEBUG_FLAG_MODES = Object.freeze({
  _webgpuGlobeUVDebug: "uv",
  _webgpuGlobeAlphaDebug: "alpha",
  _webgpuGlobeLayerCountDebug: "layer-count",
  _webgpuGlobeSample0Debug: "sample0",
  _webgpuGlobeSample1Debug: "sample1",
  _webgpuGlobeTexAlphaDebug: "tex0-alpha",
  _webgpuGlobeTexAlpha1Debug: "tex1-alpha",
  _webgpuGlobePostCompositeColorDebug: "post-composite-color",
  _webgpuGlobePostCompositeAlphaDebug: "post-composite-alpha",
  _webgpuGlobeFadeAmountDebug: "fade-amount",
  _webgpuGlobeDrapedDebug: "draped",
  _webgpuGlobeAtmoColorDebug: "atmo-color",
  _webgpuGlobeTransmittanceDebug: "transmittance",
  _webgpuGlobeRayleighVDebug: "rayleigh-v",
  _webgpuGlobeMieVDebug: "mie-v",
  _webgpuGlobeViewDirDebug: "view-dir",
});

/** `ImageryState.READY` (`packages/engine/Source/Scene/ImageryState.js`). */
export const IMAGERY_STATE_READY = 4;

/**
 * The launch flags every wgs84 probe ran under — a measurement condition, so
 * they are declared to the runtime and recorded in the receipt.
 */
const LAUNCH_ARGS = Object.freeze([
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan",
  "--disable-cache",
]);

/** The engine module the CesiumViewer page loads and this probe imports. */
const CESIUM_MODULE_URL = "/Build/CesiumUnminified/index.js";

/** The scene canvas; the page has exactly one once the widgets are gone. */
const CANVAS_SELECTOR = ".cesium-widget canvas";

/** The settle's ceiling: the archived probes never rendered more. */
const SETTLE_CAP_FRAMES = 1200;

/** Consecutive tiles-loaded frames the settle requires. */
const STABLE_FRAMES = 30;

/** Per-channel tolerance handed to `diffImages`, recorded in the receipt. */
const PAIR_TOLERANCE = 16;

/** Navigation plus the wait for `window.viewer`. */
const NAVIGATION_BUDGET_MS = 120_000;
/** Up to 1,200 settle frames on a loaded machine, plus the flush frames. */
const SETTLE_BUDGET_MS = 180_000;
/** One element capture, one tile-state read, one decode. */
const READBACK_BUDGET_MS = 30_000;
/** What one cell (one scene on one renderer) may take. */
const CELL_BUDGET_MS =
  NAVIGATION_BUDGET_MS + SETTLE_BUDGET_MS + READBACK_BUDGET_MS;

/** The `--debug-mode` list entry that means "the plain frame, no mode". */
export const PLAIN_FRAME = "none";

/**
 * Plan one run's cells: each requested scene on each requested renderer, once
 * per requested debug mode, in the canonical scene order whatever order
 * `--scene` named them in.
 *
 * `--debug-mode` takes one name or a comma-separated list (each mode is its
 * own cell on its own page, because the registry holds one mode at a time);
 * `none` in the list is the plain frame. So each archived debug-flag probe is
 * one command, e.g. its four atmosphere flags are
 * `--debug-mode fade-amount,draped,atmo-color,transmittance`.
 *
 * Pure and exported so `wgs84-probe.spec.mjs` drives it without a browser.
 *
 * @param {{scene?: string, renderers: string[], debugMode?: string|null}} options
 *   Parsed probe options.
 * @returns {Array<{scene: string, rig: object, renderer: string, debugMode: string|null}>}
 *   The cells.
 * @throws {TypeError} For a scene name that is not home, close or polar, or an
 *   empty mode list.
 * @throws {ProbeRefusal} `renderer-unavailable` when a debug mode is asked for
 *   on a run that includes WebGL: the registry is WebGPU's alone.
 */
export function planWgs84Cells({ scene, renderers, debugMode } = {}) {
  const names = String(scene ?? DEFAULT_SCENES.join(","))
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new TypeError("--scene needs at least one of home, close, polar");
  }
  for (const name of names) {
    if (!Object.hasOwn(WGS84_SCENES, name)) {
      throw new TypeError(
        `--scene must name home, close or polar (got "${name}")`,
      );
    }
  }
  let modes = [null];
  if (debugMode !== undefined && debugMode !== null) {
    const listed = String(debugMode)
      .split(",")
      .map((mode) => mode.trim())
      .filter((mode) => mode.length > 0);
    if (listed.length === 0) {
      throw new TypeError("--debug-mode needs at least one mode name");
    }
    modes = [...new Set(listed)].map((mode) =>
      mode === PLAIN_FRAME ? null : mode,
    );
    if (modes.some((mode) => mode !== null) && renderers.includes("webgl")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "--debug-mode drives the WebGPU globe-fragment debug registry, which " +
          "the WebGL renderer does not have; pass --renderer webgpu",
        { renderers, debugMode },
      );
    }
  }
  const cells = [];
  for (const name of DEFAULT_SCENES.filter((each) => names.includes(each))) {
    const rig = WGS84_SCENES[name];
    for (const renderer of renderers) {
      if (!rig.renderers.includes(renderer)) {
        continue;
      }
      for (const mode of modes) {
        cells.push({ scene: name, rig, renderer, debugMode: mode });
      }
    }
  }
  return cells;
}

/**
 * Pick the terrain a rig names from the base-layer picker. Runs in the page.
 *
 * The match is the family's own: a case-insensitive substring of the terrain
 * view-model's name. A picker with no such entry is reported, not skipped —
 * the archived probes captured the default terrain under a WGS84 label then.
 *
 * @param {{match: string}} args The substring to look for.
 * @returns {{ok: boolean, match: string, name?: string, available?: string[]}}
 *   What was selected, or what the picker offered instead.
 */
export function pageSelectWgs84Terrain({ match }) {
  // __wgs84SelectTerrain
  const viewModel = globalThis.viewer?.baseLayerPicker?.viewModel;
  const models = viewModel?.terrainProviderViewModels ?? [];
  const wanted = String(match).toLowerCase();
  const found = models.find((model) =>
    String(model.name || "")
      .toLowerCase()
      .includes(wanted),
  );
  if (!found) {
    return {
      ok: false,
      match,
      available: models.map((model) => String(model.name || "")),
    };
  }
  viewModel.selectedTerrain = found;
  return { ok: true, match, name: String(found.name || "") };
}

/**
 * Select one globe-fragment debug mode. Runs in the page.
 *
 * Goes through `CesiumDebug.globeFragmentDebug(name)` when the page has it, and
 * otherwise writes `globalThis._webgpuGlobeDebugMode` — the global that
 * `WebGPUGlobeSurfaceTileUB.ts` reads, which is what that command sets. It
 * never writes a `_webgpuGlobe*Debug` flag: the registry does not read those
 * (see the module header for how far that was searched). A registry
 * that is absent (a WebGL page, or a build whose debug pragmas were stripped)
 * or that does not list the name is reported, never captured past.
 *
 * @param {{mode: string}} args The mode name.
 * @returns {{ok: boolean, mode: string, via?: string, readBack?: unknown,
 *   known?: string[], reason?: string}} What the page did.
 */
export function pageApplyGlobeDebugMode({ mode }) {
  // __wgs84ApplyDebugMode
  const root = globalThis;
  const registry = root.__webgpuGlobeFragmentDebugRegistry;
  if (!Array.isArray(registry)) {
    return {
      ok: false,
      mode,
      reason:
        "the globe-fragment debug registry is not published on this page (a WebGL page, or a build with the debug pragmas stripped)",
    };
  }
  const known = registry.map((entry) => entry.name);
  if (!known.includes(mode)) {
    return {
      ok: false,
      mode,
      known,
      reason: `the registry has no mode named "${mode}"`,
    };
  }
  let via = "globalThis._webgpuGlobeDebugMode";
  if (typeof root.CesiumDebug?.globeFragmentDebug === "function") {
    root.CesiumDebug.globeFragmentDebug(mode);
    via = "CesiumDebug.globeFragmentDebug";
  } else {
    root._webgpuGlobeDebugMode = mode;
  }
  const readBack = root._webgpuGlobeDebugMode ?? null;
  if (readBack !== mode) {
    return {
      ok: false,
      mode,
      via,
      readBack,
      reason: "the selected mode did not read back from the page",
    };
  }
  return { ok: true, mode, via, readBack };
}

/**
 * Pin the clock, place the camera and settle. Runs in the page.
 *
 * The settle is `lib/determinism-kit.mjs`'s `settleTiles`: render until the
 * globe has reported its tiles loaded for `stableFrames` frames in a row, never
 * fewer than `minFrames` frames and at most `maxFrames`, then its eight flush
 * frames.
 *
 * @param {object} args Everything the page needs, passed in rather than closed
 *   over (a page function cannot see this module's bindings).
 * @returns {Promise<{framesRendered: number, tilesLoaded: boolean, clock: string}>}
 *   What the settle did.
 */
export async function pageFrameWgs84Rig({
  moduleUrl,
  camera,
  clock,
  det,
  minFrames,
  maxFrames,
  stableFrames,
}) {
  // __wgs84FrameRig
  const root = globalThis;
  const viewer = root.viewer;
  const C = await import(moduleUrl);
  // eslint-disable-next-line no-new-func
  new Function(det)();
  root.__det.pinClock(C, viewer, viewer.scene, clock);
  if (camera) {
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.height,
      ),
      orientation: {
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? -Math.PI / 2,
        roll: camera.roll ?? 0,
      },
    });
  }
  const framesRendered = await root.__det.settleTiles(viewer.scene, {
    minFrames,
    maxFrames,
    stableFrames,
  });
  return {
    framesRendered,
    tilesLoaded: viewer.scene.globe.tilesLoaded === true,
    clock: C.JulianDate.toIso8601(viewer.clock.currentTime),
  };
}

/**
 * The per-tile mesh and imagery state of the first tile to render, and a
 * bucket count over every tile. Runs in the page.
 *
 * This is the archived probe's own dump, kept field for field: it is what
 * showed the WGS84 tiles carry no `webMercatorT`. The one change is the READY
 * comparison, which reads `imageryReady` instead of the literal 8.
 *
 * @param {{imageryReady: number}} args `ImageryState.READY`.
 * @returns {object} The dump.
 */
export function pageReadWgs84TileState({ imageryReady }) {
  const v = globalThis.viewer;
  const t = v.scene._globe?._surface?._tilesToRender?.[0];
  const tileImagery = t?.data?.imagery?.[0];
  const ri = tileImagery?.readyImagery;
  return {
    mode: v.scene.mode,
    terrainProvider: v.terrainProvider?.constructor?.name,
    imageryLayerCount: v.scene.imageryLayers.length,
    imageryProvider:
      v.scene.imageryLayers.get(0)?.imageryProvider?.constructor?.name,
    imageryProjection:
      v.scene.imageryLayers.get(0)?.imageryProvider?.tilingScheme?.projection
        ?.constructor?.name,
    terrainProjection:
      v.terrainProvider?.tilingScheme?.projection?.constructor?.name,
    tilesToRender: v.scene._globe?._surface?._tilesToRender?.length,
    sampleTileMesh: (() => {
      if (!t?.data?.mesh) return null;
      const m = t.data.mesh;
      const e = m.encoding;
      return {
        ctor: m.constructor.name,
        encoding: e?.constructor?.name,
        quantization: e?.quantization,
        hasNormals: !!e?.hasVertexNormals,
        hasWebMercatorT: !!e?.hasWebMercatorT,
        hasGeodeticSurfaceNormals: !!e?.hasGeodeticSurfaceNormals,
        stride: e?.stride,
        centerMagnitude: m.center
          ? Math.hypot(m.center.x, m.center.y, m.center.z)
          : null,
      };
    })(),
    sampleTileImagery: tileImagery
      ? {
          useWebMercatorT: tileImagery.useWebMercatorT,
          hasTextureTranslationAndScale:
            !!tileImagery.textureTranslationAndScale,
          hasTextureCoordinateRectangle:
            !!tileImagery.textureCoordinateRectangle,
          readyImageryReady: ri
            ? ri.state === imageryReady /* ImageryState.READY */
            : null,
          hasReprojected: !!ri?._webgpuReprojectedTexture,
          hasMercTexture: !!ri?.textureWebMercator,
          hasNormalTexture: !!ri?.texture,
          imageryRectIsGeographic: ri?.rectangle
            ? typeof ri.rectangle.west === "number"
            : null,
        }
      : null,
    // ALL tiles summary: count tiles by (useWebMercatorT, hasReprojected) combos
    allTilesSummary: (() => {
      const tiles = v.scene._globe?._surface?._tilesToRender || [];
      const buckets = {};
      let withImagery = 0;
      let withoutImagery = 0;
      // Also: capture whether readyImagery is the SAME tile's loadingImagery
      // or whether it's a different (parent) imagery
      let parentImageryCount = 0;
      let selfImageryCount = 0;
      for (const tile of tiles) {
        const ti = tile?.data?.imagery?.[0];
        if (!ti) {
          withoutImagery++;
          continue;
        }
        withImagery++;
        const ri2 = ti.readyImagery;
        const li2 = ti.loadingImagery;
        if (ri2 && li2 && ri2 !== li2) parentImageryCount++;
        else if (ri2 === li2) selfImageryCount++;
        const key = `useMercT=${ti.useWebMercatorT}|reproj=${!!ri2?._webgpuReprojectedTexture}|riReady=${ri2?.state === imageryReady}|isParent=${ri2 && li2 && ri2 !== li2}`;
        buckets[key] = (buckets[key] || 0) + 1;
      }
      return {
        total: tiles.length,
        withImagery,
        withoutImagery,
        parentImageryCount,
        selfImageryCount,
        buckets,
      };
    })(),
    // First tile's parent vs self imagery levels
    sampleParentInfo: (() => {
      const t = v.scene._globe?._surface?._tilesToRender?.[0];
      const ti = t?.data?.imagery?.[0];
      if (!ti) return null;
      return {
        tileLevel: t?.level,
        tileXY: t ? `${t.x},${t.y}` : null,
        readyLevel: ti.readyImagery?.level,
        readyXY: ti.readyImagery
          ? `${ti.readyImagery.x},${ti.readyImagery.y}`
          : null,
        loadingLevel: ti.loadingImagery?.level,
        loadingXY: ti.loadingImagery
          ? `${ti.loadingImagery.x},${ti.loadingImagery.y}`
          : null,
        loadingState: ti.loadingImagery?.state,
        readyState: ti.readyImagery?.state,
        // ImageryState.READY; the archived dump compared against 8, no state
        readyIsActuallyReady: ti.readyImagery?.state === imageryReady,
        isReadyTheParent: !!(
          ti.readyImagery &&
          ti.loadingImagery &&
          ti.readyImagery !== ti.loadingImagery
        ),
        // Probe reprojected texture dimensions
        reprojWidth: ti.readyImagery?._webgpuReprojectedTexture?.width,
        reprojHeight: ti.readyImagery?._webgpuReprojectedTexture?.height,
        reprojFormat: ti.readyImagery?._webgpuReprojectedTexture?.format,
        sourceWidth:
          ti.readyImagery?.image?.width || ti.readyImagery?.image?.naturalWidth,
        sourceHeight:
          ti.readyImagery?.image?.height ||
          ti.readyImagery?.image?.naturalHeight,
        // ACTUAL rectangle values to verify units
        tileRect: t?.rectangle
          ? `[${t.rectangle.west.toFixed(4)},${t.rectangle.south.toFixed(4)},${t.rectangle.east.toFixed(4)},${t.rectangle.north.toFixed(4)}]`
          : null,
        imageryRect: ti.readyImagery?.rectangle
          ? `[${ti.readyImagery.rectangle.west.toFixed(4)},${ti.readyImagery.rectangle.south.toFixed(4)},${ti.readyImagery.rectangle.east.toFixed(4)},${ti.readyImagery.rectangle.north.toFixed(4)}]`
          : null,
        // CACHED textureCoordinateRectangle (what WebGL uses)
        cachedTexCoordsRect: ti.textureCoordinateRectangle
          ? `[${ti.textureCoordinateRectangle.x.toFixed(4)},${ti.textureCoordinateRectangle.y.toFixed(4)},${ti.textureCoordinateRectangle.z.toFixed(4)},${ti.textureCoordinateRectangle.w.toFixed(4)}]`
          : null,
        cachedTranslationAndScale: ti.textureTranslationAndScale
          ? `[${ti.textureTranslationAndScale.x.toFixed(4)},${ti.textureTranslationAndScale.y.toFixed(4)},${ti.textureTranslationAndScale.z.toFixed(4)},${ti.textureTranslationAndScale.w.toFixed(4)}]`
          : null,
        imageryCountOnTile: t?.data?.imagery?.length,
        allImageryRects: t?.data?.imagery?.map((ti2) => {
          const ri3 = ti2.readyImagery;
          return {
            rect: ri3?.rectangle
              ? `[${ri3.rectangle.south.toFixed(3)},${ri3.rectangle.north.toFixed(3)}]`
              : null,
            texCoordsRect: ti2.textureCoordinateRectangle
              ? `[${ti2.textureCoordinateRectangle.y.toFixed(3)},${ti2.textureCoordinateRectangle.w.toFixed(3)}]`
              : null,
            useMercT: ti2.useWebMercatorT,
            hasReproj: !!ri3?._webgpuReprojectedTexture,
            level: ri3?.level,
          };
        }),
      };
    })(),
  };
}

/** The name one cell's frame is banked under. */
function captureNameFor(cell, run) {
  const mode = cell.debugMode === null ? "" : `-${cell.debugMode}`;
  return `${cell.scene}${mode}-${cell.renderer}-run${run}`;
}

/** Error-level console lines and uncaught page errors, in arrival order. */
function pageErrorsFrom(diagnostics) {
  return [
    ...diagnostics.console
      .filter((message) => message.type === "error")
      .map((message) => ({ ...message, type: "error" })),
    ...diagnostics.errors.map((message) => ({ ...message, type: "pageerror" })),
  ]
    .sort((a, b) => a.seq - b.seq)
    .map(({ type, text }) => ({ type, text }));
}

/**
 * Warning-level console lines, in arrival order. The archived alphadbg probe
 * echoed warnings beside errors, so the record keeps them as their own list.
 */
function pageWarningsFrom(diagnostics) {
  return diagnostics.console
    .filter((message) => message.type === "warning")
    .map(({ text }) => ({ type: "warning", text }));
}

/**
 * Accept the viewer-chrome strip's report, or refuse the cell.
 *
 * `STRIP_WIDGETS_SOURCE` removes the CesiumViewer widgets and lists whatever
 * is still stacked over the scene canvas. An element capture composites
 * everything over the element's rectangle, so a leftover would be scored with
 * the scene by `frameChannelMeans` and by the cross-renderer diff. A report
 * with no `leftovers` list is no evidence of a clean canvas either, so it
 * refuses the same way.
 *
 * Pure and exported so `wgs84-probe.spec.mjs` drives it without a browser.
 *
 * @param {unknown} report What the strip returned in the page.
 * @param {{scene: string, renderer: string}} cell The cell, for the message.
 * @returns {{chromeRemoved: true, removed: number|null, leftovers: string[]}}
 *   What the cell record carries.
 * @throws {ProbeRefusal} `capture-chrome-over-canvas`.
 */
export function acceptChromeStrip(report, { scene, renderer }) {
  if (!Array.isArray(report?.leftovers) || report.leftovers.length > 0) {
    const found = Array.isArray(report?.leftovers)
      ? `elements were still stacked over the scene canvas (${report.leftovers.join(", ")})`
      : "the strip returned no list of what was still stacked over the scene canvas";
    throw new ProbeRefusal(
      "capture-chrome-over-canvas",
      `${scene} on ${renderer}: after the viewer chrome was stripped, ${found}, so an element capture would score it with the scene`,
      { scene, renderer, widgets: report ?? null },
    );
  }
  return {
    chromeRemoved: true,
    removed: Number.isFinite(report.removed) ? report.removed : null,
    leftovers: [],
  };
}

/**
 * One scene on one renderer: a fresh browser context, the rig applied and
 * settled, the chrome stripped and checked, one canvas capture and the
 * tile-state dump.
 *
 * Exported so `wgs84-probe.spec.mjs` drives it with a stub browser and page.
 *
 * @returns {Promise<object>} The cell, carrying the decoded `image` for the
 *   pairing step and a `record` for the receipt.
 */
export async function captureWgs84Cell({
  browser,
  origin,
  cell,
  run,
  outputDirectory,
  captures,
}) {
  const { rig } = cell;
  const context = await browser.newContext({ viewport: { ...rig.viewport } });
  try {
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    try {
      await page.addInitScript(errorGateInit);
      // A single-viewer page reads its backend from the `renderer` query.
      const url = new URL(captureUrlFor({ rig, origin }));
      url.searchParams.set("renderer", cell.renderer);
      await page.goto(url.href, {
        waitUntil: "networkidle",
        timeout: NAVIGATION_BUDGET_MS,
      });
      await page.waitForFunction(() => !!globalThis.viewer, null, {
        timeout: NAVIGATION_BUDGET_MS,
      });
      await armWebGPUDevices(page);

      const terrain = await page.evaluate(pageSelectWgs84Terrain, {
        match: rig.dials.baseLayerPickerTerrain,
      });
      if (!terrain.ok) {
        throw new ProbeRefusal(
          "terrain-unavailable",
          `the base-layer picker offers no terrain matching "${terrain.match}" (offered: ${terrain.available.join(", ") || "none"})`,
          terrain,
        );
      }
      let debug = null;
      if (cell.debugMode !== null) {
        debug = await page.evaluate(pageApplyGlobeDebugMode, {
          mode: cell.debugMode,
        });
        if (!debug.ok) {
          throw new ProbeRefusal("debug-mode-unavailable", debug.reason, debug);
        }
      }
      const framing = await page.evaluate(pageFrameWgs84Rig, {
        moduleUrl: CESIUM_MODULE_URL,
        camera: rig.camera,
        clock: rig.clock,
        det: DET_BROWSER_SETUP,
        minFrames: rig.readiness.frames,
        maxFrames: Math.max(rig.readiness.frames, SETTLE_CAP_FRAMES),
        stableFrames: STABLE_FRAMES,
      });

      // Strip the chrome last, after the settle, so nothing the page stacks
      // over the canvas while it renders reaches the capture unchecked; nothing
      // is evaluated in the page between this check and the screenshot.
      const chrome = acceptChromeStrip(
        await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`),
        cell,
      );
      const shot = await captureElement({
        page,
        selector: CANVAS_SELECTOR,
        name: captureNameFor(cell, run),
        outputDirectory,
        captures,
      });
      const tileState = await page.evaluate(pageReadWgs84TileState, {
        imageryReady: IMAGERY_STATE_READY,
      });
      const image = decodePng(shot.buffer);
      const errors = pageErrorsFrom(diagnostics);
      const warnings = pageWarningsFrom(diagnostics);
      return {
        run,
        scene: cell.scene,
        renderer: cell.renderer,
        debugMode: cell.debugMode,
        image,
        record: {
          run,
          scene: cell.scene,
          rig: rig.id,
          renderer: cell.renderer,
          debugMode: cell.debugMode,
          terrain: terrain.name,
          chromeRemoved: chrome.chromeRemoved,
          widgets: { removed: chrome.removed, leftovers: chrome.leftovers },
          debug,
          framing,
          capture: {
            name: shot.name,
            sha256: shot.sha256,
            width: image.width,
            height: image.height,
            liveness: shot.liveness,
          },
          channelMeans: frameChannelMeans(image),
          tileState,
          pageErrors: { count: errors.length, first: errors.slice(0, 5) },
          pageWarnings: {
            count: warnings.length,
            first: warnings.slice(0, 5),
          },
        },
      };
    } finally {
      diagnostics.detach();
    }
  } finally {
    await context.close();
  }
}

/**
 * Pair each scene's WebGPU frame with its WebGL frame and diff them.
 *
 * A scene captured on one renderer only (every debug-mode cell) has no pair.
 * Two frames of different sizes cannot be compared, and that is a refusal of
 * the run, never a pair reported as empty: a comparison that silently drops
 * out is how a broken capture reads as agreement.
 *
 * Pure and exported so `wgs84-probe.spec.mjs` drives it without a browser.
 *
 * @param {Array<{run: number, scene: string, renderer: string,
 *   debugMode: string|null, image: {width: number, height: number,
 *   data: ArrayLike<number>}}>} captured The run's cells.
 * @param {{tolerance?: number}} [options] Per-channel diff tolerance.
 * @returns {Array<object>} One pair per scene with both renderers.
 * @throws {ProbeRefusal} `capture-size-mismatch`.
 */
export function pairWgs84Scenes(captured, options = {}) {
  const tolerance = options.tolerance ?? PAIR_TOLERANCE;
  const groups = new Map();
  for (const cell of captured) {
    const key = `${cell.run}|${cell.scene}|${cell.debugMode ?? ""}`;
    const group = groups.get(key) ?? {};
    group[cell.renderer] = cell;
    groups.set(key, group);
  }
  const pairs = [];
  for (const { webgl, webgpu } of groups.values()) {
    if (!webgl || !webgpu) {
      continue;
    }
    const a = webgpu.image;
    const b = webgl.image;
    if (a.width !== b.width || a.height !== b.height) {
      throw new ProbeRefusal(
        "capture-size-mismatch",
        `${webgpu.scene}: the WebGPU frame is ${a.width}x${a.height} and the WebGL frame ${b.width}x${b.height}, so the pair cannot be compared`,
        {
          scene: webgpu.scene,
          webgpu: [a.width, a.height],
          webgl: [b.width, b.height],
        },
      );
    }
    const diff = diffImages(a, b, { tolerance });
    pairs.push({
      run: webgpu.run,
      scene: webgpu.scene,
      debugMode: webgpu.debugMode,
      width: a.width,
      height: a.height,
      tolerance,
      mismatchPct: diff.mismatchPct,
      changedPx: diff.changedPx,
      bbox: diff.bbox,
      diffRgba: diff.diffRgba,
    });
  }
  return pairs;
}

/** How many cells a run will take, for the deadline; never throws. */
function plannedCellCount(options) {
  try {
    return planWgs84Cells(options).length;
  } catch {
    return DEFAULT_SCENES.length * 2;
  }
}

/** The console summary: what the archived quick probe printed, per scene. */
function printSummary(cells) {
  for (const cell of cells) {
    for (const {
      channelMeans: m,
      scene,
      renderer,
      debugMode,
      tileState,
    } of cell.captures) {
      const mode = debugMode === null ? "" : ` [${debugMode}]`;
      console.log(
        `  ${scene}${mode} ${renderer} run${cell.run}: nonBlack=${m.nonBlackPct.toFixed(1)}% mean=(${m.meanR.toFixed(0)},${m.meanG.toFixed(0)},${m.meanB.toFixed(0)}) tiles=${tileState.tilesToRender} terrain=${tileState.terrainProvider}`,
      );
    }
    for (const pair of cell.pairs) {
      console.log(
        `  ${pair.scene} webgpu vs webgl run${cell.run}: mismatch=${pair.mismatchPct.toFixed(3)}% (${pair.changedPx} px over tolerance ${pair.tolerance})`,
      );
    }
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "wgs84",
  title:
    "WGS84 ellipsoid — home, close and polar views, WebGL vs WebGPU, with the per-tile mesh and imagery state",
  outputSubdirectory: "wgs84",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  launchArgs: LAUNCH_ARGS,
  // The CesiumViewer page loads `Cesium.js`, and the in-page framing imports
  // `index.js`; both are checked against the bytes on disk.
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
  ],
  args: {
    extraOptions: [
      {
        flag: "--scene",
        key: "scene",
        kind: "string",
        default: DEFAULT_SCENES.join(","),
      },
      { flag: "--debug-mode", key: "debugMode", kind: "string" },
    ],
  },
  // The opt-in to the lifecycle's derived deadline: what this run's cells may
  // take, so a hung device ends the run instead of holding the machine.
  workBudgetMs: (options) =>
    Math.max(1, plannedCellCount(options)) * CELL_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const plan = planWgs84Cells(options);
    const captured = [];
    for (const cell of plan) {
      const mode = cell.debugMode === null ? "" : ` [${cell.debugMode}]`;
      console.log(
        `[probe-wgs84] ${cell.scene}${mode} on ${cell.renderer} (run ${run})`,
      );
      captured.push(
        await captureWgs84Cell({
          browser,
          origin,
          cell,
          run,
          outputDirectory,
          captures,
        }),
      );
    }
    const pairs = pairWgs84Scenes(captured);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const pairRecords = [];
    for (const pair of pairs) {
      const diffImage = `${pair.scene}-diff-run${run}.png`;
      fs.writeFileSync(
        path.join(outputDirectory, diffImage),
        Buffer.from(encodeRgbaPng(pair.diffRgba, pair.width, pair.height)),
      );
      pairRecords.push({
        run: pair.run,
        scene: pair.scene,
        diffImage,
        tolerance: pair.tolerance,
        mismatchPct: pair.mismatchPct,
        changedPx: pair.changedPx,
        bbox: pair.bbox,
      });
    }
    return [
      {
        run,
        captures: captured.map((cell) => cell.record),
        pairs: pairRecords,
      },
    ];
  },
  receipt(cells, context) {
    printSummary(cells);
    return {
      scene: context.options.scene,
      debugMode: context.options.debugMode ?? null,
      cells,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
