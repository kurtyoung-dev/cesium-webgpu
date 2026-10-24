// ocean-fft-controls.spec.mjs — the FFT ocean's control surface and sleep law.
// @purpose Executes the FFT ocean's sleep predicate (height above the sea surface), wind direction setters, pipeline failure logging, quality-preset forwarding and Hermitian symmetry on the real modules.
// @status ACTIVE
//
// These tests fail if:
//   - the ocean sleeps on an ELLIPSOIDAL height again: under the AUTO/GEOID
//     datum the sea sits at the geoid undulation (about -104 m at the Indian
//     coast), so a camera 5 m above the water reads -99 m and would be put to
//     sleep (GL-02, behaviour C10);
//   - the renderer grows a second sleep predicate beside the primitive's;
//   - a wind heading handed to the ocean (or to the primitive directly) stops
//     reaching the spectrum, or stops marking it dirty (GL-04, C8);
//   - a rejected async pipeline creation stops logging exactly once, or is
//     retried every frame (GL-05, C5);
//   - a quality preset set before the primitive exists stops applying (GL-07,
//     C9), or a pressure change re-runs the spectrum;
//   - the initial spectrum stops being Hermitian, or the snapped anchor leaves
//     the ellipsoid (GL-08).
//
// Run: node --test Tools/visual-regression/ocean-fft-controls.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);
const readEngine = (p) =>
  fs.readFileSync(enginePath(p), "utf8").replace(/\r\n/g, "\n");
const importEngine = async (p) =>
  await import(pathToFileURL(enginePath(p)).href);

const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");
const { default: Ellipsoid } = await importEngine("Core/Ellipsoid.js");
const { default: JulianDate } = await importEngine("Core/JulianDate.js");
const { default: VerticalDatum } = await importEngine("Core/VerticalDatum.js");
const { default: GeoidUndulationGrid } = await importEngine(
  "Core/GeoidUndulationGrid.js",
);
const { default: OceanSurfacePrimitive } = await importEngine(
  "Scene/OceanSurfacePrimitive.js",
);
const { default: FeatureRendererKey } = await importEngine(
  "Renderer/FeatureRendererKey.js",
);

// ───────────────────── GL-02. one sleep predicate ─────────────────────────

const UNDULATION_M = -104.0;
const SITE = {
  lonRad: (80.0 * Math.PI) / 180.0,
  latRad: (7.0 * Math.PI) / 180.0,
};

/**
 * Run one primitive update with the camera at an ellipsoidal height and report
 * whether the feature renderer was asked to draw.
 *
 * @param {number} ellipsoidalHeightM The camera's height above the ellipsoid.
 * @returns {{drawn: boolean, primitive: object}} The outcome.
 */
function updateAt(ellipsoidalHeightM) {
  GeoidUndulationGrid.setEgm2008ForTesting({ sample: () => UNDULATION_M });
  const primitive = new OceanSurfacePrimitive({
    tideEnabled: false,
    verticalDatum: VerticalDatum.GEOID,
  });
  const draws = [];
  const frameState = {
    context: {
      isWebGPU: true,
      uniformState: {},
      getFeatureRenderer: (key) => {
        assert.equal(key, FeatureRendererKey.FFT_OCEAN);
        return {
          update: () => {
            draws.push(true);
          },
        };
      },
    },
    camera: {
      positionWC: Cartesian3.fromRadians(
        SITE.lonRad,
        SITE.latRad,
        ellipsoidalHeightM,
        Ellipsoid.WGS84,
      ),
    },
    time: JulianDate.fromIso8601("2026-01-01T00:00:00Z"),
  };
  // The first frame only establishes the anchor reference (it may rebase).
  primitive.update(frameState);
  draws.length = 0;
  primitive.update(frameState);
  return { drawn: draws.length > 0, primitive };
}

test("GL-02a a camera 5 m above a sea that sits at -104 m still draws", () => {
  const { drawn, primitive } = updateAt(UNDULATION_M + 5.0);
  assert.ok(
    Math.abs(primitive._anchorHeightM - UNDULATION_M) < 1e-9,
    "the sea surface must sit at the geoid undulation for this scenario",
  );
  assert.equal(
    drawn,
    true,
    "ellipsoidal height is -99 m but the camera is above the water",
  );
  assert.equal(primitive._fftComputeActive, true);
});

