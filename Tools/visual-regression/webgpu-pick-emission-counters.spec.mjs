// webgpu-pick-emission-counters.spec.mjs — browser-free contract for the four
// debug-only WebGPU model pick-emission counters. Pure Node: no browser, no
// GPU, no build.
//
// @purpose Pins the four pragma-stripped counters (ready-gate skips, pick
//   commands emitted, getPickPipeline call volume, createPickPipeline wall
//   time) that WebGPUModelRenderer.ts and WebGPUModelPipelineCache.ts publish
//   through Scene.getDebugSnapshot(), by executing the REAL, complete
//   `updateWebGPUModel` function end to end (not an extracted or
//   hand-copied fragment of it) and reading the result through the REAL
//   `Scene.getDebugSnapshot().renderer.modelPick` publication chain.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// A WebGPU model primitive whose on-screen colour pipeline is still cooking
// (`createRenderPipelineAsync` has not resolved) must still provide the
// synchronous pick carrier needed by a demanded ordinary or metadata pick.
// This file pins the four counters that make that distinction observable:
//
//   1. readyGateSkipsThisFrame  — primitives skipped by the ready gate.
//   2. pickCommandsEmittedThisFrame — pick draw commands actually built.
//   3. getPickPipelineCalls    — cumulative WebGPUModelPipelineCache#getPickPipeline calls.
//   4. createPickPipelineWallTimeMs — cumulative wall time inside the
//      synchronous createPickPipeline builder.
//
// Fields 1-2 reset once per frame — from `WebGPUContext#beginFrame`, via the
// exported `resetModelPickDebugCountersForFrame`, at the SAME point the
// renderer already resets `_drawCallCount`/`_triangleCount` — never lazily on
// the first counted event. Fields 3-4 are running sums across the session (a
// synchronous pick-pipeline build is a rare per-identity event, not a
// per-frame one). All four are confined to `pragmas.debug` blocks, so the
// storage and every increment disappear from a production bundle; the
// snapshot accessor remains as an always-`undefined` fallback (matching every
// other lazily-populated `getRendererStatistics` field's optionality
// contract).
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` is bundled
// with esbuild using esbuild's OWN DEFAULT MODULE RESOLUTION over the real
// `packages/engine/Source` tree — no stub-dependency allowlist, no extracted
// fragment, no hand-copied driver loop. The exported `updateWebGPUModel` is
// called directly, with a fixture built from REAL Core/Scene classes
// (`BoundingSphere`, `Cartesian3`, `Matrix4`) plus a duck-typed `model`,
// `frameState`, `device` and a bare (`Object.create`, never `new`)
// `WebGPUModelPipelineCache`/`WebGPUContext` instance. The function runs to
// completion through its real admission check, real per-node/per-primitive
// loop, real ready gate, and real pick-command construction; counters are
// read back through the REAL `Scene.prototype.getDebugSnapshot` →
// `WebGPUContext#getRendererStatistics` → `getModelPickDebugCounters` chain,
// exactly the path a browser caller reads
// (`viewer.scene.getDebugSnapshot().renderer.modelPick`).
//
// Two engine-generated-artifact gaps needed a shim, both documented where
// they're implemented below (`wgslGenPlugin`, `emptyShaderPlugin`): the
// `.js` wrapper modules `gulp build`'s WGSL/GLSL compilation step generates
// for each shader source do not exist in an unbuilt checkout (this worker is
// forbidden from running that build). The shim reads the real `.wgsl`
// source and calls the project's OWN `scripts/build.js#shaderSourceToJavaScript`
// — the literal function `gulp build` would call — to produce byte-identical
// output; an aggregated GLSL-only builtins index with no WGSL/GLSL sibling
// (irrelevant to the WebGPU model path) is aliased to an empty string,
// mirroring the project's own `webgpu-only` build variant
// (`scripts/stubs/emptyShader.js`). Neither shim changes what code executes;
// both only supply text a missing build step would otherwise have written
// to disk.
//
// Mutation tests do not touch the real file on disk. `bundleReal`'s
// `overrides` parameter substitutes mutated text for one specific real
// file's content during the bundle (by absolute path), verified present via
// `mutateOrFail` first, so a moved anchor fails loudly rather than mutating
// nothing. The SAME assertion functions the nominal tests use are re-run
// against the mutated bundle and required to throw — not a separately
// authored "expect zero" test.
//
// Every mutant wraps its target in `if (false && ...)` or bare `if (false)`
// — inertness, never deletion (SR-7 / Principle 10).
//
// CRLF: this repo checks out with `core.autocrlf=true`; anchors are matched
// against LF-normalised text.
//
// Run: node --test Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { shaderSourceToJavaScript } from "../../scripts/build.js";
import { mutateOrFail } from "./lib/engine-stub-bundler.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(directory, "../..");
const engineSource = resolve(repoRoot, "packages/engine/Source");
const engineWebGPU = resolve(engineSource, "Renderer/WebGPU");
const shadersDir = resolve(engineSource, "Shaders") + sep;

const MODEL_RENDERER_PATH = resolve(engineWebGPU, "WebGPUModelRenderer.ts");
const PIPELINE_CACHE_PATH = resolve(
  engineWebGPU,
  "WebGPUModelPipelineCache.ts",
);
const WEBGPU_CONTEXT_PATH = resolve(engineWebGPU, "WebGPUContext.ts");
const PICK_HELPERS_PATH = resolve(engineWebGPU, "WebGPUPickCommandHelpers.ts");

/**
 * Reads a source file and normalises its line terminators, so anchors in
 * this file match regardless of the checkout's autocrlf setting.
 *
 * @param {string} path Absolute path to read.
 * @returns {Promise<string>} LF-normalised source.
 */
async function readSource(path) {
  return (await readFile(path, "utf8")).split("\r\n").join("\n");
}

// Read once, up front, for the anchor-presence checks (D0-shaped
// preconditions) and the WCX0 wiring check. Mutation tests re-read their
// target file fresh inside `bundleReal`'s `overrides` handling, so a
// mutation never touches these.
const WEBGPU_CONTEXT_SOURCE = await readSource(WEBGPU_CONTEXT_PATH);

// Node has no native WebGPU implementation, so it defines none of the
// WebGPU spec's global bitflag namespaces that engine code (default-texture
// creation, buffer usage flags, etc.) reads as bare globals, the way a
// browser or Deno's WebGPU implementation would provide them. These are the
// official, standardized values from the WebGPU spec's usage-flag tables
// (mirrored in `@webgpu/types`) -- not invented for this file.
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};
globalThis.GPUBufferUsage ??= {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
};
globalThis.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
globalThis.GPUColorWrite ??= {
  RED: 0x1,
  GREEN: 0x2,
  BLUE: 0x4,
  ALPHA: 0x8,
  ALL: 0xf,
};
globalThis.GPUMapMode ??= { READ: 0x0001, WRITE: 0x0002 };

test("mutateOrFail returns changed source and rejects an identity rewrite", () => {
  assert.equal(
    mutateOrFail("before", () => "after", "changed"),
    "after",
  );
  assert.throws(() => mutateOrFail("before", (source) => source, "identity"), {
    name: "AssertionError",
    message:
      "the identity mutation changed nothing — its anchor text has moved, so " +
      "this mutation test would pass vacuously and the result it exists to " +
      "falsify would be unfalsifiable",
  });
});

/**
 * Resolves an engine `.js` shader-wrapper import that a missing `gulp
 * build` WGSL/GLSL compilation step would otherwise have generated on
 * disk. Real `.wgsl`/`.glsl` sibling → the project's own
 * `shaderSourceToJavaScript`, byte-identical to what the build step would
 * write. No sibling at all (an aggregated GLSL builtins index, irrelevant
 * to the WebGPU model path) → the empty string, mirroring the project's
 * own `webgpu-only` build variant's GLSL-shader alias
 * (`scripts/stubs/emptyShader.js`).
 */
