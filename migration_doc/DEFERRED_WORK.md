# Deferred Work Inventory - CesiumJS WebGPU Migration

**Last Updated:** 2026-05-02 (AUDIT_2026_05_02.md cross-coupling sweep — 100+ findings across 5 clusters; this doc updated with stale-status corrections + new high-priority entries)

This is the canonical list of named C-R follow-ups deferred during the principal-engineer review remediation (Batches 1-64). Each entry has a stable identifier (`C-R<n>-<NAME>`) that survives renumbering when slots are filled. Grouped by parent C-R finding from `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`.

Each entry: **What** / **Why deferred** / **Prerequisites** / **Estimated effort** (1 session ~ 1-3 hours) / **Impact** / **Trace**.

This inventory is add-only; ship items mark `(SHIPPED in Batch N)` next to the heading rather than removing the row.

**Companion docs (cross-reference before scoping):**

- [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) — exhaustive catalog of existing/new/WIP/future features
- [AUDIT_2026_05_02.md](AUDIT_2026_05_02.md) — most recent cross-coupling audit; 110+ findings prioritized by severity (BREAKING / PARTIAL / LATENT / STALE STATUS)

---

## ADR-2026-04-28: Classification architecture — depth-sampling over stencil

**Decision:** Migrate `WebGPUGroundPrimitiveRenderer` from its current 2-pass stencil approach to WebGL's depth-texture sampling architecture. Pause the original C-R8 multi-frustum sweep (Sessions 2–4 of the stencil plan) until the depth-sampling architecture lands. After the migration, the multi-frustum work folds in for free as "swap the depth-source view per frustum" rather than "redirect a render pass into a scratch FBO and accumulate stencil bits."

**Why:**

- **Feature coverage.** Stencil approach can only classify against opaque surfaces that wrote depth. The depth-sampling approach can swap which depth source it reads from, unlocking translucent-on-translucent classification, PointCloud translucent classification (Batch 79 only fixed Models via selective depth-write), and `GroundPolylinePrimitive` (currently absent on WebGPU) on the same plumbing.
- **Architectural coherence with WebGL.** WebGL's classifier (`ShadowVolumeAppearanceFS.glsl`, `PolylineShadowVolumeFS.glsl`) samples `czm_globeDepthTexture`. Maintaining two architectures in parallel (stencil for WebGPU, depth-sample for WebGL) costs more long-term than one unified architecture.
- **Calendar.** Either path is ~5–6 sessions: finish stencil-based multi-frustum (Sessions 2–4) + later migrate, vs. migrate first + multi-frustum falls out for free. Same calendar, different end state.

**Trade-offs accepted:**

- Per-fragment cost goes up modestly (one depth-texture sample + reconstruction multiply) versus stencil's fixed-function early rejection. On desktop GPUs the delta benchmarks within ~2-3%; on mobile/integrated GPUs it can reach 5-15% in classification-heavy scenes. Acceptable for Cesium's typical workloads (terrain visualization, not mobile games).
- LOC churn: ~+800 LOC of WGSL classification shaders, ~-200 LOC of stencil pipeline plumbing. Net code growth, but a single conceptual surface.
- Sandcastle baseline regenerates after the cutover (visual regression suite is the safety net).

**Stays unchanged:**

- `depth24plus-stencil8` attachment format. The format's stencil bits are still used by `WebGPUInvertClassification` (separate concern, no migration plan today). Switching to `depth24plus` saves zero bytes per pixel on most drivers.
- Edge / shadow / OIT / picking pipelines — none of these use stencil today.
- The Batch 47 `WebGPUTranslucentTileClassification` scaffolding is the canonical example of the depth-pack approach in this codebase. The migration finally turns that scaffolding into the production classifier.

**Re-sequenced plan (replaces the earlier 6-session C-R8 sweep):**

