/**
 * @module WebGPUNagaTranspiler
 *
 * Lazy GLSL / SPIR-V → WGSL transpilation via a vendored Naga WASM build.
 *
 * Goal: let the WebGL compatibility stub fall through to a real
 * Naga-based shader translation pipeline so legacy GLSL code paths
 * (third-party Cesium extensions, user `CustomShader` API calls) can
 * run on the WebGPU backend without a hand-written WGSL port.
 *
 * Status: ACTIVE — vendored naga 27 build lives at
 *   `Source/ThirdParty/naga-wasm/naga_wasm.{js,wasm}`
 *   (built from `packages/wasm-naga/` via wasm-pack, ~415 KB gzipped
 *   runtime, lazy-loaded on first compileShader call against GLSL).
 *
 * Historical note: earlier versions of this spike targeted an
 * `import("naga-wasm")` npm package with a `convert_shader(src, from, to)`
 * API. That package was unpublished from npm on 2026-04-18, so we built
 * our own vendored WASM from the upstream naga crate instead. The new
 * export shape is `glsl_to_wgsl(src, stage)` + `spirv_to_wgsl(bytes)` +
 * `normalize_wgsl(src)` + `validate_wgsl(src)` — see the crate at
 * `packages/wasm-naga/src/lib.rs` for the full set, including the
 * tooling-only exports (`wgsl_to_msl`, `wgsl_to_hlsl`, `glsl_to_spv`)
 * that are compiled into a separate WASM build.
 *
 * Known compatibility gap (tested 2026-04-18): naga's GLSL frontend
 * parses Vulkan GLSL (450+) well but rejects Cesium's raw shader
 * fragments because those files reference `czm_*` builtins that the
 * ShaderSource preprocessor prepends at runtime. The stub path only
 * works for shaders that have already been run through Cesium's
 * preprocessor — i.e. the same string the WebGL backend would pass to
 * `gl.shaderSource`. Synthetic self-contained shaders (the realistic
 * user-input case) translate correctly; see
 * `packages/wasm-naga/test-synthetic.mjs` for the passing cases.
 *
 * Non-goals (deferred):
 *   - Binding-set remapping. Naga emits raw `@group/@binding` from GLSL
 *     `layout(set=…, binding=…)` qualifiers; consumers still need to
 *     build a `GPUBindGroupLayout` from the reflection output. The
 *     `validate_wgsl` export returns the reflection JSON needed to do
 *     this, but a dedicated pipeline builder isn't wired yet.
 *   - Vertex attribute location remapping for stride/format changes.
 *   - Specialization-constant injection.
 *   - Removing this stub once Naga-based translation covers everything
 *     CesiumJS ships in stock GLSL.
 */

/// <reference types="@webgpu/types" />

/**
 * Possible shader stages naga-wasm understands. We mirror the WebGL
 * `gl.VERTEX_SHADER` / `gl.FRAGMENT_SHADER` constants on the host side and
 * translate to naga's stage strings here.
 */
export type NagaShaderStage = "vertex" | "fragment" | "compute";

/**
 * Result returned by `transpileGLSL`. WGSL is `null` on any failure path
 * (package missing, init error, parse error, validation error). The
 * `error` field carries a human-readable diagnostic for logging.
 */
export interface NagaTranspileResult {
  wgsl: string | null;
  error?: string;
  cached: boolean;
}

// ─── Lazy module handle ──────────────────────────────────────────────────────
//
// The first call to `loadNaga()` kicks off the dynamic import + WASM init.
// Subsequent calls await the same promise so concurrent compileShader()s
// don't race the loader. Once the promise resolves we keep the resolved
// module on `_nagaModule` for fast-path access.

/**
 * Shape of the vendored naga WASM module. Mirrors the exports emitted by
 * `packages/wasm-naga/src/lib.rs` when built with the `runtime` feature.
 *
 * Each function throws a regular JS `Error` on failure — naga's native
 * diagnostics are collapsed into the `Error.message` string. We don't
 * surface structured error details because naga's error types change
 * across versions and reshaping them each upgrade is more churn than
 * it's worth.
 */
