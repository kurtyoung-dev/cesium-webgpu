// wgs84-probe.spec.mjs — the wgs84 family after its probe-kit harvest. Pure
// Node: no browser, no GPU.
//
// @purpose Drives probe-wgs84.mjs's pure planning, pairing and chrome-strip check, its page-side functions against stub pages and one whole cell against a stub browser, re-derives the legacy-flag-to-mode pairing by sentinel from the debugging log and the engine registry, holds the three wgs84 rigs to the archived probes' own cameras and dwells, and checks every archived wgs84 probe is ARCHIVED-CANDIDATE, off every allowlist and still links from archive/.
// @status ACTIVE
//
// WHERE THE EXPECTATIONS COME FROM. Not from the migrated probe. The cameras
// and dwells are read out of the archived probes' text, the flag-to-mode
// pairing out of the Batch 56 table in `WEBGPU_DEBUGGING_LOG.md` and the
// registry in `WebGPUGlobeFragmentDebug.ts`, and the READY value out of
// `ImageryState.js`. A spec written from the same reading as the probe would
// only confirm the reading.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { parsePurposeHeader } from "../lib/purpose-header.mjs";
import { errorGateInit } from "../lib/webgpu-error-gate.mjs";
import { DET_BROWSER_SETUP } from "./lib/determinism-kit.mjs";
import { scanImports } from "./lib/engine-stub-bundler.mjs";
import { frameChannelMeans } from "./lib/metrics/wgs84-channel-means.mjs";
import { BEHAVIOUR_FLEET_ALLOWLIST } from "./lib/probe-fleet-behaviour-allowlist.mjs";
import { PROBE_CONTRACT_ALLOWLIST } from "./lib/probe-fleet-contract-allowlist.mjs";
import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import { PROHIBITED_READER_ALLOWLIST } from "./lib/prohibited-reader-allowlist.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import {
  DEFAULT_SCENES,
  IMAGERY_STATE_READY,
  LEGACY_DEBUG_FLAG_MODES,
  WGS84_SCENES,
  acceptChromeStrip,
  captureWgs84Cell,
  descriptor,
  pageApplyGlobeDebugMode,
  pageFrameWgs84Rig,
  pageReadWgs84TileState,
  pageSelectWgs84Terrain,
  pairWgs84Scenes,
  planWgs84Cells,
} from "./probe-wgs84.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ARCHIVE = join(HERE, "archive");
const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const archived = (name) => read(join(ARCHIVE, name));

/** The nine probes the harvest moved, by file name. */
const ARCHIVED_WGS84 = Object.freeze([
  "probe-wgs84-alphadbg.mjs",
  "probe-wgs84-atmo.mjs",
  "probe-wgs84-close-postfix.mjs",
  "probe-wgs84-layer1-alpha.mjs",
  "probe-wgs84-polar-stretch.mjs",
  "probe-wgs84-postcomposite.mjs",
  "probe-wgs84-quick.mjs",
  "probe-wgs84-sample0.mjs",
  "probe-wgs84-varyings.mjs",
]);

/** Set globals for the body and put back exactly what was there. */
async function withGlobals(values, body) {
  const saved = new Map();
  for (const key of Object.keys(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    globalThis[key] = values[key];
  }
  try {
    return await body();
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) {
        delete globalThis[key];
      } else {
        Object.defineProperty(globalThis, key, previous);
      }
    }
  }
}

