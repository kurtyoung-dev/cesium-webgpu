# WebGPUContext / WebGPUSceneRenderer Decomposition Plan

**Created:** 2026-04-30 (Batch 127)
**Origin:** 2026-04-30 audit (`migration_doc/audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md`)

## Status

- `WebGPUContext.ts`: 4427 → 4354 lines after Batch 127 (extracted `_initializeContextLimits`).
- `WebGPUSceneRenderer.ts`: 3626 lines, untouched.

Both files are still well above the 1000-line threshold called out in
`CLAUDE.md`. Decomposition is multi-session work; this document tracks
remaining candidates so future passes pick up where Batch 127 left off.

## Already extracted

| Module | LOC moved | Pattern |
|---|---|---|
| `WebGPUContextLimitsInit.ts` | 47 | Pure function. Takes a `GPUDevice`, writes the global `ContextLimits`. Idempotent so device-loss recovery can re-invoke. |

## High-value candidates in `WebGPUContext.ts`

Listed roughly in order of cleanliness × impact (highest first).

### 1. `_initializeWebGLStub()` (~230 LOC, lines 1817-2044)

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

### 2. Device-invalidation subscriber registry (~35 LOC, lines 4362-4393)

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

### 3. `_clearAllCaches()` (~40 LOC, lines 4321-4360)

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

### 4. WebGPU feature flag plumbing (~80 LOC)

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

### 5. WebGL→WebGPU enum conversions (~18 LOC, lines 3249-3261)

Three thin wrappers (`_webglToWebGPUBlendFactor`, `_webglToWebGPUBlendOp`,
`_webglToWebGPUCompareFunction`) that already delegate to module-level
functions. The methods exist only to satisfy the `WebGLStubState`
function shape. If we move the stub-state builder out (#1), these can
disappear too — just bind the module-level functions directly into the
state proxy.

### 6. Statistics block (~30 LOC, lines 4219-4258)

`getStatistics`, `resetStatistics`, `recordDrawCall`, plus the
`_drawCallCount` / `_triangleCount` / `_frameCount` fields. Trivial
candidate for a `WebGPUFrameStatistics.ts` helper class.

## High-value candidates in `WebGPUSceneRenderer.ts`

Lower priority than Context decomposition because the SceneRenderer is
younger code with cleaner internal sections, but several blocks meet
the 1000-line threshold themselves:

- **Pass orchestration** — the `_executeXxxPass` family (globe, model,
  primitive, classification, edges, transparency). Each could move to
  its own pass-specific file with a stable interface back to the
  renderer (encoder, frustum index, clear/load policy).
- **Post-process plumbing** — the SceneRenderer holds the post-process
  pipeline lifecycle + scene framebuffer + canvas blit + HDR-toggle
  guard. Extract to `WebGPUSceneRendererPostProcess.ts`.
- **Pick path** — pick framebuffer, pick command issuance, pick result
  decode. Self-contained block roughly 400 LOC.

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