const wgslGenPlugin = {
  name: "wgsl-gen",
  setup(pb) {
    pb.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === "entry-point") {
        return undefined;
      }
      const resolved = resolve(args.resolveDir, args.path);
      if (!resolved.startsWith(shadersDir)) {
        return undefined;
      }
      if (existsSync(resolved)) {
        return undefined;
      }
      const wgslPath = resolved.replace(/\.js$/, ".wgsl");
      if (existsSync(wgslPath)) {
        return { path: wgslPath, namespace: "wgsl-gen" };
      }
      const glslPath = resolved.replace(/\.js$/, ".glsl");
      if (existsSync(glslPath)) {
        return { path: glslPath, namespace: "wgsl-gen" };
      }
      return { path: resolved, namespace: "empty-shader" };
    });
    pb.onLoad({ filter: /.*/, namespace: "wgsl-gen" }, async (args) => {
      const raw = (await readFile(args.path, "utf8")).replace(/\r\n/g, "\n");
      return { contents: shaderSourceToJavaScript(raw, ""), loader: "js" };
    });
    pb.onLoad({ filter: /.*/, namespace: "empty-shader" }, () => {
      return { contents: 'export default "";', loader: "js" };
    });
  },
};

let bundleInstanceCounter = 0;

/**
 * Bundles `entrySource` with esbuild's OWN default module resolution over
 * the real engine tree — no stub-dependency allowlist. `overrides` lets a
 * mutation test substitute mutated text for one specific real file's
 * content, by absolute path, verified present first via `mutateOrFail`.
 *
 * @param {object} options Bundle options.
 * @param {string} options.entryPath Entry module path (drives `resolveDir`).
 * @param {string} options.entrySource Entry module source text.
 * @param {Array<{path: string, mutate: Function, label: string}>} [options.overrides]
 *   Real files whose disk content is replaced by a mutated copy.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
async function bundleReal({ entryPath, entrySource, overrides = [] }) {
  const overridesByPath = new Map();
  for (const o of overrides) {
    const source = await readSource(o.path);
    overridesByPath.set(o.path, mutateOrFail(source, o.mutate, o.label));
  }
  // Cache-bust: `import()` of a `data:` URI is content-addressed, so two
  // bundles of byte-identical text resolve to the SAME cached module,
  // silently sharing this file's process-wide counter singleton across
  // "separate" test bundles. An exported binding with a unique literal
  // value is never dropped by the printer (unlike a dangling comment),
  // forcing a genuinely fresh module instance on every call.
  const text = `${entrySource}\nexport const __specBundleInstance = ${bundleInstanceCounter++};\n`;
  const overridePlugin = {
    name: "content-overrides",
    setup(pb) {
      if (overridesByPath.size === 0) {
        return;
      }
      pb.onLoad({ filter: /.*/ }, (args) => {
        const mutated = overridesByPath.get(args.path);
        if (mutated === undefined) {
          return undefined;
        }
        return {
          contents: mutated,
          loader: args.path.endsWith(".ts") ? "ts" : "js",
        };
      });
    },
  };
  const result = await build({
    stdin: {
      contents: text,
      resolveDir: dirname(entryPath),
      sourcefile: entryPath.split(/[\\/]/).pop(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    logLevel: "silent",
    absWorkingDir: repoRoot,
    // Registration order matters: esbuild tries onLoad callbacks in the
    // order their plugins were registered and falls through on
    // `undefined`, so the override plugin (path-specific) gets first
    // refusal before the generic wgsl-gen/empty-shader resolution.
    plugins: [overridePlugin, wgslGenPlugin],
  });
  const code = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

// The barrel: every real export this file's fixtures need, from the real
// engine tree, in ONE module graph — so the counters' module-level storage
// in WebGPUModelPipelineCache.ts is the SAME object whether reached via a
// direct `record*` call, via `getPickPipeline`, or via a full
// `updateWebGPUModel` run.
const BARREL_PATH = resolve(engineWebGPU, "__dm07-barrel.ts");
const BARREL_SOURCE = [
  'export { default as Scene } from "../../Scene/Scene.js";',
  'export { WebGPUContext } from "./WebGPUContext.js";',
  "export {",
  "  default as WebGPUModelPipelineCache,",
  "  recordModelPickReadyGateSkip,",
  "  recordModelPickCommandEmitted,",
  "  recordGetPickPipelineCall,",
  "  recordCreatePickPipelineWallTime,",
  "  resetModelPickDebugCountersForFrame,",
  '} from "./WebGPUModelPipelineCache.js";',
  'export { MODEL_TOPOLOGY_TRIANGLE_LIST } from "./WebGPUModelTopology.js";',
  'export { updateWebGPUModel } from "./WebGPUModelRenderer.js";',
  'export { selectCommandVariant } from "./WebGPUSceneRenderer.js";',
  'export { default as BoundingSphere } from "../../Core/BoundingSphere.js";',
  'export { default as Cartesian3 } from "../../Core/Cartesian3.js";',
  'export { default as Matrix4 } from "../../Core/Matrix4.js";',
  'export { default as SceneModeEnum } from "../../Scene/SceneMode.js";',
  'export { default as PassEnum } from "../Pass.js";',
  "",
].join("\n");

/**
 * Imports the barrel, optionally with a mutated real-file override.
 *
 * @param {Array} [overrides] Passed through to {@link bundleReal}.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function importBarrel(overrides) {
  return bundleReal({
    entryPath: BARREL_PATH,
    entrySource: BARREL_SOURCE,
    overrides,
  });
}

// ────────────────────────── fixture builders ─────────────────────────────

/**
 * A no-op GPU pass/encoder-shaped object: every method call is a no-op
 * returning `undefined`, except the two "begin a pass" methods, which
 * return another instance of the same shape. Encoder/pass objects are only
 * ever used through method calls in this codebase, never read as numbers or
 * iterated, so there is no arithmetic-coercion risk in faking them this way.
 *
 * @returns {object} The fake encoder/pass.
 */
function makeNoOpPassOrEncoder() {
  const obj = {};
  const passthrough = [
    "beginRenderPass",
    "beginComputePass",
    "end",
    "finish",
    "setPipeline",
    "setBindGroup",
    "setVertexBuffer",
    "setIndexBuffer",
    "draw",
    "drawIndexed",
    "drawIndirect",
    "drawIndexedIndirect",
    "dispatchWorkgroups",
    "dispatchWorkgroupsIndirect",
    "copyBufferToBuffer",
    "copyBufferToTexture",
    "copyTextureToBuffer",
    "copyTextureToTexture",
    "clearBuffer",
    "resolveQuerySet",
    "pushDebugGroup",
    "popDebugGroup",
    "insertDebugMarker",
    "setViewport",
    "setScissorRect",
    "setStencilReference",
    "setBlendConstant",
    "writeTimestamp",
  ];
  for (const m of passthrough) {
    obj[m] = () =>
      m === "beginRenderPass" || m === "beginComputePass"
        ? makeNoOpPassOrEncoder()
        : undefined;
  }
  return obj;
}

/**
 * A fake `GPUDevice`. `createRenderPipeline` is tracked (`pipelines`
 * accumulates one entry per call) since the counters under test observe
 * whether — and how many times — it's called; every other creation method
 * returns a cheap opaque marker object, since the counters never inspect a
 * created resource's contents.
 *
 * @returns {{device: object, pipelines: Array}} The fake device and its
 *   `createRenderPipeline` call log.
 */
function makeFakeDevice() {
  const pipelines = [];
  const device = {
    limits: {
      maxSampledTexturesPerShaderStage: 32,
      maxStorageBufferBindingSize: 134217728,
    },
    features: new Set(),
    queue: {
      writeBuffer() {},
      writeTexture() {},
      submit() {},
    },
    createCommandEncoder() {
      return makeNoOpPassOrEncoder();
    },
    createBuffer(desc) {
      return {
        __kind: "buffer",
        size: desc.size,
        label: desc.label,
        destroy() {},
      };
    },
    createTexture(desc) {
      return {
        __kind: "texture",
        label: desc.label,
        createView() {
          return { __kind: "textureView" };
        },
        destroy() {},
      };
    },
    createSampler(desc) {
      return { __kind: "sampler", label: desc?.label };
    },
    createBindGroupLayout(desc) {
      return { __kind: "bindGroupLayout", label: desc?.label };
    },
    createPipelineLayout(desc) {
      return { __kind: "pipelineLayout", label: desc?.label };
    },
    createBindGroup(desc) {
      return { __kind: "bindGroup", label: desc?.label };
    },
    createShaderModule(desc) {
      return { __kind: "shaderModule", label: desc?.label };
    },
    createRenderPipeline(desc) {
      const pipeline = { __kind: "pipeline", label: desc.label };
      pipelines.push({ desc, pipeline });
      return pipeline;
    },
    createRenderPipelineAsync(desc) {
      const pipeline = { __kind: "pipeline", label: desc.label };
      pipelines.push({ desc, pipeline, async: true });
      return Promise.resolve(pipeline);
    },
    pushErrorScope() {},
    popErrorScope() {
      return Promise.resolve(null);
    },
  };
  return { device, pipelines };
}

/**
 * A bare `WebGPUContext` instance — `Object.create`, never `new`, so the
 * real (heavyweight, GPU-resource-allocating) constructor never runs. Every
 * field is set to exactly what the real code paths this fixture drives
 * read: `getRendererStatistics()`'s unconditional reads (from the
 * counters-only groups), `GraphicsContext`'s inherited pick-id bookkeeping
 * (from `ensurePickId`, reached inside a real `updateWebGPUModel` run with
 * `frameState.passes.pick = true`), and the camera/format/capability
 * surface `updateWebGPUModel` itself reads directly. Every property here
 * that has a real getter-only accessor on the class (verified individually
 * against the source — `device`, `resourceGeneration`,
 * `scenePipelineFormat`, `depthFormat`, `webgpuPipelineCache`,
 * `uniformState`, `modelCameraArena`, `uniformAllocator`, `enabledFeatures`,
 * `rendererType`) is set via `Object.defineProperty` to shadow the
 * inherited accessor, since a plain assignment throws
 * ("has only a getter") against it; everything else is a plain
 * underscore-prefixed backing field a getter reads, or an own method
 * override.
 *
 * @param {Record<string, unknown>} namespace The bundled barrel namespace.
 * @param {object} device The fake device from {@link makeFakeDevice}.
 * @returns {object} The bare context instance.
 */
function makeBareContext(namespace, device) {
  const context = Object.create(namespace.WebGPUContext.prototype);
  function defineAccessor(name, value) {
    Object.defineProperty(context, name, {
      value,
      configurable: true,
      enumerable: true,
    });
  }
  context._id = "fixture-context";
  context._canvas = { width: 800, height: 600 };
  context._options = { featureLevel: "core" };
  // GraphicsContext base-class pick-id bookkeeping (inherited, never
  // overridden on WebGPUContext), normally allocated in its own
  // constructor.
  context._nextPickColor = new Uint32Array(1);
  context._pickObjects = new Map();
  context._pickKinds = new Map();
  context.isDestroyed = () => false;
  context.hasFeature = () => false;
  defineAccessor("enabledFeatures", []);
  defineAccessor("device", device);
  defineAccessor("resourceGeneration", 1);
  defineAccessor("scenePipelineFormat", "bgra8unorm");
  defineAccessor("depthFormat", "depth24plus-stencil8");
  defineAccessor("webgpuPipelineCache", null);
  defineAccessor("uniformState", {
    view: namespace.Matrix4.clone(
      namespace.Matrix4.IDENTITY,
      new namespace.Matrix4(),
    ),
    projection: namespace.Matrix4.clone(
      namespace.Matrix4.IDENTITY,
      new namespace.Matrix4(),
    ),
    cameraPosition: new namespace.Cartesian3(-10, -10, -10),
  });
  defineAccessor("modelCameraArena", {
    beginFrame() {},
    acquire() {
      return { bindGroup: { __kind: "camBG" }, dynamicOffsets: [] };
    },
    acquireLightSlice() {
      return { __kind: "lightSlice" };
    },
  });
  defineAccessor("uniformAllocator", { beginFrame() {} });
  context._environmentDemandRegistry = { getTelemetry: () => ({}) };
  context._environmentRefreshScheduler = { getTelemetry: () => ({}) };
  return context;
}

/**
 * A bare `WebGPUModelPipelineCache` instance — `Object.create`, never
 * `new`, so the real constructor's eager device-resource allocation
 * (default textures/samplers/buffers, the effects/material/camera/instance
 * bind-group layouts, the two eagerly-compiled shader-module variants)
 * never runs. `getPickPipeline` (and its call to `createPickPipeline`) are
 * the REAL prototype methods; `getPipeline`, `_getOrCreateShaderModule`,
 * `_getOrCreatePipelineLayout`, `_getOrCreateMaterialBGL` are overridden
 * with trivial fakes, and every `_default*` placeholder field the
 * constructor allocates eagerly is faked as an opaque marker object — none
 * of them is inspected by anything this fixture drives, only assembled into
 * a merged bind group via the real `device.createBindGroup`.
 *
 * `getPipeline`'s return controls whether the ready gate lets a primitive
 * through: `null` (still cooking) or a truthy value (resolved) — this is
 * the one lever the F-group tests below flip.
 *
 * @param {Record<string, unknown>} namespace The bundled barrel namespace.
 * @param {object} device The fake device.
 * @param {() => object|null} getPipelineImpl What `getPipeline` returns.
 * @returns {object} The instance.
 */
function makeBarePipelineCache(namespace, device, getPipelineImpl) {
  const c = Object.create(namespace.WebGPUModelPipelineCache.prototype);
  c._device = device;
  c._pickFormat = "bgra8unorm";
  c._depthFormat = "depth24plus-stencil8";
  c._pickLogDepthEnabled = false;
  c._logDepthEnabled = false;
  c._primitiveTopology = namespace.MODEL_TOPOLOGY_TRIANGLE_LIST;
  c._pickPipelines = new Map();
  c._classificationPipelines = new Map();
  c._pipelines = new Map();
  c._sampleCount = 1;
  c._metadataMatTransport = false;
  c._metadataClassHash = 0;
  c._customShaderClassHash = 0;
  c._getOrCreateShaderModule = () => ({ __kind: "shaderModule" });
  c._getOrCreatePipelineLayout = () => ({ __kind: "pipelineLayout" });
  c._cameraBGL = { __kind: "cameraBGL" };
  c._instanceBGL = { __kind: "instanceBGL" };
  c._effectsBGL = { __kind: "effectsBGL" };
  c.getPipeline = getPipelineImpl;
  // Match every guarded early-return the real constructor's callers rely
  // on, so the full pipeline-map wipe those methods otherwise perform
  // never fires against Maps this bare instance never allocated (only
  // `_pickPipelines`/`_pipelines` are populated above; a fresh
  // constructor allocates a dozen more, all irrelevant to this row).
  c._sceneFormatGeneration = 0; // matches context._scenePipelineFormatGeneration ?? 0
  c._presentationFormat = "bgra8unorm";
  c._splitEnabled = false; // matches model.splitDirection === SplitDirection.NONE
  c._modelColorEnabled = false; // matches model.color undefined
  c._silhouetteEnabled = false; // matches model.silhouetteSize <= 0
  c._getOrCreateMaterialBGL = (md) => ({ __kind: "materialBGL", md });
  c._defaultFeatureIdEntries = () => [];
  c._defaultIBLCubemapView = { __kind: "defaultIBLCubemapView" };
  c._defaultIBLSampler = { __kind: "defaultIBLSampler" };
  c._defaultSHBuffer = { __kind: "defaultSHBuffer" };
  c._defaultBrdfLutView = { __kind: "defaultBrdfLutView" };
  c._defaultBrdfLutSampler = { __kind: "defaultBrdfLutSampler" };
  c._defaultPropertyTexture = { __kind: "defaultPropertyTexture" };
  c._defaultPropertyTextureView = { __kind: "defaultPropertyTextureView" };
  c._propertyTextureSampler = { __kind: "propertyTextureSampler" };
  c._defaultWhiteTexture = { __kind: "defaultWhiteTexture" };
  c._defaultWhiteTextureView = { __kind: "defaultWhiteTextureView" };
  c._defaultNormalTexture = { __kind: "defaultNormalTexture" };
  c._defaultNormalTextureView = { __kind: "defaultNormalTextureView" };
  c._defaultBlackTexture = { __kind: "defaultBlackTexture" };
  c._defaultBlackTextureView = { __kind: "defaultBlackTextureView" };
  c._defaultSampler = { __kind: "defaultSampler" };
  c._samplerCache = new Map();
  c._defaultNormalBuffer = { __kind: "defaultNormalBuffer" };
  c._defaultTangentBuffer = { __kind: "defaultTangentBuffer" };
  c._defaultUVBuffer = { __kind: "defaultUVBuffer" };
  c._defaultColorBuffer = { __kind: "defaultColorBuffer" };
  c._defaultJointsBuffer = { __kind: "defaultJointsBuffer" };
  c._defaultWeightsBuffer = { __kind: "defaultWeightsBuffer" };
  c._defaultFeatureIdBuffer = { __kind: "defaultFeatureIdBuffer" };
  c._defaultJointBuffer = { __kind: "defaultJointBuffer" };
  c._defaultMorphDeltaBuffer = { __kind: "defaultMorphDeltaBuffer" };
  c._defaultMorphWeightBuffer = { __kind: "defaultMorphWeightBuffer" };
  c._defaultInstancingBuffer = { __kind: "defaultInstancingBuffer" };
  c._defaultInstanceBG = { __kind: "defaultInstanceBG" };
  c._defaultFeatureUniformBuffer = { __kind: "defaultFeatureUniformBuffer" };
  c._materialBGLCache = new Map();
  c._pipelineLayoutCache = new Map();
  c._shaderModuleCache = new Map();
  c._metadataShaderModuleCache = new Map();
  c._metadataWGSL = "";
  c._metadataPickWGSL = "";
  c._metadataPickClassHash = 0;
  return c;
}

/**
 * One glTF-shaped runtime primitive: a single triangle, position-only (no
 * normals/UVs/skinning/morph) — the minimum `extractPrimitiveGeometry`
 * (`ModelPrimitiveGeometry.js`) accepts (position is the one required
 * attribute). `doubleSided` is a real, direct-passthrough
 * `material.doubleSided` field (`ModelMaterialInfo.js:116`,
 * `isDoubleSided: material?.doubleSided === true`) with no other code-path
 * side effects (unlike alphaMode, which would also engage a depth-write
 * pipeline this fixture doesn't stub) — used by F3 to give two primitives
 * of one model genuinely distinct `getPipeline(alphaMode, doubleSided, ...)`
 * material identities, rather than relying on call-ordinal counting, which
 * does not match how many times the real cache-refetch guard actually
 * calls `getPipeline` per primitive.
 *
 * @param {boolean} [doubleSided=false] The primitive's material.doubleSided.
 * @returns {object} The runtime primitive.
 */
function makeMinimalRuntimePrimitive(
  doubleSided = false,
  metadata = false,
  alphaMode,
) {
  const attributes = [
    {
      semantic: "POSITION",
      typedArray: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    },
  ];
  if (metadata) {
    attributes.push({
      name: "_TEMPERATURE",
      semantic: "_TEMPERATURE",
      type: "SCALAR",
      componentDatatype: "FLOAT",
      typedArray: new Float32Array([10, 20, 30]),
    });
  }
  return {
    primitive: {
      attributes,
      material: { doubleSided, alphaMode },
    },
  };
}

/**
 * A minimal admitted `model` fixture wired to `pipelineCache` via a
 * pre-seeded `_webgpuCache` — which skips `updateWebGPUModel`'s own
 * `if (!defined(model._webgpuCache))` cache-CONSTRUCTION branch entirely,
 * the same branch a model on its second-and-later update takes in
 * production (construction is a one-time event on the first frame; this
 * fixture exercises the steady-state branch, which is what a model whose
 * colour pipeline hasn't resolved yet necessarily is — it is already past
 * its first frame).
 *
 * @param {object} device The fake device.
 * @param {object} pipelineCache From {@link makeBarePipelineCache}.
 * @param {object[]} runtimePrimitives One or more from
 *   {@link makeMinimalRuntimePrimitive}.
 * @returns {object} The model fixture.
 */
function makeMinimalModel(device, pipelineCache, runtimePrimitives, metadata) {
  const modelWebGPUCache = {
    device,
    resourceGeneration: 1,
    pipelineCache,
    _enqueueTextureMipGeneration: undefined,
    _cancelTextureMipGeneration: undefined,
    cameraData: null,
    lightData: null,
    primitives: {},
    geometryViews: {},
    nodes: {},
  };
  return {
    show: true,
    ready: true,
    customShader: undefined,
    classificationType: undefined,
    _content: undefined,
    _cull: true,
    _minimumPixelSize: 0,
    shadows: 0, // ShadowMode.DISABLED
    isInvisible() {
      return false;
    },
    splitDirection: 0, // SplitDirection.NONE
    color: undefined,
    silhouetteSize: 0,
    modelMatrix: undefined,
    allowPicking: true,
    structuralMetadata: metadata
      ? {
          propertyAttributes: [
            {
              properties: {
                temperature: {
                  attribute: "_TEMPERATURE",
                  classProperty: {
                    id: "temperature",
                    type: "SCALAR",
                    componentType: "FLOAT32",
                    valueType: "FLOAT32",
                    normalized: false,
                    isArray: false,
                    isVariableLengthArray: false,
                    arrayLength: undefined,
                    hasValueTransform: false,
                    offset: undefined,
                    scale: undefined,
                    isGpuCompatible() {
                      return true;
                    },
                  },
                  hasValueTransform: false,
                  offset: undefined,
                  scale: undefined,
                },
              },
            },
          ],
        }
      : undefined,
    _webgpuCache: modelWebGPUCache,
    _sceneGraph: {
      _runtimeNodes: [{ runtimePrimitives }],
      _computedModelMatrix: undefined,
    },
  };
}

/**
 * A minimal admitted `frameState`: five real axis-aligned planes forming a
 * huge box around the origin, so the model's `BoundingSphere(origin, 1)`
 * intersects the culling volume; a real `BoundingSphere` and `Cartesian3`
 * for the model bound and camera position.
 *
 * `passes.pick` is the one lever that controls `pickDemand` inside the
 * per-primitive loop (`passes?.pick === true && !isClassifier &&
 * model.allowPicking !== false`) — it does NOT block admission the way it
 * might look like it should: `classifyWebGPUModelPreparationDemand`
 * classifies a `passes.pick !== false` frame as the CONSERVATIVE demand
 * (not REJECTED), and only a REJECTED classification stops
 * `updateWebGPUModel` early. A pick-pass frame still runs the full
 * per-primitive loop.
 *
 * @param {Record<string, unknown>} namespace The bundled barrel namespace.
 * @param {object} context From {@link makeBareContext}.
 * @param {boolean} pick Whether `frameState.passes.pick` is `true`.
 * @returns {object} The frameState fixture.
 */
function makeMinimalFrameState(namespace, context, pick, options = {}) {
  function plane(x, y, z, w) {
    return { x, y, z, w };
  }
  return {
    context,
    commandList: [],
    commandsDeferred: 0,
    mode: namespace.SceneModeEnum.SCENE3D,
    frameNumber: 1,
    cameraUnderground: false,
    passes: {
      render: true,
      pick,
      pickVoxel: false,
      offscreen: false,
      ...options.passes,
    },
    pickingMetadata: options.pickingMetadata,
    pickedMetadataInfo: options.pickedMetadataInfo,
    scene: options.scene,
    shadowMaps: [],
    cullingVolume: {
      planes: [
        plane(1, 0, 0, 1000),
        plane(-1, 0, 0, 1000),
        plane(0, 1, 0, 1000),
        plane(0, -1, 0, 1000),
        plane(0, 0, 1, 1000),
      ],
    },
    camera: { positionWC: new namespace.Cartesian3(-10, -10, -10) },
  };
}

/**
 * A bare `Scene` instance whose only set field is `_context`. Every other
 * field `getDebugSnapshot()` reads is either optional-chained or guarded by
 * `defined(...) && typeof x === "function"` immediately followed by a
 * `try { } catch { }`, so leaving them `undefined` is safe.
 *
 * @param {Record<string, unknown>} namespace The bundled barrel namespace.
 * @param {object} context The bare context.
 * @returns {object} The bare scene instance.
 */
function makeBareScene(namespace, context) {
  const scene = Object.create(namespace.Scene.prototype);
  scene._context = context;
  scene._frameState = { frameNumber: 1 };
  return scene;
}

/**
 * Executes the REAL `Scene.prototype.getDebugSnapshot` against a bare scene
 * wired to `context`, and returns `snapshot.renderer.modelPick` — the exact
 * publication path a browser caller reads
 * (`viewer.scene.getDebugSnapshot().renderer.modelPick`).
 *
 * @param {Record<string, unknown>} namespace The bundled barrel namespace.
 * @param {object} context The bare context whose counters to read.
 * @returns {object|undefined} `snapshot.renderer.modelPick`.
 */
function readModelPickThroughSnapshot(namespace, context) {
  const scene = makeBareScene(namespace, context);
  const snapshot = namespace.Scene.prototype.getDebugSnapshot.call(scene);
  assert.ok(
    snapshot && typeof snapshot === "object" && "renderer" in snapshot,
    "getDebugSnapshot() must publish a `renderer` key — the real method " +
      "shape this spec depends on has moved",
  );
  assert.ok(
    snapshot.renderer && !("error" in snapshot.renderer),
    () =>
      `getRendererStatistics() threw: ${snapshot.renderer?.error} — the ` +
      `fixture is missing something getRendererStatistics reads`,
  );
  return snapshot.renderer?.modelPick;
}

/**
 * A queue-backed `performance.now` fake: each call returns the next queued
 * value and throws if called more times than the sequence provides.
 *
 * @param {number[]} sequence Values to return, in call order.
 * @returns {() => number} The fake `now`.
 */
function queuedNow(sequence) {
  let i = 0;
  return () => {
    if (i >= sequence.length) {
      throw new Error(
        `performance.now() called more times than expected (${sequence.length})`,
      );
    }
    return sequence[i++];
  };
}

/**
 * Runs `fn` with `globalThis.performance.now` replaced, restoring the
 * original afterward even if `fn` throws.
 *
 * @param {() => number} now The fake `now`.
 * @param {Function} fn The function to run under the fake.
 * @returns {Promise<unknown>} `fn`'s return value.
 */
async function withFakeNow(now, fn) {
  const original = globalThis.performance.now.bind(globalThis.performance);
  globalThis.performance.now = now;
  try {
    return await fn();
  } finally {
    globalThis.performance.now = original;
  }
}

// ─────────────── group A: allocation, reset-at-boundary, increments ─────────

test("A1 initial snapshot reads all-zero, read through Scene.getDebugSnapshot()", async () => {
  const namespace = await importBarrel();
  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(modelPick, {
    readyGateSkipsThisFrame: 0,
    pickCommandsEmittedThisFrame: 0,
    countersFrameNumber: -1,
    getPickPipelineCalls: 0,
    createPickPipelineWallTimeMs: 0,
  });
});

test("A2 frame N has nonzero values; frame N+1 crosses the real boundary with no events; the snapshot reports both per-frame counters zero", async () => {
  const namespace = await importBarrel();
  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);

  namespace.resetModelPickDebugCountersForFrame(5);
  namespace.recordModelPickReadyGateSkip();
  namespace.recordModelPickReadyGateSkip();
  namespace.recordModelPickCommandEmitted();

  let modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(
    modelPick,
    {
      readyGateSkipsThisFrame: 2,
      pickCommandsEmittedThisFrame: 1,
      countersFrameNumber: 5,
      getPickPipelineCalls: 0,
      createPickPipelineWallTimeMs: 0,
    },
    "frame 5 must show its own nonzero counts, read through the snapshot",
  );

  // Frame N+1 — the real boundary function, called with NO model-pick
  // events in between.
  namespace.resetModelPickDebugCountersForFrame(6);
  modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(modelPick, {
    readyGateSkipsThisFrame: 0,
    pickCommandsEmittedThisFrame: 0,
    countersFrameNumber: 6,
    getPickPipelineCalls: 0,
    createPickPipelineWallTimeMs: 0,
  });
});

test("A3 the two cumulative fields are untouched by a frame-boundary reset", async () => {
  const namespace = await importBarrel();
  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);

  namespace.recordGetPickPipelineCall();
  namespace.recordGetPickPipelineCall();
  namespace.recordCreatePickPipelineWallTime(2.5);
  namespace.recordCreatePickPipelineWallTime(1.5);
  namespace.resetModelPickDebugCountersForFrame(9);
  namespace.resetModelPickDebugCountersForFrame(10);

  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(modelPick, {
    readyGateSkipsThisFrame: 0,
    pickCommandsEmittedThisFrame: 0,
    countersFrameNumber: 10,
    getPickPipelineCalls: 2,
    createPickPipelineWallTimeMs: 4,
  });
});