function legacyFlagsOnGlobal() {
  return Object.getOwnPropertyNames(globalThis).filter((name) =>
    /^_webgpuGlobe\w+Debug$/.test(name),
  );
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test("the default plan is every scene on both renderers, canonical order, no mode", () => {
  const cells = planWgs84Cells({ renderers: ["webgl", "webgpu"] });
  assert.deepEqual(
    cells.map((cell) => [cell.scene, cell.renderer, cell.debugMode]),
    [
      ["home", "webgl", null],
      ["home", "webgpu", null],
      ["close", "webgl", null],
      ["close", "webgpu", null],
      ["polar", "webgl", null],
      ["polar", "webgpu", null],
    ],
  );
  for (const cell of cells) {
    assert.equal(cell.rig, WGS84_SCENES[cell.scene]);
  }
  assert.deepEqual([...DEFAULT_SCENES], ["home", "close", "polar"]);
});

test("--scene is read case-insensitively and planned in canonical order", () => {
  const cells = planWgs84Cells({
    scene: "polar, HOME",
    renderers: ["webgpu"],
  });
  assert.deepEqual(
    cells.map((cell) => cell.scene),
    ["home", "polar"],
  );
  assert.throws(
    () => planWgs84Cells({ scene: "arctic", renderers: ["webgl"] }),
    /--scene must name home, close or polar \(got "arctic"\)/,
  );
  assert.throws(
    () => planWgs84Cells({ scene: " , ", renderers: ["webgl"] }),
    /--scene needs at least one/,
  );
});

test("--debug-mode takes a list, de-duplicated in order, with none as the plain frame", () => {
  const cells = planWgs84Cells({
    scene: "home",
    renderers: ["webgpu"],
    debugMode: "none,fade-amount,draped,fade-amount",
  });
  assert.deepEqual(
    cells.map((cell) => cell.debugMode),
    [null, "fade-amount", "draped"],
  );
  assert.throws(
    () => planWgs84Cells({ renderers: ["webgpu"], debugMode: " , " }),
    /--debug-mode needs at least one mode name/,
  );
});

test("a debug mode on a run that includes WebGL is a refusal; none alone is not", () => {
  let refusal = null;
  try {
    planWgs84Cells({ renderers: ["webgl", "webgpu"], debugMode: "uv" });
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof ProbeRefusal, "expected a ProbeRefusal");
  assert.equal(refusal.reason, "renderer-unavailable");
  assert.equal(
    planWgs84Cells({ renderers: ["webgl"], debugMode: "none" }).length,
    3,
  );
});

test("the descriptor declares its flags, its launch flags and a positive budget", () => {
  assert.equal(descriptor.name, "wgs84");
  assert.deepEqual(
    descriptor.args.extraOptions.map((option) => option.flag),
    ["--scene", "--debug-mode"],
  );
  assert.deepEqual(descriptor.launchArgs, [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan",
    "--disable-cache",
  ]);
  const perCell = descriptor.workBudgetMs({
    scene: "home",
    renderers: ["webgpu"],
  });
  assert.ok(Number.isSafeInteger(perCell) && perCell > 0);
  assert.equal(
    descriptor.workBudgetMs({ renderers: ["webgl", "webgpu"] }),
    6 * perCell,
  );
  // A malformed request still gets a deadline; the refusal comes from cells.
  assert.ok(
    descriptor.workBudgetMs({ scene: "nowhere", renderers: ["webgl"] }) > 0,
  );
});

// ---------------------------------------------------------------------------
// The rigs, against the archived probes' own text
// ---------------------------------------------------------------------------

test("each scene's rig is the registry's record and validates", async () => {
  const rigs = await loadRigs();
  for (const [scene, rig] of Object.entries(WGS84_SCENES)) {
    assert.deepEqual(
      rigById(rigs, rig.id),
      rig,
      `${scene}: not the registry record`,
    );
    assert.deepEqual(validateRig(rig), []);
    assert.ok(rig.tags.includes("wgs84"));
    assert.equal(rig.page, "Apps/CesiumViewer/index.html");
    assert.equal(rig.dials.baseLayerPickerTerrain, "wgs84");
    assert.deepEqual(rig.viewport, { width: 1280, height: 720 });
  }
});

test("the cameras and dwells are the archived probes' own", () => {
  const close = archived("probe-wgs84-close-postfix.mjs");
  const polar = archived("probe-wgs84-polar-stretch.mjs");
  const quick = archived("probe-wgs84-quick.mjs");
  // setView with a destination only takes heading 0, pitch -90 degrees, roll 0.
  const nadir = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
  assert.ok(close.includes("C.Cartesian3.fromDegrees(-100, 40, 1000000)"));
  assert.deepEqual(WGS84_SCENES.close.camera, {
    lon: -100,
    lat: 40,
    height: 1000000,
    ...nadir,
  });
  assert.ok(polar.includes("C.Cartesian3.fromDegrees(-105, 50, 14_000_000)"));
  assert.deepEqual(WGS84_SCENES.polar.camera, {
    lon: -105,
    lat: 50,
    height: 14_000_000,
    ...nadir,
  });
  assert.equal(WGS84_SCENES.home.camera, null);
  assert.ok(
    !quick.includes("setView"),
    "the quick probe never moved the camera",
  );
  // Dwells: quick and the debug-flag probes rendered 1,200 frames; the polar
  // probe broke out after 200 once tiles were loaded.
  assert.ok(quick.includes("for (let i = 0; i < 1200; i++)"));
  assert.equal(WGS84_SCENES.home.readiness.frames, 1200);
  assert.ok(polar.includes("if (v.scene.globe.tilesLoaded && i > 200) break;"));
  assert.equal(WGS84_SCENES.polar.readiness.frames, 200);
  assert.equal(WGS84_SCENES.close.readiness.frames, 360);
});

// ---------------------------------------------------------------------------
// The debug modes: legacy flags, paired by sentinel
// ---------------------------------------------------------------------------

test("every legacy flag names the registry mode with its own sentinel", () => {
  const log = read(join(REPO, "migration_doc", "WEBGPU_DEBUGGING_LOG.md"));
  const flagSentinels = new Map(
    [...log.matchAll(/^\| `(_webgpuGlobe\w+Debug)` \| ([0-9.]+e9) \|/gm)].map(
      (match) => [match[1], Number(match[2])],
    ),
  );
  const registry = read(
    join(
      REPO,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeFragmentDebug.ts",
    ),
  );
  const modeSentinels = new Map(
    [...registry.matchAll(/name: "([^"]+)",\s*sentinel: ([0-9.e]+),/g)].map(
      (match) => [match[1], Number(match[2])],
    ),
  );
  assert.equal(flagSentinels.size, 16, "the Batch 56 flag table moved");
  assert.ok(modeSentinels.size >= 16, "the registry did not parse");
  assert.deepEqual(
    Object.keys(LEGACY_DEBUG_FLAG_MODES).sort(),
    [...flagSentinels.keys()].sort(),
  );
  for (const [flag, mode] of Object.entries(LEGACY_DEBUG_FLAG_MODES)) {
    assert.equal(
      modeSentinels.get(mode),
      flagSentinels.get(flag),
      `${flag} -> ${mode}: sentinels differ`,
    );
  }
});