test("GL-02b a camera 90 m below that sea gets no draw", () => {
  const { drawn, primitive } = updateAt(UNDULATION_M - 90.0);
  assert.equal(drawn, false);
  assert.equal(primitive._fftComputeActive, false);
});

test("GL-02c the upper bound is 15 km above the sea, not the ellipsoid", () => {
  assert.equal(updateAt(UNDULATION_M + 14900.0).drawn, true);
  assert.equal(updateAt(UNDULATION_M + 15100.0).drawn, false);
});

test("GL-02d the renderer carries no second sleep predicate", () => {
  const renderer = readEngine("Renderer/WebGPU/WebGPUOceanRenderer.ts");
  assert.ok(
    !renderer.includes("positionCartographic"),
    "the ellipsoidal-height check must be gone from the renderer",
  );
  assert.ok(!/camHeight\s*[<>]/.test(renderer));
});

// ───────────────────── GL-03. no hard-coded vessel wake ─────────────────────

const { evaluate, parseExpression, stripComments, tokenize, vec2, vec4 } =
  await import("./lib/wgsl-mini-eval.mjs");

const oceanSurfaceWgsl = stripComments(
  readEngine("Shaders/WebGPU/Ocean/OceanSurface.wgsl"),
);

/**
 * The text of a WGSL function from its signature to the next top-level fn.
 *
 * @param {string} name The function name.
 * @returns {string} Its source.
 */
function wgslFunction(name) {
  const at = oceanSurfaceWgsl.indexOf(`fn ${name}(`);
  assert.ok(at >= 0, `fn ${name} must exist`);
  const next = oceanSurfaceWgsl.indexOf("\nfn ", at + 1);
  return oceanSurfaceWgsl.slice(at, next < 0 ? undefined : next);
}

/**
 * Evaluate the right-hand side of a `let NAME = ...;` binding in a function.
 *
 * @param {string} fn The function name.
 * @param {string} name The binding.
 * @param {object} env The local bindings.
 * @returns {number} The value.
 */
function evalBinding(fn, name, env) {
  const m = new RegExp(`let ${name} =\s*([^;]*);`).exec(wgslFunction(fn));
  assert.ok(m !== null, `${fn} must bind ${name}`);
  return evaluate(parseExpression(tokenize(m[1]), 0).node, env);
}

test("GL-03a the vertex height is the FFT height and the curvature drop, with no wake term", () => {
  for (const [dispY, amp, drop] of [
    [1.7, 0.8, -0.002],
    [-0.4, 1.0, -3.5],
    [0.0, 0.25, 0.0],
  ]) {
    // A wake value is offered in the environment; the law must ignore it.
    const up = evalBinding("vertexMain", "up", {
      disp: vec4(0.3, dispY, -0.2, 0.1),
      amp,
      drop,
      kelvinWake: vec2(9.0, 9.0),
    });
    assert.ok(
      Math.abs(up - (dispY * amp + drop)) < 1e-12,
      `vertex up ${up} must equal disp.y * amp + drop`,
    );
  }
});

