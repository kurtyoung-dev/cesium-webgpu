// context-3d-texture-limit.spec.mjs — the WebGL context's 3D-texture limit,
// asserted for the three kinds of `gl` object the engine is handed. Pure Node:
// no browser, no build, no GPU.
//
//   node --test Tools/visual-regression/context-3d-texture-limit.spec.mjs
//
// @purpose Pins that Context reports the 3D-texture limit its gl object supplies - the driver value on WebGL2, the stub's value under the spec WebGL stub, and 0 on WebGL1 - and that the sibling array-texture-layer limit keeps its webgl2 gate.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// `packages/engine/Source/Renderer/Context.js` builds one `capabilityOptions`
// literal and hands it to `GraphicsCapabilities.create`. The 3D-texture entry
// was gated on `webgl2`, which is computed as
// `glContext instanceof WebGL2RenderingContext`. `Specs/getWebGLStub.js` builds
// its fake context as `clone(WebGLConstants)` — a plain object — so that test is
// false for every stubbed spec context in every browser, and the limit was
// forced to 0 even though the stub answers 2048 for `MAX_3D_TEXTURE_SIZE`.
// Downstream, `Megatexture.get3DTextureDimension` throws
// "The GL context does not support a 3D texture large enough …" for any tile,
// which escaped an `afterAll` and aborted both browser suites.
//
// Upstream reads the parameter unconditionally at the same anchor
// (`ContextLimits._maximum3DTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);`).
// The fork's own capability factory is what makes that form safe on WebGL1:
// a WebGL1 context has no `MAX_3D_TEXTURE_SIZE` enum, `getParameter` of an
// invalid enum returns `null`, and `GraphicsCapabilities.create` coalesces with
// `options[name] ?? limitDefaults[name]`, whose default is 0. So the
// unconditional read needs no gate and no test-only branch.
//
// ── THE TRAP THIS ALSO PINS ─────────────────────────────────────────────────
//
// The sibling `maximumArrayTextureLayers` must KEEP its `webgl2` gate.
// `Specs/getWebGLStub.js` has no `parameterStubValues` entry for
// `MAX_ARRAY_TEXTURE_LAYERS`, but `Core/WebGLConstants.js` DOES define the enum
// and the stub is a clone of it — so "the constant is present" is true while
// "a value is supplied" is false. An ungated read of that parameter throws out
// of the stub in a debug build and yields `undefined` in a release build. Group
// C runs the REAL stub source both ways and shows both outcomes, so anyone who
// "extends the same pattern" to that line fails here rather than in CI.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// Nothing here greps source for a shape. Real source regions are SLICED out of
// the tree and compiled with `vm.compileFunction`, then driven with real engine
// modules:
//
//   * `Context.js`'s `capabilityOptions` literal — evaluated against three `gl`
//     doubles and fed through the REAL `GraphicsCapabilities.create`.
//   * `Context.js`'s `GraphicsCapabilities.create(capabilityOptions)` statement
//     — the assignment that turns the literal into the record `context.limits`
//     exposes, so the path from the literal to the record is under test too and
//     not only the literal.
//   * `Specs/getWebGLStub.js`'s `getParameterStub` — the REAL stub parameter
//     table, so the 2048 asserted below is the stub's own number, not a typed
//     constant. Compiled twice: as authored (debug) and with the debug pragma
//     block removed (release), which is what the two CI jobs each run.
//   * `Megatexture.js`'s `get3DTextureDimension` (+ its `getVolume` helper) —
//     driven with `MegatextureSpec`'s own "constructs" inputs, so the throw this
//     spec observes is the exact `RuntimeError` message the aborted CI run
//     printed — and the constructor's CALL to it, which is where the limit is
//     read off a context.
//   * `GlobeSurfaceTileProviderRendering.js`'s `addDrawCommandsForTile`
//     prologue, driven with the mock context sliced out of the REAL
//     `QuadtreePrimitiveSpec.js` — group F, which is about the spec mocks, not
//     about the limit.
//
// `Context.js` and `Megatexture.js` cannot simply be imported in Node: the first
// needs generated shader modules that only exist after a build, and the second
// pulls in a `.ts` module with a TypeScript enum, which Node's strip-only loader
// rejects. Slicing + `compileFunction` is how the real code path is reached
// without a build.
//
// ── WHAT THIS SPEC DOES NOT COVER ───────────────────────────────────────────
//
// It never constructs a `Context`, and it cannot: that needs a built tree and a
// browser. What is pinned here is the capability literal, the statement that
// records it, and the two consumers that read the limit back off a context.
// The end-to-end assertion over a constructed, stubbed `Context` is
// `packages/engine/Specs/Renderer/ContextSpec.js:76`
// (`expect(context.limits.maximum3DTextureSize).toBeGreaterThanOrEqual(256)`),
// and it runs on the karma leg — which is where `Scene/Megatexture`,
// `Scene/VoxelCell`, `Scene/QuadtreePrimitive` and `Scene/TerrainFillMesh` are
// judged as well. Group F proves the mock contexts answer every property the
// engine reads off them; it does not prove those suites pass.
//
// MUTATION: restoring `maximum3DTextureSize: webgl2 ? gl.getParameter(…) : 0`,
// or making the read inert with `false ? gl.getParameter(…) : 0`, turns
// B2/B4/D2 red (2048 → 0, and the Megatexture leg throws). Overriding the
// record with `maximum3DTextureSize: 0` at the `GraphicsCapabilities.create`
// call reds G1; replacing the constructor's `context.limits.maximum3DTextureSize`
// argument with `0` reds G2; removing `limits` from `QuadtreePrimitiveSpec`'s
// mock context reds F1/F4. Every mutant is applied to a temp COPY reached
// through the `CESIUM_L6_*` overrides below, so the OUTPUT changes rather than
// code disappearing. The observed red runs are in the landing packet.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const ENGINE_SOURCE = path.join(REPO_ROOT, "packages/engine/Source");
const ENGINE_SPECS = path.join(REPO_ROOT, "packages/engine/Specs");

