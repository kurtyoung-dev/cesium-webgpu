// @purpose Drives the verdict function of every globe probe the probe-kit harvest moved onto the shared runtime across each of its bars with no browser, and pins the family's shape: the migrated probes are runtime-resident with no private launch, argv, hash or live-canvas reader, and the retired ones sit in archive/ as ARCHIVED-CANDIDATE with every relative import still resolving from there, and every frame a migrated probe takes on the CesiumViewer page is taken after the kit's widget strip ran on that page load, with a refusal when the strip leaves anything over the canvas.
// @status ACTIVE
//
// WHY BOTH SIDES OF EVERY BAR. A migration that kept the clause text but
// changed an operator (`>` for `>=`, the 15 % carve against the wrong frame, a
// slack of 8 where the probe had 2) would still print the same claim. Each
// case below puts a cell one step inside and one step outside the bar the
// pre-migration probe applied, so an operator or constant that moved turns a
// case red. The bars are transcribed from the probes as committed at
// 7e12d8f1d0; the verdict functions under test are the migrated ones.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { parsePurposeHeader } from "../lib/purpose-header.mjs";
import { scanImports } from "./lib/engine-stub-bundler.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import * as bindGroupCache from "./probe-globe-bindgroup-cache.mjs";
import * as clippoly from "./probe-globe-clippoly-geodetic.mjs";
import * as defaultLimits from "./probe-globe-default-limits.mjs";
import * as effectsToggle from "./probe-globe-effects-handle-toggle.mjs";
import * as pickH44 from "./probe-globe-pick-h44.mjs";
import * as polar from "./probe-globe-polar-stretch.mjs";
import * as translucency from "./probe-globe-translucency.mjs";
import * as underground from "./probe-globe-underground.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MIGRATED = Object.freeze([
  "probe-globe-bindgroup-cache.mjs",
  "probe-globe-clippoly-geodetic.mjs",
  "probe-globe-default-limits.mjs",
  "probe-globe-effects-handle-toggle.mjs",
  "probe-globe-pick-h44.mjs",
  "probe-globe-polar-stretch.mjs",
  "probe-globe-translucency.mjs",
  "probe-globe-underground.mjs",
]);
const ARCHIVED = Object.freeze([
  "probe-globe-bundle-cost.mjs",
  "probe-globe-farzoom.mjs",
  "probe-globe-material.mjs",
  "probe-globe-rasterizes.mjs",
]);

const passed = (verdicts) =>
  Object.fromEntries(verdicts.map((v) => [v.id, v.pass]));
const allPass = (verdicts) => verdicts.every((v) => v.pass === true);

