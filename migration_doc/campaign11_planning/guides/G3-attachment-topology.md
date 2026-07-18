# Campaign-11 Cluster Guide G3 — `attachment-topology` (MRT/attachment topology + pass/depth-pack economics)

**Register:** `C11_CANDIDATE_REGISTER.md` §6 (8 items) · **Register sweep HEAD:** `aef553d592` (Batch 698)
**This guide verified against HEAD:** `5b98ab9698` (Batch 699, `main`, 2026-07-18). The
`packages/engine/Source/Renderer/WebGPU/` tree is CLEAN in the working copy (`git status --porcelain`
empty for that directory), so working-file reads == HEAD for every anchor below. Line numbers are
hints; the **symbol + shape is the anchor** — re-grep before editing (C10 workers are landing
batches concurrently; expect drift by execution time).

**House rules carried over unchanged (do not weaken):** no feature removed/default-disabled/visually
degraded for a metric; rule-3 conservatism (unknown demand keeps the conservative behavior);
probe-first (CLAUDE.md Principle 8); one concern per slice; perf evidence = moving-altitude
clean+API lanes only (idle-soak invalid); premise-verify-first on EVERY item (several magnitudes
below are stale post-C10-01/C10-03 even where the mechanism is verified live).

## Cluster shape and the landed Batch 683–699 context (read this first)

Four C10 landings reshape this cluster's arithmetic; every worker must hold them:

1. **C10-01 (`Batch 693`) — default 3D is now ONE frustum.** `View.js` `sawEnvironmentNoBV`
   (verified `View.js:253/:371/:412`) excludes BV-less `Pass.ENVIRONMENT` commands from near/far
   widening; WebGPU `numberOfFrustums === 1 === WebGL` at 18,000 km/500 km/300 m; the sky-only leg
   is a 2-frustum fallback. **Every "per frustum × 3" figure in the perf-register S-rows is now
   "× 1" on the default route** — the mechanisms survive, the magnitudes do not.
2. **C10-03 (`Batch 697`) — demand-driven scene-COLOR resolve.** `getColorAttachments(clearValues?,
   { resolve })` + `createColorResolvePassDescriptor()` + `WebGPUSceneRenderer._ensureSceneColorResolved`
   + context flag `_sceneColorResolvePending`, kill switch `_sceneColorResolveElisionEnabled = true`
   (all verified, see item 1/2 anchors). Scene-COLOR resolves 9 → exactly 1.
   **The slot-1 G-buffer resolve was an explicit out-of-scope carve-out** — `buildMrtSlot1Attachment`
   still bakes `resolveTarget` at every scene-FB open, so slot-1 resolves still fire per segment.
   Eliminating them is THIS cluster's `C9-10-CONSUMER-DRIVEN-MRT` territory, not a C10-03 leftover.
3. **C10-02 (`Batch 699`) — translucent-twin gate** halves unstyled-tile command counts, which
   shrinks segment/boundary counts in tile scenes (affects S7-2/S2-5 measurement baselines).
4. **C9-09 (`Batch 681`, hardened `Batch 684`) — attachment-demand registry LANDED.**
   `computeAttachmentDemand()` → frozen `context._attachmentDemand`, `context.forceSceneMRT = true`
   (conservative), truthful counters via `getAttachmentDemandStats()`
   (`gbufferBytes`, `gbufferMsaaCompanionBytes`, `slot1AttachmentOpens`, `slot1ResolveOpens`,
   `sceneColorAttachmentCount`, `sceneColorResolveOpens`, `recordMatchesActual`), and the
   **`CesiumDebug.attachmentDemand(false)` refusal** (verified `Scene/CesiumDebug.js:552-569`) that
   names the C9-10 prerequisite. The refusal is the guard this cluster lifts at the very end.

