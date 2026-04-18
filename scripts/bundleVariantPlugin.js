/**
 * @module bundleVariantPlugin
 *
 * esbuild plugin that aliases backend-specific modules to empty stubs
 * based on the requested build variant. This is what makes the
 * `webgl-only` / `webgpu-only` builds actually shrink — without it,
 * static imports of GLSL shader strings (and equivalently, WGSL strings)
 * pull both backends' resources into every bundle regardless of what
 * the entry-point barrel exports.
 *
 * Variants:
 *   - "dual"        — no aliasing, every module included (current behaviour)
 *   - "webgl-only"  — WebGPU renderer + WGSL shaders → emptyModule
 *   - "webgpu-only" — GLSL shader strings → emptyShader
 *
 * The aliasing happens via esbuild's `onResolve` hook, so it's transparent
 * to the source files — they don't need to be modified at all. The Scene
 * file's WebGL fallback path imports `GlobeFS` as usual; in a webgpu-only
 * build that import resolves to an empty string, the WebGPU feature
 * renderer intercepts before the fallback runs, and the WebGL shader
 * compile site is never reached.
 *
 * Stub files:
 *   - scripts/stubs/emptyShader.js  — `export default ""` for GLSL strings
 *   - scripts/stubs/emptyModule.js  — Proxy that throws if anyone calls
 *     into it, used for WebGPU TS modules in WebGL-only builds
 *
 * @typedef {"dual" | "webgl-only" | "webgpu-only"} BundleVariant
 */

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_SHADER = path.resolve(__dirname, "stubs", "emptyShader.js");
const STUB_MODULE = path.resolve(__dirname, "stubs", "emptyModule.js");

/**
 * Returns true if `absPath` is a GLSL shader string module under
 * `Source/Shaders/` (NOT under `Source/Shaders/WebGPU/`).
 *
 * @param {string} absPath
 */
function isGLSLShaderFile(absPath) {
  // Normalise to forward slashes for cross-platform matching
  const p = absPath.replace(/\\/g, "/");
  // Match …/Source/Shaders/<file>.js but exclude …/Source/Shaders/WebGPU/…
  const inShaders = p.includes("/Source/Shaders/");
  const inWebGPU = p.includes("/Source/Shaders/WebGPU/");
  if (!inShaders || inWebGPU) {
    return false;
  }
  return p.endsWith(".js") || p.endsWith(".glsl");
}

/**
 * Files under `Source/Renderer/WebGPU/` that are backend-neutral
 * compat surfaces and must remain available in webgl-only builds:
 *
 *   - WebGLCompatibilityStub — Proton-style translation layer that
 *     by design works in ANY variant (its whole purpose is bridging
 *     WebGL-shape calls to whatever backend is active).
 *   - WebGPUShaderTranslator — pluggable translator registry; user
 *     code registers/reads the active translator regardless of
 *     backend choice.
 *   - WebGLStubPipelineExtractor — pure utility that maps stub state
 *     → PipelineVariant; no WebGPU-renderer dependency at runtime.
 *   - WebGPUNagaTranspiler — lazy-loads naga-wasm only when a user
 *     actually requests GLSL translation.
 *
 * These files import from WebGPU types and rendering APIs, but their
 * exported surface is consumable without the WebGPU backend being
 * active. Aliasing them to empty stubs breaks the engine barrel's
 * named re-exports for variants that strip the WebGPU directory.
 */
const WEBGPU_COMPAT_EXEMPTIONS = [
  "/Source/Renderer/WebGPU/WebGLCompatibilityStub",
  "/Source/Renderer/WebGPU/WebGPUShaderTranslator",
  "/Source/Renderer/WebGPU/WebGLStubPipelineExtractor",
  "/Source/Renderer/WebGPU/WebGPUNagaTranspiler",
];

/**
 * Returns true if `absPath` is part of the WebGPU backend — either a TS
 * file under `Source/Renderer/WebGPU/` or a WGSL string module under
 * `Source/Shaders/WebGPU/`. Backend-neutral compat files are excluded
 * via `WEBGPU_COMPAT_EXEMPTIONS`.
 *
 * @param {string} absPath
 */