// Every sliced file is overridable, so an inertness mutant points this spec at
// a mutated COPY instead of editing the tree.
const sourcePath = (environmentVariable, defaultPath) =>
  process.env[environmentVariable] ?? defaultPath;

const CONTEXT_JS = sourcePath(
  "CESIUM_L6_CONTEXT_JS",
  path.join(ENGINE_SOURCE, "Renderer/Context.js"),
);
const GET_WEBGL_STUB_JS = sourcePath(
  "CESIUM_L6_GET_WEBGL_STUB_JS",
  path.join(REPO_ROOT, "Specs/getWebGLStub.js"),
);
const MEGATEXTURE_JS = sourcePath(
  "CESIUM_L6_MEGATEXTURE_JS",
  path.join(ENGINE_SOURCE, "Scene/Megatexture.js"),
);
const GLOBE_SURFACE_RENDERING_JS = sourcePath(
  "CESIUM_L6_GLOBE_RENDERING_JS",
  path.join(ENGINE_SOURCE, "Scene/GlobeSurfaceTileProviderRendering.js"),
);
const TERRAIN_FILL_MESH_JS = sourcePath(
  "CESIUM_L6_TERRAIN_FILL_MESH_JS",
  path.join(ENGINE_SOURCE, "Scene/TerrainFillMesh.js"),
);
const QUADTREE_PRIMITIVE_SPEC_JS = sourcePath(
  "CESIUM_L6_QUADTREE_SPEC_JS",
  path.join(ENGINE_SPECS, "Scene/QuadtreePrimitiveSpec.js"),
);
const TERRAIN_FILL_MESH_SPEC_JS = sourcePath(
  "CESIUM_L6_TERRAIN_FILL_MESH_SPEC_JS",
  path.join(ENGINE_SPECS, "Scene/TerrainFillMeshSpec.js"),
);

const importEngine = (relativePath) =>
  import(pathToFileURL(path.join(ENGINE_SOURCE, relativePath)).href);

