# Plan — `executeCommands` decomposition

**Status:** Plan only — work spans Batches 138-141.
**Predecessors:** Batches 127-137 of the audit-recommended Context +
SceneRenderer decomposition.

## The target

`WebGPUSceneRenderer.executeCommands` is the central frame-dispatch
spine: 689 lines (1033-1722 post-Batch-137), 35 unique `this.*`
references, dispatches into every pass-execution method on the
SceneRenderer.

A single-shot extraction would either:

- Promote ~25 private fields/methods to `public _xxx` (huge API
  surface inflation), or
- Build a 30+ member host interface (still ugly, harder to evolve).

The sane path is **slice-by-slice extraction at natural seams** so
each batch has manageable coupling and the smoke tests can bisect
any regression cleanly.

## The four slices (in extraction order)

### Batch 138 — Slice A: Render-pass redirect (lines 1141-1238)

~98 LOC. Rebuilds the active render pass from the canvas swap chain
to the scene framebuffer when `usePostProcess && _sceneFramebuffer
?.colorTarget` is satisfied. Includes the pragma-stripped diag log
that fires on the first redirect.

**Dependencies:**

- `_sceneFramebuffer` (read, currently private)
- `_width`, `_height` (read, already public after Batch 137)
- `_renderPassRedirectLogged` (read+write, debug-only field)
- `context.endCurrentRenderPass`, `context.log`,
  `context._currentCommandEncoder`, `context._currentRenderPassEncoder`
  (already public on Context)

**Approach:** extract as a free function `setupSceneFramebufferRenderPass(host, config)`.
Host interface exposes the 4 fields above. Debug field stays on the
SceneRenderer with the existing pragma block.

**Risk:** medium — render-pass setup is load-bearing for every
non-pick frame. Smoke tests catch any breakage immediately because
the canvas blit depends on this redirect.

**Estimated LOC reduction:** −90 from SceneRenderer.

### Batch 139 — Slice B: Per-frame state reset (lines 1240-1268)

~28 LOC. Resets six per-frame fields/state slots between frames so
stale data from the previous frame doesn't leak.

**Dependencies:**

- `_capturedFrustumRanges` (write, currently private — needs to flip)
- `_invertClassStencilReady` (write, already public)
- `_edgeTexturesPopulated` (write, already public)
- `_translucentTileClassification?.prepareForFrame()` (read, currently
  private — could flip OR pass as host method)
- `context._globeDepthView`, `context._packedTranslucentDepthView`
  (already public)

**Approach:** extract as `resetPerFrameState(host)`. Smallest of the
slices — could be combined with Batch 138 if the diff stays clean.

**Risk:** low. Pure state-reset with no pass dispatch.

**Estimated LOC reduction:** −25 from SceneRenderer.

### Batch 140 — Slice C: Per-frustum dispatch loop (lines 1284-1644)

**~360 LOC.** The biggest, riskiest slice. Walks frustums far-to-near
and dispatches every per-frustum pass: ENVIRONMENT, GLOBE, globe-
depth copy, TERRAIN_CLASSIFICATION, CESIUM_3D_TILE chain, VOXELS,
OPAQUE, GAUSSIAN_SPLATS (with OIT-deferral logic), refraction
capture, TRANSLUCENT, translucent-tile depth pack, pick-depth copy.

**Dependencies (15 fields + 8 method calls on `this`):**

- Fields read: `_oit`, `_globeDepth`, `_sceneFramebuffer`,
  `_translucentTileClassification`
- Fields written: `_currentFrustumIndex`, `_capturedFrustumRanges`,
  `_deferredOITSplats`
- Methods: `_clearDepthStencil`, `_executePassCommands`,
  `_executeGlobePass`, `_execute3DTilePasses`, `_executeOpaquePass`,
  `_executeTranslucentPass`, `_renderDepthPlane`,
  `_captureRefractionScene`, `_resumeScenePass` (already public),
  `_updateFrustumUniforms` (already public)

**Approach:** extract as `executeFrustumLoop(host, config, opaqueFrustumNearOffset, initialHeight2D)`.
Host interface is the largest yet (~12 fields/methods). 6 currently-
private private SceneRenderer methods need to be flipped to `public _xxx`
to feed the host interface — same pattern as Batch 137.

**Risk:** high. This loop is the heart of the renderer. A subtle
mistake (e.g. losing a `context.endCurrentRenderPass` call between
the depth-update hook and resume) will visually break globe/tile
ordering.

