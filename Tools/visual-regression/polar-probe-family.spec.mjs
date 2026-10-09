// polar-probe-family.spec.mjs — the polar probe family after the probe-kit
// harvest. Pure Node: no browser, no GPU.
// @purpose Pins the harvested polar family: the rigs restate the archived probes' own scenes, the migrated parity probe selects and guards rigs, refuses a covered canvas or an excluded renderer, counts the frames its settle rendered and builds its parity cell as stated, it carries no private launch, diff or argv parsing, and every archived polar probe is flipped, parses and links from archive/.
// @status ACTIVE
//
// THE RIGS ARE CHECKED AGAINST THE ARCHIVED SOURCES, NOT AGAINST THEMSELVES.
// Each archived polar probe is the original file moved by `git mv` with only
// its header tags changed, so its camera, clock, loop bounds, wait and dials
// are still the numbers that were captured. The first two tests read those
// numbers out of the archived text and require every polar rig to restate
// them; a rig that drifted from the scene it claims to record goes red here.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parsePurposeHeader } from "../lib/purpose-header.mjs";
import { DET_BROWSER_SETUP } from "./lib/determinism-kit.mjs";
import { scanImports } from "./lib/engine-stub-bundler.mjs";
import {
  POLAR_PARITY_RULES,
  polarParity,
} from "./lib/metrics/polar-parity.mjs";
import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";
import {
  DEFAULT_RIG_IDS,
  POLAR_DIALS,
  SETTLE_TRAILING_FRAMES,
  descriptor,
  polarParityCell,
  refuseCoveredCanvas,
  requireRigRenderers,
  selectPolarRigs,
  settledFrameCount,
} from "./probe-polar-multi-plain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = path.join(HERE, "archive");
const MIGRATED = path.join(HERE, "probe-polar-multi-plain.mjs");
const RIGS = await loadRigs();

/** The fourteen probes the harvest moved to archive/. */
const ARCHIVED = Object.freeze([
  "probe-polar-alpha-debug.mjs",
  "probe-polar-bisect.mjs",
  "probe-polar-diff-all.mjs",
  "probe-polar-fixed-time.mjs",
  "probe-polar-forcered.mjs",
  "probe-polar-fs-stages.mjs",
  "probe-polar-imagery-state.mjs",
  "probe-polar-mesh-compare.mjs",
  "probe-polar-multi-angle.mjs",
  "probe-polar-noculling.mjs",
  "probe-polar-pixel-sweep.mjs",
  "probe-polar-settle.mjs",
  "probe-polar-stretch-diag.mjs",
  "probe-polar-wireframe.mjs",
]);

const archived = (name) => fs.readFileSync(path.join(ARCHIVE, name), "utf8");
const num = (text) => Number(text.replace(/_/g, ""));

/** The loop every source wrote: `for (i < max) { …; if (tilesLoaded && i > floor) break; }` then a wait. */
function loopOf(source) {
  const max = /for \(let i = 0; i < (\d+); i\+\+\)/.exec(source);
  const floor = /tilesLoaded && i > (\d+)\) break/.exec(source);
  const dwell = /waitForTimeout\((\d+)\)/.exec(source);
  return {
    maxFrames: max ? num(max[1]) : null,
    // `i > floor` first holds at i = floor + 1, after floor + 2 rendered frames.
    frames: floor ? num(floor[1]) + 2 : null,
    dwellMs: dwell ? num(dwell[1]) : 0,
  };
}

/** Every `{ name, lon, lat, height }` view literal in a source. */
function viewsOf(source) {
  const pattern =
    /\{ name: "([a-z-]+)", lon: (-?[\d_]+), lat: (-?[\d_]+), height: ([\d_]+) \}/g;
  return [...source.matchAll(pattern)].map((m) => ({
    name: m[1],
    lon: num(m[2]),
    lat: num(m[3]),
    height: num(m[4]),
  }));
}