const { default: GraphicsCapabilities } = await importEngine(
  "Renderer/GraphicsCapabilities.js",
);
const { default: WebGLConstants } = await importEngine(
  "Core/WebGLConstants.js",
);
const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");
const { default: RuntimeError } = await importEngine("Core/RuntimeError.js");
const { default: DeveloperError } = await importEngine(
  "Core/DeveloperError.js",
);
const { default: defined } = await importEngine("Core/defined.js");
const { default: clone } = await importEngine("Core/clone.js");
const { default: FeatureRendererKey } = await importEngine(
  "Renderer/FeatureRendererKey.js",
);

/**
 * Slices the source region that starts at `startAnchor` and ends immediately
 * before `endAnchor`. Both anchors must occur exactly once, so a rename or a
 * move fails loudly here instead of silently testing the wrong region.
 */
function sliceRegion(source, startAnchor, endAnchor, label) {
  const start = source.indexOf(startAnchor);
  assert.notEqual(start, -1, `${label}: start anchor not found`);
  assert.equal(
    source.indexOf(startAnchor, start + 1),
    -1,
    `${label}: start anchor is not unique`,
  );
  const end = source.indexOf(endAnchor, start);
  assert.notEqual(end, -1, `${label}: end anchor not found`);
  return source.slice(start, end);
}

/** Strips every debug-pragma block, the way a release build does. */
function stripDebugPragmas(source) {
  const startTag = "//>>includeStart('debug'";
  const endTag = "//>>includeEnd('debug');";
  let out = source;
  for (;;) {
    const start = out.indexOf(startTag);
    if (start === -1) {
      return out;
    }
    const end = out.indexOf(endTag, start);
    assert.notEqual(end, -1, "unbalanced debug pragma in sliced source");
    out = out.slice(0, start) + out.slice(end + endTag.length);
  }
}

/** Compiles the real `capabilityOptions` literal out of Context.js. */
function loadCapabilityOptionsFactory() {
  const source = readFileSync(CONTEXT_JS, "utf8");
  const literal = sliceRegion(
    source,
    "const capabilityOptions = {",
    "\n    };",
    "Context.js capabilityOptions",
  );
  return vm.compileFunction(
    `${literal}\n};\nreturn capabilityOptions;`,
    ["gl", "webgl2", "defined", "getWebGLStub"],
    { filename: "Context.js#capabilityOptions" },
  );
}

/** Compiles the real `getParameterStub` out of Specs/getWebGLStub.js. */
function loadStubGetParameter({ release }) {
  let source = readFileSync(GET_WEBGL_STUB_JS, "utf8");
  source = sliceRegion(
    source,
    "function getParameterStub(options) {",
    "\nfunction getProgramParameterStub",
    "getWebGLStub.js getParameterStub",
  );
  if (release) {
    source = stripDebugPragmas(source);
  }
  const factory = vm.compileFunction(
    `${source}\nreturn getParameterStub;`,
    ["WebGLConstants", "defined", "DeveloperError"],
    { filename: "getWebGLStub.js#getParameterStub" },
  );
  return factory(WebGLConstants, defined, DeveloperError)({ stencil: true });
}

/** Compiles the real `Megatexture.get3DTextureDimension` (+ `getVolume`). */
function loadGet3DTextureDimension() {
  const source = readFileSync(MEGATEXTURE_JS, "utf8");
  const region = sliceRegion(
    source,
    "Megatexture.get3DTextureDimension = function (",
    "\nexport default Megatexture;",
    "Megatexture.js get3DTextureDimension",
  );
  const factory = vm.compileFunction(
    `const Megatexture = {};\n${region}\nreturn Megatexture.get3DTextureDimension;`,
    ["Cartesian3", "RuntimeError", "defined"],
    { filename: "Megatexture.js#get3DTextureDimension" },
  );
  return factory(Cartesian3, RuntimeError, defined);
}

const buildCapabilityOptions = loadCapabilityOptionsFactory();
const stubGetParameterDebug = loadStubGetParameter({ release: false });
const stubGetParameterRelease = loadStubGetParameter({ release: true });

/**
 * The spec WebGL stub as `Specs/getWebGLStub.js` really builds it: a clone of
 * `WebGLConstants` (so every enum is an own property) whose `getParameter` is
 * the real stub table. It is a plain object, so
 * `instanceof WebGL2RenderingContext` is false for it — `webgl2` is false.
 */
