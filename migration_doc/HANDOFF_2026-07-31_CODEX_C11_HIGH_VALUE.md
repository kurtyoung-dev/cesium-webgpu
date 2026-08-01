# Campaign 11 high-value work — Codex stopping-point handoff

> **SUPERSEDED REPOSITORY-STATE SNAPSHOT (2026-08-01).** Preserve this document
> as the Batch-771 stopping-point record, but do not read its repository-state
> paragraph as current. The working tree it describes **landed as Batches
> 772-781** (`origin/main` = `3900608bb9`) after orchestrator review, with eight
> confirmed defects fixed pre-landing (see `LOCAL_CHANGE_AUDIT_2026-07-31.md`
> §11 and the `C11-REVIEW-2026-08-01` entry in `WEBGPU_DEBUGGING_LOG.md`).
> Wherever this document says “implemented, not landed,” read “landed; still not
> complete” — every exit gate, browser gate, and PARTIAL status below stands
> exactly as written. In the restart order at the end, **item 1 (combined build
> and focused runtime/spec probes) was executed at landing**; items 2-7 remain
> valid campaign work. Use the live campaign queues and current `git status` as
> execution authority.

**Date:** 2026-07-31  
**Repository state (as written; see the banner above):** large pre-existing dirty
working tree; no files were staged,
committed, pushed, reset, cleaned, or stashed during this pass. In this document,
“implemented” means present in the local working tree, not landed in Git history.

## Executive state

This pass produced useful, feature-preserving slices for every requested area,
but only `C11-208` has reached its requested architectural exit gate. The other
IDs remain partial. Do not convert their queue rows to COMPLETE merely because a
focused slice is implemented.

The most important new review conclusion is that the current `C11-202`
backend-neutral path removes final WebGL `ShaderProgram` / `VertexArray` /
`DrawCommand` realization for WebGPU, but it does **not** yet remove the full
legacy frontend tax. Shared model pipeline stages can still allocate WebGL pick
IDs, instanced-pick buffers, and edge-visibility GPU resources before native
WebGPU realization. The correct next architecture is a capability-split shared
frontend, not removal of those features.

## Implemented working-tree slices

### `C11-205` — request/readiness evidence (**PARTIAL**)

- The representative workload has stable path-based tile identities and records
  issue/cancel/settle/reissue events, ready/selected sets, content states, and
  available Resource Timing byte evidence.
- Replay diagnostics are deliberately untimed and non-certifying.
- This does **not** close the resident-comparability gate: ordinary timing
  fingerprints do not yet include ready-tile identities, event chronology is not
  consumed by the comparator, request serials are not stable across renderer
  legs, model readiness transitions are absent, multiple-content requests are
  not covered, and truncated event streams can still appear valid.
- The production “versioned model state packet” remains open; broad tileset
  properties are still applied to tile models each update.

Smallest safe next slice: add ready-tile count plus dual stable identity hashes
to the ordinary post-measurement fingerprint, and reject resident comparisons
when ready sets, counts, unidentified IDs, or statistics disagree. This is
tooling-only and does not alter traversal or request policy.

### `C11-193` — environment refresh architecture (**PARTIAL**)

- Dynamic-environment refresh now records its six faces and IBL work into one
  shared refresh encoder/submission rather than paying per-face submission.
- Its refresh parameters use one aligned packed arena/upload rather than
  per-face temporary arrays and writes.
- A context-owned, frame-stamped, observe-only environment-demand registry is
  implemented at this stopping boundary. It remains telemetry-only:
  `UNKNOWN` executes exactly as before and no existing refresh is skipped.
- Still open: context-owned bounded job draining, persistent target pooling,
  selected-consumer scheduling authority, and measured queue/submission credit.

### `C11-194` — shared immutable model resources (**PARTIAL**)

- Exact-device pooled camera/instance/material layouts, fallback/default
  resources, and exact-effects-layout pipeline layouts are shared across model
  caches with lease-based teardown.
- Material/pipeline keys were reviewed; no mutable-default alias or missing
  supported sampler axis was found.
- Still open: model caches need exact device/resource-generation ownership and
  deterministic recovery teardown. The current recovery walk can miss
  `Model3DTileContent._model`, and clearing `_webgpuCache` without the renderer
  disposer can leak shared-pool leases.

### `C11-195` — RTE and dynamic camera/light data (**PARTIAL**)

- Environment-capture camera/light blocks use aligned arena slices; per-face
  camera-relative point/spot lighting stays in a coherent world/RTE frame.
- Unchanged-write suppression is present on relevant packed data paths.
- Main-view camera data still uses root/per-node direct queue writes. The
  864-byte light block is still packed/compared/uploaded per primitive even
  though it is model/view-wide; moving cameras keep punctual-light RTE data
  genuinely dynamic.
- Recommended next implementation order: camera group 0 dynamic-offset arena
  first, including command clone/capture/2D-IDL/device-recovery tests; then one
  light slice per model/view shared by all primitives.

