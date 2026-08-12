/// <reference types="@webgpu/types" />
/**
 * Globe-surface shader-module factory for `WebGPUGlobeSurfaceRenderer`.
 *
 * Five entry points:
 *
 *   - `initShaderCache(host, code)` — creates the per-device
 *     `WebGPUShaderModuleCache` and prewarms the baseline + GEODETIC_NORMAL
 *     define sets.
 *   - `getProductionShaderModule(host, defines)` — fetches/compiles the
 *     production GlobeTerrain module for a given defines bitmask.
 *   - `getDebugFragmentShaderModule(host, defines)` — lazily builds the
 *     augmented module that hosts the three debug fragment entry points
 *     (`fragmentDebugTri`, `fragmentDebugLod`, `fragmentDebugNormal`).
 *     Returns null if the device rejects the augmented source.
 *   - `getClipDistancesShaderModule(host, defines)` — lazily builds the
 *     `@builtin(clip_distances)` variant for hardware-clipping pipelines.
 *     Returns null if the source's anchor strings can't be located or the
 *     device rejects the augmented WGSL.
 *   - `buildClipDistancesShaderSource(source)` — pure string transform that
 *     produces the clip-distances variant from a preprocessed base source.
 *     Returns null if any of the three anchor strings is missing.
 *
 * The renderer's `_initShaderCache`, `_getProductionShaderModule`,
 * `_getDebugFragmentShaderModule` and `_getClipDistancesShaderModule` are
 * one-line delegators that pass `this` as the host.
 *
 * The five host fields the factory reaches into are public on the renderer,
 * with the underscore prefix retained to mark them as not callable from
 * outside the Renderer package.
 *
 * @module WebGPUGlobeSurfaceShaders
 */

import {
  ShaderDefine,
  ShaderDefineHi,
  ShaderSourceId,
} from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { preprocess as preprocessShaderSource } from "./WebGPUShaderPreprocessor.js";

/**
 * The renderer surface the shader factory reaches into. All five fields are
 * read+write via the host adapter:
 *
 *   - `_device` is read-only here (the factory never swaps the device).
 *   - `_shaderCode` is written once by `initShaderCache` and read by every
 *     subsequent factory call.
 *   - `_shaderModuleCache` is constructed by `initShaderCache` and read by
 *     `getProductionShaderModule`.
 *   - The two augmented-module Maps are read+write — each factory call
 *     probes the Map for a cached entry and inserts (`set`) the new
 *     module (or `null` for "device rejected this define-set, don't retry").
 */
export interface ShaderFactoryHost {
  _device: GPUDevice | null;
  _shaderCode: string;
  _shaderModuleCache: WebGPUShaderModuleCache | null;
  readonly _debugFragmentShaderModules: Map<number, GPUShaderModule | null>;
  readonly _clipDistancesShaderModules: Map<number, GPUShaderModule | null>;
  /**
   * True when the device's `maxSampledTexturesPerShaderStage` cannot fit the
   * full 28-texture globe layout and the renderer runs the 4-imagery-slot
   * variant. Every defines computation (pipelines, wireframe, material,
   * prewarm) ORs `ShaderDefine.GLOBE_IMAGERY_REDUCED` when set. Fixed per
   * device — captured once at renderer `initialize()`.
   */
  readonly _imageryReduced?: boolean;
  /**
   * Mirrored each frame from `Globe.enableEnhancedOcean` (default false).
   * When true, every GlobeTerrain module fetch ORs the
   * `ShaderDefineHi.ENHANCED_OCEAN` hi-word bit into `definesHi`, selecting
   * the enhanced ocean styling branch in `computeEnhancedOcean`; when false,
   * the module compiles the classic WebGL-parity `//>>else` branch. The wave
   * march is unconditional in both. The flag is read here rather than passed
   * per call so every production and clip-distances module the factory hands
   * back is consistent with the renderer's current ocean state.
   */
  readonly _enhancedOceanEnabled?: boolean;
}

// Hi-word define mask for the current ocean state. Returns
// `ShaderDefineHi.ENHANCED_OCEAN` when the renderer mirrors
// `Globe.enableEnhancedOcean === true`, else 0 (classic WebGL-parity styling).
// The value threads into `getOrCreate(..., definesHi)` + `preprocess(...,
// definesHi)`, which key the compiled module by the hi word.
function oceanDefinesHi(host: ShaderFactoryHost): number {
  return host._enhancedOceanEnabled ? ShaderDefineHi.ENHANCED_OCEAN : 0;
}