function makeStubGl() {
  const gl = clone(WebGLConstants);
  gl.getParameter = stubGetParameterDebug;
  return gl;
}

const WEBGL2_DRIVER_VALUES = {
  [WebGLConstants.MAX_3D_TEXTURE_SIZE]: 16384,
  [WebGLConstants.MAX_ARRAY_TEXTURE_LAYERS]: 2048,
  [WebGLConstants.MAX_SAMPLES]: 4,
};

/** A real-WebGL2-shaped `gl`: every enum present, driver values answered. */
function makeWebgl2Gl() {
  const gl = clone(WebGLConstants);
  gl.getParameter = (pname) =>
    pname in WEBGL2_DRIVER_VALUES ? WEBGL2_DRIVER_VALUES[pname] : 1;
  return gl;
}

/**
 * A real-WebGL1-shaped `gl`: the WebGL2-only enums are absent, and
 * `getParameter` reproduces WebGL's invalid-enum behaviour — the argument is
 * converted to a `GLenum` (so `undefined` becomes 0), INVALID_ENUM is recorded
 * and `null` is returned. It records rather than throws, exactly like a real
 * context.
 */
function makeWebgl1Gl() {
  const gl = clone(WebGLConstants);
  delete gl.MAX_3D_TEXTURE_SIZE;
  delete gl.MAX_ARRAY_TEXTURE_LAYERS;
  delete gl.MAX_SAMPLES;
  const webgl1Answers = new Set([
    WebGLConstants.MAX_COMBINED_TEXTURE_IMAGE_UNITS,
    WebGLConstants.MAX_CUBE_MAP_TEXTURE_SIZE,
    WebGLConstants.MAX_FRAGMENT_UNIFORM_VECTORS,
    WebGLConstants.MAX_TEXTURE_IMAGE_UNITS,
    WebGLConstants.MAX_RENDERBUFFER_SIZE,
    WebGLConstants.MAX_TEXTURE_SIZE,
    WebGLConstants.MAX_VARYING_VECTORS,
    WebGLConstants.MAX_VERTEX_ATTRIBS,
    WebGLConstants.MAX_VERTEX_TEXTURE_IMAGE_UNITS,
    WebGLConstants.MAX_VERTEX_UNIFORM_VECTORS,
  ]);
  gl.invalidEnumCount = 0;
  gl.getParameter = (pname) => {
    const asGLenum = Number.isFinite(Number(pname)) ? Number(pname) : 0;
    if (!webgl1Answers.has(asGLenum)) {
      gl.invalidEnumCount++;
      return null;
    }
    return 4096;
  };
  return gl;
}

/** Runs the real literal, then the real capability factory, over one `gl`. */
function limitsFor(gl, webgl2, options) {
  const getWebGLStub = options?.getWebGLStub;
  const capabilityOptions = buildCapabilityOptions(
    gl,
    webgl2,
    defined,
    getWebGLStub,
  );
  return {
    options: capabilityOptions,
    limits: GraphicsCapabilities.create(capabilityOptions),
  };
}

// ── A. the harness reaches the real source ──────────────────────────────────

test("A1 the sliced Context.js literal really is the capability table", () => {
  const { options } = limitsFor(makeWebgl2Gl(), true);
  // Entries that were never in doubt; if the slice drifted onto another
  // object these would not be here.
  assert.ok("maximumTextureSize" in options);
  assert.ok("maximumCubeMapSize" in options);
  assert.ok("maximum3DTextureSize" in options);
  assert.ok("maximumArrayTextureLayers" in options);
  assert.ok("maximumSamples" in options);
});

test("A2 the sliced stub parameter table is the real one", () => {
  // The stub's own number for the limit under repair. Every 2048 asserted in
  // group B is this value, read from the stub's source, not typed here.
  assert.equal(stubGetParameterDebug(WebGLConstants.MAX_3D_TEXTURE_SIZE), 2048);
  assert.equal(stubGetParameterDebug(WebGLConstants.MAX_TEXTURE_SIZE), 16384);
});

// ── B. the reported 3D-texture limit, per context kind ──────────────────────