**Pre-flight requirements:**

1. Re-read the entire body before extracting — no skipping.
2. Verify the slice boundaries don't break a logical pair (e.g. an
   `endCurrentRenderPass` whose matching resume is just below the
   slice boundary).
3. Run all three smoke tests + a manual visual inspection of the b3dm
   render before committing.

**Estimated LOC reduction:** −350 from SceneRenderer.

### Batch 141 — Slice D: Post-frustum chain (lines 1646-1706)

~60 LOC. Tail of the frame: overlay pass, depth plane, env effects,
invert classification composite, velocity pass, post-processing,
frame teardown.

**Dependencies:**

- Methods: `_executeOverlayPass`, `_renderDepthPlane`,
  `_executeEnvironmentalEffects`, `_runInvertClassificationComposite`,
  `_runVelocityPass`, `_runPostProcessing` (most still private)
- Fields read: `_postProcess`, `_ppDebugLogged` (debug)
- Fields written: `context._sceneHasTransmission` (already public)

**Approach:** extract as `executePostFrustumChain(host, config, perfManager)`.

**Risk:** low-medium. These are all already-extracted-or-near-extracted
sub-systems; the chain is mostly delegations.

**Estimated LOC reduction:** −55 from SceneRenderer.

## Cumulative impact

| Batch | LOC out of SceneRenderer |
|---|---|
| 138 (Slice A) | ~90 |
| 139 (Slice B) | ~25 |
| 140 (Slice C) | ~350 |
| 141 (Slice D) | ~55 |
| **Total** | **~520 LOC** |

After all four slices, `executeCommands` collapses to a thin
orchestrator (~30 lines): pick-pass branch, early returns, calls to
the four extracted helpers.

WebGPUSceneRenderer.ts should drop from current 2878 → roughly **2350
LOC** post-Batch-141.

## Cross-cutting changes (across the four batches)

- **Field promotions** (private → public underscore):
  - `_sceneFramebuffer`, `_globeDepth`, `_postProcess`, `_depthPlane`,
    `_translucentTileClassification`, `_capturedFrustumRanges`,
    `_currentFrustumIndex`. (Done across batches as each slice needs
    them.)
- **Method promotions** (private → public underscore):
  - `_ensureResources`, `_clearDepthStencil`, `_executePassCommands`,
    `_executeGlobePass`, `_execute3DTilePasses`, `_executeOpaquePass`,
    `_executeTranslucentPass`, `_executeOverlayPass`,
    `_executeEnvironmentalEffects`, `_executePickPass`,
    `_renderDepthPlane`, `_captureRefractionScene`, `_runVelocityPass`,
    `_runPostProcessing`, `_runInvertClassificationComposite`. (Done
    across batches.)
- **Debug log flags** stay on the SceneRenderer behind the existing
  pragma block; the extracted modules either inherit them via host or
  the diag stays inline at the call site (cleaner).

## Verification gate (every batch)

Same pattern as Batches 127-137:

```bash
npx tsc --noEmit                                           # ~30s
npx gulp build                                             # ~50s
node Tools/visual-regression/verify-glb-side-by-side.mjs   # ~60s
node Tools/visual-regression/verify-b3dm-render.mjs        # ~120s
node Tools/visual-regression/verify-model-feature-pick.mjs # ~120s
```

Pass criteria identical to all prior batches:
- glb side-by-side: airplane silhouette ≥ 5000 px at (149,149,149)
- b3dm: tilesFeaturesLoaded=10, modelReady=true, primCacheKeyCount=1
- C-R9 pick: featurePickIdCount=30, featurePickTexExists=true,
  featurePickFeaturesLength=30

## Out of scope for the four slices

- Touching `_executeOpaquePass`, `_executePassCommands`,
  `_executeOverlayPass` — they're orchestration sub-methods that
  could be extracted in their own batches but aren't part of the
  executeCommands decomposition per se.
- Decomposing `_ensureResources` (~268 LOC) — it allocates
  framebuffers, depth/stencil, MSAA, edge FBO, post-process intermediates.
  Separate, also-high-risk batch.
- Refactoring the host-interface pattern itself (e.g. moving to a
  base class with all SceneRenderer-side methods overridable). Today
  each extraction defines a narrow ad-hoc host interface; that's
  intentional and works.

## Branch & commits

- `main`, one commit per slice.
- Push after each verification passes.
- If any slice fails verification, revert that slice only — earlier
  slices are independent.