/** Strip comments and string contents so a construct named in prose does not count. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

test("the migrated globe probes are runtime-resident and carry none of the private machinery", () => {
  for (const name of MIGRATED) {
    const source = readFileSync(path.join(HERE, name), "utf8");
    const code = codeOnly(source);
    assert.match(
      source,
      /@runtime lib\/probe-runtime\.mjs/,
      `${name}: @runtime tag`,
    );
    assert.equal(
      parsePurposeHeader(source).status,
      "ACTIVE",
      `${name}: status`,
    );
    assert.doesNotMatch(
      source,
      /from\s+["']playwright["']/,
      `${name}: imports playwright`,
    );
    assert.doesNotMatch(code, /\.launch\s*\(/, `${name}: launches a browser`);
    assert.doesNotMatch(code, /process\.argv/, `${name}: parses argv`);
    assert.doesNotMatch(
      code,
      /process\.env\.PROBE_/,
      `${name}: reads PROBE_* env`,
    );
    assert.doesNotMatch(source, /createHash/, `${name}: hashes privately`);
    assert.doesNotMatch(
      code,
      /\.drawImage\s*\(|\.toDataURL\s*\(|\.screenshot\s*\(/,
      `${name}: reads the canvas outside the seam`,
    );
    assert.doesNotMatch(code, /localhost:8080/, `${name}: hard-codes 8080`);
    assert.match(
      code,
      /runProbe\s*\(\s*descriptor\s*\)/,
      `${name}: runs its descriptor`,
    );
  }
});

test("the retired globe probes are in archive/ as ARCHIVED-CANDIDATE, gone from the live fleet, and still link from there", async () => {
  let relative = 0;
  for (const name of ARCHIVED) {
    assert.equal(
      existsSync(path.join(HERE, name)),
      false,
      `${name} still live`,
    );
    const source = readFileSync(path.join(HERE, "archive", name), "utf8");
    assert.equal(parsePurposeHeader(source).status, "ARCHIVED-CANDIDATE", name);
    // archive/README.md: an archived file still runs from its new path. A
    // `git mv` does not re-base a relative import, and one left pointing at
    // the old neighbourhood fails ESM linking before any code runs; eslint and
    // the flat-directory fleet contract do not see it.
    const imports = scanImports(source);
    assert.ok(imports.size > 0, `${name}: the import scan found nothing`);
    for (const [specifier, { names }] of imports) {
      if (!/^\.\.?\//.test(specifier)) {
        continue;
      }
      relative++;
      const target = path.resolve(HERE, "archive", specifier);
      assert.ok(
        existsSync(target),
        `${name}: ${specifier} does not resolve from archive/`,
      );
      const exported = await import(pathToFileURL(target).href);
      for (const binding of names) {
        assert.ok(
          binding in exported,
          `${name}: ${specifier} does not export ${binding}`,
        );
      }
    }
  }
  // farzoom takes the determinism kit and rasterizes the WebGPU error gate.
  assert.ok(relative >= 2, `only ${relative} relative imports were checked`);
});

test("effects toggle: (A) carve > 5000, (B)/(C) under 15 % of the carve, (D) no console error", () => {
  const cell = {
    run: 0,
    onVsBaseline: 6000,
    offVsBaseline: 899,
    restoreVsOn: 899,
    totalPx: 786432,
    warmupFrames: 400,
    tilesLoaded: true,
    errors: [],
  };
  assert.ok(allPass(effectsToggle.evaluateEffectsToggle([cell])));
  const at = (patch) =>
    passed(effectsToggle.evaluateEffectsToggle([{ ...cell, ...patch }]));
  assert.equal(at({ onVsBaseline: 5000 })["clip-on-carves/run0"], false);
  assert.equal(
    at({ onVsBaseline: 5001, offVsBaseline: 0, restoreVsOn: 0 })[
      "clip-on-carves/run0"
    ],
    true,
  );
  assert.equal(
    at({ offVsBaseline: 900 })["clip-off-restores-baseline/run0"],
    false,
  );
  assert.equal(
    at({ restoreVsOn: 900 })["clip-restore-reproduces-on/run0"],
    false,
  );
  assert.equal(at({ errors: ["x"] })["console-errors/run0"], false);
});

test("pick-h44: every WebGPU and WebGL clause fails on its own", () => {
  const leg = (overrides) => ({
    pickGlobeFalse: { defined: false },
    pickPoint: { defined: true, id: "fg-point", isGlobe: false },
    pickGlobeTrue: { defined: true, isGlobe: true },
    errors: [],
    gpuErrors: [],
    ...overrides,
  });
  const webgl = leg({ pickGlobeTrue: { defined: false } });
  const good = { run: 0, webgl, webgpu: leg({}) };
  assert.ok(allPass(pickH44.evaluatePickH44([good])));
  const at = (cell) => passed(pickH44.evaluatePickH44([cell]));
  assert.equal(
    at({
      ...good,
      webgpu: leg({ pickGlobeFalse: { defined: true, isGlobe: true } }),
    })["webgpu-default-unpickable/run0"],
    false,
  );
  assert.equal(
    at({ ...good, webgpu: leg({ pickPoint: { defined: true, id: "other" } }) })[
      "webgpu-foreground-point-pickable/run0"
    ],
    false,
  );
  assert.equal(
    at({
      ...good,
      webgpu: leg({ pickGlobeTrue: { defined: true, isGlobe: false } }),
    })["webgpu-pickable-returns-globe/run0"],
    false,
  );
  assert.equal(
    at({ ...good, webgpu: leg({ errors: ["e"] }) })[
      "webgpu-console-errors/run0"
    ],
    false,
  );
  assert.equal(
    at({ ...good, webgpu: leg({ gpuErrors: ["g"] }) })[
      "webgpu-validation-errors/run0"
    ],
    false,
  );
  assert.equal(
    at({
      ...good,
      webgl: { ...webgl, pickGlobeTrue: { defined: true, isGlobe: true } },
    })["webgl-never-returns-globe/run0"],
    false,
  );
  assert.equal(
    at({ ...good, webgl: { ...webgl, pickPoint: { defined: false } } })[
      "webgl-foreground-point-pickable/run0"
    ],
    false,
  );
  assert.equal(
    at({ ...good, webgl: { ...webgl, errors: ["e"] } })[
      "webgl-console-errors/run0"
    ],
    false,
  );
  // WebGL GPU errors were never a clause, and still are not.
  assert.equal(
    allPass(
      pickH44.evaluatePickH44([
        { ...good, webgl: { ...webgl, gpuErrors: ["g"] } },
      ]),
    ),
    true,
  );
});

test("translucency: baseline guard 30 %, then baseline + 8 with a floor of 10, over the run median", () => {
  const cells = (scenes) => [{ run: 0, scenes }];
  const byId = (scenes) =>
    passed(translucency.evaluateTranslucency(cells(scenes)));
  assert.deepEqual(
    byId({
      "off-default": 24.5,
      "translucent-space": 32.5,
      "translucent-terrain": 3.65,
    }),
    {
      "mismatch/off-default": true,
      "mismatch/translucent-space": true,
      "mismatch/translucent-terrain": true,
    },
  );
  assert.equal(
    byId({
      "off-default": 24.5,
      "translucent-space": 32.51,
      "translucent-terrain": 1,
    })["mismatch/translucent-space"],
    false,
  );
  assert.equal(
    byId({
      "off-default": 30.01,
      "translucent-space": 1,
      "translucent-terrain": 1,
    })["mismatch/off-default"],
    false,
  );
  // The floor: a 1 % baseline still allows 10 %.
  assert.equal(
    byId({
      "off-default": 1,
      "translucent-space": 10,
      "translucent-terrain": 10.01,
    })["mismatch/translucent-terrain"],
    false,
  );
  // Across runs the median decides, as nRunMedian did.
  const three = [
    {
      run: 0,
      scenes: {
        "off-default": 20,
        "translucent-space": 40,
        "translucent-terrain": 1,
      },
    },
    {
      run: 1,
      scenes: {
        "off-default": 20,
        "translucent-space": 20,
        "translucent-terrain": 1,
      },
    },
    {
      run: 2,
      scenes: {
        "off-default": 20,
        "translucent-space": 21,
        "translucent-terrain": 1,
      },
    },
  ];
  assert.equal(
    passed(translucency.evaluateTranslucency(three))[
      "mismatch/translucent-space"
    ],
    true,
  );
});

test("underground: baseline guard 30 %, then baseline + 2 with a floor of 8, over the run median", () => {
  const byId = (scenes) =>
    passed(underground.evaluateUnderground([{ run: 0, scenes }]));
  assert.equal(
    allPass(
      underground.evaluateUnderground([
        {
          run: 0,
          scenes: {
            "above-default": 22,
            "underground-red": 24,
            "underground-def": 4.29,
          },
        },
      ]),
    ),
    true,
  );
  assert.equal(
    byId({
      "above-default": 22,
      "underground-red": 24.01,
      "underground-def": 1,
    })["mismatch/underground-red"],
    false,
  );
  assert.equal(
    byId({ "above-default": 1, "underground-red": 8, "underground-def": 8.01 })[
      "mismatch/underground-def"
    ],
    false,
  );
  assert.equal(
    byId({
      "above-default": 30.01,
      "underground-red": 1,
      "underground-def": 1,
    })["mismatch/above-default"],
    false,
  );
});

test("translucency and underground score a scene whose two frames differ in size as 100 %, and same-size frames by rgbSumDiff", () => {
  const frame = (width, value) => ({
    width,
    height: 2,
    data: new Uint8ClampedArray(width * 2 * 4).fill(value),
  });
  for (const module of [translucency, underground]) {
    assert.equal(module.scenarioMismatchPct(frame(2, 0), frame(3, 0)), 100);
    assert.equal(module.scenarioMismatchPct(frame(2, 0), frame(2, 0)), 0);
    assert.equal(module.scenarioMismatchPct(frame(2, 0), frame(2, 255)), 100);
  }
});

test("clippoly: hole >= 0.95 on both and mismatch <= 2 %, read from the printed precision", () => {
  const cell = (analysis) => [{ run: 0, analysis }];
  const byId = (analysis) => passed(clippoly.evaluateClippoly(cell(analysis)));
  assert.equal(
    allPass(
      clippoly.evaluateClippoly(
        cell({ mismatchPct: "2.00", holeFracA: "0.950", holeFracB: "1.000" }),
      ),
    ),
    true,
  );
  assert.equal(
    byId({ mismatchPct: "2.01", holeFracA: "1.000", holeFracB: "1.000" })[
      "boundary-aligned/run0"
    ],
    false,
  );
  assert.equal(
    byId({ mismatchPct: "0.00", holeFracA: "0.949", holeFracB: "1.000" })[
      "hole-webgpu/run0"
    ],
    false,
  );
  assert.equal(
    byId({ mismatchPct: "0.00", holeFracA: "1.000", holeFracB: "0.949" })[
      "hole-webgl/run0"
    ],
    false,
  );
  // A size mismatch leaves nulls, read as no hole and 100 %, as `{error}` was.
  assert.equal(
    allPass(
      clippoly.evaluateClippoly(
        cell({ mismatchPct: null, holeFracA: null, holeFracB: null }),
      ),
    ),
    false,
  );
  const odd = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  const other = { width: 3, height: 2, data: new Uint8ClampedArray(24) };
  assert.deepEqual(clippoly.analyzeClippoly(odd, other), {
    mismatchPct: null,
    holeFracA: null,
    holeFracB: null,
  });
});

test("bind-group cache: the five clauses and their bars", () => {
  const cell = {
    run: 0,
    settledA: true,
    settledB: true,
    steadyA: { frames: 30, createsPerFrame: 0.5, requestsPerFrame: 10.1 },
    steadyB: { frames: 30, createsPerFrame: 0.5, requestsPerFrame: 10.1 },
    panCreates: 10,
    nonBlackPct: 0.081,
    colorBuckets: 101,
    errors: [],
    sustainedPanGroup0Creates: 8,
    sustainedPanGroup0PerFrame: 8 / 120,
    sustainedPanGroup1Creates: 1,
    maxGroup0PerFrame: 1,
    panFramesWithGroup0: 8,
    panFrames: 120,
  };
  assert.ok(allPass(bindGroupCache.evaluateBindGroupCache([cell])));
  const at = (patch) =>
    passed(bindGroupCache.evaluateBindGroupCache([{ ...cell, ...patch }]));
  assert.equal(
    at({ steadyA: { ...cell.steadyA, createsPerFrame: 0.51 } })[
      "steady-state-settles/run0"
    ],
    false,
  );
  assert.equal(
    at({ steadyA: { ...cell.steadyA, requestsPerFrame: 10 } })[
      "steady-state-settles/run0"
    ],
    false,
  );
  assert.equal(at({ settledA: false })["steady-state-settles/run0"], false);
  assert.equal(at({ panCreates: 9 })["pan-spikes-then-resettles/run0"], false);
  assert.equal(at({ nonBlackPct: 0.08 })["globe-visibly-rendered/run0"], false);
  assert.equal(at({ colorBuckets: 100 })["globe-visibly-rendered/run0"], false);
  assert.equal(at({ errors: ["x"] })["console-errors/run0"], false);
  assert.equal(
    at({ sustainedPanGroup0Creates: 9 })[
      "sustained-pan-group0-stays-cached/run0"
    ],
    false,
  );
  assert.equal(
    at({ sustainedPanGroup1Creates: 0 })[
      "sustained-pan-group0-stays-cached/run0"
    ],
    false,
  );
});

test("default limits: the tier decides the expected layout, and each clause has its bar", () => {
  const cell = {
    run: 0,
    textureLimit: 16,
    deviceLimit: 16,
    slotCount: 4,
    loaded1: true,
    loaded2: true,
    phase1: { nonBlackPct: 0.081, colorBuckets: 151 },
    phase2: { nonBlackPct: 0.081, colorBuckets: 151 },
    changedPct: 0.01,
    greenShift: 2.01,
    errors: [],
  };
  assert.ok(allPass(defaultLimits.evaluateDefaultLimits([cell])));
  const at = (patch) =>
    passed(defaultLimits.evaluateDefaultLimits([{ ...cell, ...patch }]));
  assert.equal(at({ deviceLimit: 32 })["forced-texture-limit/run0"], false);
  assert.equal(at({ slotCount: 16 })["imagery-layout-selected/run0"], false);
  assert.equal(
    at({ textureLimit: 64, deviceLimit: 64, slotCount: 16 })[
      "imagery-layout-selected/run0"
    ],
    true,
  );
  assert.equal(
    at({ textureLimit: 28, deviceLimit: 28, slotCount: 16 })[
      "imagery-layout-selected/run0"
    ],
    true,
  );
  assert.equal(at({ loaded1: false })["single-layer-renders/run0"], false);
  assert.equal(
    at({ phase1: { nonBlackPct: 0.5, colorBuckets: 150 } })[
      "single-layer-renders/run0"
    ],
    false,
  );
  assert.equal(
    at({ greenShift: 2 })["overflow-blend-pass-composites/run0"],
    false,
  );
  assert.equal(
    at({ phase2: { nonBlackPct: 0.08, colorBuckets: 300 } })[
      "overflow-blend-pass-composites/run0"
    ],
    false,
  );
  assert.equal(at({ errors: ["x"] })["console-errors/run0"], false);
  assert.equal(
    defaultLimits.descriptor.args.extraOptions[0].flag,
    "--texture-limit",
  );
  assert.equal(defaultLimits.descriptor.args.extraOptions[0].default, 16);
});

test("polar stretch: the five per-view checks at their limits, and a size mismatch fails the way it did", () => {
  const view = {
    mismatchPct: 0.27,
    discRadius: 200,
    icePxA: 1000,
    icePxB: 1180,
    iceCentroidYA: 100,
    iceCentroidYB: 105,
    bestShift_discUnits: -0.02,
    seamBluePx: 45,
  };
  const report = (overrides) => ({
    mid: { ...view, ...overrides },
    far: { ...view, mismatchPct: 1.5 },
    extreme: { ...view, mismatchPct: 1.5 },
  });
  const at = (overrides) =>
    passed(polar.evaluatePolar([{ run: 0, report: report(overrides) }]));
  assert.ok(Object.values(at({})).every(Boolean));
  assert.equal(
    at({ iceCentroidYB: 105.2 })["mid/ice centroid Y shift/run0"],
    false,
  );
  assert.equal(at({ icePxB: 1181 })["mid/ice area ratio (gpu/gl)/run0"], false);
  assert.equal(
    at({ icePxA: 200, icePxB: 1 })["mid/ice area ratio (gpu/gl)/run0"],
    true,
  );
  assert.equal(
    at({ bestShift_discUnits: 0.025 })["mid/top-half profile shift/run0"],
    false,
  );
  assert.equal(at({ mismatchPct: 0.28 })["mid/pixel mismatch %/run0"], false);
  assert.equal(
    at({ seamBluePx: 46 })["mid/seam-blue px (tile-seam fingerprint)/run0"],
    false,
  );
  const broken = passed(
    polar.evaluatePolar([
      { run: 0, report: { ...report({}), mid: { error: "size mismatch" } } },
    ]),
  );
  assert.deepEqual(
    [
      broken["mid/ice centroid Y shift/run0"],
      broken["mid/ice area ratio (gpu/gl)/run0"],
      broken["mid/top-half profile shift/run0"],
      broken["mid/pixel mismatch %/run0"],
      broken["mid/seam-blue px (tile-seam fingerprint)/run0"],
    ],
    [false, true, false, false, false],
  );
  // The `{error}` above is what analyzePolar itself returns for a pair of two
  // sizes: it compares nothing and reports no passing number.
  const blank = (width, height) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  });
  assert.deepEqual(polar.analyzePolar(blank(1280, 720), blank(1280, 719)), {
    error: "size mismatch",
  });
});

test("every migrated descriptor declares the module its page imports and refuses a renderer it cannot measure", async () => {
  const descriptors = [
    bindGroupCache.descriptor,
    clippoly.descriptor,
    defaultLimits.descriptor,
    effectsToggle.descriptor,
    pickH44.descriptor,
    polar.descriptor,
    translucency.descriptor,
    underground.descriptor,
  ];
  for (const descriptor of descriptors) {
    assert.deepEqual(
      descriptor.servedArtifacts,
      ["Build/CesiumUnminified/index.js"],
      descriptor.name,
    );
    assert.equal(
      descriptor.workBudgetMs,
      undefined,
      `${descriptor.name}: a budget must be measured, not invented`,
    );
    await assert.rejects(
      descriptor.cells({
        browser: null,
        run: 0,
        options: { renderers: [] },
        origin: "http://localhost:8094",
      }),
      (error) => error.reason === "renderer-unavailable",
      descriptor.name,
    );
  }
});

// ─── The CesiumViewer chrome ─────────────────────────────────────────────────
//
// An element capture is a screenshot of the canvas's rectangle, so on the
// CesiumViewer page it composites the toolbar, the navigation-help panel (open
// in every fresh context), the animation widget, the credits, the timeline and
// the fullscreen button into the frame. The readbacks the migration replaced
// saw the canvas alone, and an in-page hide by selector misses whatever its
// list leaves out (the pass-4 review found the fullscreen button in every
// banked translucency and underground frame). So every probe that captures on
// that page runs the kit's strip (`lib/strip-viewer-widgets.mjs`) and refuses
// on leftovers. These cases run each migrated descriptor's own `cells()` to
// its last frame against a browser that records what the probe sends to its
// pages, in order. A page step counts as the strip only when the page actually
// receives the kit's source, so a strip made unreachable with its text kept,
// moved after a frame, sent to another page or before a later navigation, or
// replaced by a hide, turns them red. No in-page hide counts.

/** The migrated probes that take frames on the CesiumViewer page. */
const CESIUM_VIEWER_CAPTURERS = Object.freeze([
  "globe-bindgroup-cache",
  "globe-clippoly-geodetic",
  "globe-effects-handle-toggle",
  "globe-polar-stretch",
  "globe-translucency",
  "globe-underground",
]);