test("B1 a real WebGL2 context reports the driver's 3D-texture limit", () => {
  const { limits } = limitsFor(makeWebgl2Gl(), true);
  assert.equal(limits.maximum3DTextureSize, 16384);
});

test("B2 a stubbed context reports the limit the stub supplies", () => {
  const stub = makeStubGl();
  const { limits } = limitsFor(stub, false, { getWebGLStub: () => stub });
  assert.equal(
    limits.maximum3DTextureSize,
    stubGetParameterDebug(WebGLConstants.MAX_3D_TEXTURE_SIZE),
  );
  assert.equal(limits.maximum3DTextureSize, 2048);
});

test("B3 a real WebGL1 context reports 0, without throwing", () => {
  const gl = makeWebgl1Gl();
  const { options, limits } = limitsFor(gl, false);
  // The raw read yields null — the capability factory is what turns that into
  // the 0 a WebGL1 context must report, which is why no gate is needed.
  assert.equal(options.maximum3DTextureSize, null);
  assert.equal(limits.maximum3DTextureSize, 0);
  assert.ok(gl.invalidEnumCount >= 1);
});

test("B4 the stubbed value clears ContextSpec's own bar", () => {
  // packages/engine/Specs/Renderer/ContextSpec.js:76
  const stub = makeStubGl();
  const { limits } = limitsFor(stub, false, { getWebGLStub: () => stub });
  assert.ok(
    limits.maximum3DTextureSize >= 256,
    `expected ${limits.maximum3DTextureSize} to be >= 256`,
  );
});

// ── C. the siblings in the same literal ─────────────────────────────────────

test("C1 the stub carries the array-layer ENUM but supplies no VALUE", () => {
  const stub = makeStubGl();
  // A capability gate of the form `defined(gl.MAX_ARRAY_TEXTURE_LAYERS)` would
  // be TRUE here, so it would not protect this limit.
  assert.equal(defined(stub.MAX_ARRAY_TEXTURE_LAYERS), true);
  // Debug build (the coverage job): the stub throws.
  assert.throws(
    () => stubGetParameterDebug(WebGLConstants.MAX_ARRAY_TEXTURE_LAYERS),
    (error) =>
      error instanceof DeveloperError && /is not defined/.test(error.message),
  );
  // Release build (the release-tests job): the stub answers undefined.
  assert.equal(
    stubGetParameterRelease(WebGLConstants.MAX_ARRAY_TEXTURE_LAYERS),
    undefined,
  );
});

test("C2 the array-layer limit stays gated and reports 0 for the stub", () => {
  const stub = makeStubGl();
  const { limits } = limitsFor(stub, false, { getWebGLStub: () => stub });
  assert.equal(limits.maximumArrayTextureLayers, 0);
  const webgl2 = limitsFor(makeWebgl2Gl(), true).limits;
  assert.equal(webgl2.maximumArrayTextureLayers, 2048);
});

test("C3 maximumSamples keeps upstream's webgl2 gate", () => {
  const stub = makeStubGl();
  const { limits } = limitsFor(stub, false, { getWebGLStub: () => stub });
  assert.equal(limits.maximumSamples, 0);
  assert.equal(limitsFor(makeWebgl2Gl(), true).limits.maximumSamples, 4);
});

test("C4 every other entry in the literal is answered for a stubbed context", () => {
  const stub = makeStubGl();
  const { options } = limitsFor(stub, false, { getWebGLStub: () => stub });
  // Anything left undefined here would be a limit whose parameter the stub
  // cannot answer — the shape that makes an ungated read unsafe.
  const unanswered = Object.entries(options)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  assert.deepEqual(unanswered, []);
});

// ── D. the consequence the aborted CI run reported ──────────────────────────

const get3DTextureDimension = loadGet3DTextureDimension();

// MegatextureSpec.js "constructs": 16^3 voxels, 4 channels of FLOAT32.
const TILE_DIMENSIONS = new Cartesian3(16, 16, 16);
const BYTES_PER_SAMPLE = 4 * 4;
const AVAILABLE_BYTES = 16 * 16 * 16 * 4 * 4;