**Recommended in-cluster sequencing:**
`C9-10` Slice A (P0 cache audit) → `S4-2/S4-3/S4-4` sub-slices (a) and (b) → `C9-10` Slice B
(demand-wire) → `S7-2` → `S2-5` → `S7-5` → Seed-10 wave (anytime; independent) →
`Phase-8a normal-G-buffer validation` (before or during `C9-10` Slice C — it is a decision input) →
`C9-10` Slice C (P2 default flip; lifts the refusal) → `S4-2` remainder (c) (stencil-less depth —
gated on Slice A's topology-key machinery). `Phase-8a / FEAT-GAP-01` is a gated-future dossier only.

---

## 1. C9-10-CONSUMER-DRIVEN-MRT / FAR-403-C0 — the cluster keystone (P1, XL epic, 3 slices)

### WHAT + WHY (evidence trail)

Make scene-FB G-buffer/MRT topology demand-driven: a DEFAULT scene (zero G-buffer consumers)
reports **zero** G-buffer bytes, zero MSAA-companion bytes, and zero slot-1 resolves, while any
consumer (deferred-lighting / SSR / NPR / contact-shadows / SSGI / debug-overlay) toggled on —
independently AND in combination — restores exact MRT behavior with per-consumer pixel parity,
preserving HDR/MSAA/resize/device-loss/TAA/pick/classification.

Evidence trail: `DEFERRED_WORK.md` L5227 (the definitive 2026-07-16 investigation record — premise
verified REAL, no code shipped, clean tree); C9 queue `QUEUE_2026-07-15_CAMPAIGN9.md` §6 item 27
("Cache exact one-target/MRT variants… Never merely set `_mrtMode=false`") + §3.2 C9-09 row
(registry landed, "topology flip is C9-10"); perf register S4-* rows carry the byte accounting
(~16 MB rgba16float G-buffer + MSAA companion + per-segment slot-1 resolves on every non-pick
frame). The C10 disposition (C10 queue §4 seed) is explicit: **dedicated multi-batch family — do
not open inside a wave.**

Why it is the keystone: item 2's stencil-less-depth half, the standing-red
`NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` (standing-reds cluster), and the Phase-8a consumer
story all converge on the same missing machinery — a **scene-FB topology dimension in per-renderer
pipeline caches**. Slice A builds it once for everyone.

### ARCHITECTURE TODAY (all verified at HEAD `5b98ab9698`)

- `WebGPUSceneFBTargetHelpers.ts:71` — `let _mrtMode = true;` hardcoded at module scope.
  `setSceneFBMrtMode()` (`:88`) has **zero runtime callers** (repo grep: only a doc-comment mention
  in `WebGPUPrimitiveCommands.ts:83`). `isSceneFBMrtMode()` at `:97`.
- `makeSceneFBTargets(format, options)` (`:146-182`): MRT-off → `[slot0]`; MRT-on →
  `[slot0, { format: MRT_NORMAL_ROUGHNESS_FORMAT, writeMask: options.emitsGBuffer ? 0xf : 0 }]`.
  The non-null writeMask-0 placeholder exists because trailing `null` targets are treated as
  "slot absent" by the validator (Batch 117 discovery — the exact "attachment state not compatible"
  failure mode a bad flip reproduces).
- **The verified 31-renderer caller inventory** (exact `makeSceneFBTargets` importers at HEAD,
  matching the DEFERRED_WORK list):
  `WebGPUBillboardRenderer.js`, `WebGPULabelRenderer.js`, `WebGPUPointPrimitiveRenderer.js`,
  `WebGPUPolylineRenderer.js`, `WebGPUBufferPointRenderer.ts`, `WebGPUBufferPolygonRenderer.ts`,
  `WebGPUBufferPolylineRenderer.ts`, `WebGPUCloudRenderer.ts`, `WebGPUComputeInstanceRenderer.ts`,
  `WebGPUCubeMapPanoramaRenderer.js`, `WebGPUDepthPlane.ts`, `WebGPUDerivedCommand.ts`,
  `WebGPUEdgeVisibilityEmitter.ts`, `WebGPUEllipsoidPrimitiveRenderer.ts`,
  `WebGPUEnvironmentRenderer.js`, `WebGPUFlowFieldRenderer.ts`, `WebGPUGaussianSplatRenderer.ts`,
  `WebGPUGroundPolylineRenderer.js`, `WebGPUGroundPrimitiveRenderer.js`,
  `WebGPUModelPipelineCache.ts`, `WebGPUOceanRenderer.ts`, `WebGPUPointCloudRenderer.ts`,
  `WebGPUPointCloudEyeDomeLighting.ts`, `WebGPUPrimitiveCommands.ts`,
  `WebGPUSkyAtmosphereRenderer.js`, `WebGPUStarFieldRenderer.ts`,
  `WebGPUVector3DTileClampedPolylinesRenderer.js`, `WebGPUVector3DTilePolylinesRenderer.js`,
  `WebGPUVector3DTilePrimitiveRenderer.js`, `WebGPUVoxelRenderer.ts`, `WebGPUWeatherRenderer.ts`.
  (Non-callers that grep matches: the helper itself, `WebGPUAttachmentDemandRegistry.ts` doc
  mention, `Shaders/WebGPU/Model/ErrorPipeline.{js,wgsl}` comment.)
- **DRIFT vs the DW entry — the globe is NOT helper-parametric.** `makeSceneFBTargetsMRT` has
  **zero callers** at HEAD. `WebGPUGlobeSurfacePipelines.ts` builds its targets **inline**
  (`:485-505`): capture path = 1 target; scene path = hardcoded
  `[{format: host._canvasFormat, …}, {format:"rgba16float", writeMask:0xf}]`, and
  `GlobeTerrain.wgsl` emits `@location(1) normalRoughness` unconditionally on the scene variant
  (the cube-face capture variant already has a define that drops the `@location(1)` output —
  `WebGPUGlobeSurfacePipelines.ts:157/:449-451` — i.e., **a shader mechanism for a 1-target globe
  already exists in-tree**). The globe is effectively surface #32 of the audit.
- Cache-key landscape (the P0 defect):
  - Collection family: `pipelineKeyWithDepthFlag(defines, noDepthTest)`
    (`WebGPUCollectionRendererBase.ts:205-212`) — Uint32, bits 0-30 ShaderDefine + bit 31
    `NO_DEPTH_TEST_PIPELINE_KEY_BIT = 0x80000000`. **No free bit for topology.**
  - Generic `WebGPURenderPipelineCache.generateCacheKey` (`:664`, `tg:` fold at `:731`) — already
    topology-safe (folds the target-array shape).
  - Model: `WebGPUModelPipelineCache.ts` keys shader modules/layouts by
    `${effectiveDefines}:${hash}` (`:1974`) — own scheme, needs classification.
  - Single-memo renderers: e.g. `WebGPUStarFieldRenderer.ts:106` `pipelineEntry` (no key at all),
    `WebGPUDepthPlane.ts:544` direct `device.createRenderPipeline` — topology safety here means
    memo invalidation, not key widening.
  - Globe: name-keyed cache already missing axes (`BUG-GLOBE-PIPELINE-NAME-AXES`, standing-reds
    cluster — strideBytes/normals/LOG_DEPTH/`_sampleCount` absent). The topology axis folds into
    the same repair.
- **An existing per-renderer invalidation channel:** `context._scenePipelineFormatGeneration`
  (`WebGPUContext.ts:700`, bumped on msaa/HDR flips at `WebGPUSceneRenderer.ts:1458-1471`) is
  consumed by 20+ of the 31 renderer files (verified grep). CAVEAT: the standing-red
  `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` documents that these guards rebuild **one frame
  late** — stale pipelines stay bound 1–2 frames on a flip. Reusing this channel alone inherits
  that bug; the queue-mandated "cache exact one-target/MRT variants" (key BOTH variants) makes the
  flip frame fetch the correct variant with no rebuild window.
- Demand machinery (all landed, observe-only): `WebGPUContext.ts:511` `forceSceneMRT = true`;
  `:4120-4140` `computeAttachmentDemand(...)` per frame in `updateAndClearFramebuffers` **before
  pass opens**; `:5273-5335` `getAttachmentDemandStats()`. G-buffer alloc site:
  `WebGPUContext.updateAndClearFramebuffers` (~L3964 per DW; re-grep `gbufferBytes` assignment).
  Slot-1 pass-open funnel: `WebGPUSceneRendererPassRedirect.buildMrtSlot1Attachment` (single funnel
  for all three scene-pass-open sites; returns null when mode off).

### IMPLEMENTATION WALKTHROUGH — Slice A (P0): the 31+1-renderer topology-keyed pipeline-cache audit

This is the schedulable slice the orchestrator asked for. It lands **byte-identical** (default is
still forced-MRT; both variants merely become *cacheable and selectable*).

- **Step 0 — premise re-verify.** Re-grep `_mrtMode` (still hardcoded true, still zero
  `setSceneFBMrtMode` runtime callers), re-run the 31-caller inventory grep
  (`grep -rln makeSceneFBTargets packages/engine/Source/Renderer/WebGPU`), confirm
  `makeSceneFBTargetsMRT` still has zero callers, and diff the inventory against the list above —
  any NEW caller since Batch 699 joins the audit. Check whether a C10 W4 rider already landed
  `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` (its fix may have introduced exactly the
  topology-signature machinery you want — build on it, do not duplicate).
- **Step 1 — completeness sweep beyond the helper.** The 31 helper callers are necessary but not
  sufficient. Sweep `grep -rln "targets:" …/WebGPU | xargs grep -Ln makeSceneFBTargets` (verified
  candidate list at HEAD includes `WebGPUGlobeSurfacePipelines.ts`, `WebGPUModelRenderer.ts`,
  `WebGPUOIT.ts`, `WebGPUInvertClassification.ts`, `WebGPUTranslucentTileClassification.ts`,
  `WebGPUBoundingVolumeDebugPass.ts`, `WebGPUClusterDebugRenderer.ts`,
  `WebGPUPipelineDescriptorBuilder.ts`, plus post-process/effect/LUT/pick/shadow files) and
  classify each: (i) draws inside the scene-FB pass → must become topology-parametric; (ii) owns
  its own pass/target (PP chain, globe-depth pack, pick FBO, shadow maps, OIT accum, LUTs, canvas
  env effects) → topology-independent, record and skip. Useful invariant: since `_mrtMode` has been
  permanently true, anything drawing in the scene pass today MUST already declare 2 targets — so
  classification (i) is findable by looking for the hardcoded second target or helper use.
- **Step 2 — pick the mechanism per cache family** (mandated direction: "cache exact
  one-target/MRT variants"):
  - Collection family: widen `pipelineKeyWithDepthFlag` past 32 bits — the DW-suggested safe-int
    fold (e.g. `key = (defines>>>0) + (noDepthTest?2**31:0) + (mrt?2**32:0)` as a number key, or a
    template-string key) — bits 0-31 are full, so this is a type change to the map key; audit every
    map that stores by the old key.
  - Model/globe/other keyed caches: fold a topology token into their existing key strings.
  - Single-memo renderers (StarField/DepthPlane/Sun/Moon/etc.): 2-entry memo indexed by mode, or a
    stored topology token compared on fetch.
  - Generic `WebGPURenderPipelineCache` users: verify `tg:` fold covers them; no change.
  - RECOMMENDATION (design decision to record in the brief): define ONE
    `context.sceneFBTopologySignature` (color-target count + formats + depth format + sampleCount)
    so this same key dimension later absorbs the stencil-less-depth flip (item 2c) and the
    MSAA-flip standing red — do not invent three parallel one-bit mechanisms.
- **Step 3 — the globe.** Make `WebGPUGlobeSurfacePipelines.buildPipelineDescriptor` emit 1 vs 2
  targets by `isSceneFBMrtMode()`, reusing the existing capture-path define that drops
  `@location(1)` for the 1-target variant, and fold the topology axis into the globe's name key
  (coordinate with `BUG-GLOBE-PIPELINE-NAME-AXES` — same key, one repair; do not land two
  conflicting key schemes).
- **Step 4 — probe.** New `Tools/visual-regression/probe-mrt-topology-key-audit.mjs` (extend
  `probe-attachment-demand-registry.mjs`): boot default (forced MRT), then — via a debug-only test
  hook, NOT the public API — flip `setSceneFBMrtMode(false)` + open a 1-attachment scene pass and
  fetch pipelines for every renderer family present in a composite scene (globe + billboard/label/
  point/polyline + model + a primitive + depth-plane + sky/star), assert **zero validation
  errors**, flip back, assert zero errors again and pixels restored. Until Slice C, this hook must
  be pragma-gated/debug-only so no production path can flip.

**Slice B (P1, after A) — demand-wire, still byte-identical:** gate the G-buffer alloc + MSAA
companion + slot-1 resolve on `context._attachmentDemand.gbufferDemanded`; call
`setSceneFBMrtMode(gbufferDemanded)` in `updateAndClearFramebuffers` before any pipeline builds
(the record is computed there already — verified `:4132`); `forceSceneMRT` stays default-true so
`gbufferDemanded` is still always true ⇒ byte-identical, but the machinery is live.

**Slice C (P2, after B) — the flip + acceptance matrix:** flip `forceSceneMRT` default to false;
no-consumer frames drop to one target and report `gbufferBytes=0`, `gbufferMsaaCompanionBytes=0`,
`slot1ResolveOpens=0`, `sceneColorAttachmentCount=1`, `recordMatchesActual=true`. Run the full
matrix from the DW entry: each consumer independently + combinations (SSR/NPR/contact/deferred/
SSGI/debug-overlay), HDR, MSAA 1&4, resize, device-loss, TAA (msaa1 velocity path), pick, and
classification — each with pixel parity vs pre-change, PNGs READ. **This is the slice that lifts
the `CesiumDebug.attachmentDemand(false)` refusal** (`CesiumDebug.js:552-569`): replace the refusal
warn with the real path and sync the DEBUGGING_GUIDE entry (Batch 684 wrote both).

### TRAPS

- **NEVER hardcode `_mrtMode=false`** or achieve zero bytes by disabling consumers — that is
  feature removal (charter rule; the queue row states it verbatim).
- **The mid-session break is the acceptance, not an edge case:** stale 1-target pipeline vs
  2-attachment pass → "Attachment state not compatible" → invalid command buffer → black frame.
  Any renderer missed by the audit fails EXACTLY on the consumer-toggle path the acceptance
  mandates. The Batch-117 discovery (trailing-null = slot absent) is the same failure shape —
  reread the helper's comment block (`WebGPUSceneFBTargetHelpers.ts:154-176`) before touching the
  placeholder.
- **Flip timing:** mode must be set in `updateAndClearFramebuffers` BEFORE any pipeline fetch and
  pass open of that frame. Reusing only `_scenePipelineFormatGeneration` bumps inherits the
  known one-frame-late rebuild (standing red). Key-both-variants has no rebuild window.
- **C10-03 interplay (carve-out inversion):** `probe-msaa-resolve-elision` asserts slot-1 resolves
  are PRESERVED/unchanged (they were out of scope for C10-03). After Slice C, slot-1 resolves are
  legitimately 0 on no-consumer frames — that probe's assertion must become demand-conditional
  **in the same slice**, or it turns into a false red. Same for
  `probe-attachment-demand-registry`'s default-shape assertions (`topology mrt`, `slot1 opens>0`,
  `gbuffer allocated`, MSAA companion bytes>0) — all invert at Slice C on default frames.
- **Do not fold scene-COLOR resolve logic in:** `_ensureSceneColorResolved` /
  `_sceneColorResolvePending` (C10-03) is a separate, landed mechanism. Slice C removes slot-1
  resolves by removing the slot-1 attachment; it must not touch the color-resolve dirty flag.
- **Gate discipline:** C9 queue §3 required a Gate-B-clean state for topology work; C9 closed green
  but `C9-02A` remains PARTIAL/PAUSED (pick cluster). Slice A and B are correctness-independent
  (byte-identical landings) — record that in the brief; Slice C is NOT, and should wait for the C10
  pick-wave outcome (`C10-11`/`C10-12`) before scheduling.
- **Pick frames are already single-target** (`beginPickFrame` nulls the swap view, Batch 684) —
  do not "fix" pick pipelines into the topology key sweep; pick pipelines target the pick FBO and
  are out of scope.
- **TAA/velocity:** TAA forces msaa1 (Batch 234 bridge, `WebGPUSceneRenderer.ts:1402-1411`); the
  velocity rg16float target is a SEPARATE lazily-allocated target (S4 clean checks) — not slot-1.
  Don't conflate them in the acceptance matrix.
- **Two G-buffer producers exist today** (globe via inline targets + `emitsGBuffer` primitives per
  `NEW-GBUFFER-MRT-PRIMITIVE-EMIT`, DEFERRED_WORK L4568) — Slice C's no-consumer frames silently
  stop *storing* their slot-1 output. That is correct (no consumer reads it) but must be stated in
  the batch evidence, and the `Phase-8a normal-G-buffer validation` probe (item 8) should run
  BEFORE Slice C so the payoff question is answered while the always-on baseline still exists.

### VERIFICATION RECIPE

- Slice A: new `probe-mrt-topology-key-audit.mjs` (zero validation errors across the flip, per
  family); `probe-attachment-demand-registry.mjs` all `recordMatchesActual`; byte-identity =
  `capture-and-diff` globe-default crossBackend in the 0.43–0.77% band + historical lanes at C9-30
  baseline (0.01%); `probe-msaa-resolve-elision.mjs` unchanged (scene-COLOR 1, slot-1 preserved);
  `probe-frustum-count-3d.mjs` PASS (C10-01 preserved); tsc/eslint/gulp build clean.
- Slice B: identical gate net (still byte-identical by construction) + assert
  `setSceneFBMrtMode` now has exactly one runtime caller.
- Slice C: the DW acceptance matrix above, plus `getAttachmentDemandStats()` zero-byte oracle,
  plus moving-altitude clean+API on/off/restored with the G-buffer alloc/clear/resolve bandwidth
  named as the saved stage (banner only if ≥5% named-stage p95 or >3× noise; the honest expectation
  is a GPU-bandwidth win with flat CPU-p95 — C10-03 precedent: VALID COMPLETE without banner).
- Promotion stance: Slices A/B land on mechanics + byte-identity alone; Slice C lands on the
  matrix + truthful counters; no slice may claim a perf banner without moving-altitude evidence.

### MODEL TIER + EFFORT

- Slice A: **opus-or-sol**, L (mechanical once this guide's inventory is in hand; fable only if the
  completeness sweep surfaces ambiguous scene-pass renderers).
- Slice B: **opus-or-sol**, S–M.
- Slice C: **opus-or-sol** for execution with **fable on standby** for toggle-path regressions
  (the acceptance matrix is where surprises live), L. Rollback: each slice is a single-commit
  revert; A and B are byte-identical so revert is riskless; C reverts to forced-MRT.

---

## 2. S4-2 / S4-3 / S4-4 — C9-35 MSAA containment remainder (P1, M, three sub-slices)

### WHAT + WHY (evidence trail)

The bundle remainder of the C9-35/C10-03 MSAA family beyond landed ruling parts (b) resolve-elision
and (d) TAA→msaa1 verification (both in `Batch 697`). Source: perf register
`PERF_ARCH_DEEP_DIVE_2026-07-16.md` §5 S4-2/S4-3/S4-4; C10 guide H3 carries the maintainer ruling
and the bytes table. Three independent sub-slices:

- **(a) S4-3 — MSAA color usage flags:** MSAA scene color is allocated
  `RENDER_ATTACHMENT|TEXTURE_BINDING|COPY_SRC` (worst-case layout; on several drivers this disables
  or degrades framebuffer compression → potential 1.5–2× color traffic on EVERY draw, not just
  boundaries). Make the multisampled color RENDER_ATTACHMENT-only; keep TEXTURE_BINDING|COPY_SRC on
  the single-sample resolve texture only.
- **(b) S4-4 — consumer-gate the per-frame fullscreen MSAA depth resolve:** unconditional dispatch
  every MSAA frame into r16float (~12 MB + a pass boundary) while ALL consumers of the resolved
  depth view (PP AO/DoF, env effects NPR/SSR/procedural clouds, deferred) are opt-in and
  default-off — an unread texture on the default path.
- **(c) S4-2 fix-directions 3/4 — depth/stencil `storeOp:"discard"` on the final scene segment +
  stencil-less depth format on classification-free frames.** The D24S8@4× store/load pair is the
  single largest row of the S4-2 bytes table.

### ARCHITECTURE TODAY (verified at HEAD `5b98ab9698`)

- (a) `WebGPURenderTarget.ts:135-139` — single default usage mask
  `RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC`, applied to the attachment texture AND the
  resolve target (`:156/:166/:183`). Depth already has per-case usage handling (`:200-219`,
  COPY_SRC correctly skipped for MSAA depth) — color does not.
- (b) `WebGPUSceneRendererPostFrustumChain.ts` ~`:100-124` — `resolveDepthMSAA` dispatched whenever
  the scene FB exposes it and an encoder exists (no consumer gating; ends the current pass first).
  The resolve pass module is `WebGPUDepthResolveMSAA.ts`; `SceneFramebuffer.depthSampleableView`
  (`WebGPUSceneFramebuffer.ts:238`) returns the resolved view in MSAA mode. The gate pattern to
  copy: `_anyEnvEffectEnabled` at `PostFrustumChain.ts:260` (**drift**: register cites `:222-255`).
  The demand registry is the natural owner — C9-09's record already carries observe-only families;
  add a `resolvedDepth` demand mirroring C10-03's `resolvedSceneColor` precedent.
- (c) `WebGPURenderTarget.getDepthStencilAttachment(view?, ?, depthLoadOp="clear",
  depthStoreOp="store", stencilLoadOp="clear", stencilStoreOp="store")` (`:407-424`) — store is the
  default everywhere; scene FB is created `depthStencilFormat:"depth24plus-stencil8",
  depthSamplable:true` (`WebGPUSceneFramebuffer.ts:325-333` per C10-03 record).
- **Magnitudes are PREMISE-STALE:** the ~1.6 GB/frame table was 3-frustum + eager-resolve. At HEAD
  (1 frustum, demand resolve) the boundary count and totals are materially lower — re-measure
  before quoting any savings.

### IMPLEMENTATION WALKTHROUGH

- (a): parametrize per-texture usage in `createTextures()`: `sampleCount>1` color →
  RENDER_ATTACHMENT only; resolve texture keeps TEXTURE_BINDING (PP samples it) + COPY_SRC
  (refraction capture `copyTextureToTexture` reads `colorTexture`, which returns the RESOLVE
  texture in MSAA mode — verified `getColorTexture` `:443-445`). Audit OTHER `WebGPURenderTarget`
  users before changing the shared default — safest is an explicit opt-in flag set only by
  `WebGPUSceneFramebuffer`.
- (b): extend `computeAttachmentDemand` with `resolvedDepthDemanded` (readers: PP AO/DoF stage
  enablement, env-effect set, deferred/SSGI); gate the `resolveDepthMSAA` dispatch on it; keep
  rule-3 conservatism (unknown consumer ⇒ resolve). Add an actual counter
  (`depthResolveOpens`) to `getAttachmentDemandStats` so record↔actual stays truthful.
- (c): **order matters.** First (b) — while any consumer reads resolved depth you cannot discard;
  the final-segment discard is legal only when the gated consumer set is empty AND no debug/read
  path samples live depth after the last segment. `storeOp` decisions happen at pass-open
  descriptor build (`_resumeScenePass`/`_clearDepthStencil`/redirect), and "final segment" is not
  knowable at open time — mirror the C10-03 lesson (predict-at-open was REJECTED for color) and
  instead consider an end-of-frame contract: the LAST scene segment is always followed by
  `_ensureSceneColorResolved` + PP; a `finalSegmentHint` set by the frustum loop when it opens the
  last known segment is acceptable only with a conservative fallback (hint absent ⇒ store).
  The stencil-less-depth half (format flip `depth24plus-stencil8` → `depth24plus` on
  classification-free frames) **changes every scene-FB pipeline's depthStencil format = the same
  31-renderer topology-key problem** — it is GATED on item 1 Slice A's topology-signature
  machinery. Do not attempt it standalone; if scheduled early, restrict to a session-static
  decision (chosen at context creation), never mid-session.

### TRAPS

- (a) is the only sub-slice safe as a pure mechanical change — but verify no debug/readback path
  samples the MSAA attachment view directly (`InvertClassification` stencil path reads the MSAA
  attachment view per the C10-03 demand map row 3 — it BINDS it as an attachment, not a sampled
  texture; confirm before stripping TEXTURE_BINDING).
- (b) must not break the r16float quality-ceiling note: when consumers ARE on, behavior is
  unchanged (the r16float→depth32float upgrade is explicitly a separate, longer-term item — do not
  fold it in; one concern per slice).
- (c) discard + `depthSamplable:true`: `resolveDepthMSAA` reads the depth texture AFTER the last
  scene pass ends — a discard on that segment destroys its input. The gating dependency is
  (b)-first, and discard only when `resolvedDepthDemanded === false`.
- Single-sample mode (msaa1): `depthSampleableView` returns the live depth view directly — PP
  AO/DoF read it with no resolve pass; the (c) discard logic must be msaa-aware or it breaks
  msaa1 + AO scenes.
- Cross-item: item 1 Slice B gates the G-buffer MSAA companion; (a) also touches texture creation
  in the same file family — land (a) before or after Slice B, never interleaved in one batch.

### VERIFICATION RECIPE

- Probes: `probe-msaa-resolve-elision.mjs` (counters stay green), `probe-msaa-comparison.mjs`,
  `probe-attachment-demand-registry.mjs`, `probe-taa-jitter.mjs` GATE (TAA/msaa1 path),
  `capture-and-diff` full battery byte-identity for (a) and (b) at defaults; for (b) additionally a
  consumer-on scenario (enable AO or SSR, assert `depthResolveOpens` flips 0→1 and pixels match
  pre-change; PNGs read). New probe name if needed: `probe-msaa-depth-resolve-demand.mjs`.
- (c): classification scenes (`probe-classification-primitive-parity.mjs`), invert-classification
  scenario from the C10-03 recipe, plus a stencil-consumer scene before any stencil-less decision.
- Perf: moving-altitude clean+API on/off/restored; (a)'s win is driver-dependent compression —
  expect GPU-frame-time movement on some hardware and NOTHING on others; report honestly, no
  banner without ≥5%/3×-noise. Analytical byte accounting must be re-derived at HEAD (1-frustum).

### MODEL TIER + EFFORT

(a) **opus-or-sol**, S. (b) **opus-or-sol**, M. (c) **fable-first** for the final-segment/consumer
analysis (ambiguous lifetime reasoning), then opus for execution; M; stencil-less half deferred
behind item 1 Slice A. Rollback: each sub-slice single-commit.

---

## 3. S7-2 — per-frustum fixed pass scaffold gating (P1, M) — post-C10-01 remainder

### WHAT + WHY (evidence trail)

Perf register §8 S7-2 (DEEPER-ON-KNOWN, HIGH): the per-frustum pass scaffold is content-UNGATED —
the globe-depth pack runs whenever `useGlobeDepthFramebuffer` is on regardless of the frustum's
globe command count; the `clearGlobeDepth` mid-frustum clear is its own full pass open/close; the
DP-H45 post-opaque re-pack fires essentially always (`clearGlobeDepth` defaults true). C10-01
fixed the **multiplier** (2-frusta floor → 1 frustum); the per-frustum **content** remains. The
register row: "~12 scene-FB pass boundaries + 4 fullscreen RGBA8 packs per default frame" — those
are PRE-C10-01 numbers (**PREMISE-STALE magnitudes; mechanisms verified**). At HEAD expect roughly
half on the default route; sky-only fallback still pays 2 frusta.

### ARCHITECTURE TODAY (verified at HEAD `5b98ab9698`, `WebGPUSceneRendererFrustumLoop.ts`)

- `:284-292` — post-globe `executeCopyDepth` gated ONLY on
  `host._globeDepth && config.useGlobeDepthFramebuffer` (no per-frustum globe command count).
- `:303-313` — packed-depth texture published per frustum; `packedDepth.createView()` minted per
  frustum per frame (S2-5 overlap).
- `:330` — `if (config.clearGlobeDepth && !debugDepthViz)` mid-frustum clear via
  `_clearDepthStencil` (a full pass boundary).
- `:352-380` — post-3D-tiles depth-update hook → `executeUpdateDepth`.
- `:450-480` — DP-H45 post-OPAQUE re-pack; gate at `:465-473` =
  `useGlobeDepthFramebuffer && (OPAQUE>0 || VOXELS>0 || (clearGlobeDepth && !debugDepthViz))` —
  the third disjunct is constitutively true at defaults.
- `:685-694` — pickDepth consumes the packed RGBA8 texture (`globeDepthTexture`) — the packed copy
  is pick's input, which is why naive gating changes pick semantics (S7-4).

### IMPLEMENTATION WALKTHROUGH

- **Step 0 — re-quantify at HEAD** (premise-verify): instrument or count scene-FB
  `beginRenderPass` + pack passes per frame on the default globe (the C10-03 probe's bucketed
  counter is reusable). Record the new baseline; if the residual is already small, report honestly
  and shrink scope.
- **Step 1 — gate the post-globe pack on per-frustum globe command count** (the frustum's
  `Pass.GLOBE` bin length): zero globe commands in this frustum ⇒ skip end/pack/resume. Preserve
  the packed-texture *publication* semantics: consumers (`pickDepth.update`, classification) must
  still see the LAST valid pack; skipping must not leave a stale-view publish for a frustum that
  never packed (publish previous or skip publish — decide from `:303-313` flow).
- **Step 2 — fold the `clearGlobeDepth` clear into the next natural boundary's
  `depthLoadOp:"clear"`** instead of a dedicated open/close. Read the order at `:324-345` first:
  the clear precedes the depth-plane/translucent sequence — the fold target must be the very next
  scene-pass open in the same frustum, and the depth-plane draw must land inside that folded pass.
- **Step 3 — DO NOT touch the DP-H45 re-pack here.** Its correct gate is depth-version tracking,
  owned by the pick cluster (`NEW-PICK-WEBGPU-MULTIFRUSTUM-PACKED-DEPTH` / FAR-408-C0, with S7-4's
  semantic trap: the packed texture must hold cleared+depth-plane depth for pickPosition). This
  slice's charter: pack-count and clear-boundary reduction with byte-identical pick behavior.

### TRAPS

- The S7-4 pick-semantics trap is the reason this slice must NOT count-gate DP-H45: the re-pack
  runs after the mid-frustum clear + depth-plane redraw, and pickDepth consumes that state.
  Cross-cluster boundary — respect it even though the code is adjacent.
- `clearGlobeDepth` fold interacts with `C9-02B`'s depth-plane work and the translucent ordering;
  any reordering that changes what depth the translucent pass tests against is a correctness bug,
  not a perf win.
- Zero-globe-command frustums still need correct depth for non-globe content — skipping the PACK
  is safe (pack is a copy-out), skipping any CLEAR is not automatically safe.
- C10-02 (translucent twin gate) changed tile-scene command counts — rebaseline tile scenes before
  attributing deltas.
- Sky-only fallback frames (2 frusta) are the C10-01-preserved path — `probe-frustum-count-3d.mjs`
  must stay green (its sky-only leg asserts 2).

### VERIFICATION RECIPE

- New probe `probe-pass-scaffold-gating.mjs`: per-frame bucketed counts (scene-FB opens, pack
  passes) on (i) default globe, (ii) globe-off scene, (iii) tile scene, (iv) sky-only leg;
  PRE/POST deltas recorded.
- Pick oracle is mandatory: `probe-point-pick-webgpu.mjs`, `probe-billboard-pick.mjs`, and the
  pickPosition standing red's OFF-oracle discipline (the standing red
  `NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION` FAILS at HEAD — attribute via OFF-oracle
  exactly as C10-01 did, do not claim or absorb it).
