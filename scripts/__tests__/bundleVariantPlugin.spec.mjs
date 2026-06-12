// bundleVariantPlugin spec — exercised without esbuild by capturing the
// onResolve handler the plugin registers and calling it with synthetic
// args. Covers the decision matrix that governs whether an import gets
// aliased to an empty stub:
//
//   dual         — plugin returns null (no aliasing)
//   webgl-only   — WebGPU TS + WGSL shaders → stubs; GLSL shaders kept
//   webgpu-only  — GLSL shaders → stub;        WGSL + WebGPU TS kept
//
// Also covers:
//   - Bare specifiers (non-relative) always pass through.
//   - The WEBGPU_COMPAT_EXEMPTIONS allowlist (backend-neutral files).
//   - Re-entry guard via pluginData._variantSkip.
//   - Decision cache (same candidate path resolved twice returns same
//     verdict, i.e., deterministic).
//
// Run with: node scripts/__tests__/bundleVariantPlugin.spec.mjs

import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleVariantPlugin } from "../bundleVariantPlugin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Path to the stub files — mirrors the plugin's STUB_SHADER / STUB_MODULE
// constants. Used to verify the redirect target is what we expect.
const STUB_SHADER = path.resolve(REPO_ROOT, "scripts", "stubs", "emptyShader.js");
const STUB_MODULE = path.resolve(REPO_ROOT, "scripts", "stubs", "emptyModule.js");

// Fake esbuild build object that captures whatever onResolve handler the
// plugin registers. The plugin only registers ONE handler with filter /.*/
// so we can get away with a single-slot capture.
function makeFakeBuild() {
  let capturedFilter = null;
  let capturedHandler = null;
  return {
    onResolve(options, handler) {
      capturedFilter = options.filter;
      capturedHandler = handler;
    },
    resolve(handler) {
      return capturedHandler ? handler(capturedHandler) : undefined;
    },
    get filter() {
      return capturedFilter;
    },
    get handler() {
      return capturedHandler;
    },
  };
}

function setupPlugin(variant) {
  const plugin = bundleVariantPlugin(variant);
  if (!plugin) {return null;}
  const fake = makeFakeBuild();
  plugin.setup(fake);
  return fake.handler;
}

function resolveLike(handler, importPath, importer) {
  // Mimic what esbuild passes to onResolve callbacks.
  const resolveDir =
    importer && path.isAbsolute(importer)
      ? path.dirname(importer)
      : path.resolve(REPO_ROOT, importer ? path.dirname(importer) : ".");
  return handler({
    path: importPath,
    importer: importer ?? "",
    resolveDir,
    namespace: "",
    kind: "import-statement",
    pluginData: undefined,
  });
}