// The globe terrain shader flows through `WebGPUShaderModuleCache`, which
// preprocesses `//>>ifdef` directives against an active-defines bitmask,
// deduplicates module compilation across the wireframe, debug and production
// pipelines that share a source, and prewarms common variants so the
// first-frame render path has no shader-compile jank.
export function initShaderCache(host: ShaderFactoryHost, code: string): void {
  host._shaderCode = code;
  host._shaderModuleCache = new WebGPUShaderModuleCache(host._device!);

  // Prewarm the baseline module plus every variant the first ~30 frames of
  // rendering touch. Compiling them up front moves 10-20 ms of shader-compile
  // cost off the render path. The list is deliberately concrete rather than
  // computed, and must match the call sites in `_createPipelineVariant` /
  // `_createWireframePipelineVariant`. On a reduced-imagery device every globe
  // module carries the GLOBE_IMAGERY_REDUCED bit, so only the variants that
  // will actually be requested are warmed — the full-layout variants would be
  // dead weight there, and vice versa.
  const reducedBit = host._imageryReduced
    ? ShaderDefine.GLOBE_IMAGERY_REDUCED
    : 0;
  const prewarmSets: readonly number[] = [
    reducedBit, // production terrain without geodetic normals
    ShaderDefine.GEODETIC_NORMAL | reducedBit, // exaggerated terrain
  ];
  host._shaderModuleCache.prewarm(
    ShaderSourceId.GLOBE_TERRAIN,
    code,
    prewarmSets,
    "GlobeTerrain shader",
  );
}

/**
 * Resolve the production terrain shader module for a given active-defines
 * bitmask. First call per define-set runs the `//>>ifdef` preprocessor and
 * `createShaderModule`; later calls return the cached module directly.
 */
export function getProductionShaderModule(
  host: ShaderFactoryHost,
  defines: number,
): GPUShaderModule {
  // The hi-word `ENHANCED_OCEAN` bit rides `definesHi`. The module cache keys
  // the compiled module by (sourceId, defines, definesHi), so the enhanced and
  // classic ocean styling variants dedupe as distinct modules on a shared
  // device.
  const definesHi = oceanDefinesHi(host);
  const label =
    definesHi === 0
      ? "GlobeTerrain shader"
      : `GlobeTerrain shader (hi=0x${definesHi.toString(16)})`;
  return host._shaderModuleCache!.getOrCreate(
    ShaderSourceId.GLOBE_TERRAIN,
    host._shaderCode,
    defines,
    label,
    0,
    definesHi,
  );
}

/**
 * Lazily builds the augmented shader module that hosts every debug
 * fragment entry point. The vertex stages are reused unchanged from the
 * production module, so the augmented version can pair with any of the
 * existing `vertexMain*` variants — only the fragment binding differs.
 *
 * Hosted entry points:
 *   - `fragmentDebugTri`     — per-triangle face color via @builtin(primitive_index)
 *   - `fragmentDebugLod`     — tile depth-level color overlay (reads tile.tileLevel)
 *   - `fragmentDebugNormal`  — eye-space normal mapped into RGB
 *
 * Wrapped in `pushErrorScope("validation")` so a driver that rejects
 * `@builtin(primitive_index)` (older Mali/Intel paths) disables the
 * entire debug path silently instead of crashing the frame.
 *
 * Returns null if the device fails to compile the augmented module.
 * Result is cached forever.
 */