- `capture-and-diff` battery byte-identity at defaults; `probe-camera-track` 9/9 both backends;
  moving-altitude on/off/restored for the perf claim (boundary count is the named stage).

### MODEL TIER + EFFORT

**opus-or-sol**, M (well-specified after Step 0; escalate to fable only if Step 0's counts diverge
wildly from expectations). Rollback: single revert; probe survives.

---

## 4. S2-5 — pass-reopen descriptor caching (P2, S)

### WHAT + WHY

Perf register §3 S2-5: every scene-FB reopen rebuilds attachment descriptor arrays twice
(`getColorAttachments` `.map()` + fresh clearValue objects, then `_resumeScenePass` /
`_clearDepthStencil` re-`.map()` with `{...a}` spread + `[...arr, slot1]` MRT append) across ~16
reopen sites; plus per-frustum `packedDepth.createView()` minting and a recreated 3D-tile
depth-update hook closure. ~60–180 transient objects/frame pre-C10-01 (**magnitude stale; halve-ish
at HEAD**). Fix: one frozen load-variant descriptor pair per framebuffer generation, invalidated on
resize/MSAA/MRT/HDR change; reopen sites pass the stored reference. C9-09's registry is the natural
owner.

### ARCHITECTURE TODAY (verified at HEAD)