### `C11-208` — reduced globe-effects layout (**IMPLEMENTED / VERIFIED**)

- Low-limit adapters use a globe-specific reduced effects layout and four
  imagery slots, with multipass overflow preserving additional imagery layers.
- Forced `maxSampledTexturesPerShaderStage = 16` evidence passed with one and
  five imagery layers and zero WebGPU validation errors.
- No globe effect was removed.

### `C11-76` / `C11-60` — submissions and post-process churn (**PARTIAL**)

- Secondary/split viewport execution now establishes an explicit WebGPU
  submission boundary, drains callbacks safely, and avoids duplicate simulation
  intent while keeping 2D/IDL viewport resource lifetimes safe.
- The environmental compositor owns a stable snapshot/ping chain for clouds,
  NPR, contact shadows, SSR, weather, and fog, avoiding sample/render aliasing.
- NPR/contact-shadow/SSR source bind groups use bounded exact-identity caches.
- The current stopping slice adds two-parity fog composite caching and bounded
  cloud main/upscale caching, including lifecycle clearing and GPU-free contract
  tests.
- Still open: audit remaining hot-path private submits (especially compute
  instances, flow fields, point-cloud LOD, ocean/weather/entity clusters and
  fallback-only branches), cloud-shadow/cascade bind-group churn, user/library
  post-process uploads, and once-per-logical-frame 2D simulation ownership.

### `C11-202` — backend-neutral model descriptors (**PARTIAL**)

- WebGPU builds renderer-neutral primitive descriptors instead of final legacy
  shader programs, vertex arrays, base draw commands, and derived command graphs;
  WebGL retains its complete legacy realization.
- Native pipeline preparation now keeps a visible standalone model from
  publishing `Model.ready` before its async color pipeline has resolved. The
  default-delay 2D/IDL probe passed with native commands/descriptors and zero
  legacy WebGPU commands.
- The native feature-renderer owner is attached at the preparation boundary, so
  destroying a model while compilation is pending can invoke native teardown.
- Pipeline-only warmup no longer initializes model/node TAA history or realizes
  dynamic skinning, instancing, or IDL camera resources before the first real
  draw.
- Known blockers: tile-owned/off-frustum/hidden readiness still needs a separate
  CPU-ready versus backend-renderable/fallback contract; device-generation
  invalidation is incomplete; and shared legacy pipeline stages still create
  WebGL-specific pick/edge resources. Do not solve the latter by deleting pick,
  edges, metadata, style, clipping, classification, silhouette, custom shaders,
  or shadows.

## Validation already obtained

- Full repository build passed before the final stopping-boundary edits.
- Engine TypeScript and `git diff --check` passed before those final edits.
- `probe-model-scene2d-idl.mjs`: PASS at default timing; WebGPU native
  descriptors/commands present, legacy WebGPU commands zero, WebGL legacy path
  retained.
- `probe-model-scene2d-stage-guard.mjs`: PASS for WebGPU/WebGL 2D and WebGPU 3D.
- Model shadow/command graph functional cells and articulated RTE passed; the
  process remained non-green only because blocked external imagery generated
  `ERR_NETWORK_ACCESS_DENIED`.
- `probe-globe-default-limits.mjs`: PASS at the forced 16-texture adapter limit.
- Dynamic-environment recovery Node tests: 7/7 PASS.
- Focused Karma was **not** executed: EdgeHeadlessCI failed to capture the
  browser and ran 0/0 tests. This is an infrastructure failure, not a green gate.

After the last C11-60/C11-193 and C11-202 lifecycle/TAA edits, focused Prettier,
engine TypeScript, JavaScript syntax checks, and `git diff --check` are green.
They came after the last full repository build and browser probes, so the next
session must still run the combined build and focused runtime/spec probes before
claiming the combined tree verified.

## Recommended restart order

1. Run the combined repository build and focused runtime/spec probes; do not
   reconcile docs by discarding other dirty-tree work. **DONE at landing
   (2026-08-01, Batches 772-781): `npx tsc --noEmit` clean, `npx gulp build`
   green, Node contracts 195/195 at `3900608bb9`. Focused Edge/Karma still did
   not execute, so the browser-owned gates remain open.**
2. Promote ready-tile identity into the ordinary `C11-205` resident fingerprint
   so invalid renderer pairs cannot produce causal performance claims.
3. Add exact device/resource-generation ownership and disposer-driven recovery
   for all model caches, including tile-content models.
4. Add destroy-while-pipeline-pending and first-demand fallback/readiness tests
   for `C11-202`, then split WebGL-only pick/edge realization from the shared
   model frontend.
5. Implement `C11-195` camera dynamic offsets, prove capture/2D/IDL/recovery,
   then implement one light slice per model/view.
6. Finish `C11-76` private-submit migration and the remaining `C11-60` churn
   audit without removing effects.
7. Rebuild the viewer bundle and run the canonical moving-camera altitude route
   (timing-clean first, instrumentation separately). Do not use idle soak FPS as
   certification evidence.
