# Campaign Roadmap — June 2026 onward

Multi-phase execution plan for working through ALL of `DEFERRED_WORK.md`, then bugs/fixes/smaller improvements. Each phase = one workflow run (the proven sequential implement → `gulp build` → Playwright-probe → commit pattern), sized 4–11 stages. Ordering reflects dependencies (noted per phase).

**Phase 1 — ✅ DONE (Batches 232–242):** Point/Label partial-write, Cloud gate, TAA velocity activation, compute-instance BV+velocity, all-collections harness, upstream pulls + modernization regressions, pickModel #13433, scaffolding disposition, bloom parity, globe bind-group cache, CI smoke.

**Phase 2 — ✅ DONE (Batches 243–253, 2026-06-12 run):** all three bullets shipped — NEW-DERIVEDCOMMAND-VARIANT-FACTORY core (Batch 248; billboard PICK migrated as adoption proof; HDR/SHADOW kinds remain its tracked follow-ups), NEW-COLLECTIONS-LOG-DEPTH (Batches 249/250/251 — master switch defaults TRUE; residual hyperbolic writers tracked NEW-LOG-DEPTH-REMAINING-PRODUCERS), NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION (Batch 252 — pickPosition parity dH 4.1 m). Same run also landed the CI green sweep (243), TAA resolve activation (244), instanced-model VA divisors + CPU pick (245), default-limit globe layout (246), ground-view env parity (247), and the final sweep's two catches (253: cloud scale METERS + depth-plane [ld] bind visibility). All Phase-2 gates green on the final tree: far-camera + pickPosition + collections-regression + globe visual probes, full 17-gate table in WEBGPU_DEBUGGING_LOG Batch 253. **Remaining from this phase's scope:** Phase 6 pick siblings (NEW-PICK-RAY-ASYNC / NEW-PICK-METADATA-READBACK), derived-command HDR/SHADOW kinds. **NEW-LOG-DEPTH-REMAINING-PRODUCERS — geometry/opaque producers now COMPLETE:** Mat*/PBR/Basic (Batch 264), Buffer* (265), EllipsoidPrimitive + Vector3DTile* classifiers (266), final sweep + Moon divergence doc + far-camera probe flake fix (267). Full z-fight gate (3 probes) + all 11 standing gates green. Only two non-geometry producers remain hyperbolic — `WebGPUPointCloudRenderer` (PNTS/EDL) + `WebGPUGaussianSplatRenderer` (NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT) — plus off-by-default depth consumers (NEW-LOG-DEPTH-REMAINING-CONSUMERS).

---

## Phase 2 — The log-depth epic (the critical path) — ✅ SHIPPED (Batches 248–253 core flip; geometry/opaque producer sweep Batches 264–267; see status block above)

The single highest-leverage remaining correctness effort; three tracked problems share it.

- **NEW-DERIVEDCOMMAND-VARIANT-FACTORY** — rewrite `WebGPUDerivedCommand` as the real centralized pipeline-descriptor-variant layer (its archaeology-confirmed purpose). Built FIRST as the epic's vehicle; also becomes the central MSAA-bake enforcement point.
- **NEW-COLLECTIONS-LOG-DEPTH** — apply log-depth uniformly across globe + every collection pipeline via the factory. Fixes far-camera marker vanishing (the depth-quantization z-tie measured in Batch 229: a billboard 1000 m above ground at a 220 km camera is ~0.03 quantization steps from the globe).
- **NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION** — layer 3 of the pickPosition fix (per-frustum/full-frustum depth reconstruction); unblocks `pickPosition`/`sampleHeight`/`clampToHeight`/camera-zoom-to-cursor end-to-end.
- Gate: far-camera billboard probe + pickPosition probe + collections regression harness + globe visual parity.

## Phase 3 — 2D / Columbus View / morph collections (the last big visual-parity hole)

Resumes the paused Batch-220 diagnosis. Depends on Phase 2 (depth-match half).