/** What the named page functions return, where a probe reads the answer before its first frame or in its cell. */
const PAGE_ANSWERS = Object.freeze({
  pageSetupWidget: { deviceLimit: 16 },
  pageWarmup: { warmupFrames: 301, tilesLoaded: true },
  pageClipStep: { tilesLoaded: true },
  pagePhasesAB: {
    settledA: true,
    settledB: true,
    steadyA: { frames: 30, createsPerFrame: 0, requestsPerFrame: 40 },
    steadyB: { frames: 30, createsPerFrame: 0, requestsPerFrame: 40 },
    panCreates: 12,
  },
  pagePhaseE: {
    sustainedPanGroup0Creates: 0,
    sustainedPanGroup0PerFrame: 0,
    sustainedPanGroup1Creates: 9,
    maxGroup0PerFrame: 0,
    panFramesWithGroup0: 0,
    panFrames: 120,
    cacheEntries: 3,
    lifetime: { creates: 3, hits: 9, hitRate: 0.75, byGroup: { 0: 1 } },
  },
});

/**
 * The shared error gate's read (`collectGateErrors`,
 * `Tools/lib/webgpu-error-gate.mjs`) is an unnamed page function, so it is
 * answered by the gate global it reads: an empty gate.
 */
const GATE_READ = "w.__webgpuGate ||";
const EMPTY_GATE = Object.freeze({
  errors: [],
  deviceLost: null,
  armedDevices: 0,
});