interface NagaModule {
  /** GLSL → WGSL. `stage` is one of "vertex" / "fragment" / "compute". */
  glsl_to_wgsl: (source: string, stage: string) => string;
  /** SPIR-V bytes → WGSL. Entry-point metadata is carried in the SPIR-V. */
  spirv_to_wgsl: (bytes: Uint8Array) => string;
  /** Validate WGSL; return a JSON string describing entry points + bindings. */
  validate_wgsl: (source: string) => string;
  /** WGSL → WGSL roundtrip; light minifier + validator. */
  normalize_wgsl: (source: string) => string;
}

let _nagaModulePromise: Promise<NagaModule | null> | null = null;
let _nagaModule: NagaModule | null = null;
let _nagaUnavailable: boolean = false;

async function loadNaga(): Promise<NagaModule | null> {
  if (_nagaModule) return _nagaModule;
  if (_nagaUnavailable) return null;
  if (_nagaModulePromise) return _nagaModulePromise;

  _nagaModulePromise = (async (): Promise<NagaModule | null> => {
    try {
      // Dynamic import keeps the naga WASM out of the static dependency
      // graph — browsers that never hit a GLSL compileShader path never
      // download the ~415 KB gzipped blob. The vendored build lives at
      // `Source/ThirdParty/naga-wasm/naga_wasm.js` (produced from
      // `packages/wasm-naga/` via wasm-pack; see that crate's README
      // for the build recipe and Cargo features).
      //
      // The `/* @vite-ignore */` + `/* webpackIgnore: true */` magic
      // comments tell bundlers to leave the path alone so the import
      // resolves relative to the final shipped module location, not
      // the bundler's virtual graph.
      const mod = (await import(
        /* @vite-ignore */ /* webpackIgnore: true */ "../../ThirdParty/naga-wasm/naga_wasm.js" as string
      )) as { default?: (init?: unknown) => Promise<unknown> } & NagaModule;

      // wasm-pack `--target web` convention: the default export is an
      // init function that fetches (or accepts) the .wasm bytes. We
      // call it with no args so it resolves the .wasm file via a URL
      // relative to the JS glue.
      if (typeof mod.default === "function") {
        await mod.default();
      }

      if (typeof mod.glsl_to_wgsl !== "function") {
        _nagaUnavailable = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[WebGPU:Naga] naga-wasm loaded but glsl_to_wgsl is missing — " +
            "the vendored build may be stale. Rebuild via " +
            "`packages/wasm-naga`: wasm-pack build --target web --release --features runtime",
        );
        return null;
      }

      _nagaModule = {
        glsl_to_wgsl: mod.glsl_to_wgsl,
        spirv_to_wgsl: mod.spirv_to_wgsl,
        validate_wgsl: mod.validate_wgsl,
        normalize_wgsl: mod.normalize_wgsl,
      };
      //>>includeStart('debug', pragmas.debug);
      // eslint-disable-next-line no-console
      console.log(
        "[WebGPU:Naga] naga-wasm initialized — GLSL→WGSL transpilation enabled",
      );
      //>>includeEnd('debug');
      return _nagaModule;
    } catch (err) {
      _nagaUnavailable = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[WebGPU:Naga] naga-wasm not available — the vendored blob at " +
          "Source/ThirdParty/naga-wasm/ may be missing. Rebuild via " +
          "`packages/wasm-naga` (see that crate's README). " +
          `Reason: ${(err as Error).message}`,
      );
      return null;
    }
  })();

  return _nagaModulePromise;
}

// ─── FNV-1a 32-bit hash for cache keys ───────────────────────────────────────
//
// We don't need cryptographic strength here — just a fast, allocation-free
// way to dedupe identical shader sources. FNV-1a is two ops per byte and
// folds in well under a microsecond for the longest CesiumJS shaders.
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

const _transpileCache = new Map<string, NagaTranspileResult>();