test("WCX0 WebGPUContext.beginFrame() wires the real reset call at the renderer's existing frame-statistics reset point", () => {
  const startAnchor = "this._frameCount++;";
  const resetAnchor = "resetModelPickDebugCountersForFrame(this._frameCount);";
  const idx1 = WEBGPU_CONTEXT_SOURCE.indexOf(startAnchor);
  assert.notEqual(idx1, -1, "the `_frameCount++` anchor has moved");
  const idx2 = WEBGPU_CONTEXT_SOURCE.indexOf(resetAnchor, idx1);
  assert.notEqual(
    idx2,
    -1,
    "resetModelPickDebugCountersForFrame(this._frameCount) must appear " +
      "after this._frameCount++ in beginFrame() — the reset must run once " +
      "per frame at the SAME point the renderer resets its other per-frame " +
      "statistics, never lazily on the first counted event",
  );
  const between = WEBGPU_CONTEXT_SOURCE.slice(idx1 + startAnchor.length, idx2);
  assert.ok(
    between.length < 200,
    "the reset call must sit immediately after `_frameCount++`, not buried " +
      "deep in beginFrame() where its ordering relative to other resets " +
      "would be unclear",
  );
});

test("A4 mutant: an inert reset leaves the frame-N values in place instead of zeroing them", async () => {
  const resetOriginal = [
    "function resetModelPickDebugCountersForFrame(frameNumber: number): void {",
    "  //>>includeStart('debug', pragmas.debug);",
    "  modelPickDebugCounters.countersFrameNumber = frameNumber;",
    "  modelPickDebugCounters.readyGateSkipsThisFrame = 0;",
    "  modelPickDebugCounters.pickCommandsEmittedThisFrame = 0;",
    "  //>>includeEnd('debug');",
    "}",
  ].join("\n");
  const resetInert = [
    "function resetModelPickDebugCountersForFrame(frameNumber: number): void {",
    "  //>>includeStart('debug', pragmas.debug);",
    "  if (false) {",
    "    modelPickDebugCounters.countersFrameNumber = frameNumber;",
    "    modelPickDebugCounters.readyGateSkipsThisFrame = 0;",
    "    modelPickDebugCounters.pickCommandsEmittedThisFrame = 0;",
    "  }",
    "  //>>includeEnd('debug');",
    "}",
  ].join("\n");
  const namespace = await importBarrel([
    {
      path: PIPELINE_CACHE_PATH,
      label: "inert-reset",
      mutate: (source) => source.replace(resetOriginal, resetInert),
    },
  ]);

  namespace.resetModelPickDebugCountersForFrame(1);
  namespace.recordModelPickReadyGateSkip();
  namespace.recordModelPickReadyGateSkip();
  namespace.recordModelPickCommandEmitted();

  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  const beforeInertReset = readModelPickThroughSnapshot(namespace, context);
  assert.equal(beforeInertReset.readyGateSkipsThisFrame, 2);

  namespace.resetModelPickDebugCountersForFrame(2);
  const afterInertReset = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(
    afterInertReset,
    beforeInertReset,
    "vacuity check: with the reset made unreachable the counters must " +
      "stay exactly as frame 1 left them, otherwise A2 was passing for " +
      "some other reason",
  );
});