/**
 * A stand-in for the runtime's browser. Page steps are not run: each is
 * recorded (as the kit's chrome strip when the page receives
 * `STRIP_WIDGETS_SOURCE`, else as another step) with the page it was sent to,
 * and answered from `PAGE_ANSWERS` by the page function's name. Each element
 * screenshot is recorded as a frame and answered with an opaque black PNG the
 * size of its context's viewport, so each probe's own analysis runs over
 * frames of the size it expects and the run reaches its last frame.
 */
function recordingBrowser({ strip }) {
  const events = [];
  const pngs = new Map();
  const frameFor = (viewport) => {
    const width = viewport?.width ?? 4;
    const height = viewport?.height ?? 4;
    const key = `${width}x${height}`;
    if (!pngs.has(key)) {
      const rgba = new Uint8Array(width * height * 4);
      for (let i = 3; i < rgba.length; i += 4) {
        rgba[i] = 255;
      }
      pngs.set(key, Buffer.from(encodeRgbaPng(rgba, width, height)));
    }
    return pngs.get(key);
  };
  let pages = 0;
  const browser = {
    async newContext(options = {}) {
      const viewport = options.viewport ?? null;
      return {
        async newPage() {
          const pageId = pages++;
          let url = null;
          const handle = {
            async count() {
              return 1;
            },
            nth() {
              return handle;
            },
            async screenshot() {
              events.push({ kind: "frame", pageId, url });
              return frameFor(viewport);
            },
          };
          return {
            on() {},
            async addInitScript() {},
            async goto(target) {
              url = target;
              events.push({ kind: "goto", pageId, url });
            },
            async waitForFunction() {},
            async waitForTimeout() {},
            async evaluate(step, arg) {
              const text =
                typeof step === "string"
                  ? step
                  : `${step}\n${typeof arg === "string" ? arg : JSON.stringify(arg ?? null)}`;
              const kind = text.includes(STRIP_WIDGETS_SOURCE)
                ? "strip"
                : "step";
              events.push({ kind, pageId, url });
              if (kind === "strip") {
                return structuredClone(strip);
              }
              if (text.includes(GATE_READ)) {
                return structuredClone(EMPTY_GATE);
              }
              return structuredClone(PAGE_ANSWERS[step?.name]);
            },
            locator() {
              return handle;
            },
          };
        },
        async close() {},
      };
    },
  };
  return { browser, events };
}