`WebGPURenderTarget.getColorAttachments` `:317-343` (map + per-call clearValue + now the C10-03
`resolve` option); `WebGPUSceneRenderer._resumeScenePass` ~`:1907-1933` (spread-remap to
`loadOp:"load"`, comment at `:1923-1928` documents the C10-03 interaction) and `_clearDepthStencil`
~`:1990-2019`; MRT append via `buildMrtSlot1Attachment` in `WebGPUSceneRendererPassRedirect.ts`;
`packedDepth.createView()` at `FrustumLoop.ts:313`; the depth-hook closure at `:352+`. **Drift from
the register:** all three open sites now thread `{ resolve: context._sceneColorResolveElisionEnabled
!== true }` — any cached descriptor must be keyed on (or rebuilt with) the elision flag state, and
must NOT bake a `resolveTarget` back in (that silently reverts C10-03).

### IMPLEMENTATION WALKTHROUGH + TRAPS

Cache a frozen `{clearVariant, loadVariant}` descriptor pair on the scene framebuffer, versioned by
a framebuffer generation (bump on resize/msaa/hdr recreate — the `msaaChanged/hdrChanged` branch,
`SceneRenderer.ts:1437-1450` — and on MRT topology change once item 1 lands: fold
`sceneFBTopologySignature` into the generation). Hoist `packedDepth.createView()` to
create/resize time; hoist the depth-hook closure to a bound method. TRAPS: (i) GPURenderPassDescriptor
objects are consumed by `beginRenderPass` — sharing one object across concurrent opens is safe only
because passes are serial; assert single-threaded reuse (no nested scene passes). (ii) The
`depthClearValue` differs between clear and load variants and `_clearDepthStencil` sometimes wants
color-load + depth-clear — enumerate the ACTUAL variant set from the three sites before designing
the pair (it may be three variants, not two). (iii) Mutating a cached descriptor's `loadOp` in
place at one site leaks into the next site — freeze in dev builds. (iv) Item 1 Slice C changes the
attachment ARRAY LENGTH — the cache must invalidate on topology generation or it re-introduces the
exact stale-1-target failure.