/** Every `fromDegrees(lon, lat, height)` with literal arguments in a source. */
function literalCamerasOf(source) {
  const pattern = /fromDegrees\((-?[\d_]+), (-?[\d_]+), (-?[\d_]+)\)/g;
  return [...source.matchAll(pattern)].map((m) => ({
    lon: num(m[1]),
    lat: num(m[2]),
    height: num(m[3]),
  }));
}

function assertRigScene(rigId, { camera, clock, loop, dials, renderers }) {
  const rig = rigById(RIGS, rigId);
  assert.ok(rig, `rig ${rigId} is missing`);
  assert.deepEqual(validateRig(rig), [], `${rigId} validates`);
  assert.ok(rig.tags.includes("polar"), `${rigId} is tagged polar`);
  assert.equal(rig.page, "Apps/CesiumViewer/index.html", `${rigId} page`);
  assert.deepEqual(
    rig.viewport,
    { width: 1280, height: 720 },
    `${rigId} viewport`,
  );
  assert.deepEqual(
    rig.camera,
    { ...camera, heading: 0, pitch: -Math.PI / 2, roll: 0 },
    `${rigId} camera`,
  );
  assert.equal(rig.clock, clock, `${rigId} clock`);
  assert.deepEqual(
    rig.readiness,
    { kind: "settleFrames", ...loop },
    `${rigId} readiness`,
  );
  assert.deepEqual(rig.dials, { terrain: "wgs84", ...dials }, `${rigId} dials`);
  assert.deepEqual(rig.renderers, renderers, `${rigId} renderers`);
}

test("the six standing rigs and their overlay twins restate the archived multi-angle probe's views", () => {
  // probe-polar-multi-angle.mjs carries the same six views and clock as the
  // pre-harvest probe-polar-multi-plain.mjs ("Must match" in its own source).
  const source = archived("probe-polar-multi-angle.mjs");
  const views = viewsOf(source);
  assert.equal(views.length, 6, "the archived source declares six views");
  const clock = /FIXED_CLOCK_UTC = "([^"]+)"/.exec(source)[1];
  assert.match(source, /width: 1280, height: 720/);
  assert.match(
    source,
    /DebugTileImageryProvider\(\{\s*colorByLevel: true,?\s*\}\)/,
  );
  const loop = loopOf(source);
  assert.deepEqual(loop, { maxFrames: 1500, frames: 302, dwellMs: 2000 });

  assert.deepEqual(
    DEFAULT_RIG_IDS,
    views.map((view) => `polar-plain-${view.name}`),
    "the default set is the six views in the order they were captured",
  );
  for (const { name, ...camera } of views) {
    const both = ["webgl", "webgpu"];
    assertRigScene(`polar-plain-${name}`, {
      camera,
      clock,
      loop,
      dials: {},
      renderers: both,
    });
    assertRigScene(`polar-overlay-${name}`, {
      camera,
      clock,
      loop,
      dials: { debugTileOverlay: { colorByLevel: true } },
      renderers: both,
    });
  }
});

