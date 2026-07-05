# WebGPUContext / WebGPUSceneRenderer Decomposition Plan

**Created:** 2026-04-30 (Batch 127)
**Origin:** 2026-04-30 audit (`migration_doc/audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md`)

## Status

> **Updated 2026-07-05 (Q35-WEBGPUCONTEXT-DECOMP-REMAINDER, culler-pool slice).**
> An *eighth* Context helper landed: `WebGPUContextCullerPool.ts` (the GPU
> frustum-culler pool cluster), taking `WebGPUContext.ts` from **5432 → 5158
> lines** (−274). The lazy-init main/opaque-frustum/cascade/translucent culler
> getters + the idle-decay reaper (`reapIdleAuxCullers`) + the immediate
> `reapAllAuxCullers` teardown moved to host-interface free functions; the
> `GPUCullerInstance` type + the `MAX_AUX_CULLER_INDEX` / `IDLE_DECAY_FRAMES`
> constants moved with them. 14 culler fields flipped to the public-underscore
> convention. Behavior-preserving: variant smoke test all-3 PASS, culler-pool
> acceptance probe exercises every extracted entry point (incl. the
> `'never'`-hint refusal path) with zero throws / zero console errors, globe
> renders identically. Off-gate: culling is `'auto'`-gated + only dispatches on
> high-density scenes, and the extraction is a pure code-move, so the default
> path is byte-identical. Only the SceneRenderer pass family remains as the
> genuinely-hard residual (resists the self-contained-helper pattern).
>
> **Updated 2026-07-05 (Batch 593, C4-WEBGPUCONTEXT-DECOMP / Q35 slice).**
> A *seventh* Context helper landed: `WebGPUContextCanvasConfig.ts` (the HDR
> canvas-output cluster), taking `WebGPUContext.ts` from **5534 → 5432 lines**
> (−102). Behavior-preserving (A/B build confirmed identical GPU-validation
> behavior; off-gate SDR path byte-identical). This is one increment of the
> Q35 epic — the culler-pool cluster + the SceneRenderer pass family remain
> as further slices. See the new row in "Already extracted".
>
> **Updated 2026-05-30 (HEAD `88b111e49c`, Batch 185).** The earlier
> header counts were *inverted* — they read as if both files had shrunk
> after Batch 127. In reality **both files GREW**: the six extractions
> (Batches 129–133 + 143/144, ~600 LOC moved out) were outpaced by new
> feature work landing in-place. Verified with `wc -l` at HEAD.

- `WebGPUContext.ts`: 4354 (post-Batch-127) → **5178 lines** at HEAD — *grew* despite extracting the WebGL stub, device-invalidation bus, resource-cache registry, feature-flag plumbing, enum wrappers, and frame statistics.
- `WebGPUSceneRenderer.ts`: 3626 → **4016 lines** at HEAD — *grew* despite extracting the pick pass plus 10 other `WebGPUSceneRenderer*.ts` slice files and `WebGPUPostProcessPipeline.ts`.

Both files are still well above the 1000-line threshold called out in
`CLAUDE.md`, and the gap to that goal moved **further away**, not closer —
feature growth is outrunning decomposition. The mechanical, low-risk
candidates enumerated below are now all DONE; the genuinely-unfinished
residual is the SceneRenderer core (still 4016 LOC even after 10 slice
files plus `WebGPUPostProcessPipeline.ts` were peeled off), which needs a
different strategy than the "extract a self-contained helper" pattern that
closed candidates #1–#6.

## Already extracted

All six WebGPUContext helper modules below now exist on disk (verified at
HEAD). LOC is the *current* size of the extracted file, not the original
moved-line count.

