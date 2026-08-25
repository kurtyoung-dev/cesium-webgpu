# DEV notes — scene architecture

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

Scope: the C16-11 shard (in progress). Each `##` section below records one slice
of the shard; later slices extend this file rather than duplicating it.

## `WebGPUSceneRendererEnsureResources.ts` — C16-11 slice

No comment in this slice required a new archive entry. The extraction note was
pure batch history, which the format excludes. The scene-view and staged MSAA
history is already recorded in [DEFERRED_WORK.md](DEFERRED_WORK.md), the TAA
activation history in [DEV_NOTES_postprocess.md](DEV_NOTES_postprocess.md), and
the deterministic-prewarm history in
[QUEUE_2026-07-16_CAMPAIGN10.md](QUEUE_2026-07-16_CAMPAIGN10.md) and
[WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md).

## `FrameState.js`, `View.js`, `WebGPUDerivedCommand.ts`, `WebGPULogDepth.ts` — C16-11 slice

No comment in this slice required a new archive entry. The actionable celestial
measurements and the shadow-caster, environment-frustum, G-buffer,
derived-variant, and log-depth constraints remain beside the code.

For `packages/engine/Source/Scene/FrameState.js`, the star-map availability and
ownership contract already lives in `Scene/StarCubeMapResource.js`, while the
unresolved star input and G-buffer allocation disposition are recorded in
[DEFERRED_WORK.md](DEFERRED_WORK.md). The G-buffer architecture and rollout
history also remain in
[PHASE_8_SHADER_STRATEGY.md](PHASE_8_SHADER_STRATEGY.md) and
[WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md).

For `packages/engine/Source/Scene/View.js`, the enduring shadow-caster and
environment-only-frustum traps remain inline; their rollout history is already
recorded in
[QUEUE_2026-07-16_CAMPAIGN10.md](QUEUE_2026-07-16_CAMPAIGN10.md) and
[QUEUE_2026-07-19_CAMPAIGN12.md](QUEUE_2026-07-19_CAMPAIGN12.md).

For
`packages/engine/Source/Renderer/WebGPU/WebGPUDerivedCommand.ts`, the rollout
and remaining variant adoption are recorded in
[DEFERRED_WORK.md](DEFERRED_WORK.md), while current cache identity lives in
`WebGPURenderPipelineCache.ts`. For
`packages/engine/Source/Renderer/WebGPU/WebGPULogDepth.ts`, the conversion and
diagnostic history is already present in the owning campaign queues,
[DEFERRED_WORK.md](DEFERRED_WORK.md), and
[WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md). Stale state claims were
corrected in place rather than archived as guidance.

## `Scene.js` — C16-11 slice

Scope: this slice covers only `packages/engine/Source/Scene/Scene.js`.

One comment in this slice required an archive entry. Local constraints and
ordering requirements remain beside the code in present-tense form; pure batch
annotations are excluded by the format. Feature-state history is already
recorded in [DEFERRED_WORK.md](DEFERRED_WORK.md) and the owning Campaign 7, 8,
9, 10, 11, and 12 queue rows under `migration_doc/`, so it is not duplicated
here.

### `packages/engine/Source/Scene/Scene.js` — `Scene#gpuCullingHint`

_Moved 2026-08-24._

> Batch 215 — opt-in hint that this scene will reach the
> high-density command count where the WebGPU GPU-side culling /
> occlusion / sort-key dispatchers (Batches 209-211) activate.
>
> `'always'` triggers eager warm-up of the three compute pipelines
> + buffer pre-allocation at the next frame, amortizing the
> 5-50 ms pipeline-compile cost into a load frame instead of the
> first frame where the activation threshold crosses (which would
> otherwise produce a visible hitch).
>
> `'auto'` keeps the lazy-init path — first activation
> crossing pays the compile cost, subsequent crossings are warm.
>
> `'never'` (Batch 225 wire-in) — fully disables the GPU
> dispatchers. The opaque + translucent gates short-circuit
> to false (`WebGPUSceneRenderer` already reads the scene
> hint), AND the context's lazy-getter chain refuses to
> allocate new auxiliary culler instances. Existing auxiliary
> instances are reaped by the context when the policy changes.
>
> No-op on WebGL.
>
> @type {'auto' | 'always' | 'never'}
> @default 'never'
> @experimental This feature is experimental and may change or be removed without Cesium's standard deprecation policy.

Kept because the 5-50 ms pipeline-compilation range is not recorded in the
current ledger or campaign queues. The rewritten JSDoc states only the current
policy contract; this preserves the historical measurement for future warm-up
tradeoff analysis.
