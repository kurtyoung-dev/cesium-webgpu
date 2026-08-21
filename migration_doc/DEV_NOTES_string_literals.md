# DEV notes — string literals

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

This lane rewrites literal values rather than source-language comments, so
each entry banks complete source lines. Original and replacement blocks are
ordered line for line; unchanged intervening lines are omitted.

### `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — `SUN_SHADER_WGSL`

_Moved 2026-08-21._

Original literal lines (verbatim):

```text
  // C7-SUN-STARS-EXTINCTION — per-channel atmospheric transmittance along
  // C12-29 S1 — eclipseAlpha occupies the former _p2 pad at offset 124.
  // ShaderDefine bit (the registry is exhausted; C12 exit-gate item 5).
  // C12-19 — the disc's LINEAR radiance occupies the former \`_sunPad1\` pad at
  // offset 156. Exactly the C12-29 S1 manoeuvre that turned \`_p2\` into
  // ShaderDefine bit (C12 exit condition 5).
  // BUG-1 fix — near-passthrough sample (matches WebGL SunFS.glsl). The baked
  // C12-19 — true HDR disc radiance, the WGSL twin of SunFS.glsl's
  // (alpha is this pipeline's ALPHA_BLEND destination weight since C11-115 —
  // C7-SUN-STARS-EXTINCTION — attenuate + redden the sun by the atmospheric
  // C12-29 S1 — continuous eclipse / occultation fade, the WGSL twin of
  // C11-115 flips this target to ALPHA_BLEND. eclipseAlpha == 1.0 whenever
```

Replacement:

```text
  // Atmospheric transmittance is applied per channel along
  // eclipseAlpha occupies the former _p2 pad at offset 124.
  // ShaderDefine bit because the lo-word registry is exhausted.
  // The disc's LINEAR radiance occupies the former \`_sunPad1\` pad at
  // offset 156. Reusing this pad mirrors the conversion of \`_p2\` into
  // ShaderDefine bit because the lo-word registry is exhausted.
  // This near-passthrough sample matches WebGL SunFS.glsl. The baked
  // Apply true HDR disc radiance, the WGSL twin of SunFS.glsl's
  // (alpha is this pipeline's ALPHA_BLEND destination weight —
  // Attenuate and redden the sun by the atmospheric
  // Apply a continuous eclipse / occultation fade, the WGSL twin of
  // the target instead uses ALPHA_BLEND. eclipseAlpha == 1.0 whenever
```

Kept because these comments encode uniform-layout invariants, transfer-function ordering, blend semantics, and exact no-op conditions. The replacements retain those constraints without development provenance.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts` — `getDebugFragmentShaderModule`

_Moved 2026-08-21._

Original literal lines (verbatim):

```text
// Slice 5c-B Batch 117 — debug fragment variants emit FragOutput too.
```

Replacement:

```text
// Debug fragment variants emit FragOutput too.
```

Kept because the emitted WGSL comment documents the output contract for appended debug variants. The replacement retains that shader-interface constraint.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeFragmentDebug.ts` — `GLOBE_FRAGMENT_DEBUG_MODES`

_Moved 2026-08-21._

Original literal lines (verbatim):

```text
        "Per-vertex `v_atmosphereRayleighColor` varying. Since C9-14 the VS per-vertex ground-atmosphere march runs ONLY while this or `mie-v` is active (tile.time in [13.5e9,15.5e9]); production shades ground atmosphere per-fragment, so activating this mode is what populates the varying.",
      description: "Skip the underground tint blend (GLOBE-UNDERGROUND-COLOR).",
        "Skip the per-fragment translucency alpha ramp (GLOBE-TRANSLUCENCY-ALPHA); the multi-pass blend pipelines still run.",
        "Revert the B506 fragment-entry UV clamp to raw interpolated UVs (tile-seam term).",
      description: "Skip the B506 Phong ocean sun-glint specular term.",
```

Replacement:

```text
        "Per-vertex `v_atmosphereRayleighColor` varying. The VS per-vertex ground-atmosphere march runs only while this or `mie-v` is active (tile.time in [13.5e9,15.5e9]); production shades ground atmosphere per-fragment, so activating this mode is what populates the varying.",
      description: "Skip the underground tint blend.",
        "Skip the per-fragment translucency alpha ramp; the multi-pass blend pipelines still run.",
        "Revert the fragment-entry UV clamp to raw interpolated UVs (tile-seam term).",
      description: "Skip the Phong ocean sun-glint specular term.",
```