export function getDebugFragmentShaderModule(
  host: ShaderFactoryHost,
  defines: number,
): GPUShaderModule | null {
  // Probe-and-cache per active-defines set. A `null` value means the
  // device rejected the augmented source for this define-set during
  // the one-shot validation probe; don't retry.
  if (host._debugFragmentShaderModules.has(defines)) {
    return host._debugFragmentShaderModules.get(defines) ?? null;
  }
  const device = host._device;
  if (!device || !host._shaderCode) {
    return null;
  }

  // Run the `//>>ifdef` preprocessor on the base source before appending the
  // debug fragment entry points. Skipping it leaves the raw directive lines
  // as comments while both branches' body lines accumulate, producing invalid
  // WGSL like `f(a); g(b));`.
  const preprocessedBase = preprocessShaderSource(host._shaderCode, defines);

  // The three debug fragment entry points share the same vertex outputs
  // as the production fragment, so they can be appended to the existing
  // shader source without touching VertexOutput / TileUniforms.
  //
  // - fragmentDebugTri: uses @builtin(primitive_index) for face coloring.
  // - fragmentDebugLod: reads `tile.tileLevel` and maps it to a
  //   deterministic color.
  // - fragmentDebugNormal: emits the interpolated eye-space normal as
  //   RGB after a [-1,1]→[0,1] remap, which verifies the normal-map
  //   shaders' orientation.
  const augmented = `${preprocessedBase}

// Slice 5c-B Batch 117 — debug fragment variants emit FragOutput too.
// FragOutput + makeFragOutput are defined in the production source
// (GlobeTerrain.wgsl, which is preprocessedBase above) — these debug
// variants are appended to that source, so the struct + helper are
// already in scope. Slot 1 carries v_normalEC for the Lod / Normal
// variants (which have a VertexOutput); the Tri variant only has
// primitive_index input and emits the sentinel (0,0,0) so consumers
// fall back to depth reconstruction at debug-Tri-rendered pixels.
@fragment
fn fragmentDebugTri(@builtin(primitive_index) primIndex: u32) -> FragOutput {
  let r = f32((primIndex * 73u) & 255u) / 255.0;
  let g = f32((primIndex * 151u + 31u) & 255u) / 255.0;
  let b = f32((primIndex * 211u + 89u) & 255u) / 255.0;
  // No VertexOutput input so no eye-space normal available; emit
  // sentinel for slot 1 (consumers detect via length(xyz) < 0.01).
  return makeFragOutput(vec4<f32>(r, g, b, 1.0), vec3<f32>(0.0));
}

@fragment
fn fragmentDebugLod(input: VertexOutput) -> FragOutput {
  // Deterministic per-level palette: 12 hues cycle through the spectrum
  // so adjacent levels are visually distinct. Levels above 11 wrap.
  let level = u32(tile.tileControls.x + 0.5) % 12u;
  var color: vec3<f32>;
  switch (level) {
    case 0u:  { color = vec3<f32>(1.00, 0.00, 0.00); }
    case 1u:  { color = vec3<f32>(1.00, 0.50, 0.00); }
    case 2u:  { color = vec3<f32>(1.00, 1.00, 0.00); }
    case 3u:  { color = vec3<f32>(0.50, 1.00, 0.00); }
    case 4u:  { color = vec3<f32>(0.00, 1.00, 0.00); }
    case 5u:  { color = vec3<f32>(0.00, 1.00, 0.50); }
    case 6u:  { color = vec3<f32>(0.00, 1.00, 1.00); }
    case 7u:  { color = vec3<f32>(0.00, 0.50, 1.00); }
    case 8u:  { color = vec3<f32>(0.00, 0.00, 1.00); }
    case 9u:  { color = vec3<f32>(0.50, 0.00, 1.00); }
    case 10u: { color = vec3<f32>(1.00, 0.00, 1.00); }
    default:  { color = vec3<f32>(1.00, 0.00, 0.50); }
  }
  return makeFragOutput(
    vec4<f32>(color, 1.0),
    normalize(input.v_normalEC),
  );
}

@fragment
fn fragmentDebugNormal(input: VertexOutput) -> FragOutput {
  // Eye-space normal as RGB. Remap from [-1,1] to [0,1] so all components
  // are visible. Useful for verifying that vertex normals are correctly
  // interpolated and that the normal-map shaders (WGF-5) produce
  // sensible orientations. Flat-shaded tiles will show single colors
  // per primitive; smooth-shaded tiles will show gradients.
  let n = normalize(input.v_normalEC);
  return makeFragOutput(vec4<f32>(n * 0.5 + 0.5, 1.0), n);
}
`;

  try {
    device.pushErrorScope("validation");
    const mod = device.createShaderModule({
      label: `GlobeTerrain shader (debug variants, defines=0x${defines.toString(16)})`,
      code: augmented,
    });
    // Drain the validation scope. A driver that rejected the builtin still
    // leaves a module reference behind, but the next pipeline build fails
    // noisily, so replace the entry with `null` and never retry this
    // define-set.
    device.popErrorScope().then((err) => {
      if (err) {
        host._debugFragmentShaderModules.set(defines, null);
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[WebGPUGlobeSurfaceRenderer] debug fragment variants disabled ` +
            `for defines=0x${defines.toString(16)}: ${err.message}`,
        );
        //>>includeEnd('debug');
      }
    });
    host._debugFragmentShaderModules.set(defines, mod);
    return mod;
  } catch (e) {
    host._debugFragmentShaderModules.set(defines, null);
    return null;
  }
}

/**
 * Build (and cache) the GlobeTerrain shader module variant that uses
 * `@builtin(clip_distances)` for hardware clipping planes. The base source is
 * augmented in three places:
 *
 *   1. The `VertexOutput` struct gets a new
 *      `@builtin(clip_distances) clipDistances: array<f32, 8>` member.
 *
 *   2. The `processVertex` function writes 8 clip distances at the
 *      end (right after the existing far-plane Z clamp), each computed
 *      as `dot(eqHW.xyz, eyePos) + eqHW.w` against
 *      `effects.clipPlaneEqHW[i]`. The CPU has already precomputed
 *      `eqHW = (n.xyz, d + dot(n, cameraWC))` in FP64 — see
 *      `WebGPUClipDistancePrecompute.ts`.
 *
 *   3. The fragment-side `globeClipByPlanes(input.v_positionMC)`
 *      discard is neutralized so the rasterizer is the sole authority
 *      for the clipping decision. The edge-highlight code path that
 *      reads `clippingPlaneTex` for visualization is left untouched
 *      because it's a color decoration, not a geometric clip.
 *
 * The variant requires the `clip-distances` device feature; the caller
 * gates pipeline creation on `context.useHardwareClipDistances`.
 * Returns null if the device rejects the augmented source — callers
 * fall back to the production module + the legacy fragment-discard
 * path.
 */
export function getClipDistancesShaderModule(
  host: ShaderFactoryHost,
  defines: number,
): GPUShaderModule | null {
  // Probe-and-cache per active-defines set; same pattern as the debug
  // fragment module.
  if (host._clipDistancesShaderModules.has(defines)) {
    return host._clipDistancesShaderModules.get(defines) ?? null;
  }
  const device = host._device;
  if (!device || !host._shaderCode) {
    return null;
  }

  // Preprocess first so the anchor-string search in
  // `buildClipDistancesShaderSource` sees a valid-WGSL base. Without it the
  // `//>>ifdef` body lines (for instance the extra
  // `input.geodeticSurfaceNormal` argument) are still present and match the
  // anchor patterns, but produce invalid output once combined with the
  // `//>>else` branch.
  //
  // The hi word is passed so the clip-distances variant compiles the same
  // ocean styling branch as the on-screen production module; the clip variant
  // uses the real `fragmentMain`, so a mismatch renders classic water under
  // active clipping planes while the rest renders enhanced. The
  // `_clipDistancesShaderModules` map keys by `defines` only, and the renderer
  // wipes it on an ocean-flag flip, so `definesHi` is constant within a map
  // epoch.
  const definesHi = oceanDefinesHi(host);
  const preprocessedBase = preprocessShaderSource(
    host._shaderCode,
    defines,
    definesHi,
  );
  const augmented = buildClipDistancesShaderSource(preprocessedBase);
  if (augmented === null) {
    //>>includeStart('debug', pragmas.debug);
    console.warn(
      "[WebGPUGlobeSurfaceRenderer] clip-distances shader augmentation " +
        "could not locate one of its anchor strings; falling back to the " +
        "fragment-discard path.",
    );
    //>>includeEnd('debug');
    host._clipDistancesShaderModules.set(defines, null);
    return null;
  }

  try {
    device.pushErrorScope("validation");
    const mod = device.createShaderModule({
      label: `GlobeTerrain shader (clip-distances variant, defines=0x${defines.toString(16)})`,
      code: augmented,
    });
    device.popErrorScope().then((err) => {
      if (err) {
        host._clipDistancesShaderModules.set(defines, null);
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[WebGPUGlobeSurfaceRenderer] clip-distances variant disabled ` +
            `for defines=0x${defines.toString(16)}: ${err.message}`,
        );
        //>>includeEnd('debug');
      }
    });
    host._clipDistancesShaderModules.set(defines, mod);
    return mod;
  } catch (e) {
    host._clipDistancesShaderModules.set(defines, null);
    return null;
  }
}

/**
 * Pure string transformation: take the base GlobeTerrain.wgsl source and
 * return the clip-distances variant. Returns null when any of the three
 * anchor strings is missing — that means the source has drifted and the
 * substitution is unsafe.
 *
 * Kept as a separate function (not inlined into `getClipDistancesShaderModule`)
 * so it can be unit-tested against fixture sources without needing a real
 * GPUDevice.
 */
export function buildClipDistancesShaderSource(source: string): string | null {
  // Anchor 1: VertexOutput struct definition. Inject the builtin
  // clip-distances output as the last member, right before the closing
  // brace. Matching the exact existing v_distance line keeps the patch from
  // drifting onto an unrelated struct.
  const vertexOutputAnchor = "@location(4) v_distance: f32,\n};";
  if (!source.includes(vertexOutputAnchor)) {
    return null;
  }
  let out = source.replace(
    vertexOutputAnchor,
    "@location(4) v_distance: f32,\n" +
      "  // WGF-1: hardware clip distances. The 8 entries hold the\n" +
      "  // signed distance from the eye-relative vertex position to\n" +
      "  // each clipping plane; the rasterizer clips fragments where\n" +
      "  // any value is < 0. Slots beyond the active plane count are\n" +
      "  // computed against `(0,0,0,+inf)` and trivially survive.\n" +
      "  @builtin(clip_distances) clipDistances: array<f32, 8>,\n" +
      "};",
  );

  // Anchor 2: end of processVertex (right after the far-plane Z clamp).
  // Compute eyeRelativePos in WC, then write all 8 clip distances. The
  // 2D / Columbus / Morphing branches don't go through the RTE path,
  // so eyePos is the direct (positionWC - cameraWC) which gives
  // FP32-precision 0.6m noise at Earth radius — fine because clipping
  // planes are the only consumer and they have meter-scale tolerance.
  // For the SCENE3D path the same expression is exactly the already-computed
  // `rtePosition.xyz`; recomputing it here lets the augmentation work
  // uniformly across all four scene modes.
  const processVertexAnchor =
    "out.position.z = min(out.position.z, out.position.w);\n\n  return out;";
  if (!out.includes(processVertexAnchor)) {
    return null;
  }
  const cdInjection =
    "out.position.z = min(out.position.z, out.position.w);\n\n" +
    "  // WGF-1: emit hardware clip distances. eyePosWC reconstructs the\n" +
    "  // eye-relative position in the same coordinate frame the CPU used\n" +
    "  // when precomputing `effects.clipPlaneEqHW`. We use position3DWC\n" +
    "  // (the world-space terrain position) and subtract the unencoded\n" +
    "  // camera (high+low). At Earth radius this is FP32 with ~0.6 m\n" +
    "  // noise, which is comfortably below the meter-scale tolerance of\n" +
    "  // any realistic clipping plane test.\n" +
    "  let cdEyePos = position3DWC - (camera.encodedCameraHigh + camera.encodedCameraLow);\n" +
    "  for (var cdI: u32 = 0u; cdI < 8u; cdI = cdI + 1u) {\n" +
    "    let eq = effects.clipPlaneEqHW[cdI];\n" +
    "    out.clipDistances[cdI] = dot(eq.xyz, cdEyePos) + eq.w;\n" +
    "  }\n\n" +
    "  return out;";
  out = out.replace(processVertexAnchor, cdInjection);

  // Anchor 3: fragment-side discard. Removing it is unconditionally safe
  // because the rasterizer's clip-distance check is a strict superset — it
  // operates on every interpolated pixel of every clipped triangle. The
  // discard line becomes a comment rather than disappearing so line numbers
  // in errors stay close to the original.
  const fragmentDiscardAnchor =
    "if (globeClipByPlanes(input.v_positionMC)) { discard; }";
  if (!out.includes(fragmentDiscardAnchor)) {
    return null;
  }
  out = out.replace(
    fragmentDiscardAnchor,
    "// WGF-1: clipping handled by rasterizer via @builtin(clip_distances).",
  );

  // The clip_distances builtin requires an `enable` directive at the top
  // of the WGSL file (matches the f16 / subgroups pattern). The directive
  // must precede every other declaration; prepend it unconditionally.
  return `enable clip_distances;\n${out}`;
}