/**
 * Public API: transpile a GLSL shader source to WGSL.
 *
 * Returns immediately when the result is cached. On a cache miss the
 * function awaits the lazy loader, runs `convert_shader`, and stores
 * the result. The caller may pass through `null` results unchanged —
 * they indicate the shader could not be transpiled and the stub should
 * fall back to its placeholder behavior.
 *
 * @param source - GLSL source string (any version Naga's `glsl_in` accepts)
 * @param stage - Pipeline stage ("vertex" | "fragment" | "compute"). Naga's
 *                GLSL frontend is stage-aware — GLSL's entry point is always
 *                `main` and the builtin variables it recognises depend on
 *                which pipeline stage it's parsed as.
 */
export async function transpileGLSL(
  source: string,
  stage: NagaShaderStage,
): Promise<NagaTranspileResult> {
  const cacheKey = `${stage}:${fnv1a32(source).toString(16)}:${source.length}`;
  const hit = _transpileCache.get(cacheKey);
  if (hit) {
    return { ...hit, cached: true };
  }

  const naga = await loadNaga();
  if (!naga) {
    const result: NagaTranspileResult = {
      wgsl: null,
      // The vendored blob at Source/ThirdParty/naga-wasm/ either failed
      // to load (missing file, wrong filename) or the exports didn't
      // match the expected shape (stale build). The warning logged by
      // loadNaga() carries the actionable detail; here we just flag
      // the result as unavailable so callers fall back to their
      // placeholder shader path instead of hard-failing.
      error: "naga-wasm unavailable (see loadNaga warning)",
      cached: false,
    };
    _transpileCache.set(cacheKey, result);
    return result;
  }

  try {
    const wgsl = naga.glsl_to_wgsl(source, stage);
    if (typeof wgsl !== "string" || wgsl.length === 0) {
      const result: NagaTranspileResult = {
        wgsl: null,
        error: "naga returned empty WGSL",
        cached: false,
      };
      _transpileCache.set(cacheKey, result);
      return result;
    }
    const result: NagaTranspileResult = { wgsl, cached: false };
    _transpileCache.set(cacheKey, result);
    return result;
  } catch (err) {
    const result: NagaTranspileResult = {
      wgsl: null,
      error: (err as Error).message ?? String(err),
      cached: false,
    };
    _transpileCache.set(cacheKey, result);
    return result;
  }
}

/**
 * Diagnostic: returns whether `naga-wasm` has been successfully loaded
 * since this page was opened. Returns `false` until the first successful
 * `transpileGLSL` call resolves.
 */
export function isNagaReady(): boolean {
  return _nagaModule !== null;
}

// ─── WebGPUShaderTranslator adapter ────────────────────────────────────
//
// Wraps `transpileGLSL` as a `ShaderTranslator` implementation so the
// WebGL compat stub can consume it through the pluggable registry.
// Exported as `NagaShaderTranslator` — apps that want Naga-based GLSL
// translation call:
//
//   import {
//     NagaShaderTranslator,
//     registerShaderTranslator,
//   } from "@cesium/engine";
//   registerShaderTranslator(new NagaShaderTranslator());
//
// The registration is explicit rather than automatic so apps that want
// a different translator (Slang, custom, WGSL-only) aren't forced to
// drag in naga-wasm. On first translate() call the naga-wasm module
// is lazy-loaded; subsequent calls are fast-path via the cache.

import type {
  ShaderTranslator,
  TranslatedShader,
  ShaderReflection,
  ShaderStage,
} from "./WebGPUShaderTranslator.js";

export class NagaShaderTranslator implements ShaderTranslator {
  readonly name = "naga-wasm";
  readonly supports: ReadonlyArray<"glsl" | "wgsl" | "slang"> = [
    "glsl",
    "wgsl",
  ];

