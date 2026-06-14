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

## Phase 5 — Orbital / compute-instance productionization

- Kernel-level: **NEW-ORBITAL-J2-KERNEL** (+ df64 angle/trig helpers injectable into the scaffold), GMST Earth rotation, then **NEW-ORBITAL-SGP4-KERNEL** (L; FP64 pre-conditioning + reference vectors).
- Generic-system: **NEW-ORBITAL-GPU-PICKING** (GPU pick pass for storage-buffer instances), **NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK** (WASM-on-worker writing the same instance records), **NEW-ORBITAL-DEVICE-LIMITS-PROBE** (1M-element validation).

## Phase 6 — Picking parity completion

- **NEW-PICK-RAY-ASYNC** (pickFromRay/sampleHeight/clampToHeight async path + oneTimeWarning), **NEW-PICK-METADATA-READBACK** (pickMetadata/pickVoxelCoordinate stale-pixel fix), endAsync `_readbackInFlight` guard.
- Depends on Phase 2 (depth reconstruction). Gate: full pick API probe matrix WebGL vs WebGPU.

## Phase 7 — Shading & material parity

- Model PBR: **NEW-MODEL-IBL-BRDF-LUT** (wire the generated-but-unconsumed LUT split-sum), **NEW-MODEL-IBL-REFERENCE-FRAME** (stop reflections rotating with camera), **NEW-MODEL-DIRECT-BRDF-PARITY** (Smith-joint + f90).
- **NEW-SPLAT-SORT-CONSUME-INDEXES** (Gaussian splats render unsorted), **NEW-CSM-SOFT-SHADOW-PCF** (+ remaining CSM_DESIGN slices), **NEW-TAA-PIPELINE-ORDER-RECONCILE** (pre/post-tonemap decision + clamp retune), **NEW-POSTPROCESS-USER-WARN-PROD** (user GLSL stages silently dropped — un-strip the warning).
- Gate: WebGL-vs-WebGPU material/shadow visual-diff probes.

## Phase 8 — Performance sweep

- Globe: **NEW-GLOBE-DYNAMIC-OFFSET-UBO**, **NEW-GLOBE-RENDERBUNDLE-CACHE** (getOrCreate or drop the inline bundle).
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