test("A5 mutant: wrapping every record increment in `if (false && ...)` leaves every field at 0", async () => {
  const pairs = [
    [
      [
        "function recordModelPickReadyGateSkip(): void {",
        "  //>>includeStart('debug', pragmas.debug);",
        "  modelPickDebugCounters.readyGateSkipsThisFrame++;",
        "  //>>includeEnd('debug');",
        "}",
      ].join("\n"),
      [
        "function recordModelPickReadyGateSkip(): void {",
        "  //>>includeStart('debug', pragmas.debug);",
        "  if (false) {",
        "    modelPickDebugCounters.readyGateSkipsThisFrame++;",
        "  }",
        "  //>>includeEnd('debug');",
        "}",
      ].join("\n"),
    ],
    [
      [
        "function recordModelPickCommandEmitted(): void {",
        "  //>>includeStart('debug', pragmas.debug);",
        "  modelPickDebugCounters.pickCommandsEmittedThisFrame++;",
        "  //>>includeEnd('debug');",
        "}",
      ].join("\n"),
      [
        "function recordModelPickCommandEmitted(): void {",
        "  //>>includeStart('debug', pragmas.debug);",
        "  if (false) {",
        "    modelPickDebugCounters.pickCommandsEmittedThisFrame++;",
        "  }",
        "  //>>includeEnd('debug');",
        "}",
      ].join("\n"),
    ],
    [
      [
        "function recordGetPickPipelineCall(): void {",
        "  //>>includeStart('debug', pragmas.debug);",
        "  modelPickDebugCounters.getPickPipelineCalls++;",
        "  //>>includeEnd('debug');",
        "}",
      ].join("\n"),
      [
        "function recordGetPickPipelineCall(): void {",
        "  //>>includeStart('debug', pragmas.debug);",
        "  if (false) {",
        "    modelPickDebugCounters.getPickPipelineCalls++;",
        "  }",
        "  //>>includeEnd('debug');",
        "}",
      ].join("\n"),
    ],
    [
      [
        "function recordCreatePickPipelineWallTime(elapsedMs: number): void {",
        "  //>>includeStart('debug', pragmas.debug);",
        "  modelPickDebugCounters.createPickPipelineWallTimeMs += elapsedMs;",
        "  //>>includeEnd('debug');",
        "}",
      ].join("\n"),
      [
        "function recordCreatePickPipelineWallTime(elapsedMs: number): void {",
        "  //>>includeStart('debug', pragmas.debug);",
        "  if (false && elapsedMs >= 0) {",
        "    modelPickDebugCounters.createPickPipelineWallTimeMs += elapsedMs;",
        "  }",
        "  //>>includeEnd('debug');",
        "}",
      ].join("\n"),
    ],
  ];
  const namespace = await importBarrel([
    {
      path: PIPELINE_CACHE_PATH,
      label: "inert-all-four-record-functions",
      mutate: (source) => {
        let rewritten = source;
        for (const [original, inert] of pairs) {
          assert.ok(
            rewritten.includes(original),
            `a record-function anchor not found (starts "${original.slice(0, 40)}") — it has moved`,
          );
          rewritten = rewritten.replace(original, inert);
        }
        return rewritten;
      },
    },
  ]);

  namespace.resetModelPickDebugCountersForFrame(1);
  namespace.recordModelPickReadyGateSkip();
  namespace.recordModelPickCommandEmitted();
  namespace.recordGetPickPipelineCall();
  namespace.recordCreatePickPipelineWallTime(9.9);

  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(
    modelPick,
    {
      readyGateSkipsThisFrame: 0,
      pickCommandsEmittedThisFrame: 0,
      countersFrameNumber: 1,
      getPickPipelineCalls: 0,
      createPickPipelineWallTimeMs: 0,
    },
    "vacuity check: with every increment made unreachable every field must " +
      "read 0 despite being recorded against",
  );
});