test("every flag an archived probe sets is paired, and no engine reader names one", () => {
  const set = new Set();
  for (const name of ARCHIVED_WGS84) {
    for (const match of archived(name).matchAll(/_webgpuGlobe\w+Debug/g)) {
      set.add(match[0]);
    }
  }
  assert.ok(set.size >= 10, `only ${set.size} flags found in the archive`);
  for (const flag of set) {
    assert.ok(Object.hasOwn(LEGACY_DEBUG_FLAG_MODES, flag), `${flag} unpaired`);
  }
  const readers = [
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeFragmentDebug.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
  ].map((file) => read(join(REPO, file)));
  for (const source of readers) {
    assert.ok(source.includes("_webgpuGlobeDebugMode"));
    for (const flag of Object.keys(LEGACY_DEBUG_FLAG_MODES)) {
      assert.ok(!source.includes(flag), `an engine reader names ${flag}`);
    }
  }
});

test("a debug mode is applied through the registry and never as a legacy flag", async () => {
  const registry = [{ name: "uv" }, { name: "tex0-alpha" }];
  // No registry on the page.
  await withGlobals({ __webgpuGlobeFragmentDebugRegistry: undefined }, () => {
    const result = pageApplyGlobeDebugMode({ mode: "uv" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not published/);
  });
  // A name the registry does not know.
  await withGlobals({ __webgpuGlobeFragmentDebugRegistry: registry }, () => {
    const result = pageApplyGlobeDebugMode({ mode: "texalphadbg" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.known, ["uv", "tex0-alpha"]);
  });
  // Through CesiumDebug, which writes the global the tile packer reads.
  const calls = [];
  await withGlobals(
    {
      __webgpuGlobeFragmentDebugRegistry: registry,
      _webgpuGlobeDebugMode: undefined,
      CesiumDebug: {
        globeFragmentDebug(name) {
          calls.push(name);
          globalThis._webgpuGlobeDebugMode = name;
        },
      },
    },
    () => {
      const result = pageApplyGlobeDebugMode({ mode: "tex0-alpha" });
      assert.deepEqual(result, {
        ok: true,
        mode: "tex0-alpha",
        via: "CesiumDebug.globeFragmentDebug",
        readBack: "tex0-alpha",
      });
      assert.deepEqual(legacyFlagsOnGlobal(), []);
    },
  );
  assert.deepEqual(calls, ["tex0-alpha"]);
  // Without CesiumDebug, by the global directly.
  await withGlobals(
    {
      __webgpuGlobeFragmentDebugRegistry: registry,
      _webgpuGlobeDebugMode: undefined,
      CesiumDebug: undefined,
    },
    () => {
      const result = pageApplyGlobeDebugMode({ mode: "uv" });
      assert.equal(result.ok, true);
      assert.equal(result.via, "globalThis._webgpuGlobeDebugMode");
      assert.equal(globalThis._webgpuGlobeDebugMode, "uv");
      assert.deepEqual(legacyFlagsOnGlobal(), []);
    },
  );
  // A command that does not take is reported, not captured past.
  await withGlobals(
    {
      __webgpuGlobeFragmentDebugRegistry: registry,
      _webgpuGlobeDebugMode: undefined,
      CesiumDebug: { globeFragmentDebug() {} },
    },
    () => {
      const result = pageApplyGlobeDebugMode({ mode: "uv" });
      assert.equal(result.ok, false);
      assert.match(result.reason, /did not read back/);
    },
  );
});

// ---------------------------------------------------------------------------
// The terrain pick and the tile-state dump, on stub pages
// ---------------------------------------------------------------------------

test("the terrain pick takes the WGS84 entry, and reports a picker without one", async () => {
  const world = { name: "Cesium World Terrain" };
  const ellipsoid = { name: "WGS84 Ellipsoid" };
  const viewModel = {
    terrainProviderViewModels: [world, ellipsoid],
    selectedTerrain: world,
  };
  await withGlobals({ viewer: { baseLayerPicker: { viewModel } } }, () => {
    const result = pageSelectWgs84Terrain({ match: "wgs84" });
    assert.deepEqual(result, {
      ok: true,
      match: "wgs84",
      name: "WGS84 Ellipsoid",
    });
    assert.equal(viewModel.selectedTerrain, ellipsoid);
  });
  const without = {
    terrainProviderViewModels: [world],
    selectedTerrain: world,
  };
  await withGlobals(
    { viewer: { baseLayerPicker: { viewModel: without } } },
    () => {
      const result = pageSelectWgs84Terrain({ match: "wgs84" });
      assert.equal(result.ok, false);
      assert.deepEqual(result.available, ["Cesium World Terrain"]);
      assert.equal(without.selectedTerrain, world, "the selection moved");
    },
  );
});

/** A stub viewer holding one rendered tile whose imagery is in `state`. */
function stubViewer(state) {
  class EllipsoidTerrainProvider {}
  const terrainProvider = new EllipsoidTerrainProvider();
  const readyImagery = {
    state,
    level: 0,
    x: 0,
    y: 0,
    rectangle: { west: -3.1, south: -1.4, east: 0, north: 1.4 },
    _webgpuReprojectedTexture: {
      width: 256,
      height: 256,
      format: "rgba8unorm",
    },
  };
  const tileImagery = {
    readyImagery,
    loadingImagery: readyImagery,
    useWebMercatorT: false,
  };
  const tile = {
    level: 0,
    x: 0,
    y: 0,
    rectangle: { west: -3.1, south: -1.4, east: 0, north: 1.4 },
    data: { imagery: [tileImagery], mesh: null },
  };
  return {
    terrainProvider,
    scene: {
      mode: 3,
      _globe: { _surface: { _tilesToRender: [tile] } },
      imageryLayers: { length: 1, get: () => ({ imageryProvider: {} }) },
    },
  };
}

test("the dump keeps the archived fields and reads READY as ImageryState does", async () => {
  const imageryState = read(
    join(REPO, "packages/engine/Source/Scene/ImageryState.js"),
  );
  const ready = Number(imageryState.match(/\bREADY: (\d+),/)[1]);
  assert.equal(IMAGERY_STATE_READY, ready);

  await withGlobals({ viewer: stubViewer(ready) }, () => {
    const dump = pageReadWgs84TileState({ imageryReady: IMAGERY_STATE_READY });
    assert.deepEqual(Object.keys(dump), [
      "mode",
      "terrainProvider",
      "imageryLayerCount",
      "imageryProvider",
      "imageryProjection",
      "terrainProjection",
      "tilesToRender",
      "sampleTileMesh",
      "sampleTileImagery",
      "allTilesSummary",
      "sampleParentInfo",
    ]);
    assert.equal(dump.terrainProvider, "EllipsoidTerrainProvider");
    assert.equal(dump.sampleTileImagery.readyImageryReady, true);
    assert.equal(dump.sampleParentInfo.readyIsActuallyReady, true);
    assert.deepEqual(Object.keys(dump.allTilesSummary.buckets), [
      "useMercT=false|reproj=true|riReady=true|isParent=false",
    ]);
  });
  // The literal the archived dump compared against is no ImageryState value.
  assert.ok(!/:\s*8,/.test(imageryState), "ImageryState gained an 8");
  await withGlobals({ viewer: stubViewer(8) }, () => {
    const dump = pageReadWgs84TileState({ imageryReady: IMAGERY_STATE_READY });
    assert.equal(dump.sampleTileImagery.readyImageryReady, false);
  });
});

// ---------------------------------------------------------------------------
// The pairing
// ---------------------------------------------------------------------------

function frame(width, height, pixels) {
  return { width, height, data: Uint8Array.from(pixels.flat()) };
}

test("pairs a scene's two renderers, skips single-renderer cells, and refuses two sizes", () => {
  const gpu = frame(2, 1, [
    [0, 0, 0, 255],
    [200, 0, 0, 255],
  ]);
  const gl = frame(2, 1, [
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]);
  const pairs = pairWgs84Scenes([
    { run: 0, scene: "home", renderer: "webgl", debugMode: null, image: gl },
    { run: 0, scene: "home", renderer: "webgpu", debugMode: null, image: gpu },
    { run: 0, scene: "close", renderer: "webgpu", debugMode: "uv", image: gpu },
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].scene, "home");
  assert.equal(pairs[0].mismatchPct, 50);
  assert.equal(pairs[0].changedPx, 1);
  assert.equal(pairs[0].tolerance, 16);

  let refusal = null;
  try {
    pairWgs84Scenes([
      { run: 0, scene: "polar", renderer: "webgl", debugMode: null, image: gl },
      {
        run: 0,
        scene: "polar",
        renderer: "webgpu",
        debugMode: null,
        image: frame(1, 1, [[0, 0, 0, 255]]),
      },
    ]);
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof ProbeRefusal, "two sizes must refuse");
  assert.equal(refusal.reason, "capture-size-mismatch");

  // Same width, different height: refused by name, not left to diffImages.
  let heightRefusal = null;
  try {
    pairWgs84Scenes([
      { run: 0, scene: "close", renderer: "webgl", debugMode: null, image: gl },
      {
        run: 0,
        scene: "close",
        renderer: "webgpu",
        debugMode: null,
        image: frame(2, 2, [
          [0, 0, 0, 255],
          [0, 0, 0, 255],
          [0, 0, 0, 255],
          [0, 0, 0, 255],
        ]),
      },
    ]);
  } catch (error) {
    heightRefusal = error;
  }
  assert.ok(heightRefusal instanceof ProbeRefusal, "two heights must refuse");
  assert.equal(heightRefusal.reason, "capture-size-mismatch");
  assert.deepEqual(heightRefusal.details.webgpu, [2, 2]);
  assert.deepEqual(heightRefusal.details.webgl, [2, 1]);
});

// ---------------------------------------------------------------------------
// The chrome strip, the framing and one whole cell
// ---------------------------------------------------------------------------

test("the chrome strip is accepted only when it reports nothing over the canvas", () => {
  assert.deepEqual(
    acceptChromeStrip(
      { removed: 7, leftovers: [] },
      { scene: "home", renderer: "webgpu" },
    ),
    { chromeRemoved: true, removed: 7, leftovers: [] },
  );
  const refusalFor = (report) => {
    try {
      acceptChromeStrip(report, { scene: "polar", renderer: "webgl" });
    } catch (error) {
      return error;
    }
    return null;
  };
  // The fork's renderer toolbar is not among the selectors the strip removes.
  const covered = refusalFor({ removed: 7, leftovers: ["renderer-toolbar"] });
  assert.ok(covered instanceof ProbeRefusal, "a leftover must refuse");
  assert.equal(covered.reason, "capture-chrome-over-canvas");
  assert.match(covered.message, /renderer-toolbar/);
  assert.deepEqual(covered.details.widgets.leftovers, ["renderer-toolbar"]);
  // A strip that reports no list is no evidence of a clean canvas.
  for (const report of [
    undefined,
    null,
    {},
    { removed: 3 },
    { leftovers: "" },
  ]) {
    const missing = refusalFor(report);
    assert.ok(
      missing instanceof ProbeRefusal,
      `${JSON.stringify(report)} must refuse`,
    );
    assert.equal(missing.reason, "capture-chrome-over-canvas");
  }
});

/** An in-memory engine module for `pageFrameWgs84Rig`'s `import(moduleUrl)`. */
const STUB_ENGINE_URL = `data:text/javascript,${encodeURIComponent(
  [
    "export const Cartesian3 = { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) };",
    "export const JulianDate = { toIso8601: (time) => time.iso };",
  ].join("\n"),
)}`;

/** A determinism-kit stand-in that records what it is asked. */
const STUB_DET = [
  "globalThis.__det = {",
  "  pinClock(C, viewer, scene, iso) {",
  "    globalThis.__wgs84Calls.push(['pinClock', iso]);",
  "    viewer.clock.currentTime = { iso };",
  "  },",
  "  async settleTiles(scene, options) {",
  "    globalThis.__wgs84Calls.push(['settleTiles', options]);",
  "    return options.minFrames + 1;",
  "  },",
  "};",
].join("\n");

/** Run `pageFrameWgs84Rig` for a rig against a stub viewer; return the calls. */
async function frameOnStubViewer(rig) {
  const calls = [];
  const viewer = {
    camera: { setView: (view) => calls.push(["setView", view]) },
    scene: { globe: { tilesLoaded: true } },
    clock: { currentTime: null },
  };
  const result = await withGlobals(
    { viewer, __wgs84Calls: calls, __det: undefined },
    () =>
      pageFrameWgs84Rig({
        moduleUrl: STUB_ENGINE_URL,
        camera: rig.camera,
        clock: rig.clock,
        det: STUB_DET,
        minFrames: rig.readiness.frames,
        maxFrames: 1200,
        stableFrames: 30,
      }),
  );
  return { calls, result };
}

test("the framing pins the rig's clock, places its camera and settles on its dwell", async () => {
  const polar = await frameOnStubViewer(WGS84_SCENES.polar);
  assert.deepEqual(polar.calls, [
    ["pinClock", "2026-06-21T18:00:00Z"],
    [
      "setView",
      {
        destination: { lon: -105, lat: 50, height: 14_000_000 },
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      },
    ],
    ["settleTiles", { minFrames: 200, maxFrames: 1200, stableFrames: 30 }],
  ]);
  assert.deepEqual(polar.result, {
    framesRendered: 201,
    tilesLoaded: true,
    clock: "2026-06-21T18:00:00Z",
  });
  // The home rig keeps the page's own view: the camera is never moved.
  const home = await frameOnStubViewer(WGS84_SCENES.home);
  assert.deepEqual(
    home.calls.map(([step]) => step),
    ["pinClock", "settleTiles"],
  );
});

/** A 2x2 frame with four different pixels. */
const CELL_PNG = Buffer.from(
  encodeRgbaPng(
    Uint8Array.from([
      10, 20, 30, 255, 200, 100, 50, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    ]),
    2,
    2,
  ),
);

/** A clean strip report and an accepted terrain pick. */
const CLEAN_STRIP = Object.freeze({ removed: 9, leftovers: [] });
const TERRAIN_OK = Object.freeze({
  ok: true,
  match: "ellipsoid-under-test",
  name: "WGS84 Ellipsoid",
});

/**
 * A Playwright-shaped browser with one page. The page answers each of the
 * probe's page functions from `answers`, records every step in order, and
 * delivers `events` to its listeners during navigation.
 */
function stubBrowser({ terrain, debug = null, strip, events = [] }) {
  const calls = [];
  const listeners = { console: [], pageerror: [] };
  const page = {
    on: (type, listener) => listeners[type].push(listener),
    off: (type, listener) => {
      listeners[type] = listeners[type].filter((each) => each !== listener);
    },
    addInitScript: async (script) => calls.push(["addInitScript", script]),
    goto: async (url) => {
      calls.push(["goto", url]);
      for (const [type, payload] of events) {
        for (const listener of listeners[type]) {
          listener(payload);
        }
      }
    },
    waitForFunction: async () => calls.push(["waitForFunction"]),
    evaluate: async (body, arg) => {
      if (body === pageSelectWgs84Terrain) {
        calls.push(["terrain", arg]);
        return terrain;
      }
      if (body === pageApplyGlobeDebugMode) {
        calls.push(["debug", arg]);
        return debug;
      }
      if (body === pageFrameWgs84Rig) {
        calls.push(["frame", arg]);
        return { framesRendered: arg.minFrames, tilesLoaded: true };
      }
      if (body === pageReadWgs84TileState) {
        calls.push(["tileState", arg]);
        return {
          tilesToRender: 1,
          terrainProvider: "EllipsoidTerrainProvider",
        };
      }
      if (body === `(${STRIP_WIDGETS_SOURCE})()`) {
        calls.push(["strip"]);
        return strip;
      }
      // The error gate's arming and the capture seam's liveness read.
      calls.push(["evaluate"]);
      return null;
    },
    locator: (selector) => ({
      count: async () => 1,
      screenshot: async () => {
        calls.push(["screenshot", selector]);
        return CELL_PNG;
      },
    }),
  };
  let closed = 0;
  const browser = {
    newContext: async (options) => {
      calls.push(["newContext", options]);
      return {
        newPage: async () => page,
        close: async () => {
          closed += 1;
        },
      };
    },
  };
  return { browser, calls, listeners, closed: () => closed };
}

/** A console message as Playwright hands it to a listener. */
function consoleMessage(type, text) {
  return { type: () => type, text: () => text };
}

/** Run one cell of the close rig, its terrain dial renamed, on a stub. */
function runStubCell(stub, directory, { debugMode = null } = {}) {
  const rig = {
    ...WGS84_SCENES.close,
    dials: { baseLayerPickerTerrain: "ellipsoid-under-test" },
  };
  return captureWgs84Cell({
    browser: stub.browser,
    origin: "http://localhost:8094",
    cell: { scene: "close", rig, renderer: "webgpu", debugMode },
    run: 0,
    outputDirectory: directory,
    captures: [],
  });
}

const steps = (stub) => stub.calls.map(([step]) => step);
const argOf = (stub, step) => stub.calls.find(([each]) => each === step)?.[1];

test("a cell applies its rig, strips the chrome right before the capture and records it", async () => {
  const stub = stubBrowser({
    terrain: TERRAIN_OK,
    strip: CLEAN_STRIP,
    events: [
      ["console", consoleMessage("error", "e1")],
      ["console", consoleMessage("log", "ignored")],
      ["console", consoleMessage("warning", "w1")],
      ["pageerror", new Error("boom")],
    ],
  });
  await withLaneTmp("wgs84-probe-cell-", async (directory) => {
    const { record } = await runStubCell(stub, directory);
    assert.deepEqual(argOf(stub, "newContext"), {
      viewport: { width: 1280, height: 720 },
    });
    assert.equal(
      argOf(stub, "goto"),
      "http://localhost:8094/Apps/CesiumViewer/index.html?renderer=webgpu",
    );
    assert.deepEqual(argOf(stub, "terrain"), { match: "ellipsoid-under-test" });
    assert.deepEqual(argOf(stub, "frame"), {
      moduleUrl: "/Build/CesiumUnminified/index.js",
      camera: WGS84_SCENES.close.camera,
      clock: WGS84_SCENES.close.clock,
      det: DET_BROWSER_SETUP,
      minFrames: WGS84_SCENES.close.readiness.frames,
      maxFrames: 1200,
      stableFrames: 30,
    });
    // The error gate is installed before the page loads, or it sees nothing.
    const order = steps(stub);
    assert.equal(argOf(stub, "addInitScript"), errorGateInit);
    assert.ok(
      order.indexOf("addInitScript") < order.indexOf("goto"),
      "the error gate was installed after navigation",
    );
    // The dump reads READY as ImageryState spells it (4), not as 8.
    assert.deepEqual(argOf(stub, "tileState"), { imageryReady: 4 });
    // One strip, after the settle, and nothing evaluated before the shot.
    const strip = order.indexOf("strip");
    assert.equal(order.filter((step) => step === "strip").length, 1);
    assert.ok(
      order.indexOf("frame") < strip,
      "the strip ran before the settle",
    );
    assert.equal(order[strip + 1], "screenshot");
    assert.equal(argOf(stub, "screenshot"), ".cesium-widget canvas");
    assert.equal(record.chromeRemoved, true);
    assert.deepEqual(record.widgets, { removed: 9, leftovers: [] });
    assert.equal(record.terrain, "WGS84 Ellipsoid");
    assert.equal(record.rig, "wgs84-close-1mm");
    assert.equal(record.rig, WGS84_SCENES.close.id);
    assert.deepEqual(record.framing, {
      framesRendered: WGS84_SCENES.close.readiness.frames,
      tilesLoaded: true,
    });
    assert.deepEqual(record.tileState, {
      tilesToRender: 1,
      terrainProvider: "EllipsoidTerrainProvider",
    });
    assert.equal(record.capture.width, 2);
    assert.equal(record.capture.height, 2);
    assert.deepEqual(
      record.channelMeans,
      frameChannelMeans(decodePng(CELL_PNG)),
    );
    assert.deepEqual(record.pageErrors, {
      count: 2,
      first: [
        { type: "error", text: "e1" },
        { type: "pageerror", text: "boom" },
      ],
    });
    assert.deepEqual(record.pageWarnings, {
      count: 1,
      first: [{ type: "warning", text: "w1" }],
    });
    assert.deepEqual(readdirSync(directory), ["close-webgpu-run0.png"]);
  });
  assert.equal(stub.closed(), 1);
  assert.deepEqual(stub.listeners, { console: [], pageerror: [] });
});

test("a cell with anything left over the canvas, or no strip report, refuses before it captures", async () => {
  for (const strip of [{ removed: 9, leftovers: ["renderer-toolbar"] }, null]) {
    const stub = stubBrowser({ terrain: TERRAIN_OK, strip });
    await withLaneTmp("wgs84-probe-cell-", async (directory) => {
      await assert.rejects(
        runStubCell(stub, directory),
        (error) =>
          error instanceof ProbeRefusal &&
          error.reason === "capture-chrome-over-canvas",
      );
      assert.ok(!steps(stub).includes("screenshot"), "a frame was taken");
      assert.deepEqual(readdirSync(directory), []);
    });
    assert.equal(stub.closed(), 1);
  }
});

test("a cell refuses a picker without the rig's terrain, and a debug mode the page cannot apply", async () => {
  const noTerrain = stubBrowser({
    terrain: {
      ok: false,
      match: "ellipsoid-under-test",
      available: ["Cesium World Terrain"],
    },
    strip: CLEAN_STRIP,
  });
  await withLaneTmp("wgs84-probe-cell-", async (directory) => {
    await assert.rejects(
      runStubCell(noTerrain, directory),
      (error) =>
        error instanceof ProbeRefusal && error.reason === "terrain-unavailable",
    );
  });
  assert.deepEqual(
    steps(noTerrain).filter((step) =>
      ["debug", "frame", "strip", "screenshot"].includes(step),
    ),
    [],
  );

  const noMode = stubBrowser({
    terrain: TERRAIN_OK,
    debug: { ok: false, mode: "uv", reason: "the registry has no mode" },
    strip: CLEAN_STRIP,
  });
  await withLaneTmp("wgs84-probe-cell-", async (directory) => {
    await assert.rejects(
      runStubCell(noMode, directory, { debugMode: "uv" }),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "debug-mode-unavailable",
    );
  });
  assert.deepEqual(argOf(noMode, "debug"), { mode: "uv" });
  assert.ok(!steps(noMode).includes("frame"), "the rig was framed anyway");

  const withMode = stubBrowser({
    terrain: TERRAIN_OK,
    debug: { ok: true, mode: "uv", via: "CesiumDebug.globeFragmentDebug" },
    strip: CLEAN_STRIP,
  });
  await withLaneTmp("wgs84-probe-cell-", async (directory) => {
    const { record } = await runStubCell(withMode, directory, {
      debugMode: "uv",
    });
    assert.equal(record.debugMode, "uv");
    assert.equal(record.debug.via, "CesiumDebug.globeFragmentDebug");
    assert.deepEqual(readdirSync(directory), ["close-uv-webgpu-run0.png"]);
  });
  const order = steps(withMode);
  assert.ok(order.indexOf("debug") < order.indexOf("frame"));
});

test("the descriptor's cells write each pair's diff image and record it", async () => {
  const stub = stubBrowser({ terrain: TERRAIN_OK, strip: CLEAN_STRIP });
  await withLaneTmp("wgs84-probe-cells-", async (directory) => {
    const [cell] = await descriptor.cells({
      browser: stub.browser,
      run: 0,
      options: { scene: "close", renderers: ["webgl", "webgpu"] },
      origin: "http://localhost:8094",
      outputDirectory: directory,
      captures: [],
    });
    assert.equal(cell.captures.length, 2);
    assert.equal(cell.pairs.length, 1);
    const [pair] = cell.pairs;
    assert.equal(pair.scene, "close");
    assert.equal(pair.diffImage, "close-diff-run0.png");
    assert.equal(pair.mismatchPct, 0);
    assert.deepEqual(readdirSync(directory).sort(), [
      "close-diff-run0.png",
      "close-webgl-run0.png",
      "close-webgpu-run0.png",
    ]);
    const diff = decodePng(readFileSync(join(directory, pair.diffImage)));
    assert.equal(diff.width, 2);
    assert.equal(diff.height, 2);
  });
  assert.equal(stub.closed(), 2);
});

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

test("the live family is one probe; the nine others are archived and off every allowlist", () => {
  const live = readdirSync(HERE).filter(
    (name) => /^probe-wgs84.*\.mjs$/.test(name) && !name.endsWith(".spec.mjs"),
  );
  assert.deepEqual(live, ["probe-wgs84.mjs"]);
  assert.deepEqual(
    readdirSync(ARCHIVE)
      .filter((name) => name.startsWith("probe-wgs84"))
      .sort(),
    [...ARCHIVED_WGS84],
  );
  for (const name of ["probe-wgs84.mjs", ...ARCHIVED_WGS84]) {
    assert.ok(!Object.hasOwn(PROBE_CONTRACT_ALLOWLIST, name), `${name} pinned`);
    assert.ok(
      !Object.hasOwn(PROHIBITED_READER_ALLOWLIST, name),
      `${name} pinned as a prohibited reader`,
    );
    assert.ok(
      !Object.hasOwn(
        BEHAVIOUR_FLEET_ALLOWLIST,
        `Tools/visual-regression/archive/${name}`,
      ),
    );
  }
  for (const name of ARCHIVED_WGS84) {
    assert.equal(
      parsePurposeHeader(archived(name)).status,
      "ARCHIVED-CANDIDATE",
      name,
    );
  }
});

test("every relative import of an archived wgs84 probe resolves from archive/", async () => {
  let checked = 0;
  for (const name of ARCHIVED_WGS84) {
    for (const [specifier, { names }] of scanImports(archived(name))) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = resolve(ARCHIVE, specifier);
      let module;
      try {
        module = await import(pathToFileURL(target).href);
      } catch (error) {
        assert.fail(
          `${name}: ${specifier} does not resolve from archive/ (${error.message})`,
        );
      }
      for (const binding of names) {
        assert.ok(
          binding in module,
          `${name}: ${specifier} does not export ${binding}`,
        );
      }
      checked++;
    }
  }
  assert.ok(checked >= 1, `only ${checked} relative imports were checked`);
});
