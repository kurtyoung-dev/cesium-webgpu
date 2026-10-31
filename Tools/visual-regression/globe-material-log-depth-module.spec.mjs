// globe-material-log-depth-module.spec.mjs - NEW-WATER-GLOBE-MATERIAL-WATER-MASK-TILE-EDGE-SEAMS.
// @purpose Pins that a WebGPU globe material's shader module is compiled under the production globe module's own define set (LOG_DEPTH, GEODETIC_NORMAL, GLOBE_IMAGERY_REDUCED and the ocean hi word) plus MATERIAL_APPLY, so the material globe writes the renderer-wide log depth instead of hyperbolic depth whose ~1.7 km step at a 50 km camera lets 1,000 m tile skirts tie the neighbouring tile and paint seams; executes the real renderer with the real WaterMask material and GlobeTerrain.wgsl, validates the modules with naga, and carries executed inertness mutants.
// @status ACTIVE
//
// THE DEFECT. `_getOrCreateMaterialPipeline` compiled ONE module per material
// type under `MATERIAL_APPLY | GLOBE_IMAGERY_REDUCED` only, then put it in both
// stages of a descriptor whose production module carries LOG_DEPTH. With the
// renderer-wide log depth on (the WebGPU default), the material globe therefore
// wrote the rasterizer's hyperbolic z against a globe projection whose near
// plane is the log-depth camera's 0.1 m. At the E-M-water rig (50 km, pitch
// -1.2) one depth step is about 1.7 km, more than the 1,000 m skirt of an
// ellipsoid tile, so a tile's skirt ties the neighbouring tile's surface and
// whichever draws later paints over it: the coast steps across tile edges in
// the banked Edge capture, WebGL (log depth in every shader) stays continuous.
//
// WHAT IS REAL. WebGPUGlobeSurfaceRenderer.ts, WebGPUGlobeSurfacePipelines.ts,
// WebGPUGlobeSurfaceShaders.ts, WebGPUGlobeMaterial.ts and the preprocessor run
// as written (TypeScript transformed in memory); the material is
// `Material.fromType("WaterMask")`; the base source is GlobeTerrain.wgsl. The
// GPU device records what it is asked to compile. The production define set is
// not restated here: it is whatever the production path asks its module cache
// for when `buildPipelineDescriptor` builds the same geometry variant.
//
// MUTANTS. A mutant is the real module with one anchored text substitution,
// loaded under a `?mutant=<id>` URL so the unmutated graph stays in place; the
// renderer's import of WebGPUGlobeSurfaceShaders.ts inherits the query so a
// helper mutant reaches the renderer that calls it.
//
// Run: node --test Tools/visual-regression/globe-material-log-depth-module.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import { readEngineShader } from "./lib/engine-shader-source.mjs";

enableEngineTsResolution();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engine = path.join(root, "packages/engine/Source");
const webgpu = path.join(engine, "Renderer/WebGPU");

// ───────────────────────────── mutants ─────────────────────────────

const RENDERER_FILE = "WebGPUGlobeSurfaceRenderer.ts";
const SHADERS_FILE = "WebGPUGlobeSurfaceShaders.ts";

/** id → { file basename → [[anchor, replacement]] }. Anchors occur exactly once. */
const MUTANTS = {
  // The fix made unreachable: the module mask falls back to the pre-fix
  // `MATERIAL_APPLY | GLOBE_IMAGERY_REDUCED`.
  "fix-unreachable": {
    [RENDERER_FILE]: [
      [
        "(descriptor.defines ?? defines) | ShaderDefine.MATERIAL_APPLY,",
        "(false ? (descriptor.defines ?? defines) : (this._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0)) | ShaderDefine.MATERIAL_APPLY,",
      ],
    ],
  },
  // The pipeline key without the LOG_DEPTH bit: a log-depth flip reuses the
  // pipeline built for the other encoding.
  "key-without-log-depth": {
    [RENDERER_FILE]: [
      [
        "      (this._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |\n      (this._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);\n    const geomKey",
        "      (this._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);\n    const geomKey",
      ],
    ],
  },
  // The per-entry module map ignores the define set: the first module wins.
  "module-map-ignores-defines": {
    [SHADERS_FILE]: [
      [
        "const cached = entry.shaderModules.get(defines);",
        "const cached = [...entry.shaderModules.values()][0];",
      ],
    ],
  },
  // The helper drops the ocean hi word the production module compiles under.
  "helper-drops-hi-word": {
    [SHADERS_FILE]: [
      [
        "code: preprocessShaderSource(entry.wgslSource, defines, definesHi),",
        "code: preprocessShaderSource(entry.wgslSource, defines, 0),",
      ],
    ],
  },
};