// ───────── group C: `getPickPipeline` wiring, read through the snapshot ─────

test("C1 a pick-pipeline miss increments the call count and adds positive wall time, read through the snapshot", async () => {
  const namespace = await importBarrel();
  const { device, pipelines } = makeFakeDevice();
  const instance = makeBarePipelineCache(namespace, device, () => null);
  const context = makeBareContext(namespace, device);

  await withFakeNow(queuedNow([1000, 1002.5]), () => {
    const pipeline = instance.getPickPipeline(0, false, 0);
    assert.ok(pipeline, "a miss must still return a pipeline");
  });

  assert.equal(
    pipelines.length,
    1,
    "a miss must call device.createRenderPipeline exactly once",
  );
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(modelPick, {
    readyGateSkipsThisFrame: 0,
    pickCommandsEmittedThisFrame: 0,
    countersFrameNumber: -1,
    getPickPipelineCalls: 1,
    createPickPipelineWallTimeMs: 2.5,
  });
});

test("C2 a repeat call with the same identity is a cache hit: no rebuild, no new wall time, call count still rises", async () => {
  const namespace = await importBarrel();
  const { device, pipelines } = makeFakeDevice();
  const instance = makeBarePipelineCache(namespace, device, () => null);
  const context = makeBareContext(namespace, device);

  await withFakeNow(queuedNow([1000, 1002.5]), () =>
    instance.getPickPipeline(0, false, 0),
  );
  const hitPipeline = await withFakeNow(queuedNow([]), () =>
    instance.getPickPipeline(0, false, 0),
  );

  assert.ok(hitPipeline, "a hit must still return the cached pipeline");
  assert.equal(pipelines.length, 1, "a hit must not rebuild");
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(modelPick, {
    readyGateSkipsThisFrame: 0,
    pickCommandsEmittedThisFrame: 0,
    countersFrameNumber: -1,
    getPickPipelineCalls: 2,
    createPickPipelineWallTimeMs: 2.5,
  });
});