- Per-frustum camera-UB resolver for collections (Batch-173 GroundPrim pattern; `_currentSliceIndex` plumbing exists).
- C-R8-SCENE2D-JITTER camera-shift integration + projected-frame RTE encoding (`inverse(view)` eye) for collections.
- Morph blend (position2D/position3D × `czm_morphTime`) for collections; `PLAN_2DCV_MORPH_BATCHES` Batch 3 (PolylineCollection 2D/CV) + its 7-item backlog (MORPH-EXAG-SKIRTS, MORPH-MODEL-PROJECT2D, MORPH-PICK, MORPH-COMPLETION-POP, …).
- Cosmetic: collections ~0.7× screen-size mismatch (highResMultiplier/DPR).
- Gate: `probe-collections-2dcv-morph.mjs` goes green in 2D + CV (currently all-zero).

## Phase 4 — Large Dynamic Objects, roadmap Phase 2 (flat-buffer + WASM) ✅ CORE SHIPPED (Batches 270-273)

- ✅ **NEW-WASMRTE-SUBRANGE-ENCODE** (Batch 271, sub-range batchEncode + JS fallback), ✅ **NEW-BUFFERCOLL-WASM-ENCODE-WIRE** (Batch 272, threshold-gated into WebGPU+WebGL `Buffer*` repack), ✅ **NEW-BUFFERCOLL-ENCODE-BENCHMARK** (Batch 273, 10k/50k/100k both backends, threshold tuned 5000→2000 from measurement). Optional **NEW-WASM-WIDE-INSTANCE-KERNEL** remains deferred (only worth it if the residual color-pack loop becomes the bottleneck — the benchmark showed the position-encode hoist already captures the win).
- Built on the #13465 BufferPointCollection staleness fix (Batch 270).
- **Benchmark headline (Batch 273):** the win is the position-encode HOIST out of the per-primitive loop (batch fround over a contiguous Float64Array beats the per-point AGI `EncodedCartesian3` split by ~25-40% end-to-end at ≥1500 points on BOTH backends), NOT WASM SIMD (real-kernel CPU micro-bench: ~1.2x at 10k-50k, ties at 100k — below browser noise). Threshold lowered to 2000 to capture medium dynamic updates. Honest caveat carried forward: the WASM kernel still does not load in the bundle (**NEW-WASM-BRIDGE-BUNDLE-LOAD**) — the bundle runs the byte-identical JS fround twin, so the SIMD win is dormant until that infra fix lands; the strategy win stands regardless.

## Phase 5 — Orbital / compute-instance productionization — ✅ DONE (Batches 277–281; closeout Batch 282)

**Accuracy headline:** secular-J2 df64 propagator holds **15 m** over a 30-day LEO span (vs 2177 m for the f32 control — a 145× precision win); near-earth SGP4 (df64, WGS-72) holds **55 m** worst-case over a full day (24 h / 1440 min) vs an embedded python-sgp4 reference — 36× inside the 2 km budget. The engine carries ZERO orbital domain knowledge throughout — every kernel (circular / J2 / SGP4 / Lissajous), element layout, and catalog generator lives in the "WebGPU Orbital Catalog" / "WebGPU SGP4 Satellites" Sandcastle demos + the probes; the engine owns only the feature-agnostic `ComputeInstanceCollection` substrate (storage-buffer instances, pluggable WGSL/CPU kernel, RTE high/low split, df64 helpers).

- ✅ **NEW-ORBITAL-J2-KERNEL** (Batch 277) — df64 (two-float, ~46-bit) helpers in `ComputeInstanceScaffold.wgsl` + `ComputeInstanceOut.positionLow` + `csm_emitDF64` (engine, domain-agnostic); secular-J2 + IAU-82 GMST demo kernel (demo). Fixes the "RTE low part always 0" limit for opt-in kernels.
- ✅ **NEW-ORBITAL-SGP4-KERNEL** (Batch 278) — near-earth SGP4 (Vallado WGS-72) as a demo/probe kernel: CPU FP64 `sgp4init` pre-conditioning → 42-lane params (secular rates as df64 pairs) → GPU per-frame df64 update; deep-space (period ≥ 225 min) flagged + skipped so the kernel is never silently wrong.
- ✅ **NEW-ORBITAL-GPU-PICKING** (Batch 279) — rasterized GPU pick pass for storage-buffer instances; `scene.pick` returns the domain-agnostic `{collection, instanceIndex, primitive}` record (demo maps index → satellite).
- ✅ **NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK** (Batch 280) — optional `cpuKernel` JS twin + `Renderer/WebGLComputeInstanceRenderer.js` (under the FeatureRenderer seam) renders the SAME instance records on WebGL2 (no compute shaders); WebGL≈WebGPU centroid agreement 0.39 px. The Worker/WASM perf offload (NEW-COMPUTE-INSTANCE-WEBGL2-WORKER) stays deferred.
- ✅ **NEW-ORBITAL-DEVICE-LIMITS-PROBE** (Batch 281) — `probe-orbital-1m.mjs` validates the pipeline scales to a literal 1,000,000-instance catalog within negotiated device limits on a default-class adapter (records SSBO 61 MB single-binding, dispatch 15,625 workgroups; single-binding max ≈ 4.19M dispatch-bound). No multi-SSBO split needed at 1M.