### VERIFICATION RECIPE

Byte-identity is the whole bar: `capture-and-diff` battery + `probe-demand-canvas-pass` 24/24 +
`probe-msaa-resolve-elision` counters unchanged + `probe-attachment-demand-registry` green.
Allocation evidence: API-lane counter or a debug-pragma alloc counter PRE/POST (transient objects
per frame). Perf claim optional — this is an allocation-hygiene slice; no banner expected.

### MODEL TIER + EFFORT

**opus-or-sol**, S. Sequence AFTER item 1 Slice A design lands (so the generation can include the
topology signature) or keep the cache keyed on today's inputs + a TODO folded into Slice C's
checklist. Rollback: single revert.

---

## 5. S7-5 — multi-frustum contract machinery (P2, S–M) — post-C10-01 remainder

### WHAT + WHY

Perf register §8 S7-5: (i) collection camera UBs pack the camera TWICE even single-frustum (static
bake + slice copy) and upload byte-duplicate per-slice UBs + bind groups per extra frustum when
`repackPerSlice === false` (slice-N content is byte-identical to slice-0 in 3D); (ii) frustum
idx ≥ 1 allocates a dedicated 65,536-object GPU culler (~2.8 MB VRAM + dispatch + readback)
regardless of the band's command count. **C10-01 mooted the default-3D exposure** (1 frustum ⇒ no
idx≥1 culler, no per-slice duplication) — the live remainder is: the single-frustum camera
double-pack (EVERY frame, default path), the sky-only fallback (2 frusta), and 2D/CV/ortho band
frames (where `repackPerSlice=true` makes per-band repack legitimate, but the aux-culler
size/allocation is still unconditional).