test("C3 a different material identity is its own miss", async () => {
  const namespace = await importBarrel();
  const { device, pipelines } = makeFakeDevice();
  const instance = makeBarePipelineCache(namespace, device, () => null);
  const context = makeBareContext(namespace, device);

  await withFakeNow(queuedNow([1000, 1001]), () =>
    instance.getPickPipeline(0, false, 0),
  );
  await withFakeNow(queuedNow([2000, 2004]), () =>
    instance.getPickPipeline(2, false, 0),
  );

  assert.equal(pipelines.length, 2);
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(modelPick, {
    readyGateSkipsThisFrame: 0,
    pickCommandsEmittedThisFrame: 0,
    countersFrameNumber: -1,
    getPickPipelineCalls: 2,
    createPickPipelineWallTimeMs: 1 + 4,
  });
});

test("C4 the timer wraps only createPickPipeline: a caller-side dependency lookup that itself costs time is NOT counted", async () => {
  const namespace = await importBarrel();
  const { device, pipelines } = makeFakeDevice();
  const instance = makeBarePipelineCache(namespace, device, () => null);
  const context = makeBareContext(namespace, device);

  let shaderModuleLookupCost = 0;
  instance._getOrCreateShaderModule = () => {
    shaderModuleLookupCost = globalThis.performance.now();
    return { __kind: "shaderModule" };
  };

  await withFakeNow(queuedNow([500, 1000, 1002.5]), () => {
    instance.getPickPipeline(0, false, 0);
  });

  assert.equal(
    shaderModuleLookupCost,
    500,
    "the shader-module lookup's own performance.now() read must be the FIRST one consumed",
  );
  assert.equal(pipelines.length, 1);
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.equal(
    modelPick.createPickPipelineWallTimeMs,
    2.5,
    "wall time must be exactly the (1000 -> 1002.5) span inside " +
      "createPickPipeline, excluding the shader-module lookup's own " +
      "500ms-flagged read entirely",
  );
});

// ── group F: the REAL, complete `updateWebGPUModel` — not an extracted or ──
// ── hand-copied fragment. Every scenario below calls the real exported ──
// ── function through the real per-node/per-primitive loop, real ready ──
// ── gate, and real pick-command construction. ──────────────────────────────

test("F1 a pending colour pipeline with ordinary pick demand emits exactly one non-null native pickOnly carrier and records it through the snapshot", async () => {
  const namespace = await importBarrel();
  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  namespace.resetModelPickDebugCountersForFrame(1);

  const pipelineCache = makeBarePipelineCache(namespace, device, () => null);
  const model = makeMinimalModel(device, pipelineCache, [
    makeMinimalRuntimePrimitive(),
  ]);
  const frameState = makeMinimalFrameState(namespace, context, true);

  namespace.updateWebGPUModel(model, frameState);

  assert.equal(frameState.commandList.length, 1);
  const [carrier] = frameState.commandList;
  assert.equal(carrier.pickOnly, true);
  assert.ok(
    carrier.pipeline,
    "the pending pick carrier must have a real synchronous pipeline",
  );
  assert.equal(
    carrier.derivedCommands?.picking?.pickCommand,
    undefined,
    "the carrier itself is the one ordinary-pick payload; attaching another one duplicates work",
  );
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(modelPick, {
    readyGateSkipsThisFrame: 1,
    pickCommandsEmittedThisFrame: 1,
    countersFrameNumber: 1,
    getPickPipelineCalls: 1,
    createPickPipelineWallTimeMs: modelPick.createPickPipelineWallTimeMs,
  });
  assert.ok(modelPick.createPickPipelineWallTimeMs >= 0);
});