/** One run of a descriptor's `cells()` against the recording browser. */
function recordCells(descriptor, { strip }) {
  const recorder = recordingBrowser({ strip });
  // The kit's lane temp root, removed whether the run returns or throws, so a
  // killed run leaves one sweepable root rather than loose Temp-root sandboxes.
  return withLaneTmp("globe-chrome-", async (outputDirectory) => {
    try {
      const cells = await descriptor.cells({
        browser: recorder.browser,
        run: 0,
        options: { renderers: ["webgl", "webgpu"], textureLimit: 16 },
        origin: "http://localhost:8094",
        outputDirectory,
        captures: [],
      });
      return { ...recorder, cells, error: null };
    } catch (error) {
      return { ...recorder, cells: null, error };
    }
  });
}

const CLEAN_STRIP = Object.freeze({ removed: 7, leftovers: [] });

/** The scene and renderer keys each multi-capture probe records `chromeRemoved` under. */
const PER_BACKEND = (removed) => ({ webgl: removed, webgpu: removed });
const CHROME_REMOVED = Object.freeze({
  "globe-bindgroup-cache": 7,
  "globe-clippoly-geodetic": PER_BACKEND(7),
  "globe-effects-handle-toggle": 7,
  "globe-polar-stretch": {
    mid: PER_BACKEND(7),
    far: PER_BACKEND(7),
    extreme: PER_BACKEND(7),
  },
  "globe-translucency": {
    "off-default": PER_BACKEND(7),
    "translucent-space": PER_BACKEND(7),
    "translucent-terrain": PER_BACKEND(7),
  },
  "globe-underground": {
    "above-default": PER_BACKEND(7),
    "underground-red": PER_BACKEND(7),
    "underground-def": PER_BACKEND(7),
  },
});