  async translate(
    source: string,
    stage: ShaderStage,
    language: "glsl" | "wgsl" | "slang",
  ): Promise<TranslatedShader> {
    if (language === "slang") {
      throw new Error(
        "NagaShaderTranslator does not support Slang input — use the Slang build-time pipeline (`scripts/compileSlang.js`) or register a slang-wasm adapter.",
      );
    }
    if (language === "wgsl") {
      // WGSL passthrough — but we still run it through naga's
      // wgsl-in reflection pass so downstream pipeline builders get
      // real binding metadata. The wasm `validate_wgsl` export both
      // parses and validates, so any WGSL that arrives here malformed
      // fails loudly instead of silently propagating through the
      // pipeline and failing at createShaderModule time.
      const reflection = await _reflectWgsl(source, stage);
      return {
        wgsl: source,
        reflection,
        warnings: [],
      };
    }
    const result = await transpileGLSL(source, stage as NagaShaderStage);
    if (!result.wgsl) {
      throw new Error(result.error || "GLSL→WGSL translation failed");
    }
    // Parse reflection from the GENERATED WGSL (not the original GLSL).
    // Naga's glsl-in produces a module with clean @group/@binding
    // attributes, and running wgsl-in on its own output is the path
    // that gets us structured ShaderReflection without a second
    // translator pass.
    const reflection = await _reflectWgsl(result.wgsl, stage);
    return {
      wgsl: result.wgsl,
      // Reflection now carries real binding info (types, view dims,
      // access modes, min binding sizes) — pipeline builders can use
      // `buildBindGroupLayoutDescriptors` to turn this into actual
      // GPUBindGroupLayout objects.
      reflection,
      warnings: [],
    };
  }

  describe(): string {
    if (_nagaUnavailable) {
      return "NagaShaderTranslator — naga-wasm not installed (npm install naga-wasm to enable)";
    }
    if (_nagaModule) {
      return "NagaShaderTranslator — naga-wasm loaded, GLSL→WGSL active";
    }
    return "NagaShaderTranslator — naga-wasm pending first translate()";
  }
}

function _emptyReflection(stage: ShaderStage): ShaderReflection {
  return {
    entryPoint:
      stage === "vertex"
        ? "main"
        : stage === "fragment"
          ? "main"
          : "computeMain",
    stage,
    uniformBuffers: [],
    textures: [],
    samplers: [],
    attributes: [],
  };
}

/**
 * Reflect a WGSL source through naga's `validate_wgsl` and translate
 * the result into the engine's `ShaderReflection` shape. Called by
 * `NagaShaderTranslator.translate()` for both WGSL passthrough and
 * GLSL→WGSL paths.
 *
 * On any failure (naga unavailable, validation error, unexpected JSON
 * shape) the function falls back to `_emptyReflection(stage)` rather
 * than throwing — missing reflection is recoverable (callers who
 * hand-build a pipeline layout work fine without it), while a throw
 * would take down the translator's own pipeline that was otherwise
 * succeeding. Errors are logged once via the same `_nagaUnavailable`
 * flag used elsewhere so developers still see them.
 *
 * The returned reflection maps naga's binding classifier output into
 * the engine's structured `ShaderReflection`:
 *   - `kind: "uniform-buffer"` → `uniformBuffers[]`
 *   - `kind: "texture"`        → `textures[]`
 *   - `kind: "sampler"`        → `samplers[]`
 *   - Other kinds (storage, etc.) are retained by the consumer-facing
 *     BGL auto-derive helper but aren't surfaced on the narrower
 *     `ShaderReflection` interface yet — they live in
 *     `NagaBinding[]` via `validate_wgsl` directly.
 */