test("F2 a resolved colour pipeline keeps one colour carrier with one non-null ordinary pick derivative — no duplicate top-level pick command", async () => {
  const namespace = await importBarrel();
  const { device, pipelines } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  namespace.resetModelPickDebugCountersForFrame(1);

  const pipelineCache = makeBarePipelineCache(namespace, device, () => ({
    __kind: "colorPipeline",
  }));
  const model = makeMinimalModel(device, pipelineCache, [
    makeMinimalRuntimePrimitive(),
  ]);
  const frameState = makeMinimalFrameState(namespace, context, true);

  namespace.updateWebGPUModel(model, frameState);

  assert.equal(frameState.commandList.length, 1);
  const [colorCommand] = frameState.commandList;
  assert.equal(colorCommand.pickOnly, false);
  assert.ok(colorCommand.pipeline);
  assert.ok(colorCommand.derivedCommands?.picking?.pickCommand?.pipeline);
  assert.equal(colorCommand.derivedCommands.picking.pickCommand.pickOnly, true);
  assert.equal(
    pipelines.length,
    1,
    "the real getPickPipeline -> createPickPipeline chain must call the " +
      "real device.createRenderPipeline exactly once for this primitive's " +
      "first pick",
  );
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.equal(modelPick.readyGateSkipsThisFrame, 0);
  assert.equal(modelPick.pickCommandsEmittedThisFrame, 1);
  assert.equal(modelPick.getPickPipelineCalls, 1);
  assert.ok(
    modelPick.createPickPipelineWallTimeMs >= 0,
    "wall time is a real performance.now() delta around the real synchronous build, not a mocked value",
  );
});

test("F3 a mixed pending/resolved frame emits one carrier per primitive, never skips demanded pending picking, and counts two payloads", async () => {
  const namespace = await importBarrel();
  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  namespace.resetModelPickDebugCountersForFrame(1);

  // Keyed on the real `doubleSided` argument the cache-refetch guard calls
  // getPipeline with, not on call ordinal: the guard's own re-fetch
  // conditions (`primCache._pipelineNeedsRefetch`, an error-generation
  // mismatch) mean a single primitive can legitimately call getPipeline
  // more than once within one updateWebGPUModel run, so counting calls
  // does not reliably identify WHICH primitive is being asked about.
  // doubleSided=true (primitive 0) is still cooking; doubleSided=false
  // (primitive 1) is resolved.
  const pipelineCache = makeBarePipelineCache(
    namespace,
    device,
    (alphaMode, doubleSided) =>
      doubleSided ? null : { __kind: "colorPipeline" },
  );
  const model = makeMinimalModel(device, pipelineCache, [
    makeMinimalRuntimePrimitive(true),
    makeMinimalRuntimePrimitive(false),
  ]);
  const frameState = makeMinimalFrameState(namespace, context, true);

  namespace.updateWebGPUModel(model, frameState);

  assert.equal(frameState.commandList.length, 2);
  assert.equal(frameState.commandList[0].pickOnly, true);
  assert.equal(frameState.commandList[1].pickOnly, false);
  assert.ok(frameState.commandList[0].pipeline);
  assert.ok(
    frameState.commandList[1].derivedCommands?.picking?.pickCommand?.pipeline,
  );
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.deepEqual(modelPick, {
    readyGateSkipsThisFrame: 1,
    pickCommandsEmittedThisFrame: 2,
    countersFrameNumber: 1,
    getPickPipelineCalls: 2,
    createPickPipelineWallTimeMs: modelPick.createPickPipelineWallTimeMs,
  });
  assert.ok(modelPick.createPickPipelineWallTimeMs >= 0);
});

test("F3a a pending metadata pass uses its metadata derivative through the real dispatcher and never falls back to an ordinary pick payload", async () => {
  const namespace = await importBarrel();
  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  namespace.resetModelPickDebugCountersForFrame(1);
  const pipelineCache = makeBarePipelineCache(namespace, device, () => null);
  pipelineCache.setMetadataPickWGSL = () => {};
  pipelineCache.getPickMetadataPipeline = () => ({
    __kind: "metadataPickPipeline",
  });
  const model = makeMinimalModel(
    device,
    pipelineCache,
    [makeMinimalRuntimePrimitive(false, true)],
    true,
  );
  const scene = { highDynamicRange: false };
  const frameState = makeMinimalFrameState(namespace, context, true, {
    pickingMetadata: true,
    pickedMetadataInfo: { propertyName: "temperature" },
    scene,
  });
  scene.frameState = frameState;

  namespace.updateWebGPUModel(model, frameState);

  assert.equal(frameState.commandList.length, 1);
  const [carrier] = frameState.commandList;
  assert.equal(carrier.pickOnly, true);
  const metadataCommand =
    carrier.derivedCommands?.pickingMetadata?.pickMetadataCommand;
  assert.ok(
    metadataCommand?.pipeline,
    "metadata demand needs a non-null metadata derivative",
  );
  assert.equal(
    carrier.derivedCommands?.picking?.pickCommand,
    undefined,
    "metadata dispatch must not attach a duplicate derived ordinary-pick payload",
  );
  assert.strictEqual(
    namespace.selectCommandVariant(carrier, scene, true),
    metadataCommand,
    "the real dispatcher must select the metadata derivative, not the carrier or ordinary pick",
  );
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.equal(modelPick.readyGateSkipsThisFrame, 1);
  assert.equal(modelPick.pickCommandsEmittedThisFrame, 1);
});

test("F3b no pick demand, allowPicking=false, and classifiers allocate no pick payload or pick counters", async () => {
  const cases = [
    {
      name: "no demand",
      configure(model) {
        model.allowPicking = true;
      },
      pick: false,
    },
    {
      name: "allowPicking false",
      configure(model) {
        model.allowPicking = false;
      },
      pick: true,
    },
    {
      name: "classifier",
      configure(model) {
        model.classificationType = 0;
      },
      pick: true,
    },
  ];
  for (const scenario of cases) {
    const namespace = await importBarrel();
    const { device } = makeFakeDevice();
    const context = makeBareContext(namespace, device);
    namespace.resetModelPickDebugCountersForFrame(1);
    const pipelineCache = makeBarePipelineCache(namespace, device, () => null);
    const model = makeMinimalModel(device, pipelineCache, [
      makeMinimalRuntimePrimitive(),
    ]);
    scenario.configure(model);
    const frameState = makeMinimalFrameState(namespace, context, scenario.pick);
    namespace.updateWebGPUModel(model, frameState);
    for (const command of frameState.commandList) {
      assert.equal(
        command.pickOnly,
        false,
        `${scenario.name} must not emit a pickOnly carrier`,
      );
      assert.equal(command.derivedCommands?.picking?.pickCommand, undefined);
    }
    const modelPick = readModelPickThroughSnapshot(namespace, context);
    assert.equal(modelPick.pickCommandsEmittedThisFrame, 0, scenario.name);
    assert.equal(modelPick.getPickPipelineCalls, 0, scenario.name);
  }
});

test("F3c resolved pick preserves snap and precise-pass-2 derivatives without creating a second carrier", async () => {
  const namespace = await importBarrel();
  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  namespace.resetModelPickDebugCountersForFrame(1);
  const pipelineCache = makeBarePipelineCache(namespace, device, () => ({
    __kind: "colorPipeline",
  }));
  pipelineCache.getDepthWritePipeline = () => ({
    __kind: "depthWritePipeline",
  });
  pipelineCache.getSnapPipeline = () => ({ __kind: "snapPipeline" });
  pipelineCache.getPickPrecisePass1Pipeline = () => ({
    __kind: "precisePass1Pipeline",
  });
  pipelineCache.getPickPrecisePass2Pipeline = () => ({
    __kind: "precisePass2Pipeline",
  });
  const model = makeMinimalModel(device, pipelineCache, [
    makeMinimalRuntimePrimitive(false, false, "BLEND"),
  ]);
  const frameState = makeMinimalFrameState(namespace, context, true, {
    passes: { snap: true, pickMode: "precise" },
    scene: { _webgpuPickPreciseEnabled: true },
  });
  namespace.updateWebGPUModel(model, frameState);
  assert.equal(frameState.commandList.length, 1);
  const [colorCommand] = frameState.commandList;
  assert.ok(colorCommand.derivedCommands?.snapping?.snapCommand?.pipeline);
  assert.ok(
    colorCommand.derivedCommands?.picking?.pickPrecisePass1Command?.pipeline,
  );
  assert.ok(
    colorCommand.derivedCommands?.picking?.pickPrecisePass2Command?.pipeline,
  );
  assert.equal(
    colorCommand.derivedCommands.picking.pickPrecisePass2Command.pickOnly,
    true,
  );
});