test("D1 a 0 limit throws the RuntimeError the aborted run printed", () => {
  assert.throws(
    () =>
      get3DTextureDimension(
        TILE_DIMENSIONS,
        BYTES_PER_SAMPLE,
        AVAILABLE_BYTES,
        undefined,
        0,
      ),
    (error) =>
      error instanceof RuntimeError &&
      error.message ===
        "The GL context does not support a 3D texture large enough to contain a tile with the given dimensions.",
  );
});

test("D2 the limit a stubbed context now reports builds a megatexture", () => {
  const stub = makeStubGl();
  const { limits } = limitsFor(stub, false, { getWebGLStub: () => stub });
  const dimension = get3DTextureDimension(
    TILE_DIMENSIONS,
    BYTES_PER_SAMPLE,
    AVAILABLE_BYTES,
    undefined,
    limits.maximum3DTextureSize,
  );
  assert.ok(dimension instanceof Cartesian3);
  assert.ok(dimension.x >= TILE_DIMENSIONS.x);
  assert.ok(dimension.y >= TILE_DIMENSIONS.y);
  assert.ok(dimension.z >= TILE_DIMENSIONS.z);
});

test("D3 a WebGL1 context still refuses a megatexture", () => {
  const { limits } = limitsFor(makeWebgl1Gl(), false);
  assert.throws(
    () =>
      get3DTextureDimension(
        TILE_DIMENSIONS,
        BYTES_PER_SAMPLE,
        AVAILABLE_BYTES,
        undefined,
        limits.maximum3DTextureSize,
      ),
    RuntimeError,
  );
});

// ── E. the WebGPU backend is not involved ───────────────────────────────────

test("E1 WebGPU builds its 3D-texture limit from its own device limits", () => {
  // GraphicsCapabilities.fromWebGPUDevice never consults Context.js, so this
  // lane cannot move the WebGPU number.
  const capabilities = GraphicsCapabilities.fromWebGPUDevice({
    limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 2048 },
    features: new Set(),
  });
  assert.equal(capabilities.maximum3DTextureSize, 2048);
  const zeroed = GraphicsCapabilities.fromWebGPUDevice({
    limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 0 },
    features: new Set(),
  });
  assert.equal(zeroed.maximum3DTextureSize, 0);
});

// ── F. the mock contexts the companion repairs ──────────────────────────────
//
// Two spec mocks claim to be a context and are not. Since the per-context
// capability migration of 2026-07-16, `addDrawCommandsForTile` reads TWO things
// off `frameState.context` — `getFeatureRenderer` and `limits` — and the mock
// answered neither, so the first read threw and hid the second. These cases
// drive the REAL prologue of that function with the REAL mock literal sliced
// out of `QuadtreePrimitiveSpec.js`, so "the mock is complete" is an executed
// outcome rather than a reading of the diff. What they do NOT show is that the
// karma suites pass: everything past the prologue needs a built tree.

/**
 * Compiles the real prologue of `addDrawCommandsForTile` — the tile lookup, the
 * feature-renderer branch and the capability read that follows it — and returns
 * it as a callable answering `maxTextures`.
 */
function loadAddDrawCommandsForTilePrologue() {
  const source = readFileSync(GLOBE_SURFACE_RENDERING_JS, "utf8");
  const region = sliceRegion(
    source,
    "function addDrawCommandsForTile(tileProvider, tile, frameState) {",
    "\n  let waterMaskTexture = surfaceTile.waterMaskTexture;",
    "GlobeSurfaceTileProviderRendering.js addDrawCommandsForTile prologue",
  );
  const factory = vm.compileFunction(
    `${region}\n  return maxTextures;\n}\nreturn addDrawCommandsForTile;`,
    [
      "defined",
      "FeatureRendererKey",
      "TerrainFillMesh",
      "isTileClippedAwayByInversePolygons",
      "addPerTileCreditsForNextFrame",
      "addWebGPUDrawCommandsForTile",
    ],
    { filename: "GlobeSurfaceTileProviderRendering.js#addDrawCommandsForTile" },
  );
  return factory(
    defined,
    FeatureRendererKey,
    class TerrainFillMeshDouble {
      update() {}
    },
    () => false,
    () => {},
    () => {
      throw new Error("the WebGPU path must not be taken for a WebGL mock");
    },
  );
}