test("every other polar rig restates the archived probe that captured or measured its scene", () => {
  const both = ["webgl", "webgpu"];
  const webgpu = ["webgpu"];

  const fixed = archived("probe-polar-fixed-time.mjs");
  const fixedClock = /FIXED_ISO = "([^"]+)"/.exec(fixed)[1];
  for (const { name, ...camera } of viewsOf(fixed)) {
    assertRigScene(`polar-effects-off-${name}`, {
      camera,
      clock: fixedClock,
      loop: loopOf(fixed),
      dials: {
        skyAtmosphereShow: false,
        globeShowGroundAtmosphere: false,
        globeEnableLighting: false,
        sunShow: false,
        moonShow: false,
        skyBoxShow: false,
        fogEnabled: false,
      },
      renderers: both,
    });
  }
  for (const property of [
    "skyAtmosphere.show = false",
    "showGroundAtmosphere = false",
    "enableLighting = false",
    "sun.show = false",
    "moon.show = false",
    "skyBox.show = false",
    "fog.enabled = false",
  ]) {
    assert.ok(fixed.includes(property), `fixed-time sets ${property}`);
  }

  const diag = archived("probe-polar-stretch-diag.mjs");
  const [northAmerica] = literalCamerasOf(diag);
  assert.deepEqual(literalCamerasOf(archived("probe-polar-bisect.mjs")), [
    northAmerica,
  ]);
  assert.deepEqual(loopOf(archived("probe-polar-bisect.mjs")), loopOf(diag));
  assertRigScene("polar-orbit-14mm-northamerica", {
    camera: northAmerica,
    clock: null,
    loop: loopOf(diag),
    dials: {},
    renderers: both,
  });
  assertRigScene("polar-orbit-14mm-northamerica-overlay", {
    camera: northAmerica,
    clock: null,
    loop: loopOf(diag),
    dials: { debugTileOverlay: { colorByLevel: true } },
    renderers: webgpu,
  });

  const settle = archived("probe-polar-settle.mjs");
  assert.deepEqual(literalCamerasOf(settle), [northAmerica]);
  assert.match(settle, /tileCacheSize = 0/);
  const budgets = /for \(const frames of \[([\d, ]+)\]\)/.exec(settle)[1];
  for (const frames of budgets.split(",").map(num)) {
    assertRigScene(`polar-settle-14mm-${frames}f`, {
      camera: northAmerica,
      clock: null,
      // A fixed frame count with no tiles-loaded exit: floor = ceiling.
      loop: { frames, maxFrames: frames, dwellMs: loopOf(settle).dwellMs },
      dials: { globeTileCacheSize: 0 },
      renderers: webgpu,
    });
  }

  const southPoleClose = { lon: 0, lat: -89, height: 3000000 };
  for (const [rigId, file, mode] of [
    [
      "polar-southpole-close-force-red",
      "probe-polar-forcered.mjs",
      "force-red",
    ],
    ["polar-southpole-close-alpha", "probe-polar-alpha-debug.mjs", "alpha"],
  ]) {
    const source = archived(file);
    assert.deepEqual(literalCamerasOf(source), [southPoleClose]);
    assert.ok(source.includes(`"${mode}"`), `${file} sets the ${mode} mode`);
    assertRigScene(rigId, {
      camera: southPoleClose,
      clock: null,
      loop: loopOf(source),
      dials: { globeFragmentDebug: mode },
      renderers: webgpu,
    });
  }

  const noculling = archived("probe-polar-noculling.mjs");
  assert.match(noculling, /backFaceCulling = false/);
  assertRigScene("polar-noculling-southpole-close", {
    camera: literalCamerasOf(noculling)[0],
    clock: null,
    loop: loopOf(noculling),
    dials: { globeBackFaceCulling: false },
    renderers: both,
  });

  const wireframe = archived("probe-polar-wireframe.mjs");
  assert.match(wireframe, /showWireframe = true/);
  const wireViews = viewsOf(wireframe);
  assert.equal(wireViews.length, 2);
  for (const { name, ...camera } of wireViews) {
    assertRigScene(`polar-wireframe-${name}`, {
      camera,
      clock: null,
      loop: loopOf(wireframe),
      dials: { globeShowWireframe: true },
      renderers: both,
    });
  }

  // The state-dump scenes: imagery-state lists its views as {name, lat, alt}
  // at lon 0 and reads state with no wait after the loop.
  const state = archived("probe-polar-imagery-state.mjs");
  const stateViews = [
    ...state.matchAll(/\{ name: "([a-z-]+)", lat: (-?\d+), alt: ([\d_]+) \}/g),
  ];
  assert.equal(stateViews.length, 2);
  for (const [, name, lat, alt] of stateViews) {
    assertRigScene(`polar-tile-state-${name}`, {
      camera: { lon: 0, lat: num(lat), height: num(alt) },
      clock: null,
      loop: { ...loopOf(state), dwellMs: 0 },
      dials: {},
      renderers: both,
    });
  }
  const mesh = archived("probe-polar-mesh-compare.mjs");
  const meshView =
    /VIEW = \{ lon: (-?\d+), lat: (-?\d+), height: ([\d_]+) \}/.exec(mesh);
  for (const property of [
    "skyAtmosphere.show = false",
    "showGroundAtmosphere = false",
    "enableLighting = false",
  ]) {
    assert.ok(mesh.includes(property), `mesh-compare sets ${property}`);
  }
  assertRigScene("polar-mesh-orbit-80n", {
    camera: {
      lon: num(meshView[1]),
      lat: num(meshView[2]),
      height: num(meshView[3]),
    },
    clock: null,
    loop: { ...loopOf(mesh), dwellMs: 0 },
    dials: {
      skyAtmosphereShow: false,
      globeShowGroundAtmosphere: false,
      globeEnableLighting: false,
    },
    renderers: both,
  });

  // Every polar rig was reached by one of the checks above.
  const polar = RIGS.filter((rig) => rig.tags.includes("polar"));
  assert.equal(polar.length, 27, "the polar census in rig-registry.spec.mjs");
});