/**
 * Each frame a recorded run took on the CesiumViewer page, with whether the
 * kit strip reached that page after its latest navigation and before the frame.
 */
function viewerFrames(events) {
  return events.flatMap((event, index) => {
    if (
      event.kind !== "frame" ||
      !String(event.url).includes("/Apps/CesiumViewer/")
    ) {
      return [];
    }
    let stripped = false;
    for (let j = index - 1; j >= 0; j--) {
      const earlier = events[j];
      if (earlier.pageId !== event.pageId) {
        continue;
      }
      if (earlier.kind === "goto") {
        break;
      }
      if (earlier.kind === "strip") {
        stripped = true;
        break;
      }
    }
    return [{ ...event, stripped }];
  });
}

test("every frame a migrated probe takes on the CesiumViewer page is taken after the kit strip reached that page", async () => {
  const framesOnViewer = {};
  const elsewhere = [];
  const noFrame = [];
  for (const { descriptor } of [
    bindGroupCache,
    clippoly,
    defaultLimits,
    effectsToggle,
    pickH44,
    polar,
    translucency,
    underground,
  ]) {
    const run = await recordCells(descriptor, { strip: CLEAN_STRIP });
    // Every run reaches the end of its cell, so the frames below are all the
    // frames it takes, and a probe counted as taking none really takes none.
    assert.equal(
      run.error,
      null,
      `${descriptor.name}: the recorded run ended on ${run.error} before the end of its cell`,
    );
    const frames = run.events.filter((event) => event.kind === "frame");
    if (frames.length === 0) {
      noFrame.push(descriptor.name);
      continue;
    }
    const onViewer = viewerFrames(run.events);
    if (onViewer.length === 0) {
      elsewhere.push(descriptor.name);
      continue;
    }
    framesOnViewer[descriptor.name] = onViewer.length;
    for (const [n, frame] of onViewer.entries()) {
      assert.ok(
        frame.stripped,
        `${descriptor.name}: frame ${n + 1} of ${onViewer.length} on the CesiumViewer page is taken with no kit strip on that page load before it`,
      );
    }
  }
  assert.deepEqual(Object.keys(framesOnViewer).sort(), [
    ...CESIUM_VIEWER_CAPTURERS,
  ]);
  // Every capture of every probe that captures on the CesiumViewer page, so a
  // run that stopped early cannot pass on the frames it did take.
  assert.deepEqual(framesOnViewer, {
    "globe-bindgroup-cache": 2,
    "globe-clippoly-geodetic": 2,
    "globe-effects-handle-toggle": 4,
    "globe-polar-stretch": 6,
    "globe-translucency": 6,
    "globe-underground": 6,
  });
  // default-limits builds its own widget on the bare root page; pick-h44 reads
  // pick results, not frames.
  assert.deepEqual(elsewhere, ["globe-default-limits"]);
  assert.deepEqual(noFrame, ["globe-pick-h44"]);
});