**Closeout (Batch 282):** full orbital/compute-instance gate set re-run green from the committed build — probe-orbital-catalog (2000 obj, 0 err), -compute-instance-generic (BV+TAA on/off), -compute-instance-pick (3/3 indices), -orbital-j2 (15 m / 30 day), -orbital-sgp4 (55 m / 1440 min), -compute-instance-webgl2 (0.39 px), -orbital-1m (1,000,000 achieved), plus probe-collections-regression + sandcastle-smoke (3/3). BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE confirmed RESOLVED (probe-ellipsoidprim-logdepth, 18280 px). Engine-purity grep confirms zero orbital domain logic in `packages/engine/Source`.

**Demo WebGL2 polish (Batch 283):** the two compute-instance demos are now WebGL2-exercisable from the demo URL. Both "WebGPU Orbital Catalog" + "WebGPU SGP4 Satellites" read `?renderer=webgpu|webgl` (default webgpu), and the SGP4 demo gained a `cpuKernel` (FP64 SGP4 update over the same 42 packed param lanes; factored into `Tools/visual-regression/sgp4-cpu-kernel.mjs`, matching the validated reference to < 1 m / full day) so it renders on the WebGL2 CPU-kernel fallback too. New gate `probe-compute-instance-webgl2-demos.mjs` drives both demos on both backends (renders + moves + correct-backend-armed + 0 errors; all 4 legs PASS). NEW-COMPUTE-INSTANCE-WEBGL2-WORKER (worker/WASM offload) stays DEFERRED — perf-only, the main-thread fallback is functionally complete.

## Phase 6 — Picking parity completion