test("every polar rig declares only dials the migrated probe can apply", () => {
  const polar = RIGS.filter((rig) => rig.tags.includes("polar"));
  assert.ok(polar.length > 0);
  for (const rig of polar) {
    for (const dial of Object.keys(rig.dials ?? {})) {
      assert.ok(POLAR_DIALS.includes(dial), `${rig.id} declares ${dial}`);
    }
    assert.ok(Number.isInteger(rig.readiness.maxFrames), `${rig.id} maxFrames`);
    assert.ok(Number.isInteger(rig.readiness.dwellMs), `${rig.id} dwellMs`);
  }
  // And each one is selectable, which is what makes it re-capturable.
  assert.equal(
    selectPolarRigs(RIGS, polar.map((rig) => rig.id).join(",")).length,
    polar.length,
  );
});

test("rig selection: the default six, a named list, and every refusal", () => {
  assert.deepEqual(
    selectPolarRigs(RIGS, undefined).map((rig) => rig.id),
    [...DEFAULT_RIG_IDS],
  );
  assert.deepEqual(
    selectPolarRigs(
      RIGS,
      " polar-wireframe-northpole-close , polar-plain-equator-mid",
    ).map((rig) => rig.id),
    ["polar-wireframe-northpole-close", "polar-plain-equator-mid"],
  );
  assert.throws(() => selectPolarRigs(RIGS, ","), TypeError);
  assert.throws(
    () => selectPolarRigs(RIGS, "polar-no-such-rig"),
    /no rig "polar-no-such-rig"/,
  );
  assert.throws(
    () => selectPolarRigs(RIGS, "globe-default"),
    /is not a polar rig/,
  );
  const odd = { ...rigById(RIGS, "polar-plain-equator-mid"), id: "polar-odd" };
  odd.dials = { ...odd.dials, globeTranslucency: 0.5 };
  assert.throws(
    () => selectPolarRigs([odd], "polar-odd"),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "rig-dial-unsupported" &&
      error.details.unsupported.includes("globeTranslucency"),
  );
});

function grey(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4).fill(value);
  return { width, height, data };
}