test("every probe that captures on the CesiumViewer page refuses a strip that leaves anything over the canvas, and records what the strip removed", async () => {
  const tested = [];
  for (const { descriptor } of [
    bindGroupCache,
    clippoly,
    effectsToggle,
    polar,
    translucency,
    underground,
  ]) {
    for (const strip of [
      { removed: 5, leftovers: ["loadingIndicator"] },
      undefined,
    ]) {
      const refused = await recordCells(descriptor, { strip });
      assert.equal(
        refused.error?.reason,
        "capture-chrome-over-canvas",
        `${descriptor.name}: ${JSON.stringify(strip)} was not refused (${refused.error})`,
      );
      assert.equal(
        refused.events.some((event) => event.kind === "frame"),
        false,
        `${descriptor.name}: a frame was taken before the refusal`,
      );
    }
    const clean = await recordCells(descriptor, { strip: CLEAN_STRIP });
    assert.equal(clean.error, null, `${descriptor.name}: ${clean.error}`);
    assert.deepEqual(
      clean.cells[0].chromeRemoved,
      CHROME_REMOVED[descriptor.name],
      descriptor.name,
    );
    tested.push(descriptor.name);
  }
  assert.deepEqual(tested.sort(), [...CESIUM_VIEWER_CAPTURERS]);
});