async function run() {
  // ──────────────────────────────────────────────────────────────────
  // 1. Dual variant — no plugin at all.
  // ──────────────────────────────────────────────────────────────────
  assert.strictEqual(
    bundleVariantPlugin("dual"),
    null,
    "dual variant returns null (no aliasing)",
  );

  // ──────────────────────────────────────────────────────────────────
  // 2. webgpu-only — GLSL strings redirected, WGSL untouched, TS untouched.
  // ──────────────────────────────────────────────────────────────────
  {
    const handler = setupPlugin("webgpu-only");
    assert(handler, "webgpu-only plugin registers an onResolve handler");

    // A GLSL shader string module should redirect to the empty-shader stub.
    const globeFSImporter = path.resolve(
      REPO_ROOT,
      "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js",
    );
    const globeFSResult = resolveLike(
      handler,
      "../Shaders/GlobeFS.js",
      globeFSImporter,
    );
    assert.strictEqual(
      globeFSResult?.path,
      STUB_SHADER,
      "webgpu-only: GLSL GlobeFS import redirects to emptyShader",
    );

    // A WGSL shader string module should NOT redirect in webgpu-only.
    const wgslImporter = path.resolve(
      REPO_ROOT,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
    );
    const wgslResult = resolveLike(
      handler,
      "../../Shaders/WebGPU/Globe/GlobeTerrain.js",
      wgslImporter,
    );
    assert.strictEqual(
      wgslResult,
      null,
      "webgpu-only: WGSL shader imports pass through",
    );

    // A WebGPU TS file should NOT redirect in webgpu-only.
    const tsResult = resolveLike(
      handler,
      "./WebGPUGlobeSurfaceRenderer.js",
      wgslImporter,
    );
    assert.strictEqual(
      tsResult,
      null,
      "webgpu-only: WebGPU TS imports pass through",
    );

    // Bare specifiers (non-relative, not absolute) always pass through.
    const bareResult = resolveLike(handler, "lodash", globeFSImporter);
    assert.strictEqual(bareResult, null, "bare specifier passes through");

    // Re-entry guard — if pluginData._variantSkip is set, handler returns null
    // without touching the path.
    const skipResult = handler({
      path: "../Shaders/GlobeFS.js",
      importer: globeFSImporter,
      resolveDir: path.dirname(globeFSImporter),
      namespace: "",
      kind: "import-statement",
      pluginData: { _variantSkip: true },
    });
    assert.strictEqual(
      skipResult,
      null,
      "pluginData._variantSkip causes handler to pass through",
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. webgl-only — WebGPU TS + WGSL redirect, GLSL untouched.
  // ──────────────────────────────────────────────────────────────────
  {
    const handler = setupPlugin("webgl-only");
    assert(handler, "webgl-only plugin registers an onResolve handler");

    const sceneImporter = path.resolve(
      REPO_ROOT,
      "packages/engine/Source/Scene/Scene.js",
    );

    // WebGPU TS module import should redirect to emptyModule (Proxy stub).
    const tsResult = resolveLike(
      handler,
      "../Renderer/WebGPU/WebGPUContext.js",
      sceneImporter,
    );
    assert.strictEqual(
      tsResult?.path,
      STUB_MODULE,
      "webgl-only: WebGPU TS import redirects to emptyModule",
    );

    // WGSL shader string module import should redirect to emptyShader.
    const wgslResult = resolveLike(
      handler,
      "../Shaders/WebGPU/Globe/GlobeTerrain.js",
      sceneImporter,
    );
    assert.strictEqual(
      wgslResult?.path,
      STUB_SHADER,
      "webgl-only: WGSL shader import redirects to emptyShader",
    );

    // GLSL shader string module import should NOT redirect in webgl-only.
    const glslResult = resolveLike(
      handler,
      "../Shaders/GlobeFS.js",
      sceneImporter,
    );
    assert.strictEqual(
      glslResult,
      null,
      "webgl-only: GLSL shader imports pass through",
    );

    // Compat-exempt files stay resolvable in webgl-only builds.
    const compatExemptions = [
      "../Renderer/WebGPU/WebGLCompatibilityStub.js",
      "../Renderer/WebGPU/WebGPUShaderTranslator.js",
      "../Renderer/WebGPU/WebGLStubPipelineExtractor.js",
      "../Renderer/WebGPU/WebGPUNagaTranspiler.js",
    ];
    for (const exempt of compatExemptions) {
      const result = resolveLike(handler, exempt, sceneImporter);
      assert.strictEqual(
        result,
        null,
        `webgl-only: ${exempt} is compat-exempt and passes through`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. Decision cache — same path resolved twice returns the same verdict.
  // ──────────────────────────────────────────────────────────────────
  {
    const handler = setupPlugin("webgl-only");
    const sceneImporter = path.resolve(
      REPO_ROOT,
      "packages/engine/Source/Scene/Scene.js",
    );
    const a = resolveLike(
      handler,
      "../Renderer/WebGPU/WebGPUContext.js",
      sceneImporter,
    );
    const b = resolveLike(
      handler,
      "../Renderer/WebGPU/WebGPUContext.js",
      sceneImporter,
    );
    assert.deepStrictEqual(
      a,
      b,
      "decision cache: repeat lookup returns identical result",
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // 5. esbuild-internal virtual modules (namespace starts with \0) pass through.
  // ──────────────────────────────────────────────────────────────────
  {
    const handler = setupPlugin("webgl-only");
    const virtualResult = handler({
      path: "\u0000virtual:foo",
      importer: "",
      resolveDir: REPO_ROOT,
      namespace: "",
      kind: "import-statement",
      pluginData: undefined,
    });
    assert.strictEqual(
      virtualResult,
      null,
      "esbuild virtual modules (\\0-prefixed) pass through",
    );
  }

  console.log("bundleVariantPlugin spec: all assertions passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