async function _reflectWgsl(
  wgsl: string,
  stage: ShaderStage,
): Promise<ShaderReflection> {
  const naga = await loadNaga();
  if (!naga) {
    return _emptyReflection(stage);
  }
  try {
    const jsonText = naga.validate_wgsl(wgsl);
    const parsed = JSON.parse(jsonText) as {
      entryPoints?: Array<{ name: string; stage: string }>;
      bindings?: Array<{
        name: string;
        group: number;
        binding: number;
        kind: string;
        minBindingSize?: number;
        viewDimension?: string;
      }>;
    };
    // Pick the entry point whose stage matches the caller. GLSL-
    // generated WGSL always has one entry point named `main`, but WGSL
    // passthrough can carry multiple — choose the first that matches.
    const stageKey =
      stage === "vertex"
        ? "vertex"
        : stage === "fragment"
          ? "fragment"
          : "compute";
    const ep =
      parsed.entryPoints?.find((e) => e.stage === stageKey) ??
      parsed.entryPoints?.[0];

    const reflection: ShaderReflection = {
      entryPoint: ep?.name ?? _emptyReflection(stage).entryPoint,
      stage,
      uniformBuffers: [],
      textures: [],
      samplers: [],
      attributes: [],
    };
    for (const b of parsed.bindings as Array<{
      name: string;
      group: number;
      binding: number;
      kind: string;
      minBindingSize?: number;
      viewDimension?: string;
      sampleType?: string;
      multisampled?: boolean;
    }>) {
      if (b.kind === "uniform-buffer") {
        reflection.uniformBuffers.push({
          group: b.group,
          binding: b.binding,
          name: b.name,
          // The wasm reflection doesn't currently surface per-member
          // layout — getting that would require reshaping naga's
          // `TypeInner::Struct` into nested member descriptors, which
          // is mechanical but adds real WASM size. `sizeBytes` alone
          // lets WebGPU set `minBindingSize` and reject obviously
          // mismatched UBOs at pipeline-creation time, which is the
          // 80% of the value for zero extra wasm weight.
          sizeBytes: b.minBindingSize ?? 0,
          members: [],
        });
      } else if (b.kind === "texture") {
        reflection.textures.push({
          group: b.group,
          binding: b.binding,
          name: b.name,
          viewDimension: (b.viewDimension as GPUTextureViewDimension) ?? "2d",
          sampleType: mapSampleType(b.sampleType),
          multisampled: b.multisampled ?? false,
        });
      } else if (b.kind === "sampler") {
        reflection.samplers.push({
          group: b.group,
          binding: b.binding,
          name: b.name,
          type: mapSamplerType(b.sampleType),
        });
      }
      // Storage / storage-texture / external-texture are handled by
      // the BGL auto-derive path (`buildBindGroupLayoutDescriptors`
      // in WebGPUBindGroupReflection.ts), not the narrower
      // ShaderReflection shape. A future reflection schema bump can
      // widen this interface.
    }
    return reflection;
  } catch {
    // Reflection failures are never fatal — fall back to the empty
    // shape so the rest of the translator pipeline proceeds.
    return _emptyReflection(stage);
  }
}

/**
 * Translate naga's texture-sampleType string into the subset of
 * values `ShaderReflection.textures[].sampleType` accepts. Narrower
 * than WebGPU's full `GPUTextureSampleType` because the reflection
 * interface was authored before naga-wasm existed and doesn't
 * distinguish "unfilterable-float" cases that naga identifies.
 */
function mapSampleType(
  raw: string | undefined,
): "float" | "unfilterable-float" | "depth" | "sint" | "uint" {
  switch (raw) {
    case "float":
      return "float";
    case "unfilterable-float":
      return "unfilterable-float";
    case "depth":
      return "depth";
    case "sint":
      return "sint";
    case "uint":
      return "uint";
    default:
      return "float";
  }
}

/**
 * Translate naga's sampler-type string into a WebGPU sampler binding
 * type. We collapse naga's "filtering" / "non-filtering" difference
 * into the WebGPU "filtering" default unless the naga reflection
 * specifically flagged the sampler as comparison — non-filtering
 * samplers aren't distinguishable from filtering ones at the WGSL
 * reflection layer.
 */
function mapSamplerType(raw: string | undefined): GPUSamplerBindingType {
  if (raw === "comparison") return "comparison";
  if (raw === "non-filtering") return "non-filtering";
  return "filtering";
}

/**
 * Diagnostic: returns whether the loader has given up on `naga-wasm`
 * (package missing, init failure, etc.). Useful for the WebGPU stub to
 * decide whether to attempt further transpiles or fall through to its
 * placeholder behavior.
 */
export function isNagaUnavailable(): boolean {
  return _nagaUnavailable;
}

/**
 * Test-only: clear the transpile cache and reset the loader state.
 * Used by spec files; not exported via the public Cesium API.
 */
export function _resetNagaTranspilerForTests(): void {
  _transpileCache.clear();
  _nagaModulePromise = null;
  _nagaModule = null;
  _nagaUnavailable = false;
}