test("polar-stretch counts its pixel mismatch inside CROP only, while its latitude profile reads outside CROP, which is why its frames are stripped too", () => {
  // The pass-4 review's construction (R1(b)): two 1280x720 frames lit alike
  // inside CROP. The second is white everywhere outside it, the first black.
  const width = 1280;
  const height = 720;
  const crop = { x0: 250, x1: 1010, y0: 45, y1: 640 };
  const frame = (inside, outside) => {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const within =
          x >= crop.x0 && x < crop.x1 && y >= crop.y0 && y < crop.y1;
        const rgb = within ? inside : outside;
        const i = (y * width + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
        data[i + 3] = 255;
      }
    }
    return { width, height, data };
  };
  const land = [120, 90, 60];
  const read = polar.analyzePolar(
    frame(land, [0, 0, 0]),
    frame(land, [255, 255, 255]),
  );
  // Nothing outside CROP enters the mismatch...
  assert.equal(read.mismatchPct, 0);
  // ...but the profile, a circle about the consensus disc, reads rows above
  // and below CROP and counts the white there as ice.
  assert.equal(read.icePxA, 0);
  assert.ok(read.icePxB > 0, `icePxB ${read.icePxB}`);
  // The control that differs inside CROP reads 100 %.
  assert.equal(
    polar.analyzePolar(
      frame(land, [0, 0, 0]),
      frame([255, 255, 255], [0, 0, 0]),
    ).mismatchPct,
    100,
  );
});