Kept because these descriptions define activation and bypass behavior exposed by the globe-fragment debug modes. The replacements preserve those diagnostics without tracker labels.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts` — `WebGPUPostProcessPipeline#_createIdentityBlitPipeline`

_Moved 2026-08-21._

Original literal lines (verbatim):

```text
// Session 65 Batch 48 (revert of Batch 47): the inline pow(1/2.2)
// encode added in Batch 47 caused double-gamma-encoding for the FOG /
// look reported as 'BUG-WEBGPU-CUBEMAP-DOUBLE-GAMMA'-style symptom.
// signature probe-darkness-quant.mjs measured pre-Batch-47.
// Both options are bigger than Batch 47 attempted; tracking under
// NEW-VR2-3-IMAGERY-WASH-OUT.
```

Replacement:

```text
// The blit's inline pow(1/2.2) encode was reverted because it caused
// double-gamma encoding for the FOG /
// appearance characteristic of double-gamma encoding.
// signature expected when the final encode is missing.
// Either option requires a coordinated color-space change across every
// canvas-writing pipeline; this identity blit therefore remains a no-op.
```

Kept because this is the local explanation for omitting a blit-side transfer encode and for the coordinated alternatives. The replacement preserves the double-gamma physics and the missing-encode tradeoff.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts` — `configureWebGPUPostProcessPipeline`

_Moved 2026-08-21._

Original literal lines (verbatim):

```text
          "`wgslFragmentShader` set are honored. Track NEW-POSTPROCESS-USER-WGSL.",
```

Replacement:

```text
          "`wgslFragmentShader` set are honored.",
```

Kept because the warning tells users why custom post-process stages were skipped and how to supply WGSL. The replacement preserves that action while removing internal tracker routing.

### `packages/engine/Source/Renderer/WebGPU/WebGPUSSREffect.ts` — `executeSSR`

_Moved 2026-08-21._

Original literal lines (verbatim):

```text
  // than reflections. A real normal G-buffer is gated on FEAT-GAP-01
  // (Phase-8a Foundation: depth prepass + normal G-buffer). Surface this
          "A real normal G-buffer is gated on FEAT-GAP-01 (Phase-8a Foundation). " +
          "See migration_doc/DEFERRED_WORK.md.",
```

Replacement:

```text
  // than reflections. A real normal G-buffer for this path awaits the
  // depth-prepass and normal G-buffer foundation work. Surface this
          "No normal G-buffer was available for this view. " +
          "Set `scene.screenSpaceReflections = false` to avoid the placeholder noise.",
```

Kept because the warning exposes the unavailable normal-buffer input and the resulting placeholder noise. The replacement names the per-view condition honestly (the backend does render a normal G-buffer for other consumers) and gives the concrete disable property instead of an internal document pointer; the adjacent comment loses its tracker id and phase label the same way.

### `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.ts` — `WebGPUModelPipelineCache#_getOrCreateShaderModule`

_Moved 2026-08-21._

Original literal lines (verbatim):

```text
        label: "Model PBR FORCED-ERROR (C2-22 probe)",
```

Replacement:

```text
        label: "Model PBR FORCED-ERROR (deliberate probe path)",
```

Kept because the label distinguishes a deliberate invalid-module probe from an accidental shader failure. The replacement retains that diagnostic function.

### `packages/engine/Source/Scene/Model/MetadataWGSLPipelineStage.js` — `generateMetadataWGSL / generateMetadataPickWGSL`

_Moved 2026-08-21._

Original literal lines (verbatim):

```text
    "// DP-H46b/c/d — GENERATED structural-metadata chunk (property attributes + textures + tables).",
  lines.push("// Replaces the DP-H46a stub; declared real per metadata class.");
    "// DP-H46e — GENERATED metadata-pick stage (scene.pickMetadata producer).",
```

Replacement:

```text
    "// GENERATED structural-metadata chunk: property attributes, textures, and tables.",
  lines.push("// GENERATED structural-metadata declarations for this class.");
    "// GENERATED metadata-pick stage: produces values for scene.pickMetadata queries.",
```

Kept because these runtime-emitted comments identify the generated structural-metadata declarations, data chunk, and metadata-pick stage. The replacements retain those chunk descriptions without design-point ids.