function isWebGPUFile(absPath) {
  const p = absPath.replace(/\\/g, "/");
  if (
    !p.includes("/Source/Renderer/WebGPU/") &&
    !p.includes("/Source/Shaders/WebGPU/")
  ) {
    return false;
  }
  // Don't alias the compat-surface files — they must stay resolvable
  // in webgl-only builds because the engine's index.js re-exports
  // named symbols from them (registerShaderTranslator, etc.). The
  // files themselves import WebGPU types, but the TYPES are erased
  // at compile time and the RUNTIME code paths are either lazy or
  // register-only.
  for (const exempt of WEBGPU_COMPAT_EXEMPTIONS) {
    if (p.includes(exempt)) {
      return false;
    }
  }
  return true;
}

/**
 * Build the esbuild plugin for the requested variant. Returns `null`
 * for the dual variant (no aliasing needed) so callers can splat the
 * result into a plugin array unconditionally:
 *
 *   plugins: [bundleVariantPlugin("webgpu-only")].filter(Boolean)
 *
 * @param {BundleVariant} variant
 * @returns {import("esbuild").Plugin | null}
 */
export function bundleVariantPlugin(variant) {
  if (variant === "dual") {
    return null;
  }

  return {
    name: `cesium-bundle-variant-${variant}`,
    setup(build) {
      // Intercept *every* import resolution. We need onResolve here
      // (rather than esbuild's static `alias` option) because we're
      // pattern-matching path SHAPE, not exact paths — there are 200+
      // shader files and 100+ WebGPU files. A static alias map would
      // be 300 lines and brittle.
      // Decision cache: maps a synthetic candidate path to either a
      // redirect target (string) or `false` (no redirect). The cache
      // makes pattern matching O(1) for repeat lookups, which matters
      // because Cesium has ~3000 modules and plenty of import overlap.
      const decisionCache = new Map();

      build.onResolve({ filter: /.*/ }, (args) => {
        // ── Re-entry guard MUST be the first thing we check ──
        // The previous implementation called `build.resolve()` here,
        // which is expensive (it walks the full plugin chain again)
        // AND requires this re-entry guard to avoid infinite recursion.
        // The synthetic path approach below avoids both costs entirely.
        if (args.pluginData && args.pluginData._variantSkip) {
          return null;
        }

        // Skip esbuild-internal virtual modules.
        if (args.path.startsWith("\u0000")) {
          return null;
        }

        // Cheap pre-filter: only relative or absolute paths can be
        // backend-specific. Bare specifiers like "@cesium/engine" or
        // "lodash" are never shader/renderer files.
        if (
          !args.path.startsWith(".") &&
          !args.path.startsWith("/") &&
          !path.isAbsolute(args.path)
        ) {
          return null;
        }

        // Synthetic path resolution — much cheaper than build.resolve()
        // because it skips the entire plugin chain. We compute what
        // esbuild WOULD resolve to (via path.resolve from the importer's
        // directory) and pattern-match against that. This works for
        // Cesium because the codebase consistently uses explicit `.js`
        // extensions on relative imports — no extension-guessing or
        // tsconfig path mapping is required.
        //
        // If the synthetic path doesn't match a backend-specific
        // pattern, we return null and let esbuild's normal resolver
        // handle it. The synthetic check is a fast path-string match,
        // not a filesystem stat.
        const candidate = path.resolve(args.resolveDir, args.path);

        // Decision cache lookup keyed on the candidate.
        let cached = decisionCache.get(candidate);
        if (cached === undefined) {
          if (variant === "webgpu-only" && isGLSLShaderFile(candidate)) {
            cached = STUB_SHADER;
          } else if (variant === "webgl-only" && isWebGPUFile(candidate)) {
            const isShader = candidate
              .replace(/\\/g, "/")
              .includes("/Source/Shaders/WebGPU/");
            cached = isShader ? STUB_SHADER : STUB_MODULE;
          } else {
            cached = false;
          }
          decisionCache.set(candidate, cached);
        }

        if (cached === false) {
          // Not a backend-specific file — let esbuild's default
          // resolver handle it. Returning null is important so other
          // onResolve plugins (registered after us) get a turn.
          return null;
        }

        // Redirect to the stub. The stub path is absolute, so esbuild
        // accepts it directly without re-running the resolver chain.
        return { path: cached };
      });
    },
  };
}

export default bundleVariantPlugin;