/** Evaluates the `context` mock literal out of a real spec file. */
function loadSpecMockContext(specPath, endAnchor, label) {
  const source = readFileSync(specPath, "utf8");
  const region = sliceRegion(source, "context: {", endAnchor, label);
  const factory = vm.compileFunction(
    `return ({\n${region}\n}).context;`,
    ["scene"],
    { filename: label },
  );
  return factory({ drawingBufferWidth: 1000, drawingBufferHeight: 1000 });
}

/** Every property name read off a `context` binding in a source region. */
function contextPropertyReads(source) {
  return [...source.matchAll(/\bcontext\.([A-Za-z_$][\w$]*)/g)].map(
    (match) => match[1],
  );
}

const addDrawCommandsForTilePrologue = loadAddDrawCommandsForTilePrologue();

const quadtreeMockContext = () =>
  loadSpecMockContext(
    QUADTREE_PRIMITIVE_SPEC_JS,
    "\n        mode: SceneMode.SCENE3D,",
    "QuadtreePrimitiveSpec.js frameState.context",
  );

/** Drives the real prologue over one mock context. */
function runPrologue(context, vertexArray) {
  const surfaceTile = { vertexArray: vertexArray, fill: undefined };
  const frameState = { context: context, creditDisplay: undefined };
  return addDrawCommandsForTilePrologue({}, { data: surfaceTile }, frameState);
}

test("F1 QuadtreePrimitiveSpec's mock context answers the whole prologue", () => {
  const context = quadtreeMockContext();
  // The shape the spec reaches: the vertex array is already built (its creation
  // is spied in TerrainTileProcessor.mockWebGL), so the fill branch is skipped
  // and the capability read is the next statement.
  assert.equal(runPrologue(context, { destroy() {} }), 16);
  // And the other branch, where the prologue builds a fill mesh first.
  assert.equal(runPrologue(context, undefined), 16);
  // The 16 is the stub's own number for that parameter, not a constant typed
  // into this spec.
  assert.equal(
    context.limits.maximumTextureImageUnits,
    stubGetParameterDebug(WebGLConstants.MAX_TEXTURE_IMAGE_UNITS),
  );
});

test("F2 answering getFeatureRenderer alone is not enough", () => {
  // Satisfying the first read only moves the throw to the second one, in the
  // same call and the same specs.
  const context = {
    drawingBufferWidth: 1000,
    drawingBufferHeight: 1000,
    getFeatureRenderer: () => undefined,
  };
  assert.throws(
    () => runPrologue(context, { destroy() {} }),
    (error) =>
      error instanceof TypeError &&
      /maximumTextureImageUnits/.test(error.message),
  );
});

test("F3 answering neither is the failure both jobs report today", () => {
  const context = { drawingBufferWidth: 1000, drawingBufferHeight: 1000 };
  assert.throws(
    () => runPrologue(context, { destroy() {} }),
    (error) =>
      error instanceof TypeError && /getFeatureRenderer/.test(error.message),
  );
});

test("F4 the mock answers every context property the whole function reads", () => {
  const source = readFileSync(GLOBE_SURFACE_RENDERING_JS, "utf8");
  const body = sliceRegion(
    source,
    "function addDrawCommandsForTile(tileProvider, tile, frameState) {",
    "\n// Need a scratch Rectangle for cutout intersection inside addDrawCommandsForTile",
    "GlobeSurfaceTileProviderRendering.js addDrawCommandsForTile",
  );
  const reads = [...new Set(contextPropertyReads(body))].sort();
  // A slice that drifted off the function would not carry these.
  assert.ok(reads.includes("getFeatureRenderer"));
  assert.ok(reads.includes("limits"));
  const context = quadtreeMockContext();
  const unanswered = reads.filter((name) => !(name in context));
  assert.deepEqual(unanswered, []);
});