- ✅ **NEW-PICK-RAY-ASYNC sampleHeight/clampToHeight SHIPPED (Batch 284)** — these two now WORK on WebGPU by reusing the main scene depth (`Picking._reconstructHeightSurfaceWebGPU`: project target into the live view → read the surface beneath it via the Batch-252 `pickPositionWorldCoordinates` reconstruction). One-frame-stale sync cache (cold→undefined→converge 1-2 frames). pickFromRay over an ARBITRARY ray is explicitly scoped out (hit object, no position; `oneTimeWarning("WebGPU.pickFromRay.noPosition", …)`, no throw) — arbitrary-ray async position needs an offscreen GlobeDepth pack + per-view readback, deferred until a consumer needs it. Gate: `probe-pick-ray-async.mjs` (sampleHeight dH 3.5 m vs WebGL, clampToHeight exact, cold→converge, no-throw, 0 errors) + `probe-sampleheight-webgpu.mjs` rewritten to working-parity.
- ✅ **NEW-PICK-METADATA-READBACK SHIPPED (Batch 285)** — `WebGPUPickFramebuffer.readCenterPixel` (pickMetadata/pickVoxelCoordinate) now arms a synchronized, guarded (`_centerReadbackInFlight`) 1×1 readback of the JUST-RENDERED center pixel + returns a one-frame-stale coord/stamp-keyed cache (mirrors `PickDepth.getDepth`), instead of slicing `_lastReadPixels` from a prior color pass. `Picking.js` calls `endFrame()` before `readCenterPixel` so the metadata/voxel render is submitted ahead of the readback. Bonus: fixed the voxel COLOR pipeline's missing MSAA-count bake (attachment-state crash on MSAA scenes). Gate: `probe-pick-metadata.mjs` (shared readback verified via a Box pick FBO — WebGPU converges to WebGL's pick color, guard clears, 0 errors). **Asset gaps:** live voxel-coordinate parity blocked by the scaffolded placeholder voxel renderer (`C-R9-VOXEL-CELL-PICK`); full metadata decode needs an ion `EXT_structural_metadata` tileset (no local asset) — documented, mechanism verified.
- ✅ **NEW-COMPUTE-INSTANCE-PICKPOSITION SHIPPED (Batch 286)** — `scene.pickPosition` over a GPU-resident `ComputeInstanceCollection` instance now returns THAT instance's world position on BOTH backends. `Picking.pickPositionWorldCoordinates` object-picks the cursor first and, when the front record is a compute-instance (duck-typed `getInstanceWorldPosition` + `instanceIndex`, gated on a context frame-stamp so non-compute-instance scenes are untouched), returns the instance position directly (the depth path can't reconstruct a sub-pixel dot's center; on WebGPU the dots don't write depth). WebGPU reads the picked 64-B record slot back via `copyBufferToBuffer`+`mapAsync` (instance buffers gained `COPY_SRC`), summing positionHigh+positionLow, with the PickDepth one-frame-stale per-index sync cache. WebGL2 re-runs the `cpuKernel` for the index, and gained a NEW per-instance WebGL pick path (`ComputeInstanceWebGLPick{VS,FS}.glsl` + one `createPickId`/instance) — previously WebGL compute-instances were unpickable. Gate: `probe-compute-instance-pickposition.mjs` (3 instances both backends, pickPosition within 50 m — measured 0.00 m, empty→undefined, sync contract, 0 errors).
- Remaining Phase 6: arbitrary-ray pickFromRay position (offscreen-render async depth); live voxel-coordinate + metadata-over-tileset parity once the WebGPU voxel-data renderer lands / a local metadata asset is available.
- Depends on Phase 2 (depth reconstruction). Gate: full pick API probe matrix WebGL vs WebGPU.

## Phase 7 — Shading & material parity