### ARCHITECTURE TODAY (verified at HEAD)

`WebGPUCollectionCameraUB.js` — `repackPerSlice` option plumbed at `:110-147`, per-slice re-invoke
at `:243`. `WebGPUContextCullerPool.ts` — `maxObjects: 65536` hardcoded at `:114/:182/:249/:301`;
`WebGPUGPUCuller.ts:124` default 65536. (Registry note: the FAR-003/503 readback finding never
counted the per-frustum instance pool.)

### IMPLEMENTATION WALKTHROUGH + TRAPS

(1) Reuse the static-baked buffer when `repackPerSlice === false` (slice buffers exist only for
writeBuffer-vs-encoder ordering — verify that ordering constraint is actually still live before
deduping; if a mid-frame writeBuffer would race the encoder, keep distinct buffers but skip the
REPACK and copy GPU-side or reuse the bake bytes). (2) Eliminate the single-frustum double-pack:
pack once, bind the static buffer. (3) Size/skip aux cullers by the band's actual command count
(allocate lazily; a sky-only band with ~3 env commands needs no 65K culler). TRAPS: bind-group
identity — collection renderers cache bind groups keyed on buffer identity; swapping which buffer
slice-0 binds invalidates those caches (mirror the buffers-stash identity discipline from the
clustered-lighting C9-16 precedent). 2D/CV is exactly where `repackPerSlice=true` — the dedupe MUST
be conditional on the flag, never structural (S7-6's band economics live in the `frame-delta`
cluster; don't scope-creep into band-count reduction here). GPU-culler behavior is FAR-003-gated
(auto GPU cull contained) — verify what actually dispatches at HEAD before claiming savings
(**PREMISE-CHECK: the aux-culler allocation may already be unreachable on the default path
post-C10-01; the item may reduce to the double-pack + lazy-pool fix**).

### VERIFICATION RECIPE

`probe-collections-regression.mjs` + `probe-2d-cv-modes.mjs` + `probe-2d-frustum-bins.mjs` (band
paths byte-identical); sky-only leg via `probe-frustum-count-3d.mjs` scene; API-lane
WriteBufferCalls/BindGroupsCreated deltas on a collections-heavy scene; `capture-and-diff`
collections scenes byte-identical. New probe if needed: `probe-collection-ub-slice-dedupe.mjs`
asserting 1 camera pack + N-slice buffer reuse counts.

### MODEL TIER + EFFORT

**opus-or-sol**, S–M. Premise-check first (30 minutes) — if the culler half is dead at defaults,
report and shrink to the double-pack fix. Rollback: single revert.

---

## 6. Seed-10 cleanup wave — S6-6 / S6-4 / S4-6 / S4-7 (P2, M total; 4 independent sub-slices)

Perf register §14 seed 10. Four small slices; two are genuine correctness bugs (S6-4). All four
premises **verified live at HEAD** this sweep.

### S6-6 — voxel tile streaming CPU expansion (M for voxel scenes)

`WebGPUVoxelDataUpload.ts`: `expandToRGBA` fresh full-tile alloc at `:385`, `toHalfFloat` DataView
per-element at `:408`, call sites `:541/:623/:772-773/:1083-1084`. Padded 64³ tile ≈ 1.05 M
DataView round-trips ≈ 10–30 ms main-thread per tile, re-paid on LRU re-entry. FIX: tile-sized
scratch reuse + bit-twiddled (or `Float16Array` where available) conversion + optional converted-
payload cache for LRU re-entries. TRAPS: float32-filterable devices skip conversion — keep both
paths; the LRU cache must be byte-budgeted (do not trade CPU hitching for unbounded memory —
coordinate with the C9-15 residency philosophy, `terrain-imagery` cluster). VERIFY:
`probe-voxel-megatexture` PART routes (existing), plus a timed streaming lane (deep-octree zoom)
PRE/POST measuring per-tile upload CPU; visual byte-identity on voxel scenes
(`probe-voxel-*` set). Tier: **opus-or-sol**, S.

### S6-4 — WebGPUBufferMapper repair-or-retire (2 real bugs; correctness)

Verified at HEAD: (1) `WebGPUBufferMapper.ts` `_stagingCache`/`_readbackCache` are drained
(`:237-267`) and trimmed (`:286-291`) but **never repopulated** — every call allocates a GPUBuffer
that lives until destroy + issues a private mid-frame submit; (2)
`WebGPUPerformanceManager.ts:~686` calls `mapper.uploadViaStagingBuffer(targetBuffer, data,
offset)` passing a NUMERIC offset where the third parameter is `StagingUploadOptions`
(`destOffset`) — the offset is silently dropped and writes land at 0; (3) `WebGPUBuffer.ts:147-171`
`mappedAtCreation: true` + `data` skips the write branch entirely (no else) — data silently
dropped. FIX: return buffers to the caches after unmap; fix the call-site arg shape; make
`mappedAtCreation`+data write into the mapped range or throw. **Principle-7 decision required
before any retirement**: the class is the designated large-upload/readback API future streaming
work adopts — the register stance is repair-or-retire with a maintainer call; default to REPAIR.
VERIFY: new `node --test` spec `webgpu-buffer-mapper.spec.mjs` (cache round-trip, offset
honored, mappedAtCreation data present — can run against a mocked device) + a PerformanceManager
integration probe asserting bytes land at the requested offset. Tier: **opus-or-sol**, S.

### S4-6 — post-process terminal-stage canvas targeting (SDR)

`WebGPUPostProcessPipeline.ts:1737` — the final `_executeCopyStage(encoder, currentView, destView)`
runs unconditionally (comment at `:1731-1736` confirms; +16.6 MB r/w per frame @1080p SDR whenever
any stage is enabled). FIX: compile a canvas-format variant for the terminal SDR stage (key
`_compileStage` on is-terminal); KEEP the identity blit for (i) the zero-stage path (WebGPU
requires the PP blit — CLAUDE.md: `usePostProcess` always true) and (ii) HDR format mismatch.
TRAPS: `_intermediateFormat === canvasFormat` only in SDR — assert, don't assume; the ping-pong
view indexing (`viewIndex`) changes when a stage writes destView directly — the NEXT frame's
stage chain must not read a stale ping-pong slot; FXAA-is-terminal is the common case to test.
VERIFY: `capture-and-diff` with FXAA on/off byte-identity; `probe-taa-jitter` GATE; HDR scenes
unchanged (`probe-hdr-*` set); pass-count counter shows one fewer fullscreen pass with ≥1 SDR
stage enabled. Tier: **opus-or-sol**, S.

### S4-7 — lazy full-res ID render target

`WebGPUSceneFramebuffer.ts:336-343` allocates `_idTarget` (rgba8 + private D24S8) unconditionally
in `update()`; getter `idFramebuffer` at `:264-266`. Verified: no WebGPU-path callers —
`FramebufferOrchestrator.js:256` reads `view.sceneFramebuffer.idFramebuffer` but that is the WebGL
`Scene/SceneFramebuffer.js` instance (**premise-verify step for the worker: confirm the
orchestrator can never receive the WebGPU object on a WebGPU context**). ~17 MB resident @1080p,
reallocated every resize/HDR/MSAA recreate. FIX: lazy-allocate on first `idTarget`/`idFramebuffer`
access — this PRESERVES the Principle-7 scaffold contract at zero resident cost. **Removal is
forbidden** without the FEATURE_INVENTORY pick-via-ID cross-check (the register mandates
lazy-allocate as the default). VERIFY: memory snapshot PRE/POST (`getDebugSnapshot` or perf-manager
texture counters) shows the ID target absent at defaults; a synthetic getter-access test allocates
it on demand + it survives resize afterward; full `capture-and-diff` + pick probes byte-identical.
Tier: **opus-or-sol**, S.

Wave packaging: 4 independent sub-slices, one concern per commit; any subset may land. (Do not batch them
into one commit — each has its own rollback boundary.)

---

## 7. Phase-8a / FEAT-GAP-01 — normal G-buffer + depth prepass (P2/gated FUTURE — dossier)

**Dossier paragraph (not schedulable in C11 as a unit; see item 8 for the schedulable probe).**
`FEATURE_INVENTORY.md` §D (line ~927): "Phase 8a normal G-buffer + depth prepass — single
highest-leverage infra gap." It unblocks decals (FEAT-GAP-08), full clearcoat/sheen/aniso BRDFs
(FEAT-SURVEY-02/03/04), iridescence LUT, env probes with parallax correction, and better AO/GI —
and is the natural continuation of `C9-10-CONSUMER-DRIVEN-MRT` Slice C across the fleet: once
topology is demand-driven, "a consumer exists" is precisely the signal that re-enables slot-1
(and eventually widens it). **Documented drift to carry into any brief:**
`ROADMAP_AND_DEFERRED_WORK.md:1166-1169` claims the producer + MRT slot-1 ship "off by default" —
at HEAD the topology is FORCED-ON (`_mrtMode=true`, `forceSceneMRT=true`) with consumers off; the
ROADMAP §7 sentence also claims a 16-bit ShaderDefine registry, contradicting the 31-bit reality
(LQ staleness, ~160 batches). Producers today: globe (`GlobeTerrain.wgsl` FragOutput
`@location(1)`, inline targets `WebGPUGlobeSurfacePipelines.ts:485-505`) + `emitsGBuffer`
primitives (`NEW-GBUFFER-MRT-PRIMITIVE-EMIT`, DEFERRED_WORK L4568; consumers of the option at HEAD:
`WebGPUDerivedCommand.ts`, `WebGPUEllipsoidPrimitiveRenderer.ts`, `WebGPUModelPipelineCache.ts`,
`WebGPUPrimitiveCommands.ts`). The depth-prepass half has no code at HEAD. Sequencing: item 1
Slices A–C FIRST (topology machinery), item 8's validation verdict SECOND (is slot-1 worth
consuming?), then a dedicated campaign family for the prepass + consumer wiring. Effort XL;
maintainer scoping decision required before any brief is cut. No C11 scheduling recommended beyond
item 8.

