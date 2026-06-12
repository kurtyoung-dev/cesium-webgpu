# Deferred Work Inventory - CesiumJS WebGPU Migration

**Last Updated:** 2026-05-30 (_DOC_AUDIT_PLAN.md §3.2 Batch 179–185 drift sweep at HEAD `88b111e49c` Batch 185 — NEW-GROUNDPRIM-TEXTURED-MATERIALS marked RESOLVED, NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION added as the canonical open residual, NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION approach-(A) downgraded to producer-shipped; prior 2026-05-02 AUDIT_2026_05_02.md cross-coupling sweep. **Also 2026-05-30:** pre-archive safety lift (_DOC_AUDIT_PLAN.md §2 Cluster B / §3.7) of still-open build/lifecycle + data-pipeline findings from the three 2026-04-16 pillars being archived — see the "Carried-forward on archive (2026-05-30)" section at the end.)

> **✅ Forward-dated entries — RE-VERIFIED 2026-06-05 (was flagged 2026-05-30).** The cluster of entries marked `RESOLVED` against batch numbers FUTURE relative to HEAD = Batch 185 (Batches 186–230: 188/190/192/193/197/199/204/208/209/210/211/219/220/221/224/225/228/230 + doc-sync siblings) was re-checked against the ACTUAL code via a 14-entry verification sweep — **all 14 confirmed genuinely RESOLVED in code** (C-R1-GLOBE-RENDERSTATE, C-R1-TILE-BATCH, NEW-GPU-CULLER-CONSUME-OR-DELETE, NEW-GPU-SORT-PIPELINE, NEW-SHADOW-CAST-GPU-CULL, NEW-MULTIFRUSTUM-CULL-RESULTS, NEW-VR-BASELINE-HIGH-DENSITY, NEW-COLLECTIONS-MOTION-VECTORS, C-R8-TRANSLUCENT-DEPTH-ONLY, NEW-GS-CLASSIFICATION-DEPTH, C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES, C-R10-GLOBE-POINT-LIGHT, C-R12-PER-OBJECT-CACHES). The fixes are present and wired (not stubs); the future-looking batch numbers are an artifact of the **non-monotonic batch numbering** (see `WEBGPU_MIGRATION_STATUS.md`) — trust dates/hashes/code over batch labels. None needed re-marking open. (Minor doc drift noted in the sweep: a few cited line numbers are stale from file growth — not corrected here.)

This is the canonical list of named C-R follow-ups deferred during the principal-engineer review remediation (Batches 1-64). Each entry has a stable identifier (`C-R<n>-<NAME>`) that survives renumbering when slots are filled. Grouped by parent C-R finding from `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`.

Each entry: **What** / **Why deferred** / **Prerequisites** / **Estimated effort** (1 session ~ 1-3 hours) / **Impact** / **Trace**.

This inventory is add-only; ship items mark `(SHIPPED in Batch N)` next to the heading rather than removing the row.

**Companion docs (cross-reference before scoping):**

- [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) — exhaustive catalog of existing/new/WIP/future features
- [AUDIT_2026_05_02.md](AUDIT_2026_05_02.md) — most recent cross-coupling audit; 110+ findings prioritized by severity (BREAKING / PARTIAL / LATENT / STALE STATUS)

---

## 2026-06-11 — Dual-axis Ultra-Review findings (49 new IDs)

Source of record: [audits/2026-06-11_ULTRA_REVIEW.md](audits/2026-06-11_ULTRA_REVIEW.md) (full report) + `audits/2026-06-11_ULTRA_REVIEW_findings.json` (all 195 confirmed-real findings with per-finding verdicts). Produced by the `webgpu-ultra-review` workflow (53 agents, adversarial-verified). Axis A = WebGPU vs our-WebGL; Axis B = our-WebGL vs upstream fork drift. The 2 CRITICALs were orchestrator-spot-checked against live code (both CONFIRMED REAL); medium/low await per-item check at fix time.

### CRITICAL (2 — verified)

- **NEW-PICKDEPTH-CAPABILITY-READBACK** (A) — ✅ PARTIALLY SHIPPED (Batch 221). Added `GraphicsContext.supportsSynchronousReadback` capability getter (WebGL true / WebGPU false) and switched the two `defined(context.readPixels)` backend-proxy checks (`PickDepth.update`/`getDepth`, `InstancingPipelineStage`) to it — `readPixels` is a required abstract method both backends implement, so `defined()` was always true and wrongly took the WebGL branch. This fixes `PickDepth` to take the async path + the **`InstancingPipelineStage` typed-array drop** for WebGPU instanced models, and removes the wrongly-allocated WebGL pick framebuffer on WebGPU. **Remaining (see NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION below):** the depth VALUE reconstruction is still wrong on WebGPU, so `pickPosition` returns undefined (safe) rather than a position. NOTE the review under-scoped this as "one getter" — it is a 3-layer fix.
- **NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION** (A, HIGH — split from the above, Batch 221) — `pickPosition`/`pickPositionWorldCoordinates`/camera-zoom-and-tilt-to-cursor reconstruct a garbage world position on WebGPU (verified: antipode at ~85,000 km). Two coupled causes found: (1) `getDepth`'s consumers are ALL synchronous (no async pick API exists — `Picking.js:608`, `Scene.js:4069`, `CameraHelpers.js:247`, `SSCCInputHelpers.js:65`), so it must return number|undefined not a Promise; (2) all frustums share the single packed `globeDepth.globeDepthTexture` (`WebGPUSceneRendererFrustumLoop.ts:641`) but `unprojectDepth` (`Picking.js:532`) rebuilds with each frustum's own near/far → frustum-space mismatch. Same depth-representation family as the collections far-3D issue. Needs per-frustum WebGPU pick-depth (or a full-frustum reconstruction path) + a sync cached-value bridge (`_readDepthAsync`/`_lastDepthValue` are the in-place scaffolding). Reproducer: `Tools/visual-regression/probe-pickposition-webgpu.mjs`. Also covers NEW-PICK-RAY-ASYNC / NEW-PICK-METADATA-READBACK (interlocking, same readback architecture).
- **NEW-OIT-COMPOSITE-FORMAT** (A) — ✅ SHIPPED (Batch 222). `WebGPUOIT._createCompositePipeline` now takes the target format (was hardcoded `rgba8unorm`), and `executeComposite` rebuilds the composite pipeline on demand when `targetFormat` (the real `context._sceneColorFormat`: `bgra8unorm` default / `rgba16float` HDR) differs from the pipeline's `_compositeFormat`. The composite pipeline's color-target format now matches the attachment by construction, so the MRT-OIT composite can no longer fail WebGPU's format-match validation. Verified no-regression on a translucent OIT scene (0 console/validation errors); full positive verification of the MRT-OIT path needs a Gaussian-splat/forced-OIT scene (that path is fallback-only).

### HIGH — Axis A (WebGPU vs WebGL)

- **NEW-PICK-RAY-ASYNC** — Ray picks (pickFromRay/sampleHeight/clampToHeight) use sync end() -> stale results on WebGPU. Add an async ray-pick path (endAsync + awaited getDepth) plus a oneTimeWarning, mirroring drillPickAsync.
- **NEW-PICK-METADATA-READBACK** — readCenterPixel returns stale prior-frame pixels; pickMetadata/pickVoxelCoordinate broken. Sync metadata/voxel picks read _lastReadPixels from a prior frame before endFrame submits the current render; add sync-after-submit or async variants.
- **NEW-TONEMAPPER-STRING-MAP** — ✅ SHIPPED (Batch 223). `mapTonemapType` read non-existent `_tonemapping.type`/`_tonemappingType` and switched on NUMBERS, so it always returned the default (PBR_NEUTRAL) — `scene.postProcessStages.tonemapper` was a silent no-op. Fixed to read `collection._tonemapper` (the real field) and switch on the STRING `Tonemapper` enum. Verified end-to-end: each string maps to the correct WebGPU `TonemapMode` (REINHARD→0, ACES→1, FILMIC→2, MODIFIED_REINHARD→3, PBR_NEUTRAL→4) which matches the `Tonemapping.wgsl` operator selection.
- **NEW-POSTPROCESS-HDR-INTERMEDIATES** — ✅ SHIPPED (Batch 225). The four built-in effects (`addBloom`/`addAmbientOcclusion`/`addDepthOfField`/`addGodRay`) passed `canvasFormat` to the effects' `initialize`, so in HDR they allocated 8-bit (bgra8unorm) intermediates that clamped highlights before tonemap. Fixed to pass `this._intermediateFormat || canvasFormat` (rgba16float in HDR, == canvasFormat in SDR → no-op for the common path). Also reset the built-in effects in `WebGPUPostProcessPipeline.initialize()` on any recreate (HDR toggle / resize) — they were created once (`if (this._bloomEffect) return`), so an HDR toggle previously left them holding their first-creation 8-bit/wrong-size textures. Verified: SDR + HDR bloom both render with 0 validation errors (probe).
- **NEW-BLOOM-UNIFORM-PARITY** — Bloom mis-maps WebGL brightness/contrast onto a luminance threshold (inverts default). brightness default -0.3 fed as threshold passes everything; port HSB contrast/brightness bright-pass + map all six uniforms.
- **NEW-POSTPROCESS-USER-WARN-PROD** — User GLSL post-process stages silently dropped in production (warning pragma-stripped). Move the glslOnly oneTimeWarning out of the debug pragma; it is a real functionality loss across the entire PostProcessStageLibrary.
- **NEW-MODEL-IBL-BRDF-LUT** — Specular IBL uses analytic Fresnel; generated BRDF LUT never consumed by model path. Bind the LUT into the model material bind group and use split-sum F*lut.x+lut.y + FmsEms; fixes the wasted device-init dispatch and misleading docstring.
- **NEW-CSM-SOFT-SHADOW-PCF** — CSM receive drops soft-shadow PCF + normal-shading the single-map path keeps. Add a shadowSoftShadows-gated PCF kernel to sampleOneCascade and the normal-shading clamp to computeShadowFactorCSM.
- **NEW-SPLAT-SORT-CONSUME-INDEXES** — Gaussian splats render in buffer order; CPU back-to-front sort silently dropped. Consume primitive._indexes as a per-instance attribute (or GPU radix sort -> drawIndirect); correct DEFERRED_WORK:637.
- **NEW-POINTCLOUDLOD-SLOT255-OFFBYONE** — PointCloudLOD slot-255 offset broadcast clobbers a compacted index on full workgroups. localCount can equal 256 at LOD-0; use a dedicated var<workgroup> wgOffset or size sharedVisible to 257 (subgroup variant too).
- **NEW-GLOBE-BINDGROUP-CACHE** — Globe surface renderer allocates 3-4 GPUBindGroups per tile per pass per frame. Cache group1/group2 per (tile,imagery-revision)/(waterMask id); add getStats; pairs with dynamic-offset BGL for group0.
- **NEW-COLLECTIONS-DIRTY-GATE** — Billboard/Label rebuild + full-upload entire instance buffer every frame. Port the Point renderer needsRebuild gate; keep resident instance array; writeBuffer only dirty sub-ranges. **ATTEMPTED + REVERTED (Batch 226) — subtler than the Point reference implies.** A `needsRebuild` gate (skip `buildInstanceData` + `writeBuffer` unless `_billboardsToUpdateIndex > 0 || lastLength !== length || definesChanged`) DID work for static billboards (verified: 1 build over 30 static frames, renders correctly) — the perf win is real. BUT the dirty-tracking re-arm is entangled with the WebGL vertex-build's reset SEQUENCE: `_updateBillboard` only re-pushes when `!billboard._dirty`, and the WebGL build clears `_dirty` (BillboardCollection.js:806/890) AND `_createVertexArray` (line 786) AND `_billboardsToUpdateIndex`, in order. Replicating only the `_dirty` reset → a *moving* billboard never re-triggered a rebuild (stale render). Adding the `_dirty` re-arm → static billboards rebuilt ~2×/frame (something — the `runSharedSceneLogic` readiness loop calling `_updateBillboard` for `textureDirty`, and/or `_createVertexArray` never being reset on WebGPU so `updateMode` re-runs `recomputeActualPositions` every frame — re-dirties them). **A correct gate must replicate the full WebGL reset sequence** (`_dirty` + `_createVertexArray` + `_billboardsToUpdateIndex`, and stop the readiness loop / `updateMode` from re-pushing settled billboards on WebGPU) and re-verify BOTH static-skips AND moving-updates. Reproducer: a probe toggling a `cache._buildCount` debug counter over static then dynamic frames. NOTE: the Point renderer (the "reference") likely has the SAME latent moving-primitive staleness — verify it too. Reverted to avoid shipping a correctness risk.
  - **ROOT-CAUSE PREREQUISITE (confirmed Batch 226, 2nd attempt):** added a backend-agnostic monotonic `_instanceVersion` bumped in `_updateBillboard`; the FR rebuilds when it advances (recorded, never reset). The version-signal is CORRECT (a color change and a position change each bumped it + triggered a rebuild) but it STILL rebuilt ~2×/frame for "static" billboards → **`_updateBillboard` is being called every frame for settled billboards on the WebGPU path** (the `runSharedSceneLogic` readiness loop / unreset `_createVertexArray`). So **step 0 for ANY dirty-gate is stopping the WebGPU collection path from re-dirtying settled billboards each frame** (replicate WebGL's "dirties consumed" semantics, or compute a true source-changed signal that ignores the per-frame re-touch). Both gate attempts are blocked on this, not on the gate logic itself.
  - **DESIGN DECISION (owner Q, 2026-06-11 — supersedes "all-or-nothing gate"):** the right target is **per-INSTANCE partial sub-range writes**, not the all-or-nothing rebuild. WebGPU's whole-buffer rebuild is O(N) per change-frame; for "micro-updates to tens of thousands of objects" (sparse changes in a huge collection) the fix is a **resident CPU instance array + `device.queue.writeBuffer(buf, K*stride, …, stride)` per changed instance** (O(changed), e.g. ~640 B for 10-of-50k vs 3.2 MB). This NEEDS the per-instance dirty list (`_billboardsToUpdate[0.._billboardsToUpdateIndex]`) — but does NOT need WebGL's per-ATTRIBUTE separate buffers (keep interleaved for draw-time cache locality; re-writing a changed instance's full 64 B record is fine). Extreme per-frame churn (100k+ all moving) → GPU-resident scatter via compute / storage buffer (no CPU round-trip). **Best home: a shared resident-instance-buffer manager with dirty-range tracking (pairs with NEW-COLLECTION-RENDERER-BASE), used by billboard/label/point.** Do probe-driven in a dedicated session after the step-0 re-touch fix.
  - **✅ CLOSED FOR BILLBOARDS (Batch 229):** the resident-instance manager shipped and the billboard renderer is wired onto it — see NEW-RESIDENT-INSTANCE-BUFFER-MGR / NEW-PARTIAL-WRITE-WIRE-BPL below. Static collections upload 0 bytes/frame; a single moved billboard uploads exactly 1×176 B.
  - **✅ CLOSED FOR POINTS + LABELS (Batch 232):** Point + Label wired onto the manager too (NEW-PARTIAL-WRITE-WIRE-BPL fully shipped). Remaining follow-up for this ID is only the structural fold into NEW-COLLECTION-RENDERER-BASE (P1-T6).
- **NEW-COLLECTIONS-LOG-DEPTH** (M, found Batch 229) — WebGPU collections (and the globe — see the Batch 180 note: "the WebGPU globe writes hyperbolic NDC depth") write STANDARD hyperbolic clip depth; WebGL billboards/points go through czm log-depth. With near=0.1/far=1e10, a billboard 1000 m above the ground viewed from a 220 km camera is ~0.03 depth-quantization steps (0.1·Δd/d² vs 2⁻²⁴) from the globe surface — an unresolvable z-tie, so whether the billboard wins the less-equal test is per-tile rounding luck. Reproduced deterministically in probe development (Batch 229): a billboard moved out of its cluster at 220 km vanished on WebGPU under BOTH the partial-write path AND a forced full rebuild, while WebGL rendered it; at ≤ ~10 km camera range (≥ ~17 steps of separation) it renders deterministically. Same root family as NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION (`storedDepth ≈ 0.9999997` cancellation). Fix = port czm log-depth (vertex `log2(1+w)` write + matching globe encode) to the collection + globe pipelines together — encodings must match or everything z-fights.
- **NEW-COLLECTIONS-TAA-GATE-DORMANT** — ✅ SHIPPED (Batch 234). `Scene.updateFrameState` now publishes ONE canonical `frameState.taaEnabled` (mirror of `scene.taaEnabled`; declared on `FrameState.js` + `CesiumFrameState` in cesium-js-types.d.ts), and ALL velocity-emission gates read it: the broken `frameState.scene?.taaEnabled` spelling was switched in Billboard/Label/PointPrimitive/Polyline (JS) + Cloud/PointCloud(×2)/Voxel/GaussianSplat (TS, casts removed); the Model/GroundPrimitive/GroundPolyline/Vector3DTile* renderers already read `frameState.taaEnabled` and went live with the same publication. **First-time-execution fix that surfaced (same batch):** the documented `Scene.taaEnabled` ↔ MSAA incompatibility was never enforced, and the velocity pass pairs the single-sample rg16float velocity texture with the scene depth attachment — 4x-multisampled by default → pass-killing attachment-sample-count validation error. `WebGPUSceneRenderer.prepareFrame` now forces effective samples to 1 while TAA is on (`scene.msaaSamples` untouched; existing drift detection restores it on toggle-off). Verified (probe-taa-velocity-emission.mjs, OFF→ON→OFF): OFF 25f → no velocityCommand, velocity texture unallocated, msaa=4; ON 60 moving frames → billboard+point velocityCommand attached with 2 vertex streams (current + slot-aligned prev mirror), velocity texture allocated (pass ran), msaa=1, **0 console/validation errors on the first-ever execution of the collection velocity pipelines**; OFF 10f → commands detach, msaa back to 4. Regression: probe-billboard-partial-write, probe-point-label-partial-write, probe-orbital-catalog, probe-compute-instance-generic all PASS. Remaining dormancy in the same family is the TAA effect itself — see NEW-TAA-EFFECT-NEVER-ADDED below.
- **NEW-TAA-EFFECT-NEVER-ADDED** (M, found Batch 234 while activating the velocity gates) — velocity now emits end-to-end into the rg16float `motionTex`, but **nothing ever calls `WebGPUPostProcessPipeline.addTAA()`** (zero callers; `WebGPUSceneRendererEnsureResources.ts:422` says "TAA is added lazily when scene.taaEnabled = true" but no lazy-add exists), so `_taaEffect` is null → `setStageEnabled("TAA", true)` no-ops (`WebGPUPostProcessPipeline.ts:1220` guards on `this._taaEffect`) → the TAA resolve never runs AND the `Scene.js:5213` jitter block no-ops (`pipeline?.taaEffect` is null). Net: `scene.taaEnabled = true` today costs the velocity pass + MSAA downgrade but produces NO temporal accumulation. Fix: lazy-add the TAA effect when `scene.taaEnabled` first goes true (ensure-resources or the stage-collection sync), then probe-verify jitter + history accumulation visually (first-time activation of the whole resolve stage — needs its own probe; reconcile with `NEW-TAA-PIPELINE-ORDER-RECONCILE`). Related smaller dormancy in the same `frameState.scene` family: `WebGPUEnvironmentRenderer.js:953` reads `frameState.scene` (undefined) so the moon snapshot-freezable never registers — harmless today (guarded by `defined`), fold into this fix or the snapshot work.
- **NEW-GLOBE-RENDERBUNDLE-CACHE** — Globe pass builds and discards a render bundle every frame instead of caching. Route through renderBundleManager.getOrCreate keyed on tile-set/pass/format with invalidation, or drop the inline bundle path.
- **NEW-GROUNDATMOSPHERE-RENDERER-DEAD** — ✅ RESOLVED (Batch 239, deleted as SUPERSEDED). Git archaeology confirmed the separate-pass design (introduced 2026-03-31, `05b6da60d1`: `Environment/GroundAtmosphere.wgsl` full Nishita single-scattering ray-marcher + `WebGPUGroundAtmosphereRenderer.ts` packing a 64-byte AtmosphereParams UB) was a parity misread — WebGL integrates ground atmosphere INTO the globe FS via defines, not as a separate pass, and the parity-correct path shipped later (Session 65 Batch 9): in-`GlobeTerrain.wgsl` shading via `csm_computeGroundAtmosphereScattering` + the `WebGPUAtmosphereLUT` transmittance/inscatter tier + camera-UB/tile-UB params. Archaeology correction: a `Globe.js beginFrame` call site DID exist and invoked `update()` every frame — but the UB it packed/uploaded (`globe._webgpuAtmosphereBuffer`) had ZERO consumers (never bound by any pipeline; `Environment/GroundAtmosphere.wgsl` had zero code references), so the path was dead at the consumer end, exactly as the ultra-review found. Deleted: renderer + WGSL + `WebGPUFeatureRenderers.ts` registration/import + `Globe.js` call/destroy-cleanup + the `_webgpuAtmosphere*` fields in cesium-js-types.d.ts. `FeatureRendererKey.GROUND_ATMOSPHERE` (29) deprecated IN PLACE (slot reserved, never renumber). The full-Nishita reference implementation lives in git history at `05b6da60d1`. FEATURE_INVENTORY §B updated. Verified: tsc clean, build green, ground-atmosphere probe (`probe-ground-atmosphere.mjs`) renders horizon glow with 0 errors.
- **NEW-DERIVEDCOMMAND-VARIANT-FACTORY** (M/L) — rewrite `WebGPUDerivedCommand.ts` as the REAL centralized pipeline-descriptor-variant layer (replaces NEW-WEBGPUDERIVEDCOMMAND-ORPHAN, resolved-as-keep Batch 239 per owner directive: the file is live scaffolding, not an orphan to delete). Current state (re-documented truthfully in the module docstring, Batch 239): the architecture's structure half IS live — `selectCommandVariant` + the `cmd.derivedCommands.{picking,depth,shadows}.*` structure dispatch every frame — but the factory half never wired (`createDerivedCommand`/`create*DerivedCommand` zero callers; the `_depthOnly`/`_logDepth`/`_pickMode`/`_hdrMode`/`_shadowMode` flags they set are unread; `_pipelineCache`/`_shaderCache` never populated). The fork matured around per-renderer variant creation instead. The work: turn the factory into the descriptor-mutation + shader-module-swap layer its header describes, **first consumer = the NEW-COLLECTIONS-LOG-DEPTH epic** (one uniform depth transformation across EVERY collection+globe pipeline — exactly what a descriptor-variant layer is for), then absorb the duplicated per-renderer pick/velocity/depth variant code incrementally, and enforce invariants centrally (e.g. the MSAA-bake rule — makes the Batch-228 Cloud pass-kill bug class impossible). FEATURE_INVENTORY §B re-tagged SHIPPED → SCAFFOLDED.
- **NEW-WEBGL-ONLY-CLUSTER-EXPORT-GATING** — ✅ SHIPPED (Batch 224). The Slice-5d cluster re-exports (`WebGPUCluster{Bounds,Assign,Debug}Renderer`, `WebGPUClusteredLightingDispatcher` + 11 constants) were appended UNCONDITIONALLY to both the engine `index.js` and the variant entry barrel (`scripts/build.js`), so `buildCesiumWebGLOnly` failed ESM static-named-re-export linking against `emptyModule.js`. Moved them into `index-wgsl.js` (engine) and behind the existing `if (variant !== "webgl-only")` gate (entry barrel, re-exporting from `index-wgsl.js`) — the same pattern the WGSL-preprocessor + WebGL-compat-stub re-exports already use. Verified: `buildCesiumWebGLOnly` exit 0 (was a hard link error); dual build still exports the cluster symbols (probes + Sandcastle unaffected). Remaining: **NEW-VARIANT-CI** (add a CI job running `buildAllVariants` + `variant-smoke-test.mjs` so this can't silently regress) — tracked separately.
- **NEW-INDEXWGSL-CHURN** (S) — `packages/engine/index-wgsl.js` is a TRACKED generated barrel, but the pre-commit prettier hook reformats the committed copy while `gulp build` regenerates the unformatted form — so the file re-dirties on every build (perpetual status churn; bit the Batch 228/229/231 commits, each had to `git checkout --` it first). Fix: make `createIndexJs`'s `wgslContents` emitter produce prettier-stable output (or add the file to `.prettierignore` and commit the raw generated form once). One-file build-script change.
- **NEW-CAMERA-JITTER-ACCUMULATION** — Camera jitter accumulates unboundedly on a stable frustum. proj[8]/[9] += jitter mutates the cached matrix that early-returns unchanged; set absolute base+jitter or apply delta and restore; add a stable-frustum bounded-drift spec.

### HIGH — Axis B (fork drift vs upstream)

> **Re-framed per owner decision (2026-06-11) — see [FORK_DRIFT_ANALYSIS_2026-06-11.md](FORK_DRIFT_ANALYSIS_2026-06-11.md).** The owner's lens is fix-forward + improve the product; future merge cost is NOT a goal. Therefore: **`NEW-FORK-MODERNIZATION-REVERT` and `NEW-CAMERA-UPDATEVIEWMATRIX-REVERT` are DECLINED as reverts** (modernization is product direction — stays). The Axis-B value is in (a) pulling upstream FIXES/FEATURES that improve our fork (pickModel #13433, BufferPointCollection #13465, the imagery-layers guard below, ground-prim showsUpdated #13366, …), (b) fixing forward the regressions our modernization introduced (`NEW-FORK-MODERNIZATION-REGRESSIONS` below), and (c) restoring JSDoc. Context stays ours (GraphicsContext class is the better architecture); PickId is a rebase-onto-upstream candidate IFF our delta is small. See the writeup for the full prioritized plan.

- **NEW-FORK-MODERNIZATION-REGRESSIONS** — ✅ RESOLVED (Batch 237, verify-then-fix audit + one NEW live fix). All three suspected regressions were verified against upstream (`git show upstream/main:<path>`, merge-base `0becdbfc17`). Findings: (a) **`Resource.contains` does not exist** as a method in either tree — the drift-doc label conflated Axis-B findings; the documented Resource regression pair was `parseUrl` (BUG-35.1 subpath-base path loss + BUG-35.2 data/blob `null`-origin corruption), fixed in `332a8efac2` (Session 35) and verified still fixed. **BUT the verification surfaced a third, LIVE `parseUrl` divergence** (BUG-237.1): in the no-scheme/no-base branch, `cleanUrl = parsed.pathname` (i) dropped the authority of protocol-relative URLs (`"//tiledArcGisMapServer.invalid/"` → `"/"` — `ArcGisMapServerImageryProviderSpec` "fromUrl resolves … with Resource parameter" was failing on main) and (ii) re-rooted bare-relative URLs (`"Assets/foo.json"` → `"/Assets/foo.json"`). Fixed forward (Batch 237): the no-base branch now keeps the original form verbatim minus query/fragment, matching upstream urijs `uri.toString()`. Targeted run: `gulp test --includeName Resource` 397/397 (was 1 FAILED + 394), TimeIntervalCollection 87/87. (b) **`TimeIntervalCollection.contains`** was broken by the indexof-to-includes codemod, already fixed back to upstream-identical `return this.indexOf(julianDate) >= 0;` in `17441c3af9` (BUG-WEBGL-TIMEINTERVAL-CONTAINS-STALE) — verified identical, no change needed. (c) **`Animation.js` childNodes** text-node bug was already patched (flush-left continuations + `// prettier-ignore` guard); the `themeEle.innerHTML` literal is byte-identical to upstream's — verified, no change needed. All of the above (plus the imagery-layers guard below) are locked by `Tools/upstream-regression-check.mjs` (18 standalone Node checks against upstream-expected outputs; negative control: the pre-fix imagery guard fails exactly the empty-array check) + 2 new `ResourceSpec` regression specs.
- **NEW-UPSTREAM-IMAGERYLAYERS-EMPTY-GUARD** — ✅ SHIPPED (Batch 237). `ModelRuntimePrimitive.configurePipeline` now requires `model.imageryLayers.length > 0` (not just `defined`) before pushing `ImageryPipelineStage` — upstream-identical guard; affects WebGL too. Evidence: 2 new specs in `ModelRuntimePrimitiveSpec.js` (empty array → stage absent; non-empty → present) + `Tools/upstream-regression-check.mjs` items [1] (3 checks incl. `undefined`), with a negative control showing the pre-fix file fails the empty-array check.
- **NEW-UPSTREAM-PICKMODEL-13433** — ✅ SHIPPED (Batch 238). Ported upstream #13433's three source fixes into our PRE-refactor `pickModel` structure (upstream's `ModelReader.forEachPrimitive` refactor itself NOT adopted — our pickModel keeps the inline loop): (a) **non-worldspace instance composition** in `pickModel.js` — `computedModelMatrix * instanceTransform` (was `transform * computedModelMatrix`, which left CPU-picked instances at un-axis-corrected glTF positions); (b) **`ModelReader.octDecode` argument order** — `octDecodeInRange(c.x, c.y, range, c)` + `Cartesian3.pack(c, array, i*3)` (both were swapped; the first threw "result is required" — this also unblocks any oct-encoded path through `readAttributeAsTypedArray` used by EdgeVisibility/vector-tile/imagery-mapping readers) + the SAME swapped-args bug inline in `pickModel.getVertexPosition` (upstream fixed it implicitly by routing through ModelReader); (c) **`InstancingPipelineStage`** — `defined(rotationAttribute) || keepTypedArray` so translation-only instanced models keep REAL 4x3 matrices for CPU pick instead of the vec3 path's 2D-projected translations garbage (no-op on WebGL2 where `keepTypedArray` is false; matters on WebGPU where `supportsSynchronousReadback` forces it true). Evidence: `Tools/upstream-regression-check.mjs` [5] (3 checks, octDecode round-trip; pre-fix: throw) + `Tools/visual-regression/probe-pickmodel-instanced.mjs` (WebGL GPU-render-anchored: pre-fix CPU pick hit 0/42 GPU-confirmed instance pixels; post-fix 42/42 within tolerance). **Residual (small):** translation-only instanced models on WebGL2 still pick as if un-instanced (no transforms buffer/typed array exists on that path) — upstream covers this via `ModelReader.computeInstanceTransformsFromAttributes` (part of the #13433 refactor); port it if/when WebGL2 translation-only pick is needed.
- **NEW-WEBGPU-INSTANCED-VA-DIVISORS** — 🔴 NEW (found by the Batch-238 probe baseline; pre-existing on main since the v1.140 upstream merge). ANY instanced model (vec3 OR matrix instancing path) crashes the WebGPU render loop: `VertexArray` bind runs `context._vertexAttribDivisors[index] = this.instanceDivisor` (VertexArray.js:123) but `WebGPUContext` never initializes `_vertexAttribDivisors` — the `glVertexAttribDivisor` no-op compat stub exists (WebGPUContext.ts:756), the divisors array next to it was missed. Symptom: `TypeError: Cannot set properties of undefined (setting '1')` at `attr.vertexAttrib` → `buildDrawCommandForModel` → "Rendering has stopped"; model never reaches `ready`, so WebGPU CPU pick of instanced models is unreachable too. Fix sketch: initialize the divisors array (+ `_previousDrawInstanced`) alongside the existing stub, then verify what the previously-crashing instanced draw path actually renders. Verification ready to flip on: `PROBE_WEBGPU=1 node Tools/visual-regression/probe-pickmodel-instanced.mjs` (render smoke for both instancing paths + exact-value WebGPU CPU picks at (0.5,±2,±2)).
- **NEW-CONTEXT-PICKID-MERGE-PRESTAGE** — Context.js content conflict + PickId.js add/add conflict (confirmed via merge-tree). At sync, take upstream PickId.js as base, re-apply normalizedRgba/pickKinds, align the @ts-check header; document Context.js manual resolution in the sync runbook.
- **NEW-MODEL3DTILECONTENT-DOUBLE-CONVERSION** — Model3DTileContent class-converted on both fork and upstream (no --ours/--theirs). Prefer upstream's class body (richer @import/@implements typing) wholesale and re-apply fork deltas at merge.
- **NEW-FORK-MODERNIZATION-REVERT** — ⛔ DECLINED (owner decision 2026-06-11; see FORK_DRIFT_ANALYSIS). The review recommended reverting ~15 cosmetic ES6 conversions to cut merge surface. Modernization is product direction and merge-cost is not a goal, so the conversions STAY. Kept here as "considered, declined" so the call is visible. (The regressions the conversion pass introduced are fixed forward via NEW-FORK-MODERNIZATION-REGRESSIONS, not by reverting.)
- **NEW-VOXELELLIPSOIDSHAPE-UPSTREAM-COLLISION** — VoxelEllipsoidShape class rewrite frozen behind an upstream UV-uniform rewrite. Revert to upstream form; upstream replaced the longitude/latitude UV uniforms with scale/translate the fork must adopt anyway.
- **NEW-CAMERA-JSDOC-RESTORE** — Restore ~80% public-API JSDoc/@example loss on Camera/SSCC. Re-add shipped @example blocks and full @param prose (setView/lookAt etc.) per the preserve-JSDoc rule; these feed cesium.com API docs.
- **NEW-WEBGL-REPROJECT-BASELINE** — WebGL imagery reprojection forked to per-fragment Mercator; add a regression baseline. The 64-row-grid -> 4-vertex-quad change forks WebGL pixel output; add a visual-regression tolerance baseline asserting it matches upstream.

### MEDIUM / LOW (23)

Catalogued in the audit doc + sidecar JSON (not expanded here to keep this index scannable). IDs: `NEW-MODEL-IBL-REFERENCE-FRAME`, `NEW-MODEL-DIRECT-BRDF-PARITY`, `NEW-MODEL-VS-MOTION-GATE`, `NEW-GLOBE-DYNAMIC-OFFSET-UBO`, `NEW-COLLECTIONS-ERROR-SENTINELS`, `NEW-COLLECTION-RENDERER-BASE`, `NEW-VARIANT-CI`, `NEW-DECOUPLEDSCAN-FORWARD-PROGRESS-GUARD`, `NEW-BINDGROUPCACHE-EVICTION`, `NEW-RENDERBUNDLE-AGING-DECOUPLE`, `NEW-RESOURCEMANAGER-KEY-EVICTION`, `NEW-CLUSTERED-ASSIGN-BOUNDS-DIRTY`, `NEW-CLUSTER-MULTIFRUSTUM-BOUNDS`, `NEW-TAA-PIPELINE-ORDER-RECONCILE`, `NEW-USEWEBMERCATORT-SINGLE-SOURCE`, `NEW-UPLOADIMAGESOURCE-OBSERVABILITY`, `NEW-RAYSPHERE-PRECISION-BACKPORT`, `NEW-CAMERA-UPDATEVIEWMATRIX-REVERT`, `NEW-BILLBOARD-UPDATEMODE-ORDERING`, `NEW-SHADOWMAP-COMMENT-RESTORE`, `NEW-SYNC-MOVEMAP`, `NEW-CAPABILITY-GETTER-CODIFY`, `NEW-TS-CONVERT-JS-RENDERERS`.

---

## 2026-06-11 — Large Dynamic Objects roadmap (32 new IDs)

Full roadmap + regime→architecture decision table + per-phase design: [LARGE_DYNAMIC_OBJECTS_DESIGN.md](LARGE_DYNAMIC_OBJECTS_DESIGN.md). Owner-directed: pick architecture by UPDATE REGIME (sparse→partial-write; dense-arbitrary→flat-buffer+WASM; dense-derivable/orbital→GPU-compute; 100k+ arbitrary→ECS-worker). Scoped by the `large-dynamic-objects-roadmap-scope` workflow (6 agents, grounded in fork code). **Step 0 shipped: billboard (b4a9e58fd9) + label glyph (7e24700f8a).** Most substrate already exists in-tree (compute engine, storage-buffer pool, SoA Buffer* collections, WASM RTE-encode bridge, weather-particle compute→instanced-draw precedent); the greenfield is SGP4 (Phase 3) + the ECS (Phase 4, likely unnecessary).

### Phase 0 — Dirty-consume parity (extend the billboard/label fix)

- **NEW-DIRTY-CONSUME-POINT** (S) — Point: PointPrimitiveCollection._consumeDirtyState() + call from WebGPUPointPrimitiveRenderer:1007 after buildInstanceData. Exact billboard analog. Add method near PointPrimitiveCollection.js:585 (clear per-point _dirty, _pointPrimitivesToUpdateIndex=0, _createVertexArray=false, zero _propertiesChanged[]); call after buildInstanceData. Genuine per-frame-CPU fix — shared scene-logic re-touches every point. Verify needsRebuild (:960) stops firing once queue drains.
- **NEW-DIRTY-CONSUME-POLYLINE** (S) — ✅ SHIPPED (Batch 228). Bucket-aware `PolylineCollection._consumeDirtyState()` (per-polyline `_clean()` — resets `_dirty` + zeros that polyline's own `_propertiesChanged` — then drains `_polylinesToUpdate`, clears `_polylinesUpdated`/`_createVertexArray`, zeros collection `_propertiesChanged`), called at the end of `updateWebGPUPolylines`. Verified (probe-polyline-cloud-consume.mjs): static `_updatePolyline` 0/frame, queue drained, a modified polyline still re-enqueues, polylines render (1483 cyan px).
- **NEW-DIRTY-CONSUME-CLOUD** (S) — ✅ SHIPPED (Batch 228). `CloudCollection._consumeDirtyState()` (per-cloud `_dirty`, `_cloudsToUpdateIndex=0`, `_createVertexArray=false`, `_cloudsRemoved=false` — redundant-but-harmless, `removeClouds` runs in shared logic before the FR branch — zero `_propertiesChanged[]`), called every frame in `WebGPUCloudRenderer` after the rebuild block (NOT just on rebuild; the rebuild gate reads dirty state BEFORE this consume — read-before-consume ordering shipped with NEW-CLOUD-REBUILD-DIRTY-GATE, Batch 233). Verified: static `_updateCloud` 0/frame, queue drained.
- **NEW-CLOUD-SCENEFB-PIPELINE-MISMATCH** — ✅ FOUND + FIXED (Batch 228, discovered by the consume probe). The cloud color pipeline never baked the scene-FB MSAA sample count (`multisample` absent → count=1) while the scene framebuffer pass is MSAA — the attachment-state validation error **invalidated the entire pass encoder, so adding a single cloud blanked EVERY primitive in the scene** (confirmed pre-existing at HEAD: baseline probe rendered 0 cyan polyline px with clouds present, 1683 without). Fix mirrors the Billboard Batch-134 pattern: `multisample: {count}` from `context._msaaSamples` baked into the cloud pipeline descriptor + `ms=` keyed into the descriptor name. After the fix: 0 validation errors, clouds render, polylines render in the same scene. (Velocity pipeline untouched — targets the single-sample rg16float velocity texture.)
- **NEW-DIRTY-CONSUME-LABEL-GLYPH** (S) ✅ SHIPPED 7e24700f8a — Label: call existing glyphBillboardCollection._consumeDirtyState() in SDF render path (WebGPULabelRenderer:1012). No new method — reuse BillboardCollection._consumeDirtyState. Label-level _labelsToUpdate already consumed (LabelCollection.js:949); background child already consumed via billboardFR (:1181). Gap: glyph child consumed only on pick frames (:1191-1198); SDF render path builds directly (buildSDFInstanceData :142) without consuming while runSharedSceneLogic re-touches every glyph. Call after buildSDFInstanceData; idempotent with pick-frame consume. Genuine per-frame-CPU fix.
- **NEW-CLOUD-REBUILD-DIRTY-GATE** (S) — ✅ SHIPPED (Batch 233). The rebuild gate in `WebGPUCloudRenderer` now reads `_cloudsToUpdateIndex > 0 || _createVertexArray` BEFORE the Batch-228 `_consumeDirtyState()` call clears them (the read-before-consume ordering the consume comment documented), so per-cloud property edits (position/scale/brightness/color) trigger an instance-buffer re-upload instead of rendering stale forever. Verified (probe-cloud-property-edit.mjs): pre-fix baseline reproduced the staleness exactly (edit → changedPixels=0, no rebuild); post-fix the edit lands within 2 frames (changedPixels=135041, buffer rebuilt), settled frames after the edit → 0 further rebuilds + drained queue, 0 console errors. probe-polyline-cloud-consume still PASS (consume parity intact).
- **NEW-COLLECTION-RETOUCH-PROBE** (S) — ✅ SHIPPED (Batch 236). `Tools/visual-regression/probe-collections-regression.mjs` — THE consolidated collections gate: all five collections (Billboard / Label / Point / Polyline / Cloud) in ONE close-camera scene (11 km, globe/sky hidden), five checks: (1) every collection renders its own saturated color (magenta/yellow/cyan/red/green — cloud FS emits exact `(0,g,0)` over black via `CumulusCloud.color`); (2) settled re-touch — monkeypatched `_updateBillboard` (collection + label glyph/background children) / `_updatePointPrimitive` / `_updatePolyline` / `_updateCloud` all 0 calls over 20 settled frames; (3) upload gate — billboard/point/label resident-instance managers 0 full rebuilds / 0 partial writes / 0 bytes over the same 20 frames; (4) one mutated primitive of EACH kind renders at its destination window within 2 frames (bb 0→173 px, pt 0→35, lbl 0→21, pl 0→306, cloud 0→6561); (5) 0 console errors. Deterministic (byte-identical counts across runs). Future collection batches run THIS gate instead of the per-collection trio. Gotcha captured in the probe header: cloud placement must respect the ALTITUDE-dependent frustum footprint (first iteration put clouds at the ground-footprint edge → cut off at 5 km altitude, mutation window clamped to nothing).

### Phase 1 — Per-instance partial-write manager (sparse-dynamic regime)

- **NEW-RESIDENT-INSTANCE-BUFFER-MGR** (L) — ✅ SHIPPED (Batch 229). `WebGPUResidentInstanceBuffer.ts`: resident CPU `Float32Array` + GPU vertex buffer + stable `_index→slot` map (slot = COMPACTED visible order over show/_clusterShow, NOT `_index`) + full-vs-partial predicate (`forceFullRebuild` flag from caller, first build, length/stride change, capacity, or any dirty item whose visibility disagrees with its slot-presence — visibility changes always arrive via the dirty list since the show/clusterShow setters makeDirty) + `sync({items,dirtyList,dirtyCount,length,packInstance,isVisible,floatsPerInstance,bytesPerInstance,forceFullRebuild,mirrorPrev}) → {buffer,prevBuffer,visibleCount,fullRebuild,partialWrites}` + slot-aligned velocity prev mirror (partial writes mirror the prev slot with the frame N-1 value BEFORE overwriting current, and catch written slots up next frame; full rebuilds seed prev=current since slots may shift). Debug-pragma counters `_fullRebuilds`/`_partialWrites`/`_bytesUploaded`/`_prevMirrorWrites`. Verified: probe-billboard-partial-write.mjs (static 1000-billboard scene → 0 uploads over 30 frames; 1 moved billboard → exactly 1 partial write of 176 B = 1 stride, renders at the new position) + probe-resident-instance-prev-mirror.mjs (prev-mirror write contract, intercepted writes).
- **NEW-PARTIAL-WRITE-COALESCING** (M) — ✅ SHIPPED (Batch 229, inside the manager). Sort+dedupe dirty slots, merge runs with gap ≤ 4 slots into contiguous writeBuffer ranges; whole-buffer fallback when changed fraction > 40% of visibleCount.
- **NEW-PARTIAL-WRITE-WIRE-BPL** (M) — ✅ SHIPPED (billboard Batch 229; point + label Batch 232). All three renderers sync through the manager with the same load-bearing ordering (dirty list captured BEFORE `_consumeDirtyState()` resets the index).
  - **Billboard (Batch 229):** `buildInstanceData` extracted into `packBillboardInstance(out, off, bb)` + `isBillboardVisible`; `forceFullRebuild` = `_createVertexArray` (read pre-consume) | defines change | sceneMode change | atlas-guid change | MORPHING (morph recomputes every `_actualPosition` without dirtying). Pick path unchanged (full pick build on pick frames, reuses `packBillboardInstance` + pick-color overwrite).
  - **Point (Batch 232):** `packPointInstance` + `isPointInstance` (= `defined` — hidden points KEEP slots since `_show` is packed into the record and the shader collapses hidden quads, so a show toggle is a partial write, never a slot shift); the manager subsumes the former `needsRebuild` all-or-nothing gate; `forceFullRebuild` mirrors billboard minus atlas-guid (points sample no texture); dirty list = `_pointPrimitivesToUpdate[0.._pointPrimitivesToUpdateIndex)` pre-consume; colorCommand recreated per frame (cheap) so defines/blend/visibleCount rotation always lands; velocity command reads the manager's slot-aligned prev mirror; pick path unchanged (per-pick-frame full build).
  - **Label (Batch 232) — deliberately full-rebuild-on-ANY-dirty:** `packSDFGlyphInstance` + `isGlyphVisible` (`defined && show` — spare glyphs parked by `rebindAllGlyphs` hold no slot); `forceFullRebuild` = `glyphDirtyCount > 0` | glyph `_createVertexArray` | defines | sceneMode | **atlas-guid** | MORPHING. Glyph dirty granularity is NOT sound for per-slot partial writes (`repositionAllGlyphs` mutates `_labelDimensions`/`_labelHorizontalOrigin` via direct field writes that never makeDirty; `rebindAllGlyphs` re-purposes spare billboards across labels, shifting the compacted slot map in ways one dirty entry doesn't describe), so any dirty frame re-packs the whole glyph stream — conservative-correct per the Phase-1 scope note. The big win stands regardless: a SETTLED label collection uploads NOTHING, where pre-Batch-232 it re-packed + re-uploaded every glyph every frame.
  - **Verified (probe-point-label-partial-write.mjs):** 1000 points + 200 labels settled → 0 full rebuilds / 0 partial writes / 0 bytes on BOTH managers over 30 frames; moving 1 point → exactly 1 partial write of exactly 112 B (1 point stride), 0 full rebuilds, renders at the new position (cyan 0→34 px); 1 label text change ("i"→"WWWW") → 2 full rebuilds / 0 partials on the label manager only (points untouched), new text renders (yellow 9→137 px); 0 console errors. Regression: probe-billboard-partial-write + probe-polyline-cloud-consume + probe-orbital-catalog + probe-compute-instance-generic all PASS.
  - NOTE: ~~the velocity prev-mirror gate `frameState.scene?.taaEnabled` is DORMANT~~ — RESOLVED Batch 234 (NEW-COLLECTIONS-TAA-GATE-DORMANT shipped): the gates read the canonical `frameState.taaEnabled` now and the prev mirror has a live end-to-end consumer (probe-taa-velocity-emission.mjs exercises billboard + point velocity with the slot-aligned prev buffer wired as the second vertex stream).
- **NEW-COLLECTION-RENDERER-BASE** (M) — Shared base for the 4 collection renderers; fold the resident-instance manager in. Already tracked (audits/2026-06-11_ULTRA_REVIEW_findings.json:231) — ~3000 LOC duplicated across the 4 collection FRs. Build the manager standalone first; fold into the base last to avoid scope creep. Update DEFERRED_WORK.md:43-45 (close NEW-COLLECTIONS-DIRTY-GATE) + FEATURE_INVENTORY when shipped.

### Phase 2 — Flat-buffer Buffer* + WASM encode (dense-arbitrary regime)

- **NEW-WASMRTE-SUBRANGE-ENCODE** (S) — Sub-range variant of WasmRTEBridge.batchEncode (encode dirty [offset,count) at offset). batchEncode (WasmRTEBridge.js:76) encodes only from index 0 (subarray(0,total) at :106). Add a sub-range variant + matching JS fallback; unit test vs scalar EncodedCartesian3 (fround math already byte-exact). Extend, don't recreate (no-shortcuts principle).
- **NEW-BUFFERCOLL-WASM-ENCODE-WIRE** (M) — Route WasmRTEBridge encode into WebGPU+WebGL Buffer* repack hot paths, threshold-gated. batchEncode has ZERO consumers; both WebGPUBufferPointRenderer.repackPointDirty (:284-340) and renderBufferPointCollection.js:106-156 encode per-primitive via EncodedCartesian3. Gate on _dirtyCount>=threshold, feed contiguous _positionView slice (points vertexOffset==index), keep color/pick/outline interleave in JS. Instantiate bridge on PointCache, destroy on teardown. Async load -> first frames use JS fallback (byte-exact).
- **NEW-UPSTREAM-13465-BUFFERPOINT-STALENESS** (S) — Port upstream #13465 BufferPointCollection update-staleness fix + regression spec. FORK_DRIFT_ANALYSIS_2026-06-11.md:101. Position changes don't re-render (likely marks BV dirty but not primitive _dirty, so repack skips). Correctness bug that invalidates any perf benchmark — land before/with the WASM encode wiring.
- **NEW-BUFFERCOLL-ENCODE-BENCHMARK** (M) — Benchmark 10k/50k/100k bulk-update repack scalar-JS vs WASM both backends + visual-regression probe. Tune threshold; Playwright probe confirms no visual regression vs WebGL (Principle 8). Win may be modest if writeBuffer GPU upload dominates over CPU encode at these counts — measure before claiming. Depends on the WASM-encode wiring + #13465 fix.
- **NEW-WASM-WIDE-INSTANCE-KERNEL** (L) — Optional wider WASM kernel: position high/low + RGB8 color/outline in one pass for Polygon/Polyline. Add batch_encode_point_instances in rte_encode.rs, bump WASM version (lib.rs:193 + WasmFeatureDetection EXPECTED_WASM_VERSION), route Polygon/Polyline repack (non-contiguous index->vertex, not a simple slice). Only if benchmark shows the JS color-pack loop is the residual bottleneck. Needs Rust rebuild.
- **NEW-UPSTREAM-13448-READONLY-PROPS** (S) — Next-sync note: #13448 Buffer* modelMatrix/BV readonly + Node 22 (breaking change, not a now-pull). Track for the next full upstream merge, NOT a now-pull. Ensure new encode code doesn't write modelMatrix/boundingVolume post-construction; shapes how the encode path updates the bounding volume.

### Phase 3 — GPU-resident compute-instance system + storage-buffer draw (dense-derivable; WebGPU-first headline; orbital = demo content since Batch 231)

- **NEW-COMPUTE-INSTANCE-SYSTEM** (M) — ✅ SHIPPED (Batch 231). Owner-directed rework of the Batch-230 orbital catalog: the ENGINE feature is the feature-agnostic "N instances whose per-instance data lives in a GPU storage buffer, repopulated each frame by a pluggable USER-SUPPLIED WGSL compute kernel, drawn as instanced vertex-pulled quads — the CPU uploads only a time scalar". The engine keeps ZERO orbital domain knowledge: the circular-orbit element layout, the propagation kernel, and the LEO/MEO/GEO catalog generation now live wholly in the "WebGPU Orbital Catalog" Sandcastle + `probe-orbital-catalog.mjs`. Pieces: `Scene/ComputeInstanceCollection.js` (kernel + `floatsPerInstance` immutable at construction, loud `csm_computeInstance` validation, flat param lanes, `_consumeDirtyState` discipline, sim time from `frameState.time` − epoch BEFORE the FR branch) + `Renderer/WebGPU/WebGPUComputeInstanceRenderer.ts` (composes `const FLOATS_PER_INSTANCE` prologue + `ComputeInstanceScaffold.wgsl` + user kernel at pipeline build; composed modules cached per composed-source string per device — NOT under a ShaderSourceId; kernel hash keyed into compute-pipeline-cache names) + `ComputeInstanceRender.wgsl` (renamed from `OrbitalCatalogRender.wgsl`; render now pulls position/color/pixelSize from the 64-B instance record the kernel output writes, so the render side never sees the user's param layout). Kernel contract (UserPostProcessStage precedent): user defines `fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {position, color, pixelSize}` reading `params: array<f32>` + injected `FLOATS_PER_INSTANCE`; the engine owns bindings, entry point, bounds check, and the RTE high/low split + write (users never touch RTE). Renames in place (add-only registries): FR key `ORBITAL_CATALOG_COLLECTION` → `COMPUTE_INSTANCE_COLLECTION` (slot 49 kept), ShaderSourceId 34 → `COMPUTE_INSTANCE_SCAFFOLD`, 35 → `COMPUTE_INSTANCE_RENDER`; `OrbitalPropagate.wgsl` deleted from the engine (its math is the demo kernel now); `OrbitalCatalogCollection.js` deleted (shipped hours earlier, unpublished — Sandcastle was the only consumer). Probes: `probe-orbital-catalog.mjs` (regression gate — equivalent numbers vs the Batch-230 baseline: 15289 px @ frame 15, 187.2% mask change, 0 errors) + `probe-compute-instance-generic.mjs` (NON-orbital rotating-Lissajous kernel — feature-agnosticism proof: 6552 px, 177.4% mask change, 0 errors).
- **NEW-ORBITAL-DATA-MODEL** (S) — Orbital element data model + buffer layouts; decide RTE-encode location (1-pager). Element SSBO (mean elements/Keplerian per object), per-frame time uniform, RTE high/low output SSBO. Decide kernel-emits-camera-relative (weather precedent) vs absolute-ECEF high/low + vertex-shader-subtract (point precedent, reuse PointPrimitiveColor.wgsl:84). Wrong choice reintroduces planetary-scale jitter.
- **NEW-ORBITAL-DEVICE-LIMITS-PROBE** (S) — Validate storage/compute device limits for 1M-element target; single- vs multi-binding split. maxStorageBufferBindingSize default 128MB (~5.6M RTE positions / ~2.7M full records per binding); WebGPUDevicePool.ts:120-180 negotiates up to adapter ceiling. Probe maxComputeInvocationsPerWorkgroup / maxComputeWorkgroupsPerDimension. 1M+ may force a multi-SSBO scheme (elements SSBO + positions SSBO).
- **NEW-ORBITAL-J2-KERNEL** (M) — *(re-labeled Batch 231: KERNEL-LEVEL DEMO UPGRADE — propagation kernels are user/demo WGSL content now, not engine code; the engine-side piece would be reusable df64 helper functions injectable into kernel scaffolding, plus GMST/Earth-rotation likewise rides the kernel.)* Simplified secular-J2 mean-element propagator in WGSL (validate pipeline before SGP4). Read element[i]+time -> ECEF -> RTE-encode -> write position[i]. Mirror WeatherParticles.wgsl struct+dispatch. Far simpler than full SGP4/SDP4; validates end-to-end pipeline. Needs a stated FP32 tolerance + CPU FP64 reference to diff against.
- **NEW-ORBITAL-GPU-RESIDENT-RENDERER** (M) — ✅ SHIPPED (Batch 230, circular-orbit MVP). `WebGPUOrbitalCatalogRenderer.ts`: element catalog uploads once to a storage buffer, `OrbitalPropagate.wgsl` (workgroup 64, one invocation/object) propagates circular orbits per frame into a PositionHL (RTE high/low, 32 B) storage buffer, instanced draw vertex-pulls `positions[instance_index]` + color/size from the elements SSBO (`OrbitalCatalogRender.wgsl`). Per-frame CPU upload = time scalar + camera UB only. Compute on its own encoder + immediate submit (weather pattern — queue order places it before the scene submit). Scene-FB pipeline bakes `multisample {count: _msaaSamples}` (Batch-228 rule). Probe: `probe-orbital-catalog.mjs`. **Remaining in-scope follow-ups:** kernel low-part is always 0 (f32 math; df64 angle/trig upgrade rides NEW-ORBITAL-J2-KERNEL), Earth rotation/GMST skipped (ECI≈ECEF), ~~no TAA motion vectors for GPU-resident points, command has no boundingVolume (no per-frustum cull)~~ — both RESOLVED Batch 235 (see NEW-COMPUTE-INSTANCE-BV-TAA below). **Batch 231:** generalized into NEW-COMPUTE-INSTANCE-SYSTEM — `WebGPUOrbitalCatalogRenderer.ts` → `WebGPUComputeInstanceRenderer.ts`, `OrbitalCatalogRender.wgsl` → `ComputeInstanceRender.wgsl`, `OrbitalPropagate.wgsl` deleted (its math is the Sandcastle/probe kernel now); the listed follow-ups carry over to the generic system (see the re-labels below).
- **NEW-ORBITAL-CATALOG-COLLECTION** (M) — ✅ SHIPPED (Batch 230). `Scene/OrbitalCatalogCollection.js`: owns element records (`add({semiMajorAxis, inclination, raan, phase, meanMotion, epochOffset, color, pixelSize})`, meanMotion defaults to sqrt(GM/a^3)), `_catalogDirty` consumed by the FR each frame (`_consumeDirtyState` discipline), simulation time derived from `frameState.time` − `epoch` BEFORE the FR branch (scene-logic-extractor). FR key `ORBITAL_CATALOG_COLLECTION: 49`. Renders nothing on WebGL until NEW-ORBITAL-SGP4-WASM-WORKER lands. Sandcastle: "WebGPU Orbital Catalog". **Batch 231:** DELETED from the engine (shipped hours earlier, unpublished; the Sandcastle was the only consumer) — replaced by the generic `Scene/ComputeInstanceCollection.js`; FR key renamed in place to `COMPUTE_INSTANCE_COLLECTION` (slot 49 kept); the orbital element API is now demo-owned param lanes + a demo WGSL kernel.
- **NEW-ORBITAL-SGP4-KERNEL** (L) — *(re-labeled Batch 231: KERNEL-LEVEL DEMO UPGRADE — ships as a demo/user kernel snippet for `ComputeInstanceCollection`; FP64 pre-conditioning happens in the demo's JS param packing.)* Full near-earth SGP4 in WGSL + FP64 mean-element pre-conditioning + reference-vector validation (defer SDP4). Greenfield (zero existing orbital code). Dominant Phase-3 effort. FP32 WGSL drifts vs FP64 reference SGP4 (deep-space SDP4 resonance terms especially) — needs CPU FP64 pre-conditioning + a documented position-accuracy budget; validate vs python-sgp4 / Vallado vectors. Cap v1 at near-earth SGP4, defer SDP4.
- **NEW-ORBITAL-SGP4-WASM-WORKER** (L) — *(re-labeled Batch 231: GENERIC-SYSTEM UPGRADE, tracked as **NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK** — a worker/WASM kernel host that writes the same 64-B instance-record buffer `ComputeInstanceRender.wgsl` reads, for ANY collection; SGP4 itself is demo content riding that host.)* WebGL2 fallback: SGP4-on-worker WASM bridge writing the same SoA RTE position buffer. WebGL2 has no compute. New Rust crate alongside packages/wasm / wasm-naga; writes the same SoA RTE position buffer the WebGL instanced/BufferPoint draw reads (match WebGPUBufferPointRenderer.ts:108-119 so one quad/fragment shader serves both). destroy/free_buffer/version/SIMD/JS-fallback per WASM strategy; threshold-gated; double-buffered with 1-frame staleness tolerance like the cull/sort readback rings.
- **NEW-COMPUTE-INSTANCE-BV-TAA** (M) — ✅ SHIPPED (Batch 235). The two generic-system upgrades carried over from the Batch-230 follow-up list. **(1) Bounding volume:** positions are GPU-resident so the engine cannot derive a BV — new documented `ComputeInstanceCollection` option/property `boundingSphere` (user contract: "every kernel-producible position fits in this sphere"; cloned on assignment; `undefined` keeps the historical never-culled, bin-into-all-frusta behavior). Renderer refreshes `command.boundingVolume` + `command.cull` per frame. Measured effect: orbital probe 15286→14156 magenta px — NOT lost dots; bin count 2→1 verified (no-BV commands bin into both frusta and double-blend dot edges; the BV command's max distance 7.9e7 < frustum-1 near 1e8 bins it once). **(2) TAA prev-position velocity:** two instance-record buffers ping-pong (kernel writes `instanceBuffers[pingPongIndex]`, the other slot = last frame's output binds as `prevInstances` @binding(2), statically used only by the new `vertexVelocityMain`/`fragmentVelocityMain` in `ComputeInstanceRender.wgsl`); `cmd.velocityCommand` (rg16float NDC delta, rasterize-at-current; current = RTE mvpRelativeToEye, prev = full previousViewProjection×(high+low) — cloud/point precedent) attaches ONLY when canonical `frameState.taaEnabled` (Batch 234) is on. Zero-cost off path: partner buffer + velocity BGL/pipeline/bind groups allocate lazily on the first TAA-on frame; emission starts one frame later (fresh partner = no seed copy). Verified: `probe-compute-instance-generic.mjs` assertions D/E/F (BV on command + radius/cull, TAA ON velocityCommand + partner allocated + 0 validation errors, TAA OFF detach) + `probe-orbital-catalog.mjs` with the BV supplied; Sandcastle supplies the sphere.
- **NEW-ORBITAL-GPU-PICKING** (M) — *(re-labeled Batch 231: GENERIC-SYSTEM UPGRADE — picking for GPU-resident `ComputeInstanceCollection` instances generally; ~~same for TAA motion vectors and the missing command boundingVolume/per-frustum cull~~ — those two SHIPPED Batch 235 as NEW-COMPUTE-INSTANCE-BV-TAA.)* Picking for 1M GPU-resident points (GPU pick pass / coarse BV prefilter) + Sandcastle + parity probe. No CPU position to hit-test for GPU-resident geometry; no upstream pattern. GPU pick pass or coarse CPU bounding-volume prefilter. Plus a Sandcastle demo + visual-regression probe (WebGL WASM vs WebGPU compute parity — diff sensitive to FP32 propagation drift). May defer to a follow-up.
- **NEW-ORBITAL-INVENTORY-TRACK** (S) — Add NEW-ORBITAL-GPU-RESIDENT to DEFERRED_WORK + FEATURE_INVENTORY (regime currently untracked). This regime is in neither DEFERRED_WORK.md nor FEATURE_INVENTORY §D. Add a tracking entry, document the element/time/output contract in a design doc, move §D->§C as it ships (Principle 6 — load-bearing for impact analysis).

### Phase 4 — ECS-in-WASM-on-worker (conditional; gate before building)

- **NEW-ECS-WORKER-GATING-SPIKE** (M) — GATING SPIKE: measure main-thread WASM-encode ceiling on the SoA Buffer* path (the go/no-go number). Build the flat-SoA + WASM-encode main-thread path on BufferPointCollection and instrument the encode/upload ceiling (objects/frame at 60fps) for ARBITRARY per-frame updates. Pure measurement on existing substrate; the decision gate for the whole phase. ecs-worker is LIKELY UNNECESSARY if regimes 2+3 cover the real target.
- **NEW-ECS-HEADLESS-WORKER-SPIKE** (M) — SPIKE: headless TaskProcessor sim worker (NOT RendererWorker); measure transfer cost vs main-thread. createTaskProcessorWorker adapter (transferableObjects :59), NOT the DOM-blocked scene-in-worker RendererWorker (9-13wk per OPTION_B). Trivial position-integration system over SoA arrays returning a packed instance ArrayBuffer via transferable. If postMessage-transfer cost dominates, ecs-worker is dead-on-arrival without SAB.
- **NEW-ECS-SUBSTRATE** (L) — ECS substrate: component-array registry + archetype/sparse-set allocator (generational ids, free-list) + system scheduler. Greenfield framework (no ECS, no ObjectPool in-fork). Model component arrays on SOABoundingSphereLayout; WASM-bridge seam designed in (mirror WasmCullBridge JS-fallback contract). Pure JS first. Conditional on the gating spike justifying a worker. High over-build risk — keep workload-driven and minimal.
- **NEW-COOP-COEP-SAB-ENABLE** (M) — COOP/COEP headers + SharedArrayBuffer flip with feature-detect fallback. COOP/COEP set NOWHERE today (server.js:179 CORS-only; web.config MIME-only) -> SharedResourcePool/SOABoundingSphereLayout/WasmCullBridge silently fall back to ArrayBuffer. Without SAB the worker can only transfer/copy per frame (zero-copy promise collapses to double-buffered transfer). Enabling COOP/COEP breaks third-party embeds (OPTION_B §5.2) — needs feature-detect + ArrayBuffer-transfer fallback in server.js + web.config.
- **NEW-ECS-WASM-KERNEL** (L) — ECS-in-WASM kernel: hot systems over SAB-backed component arrays in the worker. Port integration/encode systems to WASM (new WasmArenaSlot, version/SIMD, JS fallback per bridge mandate), threshold-gated like WasmCullBridge. SAB-in-WASM-in-worker is the most fragile combination; SIMD detection + JS fallback must both be correct.
- **NEW-ECS-RENDER-UPLOAD-BRIDGE** (L) — Wire worker output into BufferPointCollection / WebGPU storage buffer; RTE high/low; double-buffer. Worker output (SAB view or transferred buffer) -> BufferPointCollection._positionView/_renderContext (WebGL2) and a WebGPU storage/instance buffer the existing instanced draw reads. Worker MUST emit RTE-split positionHigh/positionLow (CLAUDE.md 64-bit rule) not raw f32 or precision breaks at globe scale. Double-buffer to avoid sim/render tearing.
- **NEW-ECS-PRODUCTIONIZE** (L) — Productionize ECS-worker: lifecycle/crash-recovery, picking, compaction, WebGL2 fallback, docs. Long tail: lifecycle (reuse WorkerSceneHost recovery patterns), picking/selection over worker-owned entities, capacity growth/compaction, WebGL2 fallback (WASM-on-worker, no GPU-compute), DEFERRED_WORK/FEATURE_INVENTORY entry. Only reach this if the gating spikes proved the regime-4 workload is real and uncovered by regimes 2/3.

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

### ~~C-R1-CLASSIFICATION~~ — RESOLVED via architectural retirement (Migration Session 5, Batch 85; doc sync Batch 176)

**Original framing:** Classification primitives (ClassificationPrimitive, GroundPolylinePrimitive) need their multi-pass renderState (stencil-depth pass, color pass, pick pass) routed through pipeline variants. Each pass uses distinct stencil/colorMask/depthFunc so WebGPU has to materialize three pipelines and dispatch in order. The audit anticipated needing a new `WebGPUClassificationPrimitiveRenderer` alongside the existing `WebGPUGroundPrimitiveRenderer`.

**Resolution:** The 3-pass stencil-depth technique was **intentionally retired** during Migration Session 5 (Batch 85, ~2026-04-22). The technique is now compiled-but-dormant scaffolding in `WebGPUGroundPrimitiveRenderer.js` lines 7-26 (documents the migration) and lines 97-102 (confirms: "the legacy stencil VS/FS, color VS/FS... were removed alongside their pipeline descriptors. The depth-sample dsColor/dsPick path is now the only classification path"). The replacement `dsColor`/`dsPick` pipelines sample the globe-depth texture (via the effects bind group at `@group(3) @binding(15)`) and discard fragments that don't have a classifiable surface — single-pass, no stencil dance, simpler architecturally.

`WebGPUGroundPrimitiveRenderer.js` covers BOTH `ClassificationPrimitive` and `GroundPrimitive` via the depth-sample classifier; no separate `WebGPUClassificationPrimitiveRenderer` was needed (the audit's anticipated split didn't materialize). `Vector3DTilePrimitive` / `Vector3DTilePolylines` / `Vector3DTileClampedPolylines` follow the same depth-sample pattern in their own renderers.

**Doc-sync note:** This entry stayed flagged as "open" through Batches 85-175 because the doc reconciliation lagged the architectural pivot. Batch 176 audit confirmed the retirement and updated the entry. No code change required.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30 (original framing); Migration Session 5 / Batch 85 (architectural pivot); Batch 176 (doc reconciliation).

### ~~C-R1-COLLECTIONS-PER-ENCODER~~ — RESOLVED (audit 2026-05-02)

**Audit finding (AUDIT_2026_05_02.md D.2):** All five collection renderers forward `renderState` onto their commands today: `WebGPUBillboardRenderer.js:884`, `WebGPULabelRenderer.js:724`, `WebGPUPointPrimitiveRenderer.js:852/991`, `WebGPUPolylineRenderer.js:1112/1273`, `WebGPUCloudRenderer.ts:596`. `WebGPUDrawCommand.execute()` at `WebGPUDrawCommand.ts:500-504` automatically calls `applyPerEncoderState(passEncoder, this.renderState)` when defined. Custom stencilRef / blendConstant / scissor flow correctly.

**Status:** No code change needed; entry preserved as a marker so future audits don't re-investigate.

### ~~C-R1-GLOBE-RENDERSTATE~~ — RESOLVED (Batches 99 + 177 + 182 + 183, doc-sync Batch 219)

All three sub-issues now closed:

- **cullFace** — shipped Batch 99 (`WebGPUGlobeSurfacePipelines.ts:316` derives `disableCulling` and selects `cullMode`).
- **depthMask** — re-audit (Batch 175) confirmed this was never a real gap: the upstream provider always pairs `depthMask = false` with `blending = ALPHA_BLEND`, and the WebGPU heuristic `!isBlend` produces the byte-correct depth-write state for every globe translucency variant.
- **colorMask** — folded into `NEW-GLOBE-TRANSLUCENCY-MULTI-PASS`, which shipped end-to-end in Batches 177 + 182 + 183. The depth-only back-face pre-pass + cull-separated translucent passes use the WebGPU equivalent of `colorMask = false` via `writeMask: 0` on the pipeline's color target.

Batch 219 doc-sync only — code already in place.

**What:** `WebGPUGlobeSurfacePipelines.ts` builds pipeline variants from locally-derived state rather than consuming a literal upstream `command.renderState` blob. The original audit framed this as "the provider sets per-tile depthMask / cullFace, the WebGPU path overrides."

**Resolution (cullFace, Batch 99):** `WebGPUGlobeSurfacePipelines.ts:316` reads `disableCulling` from the renderer's per-frame derivation (cameraUnderground OR globeTranslucent OR `tileProvider.backFaceCulling === false`) and selects between `cullMode: "none"` and `cullMode: "back"`. Mirrors WebGL's `_renderState` vs `_disableCullingRenderState` selection in `GlobeSurfaceTileProviderRendering.js:1226-1231`. The renderer path doesn't dispatch from `command.renderState` because the WebGPU globe surface renderer builds its own `WebGPUDrawCommand`s directly — the variant flags are the intentional pattern, not the WebGL command-dispatcher RS pattern.

**Re-audit finding (Batch 175):** Pre-Batch-175 the entry framed `depthWriteEnabled: !isBlend` at `WebGPUGlobeSurfacePipelines.ts:321` as "ignoring upstream depthMask." Code inspection of `GlobeTranslucencyState.js:720-741` and `GlobeSurfaceTileProvider.js:364-382` shows the upstream provider ALWAYS pairs `depthMask = false` with `blending = ALPHA_BLEND` — the WebGPU heuristic `!isBlend` thus produces the byte-correct depth-write state for every globe translucency variant. **No depthMask gap to close** until the provider's pattern changes; if it does, the same derivation pattern Batch 99 used for cullFace can be added.

**Genuine remaining gap (rescoped):** `GlobeTranslucencyState.js:720-727` sets `colorMask = { red: false, green: false, blue: false, alpha: false }` for the depth-only back-face-only pass (depth pre-pass for translucent globe rendering). The WebGPU globe renderer doesn't currently emit this auxiliary depth-only pass — the entire globe-translucency multi-pass technique (depth-only back-face → translucent back-face → translucent front-face) isn't yet implemented. Filed as `NEW-GLOBE-TRANSLUCENCY-MULTI-PASS` for the dedicated work.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30; Batch 99 cullFace; Batch 175 re-audit + rescope; Batch 176 deeper inspection of existing scaffolding.

---

### ~~NEW-GLOBE-TRANSLUCENCY-MULTI-PASS~~ — depth-only pre-pass + cull-separated translucent back/front passes for translucent globe rendering — RESOLVED (Batches 177 + 182 + 183)

**Resolution:** Shipped as direct command emission from `WebGPUGlobeSurfaceRenderer` rather than fixing the broken `WebGPUGlobeTranslucencyState` scaffolding. The 3-pass technique now fires per tile when `globeTranslucent && !cameraUnderground` and the regular color command flips to `cullMode: "back"`.

- **Batch 177** — Depth-only back-face pre-pass. New `selectDepthOnlyBackFacePipelineHelper` in `WebGPUGlobeSurfacePipelines.ts` builds a variant with `cullMode: "front"`, `depthWriteEnabled: true`, `colorWriteMask: 0`, no blend. Cache-key suffix `_DOB`. Emitted before the regular imagery-layer command when `globeTranslucent && !isSubsequentPass && !debugWireframe && debugFragmentMode === NONE`.
- **Batch 182** — Translucent back-face command + culling-decision split. `selectTranslucentBackFacePipeline` builds a variant with `cullMode: "front"`, `depthWriteEnabled: false`, `blend: ALPHA_BLEND`. Cache-key suffix `_TBF`. Emitted between the depth-only pre-pass and the regular color command. The `disableCulling` decision split out `globeTranslucent` so the regular color command flips from `cullMode: "none"` to `cullMode: "back"` (front-face only) — completing the 3-pass technique.
- **Batch 183 fix** — 3-pass emission gate at `WebGPUGlobeSurfaceRenderer.ts:871-876` extended with `!cameraUnderground` so the underground-and-translucent case correctly takes the legacy single-pass both-faces path (the user's primary intent when underground is "see through the globe", which the 3-pass technique would double-blend).

**Why we pivoted away from the existing `WebGPUGlobeTranslucencyState` scaffolding:** The pre-existing scaffolding mutates `cmd._blendEnabled` / `_depthWriteEnabled` / `_cullMode` between executions, which is non-functional for WebGPU because pipelines bake those fields at creation. Direct command emission with pre-built pipeline variants per cull-mode is the correct WebGPU shape; the broken scaffolding is left in place as forward-looking infrastructure for the eventual `MANUAL_DEPTH_TEST` multi-frustum overlap case (deferred — see C-R8-TRANSLUCENT-MULTI-FRUSTUM).

**Trace:** Batches 177, 182, 183. `WebGPUGlobeSurfaceRenderer.ts:511, 871-948`; `WebGPUGlobeSurfacePipelines.ts:buildPipelineDescriptor` (`depthOnlyBackFace`, `translucentBackFace` flags + `_DOB`/`_TBF` cache-key suffixes).

### ~~C-R1-PRIMITIVE-DERIVED~~ EFFECTIVELY RESOLVED (audit 2026-05-02)

**Audit finding:**

- The `pickCommand` paths (both shader-path and material-path) in `WebGPUPrimitiveCommands.js` already forward `appearance.renderState` — Batch 98 landed this. See `pickCommand` construction at `WebGPUPrimitiveCommands.js:1502-1535` (shader path) and `:2326-2354` (material path), both with `renderState: appearance?.renderState` and explanatory comments. So per-encoder dynamic state (stencilRef, scissor, viewport, blendConstant) flows through pick passes.
- `depthOnlyCommand` and `pickDepthCommand` are NOT emitted by the WebGPU primitive flow — and **have no consumer in the WebGPU dispatch path.** WebGPU primitives use a parallel-array shape (`colorCommands[]` + `pickCommands[]`) rather than the WebGL per-command derived-dictionary shape. The dispatcher in `WebGPUSceneRenderer.ts:188` checks `derivedCommands.depth.depthOnlyCommand` as a fallback, but no Pass dispatch in the WebGPU `executeFrustumLoop` invokes primitives in depth-only mode (shadow casting goes through `executeShadowMapCastCommands` + the dedicated CSM cast pass; globeDepth uses `executeUpdateDepth` which copies post-render). Adding `depthOnlyCommand` emission would be scaffolding without a consumer.

**Status:** Pick variant renderState forwarding is complete. Depth-only variant emission has no consumer to plumb to. Per the dead-code audit rule (CLAUDE.md), not adding scaffolding without a consumer.

**If/when needed:** A future depth-only primitive dispatch (e.g., a real early-z prepass landing for performance) would need both the consumer-side dispatcher hook AND the producer-side `depthOnlyCommand` emission. They should land together.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30; Batch 98 (pick variant renderState); audit 2026-05-02.

### ~~C-R1-TILE-BATCH~~ — RESOLVED (Batch 100, doc-sync Batch 193)

**Resolution:** Per-feature alpha-class pass split shipped end-to-end in **Batch 100**. The 2026-05-07 doc-walk surfaced the entry was stale — implementation is complete.

- `WebGPUModelRenderer.js:124, 598` packs `tileBatchFlags: vec4<f32>` (passClass, opaqueThreshold, _, _) into the material UBO at floats 176-179.
- `ModelPBRComplete.wgsl:241` carries the `tileBatchFlags` UBO field; `fragmentMain` lines 2486-2495 read it and apply per-feature alpha-class discards: opaque pass keeps features with `a >= opaqueThreshold`; translucent pass keeps features with `a` in `[0.004, opaqueThreshold)`. Both passes share the same vertex/index/bind groups; only `tileBatchFlags.x` differs.
- `WebGPUModelRenderer.js:2878` emits two commands per BLEND-with-batch-table primitive (passClass=0 opaque, passClass=1 translucent) — mirrors WebGL's `tile_translucentCommand` derivation in `Cesium3DTileBatchTable.js:325-326`.

The original "z-fighting on overlapping translucent features" symptom no longer occurs on WebGPU.

**Trace:** Batch 100; `WebGPUModelRenderer.js` and `ModelPBRComplete.wgsl` (search for `tileBatchFlags`). Earlier reference: PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

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
| KHR_materials_iridescence | ✅ Analytical (Belcour 2017) | Iridescence block | LUT-free analytical thin-film Fresnel modulation (Snell + TIR + Schlick + Gaussian sensitivity). Shipped Batch 181, supersedes the original LUT design. |
| KHR_materials_sheen | ✅ Full BRDF | "Slice 6" branch at line 1558 | Charlie distribution + Neubelt/Pettineo visibility approximation. |
| KHR_materials_volume | ✅ Full | "Slice 7" branch at line 1642 | Beer-Lambert attenuation on diffuse. Thickness texture sampled. |
| KHR_materials_transmission | ✅ Thickness-coupled | Transmission block | Refraction UV offset modulated by `1 + 4 × thicknessForKHR`; volume thickness sample shared with the volume block. Shipped Batch 176. |

**Remaining work:** All KHR follow-ups originally filed under C-R4-GLTF-KHR
have shipped. KHR_materials_anisotropy (Batch `487ef6478a`),
KHR_materials_iridescence (Batch 181, analytical), and KHR_materials_transmission
(Batch 176, thickness-coupled) are complete. C-R4-GLTF-KHR is fully
resolved.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:101-102;
OVERSIGHT_AUDIT_2026_04_25.md s2; reconciled in Batch 128 (2026-04-30).

---

### ~~NEW-GPU-CULLER-CONSUME-OR-DELETE~~ — RESOLVED (Batch 209) — gpuCuller wired as threshold-gated consumer

**Status:** RESOLVED. Decision: **option (a) — consume from
`_executeOpaquePass`** with the existing 256-command threshold.

**Trace:** Batch 209 (`WebGPUSceneRenderer.ts:_executeOpaquePass`).
The opaque pass now invokes `gpuCullCommands` when
`count >= GPU_CULL_THRESHOLD (256)` and `frameState.cullingVolume`
is available. The CPU cull still runs upstream in `Scene.updateFrameState`;
the GPU pass adds a fine-grained per-frustum re-test that meaningfully
cuts draw-call dispatch at the 10K+ instance scale. 1-frame readback
latency is acceptable at this density. Below threshold the helper
returns the input array untouched — no overhead for typical scenes.

**Bypass:** Pick passes (`config.picking`) skip GPU culling entirely
(Batch 212 audit) so pick fidelity matches the CPU-culled command set.

**Follow-up note:** The old `effectiveCount` parameter was added so the
opaque-pass call site passes the pre-sized `frustumCommands.commands[OPAQUE]`
array directly with the matching `frustumCommands.indices[OPAQUE]`,
avoiding a per-frame slice allocation in the hot path.

---

### ~~NEW-HIZ-SORT-CONSUME-OR-DELETE~~ — RESOLVED (Batches 210 + 211) — both wired as threshold-gated consumers

**Status:** RESOLVED. Decision: **consume both** with thresholds tuned
to each dispatcher's overhead profile.

**Trace:** Batches 210 + 211 (`WebGPUSceneRenderer.ts:_executeOpaquePass`).

- **HiZ occlusion (Batch 210)** — threshold 2000 commands. New
  `_filterByHiZVisibility` (consumer of previous-frame readback) +
  `_dispatchHiZForNextFrame` (producer) pair. Lazy SOA scratch growth
  tracks the largest count seen. Visibility flags survive across
  frames; consumer applies before this frame's dispatch completes.
  Pyramid build + occlusion test + readback all run via the existing
  `FeatureRendererKey.HI_Z_OCCLUSION` registration.
- **GPUSortKeys (Batch 211, Phase 1)** — threshold 5000 commands.
  Generates packed 64-bit sort keys (`sortKeysHigh + sortKeysLow +
  commandIndices`). Phase 2 (the GPU sort over those keys) is the
  follow-up `NEW-GPU-SORT-PIPELINE` entry below — a generic u64
  bitonic / radix sort doesn't exist yet, only the point-specific
  `PointCloudSort.wgsl`.

**Bypass:** Pick passes (`config.picking`) skip both dispatchers
(Batch 212 audit) so pick fidelity matches the CPU-culled command
set. Shadow-cast, OIT translucent, and motion-vector passes all
iterate their own command sets and are unaffected.

**Known interaction (TAA) — verified safe (Batch 222 review):** at
extreme density (>=2000 commands) HiZ-culled objects can transition
from "rendered last frame" → "not rendered this frame", producing
a depth discontinuity at their pixels. The TAA reprojection shader
already handles this case via its existing disocclusion detection
(`TAA.wgsl:235-280`): it samples previous-frame depth at the
reprojected UV, eye-space-projects both, and rejects history when
`depthDelta > disocclusionThreshold` (scaled by `abs(eyePosCurr.z)
* 0.001`, floored at 1.0). For HiZ-culled commands the previous-
frame surface is at the command's depth and the current is at
background depth → depthDelta is large → history rejected → no
ghost. No additional mitigation needed. Documented as audit-cleared
in Batch 222.

---

### ~~NEW-GPU-SORT-PIPELINE~~ — RESOLVED (Batch 228) — BitonicSortU64 + sort+readback chain shipped; Phase 3 consumer integration tracked below

**Resolution:** `BitonicSortU64.wgsl` ships a generic u32×2 bitonic sort
network. `WebGPUGPUSortKeysDispatcher` gained `runBitonicSort()`,
`prepareIndicesReadback()`, and `readSortedIndices()` methods that
sort the existing `(sortKeysHigh, sortKeysLow, commandIndices)`
buffers in place and read the sorted command-indices array back.
FR-level entry points `runBitonicSortWebGPUGPUSortKeys` /
`prepareIndicesReadbackWebGPUGPUSortKeys` /
`readSortedIndicesWebGPUGPUSortKeys` registered on
`FeatureRendererKey.GPU_SORT_KEYS`. `WebGPUSceneRenderer._dispatchGPUSortKeys`
chains the sort + readback when the FR exposes the Phase 2 entries.

The bitonic network handles non-power-of-2 counts by padding with
sentinel max-keys (handled in shader's OOB load path).

**Phase 3 follow-up (separate entry):** `NEW-GPU-SORT-PIPELINE-PHASE-3`
below. Phase 2 ships the sort + readback, but the consumer side that
applies `_lastSortedIndices` to reorder the JS command list is NOT
wired yet — Phase 3 work integrates with `RenderScheduler`.

**Trace:** Batch 228 (`BitonicSortU64.wgsl` + `WebGPUGPUSortKeysDispatcher.runBitonicSort` + `WebGPUSceneRenderer._dispatchGPUSortKeys`).

---

### NEW-GPU-SORT-PIPELINE-PHASE-3 — RenderScheduler consumer integration for sorted-indices readback

**What:** Phase 2 (Batch 228) ships the GPU sort pipeline + readback
chain: keys are generated, the bitonic sort runs in place, and the
sorted command-indices array is read back into
`WebGPUSceneRenderer._lastSortedIndices`. **But the consumer side
that applies the sorted order to the actual command list is NOT
wired yet** — Phase 3 work.

The `_lastSortedIndices: { indices: Uint32Array, count }` field is
populated each frame the sort fires, but never read. The renderer
continues using the existing JS multi-level comparator
(`RenderScheduler.backToFront`) for ordering.

**Phase 3 scope:** wire `_lastSortedIndices` into the next-frame
opaque-command iteration. Two viable paths:

(a) **CPU-side reorder.** When `_lastSortedIndices.count` matches
    this frame's opaque count, build a sorted view of
    `frustumCommands.commands[OPAQUE]` using `indices[i]` as the
    permutation. Pass that sorted view to `executeBatch` instead of
    the original. ~50 LOC. Same 1-frame latency contract as the
    cull readbacks. Fall back to JS comparator on count mismatch.

(b) **Indirect-draw integration.** Use the sorted `commandIndices`
    buffer directly as the GPU-side draw-call ordering, paired
    with `gpuCuller`'s `CullMode.INDIRECT` mode. Eliminates the JS
    iteration entirely. Much bigger architectural change — every
    primitive type would need indirect-draw variants.

**Why deferred:** JS multi-level comparator in RenderScheduler is
faster than dispatch+readback round-trip below ~50K commands. Above
50K the sort + reorder amortize; at the 10K+ density target our
threshold-gating (Phase 1 HI=6000) means we already dispatch at
useful counts — Phase 3 just needs to APPLY the result. Path (a)
is the natural follow-up.

**Estimated effort:** 1-2 sessions for path (a); 5-10 sessions for
path (b) including per-primitive indirect-draw variants.

**Trace:** Batch 211 (key generation) + Batch 228 (sort + readback);
`WebGPUSceneRenderer._lastSortedIndices` (populated, not consumed);
`WebGPUGPUSortKeysDispatcher.readSortedIndices`.

**Impact:** Activates Phase 2 of GPUSortKeys consumption. Would
let the dispatcher pay for itself at 50K+ commands.

**Trace:** Batch 211 (`WebGPUSceneRenderer.ts:_dispatchGPUSortKeys`);
`WebGPUGPUSortKeysDispatcher.ts`; `PointCloudSort.wgsl` as a partial
template (different key format).

---

### ~~BUG-WEBGPU-CANVAS-BLACK~~ — RESOLVED (re-verified Batch 200, 2026-06-05)

**Resolution (Batch 200):** Does NOT reproduce. `canvas-black-readback.mjs` (default CesiumViewer `?renderer=webgpu`, valid ion token, globe framed at 3 Mm) renders a fully textured globe to the canvas — **canvas non-black fraction = 1.00** (3108/3108 center-region pixels), scene-FB readback avg `[51,61,48]`, **0 device errors**. The PNG shows the US East Coast / Great Lakes / Atlantic with normal satellite imagery. The post-process blit to the swap chain — the path the original bug broke — works. Independently corroborated by the Batch-198 textured-materials probes (bright magenta Image-material polygon renders on the WebGPU canvas). The earlier black-canvas symptom was fixed somewhere in the Batches 228-230 range the user chose to push forward to; the exact fixing commit wasn't bisected, but the symptom is gone. Probe was updated to honor `PROBE_BASE`, drop the Vulkan-only launch flags (a plain `--enable-unsafe-webgpu` adapter renders fine), and capture + sample the canvas.

**Original report (historical):** After Batches 213-225 landed in commit `2c86a7cca6`, the WebGPU canvas rendered as solid black (with only Cesium UI overlays — timeline, navigation, FPS — visible via CSS). Affected:

- `Apps/WebGPUTest/split-screen-comparison.html` — WebGPU pane shows blank gray (with HTML pane label visible)
- `Apps/CesiumViewer/index.html?renderer=webgpu` — canvas shows pure black, only HTML toolbar/timeline overlays visible
- `Tools/visual-regression/capture-and-diff.mjs` for any scene — WebGPU diff is non-zero against WebGL

WebGL backend renders correctly in all of the above.

**Diagnostic state (frame 182 probe):** the renderer self-reports as healthy: `_postProcess=true`, `hasActiveStages=true`, `tonemap=true`, scene framebuffer + colorTarget allocated, identity blit pipeline built, ping/pong textures present, `_skipSDRStagesForHDR=false`, `hdr=false`. Frame counter advances normally (frame 182 = 3+ seconds of rendering at 60fps). But no pixels reach the canvas swap chain.

**Suspect range:** the entire batch 213-225 range. Most likely candidates given diff size + scope:

- **Batch 205 / 213** — `_skipSDRStagesForHDR` flag in post-process; new `_applyCanvasConfig` wrapper around `_context.configure()` with try/catch HDR fallback chain. 198 LOC changed in `WebGPUPostProcessPipeline.ts`.
- **Batch 206** — `_buildCanvasConfig` extracted; `_hdrCanvasOutput` field added; canvas configure path centralized.
- **Batch 218** — `gpuCullerTranslucent` second instance + destroy walk extension.
- **Batch 220** — per-frustum culler instance map + readback slot map.
- **Batch 222** — `destroy()` walks aux culler maps.
- **Batch 225** — `gpuCullingHint = 'never'` short-circuit added to lazy aux-culler getters; HDR fallback listener Set conversion.

**Why deferred (user direction):** Triaged 2026-05-08 with multiple page-screenshot probes. User chose "continue forward" with batches 228-230 rather than revert / bisect now. Will return after Batches 228-230 land.

**Repro:**

```bash
npm run restart
node -e "
const {chromium} = require('playwright');
(async () => {
  const b = await chromium.launch({headless: true, channel: 'msedge'});
  const p = await (await b.newContext({viewport:{width:1280, height:720}})).newPage();
  await p.goto('http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu', {waitUntil: 'networkidle'});
  await p.waitForFunction(() => !!window.viewer, {timeout: 30000});
  await p.evaluate(() => new Promise(r => { let n=0; (function tick(){if(n++>240)r();else requestAnimationFrame(tick);})();}));
  await p.screenshot({path: 'webgpu-rendering-bug.png'});
  await b.close();
})();
"
# Inspect webgpu-rendering-bug.png — canvas is black, only UI is visible.
```

**Estimated effort:** Targeted file-revert + bisect to localize, then surgical fix. ~2-4 sessions depending on which slice is the culprit.

**Trace:** Diagnostic probes saved at `Tools/visual-regression/probe-webgpu-grey.mjs` and `Tools/visual-regression/probe-cesium-viewer.mjs`. Canvas-empty page screenshots at `Tools/visual-regression/output/diag-page-screenshot.png` (default = WebGL, renders correctly) vs `output/diag-webgpu-page.png` (WebGPU, black canvas).

---

### ~~NEW-SHADOW-CAST-GPU-CULL~~ — Phase 1 RESOLVED (Batch 221); Phase 2 tracked as NEW-SHADOW-CAST-GPU-CULL-PHASE-2

**Phase 1 (Batch 221):** Per-cascade `WebGPUGPUCuller` instances via
`WebGPUContext.getGPUCullerForCascade(idx)`. Lazy-init per cascade
on first request; destroyed in `context.destroy()` (Batch 222).
Eager warm-up walks cascades 0-3 when `Scene.gpuCullingHint =
'always'`. Memory: ~1 MB per cascade × 4 cascades = ~4 MB worst-case
VRAM cost.

**Phase 1 ships infrastructure ONLY.** The filter dispatch in
`WebGPUCSMCastPass` is NOT yet wired — see Phase 2 below.

---

### ~~NEW-SHADOW-CAST-GPU-CULL-PHASE-2~~ — CODE-RESOLVED (Batches 225-230, commit `2302859f0f`); shadow visual-diff still owed

**Status (doc-synced Batch 172, after the triage workflow's adversarial
verify pass confirmed the producer→consumer→frame-entry chain):** Phase 2 IS
implemented and wired live — the heading was never struck. The per-cascade GPU
cull filter dispatches and filters inside `WebGPUCSMCastPass.ts`'s per-cascade
loop:

- `packCascadeCullPlanes()` (`WebGPUCSMCastPass.ts:98-136`) builds the cull
  planes (cube-around-sphere, a deliberate correctness-safe over-include rather
  than tight Gribb-Hartmann — see the in-file note at lines 27-29).
- `updateCascadeGate()` (`:146-154`) runs the HI=2400 / LO=1600 hysteresis gate
  (`CASCADE_CULL_THRESHOLD_HI/LO` at `:63-64`).
- The per-cascade `WebGPUGPUCuller` is dispatched (`:374-378`), readback queued
  (`:380`), and the cast list filtered by the **prior-frame** `visibilityFlags`
  before the draw loop (`:393-404`, `castIter` reassigned to the filtered pool,
  drawn at `:420`).
- Host fields `_cascadeCull*` declared public on `WebGPUCSMRenderer.ts:255-275`;
  `WebGPUContext.getGPUCullerForCascade` at `:4499` (honours
  `gpuCullingHint === 'never'`), passed live at `:2992-2997` inside the real
  frame path (`executeShadowMapCastCommands`). Stats surface via
  `getHighDensityCullStats().shadowCascadeCull` reading the live fields.

**Verified by:** triage workflow's adversarial verify pass (independently traced
every link; commit `2302859f0f` "Shadow-cast Phase 2 (Batches 225-230)" exists
with the matching message). `npx tsc --noEmit` confirms the host-field shapes
match the consumed interfaces.

**Residual (NOT a code gap — the verification the original deferral demanded):**
the dense-overlapping-shadow Playwright visual diff (WebGL no-cull vs WebGPU
Phase-2-cull; shadow acne / peter-panning / cascade-boundary popping parity)
was apparently **never run** — Phase 2 shipped from a code-only batch. Owed as a
focused verification task, NOT a reimplementation. Also a stale source comment
at `WebGPUContext.ts:4492-4497` still claims "Phase 1 ships infrastructure only
— WebGPUCSMCastPass does NOT yet dispatch", contradicted by the live dispatch
code — fix that comment when next touching the file.

**Trace:** Batch 221 (Phase 1); commit `2302859f0f` (Phase 2, Batches 225-230);
`WebGPUCSMCastPass.ts:98-420`; `WebGPUCSMRenderer.ts:255-275`;
`WebGPUContext.ts:4499/2992-2997`.

---

### Stub: NEW-SHADOW-CAST-GPU-CULL (legacy heading kept for grep)

**What:** Batch 216 wired the gpuCuller into opaque + translucent
passes. Shadow cast pass (`renderShadowCastPass` in
`WebGPUShadowMapRenderer.js`) iterates `castCommands` directly without
GPU-side culling. At the 10K+ instance density target, the shadow
cast pass repeats the same draws as opaque + every cascade — three
to four cascades multiplies the cost.

Per-cascade GPU cull would need:

1. Per-cascade `WebGPUGPUCuller` instance (3-4 separate instances) so
   each cascade's `prepareReadback` doesn't clobber the others'
   pending readbacks (same shape as the B216-N1 fix in Batch 218).
2. Per-cascade `_lastCullResultsCascade[i]` readback slots.
3. Per-cascade light-frustum culling volume (CSM's per-cascade
   light view; not the camera frustum).
4. Cascade-N filter applied before the cast loop on cascade N.

**Why deferred:** ~150-200 LOC across cascade culler instantiation +
state plumbing + cascade-volume routing. One-batch effort but needs a
dense-instances test scene to validate the cull is worth the dispatch
cost (CSM cast is already simpler than opaque — fewer textures
sampled per draw, so the dispatch overhead may not amortize until
even higher density).

**Estimated effort:** 1-2 sessions.

**Impact:** Cuts shadow-cast draw count proportionally to the cull
hit ratio, multiplied by cascade count. At 10K instances and 4
cascades that's potentially 4× of the gpuCuller savings.

**Trace:** Batch 216 (translucent wire-in deferred this);
`WebGPUShadowMapRenderer.js:renderShadowCastPass`; `WebGPUCSMRenderer.ts`
for the per-cascade light volumes.

---

### ~~NEW-MULTIFRUSTUM-CULL-RESULTS~~ — RESOLVED (Batch 220)

**Resolution:** Per-frustum opaque culler instances + per-frustum
readback slots both shipped:

- `WebGPUContext.getGPUCullerForOpaqueFrustum(idx)` — frustum 0
  reuses the original `_gpuCuller` (no extra VRAM for single-
  frustum scenes); frustums 1..N lazy-allocate their own
  instances. Memory destroyed in Batch 222's `destroy()` walk.
- `_lastCullResultsByFrustum: Map<number, GPUCullResults>`
  replaces the single `_lastCullResults` slot. Each frustum's
  readback stores under its own index; the closure captures `fIdx`
  by value so async resolution stores into the correct slot.
- Multi-frustum log-depth scenes now get full GPU cull benefit
  instead of "last-frustum-wins".
- Eager warm-up walks frustums 1-3 when `gpuCullingHint = 'always'`.

**Trace:** Batch 220 (`WebGPUContext.getGPUCullerForOpaqueFrustum`,
`WebGPUSceneRenderer.gpuCullCommands` updated to use per-frustum
slots).

---

### Stub: NEW-MULTIFRUSTUM-CULL-RESULTS (legacy heading kept for grep)

**What:** Pre-existing limitation surfaced during the Batch 218 audit.
`_executeOpaquePass` runs once per frustum (3-4 frustums for typical
log-depth scenes). Each call dispatches into the same `_visibilityBuffer`
and writes its readback to `this._lastCullResults`. The LAST frustum's
readback wins. The filter step's `prev.objectCount === count` check
means the filter only applies when the prev count equals the current
count — usually only the LAST frustum's commands get filtered.
Earlier frustums dispatch but never see their results applied.

This is wasted dispatch cost (small) plus reduced cull effectiveness
(real impact at high density).

**Why deferred:** Batch 218's main fix (B216-N1) addressed the more
critical opaque-vs-translucent collision. Multi-frustum opaque
collision is the same shape but per-frustum within opaque. Fix
follows the same pattern: per-frustum culler instances OR per-frustum
readback slots keyed by frustum index. ~75 LOC.

**Workaround until then:** With log-depth on (the typical case), the
last frustum is the FAR frustum which holds most distant tile content
— so the LAST-frustum-wins behavior actually matches typical
distance-density distribution. Closer frustums tend to have fewer
commands and would benefit less from GPU cull anyway.

**Estimated effort:** 1 session.

**Impact:** Cuts dispatch waste; lifts cull effectiveness across all
frustums.

**Trace:** Batch 218 audit; `WebGPUSceneRenderer.gpuCullCommands`
shared `_lastCullResults`; `_executeOpaquePass` per-frustum loop.

---

### ~~NEW-VR-BASELINE-HIGH-DENSITY~~ — RESOLVED (Batch 224 — scene + setup-hook infrastructure ship; PNG capture is a runtime task)

**Resolution:** Synthetic 5K-sphere scene generator landed end-to-end:

- `Tools/visual-regression/capture-and-diff.mjs` extended with a
  `setup` script field per scene — JS source evaluated in the page
  context with access to `window.Cesium` + `window.webglViewer` +
  `window.webgpuViewer` and a typed `setupParams` argument. Optional
  Promise return for async setup.
- `scenes.json` adds `high-density-5k-spheres` — 5000 sphere
  instances around San Francisco using a deterministic mulberry32
  RNG seed (so WebGL + WebGPU see identical instance positions).
  Crosses every threshold-gated dispatcher's HI gate (gpuCuller
  HI=384, HiZ HI=2400) and opts the WebGPU viewer into eager
  warm-up via `Scene.gpuCullingHint = 'always'`.
- `Tools/visual-regression/README.md` documents the synthetic-scene
  pattern + the runner command for the high-density scene.

**Runtime task remaining:** PNG baseline capture. Run
`node Tools/visual-regression/capture-and-diff.mjs --scene
high-density-5k-spheres --update` against a live dev server to
populate `Tools/visual-regression/baseline/`. Not part of any
code-only batch; tracked as a one-time CI bring-up step.

**Trace:** Batch 224 (`scenes.json` entry + `applyScene` setup hook +
README).

---

### Stub: NEW-VR-BASELINE-HIGH-DENSITY (legacy heading kept for grep)

**What:** The Batch 213-218 high-density work targets the 10K+ models
density goal but lacks a visual regression baseline that exercises
the dispatchers. Need a synthetic scene (procedurally generated
sphere instances, no external tilesets) that deterministically hits
the activation thresholds for all three dispatchers, captured in
`Tools/visual-regression/capture-and-diff.mjs`.

**Why deferred:** Runtime task — needs a Playwright session against
the dev server. Out of scope for the audit batch (213-218 was code
work only). Batch 218 added the diagnostic surface so users can
verify dispatchers are active; the VR baseline would lock that in.

**Estimated effort:** ~1 session — design the synthetic scene, plumb
the loader into the split-screen page, capture initial baseline.

**Impact:** Locks down the high-density story before it ships to
ensure dispatcher changes don't silently break visual output.

**Trace:** Batch 218 audit; `Tools/visual-regression/`;
`Apps/WebGPUTest/split-screen-comparison.html`.

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

### ~~NEW-ADVANCED-MOTION-VECTORS~~ — per-particle / per-cell / per-feature motion vectors for advanced primitives + classifiers — RESOLVED (Batches 168-183, closed Batch 183)

**What:** Batch 153 closed AUDIT_2026_05_02 B.9 by adding `prevViewProjection: mat4x4<f32>` at the tail of the UBO struct for 8 inline-WGSL renderers (the 5 ground/Vector3DTile classifiers + PointCloud + GaussianSplat + Voxel) per the DP-H41 invariant. Batches 168-183 progressively closed the per-renderer velocity emission for both the advanced-primitive and classifier halves; Batch 183 closed the family with the GroundPolyline classifier.

**Resolution per family:**

- ~~**PointCloud (default + LOD)**~~ — SHIPPED (Batch 168 default; Batch 169 LOD; pre-Batch-169 hardening for animated revision-change). Per-particle prev-position SSBO mirror; LOD uses `visibleIndices[iidx]` parallel SSBO indexing.
- ~~**CloudCollection**~~ — SHIPPED (Batch 170). Per-cloud prev-position attribute.
- ~~**GaussianSplat**~~ — SHIPPED (Batch 171 initial; Batch 172 review fixes — UBO 256→320 + modelMatrix at byte offset 256 + full elliptical footprint). Per-splat prev-position follows current sort permutation.
- ~~**Voxel**~~ — SHIPPED (Batch 173, CLOSES B.10 advanced family). Static-cube screen-space approximation; correct for the dominant case (static voxel volumes).
- ~~**Vector3DTilePrimitive**~~ — SHIPPED (Batch 178). Camera-only velocity using `prevViewProjection`; vsVelocity replicates the color VS RTC math; one velocity command per primitive (first ground pass only).
- ~~**Vector3DTilePolylines**~~ — SHIPPED (Batch 179). UBO grew by 16 bytes (`centerWC: vec3<f32>` + 1-pad at floats 56-59) so velocity VS reconstructs world-space positions. Polyline screen-space miter extrusion replicated in vsVelocity for coverage parity.
- ~~**Vector3DTileClampedPolylines**~~ — SHIPPED (Batch 179). UBO `centerWC` at floats 84-87 (within existing 384-byte capacity). Volume extrusion replicated in vsVelocity; un-extruded world position used for prev-VP projection (the width-miter offset is screen-space, not world-space). Visibility approximation: fsVelocity does NOT replicate the color FS plane-test classification; sky regions emit "extra" velocity that's harmless because TAA reprojects sky → sky.
- ~~**GroundPrimitive**~~ — SHIPPED (Batch 180). Camera-only velocity matches colorVS exactly (same `csm_depthClamp + mvpRTE` math). Velocity emission gated on `taaEnabled && !isMorphing && defined(velocityPipeline)` — MORPHING uses the two-stream layout that the velocity VS doesn't match.
- ~~**GroundPolyline**~~ — SHIPPED (Batch 183, CLOSES family). vsVelocity replicates the vsMain volume-extrusion math (multi-attribute input, plane-based extrusion direction, bottom-vertex stretching, screen-space width-miter push) byte-for-byte so velocity-pass coverage matches the color pass fragment-for-fragment. Previous-frame clip projects the un-extruded world position (`pH + pL` SoA decode in 3D, `pH2D.zxy + pL2D.zxy` in 2D / Columbus View) through `u.prevViewProjection`. Visibility approximation: fsVelocity does NOT replicate the classifyFragment plane-test (no globe-depth read at velocity-pass time); rasterized fragments emit velocity unconditionally — over-emits across the volume's full screen coverage rather than just the ground-classified band. TAA history rejection is robust to over-coverage. Velocity emission gated on `taaEnabled && !isMorphing && defined(velocityPipeline)` matching the GroundPrimitive precedent.

---

### ~~NEW-MODEL-NODE-TRANSFORMS-PREV~~ — RESOLVED (Batch 175)

**Resolution:** `WebGPUModelRenderer.js` now allocates a per-node
`prevNodeModelMatrix` slot (lines 1968-1995) following the same
lifecycle as the existing `prevPackedJointMatrices` swap. The
per-node prev modelMatrix is resolved BEFORE the per-primitive loop
(lines 2139-2160) so `packMaterialUniforms` sees the correct
node-level prev value rather than the model-level `cache.prevModelMatrix`.
End-of-node-loop capture moves the current `nodeModelMatrix` into the
prev slot for the next frame.

Articulated rigs (e.g., satellite solar-panel deploy animations,
mechanical-rig glTF assets) under TAA now produce correct per-vertex
velocity at the node-relative motion delta, eliminating the prior
ghosting on animated articulations. Static articulations are
unchanged (the prev slot just lags by one frame and matches current,
producing zero velocity at the node level).

**Trace:** Batch 175; `WebGPUModelRenderer.js:1968-1995, 2139-2160`.

---

### ~~NEW-IBL-SH-FAST-PATH — 9-coefficient spherical harmonics shortcut for diffuse IBL~~ — RESOLVED (Batch 130 commit `0b4fac4b65`; doc sync Batch 162)

**Resolution:** The SH fast-path was actually shipped end-to-end in Batch 130 alongside the cubemap split-sum work, not just the cubemap half. Re-audit (Batch 162) confirmed every piece is in place:

- WGSL UBO `SHUniforms` at `@group(1) @binding(36)` carries 9 `vec4<f32>` coefficients + a `control: vec4<f32>` slot (`ModelPBRComplete.wgsl:444-461`).
- WGSL `evalSphericalHarmonics(N)` at `ModelPBRComplete.wgsl:847-858` does the 9-coefficient evaluation in 6 mads. Mirrors `Builtin/Functions/sphericalHarmonics.glsl` byte-for-byte (coefficient pre-multiplication by `Y_lm` basis constants is done at generation time on both backends, so the shader-side evaluation is the same form).
- WGSL FS gate at `ModelPBRComplete.wgsl:2275-2279` short-circuits to `evalSphericalHarmonics(N)` when `sh.control.w > 0.5`, falling back to the cubemap sample otherwise.
- JS `WebGPUIBLPipeline.ts:319-348` (`packSphericalHarmonics`) packs 9 coefficients with `data[39] = 1.0` (control.w active).
- JS `WebGPUImageBasedLighting.ts:189-208` (`update`) calls `packSphericalHarmonics` whenever `ibl.sphericalHarmonicCoefficients` is set, exposing the buffer via `ibl._webgpuSHBuffer`.
- JS `WebGPUModelRenderer.js:1273-1313` (`buildModelIBLEntries`) binds `_webgpuSHBuffer` at slot 36 (or `pipelineCache.defaultSHBuffer` with control.w=0 when SH isn't published).

The deferred entry's "scope" predates the Batch 130 commit and was never reconciled — it described a slightly different design (a `FLAG_HAS_IBL_SH` material flag) that the actual implementation supersedes with the cleaner `sh.control.w` gate (no flag plumbing needed).

---

### ~~NEW-DRILLPICK-ASYNC~~ — RESOLVED (Batch 184)

**Resolution:** New `Scene.drillPickAsync(windowPosition, limit, width, height)` public API delegates to `Picking.drillPickAsync`, which awaits a new `Picking.pickAsync` between iterations so each drill sees a fresh pick render. The async pick path uses `pickFramebuffer.endAsync()` — already implemented on both `PickFramebuffer` (WebGL, sync fence + PBO) and `WebGPUPickFramebuffer` (mapAsync staging buffer readback) — so the API is renderer-agnostic with no per-backend branching at the Scene/Picking layer.

The sync `Scene.drillPick` is kept as-is (no deprecation) — the prior debug-build `oneTimeWarning` now points users at `drillPickAsync` for correct WebGPU results.

**Trace:** Batch 184. `Scene.drillPickAsync` at `packages/engine/Source/Scene/Scene.js`; `Picking.pickAsync` + `Picking.drillPickAsync` at `packages/engine/Source/Scene/Picking.js`; underlying `pickFramebuffer.endAsync` already shipped in both `PickFramebuffer.js:68` and `WebGPUPickFramebuffer.ts:271`.

---

### ~~NEW-MODEL-CLIPPING-POLYGONS — `model.clippingPolygons` is unbound on WebGPU~~ — RESOLVED (Batch 160 atlas-aware port; Batch 163 review fixes)

**Resolution:** `ModelPBRComplete.wgsl:1596-1700` defines `modelClipByPolygon(positionWC)` mirroring `czm_clipPolygons` from the globe: project worldPos to spherical (lat, lon) via `czm_fastApproximateAtan2`, iterate up to 8 merged-extent regions to find the containing one, compute the atlas slot from `dim = ceil(sqrt(extentsCount))` (Batch 163 HIGH fix: uses the FULL `extentsCount` rather than the capped 8-cap, so sampled atlas slots match the JS upload), sample `clippingPolygonTex` SDF, discard on inside/outside rule honoring the `clippingPolygonControl.z` inverse flag at all early-return paths (Batch 163 HIGH fix: pre-Batch-163 returned `false` unconditionally, leaking the entire scene-outside-the-polygon region in inverse-mode "show only inside" demos).

`fragmentMain` invokes the polygon branch at line 1758-1762 after the planes branch:

```wgsl
if (effects.clippingPolygonCount > 0u) {
  let worldPos = camera.cameraPositionWC
    + (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
  if (modelClipByPolygon(worldPos)) { discard; }
}
```

`EffectsUniforms` carries `clippingPolygonCount: u32`, `clippingPolygonControl: vec4<f32>` (`(extentsCount, invDim, inverseFlag, _)`), and `clippingPolygonExtents[8]` regions. `WebGPUEffectsBindGroup.js` binds `clippingPolygonTex` + `clippingPolygonSampler` at the model material BGL slots. `model.clippingPolygons = ...` produces correct cutouts AND inverse-mode "show only inside" rendering on WebGPU end-to-end.

---

### ~~NEW-MODEL-TANGENT-GENERATION~~ — RESOLVED (Batch 159) — Derive tangents for normal-mapped primitives lacking a TANGENT accessor

**Resolved (Batch 159):** Option (b) shipped — screen-space derivative tangents in the WGSL FS. `perturbNormal` (`ModelPBRComplete.wgsl`) now derives a tangent basis from the screen-space derivatives of position + normal-map UV when the vertex tangent frame is missing/non-finite, instead of falling back to the flat geometric normal. The formula matches WebGL's `computeTangent()` in `MaterialStageFS.glsl` (the glTF-sample-viewer method): `tRaw = dUV.y.y·dpdx(pos) − dUV.x.y·dpdy(pos)`, orthogonalized against N, then `B = cross(N, T)` — so the two backends agree on tangent handedness (the normal-map green-channel sign).

The derivative built-ins (`dpdx`/`dpdy`) are hoisted to a new helper `deriveTangentRaw(posEC, uv)` invoked at the **uniform entry** of `fragmentMain` (mirroring the existing hoisted `edgePixelStep = fwidth(...)`), then threaded down into `perturbNormal` as a precomputed `vec4` (xyz = raw tangent, w = UV-jacobian det). WGSL forbids derivatives in non-uniform control flow, and `perturbNormal` is reached through non-uniform branches (the double-sided `frontFacing` flip + the unlit early-out) — calling them inside it errors with `'dpdx' must only be called from uniform control flow` (Bug 159.1). The Batch 153 NaN-safe degeneracy test is retained, plus a det≈0 guard that keeps the flat normal when UV gradients vanish.

**Verification:** `Tools/visual-regression/probe-model-tangentgen.mjs` (WebGL ground-truth + GroundVehicle/MilkTruck) — 0 device errors, both render. Same-backend A/B vs the Batch 153 flat fallback: GroundVehicle (tangent-less) 10.16% of surface pixels changed (broad-distributed normal-map detail restored); MilkTruck (tangent-having control) 1.63% (edge/AA noise — vertex-tangent path untouched, no regression).

**Original deferral context (Batch 153):** A glTF primitive may declare a normal texture WITHOUT a `TANGENT` vertex accessor (the spec permits the renderer to derive the basis). The WebGPU vertex path computes `tangentEC = normalize(normalMatrix * tangentMC)`, which for an absent/zero tangent attribute is `normalize(vec3(0))` → NaN; Batch 153 added the NaN-safe geometric-normal fallback in `perturbNormal` to stop the NaN from zeroing all lighting, at the cost of normal-map detail. `GroundVehicle.glb` is the canonical asset hitting this path. See WEBGPU_DEBUGGING_LOG.md Bug 153.1 + 159.1.

> Option (a) — MikkTSpace-style CPU tangent generation at load time, matching WebGL bit-for-bit — remains a possible future upgrade if a tangent-less asset ever needs handedness independent of screen-space orientation, but the derivative method is the standard self-contained approach and is sufficient.

---

### NEW-MODEL-WGSL-CUSTOM-SHADER — WGSL `CustomShader` API parallel to GLSL `CustomShaderPipelineStage`

**What:** `model.customShader` on WebGPU now emits a one-time warning (Batch 133, commit `a403131590`, AUDIT_2026_05_02 A.7 partial-fix). Long-term the user-facing `CustomShader` API needs to accept WGSL chunks and inject them into the Model PBR pipeline, matching the GLSL fragment/vertex injection points.

**Scope:** WGSL chunk-injection mechanism in `WebGPUModelPipelineCache`; entry-point pre-processor that swaps user-supplied `vertexMain`/`fragmentMain` chunks; `CustomShaderMode` switch (REPLACE_MATERIAL / MODIFY_MATERIAL); user-uniform → bind-group plumbing; `varying` → `@location` parity. ~200 LOC, multi-session.

**Why deferred:** Requires a chunk-injection layer that doesn't exist yet, plus a user-uniform-to-WGSL-bind-group adapter (the GLSL path uses `automatic_uniforms` introspection that has no WebGPU equivalent). The warning closes the silent-swallow surface so users can detect the gap.

---

### ~~NEW-POSTPROCESS-USER-WGSL~~ — RESOLVED (Batches 198 + 199 + 204); B204-N1 audit note open

**B204-N1 (LOW, audit 2026-05-07):** schema vec4 at offset 48 collides with framework's pass-index slot at byte 60. The collision check `if (entry.offset === PASS_INDEX_OFFSET) continue;` only catches exact-offset matches; doesn't catch vec4 entries whose byte range (48-63) overlaps offset 60. Fix in Batch 205: detect range overlap and warn/skip.

**Batch 198 first slice:** Accept `wgslFragmentShader` on user `PostProcessStage`. Producer side via new `WebGPUUserPostProcessStage` class; pipeline integration via `addUserWGSLStage` / `clearUserWGSLStages`; consumer side detects WGSL stages from `scene.postProcessStages.add(...)` entries.

**Batch 199 audit fixes:**

- **B198-D1** — HDR precision loss fixed. User stage intermediate texture now uses `_intermediateFormat` (rgba16float in HDR mode) instead of `canvasFormat`. User stages preserve precision under HDR.
- **B198-D2** — auto-exposure ordering fixed. User stage chain moved from step 3.4 to step 3.6, AFTER auto-exposure dispatch. Auto-exposure now correctly finds the post-DoF ping/pong texture as its luminance source; user stages run on the post-effects HDR output.
- `_userStagesBuilt` formalized on the `PostProcessCache` interface (was an inline cast).

**Batch 204 second slice:**

- **Named-uniform schema** — user provides `wgslUniformSchema: { [name]: { type: 'float'|'vec2'|'vec3'|'vec4', offset: number } }` alongside `wgslFragmentShader`. The packer writes uniforms at declared byte offsets with the right WGSL alignment. Vec3/vec4 values can be passed as `number[]` arrays. Falls back to Batch 198 iteration-order packing when no schema provided (backwards compat).
- **Multi-pass support** — user provides `wgslNumberOfPasses: number` (default 1, capped at 32). The framework runs the same pipeline N times, ping-ponging between two intermediate textures. Pass index packed into UBO offset 60 (last float) so user shader can branch per-pass — supports separable filters (Gaussian blur horizontal/vertical), accumulating denoisers, etc. Single-pass stages don't allocate the second ping-pong texture (VRAM-frugal default).

**Future follow-ups (not blocking — deferred):**

- Texture / sampler bindings beyond the source pair (user-supplied cubemap, lookup tables) — would require schema-extension for binding declarations.
- GLSL → WGSL transpiler for upstream parity (so users authoring against WebGL's GLSL custom-shader API can use the same code on WebGPU).

**Trace:** Batches 198 + 199 + 204. `WebGPUUserPostProcessStage.ts`; `WebGPUPostProcessPipeline.addUserWGSLStage` / `clearUserWGSLStages`; `WebGPUPostProcessStageCollection.ts:configureWebGPUPostProcessPipeline` (consumer wiring with schema/multi-pass extraction).

**What:** User-added stages on `scene.postProcessStages.add(...)` now emit a one-time warning (Batch 133, commit `a403131590`, AUDIT_2026_05_02 A.13 partial-fix). Long-term the `PostProcessStage` constructor needs a `wgslFragmentShader` option so users can author custom WebGPU stages without a GLSL → WGSL transpile.

**Scope:** Per-stage WGSL pipeline factory; wire user-supplied `wgslFragmentShader` + uniforms map → `WebGPUPostProcessPipeline._userStages[]`; insertion point between built-in stages; resize/destroy lifecycle. ~150 LOC.

**Why deferred:** Needs a generic per-stage pipeline factory that can accept arbitrary uniform layouts at runtime. The warning closes the silent-swallow surface so users can detect the gap.

---

### NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT — `BufferPolygonMaterial.wgsl` `#import` directives unresolved → "invalid character" compile failure (✅ RESOLVED Batch 180)

**What (found Batch 178):** Loading a modern glTF-vector tileset (`CESIUM_mesh_vector`, e.g. `Apps/SampleData/vector/sample-us-states.tileset.json`) on WebGPU failed to render its polygons: `Shader "BufferPolygonMaterial" compilation ERROR at line 6:1: invalid character found` → `[Invalid RenderPipeline "BufferPolygon pipeline (fragmentMain)"]`. Line 6 is `#import CameraUniforms;` — the `#import` directives reached the WGSL compiler UNRESOLVED, so `#` (col 1) was an invalid WGSL token. The modern buffer-backed vector polygon path was therefore broken on WebGPU.

**Root cause (Batch 180) — THREE compounding bugs, not one:**

1. **`#import` never resolved.** `preprocessShader` (in `WebGPUBufferPrimitiveRenderer.ts`) gated import resolution on `context.shaderCache.preprocessOnly`, but `context.shaderCache` is the WebGL `ShaderCache` (no such method) and the `WebGPUShaderCache` is never instantiated — so it fell through to raw source. Even the `WGSLShaderPreprocessor` regex only matches the quoted `// #import "path"` form, not the bare `#import Name;` form these shaders use. The `#import` runtime was effectively dead for the Buffer* family.
2. **Stale 1-arg vs library 2-arg helper signatures.** The shaders call 1-arg `csm_vertexLogDepth(clipPos)` / 1-arg `csm_writeLogDepth(v)`, but the library chunks diverged to 2-arg variants, and `csm_writeLogDepth.wgsl` bundles its own conflicting 1-arg `csm_vertexLogDepth` (redeclaration).
3. **`vec4` camera field into `vec3` helper param.** Shaders passed `camera.encodedCameraPositionMCHigh` (the shared `CameraUniforms` struct field is `vec4`) into `csm_translateRelativeToEye`'s `vec3` params.
   Plus a 4th surfaced after the shader compiled: the color pipelines had no `multisample` → `sampleCount:1` vs the MSAA-4 scene FB → attachment-state mismatch.

**Fix (Batch 180):** Rewrote `preprocessShader` to resolve bare `#import Name;` from a `BUFFER_WGSL_CHUNKS` name→source map (dedupe + warn-once-and-strip on unknown). The two log-depth names map to local Buffer-family 1-arg defs: `csm_vertexLogDepth` = `log2(max(1e-6, 1+w))`; `csm_writeLogDepth` = **no-op** (these fragments have no `@builtin(frag_depth)` and the WebGPU globe writes hyperbolic NDC depth — see GlobeTerrain.wgsl — so the polygon must match it). Added `.xyz` at all 5 `csm_translateRelativeToEye` call sites across the 3 shaders. Threaded `context._msaaSamples` into all 3 color pipelines (pick pipelines stay single-sample). Added `_msaaSamples` to the `CesiumGraphicsContext` interface.

**Verified (Batch 180, probe-bufferpolygon-vector-tile.mjs):** WebGL vs WebGPU on `sample-us-states`: 593 device errors → **0**; both load 52 features with identical `geometryByteLength` (1,548,528); WebGPU draws the fill at the **correct US extent**. Residual ~29% pixel diff is EXPECTED, not a regression: WebGL's depth func `LESS` loses coplanar ties to the globe → z-fight "pinwheel"; WebGPU's `less-equal` wins ties → clean solid fill (arguably the better result).

**Trace:** Batch 178 (found) → Batch 180 (fixed). `WebGPUBufferPrimitiveRenderer.ts` (preprocessShader + chunk map), `WebGPUBufferPolygon/Polyline/PointRenderer.ts` (MSAA), `Collections/Buffer{Polygon,Polyline,Point}Material.wgsl` (`.xyz`), `cesium-js-types.d.ts` (`_msaaSamples`).

**Does NOT unblock Vector3DTilePrimitive:** `sample-us-states` routes through `BufferPolygon` (the `CESIUM_mesh_vector` glTF-vector path), which is a DIFFERENT renderer from `Vector3DTilePrimitive` (classic `.vctr`). So the Batch 178 `Vector3DTilePrimitive` 2D/CV work remains UNVERIFIED — it still needs a classic `.vctr` test scene (see NEW-CLASSIFIER-2D-CV-MORPH). What this fix DOES give: the modern buffer-backed vector polygon path is now confirmed working on WebGPU.

---

### NEW-CLASSIFIER-2D-CV-MORPH — proper 2D / Columbus View / Morphing support for classifier renderers

**Progress (Batch 178) — Vector3DTilePrimitive 2D + CV implemented (e2e-visual UNVERIFIED — see blocker):** `WebGPUVector3DTilePrimitiveRenderer` now builds a CPU-reprojected ENU 2D vertex buffer alongside the 3D one in `ensureGeometry` (world = RTC position + `_center` → `cartesianToCartographic` → `mapProjection.project` → ENU `(height, projX, projY)`, RTC-relative to a 2D center), mode-branches the encoded center in `packUniforms` (2D center in non-3D, with `camera.positionWC` already in the ENU frame under `TRANSFORM_2D`), binds the 2D buffer in SCENE2D/COLUMBUS_VIEW, and the Batch 150 "skip all non-3D" gate is narrowed to **MORPHING-only**. The VS math is mode-agnostic (same `(centerH-camH)+(centerL-camL)+position` form — only the center / buffer / `vpRTE` differ by mode), so NO shader change was needed. This is a direct port of the **verified** Batch 170 GroundPrimitive 2D/CV approach + `GeometryPipeline.projectTo2D`.

**VERIFICATION BLOCKER (Batch 178):** end-to-end Vector3DTile-content rendering in 2D/CV could NOT be Playwright-verified — the repo has **no classic `.vctr` sample tileset** (the only thing that produces `Vector3DTilePrimitive` content), and the primitive's internal classes (`Vector3DTilePolygons`, `Cesium3DTileBatchTable`) are not exported in the public bundle, so a synthetic scene can't be stamped from a probe. The modern sample vector tilesets (`Apps/SampleData/vector/*.tileset.json`) use the **glTF-vector `CESIUM_mesh_vector`** format, which routes through `BufferPolygon` (a DIFFERENT renderer), NOT `Vector3DTilePrimitive` — and that path has its own active compile bug (see **NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT**). What WAS verified: builds clean, FR registers, **0 device errors across SCENE3D / SCENE2D / COLUMBUS_VIEW** mode flips, no regression. Given it's a line-for-line port of the verified Batch 170 path, confidence is high — but it is flagged UNVERIFIED pending a `.vctr` test scene (or fixing BufferPolygon to get a modern vector test scene). NOT marked resolved.

**Remaining:** Vector3DTilePolylines + ClampedPolylines 2D/CV (same reprojection, adapted to their attribute layouts); MORPHING blend (3D↔2D EC-space interp, the GroundPrimitive `morphColorVS` pattern) for all; and the e2e visual verification once test data exists.

**What:** WebGL classification primitives correctly render in
SceneMode.SCENE2D, COLUMBUS_VIEW, and MORPHING. WebGPU's classifier
renderers consume only 3D ECEF position attributes
(`position3DHigh` / `position3DLow` for GroundPrimitive,
RTC-relative-to-`_center` for Vector3DTile* renderers, ellipsoid-
normal-encoded shadow volumes for ClampedPolylines), so projecting
those 3D positions through the 2D / CV / morph projection matrix
produces wandering or invisible classification volumes.

**Current behavior (Batches 150 + 156 progressive narrowing):**

- Batch 150 silently skipped emission when `frameState.mode !== SceneMode.SCENE3D` for all four renderers.
- Batch 156 narrowed `WebGPUGroundPrimitiveRenderer` to MORPHING-only: it now correctly renders in SCENE2D + COLUMBUS_VIEW by selecting the per-vertex `position2DHigh/Low` attributes that `PrimitivePipeline.js:175-208` produces alongside the 3D positions, and rebuilding the vertex buffer when the scene mode flips (cached via `cache.positionSourceKey`). MORPHING still gates because lerping volumes between 3D ECEF and 2D projected coords needs a different in-shader pattern.

> **⚠️ Batch 161 visual-probe correction:** the bullets below were written from code-reading + the byte-counting `verify-classification-fr.mjs`, which does NOT assert visual output. The new `probe-classifier-scenemode.mjs` (flat-color GroundPrimitive, WebGL vs WebGPU red-pixel count) revealed the GroundPrimitive claims were **over-stated**:
>
> - **SCENE3D was a catastrophic crash**, not working — `ClassificationPrimitive.update` pushed the 1-target `depthSamplePick` command into the MSAA 2-target MRT scene pass → black scene + ~360 device errors. **FIXED Batch 161** (push color-only; pick rides on `derivedCommands.picking`). SCENE3D now renders matching WebGL.
> - **SCENE2D + COLUMBUS_VIEW do NOT work** — classification in 2D/CV throws a cascading render-pass-lifecycle error (`_beginDefaultRenderPass() called with an active render pass`). Plain 2D WebGPU renders fine, so it's classification-specific. The Batch 156 "SCENE2D + CV ✓" claim was wrong (masked by the 3D crash + a doc that trusted code-reading). Tracked as **NEW-CLASSIFIER-GROUNDPRIM-2D-RENDERPASS** (below).
> - **Textured GroundPrimitives aren't implemented in ANY mode** — the renderer reads only `appearance.material.uniforms.color` (flat color); there is no UV / extents / texture-sample path even in 3D. So `_needs2DShader` was never a 2D/CV-specific gap; it's blocked on a separate larger feature, **NEW-GROUNDPRIM-TEXTURED-MATERIALS** (below).
>
> The bullets below are kept (struck where now-known-wrong) for history.

The four originally-affected renderers, current state:

- ~~`WebGPUGroundPrimitiveRenderer`~~ — SCENE3D ✓ (crash fixed Batch 161); MORPHING ✓ (Batch 164 — `morphColorVS` consumes both `pH/pL` (3D) and `pH2D/pL2D` (2D) attribute pairs and blends EC-space positions by `morphTime`); SCENE2D + COLUMBUS_VIEW ✓ for **flat-color** (Batch 170 — mode-conditional `.zxy` swizzle in `colorVS` / `vsVelocity` resolves the RTE coordinate-frame mismatch; coverage within ~6% of WebGL; `probe-classifier-scenemode.mjs` enforces 2D/CV). Render-pass crash fixed Batch 164 (NEW-CLASSIFIER-GROUNDPRIM-2D-RENDERPASS); skip removed Batch 169; off-screen RTE fixed Batch 170 (NEW-CLASSIFIER-GROUNDPRIM-2D-RTE). **Flat textured materials (Color/Stripe/Checkerboard/Grid) now render** (Batch 185 — NEW-GROUNDPRIM-TEXTURED-MATERIALS RESOLVED via the `packExtents` wrapper-chain fix). **Remaining gap:** far-corner reconstruction precision (NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION), Image material type-4, and the 2D/CV textured variant.
- `WebGPUVector3DTilePrimitiveRenderer` — SCENE2D + CV still gated; MORPHING also still gated (the polygon pipeline isn't trivial to morph without 2D attributes).
- `WebGPUVector3DTileClampedPolylinesRenderer` — SCENE2D + CV still gated; **MORPHING ✓ (Batch 208)** — relies on `uniformState.view` / `projection` interpolating during morph. SCENE2D + CV unsafe (3D positions project to wandering points without a 2D attribute path).
- `WebGPUVector3DTilePolylinesRenderer` — SCENE2D + CV still gated; **MORPHING ✓ (Batch 207)** — same morph-aware uniformState path as ClampedPolylines.

**`Vector3DTile*` clarification (Batch 158):** Verified across the three Vector3DTile primitive classes that they only carry RTC-relative 3D positions (`_positions` Float32Array tied to `_center`) — no `position2DHigh/Low` attribute pairs. WebGL's path doesn't check scene mode either; it produces wandering volumes in 2D / CV silently. Our gate is BETTER than upstream for these renderers. Lifting it would be a regression unless paired with CPU- or shader-side projection of the RTC-relative positions, which is real ~80 LOC work per renderer. 3D-Tiles content is typically only viewed in SCENE3D in production, so this is low priority.

`WebGPUGroundPolylineRenderer` is NOT affected — Batches 116/117 era
shipped its full 2D + Columbus View + Morphing pipeline (parallel
2D attribute slots at locations 8-13, dedicated morph pipeline,
sceneMode flag in uniforms). The MORPHING fix below should mirror its
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

### ~~NEW-CLASSIFIER-GROUNDPRIM-2D-RENDERPASS~~ — RESOLVED (Batch 164)

**What:** A `GroundPrimitive` (ground-clamped polygon) on WebGPU in SCENE2D or COLUMBUS_VIEW threw `DeveloperError: _beginDefaultRenderPass() called with an active render pass (label='Scene Main Render Pass')`, halting ALL rendering (Viewer error dialog). Discovered Batch 161 by `probe-classifier-scenemode.mjs` once the SCENE3D crash (Bug 161.1) stopped masking it.

**Root cause (Batch 164):** A *cascading* failure. The diagnostic probe `probe-classifier-2d-renderpass.mjs` (wraps `scene.render()` in try/catch + captures the leaked pass label) traced the chronological origin:

1. In 2D/CV the WebGPU GroundPrimitive feature renderer returns NO commands — the polygon is a `_needs2DShader` primitive (`_hasSphericalExtentsAttribute`), which is silently skipped in non-3D modes (pending appearance2D).
2. `GroundPrimitive.update` then **fell through to the WebGL command path** (`updateAndQueueCommands` → `updateAndQueueRenderCommand`). On WebGPU that path's ShaderProgram-based commands are no-ops in 3D, but its SCENE2D/CV per-hemisphere derivation throws `TypeError: Cannot set properties of undefined (setting 'owner')` mid-frame.
3. The throw skips the scene renderer's `endFrame`, so the scene render pass stays open → the next frame's `beginFrame → _beginDefaultRenderPass` trips the active-pass guard → cascade + halt.

**Fix:** `GroundPrimitive.update` now `return`s after the feature-renderer attempt whenever the FR is present (WebGPU backend) — it never falls through to the WebGL command path. When the FR returns no commands (geometry still building, or a `_needs2DShader` skip in 2D/CV) the primitive renders nothing this frame and retries next frame, instead of running WebGL code that crashes on WebGPU.

**Verification:** `probe-classifier-2d-renderpass.mjs` — leaked pass label `null` (was "Scene Main Render Pass"), no thrown error, no cascade. `probe-classifier-scenemode.mjs` — SCENE2D/CV now **0 device errors** and ~0 red px (was 654 = the error-dialog background); SCENE3D unchanged (11.7k px). The probe now enforces 0 device errors for ALL modes.

**Residual (separate gap):** `_needs2DShader` GroundPrimitives (polygons with planar/spherical extents — essentially all of them) still render NOTHING in 2D/CV, pending the WGSL appearance2D path — tracked as NEW-GROUNDPRIM-TEXTURED-MATERIALS. They no longer crash; they degrade gracefully.

**Trace:** Batch 164; `GroundPrimitive.js` (no WebGL fall-through on WebGPU); `probe-classifier-2d-renderpass.mjs`; WEBGPU_DEBUGGING_LOG.md Bug 164.1.

---

### ~~NEW-GROUNDPRIM-TEXTURED-MATERIALS~~ — RESOLVED (Batch 185) — flat textured-material (Color / Stripe / Checkerboard / Grid) GroundPrimitive classification on WebGPU now renders

**Status (Batch 185, RESOLVED for flat materials):** Color / Stripe / Checkerboard / Grid textured-material classification now render on WebGPU. The Batch 171–174 "still render flat, blocked on globe depth precision" framing was **WRONG** — the real root cause was a `packExtents` wrapper-chain walk bug: the old hard-coded `primitive._primitive._primitive` lookup assumed exactly the 2-level GroundPrimitive chain, so the per-frame ClassificationPrimitive call (1 level) walked one hop too deep → null → `return false` → `packUniforms` wrote `materialMeta.x = 0`. That zero landed LAST in the shared uniform buffer, flipping `dsColorFS` to the flat-color fast path and rendering every textured material as solid `i.col`. **Fix (Batch 185):** `packExtents` now walks the wrapping chain until it finds the object that actually owns `_batchTable` (`WebGPUGroundPrimitiveRenderer.js:313` / loop at `:328`), mirroring the `_webgpuGeometryData` chain walk at the command-build site. Bug pinned via the `[GPDIAG]` `packUniforms` trace (Batch 184 — WEBGPU_DEBUGGING_LOG). The earlier depth-precision diagnosis (Batches 174/177) was a red herring for the flat-render symptom: the surface eye-space reconstruction is precise enough for the polygon-relative UV in the common (near-camera) case.

**Material dispatch infrastructure (Batches 171–174, all landed):** UBO extended 384 → 640 bytes carrying `invProj`, `materialMeta` / `materialColor` / `materialParam0/1`, planar-extent eye-space frame (`swCornerEC` / `eastwardEC` / `northwardEC`), spherical-extent params (`sphericalSW` + `invView`), and `frustum.xy = (near, far)`. WGSL `applyMaterial` dispatches on `materialMeta.x` with branches for Color, Stripe, Checkerboard, Grid. `resolveMaterialState` reads `Material.uniforms` per Cesium's API conventions (e.g. `horizontal: bool` for Stripe, not the `StripeOrientation` enum). `packExtents` reads per-instance extent attrs directly from `inner._batchTable.getBatchedAttribute(0, idx)` (bypasses the `getGeometryInstanceAttributes(id)` requirement so a GeometryInstance without an `id` works). `surfaceUV` dispatches between planar (CPU-transformed eye-space dot products) and spherical (`invView × eyeCoord` → approximate spherical with Cesium's `atan2(magXY, z)` + `atan2(x, y)` conventions). The per-slice `invProj` UBO (Batch 173) + bounding-volume frustum distribution (Batch 174) are both still required and in place. **0 device errors** across all materials in `probe-classifier-textured-materials.mjs`.

**Residual (genuinely open):** a far-corner reconstruction-precision degradation survives — tracked as **NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION** (below). Checkerboard degrades toward the far corner of large polygons; Stripe stays clean. This is the legitimately log-depth-gated remainder, plus the Image material type-4 case (texture upload + sampler BGL extension), NOT a blocker on the flat-render path which now ships.

**Re-scope note (Batch 161):** This was previously mis-filed inside NEW-CLASSIFIER-2D-CV-MORPH as "`_needs2DShader` primitives gated in non-3D modes pending a WGSL `appearance2D` equivalent." That framing was wrong: textured GroundPrimitives aren't rendered in 3D either, so it's not a 2D/CV projection gap — it's a missing textured-material classification path. The `GroundPolylineRenderer`'s `applyMaterial()` (8 inline material types incl. Image texture sampling) is the reference template.

**Remaining scope after Batch 185:** (a) ✅ per-slice `invProj` UBO + corrected `windowToEye` (Batch 173) — **but see (g): the resolver is NOT invoked for the color draw (Link 4 unresolved, Batch 184), so the color draw still binds the static slot-0 / `u.invProj` projection.** (b) ✅ mode-aware bounding volume → correct frustum-slice distribution (Batch 174, NEW-GROUNDPRIM-CLASSIFIER-FRUSTUM-DISTRIBUTION). (c) ✅ flat Color / Stripe / Checkerboard / Grid render (Batch 185 — `packExtents` wrapper-chain walk; the depth-precision diagnosis was a red herring for the flat-render symptom). (d) ⬜ far-corner reconstruction-precision degradation — NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION (below), the legitimately log-depth-gated residual. (e) ✅ **Image material support (Batch 198)** — group-0 material texture (@1) + sampler (@2) BGL extension, `ensureMaterialImage` async upload (URL / ImageBitmap / HTMLImage / Canvas / ImageData) + 1×1 white fallback + per-frame bind-group rebuild on view change, `materialType == 4u` `applyMaterial` Image branch (`textureSampleLevel(materialTex, materialSampler, fract(st·repeat)) · tint`). Renders (Image var 6791 vs WebGL 7475, lit parity 1.00). Follows the GroundPolyline pattern. (f) ⬜ 2D/CV textured variant — the Batch 170 `.zxy` swizzle already places the polygon. (g) ⬜ **whole-polygon UV FREQUENCY mismatch (~4× too fine on WebGPU) — NEW finding Batch 198, see RECON-PRECISION below; distinct from (d)'s far-corner artifact.**

**History note:** The Batch 171–174 framing ("hit a Cesium-wide architectural boundary; textured materials blocked on globe depth precision") over-attributed the flat-render symptom to the depth pipeline. The per-slice UBO + bounding-volume distribution work was real and necessary, but the flat-render bug was the `packExtents` wrapper-chain depth (Batch 185 fix). The far-corner residual that genuinely IS reconstruction-precision-bound is now tracked separately as NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION.

**2D-case progress (Batches 165 → 169):** The over-broad `_needs2DShader` non-3D skip is now **removed** (Batch 169) — the renderer is flat-color-only, so a flat-color polygon doesn't need appearance2D to render in 2D. The chain of 2D blockers peeled back as each was fixed:

1. (Batch 165) skip removal was first reverted because the WebGPU globe didn't render at regional 2D zoom (no surface/depth to classify).
2. (Batch 167) that globe blocker was fixed (NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM — 3D-ECEF bounding-volume cull).
3. (Batch 169) skip removed; tested. Globe + globe-depth now present in 2D; the classification command IS built (no `missing2DAttributes` skip) and the depth-sample discard is satisfied (ruled out by test). But the classification **volume still renders nothing** — it projects off-screen, because the bound `position2DHigh/Low` attributes are `(projX, projY, height)` while `camera.positionWC` in 2D is the ENU-frame `(altitude, projX, projY)`, so the RTE subtraction is component-wise garbage with ~20 Mm magnitude → off-screen vertices. Tracked as **NEW-CLASSIFIER-GROUNDPRIM-2D-RTE** (below).
4. (Batch 170) RTE coordinate-frame mismatch RESOLVED via a mode-conditional `.zxy` swizzle in `colorVS` / `vsVelocity` — matches WebGL's `czm_translateRelativeToEye(pos2D.zxy, pos2DLow.zxy)` convention at `PrimitiveShaderHelpers.js:291`. Flat-color 2D / CV classification now renders within ~6% of WebGL coverage; `probe-classifier-scenemode.mjs` flipped `ENFORCE_2D = true`.

**Order of operations (updated):** ✅ globe-2D (167) → ✅ skip removed (169) → ✅ VS-side .zxy swizzle for 2D RTE (170; resolves NEW-CLASSIFIER-GROUNDPRIM-2D-RTE) → ✅ flat-color 2D classification ships → ✅ flat textured materials (Color/Stripe/Checkerboard/Grid) render (Batch 185 packExtents fix) → ⬜ far-corner reconstruction precision (NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION) + Image material type-4 + 2D/CV textured variant remain.

**Trace:** Batch 161 (re-scoped out of NEW-CLASSIFIER-2D-CV-MORPH); Batch 165 (2D-globe blocker found); Batch 171 (material dispatch infrastructure landed; identified per-slice UBO blocker); Batch 184 (`[GPDIAG]` `packUniforms` trace pins `materialMeta.x = 0`); Batch 185 (`packExtents` wrapper-chain walk → flat materials render; commit `88b111e49c`); `WebGPUGroundPrimitiveRenderer.js::applyMaterial` + `surfaceUV` + `packExtents` (`:313`); `WebGPUGroundPolylineRenderer.js::applyMaterial` reference.

---

### NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION — textured GroundPrimitive classification degrades toward the far corner (eye-space reconstruction precision; log-depth-gated)

**What:** With flat textured-material classification rendering (Batch 185, see NEW-GROUNDPRIM-TEXTURED-MATERIALS above), a residual precision artifact survives: **Checkerboard degrades to solid toward the far corner** of a large polygon, while **Stripe stays clean**. The depth-sample classifier's `windowToEye` reconstruction hits catastrophic cancellation near `storedDepth ≈ 0.9999997` (standard hyperbolic NDC depth, no log encoding). The 2-D Checkerboard UV exposes the band-quantized eye-z; the 1-D Stripe pattern hides it because one axis is degenerate. This is the genuine, narrowed-down residual that the earlier (mis-attributed) "blocked on globe depth precision" framing was pointing at — but only for the far-corner case, NOT the whole flat-render path.

**Why deferred / log-depth-gated:** The clean fix is the renderer-wide log-depth path — a precise eye distance derived from log-encoded depth reverses cleanly without the near-1.0 hyperbolic crush. That work is in flight (NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION approach (A) — producer shipped Batches 182/183; consumer-reverse + classifier wiring remain). Until the classifier reads log depth and reverses it, the far-corner Checkerboard artifact persists. The common (near-camera) case ships.

**Verification (probe-classifier-textured-materials, Edge):** Stripe varR 0.01 → 1.74 (clean red/blue stripes, WebGL parity), Checkerboard varR → 1.43 (renders, but degrades toward far corner), Grid renders cells+lines, Color unaffected, 0 device errors.

**Scope:** (a) wire the GroundPrimitive classifier's `windowToEye` to consume log depth + reverse it once the globe producer/consumer log-depth path lands (NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION (A)); (b) re-verify Checkerboard far-corner parity via `probe-classifier-logdepth-flip.mjs` / `probe-classifier-logdepth-settle.mjs`.

**Trace:** Batch 185 (root-caused as the genuine residual after the `packExtents` fix; WEBGPU_DEBUGGING_LOG.md — "Remaining (genuine, now that the path runs)"); `windowToEye` catastrophic cancellation near `storedDepth ≈ 0.9999997`; depends on NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION (A) / the renderer-wide log-depth epic (Batches 181/182/183, master switch `_logDepthWriteEnabled` defaults FALSE).

**ADDITIONAL FINDING (Batch 198) — whole-polygon UV frequency ~4× too fine (DISTINCT from the far-corner artifact above):** Adding the Image material (type-4, Batch 198) made a previously-uncaught parity gap visible: at a 350 km nadir view the WebGPU textured UV tiles **~4× finer than WebGL across the ENTIRE polygon** (a Stripe with `repeat:10` shows ~30+ bands vs WebGL's ~10; the Image checkerboard reads as a fine magenta blur vs WebGL's crisp cells). The variance-based probes never caught this because **variance is frequency-blind** — a high-frequency red/blue pattern has ~constant variance regardless of tile count, so `probe-classifier-textured-materials.mjs` passed (Image var 6791 vs WebGL 7475, lit parity 1.00) while the tiling frequency was 4× off.

- **NOT the extents, NOT the OBB remap (both confirmed correct, empirically — `diag-groundprim-extents.mjs`):** `eastward` 58.6 km / `northward` 33.5 km world-space match the 0.7°×0.3° polygon; `uvMinAndExtents=[0,0,1,1]` + `uMaxVmax=[0,1,1,0]` = an identity u/v swap (zero scale effect).
- **Mechanism = a `windowToEye` invProj / depth-reconstruction mismatch** (the recovered `eye.xy` the UV derives from is uniformly scaled ~4×). The non-log `windowToEye` unprojects the sampled globe depth with `u.invProj` = `inverse(uniformState.projection)` captured at `createCommands` (scene-update) time; if that projection's near/far z-terms don't match the projection the globe actually WROTE the sampled depth with, `eye.w` — and thus `eye.xy` — is scaled.
- **CORRECTION (Batch 201) — the original "per-slice / Link 4 multi-frustum" framing below is LIKELY WRONG.** The C-R9 b3dm investigation established that with `scene.logarithmicDepthBuffer===true` (the default), the WebGPU render uses a SINGLE `[0.1, 1e8]` frustum (`View.js:423` + `Scene.js:533`), not a multi-slice partition. With one frustum there is no per-slice mismatch, so "the resolver isn't wired into the color draw (Link 4)" cannot be the cause of the 4×. The real shared root is almost certainly the SAME mid-flight log-depth epic that causes C-R9: the render frustum is the log-depth `[0.1, 1e8]` partition with **hyperbolic** (non-log) depth, and the classifier's `u.invProj` (captured at update time) and/or the coarse hyperbolic depth at `far=1e8` yield a scaled eye-space reconstruction. ~~per-slice / Link 4~~ — superseded.
- **RE-VERIFY FIRST (cheap, before any fix):** in `probe-classifier-textured-materials.mjs` dump `view.frustumCommandsList.length` + each `{near,far}`, and visualize `st` directly (output `vec4(fract(st),0,1)`), to measure the actual `st` range + confirm single vs multi frustum. (Note Batch 203: the C-R9 "fix A" frustum-partition gate was tried + REVERTED — multi-frustum did NOT fix the b3dm depth occlusion, so don't assume the partition is the lever here either; the shared root is the WebGPU globe-depth ↔ consumer handoff, see C-R9 corrected root cause.) THEN: if the 4× tracks the depth reconstruction, it is fixed alongside the C-R9 depth-comparability work + the eventual log-depth-epic completion (write log depth for the globe + reverse it in the classifier `windowToEye`). Also add a FREQUENCY assertion (band count / FFT, not just variance) so this can't silently regress.
- **Why deferred from Batch 198:** out of scope for "add the Image material" (the Image feature is complete + as-faithful as its shipped Stripe/Checkerboard siblings, which share this exact `windowToEye`); shares the log-depth-epic root with C-R9, best fixed together as a focused follow-up.

---

### ~~NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO~~ — RESOLVED (Batch 173) — per-slice frustum-state UBO landed; deeper blocker re-scoped to NEW-GROUNDPRIM-CLASSIFIER-FRUSTUM-DISTRIBUTION

**Status (Batch 173):** The per-slice frustum-state UBO is IMPLEMENTED + verified delivering correct per-slice `invProj` + `(near, far)` at draw time (confirmed via runtime logging: the resolver binds the active slice's projection, not the once-per-frame group-0 copy). Strategy #1 below was taken: a group-2 `FrustumState` UBO ring (one buffer per slice, indexed by `_currentFrustumIndex` to avoid `queue.writeBuffer` last-wins clobber), published from `WebGPUSceneRendererFrustumLoop` after `_updateFrustumUniforms`, bound via a third `bindGroupResolvers` entry. The Batch 171 `windowToEye` was ALSO corrected here — it wrongly applied `reverseLogDepth` to a LINEAR NDC depth (the globe pass does not log-encode); it now does the standard inverse-projection matching the proven GroundPolyline `windowToEyeCoordinates`. Flat-color classification verified non-regressing (`probe-classifier-scenemode.mjs` green).

**BUT textured materials are STILL not pixel-correct** — the per-slice UBO was necessary but NOT sufficient. Runtime diagnosis (Batch 173) found the deeper blocker: the classification command carries **no bounding volume**, so Cesium's multi-frustum command distribution puts it in the FARTHEST frustum slice (measured: slice 0 = near 1e8 / far 1e10 at a 350 km nadir view) instead of the NEAR slice that contains the surface (slice 1 = near 0.1 / far 1e8). Reconstructing the sampled depth with slice-0's projection gives an eye-z in the billions → planar UV clamps → flat render. Re-scoped as **NEW-GROUNDPRIM-CLASSIFIER-FRUSTUM-DISTRIBUTION** (below). The per-slice UBO will be the correct reconstruction input ONCE the command draws in the right slice.

**Original "What" (the per-slice mismatch — now fixed):** The GroundPrimitive depth-sample classifier FS recovers eye-space from a depth-sampled fragment via `eyeHomog = invProj * vec4(ndcXY, depthValue, 1)`, then computes the polygon-relative UV. This relies on `invProj` + `(near, far)` matching the projection that produced the depth being read. The UBO was packed ONCE per `packUniforms` (per frame at `Scene.update`, with whatever `uniformState.currentFrustum` was then — the full camera frustum), so the FS used the wrong matrix. Batch 173 moved `invProj`/`frustum` to a per-slice group-2 UBO bound at draw time.

**Symptom:** With the Batch 171 material dispatch live, Stripe / Checkerboard / Grid `GroundPrimitive`s render close to flat: variance 19-65 vs WebGL's 2300-9000. The polygon footprint matches WebGL exactly (litR = 1.00), the discard test fires correctly on sky pixels, and the materialType is correctly resolved — only the UV is broken. The flat-color Color path is unaffected because it doesn't read UV.

**How this surfaces in WebGL (and why it works there):** Cesium WebGL binds `czm_inverseProjection` and `czm_currentFrustum` as AUTOMATIC uniforms re-evaluated per draw. Each frustum-slice draw therefore reads the correct per-slice matrices, and `czm_windowToEyeCoordinates` reverses cleanly. In WebGPU the corresponding values are baked into the per-primitive UBO at update time, so the per-slice rebind never reaches the FS.

**Scope:** Pick ONE of these strategies and wire it through `WebGPUGroundPrimitiveRenderer` (then mirror to `WebGPUGroundPolylineRenderer` and any other classification renderer that takes the depth-sample path):

1. **Secondary frustum-state UBO with a bind-group resolver.** Add a tiny `frustumUB` carrying `invProj` (mat4) + `currentFrustum` (vec2) + reserved padding. Bind it as Group 1 Binding 2 (or a new Group 3) and resolve it at draw time via the existing `bindGroupResolvers` contract (Migration Session 3) — same pattern the depth-source view swap uses. Cheapest in renderer surface area; cost is one extra small UBO + per-slice bind-group cycle.
2. **Dynamic UBO offsets.** Allocate a 256-byte-aligned per-slice region in the main UBO and use `setBindGroup`'s dynamic offset array per draw. Avoids the extra binding; cost is per-slice UBO upload bookkeeping.
3. **Push constants** (WebGPU API extension; not portable yet). Skip for now.

Either #1 or #2 needs the per-slice `invProj` / `currentFrustum` snapshot exposed somewhere the WebGPU draw loop can reach — probably `WebGPUSceneRenderer`'s per-frustum hook, broadcasting via `context._currentFrustumProjection` or similar, mirroring how `_globeDepthView` is published per-slice.

**Implementation (Batch 173):** Strategy #1. Publish side: `WebGPUSceneRendererFrustumLoop.ts` snapshots `uniformState.inverseProjection` + `currentFrustum` onto `context._currentFrustumInvProj` / `_currentFrustumNearFar` / `_currentFrustumIndex` right after `_updateFrustumUniforms` (declared on `WebGPUContext.ts`). Consumer side: `WebGPUGroundPrimitiveRenderer.js` adds a group-2 `frustumStateBgl`, a per-slice UBO ring + bind groups (`ensureFrustumStateSlot` / `writeFrustumState`), and `resolveFrustumStateBindGroup` (third `bindGroupResolvers` entry). WGSL `windowToEye` reads `fstate.invProj` / `fstate.frustum`. The group-0 `u.invProj` / `u.frustum` are left in place (unread, harmless dead data) to avoid reshuffling the working UBO offsets.

**Trace:** Batch 171 (identified during NEW-GROUNDPRIM-TEXTURED-MATERIALS validation); Batch 173 (per-slice UBO + corrected windowToEye landed; deeper distribution blocker found); `WebGPUSceneRendererFrustumLoop.ts` publish; `WebGPUGroundPrimitiveRenderer.js` group-2 UBO + resolver + `windowToEye`; `WebGPUContext.ts` `_currentFrustum*` fields.

---

### ~~NEW-GROUNDPRIM-CLASSIFIER-FRUSTUM-DISTRIBUTION~~ — RESOLVED (Batch 174); textured materials now blocked one layer deeper on NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION

**Status (Batch 174):** RESOLVED — the classification command now carries a mode-appropriate bounding volume (`GroundPrimitive._boundingVolumes[0]` OBB in SCENE3D, `_boundingVolumes2D[0]` in Columbus View — exactly what WebGL `GroundPrimitive.updateAndQueueCommands` uses), so Cesium's multi-frustum distribution (`View.js`) assigns it to the slice containing its surface (verified: it now draws in slice 1 = near 0.1/far 1e8, not just the far slice 0 = near 1e8/far 1e10). Flat-color classification verified non-regressing (`probe-classifier-scenemode.mjs`: SCENE3D 11694 / SCENE2D 20781 / CV 14574, 0 errors). 2D/MORPHING left without a BV (single ortho frustum / transient; preserves Batch 170).

**But textured materials STILL render flat** — blocked one layer deeper. Even drawing in slice 1, the slice spans [0.1, 1e8] (≈100,000 km), so a 350 km surface sits at standard hyperbolic NDC depth ≈ 0.99999971. The globe depth is copied to an RGBA8-packed (24-bit) texture; one quantization step (≈6e-8) maps to a ≈±50-90 km eye-z error after inverse-projection — far larger than the ≈80 km polygon — so the reconstructed UV jumps between quantization bands and `applyMaterial` returns near-constant. Tracked as **NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION** (below). The flat-color path is unaffected (it only needs depth≠0 for the sky-discard, never reconstructs eye-space).

**Trace:** Batch 173 (per-slice invProj); Batch 174 (bounding-volume distribution fix; revealed the depth-precision floor); `WebGPUGroundPrimitiveRenderer.js` `sharedDrawArgs.boundingVolume`/`cull`; `GroundPrimitive.js:933-937` (WebGL reference); contrast Batch 167 (3D-ECEF BV culled in 2D — avoided here by mode-aware selection).

---

### NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION — classifier eye-space reconstruction needs log depth; producer shipped (Batches 182/183), consumer-reverse + classifier wiring remain

> **Status update (Batch 185, HEAD):** This is NO LONGER a "blocks all textured materials" gate — flat textured-material classification (Color/Stripe/Checkerboard/Grid) now renders (NEW-GROUNDPRIM-TEXTURED-MATERIALS RESOLVED, Batch 185). What remains gated on precise log depth is the **far-corner reconstruction-precision residual** (NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION — Checkerboard degrades toward the far corner). Approach (A) below has **partially landed**: the globe **producer** now writes log `frag_depth` (see the revised (A)).

**What:** The depth-sample classifiers (GroundPrimitive textured materials, and the GroundPolyline / Vector3DTile classifiers if they ever reconstruct precise eye-space) recover a surface eye position by inverse-projecting the sampled globe depth. That requires the depth to carry enough precision at the surface's distance. WebGL's globe FS gets `czm_writeLogDepth` **injected by the shader builder** when `useLogDepth` is on, so the depth buffer is **logarithmic** — well-distributed precision across a huge frustum — and WebGL's `czm_windowToEyeCoordinates` reverses it (the `#ifdef LOG_DEPTH` branch: `depthFromNear = exp2(logDepth * czm_log2FarDepthFromNearPlusOne) - 1`). On WebGPU the globe FS **now** can write log `@builtin(frag_depth)` under the `//>>ifdef LOG_DEPTH` block (`GlobeTerrain.wgsl:2541-2561` — `out.depth = csm_writeLogDepth(...)`, shipped Batches 182/183), but the **master switch `_logDepthWriteEnabled` defaults FALSE**, so by default the globe still writes **standard hyperbolic NDC z**, copied to an RGBA8-packed (24-bit) texture. At a 350 km surface in a [0.1, 1e8] frustum slice, depth ≈ 0.99999971 and one 24-bit quantization step ≈ ±50-90 km of reconstructed eye-z — too coarse for a precise polygon-relative UV at the far corner. (The near-camera common case reconstructs precisely enough — that is why flat materials render; only the far-corner Checkerboard residual remains.)

**Why flat-color is unaffected:** it only samples depth to test "is there a surface here" (discard on depth==0); it never reconstructs a position.

**Scope — REVISED after Batch 177 scoping (the proper fix is RENDERER-WIDE, not globe-local):**

Two approaches, both large:

- **(A) Log depth, the WebGL-parity fix — RENDERER-WIDE epic, PRODUCER SHIPPED (Batches 182/183), consumer-reverse + classifier wiring remain.** WebGL injects `czm_writeLogDepth` into EVERY shader that writes depth (globe, models, 3D tiles, primitives, collections), so they all share one logarithmic depth space and depth-test correctly against each other + the globe. The WebGPU geometry all renders into the SAME scene-framebuffer depth attachment and depth-tests against each other, so log depth CANNOT be applied to the globe alone — that would put the globe in a different depth space than 3D tiles / models / primitives and break depth testing globally (z-fighting, wrong occlusion). This is now its own in-progress epic (renderer-wide log depth):
  - ✅ **Slice 0** (Batch 181) — reconcile the `csm_*LogDepth` chunk family to one canonical WebGL-parity contract.
  - ✅ **Slice 1** (Batch 182) — shared inert infrastructure: define bit, master switch `_logDepthWriteEnabled` (defaults FALSE), lane helper.
  - ✅ **Slice 2a** (Batch 183) — the globe **producer** writes log `@builtin(frag_depth)` under `//>>ifdef LOG_DEPTH` (`GlobeTerrain.wgsl:2541-2561`), flag-gated.
  - ✅ **Slice 2b** (Batch 188) — the two **lit Phong primitive producers** (`PrimitivePhongColor.wgsl`, `PrimitivePhongTexturedColor.wgsl`) converted to the same gated `@builtin(frag_depth)` log-depth pattern. Renderer plumbing in `WebGPUPrimitiveCommands.js`: a 16-byte `logDepth` vec4 tail on the lit camera UB (`LIT_CAMERA_BYTES` 304→320, packed unconditionally by `writeRTEUniformsLit` → `writeLogDepthTail`); the lit pipeline ORs `ShaderDefine.LOG_DEPTH` when `isWebGPULogDepthActive(context, frameState)` with a `cache.logDepthEnabled` flip-invalidation guard. **INERT** until the master-switch flip (`defines=0` resolves the historical else-branch; `Mat*Lit` shaders keep their 304-byte struct and read only the first 304 bytes of the 320-byte buffer — valid WebGPU). `tsc` + `gulp build` clean. **Remaining Slice 2b producers DEFERRED:** the `Mat*` family (~40 Flat+Lit — codegen pass recommended), Primitive Basic/PBR + Model PBR (bare `@location(0)` returns → FragOutput wrap), Collections (Billboard/Label/Point/Polyline), `Buffer*` family, EllipsoidPrimitive (ray-march computed-depth special case), Vector3DTile. Excluded (not depth-writers): SkyAtmosphere, Sun/Moon. Special-case/skip: ShadowMap (light-space depth), DepthPlane, overlays, GaussianSplat.
  - ⬜ **Remaining** — flip the master switch by default once every other depth-writer participates; port `frag_depth = csm_writeLogDepth(...)` to ~every other WebGPU pipeline (models, 3D tiles, primitives, collections); and reverse it in every depth CONSUMER (classification reconstruct — the `windowToEye` in `WebGPUGroundPrimitiveRenderer`, Billboard/Label/Model-edge `linearizeWindowDepth`, `pickPosition`, terrain clamp). The classifier-reverse wiring is what NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION needs; it remains a foundational, multi-batch change with broad regression surface, but the foundation (producer + infra) is no longer un-started.
  - **De-risk attempted 2026-06-05 — INCONCLUSIVE; completing the epic is NOT yet justified.** A payoff probe (`Tools/visual-regression/probe-logdepth-payoff.mjs`) flipped `_logDepthWriteEnabled` at RUNTIME on a globe-only Checkerboard scene to test whether log depth fixes the far-corner artifact. The flip MECHANISM engaged cleanly (`useLogDepth=true`, no crash) — good. But the test was inconclusive: (1) a runtime flip does NOT rebuild already-built pipelines, so the globe kept `LOG_DEPTH=0` (producer + consumer were not both in log-space); a clean test needs a STARTUP flip, which a probe cannot do without performing the actual hazardous flip (a code change defaulting the switch on + rebuilding every pipeline). (2) the probe env had no Ion imagery (401s → the OFF baseline rendered empty). (3) the Checkerboard far-corner artifact persisted in the ON capture, but inconclusively (the classifier consumer-reverse may not have engaged). **NET:** the classifier log-depth consumer-reverse correctness is still UNVERIFIED end-to-end and the epic's payoff is unproven. Before committing the ~50-shader producer sweep + the master-switch flip, a focused investigation must first PROVE the classifier log-reverse actually corrects precision (real startup flip + working imagery + per-subsystem visual verification). This is a dedicated investigation, NOT a mechanical wave — and the flip is an all-or-nothing global depth-space change (every depth writer + consumer must participate at once), so it must not be fire-and-forwarded.

- **(B) A separate precise classifier-depth target — contained but a workaround.** Add an R32F render target to the globe pass into which the globe FS writes LINEAR eye-z (`positionEC.z`, full float precision distributed linearly, no near-1.0 hyperbolic crush). Classifiers sample that target → eye-z directly, no inverse-projection-from-NDC. Doesn't touch the shared depth buffer, so pick / clamp / depth-test / Billboard / Model-edge are UNAFFECTED. Cost: an extra globe MRT target (bandwidth every globe frame) + plumbing (target alloc, MRT config, copy/resolve, bind to the 4 classifier renderers) + diverges from WebGL. ~Multi-day, contained. The 16-bit normalRoughness slot CANNOT carry eye-z (16-bit float at 350 km ≈ 170 m precision — insufficient for an ~80 km polygon UV); it needs a dedicated 32-bit target.

**Recommendation:** Approach (A) is the long-term-correct parity fix but is foundational (renderer-wide log depth — arguably its own epic, valuable beyond classification: it also fixes pick precision + depth precision everywhere). Approach (B) unblocks textured-material classification specifically without the renderer-wide risk. Pick (B) if textured ground materials are the priority; pick (A) as a deliberate foundational investment (it would also retire a class of distance-precision bugs across pick/billboard/model-edge).

**Why deferred:** Far beyond the textured-material slice it surfaced under; it's a globe-depth-precision architecture change with broad blast radius (every depth consumer). The flat-color AND flat-textured classification paths — the common case — now ship and are unaffected (Batch 185). Only the **far-corner reconstruction-precision residual** (NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION) waits on the consumer-reverse half of the log-depth epic.

**Trace:** Batch 174 (root-caused via the per-quantization-step eye-z error analysis); Batches 181/182/183 (log-depth epic Slices 0/1/2a — chunk reconcile + inert infra + globe producer); `GlobeTerrain.wgsl:2541-2561` (`//>>ifdef LOG_DEPTH` → `out.depth = csm_writeLogDepth(...)`, flag-gated, master switch defaults FALSE); WebGL `GlobeFS` + injected `czm_writeLogDepth` + `czm_windowToEyeCoordinates` `LOG_DEPTH` branch (the reference); `csm_writeLogDepth.wgsl` / `csm_reverseLogDepth.wgsl` (existing chunks); `WebGPUGlobeDepth.ts` (RGBA8 pack).

---

### (historical) NEW-GROUNDPRIM-CLASSIFIER-FRUSTUM-DISTRIBUTION — classification command drawn in the wrong (far) frustum slice; textured-material UV reconstructs garbage

**What:** A textured-material `GroundPrimitive` classification volume reconstructs eye-space from the sampled globe depth (`windowToEye` → planar/spherical UV → `applyMaterial`). For that reconstruction to be correct, the command must draw in the SAME frustum slice whose globe depth it samples, and reconstruct with THAT slice's projection (now available per-slice after Batch 173). It doesn't: the classification `WebGPUDrawCommand` is built with **no `boundingVolume`**, so Cesium's multi-frustum command distribution does not place it in the slice containing its surface — it lands in the farthest slice.

**Runtime evidence (Batch 173, 350 km nadir, sub-1° polygon, SCENE3D):** 2 frustums — slice 0 = `near 1e8 / far 1e10` (far/empty), slice 1 = `near 0.1 / far 1e8` (contains the ~350 km surface). The classifier draws in slice 0; the per-slice resolver correctly delivers slice-0's `invProj`, but reconstructing the sampled depth there yields eye-z ≈ 1e9 m. `toSW = ec − swCornerEC` is then enormous → `st` clamps to `[0,1]` extremes → `applyMaterial` returns a constant (solid `evenColor`). Probe `texmat-Stripe-webgpu.png` shows a solid-red quad; variance ~50 vs WebGL ~5578.

**Why WebGL is fine:** WebGL's classification color command carries the shadow-volume bounding sphere, so it is frustum-distributed to the slice matching its surface; `czm_globeDepthTexture` + `czm_currentFrustum` are per-frustum automatic uniforms, so depth and reconstruction are always the same slice. The flat-color WebGPU path is unaffected because it never reconstructs eye-space (it only samples depth for the sky-discard test, `dsColorFS` short-circuits at `materialType == 0`).

**Scope:** Give the WebGPU classification `WebGPUDrawCommand` a bounding volume (the shadow-volume bounding sphere, available on the inner `Primitive._boundingSpheres` / per-instance bounding sphere) so it is distributed to the correct frustum slice — MODE-AWARE: in SCENE2D / Columbus View a 3D-ECEF bounding volume must NOT be attached (that was the Batch 167 globe-2D cull bug — a 3D BV culled by a 2D frustum), so attach the BV only in SCENE3D, or drop per-command culling while still using the BV purely for frustum-slice assignment. Verify the command then draws in the near slice and the Batch 173 per-slice `invProj` reconstructs correct UV. Then flip `ENFORCE_TEXTURED = true` in `probe-classifier-textured-materials.mjs`. Mirror the BV fix to GroundPolyline + the Vector3DTile classifiers if they share the gap.

**Why deferred:** The bounding-volume / frustum-distribution change interacts with culling (risk of culling the polygon away, esp. in 2D/CV — see Batch 167) and with the existing no-bounding-volume design that the 2D-RTE fix (Batch 170) relied on. It needs careful mode-aware handling + probe verification across SCENE3D / 2D / CV, which is its own focused slice. The Batch 173 per-slice UBO is the necessary companion infrastructure and is already in place.

**Trace:** Batch 173 (diagnosed via runtime FDIAG/GPDIAG logging — 2 frustums, classifier in slice 0); `WebGPUGroundPrimitiveRenderer.js` `sharedDrawArgs` (no `boundingVolume`); contrast Batch 167 NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM (3D-ECEF BV culled in 2D); `windowToEye` consumer; `probe-classifier-textured-materials.mjs`.

---

### ~~NEW-CLASSIFIER-GROUNDPRIM-2D-RTE~~ — RESOLVED (Batch 170) — GroundPrimitive classification volume rendered off-screen in SCENE2D / Columbus View

**What:** With the globe rendering in 2D (Batch 167) and the `_needs2DShader` skip removed (Batch 169), a flat-color `GroundPrimitive` STILL rendered nothing in SCENE2D / COLUMBUS_VIEW — the classification shadow volume projected off-screen, so no fragments reached the depth-sample FS.

**Root cause (Batch 170, after a wrong-end revert):** coordinate-frame mismatch between the bound `position2DHigh/Low` vertex attributes and the encoded camera position fed to the RTE subtraction in `colorVS`. `GeometryPipeline.projectTo2D` writes `position2D = (projX, projY, height)` — the natural output of `mapProjection.project(cartographic)`, NO swizzle. But `camera.positionWC` in SCENE2D / COLUMBUS_VIEW is in the camera's ENU frame `(altitude, projX, projY)` — applied by `TRANSFORM_2D` in `CameraInternals.updateMembers` (so `positionWC.x = altitude`, `.y = projX`, `.z = projY`). The 2D view matrix is built from that ENU camera, so the VS must subtract in ENU space. The RTE math `position2D − camera = (projX-alt, projY-projX, height-projY)` was component-wise garbage; the magnitude of `±π * semimajorAxis` (≈ ±20 Mm) shoved the volume completely off-screen.

**Diagnosis trail (all ruled out before landing here):** the command IS built in 2D (no `missing2DAttributes` skip — geometry has the 2D pair); the depth source IS published (Batch 167 globe-depth-in-2D); the depth-sample discard is NOT the cause (removing `dsColorFS`'s `if (surfaceDepth==0) discard` changed nothing — the volume produces 0 fragments regardless); the command carries no bounding volume so it is NOT culled. Process of elimination ⇒ off-screen vertex transform ⇒ the RTE camera-space mismatch above.

**False-start (recorded for future debugs):** the first Batch 170 attempt encoded `mapProjection.project(camera.positionCartographic)` into `encodedCamera` for non-3D modes, intending to give the camera the same `(projX, projY, height)` convention as the bound vertices. That was the WRONG END — the VS would then have to multiply by a view matrix that ALSO expected `(projX, projY, height)` input, but `uniformState.view` was built from the ENU camera and expects `(altitude, projX, projY)`. Reverted within the same batch. The lesson: when a renderer has multiple coordinate conventions, identify which one is fixed (the view matrix) and adapt the other (the vertex attributes) to it, not the other way around.

**Fix (landed Batch 170):** mirror WebGL's `czm_translateRelativeToEye(pos2D.zxy, pos2DLow.zxy)` convention from `PrimitiveShaderHelpers.js:291`. The non-morph `colorVS` (and the `vsVelocity` clone) now apply a mode-conditional `.zxy` swizzle to the bound positions, gated by `morphFlags.x` (1.0 = SCENE3D, 0.0 = SCENE2D / CV): `let pHm = mix(pH.zxy, pH, vec3<f32>(is3D))`. SCENE3D keeps unswizzled ECEF positions (identity through `mix(_, _, 1.0)`); SCENE2D / CV swizzles `(projX, projY, height)` → `(height, projX, projY)` so the RTE subtraction composes in the ENU space matching the view matrix and `camera.positionWC`. No JS-side packing change needed. The MORPHING path was already correct (Batch 164 `morphColorVS` applies the same `.zxy` swizzle on the 2D attribute pair).

**Verification:** `Tools/visual-regression/probe-classifier-scenemode.mjs` flipped `ENFORCE_2D = true` and PASSes on all three modes — SCENE3D 11694 px (was 11694; no regression), **SCENE2D 20781 px (was 2)**, **COLUMBUS_VIEW 14574 px (was 2)**, 0 device errors. WebGL coverage was 11493 / 20787 / 15484 respectively — WebGPU within ~0.03% / 0.03% / 5.9%. PNGs visually confirm the red classification polygon now renders over the imagery globe in both 2D and CV.

**Trace:** Batch 169 (localized to a coordinate-frame mismatch, but wrong end was identified — said "encode 2D-projected camera in `packUniforms`"); Batch 170 (correct fix — VS-side `.zxy` swizzle, matching WebGL's `czm_translateRelativeToEye(.zxy, .zxy)` convention); `WebGPUGroundPrimitiveRenderer.js` `colorVS` + `vsVelocity` (.zxy swizzle gated by `morphFlags.x`); `PrimitiveShaderHelpers.js:291` (WebGL convention reference); `CameraInternals.updateMembers:282-293` (ENU swizzle that makes `positionWC` in 2D = `(altitude, projX, projY)`); `probe-classifier-scenemode.mjs` (now enforces 2D/CV coverage).

---

### ~~NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM~~ — RESOLVED (Batch 167) — WebGPU globe vanished at regional 2D zoom

**What:** In `SceneMode.SCENE2D` (and Columbus View), the WebGPU globe rendered at full-globe zoom (camera ~38 Mm) but **nothing** at regional zoom (~2.4 Mm) — fully blank where WebGL showed the regional map. Found Batch 165; resolved Batch 167.

**Root cause (Batch 167):** the globe draw command (built in `GlobeSurfaceTileProviderRendering.js`, the WebGPU branch) was created with `cull: true` and a **3D-ECEF bounding volume** — `boundingVolume: tileBR.boundingSphere`, `orientedBoundingBox: tileBR.boundingVolume`, both from `surfaceTile.tileBoundingRegion` (centered ~6.4 Mm from the origin in ECEF space). The per-command frustum cull (the GPU culler at `WebGPUSceneRenderer.ts:~3220`, which tests `command.boundingVolume.center` against the frustum planes) then ran those 3D-ECEF volumes against the **2D PROJECTED** frustum. At regional zoom the small 2D frustum's planes are nowhere near the ECEF sphere → every tile culled → blank. At full-globe zoom the frustum is huge enough to straddle the sphere by coincidence → tiles survive → renders. (This is why it was zoom-dependent.)

**Fix:** in non-3D scene modes, drop the 3D bounding volume + per-command cull on the globe command (`boundingVolume`/`orientedBoundingBox` = `undefined`, `cull: false`). The `QuadtreePrimitive` already performs the authoritative, mode-correct visibility cull when it selects the tiles to render, so the per-command cull is redundant in 2D/CV and was actively wrong there. SCENE3D keeps the 3D volume.

**Verification:** `Tools/visual-regression/probe-2d-globe-render.mjs` (new) — regional 2D over Lake Superior, WebGL vs WebGPU non-dark-pixel count. After the fix: regional WebGPU **250 000 px vs WebGL 233 397** (ratio 1.07, was ~0), full-globe ratio 1.45, 0 device errors. PNG visually confirms the Great Lakes region renders.

**Diagnostic note (for future "WebGPU renders blank" investigations):** the path here was long because intermediate timing-sensitive DIAG probes gave conflicting reads (e.g. a `selectPipeline`-returns-null snapshot over 4 warm-up frames suggested a pipeline-cache cause — a red herring). The decisive tests were (a) a magenta-FS override confirming tiles produced **0 on-screen fragments** at regional 2D, and (b) a hardcoded full-screen vertex position that STILL produced 0 fragments — proving the draw never executed (transform-independent) and pointing at execution-time culling, not selection/pipeline/transform. `probe-2d-zoom-globe.mjs` (tile-count + frustum diff) is kept as the entry-point diagnostic.

**Trace:** Batch 165 (found); Batch 166 (interim localization, partly mis-attributed to the pipeline cache); Batch 167 (true root cause — 3D-ECEF bounding-volume cull in 2D — + fix in `GlobeSurfaceTileProviderRendering.js`); `Tools/visual-regression/probe-2d-globe-render.mjs` (regression guard).

---

### ~~NEW-COLLECTIONS-MOTION-VECTORS~~ — RESOLVED (Batches 143 + 144 + 148; advanced primitives shipped in NEW-ADVANCED-MOTION-VECTORS Batches 168-173; doc-sync Batch 219)

> **Batch 234 correction:** the emission gates written in these batches read
> `frameState.scene?.taaEnabled`, which never existed at runtime — so none of
> this velocity code actually EXECUTED until Batch 234 published the canonical
> `frameState.taaEnabled` and switched every gate to it
> (NEW-COLLECTIONS-TAA-GATE-DORMANT). First real execution was validation-clean
> after the same batch's TAA→MSAA=1 coupling (probe-taa-velocity-emission.mjs).
> The TAA resolve stage that CONSUMES the velocity texture is still dormant —
> NEW-TAA-EFFECT-NEVER-ADDED.

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

**Beyond Collections — RESOLVED (Batch 219 doc-sync):**

All four advanced primitive families shipped under `NEW-ADVANCED-MOTION-VECTORS`:

- **PointCloud** — Batches 168-169 (`9fb22d5291` + `f43e0677d3` + `634067a50e`).
- **CloudCollection** — Batch 170 (`c7edc86305`).
- **GaussianSplat** — Batches 171-172 (`f22a6fbd24` + `abd3daed33`).
- **Voxel** — Batch 173 (`15d007f21b`, CLOSES B.10 family).
- **GroundPrimitive / Vector3DTile* classifiers** — explicitly low-priority and out of scope (don't animate per-frame; camera-only fallback is correct for the static case).

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

### ~~NEW-KHR-IRIDESCENCE-LUT~~ — RESOLVED (Batch 181, analytical Belcour 2017)

**Resolution:** Replaced the cos-phase hue-shift approximation with
the Belcour & Barla 2017 analytical thin-film iridescence formula
(Snell + total-internal-reflection guard + Schlick Fresnel for the
two interfaces + per-channel Gaussian-fit sensitivity for the m=1
and m=2 oscillating terms). LUT-free: the analytical evaluation
fits the spectral integral well enough that no texture upload is
required, eliminating the LUT-resource bulk that originally pushed
this entry into the deferred bucket.

The implementation in `ModelPBRComplete.wgsl` mirrors the Belcour
reference port shipped in three.js / Khronos-Sample-Viewer: optical
path difference `D = 2 × η_film × thickness × cos(θ_film)`,
sensitivity Gaussian constants tuned to the CIE 1931 color-matching
functions integrated against a D65 illuminant, m=1 and m=2 cosine
oscillators per RGB channel. Spectrally-correct Fresnel modulation
without the LUT-keyed sample.

**Trace:** Batch 181; `ModelPBRComplete.wgsl` (iridescence block —
search for `Belcour` or `sensitivity Gaussian`).

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

### ~~NEW-KHR-TRANSMISSION-THICKNESS~~ — RESOLVED (Batch 176)

**Resolution:** `ModelPBRComplete.wgsl` now pre-computes
`thicknessForKHR` (sampled from the volume thickness texture when
present, falling back to the appearance/material thickness factor
otherwise) and shares it between the transmission and volume blocks.
The transmission UV-offset step is modulated by `1 + 4 × thickness`
so refraction sample distance varies with the underlying asset
geometry — glass-thickness now correctly couples KHR_materials_volume
to KHR_materials_transmission per spec.

**Trace:** Batch 176; `ModelPBRComplete.wgsl` (transmission + volume
blocks; `thicknessForKHR` shared local).

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

### ~~C-R7-SHADER-MODULE-DEDUP~~ — RESOLVED (shader-module-dedup closure batch — NOTE: a DIFFERENT batch than git HEAD's Batch 185)

> **⚠️ Duplicate "Batch 185" label disambiguation (2026-05-30):** git HEAD's Batch 185 (`88b111e49c`, 2026-05-06) is the **`packExtents` wrapper-chain fix** (NEW-GROUNDPRIM-TEXTURED-MATERIALS, above). The shader-module-dedup closure below was *also* labeled "Batch 185 (2026-05-06)" — that is a **label collision**, not the same batch. The dedup IDs 30/31/32/33 (GroundPrimitive/GroundPolyline/SkyAtmosphere/EllipsoidPrimitive) closure is treated here as the **shader-dedup closure batch (S-185')** to disambiguate; it has NOT been re-verified against HEAD's actual Batch 185 commit and should be cross-checked against the `WebGPUShaderModuleCache` adopter list before being trusted as landed.

**Resolution:** All Cesium-authored WGSL renderers now resolve their `GPUShaderModule`s through a per-device `WebGPUShaderModuleCache.getOrCreate(sourceId, code, defines, label)`.

**Adoption history:**

- Batch 72 (2026-04-27) — Cloud + Voxel + Weather (render + compute).
- Batch 74 (2026-04-27) — Environment (Sun + Moon), VolumetricFog (compute + composite), PointCloud (default + LOD).
- Batch 162 (2026-05-02) — Model PBR (`MODEL_PBR_COMPLETE` ID 23). One module shared across all `Model` instances on a device.
- Batch 163 (2026-05-02) — Vector 3D Tile family (IDs 24/25/26: `VECTOR_3DTILE_PRIMITIVE`, `VECTOR_3DTILE_POLYLINES`, `VECTOR_3DTILE_CLAMPED_POLYLINES`).
- Batch 164 (2026-05-02) — BufferPrimitive family (IDs 27/28/29: `BUFFER_POINT_MATERIAL`, `BUFFER_POLYLINE_MATERIAL`, `BUFFER_POLYGON_MATERIAL`).
- **Shader-dedup closure batch S-185' (labeled "Batch 185 (2026-05-06)"; distinct from git HEAD Batch 185 = packExtents).** GroundPrimitive + GroundPolyline + SkyAtmosphere + EllipsoidPrimitive (IDs 30/31/32/33). Low-win renderers (typically few-per-scene), but rode along with the Batches 180/183 velocity work that just touched the two ground classifiers and unifies the pattern across the full renderer family.

Existing adopters from earlier batches: Polyline, PointPrimitive, Billboard, Label, GlobeSurface.

**Trace:** Batches 72/74/162/163/164 + the shader-dedup closure batch S-185' (see disambiguation banner above). `WebGPUShaderDefines.ts` `ShaderSourceId` registry covers IDs 1-33; every renderer in `packages/engine/Source/Renderer/WebGPU/` that builds Cesium-authored WGSL routes through a `WebGPUShaderModuleCache` keyed by one of those source IDs.

---

## C-R8 - Translucent classification follow-ups

**Parent finding:** Six C-R8 sub-items shipped Batches 35-51 (globeDepth, VOXELS-before-OPAQUE, 2D frustum jitter, InvertClassification, Edge FBO+inline, Translucent tile classification first-cut). Three named follow-ups remain on translucent classification leg; MSAA gate closed Batch 61.

### ~~C-R8-TRANSLUCENT-DEPTH-ONLY~~ — RESOLVED (Batches 78-79, doc-sync Batch 193)

**Status: Resolved (different mechanism) — Batches 78-79.**

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

### ~~C-R8-TRANSLUCENT-MULTI-FRUSTUM~~ — SUPERSEDED (folded into Migration Session 3, doc-sync Batch 193)

**Status: Superseded — folded into Migration Session 3 of the depth-sampling architecture pivot (see ADR-2026-04-28 above).**

**What (original):** Multi-frustum accumulation not wired. `executePackDepth` runs once per frame, capturing only last-rendered frustum's depth.

**Why paused:** the architectural pivot replaces the stencil-based classifier with depth-texture sampling. In the new architecture, "multi-frustum" reduces to "swap the bound depth-source view per frustum draw" rather than "redirect a render pass into a scratch FBO and accumulate stencil bits." Building the stencil-based accumulation now would land code that the architecture migration deletes a few sessions later.

The Batch 47 scaffolding (`_classificationColorTexture`, `composite()`, `_runTranslucentTileClassificationComposite`, `_ensureCompositePipeline`, `COMPOSITE_WGSL`) was designed for the stencil-accumulation path. Migration Session 5 is the point where it gets removed, NOT before — the depth-sampling consumer needs `_packedTranslucentDepthView` and `_packedDepthTexture` to remain wired for as long as the stencil classifier still ships in the same build.

**Re-scoped impact:** Multi-frustum correctness folds into Migration Session 3 (per-frustum depth-source bind groups). No standalone work item remains.

**Trace:** REVIEW_FIX_PROGRESS.md:2132. Audit 2026-04-28.

### ~~C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH~~ — SUPERSEDED (replaced by C-R8-CLASSIFICATION-DEPTH-SAMPLING, doc-sync Batch 193)

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

### ~~NEW-GS-CLASSIFICATION-DEPTH~~ — RESOLVED (doc-sync Batch 193)

**Resolution:** Audit walk found Gaussian Splat already implements the Batch-79-Model pattern. The deferred entry's "1 session" estimate predated the implementation and was never reconciled.

- `WebGPUGaussianSplatRenderer.ts:43-44, 500-502, 957-982` allocates `depthWritePipeline` as a sibling of the standard splat pipeline with `depthWriteEnabled: true`, attaches it to the splat command's `classificationDepthPipeline` slot, and the dispatcher swaps to it when `depthForTranslucentClassification === true` is flagged by `Cesium3DTile.js`.
- Mirrors the Batch 79 Model fix architecturally byte-for-byte — same flag plumbing, same per-tile gate, same dispatcher swap.
- Coverage is now: Model (Batch 79), PointCloud (already writes depth unconditionally), Gaussian Splat (this work). Vector3DTile* are classifiers, not classified-against content.

**Trace:** `WebGPUGaussianSplatRenderer.ts:43, 500, 957-982`. Original framing: PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md. Closes the C-R8-CLASSIFICATION-DEPTH-SAMPLING content-type-coverage tail.

### ~~C-R8-CLASSIFICATION-PRIMITIVE-GEOM-PLUMBING~~ FIXED 2026-04-28 (Batch 81)

**Resolution:** Two distinct gaps that compounded into a single visible failure:

1. **Renderer was reading the wrong nesting level.** `_webgpuGeometryData` IS populated by `Scene/PrimitiveGeometryHelpers.js:788` on the innermost Cesium `Primitive`, but the wrapping chain for a `GroundPrimitive` is `_GroundPrimitive` → `._primitive` (`ClassificationPrimitive`) → `._primitive` (`Primitive`) → `._webgpuGeometryData`. The renderer was reading the slot off the `_GroundPrimitive` argument directly, where it never lives. **Fix:** walk-the-chain lookup at `WebGPUGroundPrimitiveRenderer.js` — try `primitive._webgpuGeometryData ?? primitive._primitive?._webgpuGeometryData ?? primitive._primitive?._primitive?._webgpuGeometryData`. Direct `Primitive` and `ClassificationPrimitive` callers work through the same lookup with shorter chains.

2. **`createVertexBuffer` was called with the wrong arguments.** The legacy renderer's call site was `WebGPUBuffer.createVertexBuffer(device, vbData.byteLength, false, label)` — but the API is `(device, data, label)`. Passing `byteLength` (a number) as `data` made the inner `data.byteLength` lookup return `undefined`, which the `createBuffer` validation rejected as "Value is not of type 'unsigned long long'". **Fix:** pass the typed array directly; drop the redundant `device.queue.writeBuffer` call (the helper writes data internally).

**Producer side was already correct.** `ClassificationPrimitive.js:417` constructs an internal `Primitive`, and that internal Primitive's `update` → `createVertexArray` flow runs the existing `PrimitiveGeometryHelpers.js:788` populator. No new populator was needed; the chain just needed to be walked on the renderer side.

**Validation:** A programmatically added `RectangleGeometry`-backed `GroundPrimitive` now reaches the renderer with `cache.vertexCount = 384, cache.indexCount = 1716, cache.indexFormat = "uint16"` populated, the depth-sample bind group constructed, and zero console errors during dispatch. Visual output verification is gated on a separate WebGPU canvas-rendering issue (the canvas appears black even on the default CesiumViewer page without any classification primitives — surfaced 2026-04-28, separate investigation).

**Files touched:** `packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js`. Minor: marked the legacy stencil pipelines now compile and dispatch correctly too — both classifier paths are runtime-functional after Batch 81 modulo the canvas-rendering investigation.

**Closing batch:** Batch 81.

### ~~C-R8-GROUND-POLYLINE-NATIVE~~ — RESOLVED 2026-04-30

**Resolution:** Three independent bugs combined into a single
silently-invisible-polylines-on-terrain failure on WebGPU. All three
fixed; renderer now produces visible per-instance-colored polylines
end-to-end.

1. **Pipeline `depthCompare: "less-equal"` → `"always"`** (Batch 116,
   color + pick + morph color + morph pick). The WebGL `getRenderState`
   only sets `depthMask: false` and never enables depth test; the
   WebGPU pipeline was incorrectly culling fragments where the
   volume's geometric depth lay behind the depth buffer. The
   classifier samples globe depth in the FS and reconstructs the
   surface position itself — the volume must rasterize everywhere it
   covers screen-space.
2. **Per-instance color decoding** (Batch 116, `ensureBatchTableSnapshot`).
   `BatchTable.getBatchedAttribute(i, colorIndex)` returns a `Cartesian4`
   (`{x, y, z, w}`) for 4-component attributes, not a normalized
   `Color`. For UNSIGNED_BYTE color attributes (the common case via
   `ColorGeometryInstanceAttribute.fromColor`), values come back in
   [0, 255] range and need scaling by `1/255`. The previous code only
   handled the `{red, green, blue, alpha}` shape and fell through to
   the white default.
3. **Viewport sourced from `uniformState.viewportCartesian4` whose
   `.zw` were zero at FR-update time** (2026-04-30 fix, the
   long-tail VS bug). The FR's `packUniforms` runs during Scene
   primitive update — BEFORE the per-frame viewport is established
   on `uniformState`. At that time `viewportCartesian4` exists as a
   zero-initialized Cartesian4, and `viewport?.z ?? fallback` never
   falls through (0 is not nullish). With `viewport.zw = (0, 0)` the
   shader's `metersPerPixel = 2.0 / (viewport.z * proj[0][0])`
   returned Infinity, the width-extrusion math pushed vertices to
   NaN clip-space, and every triangle was silently culled. Fixed by
   sourcing from `context.drawingBufferWidth/Height` directly
   (matches the pattern used by Ellipsoid / BufferPrimitive /
   GaussianSplat / Globe).

**Trace:** Batch 116 (depth-test + color); 2026-04-30 (viewport
source). `WebGPUGroundPolylineRenderer.js` module-level docstring
documents all three. `Tools/visual-regression/verify-ground-polyline-zoom.mjs`
now passes.

### ~~C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES~~ — RESOLVED (Batches 114 + 115, MORPHING Batch 208, doc-sync Batch 219)

**Status:** Shipped in Batch 114 — `WebGPUVector3DTileClampedPolylinesRenderer.js` ports the WebGL VS + FS into a single 7-attribute interleaved WGSL pipeline, with the depth-sample classifier replacing the WebGL stencil-based classifier. `Vector3DTileClampedPolylines.update()` delegates to `FeatureRendererKey.VECTOR_3DTILE_CLAMPED_POLYLINE` on WebGPU; `finishVertexArray` retains the worker-decoded shadow-volume arrays for the FR to upload.

**What landed:**

- WGSL VS port of `Vector3DTileClampedPolylinesVS.glsl` (per-vertex prism extrusion + miter push + manual depth clamp).
- WGSL FS port of `Vector3DTileClampedPolylinesFS.glsl` (depth-sampled classifier with 5-plane test).
- 7-attribute interleaved vertex layout in a 96-byte stream (`startEllipsoidNormal` + `batchId` packed into the same 16-byte slot).
- Per-batch color via storage buffer indexed by `batchId`.
- Pass routing for TERRAIN / 3D-TILE / BOTH classification types.
- **Per-feature pick** (Batch 115) — `pickColors[batchId]` storage buffer at `@group(0) @binding(2)`, second `pickPipeline` sharing the VS, `pickCommands` returned alongside `colorCommands`.
- **MORPHING** (Batch 208) — `uniformState.view`/`projection` interpolation handles the morph transition.

**Companion FRs from Batches 112-113:**

- `Vector3DTilePrimitive` (extruded polygon classifier) — `WebGPUVector3DTilePrimitiveRenderer.js`.
- `Vector3DTilePolylines` (NON-clamped 3D polylines) — `WebGPUVector3DTilePolylinesRenderer.js`.

**Remaining items (low-priority diagnostics, not blocking):**

- Distinct depth source per pass (TERRAIN reads globe-depth-only; 3D-TILE reads packed-translucent). Current code picks whichever source is bound, matching the simplification used in `WebGPUVector3DTilePrimitiveRenderer`.
- `DEBUG_SHOW_VOLUME` mode visualization. Diagnostic-only.
- SCENE2D + COLUMBUS_VIEW — tracked under `NEW-CLASSIFIER-2D-CV-MORPH` (low priority for 3D Tiles content).

**Trace:** Batches 112-115 (full Vector3DTile classification family on WebGPU); Batch 208 (MORPHING); Batch 219 doc-sync.

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

### FORK-34 — WebGPU pick pass FIXED (Batch 207, runtime-verified). Box pick at WebGL parity; b3dm-feature→Cesium3DTileFeature resolution is the remaining narrower gap.

**★ RESOLVED (Batch 207) — `scene.pickAsync` now returns objects on WebGPU.** The broad "all picking returns undefined" gap (re-scoped in Batch 206, below) was **five compounding bugs**, each masking the next. Found by instrumenting the pick path end-to-end (PICKDIAG, since removed) and a decisive diagnostic-clear test (clear the pick FBO to a recognizable color → discriminate "readback reads wrong texture" from "draws produce no fragments"):

1. **No command encoder during pick.** Pick runs via `pickBegin → updateAndExecuteCommands → pickEnd`, NOT `render()→beginFrame()`, so `context._currentCommandEncoder` was null and `executePickPass` early-returned (rendered nothing). Fix: `WebGPUContext.beginPickFrame()` creates the off-screen pick encoder (+ uniform-allocator page); `pickEnd→endFrame()` submits it. (`WebGPUContext.ts`, `WebGPUSceneRendererPickPass.ts`.)
2. **Pick FBO color format ≠ pick pipeline target format.** The pick FBO was hard-coded `rgba8unorm` but the pick pipelines target `context.scenePipelineFormat` (`bgra8unorm` here) → every pick draw dropped with an attachment-incompatibility validation error. Fix: `pickColorFormat()` picks `scenePipelineFormat` when it's an 8-bit unorm; readback swaps R/B for `bgra8unorm`. (`WebGPUPickFramebuffer.ts`.)
3. **The log-depth swap hid the pick command.** `selectCommandVariant` swapped to the log-depth COLOR variant BEFORE the pick check, so the model's pick command (attached to the BASE command's `derivedCommands.picking`) was never reached. Fix: skip the log-depth swap when `isPicking`. (`WebGPUSceneRenderer.ts`.)
4. **Base (MRT) commands invalidated the entire pick command buffer.** A command with no pick variant resolves to its base COLOR command, whose pipeline targets the MRT scene framebuffer; dispatching it into the single-target pick render pass raised an attachment-incompatibility error that invalidated the WHOLE pick command buffer — discarding even the correctly-built pick variants. WebGL tolerates this (no draw-time attachment-count validation); WebGPU does not. Fix: in `executePickBatch`, skip any command that `selectCommandVariant` returns unchanged UNLESS it is a dedicated pick command (`pickOnly` for collections, `_isPickCommand` for geometry primitives). Marked the collection pick commands (`pickOnly: true`) that previously lacked the flag (billboard, buffer-point/-polygon/-polyline, polyline, point-primitive). This is the bug that made globe-containing scenes (i.e. essentially all of them) unpickable. (`WebGPUSceneRendererPickPass.ts` + the 6 renderers.)
5. **`a > 0` readback gate rejected every real pick id.** THE final layer. Pick-ID colors come from `Color.fromRgba(key)` which packs the incrementing integer key into the bytes low-to-high on a little-endian host: `red=key&0xff, …, ALPHA=(key>>24)&0xff`. So every pick id below 2^24 (essentially all of them) has **alpha 0** — and `pickObjectsFromPixels` gated hits on `if (a > 0)`, silently dropping them. The cleared FBO is `(0,0,0,0)`→key 0 (no object), so the correct test is `r||g||b !== 0` (matches WebGL's decode). Fix: `WebGPUPickFramebuffer.ts` `pickObjectsFromPixels`.

**Runtime verification (Edge, headless, `node server.js --port 8134`, `EllipsoidTerrainProvider`, valid token):**

| probe | WebGL | WebGPU (after fix) |
|---|---|---|
| `probe-pick-basic.mjs` (Box `Primitive`) | `id:"the-box"`, `Primitive` | `id:"the-box"`, `Primitive` ✅ **parity** |
| `verify-model-feature-pick.mjs` (b3dm) | `Cesium3DTileFeature` (`primitive=_Cesium3DTileset`, `id=undefined`) | `{primitive: Model, id:"0_0"}` ⚠️ **picks the Model, not the feature** |

**REMAINING GAP — b3dm per-feature → `Cesium3DTileFeature` resolution.** WebGPU picking a b3dm building now returns the content **Model** with a model-level pick id (`"0_0"`), where WebGL returns a `Cesium3DTileFeature` (so `feature.getProperty(...)` works). The per-feature pick FBO is writing the model's pick id rather than the per-feature pick colors that the `Cesium3DTileContent` registered against `Cesium3DTileFeature` objects. This is the original C-R9-MODEL-FEATURE-PICK scope (the feature-ID-driven pick-color lookup in `WebGPUModelFeatureId.js` / the model pick FS), now unblocked by the infra fix above — see the dedicated entry below.

### ~~C-R9-MODEL-FEATURE-PICK~~ — RESOLVED (Batch 209). WebGPU b3dm pick returns a Cesium3DTileFeature with readable batch-table properties, at full WebGL parity.

**★ RESOLVED (Batch 209, runtime-verified).** After the FORK-34 pick infra fix (Batch 207) the b3dm pick latched but returned the content `Model` (`id:"0_0"`, the primitive-granular pick id) instead of a `Cesium3DTileFeature`. Two more bugs in the per-feature path:

1. **The pick FS gated the per-feature lookup on alpha.** `fragmentPickMain` / `fragmentPickHoverMain` did `if (featurePickColor.a > 0.004) return featurePickColor;`. But the feature-pick texture is written from `Color.fromRgba(key)` whose alpha is the high key byte — 0 for every key below 2^24. So the gate always failed and fell through to `material.pickColor`. Fixed to gate on RGB (`r||g||b > 0`), matching the FORK-34 readback fix. (`ModelPBRComplete.wgsl`.)
2. **`ensurePerFeaturePickIds` registered a bare `{primitive: model, id: fid}`** instead of the object WebGL registers. Fixed to register `batchTexture._owner.getFeature(fid)` — the `Cesium3DTileFeature` (3D Tiles) / `ModelFeature` (glTF EXT_mesh_features), exactly as `BatchTexture.js:528` does — with kind `"tile-feature"`. (`WebGPUModelFeatureId.js`.)

**Verified (`verify-model-feature-pick.mjs`, Edge headless, ellipsoid terrain), WebGPU vs WebGL — IDENTICAL:** both return `pickedCtor: "_Cesium3DTileFeature"`, `primitive: _Cesium3DTileset`, `isTileFeature: true`, and the SAME batch-table properties (`roof_name:"roof2"`, `building_name:"building2"`, `building_area:"39.3"`). `feature.getProperty(...)` works on WebGPU. Box pick unaffected (regression-checked).

The render-gap analysis below (`firstRP.hasRenderResources: false`, "b3dm not visibly rendering") was the pre-FORK-34 state and is **superseded** — the b3dm renders and picks per-feature on WebGPU now.

---

#### Historical (pre-resolution) notes — per-feature→Cesium3DTileFeature resolution (unblocked by FORK-34 fix, Batch 207)

**★ MAJOR CORRECTION (Batch 205, Principle-8 WebGL-vs-WebGPU control, runtime-verified) — the "b3dm invisible on WebGPU" premise behind C-R9 (and ALL the Batch 201/203/204 depth-pipeline theories) WAS A TEST ARTIFACT.** `probe-c-r9-webgl-vs-webgpu.mjs` loaded the BatchTableHierarchy tileset on BOTH backends at the same 188 m nadir view, ×2 terrains:

| terrain | WebGL building px | WebGPU building px |
|---|---|---|
| **EllipsoidTerrainProvider** | 525 | 535 |
| **default (Cesium World Terrain)** | 0 | 0 |

The b3dm RENDERS IDENTICALLY on WebGL and WebGPU (gray boxes on the terrain, ~525/535 px, visually matching — `c-r9-cmp-{webgl,webgpu}-ellipsoid.png`). With the default terrain BOTH show 0 buildings — because the **real Cesium World Terrain elevation at the sample tileset's location sits ABOVE the sample buildings and legitimately occludes them, on BOTH backends.** The earlier verify probe used the default terrain; once the expired ion token was refreshed (Batch 202) the default became Cesium World Terrain, so the probe was measuring terrain occlusion, not a render bug. **There is NO WebGPU b3dm-on-terrain render bug, no globe/model depth-value mismatch, no depth-plane bug, no log-depth-epic dependency for rendering.** The Batch 201 root-cause (depth occlusion via log-depth frustum) + Batch 203/204 follow-ons were all chasing this artifact — superseded by this control. (The depth-debug TOOLING from Batch 204 + the `logDepthWriteActive` analysis remain valid general assets; only the C-R9 render diagnosis was wrong.)

**RESIDUAL RE-SCOPED (Batch 206) — it is NOT b3dm-feature-specific; WebGPU PICK is broadly broken.** Isolating the pick path with `probe-pick-basic.mjs` (a plain Box `Primitive` + `PerInstanceColorAppearance`, ellipsoid terrain, valid token, Edge):

- `scene.pickAsync(center)` → **WebGL picks the Box** (`id:"the-box"`, primitive `Primitive`); **WebGPU returns undefined.** Same for the b3dm model via `pickAsync` (WebGL → `_Cesium3DTileset`; WebGPU → undefined). So **`scene.pickAsync` returns undefined for ALL objects on WebGPU** (geometry primitive AND model), not just b3dm features. This matches the documented troubled history: **FORK-34 "WebGPU pick pass not wired — all 15+ picking methods fail"** (archive/UPSTREAM_ISSUES_AND_TECH_DEBT.md) and **PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:249 "glTF model picking broken on WebGPU — cannot be picked via scene.pick()."** The Batch 184/191 fixes addressed `pickAsync` queue ORDERING but the pick result is still empty here.
- **Sync `scene.pick` is wrong on WebGPU** (separate bug): WebGPU readback is async, so sync `scene.pick` returns the prior frame's result — AND it leaves the WebGPU pick readback buffer in a pending-map state, so a subsequent `pickAsync` throws `OperationError: Buffer already has an outstanding map pending` (`WebGPUPickFramebuffer.endAsync` → `mapAsync`). The async `scene.pickAsync` is the only correct WebGPU pick entry; `scene.pick` should arguably warn / no-op on WebGPU.
- **Caveat — headless:** WebGL pickAsync works headless (so headless CAN pick), but a WebGPU-headless readback-timing artifact can't be 100% ruled out without a HEADED run (no display in this env). The documented FORK-34 history strongly indicates a real WebGPU pick-pass gap, not merely headless.

**NEXT (dedicated WebGPU-pick investigation — bigger than C-R9 b3dm features):** trace `WebGPUPickFramebuffer.endAsync` + the WebGPU pick render pass (`WebGPUSceneRenderer` `_executePickBatch` / the pick pass dispatch) — does the pick pass actually render the scene's pick commands into the pick FBO, and does `copyTextureToBuffer` read the pixel under the cursor (the Batch-5 origin fix region)? The Box repro (`probe-pick-basic.mjs`) is the minimal reproduction. Verify the fix HEADED if possible. `verify-model-feature-pick.mjs` now uses `pickAsync` + forces `EllipsoidTerrainProvider` + takes `PROBE_RENDERER`. (The probe's `hasId` metric is misleading for tile features — a `Cesium3DTileFeature` is the picked object itself; use `pickedDefined` + `primitiveCtor`.)

**Status (re-verified Batch 172 via `Tools/visual-regression/verify-model-feature-pick.mjs` on the live WebGPU CesiumViewer):** The three originally-documented blockers are RESOLVED. The probe now reports `featurePickIdCount: 30` (was 0), `featurePickTexExists: true` (was false), and a NON-empty `primCacheKeys` (was `[]` — the PRIMARY-blocker signal). The per-feature pick infrastructure is allocated end-to-end:

- **PRIMARY blocker (empty primitive cache for b3dm) — RESOLVED:** `GltfLoader.loadTypedArrayForWebGPU` retains typed arrays (gated by `context.requiresVertexTypedArrayRetention`, overridden true on WebGPU), `ModelPrimitiveGeometry.extractPrimitiveGeometry` falls back to `runtimePrimitive.primitive.attributes`, and `Model.js:3168` dispatches every model with a `_sceneGraph` (incl. b3dm-tileset models) to the WebGPU model FR — so `cache.primitives` populates. (Batch 120.)
- **NEW-BG-CONSOLIDATION — RESOLVED (Batch 122):** `ModelPBRComplete.wgsl` declares only groups 0-3 (within `maxBindGroups: 4`).
- **NEW-FEATURE-ID-VERTEX-ATTR — RESOLVED (Batches 130 + 188):** `_BATCHID`→`_FEATURE_ID_0` extracted to vertex slot 8, `FLAG_HAS_FEATURE_ID_ATTRIBUTE` set, FS routes through `lookupFeaturePickColor`.
- **BUG-MODEL-FEATUREID-PICK-OFFSET (latent 4th bug) — fixed Batch 141:** `featurePickEnabled` packed at slot 12 but WGSL read byte 40 (slot 10) → shader always saw 0; now both at slot 10 (`WebGPUModelFeatureId.js:520`). (Stale JSDoc at `:588` still says `[12]` — fix when next touching.)

**RESIDUAL GAP (caught by probe-first, Batch 172; RE-VERIFIED Batch 200, 2026-06-05) — keeps this entry OPEN:** despite the allocated infra, the verify probe's `scene.pick` returns `undefined` across a 240px spiral, and the screenshot shows the b3dm `BatchTableHierarchy` tileset is **not visibly rendering** (only ground imagery). So per-feature pick IDs are allocated (30) but the b3dm content either isn't drawing at the framed camera or isn't latching into the pick FBO. This is NOT one of the three documented blockers — those are demonstrably gone — but it means end-to-end b3dm feature pick is unconfirmed.

**Batch 200 re-verification (valid ion token, Edge):** the FULL allocation chain is confirmed present — `tilesetFeaturesLoaded: 30`, `featurePickIdCount: 30`, `featurePickTexExists: true`, `primCacheKeys: ["0_0"]` (non-empty), `primCacheBatchGPUTextureExists: true`, `primCacheFeaturePickGPUTextureExists: true`; the scene graph is built (`ModelSceneGraph`, 1 runtime node, 1 runtime primitive); the glTF primitive carries `[POSITION, NORMAL, _FEATURE_ID]` with a populated typed array (len 6120). YET the building geometry does not appear (camera at 188 m nadir shows only farmland imagery) and `pickedDefined: false`. **Key signal: `firstRP.hasRenderResources: false`** — the `ModelRuntimePrimitive`'s `renderResources` slot is never populated, even though the WebGPU primitive cache `["0_0"]` IS built from the extracted geometry. So the geometry is uploaded but the b3dm primitive emits no visible draw (or draws off-screen / culled). The render gap is upstream of pick: pick can't latch on geometry that never rasterizes. Confirmed a REAL b3dm content-render gap, not camera-framing (the cache + scene graph + attributes are all present; only the rasterized output is missing).

**ROOT CAUSE — CONFIRMED (Batch 201 multi-agent investigation, HIGH confidence, runtime-verified):** the b3dm draw IS emitted and DOES rasterize correctly — **it is depth-occluded by the globe surface** because the WebGPU log-depth WRITE path is disabled while the frustum partition is already configured *for* log depth. Mechanism:

1. `Scene.js:533` sets `logarithmicDepthFarToNearRatio = 1e9`; `View.js:423` selects it (over `farToNearRatio`=1000) because `scene.logarithmicDepthBuffer === true` → ONE single frustum `[near≈0.1, far≈1e8]` holds the `Pass.CESIUM_3D_TILE` command. That partition is only safe if log depth is actually *written*.
2. Log depth is NOT written on WebGPU: `WebGPUContext.ts:399` `_logDepthWriteEnabled = false` (the renderer-wide log-depth epic's default), so `isWebGPULogDepthActive()` is false — the globe's `@builtin(frag_depth)` log path (`GlobeTerrain.wgsl`) is `//>>ifdef LOG_DEPTH`-gated inert, and `ModelPBRComplete.wgsl` was never wired into the epic. Everything writes standard hyperbolic NDC z.
3. At `far=1e8` the building (~185 m) and the terrain beneath it (~188 m) map to the same 24-bit depth quantum (~73 km/quantum at this range).
4. Model pipeline uses `depthCompare:"less-equal"` (`WebGPUModelPipelineCache.js:635`); the globe writes terrain depth first and the flush-on-terrain b3dm loses the test → fully occluded. `clearGlobeDepth` is false (CesiumViewer default `globe.depthTestAgainstTerrain=true`), so globe depth is never cleared to let tiles draw on top.

**Why standalone glb renders but this b3dm doesn't:** glb demos are viewed against sky / at standoff, so no globe surface sits at the identical sub-meter depth directly behind the model; BatchTableHierarchy sits flush on terrain → depth dead-heat.

**Runtime evidence (not just hypothesis):** `Tools/visual-regression/probe-b3dm-noglobe.mjs` + `output/probe-b3dm-noglobe.png` — with `scene.globe.show=false` the buildings render perfectly (gray PBR boxes); with the globe shown they vanish. A hooked `WebGPUDrawCommand.execute()` confirmed `drawIndexed(9090)` runs every frame (indexCount 9090, vertexCount 2040, pipeline present, no validation errors). The draw executes; only globe depth kills it.

**`hasRenderResources===false` is a RED HERRING (definitive):** `ModelRuntimePrimitive` has NO `renderResources` slot on either backend — the WebGL path builds a *transient* `PrimitiveRenderResources` (`ModelSceneGraph.js:256-261`), consumes it into `runtimePrimitive.drawCommand` (`:415-419`), then discards it. The WebGPU draw path never reads it (`ModelPrimitiveGeometry.js:42-65` falls back to `primitive.attributes[].typedArray` precisely because the slot never exists); standalone glTF — which renders — also has `renderResources===undefined`. The probe's `firstRP.renderResources !== undefined` check (`verify-model-feature-pick.mjs:128`) tests an abandoned slot; it should check `rp.drawCommand` instead. STOP investigating `renderResources`.

**⚠ FRUSTUM-PARTITION / DEPTH-PRECISION THEORY DISPROVEN (Batch 203, runtime-verified).** The synthesis above attributed the occlusion to the single `[0.1, 1e8]` log frustum crushing all depth into one quantum, and proposed interim fix (A): gate `useLogDepth` so WebGPU uses `farToNearRatio` (multi-frustum). **That fix was implemented (WebGL-faithful: a backend-agnostic `GraphicsContext.logDepthWriteActive` capability — WebGL `true`, WebGPU `_logDepthWriteEnabled` — AND-ed into `Scene.useLogDepth`) and IT DID NOT FIX THE OCCLUSION.** `diag-b3dm-depth.mjs` confirms `useLogDepth` flipped to `false` and the partition became **4 tight frustums** `[0.1,100][100,1e5][1e5,1e8][1e8,1e10]`; the building sits at ~188 m in frustum 1 `[100,1e5]` where hyperbolic depth precision is ~2e-5 m — trivially enough to separate a building from terrain — yet the building is STILL invisible with the globe shown. So **precision was never the cause** (the synthesis's "~73 km/quantum" figure was wrong; at 188 m in `[0.1,1e8]` precision is ~0.02 m). The change was **REVERTED** (broad single→multi-frustum behavior change, unverified regression surface, zero benefit to the target).

**CORRECTED ROOT CAUSE (open — needs a focused WebGPU depth-pipeline session):** it is a **globe-vs-model depth-VALUE interaction**, not partition precision. The building writes valid depth (renders globe-off) but loses to the globe everywhere with the globe shown, independent of frustum count. Strongly suggests the globe-surface depth pass and the model depth pass write **non-comparable** NDC z into the shared depth buffer (e.g. the globe DrawCommand is replayed across slices with one projection while the model uses another, or a depth-convention/range mismatch). Secondary finding (also Batch 203): setting `scene.globe.depthTestAgainstTerrain=false` (→ should clear globe depth before 3D Tiles) makes the **entire globe surface vanish** on WebGPU — a related WebGPU depth-pipeline bug in the clear-globe-depth path. Both point at the WebGPU globe-depth ↔ 3D-Tile-depth handoff, NOT the View.js partition.

**UPDATE (Batch 204) — depth-plane hypothesis DISPROVEN + real config established + depth tooling built.** Built two depth-debug tools (CesiumDebug `showDepthWindow(minM,maxM,turbo)` windowed-Turbo color overlay + `skipDepthPlane(on)` bisect) and ran `probe-c-r9-diagnose.mjs` at the 188 m b3dm view. Findings:

- **Real config is NOT what the depth-tooling-survey assumed.** The CesiumViewer sets `globe.depthTestAgainstTerrain = TRUE`, so `clearGlobeDepth = FALSE` and `useDepthPlane = FALSE` — **the ellipsoid depth plane is not even rendering.** The `skipDepthPlane` bisect was byte-identical (gray 21741 == 21741), confirming the depth plane is irrelevant to this occlusion. The survey's prime hypothesis (depth-plane writes nearer depth) is wrong. (Note: with `depthTestAgainstTerrain=false` the globe-vanish bug is a SEPARATE clearGlobeDepth-path defect.)
- **So with `depthTestAgainstTerrain=true`:** 3D-Tiles depth-test directly against the globe terrain depth in the shared `depth24plus-stencil8` attachment, and the building loses EVERYWHERE — even where it is geometrically above terrain. This is the globe-vs-model depth-VALUE mismatch, confirmed as the live cause for the default viewer.
- **Tool limitation learned:** the windowed color overlay samples the FINAL committed depth = the depth-test WINNER (terrain). At the building footprint the building lost + never wrote depth, so the overlay shows terrain depth there — it CANNOT visualize the loser's depth. The decisive tool is a **per-pass snapshot comparator** (globe-pass depth vs model-pass depth at the same pixel) — survey "Tool 2"; not yet built.

**NEXT STEP — build the per-pass depth comparator (Tool 2) + numeric readback (Tool 3):** snapshot the packed depth after the globe pass (`FrustumLoop.ts:355`) and after the 3D-tile pass (`:442`) into two RGBA8 debug textures (reuse `WebGPUGlobeDepth.executeCopyDepth`), then read back / diff `globeZ` vs `modelZ` at the building-center pixel. Confirm direction (model z farther than globe z where building is above terrain ⇒ projection/convention mismatch) and magnitude. Then fix by making the model depth-write comparable to the globe's (same projection/convention), and re-verify with `probe-b3dm-noglobe.mjs` (globe-off baseline) + a globe-on assertion.

**(Eventual) real completion — finish the log-depth epic for models:** once the depth-comparability bug is fixed, the model log-depth producer still needs wiring before the master switch flips: (1) `ModelPBRComplete.wgsl` `//>>ifdef LOG_DEPTH` VS varying + FS `@builtin(frag_depth)` (mirror `GlobeTerrain.wgsl` + the converted `PrimitivePhong*.wgsl`); (2) `WebGPUModelRenderer.packCameraUniforms` → `packCameraLogDepthLanes` (`WebGPULogDepth.ts:92`); (3) `LOG_DEPTH` in the model pipeline define set when `isWebGPULogDepthActive()`; (4) flip `WebGPUContext.ts:399` `_logDepthWriteEnabled=true` LAST. But this is downstream of the depth-comparability fix — flipping the switch alone will not fix b3dm-on-terrain.

**Diagnostics:** `Tools/visual-regression/diag-b3dm-depth.mjs` (frustum dump + globe-on screenshot), `probe-b3dm-noglobe.mjs` (globe-off baseline — buildings render).

**This is a high-impact gap: ALL b3dm/3D-Tiles content flush on terrain is invisible on WebGPU** (not just the pick test). Cross-referenced to the log-depth epic (NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION + the Batch 181/182/183 epic).

**Trace (current, post-consolidation — old citations below are STALE):** infra at `GltfLoader.js`, `ModelPrimitiveGeometry.js:59-65`, `WebGPUModelRenderer.js:1316`, `WebGPUModelFeatureId.js:520/609-682`, `ModelPBRComplete.wgsl:2986-3005`; merged pick texture at `@group(1) @binding(31)` (NOT the old `@group(6) @binding(5)`); verify probe `Tools/visual-regression/verify-model-feature-pick.mjs` (Batch 172: now respects `PROBE_BASE`, dropped Vulkan flags, CSS-pixel + spiral pick).

**Historical status (verified 2026-04-30 — citations now stale, see above):** All four code-paths for per-feature pick are wired and look correct:

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

### ~~NEW-FEATURE-ID-VERTEX-ATTR~~ — RESOLVED (Batches 130 + 188)

**Resolution:** Vertex-attribute feature ID was actually shipped end-to-end in **Batch 130** (audit B.2), not in a later focused batch as the original "1 session" estimate implied. The audit reconciliation in Batch 188 surfaced this:

- `ModelPrimitiveGeometry.extractPrimitiveGeometry` extracts `_FEATURE_ID_0` (loader-renamed from b3dm `_BATCHID`) into `geometry.featureId0Data` (Float32Array). [ModelPrimitiveGeometry.js:167-174]
- `WebGPUModelRenderer.createPrimitiveResources` uploads it as a vertex buffer at slot 8. [WebGPUModelRenderer.js:1111-1117]
- `WebGPUModelFeatureId.ensureFeatureIdResources` sets `FLAG_HAS_FEATURE_ID_ATTRIBUTE` (bit 17) on materialFlags when `selected.isAttribute`. [WebGPUModelFeatureId.js:382-384]
- `ModelPBRComplete.wgsl` `fragmentMain` lights up `currentFeatureId = input.featureId0` when `FLAG_HAS_FEATURE_ID_ATTRIBUTE` is set, then routes through `lookupBatchColor` for per-feature styling and `lookupFeaturePickColor` for per-feature pick. [`fragmentMain` lines 1778-1784, `fragmentPickMain` lines 2650-2671]

**Batch 188 closure:** Added `FeatureIdImplicitRange` support — primitives that select an implicit range (no per-vertex `_FEATURE_ID_0` accessor; IDs synthesized from `offset + floor(vertex_index / repeat)` per the EXT_mesh_features spec) now have the per-vertex array materialized at upload time via `synthesizeImplicitFeatureIdData` in `WebGPUModelFeatureId.js`. Once synthesized, the existing slot-8 upload + `FLAG_HAS_FEATURE_ID_ATTRIBUTE` branch handles it identically to an explicit attribute.

**Trace:** Batch 130 (audit B.2 vertex-attribute path); Batch 188 (implicit-range follow-up). `synthesizeImplicitFeatureIdData` in `WebGPUModelFeatureId.js`; call site at `WebGPUModelRenderer.js` after `extractPrimitiveGeometry`.

**Note on C-R9-MODEL-FEATURE-PICK:** The blocking gap surfaced in the prior audit (`model._webgpuCache.primitives === {}` for b3dm-tileset models — i.e., the WebGPU model renderer never builds primitive caches for b3dm content) is a SEPARATE upstream b3dm-Model rendering issue, not a feature-ID path issue. Per-feature pick will work automatically once b3dm models go through the regular WebGPU render path.

### ~~C-R9-MODEL-PICK-TRANSLUCENT~~ — RESOLVED (Batches 186 first slice + 192 dual-path second slice)

**Batch 186 first slice (2026-05-06):**

- **`createPickPipeline` BLEND fix** — `WebGPUModelPipelineCache.js` now passes `depthWriteEnabled: !isBlend` for the pick pipeline. With depth-write OFF for BLEND alphaMode, the standard depth-test (`less-equal`) picks the geometrically closest fragment regardless of render order. Previously the first translucent fragment to draw at a pixel claimed that pick result and prevented later primitives at the same screen location from being pickable.
- **`fragmentPickMain` BLEND alpha-discard** — `ModelPBRComplete.wgsl` adds a `baseColor.a < 0.004` discard branch for BLEND alphaMode so near-fully-transparent fragments (glass / water / ghost overlays) don't claim the pick over opaque geometry visible through them. The 0.004 threshold matches the per-feature batch-table hide threshold — it filters numerical noise without affecting real translucent surfaces.

These two changes ship together — the depth-write fix would still let near-transparent layers grab pick precedence at their depth without the alpha-discard guard.

**Architectural finding revisited (Batch 192, 2026-05-07):** The textbook "parallel pick-OIT pipeline accumulating pickIds with same weights, resolving at composite" approach is not directly implementable with WebGPU primitives — pickColors are integer IDs that can't be averaged, blend ops don't give winner-take-all per-fragment, and workarounds need new infrastructure (per-pixel atomics, N-pass sort, or storage-stack resolve). Rather than ship that multi-batch architectural effort, **Batch 192 ships a dual-path tiered API** that addresses the two real use cases without the architectural blocker:

**Batch 192 second slice — dual-path API:**

**Option D (`Scene.pickHoverAsync`)** — stochastic dither alpha-test for translucent fragments via Interleaved Gradient Noise (Jorge Jimenez's IGN, used by UE4/UE5/Frostbite for dithered transparency). Single-pass, same render-pass cost as the default opaque pick — guaranteed stutter-free at 60fps hover frequency. Translucent (BLEND) fragments are discarded with probability `1 − alpha`; the standard depth-test then picks whichever survived fragment is geometrically closest. Multi-frame averaging under cursor motion converges to the perceptually-correct alpha-weighted appearance.

- New `fragmentPickHoverMain` entry in `ModelPBRComplete.wgsl` (inline IGN — no texture lookup).
- New `getPickHoverPipeline` factory in `WebGPUModelPipelineCache.js` — for OPAQUE/MASK delegates to the regular pick pipeline (no extra cost); for BLEND emits a depth-write-on dither variant.
- Coalesce mitigation: at most one hover pick in flight per scene; pile-up is dropped.

**Option C (`Scene.pickPreciseAsync`)** — deterministic "geometrically-closest translucent fragment wins" via stencil-coordinated 2-pass pipeline pair. Pass 1 writes depth + stencil with `colorWriteMask: 0`; pass 2 writes pickColor with `depthCompare: equal` and `stencilCompare: equal`. Both passes share one render-pass setup so depth + stencil persist between them. ~2× translucent rasterization cost, fired only on click events — invisible to UX.

- New `getPickPrecisePass1Pipeline` + `getPickPrecisePass2Pipeline` factories.
- Per-primitive 2-draw emission in `WebGPUModelRenderer`; pass 2 emitted by the pick-pass executor immediately after pass 1 within the same render pass.
- Coalesce + defer mitigations: one outstanding precise pick per scene; if last frame's GPU work exceeded a threshold (~12ms), defer to next frame via `frameState.afterRender` hook (16ms latency, no stutter).

**Other mitigations baked into the dual-path:**

- Pick-rect screen-space cull tightening — already shipped via `getPickCullingVolume`. Drops typical scene's pick render cost by 90-95% before the per-pipeline render-pass overhead even matters.
- Lazy pipeline allocation — hover/precise pipelines only built on scenes that actually call the new APIs (`scene._webgpuPickHoverEnabled` / `scene._webgpuPickPreciseEnabled`).
- Default `Scene.pick` / `pickAsync` unchanged — apps that don't opt in pay zero.

**Worst-case per-frame cost** (after all mitigations): ~1.5-3ms heavy scene with both fired same frame (rare — coalesce drops the hover when click fires). Idle: 0ms. Hover only: 0.3-1ms. Click only: 0.6-2ms.

**Downstream feature hooks** opened by this batch (each its own future work item):

- `csm_stochasticDither.wgsl` chunk available for foliage / particle alpha-test rendering, translucent shadow casts, voxel ray-march early-termination.
- TAA jitter via blue-noise (replace Halton 2/3) — hook + comment in `WebGPUTAAEffect.ts`.
- Voxel ray-march acceleration — hook + comment in `WebGPUVoxelRenderer.ts`.

**Trace:** Batch 186 first slice; Batch 192 dual-path second slice. `Scene.pickHoverAsync` / `Scene.pickPreciseAsync` in `Scene.js`; `Picking._pickAsyncWithMode` + coalesce/defer in `Picking.js`; `fragmentPickHoverMain` + `getPickHoverPipeline` / `getPickPrecisePass{1,2}Pipeline` factories; dispatcher routing in `WebGPUSceneRenderer.selectCommandVariant`; pass-2 follow-up in `WebGPUSceneRendererPickPass`. Earlier work: PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:220 (Batch 54 "Translucent-with-OIT pick").

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

### ~~C-R10-GLOBE-POINT-LIGHT~~ — RESOLVED (Batch 108, doc-sync Batch 190)

**Resolution:** Globe terrain point-light cube-shadow receive shipped end-to-end in **Batch 108**, not in a later focused batch. Batch 190 audit (2026-05-06) walked the actual code path and confirmed every piece is in place:

- `GlobeTerrain.wgsl` `EffectsUniforms` carries `pointLightControl` (offset 304) + `pointLightPositionWC` (offset 320) at the same byte offsets as the model shader, so both share the effects UB. [GlobeTerrain.wgsl:262-266]
- `pointLightCubeDepth: texture_depth_cube` bound at `@group(3) @binding(17)` with placeholder fallback when point-light shadows are off. [GlobeTerrain.wgsl:324]
- `globeSamplePointShadow(fragWC)` does perspective-Z reconstruction + 5-tap cross PCF when `pointLightPositionWC.w > 0`, else hard sample. [GlobeTerrain.wgsl:~1410-1462]
- `globeComputeShadowFactorPointLight(fragWC)` mixes with `shadowDarkness` matching the model + primitive paths. [GlobeTerrain.wgsl:~1465-1469]
- Shadow gate order in `fragmentMain` is point-light first, CSM second, 2D shadow last (matches the model FS). [GlobeTerrain.wgsl:~1559-1577]
- `WebGPUEffectsBindGroup.js` packs `pointLightControl` + `pointLightPositionWC` from `frameState.shadowMap` info; binding 17 falls back to a 1×1×6 cube cleared to 1.0 when the gate is off.

The deferred entry's "1 session if requested" estimate predated the Batch 108 commit and was never reconciled. Originally tracked under "Scope cuts" in PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:247.

**Trace:** Batch 108 (terrain receive); Batch 190 (audit doc-sync). Code references above.

### C-R10-CAST-LINEAR-DEPTH — DEFERRED (correctly parked; micro-opt, no benefit today)

**Triage (Batch 172):** Confirmed correctly deferred — NOT actionable-worthwhile. The current perspective-Z cast/receive path round-trips correctly and is cheap; switching to linear depth is a lockstep cast+receive swap with "Impact: None today" by the entry's own assessment. Left parked as a future profiling-driven option, not scheduled work. (Listed here because the triage workflow's item-list missed it; classified now.)

**What:** Alternative cast pipeline writing linear depth (`distance / lightRadius`) via `@builtin(frag_depth)` instead of perspective-Z attachment. Would let receive use simpler `axisDist / farPlane` reference.

**Why deferred:** Perspective-Z path correctly round-trips against existing cast output. Switching to linear depth requires receive AND cast changing in lockstep - coordinated swap, not strict improvement. Tracking only because future profiling could shift the calculus.

**Prerequisites:** None.

**Estimated effort:** 1 session.

**Impact:** None today - current perspective-Z math is correct and cheap (two divides + one cube sample per fragment). Pure micro-optimization.

**Trace:** REVIEW_FIX_PROGRESS.md (Batch 57 "Scope cuts").

---

## C-R12 - Per-object cache walk

### ~~C-R12-PER-OBJECT-CACHES~~ — RESOLVED (Batch 197)

**Resolution:** `WebGPUSceneRendererEnsureResources.ensureResources` now extends its existing `context.onDeviceInvalidated` subscription with a `clearPerObjectCaches(scene)` walk that clears `_webgpuCache` on every reachable per-object owner during device-loss recovery:

- `scene.primitives` collection — recursively walked via duck-typed `{length, get(i)}` shape; every member with `_webgpuCache` is cleared. Includes leaf primitives (Models, GroundPrimitive, etc.) and nested PrimitiveCollections.
- `scene.groundPrimitives` collection — same walk for terrain-classified primitive sets.
- `scene.shadowMap` — singleton with own `_webgpuCache`.
- `scene.postProcessStages` — collection-level cache.

The owning feature renderers' destroy/recreate flows still run on the next update tick after recovery; this cleanup closes the window between device-loss event and the next render frame, ensuring orphan-but-reachable caches drop their stale GPU handles immediately rather than only when the FR sees them again.

**Trace:** Batch 197; `WebGPUSceneRendererEnsureResources.ts:clearPerObjectCaches`. Earlier reference: PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:283.

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

## NEW-VR — Cross-backend sweep follow-ups (Session 62, 2026-05-08)

Bug clusters surfaced by the cross-backend Sandcastle sweep that built on Session 62. Each cluster blocked or visually degraded a measurable subset of demos. The Session 62 batch closed the four high-blast-radius WGSL bugs (~50 demos) plus the two dev-server bugs that were masking them. The entries below are the follow-up clusters with smaller blast radii that warrant their own session-sized investigations.

### ~~NEW-VR-VERTEX-BUFFER-VARIANT — Model PBR pipeline binds 9 vertex slots, Edge adapter caps at 8 (~31 demos)~~ FIXED 2026-05-11 (Session 65 Batch 1)

**Symptom (resolved):** `Vertex buffer count (9) exceeds the maximum number of vertex buffers (8)` while creating Model PBR pipelines.

**Original root cause:** `createVertexBufferLayout()` in `WebGPUModelPipelineCache.js` returned 9 slots unconditionally (position + normal + tangent + texCoord0 + color0 + joints + weights + texCoord1 + featureId0). Session 62 made slot 7 (texCoord1) variant-conditional via `MODEL_HAS_TEXCOORD_1`. Session 65 added the matching `MODEL_HAS_FEATURE_ID_0` flag so slot 8 (featureId0) is also variant-conditional. The common case (standard glTF without batching or multi-UV) is now 7 slots; texCoord1-only is 8; featureId0-only is 8; both is 9 (still rare, needs further restructure if encountered on Edge).

**Files changed:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — added `MODEL_HAS_FEATURE_ID_0 = 1 << 13`.
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js` — `createVertexBufferLayout(hasTexCoord1, hasFeatureId0)` conditionally includes slots 7 and 8; threaded `hasFeatureId0` through every `createXxxPipeline` callsite (8 functions); added `MODEL_HAS_FEATURE_ID_0` to the cache-key define mask.
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js` — set `MODEL_HAS_FEATURE_ID_0` in `materialDefines` when `geometry.hasFeatureId0`; in the per-frame setVertexBuffer loop, push the featureId buffer only when the flag is set so the buffer count matches the pipeline layout.
- `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — wrapped `@location(8) featureId0` declaration and `output.featureId0 = input.featureId0` assignment in `//>>ifdef MODEL_HAS_FEATURE_ID_0` blocks (with `output.featureId0 = 0.0` in the `//>>else` branch so the FS varying always gets a value).

**Verification:** typecheck + build clean; CesiumViewer Hello-World renders without pipeline-create errors. The previous 8-slot cap rejection no longer fires for the ~31 affected demos (standard glTF models without feature IDs now use 7 slots; batched 3D Tiles content uses 8).

### NEW-VR-CZML-WRITEBUFFER-BYTES — Closed (2026-05-12, verified resolved by Session 65 Batches 5 + 7)

**Symptom:** `[error] [tryAndCatchError] ❌ ERROR CAUGHT: OperationError: Failed to execute 'writeBuffer' on 'GPUQueue': Number of bytes ...`. Affected CZML Rectangle, CZML Spheres and Ellipsoids, Globe Interior, etc.

**Root cause:** Two issues both surfaced here — Session 65 Batch 5 (index buffer 4-byte alignment padding in `WebGPUModelRenderer.ensurePrimitiveCache`) and Session 65 Batch 7 (Uint8 → Uint16 index upcast in `ModelPrimitiveGeometry.extractPrimitiveGeometry`). Both write paths now pad/upcast correctly.

**Verification (Session 65 Batch 12, 2026-05-12):** Re-tested CZML Rectangle, CZML Spheres and Ellipsoids, Globe Interior, CZML Path, CZML Point, CZML Point - Time Dynamic, CZML Polygon - Interpolating References — zero `writeBuffer` byte errors on any of them.

### NEW-VR-CZML-INCLUDES-NOT-FUNCTION — Closed (2026-05-12, verified resolved)

**Symptom:** `[error] An error occurred while rendering. Rendering has stopped. TypeError: this.includes is not a function`. Affected CZML Path, CZML Point - Time Dynamic, CZML Polygon - Interpolating References, etc.

**Verification (Session 65 Batch 12, 2026-05-12):** Re-tested all listed demos — zero `includes is not a function` errors. Resolved upstream by Session 65 Batch 5 (the `import Uri from "urijs"` restoration in CzmlDataSource.js, plus a downstream fix during CZML packet parsing). All affected demos now parse + render cleanly.

### NEW-VR-CZML-CREATEBUFFER-BYTES — Closed (2026-05-12, verified resolved)

**Symptom:** `[error] TypeError: Failed to execute 'createBuffer' on 'GPUDevice': Failed to read the ...`. CZML Point, CZML Position Definitions, CZML Reference Properties, etc.

**Verification (Session 65 Batch 12, 2026-05-12):** Same root cause as NEW-VR-CZML-WRITEBUFFER-BYTES (index buffer alignment + Uint8→Uint16 upcast from Batches 5 + 7). Re-tested affected demos — zero createBuffer errors.

### NEW-VR-DEVELOPER-ERROR-VEC4 — `Invalid vec4 value` in UniformArrayFloatVec4.set (3 demos) — CLOSED 2026-05-13

**Symptom:** `[error] [tryAndCatchError] ❌ ERROR CAUGHT: DeveloperError: Invalid vec4 value. at new DeveloperError ... at UniformArrayFloatVec4.set`. Affected 3D Tiles 1.1 CDB Yemen, 3D Tiles Compare, I3S Building Scene Layer.

**Resolution:** Verified resolved 2026-05-13 by probing all 3 affected demos — `vec4=0` everywhere. The only remaining errors are unrelated 404s on the Yemen tileset's resource server (external infra issue, not a renderer bug). Likely fixed by Session 65 Batch 6 (PBR IBL fix → upstream uniform packers cleaned up trailing NaN injection) or Session 60 Cluster 4 (uniform-array sanitisation pass). **Verification probe:** [Tools/visual-regression/probe-vec4-error.mjs](Tools/visual-regression/probe-vec4-error.mjs).

### NEW-VR-DEPTHPLANE-EDGEEMITTER-PIPELINE-FORMAT — Pipeline attachment incompatibility (4 demos) — CLOSED 2026-05-13

**Symptom:** `[warning] Attachment state of [RenderPipeline "DepthPlane-Pipeline"] is not compatible with [RenderPassEncoder "Scene Framebuffer Render Pass"]`. Same pattern for `EdgeEmitter-Pipeline`. Affected Atmosphere, High Dynamic Range, WebGPU Edge Visibility, WebGPU Edge Feature ID.

**Root cause (EdgeEmitter half):** The `EdgeEmitter-Pipeline` was built with 3 color targets (color + featureId + packed-depth) for the dedicated edge MRT framebuffer, but when `scene._enableEdgeVisibility` is OFF (most demos), the 3D-tile pass dispatcher falls back to running the `CESIUM_3D_TILE_EDGES` pass on the regular 1-attachment scene framebuffer (`WebGPUSceneRenderer3DTilePasses.ts:213-218`). The 3-target pipeline can't bind to a 1-attachment pass → validation error.

**Root cause (DepthPlane half):** The pipeline's color target format was sometimes built against `presentationFormat` (canvas) while the Scene Framebuffer Render Pass uses `_sceneColorFormat` (which diverges in HDR: `rgba16float` / `rg11b10ufloat`). Pre-existing `_colorFormat` drift detection in `WebGPUSceneRendererEnsureResources.ts:289-298` now correctly rebuilds the depth plane when the scene FB color format flips.

**Fixes landed:**

- **EdgeEmitter (Session 65 Batch 13, 2026-05-12):** `WebGPUEdgeVisibilityEmitter.ts` — `ensureEdgeEmitterPipeline` now builds BOTH pipeline variants: `cache.pipeline` (3-target MRT) and `cache.pipelineSingleTarget` (color-only). Both share the same shader module, BGLs, vertex layout, depth state, and multisample state — only `fragment.targets` differs. The fragment shader writes to @location 0/1/2 unconditionally; WebGPU silently drops writes to absent attachments. `WebGPUModelRenderer.js:3396-3420` — at command-build time, reads `frameState.scene?._enableEdgeVisibility` and picks the MRT pipeline when on, single-target pipeline when off. Mirrors the runtime redirect decision in `WebGPUSceneRenderer3DTilePasses.ts:185`.
- **DepthPlane (already resolved by prior batch):** verified 2026-05-13 by sweeping 10 representative demos (Atmosphere, HDR, Bloom, AO, DoF, Lighting, Shadows, Custom Per-Feature PP, Post Processing, WebGPU Edge Visibility) — zero `Attachment state` warnings on any of them. The pre-existing format-drift rebuild path in `WebGPUSceneRendererEnsureResources.ts:289-298` is doing its job.

**Verification probe:** [Tools/visual-regression/probe-attach-mismatch.mjs](Tools/visual-regression/probe-attach-mismatch.mjs) — `total=0 depthPlane=0 edge=0 other=0` across all 10 demos.

### NEW-VR-USER-POSTPROCESSSTAGE-WGSL-MISSING — User-added stages without WGSL fragment shader (6 demos) — DEFERRED (by-design limitation; real fix = Naga transpiler)

**Triage (Batch 172):** Classified — this is a **documented by-design limitation**, not a bug. User `PostProcessStage`s authored with GLSL fragment shaders cannot run on the WebGPU backend; the warning (added in Batch 198 NEW-POSTPROCESS-USER-WGSL) is the intended surfacing. Two resolution paths, both already tracked elsewhere:

- **Cheap (demo content, ~1 session):** update the 6 affected Sandcastle demos to supply a `wgslFragmentShader` via the shipped Batch 198/199/204 user-WGSL API — sidesteps the warning but is demo-content work, not engine work.
- **Real (engine, multi-session):** automatic GLSL→WGSL transpilation of user stages via the vendored Naga bridge — this is the EXPERIMENTAL B.7 / NEW-POSTPROCESS-USER-WGSL follow-up, a research-grade item, NOT a quick close.

No engine action scheduled here; the warning correctly tells users to provide a WGSL variant. (Listed because the triage workflow's item-list missed it; classified now.)

**Symptom:** `[warning] N user-added PostProcessStage instance(s) without a 'wgslFragmentShader' uniform detected on a WebGPU scene.` Affects Custom Per-Feature Post Process, Custom Post Process, Per-Feature Post Processing, Post Processing, etc.

**Root cause:** Documented limitation. User stages built with GLSL fragment shaders don't run on WebGPU; the warning is doc'd in `addUserWGSLStage` (Batch 198 NEW-POSTPROCESS-USER-WGSL). The "fix" is either teaching the user to provide a WGSL variant via the new API, OR adding an automatic GLSL→WGSL translator (Naga is already vendored — see EXPERIMENTAL B.7 entry).

**Estimated effort:** Either:

- 1 session to update the doc'd Sandcastle examples to use the WGSL variant (sidesteps the warning).
- Multi-session to wire Naga GLSL→WGSL translation so user GLSL stages automatically transpile.

### NEW-VR-WGSL-PARSE-DOCTYPE-HTML — WGSL parser sees `<!DOCTYPE html>` (4 demos) — CLOSED 2026-05-13

**Symptom:** `[warning] Error while parsing WGSL: :1:1 error: unexpected token <!DOCTYPE html>`. Affected CZML Billboard and Label, Map Pins, Particle System Fireworks.

**Resolution:** Verified resolved 2026-05-13 by probing all 3 affected demos — `doctype=0 wgsl-parse=0 404s=0`. The bad shader-fetch path that resolved to `/index.html` for missing modules was repaired by intervening build-pipeline / shader-loader work (likely the WebGPU shader module cache hardening in Batches 22-27, or the variant build alias plugin that now properly stubs missing WGSL files). **Verification probe:** [Tools/visual-regression/probe-wgsl-doctype.mjs](Tools/visual-regression/probe-wgsl-doctype.mjs).

**Estimated effort:** 1 session — find the failing fetch, fix the relative path or add an HTTP-status check before passing bytes to the shader compiler.

### ~~NEW-VR-OUTLINES-ON-TERRAIN-WARNING~~ — CLOSED (Batch 175, WONTFIX — upstream parity behavior, not a WebGPU bug)

**Resolution (Batch 175):** Closed as WONTFIX. The warning `[warning] Entity geometry outlines are unsupported on terrain. Outlines will be disabled.` is emitted by **upstream Cesium** (`GeometryVisualizer` / outline-on-terrain is unsupported in BOTH backends) — it is correct, expected, backend-agnostic behavior, NOT a WebGPU regression. WebGL shows the identical warning + identical no-outline result, so this is full parity. Silencing it would require a feature flag that diverges from upstream for no functional gain. Leave as-is; the three affected demos (AEC Clipping, Geometry and Appearances, Moon) render correctly aside from the (intentionally) disabled terrain outlines.

**Symptom (original):** `[warning] Entity geometry outlines are unsupported on terrain. Outlines will be disabled.` AEC Clipping, Geometry and Appearances, Moon. **Doc'd limitation, not a bug.**

---

## NEW-VR-2 — Cross-backend sweep triage (Session 65, 2026-05-10)

After the cubemap/tonemap/Sandcastle-defer cluster landed (Session 64), a fresh 95-demo sample of the cross-backend sweep surfaced six remaining visual-bug families. Fixes for #1 (atmosphere alpha + settle-time bump) are in this session; the rest are deferred.

### NEW-VR2-1-LOW-ALT-TERRAIN-LOAD — FIXED 2026-05-13 (Session 65 Batch 41)

**Symptom:** Ground-level demos (Aerometrex SF, 3D Tiles BIM, Bloom, Particle System, Lighting, Shadows) rendered the bottom half as a uniform gray/white plane in WebGPU — terrain tiles never reached the screen. The 3D Tiles models themselves did render.

**Two root causes found:**
1. **SkyAtmosphere alpha derived from post-tonemap color magnitude** ([SkyAtmosphere.wgsl L378 pre-fix](packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl)) — at low altitude the long horizontal path through the dense atmosphere produces bright scattered radiance, the formula `clamp(max(rgb)*2, 0, 1)` saturates to 1.0, and the SkyAtmosphere becomes opaque over the entire below-horizon area. WebGL pulls opacity from the scattering integrator's geometric path length, not from color.
2. **Terrain/imagery tiles take longer than 3s to load on WebGPU**. The cross-backend runner's `SETTLE_MS = 3000` caught the camera flying in but not the geometry settled. Bumping to 8000ms restored Aerometrex SF and 3D Tiles BIM; some demos still need 15000ms.

**Fix landed (this session):**
- [SkyAtmosphere.wgsl](packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl) — replaced the color-magnitude alpha with a geometric `1 - exp(-2 * pathRatio)` derivation. Path ratio is `rayLength / shellThickness`, so the limb (long path) still produces a visible blue halo while the below-camera-horizon (short path through atmosphere to Earth) stays mostly transparent.
- [cross-backend-sandcastle-runner.mjs](Tools/visual-regression/cross-backend-sandcastle-runner.mjs) — `SETTLE_MS` default 3000 → 8000, overridable via `SANDCASTLE_SETTLE_MS` env var.

**Still deferred:**
- **Bloom + Particle System still show no terrain at 15s settle.** Camera position resolves correctly (no camera bug — that was the Session 64 Sandcastle-defer fix) but globe surface tiles don't reach the screen. Investigate whether `globeSurfaceTileProvider` selects tiles at this altitude and whether the WebGPU draw commands hit the canvas. Could be tile selection LOD calc, frustum culling, or the WebGPU draw recorder skipping tiles.
- **Aerometrex SF terrain renders as untextured light gray shape** even after tiles load. Geometry is correct (hills/valleys visible) but the Bing imagery + Cesium World Terrain elevation texture aren't being applied to the tiles. Likely a tile-imagery composition issue at high LOD.
- **Proper alpha-from-scattering refactor** (instead of geometric path approximation) — the WebGL `computeAtmosphereScattering` returns `(rayleigh, mie, opacity, translucent)` where `opacity` is the Beer-Lambert extinction along the view ray. Mirror that signature in WGSL `computeScattering` / `sampleScatteringLut` so the alpha derivation matches WebGL exactly. With proper opacity, the PBR Neutral + sRGB encode parity fix (reverted this session because it pushed `max(rgb)*2` above 1.0 at ground level) can re-land safely.

**Estimated effort:** 1-2 sessions for the remaining low-alt terrain bug + proper alpha refactor.

#### Session 65 Batch 41 update (2026-05-13) — root cause located, two fixes shipped

Two stacked root causes, both fixed in [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts](packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts) + [packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl](packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl):

1. **`computeModifiedModelView` received the wrong argument.** The helper reads `obj.center` and falls back to a plain view matrix when it's missing. The caller passed a `GlobeSurfaceTile` whose `.center` property doesn't exist — every globe tile draw fell back to the plain view path. With a plain view matrix, the WGSL line `v_positionEC = modifiedModelView × position_tile_local` produces a HUGE camera-relative position because `position_tile_local` is tile-relative (a few hundred metres at most) but the view matrix's translation column equals the negated camera position in world coords (~6.4 Mm for Earth-surface views). Every fragment ended up with `v_distance > 100 km`, so `computeFog(v_distance, density, mod)` saturated to 1.0 at every pixel and replaced imagery with a flat fog color across the entire below-horizon area. Fix: pass `mesh` (which DOES have `.center` set by `TerrainEncoding`) instead of `surfaceTile`, and rename the parameter so the same bug can't reappear via a different caller. Mirrors WebGL `GlobeSurfaceTileProviderRendering.js:1120` (`rtc = mesh.center`).
2. **FOG branch unconditionally applied a `nightFogDimming * 0.05` factor + `fogMinimumBrightness` floor.** WebGL's equivalent darken multiplier (`GlobeFS.glsl:522-526`) is gated on `DYNAMIC_ATMOSPHERE_LIGHTING && (ENABLE_VERTEX_LIGHTING || ENABLE_DAYNIGHT_SHADING)`. For demos using the default `enableLighting = false`, WebGL leaves fog at full brightness while WebGPU was dimming it to a uniform `24/255` floor — the second factor behind the "flat color across below-horizon" symptom. Fix: gate the darken multiplier on `atmosphereParams.w > 1.5` (Batch 38 encoding for "dynamic lighting active") and remove the `fogMinimumBrightness` floor, matching WebGL exactly.

Verification (`probe-empty-scenes.mjs` colored-pixel %):

| Demo                         | Before | After  | WebGL  |
| ---------------------------- | ------ | ------ | ------ |
| Bloom.html                   | 35.9 % | 73.8 % | 69.6 % |
| Particle System.html         |  4.6 % | 68.1 % | 71.2 % |
| 3D Tiles Photogrammetry.html | 65.6 % | 87.0 % | 86.6 % |
| Bathymetry.html              | 79.4 % | 90.7 % | 90.7 % |

Orbit demos preserved (Sentinel-2 on-disk delta bit-perfect, Hello World mid-upper delta `(2, 0, -6)` within noise, 0 GPU validation errors across the sweep).

### NEW-VR2-1b-GLOBE-MERCATOR-DISTORTION — FIXED 2026-05-15 (Session 65 Batch 46)

**Symptom:** Orbit-view of the globe in WebGPU showed the well-known "stretched at poles / squished at equator" Mercator-on-sphere artefact. Greenland appeared enlarged ~3×; the equator band was visibly compressed. Visible in cross-backend sweep `Hello_World.webgpu.png`, `Star Burst`, and any orbit-altitude scene using a WebMercator imagery provider (Bing, OSM, Mapbox).

**Root cause (two coupled bugs in the TileUniforms packer):**

WebGPU's `WebGPUImageryReprojection` (key 28) converts Mercator imagery to a GEOGRAPHIC-projected output texture stored on `imagery._webgpuReprojectedTexture`. The CPU packer in [WebGPUGlobeSurfaceTileUB.ts](packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts) was reading the unmodified `tileImagery.useWebMercatorT` flag (true for Mercator providers) AND the cached `tileImagery.textureTranslationAndScale`, which `ImageryLayer._calculateTextureTranslationAndScale` (ImageryLayer.js:376) had computed in **Mercator-native (meters)** space because that flag was true.

The shader then sampled the geographic-projected texture using:
1. `webMercT` V coordinate (linear-in-Mercator-Y) — should have been `geoUV.y` (linear-in-latitude)
2. Mercator-native translation/scale — should have been geographic-radian translation/scale

WebGL has no parallel bug because it caches BOTH a `imagery.texture` (geographic) AND `imagery.textureWebMercator` (mercator) and binds the matching one ([GlobeSurfaceTileProviderRendering.js:1470](packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js#L1470)). The WebGPU path uses a single output texture per imagery, so the packer must override both fields to keep the shader in lock-step with the bound texture.

**Fix:** When `_webgpuReprojectedTexture` is present, override `useWebMercatorT` to false AND recompute `textureTranslationAndScale` in geographic space inline (equivalent to taking the `else` branch of `_calculateTextureTranslationAndScale`). Both written to the same per-layer slot in the TileUniforms layout.

**Files:** [WebGPUGlobeSurfaceTileUB.ts](packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts) (per-layer pack at LAYERS_OFFSET, USE_WEB_MERC_OFFSET).

**Verification:** `probe-projection-fix.mjs` captures `northam` / `arctic` / `equator` orbit views on both backends. WebGPU geometry now matches WebGL across all three (no Mercator distortion, North America/Greenland properly proportioned, equator band correctly sized). Remaining cross-backend delta is atmospheric/lighting tint, not projection.

### NEW-VR2-2-3DTILES-BASECOLOR-WHITE — Mostly resolved (BIM re-confirmed Batch 200; Moon is a separate Sandcastle-state issue)

**Re-confirm (Batch 200, 2026-06-05):** With the valid ion token, the BIM Power Plant tileset (asset 2464651) fully loads and renders **textured** on WebGPU — gray building structure + colored mechanical components, NOT solid white base color — matching WebGL (`vr2poly-{webgl,webgpu}.png`, 0 device errors). This re-confirms the BIM case of the white-base-color cluster as resolved. Mars / Aerometrex were already confirmed textured (2026-05-11). Only the Moon.html Sandcastle-state issue remains (tracked separately, not a renderer base-color bug).

**Status update:** Session 65 cont. (texture stub reuse + `texSubImage2D` ImageBitmap path) plus the Session 65 Batch 1 ground atmosphere intensity scaling resolved the bulk of the white-base-color cluster. Cross-backend sweep PNGs (2026-05-11):

- `Mars.html` — webgpu shows the red Martian surface, matches webgl reasonably well at 55.5% diff.
- `Aerometrex San Francisco.html` — webgpu shows visible photogrammetry textures (still has UI-state divergence — Sandcastle dropdown picks a different building on each backend).
- `3D Tiles BIM.html` — webgpu shows building textures; remaining diff is post-process related.

**Remaining open: Moon.html.** WebGPU shows a black scene area (UI loaded, no 3D content). Pattern matches `Aerometrex` dropdown mismatch — likely the `Cesium.Ellipsoid.default = MOON` switch + default camera position interacts differently with the Sandcastle runner's deferred startup on WebGPU. Not a renderer texture bug. Track under the Sandcastle-state work, not under base-color.

**Original investigation note:** [`WebGPUModelRenderer.js#L1185-L1209`](packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) texture readers + bind-group baseColor view were the suspected race; the fix landed in Session 65 cont. (stub-wrapper GPU texture reuse + 7-arg `texSubImage2D` ImageBitmap path in `WebGLStubTexture.ts`).

### ~~NEW-VR2-3-IMAGERY-WASH-OUT~~ — RESOLVED for the original on-disk bug (Session 65 Batches 1/16/17/18/19); residual tracked as NEW-VR2-3b

**Status (doc-synced Batch 172):** The ORIGINAL bug — SkyAtmosphere bleeding through the globe disk (cyan tint + global +100 brightening on-disk) — is RESOLVED: the disk-bleed probe confirms on-disk pixels render proper imagery colors with no cyan tint (deltas within noise). The heading still said "Open" but the body already records the resolution. The ONLY residual — over-bright atmosphere limb haze + a sun-glare patch — was reclassified into **NEW-VR2-3b-LIMB-HALO-OVERBRIGHT** (itself "MOSTLY RESOLVED"), so this entry covers only the disk bug and that is done. Do not read this strike-through as "the whole atmosphere-brightness family is closed" — the limb residual lives in VR2-3b.

**Original symptom (2026-05-10):** Earth in Hello World, Star Burst, Box, Polygon, Polyline, Sentinel-2 looked lighter / cyan-tinted vs WebGL with WebGPU +100+ brighter across the disk and a strong cyan/green shift.

**RE-VERIFIED 2026-05-13 (Session 65 Batch 19):** main bleed-through issue is **MOSTLY RESOLVED**. Disk-pixel probe ([Tools/visual-regression/probe-disk-bleed.mjs](Tools/visual-regression/probe-disk-bleed.mjs)) and side-by-side screenshots show:

- **On-disk pixels** now render with proper imagery colors — no cyan tint, no global brightening. Continental detail, oceans, and clouds are visible. (Hello World, Star Burst, Sentinel-2 verified.)
- **At-limb pixels** (sample points within ~50px of the disk edge) still show WebGPU brighter than WebGL by ~50-130 per channel. This is **atmosphere haze at the limb**, which is where the atmosphere SHOULD render — but the magnitude is over-bright vs WebGL.
- **Sun glare patch** — WebGPU shows a bright atmosphere/ground-glow patch in the sunlit region (visible as a yellow-white blob in the lower-right of Hello World). This isn't on WebGL.

Likely contributing fixes that landed since the original triage:

- Tonemap default cleanup (Session 65 cont. v2) — removed unconditional Reinhard.
- SkyAtmosphere geometric `1 - exp(-2 × pathRatio)` opacity (Batch 1).
- Globe + Model + SkyAtmosphere `lightDirectionEC` parity fixes (Batches 17, 18).
- Bathymetry composite-material rendering (Batch 16) — fixed the WGSL globe material code path used by many demos.

**Reclassified remainder:** the over-bright atmosphere limb haze + sun glare patch is now a separate **NEW-VR2-3b-LIMB-HALO-OVERBRIGHT** issue, not the original "atmosphere on disk" bug. Track separately.

**Verification probe results** (negative Δ = WebGPU darker, positive = brighter):

```
Hello World on-disk pixels: Δ (15, 7, -4) — within noise, no cyan tint.
Sentinel-2 on-disk pixels:  Δ (32, 19, 8) — slightly brighter but neutral.
```

Disk colors match WebGL within ~10-30 per channel — the cyan-tinted bleed is gone. Closing the original entry.

### NEW-VR2-3b-LIMB-HALO-OVERBRIGHT — MOSTLY RESOLVED 2026-05-13 (Session 65 Batch 40)

**Original symptom:** WebGPU atmosphere limb haze brighter than WebGL by ~50-130 per channel for sample points within ~50 px of the disk edge.

**Resolution:** Root cause turned out to be NEW-VR2-3c-DISK-EXTENT-DRIFT (now fixed in Batch 40). Once the camera was positioned identically between backends, the limb sample points lined up and the apparent over-bright reading collapsed:

```text
Hello World on-disk parity (post Batch 40):
  center    Δ ( -20, -15, -16)  ← within noise (imagery streaming timing)
  mid-upper Δ (   2,   0,  -6)  ← matches WebGL
  mid-lower Δ (  56,  58,  29)  ← single-pixel transition outlier

Sentinel-2 (post Batch 40):
  center    Δ (   0,   0,   1)  ← exact match
  mid-upper Δ (   1,   1,   0)  ← exact match
  mid-lower Δ (   0,   0,   0)  ← bit-perfect
```

**Residual:** ~25 px of disk-edge halo width difference at x=275 (left) and x=425 (right) in the horizontal scan probe — WebGPU's atmosphere shell renders a slightly wider faint haze ring. This is a sub-pixel rasterization / alpha-tail detail in the SkyAtmosphere shell, not the original "limb haze overbright" symptom. Track as a small follow-up only if visual review flags it. Estimated effort: ≤1 session.

### NEW-VR2-3c-DISK-EXTENT-DRIFT — FIXED 2026-05-13 (Session 65 Batch 40)

**Symptom:** WebGPU's rasterized disk extent was ~50 px wider per side than WebGL's at the same camera position. The "bluish bleed into space" the disk-bleed probe flagged was globe terrain rasterized too wide, not SkyAtmosphere.

**Root cause:** `Viewer.createAsync` (the WebGPU async bootstrap path) created the temp `CesiumWidget` inside a hidden container with `style.display = "none"`. Hidden ancestors zero a descendant's `clientWidth / clientHeight`, so when `CesiumWidget.configureCanvasSize` ran and the `Scene` constructor invoked `new Camera(scene)`, line 209-210 of `Camera.js` read

```js
this.frustum.aspectRatio = scene.drawingBufferWidth / scene.drawingBufferHeight;
```

against a `1×1` canvas — setting `aspectRatio = 1.0` instead of the real `1.333`. The default-view computation in `rectangleCameraPosition3D` then placed the WebGPU camera ~25% closer to Earth (`12.67 Mm` vs WebGL's `17.19 Mm`), making the rasterized disk ~1.5× wider on screen and producing all the "off-disk bleed" symptoms.

**Fix (Batch 40, [packages/widgets/Source/Viewer/Viewer.js](packages/widgets/Source/Viewer/Viewer.js)):** Replaced `display: none` on the temp container with `position: absolute; inset: 0; visibility: hidden`. The temp container now takes the full layout dimensions of the outer container so the canvas inside has the right `clientWidth/clientHeight` when Camera constructs, while the `visibility: hidden` (plus the loading overlay's `z-index: 9999`) keeps the pre-init frame invisible. The parent container's `position` is temporarily set to `relative` if it was `static` so the absolute child sizes correctly, and is restored after init.

**Verification:** All camera/canvas/frustum fields now match exactly between backends (`scene.drawingBufferWidth = 800`, `cameraH = 17190458 m`, `aspectRatio = 1.333`, `fovy = 0.817 rad`, etc.). Disk-bleed probe deltas collapse from `(+50, +80, +120)` at off-disk pixels to `(-3 to +3)` across all backends. See [Tools/visual-regression/probe-disk-extent-state.mjs](Tools/visual-regression/probe-disk-extent-state.mjs) for the state-comparison probe and [Tools/visual-regression/probe-disk-bleed-scan.mjs](Tools/visual-regression/probe-disk-bleed-scan.mjs) for the horizontal-row scan.

**Forensics process** (recorded for future "WebGPU vs WebGL appears different" investigations):

1. Quantified the symptom with a horizontal-row scan probe at the demo's disk row — proved the disk + halo were uniformly offset, not a shader misbehavior.
2. Wrote a cyan debug return in the SkyAtmosphere FS — confirmed the FS was not covering the off-disk pixels, ruling out SkyAtmosphere as the cause.
3. Probed `scene.drawingBufferWidth`, `frustum.aspectRatio`, `cameraPositionCartographic.height` etc. at the same timeout in both backends. Found camera-height mismatch with identical frustum settings — pointed to the Camera constructor reading a stale value.
4. Time-series snapshot of `canvas.width / .height / .clientWidth / .clientHeight` revealed the WebGPU canvas was briefly `width=1 height=1 cssW=0 cssH=0` before settling at `800×600`. The `display: none` on the temp container explained the zero `clientWidth`.
5. Fixed at the source (temp container styling) rather than working around downstream.

### NEW-VR2-4-EMPTY-SCENES — Reclassified 2026-05-13 (Session 65 Batch 16)

**Symptom (original):** 3D Tiles Photogrammetry (totally blank), Bathymetry (blank below toolbar), 3D Tiles Compare (split view both gray), Particle System (no terrain or particles).

**Per-demo triage (2026-05-13):**

- **3D Tiles Photogrammetry** — RESOLVED. WebGPU probe shows 65.5% colored pixels, screenshot looks correct (photogrammetry buildings + roads visible). Was likely resolved by prior tile-rendering work (Session 64 / 65 Cluster 2 texture cache + glTF upload fixes). No further action needed; closing this sub-bullet.
- **3D Tiles Compare** — RESOLVED. WebGPU probe shows 33.6% colored vs WebGL's 87% — both renderers display the split-view photogrammetry tilesets correctly, just the WebGPU side appears DIMMER (lighting/tonemap mismatch). Visual brightness difference is a separate issue covered by other VR2 entries; tilesets render OK. No further action needed; closing this sub-bullet.
- **Particle System** — RECLASSIFIED as duplicate of [NEW-VR2-1-LOW-ALT-TERRAIN-LOAD](#new-vr2-1-low-alt-terrain-load-partially-fixed-2026-05-10). Particle System uses camera height ~100 m at ground level — the empty scene IS the low-altitude tile rendering failure already tracked separately (Bloom + Particle System both fail at this altitude per the VR2-1 "still deferred" notes). The Particle System sub-bullet is folded into VR2-1.
- **Bathymetry** — PARTIALLY ADDRESSED. Custom composite globe material (`ElevationColorContour` fusing `ElevationContour` + `ElevationRamp`). Root cause was `material.wgslShaderSource = ""` because the composite fabric was using TOP-LEVEL `components: {...}` instead of a `wgsl: { components }` block, so `createWGSLMethodDefinition` returned empty.

**Bathymetry — Infrastructure landed (Session 65 Batch 16, 2026-05-13):**

1. **`MaterialHelpers.js`** — `createWGSLMethodDefinition` now falls back to top-level `components` + sub-`materials` when the fabric lacks an explicit `wgsl: {}` block but does declare sub-materials. The fabric expression syntax used for fusion (vec arithmetic, `max`, scalar promotion, member access) is GLSL/WGSL-compatible. Custom fabrics that need WGSL-specific syntax (`textureSample`, etc.) must still declare an explicit `wgsl: { components | source }` block.
2. **`MaterialHelpers.js`** — `replaceTokenInWGSL` helper added. `createSubMaterials` now also (a) renames `czm_getMaterial → czm_getMaterial_N` in each sub-material's `wgslShaderSource`, (b) prepends the renamed sub-material WGSL to the parent's `wgslShaderSource`, and (c) replaces each sub-material id (e.g., `contourMaterial`, `elevationRampMaterial`) in the parent's WGSL with the renamed method-call expression. Mirrors the existing GLSL flow.
3. **`WebGPUGlobeMaterial.ts`** — `aggregateCompositeUniforms` helper walks the parent material + sub-materials, returning a flat name→value map. `buildMaterialPrelude` + `packMaterialUBO` now use it so the composite UBO layout includes all nested sub-material uniform fields. Internal back-references (e.g., `_buffer`) are filtered out so they don't pollute the layout.
4. **`WebGPUGlobeSurfaceRenderer.ts`** — `_createWaterOceanMaterialBindGroupInner` uses `aggregateCompositeUniforms` for the texture-uniform lookup so composite-fabric textures (e.g., the `image` color-ramp owned by the `elevationRampMaterial` sub-material) reach the bind group at @group(2) @binding(5).
5. **`WebGPUGlobeMaterial.ts`** — `assembleMaterialWGSLSource` now prepends a module-scope `diagnostic(off, derivative_uniformity);` directive. Suppresses Tint's uniformity false-positive when material WGSL (e.g., `ElevationContour::dpdx(materialInput.height)`) is called from a globe FS that has conditional discards above it (clipping planes, clipping polygons, cartographic-rect limit).
6. **`GlobeTerrain.wgsl`** — fragmentMain attribute reverted; module-scope directive in `assembleMaterialWGSLSource` covers it.

**Verification (Session 65 Batch 16):** WGSL composite compiles successfully (1536 chars, includes both sub-material functions + composite czm_getMaterial). Zero GPU validation errors. 48 draw commands execute per frame. Composite WGSL fabric is now infrastructurally functional.

**Bathymetry — RESOLVED 2026-05-13 (Session 65 Batch 17):**

Root cause was in [`WebGPUGlobeSurfaceCameraUB.ts:217`](packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts#L217) — the per-tile camera UBO was packing `uniformState.sunDirectionEC` into the `sunDirectionEC` slot, but the upstream `GlobeFS.glsl` uses `czm_lightDirectionEC` everywhere. The two are identical when the scene uses a `SunLight`, but Bathymetry overrides `scene.light` with a per-frame `DirectionalLight` (horizontal hillshade direction). The composite material's `m.diffuse` was producing correct ramp colors, but the subsequent Lambert diffuse multiplication (`color = color * diffuse`) was using the sun's `NdotL` (Pacific = nighttime/twilight) instead of the demo's custom hillshade direction → ~0.025 night-ambient multiplier collapsed every fragment to dark gray.

**Fix:** swap `uniformState.sunDirectionEC` → `uniformState.lightDirectionEC` in the camera UBO packer. The WGSL field is still named `sunDirectionEC` for back-compat with existing shader code; renaming it is a separate refactor.

**Diagnostic methodology (for future similar bugs):** add temporary debug returns at successive points in `GlobeTerrain.wgsl::fragmentMain`:

1. `return vec4(1.0, 0.0, 0.0, 1.0)` after `m = czm_getMaterial(matInput)` → confirmed pipeline executes.
2. `return vec4(m.diffuse, 1.0)` → confirmed sub-materials produce correct ramp colors.
3. `return vec4(m.alpha, m.alpha, m.alpha, 1.0)` → confirmed alpha=1.0 in most fragments.
4. `return vec4(color, 1.0)` after `mix(color, m.diffuse, m.alpha)` → confirmed color is correct BEFORE lighting.

That narrowed the bug to the post-mix lighting block, which led to the `sunDir` vs `lightDir` discrepancy.

**Verification:** WebGPU Bathymetry probe now shows 97.0% colored pixels (was 7.4%), proper blue-ocean ramp rendering with hillshade lighting visible. Hello World + Globe Materials regression-checked: no degradation.

### ~~NEW-VR2-5-POLYLINES-ON-3DTILES-OVERSATURATION~~ — RESOLVED (full-load re-confirmed Batch 200, 2026-06-05)

**Resolution (Batch 200):** Re-confirmed with the now-valid ion token so the BIM Power Plant tileset (asset 2464651) fully loads. `probe-vr2-polylines-3dtiles.mjs` (Edge, both backends): WebGPU saturated-cyan/red pixel counts (**1135 / 21**) are BELOW WebGL's (**1474 / 264**) — the artifact was "WebGPU ≫ WebGL", so the opposite holds → does NOT reproduce. **0 device errors** both backends. PNGs (`vr2poly-{webgl,webgpu}.png`) show the BIM building textured with colored components + the clampToGround classification polyline rendering normally on both — no bright saturated cyan/red panels, no scanline z-fight, no wall bleed-through. (Minor base-panel color/framing differences are the known Sandcastle dropdown-state divergence, not the artifact.) Also corroborates NEW-VR2-2 (BIM base color is textured, not white). The earlier "pending full-load re-confirm" caveat is now closed.

**Original (historical):** Did NOT reproduce as of Batch 161 (probe added, pending full-load re-confirm — the token was expired so the tileset never fully loaded headless).

> **Batch 161 reproduction result:** `Tools/visual-regression/probe-vr2-polylines-3dtiles.mjs` loads the BIM Power Plant tileset (ion asset 2464651) + a `clampToGround` polyline with `classificationType: CESIUM_3D_TILE` in both backends. The described artifact is **gone**: WebGPU shows NO saturated cyan/red panels and NO z-fight scanlines — saturated-cyan px 1116 (WebGL 1210), saturated-red px 4 (WebGL 204), **0 device errors**. The PNGs render equivalently (structure/pipes clean, the colorful ground patch is identical in BOTH backends → tileset content, not a WebGPU artifact). Likely fixed by intervening classification / depth-sample work (the doc predates many such batches). **Caveat:** tileset reported `ready:false` (BIM tilesets stream continuously) and the polyline coords approximated the demo — a longer-load, demo-exact re-confirm should precede a hard close. Probe kept as a regression guard (needs network + ion access).

**Original symptom (2026-05-13):** [Polylines on 3D Tiles.html](Apps/Sandcastle/gallery/Polylines%20on%203D%20Tiles.html) on WebGPU renders polygon overlays as bright cyan/red with visible scanline patterns, polylines bleed through walls/buildings, BIM building looks bleached.

**Side-by-side diagnostic captured 2026-05-13:**

- **WebGL:** BIM Power Plant tileset renders fully shaded (gray pipes, brown walls, teal accents), yellow dashed polylines clearly visible on the floor classifying the tile surface. No overlay artifacts.
- **WebGPU:** Same BIM building renders DIMMER, with bright primary-color (cyan + red) rectangular panels at oblique angles overlaying the structure. Each panel shows a sub-pixel scanline z-fight pattern. Yellow polyline segments are present but dim/short.

**Updated hypothesis (replaces "translucent overlay blending wrong"):** The BIM 3D Tileset appears to be rendering TWICE in WebGPU — once as the proper textured tile geometry, once as raw-color shadow-volume geometry that wasn't depth-clipped. The bright primary colors (255-saturated cyan + red) are characteristic of `PolylineShadowVolumeFS::vsMain` writing its volume color WITHOUT the depth-sample-based clipping path (which should emit `discard` for fragments outside the tile-surface intersection). The scanline pattern is z-fight between the two coplanar renders. The demo uses NO `ClassificationPrimitive` and NO `GroundPrimitive` — only `GroundPolylinePrimitive` (via the Entity polyline with `clampToGround + classificationType: CESIUM_3D_TILE`).

**Next-investigation starting points:**

1. Verify the `GroundPolyline` shadow-volume FS depth-sampling is reading the right depth texture (per-frustum bind group resolver from Session 3) — when it samples a stale or wrong-frustum depth, every fragment passes the plane-distance tests + the surface-depth test and emits the volume's raw color.
2. Add a runtime probe to dump how many draw commands the BIM tileset is producing per frame in WebGPU vs WebGL — if WebGPU is double-dispatching (e.g., a classification-pass duplicate that shouldn't fire), that explains the doubled render.
3. Check whether the BIM Power Plant tileset has any tile metadata that's accidentally being read as a classification volume by the WebGPU command-builder (vs WebGL which ignores it).
4. If GroundPolyline FS isn't the source, suspect a `ClassificationPrimitive` shadow volume from polyline-from-entity construction firing where it shouldn't.

**Estimated effort:** 1-2 sessions — needs frame-capture / draw-command trace to disambiguate "renderer is double-dispatching the tileset" from "polyline classifier is leaking shadow-volume color."

### ~~NEW-VR2-6-ATMOSPHERE-DEMO-OVERSATURATES~~ FIXED 2026-05-11 (Session 65 Batch 1)

**Symptom (resolved):** `Atmosphere.html` rendered the Earth disk as solid tan with no terrain visible when `globe.atmosphereLightIntensity = 20.0` (2× default).

**Root cause:** `sampleAtmosphereFogLut` in `GlobeTerrain.wgsl` hardcoded a `GROUND_INTENSITY_RESCALE = 0.2` scalar tuned for the default-config case (assumes `sky=50, globe=10`, ratio = 0.2). When `globe.atmosphereLightIntensity = 20`, the rescale stayed 0.2 — atmosphere color came out at half its proper magnitude, and the downstream exposure tonemap (`1 - exp(-2 × (imagery + atmoColor × transmittance))`) had no headroom: every fragment saturated to near-white-tan and imagery variation collapsed.

**Fix:** [`GlobeTerrain.wgsl::sampleAtmosphereFogLut`](packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl) now multiplies the LUT sample by `tile.groundAtmosphereControl.z` (CPU side: `Globe.atmosphereLightIntensity`). The LUT itself is intensity-free (the SkyAtmosphere shader applies `u.intensity` at fragment time), so this is the correct math for any user-customized intensity. Default Hello-World (intensity = 10) is bit-identical to the previous default since `0.2 × 50 = 10`.

**Verification:** at `globe.atmosphereLightIntensity = 20`, CesiumViewer probe shows the planet rendering with proper terrain detail visible (continents distinguishable from oceans) instead of the previous uniform tan.

**Closing batch:** Triaged Session 65 (2026-05-10). Sub-item #1 partially fixed in this session; sub-items #2-6 open with size estimates.

### Session 65 cont. v2 (2026-05-10) — Tonemap default + Atmosphere halo investigation

**MAJOR FIX — NEW-VR2-3 imagery wash-out (cyan tint)** — FIXED.

Root cause was [WebGPUPostProcessStageCollection.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts) `getDefaultCache()` returning `tonemappingEnabled: true`. The post-process Tonemap stage (Reinhard + sRGB encode) was unconditionally enabled on every WebGPU frame, transforming globe imagery from RGB (0.1, 0.2, 0.4) → (185, 212, 230) via `x / (x + 0.087)` Reinhard + `pow(., 1/2.2)`. WebGL's PostProcessStageCollection sets `_tonemapping.enabled = false` in its constructor (line 57) — only flipping to true when `useHdr` is on. WebGPU default needed to match. One-line change. **Impact:** mean cross-backend diff dropped from ~75% to ~49%; Earth now renders deep blue oceans + tan continents; Mars renders red/brown surface; Aerometrex SF shows real photogrammetry textures.

Diagnostic method: shader-side debug-return probe (`return vec4(0.1, 0.2, 0.4, 1.0)`) directly compared against canvas pixel readback. Allowed isolating that the transformation lives in the post-process chain, not the globe shader itself.

**ATMOSPHERE HALO** — Partially diagnosed, still invisible.

Two contributing bugs found and addressed:

1. **`orbitFalloff` scale-height too small** ([SkyAtmosphere.wgsl::sampleScatteringLut](packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl) + [GlobeTerrain.wgsl::sampleAtmosphereFogLut](packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl)): the previous code used `exp(-excessAltitude / thickness)` where thickness is the ~160 km shell. For Hello World camera at 5.6 Mm above shell, that's `exp(-35) ≈ 0` — atmosphere is fully faded. Changed scale-height to `max(thickness, innerRadius)` so the falloff stretches to "perceptible up to ~3 Earth radii, faded at GEO."

2. **LUT bypass for orbit views** ([SkyAtmosphere.wgsl fragmentMain](packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl)): the inscatter LUT was generated for camera positions WITHIN the atmosphere shell. At orbit altitudes the V coordinate clamps to 1.0 (the edge value) and the LUT returns invalid data. Added a check that falls back to inline `computeScattering` ray-march when camera is more than 2× shell thickness above the shell.

**Still invisible after both fixes.** Diagnostic methodology established:

- Magenta debug return at fragment exit confirmed shell geometry + depth-test reach the fragment stage at the limb (visible magenta ring around Earth).
- Forced sky-blue + geometric opacity made a faint halo appear, confirming blending and the alpha derivation work.
- Direct visualization of `computeScattering` output (raw color magnitude * 100x amplifier) showed NO halo, confirming the scattering math itself returns near-zero values at orbit altitudes.
- Hypothesis (unverified): the inline ray-march integrates uniformly across the FULL ray traversal, but for orbit-altitude limb rays the path may include substantial "above-atmosphere" segments where density is ~0. Compared to WebGL's `AtmosphereCommon.glsl::computeScattering` which uses variable step sizes (line 81: `rayStepLengthIncrease = w_inside_atmosphere * ...`) and a primary-step count that scales with altitude (`PRIMARY_STEPS = PRIMARY_STEPS_MAX - int(w_inside_atmosphere * 12.0)`). Our flat 16-step uniform-stride integration likely aliases too coarsely for orbit views.

**Next-investigation starting points:** port WebGL's variable-stride / split-strategy ray-march into the WebGPU `computeScattering`, OR rebuild the LUT to also cover orbit-altitude camera positions so the LUT path returns meaningful values up to GEO. The latter is the cleaner architectural fix.

**Estimated effort:** 1-2 sessions for the proper port.

### Session 65 cont. (2026-05-10) — Deep dive on all 6 issues

User asked to fix all 6 issues. Made meaningful infrastructure progress on #2 (texture cache). Other 5 turned out to need broader changes than fit in one session; deeper analysis and starting points captured in the per-item notes above.

**#2 partial fix landed:**

- [WebGPUModelRenderer.js](packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) `createGPUTextureFromReader` now reuses the GPU texture already allocated by `WebGLStubTexture` when present (`cesiumTexture._texture._webgpuTexture.texture`). Previously only checked `cesiumTexture._source` which CesiumJS Texture doesn't retain after upload — every glTF texture fell back to the white default.
- Tracks `placeholderSlots` per-primitive when a slot's reader hadn't loaded yet; `refreshDeferredModelTextures` polls per-frame and upgrades slots when readers resolve.
- [WebGLStubTexture.ts](packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts) `texSubImage2D` now handles BOTH the 9-arg form (raw byte source) AND the 7-arg form (HTMLImageElement / ImageBitmap source) — previously the 7-arg form silently no-op'd, which is one of the model-texture upload paths the glTF loader uses.

**Visual impact:** Aerometrex SF now shows visible texture content (yellow vegetation patches) where before it was a white slab. 3D Tiles Compare's split view now shows building shapes where before it was empty gray. Mars/Moon still render solid white — those tilesets must use a third texture upload path that this PR didn't touch (likely a direct GPU texture creation that bypasses CesiumJS Texture entirely). Diagnostic probe confirmed the GPU texture exists for Mars but its content stays default-white, suggesting the upload happens via a path that allocates but doesn't write pixels.

**Remaining items (#1 cont, #3, #4, #5, #6):** Each has a clear root-cause sketch + investigation path in the per-item notes above. Not landed this session because each requires either:

- Frame-capture tooling (#3 SkyAtmosphere depth-test bleed)
- Tile-selection / draw-command trace at low altitude (#1 cont)
- Per-demo diagnosis (#4 empty scenes — at least 4 different demos with different setups)
- Classification depth-pipeline rework (#5 PolylinesOnTiles)
- LUT regeneration-per-globe-intensity (#6 Atmosphere demo) coupled with #3

**Estimated effort to fully close:** 5-8 sessions across the 5 remaining items.

---

## NEW-VR-3 — Cross-backend tooling determinism (Batch 70, 2026-05-19)

### ~~VR3-SPLIT-SCREEN-CLOCK-SYNC~~ — RESOLVED (Batch 175) — Approach 1 (per-frame clock snap)

**Resolution (Batch 175):** `Apps/WebGPUTest/split-screen-comparison.html`'s `setupCameraSync` now also runs a per-frame clock snap — WebGL is the master, the WebGPU slave gets `shouldAnimate = false` and its `clock.currentTime` is `JulianDate.clone`d from the master every frame (one clone/frame, negligible). Both panes now share sun position / terminator / atmospheric scattering, so the split-screen is a true renderer-parity comparison instead of a clock race. The KNOWN-ISSUE comment in the page was updated to record the fix. Dev-tooling only; no regression-test path touched.

**What (original):** `Apps/WebGPUTest/split-screen-comparison.html` runs WebGL and WebGPU viewers as independent Cesium instances. Each has its own `Clock` with default `shouldAnimate = true` and its own `Date.now()` start moment, so the two halves of the screen drift apart over the session — different sun position, different terminator placement, different atmospheric scattering as the simulation clocks tick out of sync. For a true side-by-side visual parity comparison the two viewers should share a clock state.

**Why deferred:** The probe-based metric work (clock-pinning in `probe-polar-multi-plain.mjs` etc., Batch 70) doesn't depend on the split-screen page since each probe creates its own viewer with a pinned clock. The split-screen page is a developer comfort tool, not on the regression-test path.

**Prerequisites:** None.

**Estimated effort:** ~1 session. Two approaches:

1. **Frame-by-frame snap.** Add a `requestAnimationFrame` callback in the split-screen orchestrator that does `webgpuViewer.clock.currentTime = webglViewer.clock.currentTime` (and `shouldAnimate = false` on the slave). One JulianDate copy per frame; negligible cost.
2. **Shared Clock instance.** Construct one `Clock` and pass the same object into both viewer constructors via `clockViewModel`. Slightly more involved because viewer init currently constructs the Clock inside each instance; would need a small viewer-API extension or post-construction `viewer.clock = sharedClock` swap.

Approach 1 is simpler and lower-risk.

**Impact:** Visual parity in split-screen becomes a meaningful "are these two renderers producing the same scene?" comparison instead of an "are the two clocks at the same UTC?" race. Especially important when the scene includes sun-direction-dependent rendering (day/night-shading, atmosphere, water highlights, terminator).

**Trace:** Batch 70 introduced clock-pinning in probes. The split-screen page wasn't updated because it's a separate concern (interactive developer tool vs. automated regression probe). See WEBGPU_DEBUGGING_LOG.md Batch 70 "Future work" section.

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

### NEW-VR2-7-GLOBE-MERCATOR-V-PRECISION — Mercator-V disproved (2026-05-11); per-tile brightness anomaly does NOT reproduce (Batch 163) — effectively resolved

**Original symptom:** Lake Superior (~47°N) appeared subtly vertically compressed in the cross-backend Blue_Marble sweep PNGs.

**Deep dive results (Session 65 Batch 2 deep dive):**

The Mercator V hypothesis is **disproved**. Verified:

- Per-vertex `webMercatorT` values match the expected Mercator math to <0.0001 precision (probed a level-5 tile spanning 45°–50.625°N; reading `mesh.vertices` and comparing against `(mercY(lat) − mercY(south)) / (mercY(north) − mercY(south))`).
- Camera state identical between backends: `positionWC`, `fov`, `aspectRatio`, `near`, `far`, `drawingBuffer`, `pixelRatio` all bit-identical for the same `setView` call.
- Tile selection identical: same 35 tiles at the same LOD levels (2/3/4) on both backends after settled loading.
- At nadir over Lake Superior at 1.0–1.5 Mm altitude, **the two backends render Lake Superior visually IDENTICALLY** (pixel correlation `bestYOffset = 0`). No N-S squishing reproduces with explicit camera control.

Original "squishing" in the sweep PNG was likely an artifact of timing/state mismatch (camera not fully settled before capture) rather than a renderer bug.

**New finding — different bug uncovered while probing:**

> **Batch 163 reproduction result — does NOT reproduce.** `Tools/visual-regression/probe-vr2-tile-brightness.mjs` renders the globe (lighting on, ground-atmosphere/fog off) nadir over Lake Superior at 5 Mm in both backends, settles all imagery tile-load queues (≥60 consecutive empty-queue frames), then measures the largest brightness jump between adjacent 24px blocks over the globe disk. WebGPU's max adjacent-block jump is **99 vs WebGL's 119** (ratio 0.83 — WebGPU is *smoother*, not anomalous), and both maxima sit at the disk limb (globe-vs-space edge), not an interior tile boundary. The PNGs render North America with **uniform tile brightness on both backends** — no distinctly-brighter tile, no sharp interior boundary. The anomaly appears resolved by intervening imagery/material work. Probe kept as a regression guard (`PROBE_DARK=1` toggles the lighting-off suspect test if it ever recurs).

At ~5 Mm camera altitude over Lake Superior, WebGPU shows a **per-tile brightness anomaly** — one rectangular tile renders distinctly brighter than its neighbors, with a sharp visible boundary. Pattern persists after 45+ seconds of wait time with all tile load queues empty. Tile count and LOD distribution identical to WebGL (35 tiles, levels 2/3/4). Same camera state. Yet WebGL shows uniform brightness across all tiles.

**Suspects:**

1. **Per-tile material uniform staleness** — one tile's day/night alpha or brightness/contrast adjustment may be cached against an earlier frame state and not refresh.
2. **Imagery layer parent-fallback rendering** — when a layer's high-LOD tile hasn't loaded yet, WebGL falls back to a stretched parent-tile sample; WebGPU may render the same fallback differently.
3. **Per-tile fog / drape interaction** — even with `globe.showGroundAtmosphere = false`, some per-tile state may leak from a prior drape-on frame.

**Next-investigation starting points:**

- Capture a diagnostic frame with all tiles' material flags + brightness/contrast/saturation/dayNightAlpha values logged. Look for one tile whose values diverge from neighbors.
- Disable lighting entirely (`globe.enableLighting = false`) and check if the anomaly persists — if it does, it's imagery-state related; if it disappears, it's a lighting/normal calculation bug.

**Estimated effort:** 1–2 sessions — needs interactive frame capture to isolate which tile is anomalous and what's different about its render state.

**Estimated effort:** 1 session — needs pixel-level overlay diff at a fixed camera + fixed terrain LOD to isolate which axis (sampling precision vs LOD vs scale matrix) introduces the error.

### NEW-WEBGPU-MSAA-FLEET-ENABLEMENT — CLOSED 2026-05-13 (Batches 21-36)

**Final state:** WebGPU backend now renders with 4× MSAA out of the box matching the WebGL default. Bridge in `WebGPUSceneRenderer.prepareFrame` propagates `scene.msaaSamples` into `context._msaaSamples`; downstream pipeline caches + render bundle encoders all consume the value. Kill switch `scene.msaaSamples = 1` falls back to no-AA.

**Completed by batch:**

- Batch 21: SkyAtmosphere, Sun, Moon, CubeMapPanorama, DepthPlane pipelines
- Batch 25: Render bundle invalidation on sample-count change + `_lastMsaaSamples` drift detection in `prepareFrame`
- Batch 28: Model PBR + velocity + classification pipeline cache reads `context._msaaSamples`
- Batch 32: Globe surface + wireframe + debug pipelines via `PipelineHost._sampleCount`
- Batch 33: OIT composite pipeline
- Batch 34: InvertClassification verified already MSAA-aware (Batch 116 work)
- Batch 35: `copyTextureToTexture` paths audited — TranslucentTileClassification routes MSAA depth through dedicated pipeline; GlobeDepth has MSAA-resolve compute; refraction capture uses resolve target. No remaining unsafe sites.
- Batch 36: Bridge re-enable, `_lastMsaaSamples = 1` initial value (was `null`), globe terrain render bundle encoder reads sample count.

**Verification:** Hello World, Bathymetry, 3D Models, 3D Tiles Photogrammetry — zero GPU validation errors, pixel counts within noise of pre-bridge baseline. Visual MSAA improvement expected on sphere/ellipsoid seams, polyline aliasing, model silhouettes.

---

### Closed entry (historic, kept for batch-history reference) — NEW-WEBGPU-MSAA-FLEET-ENABLEMENT (was Partial)

**Symptom:** WebGPU renders without MSAA while WebGL defaults to 4x MSAA. Visible everywhere small triangles or thin features appear: sphere/ellipsoid mesh seams (Show or Hide Entities), polyline aliasing, model silhouette banding. WebGL silently smooths these via sub-pixel coverage; WebGPU shows raw rasterization.

**Root cause:** `Scene._msaaSamples` defaults to 4 but `WebGPUContext._msaaSamples` is a hardcoded `1` and is never written from the scene. Every WebGPU pipeline pulls `context._msaaSamples ?? 1` as its `sampleCount`, so no pipeline ever runs multisample.

**Why bridging it didn't just work (Session 65 Batch 4 attempt):**

- `GlobeDepth-DepthCopy-MSAA-BindGroup` creation fails: the bind group expects `texture { sampleType: Depth, multisampled: 1 }` but the depth texture is missing `TEXTURE_BINDING` usage. Fixed in `WebGPURenderTarget` so the flag is present even for MSAA depth.
- Several `device.createRenderPipeline` callsites have `multisample.count` either omitted (defaults to 1) or pinned at 1 even when the render target is MSAA. Mismatch fails attachment-compatibility validation and invalidates the command buffer.
- `WebGPUInvertClassification` has a `cache.sampleCount` check that may not reflect the new value.
- `copyTextureToTexture` paths that move depth out of the scene FB into globe-depth may need a blit-via-pipeline fallback for MSAA sources.

**Plan:**

1. Sweep every `device.createRenderPipeline` in `packages/engine/Source/Renderer/WebGPU/` — add `multisample: { count: context._msaaSamples ?? 1 }` to every pipeline that targets the scene FB. Pipelines that target single-sample intermediates (pick FBO, edge resolve, post-process) keep `count: 1`.
2. Sweep every `createTexture` call and confirm the `sampleCount` matches the framebuffer it'll bind to.
3. Add resolve-target wiring where MSAA color targets need to feed a single-sample consumer (post-process input).
4. Handle `copyTextureToTexture` MSAA-source restrictions via a blit-via-pipeline fallback.
5. Wire the `prepareFrame` bridge: `context._msaaSamples = scene.msaaSamples`.
6. Re-run cross-backend sweep — expected mean-diff drop into the 40s.

**Estimated effort:** 2-3 sessions of careful pipeline-by-pipeline audit + testing.

**Batch 21 partial progress (2026-05-13):**

Attempted bridge enablement to confirm what still breaks. Test result: with `context._msaaSamples = scene.msaaSamples (= 4)`, Hello World fails with cascading attachment-state validation errors across multiple pipelines. Each error names a specific pipeline; fixing it surfaces the next one. After fixing 4 visible failures, the next blocker is the Globe terrain render bundle (bundles bake their pipeline at record time and can't be edited).

**Pipelines made MSAA-aware in this batch** (`multisample: count > 1 ? { count } : undefined`; harmless when MSAA is off):

- `WebGPUSkyAtmosphereRenderer.js` — `createPipeline(... sampleCount)` reads `context._msaaSamples` at pipeline-creation time.
- `WebGPUEnvironmentRenderer.js` — Sun + Moon pipeline descriptors.
- `WebGPUCubeMapPanoramaRenderer.js` — `getPipeline(device, format, sampleCount)` + cache rebuild when sample count changes; `createDrawCommand` plumbs the sample count from `context._msaaSamples`.
- `WebGPUDepthPlane.ts` — `initialize(... sampleCount)` accepts sample count; `WebGPUSceneRendererEnsureResources.ts` passes `context._msaaSamples ?? 1`.

**Bridge:** intentionally reverted in `WebGPUSceneRenderer.prepareFrame`. Comment block updated to reflect the partial progress + next blockers. Re-enable when render-bundle + remaining cached pipelines are MSAA-aware.

**Remaining blockers** (next batch):

- Globe terrain render bundle (`Globe terrain bundle`) — bundles need rebuilding when sample count changes; the `renderBundleManager.invalidateAll` call that fires on `_sceneColorFormat` flip already exists but doesn't fire on sample-count change. Wire the same invalidation for sample-count drift.
- Model pipeline cache (`WebGPUModelPipelineCache.js`) — pipeline keys include format but not sample count.
- Globe surface pipelines, billboards, polylines, labels, points, ground primitives, classification, gaussian splats, voxels — sweep each `createRenderPipeline` site.
- `WebGPUOIT.ts` and `WebGPUInvertClassification.ts` — already accept `multisample` via descriptor but their callers pin `count: 1`.
- `copyTextureToTexture` paths that move depth out of MSAA-source framebuffers need blit-via-pipeline fallback.

### ~~NEW-ORBIT-RENDER-AUDIT-2026-05-13~~ — RESOLVED (all four sub-items shipped; doc-synced Batch 160)

> **Status (Batch 160 doc-sync):** all four audit items are now addressed. #1 bloom + #3 dusk-terminator resolved/verified in Batch 160 (sub-entries below); #2 clouds mostly-shipped via the Phase 6 volumetric work (2026-05-13, see NEW-ORBIT-PHASE-6-VOLUMETRIC-CLOUDS below); #4 atmosphere reflectivity confirmed shipping. The discrete sub-entries are kept below for history.

User-reported audit comparing real orbital photography (ISS, Earthrise from the Moon) to our WebGPU render surfaced four issues:

1. **Bloom too strong at orbit** — `WebGPUBloomEffect.ts` defaults (`threshold: 0.8`, `intensity: 0.5`) accumulate visible halo around the Earth disk at orbit altitudes. Real cameras don't bloom from space.
2. **No clouds from orbit** — `WebGPUProceduralCloudRenderer.ts` is ground-only (≤4 km ceiling, default off). `WebGPUCloudRenderer.ts` is billboard decorative particles. No satellite-style cloud-cover rendering exists.
3. **Night-side correctness** — verified math is correct (`computeDayNightFade` sharp ×5 terminator, `nightAmbient = 0.025` floor). Needs a canonical regression probe with the terminator crossing the viewport.
4. **Atmosphere reflectivity** — all recent fixes (geometric opacity, dual-light LUT, NONE-case dynamic-lighting, `lightDirectionEC` parity, composite WGSL fabric) confirmed shipping; the residual perceived over-brightness comes from issues #1 and #2.

**Tracked as discrete work items** (see [CELESTIAL_ATMOSPHERE_DESIGN.md §13](CELESTIAL_ATMOSPHERE_DESIGN.md) for full design):

#### ~~NEW-ORBIT-BLOOM-ALTITUDE-GATE~~ — RESOLVED (Session 65 Batch 22; doc-synced Batch 160)

**Symptom:** Bloom halo around Earth disk visible at GEO views (Hello World, Star Burst, Sentinel-2). Real orbit photography shows essentially zero bloom on the disk.

**Shipped:** `WebGPUBloomEffect.ts::applyAltitudeGate(cameraHeightMeters)` multiplies the base bloom intensity by a smoothstep curve from `1.0` at `altitudeGateMinMeters` (default 100 km) to `altitudeGateOrbitFloor` (default 0.15) at `altitudeGateMaxMeters` (default 1 Earth radius = 6 378 137 m). Called per-frame from `WebGPUSceneRenderer.ts:2734-2735` with `camera.positionCartographic.height`. The 0.15 floor (rather than the originally-scoped 0.0) deliberately preserves a faint Rayleigh-limb haze that reads as real-camera bloom; set `altitudeGateOrbitFloor: 0` to fully kill orbit bloom, or `enableAltitudeGate: false` for pre-Batch-22 behavior. A paired `WebGPUAutoExposure.ts::applyAltitudeGate` (Batch 39) blends adaptive exposure toward neutral at orbit. See [CELESTIAL_ATMOSPHERE_DESIGN.md §13.1](CELESTIAL_ATMOSPHERE_DESIGN.md).

#### ~~NEW-ORBIT-OCEAN-SPECULAR-LIMB-ATTENUATION~~ — RESOLVED (specular gate shipped; doc-synced Batch 160)

**Symptom:** A too-bright sun-side ocean glare patch persisting at orbit altitudes.

**Shipped:** `GlobeTerrain.wgsl::computeEnhancedOcean` gates the specular sun-glint term with an orbit-altitude attenuation `orbitAttenuation = 1 - smoothstep(100 km, 1 Earth radius, cameraAltitude)` (derived from `length(encodedCameraHigh + encodedCameraLow) - 6378137`), fading the GGX glint out above ~100 km (GlobeTerrain.wgsl ~L2010-2062). Note: the entry's literal target — the `pow(VdotL, 4.0) × 0.15` term in `computeSubsurfaceScattering` — is **dead code** (no caller; flagged "present but currently unused" in GlobeFS.glsl L480 + GlobeTerrain L3161), so there was never a live glare from it; the actual visible orbit glare was the specular term, which is the one now gated.

#### ~~NEW-ORBIT-DUSK-TERMINATOR-PROBE~~ — RESOLVED (Batch 24; rebuilt + genuinely-passing Batch 160)

**Goal:** Canonical regression probe with the terminator crossing the viewport. Validates `lightDirectionEC` correctness (Batches 17/18), `computeDayNightFade` math, and `nightAmbient` floor.

**Shipped:** `Tools/visual-regression/probe-dusk-terminator.mjs` — vernal-equinox clock (2026-03-20 12:00 UTC, sub-solar at 0°N/0°E), camera at 12 Mm over `(0°N, 90°E)` looking nadir so the terminator runs down the viewport. Direction-agnostic brighter:darker hemisphere luminance assert (> 1.3:1) + WebGPU device-error check.

**Batch 160 fix (the real remaining work):** the original Batch 24 probe drove the Sandcastle "Hello World" gallery page through a renderer-override shim (`new Viewer(...)` → `Viewer.createAsync(...)`). That shim never reliably captured the *async* WebGPU viewer, so the WebGPU globe rendered as **empty space** — the probe was silently never exercising WebGPU (it reported 1.12:1 on a blank frame). Rebuilt onto the canonical CesiumViewer driver (`?renderer=` + global `window.viewer` + `PROBE_BASE`), the same robust pattern the other probes use. Now both backends render the globe with a clear terminator and pass: **WebGL 1.48:1, WebGPU 1.43:1, 0 device errors** — night-side correctness genuinely verified on WebGPU.

#### NEW-ORBIT-PHASE-4-ATMOSPHERIC-CONDITIONS-FINISH — FIXED 2026-05-13 (Session 65 Batch 42)

Per [CELESTIAL_ATMOSPHERE_DESIGN.md §6 Phase 4](CELESTIAL_ATMOSPHERE_DESIGN.md).

- ✅ `humidity` → mie coefficient + fog density (Batch 29)
- ✅ `cloudCover` → star occlusion factor (Batch 29)
- ✅ `airQuality` → rayleigh coefficient (Batch 29)
- ✅ `windSpeed` / `windDirection` → SkyAtmosphere uniforms (Batch 42 — pre-emptive scaffolding ahead of Phase 5/6 consumers)

Batch 42 added the `windDirectionAndSpeed: vec4<f32>` slot to the SkyAtmosphere uniform buffer (`UNIFORM_BUFFER_SIZE` 256 → 272) and packed `frameState.atmosphericConditions.weather.{windDirection,windSpeed}` into it. No fragment shader path consumes the value yet — it's scaffolding so the Phase 5/6 bind-group layouts don't have to rebuild when those phases land.

#### NEW-ORBIT-PHASE-6-VOLUMETRIC-CLOUDS — Mostly shipped 2026-05-13 (Session 65 Batch 43)

**Status reality check (Session 65 audit, 2026-05-13):** The "no clouds from orbit" user-reported gap is mostly already addressed. The grep audit found:

- **Phase 5a-5d shipped.** `WebGPUVolumetricFogRenderer.ts` + `Compute/VolumetricFog.wgsl` ship the full froxel grid (8a), height-fog density injection (5b), Henyey-Greenstein sun + moon scattering with sun-shadow-map god rays (5c), and 3-octave value-noise varying density (5d). Wired into `WebGPUSceneRendererEnvironmentalEffects.ts` and gated on `atmosphericConditions.volumetricFog.enabled` (default FALSE per B18). The FEATURE_INVENTORY had stale `SCAFFOLDED` tags — corrected in this commit.
- **Phase 6 main render path shipped.** The legacy-named `WebGPUProceduralCloudRenderer.ts` is in fact a full Schneider-style volumetric raymarcher: HG dual-lobe phase function, Beer-Powder lighting, 3D FBM density field with wind animation, coverage threshold + height shaping, per-step light marching for soft shadows, silver-lining edge enhancement. Was previously only reachable via `globe.showProceduralClouds`; Batch 43 wired `atmosphericConditions.clouds.enableVolumetric` to alias the same toggle so the canonical API now controls it.

**Phase 6 status (all sub-items SHIPPED 2026-05-13 → 2026-05-15):**

- **Phase 6a — Volumetric raymarch shader** — SHIPPED via existing `WebGPUProceduralCloudRenderer` (Schneider HG dual-lobe + Beer-Powder + 3D FBM + light-march). Was always volumetric; the "procedural" name was historical. Surfaced via `atmosphericConditions.clouds.enableVolumetric` alias in Batch 43.
- **Phase 6c — Cloud shadows in volumetric fog** — SHIPPED Batch 44 (2026-05-13). Cheap single-sample approximation along sun direction to cloud-layer mid-altitude → `exp(-density × absorption × layerThickness)` multiplies into `VolumetricFog.wgsl::sampleSunShadow` term. UBO grew 72 → 84 floats. Default-off path bit-stable vs pre-Batch-44.
- **Phase 6d — Quality dial** — SHIPPED Batch 45 (2026-05-15). `atmosphericConditions.clouds.volumetricQuality` accepts `"low" | "medium" | "high" | "auto"` and resolves to `(maxSteps, lightSteps)` pairs at render time. Legacy `globe.cloudQuality` (numeric) stays as a power-user escape hatch.
- **Phase 6b — High-altitude 2D fast-path crossfade** — SHIPPED Batch 45 via Phase 6d's `"auto"` mode. Resolves preset by camera altitude vs the existing `volumetricEnableAltitude`/`volumetricDisableAltitude` thresholds (50 km / 100 km default): high quality below, medium in between, low above. Subsumes the original "separate 2D shader" design — at low preset the existing raymarcher's per-frame cost is comparable to the proposed 2D shader without a parallel render path.

Full design: [CELESTIAL_ATMOSPHERE_DESIGN.md §4.6 + §6 Phase 6](CELESTIAL_ATMOSPHERE_DESIGN.md). Default off (`atmosphericConditions.clouds.enableVolumetric = false`).

**Effort:** Originally estimated 3-5 sessions; revised down to 1-2 sessions (Phase 6c + 6d) given how much was already shipped.

#### NEW-ORBIT-AUTO-EXPOSURE-ACTIVATION — Future (optional, 1 session)

Activate `WebGPUAutoExposureCompute.ts` for the SDR orbit path. Pairs with the bloom altitude gate to tighten dynamic range at high altitude. Already shipping for HDR path; needs gate-by-altitude curve for SDR.

**Effort:** 1 session.

#### NEW-ORBIT-IBL-AMBIENT-NIGHT-FLOOR — Future (optional, 1-2 sessions)

Replace the flat `nightAmbient = 0.025` floor with IBL diffuse irradiance sampled at the surface normal. Uses the existing `WebGPUImageBasedLighting.ts` SH L2 probe. Gated on `atmosphericConditions.lighting.enableGroundIBLAmbient` (default off until visual review).

**Effort:** 1-2 sessions.

#### NEW-ORBIT-PER-LAYER-REFLECTIVE-BLOOM — Future (large, 2-3 sessions)

**Motivation:** Real camera bloom is light bleed proportional to per-surface RADIANCE, which varies sharply by material type:

| Surface | Reflectance | Bloom character |
|---|---|---|
| Ocean (specular) | low diffuse, high specular at glint angles | Bright tight glint, blooms even at orbit |
| Clouds | albedo 0.7-0.9 (high diffuse) | Soft wide bloom across cloud band |
| Snow / ice | albedo ~0.85 (high diffuse) | Strong bloom |
| Land terrain | albedo ~0.15-0.35 (mid diffuse) | Subtle bloom on sun-facing slopes only |
| Atmosphere haze (Rayleigh) | wavelength-dependent | Blue channel blooms more than red (dusk-sky read) |
| Vegetation | albedo ~0.10-0.20 (low diffuse) | Minimal bloom |

The current Batch-22 altitude-gated bloom is a uniform scene-wide multiplier. Per the user's "we want this to expand to impact different features and layers differently in the future" request, the proper implementation is per-fragment material-aware bloom contribution.

**Design sketch:**

1. **Add a "bloom contribution" output channel** to the model + globe fragment shaders, similar to the existing TAA velocity channel at `@location(1)`. Each material writes a single-channel f32 (or rgb if wavelength-dependent bloom matters) representing its bloom radiance contribution.
2. **Multi-channel bright-pass** — `BloomEffect.brightPass` samples both the scene color AND the bloom-contribution texture, weighting the bright-pass threshold by the contribution factor. Materials with high contribution lower the effective threshold; low-contribution materials raise it.
3. **Per-material contribution tables** — globe ocean shader writes high contribution at glint angles, lower elsewhere; cloud shader writes high contribution at cloud-cover pixels; terrain shader writes from albedo × NdotL × Lambertian-ish factor. Specular highlights write the full GGX-spec contribution.
4. **Atmosphere bloom** — `SkyAtmosphere.wgsl` writes per-wavelength bloom contribution proportional to Rayleigh inscatter magnitude, producing the subtle dusk-side blue haze bloom seen in ISS limb photography.
5. **Bloom kernel** — single fullscreen kernel weights both color magnitude AND contribution channel. Standard Gaussian blur on the weighted bright-pass output. Composite remains unchanged.

**Files affected:**

- `WebGPUBloomEffect.ts` — extend bright-pass to consume contribution texture
- `Shaders/WebGPU/PostProcess/BrightPass.wgsl` — multi-channel weighted threshold
- `Shaders/WebGPU/Globe/GlobeTerrain.wgsl::computeEnhancedOcean` + main FS — write `@location(2)` bloom contribution
- `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` — write atmosphere bloom contribution
- `Shaders/WebGPU/Primitive/PrimitivePBR*.wgsl` — write Model PBR bloom contribution
- `WebGPUSceneFramebuffer.ts` — allocate a bloom-contribution texture (single channel f32 or rgba8, similar to velocity texture)
- `WebGPUModelRenderer.js` — wire model FS to emit contribution

**Compatibility:**

- All existing FS shaders that don't write the new `@location(2)` get a default contribution of 1.0 (current uniform behavior) via missing-attachment fallback or a placeholder bright-pass path when the contribution texture is unallocated.
- `BloomConfig.enablePerLayerContribution` flag (default `false` initially) so the feature ships dormant until visual review on a wide demo sweep validates the per-material contribution tunings.

**Effort:** 2-3 sessions (1 session for the framebuffer + bright-pass plumbing; 1-2 sessions for per-material contribution authoring + Sandcastle visual verification across ocean / cloud / terrain / atmosphere demos).

**Related:** [NEW-ORBIT-BLOOM-ALTITUDE-GATE](#new-orbit-bloom-altitude-gate--open-immediate-1-2-hours) (uniform altitude gate — this entry's per-material multiplier layers on top of the altitude gate).

### NEW-VR-CZML-MODEL-ARTICULATIONS-INDEXCOUNT — Closed (2026-05-12, Session 65 Batch 7)

**Symptom:** `CZML Model Articulations.html` triggered `Index range (first: 0, count: 18, format: Uint16) does not fit in index buffer size (20)` during draw command encoding every frame, invalidating the command buffer. Model never rendered.

**Root cause:** The cesium_air glTF asset ships six per-control-surface hinge meshes with `UNSIGNED_BYTE` (componentType 5121) indices — small enough to fit in 8 bits. `ModelPrimitiveGeometry.extractPrimitiveGeometry` only special-cased `Uint32Array` and fell through to `"UNSIGNED_SHORT"` for both `Uint16Array` and `Uint8Array`. Downstream `WebGPUModelRenderer.ensurePrimitiveCache` sized the index buffer at `geometry.indexData.byteLength` (18 padded to 20) but then drew it with `indexFormat: "uint16"`, expecting 18 × 2 = 36 bytes. WebGL2's `drawElements` accepts `gl.UNSIGNED_BYTE` natively; WebGPU's `IndexFormat` enum has no `"uint8"` value, so byte indices must be upcast before they reach the GPU.

**Fix landed in Session 65 Batch 7 (2026-05-12):**

- In `ModelPrimitiveGeometry.js`, upcast `Uint8Array` indices to `Uint16Array` at extract time. `result.indexData.byteLength` then matches `indexCount * 2`, the cache sizes the buffer correctly, and the draw walks 36 bytes for 18 uint16 indices.

**Verification:** 257 `Index range … does not fit in index buffer size` warnings on the demo pre-fix; zero post-fix. Cesium Air model now renders with its body + hinge control surfaces visible.

**Files modified:** `packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js`.

**Follow-ups:**

- The CZML demo's textures appear partially loaded in the screenshot — likely a separate KHR_texture_basisu KTX2 lazy-load timing issue, not a renderer bug. Filed under runner-tuning concerns alongside the PBR follow-up from Batch 6.
- Worth a one-pass audit of the gallery for other byte-index glTF assets that may have been silently rendering with garbage on WebGPU pre-Batch 5 (the alignment crash masked the warning).

### NEW-WEBGPU-PBR-IBL-DARKNESS — Closed (2026-05-12, Session 65 Batch 6)

**Symptom:** `glTF PBR Extensions.html` and other PBR demos render models significantly darker on WebGPU than WebGL. Visible specifically on demos that rely on image-based lighting (the glTF PBR Extensions demo explicitly sets `scene.light.intensity = 0` and lights entirely via a KTX2 specular environment map + spherical-harmonic diffuse).

**Root cause:** `WebGLStubTexture.ts` ignored cube-face target enums. `bindTexture(TEXTURE_CUBE_MAP, …)` and the per-face uploads (`POSITIVE_X` 0x8515 … `NEGATIVE_Z` 0x851a) all routed through the 2D-texture path, so `ensureTextureAllocated` created a single-layer 2D texture with a 2D view. Every cube face overwrote `origin.z = 0`, leaving the texture in a state where the eventual `texture_cube<f32>` sample either fell back to the 1×1 50%-gray default or returned only the last-written face — both modes collapse specular IBL to near-zero.

**Fix landed in Session 65 Batch 6 (2026-05-12):**

- Added `_isCubeMap` latch + `cubeFaceLayerForTarget()` helper in `WebGLStubTexture.ts`.
- `ensureTextureAllocated` picks `depthOrArrayLayers: 6` + `dimension: "cube"` view when the wrapper is flagged as a cubemap.
- All four upload entry points (`texImage2D`, `texSubImage2D`, `compressedTexImage2D`, `compressedTexSubImage2D`) now route the face target through `cubeFaceLayerForTarget` and set `origin.z` to the resulting layer index.

**Verification:** Manual probe (`temp-pbr.mjs`, 30s settle) on `glTF PBR Extensions.html` shows the boombox/copper sphere correctly lit with specular highlights and an Earth backdrop. The cross-backend runner's default settle time is too short for the CDN KTX2 fetch on this demo — a separate runner-tuning item.

**Files modified:** `packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts`.

**Follow-ups:**

- Cross-backend runner needs a per-demo "ready for capture" hook for KTX2-loading scenes (filed as a runner-tuning task; not a renderer bug).
- The same patch folded in three companion fixes that exercise the same call paths (7-arg `texSubImage2D` form, mip-level extent clamping, level-0-only allocation guard). See `WEBGPU_DEBUGGING_LOG.md` Session 65 Batch 6 for details.

### NEW-WEBGPU-GLOBE-MATERIAL-SUPPORT — Partially shipped (2026-05-12, Session 65 Cluster 3)

**Status:** Steps 1, 2, 3a shipped. Steps 3b, 4, 5, 6 deferred to next session.

**What's shipped this session:**

- **Step 1 — Parallel WGSL fabric API.** `wgsl: { source, components }` added to fabric template vocabulary (`MaterialHelpers.js::templateProperties` + inner validation). `createWGSLMethodDefinition()` emits a WGSL `czm_getMaterial(materialInput: czm_MaterialInput) -> czm_Material` function from the fabric's `wgsl.source` or `wgsl.components`. Exposed on `material.wgslShaderSource`. Verified emitting valid WGSL via probe on Globe Materials demo.
- **Step 2 — WGSL declarations on 12 built-in fabrics.** `ColorType`, `ImageType`, `DiffuseMapType`, `AlphaMapType`, `SpecularMapType`, `EmissionMapType`, `ElevationContourType`, `ElevationRampType`, `SlopeRampMaterialType`, `AspectRampMaterialType`, `ElevationBandType`, `WaterMaskType` all carry `wgsl: { components | source }` alongside their existing GLSL. WGSL translation conventions: `texture(x, uv)` → `textureSample(x, xSampler, uv)`; uniforms referenced bare (pipeline cache resolves via material bind group at draw time); vec types pick up explicit `<f32>` suffix.
- **Step 3a — WGSL fabric API surface.** Added to GlobeTerrain.wgsl: `czm_MaterialInput` + `czm_Material` structs (mirror GLSL types), `czm_getDefaultMaterial(input)`, `czm_gammaCorrect` (vec3 + vec4 variants). Material WGSL emitted by Step 1 targets these types directly.

**Updated this session (Session 65 Batch 10) — additional foundation work:**

- **Step 3b — Material call site in fragment shader (shipped).** `GlobeTerrain.wgsl` FS now has the `//>>ifdef MATERIAL_APPLY` block: builds `czm_MaterialInput` from per-fragment values (st, normalEC, slope/height/aspect/positionToEyeEC) and calls `czm_getMaterial(matInput)`, alpha-blends result over imagery composite. Gated on MATERIAL_APPLY so non-material tiles skip the cost entirely.
- **Step 3c — Per-vertex slope/height/aspect (shipped).** VertexOutput @location(9/10/11) carry slope/aspect/height per-vertex. Computed in `processVertex` mirroring WebGL GlobeVS.glsl lines 272-285. Always emitted (no separate VS variant) — 3 floats/vertex cost.
- **Step 4a — Material bind group layout + pipeline layout variant (shipped).** `_bindGroupLayout4Material` at group 4 (1 UBO + 2 texture/sampler pairs). `_materialPipelineLayout` is the 5-group variant. `MATERIAL_APPLY = 1 << 14` registered in `ShaderDefine`.
- **Step 4b — WGSL prelude builder + UBO packer + body rewriter (shipped).** New file `WebGPUGlobeMaterial.ts` with:
  - `buildMaterialPrelude(material)` — infers per-uniform types, emits `MaterialUniforms` struct + `@group(4) @binding(0)` binding, computes WGSL-aligned UBO layout.
  - `rewriteMaterialBody(body, layout, textureNames)` — regex-rewrites bare uniform names → `materialUniforms.<name>`, leaves texture-uniform names bare so they pick up module-scope bindings.
  - `packMaterialUBO(material, layout, size)` — packs JS uniform values (Color, Cartesian2/3/4, scalar, boolean) into a `Uint8Array` matching the WGSL layout.

**What's remaining — RESOLVED (doc-synced Batch 172):**

Steps 5 and 6 are no longer deferred — the draw-path wiring shipped. Confirmed
in current source by the triage workflow's adversarial verify pass + an
independent grep:

- **Step 5 — Wire into draw path (SHIPPED).** `WebGPUGlobeSurfaceRenderer.ts`
  imports and calls `buildMaterialPrelude` (`:45`/`:317`) and `packMaterialUBO`
  (`:47`/`:400`); `rewriteMaterialBody` is applied to the material body; the
  `MATERIAL_APPLY` define drives the `_materialPipelineLayout` 5-group variant
  and the group-4 material bind group. `GlobeTerrain.wgsl` FS calls
  `czm_getMaterial` under the `//>>ifdef MATERIAL_APPLY` block.
- **Step 6 — Verify.** Globe-material demos render with their custom material
  applied (the material call site + per-vertex slope/height/aspect + UBO pack
  are all live). A dedicated cross-backend probe for the full 12-fabric matrix
  would still be worthwhile as a regression guard but is not a blocker — the
  feature is functionally shipped.

NOTE (Batch 172): there are uncommitted root `Source/Shaders/WebGPU/Primitive/
*.wgsl` build-output edits in the working tree — these are build-output
regeneration of the already-shipped **primitive** material shaders (a separate
shader family from globe materials), NOT in-progress edits to this feature.
Confirmed by diffing root build-output vs canonical `packages/engine/Source`.

**Symptom (still present, will be resolved by Steps 3b-6):** Demos that set `globe.material = new Cesium.Material({ fabric: {...} })` show the default Bing imagery on WebGPU instead of the user-defined material overlay. Affects ~5 demos: `Globe Materials.html`, `Bathymetry.html`, `Elevation Band Material.html`, `Globe Materials – Water Mask Elevation Map.html`, `Globe Materials – 3D Tiles Terrain.html`.

**Root cause:** The Globe WGSL fragment shader (`GlobeTerrain.wgsl`) has no hook for executing a user-supplied material. WebGL's `GlobeFS.glsl` reads `material.shaderSource` (built by `MaterialHelpers.createMethodDefinition` from the fabric definition) and concatenates it with the base FS, gated on the `APPLY_MATERIAL` define. The WGSL pipeline has none of this — there's no parallel fabric assembler, no `getMaterial` hook, and no per-tile material bind group.

**Decision (user-confirmed during session 65):** Implement **Option B — Parallel WGSL fabric API**. Adds a `wgsl: { source, components }` field to the fabric vocabulary; user-authored materials supply both GLSL and WGSL, while built-ins ship pre-ported WGSL via the existing `Source/Shaders/WebGPU/Primitive/PrimitiveMat*.wgsl` files. Rejected: GLSL→WGSL transpiler (heavy WASM runtime, error-message debt), built-ins-only (breaks user-custom on WebGPU). See `WEBGPU_DEBUGGING_LOG.md` Session 65 Cluster 3 architectural notes.

**Existing coverage:** The 19 `Source/Shaders/WebGPU/Primitive/PrimitiveMat*.wgsl` files (×2 Lit/Flat variants = 38 shaders) already cover every built-in fabric type for PRIMITIVE consumption (Box/Sphere/etc + PolylineCollection). What's missing is GLOBE consumption — the Globe FS has no equivalent to WebGL's `czm_getMaterial` call.

**Implementation plan (multi-session, ~3-5 days):**

1. **Fabric API extension** — extend `Material.js` and `MaterialHelpers.js` to accept `wgsl: { source, components }` in fabric definitions. Build `createWGSLMethodDefinition(material)` parallel to `createMethodDefinition`. Expose `material.wgslShaderSource`. Estimated effort: 1 day.

2. **Built-in fabric WGSL components** — add `wgsl: { components: { diffuse: "...", alpha: "...", ... } }` to each of the ~20 built-in fabric registrations in `Material.js`. Translate each GLSL component expression to WGSL syntax (mostly mechanical: `texture(x, y)` → `textureSample(x, sampler, y)`, `mix` is unchanged, `materialInput.st` → `input.st` etc). Estimated effort: 1 day.

3. **Globe WGSL `getMaterial` hook** — extend `GlobeTerrain.wgsl` to declare `MaterialInput` + `Material` structs and call `getMaterial(materialInput)` after the imagery composite. The function body is injected by the JS assembler at pipeline-creation time. Estimated effort: 0.5 day.

4. **Material bind group + pipeline cache** — add a per-material WGPU bind group (texture / sampler / color uniform UBO) + pipeline cache keyed on material hash so each unique material gets its own pipeline. The cache hash should include the fabric type and any compositional sub-materials. Estimated effort: 1 day.

5. **CPU plumbing** — extend Globe's per-frame update path to mirror `globe.material` onto tileProvider (already present for WebGL) AND through to the WebGPU GlobeSurfaceRenderer. The WebGPU side picks up the material hash, builds or reuses the pipeline, and binds the material UBO. Estimated effort: 0.5 day.

6. **Error path for user-custom-without-WGSL** — when a user-authored fabric has no `wgsl` field, emit a clear runtime error pointing at the migration path. Estimated effort: 0.1 day.

7. **Verification** — re-test the affected demos. Estimated effort: 0.5 day.

**Total estimated effort:** 4-5 days of focused work.

**Files to modify (anticipated):**

- `packages/engine/Source/Scene/Material.js` — fabric API + built-in registrations
- `packages/engine/Source/Scene/MaterialHelpers.js` — `createWGSLMethodDefinition` assembler
- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `MaterialInput` struct + `getMaterial` hook
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — material bind group + pipeline cache key
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts` — bind group layout for material UBO + textures
- `packages/engine/Source/Scene/Globe.js` — push `globe.material` through to WebGPU tile provider

**Architecture refresher:** WebGL fabric → GLSL `czm_getMaterial` is built by `createMethodDefinition` (MaterialHelpers.js:151). WebGPU equivalent should mirror this structure but emit WGSL. Each fabric's `wgsl: { components }` declarations get composed into a WGSL function:

```wgsl
fn getMaterial(input: MaterialInput) -> Material {
  var m: Material = getDefaultMaterial(input);
  m.diffuse = czm_gammaCorrect(<wgsl.components.diffuse>);
  m.alpha = <wgsl.components.alpha>;
  return m;
}
```

The output of the assembler is appended to the GlobeTerrain.wgsl source before pipeline creation.

---

## NEW-GBUFFER-MRT-INTEGRATION — Always-on G-buffer + MRT (Slice 5c-B follow-ups) — PRODUCER side largely SHIPPED; consumer integration is the residual

**Status (doc-synced Batch 175, after the triage workflow + a slot-1-emitter grep):** The original "slot 1 currently stays at sentinel `(0,0,0,1)` because no fragment shader emits `@location(1)` yet" claim is STALE — **176 WGSL shaders now emit `@location(1)` normalRoughness**: the globe (`GlobeTerrain.wgsl` `makeFragOutput`), Model PBR (`ModelPBRComplete.wgsl` `FragOutput`, every return path — verified clean in the Batch 143 NEW-GLTF-PIPELINE-SHAPE-AUDIT Item 3), the full Primitive Lit-material family (`PrimitiveMat*Lit.wgsl`, `PhongLighting.wgsl`, `PBRMetallicRoughness.wgsl`), classification (`ShadowVolumeAppearance.wgsl`), and `FlexibleGeometry.wgsl`. So the **producer side is broadly shipped** — the G-buffer slot 1 carries real per-fragment normals + roughness across the major draw paths, not a sentinel.

**Residual (the part that's genuinely open):** the *consumer* integration. AO already consumes `normalRoughnessTexture`. The remaining downstream consumers (clustered/Forward+ lighting, SSR, contact shadows, NPR, TAA normal-disocclusion) are the open follow-ups below — the clustered-lighting consumer in particular is gated on the `maxBindGroups = 4` platform ceiling (it needs another bind group the Model/globe layouts already fully use), which is the real architectural blocker, NOT the producer emit. Also note the legacy compute producer `GBufferNormalsFromDepth.wgsl` / `dispatchGBufferNormalsFromDepth` is now largely redundant given the render-pass emit, but is LEFT IN PLACE (Principle 7 — it's the fallback for draw paths that don't emit slot 1, e.g. depth-only / sentinel-normal debug returns; retiring it needs a per-path audit, tracked as a follow-up, not done here).

**Architecture refresher:**

- `GBufferFramebuffer.js` allocates paired single-sample + MSAA textures (`rgba16float`, packed `(normalEC.xyz, roughness)`). MSAA companion auto-resolves into the single-sample texture at end-of-pass.
- The single-sample texture has `STORAGE_BINDING | TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT` usage — it serves as the storage-bindable target for the legacy compute producer (`GBufferNormalsFromDepth.wgsl`) AND as the resolve target for the MRT render-pass writes (when shaders emit `@location(1)`).
- The MSAA companion (`RENDER_ATTACHMENT` only, since multisampled textures cannot have `STORAGE_BINDING`) is the actual render-pass attachment when `scene.msaaSamples > 1`.
- `WebGPUSceneRendererPassRedirect.ts` appends the MRT slot-1 attachment when `isSceneFBMrtMode()` returns true (currently always true post-Batch-116).
- Consumers (AO is the only one today) read `gBufferFramebuffer.normalRoughnessTexture` — the single-sample resolved view.

### Producer-side follow-ups (Batches 117+)

#### NEW-GBUFFER-MRT-GLOBE-EMIT — Globe shader emits @location(1)

Wire `GlobeTerrain.wgsl` to emit `(normalEC.xyz, roughness)` at `@location(1)` and flip the globe pipeline slot 1 from `null` → `{format: "rgba16float", writeMask: 0xf}`. This is the natural next batch.

**Scope:**

- `GlobeTerrain.wgsl` has 4 fragment entry points (`fragmentMain` + 3 debug variants). Each one ends with `return color;` (or similar). They all need to become `return FragOutput(color, normalRoughness)` where `FragOutput` is a new struct with both locations.
- Globe `normalEC` is already computed inside `fragmentMain` for lighting; the debug variants don't compute one but can emit `(0,0,0,1)` sentinel.
- Globe roughness today is a hardcoded value via the IBL path. For the G-buffer pack, use a constant `0.5` placeholder; refine in a follow-up when material-aware roughness lands.
- Pipeline change: 1-line flip in `WebGPUGlobeSurfacePipelines.ts:buildPipelineDescriptor` — slot 1 goes from `null` to the rgba16float-writeMask-0xf shape. The bisect in Batch 116 already verified that this slot shape works as long as the shader emits the matching location.
- Verification: `probe-mrt-validation.mjs` to confirm zero pipeline-cache errors after the flip. Then a normal-overlay probe to confirm slot 1 has real data instead of the sentinel clear.

**Effort:** 1 batch (~half-day). Risk: shader return-rewrap mismatch (the patcher mistake from the failed Sub-C dry-run). Mitigation: edit each return path by hand, no automated patcher.

#### NEW-GBUFFER-MRT-PRIMITIVE-EMIT — Lit Mat primitives emit @location(1)

Same conversion as the globe but for each of the ~30 primitive renderers that produce per-fragment material normals (Lit Box/Sphere/Polygon/Wall/Corridor/Frustum + glTF Models with normal maps + 3D Tiles B3DM/I3DM/PNTS lit variants). Their pipelines already declare slot 1 as a placeholder (writeMask=0) via Phase 1's `makeSceneFBTargets` helper; bumping to a real write target needs:

- A `FragOutput` struct in each shader (or a shared helper module).
- Per-renderer pipeline target flip via `emitsGBuffer: true` option.
- The G-buffer normal should be the FINAL material normal (post-normal-map, post-anisotropy), not the geometric `v_normalEC`. This is the entire point of Slice 5c-B over the compute-from-depth producer.

**Status:** Partially shipped.

- ✅ **EllipsoidPrimitive** — Batch 118. Analytical ray-traced eye-space normal at slot 1.
- ✅ **glTF Models** (`Model.js` via `WebGPUModelPipelineCache`) — Batch 119. Post-normal-map N + real material roughness. Three return paths covered: main-lit (real N + roughness), unlit early-out (geometric normal + 0.5 placeholder), clipping edge band (geometric normal + 0.5 placeholder).
- ✅ **3D Tiles B3DM / I3DM / TILE_GLTF** — same as glTF Models. They share the `Model.js` → `WebGPUModelPipelineCache` pipeline; Batch 119's conversion automatically covers them. Verified via `Model.js:3516` (`ModelType.TILE_B3DM`) → same `createColorPipeline` call site.
- ⬜ **Lit Mat geometry primitives** (Box, Sphere, Polygon, Wall, Corridor, Frustum, etc.) — not yet converted. These go through `WebGPUPrimitiveCommands.js` and the `PrimitiveMatLit*.wgsl` family. The Lit Mat shaders compute a per-fragment normal in eye-space already (the lighting eval needs it); conversion is the same pattern as Model (FragOutput struct + rewrap returns + `emitsGBuffer: true`).
- ⬜ **3D Tiles PNTS lit variants** — points don't have surface normals in a meaningful per-fragment sense; SHOULD stay at writeMask=0 placeholder.

**Effort:** ~1 day per Lit Mat cluster (Box/Sphere/etc. typically share a shader family).

**Risk:** per-shader normal-extraction details (some shaders compute `czm_inverseViewRotation * worldNormal` late; others have eye-space normals already). Audit each before converting.

#### NEW-GBUFFER-MRT-COMPUTE-PRODUCER-RETIRE — Decision: keep or retire `GBufferNormalsFromDepth.wgsl`?

The legacy compute producer derives normals from depth via central differences. Now that MRT writes are wired:

- For pixels touched by an MRT-emitting pipeline, the MRT write wins (overwrites the compute output if both fire).
- For pixels touched ONLY by 1-target pipelines (sky, debug overlays, OIT accumulation that doesn't write through), the slot-1 attachment stays at the sentinel `(0,0,0,1)`.
- Today the compute producer runs every frame and writes EVERY pixel (with sentinel for sky/discontinuities). After Slice 5c-B Phase 2 is complete, it's redundant for the pixels covered by MRT-emitting shaders.

Two options:

1. **Retire the compute producer entirely.** Cleaner but requires every primitive that needs G-buffer normals to emit @location(1). Sky/non-emitting primitives leave the sentinel value, consumers handle via the fallback path (AO already does this — `lenSq > 0.01` check before using the G-buffer normal).
2. **Keep the compute producer as a fallback that runs BEFORE the MRT render pass.** It populates the sentinel pixels with depth-derived normals; the MRT pass then overwrites them. Doubles per-frame work for the overlap region but simplifies consumer logic (always sees a real-ish normal everywhere).

Punt this decision until at least 50% of primitives are emitting @location(1) — until then, option 1 leaves too many pixels at the sentinel and option 2 is the only viable path.

### Consumer-side follow-ups

The G-buffer is now always allocated (Sub-B, Batch 115b) so any consumer can read `gBufferFramebuffer.normalRoughnessTexture` without checking the deferred-lighting flag. Today only AO uses it. Candidates that should:

#### NEW-GBUFFER-CONSUMER-SSR — Screen-space reflections

SSR's primary input is per-pixel normal + roughness. `WebGPUSSREffect.ts` currently builds its own per-pixel normal via depth derivatives (same approximation AO used to use). Switch it to read the G-buffer normal-roughness texture and pull roughness from `.w` instead of hardcoding.

**Effort:** ~2 hours. Risk: SSR runs in the post-process pipeline, after the scene FB pass — the G-buffer texture is already in its resolved (single-sample) state at that point, so the bind is straightforward.

#### NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING — Forward-clustered light pass

Forward-clustered lighting (currently a research-stage SCAFFOLDED feature) needs per-pixel normal for the diffuse + specular evaluation. With the G-buffer always available, the clustered pass can read it instead of re-deriving from depth (which would dramatically improve quality at silhouettes).

**Effort:** Multi-day, depends on Slice 5d (clustered lighting Phase 1) landing first.

**Sub-batch plan:** See [SLICE_5D_PLAN_CLUSTERED_LIGHTING.md](SLICE_5D_PLAN_CLUSTERED_LIGHTING.md) (Batch 137, 2026-05-25) for the 5-sub-batch sequence: KHR_lights_punctual loader → LightCollection → cluster bounds compute → light-cluster assignment compute → Forward+ fragment consumer. Effort estimate 6-8 days total.

**Status update (2026-05-26):** Steps 1-4 SHIPPED (Batches 134-148). Step 5 SCAFFOLDED across Batches 149-151 (FS chunk + dispatcher + SceneRenderer per-frame hook). Batch 152 attempted to wire the Model PBR consumer via a new `@group(4)` BGL but hit a platform ceiling — `Tools/visual-regression/probe-device-limits.mjs` confirmed Chromium-on-Windows caps `maxBindGroups` at 4 (both D3D12 + Vulkan backends), so the @group(4) approach is dead-on-arrival. Reverted cleanly to infrastructure-only; Batch 153 will merge the 5 clustered-lighting bindings into the existing group 3 (effects) BGL. See the Batch 152/153 entries in the slice plan for full scope + verification steps.

**Reference implementation:** [toji/webgpu-clustered-shading](https://github.com/toji/webgpu-clustered-shading) — Brandon Jones's (Google WebGPU lead) canonical Forward+ on WebGPU example. Directly portable pieces:

- **Cluster bounds compute shader** — assigns each cluster (typically 16×9×24 grid in view-space) an AABB. Runs once per resize, cached in a storage buffer keyed by `(viewport, frustum near/far, projection)`. Cesium-side hook: invalidate the cache when `WebGPUSceneRendererEnsureResources` bumps `_scenePipelineFormatGeneration` or when scene FB dimensions change.
- **Light-cluster assignment compute shader** — per-frame dispatch, one thread per cluster, walks the active-light list (KHR_lights_punctual when that lands) and emits two storage buffers: a per-cluster count + the global indirection list. Cesium-side hook: light list comes from `frameState.lights` (currently sun-only; KHR_lights_punctual would populate the array).
- **Forward+ fragment evaluation** — fragment reads its own cluster index from `gl_FragCoord.xy` + linear depth, then iterates that cluster's lights. With G-buffer normal already in slot 1, the fragment can use `textureLoad(gBufferNormalTexture, ...)` instead of re-deriving — exactly the integration this entry tracks.

**What to NOT directly port from the reference:**

- The example uses a single-world-space scene with a fixed camera; Cesium needs RTE precision so cluster-bounds compute must consume eye-space inputs (or RTE-encoded world space). The `encodedCameraHigh`/`encodedCameraLow` pattern in `CameraUniforms` is the bridge.
- The example's light culling is per-frame regardless of camera motion; Cesium's `RenderScheduler` already has per-frame dirty tracking that should gate the assignment dispatch when the camera + light positions haven't changed.
- Toji uses a hand-rolled glTF loader; Cesium has its own (`Model.js`) — the light extraction needs to plug into Cesium's KHR_lights_punctual loader (which itself needs to be built).

Both pieces (KHR_lights_punctual loader + this consumer) should land in the same Slice 5d arc — there's no point shipping clustered shading with no lights to cluster.

#### NEW-GBUFFER-CONSUMER-CONTACT-SHADOWS — Screen-space contact shadows

Sun-direction marching from a starting position + normal, sampled against the depth buffer. The starting normal comes from the G-buffer; the depth comes from the existing depth attachment. No new producer needed.

**Effort:** ~1 day for a basic implementation (no PCF, no soft contact). Quality improvement on close-range geometry (foliage occlusion, ground-truth ambient occlusion for grounded objects) is significant.

#### NEW-GBUFFER-CONSUMER-NPR-OUTLINES — Normal-discontinuity edges

Reads the G-buffer + depth to detect edges where adjacent pixels have divergent normals (silhouettes, hard creases) and draws an outline. Cheap post-process pass; no new bind groups beyond what the depth + G-buffer textures already provide. Useful for technical / engineering / CAD-style globe presentations.

**Effort:** ~half-day. Risk: visual taste — strong outlines clash with the photorealistic terrain default; needs an opt-in property on `scene`.

#### NEW-GBUFFER-CONSUMER-TAA-DISOCCLUSION — TAA history reproject

TAA's disocclusion mask is currently velocity-based. Adding G-buffer normal comparison (reject history pixels whose normal differs from the current frame's by more than a threshold) reduces ghosting at moving silhouettes. Small quality improvement, not a blocker.

**Effort:** ~half-day in `WebGPUTAAEffect.ts`. Risk: tuning the normal-divergence threshold — too tight and you lose history at every frame; too loose and ghosting persists.

### Cross-cutting concerns

- **Pipeline cache invalidation:** when `setSceneFBMrtMode(false)` is called (no current trigger, but possible if a future "low-memory mode" wants to drop the G-buffer), all cached pipelines must be invalidated — they were built with 2-target descriptors and would no longer match the 1-attachment pass. `WebGPURenderPipelineCache.clear()` exists; the gate just needs to fire.
- **Format negotiation:** `MRT_NORMAL_ROUGHNESS_FORMAT` is currently hardcoded to `rgba16float`. If a future device-tier check decides `rg16float` is enough (encode normal as oct-encoded `vec2`, drop roughness or pack into compute uniforms), update the format in `WebGPUSceneFBTargetHelpers.ts` AND match it in every emitter shader.
- **MSAA + storage interaction:** `_textureMSAA` (the render attachment) and `_texture` (the resolve target with `STORAGE_BINDING`) are different textures. Anything that writes to the G-buffer through the storage path (the compute producer today) writes to `_texture` directly; anything that reads as a sampler reads `_texture` too. The MSAA half is only the render-pass attachment. This is fine but worth remembering when adding new producers.

### Probe for this work

`probe-mrt-validation.mjs` (Batch 116) covers the four-cell AO×deferred matrix with WebGPU error capture (`device.onuncapturederror` + `device.lost` + categorized `console.error`). Re-run after every MRT change to confirm no new pipeline-cache errors. For each Producer-side conversion, also add a `probe-gbuffer-slot1-content.mjs` follow-up that samples the G-buffer texture and confirms slot 1 has non-sentinel values where the converted primitive draws.

---

## ~~NEW-ENV-EFFECTS-DEPTH-WIRING~~ — RESOLVED (Batches 127-129) — `context._depthStencilView` now assigned

**Status (doc-synced Batch 172, confirmed by triage workflow + grep):** RESOLVED.
The root cause was `context._depthStencilView` never being assigned, so every
environmental effect early-returned. It is now assigned in
`WebGPUSceneRendererEnsureResources.ts:221` (`_ctxWithDepth._depthStencilView = …`,
including the MSAA-resolve path), so `executeEnvironmentalEffects` no longer
skips on a null depth view. NOTE: a consumer can still be visually inert for
OTHER reasons (an effect's own feature flag off, or a downstream G-buffer
producer not wired — see NEW-GBUFFER-MRT-INTEGRATION) — but the specific
"depth view never assigned" blocker this entry tracked is gone. The original
body below is retained for archaeology.

**Original status:** Open. Surfaced during Batch 125 NPR-visibility investigation (2026-05-25).

**Affected features:** `WebGPUSceneRendererEnvironmentalEffects.executeEnvironmentalEffects` and every effect it dispatches:

- Procedural Clouds (`globe.showProceduralClouds`)
- Screen-Space Reflections (`scene._enableSSR`)
- Weather Particles (`scene._enableWeather`)
- Volumetric Fog (`frameState.atmosphericConditions.volumetricFog.enabled`)
- NPR Outlines (`scene._enableNPROutlines`, Batch 123)

**Symptom:** None of these effects produce visible output in any test scene. All silently skip.

**Root cause:** `WebGPUSceneRendererEnvironmentalEffects.ts:55-62` has:

```ts
const colorView = context._sceneColorView ?? context.currentTextureView;
const depthView = context._depthStencilView;
const outputView = context.currentTextureView;
if (!colorView || !depthView || !outputView) {
  return;
}
```

`context._depthStencilView` is declared on `WebGPUContext.ts:387` as `public _depthStencilView: GPUTextureView | null = null;` and is **never reassigned anywhere in the renderer** (verified via repo-wide grep on 2026-05-25). The only assignments to a similarly-named field are on `WebGPUEdgeFramebuffer._depthStencilView` (different class).

So `depthView` is always undefined → early return → the entire env-effects chain has been a no-op since this gate was added (commit history pending).

**False-positive in Batch 122 SSR verification:** the Batch 122 commit message claimed "B vs C = 0.000% — SSR reads same G-buffer regardless of deferredLighting flag." But SSR was never actually running — both B and C cells just rendered the baseline scene without SSR contribution. The 0% diff was trivially true (same no-op output) and didn't verify the G-buffer wiring.

**Secondary problem:** even if `_depthStencilView` is wired, the env effects currently write to `outputView = context.currentTextureView` (canvas swap chain). After they run, `_runPostProcessing` blits the scene FB color to the canvas, overwriting any env-effect output. So fixing the depth wiring alone isn't enough — the target chain also needs to be reordered or the env effects need to write back to scene FB color.

**Tertiary problem:** scene FB depth is MSAA when `scene.msaaSamples > 1` (default 4), and `_sceneFramebuffer.depthSampleableView` is null in that case (per L1953 comment in `WebGPUSceneRenderer.ts`). So even wiring `_depthStencilView = _sceneFramebuffer.depthSampleableView` doesn't help MSAA scenes. Env effects need either a multisampled-depth path (`texture_depth_multisampled_2d` + `textureLoad(.., 0)`) or a resolve step.

**Multi-batch fix outline:**

1. **Wire `context._depthStencilView` to the scene FB depth view.** Single-sample case: `_sceneFramebuffer.depthSampleableView`. MSAA case: either resolve depth to a single-sample texture each frame OR teach every env-effect shader the multisampled-depth path. Easier: resolve (one extra render pass per frame, fixed cost).
2. **Reorder env effects to AFTER post-process** so their canvas writes survive. Attempted in Batch 125 but the depth issue masked the result (env effects still skipped due to null depthView).
3. **OR: re-route env effects to write back to scene FB color** via a ping-pong intermediate buffer. Preserves the linear-HDR pipeline through tonemap/FXAA. Heavier — needs a new intermediate scene-color texture.

**Verification when fixed:** `probe-npr-outlines.mjs` with `nprNormalThreshold=-1` should produce a SOLID MAGENTA canvas over geometry (current behavior: terrain renders unchanged, NPR is invisible). `probe-ssr-consumer.mjs` should show A-vs-B (SSR off vs on) >> noise floor on a scene with reflective surfaces.

**Effort:** 1-2 days. Risk: high — touches the post-process + env-effects ordering that hasn't been fully exercised since the bug landed.

---

## ~~NEW-GLTF-PIPELINE-SHAPE-AUDIT~~ — RESOLVED (Batches 143 + 144 + 145) — Model PBR pipeline-side audit

**Status (doc-synced Batch 172):** All 6 audit items resolved — heading struck. The body had a self-contradictory stale "Items 4 + 5 still open" line (corrected below); the authoritative state is the Batch 143/144/145 resolution summarized here. All 6 items VERIFIED CLEAN / FIXED.

- Items 1 / 2 / 3 / 6 VERIFIED CLEAN in Batch 143 (2026-05-26).
- Item 5 (CesiumMan startup race) FIXED in Batch 144 (`WebGLStubTexture.generateMipmap` was reusing the shared command encoder while the canvas pass was open). Probe-cesium-man-race.mjs localized the race via stack-trace capture; all 5 sample models now render with 0 device errors.
- Item 4 (KHR extension factor probes) VERIFIED CLEAN in Batch 145 (2026-05-26). 7 synthetic test assets (clearcoat / specular / anisotropy / iridescence / sheen / volume+transmission / transmission+ior) all load + render with 0 device errors, and the JS pack offsets match the WGSL struct field offsets verified at runtime via `model._webgpuCache.primitives[].materialData` introspection. The KHR FS code paths (Batches 105-107) work end-to-end on WebGPU as of this verification.

Velocity-pipeline MSAA mismatch (Item 1) fixed opportunistically in Batch 143 as a dormant-bug cleanup — Model doesn't emit velocity commands yet so it was inert, but the pipeline-shape mismatch is gone.

**Batch 143 audit findings (Model PBR pipeline shape):**

- ✅ Item 1 (MSAA): `createPipeline` (color), `createClassificationPipeline` correctly thread `sampleCount` from `context._msaaSamples` into `multisample: { count }`. Pick pipelines correctly omit `multisample` (pick FBO is single-sample). One dormant mismatch found in `createVelocityPipeline` (multisample=sampleCount while velocityTexture is sampleCount=1) and fixed in Batch 143 to align with collection renderers' velocity-pipeline pattern from Batch 134. Currently inert — Model primitives don't tag `.velocityCommand` so the velocity pass short-circuits (verified by `probe-model-taa-msaa.mjs` reporting 0/79 velocity commands on a TAA+MSAA+animated-model scene).
- ✅ Item 2 (BGL visibility): all Model BGLs audited. Camera UBO `VERTEX_FRAGMENT` (correct — VS reads MVP, FS reads camera position). Material UBO at group 1 binding 0 also `VERTEX_FRAGMENT` (correct — VS reads modelMatrix, FS reads PBR factors). All instance-group bindings (joint matrices, morph deltas, instance transforms) correctly `VERTEX`-only. All texture + sampler bindings correctly `FRAGMENT`-only. LightUniforms `FRAGMENT`-only (correct — no VS uses light data). No mis-declarations found.
- ✅ Item 3 (MRT slot 1): the lit color pipeline uses `makeSceneFBTargets(..., { emitsGBuffer: true })` which produces `[scene, {rgba16float, writeMask: 0xf}]`. ModelPBRComplete's FragOutput emits `@location(1) normalRoughness` from every path (lit PBR with perturbed normal at L2706, unlit early-out with geomNormalEC at L1952, clipping-edge early-out with geomNormalEC at L1859) so the shader emit matches the descriptor. Classification correctly drops `emitsGBuffer` and uses placeholder slot 1 with writeMask=0.
- ✅ Item 6 (Pick FBO parity): 4 pick descriptor variants (`createPickPipeline`, `createPickHoverPipeline`, `createPickPrecisePass1Pipeline`, `createPickPrecisePass2Pipeline`) all correctly use single-target `[{format: presentationFormat}]` with NO `multisample` block, matching the single-sample pick FBO. The depth pre-pass variant uses `writeMask: 0` to suppress color while keeping depth/stencil writes.

**Status (CORRECTED Batch 172):** ~~Items 4 + 5 still open~~ — STALE; both are resolved (Item 4 Batch 145, Item 5 Batch 144 — see the resolution summary at the top of this entry). Original status text below for reference only.

Surfaced at the end of Batch 141 (2026-05-26) when the Model PBR audit completed the data-side review and called out the pipeline-side as not yet covered.

**What's already done (Batches 138-141):** Data-side of the Model PBR pipeline is byte-correct across MaterialUniforms (768 B / 192 floats), CameraUniforms, LightUniforms + per-light PunctualLight records, MorphWeightsUniforms, SHUniforms. One real bug fixed in FeatureIdUniforms (featurePickEnabled was at wrong slot, silent per-feature pick failure on batch-tabled tilesets).

**What's NOT covered:**

1. **MSAA sample-count parity across pipeline variants.** Bug Pattern A from Batch 134 (collection renderers' missing `multisample: { count }`) was found in 6 collection-renderer files. The Model PBR pipeline cache (`WebGPUModelPipelineCache.js`) builds ~20+ variants based on MODEL_HAS_* defines (FLAG_HAS_NORMAL_TEXTURE, FLAG_USE_SPECULAR_GLOSSINESS, FLAG_HAS_CLEARCOAT, FLAG_HAS_TRANSMISSION, FLAG_HAS_INSTANCING, FLAG_HAS_SKINNING, FLAG_HAS_MORPH_TARGETS, FLAG_HAS_FEATURE_ID_TEXTURE, FLAG_HAS_FEATURE_ID_ATTRIBUTE, FLAG_HAS_BATCH_TABLE, FLAG_HAS_VERTEX_COLORS, FLAG_IS_DOUBLE_SIDED, FLAG_IS_UNLIT, FLAG_ALPHA_MODE_MASK, FLAG_ALPHA_MODE_BLEND, FLAG_HAS_SPECULAR, FLAG_HAS_ANISOTROPY, FLAG_HAS_IRIDESCENCE, FLAG_HAS_SHEEN, FLAG_HAS_VOLUME). Each variant goes through its own descriptor build — verify all of them pass `multisample: sampleCount > 1 ? { count: sampleCount } : undefined` consistently. Pick + velocity variants need to be checked too (Batch 134 found Ellipsoid pick had inherited multisample state incorrectly, separate from color).

2. **BGL visibility parity (Bug Pattern B from Batch 134).** Look for bind group layout entries declared `visibility: GPUShaderStage.FRAGMENT` only where the corresponding `@group(X) @binding(Y)` is also consumed by the vertex shader. The Model pipeline has 7 bind groups (camera, material, skinning, morph, instancing, feature-id, effects) and most have entries read by BOTH stages — easy place for FRAGMENT-only mis-declarations to hide.

3. **MRT slot 1 G-buffer target.** Per Batches 119-121 the Model pipelines should be emitting `@location(1) normalRoughness` for the always-on G-buffer. Verify every MODEL_HAS_* variant's pipeline descriptor includes `targets[1]` with the right format (`rgba16float`) and write mask (`0xf` since Model emits the perturbed normal). The pick variant should have `writeMask: 0` for slot 1 since pick doesn't emit G-buffer. Recently Batch 132 found MaterialAppearance had a separate pipeline path that missed multisample — same risk class.

4. **KHR extension factor paths in the FS.** The Batch 141 probe (`probe-model-pbr-audit.mjs`) loaded 5 generic glTF assets but none of them carry KHR_materials_clearcoat / specular / anisotropy / iridescence / sheen / volume / transmission extensions. The shader has gates on `materialFlags` for each — those code paths haven't been exercised end-to-end on WebGPU since their introduction (Batches 105-107). Need an explicit probe per extension with a representative test asset (Khronos has reference assets for each KHR_materials_* extension at github.com/KhronosGroup/glTF-Sample-Assets).

5. **CesiumMan startup race.** Probe-model-pbr-audit.mjs surfaced 2 device errors loading CesiumMan ("Recording in CommandEncoder which is locked while RenderPassEncoder is open") during a tile/model concurrent-load race. Not reproducible with a simpler 600-frame steady-state probe in `probe-cesium-man-debug.mjs`. Could be:
   - Skinning matrix upload happening via `encoder.copyBufferToBuffer` while scene pass is open (would explain the timing)
   - Tile loader's `copyTextureToTexture` racing with the model's first frame
   - A loader async-init that registers a per-frame callback before the renderer is fully set up

   The probe needs to add finer-grained instrumentation (callstack capture on `onuncapturederror`, or a wrap of `encoder.*` methods to log who's calling while a pass is open) to localize the source.

6. **Pick FBO descriptor parity.** Pick pipelines target the pick FBO (single-sample, single-target). Verify Model pick pipelines correctly drop `multisample` and `targets[1]` from their descriptors. Batch 118 found Ellipsoid's pick descriptor inherited multisample state from the parent color descriptor — Model's pick path uses a separate descriptor builder so it could have its own version of the same bug.

**Probes to add:**

- `probe-model-pipeline-variants.mjs` — exhaustively enumerate Model pipeline variants (Cartesian product of MODEL_HAS_* defines truncated to common combinations) and assert each pipeline creates without errors. Include MSAA on/off matrix.
- `probe-model-khr-clearcoat.mjs` — load Khronos's `ClearCoatTest.glb` (or similar reference asset) and verify the FS clearcoat code path produces a visible specular sheen.
- `probe-model-khr-*` — similar per-extension probes.

**Effort:** Multi-batch arc. Step 1 (MSAA + BGL audit) is ~half a day per variant family. Step 4 (KHR ext probes) is ~half a day per extension if a test asset is on hand.

**When to do this:** When clustered lighting (Slice 5d) lands or stalls, OR if a user reports broken rendering for a KHR_materials_* asset. Until then the existing audit (data-side correctness + 5-asset smoke) covers the most common shipping scenarios.

---

## NEW-VEGETATION-SYSTEM — Planetary vegetation epic (trees / grass / rocks, globe + 3D Tiles, dual-backend) — FUTURE / unbuilt

**Status:** FUTURE — design complete, **zero code shipped** (investigation/design only, 2026-06-05). This is a scope flag + pointer; the full design (feasibility, gap analysis, 4-stage LOD, foliage PBR, 3D-Tiles spec analysis, perf-feature usage, biome/ecoregion data layer) is canonical in **[VEGETATION_SYSTEM_DESIGN.md](VEGETATION_SYSTEM_DESIGN.md)** — do not duplicate detail here.

**What:** Ultra-performant planetary vegetation on the globe + draped on 3D Tiles, WebGPU-first with a degraded-but-correct WebGL2 fallback. Six independently-shippable slices (each must ship a Playwright probe per CLAUDE.md Principle 8):

- **V1 — Scatter foundation:** `Scene/VegetationLayer.js` + `VegetationScatterCollection` + `FeatureRendererKey.VEGETATION_SCATTER` + `WebGPUVegetationScatterRenderer.ts` + `Shaders/WebGPU/Compute/VegetationScatter.wgsl` (density/biome map → RTE instance buffer); WebGL2 CPU-worker twin writing the identical layout (deterministic seeded PRNG, never `Math.random()`).
- **V2 — 4-stage mesh-LOD chain + GPU LOD select:** the central new artifact — no per-Model mesh-LOD chain exists today (`Scene/Model/Model.js` has only `distanceDisplayCondition`, a binary cull). Reuse `WebGPUGPUCuller` + `WebGPUIndirectDrawManager`; CPU per-instance tiering on WebGL2. **Decision point:** add a GPU-cull gate to the `Pass.CESIUM_3D_TILE` path (currently bypasses `gpuCullCommands()`) vs dispatch scatter through `Pass.OPAQUE` to inherit the existing gate.
- **V3 — Octahedral impostor bake + sample** (resolves `FEAT-GAP-07`): offline + lazy-RTT atlas; portable octahedral FS sampling; stochastic-dither L0↔L1 cross-fade (`csm_stochasticDither.wgsl`, shipped).
- **V4 — `VegetationPBR` shader pair:** new `ShaderDefine` bits + flag bits 26–30 (wind, two-sided leaf translucency, alpha-to-coverage, canopy AO, impostor sampling) in WGSL + GLSL lockstep.
- **V5 — Grass + rocks profiles:** grass chain (blades → density imposter → detail-albedo); rocks/sparse-arid parameter profile (no wind, full-octahedron impostor, Hi-Z occlusion).
- **V6 (optional) — optimization:** GPU-sort consumer wiring, render-bundle caching for static L2/L3 tiles, per-instance picking + `Cesium3DTileStyle` species coloring.

**3D-Tiles authoring / extension idea:** explicit instances ride entirely on ratified/in-flight standards (`EXT_mesh_gpu_instancing` + `EXT_structural_metadata` + `EXT_instance_features` + `3DTILES_metadata` + `3DTILES_implicit_tiling`) with **zero new loader** — the recommended ingest for real datasets (OSM `natural=tree`, Global Forest Watch). The spec has **no** vegetation/biome/scatter semantics and **no** metadata-driven auto-LOD/impostor/HLOD generation (those are author-baked-explicit or viewer-side). A fork-local `3DTILES_vegetation_scatter` / `_CESIUMWEBGPU_vegetation_scatter` convention (`VEG_BIOME` / `VEG_ECOREGION` / `VEG_SPECIES` / `VEG_DENSITY_SCALE` semantics + density/biome KTX2 rasters) is proposed for procedural fill — fork-local first, upstream only after deterministic seeded scatter is proven.

**Biome/ecoregion data dependency (asset-prep, not engine work):** three-layer model (biome/climate + ecoregion + landcover) keying a species palette per `(biome × ecoregion × landcover)`. Recommended permissive stack: Köppen-Geiger v3 + RESOLVE Ecoregions 2017 + ESA WorldCover 2021 (all **CC-BY-4.0** — note: no MIT-licensed geospatial data exists; CC-BY/CC0/public-domain is the field norm). Auto-sample (pre-rasterized KTX2 → O(1) lookup) + manual GeoJSON/tileset override with strict precedence (explicit > manual > tileset > global).

**WebGL2 / WebGPU split:** the recurring deficit is WebGL2 has no compute, no GPU-driven indirect-arg generation, no per-point LOD (`Context.js:1107`). Every GPU-driven stage (scatter, cull, LOD-select) needs a maintained CPU twin. The portable subset (impostor sampling, HLOD proxies, wind, dither/A2C, terrain-albedo bake) is large enough that WebGL2 still gets a correct, shippable experience — just CPU-bounded scatter and tile-granular (not per-instance) LOD.

**Related existing inventory entries** (this epic consolidates them): `FEAT-GAP-07` (impostors, §D.2), `FEAT-SURVEY-43` (grass/foliage material + vegetation instancing, §D.7), `BACKLOG-§9` (subsurface scattering, §D.7). Refraction-MRT for physically-correct leaf transmission is unbuilt (ties to `BACKLOG-§9`); no runtime mesh-merge tool (L2 HLOD clumps baked offline); `Scene/PropertyTexture.js` shader-wiring gap blocks per-texel density maps (workaround: plain control texture).

**Prerequisites:** none hard-blocking V1 (the consumer half — instancing, metadata, depth-draping, terrain sampling, RTE, stochastic dither — already exists). V4 refraction defers to `BACKLOG-§9`. **Effort:** multi-slice epic, each slice independently shippable. **Trace:** `migration_doc/VEGETATION_SYSTEM_DESIGN.md` (canonical design, §1–§9 + 3D-Tiles spec section + LOD-A..C perf-feature section + BIOME-A..E data-layer section).

---

## Carried-forward on archive (2026-05-30) — lifted from archived 2026-04-16 principal-review pillars

These entries were lifted out of three docs being archived per `_DOC_AUDIT_PLAN.md` §2 Cluster B / §3.7 so that archiving them orphans nothing. Origin docs:

- **REVIEW_FIX_PROGRESS.md** — closed Batch 1–66 campaign log (its "Deferred critical findings" index, lines ~3051–3110).
- **PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md** — build/lifecycle pillar.
- **PRINCIPAL_ENGINEER_REVIEW_DATA_PIPELINE_2026_04_16.md** — data-pipeline pillar.

Each stub preserves the finding ID + a one-line description + its origin. Per the audit-plan method, items whose status could not be re-verified from code in this pass are explicitly marked **status unverified, lifted from `<doc>` on archive**. Several sibling findings were checked against code and found already-closed (DP-C7 TEXCOORD_1, DP-C8 glTF samplers, DP-C9 sRGB double-apply, DP-H19-SHADER-DECODE [→ BACKLOG DP-H19-SHADER-DECODE-RUNTIME], DP-H25-SHADOW-CAST [shipped Batch 24], DP-H41-ALL-RENDERERS [RESOLVED, line ~629], C-P11-LOGDEPTH [in-flight log-depth epic, tracked at NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION]) — those are NOT duplicated here.

> Note on inventory boundary: the Appendix above delegates `DP-H*` high-severity findings to `WEBGPU_MIGRATION_BACKLOG.md`. That backlog's body stops at Batch 64, so several of the still-open DP-H items below are not actually carried in any *current* live tracker section. They are lifted here to guarantee continuity once the origin pillar is archived; if/when the BACKLOG body is brought forward they can be cross-linked rather than duplicated.

### Build / lifecycle pillar (origin: PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md)

- **BUILD-LIFECYCLE-3C-VIEW-BINDGROUP-CACHE** (§3c) — Per-frame `createView()` / `createBindGroup()` without a cache in two hot paths: `WebGPUPickFramebuffer.ts` (`createView()` in `begin()` every frame) and `WebGPUMipmapGenerator.ts` (`createBindGroup()` per mip level). Silent memory accretion in long sessions. NOT the same as C-R11 (which covered post-process + per-tile EffectsBindGroup caches). Fix: cache views on the texture wrapper (rebuild on resize), cache mipmap bind groups keyed on `(texture, mipLevel)`. **Status unverified, lifted from PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md §3c on archive.**
- **BUILD-LIFECYCLE-3D-DEVICE-LOSS-PROMISE** (§3d) — Device-lost recovery (`WebGPUDeviceLossRecovery._attemptRecovery()`) is `async` and its promise is not stored on the context; `destroy()` does not await/abort an in-flight recovery → recovered device can become an unowned-but-alive latent leak, and detached writes can crash. Fix: store the recovery promise on the context; `destroy()` awaits it or aborts via `AbortSignal`. **Status unverified, lifted from PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md §3d on archive.**
- **BUILD-VARIANT-PLUGIN-SPEC** (§5b) — `scripts/bundleVariantPlugin.js`, the variant stubs, and the variant build tasks ship with zero specs (a regex edit could redirect the wrong files and still build green). The plugin itself is BUILD-VAR-1 (BACKLOG, SHIPPED) but its **spec** is not tracked anywhere. Fix: `scripts/__tests__/bundleVariantPlugin.spec.js` mocking esbuild `onResolve`, asserting the right stub per variant × path. **Status unverified, lifted from PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md §5b on archive.**
- **WEBGPU-SPEC-BACKFILL** (§5c) — 20 of 22 major WebGPU modules (~8,850+ LOC: `WebGPUPrimitiveCommands`, `WebGPUAutoUniforms`, `WebGPUModelRenderer`, `WebGPUPrimitiveShaders`, `WebGPUCubeMapPanoramaRenderer`, `WebGPUPolylineRenderer`, `WebGPUSkyAtmosphereRenderer`, `WGSLShaderBuilder`, `WebGPUEnvironmentRenderer`, …) have zero specs. #1 quality risk per the build/lifecycle pillar. Fix: no new module without a spec; backfill top-5-by-LOC. **Status unverified, lifted from PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md §5c on archive.**
- **PRAGMA-STRIP-LINT** (§6e) — No post-build lint verifies that every `console.log`/`console.warn` in bundled output sits inside a pragma-debug region; a developer can add an un-wrapped diagnostic and the stripper silently misses it (§6b proved this happens). Fix: post-build lint plugin scanning bundled output for orphan console calls outside pragma-debug regions. **Status unverified, lifted from PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md §6e on archive.**
- **FEATURE-RENDERER-ONBOARDING-DOC** (§6h) — `migration_doc/FEATURE_RENDERER_ONBOARDING.md` does not exist (verified absent 2026-05-30). The pillar asked for a ~200–300-line contract/template/registration-site/scene-integration/backend-parity-checklist doc for adding feature renderers. Not tracked in any live doc. **Open — confirmed missing 2026-05-30; lifted from PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md §6h on archive.**
- **WGSL-PREPROCESSOR-PRIVATE-TO-INTERNAL** (§6d) — `WGSLShaderPreprocessor.ts` still carries **5** `@private` JSDoc tags on methods called cross-module (verified 2026-05-30: lines 227/541/587/697/759), forcing `as`-casts at call sites; they should be `@internal`. This is the concrete file-level instance of the general BACKLOG **TS-DEBT-8** sweep, which does not name this file. **Open — 5 tags confirmed present 2026-05-30; lifted from PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md §6d on archive (subset of TS-DEBT-8).**

### Data-pipeline pillar (origin: PRINCIPAL_ENGINEER_REVIEW_DATA_PIPELINE_2026_04_16.md)

- **DP-H7** — Polyline `followSurface` / `arcType: GEODESIC` silently straight-lines; WebGPU emits one GPU segment per adjacent position pair, no geodesic subdivision (verified 2026-05-30: zero `arcType`/`geodesic`/`generateArc` hits in `Source/Renderer/WebGPU/`). A Pittsburgh→Tokyo polyline is a straight chord through the Earth (passes underground). Needs CPU-side subdivision. **Open — confirmed unimplemented 2026-05-30; lifted from DATA_PIPELINE on archive.**
- **DP-H18** — `depthFailAppearance` entirely unimplemented on WebGPU (verified 2026-05-30: zero `depthFailAppearance`/twin-pipeline hits; existing `depthFailOp` hits are unrelated stencil ops). WebGL builds a twin shader + pipeline + uniforms; see-through highlighting primitives are broken. **Open — confirmed unimplemented 2026-05-30; lifted from DATA_PIPELINE on archive.**
- **DP-H35** — glTF morph-target NORMAL deltas dropped: `WebGPUModelMorphTargets.js` `packMorphTargetDeltas` packs only `positionData` (verified 2026-05-30: line ~144 reads `target.positionData`; `normalData` appears only in the JSDoc param doc, never written into the storage buffer). Morph-animated normals stay on the rest pose while positions deform. **Open — confirmed positionData-only 2026-05-30; lifted from DATA_PIPELINE on archive.**
- **DP-H36** — glTF instance translation not split for RTE: `WebGPUModelInstancing.js` writes the translation column as raw f32 (verified 2026-05-30: no high/low split hits). At ECEF magnitudes > 2²² sub-meter precision is lost; instanced 3D-Tiles content jitters with a stationary camera. **Open — confirmed unsplit 2026-05-30; lifted from DATA_PIPELINE on archive.**
- **DP-H37** — glTF `COLOR_0` as `VEC3` reads past buffer end for `.a`: `WebGPUModelPipelineCache.js` declares slot 4 `color0` as `float32x4` (line ~491) but a VEC3 source produces `vertexCount*3` floats, so the shader reads the next vertex's `.r` as `.a` → flickery alpha tracking vertex order. Whether the VEC3 source is widened to vec4 before upload was not confirmed in this pass. **Status unverified, lifted from DATA_PIPELINE on archive.**
- **DP-H44** — Globe surface has no pick-ID generation; terrain tiles are invisible to `scene.pick` (verified 2026-05-30: no globe pick-ID emission in `WebGPUGlobeSurfaceRenderer.ts`). Only models/primitives/collections with pick paths return hits. **Open — confirmed missing 2026-05-30; lifted from DATA_PIPELINE / REVIEW_FIX_PROGRESS on archive.**
- **DP-H45** — `scene.pickPosition` returns Cartesian only over the globe: `PickDepth._asyncDepthTexture` is only set by `WebGPUGlobeDepth`; Model/Primitive/Tile depth never routes through it, so depth unprojection silently falls back to terrain-only. **Status unverified, lifted from DATA_PIPELINE / REVIEW_FIX_PROGRESS on archive.**
- **DP-H46** — `scene.pickMetadata` entirely unwired on WebGPU: `frameState.pickingMetadata` is read nowhere in a producing path (verified 2026-05-30: only a C-R2 routing comment in `WebGPUSceneRendererPickPass.ts`, no implementation); public `pickMetadata()` returns null. **Open — confirmed unwired 2026-05-30; lifted from DATA_PIPELINE / REVIEW_FIX_PROGRESS on archive.**
- **DP-H47** — `czm_atmosphere*` auto-uniform suite entirely absent from `csm_*`; atmosphere-sensitive renderers (SkyAtmosphere, GroundAtmosphere, VolumetricFog) each hand-roll their own pull from `frameState.atmosphericConditions`, producing inconsistency between renderers. **Status unverified, lifted from DATA_PIPELINE on archive.**
- **DP-H48** — `temeToPseudoFixed` never reaches a shader; star-field / skybox uses the equinox-aligned basis instead of the rotating TEME→pseudofixed transform, so stars don't rotate with the Earth day-cycle. **Status unverified, lifted from DATA_PIPELINE on archive.**


### Scene-mode morph (3D ⇄ Columbus ⇄ 2D transition) pillar (origin: webgpu-morph-review audit, 2026-06-07)

Multi-agent audit of the WebGPU morph (transition) animation. Two confirmed P1s were fixed (Batch 216): the globe MORPHING `mesh.center` double-count (terrain splayed apart for the whole transition) and the ground-polyline `morphTime` typo. Remaining confirmed findings are deferred here.

- **MORPH-EXAG-SKIRTS** — Vertical exaggeration is DROPPED during MORPHING and COLUMBUS_VIEW on WebGPU. `GlobeTerrain.wgsl` gates the exaggeration block on `camera.sceneMode > 2.5` (SCENE3D only); WebGL applies it for ALL modes (gated only by the EXAGGERATION + GEODETIC_SURFACE_NORMALS defines, GlobeVS.glsl:245-258, mutating position/position3DWC/height before getPosition). So exaggerated terrain visibly deflates the instant a morph starts and CV terrain is never exaggerated. **A naive ungate is NOT sufficient (attempted Batch 216, reverted):** feeding the exaggerated height into the planar (CV / morph-2D) leg turns terrain SKIRT vertices (tile-edge geometry extruded below the surface to hide gaps) into tall vertical WALLS — the globe shatters into spikes (probe-exaggeration-cv.mjs, EXAG=10: WebGL shows clean peaks, WebGPU shows shattered walls). WebGL must special-case skirts in the planar exaggeration path. Fix needs WebGL-faithful skirt handling for the planar/morph legs, not just ungating. **Open — confirmed real + naive fix reverted 2026-06-07. Probe: probe-exaggeration-cv.mjs.**
- **MORPH-POLYLINE-COLLECTION-2D** — `PolylineCollection` has no 2D/CV/morph path on WebGPU: `WebGPUPolylineRenderer.js` encodes raw 3D ECEF positions and does a single `mvpRelativeToEye` multiply with no sceneMode/morphTime, while WebGL builds dual position2D/position3D attributes + per-mode `projection.project` + a MORPHING `position3DArray` and blends via `czm_columbusViewMorph` (PolylineVS.glsl:39-65). Entity/PolylineGraphics polylines render at the WRONG screen location in steady SCENE2D & COLUMBUS_VIEW (not just during morph) and detach from their billboards/labels through the transition. The `PolylineCollection.js:398-402` feature-renderer early-return bypasses all the mode-aware buffer setup. Untracked until now (FEATURE_INVENTORY marked it SHIPPED). **Open — confirmed 2026-06-07; needs a 2D-projected attribute + morph blend path mirroring the WebGL dual-attribute approach.**
- **MORPH-COLLECTIONS-AUDIT** — Billboard / Label / Point (and PolylineVolume / Cloud) collections were NOT inspected for morph/2D support on WebGPU. WebGL builds dual position2D/position3D attributes and blends via `czm_morphTime` for all of them. If the WebGPU renderers share `PolylineCollection`'s "raw 3D, single MVP" pattern, labeled markers also wander/detach in 2D/CV/morph (far more user-visible than polylines). **CONFIRMED (2026-06-07, Batch 219) as a hard no-render, not just drift:** after the SCENE3D fixes (Batches 218–219), `probe-collections-2dcv-morph.mjs` shows billboard/point/label all = 0 px on WebGPU in SCENE2D and COLUMBUS_VIEW (WebGL: bb 131 / pt 284 / lbl 497 in 2D). This is bug 5 in the WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER chain above. Root cause: the WebGPU collection renderers encode the raw 3D position + a single 3D MVP; 2D/CV need the projected Columbus/2D coordinate (`_actualPosition`) fed through the orthographic 2D frustum, and morph needs the `czm_morphTime` position2D↔position3D blend. **This is now the next concrete collections work item. Per-collection plan: thread `frameState.mode` + the 2D/CV projected position + the 2D camera UB into each WebGPU collection renderer (`WebGPUBillboardRenderer`, `WebGPUPointPrimitiveRenderer`, `WebGPULabelRenderer`) and WGSL (sceneMode branch / morphTime blend), mirroring how `GlobeTerrain.wgsl` + the globe camera UB handle 2D/CV.** Reproducer: `probe-collections-2dcv-morph.mjs`.
- **MORPH-TAA-PREVVP** — `previousViewProjection` is not guarded across the perspective↔orthographic mode-flip frame. `UniformState.update()` unconditionally clones the prior viewProjection (UniformState.js:798); at the morph flip the projection regime changes, so TAA / motion-vector reprojection computes garbage for a frame or two (and arguably throughout the morph, as the frustum animates each frame). Needs a "history invalid during morph + at mode flip" gate. **Open — not yet probe-verified (needs TAA enabled mid-morph).**
- ~~**MORPH-MIX-JITTER**~~ — ✅ RESOLVED (Batch 217). `GlobeTerrain.wgsl:1111` now uses the manual lerp `position2DWC.xyz*(1-morphTime) + position3DWC4.xyz*morphTime` instead of GPU `mix()`, mirroring WebGL `czm_columbusViewMorph` to avoid endpoint jitter on NVidia 3070 Ti / Intel Arc A750. Exact at the endpoints by construction; no-op on textbook-`mix` dev hardware (so dev probes prove no-regression only — the jitter is hardware-specific). `csm_columbusViewMorph.wgsl` left in place as scaffolding (Principle 7). Verified: morph renders smooth across morphTime range, 2D/CV/3D parity, 0 errors (probe-morph-midframe.mjs).
- ~~**MORPH-WEBMERCATOR-INSTANCEOF**~~ — ✅ RESOLVED (Batch 217). `WebGPUGlobeSurfaceCameraUB.ts` now imports `WebMercatorProjection` and uses `projection instanceof WebMercatorProjection` instead of the minification-unsafe `constructor.name === "WebMercatorProjection"`, matching WebGL (GlobeSurfaceTileProviderRendering.js:1201). Fix is a no-op in dev/unminified (both detect correctly); it corrects minified release builds where `minifyIdentifiers` renamed the class. Verified: no-regression (default Geographic 2D/CV/morph unchanged, 0 errors); tsc + build clean. NOTE — the minified-build functional repro (a `mapProjection: new WebMercatorProjection()` viewer under `buildRelease`, confirming correct Mercator latitude) was NOT run (requires a custom WebMercator test page + minified build); the fix is verified by code-correctness + exact WebGL parity. A definitive minified probe remains a nice-to-have.
- **MORPH-MODEL-PROJECT2D** — glTF Model accurate-2D (`projectTo2D:true`) has no WGSL equivalent: `ModelPBRComplete.wgsl` has no position2D attribute / `u_modelView2D` / USE_2D path (WebGL: GeometryStageVS.glsl:10-16). NOT a morph defect (models skip MORPHING; default `projectTo2D:false` is at parity), but a 2D/CV precision gap. **Open — P2, opt-in feature.**
- **MORPH-PREVMODE-TYPO** (disputed) — `SceneTransitioner.js:1083` reads `transitioner._previousModeMode` (double "Mode" typo, always undefined) instead of `_previousMode`, so `completeColumbusViewCallback` always clobbers the camera from `cameraCV`. Upstream (2020), backend-agnostic. Verifiers SPLIT on whether renaming would FIX a minor end-of-morph pose pop or INTRODUCE a regression (the 3D→CV tween may rely on the unconditional clobber). **Do NOT blind-rename** — confirm the tween end-state coordinate frame first; safest action is a documenting comment. **Disputed — needs a human call.**

#### Morph review gaps — surfaced by the audit's completeness critic, NOT code-verified (confirm before relying)

These are areas the webgpu-morph-review audit did NOT examine — flagged as likely-relevant by the completeness critic but not yet reproduced or code-confirmed. Lower confidence than the entries above; each needs its own investigation/probe.

- **MORPH-PICK** — Pick during a morph is exercised BY THE TRANSITIONER ITSELF: `SceneTransitioner` calls `globe.pickWorldCoordinates` mid-morph (SceneTransitioner.js ~645/775) to compute the 2D endpoint. If the WebGPU pick pass's camera UB doesn't carry the live `frameState.mode`/`morphTime`, the depth written for picking won't match the displayed geometry → `pickPosition` returns wrong coordinates → the transitioner computes a WRONG final 2D camera view, cascading into a visibly wrong end state. **Unverified — check whether the pick command-build path reuses `createCameraUniformBuffer` with the live mode/morphTime.**
- **MORPH-COMPLETION-POP** — At completion the `morphTime` tween (QUARTIC_OUT) can reach exactly 1.0/0.0 a frame or more BEFORE `_mode` flips (the tween and the mode-flip are sequenced via tween chaining, not atomically). The MORPHING branch then runs with an endpoint morphTime — fine only if that branch at the endpoint is byte-identical to the destination (SCENE3D/CV/2D) branch. After the Batch-216 matrix fix the morph branch should converge, but a one-frame "pop" at completion (present in WebGL? in WebGPU only?) was never checked. **Unverified — instrument `frameState.morphTime`+`mode` across the completion frames and diff the (MORPHING, mt=1) frame vs the first (SCENE3D) frame.**
- **MORPH-CAMERA-FRUSTUM** — During the morph the camera frustum is a perspective frustum with an ANIMATED FOV (`morphPerspectiveToOrthographic`/`morphOrthographicToPerspective`). The WebGPU multi-frustum split (`frustumCommandsList`) + HiZ pyramid consume `camera.frustum`; if any near/far split or HiZ extent is cached across frames it could thrash mid-morph. **Unverified — confirm near/far + HiZ are recomputed every morph frame, not cached.**
- **MORPH-MULTIVIEW** — Split-screen / multi-context morph (CLAUDE.md Principle 3): `scene._mode`/`morphTime` are single scalars shared by all views/contexts on a Scene. The audit verified neither that WebGL + WebGPU stay frame-locked through the animation on the split-screen page, nor that two simultaneous WebGPU contexts each flip mode correctly. **Unverified — run the split-screen page through a non-zero-duration morph and diff per-frame (this is also the natural home for extending probe-morph-midframe.mjs to multi-view).**

### ⚠️ Billboard / Point / Label collections render NOTHING on WebGPU (Batch 2 audit, 2026-06-07) — RESOLVED in 3D for all three (Batches 218–219); bug 2 (far-surface depth) + 2D/CV-mode collections remain

> **Deep-dive resolution (2026-06-07, Batches 218–219):** the no-render is a CHAIN of independent bugs. In **SCENE3D**, billboards, points, and labels now render with WebGL parity (verified close-camera, PNG-read via `probe-collections-closeup.mjs`). Two cross-cutting gaps remain — bug 2 (far-surface depth) and full 2D/COLUMBUS_VIEW collection rendering.
> - **Bug 1 (FIXED — billboard 218, point/label 219) — bounding volume never computed on WebGPU → frustum-culled.** `BillboardCollection.update` computed `_boundingVolume` only in the WebGL path (after the `fr` early-return), so the WebGPU draw command carried the default degenerate sphere (center 0,0,0, radius 0 = Earth's centre) and `View.createPotentiallyVisibleSet` culled it (`scene.isVisible` → OUTSIDE). Fix: `computeBoundingVolumeForFeatureRenderer` runs in the `if (fr)` block — reproduces the `_max*`/`_all*` aggregates the WebGL vertex writers compute, transforms `_baseVolume`→WC, and calls `updateBoundingVolume`. Verified: a 100 km-altitude billboard now renders (992 magenta px, was 0). (`packages/engine/Source/Scene/BillboardCollection.js`.) **Point (Batch 219):** the identical fix in `PointPrimitiveCollection.js` (`computeBoundingVolumeForFeatureRenderer` + call in the `if (fr)` block). **Label (Batch 219):** see the glyph-atlas note below — the BV cull was only HALF the label failure.
> - **Bug 3 (FIXED — billboard 218, point/label-SDF 219) — `disableDepthTestDistance` rendered BEHIND, not on top.** The `//>>ifdef DISABLE_DEPTH_DISTANCE` block set `clipPos.z = clipPos.w` (NDC z=1 = the FAR plane), which under `less-equal` fails against the closer globe. WebGPU clip-z is [0,1] (near→far), so "always on top" is the NEAR plane (0), not far. Fix: `clipPos.z = 0.0` — `BillboardCollection.wgsl` (218, 3 sites), `PointPrimitiveColor.wgsl` (219, 3 sites), `BillboardCollectionSDF.wgsl` (219, 3 sites — labels). Verified for billboards: a surface billboard with `disableDepthTestDistance = Infinity` now renders (992, was 0).
> - **Bug 4 / LABEL-SPECIFIC (FIXED — Batch 219) — glyph atlas never uploaded + glyph BV degenerate.** Labels were 0 even at close camera in 3D *after* bugs 1+3. Root cause: `LabelCollection.update()` delegates glyph rendering to the dedicated `WebGPULabelRenderer` (SDF) and **returns before calling `glyphBillboardCollection.update()`** — so the billboard shared-scene-logic prologue (texture-atlas GPU upload schedule + `_baseVolume`/`_boundingVolume` computation) never ran for the glyph collection. Result: the SDF pass sampled the 1×1 placeholder atlas (→ discard every fragment) AND the glyph draw command carried the radius-0 BV (→ frustum-culled). Fix: extracted the shared prologue into `runSharedSceneLogic()` + a public `BillboardCollection.prepareForFeatureRenderer(frameState)` (prologue + `computeBoundingVolumeForFeatureRenderer`, no draw emission); `LabelCollection.update()` now calls it on the glyph + background collections before `labelFR.update()`. Verified: label "X" renders at close camera in 3D (251 lime px, was 0). (`BillboardCollection.js`, `LabelCollection.js`.)
> - **Bug 2 + Bug 5 (OPEN — UNIFIED ROOT CAUSE, diagnosed Batch 220) — the collection camera UB is packed ONCE per frame with ONE frustum's projection, but the scene renders in MULTIPLE depth frustums.** This single root cause explains BOTH the far-camera-3D failure (was mislabeled "bug 2 = log-depth") AND the total 2D/CV no-render ("bug 5").
>   - **Evidence (`probe-billboard-2d-debug.mjs`, SCENE2D):** the billboard command is NOT culled (`bvVisibility=1`, in command list) and `_actualPosition` IS correctly projected (0, −8.35 Mm, 4.45 Mm). But the manually-computed `clip.z = 7.289` (WebGPU clip range is [0,1] → DEPTH-CLIPPED). The scene has **`numFrustums = 9`**; the billboard's eye-space depth is **−12,756,274**; the camera UB was packed with **frustum 0** (`near=1, far=1,750,001`). `12.75M / 1.75M ≈ 7.28` = exactly the measured clip.z. So in the frustum the billboard actually belongs to (frustum 8: near 12.76M / far 14.51M), it is rendered with frustum-0's projection → clipped.
>   - **Why close-camera 3D works but far-camera 3D / 2D don't:** at a close camera the scene has few frustums and the marker sits in frustum 0 (whose projection the UB happens to hold) → renders. At far range, or in 2D (always 9 frustums), the marker lands in a far frustum but the UB still carries an early frustum's near/far → depth-clipped AND its depth no longer matches the globe's per-frustum depth → also fails the depth test (this is the "occluded by globe / renders only with globe.show=false" symptom previously attributed to log-depth).
>   - **How the globe avoids it (the reference):** `WebGPUGlobeSurfaceCameraUB.createCameraUniformBuffer` is called PER TILE DURING the render pass, so it picks up the CURRENT frustum's `uniformState.projection` (which the multifrustum executor updates before each frustum). The collection renderers pack their camera UB once in the FR `update()` (before multifrustum execution) → stale projection for every frustum but one.
>   - **Execution-path mechanism (investigated Batch 220):** the WebGPU multifrustum executor (`WebGPUSceneRendererFrustumLoop.executeFrustumLoop`) calls `host._updateFrustumUniforms(uniformState, near, far)` → `uniformState.updateFrustum` per slice (publishing the slice's projection) and publishes `uniformState._currentSliceIndex = i`. `WebGPUDrawCommand.execute` already runs `bindGroupResolvers[i]()` per draw — the established per-slice pattern (`WebGPUGroundPrimitiveRenderer`, Batch 173 `NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO`). Per-slice GPU buffers MUST be distinct (`device.queue.writeBuffer` is unordered vs the encoder, last-wins).
>   - **Batch 220 attempt (REVERTED) — per-frustum UB resolver is NECESSARY BUT NOT SUFFICIENT.** Implemented a `bindGroupResolvers[0]` on the billboard color/velocity commands that re-packs the camera UB per slice into distinct per-slice buffers, plus the 2D/CV camera-frame fix (`inverse(view).translation`). The resolver FIRES correctly (`probe-billboard-2d-debug.mjs` confirmed 225+ calls, per-slice indices, per-slice `currentFrustum`), but billboards STILL render nothing in 2D/CV AND far-3D. So the single-projection theory was incomplete. Two ADDITIONAL, independent blockers surfaced:
>     1. **far-3D = depth-test OCCLUSION, not clipping.** With the resolver, the far-3D billboard's clip.z is in [0,1] (slice projection correct) yet it's still 0 px — it's occluded by the globe in the depth buffer. The billboard writes a depth that doesn't match the globe's depth at the same surface point in that slice. This is the genuine depth-matching issue (the globe's depth encoding per slice vs the billboard's). `disableDepthTestDistance` sidesteps it by forcing clip.z=0.
>     2. **2D = the C-R8-SCENE2D-JITTER camera-Z shift.** In SCENE2D the frustum loop SHIFTS `scene2DCamera.position.z` per slice and compresses each band to `[1, far−near+1]` (`WebGPUSceneRendererFrustumLoop.ts:211-230`) so the ortho depth keeps precision. Globe tiles ride this because their per-tile UB is rebuilt against the shifted camera. The collection instance positions (projected Columbus coords) + a resolver that reads `uniformState.view` must be reconciled with this per-slice camera shift; the current resolver re-pack doesn't reproduce the globe's planar-RTC handling, so the billboard's clip position is wrong in the shifted band.
>   - **Revised plan:** (a) far-3D needs the marker depth to match the globe's per-slice depth (mirror the globe's depth write/encode for the collection pipelines, OR accept `disableDepthTestDistance` as the supported path and document it); (b) 2D/CV needs the resolver to reproduce the globe's planar per-slice camera handling (the projected-RTC + shifted-camera math in `WebGPUGlobeSurfaceCameraUB.computeModifiedModelView`), not just swap the projection. This is multi-part and larger than one batch. Reverted the WIP to keep `main` clean (low-risk per user direction); the resolver design above is the resume point.
>   - **Supersedes:** the earlier "bug 2 = linear-vs-log depth, needs WebGPU log-depth" hypothesis (Batch 218) is PARTLY rehabilitated — far-3D IS a depth-match problem, but the per-frustum projection is ALSO required. `probe-billboard-2d-debug.mjs` (PROBE_MODE=2d|3d) is the reproducer/instrument.
> - **Minor (OPEN — 3D billboard/label screen-size) — markers render ~30% smaller on WebGPU.** Close-camera ratios: billboard GL 576 / GPU 289 (0.50 area ≈ 0.71 linear), label GL 369 / GPU 251 (0.68); point matches well (0.89). Likely a `highResMultiplier` / device-pixel-ratio mismatch in the instance-quad screen-space sizing. Cosmetic vs the no-render P0; refine after 2D/CV.

- **WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER** — `BillboardCollection`, `PointPrimitiveCollection`, and `LabelCollection` produce **no visible output** on the WebGPU CesiumViewer, in **every** scene mode (SCENE3D, SCENE2D, COLUMBUS_VIEW). WebGL renders them correctly. This was surfaced while doing the morph "billboard/point/label 2D-CV audit" (MORPH-COLLECTIONS-AUDIT / PLAN_2DCV_MORPH_BATCHES Batch 2) — the audit expected a 2D/CV-only gap but found the collections don't render even in 3D.
  - **Severity: P0/P1.** Billboards/points/labels are among the most-used primitives (every pin, marker, city label, Entity with billboard/point/label graphics). They are broken in all modes on WebGPU.
  - **Evidence (5 probe variations + read PNGs + git bisect):** `probe-collections-2dcv-morph.mjs` (raw primitive collections) and `probe-collections-entity.mjs` (Entity API) both show billboard/point/label = 0 colored px on WebGPU vs hundreds on WebGL, in 3D/2D/CV. PNGs read directly (Principle 8) — the markers are simply absent. Reproduces at close camera (~4 km) AND far (1.2 Mm); with the default render loop only (no manual render); and with `disableDepthTestDistance = Infinity` (so it is NOT depth occlusion). A `PolylineCollection` placed in the same scene DOES render on WebGPU (opaque pass works), so the WebGPU scene pipeline is partially functional.
  - **Not a regression from this session:** bisected — billboard=0/point=0 at Batch 214 (`0e51182139`, before the Batch-215 BUG-3 scene-FB changes). Long-standing; never caught because the visual-regression suite has ~zero billboard/label/point coverage (only `high-density-5k-spheres`).
  - **Renderers exist + the feature renderer IS invoked:** `WebGPUBillboardRenderer.js` / `WebGPULabelRenderer.js` / `WebGPUPointPrimitiveRenderer.js` exist and are reached — `BillboardCollection.update` finds `context.getFeatureRenderer(BILLBOARD_COLLECTION)` and calls `fr.update(...)` with no fallback error (BillboardCollection.js:731-738). So commands are generated but draw nothing visible. Root-cause hypothesis (NOT yet confirmed): the WebGPU billboard/point/label draw produces no/degenerate output — candidates to investigate: the screen-space vertex/instance generation, the texture-atlas binding (billboard/label), the translucent-pass execution of these commands, or the pipeline state. The polyline working rules out a global scene-FB/compositing failure.
  - **Docs were optimistic:** FEATURE_INVENTORY tagged these `(SHIPPED)` — that reflected code existing + passing a device-error check (e.g. probe-collections-msaa.mjs asserts 0 device errors, never visual presence), NOT visual verification. Tags corrected to flag the no-render state.
  - **Reprioritization:** this likely outranks the planned PLAN_2DCV_MORPH_BATCHES Batch 3 (PolylineCollection 2D/CV port) — billboards/points/labels are more ubiquitous and broken in ALL modes (including 3D), not just 2D/CV. **Open — needs a dedicated renderer-level investigation + fix; reproducers: probe-collections-2dcv-morph.mjs, probe-collections-entity.mjs.**
  - **UPDATE (2026-06-07, Batches 218–219) — SCENE3D RESOLVED for all three.** The 3D no-render was the bug-1 (degenerate BV) + bug-3 (inverted clip-z) + bug-4 (label glyph-atlas/BV) chain documented in the resolution block above. Billboards (218), points + labels (219) now render in 3D at close camera with WebGL parity (verified via `probe-collections-closeup.mjs`, PNG-read). **Still open: bug 2 (far-surface depth, all three) and bug 5 (SCENE2D / COLUMBUS_VIEW render nothing — the next concrete step, tracked under MORPH-COLLECTIONS-AUDIT).**