/**
 * F1's exact check, factored out so the mutant test (F4) can reuse the
 * IDENTICAL assertion — not a separately-authored "expect zero" test —
 * against a bundle with the real ready-gate call site made unreachable, and
 * require it to throw.
 *
 * @param {Record<string, unknown>} namespace The bundled barrel namespace.
 */
function assertReadyGateSkipRecordedByRealUpdate(namespace) {
  const { device } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  namespace.resetModelPickDebugCountersForFrame(1);
  const pipelineCache = makeBarePipelineCache(namespace, device, () => null);
  const model = makeMinimalModel(device, pipelineCache, [
    makeMinimalRuntimePrimitive(),
  ]);
  const frameState = makeMinimalFrameState(namespace, context, true);
  namespace.updateWebGPUModel(model, frameState);
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.equal(
    modelPick.readyGateSkipsThisFrame,
    1,
    "the real updateWebGPUModel run must record one ready-gate skip",
  );
}

/**
 * F2's exact check, factored out for the same reason as
 * {@link assertReadyGateSkipRecordedByRealUpdate}.
 *
 * @param {Record<string, unknown>} namespace The bundled barrel namespace.
 */
function assertPickEmissionRecordedByRealUpdate(namespace) {
  const { device, pipelines } = makeFakeDevice();
  const context = makeBareContext(namespace, device);
  namespace.resetModelPickDebugCountersForFrame(1);
  const pipelineCache = makeBarePipelineCache(namespace, device, () => ({
    __kind: "colorPipeline",
  }));
  const model = makeMinimalModel(device, pipelineCache, [
    makeMinimalRuntimePrimitive(),
  ]);
  const frameState = makeMinimalFrameState(namespace, context, true);
  namespace.updateWebGPUModel(model, frameState);
  assert.equal(
    frameState.commandList.length,
    1,
    "the colour command must still be emitted — only the pick-emission " +
      "counter call site is the mutation target",
  );
  assert.equal(
    pipelines.length,
    1,
    "the pick pipeline must still be built for real — the draw path is not what's mutated",
  );
  const modelPick = readModelPickThroughSnapshot(namespace, context);
  assert.equal(
    modelPick.pickCommandsEmittedThisFrame,
    1,
    "the real updateWebGPUModel run must record one pick emission",
  );
}

test("F4 mutant: the SAME assertion F1 uses fails when the real ready-gate call site is made unreachable in the real updateWebGPUModel run", async () => {
  const nominal = await importBarrel();
  // Sanity — the unmutated bundle passes.
  assertReadyGateSkipRecordedByRealUpdate(nominal);

  const original = "recordModelPickReadyGateSkip();";
  const inert = "if (false) { recordModelPickReadyGateSkip(); }";
  const mutated = await importBarrel([
    {
      path: MODEL_RENDERER_PATH,
      label: "inert-ready-gate-call-real-update",
      mutate: (source) => {
        assert.ok(
          source.includes(original),
          "the ready-gate call-site anchor has moved",
        );
        return source.replace(original, inert);
      },
    },
  ]);
  assert.throws(
    () => assertReadyGateSkipRecordedByRealUpdate(mutated),
    /AssertionError|strict/i,
    "RED required: F1's own assertion, run against a REAL updateWebGPUModel " +
      "execution over the mutated real file, must throw",
  );
});

test("F5 mutant: the SAME assertion F2 uses fails when the real pick-emission call site is made unreachable in the real updateWebGPUModel run", async () => {
  const nominal = await importBarrel();
  assertPickEmissionRecordedByRealUpdate(nominal);

  const original = [
    "        attachPickToColorCommand(webgpuCmd, pickCmd);",
    "        //>>includeStart('debug', pragmas.debug);",
    "        recordModelPickCommandEmitted();",
    "        //>>includeEnd('debug');",
  ].join("\n");
  const inert = [
    "        attachPickToColorCommand(webgpuCmd, pickCmd);",
    "        //>>includeStart('debug', pragmas.debug);",
    "        if (false) { recordModelPickCommandEmitted(); }",
    "        //>>includeEnd('debug');",
  ].join("\n");
  const mutated = await importBarrel([
    {
      path: MODEL_RENDERER_PATH,
      label: "inert-pick-emission-call-real-update",
      mutate: (source) => {
        assert.ok(
          source.includes(original),
          "the resolved-color pick-emission call-site anchor has moved",
        );
        return source.replace(original, inert);
      },
    },
  ]);
  assert.throws(
    () => assertPickEmissionRecordedByRealUpdate(mutated),
    /AssertionError|strict/i,
    "RED required: F2's own assertion, run against a REAL updateWebGPUModel " +
      "execution over the mutated real file, must throw — the colour " +
      "command and the real pick-pipeline build (asserted inside the same " +
      "function, before the counter check) still succeed; only the counter " +
      "call site is unreachable",
  );
});

test("F6 mutant: making the dedicated pending carrier append unreachable makes the pending ordinary-pick assertion red", async () => {
  function assertPendingCarrier(namespace) {
    const { device } = makeFakeDevice();
    const context = makeBareContext(namespace, device);
    namespace.resetModelPickDebugCountersForFrame(1);
    const pipelineCache = makeBarePipelineCache(namespace, device, () => null);
    const model = makeMinimalModel(device, pipelineCache, [
      makeMinimalRuntimePrimitive(),
    ]);
    const frameState = makeMinimalFrameState(namespace, context, true);
    namespace.updateWebGPUModel(model, frameState);
    assert.equal(frameState.commandList.length, 1);
    assert.equal(frameState.commandList[0].pickOnly, true);
    assert.ok(frameState.commandList[0].pipeline);
  }

  const nominal = await importBarrel();
  assertPendingCarrier(nominal);
  const append = "frameState.commandList.push(pendingPickCommand);";
  const mutated = await importBarrel([
    {
      path: MODEL_RENDERER_PATH,
      label: "inert-pending-pick-carrier-append",
      mutate: (source) => {
        assert.ok(
          source.includes(append),
          "the dedicated pending-carrier append anchor has moved",
        );
        return source.replace(append, `if (false) { ${append} }`);
      },
    },
  ]);
  assert.throws(
    () => assertPendingCarrier(mutated),
    /AssertionError|strict/i,
    "RED required: making the real pending-carrier append unreachable must break the same ordinary-pick assertion",
  );
});

test("F7 mutant: making the real metadata attachment inert makes metadata dispatch fall back instead of selecting the derivative", async () => {
  async function assertPendingMetadataDispatch(namespace) {
    const { device } = makeFakeDevice();
    const context = makeBareContext(namespace, device);
    const pipelineCache = makeBarePipelineCache(namespace, device, () => null);
    pipelineCache.setMetadataPickWGSL = () => {};
    pipelineCache.getPickMetadataPipeline = () => ({
      __kind: "metadataPickPipeline",
    });
    const model = makeMinimalModel(
      device,
      pipelineCache,
      [makeMinimalRuntimePrimitive(false, true)],
      true,
    );
    const scene = { highDynamicRange: false };
    const frameState = makeMinimalFrameState(namespace, context, true, {
      pickingMetadata: true,
      pickedMetadataInfo: { propertyName: "temperature" },
      scene,
    });
    scene.frameState = frameState;
    namespace.updateWebGPUModel(model, frameState);
    assert.equal(frameState.commandList.length, 1);
    const [carrier] = frameState.commandList;
    const metadataCommand =
      carrier.derivedCommands?.pickingMetadata?.pickMetadataCommand;
    assert.ok(metadataCommand?.pipeline);
    assert.equal(carrier.derivedCommands?.picking?.pickCommand, undefined);
    assert.strictEqual(
      namespace.selectCommandVariant(carrier, scene, true),
      metadataCommand,
    );
  }

  const nominal = await importBarrel();
  await assertPendingMetadataDispatch(nominal);
  const attachment = "derived.pickingMetadata = { pickMetadataCommand };";
  const mutated = await importBarrel([
    {
      path: PICK_HELPERS_PATH,
      label: "inert-pending-metadata-attachment",
      mutate: (source) => {
        assert.ok(
          source.includes(attachment),
          "the metadata attachment anchor has moved",
        );
        return source.replace(attachment, `if (false) { ${attachment} }`);
      },
    },
  ]);
  await assert.rejects(
    () => assertPendingMetadataDispatch(mutated),
    /AssertionError|strict/i,
    "RED required: the same metadata-dispatch assertion must reject after its real attachment is made unreachable",
  );
});