---

## 8. Phase-8a normal-G-buffer validation (P2, S, tooling) — the payoff probe that never ran

### WHAT + WHY

`ROADMAP_AND_DEFERRED_WORK.md` §7 (row at line ~930) + §"Phase 8a foundation": the slot-1
normal-roughness producer ships, but the **payoff-validation probe — does any consumer actually
benefit? — never ran**. It is the decision input for (a) item 1 Slice C's evidence narrative
(what is lost on no-consumer frames: nothing consumed it anyway — prove it), and (b) whether
FEAT-GAP-01 consumers should read slot-1 or a depth-derived fallback. Existing adjacent probes
(verified in `Tools/visual-regression/`): `probe-gbuffer-enabled.mjs` (asserts flipping
`scene.deferredLighting` is VISUALLY INERT — an invisibility test, not a payoff test),
`probe-gbuffer-visualize.mjs`, `probe-normalmap-gbuffer.mjs`, `probe-mrt-validation.mjs`,
`probe-litmat-mrt.mjs`, `probe-ellipsoid-mrt.mjs`, `probe-model-mrt.mjs`.

### IMPLEMENTATION WALKTHROUGH + VERIFICATION

New `probe-gbuffer-consumer-payoff.mjs`: for each shipped consumer that can read slot-1 (AO is the
named one — "consumers (AO today, SSR / clustered lighting / contact shadows next)" per the globe
pipeline comment at `WebGPUGlobeSurfacePipelines.ts:466-476`), capture (i) consumer ON with slot-1
normals available (today's default topology), (ii) consumer ON with the depth-derived fallback
forced (the sentinel path the same comment documents), (iii) consumer OFF. Diff (i) vs (ii) on
normal-sensitive content (terrain relief + a normal-mapped model + an ellipsoid): a
non-trivial, visually-better delta = slot-1 pays; a null delta = the producer feeds nothing today
and Slice C's zero-byte default costs literally nothing. READ the PNGs; record the verdict in the
ledger + FEATURE_INVENTORY §D note. TRAPS: forcing the fallback must use the existing sentinel
mechanism ((0,0,0,*) slot-1 sample → depth-derived path), not a hacked shader; do this via a
debug hook or a scene with no slot-1 producers rather than editing WGSL. Run BEFORE item 1
Slice C while the always-on baseline exists.

### MODEL TIER + EFFORT

**fable**, S — this is an evidence-gathering/judgment task (diagnostic shape), not mechanical
execution. Output is a verdict + artifacts, zero engine code.

---

## OPEN QUESTIONS for the orchestrator

1. **C10 outcome dependencies.** C10 is still in flight at HEAD: `C10-06/07/08` (boot triad),
   `C10-11/12` (pick fleet log-depth + gate flip), `C10-13` (reversed-Z spike) and `C10-30`
   (checkpoint) are open. (a) Item 1 Slice C should not schedule until the C10 pick-wave outcome is
   known (Gate-B-class coupling recorded in the DW entry). (b) If `C10-13` returns GO and the
   gated `C10-GT-REVERSED-Z-SLICE-B` ever activates, the RGBA8 pack ecosystem S7-2 optimizes is
   slated for DELETION — S7-2 is still worth landing (near-term win, small diff) but the
   orchestrator should sequence it before any reversed-Z commitment and mark it
   superseded-by-design there. (c) All perf baselines in this cluster must be re-anchored to the
   C10-30 checkpoint artifacts once it runs.
2. **Who owns `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`?** It is listed as a C10 W4 rider
   (standing-reds cluster). If it lands in C10, item 1 Slice A must BUILD ON its transition
   machinery; if it does not, the orchestrator should decide whether Slice A's
   `sceneFBTopologySignature` recommendation absorbs it (one mechanism for sampleCount + MRT +
   depth-format) — my recommendation — or they stay separate slices in separate clusters.
   Cross-cluster coordination needed either way.
3. **Maintainer decisions needed:** (a) item 1 Slice C's default flip (`forceSceneMRT` → false) is
   a frame-topology behavior change — does the maintainer want an explicit sign-off recorded like
   the C10-03R reserve-lever protocol, or does the DW-recorded phasing count as standing approval?
   (b) S6-4 repair-vs-retire (Principle-7); recommendation REPAIR. (c) Whether the stencil-less
   depth half of item 2(c) is wanted at all before reversed-Z resolves (it may be throwaway work if
   `C10-GT` ever activates — same D24S8 surface).
4. **Sequencing constraint inside C11:** item 8 (payoff probe) MUST run before item 1 Slice C
   (needs the always-on slot-1 baseline). Cheap, fable-tier, zero risk — schedule it early.
5. **Register magnitude staleness:** every S4-2/S7-2/S7-5/S2-5 byte/count figure predates C10-01
   and C10-03. Workers are instructed to re-measure (premise-verify steps included per item), but
   the orchestrator should NOT rank these items against other clusters by the stale magnitudes —
   the default-path residuals are smaller than the register rows read.
6. **PREMISE-UNVERIFIED flags summary** (worker must check at execution HEAD): S7-5's aux-culler
   reachability at defaults post-C10-01; S4-7's FramebufferOrchestrator-never-receives-WebGPU-FB
   assumption; S7-2/S4-2 magnitudes (mechanisms verified, counts stale); the C10 W4 rider status of
   the MSAA-flip standing red. Everything else in this guide was verified live at `5b98ab9698`.
