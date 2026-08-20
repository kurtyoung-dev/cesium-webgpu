# DEV notes — scene architecture

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

Scope: the C16-11 shard (in progress). This slice covers only
`packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts`;
later slices extend this file rather than duplicating it.

No comment in this slice required a new archive entry. The extraction note was
pure batch history, which the format excludes. The scene-view and staged MSAA
history is already recorded in [DEFERRED_WORK.md](DEFERRED_WORK.md), the TAA
activation history in [DEV_NOTES_postprocess.md](DEV_NOTES_postprocess.md), and
the deterministic-prewarm history in
[QUEUE_2026-07-16_CAMPAIGN10.md](QUEUE_2026-07-16_CAMPAIGN10.md) and
[WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md).