test("F5 TerrainFillMesh reads one context property, and its mock answers it", () => {
  const reads = [
    ...new Set(
      contextPropertyReads(readFileSync(TERRAIN_FILL_MESH_JS, "utf8")),
    ),
  ].sort();
  // Which is why that mock needs no `limits` entry and the two mocks differ.
  assert.deepEqual(reads, ["getFeatureRenderer"]);
  const context = loadSpecMockContext(
    TERRAIN_FILL_MESH_SPEC_JS,
    "\n      mode: SceneMode.SCENE3D,",
    "TerrainFillMeshSpec.js frameState.context",
  );
  const unanswered = reads.filter((name) => !(name in context));
  assert.deepEqual(unanswered, []);
});

// ── G. from the literal to the record, and from the record to the consumer ──
//
// Group B stops at the literal and the factory. These two cases carry the same
// value across the statements that sit on either side of it in real code: the
// assignment that records it on the context, and the constructor read that
// consumes it.

/** Compiles the real statement that records the capability options. */
function loadCapabilityRecordAssignment() {
  const source = readFileSync(CONTEXT_JS, "utf8");
  const region = sliceRegion(
    source,
    "this._graphicsCapabilities = GraphicsCapabilities.create(",
    "\n    this._clearColor = new Color(0.0, 0.0, 0.0, 0.0);",
    "Context.js capability record assignment",
  );
  const assign = vm.compileFunction(
    `${region}\nreturn this._graphicsCapabilities;`,
    ["GraphicsCapabilities", "capabilityOptions"],
    { filename: "Context.js#recordCapabilities" },
  );
  return (capabilityOptions) =>
    assign.call({}, GraphicsCapabilities, capabilityOptions);
}

/** Compiles the Megatexture constructor's CALL to get3DTextureDimension. */
function loadMegatextureDimensionCall() {
  const source = readFileSync(MEGATEXTURE_JS, "utf8");
  const region = sliceRegion(
    source,
    "const textureDimension = Megatexture.get3DTextureDimension(",
    "\n    const tileCounts = Cartesian3.divideComponents(",
    "Megatexture.js constructor dimension call",
  );
  const call = vm.compileFunction(
    `${region}\nreturn textureDimension;`,
    [
      "Megatexture",
      "dimensions",
      "bytesPerSample",
      "availableTextureMemoryBytes",
      "tileCount",
      "context",
    ],
    { filename: "Megatexture.js#constructorDimensionCall" },
  );
  return (context) =>
    call(
      { get3DTextureDimension: get3DTextureDimension },
      TILE_DIMENSIONS,
      BYTES_PER_SAMPLE,
      AVAILABLE_BYTES,
      undefined,
      context,
    );
}

const recordCapabilities = loadCapabilityRecordAssignment();
const megatextureDimensionCall = loadMegatextureDimensionCall();

test("G1 the recorded capability table carries the limit the literal built", () => {
  const stub = makeStubGl();
  const { options } = limitsFor(stub, false, { getWebGLStub: () => stub });
  // Context.js's own assignment, not a re-implementation of it: overriding the
  // limit where the record is built reds this case with the literal untouched.
  const recorded = recordCapabilities(options);
  assert.equal(
    recorded.maximum3DTextureSize,
    stubGetParameterDebug(WebGLConstants.MAX_3D_TEXTURE_SIZE),
  );
  assert.equal(recorded.maximum3DTextureSize, 2048);
  assert.equal(
    recordCapabilities(limitsFor(makeWebgl1Gl(), false).options)
      .maximum3DTextureSize,
    0,
  );
});

test("G2 the megatexture reads its limit off the context it is handed", () => {
  const stub = makeStubGl();
  const { limits } = limitsFor(stub, false, { getWebGLStub: () => stub });
  const dimension = megatextureDimensionCall({ limits: limits });
  assert.ok(dimension instanceof Cartesian3);
  assert.ok(dimension.x >= TILE_DIMENSIONS.x);
  // The same call with the 0 a stubbed context used to report is the throw that
  // ended both runs.
  assert.throws(
    () => megatextureDimensionCall({ limits: { maximum3DTextureSize: 0 } }),
    (error) =>
      error instanceof RuntimeError &&
      error.message ===
        "The GL context does not support a 3D texture large enough to contain a tile with the given dimensions.",
  );
});