function applyMutant(basename, source, mutantId) {
  const edits = MUTANTS[mutantId]?.[basename];
  if (!edits) {
    return source;
  }
  let text = source;
  for (const [anchor, replacement] of edits) {
    assert.equal(
      text.split(anchor).length - 1,
      1,
      `mutant ${mutantId}: anchor must occur once in ${basename}: ${anchor}`,
    );
    text = text.replace(anchor, () => replacement);
  }
  return text;
}

// The renderer reaches a const enum and generated shader-string modules that
// Node's strip-only loader cannot consume: TypeScript is transformed in memory
// and an absent generated module under Shaders/ becomes an empty default
// export (none of them is read on the material path). A `?mutant=` query on a
// parent is carried to its WebGPUGlobeSurfaceShaders.ts import.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const candidatePath = fileURLToPath(
        new URL(specifier, context.parentURL),
      );
      const normalizedPath = candidatePath.replaceAll("\\", "/");
      if (
        !fs.existsSync(candidatePath) &&
        normalizedPath.includes("/packages/engine/Source/Shaders/")
      ) {
        return {
          url: `data:text/javascript,export default %22%22;#${encodeURIComponent(candidatePath)}`,
          shortCircuit: true,
        };
      }
    }
    const resolved = nextResolve(specifier, context);
    const parentMutant = context.parentURL?.startsWith("file:")
      ? new URL(context.parentURL).searchParams.get("mutant")
      : null;
    if (
      parentMutant &&
      resolved.url.startsWith("file:") &&
      resolved.url.endsWith(`/${SHADERS_FILE}`)
    ) {
      return {
        ...resolved,
        url: `${resolved.url}?mutant=${parentMutant}`,
      };
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.ts(\?|$)/.test(url)) {
      const parsed = new URL(url);
      const mutantId = parsed.searchParams.get("mutant");
      parsed.search = "";
      const file = fileURLToPath(parsed);
      let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      if (mutantId) {
        source = applyMutant(path.basename(file), source, mutantId);
      }
      return {
        format: "module",
        source: stripTypeScriptTypes(source, {
          mode: "transform",
          sourceMap: false,
        }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const Material = (
  await import("../../packages/engine/Source/Scene/Material.js")
).default;
const { ShaderDefine } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts");
const { preprocess } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUShaderPreprocessor.ts");
const { buildPipelineDescriptor } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts");
const { DebugFragmentMode } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts");

async function importRenderer(mutantId) {
  const url = pathToFileURL(path.join(webgpu, RENDERER_FILE));
  if (mutantId) {
    assert.ok(MUTANTS[mutantId], `unknown mutant ${mutantId}`);
    url.search = `mutant=${mutantId}`;
  }
  return (await import(url.href)).WebGPUGlobeSurfaceRenderer;
}

const RealRenderer = await importRenderer(null);

const GLOBE_TERRAIN_WGSL = readEngineShader(
  "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);

// ───────────────────────────── harness ─────────────────────────────

globalThis.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 };
globalThis.HTMLImageElement ??= class HTMLImageElement {};
globalThis.HTMLCanvasElement ??= class HTMLCanvasElement {};
globalThis.ImageBitmap ??= class ImageBitmap {};
// MaterialHelpers classifies a uniform value against these DOM constructors
// (a Color matches none of them); Node has none.
globalThis.OffscreenCanvas ??= class OffscreenCanvas {};
globalThis.HTMLVideoElement ??= class HTMLVideoElement {};

const OCEAN_STATES = {
  default: {},
  waterProviderParity: { _waterProviderParityEnabled: true },
  enhancedOcean: { _enhancedOceanEnabled: true },
};

/**
 * A renderer instance wired to a recording device and a recording production
 * module cache: every material module is `{ kind: "material", code, label }`,
 * every production module `{ kind: "production", defines, definesHi }`.
 */
function makeRenderer(Renderer, state) {
  const renderer = new Renderer();
  const materialModules = [];
  renderer._device = {
    createShaderModule(descriptor) {
      const module = { kind: "material", ...descriptor };
      materialModules.push(module);
      return module;
    },
    createBuffer() {
      return {};
    },
    createRenderPipeline(descriptor) {
      return { descriptor };
    },
    queue: { writeBuffer() {} },
  };
  renderer._pipelineLayout = {};
  renderer._shaderModuleCache = {
    getOrCreate(sourceId, source, defines, label, keySalt, definesHi = 0) {
      return { kind: "production", defines, definesHi };
    },
  };
  renderer._shaderCode = GLOBE_TERRAIN_WGSL;
  renderer._canvasFormat = "rgba16float";
  renderer._sampleCount = 1;
  Object.assign(renderer, state);
  return { renderer, materialModules };
}

/** The geometry variant every call below draws (uncompressed, with normals). */
function geometry(hasGeodeticSurfaceNormals) {
  return {
    isQuantized: false,
    hasNormals: true,
    hasWebMercatorT: true,
    isBlend: false,
    strideBytes: hasGeodeticSurfaceNormals ? 44 : 32,
    hasGeodeticSurfaceNormals,
    disableCulling: false,
  };
}

function materialPipeline(renderer, material, g) {
  const result = renderer._getOrCreateMaterialPipeline(
    material,
    g.isQuantized,
    g.hasNormals,
    g.hasWebMercatorT,
    g.isBlend,
    g.strideBytes,
    g.hasGeodeticSurfaceNormals,
    g.disableCulling,
  );
  assert.notEqual(result, null, "the material pipeline is built");
  const descriptor = result.pipeline.descriptor;
  assert.equal(
    descriptor.vertex.module,
    descriptor.fragment.module,
    "one material module serves both stages",
  );
  assert.equal(descriptor.vertex.module.kind, "material");
  return { ...result, module: descriptor.vertex.module };
}

/** What the production path compiles for the same geometry variant. */
function productionModule(renderer, g) {
  const descriptor = buildPipelineDescriptor(
    renderer,
    g.isQuantized,
    g.hasNormals,
    g.hasWebMercatorT,
    g.isBlend,
    g.strideBytes,
    DebugFragmentMode.NONE,
    false,
    g.hasGeodeticSurfaceNormals,
    g.disableCulling,
  );
  const module = descriptor.vertex.module;
  assert.equal(module.kind, "production");
  assert.equal(descriptor.fragment.module, module);
  return module;
}

const FRAG_DEPTH = /@builtin\(frag_depth\)\s+depth\s*:\s*f32/;
const LOG_DEPTH_VARYING = /@location\(\d+\)\s+v_logDepth\s*:\s*f32/;
const writesLogDepth = (code) =>
  FRAG_DEPTH.test(code) && LOG_DEPTH_VARYING.test(code);

function waterMaskMaterial() {
  const material = Material.fromType("WaterMask");
  assert.match(
    material.wgslShaderSource,
    /materialInput\.waterMask/,
    "the WaterMask fabric's WGSL reads the mask",
  );
  return material;
}

// ───────────────────────────── the contract ─────────────────────────────

/**
 * Over log depth x geodetic normals x reduced imagery x ocean hi word: the
 * material module is the material's assembled source preprocessed under the
 * production module's (defines, definesHi) plus MATERIAL_APPLY, and it writes
 * log depth exactly when the production module does.
 */
function checkModuleMatchesProduction(Renderer) {
  const material = waterMaskMaterial();
  let cells = 0;
  for (const logDepth of [true, false]) {
    for (const geodetic of [false, true]) {
      for (const reduced of [false, true]) {
        for (const [oceanName, ocean] of Object.entries(OCEAN_STATES)) {
          const label = `logDepth=${logDepth} geodetic=${geodetic} reduced=${reduced} ocean=${oceanName}`;
          const { renderer } = makeRenderer(Renderer, {
            _logDepthEnabled: logDepth,
            _imageryReduced: reduced,
            ...ocean,
          });
          const g = geometry(geodetic);
          const prod = productionModule(renderer, g);
          const { module, entry } = materialPipeline(renderer, material, g);
          assert.equal(
            (prod.defines & ShaderDefine.LOG_DEPTH) !== 0,
            logDepth,
            `${label}: the production module's LOG_DEPTH follows the renderer`,
          );
          const expected = preprocess(
            entry.wgslSource,
            prod.defines | ShaderDefine.MATERIAL_APPLY,
            prod.definesHi,
          );
          assert.equal(
            module.code === expected,
            true,
            `${label}: the material module is the production define set plus MATERIAL_APPLY`,
          );
          assert.equal(
            writesLogDepth(module.code),
            logDepth,
            `${label}: the material globe writes log depth exactly when the production globe does`,
          );
          cells++;
        }
      }
    }
  }
  assert.equal(cells, 24);
}

/**
 * One renderer, log depth on → off → on: each state draws through a pipeline
 * whose module matches that state, nothing compiled for one encoding is
 * reused for the other, and returning to a state reuses its own pipeline.
 */
function checkLogDepthFlip(Renderer) {
  const material = waterMaskMaterial();
  const { renderer, materialModules } = makeRenderer(Renderer, {
    _logDepthEnabled: true,
  });
  const g = geometry(false);
  const on = materialPipeline(renderer, material, g);
  assert.equal(writesLogDepth(on.module.code), true, "on: log depth");
  renderer._logDepthEnabled = false;
  const off = materialPipeline(renderer, material, g);
  assert.equal(writesLogDepth(off.module.code), false, "off: hyperbolic");
  assert.notEqual(off.pipeline, on.pipeline, "off: its own pipeline");
  renderer._logDepthEnabled = true;
  const back = materialPipeline(renderer, material, g);
  assert.equal(back.pipeline, on.pipeline, "on again: the on pipeline");
  assert.equal(materialModules.length, 2, "one module per define set");
  assert.equal(on.entry.shaderModules.size, 2);
  assert.equal(on.entry.pipelines.size, 2);
}

test("the material module carries the production define set and writes log depth with it (24 cells)", () => {
  checkModuleMatchesProduction(RealRenderer);
});

test("a log-depth flip rebuilds through a keyed miss and returns to its own pipeline", () => {
  checkLogDepthFlip(RealRenderer);
});

test("the WaterMask material modules are valid WGSL (naga), log depth on and off", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  const material = waterMaskMaterial();
  for (const logDepth of [true, false]) {
    for (const [oceanName, ocean] of Object.entries({
      default: OCEAN_STATES.default,
      waterProviderParity: OCEAN_STATES.waterProviderParity,
    })) {
      const { renderer } = makeRenderer(RealRenderer, {
        _logDepthEnabled: logDepth,
        ...ocean,
      });
      const { module } = materialPipeline(renderer, material, geometry(false));
      assert.doesNotThrow(
        () => naga.validate_wgsl(module.code),
        `logDepth=${logDepth} ocean=${oceanName}`,
      );
    }
  }
});

// ───────────────────────── the measured arithmetic ─────────────────────────

test("the mechanism in numbers: a 1,000 m skirt is within one hyperbolic depth step at the rig, thousands of log steps", () => {
  // The log-depth camera frustum the globe projection is built from
  // (`UniformState.updateCamera` at scene update).
  const sceneJs = fs.readFileSync(path.join(engine, "Scene/Scene.js"), "utf8");
  const frustum =
    /if \(this\._logDepthBuffer\) \{\s*camera\.frustum\.near = ([\d.e]+);\s*camera\.frustum\.far = ([\d.e]+);/.exec(
      sceneJs,
    );
  assert.ok(frustum, "Scene.js sets the log-depth camera frustum");
  const near = Number(frustum[1]);
  const far = Number(frustum[2]);
  assert.equal(near, 0.1);
  assert.equal(far, 1e10);

  // The ellipsoid tile skirt: HeightmapTerrainData's min(4 x level error,
  // 1000) with the ellipsoid provider's 16-sample heightmap.
  const heightmap = fs.readFileSync(
    path.join(engine, "Core/HeightmapTerrainData.js"),
    "utf8",
  );
  assert.match(
    heightmap,
    /this\._skirtHeight = Math\.min\(thisLevelMaxError \* 4\.0, 1000\.0\);/,
  );
  const ellipsoidProvider = fs.readFileSync(
    path.join(engine, "Core/EllipsoidTerrainProvider.js"),
    "utf8",
  );
  assert.match(ellipsoidProvider, /const width = 16;/);
  const levelZeroError = (6378137.0 * 2 * Math.PI * 0.25) / (16 * 2);
  const level10Skirt = Math.min((levelZeroError / 1024) * 4.0, 1000.0);
  assert.equal(level10Skirt, 1000.0, "a level-10 ellipsoid skirt is 1,000 m");

  // How much further along a view ray the skirt's bottom lies than the
  // neighbouring surface: skirt / sin(ray elevation). The rig looks down at
  // pitch 1.2 rad with a 60-degree horizontal field of view at 1280 x 720, so
  // its rays run between 1.2 -/+ half the vertical field of view below the
  // horizon; the shallowest ray gives the largest gap, the steepest the least.
  const halfVerticalFov = Math.atan(Math.tan(Math.PI / 6) / (1280 / 720));
  const widestGap = level10Skirt / Math.sin(1.2 - halfVerticalFov);
  const narrowestGap = level10Skirt / Math.sin(1.2 + halfVerticalFov);

  // WebGPU [0,1] perspective depth, rounded to f32 as stored, over the rig's
  // ~50-60 km range of the coast.
  const f32 = Math.fround;
  const hyperbolic = (z) => f32((far / (far - near)) * (1 - near / z));
  const log = (z) => f32(Math.log2(z - near + 1) / Math.log2(far - near + 1));
  const step = 2 ** -24; // one f32 / 24-bit unorm step just below 1.0
  for (const z of [50000, 55000, 60000]) {
    const hyperbolicSteps = (hyperbolic(z + widestGap) - hyperbolic(z)) / step;
    // log depth there is ~0.47, where an f32 step is 2^-25.
    const logSteps = (log(z + narrowestGap) - log(z)) / 2 ** -25;
    assert.ok(
      hyperbolicSteps <= 1,
      `z=${z}: the whole skirt sits within ${hyperbolicSteps} hyperbolic step(s) of the surface`,
    );
    assert.ok(
      logSteps > 1000,
      `z=${z}: log depth separates it by ${Math.round(logSteps)} steps`,
    );
  }
});

// ───────────────────────────── mutants ─────────────────────────────

async function assertMutantRed(mutantId, check) {
  const Mutant = await importRenderer(mutantId);
  assert.notEqual(Mutant, RealRenderer, `${mutantId}: a separate instance`);
  assert.throws(
    () => check(Mutant),
    assert.AssertionError,
    `mutant "${mutantId}" must turn the check red`,
  );
}

test("mutant: the fix made unreachable (pre-fix module mask) is DETECTED", async () => {
  await assertMutantRed("fix-unreachable", checkModuleMatchesProduction);
  await assertMutantRed("fix-unreachable", checkLogDepthFlip);
});

test("mutant: a pipeline key without LOG_DEPTH is DETECTED by the flip check", async () => {
  await assertMutantRed("key-without-log-depth", checkLogDepthFlip);
});

test("mutant: a module map that ignores the define set is DETECTED", async () => {
  await assertMutantRed("module-map-ignores-defines", checkLogDepthFlip);
});

test("mutant: a module compiled without the ocean hi word is DETECTED", async () => {
  await assertMutantRed("helper-drops-hi-word", checkModuleMatchesProduction);
});