1. **Migration Session 1** — WGSL port of `ShadowVolumeAppearanceVS/FS` + companion uniforms + first-cut single-pipeline `WebGPUGroundPrimitiveRenderer` swap that samples `globeDepthTexture` instead of doing the stencil 2-pass. Keep stencil pipelines compiled but unused as a one-batch fallback.
2. **Migration Session 2** — Runtime depth-source swap (globe-depth ↔ packed-translucent-depth). Wire the Batch 47 `_packedTranslucentDepthView` as the secondary source. Closes C-R8-CLASSIFICATION-DEPTH-SAMPLING and absorbs C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH.
3. **Migration Session 3** — Per-frustum FBO redirect now becomes "per-frustum depth-source bind group." Closes C-R8-TRANSLUCENT-MULTI-FRUSTUM. Composite + accumulation are no-ops (the depth-sample approach doesn't need them).
4. **Migration Session 4** — `WebGPUGroundPolylineRenderer` (port `PolylineShadowVolumeVS/FS` to WGSL). Reuses the Session 2 depth-source plumbing. Closes C-R8-GROUND-POLYLINE-NATIVE.
5. **Migration Session 5** — Delete unused stencil pipelines from `WebGPUGroundPrimitiveRenderer`. Drop the Batch 47 composite scaffolding (`composite()`, `_compositePipeline`, `COMPOSITE_WGSL`, `_runTranslucentTileClassificationComposite`) — the depth-sample architecture doesn't need it.

**Origin:** Audit + senior-dev review on 2026-04-28 after Batch 79 fixed the user-visible Model translucent-tile classification bug via selective depth-write. The audit revealed the stencil approach was a local minimum and the multi-frustum sweep would re-architect the wrong surface. See conversation transcript at `eb6dfaec-c294-4f46-966a-d8d9138c8bf0` for the full reasoning.

---

## C-R1 - command.renderState adoption tail

**Parent finding (PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30):** `RenderStateToPipelineVariant.ts` foundation + 7 consumer renderers landed in Batches 30/35-37/39. Four named gaps remain.

### C-R1-CLASSIFICATION

**What:** Classification primitives (ClassificationPrimitive, GroundPolylinePrimitive) need their multi-pass renderState (stencil-depth pass, color pass, pick pass) routed through pipeline variants. Each pass uses distinct stencil/colorMask/depthFunc so WebGPU has to materialize three pipelines and dispatch in order.

**Why deferred:** WebGPU classification dispatch is a single-pipeline path; splitting into the WebGL-style 3-pass walk requires per-pass pipeline variant work plus renderer-level ordering change. Touches `WebGPUGroundPrimitiveRenderer.js` plus a new `WebGPUClassificationPrimitiveRenderer` that doesn't exist yet.

**Prerequisites:** None - foundation in place since Batch 30. `selectCommandVariant` (Batch 29) is the dispatch hook.

**Estimated effort:** 1 dedicated session.

**Impact:** 3D Tiles classification on WebGPU may bleed through tile boundaries when the stencil-depth pass doesn't run. Single-pass mode currently approximates the visible surface only.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

### ~~C-R1-COLLECTIONS-PER-ENCODER~~ — RESOLVED (audit 2026-05-02)

**Audit finding (AUDIT_2026_05_02.md D.2):** All five collection renderers forward `renderState` onto their commands today: `WebGPUBillboardRenderer.js:884`, `WebGPULabelRenderer.js:724`, `WebGPUPointPrimitiveRenderer.js:852/991`, `WebGPUPolylineRenderer.js:1112/1273`, `WebGPUCloudRenderer.ts:596`. `WebGPUDrawCommand.execute()` at `WebGPUDrawCommand.ts:500-504` automatically calls `applyPerEncoderState(passEncoder, this.renderState)` when defined. Custom stencilRef / blendConstant / scissor flow correctly.

**Status:** No code change needed; entry preserved as a marker so future audits don't re-investigate.

### C-R1-GLOBE-RENDERSTATE

**What:** `WebGPUGlobeSurfaceRenderer.ts` builds pipeline variants from local hard-coded state instead of consuming upstream `command.renderState`. The provider sets per-tile depthMask / cullFace based on tile elevation/back-facing geometry; the WebGPU path overrides with a fixed front-face cull.

**Why deferred:** Globe surface renderer has its own custom pipeline-variant builder predating `RenderStateToPipelineVariant.ts`; routing the upstream renderState through requires reconciling two distinct variant key shapes.

**Prerequisites:** Bundles naturally with C-R7-RENDERER-MIGRATION (route GlobeSurface through central pipeline cache).

**Estimated effort:** 1-2 sessions.

**Impact:** Underground / inverted tiles may render with wrong cull mode at the rim of the globe (e.g., transitioning across a steep cliff). Minor artifacting.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

### ~~C-R1-PRIMITIVE-DERIVED~~ EFFECTIVELY RESOLVED (audit 2026-05-02)

**Audit finding:**

- The `pickCommand` paths (both shader-path and material-path) in `WebGPUPrimitiveCommands.js` already forward `appearance.renderState` — Batch 98 landed this. See `pickCommand` construction at `WebGPUPrimitiveCommands.js:1502-1535` (shader path) and `:2326-2354` (material path), both with `renderState: appearance?.renderState` and explanatory comments. So per-encoder dynamic state (stencilRef, scissor, viewport, blendConstant) flows through pick passes.
- `depthOnlyCommand` and `pickDepthCommand` are NOT emitted by the WebGPU primitive flow — and **have no consumer in the WebGPU dispatch path.** WebGPU primitives use a parallel-array shape (`colorCommands[]` + `pickCommands[]`) rather than the WebGL per-command derived-dictionary shape. The dispatcher in `WebGPUSceneRenderer.ts:188` checks `derivedCommands.depth.depthOnlyCommand` as a fallback, but no Pass dispatch in the WebGPU `executeFrustumLoop` invokes primitives in depth-only mode (shadow casting goes through `executeShadowMapCastCommands` + the dedicated CSM cast pass; globeDepth uses `executeUpdateDepth` which copies post-render). Adding `depthOnlyCommand` emission would be scaffolding without a consumer.

**Status:** Pick variant renderState forwarding is complete. Depth-only variant emission has no consumer to plumb to. Per the dead-code audit rule (CLAUDE.md), not adding scaffolding without a consumer.

**If/when needed:** A future depth-only primitive dispatch (e.g., a real early-z prepass landing for performance) would need both the consumer-side dispatcher hook AND the producer-side `depthOnlyCommand` emission. They should land together.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30; Batch 98 (pick variant renderState); audit 2026-05-02.

### C-R1-TILE-BATCH

**What:** `Cesium3DTileBatchTable.js` per-feature renderState (depthMask flip for `_depthOnlyCommand` derivation, custom color blend for translucent tiles) is not consumed by the WebGPU model command emission path.

**Why deferred:** Routing through the renderState pipe requires teaching `WebGPUModelRenderer.js` to inspect batch-table per-feature state, which has its own representation that's not yet typed.

**Prerequisites:** Pairs with C-R9-MODEL-FEATURE-PICK - both touch batch-table integration.

**Estimated effort:** 1-2 sessions.

**Impact:** Per-feature transparency in 3D Tiles renders without the alpha-driven depthMask flip on WebGPU; visible as z-fighting on overlapping translucent features.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

---

## C-R4 - glTF KHR extensions

### ~~C-R4-GLTF-KHR~~ MOSTLY RESOLVED 2026-04-30 (audit)

**Resolution:** Audit (2026-04-30, this session) found that **all seven**
listed KHR extensions are wired into `ModelPBRComplete.wgsl` and
`WebGPUModelRenderer.js` already, via Batches 102, 103, 105, and the
"Slice 2-7" series:

| Extension | Status | Shader markers | Notes |
| --- | --- | --- | --- |
| KHR_texture_transform | ✅ Full | `applyTextureTransform()` at lines 1271-1283; called from `baseColorUV`, `normalUV`, `metallicRoughnessUV`, `emissiveUV`, `occlusionUV` | Per-texture 3×3 matrix uploaded as 3 padded vec4 columns; `textureTransformFlags` bitmask gates the matrix multiply per slot. |
| KHR_materials_clearcoat | ✅ Full BRDF | "Slice 2" branch at line 1515 | Second GGX lobe with own normal/roughness textures + base-material attenuation by `(1 - F_clearcoat)`. |
| KHR_materials_specular | ✅ Full | "Slice 3" branch at line 1400 | F0 dielectric component recoloured by specular color factor + texture; metallic surfaces use baseColor for F0 per spec. |
| KHR_materials_anisotropy | ⚠️ Approximated | "Slice 4" branch at line 1482 | GGX D-term stretched along view-relative direction. Full per-tangent BRDF deferred (needs vertex-tangent attribute through FragmentInput; comment at line 1474 calls this out). |
| KHR_materials_iridescence | ⚠️ Approximated | "Slice 5" branch at line 1428 | Hue-shift approximation rather than true thin-film LUT-based interference. Full Khronos reference impl needs precomputed wavelength LUT. |
| KHR_materials_sheen | ✅ Full BRDF | "Slice 6" branch at line 1558 | Charlie distribution + Neubelt/Pettineo visibility approximation. |
| KHR_materials_volume | ✅ Full | "Slice 7" branch at line 1642 | Beer-Lambert attenuation on diffuse. Thickness texture sampled. |
| KHR_materials_transmission | ⚠️ Simplified | "Batch 105" branch at line 1606 | Samples a refraction texture but uses placeholder until the full opaque-only MRT is wired (Batch 107 added the capture pass; FS still reads at simple offset rather than thickness-driven path). |

**Remaining work** (now scoped much more narrowly than the original
multi-week estimate):

- **NEW-KHR-ANISO-TANGENT** — wire glTF tangent attribute through to FS
  for true per-tangent anisotropic GGX. Drops the "view-relative
  approximation" comment at line 1474.
- **NEW-KHR-IRIDESCENCE-LUT** — precomputed thin-film LUT + sample at
  NdotV for true wavelength-dependent Fresnel modulation. Drops the
  hue-shift approximation at line 1428.
- **NEW-KHR-TRANSMISSION-THICKNESS** — couple transmission's refracted
  UV offset to the volume thickness texture so glass-thickness varies
  correctly. Today the offset is a fixed 0.05 step (line 1626).

These are individual session-sized follow-ups, not the original
multi-week workstream. Filed below.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:101-102;
OVERSIGHT_AUDIT_2026_04_25.md s2; reconciled in Batch 128 (2026-04-30).

---

### NEW-GPU-CULLER-CONSUME-OR-DELETE — `gpuCullCommands` orphan dispatcher decision

**What:** `WebGPUSceneRenderer.gpuCullCommands()` (defined in
`WebGPUSceneRenderer.ts:2171`) is a working compute-shader frustum
culler with bounding-sphere SoA + 6-plane test, threshold-gated at
256 commands. The dispatcher (`WebGPUGPUCuller`) lazy-loads its WGSL
plus the compute pipeline on first `context.gpuCuller` access. It has
**zero callers**. The frustum loop in
`WebGPUSceneRendererFrustumLoop.ts` runs CPU-side culling via the
standard `BoundingSphere.intersect` inline, never delegating to GPU.

**Status (Batch 135):** Eager initialization trigger
(`void this.gpuCuller` in `WebGPUContext._warmUpPipelines`) removed
so the ~256KB SOA buffers don't allocate when nobody uses them. The
getter stays lazy; the dispatcher will instantiate on first call to
`gpuCullCommands()` from any future consumer.

**Why deferred:** Two valid paths:

(a) **Consume from `executeFrustumLoop`.** Wire
    `gpuCullCommands(commands, context, cullingVolume)` into the
    pre-pass-execution hook so commands are filtered before
    dispatch. Low-LOC integration but needs benchmark data: the
    256-command threshold was a guess; real workloads (Sandcastle
    mid-complexity scenes ~50-200 commands per frustum) probably
    don't exceed it, so the win is small / negative for most users.

(b) **Delete `gpuCullCommands` + `WebGPUGPUCuller`.** Remove the
    method, the file, the lazy getter, and the FrustumCull.wgsl
    compute. Saves the indirection and the cognitive load of
    "is this the producer or consumer?"

(c) **Hybrid: keep the dispatcher, expose a `scene.useGPUCommandCulling`
    opt-in.** Power users with very-high command counts (heavy 3D Tile
    workflows) can enable it, default is off. Requires (a) wiring
    plus a config knob.

Picking (a) without benchmarks is premature optimization; (b) is
honest and aligned with the current code paths; (c) is the most
flexible. Decision belongs in a render-perf review, not in an audit
remediation batch.

**Estimated effort:** 1 session for (a) or (c); 30 min for (b).

**Impact:** Closes C.2 from AUDIT_2026_05_02 (gpuCullCommands part).
Either deletes ~250 LOC or activates GPU-side culling for high-command
scenes.

**Trace:** AUDIT_2026_05_02.md C.2;
`WebGPUSceneRenderer.ts:2171` (orphan method);
`WebGPUContext.ts:923-937` (eager-init removed in Batch 135).

---

### NEW-HIZ-SORT-CONSUME-OR-DELETE — HiZ + GPUSortKeys orphan dispatchers

**What:** Two more dispatchers registered as feature renderers but
never invoked from a render path:

- `WebGPUHiZOcclusionDispatcher` — full hierarchical-Z occlusion
  query with depth-pyramid build + per-bounding-sphere readback.
- `WebGPUGPUSortKeysDispatcher` — radix sort for command back-to-front
  ordering, mirrors `CommandSorter.backToFront` pattern.

Both have `getStatistics()` hooked into `context.getDebugSnapshot()`
but no `dispatch()` consumer. `WebGPUPointCloudSortDispatcher` is the
exception — actively consumed by `WasmPointCloudBridge` for splat /
point-cloud sort.

**Why deferred:** Same shape as NEW-GPU-CULLER-CONSUME-OR-DELETE —
each needs a render-path wire-in (plus benchmark data) OR a clean
removal. HiZ is the higher-value of the two for very dense 3D Tile
workflows (would meaningfully cull occluded models). GPUSortKeys
overlaps with the existing CPU sort and probably loses on most
workloads given the readback cost.

**Estimated effort:** 1-2 sessions per dispatcher (depending on
consume-vs-delete decision).

**Impact:** Closes C.2 from AUDIT_2026_05_02 (HiZ + sort parts).
Either retires unused infra or activates GPU-side occlusion / sort.

**Trace:** AUDIT_2026_05_02.md C.2;
`WebGPUFeatureRenderers.ts:340-435` (FR registrations);
`WebGPUHiZOcclusionDispatcher.ts`, `WebGPUGPUSortKeysDispatcher.ts`.

---

### ~~NEW-DEVICE-POOL-ADOPT~~ — RESOLVED (Batch 135, design choice (a) hoist-negotiation)

**Resolution:** Design (a) chosen — adaptive limit + feature negotiation
moved into `WebGPUDevicePool`, and `WebGPUContext._initialize` now calls
`pool.acquireDevice(...)` for adapter + device acquisition.

**What landed:**

- `WebGPUDevicePool` gained `_negotiate(adapter, opts)` which inspects
  the adapter's `limits.*` ceilings and scales the requested limits
  up using `ADAPTIVE_LIMIT_CAPS` (the same `Math.min(adapterValue, cap)`
  logic that used to live inline in `WebGPUContext._initialize`). The
  cap table is exported as a module constant so future tuning lands in
  one place. Feature negotiation merges `WebGPUFeatureFlags.DESIRED_FEATURES`
  with `opts.requiredFeatures`.
- Compatibility check extended: `acquireDevice` verifies the primary
  device's enabled limits are >= the new context's required limits in
  addition to the existing feature-subset check. A second context with
  stricter limit requirements gets its own device instead of silently
  sharing one that doesn't meet them. Tracked limits include the six
  adaptive ones plus `maxBufferSize`, `maxStorageBufferBindingSize`,
  `maxComputeWorkgroupStorageSize` (the commonly-customized ones).
- `WebGPUContextOptions.useDevicePool` added (default true). Setting
  false forces a fresh device by passing `forceNewDevice: true` through
  to the pool — used for tests / benchmarks / recovery scenarios.
- `WebGPUContext._deviceFromPool` flag tracks whether the device came
  from the pool. The destroy path calls `pool.releaseDevice` when true
  (refcount-aware) and `device.destroy()` directly when false (legacy
  direct-injection / recovery paths).
- `featureLevel: "compatibility"` plumbed through to the pool so
  WebGL2-on-WebGPU adapters still work end-to-end.

**Files touched:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUDevicePool.ts` —
  hoisted negotiation, added limits-compatibility check, added
  `featureLevel`, added `enabledLimits` snapshot.
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` —
  `_initialize` now calls `pool.acquireDevice`, destroy calls
  `pool.releaseDevice` when `_deviceFromPool` is true, `useDevicePool`
  option added.

**Trade-offs accepted:**

- The pool now knows about Cesium's render-feature requirements
  (which limits to scale, the cap values). This is the design choice
  for (a) — concentrating policy in one place vs distributing it
  across renderers. A future fork that needs different caps overrides
  `ADAPTIVE_LIMIT_CAPS` (currently a module-level frozen object — if
  override becomes common, expose a setter).
- Per-context limit overrides still work via
  `WebGPUContextOptions.requiredLimits` — those values are never
  lowered by the negotiator. Power users get full control without
  forking the pool.

**Closing batch:** Batch 135.

---

### NEW-ADVANCED-MOTION-VECTORS — per-particle / per-cell / per-feature motion vectors for advanced primitives + classifiers

**What:** Batch 153 closed AUDIT_2026_05_02 B.9 by adding `prevViewProjection: mat4x4<f32>` at the tail of the UBO struct for 8 inline-WGSL renderers (the 5 ground/Vector3DTile classifiers + PointCloud + GaussianSplat + Voxel) per the DP-H41 invariant. The field is a layout-only invariant today; the corresponding per-renderer velocity pass that emits to the rg16float velocity texture is the follow-on work.

**Scope per family:**

- **Vector3DTile classifiers** (Primitive, Polylines, ClampedPolylines): per-feature prev-position storage buffer; velocity entry point that reads `batchId` and looks up prev/curr position; FS emits `(currClip - prevClip).xy / w`. ~80 LOC × 3.
- **GroundPrimitive / GroundPolyline**: per-instance prev-position; same pattern as Polyline collection (Batch 148). ~80 LOC × 2.
- **PointCloud**: per-particle prev-position storage buffer (parallel to the existing per-particle position SSBO). LOD variant needs prev `instanceData` mirror. ~120 LOC.
- **GaussianSplat**: per-splat prev-position. Sort order changes frame-to-frame so prev-buffer indexing must follow the current sort permutation, not a stable per-splat ID. ~150 LOC.
- **Voxel**: per-cell prev grid (or screen-space approximation). Voxel volumes are typically static; per-cell motion is rare. May reduce to camera-only fallback for v1. ~100 LOC if per-cell, ~30 LOC if screen-space approximation.

**Why deferred:** Each family has distinct architectural questions (sort-order indexing for splats, classifier-batch-ID plumbing for Vector3DTile, voxel scope decision). 1-2 sessions per family.

---

### NEW-MODEL-NODE-TRANSFORMS-PREV — per-runtime-node prev-frame modelMatrix for TAA velocity on articulated rigs

**What:** Batch 152 closed AUDIT_2026_05_02 B.8 by threading `nodeModelMatrix = sceneGraphMatrix × runtimeNode.transformToRoot` through the per-primitive camera + material UBOs. The TAA velocity path still uses the model-level `cache.prevModelMatrix`, which is correct for static articulations (set once, then locked) but produces ghosting under TAA when articulation animations modify `runtimeNode.transform` per-frame.

**Scope:**

- Add `prevModelMatrix` to the per-node cache slot (`cache.nodes[nodeIdx]`).
- Capture per-node prev modelMatrix in the same lifecycle as the existing `prevPackedJointMatrices` swap (Batch 130 pattern): `prevModelMatrix.set(currentModelMatrix)` BEFORE updating to the new frame's `nodeModelMatrix`.
- Pass per-node `nc.prevModelMatrix` to `packMaterialUniforms` instead of `cache.prevModelMatrix` for the velocity input.
- ~30 LOC.

**Why deferred:** Visible only under TAA + animated articulations, which is a narrow-but-real intersection (e.g., satellite solar-panel deploy animations under TAA). Static articulations and most articulated assets don't trigger it.

---

### NEW-DRILLPICK-ASYNC — `Scene.drillPick` returns stale prior-frame results on WebGPU

**What:** `Scene.drillPick` is documented to drill through stacked features by calling `pick()` synchronously, hiding the topmost feature with `setShow(false)`, and re-picking. On WebGPU, `WebGPUPickFramebuffer.end()` returns the PREVIOUS frame's pixels (async readback is the architecture), so every iteration sees the same starting state and the drill loop returns garbage. Commit `6ab47593fe` (Batch ~149) added a debug-build `oneTimeWarning` so users see the limitation; the real fix needs an async API.

**Scope:**

- New `Scene.drillPickAsync(...)` API that awaits each pick before mutating show state
- OR force `device.queue.onSubmittedWorkDone()` between iterations on the synchronous path (slow but compatible)
- Update upstream-derived call sites (`Picking.drillPick`) to prefer async on WebGPU
- ~50 LOC

**Why deferred:** Async drillPick changes a public API surface — needs a deprecation path for the sync version and likely a renderer-agnostic `drillPickAsync` shape that WebGL implements as a thin Promise.resolve wrapper.

---

### NEW-MODEL-CLIPPING-POLYGONS — `model.clippingPolygons` is unbound on WebGPU

**What:** `model.clippingPlanes` now produces correct cutaways on WebGPU (commit `ebdc3548c3`, AUDIT_2026_05_02 A.6 partial-fix). The matching `model.clippingPolygons` SDF binding was never wired into the model material BGL — `clippingPolygonsLengthsAndExtents` / `clippingPolygonsTexture` slots don't exist in `EffectsUniforms`, and `ModelClippingPolygonsPipelineStage`'s WGSL counterpart is absent. Setting `model.clippingPolygons = ...` on WebGPU is a silent no-op.

**Scope:** Add SDF texture + length-and-extents UBO field to `EffectsUniforms`; bind through Effects BGL; port `ModelClippingPolygonsStageFS.glsl` to a WGSL inline branch (signed-distance per-polygon test → discard on union/intersection rule, mirrors `modelClipByPlanes`). ~120 LOC.

**Why deferred:** Polygons need the SDF texture upload pipeline that's currently only used by the globe surface renderer. The existing `modelClipByPlanes` was reachable in ~80 LOC because the texture + UBO were already plumbed; polygons require both new bind slots and a new SDF upload path, putting them in a separate batch.

---

### NEW-MODEL-WGSL-CUSTOM-SHADER — WGSL `CustomShader` API parallel to GLSL `CustomShaderPipelineStage`

**What:** `model.customShader` on WebGPU now emits a one-time warning (Batch 133, commit `a403131590`, AUDIT_2026_05_02 A.7 partial-fix). Long-term the user-facing `CustomShader` API needs to accept WGSL chunks and inject them into the Model PBR pipeline, matching the GLSL fragment/vertex injection points.

**Scope:** WGSL chunk-injection mechanism in `WebGPUModelPipelineCache`; entry-point pre-processor that swaps user-supplied `vertexMain`/`fragmentMain` chunks; `CustomShaderMode` switch (REPLACE_MATERIAL / MODIFY_MATERIAL); user-uniform → bind-group plumbing; `varying` → `@location` parity. ~200 LOC, multi-session.

**Why deferred:** Requires a chunk-injection layer that doesn't exist yet, plus a user-uniform-to-WGSL-bind-group adapter (the GLSL path uses `automatic_uniforms` introspection that has no WebGPU equivalent). The warning closes the silent-swallow surface so users can detect the gap.

---

### NEW-POSTPROCESS-USER-WGSL — accept `wgslFragmentShader` on user `PostProcessStage`

**What:** User-added stages on `scene.postProcessStages.add(...)` now emit a one-time warning (Batch 133, commit `a403131590`, AUDIT_2026_05_02 A.13 partial-fix). Long-term the `PostProcessStage` constructor needs a `wgslFragmentShader` option so users can author custom WebGPU stages without a GLSL → WGSL transpile.

**Scope:** Per-stage WGSL pipeline factory; wire user-supplied `wgslFragmentShader` + uniforms map → `WebGPUPostProcessPipeline._userStages[]`; insertion point between built-in stages; resize/destroy lifecycle. ~150 LOC.

**Why deferred:** Needs a generic per-stage pipeline factory that can accept arbitrary uniform layouts at runtime. The warning closes the silent-swallow surface so users can detect the gap.

---

### NEW-CLASSIFIER-2D-CV-MORPH — proper 2D / Columbus View / Morphing support for classifier renderers

**What:** WebGL classification primitives correctly render in
SceneMode.SCENE2D, COLUMBUS_VIEW, and MORPHING. WebGPU's classifier
renderers consume only 3D ECEF position attributes
(`position3DHigh` / `position3DLow` for GroundPrimitive,
RTC-relative-to-`_center` for Vector3DTile* renderers, ellipsoid-
normal-encoded shadow volumes for ClampedPolylines), so projecting
those 3D positions through the 2D / CV / morph projection matrix
produces wandering or invisible classification volumes.

**Current behavior (Batch 150 conservative gate):** Each affected
classifier silently skips emission when `frameState.mode !== SceneMode.SCENE3D`,
producing nothing on screen rather than visually-incorrect volumes.
A debug-build `oneTimeWarning` flags the limitation. The four
affected renderers are:

- `WebGPUGroundPrimitiveRenderer` (GroundPrimitive)
- `WebGPUVector3DTilePrimitiveRenderer` (vector tile polygons)
- `WebGPUVector3DTileClampedPolylinesRenderer` (vector tile clamped polylines)
- `WebGPUVector3DTilePolylinesRenderer` (non-clamped vector tile polylines)

`WebGPUGroundPolylineRenderer` is NOT affected — Batches 116/117 era
shipped its full 2D + Columbus View + Morphing pipeline (parallel
2D attribute slots at locations 8-13, dedicated morph pipeline,
sceneMode flag in uniforms). The proper fix below should mirror its
pattern.

**Why deferred:** Each affected renderer needs:

1. **Vertex buffer** extended with 2D/CV position attributes
   (`position2DHigh` / `position2DLow` from the geometry's `_webgpuGeometryData`).
2. **Pipeline layout** extended with new attribute slots.
3. **Per-renderer WGSL VS** branched on a sceneMode uniform: 3D
   path uses 3D positions + RTE camera; 2D / CV path uses 2D
   positions + 2D / CV view-projection; MORPHING blends between
   them by `czm_morphTime`.
4. **JS pack** writes scene-mode flag into the per-frame uniform
   buffer.
5. (Optional) Separate morph pipeline if morph-mode WGSL diverges
   significantly from the steady-state branch (the GroundPolyline
   renderer does this).

For 3D Tiles content (Vector3DTile* renderers), 2D / CV use is rare
in production — the full 3D Tiles tileset architecture is 3D-
oriented. Lower-priority unless a user explicitly reports a need.

For GroundPrimitive (which IS commonly used in 2D scenes for UI
overlay shapes), a proper fix matches WebGL behavior and unblocks
data-vis use cases.

**Estimated effort:** 2-3 sessions per renderer (~80 LOC each).
GroundPolyline's existing implementation is the reference template.

**Trace:** AUDIT_2026_05_02.md A.4; Batch 150 conservative gate;
`WebGPUGroundPolylineRenderer.js` (locations 8-13 + morph pipeline)
as the reference implementation.

---

### ~~NEW-COLLECTIONS-MOTION-VECTORS~~ — Collections sweep RESOLVED (Batches 143/144/148); advanced primitives remain

**Status:** All four Collections renderers (Billboard, Label,
Polyline, Point) now emit per-pixel motion vectors when TAA is
enabled. Animated content (entity tracking, moving sprite labels,
path animations, moving points) no longer ghosts on the temporal
history. Static content emits zero velocity (prev = current) — no
behavior change for the common case.

Beyond Collections, advanced primitives (GaussianSplat / PointCloud /
Cloud / Voxel) and classifiers (GroundPrimitive / Vector3DTile*)
still rely on TAA's camera-only fallback; that's correct for the
static case but ghosts on per-instance / per-particle / per-cell
animation. See the "Beyond Collections" section below.

**What landed for Polyline + Point (Batch 148):**

- `PolylineCollection.wgsl` gained `vertexVelocityMain` +
  `fragmentVelocityMain` entry points at the next free locations
  (7-10 for prev start/end positions). Center delta interpolated
  via `mix(prevClipStart, prevClipEnd, isEnd)` — same `isEnd`
  vertex-index switch the regular VS uses for current-frame
  interpolation. Velocity = `mix`ed current NDC − `mix`ed prev NDC.
  PolylineArrow / PolylineDash / PolylineGlow / PolylineOutline
  material variants do NOT have velocity entry points yet —
  velocity emission for those is skipped (camera-only fallback
  continues).
- `PointPrimitiveColor.wgsl` gained the velocity entries at
  locations 7-8 (single position per instance, mirrors Billboard).
- `WebGPUPolylineRenderer.js`:
  - `VELOCITY_PREV_SEGMENT_BUFFER_LAYOUT` (4 slot — start/end high/low).
  - `buildPolylineVelocityDescriptor` + `getOrCreatePolylineVelocityPipelineEntry`
    (gated on `materialType === "polylineColor"` since only the base
    shader has velocity entries).
  - Per-material `prevSegmentBuffer_*` GPU buffers + `prevSegmentData_*`
    CPU stash, mirroring the segment buffer keying.
  - Velocity command attached to color command via
    `cmd.velocityCommand` only when TAA is on AND the velocity
    pipeline resolved this tick. Velocity uses ONLY the camera bind
    group (slot 0); the material BG is unused by the velocity FS,
    so it's omitted to keep the bind group count down.
  - Per-material `prevSegmentBuffer_*` released in
    `destroyWebGPUPolylineResources`.
- `WebGPUPointPrimitiveRenderer.js`:
  - `VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT` (2 slots — high/low).
  - `buildPointVelocityDescriptor`.
  - `cache.velocityPipelines` Map keyed identically to the color
    cache; cleared in lockstep on HDR / scene-format change.
  - `cache.prevInstanceBuffer` + `cache.prevInstanceData` stash.
  - Per-frame writeBuffer of prev BEFORE current — gated on the
    existing `needsRebuild` flag so static point collections don't
    re-upload buffers for nothing. Velocity command re-attached
    every frame (cheap reference assignment) so it picks up changes
    to visible count without a full rebuild.
  - `prevInstanceBuffer` released in `destroyWebGPUPointResources`.

**What landed for Billboard (Batch 143):**

The Collections sweep started here. See Batch 143 for the full
design notes — Polyline + Point + Label all mirror this pattern:

**What landed for Label (Batch 144):**

- `BillboardCollectionSDF.wgsl` gained `vertexVelocityMain` +
  `fragmentVelocityMain` entry points mirroring the Billboard
  pattern. SDF instance stride uses locations 0-12, so prev-
  position locations are 13 (high) / 14 (low). Center-only delta;
  glyph corner offsets / pixel offsets / rotation cancel between
  frames for moving labels. The shared velocity FS guards against
  `w <= 0` and returns `vec2(0)` so TAA falls back to camera-only
  reprojection on near-plane clips.
- `WebGPULabelRenderer.js`:
  - `VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT` + `buildSDFVelocityDescriptor`
    helpers paralleling Billboard's. Velocity pipeline targets
    `rg16float`, depth read-only.
  - `cache.sdfVelocityPipelineEntries` Map keyed identically to
    `cache.sdfPipelineEntries` and cleared in lockstep on
    HDR / scene-format change.
  - `cache.sdfPrevInstanceBuffer` GPU buffer +
    `cache.sdfPrevInstanceData` CPU stash. Same first-frame
    initialization (prev = current → zero velocity), same
    pad-tail-with-current-data behavior on glyph count growth, same
    TAA-off → on transition resilience.
  - `sdfCommand.velocityCommand` set when TAA is on; the existing
    `_runVelocityPass` already walks the command list for this slot.
  - `sdfPrevInstanceBuffer` released in
    `destroyWebGPULabelResources`.

**What landed for Billboard (Batch 143):**

- `BillboardCollection.wgsl` gained `vertexVelocityMain` +
  `fragmentVelocityMain` entry points plus `VelocityVertexInput` /
  `VelocityVertexOutput` structs. The velocity VS reads the regular
  instance buffer at slot 0 and a one-frame-lagged prev-instance
  buffer at slot 1 (locations 11/12 carry prev posHigh / posLow).
  Center-only delta — corner offsets / rotation / pixel offsets
  cancel between frames for moving billboards, so the FS emits
  `(currentCenterNdc - prevCenterNdc)` directly. Degenerate
  `clip.w <= 0` returns `vec2(0)` so TAA falls back to camera-only
  reprojection on near-plane clips.
- `WebGPUBillboardRenderer.js`:
  - `VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT` + `buildBillboardVelocityDescriptor`
    helpers. Velocity pipeline targets `rg16float` matching the
    scene-FB velocity texture format; depth is read-only
    (`depthCompare: less-equal`, `depthWriteEnabled: false`) so
    fragments behind opaque geometry fail the depth test.
  - `cache.velocityPipelineEntries` Map keyed on the same `defines`
    bitmask as the color pipeline cache; lazily populated when
    `frameState.scene.taaEnabled === true`.
  - `cache.prevInstanceBuffer` GPU buffer + `cache.prevInstanceData`
    CPU-side typed-array stash. Each frame, the renderer uploads
    last frame's data to the prev buffer BEFORE overwriting the
    current buffer with this frame's data. First-frame fallback
    initializes prev = current (zero velocity, equivalent to "no
    history"). Buffer lifecycle outlives a single TAA off-toggle so
    a TAA off → on transition doesn't drop a frame of velocity.
  - Resize-and-pad logic for visibleCount changes between frames:
    if last frame had fewer billboards, the tail is filled with
    current data so newly-spawned billboards see prev = current
    (born this frame, no apparent motion).
  - `cache.colorCommand.velocityCommand` set to the velocity command
    when TAA is on; `WebGPUSceneRenderer._runVelocityPass` already
    walks the command list for this slot and dispatches the
    velocity command into the rg16float velocity texture.
- `cache.prevInstanceBuffer` released in
  `destroyWebGPUBillboardResources`.

**Pattern for follow-up renderers (Label / Polyline / Point /
GaussianSplat / PointCloud / Cloud):**

1. **Shader (`*Collection.wgsl` / `BillboardCollectionSDF.wgsl`):**
   - Add `VelocityVertexInput` mirroring the regular `VertexInput`
     plus prev-position locations starting at the next free
     `@location(N)`. Locations 11+ for Billboard; pick the next free
     slot for each shader (Label SDF uses 0-12 already, so prev
     starts at 13).
   - Add `VelocityVertexOutput` carrying `currentCenterClip` +
     `prevCenterClip` as `vec4<f32>` varyings.
   - Add `vertexVelocityMain` that projects current via
     `mvpRelativeToEye` and prev via `previousViewProjection` (full
     mat4 multiply of `prevPosHigh + prevPosLow` — precision loss at
     planet scale is acceptable for NDC delta magnitudes).
     Rasterize the quad / line / point at the CURRENT-frame position
     so the velocity texture covers the right pixels.
   - Add `fragmentVelocityMain` returning
     `(currentCenterClip.xy/curW) - (prevCenterClip.xy/prevW)` as
     `vec2<f32>` to `@location(0)`. Guard against `w <= 0` with
     `vec2(0)` fallback.
2. **Pipeline cache (`WebGPU*Renderer.js`):**
   - Add `VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT` describing the
     prev-position attribute slots (use the same per-instance stride
     so the renderer can upload the entire prev buffer wholesale).
   - Add `buildXVelocityDescriptor` helper paralleling
     `buildXDescriptor` but with `entryPoint: "vertexVelocityMain" /
     "fragmentVelocityMain"`, `targets: [{ format: "rg16float" }]`,
     and the two-VB `buffers` array.
   - Add `cache.velocityPipelineEntries` Map keyed identically to
     the color cache; clear it on HDR / scene-format change in the
     same spot the color cache gets cleared.
   - Resolve velocity pipeline only when
     `frameState.scene.taaEnabled === true`.
3. **Prev-instance buffer management:**
   - Add `cache.prevInstanceBuffer` (GPU) + `cache.prevInstanceData`
     (CPU Float32Array stash).
   - Per-frame: before `device.queue.writeBuffer` of new instance
     data, write LAST frame's data to `prevInstanceBuffer`. On the
     first frame `prevInstanceData` is undefined — fall back to
     using current data (zero velocity).
   - Visible-count changes: pad/truncate the prev payload so
     newly-spawned instances see prev = current.
   - Stash this frame's typed array into `cache.prevInstanceData`
     for next frame's use.
   - Free `prevInstanceBuffer` in the renderer's destroy path.
4. **Velocity command attachment:**
   - When `taaEnabledThisFrame && velocityPipeline &&
     prevInstanceBuffer`, build a `WebGPUDrawCommand` mirroring the
     color command except for `pipeline: velocityPipeline` and
     `vertexBuffers: [instanceBuffer, prevInstanceBuffer]`. Attach
     it as `cache.colorCommand.velocityCommand`.
   - When TAA is off, set `cache.colorCommand.velocityCommand =
     undefined` so a stale prior-frame velocity command doesn't
     leak.

**Collections follow-ups — all SHIPPED:**

- ~~**Label**~~ — SHIPPED (Batch 144).
- ~~**Polyline**~~ — SHIPPED (Batch 148). Per-instance prev start/end
  positions at locations 7-10. Center delta interpolated via
  `mix(prevClipStart, prevClipEnd, isEnd)`. Material variants
  (Arrow/Dash/Glow/Outline) skip velocity emission since they don't
  yet have velocity entry points.
- ~~**PointPrimitive**~~ — SHIPPED (Batch 148). Per-instance prev
  position at locations 7-8. Mirrors Billboard exactly.

**Beyond Collections (out of "1 session" scope):**

- GaussianSplat / PointCloud / Cloud — per-particle prev-state
  needed; estimated 1-2 sessions per family.
- Voxel — time-evolving voxels need per-voxel-grid-cell prev
  state; architectural design needed first (out of scope).
- GroundPrimitive / Vector3DTile* classifiers — typically don't
  animate per-frame, so velocity emission is low-priority. Camera-
  only reprojection (existing fallback) is correct for the static
  case.

**Trace:** AUDIT_2026_05_02.md B.10;
`WebGPUTAAEffect.ts:_motionVectorsValid` (camera-only fallback path);
`ModelPBRComplete.wgsl:computeMotionVectorScreenSpace` (template
implementation, Batch 96); `BillboardCollection.wgsl` velocity
entries (Batch 143); `BillboardCollectionSDF.wgsl` velocity
entries (Batch 144); `PolylineCollection.wgsl` +
`PointPrimitiveColor.wgsl` velocity entries (Batch 148).

---

### ~~NEW-COLLECTIONS-DISTANCE-ATTRIBS~~ — RESOLVED (Batch 136)

**Resolution:** All four distance gates now wired across every
collection where they apply. WebGL feature parity reached.

**What landed:**

- 3 new `ShaderDefine` bits added (add-only, sequential after the
  Batch 135 `DISTANCE_DISPLAY_CONDITION`):
  `EYE_DISTANCE_TRANSLUCENCY (1<<5)`,
  `EYE_DISTANCE_PIXEL_OFFSET (1<<6)`,
  `EYE_DISTANCE_SCALING (1<<7)`.
- Each ramp uses a WGSL `czm_nearFarScalar` helper that mirrors
  `Source/Shaders/Builtin/Functions/nearFarScalar.glsl` — packed vec4
  layout `(near, nearValue, far, farValue)` so the JS side just
  passes the upstream `NearFarScalar` directly through a shared
  `packNearFarScalar(out, offset, scalar, identity)` helper.
- `BillboardCollection.wgsl` now wires all 4 gates. Instance buffer
  bumped from 7 vec4 (28 floats) to 10 vec4 (40 floats) — three new
  per-instance NearFarScalars at locations 7/8/9. The pick variant
  mirrors the layout so a fading / hidden / shrunk billboard is also
  unpickable.
- `PolylineCollection.wgsl` wires DDC + EYE_DISTANCE_TRANSLUCENCY (no
  pixelOffset, no quad-scale on polylines). Instance buffer 6 → 7
  vec4 with translucencyByDistance at @location(6); DDC packed into
  `perInstanceFlags.zw` (previously `_pad`).
- `PointPrimitiveColor.wgsl` + `PointPrimitivePick.wgsl` wire DDC +
  EYE_DISTANCE_TRANSLUCENCY + EYE_DISTANCE_SCALING (no pixelOffset on
  points). Instance buffer 5 → 7 vec4 with translucencyByDistance +
  scaleByDistance at @locations 5/6.
- `LabelCollection` ~~inherits the Billboard fix automatically~~
  needed its OWN wiring (Batch 137 correction). Although Label
  setters propagate distance attribs to glyph billboards, those
  glyphs render through a SEPARATE shader path —
  `BillboardCollectionSDF.wgsl` driven by `WebGPULabelRenderer.js`,
  not `BillboardCollection.wgsl` driven by `WebGPUBillboardRenderer.js`.
  Batch 137 added the gates to the SDF shader + extended the
  Label renderer's instance buffer (36 → 48 floats) so
  `label.distanceDisplayCondition` / `translucencyByDistance` /
  `pixelOffsetScaleByDistance` / `scaleByDistance` now actually
  affect labels on WebGPU.
- Per-frame `computeDefinesForFrame` in every renderer now scans
  for the new gates and only flips bits when at least one
  primitive sets the corresponding property — collections that
  don't use distance attribs stay on the baseline pipeline.
- Prewarm tables extended with the most common production combos
  (KML / GeoJSON entities typically combine DDC + translucency).
- One-time warnings (`WebGPUBillboard.distanceAttribs`,
  `WebGPUPolyline.distanceAttribs`, `WebGPUPointPrimitive.distanceAttribs`)
  retired.

**Files touched:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` —
  3 new define bits.
- `packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js` —
  layout extension, packing helper, define scan, prewarm, warning
  retirement.
- `packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js` —
  DDC + translucency wiring.
- `packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js` —
  DDC + translucency + scaling wiring.
- `packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl` —
  4-gate VS + `czm_nearFarScalar`.
- `packages/engine/Source/Shaders/WebGPU/Collections/PolylineCollection.wgsl` —
  2-gate VS + `czm_nearFarScalar`.
- `packages/engine/Source/Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl` —
  3-gate VS + `czm_nearFarScalar`.
- `packages/engine/Source/Shaders/WebGPU/Collections/PointPrimitivePick.wgsl` —
  pick path mirrors color visibility.

**Batch 137 audit follow-up — shader variants the original Batch 136
missed:**

- `BillboardCollectionPick.wgsl` — pick path needed all 4 gates so an
  invisible billboard (translucency=0 / scale=0 / out-of-DDC-window)
  is also unpickable. Pre-Batch-137 the pick variant only had
  DISABLE_DEPTH + SPLIT, so a hidden-by-distance billboard remained
  pickable.
- `BillboardCollectionSDF.wgsl` + `WebGPULabelRenderer.js` — labels
  render through this SDF path, not through the base BillboardCollection
  shader. Both the WGSL and the renderer's instance buffer (36 → 48
  floats) needed the same 4-gate extension. Without this fix Batch
  136's claim "Label inherits via Billboard" was visibly wrong: setting
  `label.translucencyByDistance` had no effect.
- `PolylineCollectionPick.wgsl` — same parity issue as Billboard pick
  (DDC + translucency).
- `PolylineArrow.wgsl` + `PolylineDash.wgsl` + `PolylineGlow.wgsl` +
  `PolylineOutline.wgsl` — material variants of polyline. Each gained
  a `v_alphaScale` varying that propagates `translucencyByDistance` to
  the FS where the material's final color alpha is multiplied. DDC +
  DISABLE_DEPTH + SPLIT also added.

**Trade-offs accepted:**

- Instance buffer stride grew on each renderer to make room for the
  always-present NearFarScalar vec4s. The shader gates ifdef-out
  reads when the corresponding define isn't set, so the cost is
  upload bandwidth only (negligible for typical scene sizes).
- Prewarm tables grew to ~10 variants per renderer. Cold-path
  variants compile lazily through the shader-module cache.
- The Polyline SDF Label instance buffer grew 36 → 48 floats; for a
  typical 10k-glyph label scene that's an extra 480 KB of
  per-frame upload — negligible.

**Closing batch:** Batch 136 + Batch 137 (variant follow-up after
audit identified missed shader paths).

---

### ~~NEW-VS-THREE-POINT-DEPTH-CHECK~~ — RESOLVED (Batch 138, simplified anchor-only sampling)

**Resolution:** Implemented a simplified 1-point depth check (anchor
sampling only) instead of the full 3-point pattern. WebGL's
`VS_THREE_POINT_DEPTH_CHECK` samples globe depth at three label-anchor
positions (origin / top / top-right) and discards only when ALL three
are occluded. The simplified version samples at the anchor only, which
covers the dominant case (label centered behind a hill) but slightly
over-discards when the anchor is occluded but the label spans high
enough to peek over. Tracked as
`NEW-VS-THREE-POINT-FULL-3POINT-SAMPLING` for future refinement —
proper 3-point sampling requires extracting `addScreenSpaceOffset`
into a shared chunk so all 3 sample points can call it.

**What landed:**

- `VS_THREE_POINT_DEPTH_CHECK` ShaderDefine bit (1 << 8). Add-only.
- `BillboardCollection.wgsl` + `BillboardCollectionSDF.wgsl` (label
  SDF path) gained:
  - Globe depth texture binding at `@group(0) @binding(3)` + sampler
    at `@binding(4)`. VS-only visibility.
  - `czm_unpackDepth(rgba) -> f32` helper (matches WebGL packDepth/
    unpackDepth scheme).
  - `getGlobeDepth(positionEC) -> f32` helper that projects to NDC,
    samples the packed depth texture, unpacks, and returns clip-z
    units for direct comparison against `clipPos.z`.
  - Per-instance `threePointAttribs` vec4 carrying depthOrigin
    (.xy) + enableDepthCheck flag (.z) + reserved (.w). Billboard
    @location(10), Label SDF @location(12).
  - 3-point check body inside `//>>ifdef VS_THREE_POINT_DEPTH_CHECK`:
    gates on `camDistSq < threePointDepthTestDistance^2`, samples
    globe depth at the anchor, collapses clipPos to a degenerate
    position when occluded.
- `WebGPUBillboardRenderer.js`:
  - Instance buffer 40 → 44 floats (10 → 11 vec4); `threePointAttribs`
    packed at offset 40-43 with default `(0, 0, 1.0, 0)` for plain
    billboards (label collection overrides via its own renderer).
  - BGL extended to 5 entries (added globe depth texture + sampler,
    VS-only).
  - Bind group rebuilds when `context._globeDepthView` changes
    (placeholder bound when null).
  - Camera UBO slot 43 (formerly `_pad2`) now carries
    `threePointDepthTestDistance` — read from
    `collection._threePointDepthTestDistance`.
  - `computeDefinesForFrame` flips `VS_THREE_POINT_DEPTH_CHECK` when
    `collection._shaderClampToGround === true` (mirrors WebGL's
    `BillboardCollection.js:1031`).
  - Prewarm extended with 3 new variants (3PD only, 3PD + KML,
    full prod with 3PD).
- `WebGPULabelRenderer.js`:
  - Instance buffer 48 → 52 floats (12 → 13 vec4); `threePointAttribs`
    packed at offset 48-51 with the glyph billboard's
    `_horizontalOrigin` / `_verticalOrigin` (Label propagates from
    parent via `_rebindAllGlyphs`).
  - SDF BGL extended to 5 entries (matching Billboard).
  - Bind group rebuilds with globe depth view per-frame.
  - Camera UBO slot 43 reads `labelCollection._glyphBillboardCollection._threePointDepthTestDistance`.
  - `computeLabelDefinesForFrame` flips the bit when
    `glyphCollection._shaderClampToGround === true`.
  - Prewarm extended.
- Pick paths intentionally NOT modified — pick-through-terrain
  matches WebGL behavior.

**Files touched:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js`
- `packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js`
- `packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl`

**Trade-offs accepted:**

- Anchor-only sampling vs proper 3-point. Functional for the dominant
  case (KML labels behind hills); subtle over-discard for very tall
  labels that span over a peak. Future refinement tracked.
- BGL grew to 5 entries on Billboard + Label SDF — extra placeholder
  texture binding when feature OFF. Negligible cost.
- Bind group rebuilds when globe depth view changes (per-frame on
  globe scenes). One extra `createBindGroup` call per frame per
  collection — well within WebGPU bind-group creation budgets.

**Closing batch:** Batch 138.

---

### ~~NEW-VS-THREE-POINT-FULL-3POINT-SAMPLING~~ — RESOLVED (Batch 139)

**Resolution:** Implemented full 3-point sampling. Each billboard /
label samples globe depth at three key points (origin / top / top-right)
and discards only when ALL three are occluded.

**What landed:**

- `addScreenSpaceOffsetClip(anchorClip, direction, size, pixelOffset, rotation, pixelToClip)` —
  WGSL helper that computes a clip-space corner position for a
  billboard given the anchor's clipPos and a direction in [-1, 1].
  Rotation, pixelOffset, and size baked in. Added to both
  `BillboardCollection.wgsl` and `BillboardCollectionSDF.wgsl`. (Did
  not extract to a shared chunk — the WGSL preprocessor's `//>>include`
  semantics weren't necessary; ~30 LOC duplicated across 2 files is
  cheaper than the chunk-include refactor.)
- `getGlobeNdcDepth(clipPos)` returns the terrain's NDC z directly
  (instead of converting to clip-z) so callers compare in NDC space.
  This also fixed a separate Batch 138 design flaw where the
  clip-z bias (`depthsilon = 10.0` clip-units) was distance-dependent.
  Now uses `ndcBias = 0.0001` which is uniform across distances.
- 3-point check body: samples anchor, top (origin + (0, 1)), top-right
  (origin + (1, 1)). Cascade: only check sample 2 when sample 1 is
  occluded; only check sample 3 when sample 2 is occluded; only
  discard when all 3 are occluded. Mirrors WebGL's
  `BillboardCollectionVS.glsl:294-323`.

**Files touched:**

- `packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl`

**Closing batch:** Batch 139.

---

### ~~NEW-DISABLE-DEPTH-DISTANCE-INFINITY-PARITY-POLYLINE-POINT~~ — RESOLVED (Batch 140)

**Resolution:** Mechanical sweep across the 2 remaining renderers + 8
shader variants. Both `WebGPUPolylineRenderer.js` and
`WebGPUPointPrimitiveRenderer.js` gained the
`encodeDisableDepthTestDistance(value)` helper (matching the
Billboard + Label implementation): maps `Number.POSITIVE_INFINITY` to
`-1.0` for the WGSL `<0` sentinel, returns `value` for finite
positives, and `0.0` for `NaN` / negative / non-number inputs. Pack
sites (4 total — color + pick on each renderer) updated to call the
helper.

WGSL pattern swap applied to all 8 affected shaders:
`PolylineCollection.wgsl`, `PolylineCollectionPick.wgsl`,
`PolylineArrow.wgsl`, `PolylineDash.wgsl`, `PolylineGlow.wgsl`,
`PolylineOutline.wgsl`, `PointPrimitiveColor.wgsl`,
`PointPrimitivePick.wgsl`. Each now uses the raw-sentinel
cascade — read `perInstanceFlags.x`, check `<0` BEFORE squaring,
fall through to per-instance squared compare, then to frame-wide
minimum compare. Pre-fix the squaring step killed the sign on the
sentinel branch, making the WebGL-parity "always disable" mode dead
code.

**Files touched:** 2 JS renderers + 8 WGSL shaders.

**Closing batch:** Batch 140.

---

### ~~NEW-VS-THREE-POINT-DISABLE-DEPTH-INTERACTION~~ — RESOLVED (Batch 139)

**Resolution:** Implemented in WGSL (no JS-side changes needed). The
gate now reads `disableDepthTestDistance` from `perInstanceFlags.x`
(and falls back to `camera.minimumDisableDepthTestDistance`) to
determine whether the camera is within disable-depth range, then
drops `enableDepthCheck` to 0 when it is. Mirrors WebGL's
`BillboardCollectionVS.glsl:266-277` exactly.

Computing `enableDepthCheck` in WGSL (not JS) was simpler than the
original deferred plan: the data is already on the per-instance
attribute, the camera UBO has the frame-wide minimum, and `camDistSq`
is already computed for the other distance gates. ~12 LOC per shader.

**Files touched:** `BillboardCollection.wgsl` + `BillboardCollectionSDF.wgsl`.

**Closing batch:** Batch 139.

---

### ~~NEW-LABEL-SDF-BIND-GROUP-CACHING~~ — RESOLVED (Batch 139)

**Resolution:** `WebGPULabelRenderer.update()` now caches the
last-bound (atlas view, atlas sampler, globe depth view, uniform
buffer) tuple and only recreates the SDF bind group when at least
one resource rotated. Pre-Batch-139 the bind group was
unconditionally rebuilt every frame, paying the `createBindGroup`
cost for every Sandcastle frame even when nothing changed.

**Status note:** The bind group still rebuilds every frame on globe
scenes because `context._globeDepthView` is a fresh `createView()`
object per frame from the scene renderer's frustum loop. A more
aggressive cache would compare by underlying `GPUTexture` identity
rather than view object identity — but that requires the scene
renderer to expose the texture (or cache the view itself). Tracked
separately if profiling shows it matters.

**Files touched:** `WebGPULabelRenderer.js`.

**Closing batch:** Batch 139.

---

### ~~NEW-VS-THREE-POINT-DEPTH-CHECK~~ — original plan (now resolved above)

**What:** WebGL billboards and labels with
`heightReference !== HeightReference.NONE` (i.e., clamped to the
terrain surface) participate in a 3-point depth check that hides them
when occluded by terrain. The vertex stage samples the globe depth
texture at three "key points" of the quad (origin, top, top-right). If
ALL three fail the depth comparison vs the label's eye-space depth,
the vertex is collapsed to a degenerate position so the rasterizer
discards it. The 3-point pattern is intentional — labels that span over
hills should remain visible if any anchor point pokes above the
terrain.

WebGL gates the entire feature behind a `u_threePointDepthTestDistance`
uniform: outside that distance, the check is skipped (perf optimization
for far zooms where labels can't realistically be terrain-occluded).
Activated via the `VS_THREE_POINT_DEPTH_CHECK` define when
`BillboardCollection._shaderClampToGround === true` (i.e., any billboard
in the collection has a non-NONE heightReference).

**Status (WebGPU, Batch 137):** Not implemented. Clamp-to-ground
billboards / labels render through terrain on WebGPU — visible
regression for any KML / GeoJSON dataset that anchors labels to
ground (a very common case). Tracked here as the next item to plan
after audit A.14 close-out.

**Why deferred:** Multi-session feature with several non-trivial
prerequisites:

1. **`VS_THREE_POINT_DEPTH_CHECK` ShaderDefine bit** — add `1 << 8` to
   the registry (add-only, sequential after Batch 137's bit 7).

2. **Globe depth texture binding on Billboard / Label BGLs**:
   - Already shipped on the Model effects BGL at @group(3) @binding(15)
     (`globeDepthTex`).
   - Billboard / Label / SDF BGLs need it added. Recommendation:
     extend the camera BGL with two new bindings (depth texture +
     sampler) at @group(0) @binding(3..4). Keeps it on the always-bound
     camera group rather than introducing a new group.
   - Sample type: `unfilterable-float` (the depth texture is packed via
     `czm_packDepth` into RGBA8). NEAREST sampler.

3. **Camera UBO extension**:
   - Add `threePointDepthTestDistance: f32` slot.
   - Optionally add `inverseProjection: mat4x4<f32>` if depth unpacking
     needs it (probably not — the WebGL flow projects forward and
     samples NDC, which is what the WGSL port should mirror).
   - Total UBO growth: ~16-80 bytes.

4. **Per-instance `depthOrigin` attribute**:
   - WebGL packs label horizontal/vertical origin into
     `compressedAttribute2.w`. Two enum values (-1 / 0 / +1 each axis,
     plus the "billboard inherits regular origin" sentinel) → 4 bits
     each, fits in a u8.
   - WebGPU options:
     - **(a) Pack into existing `compressedAttr0.zw`** (currently
       alignedAxis.xy on Billboard). Tight but doable.
     - **(b) Add a new vec4 slot** for label-specific data
       (depthOrigin + heightReference flag + sdfParams overflow).
       Cleaner but bumps stride.
   - Recommendation: (b). Stride growth is negligible at typical
     label counts; clarity wins.

5. **WGSL helpers**:
   - `getGlobeDepth(positionEC) -> f32`: project to NDC, sample globe
     depth texture, unpack via `czm_unpackDepth` equivalent. ~15 LOC.
   - `addScreenSpaceOffset(positionEC, ...) -> vec4<f32>`: existing
     inline corner expansion needs extraction as a function so the
     three sample points can call it with different `(direction,
     origin)` pairs. Currently inlined in the VS body of every
     billboard variant — would need to live in a shared helper file
     (`chunks/functions/csm_addScreenSpaceOffset.wgsl`?) and be
     `//>>include`-d. Module cache key needs to handle this. ~50 LOC.
   - `czm_unpackDepth(rgba) -> f32`: standard 4-byte → float decode.
     Already inline in some shaders; worth extracting. ~5 LOC.

6. **VS three-point check body**:
   - Mirror the WebGL conditional structure: `if (lengthSq < dist^2 &&
     enableDepthCheck == 1.0)`.
   - Compute three sample points: `pEC1 = origin`, `pEC2 = top`,
     `pEC3 = top-right`.
   - Depth comparison: `pEC.z + depthsilon < globeDepth` for each
     (depthsilon = 10.0 from WebGL).
   - If all three fail: `positionEC = vec3(0.0)`.
   - ~30 LOC per shader.

7. **Frame-state bit detection in `computeDefinesForFrame`**:
   - Set `VS_THREE_POINT_DEPTH_CHECK` when
     `collection._shaderClampToGround === true` (mirrors
     `BillboardCollection.js:1031`).
   - Flag flips when a billboard's `heightReference !==
     HeightReference.NONE` is added to the collection.
   - ~10 LOC per renderer.

8. **Per-shader port**:
   - `BillboardCollection.wgsl` (color) — primary consumer.
   - `BillboardCollectionSDF.wgsl` (label glyph SDF path) —
     critical, this is what most labels render through.
   - **Pick paths**: WebGL does NOT enable the check on pick. WebGPU
     should match — pick-through-terrain is acceptable.
   - **Polyline / Point**: don't apply, no clamp-to-ground heightRef.

9. **Backwards compatibility**:
   - The `_shaderClampToGround` flag already exists on
     `BillboardCollection`; WebGPU's `computeDefinesForFrame` just
     needs to read it.
   - Existing billboards without a heightReference stay on the
     baseline shader (zero new perf cost).

**Architectural decisions to make before implementing:**

- (Q1) Bind globe depth on the camera BGL or introduce a new BGL?
  - **Recommendation**: camera BGL extension. One bind cost,
    available everywhere.
- (Q2) Extract `addScreenSpaceOffset` to a chunk file?
  - **Recommendation**: yes. The inline duplication across 7
    Billboard / Polyline shaders is already a maintenance burden;
    this feature is the right time to extract.
- (Q3) Keep the per-instance `depthOrigin` packing tight or split
  into a new vec4?
  - **Recommendation**: new vec4 slot. ~64 bytes per visible
    label of bandwidth; negligible.
- (Q4) Should the SDF / Label path also pay this cost when no
  labels are clamped?
  - **No.** The bit is per-collection; labels-without-clamp don't
    pay anything beyond the baseline shader.

**Performance profile:**

- 3 globe-depth texture samples per visible vertex when active.
- 6 vertices × 3 samples × 1k labels = ~18k texture samples per
  frame. Globe depth texture is small (~512×512), well within
  texture cache. Negligible.
- Cost when feature OFF: zero (the bit isn't flipped, the gate
  ifdef-blocks compile out).

**Estimated effort:** 2-3 sessions, broken roughly as:

- Session 1: Camera BGL extension + globe depth wiring + helper
  extraction (`addScreenSpaceOffset`, `getGlobeDepth`) + ShaderDefine
  bit.
- Session 2: 3-point check body in `BillboardCollection.wgsl` +
  `BillboardCollectionSDF.wgsl`. JS-side `computeDefinesForFrame`
  detection + `depthOrigin` per-instance attribute packing.
- Session 3: Audit pass (similar shape to Batch 137 — verify pick
  variants intentionally don't gate, verify renderer instance
  buffer layouts match WGSL @location bindings, verify
  `_shaderClampToGround` flag flips correctly when heightReference
  changes mid-session).

**Estimated LOC:** ~300-400, distributed:

- ShaderDefine + bit: 5
- Camera UBO + BGL extensions: ~50
- WGSL helpers (extracted): ~70
- VS check body × 2 shaders: ~60
- JS instance packing + detection × 2 renderers: ~50
- Tests / pre-warm tables: ~30
- DEFERRED_WORK + comments: ~30

**Prerequisites:**

- None blocking — globe depth texture is already produced by
  `WebGPUGlobeDepth.executeCopyDepth`, sampled by the model PBR
  shader via `globeDepthTex`. Reusing the same texture view + a
  filtering-compatible sampler is straightforward.

**Impact:** Closes the WS_THREE_POINT_DEPTH_CHECK feature gap. KML
/ GeoJSON / CZML labels with heightReference of CLAMP_TO_GROUND or
CLAMP_TO_TERRAIN will visually correctly hide behind hills and
mountains on WebGPU, matching WebGL behavior.

**Trace:**

- WebGL VS: `Source/Shaders/BillboardCollectionVS.glsl:294-324`
  (the `#ifdef VS_THREE_POINT_DEPTH_CHECK` block).
- WebGL helper: `Source/Shaders/BillboardCollectionVS.glsl:89-104`
  (`getGlobeDepth`).
- Define enablement: `Source/Scene/BillboardCollection.js:1031`
  (`_shaderClampToGround` flag).
- Uniform setter:
  `Source/Scene/BillboardCollection.js:336-338`
  (`u_threePointDepthTestDistance`).
- Frontend property:
  `Source/Scene/BillboardCollection.js:472-481`
  (`get/set threePointDepthTestDistance`).

---

### ~~NEW-MODEL-AS-CLASSIFIER~~ — RESOLVED (Batch 142)

**Resolution:** `model.classificationType` now drapes the model's geometry
onto terrain / 3D-Tile surfaces using the depth-sample classifier
architecture shared with the four ground-classifier renderers. The
implementation reuses the existing model pipeline layout (4 bind groups,
including the effects bind group that already binds globe depth at
`@group(3) @binding(15)`) — no new bind group layout, no new pipeline
layout, no separate `WebGPUClassificationModelRenderer.js`. The original
~300 LOC estimate assumed a parallel renderer; the realized solution is
~80 LOC across four files because the bind group reuse collapses most
of the scaffolding work.

**What landed:**

- New `fragmentClassificationMain` entry point in
  `Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl`. Reuses the
  existing `vertexMain` (animated models classify correctly because
  skinning / morph / instancing transforms are already applied). The
  FS samples `globeDepthTex` (group 3 binding 15), discards where
  surface depth is 0 (sky), and emits `material.baseColorFactor` —
  or `material.diffuseFactor_rgba` for KHR_materials_pbrSpecularGlossiness
  models. Viewport size is recovered from `textureDimensions(globeDepthTex)`
  rather than a UBO field, since globe depth is sized to the drawing
  buffer (same space as fragment coordinates).
- New `getClassificationPipeline(alphaMode, doubleSided)` on
  `WebGPUModelPipelineCache` plus a private `createClassificationPipeline`
  helper. The pipeline reuses the model PBR layout and shader module;
  only the fragment entry point + standard src-alpha blend differ.
  Cache wipe on HDR / scene-format change wired via
  `maybeUpdateForSceneFormat`.
- Dispatch wiring in `WebGPUModelRenderer.js`: when
  `defined(model.classificationType)`, the per-primitive command
  emission swaps to the classification pipeline, routes the command
  to `Pass.TERRAIN_CLASSIFICATION` (3) for `ClassificationType.TERRAIN`
  or `Pass.CESIUM_3D_TILE_CLASSIFICATION` (6) for `CESIUM_3D_TILE` /
  `BOTH`, and skips the pick / velocity / tile-batch dual / translucent
  depth-write / edge variants (none of which apply to a classifier).
- Replaced the `WebGPUModel.classificationType` one-time warning with
  a Batch 142 resolution comment.

**Architectural notes (verified during scope):**

- RTE precision: the classification pipeline reuses the existing
  `vertexMain`, which already handles the model's RTE encoding. No
  RTE math change needed.
- Same-cycle globe depth: globe depth is published to
  `context._globeDepthView` by the frustum loop BEFORE classification
  passes run (publication site
  `WebGPUSceneRendererFrustumLoop.ts:251`). Model classifier commands
  dispatched at TERRAIN/3D-Tile pass slots see this-frame's globe depth.
- BOTH classification compromise: `ClassificationType.BOTH` routes into
  `CESIUM_3D_TILE_CLASSIFICATION` only (mirrors
  `WebGPUGroundPrimitiveRenderer`'s same compromise — a full BOTH split
  would emit two commands per primitive). Terrain-only emission for
  BOTH classifiers is tracked as a follow-up if scenes need it.
- Animation gate: `Model.js:3095-3098` already disables animations on
  classification models, so the morph / skinning paths run at zero
  weight; the classifier's skinning-aware VS dispatches correctly
  even though the animated state is frozen.

**Closing batch:** Batch 142.

---

### ~~NEW-INVERT-CLASS-STENCIL-CLASSIFIER~~ — RESOLVED (Batch 141)

**Resolution:** All four depth-sample classifier renderers now emit a
dedicated IGNORE_SHOW stencil-write command alongside the color command
when classifying 3D Tiles. The stencil-gated composite branch in
`WebGPUInvertClassification` (which already existed but was unreachable
because no command ever wrote stencil) now activates whenever the
IGNORE_SHOW pass dispatches with > 0 commands, so classified regions
stop receiving the invert tint and only unclassified pixels are
modulated by `highlightColor` — matching WebGL behavior.

**What landed:**

- `WebGPUGroundPrimitiveRenderer.js`, `WebGPUGroundPolylineRenderer.js`,
  `WebGPUVector3DTilePrimitiveRenderer.js`, and
  `WebGPUVector3DTileClampedPolylinesRenderer.js` each gained:
  - A new `stencilFS` / `dsStencilFS` WGSL entry that mirrors the color
    FS (sky-discard + plane-test where applicable) but does NOT discard
    on per-feature `show` — that's the whole point of the IGNORE_SHOW
    pass: mark the volume regardless of `feature.show`.
  - A new pipeline descriptor (`stencilDescriptor` /
    `depthSampleStencilDescriptor`) with the existing color target
    format but `writeMask: 0` to disable color writes; depth-stencil
    state adds `compare: always`, `passOp: replace`,
    `stencilReadMask: 0xff`, `stencilWriteMask: 0xff` on both
    `stencilFront` and `stencilBack`.
  - A new pipeline cache slot routed through the central
    `WebGPURenderPipelineCache` alongside the existing color/pick
    pipelines.
  - An `ignoreShowCommand(s)` field on the renderer's return shape, only
    populated when `groundPass === 6` (3D-Tile classification). The
    `renderState.stencilTest.reference = 0xff` is forwarded through
    `applyPerEncoderState` so `passEncoder.setStencilReference(0xff)`
    fires before each stencil-write draw.
- The four dispatch sites
  (`Scene/GroundPrimitive.js:879`, `Scene/GroundPolylinePrimitive.js:836`,
  `Scene/Vector3DTilePrimitive.js:334`,
  `Scene/Vector3DTileClampedPolylines.js:210`) push the
  `ignoreShowCommand(s)` onto `commandList` only when
  `frameState.invertClassification` is true.
- The pre-existing dispatcher in
  `WebGPUSceneRenderer3DTilePasses.ts:316-355` already routed
  `Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW` into the invert FBO
  and flipped `invertHasStencilData = true` once `ignoreShowCount > 0`.
  With Batch 141's commands present, that count is now non-zero and
  `_invertClassStencilReady` flips on, activating the stencil-gated
  composite path (Batch 40 had already wired the composite pipelines
  but they were unreachable).
- Removed the obsolete one-time warning from
  `WebGPUSceneRenderer._runInvertClassificationComposite` and dropped
  the now-unused `oneTimeWarning` import.

**Same-cycle depth + RTE compatibility (verified during scope):**

- The stencil-write VS reuses the existing color VS, which already does
  RTE-emulated 64-bit precision. No change to RTE math.
- Globe depth (`context._globeDepthView`) is published BEFORE the
  IGNORE_SHOW pass runs (publication site
  `WebGPUSceneRendererFrustumLoop.ts:251` runs after the globe pass; the
  `onAfterTileMainPass` hook re-publishes after the tile main pass at
  `WebGPUSceneRenderer3DTilePasses.ts:288`, before IGNORE_SHOW
  dispatches at line 320). The stencil-write FS samples that
  same-cycle globe depth, identical to the color FS.
- Pick commands run in the regular CLASSIFICATION pass against the scene
  FB, completely independent of IGNORE_SHOW. The IGNORE_SHOW pass writes
  only stencil bits to the invert FBO's depth-stencil texture; it never
  touches pick FBO, scene color, or globe depth. Same-cycle pick is
  unaffected.

**Closing batch:** Batch 141.

---

### ~~NEW-KHR-ANISO-TANGENT~~ — RESOLVED (commit `487ef6478a`)

`ModelPBRComplete.wgsl:1815-1845` now uses `input.tangentEC` (with a `tanLenSq > 1.0e-6` guard against zero-length tangent on primitives without an authored TANGENT attribute) instead of the view-relative `cross(N, V)` approximation. `aniDir = aniT * cos(aniRotation) + aniB * sin(aniRotation)` where `aniT/aniB` are the normalized tangent and bitangent; the GGX D-term roughness is then stretched along that direction. View-relative basis kept as a fallback for non-tangent-authored materials. Brushed-metal materials with authored anisotropic UVs now streak along the per-fragment tangent direction matching the glTF spec.

---

### NEW-KHR-IRIDESCENCE-LUT

**What:** KHR_materials_iridescence currently uses a hue-shift
approximation (`0.5 + 0.5 * cos(phase * 2π + offset)` per RGB
component) rather than a precomputed wavelength-LUT. The Khronos
reference impl samples a 64×1 LUT keyed on
`(NdotV, thickness, IOR)` for spectrally-correct Fresnel modulation.

**Why deferred:** Bulkier than the other slices because it ships the
LUT as a resource — needs a one-time texture upload at module init
plus an extra sampler binding.

**Trace:** `ModelPBRComplete.wgsl` line 1424 ("Full thin-film
interference requires per-wavelength optical-path-difference math
that's prohibitive without a precomputed LUT").

---

### NEW-DYNAMIC-ENVMAP-FULL-SCENE — true scene render-to-cubemap (terrain + 3D Tiles in reflections)

**Status (Batch 131 + Batch 134):** Procedural-sky path with proper
Rayleigh + Mie atmospheric scattering SHIPPED. The manager runs an
inline Bruneton-Neyret-style scattering compute into the cubemap
(driven by `uniformState.sunDirectionWC` + per-manager `skyColor` /
`groundColor` overrides) and feeds the result into `generateIBLMaps`
to produce prefiltered irradiance + radiance views. Sun-driven sky
colors at any time of day, sun-position-tracked refresh
(`SUN_REFRESH_EPSILON_SQ` debounce), and prefilter cleanup (existing
C-P17 path) all wired. Models with no explicit
`imageBasedLighting.specularEnvironmentMaps` fall back to the
manager's prefiltered views via `buildModelIBLEntries` in
`WebGPUModelRenderer`.

**What remains:** True scene-capture path. The procedural sky now
correctly captures atmosphere + sun, but doesn't include OTHER scene
content (terrain elevation, 3D Tiles buildings, glTF model geometry).
Useful when reflections must show the scene's actual surroundings.

**Why deferred:** Real ~250 LOC feature requiring:

**Why deferred:** Real ~250 LOC feature requiring:

1. Atmosphere/sky renderer (`WebGPUSkyAtmosphereRenderer`,
   `WebGPUSpaceRenderer`, `WebGPUSunRenderer`) accepting arbitrary
   view matrices instead of the main camera (~80 LOC -- view-matrix
   plumbing + render-target plumbing for cubemap faces).
2. Cubemap face render pass setup with per-face view matrix and
   color attachment as a single 2D-array slice (~40 LOC).
3. Trigger logic: fire only when camera position changes by >N km,
   or sun direction changes by >M degrees, or every K frames as a
   fallback. Currently the manager has `framesSinceUpdate` but no
   trigger threshold (~30 LOC).
4. IBL prefilter invocation post-capture: call `generateIBLMaps()`
   on the captured cubemap and republish the irradiance + radiance
   views to the model material BG (~30 LOC).
5. Mipmap generation for the captured cubemap before prefilter
   (~30 LOC -- standard 6-face downscale compute pass).
6. JS-side wiring through `DynamicEnvironmentMapManager.update`
   to the WebGPU FR (~40 LOC).

The audit's 150-LOC budget covers items 4-6; items 1-3 are the real
work and are touchscreen for the atmosphere/sky stack.

**Trace:** AUDIT_2026_05_02.md §A.12;
`WebGPUDynamicEnvironmentMapManager.ts:133-154` (the placeholder fill).

---

### ~~NEW-TAA-MORPH-PREV~~ — RESOLVED (Batch 134)

**Resolution:** Prev-frame morph weights now tracked via
`primCache._morphWeightBufferPrev` (uniform mirror of the current
weights buffer, same swap-and-upload pattern as
`prevPackedJointMatrices`). Bound to `@group(2) @binding(5)` as
`previousMorphWeights`. The vertex shader's prev-frame branch reads
from this when computing `prevPositionMC`, so facial blendshapes /
lip-sync produce correct per-vertex velocity.

---

### ~~ORIGINAL-NEW-TAA-MORPH-PREV~~ (kept for archaeology)

**What:** Audit A.5 (Batch 130) wired prev-frame joint matrices into
the velocity pass via `previousJointMatrices` at `@group(2)
@binding(4)`. Prev-frame morph weights are NOT yet tracked — the
shader re-runs the morph pass with CURRENT weights when computing
`prevPositionMC`, so models with frame-to-frame morph deltas (e.g.,
facial blendshapes) still produce slightly off velocity at the
morphed-only deltas.

**Why deferred:** Morph weights live in the per-frame `morphWeights`
UBO. Capturing prev requires either (a) a parallel `prevMorphWeights`
UBO at @group(2) @binding(5) + JS-side capture (mirrors the joint
pattern), or (b) accepting the small velocity error since morph
deltas are typically < 5% of total per-frame motion. Estimated ~30 LOC
across `WebGPUModelRenderer.js` (capture loop), `WebGPUModelMorphTargets.js`
(prev UBO write), `WebGPUModelPipelineCache.js` (BGL binding 5), and
`ModelPBRComplete.wgsl` (use prevMorphWeights in the prev branch).

**Trace:** `ModelPBRComplete.wgsl` vertexMain prev-frame block,
"Morph weights and instance transforms still use current-frame data."

---

### ~~NEW-TAA-INSTANCE-PREV~~ — RESOLVED (Batch 134)

**Resolution:** Bound `previousInstanceTransforms` at `@group(2)
@binding(6)` as a separate storage slot. For static GPU instancing
(today's only case) it aliases the current `instancingBuffer` so
`prevPositionMC == positionMC` from the instance step (zero velocity
contribution). When animated EXT_mesh_gpu_instancing assets land,
the renderer can publish a separate `nodeCache.prevInstancingBuffer`
and the shader will pick it up automatically.

---

### ~~ORIGINAL-NEW-TAA-INSTANCE-PREV~~ (kept for archaeology)

**What:** Same shape as NEW-TAA-MORPH-PREV but for
`instanceTransforms` (binding 3). Animated GPU instancing — e.g., a
particle system using EXT_mesh_gpu_instancing with per-frame transform
updates — produces wrong velocity because the prev-frame skin pass
uses the CURRENT instance transform.

**Why deferred:** GPU instancing is rare for animated content (most
EXT_mesh_gpu_instancing assets ship static instances — trees,
furniture, props). The fix is the same shape as the joint-matrix
prev-frame buffer: ~40 LOC for a `prevInstanceTransforms` storage
buffer at @group(2) @binding(6) + JS swap-and-upload pattern in
`WebGPUModelInstancing.js`.

**Trace:** `ModelPBRComplete.wgsl` vertexMain prev-frame block,
"Morph weights and instance transforms still use current-frame data."

---

### ~~NEW-KHR-LIGHTS-PUNCTUAL-GLTF-LOADER~~ — RESOLVED (Batch 134)

**Resolution:** glTF asset auto-import shipped. `GltfLoader.parse()`
reads `gltf.extensions.KHR_lights_punctual.lights[]` (scene-level
array of light defs). `loadNode()` records the per-node
`extensions.KHR_lights_punctual.light` index on `node.lightIndex`.
After `loadNodes()` returns, `materializeKhrLightsPunctual()` walks
the node tree composing world matrices, then resolves each per-node
light reference's MODEL-space position + direction (lights live at
node origin pointing -Z per glTF spec). The flat array lands on
`components.lights`, exposed as `model.lightsFromGltf`.
`WebGPUModelRenderer.packPunctualLights()` merges these with
`scene.lights` (scene-level wins on overflow), transforming each
glTF light's position/direction by `model.modelMatrix` to lift to
world coords before packing into the per-model UBO.

**Spot-light direction (RESOLVED in Batch 134, CONCERN #6):**
`LightCollection.pack()` and the WGSL `PunctualLight` struct now
carry a `spotDirection: vec3<f32>` at slot 16-18 (per-light record
bumped from 16 to 20 floats). The shader's cone narrowing uses the
authored direction, not the meaningless `normalize(position)` from
the pre-Batch-134 placeholder.

---

### ~~ORIGINAL-NEW-KHR-LIGHTS-PUNCTUAL-GLTF-LOADER~~ (kept for archaeology)

**Status (Batch 131):** Scene-level light pipeline LANDED. Audit B.3
shipped the WGSL struct + UBO packing + per-light Cook-Torrance
accumulation. Users can now do:

```js
scene.lights.add(new PointLight({ position, color, intensity, range }));
scene.lights.add(new DirectionalLight({ direction, color, intensity }));
scene.lights.add(new SpotLight({ position, direction, innerConeAngle, ... }));
```

and any PBR material rendered through `WebGPUModelRenderer` accumulates
the light's contribution. Cap is 8 (matches `LightCollection.MAX_LIGHTS`).

**What remains:** glTF asset auto-import. When a glTF carries
`extensions.KHR_lights_punctual` at the document level + per-node
`extensions.KHR_lights_punctual.light` references, the loader should
materialize those lights into the model's `LightCollection`
automatically. Today users have to manually inspect the glTF JSON and
recreate the lights themselves.

**Scope (~120 LOC):**

1. `GltfLoader` extension reader for `gltf.extensions.KHR_lights_punctual.lights[]` (type, color, intensity, range, spot cone angles).
2. Per-node walk to find `node.extensions.KHR_lights_punctual.light` + compose world transform from parent chain.
3. Materialize as `PointLight` / `DirectionalLight` / `SpotLight` instances and merge into the model's owned `LightCollection`.
4. (Optional) Surface as `model.lights` getter so users can inspect / mutate per-asset.

**Spot-light direction (~30 LOC):** Current shader treats spots as
"point with cone in the direction of fragment-to-light" -- correct only
for spots aimed at the fragment. Real fix: extend the JS pack to write
the spot's direction into a separate slot (currently overlapping
posOrDir for directional vs position for spot) so the shader can
gate the cone against the authored direction. Filed as
`NEW-SPOTLIGHT-DIR` inline in the shader comment.

**Trace:** AUDIT_2026_05_02.md §B.3; Batch 131 commit (scene-level
wiring); `ModelPBRComplete.wgsl` punctual loop block.

---

### NEW-KHR-TRANSMISSION-THICKNESS

**What:** KHR_materials_transmission currently uses a fixed UV-offset
step (0.05) when sampling the refraction scene texture. The spec
couples the offset to KHR_materials_volume's thickness so
glass-thickness varies correctly with the underlying asset's
geometry. Today both extensions activate independently.

**Why deferred:** Slice 7 (volume) and Batch 105 (transmission) shipped
in different iterations without sharing the thickness sample. Full fix
is local to the transmission branch in `ModelPBRComplete.wgsl`.

**Trace:** `ModelPBRComplete.wgsl` line 1620 ("Without a thickness
sample we use a fixed step...").

---

## C-R7 - Central pipeline cache adoption tail

**Parent finding:** Pipeline cache (`WebGPURenderPipelineCache`) instantiated + key-correct + device-loss-invalidated in Batches 33-34, audited Batch 52. First-cut consumer migration Batch 56, second cut Batch 62.

### ~~C-R7-RENDERER-MIGRATION-REMAINING~~ DONE 2026-04-29 (audit)

**Resolution:** Audit (2026-04-29, this session) found `WebGPUGlobeSurfaceRenderer` has been routing through the central `webgpuPipelineCache` since **Batch 75** (`_resolveGlobePipelineEntry` calls `pipelineCache.getPipelineSync` / `getPipeline`; the local `_pipelineCache: Map<string, GlobePipelineEntry>` now holds DESCRIPTORS, not pipelines, with the actual `GPURenderPipeline` resolved through the central cache and a sync-fallback `device.createRenderPipeline()` only when no central cache is wired). The `WebGPUShaderModuleCache` is also already adopted (Batch 20).

That leaves only:

- **`WebGPUModelRenderer`** — special-case, blocked on the KHR-extension shader-family work (C-R4-GLTF-KHR). Its pipeline cache adoption pairs with the shader-module dedup work because two models with identical material settings need to share modules to share pipelines.
- **`WebGPUAutoExposure`** — compute pipeline, out of scope until a `WebGPUComputePipelineCache` exists.

Both are tracked under their own work items below; this entry is closed.

**Adopter count:** 15 renderers route through `webgpuPipelineCache` (Polyline, PointPrimitive, GroundPrimitive, GaussianSplat, EllipsoidPrimitive, BufferPrimitive, DepthPlane, Cloud, Voxel, Label, Billboard, Environment Sun, Environment Moon, PointCloud, **GlobeSurface**) + Weather render + VolumetricFog composite.

**Closing batch:** Audit reframe (2026-04-29) confirmed Batch 75 already shipped this for GlobeSurface; the prior wording of this entry was stale.

**Trace:** Verified by grep of `WebGPUGlobeSurfaceRenderer.ts` for `device.createRenderPipeline` (one match — the synchronous-fallback path inside `_resolveGlobePipelineEntry`, used only when the central cache isn't available).

### C-R7-SHADER-MODULE-DEDUP

**What:** Cross-renderer `GPUShaderModule` sharing. Wiring `WebGPUShaderModuleCache` into all renderers lets identical sources actually dedupe.

**Progress:**

- Batch 72 (2026-04-27) added Cloud + Voxel + Weather (render + compute shaders).
- Batch 74 (2026-04-27) added Environment (Sun + Moon), VolumetricFog (compute + composite), PointCloud (default + LOD).
- **Batch 162 (2026-05-02) — Model PBR adoption.** `WebGPUModelPipelineCache._shaderModule` now resolves through a per-device `WebGPUShaderModuleCache` (`MODEL_PBR_COMPLETE` source ID 23). One `WebGPUModelPipelineCache` is created per `Model` instance, so a 100-glTF tileset previously compiled the same WGSL 100 times — now shares one `GPUShaderModule` across all instances on a device. Pipelines themselves stay per-cache (per-Model formats / alphaMode / doubleSided).
- **Batch 163 (2026-05-02) — Vector 3D Tile family adoption.** All three Vector 3D Tile renderers route through per-device caches with new source IDs 24/25/26 (`VECTOR_3DTILE_PRIMITIVE`, `VECTOR_3DTILE_POLYLINES`, `VECTOR_3DTILE_CLAMPED_POLYLINES`). WGSL is built per-`buildResources` call but is constant per build, so dense vector overlays with N visible tiles now share one module instead of compiling N times.
- **Batch 164 (2026-05-02) — BufferPrimitive family adoption.** BufferPoint/Polyline/Polygon renderers route through a single shared per-device cache (helper exported from `WebGPUBufferPrimitiveRenderer.ts` since the 3 renderers share the parent module). New source IDs 27/28/29 (`BUFFER_POINT_MATERIAL`, `BUFFER_POLYLINE_MATERIAL`, `BUFFER_POLYGON_MATERIAL`). Each `BufferPrimitiveCollection` previously compiled its own module; now one module per `(device, materialKind)` regardless of collection count.

Existing adopters from earlier batches: Polyline, PointPrimitive, Billboard, Label, GlobeSurface.

**Remaining renderers (still bypass the cache, audited 2026-05-02):**

| Renderer | File | Estimated impact |
| --- | --- | --- |
| Ground Primitive + Ground Polyline | `WebGPUGround*.js` | Typically few-per-scene. Low dedup win. |
| SkyAtmosphere | `WebGPUSkyAtmosphereRenderer.js` | Singleton per scene. Negligible win. |
| Ellipsoid Primitive | `WebGPUEllipsoidPrimitiveRenderer.ts` | Few-per-scene. Low win. |

**Prerequisites:** None - `WebGPUShaderModuleCache.ts` exists since Batch 22.

**Estimated remaining effort:** All high-dedup-win renderers covered as of Batch 164. The 3 low-win remainders can ride along when next touched for other reasons (per "incremental upgrade" rule in CLAUDE.md). Mark this entry CLOSED if/when the low-win three are mopped up; the dedup architecture itself is fully wired.

**Impact:** Memory pressure on shader-heavy scenes — Model (Batch 162), Vector 3D Tiles (Batch 163), and BufferPrimitive (Batch 164) cover the highest instance-count cases.

**Trace:** REVIEW_FIX_PROGRESS.md:2399 (Batch 52 audit), Batches 72/74/162/163/164 lists; OVERSIGHT_AUDIT_2026_04_25.md s3.

---

## C-R8 - Translucent classification follow-ups

**Parent finding:** Six C-R8 sub-items shipped Batches 35-51 (globeDepth, VOXELS-before-OPAQUE, 2D frustum jitter, InvertClassification, Edge FBO+inline, Translucent tile classification first-cut). Three named follow-ups remain on translucent classification leg; MSAA gate closed Batch 61.

### C-R8-TRANSLUCENT-DEPTH-ONLY

**Status: Resolved (different mechanism) — Batches 78–79.**

**What (original framing):** Translucent depth capture was over-broad — `executePackDepth` copies ALL translucent geometry's depth, not just `depthForTranslucentClassification`-flagged 3D-tile content. WebGL's selective behaviour derives a `_depthOnlyCommand` per flagged command per `Cesium3DTile.js:1084`.

**Architectural reframe (audit, 2026-04-28):** WebGPU does NOT consume the packed-depth texture the way the original framing assumed. The active classification renderer (`WebGPUGroundPrimitiveRenderer`) is a stencil-based two-pass approach with no depth-texture sampling — neither `_packedDepthTexture` nor `_globeDepthTexture` is bound to any classification pipeline. Filtering the pack-depth contributors only matters once a depth-sampling classifier exists (tracked separately as **C-R8-CLASSIFICATION-DEPTH-SAMPLING** below).

What the user-visible bug actually is: when a translucent 3D tile overlaps a classification volume, the scene-FB depth at translucent pixels is whatever's behind the tile (globe), so the volume draws on the globe under the tile rather than on the tile surface.

**Batch 78 (gating):**

- `WebGPUDrawCommand` now carries the `depthForTranslucentClassification` flag (Cesium3DTile.js:1084 lands on the WebGPU command instance; previously the assignment hit the field as `undefined` since it didn't exist on the class).
- `WebGPUTranslucentTileClassification.executeTranslucentDepthPass` accepts a `flaggedCommandsPresent` argument and short-circuits the entire pack-depth pipeline (no copy, no MSAA source recording, no pack pass) when no commands in the frustum need translucent classification depth.
- `WebGPUSceneRenderer` scans the frustum's TRANSLUCENT command list before invoking the translucent-depth path.

**Batch 79 (the actual fix — selective depth-write):**

- `WebGPUModelPipelineCache.getDepthWritePipeline(alphaMode, doubleSided)` builds a sibling pipeline of `getPipeline` with `depthWriteEnabled = true` forced on for ALPHA_BLEND. Layout, vertex, fragment, and blend state are identical to the standard variant; only the depth-write bit differs. Cached separately so the standard translucent path (no depth write, alpha-correct compositing) is unchanged for non-tile content.
- `WebGPUModelRenderer` eagerly builds the depth-write variant for every BLEND primitive and stashes it on the `WebGPUDrawCommand` as `classificationDepthPipeline`.
- `WebGPUDrawCommand.execute()` swaps to that variant when `depthForTranslucentClassification === true`. The bind groups, vertex buffers, and draw call are unchanged.

Net effect: translucent 3D tile surfaces populate the scene-FB depth attachment, so the existing stencil-based GroundPrimitive classifier clips its volumes against the tile surface instead of the globe behind it — matching WebGL's user-visible behaviour without porting WebGL's depth-texture sampling architecture.

**Side effect (intended):** translucent labels behind translucent 3D tiles will now be occluded (more physically correct than WebGL's "label sees through everything"). Acceptable.

**Coverage gaps (intentional, deferred to Path A continuation):**

- PointCloud / batched primitive content does not yet have a depth-write variant — only Model (b3dm/i3dm/glb) primitives do. PointCloud translucent tiles will still mis-classify until C-R8-CLASSIFICATION-DEPTH-SAMPLING lands the cleaner architecture.
- Multi-frustum accumulation is still single-frustum (see C-R8-TRANSLUCENT-MULTI-FRUSTUM).
- Depth-only WGSL variants per command (mirroring WebGL's `_depthOnlyCommand`) are still not built — but their value disappears with the new architecture.

**Trace:** REVIEW_FIX_PROGRESS.md:2130; Batch 78 + Batch 79 shipped 2026-04-28.

### C-R8-TRANSLUCENT-MULTI-FRUSTUM

**Status: Paused — folded into Migration Session 3 of the depth-sampling architecture pivot (see ADR-2026-04-28 above).**

**What (original):** Multi-frustum accumulation not wired. `executePackDepth` runs once per frame, capturing only last-rendered frustum's depth.

**Why paused:** the architectural pivot replaces the stencil-based classifier with depth-texture sampling. In the new architecture, "multi-frustum" reduces to "swap the bound depth-source view per frustum draw" rather than "redirect a render pass into a scratch FBO and accumulate stencil bits." Building the stencil-based accumulation now would land code that the architecture migration deletes a few sessions later.

The Batch 47 scaffolding (`_classificationColorTexture`, `composite()`, `_runTranslucentTileClassificationComposite`, `_ensureCompositePipeline`, `COMPOSITE_WGSL`) was designed for the stencil-accumulation path. Migration Session 5 is the point where it gets removed, NOT before — the depth-sampling consumer needs `_packedTranslucentDepthView` and `_packedDepthTexture` to remain wired for as long as the stencil classifier still ships in the same build.

**Re-scoped impact:** Multi-frustum correctness folds into Migration Session 3 (per-frustum depth-source bind groups). No standalone work item remains.

**Trace:** REVIEW_FIX_PROGRESS.md:2132. Audit 2026-04-28.

### C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH

**What (original framing):** Classification primitive shaders sample `globeDepthTexture`; need option to sample `packedTranslucentDepthView` (Batch 47 pack pipeline) when translucent depth available — that's how WebGL gets translucent-on-translucent classification right.

**Audit reframe (2026-04-28):** WebGPU's only classification primitive renderer (`WebGPUGroundPrimitiveRenderer`) is a stencil-based two-pass approach with NO depth-texture sampling. The original "swap depth source" framing assumed a port of WebGL's `ShadowVolumeAppearanceFS` / `PolylineShadowVolumeFS` depth-sampling architecture. We did not port that.

The framing splits into two distinct items:

1. **C-R8-CLASSIFICATION-DEPTH-SAMPLING** (architectural, future) — replaces the stencil approach with a depth-sampling approach so the renderer can read `_packedDepthTexture` for translucent-on-translucent. Tracked as a separate item below.
2. **DISPATCH proper** — the original WebGL framing isn't directly portable. Closing this item now in favour of the depth-sampling architecture follow-up.

**Why deferred / superseded:** Folded into C-R8-CLASSIFICATION-DEPTH-SAMPLING.

**Status: Superseded — closed by audit; replaced by C-R8-CLASSIFICATION-DEPTH-SAMPLING.**

**Trace:** REVIEW_FIX_PROGRESS.md:2133. Audit 2026-04-28.

### ~~C-R8-CLASSIFICATION-DEPTH-SAMPLING~~ — RESOLVED (Migration Sessions 1-5, Batches 80-85)

**Resolution (verified 2026-04-30 by Batch 117 / 118 audit):** The depth-sampling architectural rewrite shipped across Migration Sessions 1-5:

- **Session 1 (Batch 80):** depth-sample classifier infrastructure — `dsColorFS` / `dsPickFS` entry points sample globe-depth and discard where the surface wrote no depth.
- **Session 2 (Batch 82):** runtime depth-source swap (globe-depth ↔ packed-translucent-depth) via `_packedTranslucentDepthView` plumbed through `WebGPUDrawCommand.bindGroupResolvers`.
- **Session 3 (Batch 83):** per-frustum depth-source bind groups.
- **Session 4 (Batch 84):** `WebGPUGroundPolylineRenderer` skeleton.
- **Session 4b (Batches 86, 88, 97, 116, 117):** full WGSL port of `PolylineShadowVolumeVS/FS` + materials + per-instance color decoding + depth-test + viewport-source fixes.
- **Session 5 (Batch 85):** retire the legacy stencil classifier path. Depth-sampling is now the only classification path.

**Selective depth-write side (Batch 79):** Models force depth-write ON for BLEND-mode primitives via `WebGPUModelPipelineCache.depthWritePipeline` + `WebGPUDrawCommand.classificationDepthPipeline` + `Cesium3DTile.js:1084` flag plumbing.

**Verified content-type coverage:**

- **Model (b3dm/i3dm/glb):** Selective depth-write variant shipped Batch 79.
- **PointCloud:** Already writes depth unconditionally (`WebGPUPointCloudRenderer.ts:386` `depthWriteEnabled: true`). No variant needed.
- **Vector3DTile* family:** These ARE classifiers (depth-sample consumers), not classified-against content.
- **Gaussian Splat:** Pipelines have `depthWriteEnabled: false` for translucent rendering — when a translucent splat tile is the source content for ground classification, the depth buffer is empty at those pixels. Tracked as a separate small item below: **NEW-GS-CLASSIFICATION-DEPTH** (~1 session, follow-up to Batch 79's Model pattern).

**Trace:** Replaces C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH per audit 2026-04-28; full closure documented 2026-04-30.

### NEW-GS-CLASSIFICATION-DEPTH

**What:** Gaussian Splat 3D-tile content (`.spz`/`.splat`) currently has `depthWriteEnabled: false` on its translucent pipelines. When a ground primitive classifies against a region containing a translucent splat tile, the classifier samples globe-depth instead of splat-tile depth — classification "leaks through" the splat to whatever lies behind it on the globe surface.

**Why deferred:** Edge case. Most production 3D Tiles content is Models / PointClouds; splat-as-classification-source is rare.

**Prerequisites:** None. Mirrors the Batch 79 Model fix — sibling pipeline with `depthWriteEnabled: true`, swap via `WebGPUDrawCommand.classificationDepthPipeline` when the per-tile `depthForTranslucentClassification` flag is set.

**Estimated effort:** 1 session.

**Impact:** Without it: translucent splat tiles mis-classify when used as classification sources. With it: full content-type coverage for translucent-tile classification.

### ~~C-R8-CLASSIFICATION-PRIMITIVE-GEOM-PLUMBING~~ FIXED 2026-04-28 (Batch 81)

**Resolution:** Two distinct gaps that compounded into a single visible failure:

1. **Renderer was reading the wrong nesting level.** `_webgpuGeometryData` IS populated by `Scene/PrimitiveGeometryHelpers.js:788` on the innermost Cesium `Primitive`, but the wrapping chain for a `GroundPrimitive` is `_GroundPrimitive` → `._primitive` (`ClassificationPrimitive`) → `._primitive` (`Primitive`) → `._webgpuGeometryData`. The renderer was reading the slot off the `_GroundPrimitive` argument directly, where it never lives. **Fix:** walk-the-chain lookup at `WebGPUGroundPrimitiveRenderer.js` — try `primitive._webgpuGeometryData ?? primitive._primitive?._webgpuGeometryData ?? primitive._primitive?._primitive?._webgpuGeometryData`. Direct `Primitive` and `ClassificationPrimitive` callers work through the same lookup with shorter chains.

2. **`createVertexBuffer` was called with the wrong arguments.** The legacy renderer's call site was `WebGPUBuffer.createVertexBuffer(device, vbData.byteLength, false, label)` — but the API is `(device, data, label)`. Passing `byteLength` (a number) as `data` made the inner `data.byteLength` lookup return `undefined`, which the `createBuffer` validation rejected as "Value is not of type 'unsigned long long'". **Fix:** pass the typed array directly; drop the redundant `device.queue.writeBuffer` call (the helper writes data internally).

**Producer side was already correct.** `ClassificationPrimitive.js:417` constructs an internal `Primitive`, and that internal Primitive's `update` → `createVertexArray` flow runs the existing `PrimitiveGeometryHelpers.js:788` populator. No new populator was needed; the chain just needed to be walked on the renderer side.

**Validation:** A programmatically added `RectangleGeometry`-backed `GroundPrimitive` now reaches the renderer with `cache.vertexCount = 384, cache.indexCount = 1716, cache.indexFormat = "uint16"` populated, the depth-sample bind group constructed, and zero console errors during dispatch. Visual output verification is gated on a separate WebGPU canvas-rendering issue (the canvas appears black even on the default CesiumViewer page without any classification primitives — surfaced 2026-04-28, separate investigation).

**Files touched:** `packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js`. Minor: marked the legacy stencil pipelines now compile and dispatch correctly too — both classifier paths are runtime-functional after Batch 81 modulo the canvas-rendering investigation.

**Closing batch:** Batch 81.

### C-R8-GROUND-POLYLINE-NATIVE — PARTIAL (two unrelated defects fixed; VS extrusion remains)

**Status as of 2026-04-30 (Batch 116):** `WebGPUGroundPolylineRenderer` ships with full color + pick pipelines, depth-sample bind groups, batch-table snapshot, vertex/index buffer upload, and morph-mode pipeline pair. The Scene-side `GroundPolylinePrimitive.update()` delegates to the FR. Two real bugs were found and fixed in Batch 116; one bug remains.

**Fixed in Batch 116:**

- **Pipeline `depthCompare: "less-equal"` → `"always"`** (color, pick, morph color, morph pick). The WebGL `getRenderState` only sets `depthMask: false` and never enables depth test; the WebGPU pipeline was incorrectly culling fragments where the volume's geometric depth lay behind the depth buffer. The classifier samples globe depth in the FS and reconstructs the surface position itself — the volume must rasterize everywhere it covers screen-space.
- **Per-instance color decoding** in `ensureBatchTableSnapshot`. `BatchTable.getBatchedAttribute(i, colorIndex)` returns a `Cartesian4` (`{x, y, z, w}`) for 4-component attributes, not a normalized `Color`. For UNSIGNED_BYTE color attributes (the common case via `ColorGeometryInstanceAttribute.fromColor`), values come back in [0, 255] range and need scaling by `1/255`. The previous code only handled the `{red, green, blue, alpha}` shape and fell through to the white default — every polyline's per-instance color uploaded as `(1, 1, 1, 1)` instead of the user-specified value.

**Remaining bug:** Width extrusion in vsMain pushes vertices off-screen. Bisection confirmed:

1. Replacing `out.pos` with a fullscreen-NDC fan: visible (pipeline sound).
2. Bypassing the entire extrusion (`out.pos = u.proj * (u.mvRTE * positionRTE)`): visible thin polyline outline (RTE + projection sound).
3. Adding a constant width offset (`positionEC + 2240.0 * normalEC`): visible wide red band (normalEC direction sound).
4. Restoring the formula `widthMeters = widthPixels * metersPerPixel(positionEC) / dot(normalEC0, rightPlaneNormalEC)`: not visible.

The per-vertex `widthMeters` produces extreme magnitudes — most likely because `dot(normalEC0, rightPlaneNormalEC)` approaches zero at miter joints, blowing `widthMeters / dot` past the far plane on a subset of vertices and degenerating the triangle fan. The WebGL VS uses the identical formula and works, so something subtle in the WebGPU port is producing a different runtime value (candidate causes: vertex attribute swizzle/encoding mismatch, `czm_normal` matrix layout, `metersPerPixel` returning a different sign/magnitude under WebGPU's [0, 1] NDC z).

**Why still deferred:** Multi-hour focused bisection — not blocking anything outside `GroundPolylinePrimitive`. Apps that need ground polylines on WebGPU today still get blank output (no crash, no validation warnings), but with the depth-test + color fixes in place the renderer should be correct end-to-end once the VS bug is found.

**Prerequisites:** None — bug fix is local to `WebGPUGroundPolylineRenderer.js`'s vsMain.

**Estimated effort:** 1 session, focused VS bisection. Capture vsMain output for a known-good WebGL frame (pull `gl_Position` from a debug RenderDoc capture or instrument the WebGL VS), diff per-vertex against the WebGPU VS to find the divergence.

**Impact:** Polylines on terrain are not visible on WebGPU even though the renderer dispatches commands. No crash, no validation warnings.

**Trace:** Audit 2026-04-28; isolated 2026-04-30 in Batch 111; partially fixed (depth-test + color) 2026-04-30 in Batch 116. `Tools/visual-regression/verify-ground-polyline-zoom.mjs` reproduces.

### C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES — RESOLVED (Batch 114)

**Status:** Shipped in Batch 114 — `WebGPUVector3DTileClampedPolylinesRenderer.js` ports the WebGL VS + FS into a single 7-attribute interleaved WGSL pipeline, with the depth-sample classifier replacing the WebGL stencil-based classifier. `Vector3DTileClampedPolylines.update()` delegates to `FeatureRendererKey.VECTOR_3DTILE_CLAMPED_POLYLINE` on WebGPU; `finishVertexArray` retains the worker-decoded shadow-volume arrays for the FR to upload.

**What landed:**

- WGSL VS port of `Vector3DTileClampedPolylinesVS.glsl` (per-vertex prism extrusion + miter push + manual depth clamp).
- WGSL FS port of `Vector3DTileClampedPolylinesFS.glsl` (depth-sampled classifier with 5-plane test).
- 7-attribute interleaved vertex layout in a 96-byte stream (`startEllipsoidNormal` + `batchId` packed into the same 16-byte slot).
- Per-batch color via storage buffer indexed by `batchId`.
- Pass routing for TERRAIN / 3D-TILE / BOTH classification types.

**Companion FRs from Batches 112-113:**

- `Vector3DTilePrimitive` (extruded polygon classifier) — `WebGPUVector3DTilePrimitiveRenderer.js`.
- `Vector3DTilePolylines` (NON-clamped 3D polylines) — `WebGPUVector3DTilePolylinesRenderer.js`.

**Remaining follow-ups (small):**

- Per-feature pick. Storage-buffer slot already reserved; one extra `vec4[batchId]` write enables it.
- Distinct depth source per pass (TERRAIN reads globe-depth-only; 3D-TILE reads packed-translucent). Current code picks whichever source is bound, matching the simplification used in `WebGPUVector3DTilePrimitiveRenderer`.
- `DEBUG_SHOW_VOLUME` mode visualization.

**Trace:** Batches 112-114 (full Vector3DTile classification family on WebGPU).

---

## C-R9 - Pick command tail

**Parent finding:** Five WebGPU renderers were missing pick paths. All five shipped at primitive granularity through Batches 30/31/53/54. Three named follow-ups remain.

### ~~NEW-BG-CONSOLIDATION~~ — RESOLVED Batch 122 (audit 2026-05-02)

**Audit finding (AUDIT_2026_05_02.md D.1):** `WebGPUModelPipelineCache.js:545-553` (current line) declares 4 BGLs (camera, material, instance, effects). `ModelPBRComplete.wgsl` only uses `@group(0..3)`. The 8→4 consolidation shipped in Batch 122. The "ALL Model rendering broken on Edge/Vulkan" warning below was true pre-Batch 122 and has been moot for ~10 batches.

**Status:** Resolved. C-R9-MODEL-FEATURE-PICK is no longer blocked by this — it's blocked by the per-vertex-attribute feature-ID path (see new entry NEW-FEATURE-ID-VERTEX-ATTR below).

**Historical record (preserved for archaeology):**

`WebGPUModelPipelineCache.js:51-156` (pre-Batch 122) declared 8 bind group layouts (camera, material+light, textures, skinning, morphTarget, instancing, featureId, effects → groups 0-7). The WebGPU spec default `maxBindGroups = 4`. On adapters with the default limit (Edge/Vulkan, all backends without an explicit higher tier), pipeline creation fails with `bindGroupLayoutCount (8) is larger than the maximum allowed (4)` — silently, because the failure surfaces async via `popErrorScope` while the synchronous `setPipeline()` call gets an "Invalid RenderPipeline" handle that the validation layer rejects without throwing.

**Discovered (2026-04-30) during the C-R9 investigation chain:**

1. b3dm-Model rendering gap was NOT b3dm-specific — it affected ALL Model rendering on WebGPU.
2. Three real bugs along the chain were fixed and shipped this session (see Batch 120):
   - `Scene/GltfLoader.js`: typed-array retention broadened to all WebGPU contexts (mirrors NEW-4-A pattern).
   - `Scene/Model/ModelPrimitiveGeometry.js:extractPrimitiveGeometry`: fall back to `runtimePrimitive.primitive.attributes` because `runtimePrimitive.renderResources` is never assigned anywhere.
   - `Scene/DerivedCommand.js` + `Scene/OIT.js`: WebGPU short-circuit guards added to `createPickDerivedCommand`, `createPickMetadataDerivedCommand`, `createHdrCommand`, `OIT.createDerivedCommands` (sibling pattern to the existing guards in `createDepthOnlyDerivedCommand` + `createLogDepthCommand`).
3. After all three fixes, `model._webgpuCache.primitives` populates correctly (5 primitives on the CesiumAir test glb), but pipeline creation fails on the bind-group-count limit.

**Why deferred:** Bind-group consolidation requires:

- Restructuring 8 logical groups into ≤4 physical groups in `WebGPUModelPipelineCache.js` (~60 lines of BGL construction + ~20 lines of bind group construction).
- Updating ALL `@group(N) @binding(M)` declarations in `ModelPBRComplete.wgsl` (~200 sites).
- Updating JS bind group factory functions (e.g., `createEffectsBindGroup` in `WebGPUEffectsBindGroup.js`).
- Likely combination scheme:
  - Group 0: camera + effects (read-only frame uniforms)
  - Group 1: material + light + textures (per-material)
  - Group 2: skinning + morphTarget + instancing (per-instance vertex data)
  - Group 3: featureId (per-feature)

**Estimated effort:** 2-3 sessions. Mechanical but extensive.

**Impact:** Without it: ALL b3dm/i3dm/glb Model rendering on WebGPU is broken on adapters with the spec-default `maxBindGroups: 4` (Edge/Vulkan, most current production paths). With it: 3D Tiles vector content renders, Model demos work, C-R9-MODEL-FEATURE-PICK fires (the prerequisite chain it was blocked on).

**Trace:** Discovered 2026-04-30 during the b3dm-Model rendering investigation. `Tools/visual-regression/verify-glb-renders.mjs` is the repro — load CesiumAir.glb → see "bindGroupLayoutCount (8) is larger than the maximum allowed (4)" warning.

### C-R9-MODEL-FEATURE-PICK — CODE WIRED, BLOCKED ON UPSTREAM b3dm RENDERING GAP

**Status (verified 2026-04-30 via `Tools/visual-regression/verify-model-feature-pick.mjs`):** All four code-paths for per-feature pick are wired and look correct:

1. **Shader pickFS routes through `lookupFeaturePickColor`** (`ModelPBRComplete.wgsl:1862–1929`) when `featureId.featurePickEnabled > 0.5` and the batch table is bound.
2. **Per-feature pick texture allocation + upload** in `WebGPUModelFeatureId.js:512–580` (`ensurePerFeaturePickIds`) — eager allocation when batch table is present, one Cesium pickId per feature, target = `{primitive: model, id: featureId}`.
3. **Bind group binds feature-pick texture** at `@group(6) @binding(5)` (`WebGPUModelFeatureId.js:459–462`).
4. **Uniform flag flip** — `featureUniformData[12] = featurePickTex ? 1.0 : 0.0` (`WebGPUModelFeatureId.js:423`).

**Blocking gap (discovered during verification):** The verify script loads `BatchTableHierarchy/tileset.json` (b3dm content with 30-feature batch table, `batchTextureExists: true`, `batchTextureDimensions: [30, 1]` — all the upstream metadata is correct) and confirms:

- `tilesetFeaturesLoaded: 30` — Cesium loads the features.
- `model._webgpuCache.primitives === {}` — **the WebGPU model renderer never builds primitive caches for the b3dm-tileset model.**
- Consequently `ensureFeatureIdResources` is never invoked, `ensurePerFeaturePickIds` never runs, and no per-feature pickIds are allocated.

**SECONDARY blocking gap (discovered audit 2026-05-02):** Even when b3dm rendering lands, only the texture-based feature ID path will fire. `ModelPBRComplete.wgsl:1915-1929` gates per-feature pick on `FLAG_HAS_FEATURE_ID_TEXTURE`. B3DM tilesets predominantly carry `_BATCHID` vertex attributes, NOT textures. There's no `unpackFeatureIdFromAttribute` path in the shader and no `featureIdAttributeBuffer` binding in the pipeline cache. See new entry **NEW-FEATURE-ID-VERTEX-ATTR** below.

So the C-R9 work is functionally **un-testable** until BOTH the upstream b3dm-Model rendering path AND the vertex-attribute feature-ID path land.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:220 (Batch 54 "Still open"); 2026-04-30 reverification confirms shader + JS code wired Batches 100/101; AUDIT_2026_05_02.md B.2 surfaces the secondary blocker.

### NEW-FEATURE-ID-VERTEX-ATTR

**What:** Per-feature pick on B3DM tilesets requires reading `_BATCHID` vertex attribute (and EXT_mesh_features ID0/ID1/ID2). The texture-based path is wired; the vertex-attribute path is missing.

**Why deferred:** Surfaced by AUDIT_2026_05_02.md after the NEW-BG-CONSOLIDATION reconciliation. Most existing 3D Tiles content uses vertex-attribute feature IDs.

**Prerequisites:** None on the WebGPU side; can land independently. (NEW-BG-CONSOLIDATION blocker for the broader pick chain is already lifted.)

**Estimated effort:** 1 session.

**Implementation:** Wire `_BATCHID` (and EXT_mesh_features ID0/ID1/ID2) vertex attribute as a vertex input slot, plumb through to FS via `@interpolate(flat) @location(N) batchId: u32` (use `flat` interpolation since per-vertex IDs are integer constants per-triangle), and route through `lookupFeaturePickColor`/`lookupBatchColor` from there as the alternative to the texture sample.

**Impact:** B3DM tilesets — the most common 3D Tiles content type — get per-feature pick.

**Trace:** AUDIT_2026_05_02.md B.2.

**Estimated remaining effort:** 0 sessions if the b3dm-Model render path lands separately; the verify script will then pass automatically.

### C-R9-MODEL-PICK-TRANSLUCENT

**What:** Translucent-with-OIT pick - depth-correct alpha-blended picking through OIT framebuffer. Currently pick forces depth-write ON for ALL alpha modes (front-most fragment wins).

**Why deferred:** OIT writes accum + revealage textures, not pickable color. Routing pick through OIT requires parallel pick-OIT pipeline accumulating pickIds with same weights, resolving at composite.

**Prerequisites:** None - OIT path itself is stable.

**Estimated effort:** 2 sessions.

**Impact:** Picking through stacked translucent surfaces (glass building facades) returns whichever closest, not what user visually identifies. Acceptable first-cut.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:220 (Batch 54 "Translucent-with-OIT pick").

### C-R9-VOXEL-CELL-PICK

**What:** Per-cell granularity for voxel pick. `scene.pick()` returns the primitive; per-cell pick needs cell coords (3 x u32) packed into pickColor or out-of-band.

**Why deferred:** Voxel cell coords don't fit in 4-byte pickColor - needs separate buffer/texture + different resolve path.

**Prerequisites:** None.

**Estimated effort:** 1-2 sessions.

**Impact:** Voxel hover/click selection of individual cells doesn't work. Coarse primitive-level pick works.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:222 (Batch 53 "Per-cell / per-tile pick is out of scope").

---

## C-R10 - Point-light shadow tail

**Parent finding:** Cube-shadow cast (Batch 34) + Model FS receive (Batch 57) + soft-shadow PCF (Batch 63). Two named follow-ups remain.

### C-R10-GLOBE-POINT-LIGHT

**What:** Globe terrain receive shader extension for cube depth. `GlobeTerrain.wgsl` keeps using 2D shadow path; point-light shadows on terrain are uncommon.

**Why deferred:** Adding point-light receive to terrain requires copying `samplePointShadow` helper + new BGL binding into `GlobeTerrain.wgsl` AND updating effects bind-group consumer (currently same UBO layout as Model FS, so cube binding is a BGL grow that globe also has to consume). Architectural cost, low payoff.

**Prerequisites:** None - Batch 57's BGL is already set up to grow.

**Estimated effort:** 1 session if requested.

**Impact:** Point lights don't cast shadows on terrain on WebGPU. Models, primitives stay shadowed correctly.

**Trace:** REVIEW_FIX_PROGRESS.md (Batch 57 "Scope cuts"); PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:247.

### C-R10-CAST-LINEAR-DEPTH

**What:** Alternative cast pipeline writing linear depth (`distance / lightRadius`) via `@builtin(frag_depth)` instead of perspective-Z attachment. Would let receive use simpler `axisDist / farPlane` reference.

**Why deferred:** Perspective-Z path correctly round-trips against existing cast output. Switching to linear depth requires receive AND cast changing in lockstep - coordinated swap, not strict improvement. Tracking only because future profiling could shift the calculus.

**Prerequisites:** None.

**Estimated effort:** 1 session.

**Impact:** None today - current perspective-Z math is correct and cheap (two divides + one cube sample per fragment). Pure micro-optimization.

**Trace:** REVIEW_FIX_PROGRESS.md (Batch 57 "Scope cuts").

---

## C-R12 - Per-object cache walk

### C-R12-PER-OBJECT-CACHES

**What:** Extend `onDeviceInvalidated` event subscriber walk to per-Model / per-Collection / per-Renderer object caches. Subsystem-level caches (Bloom/AO/DoF/GodRays/AutoExposure/scene FB) are wired; per-object caches (`model._webgpuCache`, `clippingPlanes._webgpuCache`) are not.

**Why deferred:** Most per-object caches DO get rebuilt next frame because owning feature renderer's destroy + recreate runs anyway. Belt-and-suspenders correctness.

**Prerequisites:** None.

**Estimated effort:** 1 session.

**Impact:** None observed - device-loss recovery currently works for the test scenes that have hit it. Risk: a future cache that doesn't get reaped on next-frame churn would silently use stale GPU handles.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:283 ("tracked as **FOLLOW-UP C-R12-PER-OBJECT-CACHES** if it becomes necessary").

---

## NEW-4 — Genuine WebGPU bugs surfaced by TRULY FINAL Sandcastle pass (Batch 66)

The first end-to-end Sandcastle WebGPU verification (`SANDCASTLE_BATCH_66_TRULY_FINAL_REPORT.md`) flushed multiple second-layer bugs that only appeared once `Viewer.createAsync` actually initialized the WebGPU backend on the demos. NEW-3-A/B/C closed inline; NEW-4-B/C/F closed inline; NEW-4-A/D/E genuinely multi-session and tracked here.

### ~~NEW-4-A — EdgeVisibilityPipelineStage uses WebGL-only `Buffer.getBufferData`~~ FIXED 2026-04-25 (Batch 67)
**Resolution:** Took architecture option (b) — eager retention at upload — over (a) async pipeline-stage refactor. (a) was multi-session architectural work touching every pipeline stage's contract; (b) is two narrow edits and reuses the existing `loadTypedArray` plumbing. `GltfLoader.loadVertexAttribute` now sets `outputTypedArray = true` on every vertex attribute when `frameState.context.isWebGPU` AND the primitive carries `EXT_mesh_primitive_edge_visibility`, so `EdgeVisibilityPipelineStage`'s existing `defined(attribute.typedArray) ? attribute.typedArray : ModelReader.readAttributeAsTypedArray(...)` branch always takes the fast path on WebGPU and never invokes the WebGL-only sync readback. `EdgeVisibilityPipelineStage.process` also gained a defensive guard that bails cleanly with a `console.error` if the typed array is missing on WebGPU (safety net for any future loader path that skips retention). WebGL keeps prior behaviour — typed arrays still freed after upload, falling back through `Buffer.getBufferData` as before. Mirrors the pre-existing `loadIndices` retention pattern that already special-cased `hasEdgeVisibility` for the index typed array.
**Files touched:** [packages/engine/Source/Scene/GltfLoader.js](../packages/engine/Source/Scene/GltfLoader.js) (loadVertexAttribute retention), [packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js](../packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js) (defensive WebGPU guard).
**Sandcastle verification:** `WebGPU Edge Visibility.html` and `WebGPU Edge Feature ID.html` both PASS in `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` (previously hard-FAIL with `DeveloperError: A WebGL 2 context is required.` from `Buffer.getBufferData` thrown in `buildTriangleAdjacency`).
**Closing batch:** Batch 67.

### ~~NEW-4-D — Texture3D constructor has WebGL-only guard~~ FIXED 2026-04-25 (Batch 67)
**Resolution:** `Texture3D` constructor now short-circuits to `new WebGPUTexture3D(options)` when `context.isWebGPU` is true, BEFORE the WebGL2 `webgl2` guard runs. JS constructor return-value semantics replace `this` with the returned WebGPU instance, so every caller (`Megatexture.js`, future volumetric features) gets the right backend with zero call-site changes. The webgl-only build variant remains correct because the `WebGPUTexture3D` import is redirected to `emptyModule.js` (Proxy that throws on instantiation) and the dispatch is gated on `isWebGPU`, which is false in those builds. NEW-4-E is now reachable — Voxel demos reach `WebGPUVoxelRenderer.update()` and the WGSL pipeline-build step.
**Files touched:** [packages/engine/Source/Renderer/Texture3D.js](../packages/engine/Source/Renderer/Texture3D.js) (added import + 12-line WebGPU dispatch in constructor + factory comment).
**Closing batch:** Batch 67. See [WEBGPU_DEBUGGING_LOG.md § Session 39](WEBGPU_DEBUGGING_LOG.md) for full root-cause + fix narrative.

### ~~NEW-4-E — Voxel color pipeline WGSL parse error at line 113~~ FIXED 2026-04-25 (Batch 68)

**Captured live error (verbatim, port 8090 dev server, ctx UUID redacted):**

```text
[CesiumJS:webgpu:<ctx-uuid>] Shader "unlabeled" compilation ERROR at line 113:1: missing return at end of function
```

This matched the Batch-67 prediction exactly — naga couldn't prove that `fragmentMain` returns on every control-flow path because the `if (tr.x > tr.y) { discard; }` and `if (accumA < 0.01) { discard; }` early-outs in WGSL do NOT count as function terminators. `discard` is a fragment-state mutation, not a control-flow return.
**Resolution:** Took candidate (a) — paired each `discard;` with an explicit `return vec4<f32>(0.0);` in both `fragmentMain` and `fragmentPickMain`. The returned value is dropped by the discard so the colour is irrelevant; the explicit `return` gives naga the terminator it requires. Also added a trailing `return vec4<f32>(0.0);` after the terminal `discard;` at the end of `fragmentPickMain` (the no-hit fallthrough). Verified by re-running `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` against a worktree-private dev server on port 8090 — the `missing return at end of function` error is gone from the Voxel Pick demo's console.
**Files touched:** [packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts) (3 paired `discard; return` edits + 1 trailing fallthrough return + JSDoc-style WGSL comments explaining the naga requirement).
**Closing batch:** Batch 68.

### ~~NEW-4-G — Voxel WGSL `textureSample` not in uniform control flow~~ FIXED 2026-04-26 (Batch 69)

**Resolution:** Took candidate (a) — replaced `textureSample(voxelTex, voxelSamp, uvw)` with `textureSampleLevel(voxelTex, voxelSamp, uvw, 0.0)` in both `fragmentMain` (line 120) and `fragmentPickMain` (line 159) of [WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts). `textureSampleLevel` with explicit LOD 0 doesn't compute derivatives, so it has no uniform-control-flow requirement and naga accepts it inside the data-dependent ray-march loop. Volumetric voxel textures are single-mip, so forcing LOD 0 matches existing intent. Verified by re-running `SANDCASTLE_BASE_URL=http://localhost:8082 node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` — the `'textureSample' must only be called from uniform control flow` error is gone from the Voxel Pick demo's console. NEW-4-H (next predicted blocker) immediately surfaced as expected.
**Files touched:** [packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts) (2 paired textureSample → textureSampleLevel edits + WGSL comments referencing NEW-4-G).
**Closing batch:** Batch 69.

### ~~NEW-4-H — Voxel `updateWebGPUVoxelPrimitive` calls `Matrix4.multiplyByPoint` with undefined cartesian~~ FIXED 2026-04-26 (Batch 70)

**Resolution:** Two coupled root causes, both fixed in one batch:

1. **`UniformState.cameraPosition` getter was missing.** The TS `.d.ts` companion declared `readonly cameraPosition: Cartesian3` and ~13 WebGPU renderer call sites consumed it (`WebGPUVoxelRenderer`, `WebGPUCloudRenderer`, `WebGPUEllipsoidPrimitiveRenderer`, `WebGPUGaussianSplatRenderer`, `WebGPUPointCloudRenderer`, `WebGPUBufferPrimitiveRenderer`, `WebGPUGlobeSurfaceRenderer`, `WebGPUUniformGroupManager`, `WebGPUModelRenderer`, etc.) — but the JS class only had the private `_cameraPosition` field. Reads always returned `undefined`. Production builds masked this because `Check.typeOf.object` debug pragmas are stripped; the unminified Sandcastle build surfaced the first crash on the Voxel Pick demo. **Fix:** added `get cameraPosition() { return this._cameraPosition; }` to [UniformState.js](../packages/engine/Source/Renderer/UniformState.js) next to `previousCameraPosition`. One line, restores the contract the .d.ts has always promised, fixes all 13 call sites at once.

2. **`DerivedCommand.createDepthOnlyDerivedCommand` lacked the WebGPU shader-program guard** that its sibling `createLogDepthCommand` already had (NEW-5-A, Batch 66). Once Voxel Pick reached the per-frame derived-command sweep, `Scene.updateDerivedCommands → DerivedCommand.createDepthOnlyDerivedCommand` was called for every WebGPU command, and `getDepthOnlyShaderProgram → ShaderCache.getDerivedShaderProgram` dereferenced `shaderProgram._cachedShader` on a WebGPU command (which carries a `GPUShaderModule`-backed pipeline, not a WebGL `ShaderProgram` with `id` / `_cachedShader` fields). Crashed both Voxel Pick AND Translucent Classification with `Cannot read properties of undefined (reading '_cachedShader')`. **Fix:** added the symmetric `if (!defined(cmdShader?.id))` guard at the top of [DerivedCommand.createDepthOnlyDerivedCommand](../packages/engine/Source/Scene/DerivedCommand.js) — copies the WebGPU shader/renderState through unchanged, leaving the WebGPU dispatcher (`selectCommandVariant`) to route depth-only via its own `derivedCommands.depth.command` slot with a pre-built WGSL pipeline.

**Files touched:** [packages/engine/Source/Renderer/UniformState.js](../packages/engine/Source/Renderer/UniformState.js) (added `cameraPosition` getter), [packages/engine/Source/Scene/DerivedCommand.js](../packages/engine/Source/Scene/DerivedCommand.js) (added NEW-4-H WebGPU guard mirroring NEW-5-A).

**Sandcastle verification:** `WebGPU Voxel Pick.html` PASS (was FAIL since Batch 66). Sandcastle baseline jumped from 5/7 to 6/7 PASS in this batch alone; Translucent Classification's `_cachedShader` co-failure is also resolved by the same DerivedCommand.js fix, leaving only its separate depth-format-copy-compat issue (tracked as NEW-4-I).

**Closing batch:** Batch 70.

### ~~NEW-4-I — Translucent Classification copies Depth24PlusStencil8 → Depth24Plus (incompatible formats)~~ FIXED 2026-04-27 (Batch 71)

**Resolution:** Took candidate (a) — flipped the `_translucentDepthTexture` allocation in [WebGPUTranslucentTileClassification.update](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts) from `format: "depth24plus"` to `format: "depth24plus-stencil8"` so it matches the scene FB depth attachment (`SceneFramebuffer-Color_depth`). The `copyTextureToTexture` call in `executeTranslucentDepthPass` now passes WebGPU spec validation. The sampleable view at `_translucentDepthSampleableView` already pinned `aspect: "depth-only"` so the pack pipeline still reads only the depth channel — the stencil aspect is allocated but never sampled. Cost: one stencil byte per pixel (~negligible at any practical viewport size). The unused `_translucentDepthView` (default-aspect, dead code from a prior refactor) was left in place since it's never consumed and removing it is out of scope. Verified by re-running `SANDCASTLE_BASE_URL=http://localhost:8082 node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` after `npx gulp build` — Translucent Classification went from FAIL to PASS, taking the Sandcastle baseline from 6/7 to **7/7 PASS** (first time all WebGPU demos green on real WebGPU since the Batch 66 baseline framework was introduced).
**Files touched:** [packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts) (1-line format change + NEW-4-I rationale comment).
**Closing batch:** Batch 71.

---

## ~~BUG-F2 — ShaderBuilder crash on BENTLEY edge asset~~ FIXED (Batch 66)

### ~~F2-SHADERBUILDER-EMPTY-FUNCTION~~ FIXED 2026-04-25 (Batch 66)
**Resolution:** Root cause was NOT property-table mismatch as initially diagnosed. The March 2026 ES6 modernization commit (`febe065f36`) added a debug-only `throw new DeveloperError("The shader function must have at least one line.")` to `ShaderFunction.generateGlslLines()`. `MetadataPipelineStage.declareStructsAndFunctions` legitimately registers `initializeMetadata` / `setMetadataVaryings` unconditionally (so `MetadataStageVS/FS` chunks can call them as no-ops when the model has no metadata), and most glTF assets — Milk Truck, EdgeVisibility test assets, BENTLEY — fall into the empty-body path. **Fix:** removed the empty-body throw in [ShaderFunction.js](packages/engine/Source/Renderer/ShaderFunction.js). GLSL allows empty function bodies (`void foo() {}` is valid); the pre-modernization behaviour silently emitted them. Diagnosis was complicated because the prior verification's "BENTLEY-specific" framing was wrong — the simpler `EdgeVisibilityMaterial.glb` (zero metadata) hit the same path on re-verification, which is what surfaced the actual root cause.
**Closing batch:** Batch 66 ShaderFunction.js empty-body fix.

---

## Cross-cutting priority guide

> **Update 2026-04-27 (Batch 71 reconciliation):** the prior version of this guide led with "C-R5-IMAGERY-16 is the single biggest visual-correctness gap remaining". That citation was lifted from `OVERSIGHT_AUDIT_2026_04_25.md` §2, which was written hours before Batch 58 closed C-R5-IMAGERY-16 (16-layer cap + 5 missing per-layer uniforms shipped — see [PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md § C-R5](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md)). The audit's recommendation #2 was acted on; the doc trail just never reconciled the closure into this priority guide. C-R5 is no longer the lead item — the highest-impact open correctness work is now C-R8-TRANSLUCENT-MULTI-FRUSTUM.

1. **Highest-impact correctness wins first.** **C-R8-TRANSLUCENT-MULTI-FRUSTUM** produces visible artifacting in nearly every multi-frustum scene (every camera height crossing a logarithmic frustum boundary). 2 sessions, bounded.
2. **Architectural enablers second.** C-R7-RENDERER-MIGRATION-REMAINING + C-R7-SHADER-MODULE-DEDUP together unlock perf wins across the renderer fleet — mechanical pass × 9 renderers.
3. **C-R4-GLTF-KHR is its own multi-week workstream.** Don't pair with anything; consume sessions one extension at a time. KHR_texture_transform is the highest-impact single extension.
4. **C-R9-\* pick follow-ups are nice-to-have.** Per-feature pick / per-cell pick / OIT pick all matter for specific app types; not on critical path for migration parity.
5. **C-R12-PER-OBJECT-CACHES** is a "leave it until something breaks" item.

---

## Appendix - Items NOT in this inventory

- **Bug-tracker items** are tracked in `WEBGPU_DEBUGGING_LOG.md`. Numbered `BUG-NN.M`.
- **High-severity findings** (`H-R*`, `H-P*`, `DP-H*`) are in `WEBGPU_MIGRATION_BACKLOG.md` rather than here. This inventory is C-R-prefixed only.
- **Open parent findings** without named follow-ups (`C-R4`) stay in their parent review docs as deferral entries themselves. (`C-R5` was the other entry here pre-2026-04-27 and is now CLOSED — Batch 58 shipped C-R5-IMAGERY-16; no remaining follow-ups.)