test("the parity cell: both banked rules for a pair, none for a one-renderer rig, a throw for two sizes", () => {
  const pairRig = rigById(RIGS, "polar-plain-midlat-mid");
  const gl = grey(20, 10, 100);
  const gpu = grey(20, 10, 100);
  gpu.data[4 * (5 * 20 + 10)] = 200; // one pixel inside the inset, sum 100
  const cell = polarParityCell(
    pairRig,
    0,
    { webgl: { sha256: "a" }, webgpu: { sha256: "b" } },
    {
      webgl: gl,
      webgpu: gpu,
    },
  );
  assert.equal(cell.rigId, "polar-plain-midlat-mid");
  assert.deepEqual(cell.renderers, ["webgl", "webgpu"]);
  assert.deepEqual(cell.parity, polarParity(gl, gpu));
  assert.deepEqual(Object.keys(cell.parity), Object.keys(POLAR_PARITY_RULES));
  assert.equal(cell.parity["centre80-sum24"].mismatchPx, 1);

  const oneRig = rigById(RIGS, "polar-southpole-close-force-red");
  const single = polarParityCell(
    oneRig,
    0,
    { webgpu: { sha256: "c" } },
    { webgpu: gpu },
  );
  assert.equal(single.parity, null);
  assert.match(single.parityNote, /webgpu only/);

  assert.throws(
    () =>
      polarParityCell(
        pairRig,
        0,
        { webgl: {}, webgpu: {} },
        {
          webgl: grey(20, 10, 1),
          webgpu: grey(10, 20, 1),
        },
      ),
    RangeError,
  );
});

test("the capture refusals: a canvas still covered after the strip, and a renderer the run excludes", () => {
  const pair = rigById(RIGS, "polar-plain-midlat-mid");
  const clear = { removed: 6, leftovers: [] };
  assert.equal(refuseCoveredCanvas(pair.id, "webgpu", clear), clear);
  assert.throws(
    () =>
      refuseCoveredCanvas(pair.id, "webgpu", {
        removed: 6,
        leftovers: ["cesium-viewer-toolbar"],
      }),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "capture-canvas-covered" &&
      error.details.rig === pair.id &&
      error.details.renderer === "webgpu" &&
      error.details.leftovers.includes("cesium-viewer-toolbar"),
  );

  assert.equal(requireRigRenderers(pair, ["webgl", "webgpu"]), undefined);
  assert.throws(
    () => requireRigRenderers(pair, ["webgpu"]),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "renderer-unavailable" &&
      /excludes webgl$/.test(error.message),
  );
  const single = rigById(RIGS, "polar-southpole-close-force-red");
  assert.equal(requireRigRenderers(single, ["webgpu"]), undefined);
  assert.throws(
    () => requireRigRenderers(single, ["webgl"]),
    (error) =>
      error instanceof ProbeRefusal && error.reason === "renderer-unavailable",
  );
});

/**
 * Runs the determinism kit's own `settleTiles` (its browser source, as the
 * page receives it) over a scene whose tiles report loaded from render
 * `loadedAt` on (never, when null), and counts every render.
 */
async function runKitSettle({ minFrames, maxFrames, loadedAt }) {
  const page = {};
  let now = 0;
  const performance = { now: () => (now += 1000) };
  const requestAnimationFrame = (callback) => setImmediate(callback);
  // eslint-disable-next-line no-new-func
  new Function(
    "window",
    "requestAnimationFrame",
    "performance",
    DET_BROWSER_SETUP,
  )(page, requestAnimationFrame, performance);
  let renders = 0;
  const scene = {
    render: () => {
      renders++;
    },
    globe: {
      get tilesLoaded() {
        return loadedAt !== null && renders >= loadedAt;
      },
    },
  };
  const loopIndex = await page.__det.settleTiles(scene, {
    stableFrames: 1,
    minFrames,
    maxFrames,
    minMillis: 1,
  });
  return { loopIndex, renders };
}

test("framesRendered is the number of frames the kit's settle rendered, trailing frames included", async () => {
  for (const [minFrames, maxFrames, loadedAt, expected] of [
    [302, 1500, 1, 310], // a default rig settling at its floor
    [302, 1500, 700, 708], // settling past the floor
    [302, 1500, null, 1508], // running out
    [120, 120, 1, 128], // polar-settle-14mm-120f, loaded early
    [120, 120, null, 128], // polar-settle-14mm-120f, never loaded
  ]) {
    const { loopIndex, renders } = await runKitSettle({
      minFrames,
      maxFrames,
      loadedAt,
    });
    assert.equal(renders, expected, "the kit rendered what the case expects");
    assert.equal(
      settledFrameCount(loopIndex, maxFrames),
      renders,
      `min ${minFrames} max ${maxFrames} loaded at ${loadedAt}`,
    );
  }
  assert.equal(SETTLE_TRAILING_FRAMES, 8);
});

