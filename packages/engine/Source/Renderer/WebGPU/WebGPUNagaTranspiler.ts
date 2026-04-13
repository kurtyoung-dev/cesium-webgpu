/**
 * @module WebGPUNagaTranspiler
 *
 * Spike: lazy GLSL→WGSL transpilation via the optional `naga-wasm` package.
 *
 * Goal of this spike: prove the WebGL compatibility stub can fall through to
 * a real Naga-based shader translation pipeline so that legacy GLSL code
 * paths (Cesium's stock vertex/fragment shaders, third-party extensions)
 * can run on the WebGPU backend without a hand-written WGSL port.
 *
 * Status: PROOF OF CONCEPT
 * - The `naga-wasm` package is loaded via `import("naga-wasm")` so the
 *   ~1.5 MB WASM blob is fetched only on the first GLSL shader the stub
 *   sees. The build does not pin a hard dependency on it; if the package
 *   is not installed the loader returns `null` and the stub silently
 *   falls back to its no-op behavior.
 * - Transpiled output is keyed on `(stage, fnvHash(source))` so repeated
 *   compilation of the same shader is a single map lookup.
 *
 * Activation:
 *   1. `npm install naga-wasm` in the engine package
 *   2. The first call to `WebGPUNagaTranspiler.transpileGLSL` loads + caches
 *      the WASM module and returns the WGSL string (or null on error).
 *
 * Non-goals (deferred):
 *   - Binding-set remapping. Naga emits raw `@group/@binding` from GLSL
 *     `layout(binding = …)` qualifiers; consumers still need a layout
 *     reflection step before creating a real bind group layout.
 *   - Vertex attribute location remapping for stride/format changes.
 *   - Specialization-constant injection.
 *   - Removing this stub once Naga-based stubs cover everything CesiumJS
 *     ships in stock GLSL.
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

interface NagaModule {
  convert_shader: (source: string, from: string, to: string) => string;
  detect_shader_language?: (source: string) => unknown;
  validate_shader_detailed?: (source: string, lang: string) => unknown;
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
      // Dynamic import keeps `naga-wasm` out of the static dependency
      // graph — the build does not require it. If the user hasn't run
      // `npm install naga-wasm`, this throws and we mark the loader
      // permanently unavailable for the lifetime of the page.
      const mod = (await import(
        /* @vite-ignore */ /* webpackIgnore: true */ "naga-wasm" as string
      )) as { default?: () => Promise<unknown> } & NagaModule;

      // The package follows the wasm-pack `--target web` convention:
      // the default export is an init function that fetches the .wasm
      // file. We have to await it before any `convert_shader` call.
      if (typeof mod.default === "function") {
        await mod.default();
      }

      if (typeof mod.convert_shader !== "function") {
        _nagaUnavailable = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[WebGPU:Naga] naga-wasm loaded but convert_shader is missing — wrong package version?",
        );
        return null;
      }

      _nagaModule = {
        convert_shader: mod.convert_shader,
        detect_shader_language: mod.detect_shader_language,
        validate_shader_detailed: mod.validate_shader_detailed,
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
        "[WebGPU:Naga] naga-wasm not available — install it with " +
          "`npm install naga-wasm` to enable GLSL→WGSL fallback. " +
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
 * @param stage - Pipeline stage hint; not currently used by `convert_shader`
 *                but reserved for future Naga API revisions that need it
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
      error: "naga-wasm not installed",
      cached: false,
    };
    _transpileCache.set(cacheKey, result);
    return result;
  }

  try {
    const wgsl = naga.convert_shader(source, "glsl", "wgsl");
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