| Module | Batch | LOC | Pattern |
|---|---|---|---|
| `WebGPUContextLimitsInit.ts` | 127 | 104 | Pure function. Takes a `GPUDevice`, writes the global `ContextLimits`. Idempotent so device-loss recovery can re-invoke. |
| `WebGPUContextWebGLStubInit.ts` | 129 | 353 | The ~230-line WebGL-stub state literal (candidate #1) plus the now-removed `webglToWebGPU*` enum wrappers (candidate #5) — the stub points straight at the module-level functions in `WebGLStateConverters.ts`. |
| `WebGPUDeviceInvalidationBus.ts` | 130 | 87 | Subscriber registry (`onDeviceInvalidated` / `_fireDeviceInvalidated`) — candidate #2. Context owns one instance and delegates. |
| `WebGPUResourceCacheRegistry.ts` | 131 | 100 | Owns the cleanable-cache list; `_clearAllCaches()` (candidate #3) walks it in registration order, then fires the invalidation bus. |
| `WebGPUFeatureFlags.ts` | 132 | 142 | `_buildFeatureList` / `_updateFeatureFlags` / `hasFeature` plumbing (candidate #4). Context constructs one and `hasFeature` delegates. |
| `WebGPUFrameStatistics.ts` | 143/144 | 83 | `getStatistics` / `resetStatistics` / `recordDrawCall` + the draw/triangle/frame counters (candidate #6). |
| `WebGPUContextCanvasConfig.ts` | 593 | 243 | HDR canvas-output cluster (Q35 slice / C4-WEBGPUCONTEXT-DECOMP): `buildCanvasConfig` / `applyCanvasConfig` / `reconfigureCanvas` / `setHDRCanvasOutput` / `setHDRFallbackListener` / `clearAllHDRFallbackListeners`. Host-interface pattern; the Context methods became one-line delegators (orphaned `_buildCanvasConfig` removed). Net −102 LOC on `WebGPUContext.ts` (5534 → 5432). Behavior-preserving: A/B build confirmed identical GPU-validation behavior; off-gate SDR path byte-identical (HDR is opt-in, `_hdrCanvasOutput` defaults false). Acceptance: `Tools/visual-regression/probe-hdr-canvas-output-decomp.mjs`. |
| `WebGPUContextCullerPool.ts` | Q35 remainder | 452 | GPU frustum-culler pool cluster: `getGpuCuller` / `getGpuCullerForOpaqueFrustum` / `getGpuCullerForCascade` / `getGpuCullerTranslucent` / `reapIdleAuxCullers` / `reapAllAuxCullers`, plus the `GPUCullerInstance` type and the `MAX_AUX_CULLER_INDEX` / `IDLE_DECAY_FRAMES` constants. Host-interface (`CullerPoolHost`) free-function pattern; the Context getters/methods became one-line delegators, and 14 culler fields (`_gpuCuller*`, `_gpuCullerBy*`, `_gpuCullingHint`, `_internalFrameId`) flipped to public-underscore. Net −274 LOC on `WebGPUContext.ts` (5432 → 5158). Behavior-preserving: variant smoke test all-3 PASS + `probe-culler-pool-decomp.mjs` (every extracted entry point + `'never'`-hint refusal, zero throws/errors, globe renders). Off-gate: culling is `'auto'`-gated + high-density-only, extraction is pure code-move → default path byte-identical. Acceptance: `Tools/visual-regression/probe-culler-pool-decomp.mjs`. |

## High-value candidates in `WebGPUContext.ts` — ALL DONE

> **All six candidates below shipped (Batches 129–132 + 143/144).** They
> are preserved here as the rationale-of-record for the shipped
> extractions; line-number citations are pre-extraction and are no longer
> live anchors. See the "Already extracted" table for the resulting files.

Listed roughly in order of cleanliness × impact (highest first).

### 1. `_initializeWebGLStub()` — DONE (Batch 129 → `WebGPUContextWebGLStubInit.ts`)

*Original: ~230 LOC, lines 1817-2044.*


A 230-line method that's ~95% a state-proxy literal handed to
`createWebGLCompatibilityStub(state)`. Already uses an explicit
`WebGLStubState` interface as its API surface, so the proxy can move to
its own file with **no signature change**.

**Blocker (small):** the proxy reads/writes about 30 `private` fields
on the context (`_activeTextureUnit`, `_textureBindings`, `_blendEnabled`,
etc.). Either (a) change those to `public _xxx` to match the existing
"public-underscore for cross-module access" convention used elsewhere
in the file (`public _device`, `public _frameCount`, `public _canvas`),
or (b) keep a thin `_buildWebGLStubState()` method on the Context that
returns the literal and put the call to `createWebGLCompatibilityStub`
in the new file.

**Recommendation:** option (a) for consistency. The fields are already
read/written from across the renderer module via the stub itself.

### 2. Device-invalidation subscriber registry — DONE (Batch 130 → `WebGPUDeviceInvalidationBus.ts`)

*Original: ~35 LOC, lines 4362-4393.*

`_deviceInvalidatedListeners: Set<() => void>`, `onDeviceInvalidated`,
`_fireDeviceInvalidated`. Pure subscriber pattern with no Context-specific
state. Trivial to extract as a `WebGPUDeviceInvalidationBus.ts` helper:

```ts
export class DeviceInvalidationBus {
  private listeners = new Set<() => void>();
  subscribe(cb: () => void): () => void { ... }
  fire(contextIdForLogs?: string): void { ... }
}
```

Context owns one instance, delegates `onDeviceInvalidated` and
`_fireDeviceInvalidated`. Net Context savings: ~30 LOC.

### 3. `_clearAllCaches()` — DONE (Batch 131 → `WebGPUResourceCacheRegistry.ts`)

*Original: ~40 LOC, lines 4321-4360.*

Self-contained: walks the various caches and pools on the context,
clears them, then fires the invalidation bus. The "what to clear" list
is the only piece tightly coupled to Context private state.

**Approach:** introduce a `WebGPUResourceCacheRegistry.ts` that owns the
list of cleanable caches (samplerCache, bindGroupLayoutCache,
bindGroupCache, bufferPool, uniformBufferPool, depthTexture handles,
viewportQuad refs, shader/pipeline/compute caches, effects placeholder
cache). Context registers its caches with the registry; clearAll fires
the registry. Less mechanical than #1 / #2 but pays off when more
caches arrive.

### 4. WebGPU feature flag plumbing — DONE (Batch 132 → `WebGPUFeatureFlags.ts`)

*Original: ~80 LOC.*

`_buildFeatureList()` (line 1661) + `_updateFeatureFlags()` (line 1683)
+ `hasFeature()` (line 1745) + the `_enabledFeatures: Set<string>`
field. All they touch is the `GPUAdapter` and a private Set. Move to
`WebGPUFeatureFlags.ts` exposing:

```ts
export class WebGPUFeatureFlags {
  constructor(adapter: GPUAdapter, requested: GPUFeatureName[]);
  enabled: ReadonlySet<string>;
  has(featureName: string): boolean;
  toRequiredFeatures(): GPUFeatureName[];
}
```

Context constructs one in `_initialize` and exposes `hasFeature` as a
delegator.

### 5. WebGL→WebGPU enum conversions — DONE (Batch 129, removed with the stub)

*Original: ~18 LOC, lines 3249-3261.* As predicted below, moving the
stub-state builder out (#1) let these wrappers disappear entirely — the
stub now binds the module-level `WebGLStateConverters.ts` functions
directly.

Three thin wrappers (`_webglToWebGPUBlendFactor`, `_webglToWebGPUBlendOp`,
`_webglToWebGPUCompareFunction`) that already delegate to module-level
functions. The methods exist only to satisfy the `WebGLStubState`
function shape. If we move the stub-state builder out (#1), these can
disappear too — just bind the module-level functions directly into the
state proxy.

### 6. Statistics block — DONE (Batches 143/144 → `WebGPUFrameStatistics.ts`)

*Original: ~30 LOC, lines 4219-4258.*

`getStatistics`, `resetStatistics`, `recordDrawCall`, plus the
`_drawCallCount` / `_triangleCount` / `_frameCount` fields. Trivial
candidate for a `WebGPUFrameStatistics.ts` helper class.

## High-value candidates in `WebGPUSceneRenderer.ts`

Lower priority than Context decomposition because the SceneRenderer is
younger code with cleaner internal sections, but several blocks meet
the 1000-line threshold themselves. **Two of the three original candidates
have shipped**; ten `WebGPUSceneRenderer*.ts` slice files now exist
(`3DTilePasses`, `EnsureResources`, `EnvironmentalEffects`, `FrameReset`,
`FrustumLoop`, `GlobePass`, `PassRedirect`, `PickPass`, `PostFrustumChain`,
`TranslucentPass`) plus `WebGPUPostProcessPipeline.ts` — yet the core is
**still 4016 LOC**. The pass family is the genuinely-unfinished residual.

- **Pass orchestration — PARTIALLY DONE / RESIDUAL.** Globe, translucent,
  3D-tile, post-frustum, and pass-redirect slices have moved to their own
  `WebGPUSceneRenderer*.ts` files, but the core `_executeXxxPass`
  orchestration (model, primitive, classification, edges) still lives in
  the 4016-LOC core. This is where the remaining decomposition work is —
  and it resists the clean "extract a self-contained helper" pattern that
  closed Context candidates #1–#6, because each pass reaches back into
  renderer state (encoder, frustum index, clear/load policy). **This is
  the genuinely-unfinished residual** and the reason the core grew rather
  than shrank.
- **Post-process plumbing — DONE.** Extracted to
  `WebGPUPostProcessPipeline.ts` (1477 LOC: pipeline lifecycle + scene
  framebuffer + canvas blit + HDR-toggle guard).
- **Pick path — DONE (Batch 133 → `WebGPUSceneRendererPickPass.ts`, 310 LOC).**
  Pick framebuffer, pick command issuance, and pick result decode are
  split out (companion helpers `WebGPUPickFramebuffer.ts` /
  `WebGPUPickCommandHelpers.ts`).

## Non-candidates (leave alone)

- Frame lifecycle (`beginFrame` / `endFrame` / `_beginDefaultRenderPass`
  / `endCurrentRenderPass` / `resumeDefaultRenderPass` / `_ensureDepthTexture`)
  — small, tightly-coupled to Context private state, no clear API
  boundary. Leave inline.
- The shadow-cast / TAA / CSM Slice integration code — already split
  across `WebGPUCascadedShadowMap`, `WebGPUTAA`, etc. The SceneRenderer
  just orchestrates calls to those.

## Strategy

Avoid mega-PRs. Each extraction should:

1. Move the code to a new file in `packages/engine/Source/Renderer/WebGPU/`.
2. Replace the original method body with a one-line delegation OR
   remove the wrapper if no callers exist.
3. Run `npx tsc --noEmit` + `npx gulp build` + the appropriate
   `Tools/visual-regression/` smoke test before committing.
4. Be one batch unto itself so any regression bisects cleanly.