test("the migrated probe runs on the shared runtime with no private launch, diff, hash or argv parsing", () => {
  const source = fs.readFileSync(MIGRATED, "utf8");
  const header = parsePurposeHeader(source);
  assert.equal(header.status, "ACTIVE");
  assert.deepEqual(header.errors, []);
  assert.match(source, /^\/\/ @runtime lib\/probe-runtime\.mjs\r?$/m);
  for (const [pattern, what] of [
    [/from\s+["']playwright["']/, "a playwright import"],
    [/\.launch\s*\(/, "a browser launch"],
    [/process\.argv/, "argv parsing"],
    [/localhost:8080/, "the 8080 origin"],
    [/createHash/, "a private hash"],
    [/\.screenshot\s*\(/, "a page screenshot"],
    [/drawImage|toDataURL|getImageData/, "an in-page readback"],
    [/fs\.writeFileSync/, "a private file write"],
  ]) {
    assert.doesNotMatch(source, pattern, `the migrated probe carries ${what}`);
  }
  assert.match(source, /captureElement\(/);
  assert.match(source, /polarParity\(/);
  // Text-shape pins (Principle 10: they hold the source's text, not a
  // behaviour) for the call shapes no Node spec can drive: the widget strip is
  // evaluated in the page and its result refused when anything is left over,
  // the run refuses an excluded renderer, and the frame is the scene canvas,
  // never the page.
  assert.match(source, /\$\{STRIP_WIDGETS_SOURCE\}\)\(\)/);
  assert.match(source, /refuseCoveredCanvas\(rig\.id, renderer, stripped\);/);
  assert.match(source, /requireRigRenderers\(rig, options\.renderers\);/);
  assert.match(source, /const SCENE_CANVAS = "\.cesium-widget canvas";/);
  assert.match(source, /selector: SCENE_CANVAS,/);
  assert.equal(descriptor.name, "polar-multi-plain");
  assert.equal(descriptor.receiptEnvelope, "runtime");
  assert.deepEqual(descriptor.servedArtifacts, [
    "Build/CesiumUnminified/index.js",
  ]);
  assert.deepEqual(descriptor.args.extraOptions, [
    { flag: "--rigs", key: "rigs", kind: "string" },
  ]);
});

test("the live polar family is the one migrated probe; the other fourteen are archived, flipped, parse and link", () => {
  const live = fs
    .readdirSync(HERE)
    .filter((name) => name.startsWith("probe-polar-") && name.endsWith(".mjs"));
  assert.deepEqual(live, ["probe-polar-multi-plain.mjs"]);

  const inArchive = fs
    .readdirSync(ARCHIVE)
    .filter((name) => name.startsWith("probe-polar-"))
    .sort();
  assert.deepEqual(inArchive, [...ARCHIVED]);

  let relativeImports = 0;
  for (const name of ARCHIVED) {
    const file = path.join(ARCHIVE, name);
    const source = fs.readFileSync(file, "utf8");
    const header = parsePurposeHeader(source);
    assert.equal(header.status, "ARCHIVED-CANDIDATE", `${name} status`);
    assert.deepEqual(header.errors, [], `${name} header`);
    assert.match(header.note ?? "", /probe-kit harvest/, `${name} note`);
    // Parses as written from its new path.
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    // Any relative import must resolve from archive/ (none of the fourteen
    // has one today; a future edit that adds one is held to it).
    for (const specifier of scanImports(source).keys()) {
      if (specifier.startsWith(".")) {
        relativeImports++;
        assert.ok(
          fs.existsSync(path.resolve(ARCHIVE, specifier)),
          `${name}: ${specifier} does not resolve from archive/`,
        );
      }
    }
  }
  assert.equal(
    relativeImports,
    0,
    "the archived polar probes import packages only",
  );
});