test("GL-03b neither stage calls the wake, so nothing is drawn at a fixed offset", () => {
  const calls = oceanSurfaceWgsl.match(/computeKelvinVesselWake\(/g) ?? [];
  assert.equal(
    calls.length,
    1,
    "the only mention is the definition; no stage calls it",
  );
  for (const token of ["kelvinWake", "kelvinWakeFrag", "wakeCrestBoost"]) {
    assert.ok(!oceanSurfaceWgsl.includes(token), `${token} must be gone`);
  }
  assert.ok(
    !/step\(400\.0/.test(oceanSurfaceWgsl),
    "the fragment position hack must be gone",
  );
});

test("GL-03c the fragment foam is the Jacobian channel only", () => {
  const foam = evalBinding("fragmentMain", "foam", {
    dispCenter: vec4(0, 0, 0, 0.5),
    ocean: { foamStrength: 0.8 },
    cascadeFoamLace: 1.0,
    input: { fade: 1.0 },
    altitudeHandover: 1.0,
    kelvinWakeFrag: vec2(1.0, 1.0),
  });
  assert.ok(Math.abs(foam - 0.4) < 1e-12, `foam ${foam}`);
});

// ──────────── GL-04. wind heading reaches the spectrum (C8) ────────────

const { default: GlobeWaterOcean } = await importEngine(
  "Scene/GlobeWaterOcean.js",
);

/**
 * A facade over a recording scene, with the datum pinned to the ellipsoid so
 * enabling it starts no geoid fetch.
 *
 * @returns {{ocean: object, added: object[]}} The facade and what it added.
 */
function makeOcean() {
  const added = [];
  const scene = {
    primitives: {
      add: (p) => added.push(p),
      remove: () => {},
    },
    globe: {},
  };
  const ocean = new GlobeWaterOcean(scene);
  ocean.verticalDatum = VerticalDatum.ELLIPSOID;
  return { ocean, added };
}

test("GL-04a a wind heading handed to the facade reaches the primitive's spectrum and dirties it", () => {
  const { ocean } = makeOcean();
  ocean.enabled = true;
  const prim = ocean.primitive;
  prim._paramsDirty = false;
  ocean.applyEnvironmentalTensor({
    windSpeed: 18.0,
    windHeadingRad: Math.PI / 2,
  });
  assert.ok(Math.abs(prim._windDirX) < 1e-6, `dirX ${prim._windDirX}`);
  assert.ok(Math.abs(prim._windDirZ - 1.0) < 1e-6, `dirZ ${prim._windDirZ}`);
  assert.equal(prim._windSpeed, 18.0);
  assert.equal(prim._paramsDirty, true);
  assert.ok(Math.abs(ocean.windDirection - Math.PI / 2) < 1e-12);
});

test("GL-04b the same call made on the primitive directly changes the wind", () => {
  const prim = new OceanSurfacePrimitive();
  prim._paramsDirty = false;
  prim.applyEnvironmentalTensor({ windSpeed: 7.0, windHeadingRad: Math.PI });
  assert.equal(prim._windSpeed, 7.0, "speed must reach the spectrum field");
  assert.ok(Math.abs(prim._windDirX + 1.0) < 1e-6);
  assert.ok(Math.abs(prim._windDirZ) < 1e-6);
  assert.equal(prim._paramsDirty, true);
  assert.ok(Math.abs(prim.windDirection - Math.PI) < 1e-9);
});

test("GL-04e a live heading or speed set on the facade reaches and dirties the primitive", () => {
  const { ocean } = makeOcean();
  ocean.enabled = true;
  const prim = ocean.primitive;
  prim._paramsDirty = false;
  ocean.windDirection = Math.PI;
  assert.ok(Math.abs(prim._windDirX + 1.0) < 1e-6);
  assert.equal(prim._paramsDirty, true);
});

test("GL-04f the primitive's own accessors dirty the spectrum", () => {
  const prim = new OceanSurfacePrimitive();
  prim._paramsDirty = false;
  prim.windDirection = 0.5;
  assert.equal(prim._paramsDirty, true, "heading must dirty on its own");
  prim._paramsDirty = false;
  prim.windSpeed = 9.0;
  assert.equal(prim._paramsDirty, true, "speed must dirty on its own");
  assert.equal(prim._windSpeed, 9.0);
});

test("GL-04c a heading set before the primitive exists is applied on enable", () => {
  const { ocean } = makeOcean();
  ocean.windDirection = Math.PI / 2;
  ocean.enabled = true;
  assert.ok(Math.abs(ocean.primitive._windDirZ - 1.0) < 1e-6);
});

test("GL-04d a non-finite heading is ignored, not stored", () => {
  const prim = new OceanSurfacePrimitive();
  prim.windDirection = Number.NaN;
  assert.equal(prim._windDirX, 1.0);
  assert.equal(prim._windDirZ, 0.0);
});

// ──────── GL-07. presets and bathymetry survive the primitive's birth (C9) ────────

test("GL-07a detail and foam set before enable equal those set after", () => {
  const before = makeOcean();
  before.ocean.detailScale = 1.5;
  before.ocean.foamStrength = 0.7;
  before.ocean.enabled = true;

  const after = makeOcean();
  after.ocean.enabled = true;
  after.ocean.detailScale = 1.5;
  after.ocean.foamStrength = 0.7;

  for (const key of ["_detailScale", "_foamStrength"]) {
    assert.equal(before.ocean.primitive[key], after.ocean.primitive[key]);
  }
  assert.equal(before.ocean.primitive._detailScale, 1.5);
  assert.equal(before.ocean.primitive._foamStrength, 0.7);
});

test("GL-07b an untouched facade creates the primitive's own defaults", () => {
  const { ocean } = makeOcean();
  ocean.enabled = true;
  const fresh = new OceanSurfacePrimitive();
  assert.equal(ocean.primitive._detailScale, fresh._detailScale);
  assert.equal(ocean.primitive._foamStrength, fresh._foamStrength);
});

test("GL-07c cached bathymetry depth and Jerlov type are forwarded on enable", () => {
  const { ocean } = makeOcean();
  ocean.applyBathymetryTensor({ depthMeters: 42.0, jerlovType: 3 });
  ocean.enabled = true;
  assert.equal(ocean.primitive._bathymetryDepthM, 42.0);
  assert.equal(ocean.primitive._bathymetryJerlovType, 3);
  assert.equal(ocean.bathymetryDepthMeters, 42.0);
  assert.equal(ocean.bathymetryJerlovType, 3);
});

test("GL-07d with no bathymetry applied, nothing is forwarded", () => {
  const { ocean } = makeOcean();
  ocean.enabled = true;
  assert.equal(ocean.primitive._bathymetryDepthM, undefined);
  assert.equal(ocean.primitive._bathymetryJerlovType, undefined);
});

test("GL-07e a pressure change moves the surge but does not regenerate the spectrum", () => {
  const { ocean } = makeOcean();
  ocean.enabled = true;
  const prim = ocean.primitive;
  prim._paramsDirty = false;
  ocean.meanSeaLevelPressure = 990.0;
  assert.equal(prim._meanSeaLevelPressure, 990.0);
  assert.ok(Math.abs(ocean.stormSurgeMeters - 0.2325) < 1e-9);
  assert.equal(prim._paramsDirty, false);
});

// ───────── GL-05. a rejected pipeline logs once and stays failed (C5) ─────────
//
// The renderer is TypeScript with transitive imports Node cannot strip, so the
// functions that own the pipeline lifecycle are lifted out of the shipped
// source, stripped of types and run against a device whose creations reject.

const rendererTs = readEngine("Renderer/WebGPU/WebGPUOceanRenderer.ts");

/**
 * The full text of a top-level function declaration.
 *
 * @param {string} src The file text.
 * @param {string} name The function name.
 * @returns {string} Its source.
 */
function extractTsFunction(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name} must exist`);
  let i = src.indexOf("(", at);
  for (let depth = 0; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  let j = src.indexOf("{", i);
  for (let depth = 0; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(at, j + 1);
}

const { stripTypeScriptTypes } = await import("node:module");

/**
 * Compile the lifecycle functions from a renderer source text.
 *
 * @param {string} src The (possibly mutated) renderer text.
 * @param {object} fakeConsole The console the functions log to.
 * @returns {{requestComputePipelines: Function, tryResolveRenderPipeline: Function}} The callables.
 */
function compileLifecycle(src, fakeConsole) {
  const code = [
    "reportOceanPipelineFailure",
    "requestComputePipelines",
    "tryResolveRenderPipeline",
  ]
    .map((n) => extractTsFunction(src, n))
    .join("\n");
  const js = stripTypeScriptTypes(code);
  return vm.compileFunction(
    `${js}\nreturn { requestComputePipelines, tryResolveRenderPipeline };`,
    ["console"],
  )(fakeConsole);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeLog() {
  const calls = [];
  return { calls, console: { error: (...a) => calls.push(a.join(" ")) } };
}

function freshCache() {
  return {
    pipelineGeneration: 1,
    paramsDirty: false,
    renderPipeline: null,
    renderPipelineDescriptor: { name: "Ocean pipeline [test]" },
    renderPipelineRequestPending: false,
  };
}

test("GL-05a a rejected compute creation logs one error naming the context and stays failed", async () => {
  const log = makeLog();
  const { requestComputePipelines } = compileLifecycle(rendererTs, log.console);
  let created = 0;
  const device = {
    createComputePipelineAsync: () => {
      created += 1;
      return Promise.reject(new Error("module invalid"));
    },
  };
  const cache = freshCache();
  requestComputePipelines(device, [{}, {}, {}, {}, {}, {}], cache, {
    id: "ctx-a3f7",
  });
  await flush();
  assert.equal(log.calls.length, 1, "exactly one error for six rejections");
  assert.match(log.calls[0], /ctx-a3f7/);
  assert.match(log.calls[0], /Ocean compute/);
  assert.match(log.calls[0], /module invalid/);
  assert.equal(cache.computePipelinesFailed, true);
  assert.notEqual(cache.computePipelinesReady, true);
  assert.equal(created, 6, "one request per pipeline, never repeated");
});

test("GL-05b a rejected render creation logs once and is never re-requested", async () => {
  const log = makeLog();
  const { tryResolveRenderPipeline } = compileLifecycle(
    rendererTs,
    log.console,
  );
  let requests = 0;
  const pipelineCache = {
    getPipelineSync: () => null,
    getPipeline: () => {
      requests += 1;
      return Promise.reject(new Error("fragment output mismatch"));
    },
  };
  const cache = freshCache();
  const context = { id: "ctx-a3f7" };
  for (let frame = 0; frame < 60; frame += 1) {
    assert.equal(
      tryResolveRenderPipeline({}, pipelineCache, cache, context),
      false,
    );
    await flush();
  }
  assert.equal(requests, 1, "a failed pipeline must not be retried per frame");
  assert.equal(log.calls.length, 1);
  assert.match(log.calls[0], /ctx-a3f7/);
  assert.match(log.calls[0], /Ocean pipeline \[test\]/);
  assert.equal(cache.renderPipelineFailed, true);
});

test("GL-05c the same holds on the device's own async path", async () => {
  const log = makeLog();
  const { tryResolveRenderPipeline } = compileLifecycle(
    rendererTs,
    log.console,
  );
  let requests = 0;
  const device = {
    createRenderPipelineAsync: () => {
      requests += 1;
      return Promise.reject(new Error("bad"));
    },
  };
  const cache = freshCache();
  for (let frame = 0; frame < 10; frame += 1) {
    tryResolveRenderPipeline(device, null, cache, { id: "ctx-b" });
    await flush();
  }
  assert.equal(requests, 1);
  assert.equal(log.calls.length, 1);
});

test("GL-05d a resolution from a superseded generation is ignored", async () => {
  const log = makeLog();
  const { tryResolveRenderPipeline } = compileLifecycle(
    rendererTs,
    log.console,
  );
  const pending = [];
  const pipelineCache = {
    getPipelineSync: () => null,
    getPipeline: () =>
      new Promise((res, rej) => {
        pending.push({ res, rej });
      }),
  };
  const cache = freshCache();
  tryResolveRenderPipeline({}, pipelineCache, cache, { id: "c" });
  assert.equal(cache.renderPipelineRequestPending, true);
  // A re-initialisation supersedes the request and clears the pending flag.
  cache.pipelineGeneration += 1;
  cache.renderPipelineRequestPending = false;
  cache.renderPipelineDescriptor = { name: "second" };
  tryResolveRenderPipeline({}, pipelineCache, cache, { id: "c" });
  assert.equal(pending.length, 2);
  // The stale result lands first.
  pending[0].res({ stale: true });
  await flush();
  assert.equal(cache.renderPipeline, null, "stale result must not be adopted");
  assert.equal(
    cache.renderPipelineRequestPending,
    true,
    "stale result must not clear the live request's pending flag",
  );
  pending[1].res({ fresh: true });
  await flush();
  assert.deepEqual(cache.renderPipeline, { fresh: true });
  assert.equal(log.calls.length, 0);
});

test("GL-05e a stale rejection logs nothing and does not mark the new generation failed", async () => {
  const log = makeLog();
  const { tryResolveRenderPipeline } = compileLifecycle(
    rendererTs,
    log.console,
  );
  let rej;
  const pipelineCache = {
    getPipelineSync: () => null,
    getPipeline: () =>
      new Promise((_res, r) => {
        rej = r;
      }),
  };
  const cache = freshCache();
  tryResolveRenderPipeline({}, pipelineCache, cache, { id: "c" });
  cache.pipelineGeneration += 1;
  rej(new Error("old descriptor"));
  await flush();
  assert.equal(log.calls.length, 0);
  assert.notEqual(cache.renderPipelineFailed, true);
});

test("GL-05f successful compute creation arms the spectrum and logs nothing", async () => {
  const log = makeLog();
  const { requestComputePipelines } = compileLifecycle(rendererTs, log.console);
  const device = {
    createComputePipelineAsync: (d) => Promise.resolve({ d }),
  };
  const cache = freshCache();
  requestComputePipelines(device, [1, 2, 3, 4, 5, 6], cache, { id: "x" });
  await flush();
  assert.equal(cache.computePipelinesReady, true);
  assert.equal(cache.paramsDirty, true);
  assert.deepEqual(cache.mergePipeline, { d: 6 });
  assert.equal(log.calls.length, 0);
});

test("GL-05g the per-frame path stops on a terminal failure, and the dead flag is gone", () => {
  assert.ok(!rendererTs.includes("computePipelinesPending"));
  const update = extractTsFunction(rendererTs, "updateWebGPUOcean");
  const guardRe =
    /if \(cache\.computePipelinesFailed \|\| cache\.renderPipelineFailed\) \{\s*(?:\/\/[^\n]*\n\s*)*return;\s*\}/;
  const guard = update.search(guardRe);
  const resolve = update.indexOf("tryResolveRenderPipeline(");
  assert.ok(guard > 0 && guard < resolve, "the guard must precede the request");
});

// ───────── GL-08. the initial spectrum is Hermitian; the anchor is on the sea ─────────
//
// The compute shader cannot run in Node, so the three decisions that make the
// spectrum Hermitian are read out of the shipped OceanInitialSpectrum.wgsl and
// executed: which texel the partner gaussian is read from (the formula for the
// mirrored coordinate is evaluated from the source text), which half of that
// texel is read, and which texels are left empty. A reverted shader therefore
// changes the NUMBER this test measures, not just a string it greps for.

const initialSpectrumWgsl = stripComments(
  readEngine("Shaders/WebGPU/Ocean/OceanInitialSpectrum.wgsl"),
);

/**
 * Read the pairing decisions out of the shader text.
 *
 * @param {string} src The (possibly mutated) stripped shader text.
 * @returns {{mirror: Function|null, partnerSwizzle: string, partnerFromMirror: boolean, isEmpty: Function}} The decisions.
 */
function readPairingDecisions(src) {
  const m =
    /let mirrorCoord = vec2<i32>\(i32\(([^;]*?)\), i32\(([^;]*?)\)\);/.exec(
      src,
    );
  const compile = (expr) =>
    vm.compileFunction(`return (${expr.replace(/(\d+)u\b/g, "$1")});`, [
      "N",
      "id",
    ]);
  const mirror =
    m === null
      ? null
      : {
          x: compile(m[1]),
          y: compile(m[2]),
        };
  const hm =
    /let hm = invSqrt2 \* (\w+)\.(xy|zw) \* sqrt\(phillips\(-k\)\);/.exec(src);
  assert.ok(hm !== null, "the partner term must be findable");
  const partnerVar = hm[1];
  const binding = new RegExp(
    `let ${partnerVar} = textureLoad\\(Noise, ([^,]+), 0\\);`,
  ).exec(src);
  assert.ok(binding !== null, "the partner noise must be a Noise load");
  const partnerFromMirror = binding[1].trim() === "mirrorCoord";
  const empty =
    /if \(([^)]*)\) \{\s*textureStore\(H0, vec2<i32>\(id\.xy\), vec4<f32>\(0\.0, 0\.0, 0\.0, 0\.0\)\);\s*return;\s*\}/.exec(
      src,
    );
  const isEmpty =
    empty === null
      ? () => false
      : vm.compileFunction(`return (${empty[1].replace(/(\d+)u\b/g, "$1")});`, [
          "id",
        ]);
  return {
    mirror,
    partnerSwizzle: hm[2],
    partnerFromMirror,
    isEmpty,
  };
}

/** Phillips spectrum with the shader's constants, deep water. */
function phillips(kx, kz, p) {
  const kLen = Math.hypot(kx, kz);
  if (kLen < 1e-6) return 0.0;
  const kLen2 = kLen * kLen;
  const L = (p.windSpeed * p.windSpeed) / p.gravity;
  const wLen = Math.hypot(p.windX, p.windZ);
  const dir = (kx / kLen) * (p.windX / wLen) + (kz / kLen) * (p.windZ / wLen);
  let dirFactor = dir * dir;
  if (dir < 0.0) dirFactor *= p.dirDamp;
  let v =
    ((p.amplitude * Math.exp(-1.0 / (kLen2 * L * L))) / (kLen2 * kLen2)) *
    dirFactor;
  v *= Math.exp(-kLen2 * p.smallWave * p.smallWave);
  return v;
}

/**
 * The worst imaginary part, relative to the real part, of the inverse
 * transform of the time-evolved spectrum.
 *
 * @param {object} decisions What the shader does (or, for a control, what the
 *   pre-fix shader did).
 * @returns {number} max |imag| / max |real|.
 */
function hermitianResidual(decisions) {
  const N = 32;
  const half = N / 2;
  const p = {
    windSpeed: 12.0,
    gravity: 9.81,
    windX: 1.0,
    windZ: 0.0,
    amplitude: 4.0,
    smallWave: 1.0,
    dirDamp: 0.15,
    patchLength: 250.0,
  };
  const dk = (2.0 * Math.PI) / p.patchLength;
  let seed = 0x1234abcd;
  const rand = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0xffffffff;
  };
  const gauss = () => {
    let u = rand();
    const v = rand();
    if (u < 1e-7) u = 1e-7;
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  };
  const noise = new Float64Array(N * N * 4);
  for (let i = 0; i < noise.length; i += 1) noise[i] = gauss();
  const at = (x, y) => (y * N + x) * 4;
  const c = 0.70710678118;
  const t = 3.7;
  const field = []; // [mx, mz, re, im]
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      if (decisions.isEmpty({ x, y })) continue;
      const mx = x - half;
      const mz = y - half;
      const kx = mx * dk;
      const kz = mz * dk;
      const own = at(x, y);
      const h0 = [
        c * noise[own] * Math.sqrt(phillips(kx, kz, p)),
        c * noise[own + 1] * Math.sqrt(phillips(kx, kz, p)),
      ];
      let src = own;
      if (decisions.partnerFromMirror && decisions.mirror !== null) {
        src = at(
          decisions.mirror.x(N, { x, y }),
          decisions.mirror.y(N, { x, y }),
        );
      }
      const o = decisions.partnerSwizzle === "xy" ? 0 : 2;
      const amp = c * Math.sqrt(phillips(-kx, -kz, p));
      const hmc = [noise[src + o] * amp, -(noise[src + o + 1] * amp)];
      const w = Math.sqrt(p.gravity * Math.hypot(kx, kz));
      const ph = w * t;
      const ep = [Math.cos(ph), Math.sin(ph)];
      const em = [Math.cos(ph), -Math.sin(ph)];
      const cm = (a, b) => [
        a[0] * b[0] - a[1] * b[1],
        a[0] * b[1] + a[1] * b[0],
      ];
      const a1 = cm(h0, ep);
      const a2 = cm(hmc, em);
      field.push([mx, mz, a1[0] + a2[0], a1[1] + a2[1]]);
    }
  }
  const cos = new Float64Array(N);
  const sin = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    cos[i] = Math.cos((2.0 * Math.PI * i) / N);
    sin[i] = Math.sin((2.0 * Math.PI * i) / N);
  }
  const wrap = (v) => ((v % N) + N) % N;
  let maxRe = 0.0;
  let maxIm = 0.0;
  for (let b = 0; b < N; b += 1) {
    for (let a = 0; a < N; a += 1) {
      let re = 0.0;
      let im = 0.0;
      for (const [mx, mz, hr, hi] of field) {
        const idx = wrap(mx * a + mz * b);
        re += hr * cos[idx] - hi * sin[idx];
        im += hr * sin[idx] + hi * cos[idx];
      }
      maxRe = Math.max(maxRe, Math.abs(re));
      maxIm = Math.max(maxIm, Math.abs(im));
    }
  }
  return maxIm / maxRe;
}

test("GL-08a the shipped pairing decisions give a real height field (N = 32)", () => {
  const decisions = readPairingDecisions(initialSpectrumWgsl);
  assert.ok(decisions.mirror !== null, "the mirrored coordinate must exist");
  const residual = hermitianResidual(decisions);
  assert.ok(residual < 1e-3, `imag/real = ${residual}`);
});

test("GL-08b the measure is sensitive: the earlier pairings are not Hermitian", () => {
  const shipped = readPairingDecisions(initialSpectrumWgsl);
  // The very first shader read the second gaussian pair of the same texel.
  const original = {
    ...shipped,
    partnerSwizzle: "zw",
    partnerFromMirror: false,
    isEmpty: () => false,
  };
  assert.ok(hermitianResidual(original) > 0.1);
  // The intermediate fix mirrored the partner but still paired the unpaired
  // row and column with themselves.
  const intermediate = { ...shipped, isEmpty: () => false };
  const r = hermitianResidual(intermediate);
  assert.ok(
    r > 1e-3,
    `unpaired row/column residual ${r} must exceed the bound`,
  );
});

test("GL-08c the mirror formula maps every paired texel to its negative frequency", () => {
  const { mirror } = readPairingDecisions(initialSpectrumWgsl);
  const N = 32;
  for (let x = 1; x < N; x += 1) {
    const mx = x - N / 2;
    const mirrored = mirror.x(N, { x, y: 1 }) - N / 2;
    assert.equal(mirrored + mx, 0, `texel ${x}`);
  }
});

test("GL-08d the unpaired k = -N/2 row and column are left empty, and nothing else is", () => {
  const { isEmpty } = readPairingDecisions(initialSpectrumWgsl);
  const N = 32;
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      assert.equal(isEmpty({ x, y }), x === 0 || y === 0, `(${x}, ${y})`);
    }
  }
});

test("GL-08e OceanIFFT carries no shared array or barrier, and FlowFieldRender keeps its single-term position", () => {
  const ifft = readEngine("Shaders/WebGPU/Ocean/OceanIFFT.wgsl");
  assert.ok(!ifft.includes("var<workgroup>"));
  assert.ok(!ifft.includes("workgroupBarrier"));
  assert.ok(!ifft.includes("local_invocation_index"));
  const flow = readEngine("Shaders/WebGPU/FlowFieldRender.wgsl");
  assert.ok(flow.includes("fn lonLatToEcef("));
  assert.ok(!flow.includes("lonLatToEcefHighLow"));
  assert.ok(!flow.includes("struct EcefHighLow"));
});

test("GL-08f the snapped anchor lies on the ellipsoid at every offset up to the rebase distance", () => {
  const ellipsoid = Ellipsoid.WGS84;
  const worstHeight = (offsetM) => {
    const primitive = new OceanSurfacePrimitive({
      tideEnabled: false,
      verticalDatum: VerticalDatum.ELLIPSOID,
    });
    const origin = Cartesian3.fromRadians(SITE.lonRad, SITE.latRad, 0.0);
    const frameAt = (position) => ({
      context: {
        isWebGPU: true,
        uniformState: {},
        getFeatureRenderer: () => undefined,
      },
      camera: { positionWC: position },
      time: JulianDate.fromIso8601("2026-01-01T00:00:00Z"),
    });
    primitive.update(frameAt(origin)); // establishes A0
    primitive.update(frameAt(origin));
    const east = Cartesian3.clone(primitive._a0East);
    const moved = Cartesian3.add(
      origin,
      Cartesian3.multiplyByScalar(east, offsetM, new Cartesian3()),
      new Cartesian3(),
    );
    primitive.update(frameAt(moved));
    const carto = ellipsoid.cartesianToCartographic(primitive._anchor);
    return Math.abs(carto.height);
  };
  for (const offset of [0.0, 6000.0, 11000.0]) {
    const h = worstHeight(offset);
    assert.ok(h < 1e-3, `anchor ${h} m off the ellipsoid at ${offset} m`);
  }
});