- Model PBR: ✅ **NEW-MODEL-IBL-BRDF-LUT** (Batch 287 — split-sum LUT wired + Fdez-Aguera diffuse), ✅ **NEW-MODEL-IBL-REFERENCE-FRAME** (Batch 287 — reflections now world-fixed via the packed `iblReferenceFrameMatrix` mat3), **NEW-MODEL-DIRECT-BRDF-PARITY** (Smith-joint + f90 — still open). Surfaced: **NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU** (authored KTX2 specular env maps don't load on the WebGPU context; procedural fallback used).
- ✅ **NEW-SPLAT-SORT-CONSUME-INDEXES** (Batch 288 — Gaussian splats consume back-to-front sort). **NEW-CSM-SOFT-SHADOW-PCF** (Batch 289 — receive-side 3x3 PCF kernel CODE SHIPPED; visual-verify blocked on **NEW-CSM-CAST-NO-DISPATCH-VIEWER** (HIGH, surfaced Batch 289 — WebGPU CSM cast pass dispatches 0 commands in viewer scenes, so no cast shadow reaches the receiver). Remaining CSM_DESIGN slices: normal-shading clamp + altitude-adaptive splits (Slice 3) + VSM. **NEW-TAA-PIPELINE-ORDER-RECONCILE** (pre/post-tonemap decision + clamp retune), **NEW-POSTPROCESS-USER-WARN-PROD** (user GLSL stages silently dropped — un-strip the warning).
- Gate: WebGL-vs-WebGPU material/shadow visual-diff probes.

## Phase 8 — Performance sweep

- Globe: ✅ **NEW-GLOBE-DYNAMIC-OFFSET-UBO** (Batch 292 — group-0 camera/tile UB on a dynamic-offset BGL; the Batch-241 cache now keys on ring-page identity only, so group-0 bind-group creations during sustained panning dropped from ~15/120f to 0, cache capped at ~pageCount entries). ✅ **NEW-GLOBE-RENDERBUNDLE-CACHE** (Batch 292 — dropped the inline per-frame globe render bundle: it was ~0.3-0.4 ms/frame net-NEGATIVE with worse p90, and can't be cached because per-tile dynamic UB offsets are baked into the recorded commands and rotate each frame; `executeGlobeDispatch` now goes straight to `executeBatch`).
- **FORK-41** dormant compute activation (HiZ + OcclusionTest — "5-20× on dense 3D Tiles" left on the floor), **NEW-POINTCLOUDLOD-SLOT255-OFFBYONE** (real correctness bug at full workgroups).
- Cache hygiene: **NEW-BINDGROUPCACHE-EVICTION**, **NEW-RENDERBUNDLE-AGING-DECOUPLE**, **NEW-RESOURCEMANAGER-KEY-EVICTION**; clustered: **NEW-CLUSTERED-ASSIGN-BOUNDS-DIRTY**, **NEW-CLUSTER-MULTIFRUSTUM-BOUNDS**; **NEW-MODEL-VS-MOTION-GATE**, **NEW-CAMERA-JITTER-ACCUMULATION**, **NEW-DECOUPLEDSCAN-FORWARD-PROGRESS-GUARD**.
- Gate: CesiumDebug.gpuPassCost/cpuPassCost before/after numbers per item.

## Phase 9 — Upstream alignment (fix-forward lens, FORK_DRIFT_ANALYSIS)

- Remaining drift items: **PickId rebase assessment**, Model3DTileContent double-conversion strategy, **NEW-CAMERA-JSDOC-RESTORE** + adopt upstream **sg-scan** lint, **NEW-SHADOWMAP-COMMENT-RESTORE**, **NEW-WEBGL-REPROJECT-BASELINE**, **NEW-SYNC-MOVEMAP** (runbook).
- Then THE upstream merge (v1.142+) via the Upstream Sync Procedure, planned around the breaking changes (Node 22, `Buffer*` readonly props) + adopt EXT_structural_metadata vector tiles, OffscreenCanvas imagery.

## Phase 10 — Entity-scale integrations (the large-dynamic-objects on-ramp)

- **Entity/CZML bulk fast-path** (50k entities → flat buffers without per-entity visualizer cost), **SampledPositionProperty/Clock → GPU keyframe-interpolation kernel** (second ComputeInstance kernel family), **EntityCluster-on-GPU** (mandatory for 50k labels; reuse GPU sort/cull), **orbit paths/trails** (GPU-computed polylines), **LOD chain** (point → impostor → instanced model; ties to vegetation design).

## Phase 11 — Maintainability & architecture debt

- **NEW-TS-CONVERT-JS-RENDERERS** (Model renderer first), **NEW-COLLECTION-RENDERER-BASE** (fold the resident-instance manager into a shared base, ~3000 LOC dedup), SceneRenderer god-object residual (WEBGPU_CONTEXT_DECOMPOSITION_PLAN), **NEW-COLLECTIONS-ERROR-SENTINELS** (the three mandated permanent sentinels), **NEW-CAPABILITY-GETTER-CODIFY** (migrate remaining isWebGPU branches), **NEW-INDEXWGSL-CHURN**, >1000-LOC decompositions, doc-currency sweep (FEATURE_INVENTORY / DEBUGGING_GUIDE / README index).

## Phase 12 — Bug bash & small improvements (the long tail)

- Remaining med/low ultra-review residue: **NEW-USEWEBMERCATORT-SINGLE-SOURCE**, **NEW-UPLOADIMAGESOURCE-OBSERVABILITY**, **NEW-RAYSPHERE-PRECISION-BACKPORT** (WebGL2 backport), **NEW-BILLBOARD-UPDATEMODE-ORDERING**, **DP-H47** (czm_atmosphere auto-uniform suite), plus a fresh mini-audit to re-triage anything the campaign made stale.
- Backport table follow-ups from the ultra-review §5 (WebGL2 candidates worth the port).

## Phase 13 — GATED: ECS-in-WASM-on-worker

- Only if **NEW-ECS-WORKER-GATING-SPIKE** (main-thread WASM-encode ceiling measurement, cheap) proves regimes 2+3 don't cover the real workload. Includes the COOP/COEP/SharedArrayBuffer decision. Otherwise: close as unnecessary.

---

**Standing rules for every phase:** probe-gated commits, no push until orchestrator review; tracking docs updated in-stage; riskiest stage last; revert-don't-ship-broken; batch numbers continue monotonically. After each phase, re-triage: items the phase obsoleted get closed, new findings get IDs.
