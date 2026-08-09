# Voxel / Point Cloud / Gaussian Splat — WebGPU Parity Audit + Adoption Survey (2026-08-09)

**Provenance:** maintainer ask 2026-08-09 ("audit voxel, point cloud, and gaussian rendering in WebGPU
... parity with WebGL in both code and functionality ... any new cutting edge features").
Executed by a 20-agent read-only workflow (`wf_8b446052-63c`): 7 sweeps (3 code-parity, ledgers,
verification evidence, 2 research), 12 adversarial verifications of load-bearing parity claims,
1 synthesis. Every in-repo claim carries a file:line citation. The five untracked defect rows this
audit surfaced were filed in DEFERRED_WORK.md in the same landing.

---

# Maintainer Decision Packet — Voxel / Point Cloud / Gaussian Splat: WebGPU Parity + Cutting-Edge Adoption
*Synthesized 2026-08-06 from read-only sweeps at HEAD. All claims cited; sizes S/M/L; no new IDs invented for tracked work.*

---

## 1. HEADLINE

- **VOXELS — PARTIAL parity, STRONGLY-but-STALE verified.** Shipped core (3 shapes, per-cell pick, SSE refinement to depth 3) is probe-certified byte/IoU-level, but every recorded run is 2026-07-02..17 (WEBGPU_DEBUGGING_LOG.md:14751), the inventory self-declares WIP/PARTIAL (FEATURE_INVENTORY.md:614-615), and a P0 defect (camera-inside → black) plus a large tracked API-hole cluster stand open.
- **POINT CLOUDS — SPLIT parity, WEAK-to-MODERATE verification.** Dedicated (TimeDynamicPointCloud) path is near-parity for attenuation+EDL; the *model path that serves all 3D Tiles PNTS* silently loses attenuation, EDL, and style expressions on WebGPU; an OPEN drifting 27-45% color tint (DEFERRED_WORK.md:9270) and three probes that print GATE FAIL yet exit 0 (DEFERRED_WORK.md:512-519) make the standing green unauditable.
- **GAUSSIAN SPLATS — NEAR-PARITY, STRONGEST and FRESHEST verification of the three.** Mutation-tested production-asset harness, 2026-08-07 Edge numbers: cube 0.000% / tower 0.017% vs 3% (QUEUE_2026-08-02_CAMPAIGN15.md:491-493, 533-535); WebGPU *exceeds* WebGL (picking, TAA, fog); remaining tail is verification (G6 gate never executed, G7 unverified, G8 unarmed, tower frame-variance class) plus one code gap (splitDirection).

---

## 2. PER-SUBSYSTEM PARITY TABLES

**Legend — verified?:** `probe(stale)` = recorded PASS 2026-07-02..17 only; `code` = implementation confirmed, never pixel-verified; `fresh` = 2026-08-07/08 Edge run. **Functionality parity requires a `probe`/`fresh` entry; `code` alone is code parity only.**

### 2a. Voxels (WebGPUVoxelRenderer.ts — independent proxy-cube ray-marcher, not a GLSL port)

| Feature | WebGL | WebGPU | Verified? | Citation |
|---|---|---|---|---|
| FR routing, no dead WebGL fallthrough | n/a | ✅ | code | VoxelPrimitive.js:461-476 |
| BOX shape geom + shapeUv (bit-identical chain) | ✅ | ✅ | probe(stale) IoU 0.986, L1 0 | WebGPUVoxelRenderer.ts:514-519,714-729; WEBGPU_DEBUGGING_LOG.md:14751 |
| ELLIPSOID / CYLINDER shells + UV | ✅ | ✅ core; lon/lat/angle **render bounds NOT intersected**; refinement root-only | probe(stale) | WebGPUVoxelRenderer.ts:425-443,454-489,503-512 |
| Per-cell scene.pickVoxel (through L3, byte-identical pack) | ✅ | ✅ | probe(stale) byte-equal | WebGPUVoxelRenderer.ts:1174-1332,3722-3789 |
| Octree depth | arbitrary (octree textures) | **capped depth 3** (585-slot atlas) | probe(stale) to L3 | VoxelTraversal.js:195-256 vs WebGPUVoxelRenderer.ts:752-780; DEFERRED_WORK.md:7464-7519 |
| Streaming / eviction | 128-512 MB megatexture budget | demand ladder, **L2-only LRU** | probe(stale) | WebGPUVoxelDataUpload.ts:825-939 |
| Metadata properties | one megatexture per property | **property 0 only** | code | WebGPUVoxelDataUpload.ts:84-85 |
| User CustomShader | GLSL + uniforms + colorMap | **native-WGSL only**; GLSL/uniforms → silent gray | probe(stale, WGSL leg only) | WebGPUVoxelRenderer.ts:1455-1489; DEFERRED_WORK.md:9317-9328 |
| ClippingPlaneCollection | ✅ | ❌ | code | grep 0 hits; VoxelRenderResources.js |
| levelBlendFactor blending | ✅ | ❌ | code | VoxelTraversal.js:282-288 |
| Time-dynamic keyframes | ✅ | ❌ (keyframe hardcoded 0) | code | WebGPUVoxelDataUpload.ts:454-460 |
| Ortho camera / vert. exaggeration / depthTest ray-clip / stepSize / events+stats+debugDraw | ✅ | ❌ (cluster) | code | VoxelFS.glsl:118-140; VoxelPrimitive.js:494; WebGPUVoxelRenderer.ts:2765-2770,3247-3259 |
| Camera inside volume | renders interior | **BLACK** | open defect | DEFERRED_WORK.md:7595-7605 |
| IGN jitter, TAA velocity, aerial fog | — | ✅ EXCEEDS | code | WebGPUVoxelRenderer.ts:782-797,3562-3628,993-1033 |

**Functionality parity:** 11-probe fleet all PASS *at last run* (DEBUGGING_GUIDE.md:1001-1007) — 3-5 weeks stale; no capture-and-diff baseline scene; 2026-08-08 readme run is presence-only (27.0% non-black, no WebGL comparison).

### 2b. Point clouds (three paths: A = 3D Tiles PNTS→Model pipeline; B = TimeDynamicPointCloud→dedicated renderer; C = BufferPointCollection)

| Feature | WebGL | WebGPU | Verified? | Citation |
|---|---|---|---|---|
| Attenuation family (path B) | ✅ | ✅ formula-mirror incl. 2D/ortho | probe(stale, **gain-normalized**) B490 | WebGPUPointCloudRenderer.ts:325-334,1583-1609 |
| Attenuation / pointSize (path A — all PNTS tilesets) | ✅ | ❌ **fixed 1 px** (WGSL stage orphaned) | code | PointCloudStylingPipelineStage.js:118-200; DEFERRED_WORK.md:9285 |
| EDL (path B) | ✅ | ✅ full offscreen path | probe(stale) B465; probe exits 0 on FAIL | WebGPUPointCloudEyeDomeLighting.ts:439-488; DEFERRED_WORK.md:512-519 |
| EDL (path A — tileset EDL) | ✅ | ❌ **silently inert** (only `_edlSource`-tagged commands recorded) | code | PointCloudEyeDomeLighting.js:61-72 |
| Draco (path A) | ✅ | ✅ shared CPU decode | code | PntsLoader.js:149-208 |
| Draco (path B) | ✅ | ❌ **never renders, never ready** | code | PointCloud.js:218-232, PntsParser.js:296-320 |
| Per-point GPU style expressions (both paths) | ✅ | ❌ constant CPU pointSize only | code | PointCloud.js:1109-1178 vs :197-217 |
| Batch-table per-feature styling + picking (path A) | ✅ | ✅ | code (+B141 fix) | WebGPUModelFeatureId.js; WebGPUModelRenderer.ts:7948-7975 |
| Color decode (path B) | RGB/RGBA/RGB565/CONSTANT_RGBA + translucency | **RGB-stride-3 only**; RGBA misread, RGB565→white, always opaque | code | WebGPUPointCloudRenderer.ts:1125-1135,1661 |
| Color fidelity (path B) | reference | **27-45% bright/blue, session-drifting** — OPEN | probe-measured | DEFERRED_WORK.md:9270 |
| normalShading / backFaceCulling (path B) | ✅ | ❌ (no normals in 40-byte layout) | code | PointCloud.js:98-103; WebGPUPointCloudRenderer.ts:1158-1216 |
| BufferPointCollection (path C) | ✅ | ✅ | code | renderBufferPointCollection.js:26-36 |
| GPU LOD/cull, GPU sort, velocity, log-depth+fog | — | ✅ EXCEEDS (opt-in) | probe(stale) lod PASS | WebGPUPointCloudLODProcessor.ts:1-28 |
| POINTS shadow topology | ✅ | ✅ (C11-90) | code | DEFERRED_WORK.md:9286 |

**Functionality parity:** weakest of the three — last visual parity numbers 2026-07-01..02, standing gate normalized around an open visible divergence, no fork Sandcastle demo, no baseline scene. NOTE: FEATURE_INVENTORY.md:611 "pnts/3D-tiles (SHIPPED)" for WebGPUPointCloudRenderer is drift — that renderer serves only path B.

### 2c. Gaussian splats (C15-G track, post-Batch 916)

| Feature | WebGL | WebGPU | Verified? | Citation |
|---|---|---|---|---|
| SPZ/glTF loading (KHR + spz_2) | shared | shared | fresh | GltfSpzLoader.js:15-19,70-80 |
| 32-byte WASM packed records | RGBA32UI texture | storage buffer, **verbatim** | fresh 0.000% cube | gaussianSplatTextureGenerator.js:24-30; G3 QUEUE:533 |
| Async WASM radix sort + provenance guards | ✅ | ✅ | fresh, ⚠ count-not-timing caveat (G4) | GaussianSplatPrimitive.js:309-321; QUEUE:534 |
| SH degrees 1-3 (bit-identical coeffs, shared budget) | ✅ | ✅ | fresh B916, non-vacuity proven | QUEUE:483-493 |
| Premultiplied blend + inline GAUSSIAN_SPLATS pass | ✅ | ✅ mirror | fresh 0.017% tower | GaussianSplatPrimitive.js:2323-2327 |
| Tile streaming / SSE / hard-cap / snapshot machine | shared | shared | fresh | GaussianSplat3DTileContent.js:29-30 |
| Multi-frustum depth compose | ✅ | mechanism fixed (B889); **written gate never executed** | G6 PARTIAL | WebGPUGaussianSplatRenderer.ts:1891-1912; QUEUE:536 |
| Classification depth | ✅ | wired, **UNVERIFIED on production data** | G7 PENDING | WebGPUGaussianSplatRenderer.ts:73-84; QUEUE:537 |
| splitDirection split-screen discard | ✅ | ❌ (grep 0 in renderer/WGSL) | code | PrimitiveGaussianSplatVS.glsl:195 vs WebGPUGaussianSplatRenderer.ts |
| Picking | ❌ (unpickable) | ✅ primitive-level — EXCEEDS | code | GaussianSplat3DTileContent.js:543-545,584-586 |
| TAA velocity, aerial fog, log frag_depth, opt-in OIT | — | ✅ EXCEEDS | code | WebGPUGaussianSplatRenderer.ts:913-1014,826-860,2677-2716 |

**Functionality parity:** the only subsystem with fresh, mutation-tested (217+ node checks), dual-mode cross-backend certification. Tail: G8 thresholds measured-not-armed; tower legs structurally blocked by C15-GSPLAT-TOWER-FRAME-VARIANCE (~0.055% on BOTH backends vs 0.050% bar; DEFERRED_WORK.md:1507-1511) — under the R-7 30-batch escalation clock (MAINTAINER_RULINGS_2026-08-10.md:141-145).

---

## 3. GAPS (ranked by user impact)

1. **Voxel camera-inside-volume black** — flying into any volume blanks the primitive. **M.** Tracked: **C11-13** (P0, W1, NOT STARTED) / NEW-VOXEL-INSIDE-CAMERA-BLACK (DEFERRED_WORK.md:7595-7605).
2. **3D Tiles PNTS composite loss (path A): 1 px points, inert EDL, no style expressions** — the dominant real-world point-cloud usage looks like unlit dust and ignores `pointCloudShading` on WebGPU. **L.** Tracked in part: style compiler = **C11-86** (P2); attenuation quad-expansion scaffolding recorded do-not-remove at DEFERRED_WORK.md:9285 but **no open row**; **EDL-inert is untracked — needs a filed row** (the silent no-op is the worst part).
3. **Dedicated-path color correctness: 27-45% drifting tint + format decode (RGBA misread / RGB565 white / CONSTANT_RGBA ignored / translucency lost)** — every TimeDynamicPointCloud visibly wrong; the sprite gate is normalized *around* it. **M.** Tracked only as candidate **PARITY-POINTCLOUD-COLOR-TINT** (DEFERRED_WORK.md:9270, never filed) — file it; format decode is untracked.
4. **Dedicated-path Draco: silent永 hang** — draco TimeDynamicPointCloud never renders and never reports ready. **M.** **Untracked — needs a row.**
5. **Splat verification tail (G6 gate unexecuted / G7 unverified / G8 unarmed / tower frame-variance)** — parity claim rests on it; classification-on-splats could be wrong today. **S-M (verification work).** Tracked: **C15-G6/G7/G8** + C15-GSPLAT-TOWER-FRAME-VARIANCE; Lane D order in CLOSEOUT_PLAN_2026-08-07.md:123-139.
6. **Voxel octree depth>3, non-BOX refinement root-only, L3 LRU** — deep zooms stay coarse forever; ellipsoid/cylinder volumes never refine. **XL.** Tracked: **C11-100** / PARITY-VOXEL-OCTREE-TRAVERSAL (sliced; incl. untriaged megatexture PART-3 red at HEAD, DEFERRED_WORK.md:7533-7537).
7. **Voxel customShader residuals** — upstream GLSL shaders, uniforms, colorMap all silently gray. **M.** Tracked: **C11-108** / VOXEL-USER-CUSTOMSHADER-RESIDUALS (DEFERRED_WORK.md:9317-9328).
8. **Voxel API cluster: clippingPlanes, keyframes, levelBlendFactor, ortho, vertical exaggeration, depthTest ray-clip, stepSize, events/statistics/debugDraw** — each a documented public API that silently no-ops. **L cumulative.** Partially covered by the C11 W7 voxel block (C11-101..107); per-feature coverage should be confirmed at C11 intake against FEATURE_INVENTORY.md:614-615 — no new IDs needed where rows exist.
9. **Splat splitDirection missing** — ImagerySplitter-style comparisons show splats on both sides. **S.** **Untracked — needs a row** (natural post-G8 G-track rider).
10. **Verification integrity: 3 probes exit 0 on GATE FAIL** (tracked OPEN: NEW-PROBE-VERDICT-PRINTS-FAIL-AND-EXITS-ZERO, DEFERRED_WORK.md:512-519) **+ zero capture-and-diff baseline scenes for all three subsystems** (untracked) **+ voxel/pointcloud probe staleness.** **S to fix, highest leverage per hour** — it re-arms trust in everything above.

---

## 4. CUTTING-EDGE ADOPTION CANDIDATES (ranked payoff/cost for a geospatial engine)

All new code to the **C16 comment standard**; note C16-10 (splat/point/compute rewrite shard, PENDING) will rewrite these very files' embedded WGSL (worst census: voxel 60 / pointcloud 29 / splat 22 markers, QUEUE_2026-08-10_CAMPAIGN16.md:29) — sequence adoption edits to land either before or after that shard, not interleaved. Gsplat items queue in the **G-track lane (ruling R6, NOT under the R4 aurora hold)** but **post-G8**, because every G row carries a byte-identical-WebGL-off gate until the terminal gate closes.

1. **Continuous LOD (CLOD) keep-function for the point-cloud GPU LOD layer** — replaces 4-band decimation (PointCloudLOD.wgsl:20-25) with `keep = hash(id) < f(dist)`; kills band-boundary popping in a fork-differentiating feature (WebGL has no LOD layer — additive WEBGPU-EXCEEDS, parity-principle clean). **Cost S.** Queue: new proposed row, no deps. Acceptance: camera-dolly probe asserting no kept-set discontinuity at former band radii + negative control restoring bands.
2. **Voxel empty-space skip via per-slot min/max occupancy** — the march currently fixed-steps the whole volume (VoxelRayMarch.wgsl:39-43 pattern in VOXEL_WGSL); occupancy metadata per atlas slot skips empty bricks. Lossless — performance-principle safe. **Cost S-M.** Queue: new proposed row; natural first slice riding **C11-100**. Acceptance: interleaved-A/B GPU timing (C13-39 doctrine) on a sparse asset + byte-identical output on a dense asset.
3. **Brickmap / per-level page-table atlas generalization** — this IS the codebase's own named follow-up (WebGPUVoxelDataUpload.ts:79-83) and simultaneously removes the depth-3 cap, un-gates non-BOX LOD, and produces the occupancy data for item 2. **Cost M.** Queue: **as the implementation vehicle for existing C11-100** — no new ID. Acceptance: probe-voxel-octree-l3plus extended to depth 4-5 with discriminator assets.
4. **SH distance-band truncation (splats)** — evaluate degree 1 far / 3 near through the backend-neutral `applySphericalHarmonicsBudget` seam (G5 option-a precedent: both backends degrade together); cuts the tower's 8.6M-word SH buffer + VS ALU at globe zoom-out. **Cost S.** Queue: new post-G8 G-track row. Acceptance: parity-harness near/far azimuth legs identical cross-backend + byte-identical-off.
5. **Mip-Splatting opt-in (splats, both backends)** — both backends currently ship vanilla +0.3 dilation with no compensation (PrimitiveGaussianSplatVS.glsl:124-126 and WGSL twin); Mip-Splatting fixes distant-splat aliasing/over-brightening — the globe-critical splat quality item. Shader-only, portable GLSL+WGSL, default-off. **Cost S-M.** Queue: new post-G8 G-track row. Acceptance: cross-backend parity ON at both gate assets + off-gate byte-identical.
6. **GPU radix sort for splats** — removes sort-staleness popping during fast slews (throttle: ~0.5°/1 m/3-frame, GaussianSplatPrimitive.js:157-162); subgroups now shipped and already auto-requested (WebGPUFeatureFlags.ts:40-73). WebGPU-side perf path; WebGL keeps the shared worker sort (order converges — no visual divergence). **Cost M.** Queue: new post-G8 G-track row **discharging BACKLOG §11** (explicit G4 non-goal until then). Acceptance: frozen-camera index byte-equivalence vs worker sort + **interleaved A/B timing** (do not repeat G4's count-for-timing substitution).
7. **Multi-scale EDL, then AO-over-EDL-depth (point clouds, both backends where portable)** — assembled from landed pieces (r32float EDL FBO WebGPUPointCloudEyeDomeLighting.ts:86-90, AO effect, GBufferNormalsFromDepth). **Cost S then M.** Queue: new proposed rows, **dependency: gap #3 (color tint) and the probe exit-code fix first** — do not build atop a divergent, unauditable baseline. Acceptance: extended EDL parity probe with real exit codes.
8. **HiZ occlusion wiring for the point/tile path** — finishes built infra (dispatcher docstring: JS treat-all-visible still authoritative, WebGPUHiZOcclusionDispatcher.ts:30-34). **Cost M.** Queue: existing **FORK-41 / FEATURE_INVENTORY §D** consumer-wiring items (adjacent to C11-98) — no new ID. Acceptance: culled-count probe + zero-visual-change gate.
9. **Two-pass u32 compute point rasterization behind the existing count threshold** — the scale unlock for 100M+ points; single-pass Schuetz is blocked (no 64-bit atomics in WebGPU). Reuses SOA buffers, scan/compact, threshold gate. **Cost M-L.** Queue: new proposed row after 1 and 8. Acceptance: parity vs quad path at the threshold boundary + interleaved perf A/B.
10. **Ray-guided residency feedback for voxel streaming** — atomic miss-flags + readback ring (patterns already proven in GPUCuller) feeding the existing demand ladder; requires convergence-frame scheduling under request-render. **Cost S-M.** Queue: new proposed row after 3.
**Watch / defer / non-goals:** SPZ-4 loader compat check (S, watch); StochasticSplats sort-free spike (M-L, post-G8, fits STBN+TAA infra); temporal half-res voxel march reusing cloud reconstruction (M); NanoVDB ingest (M-L, strategic); 2DGS (asset-ecosystem-gated); LiDAR-surfel via splat renderer (M, post-G8); SOG loader (defer — outside the 3D Tiles container); ray-traced 3DGS + 4DGS (recommend recording as explicit non-goals — no WebGPU RT API; animated splats already out per §6d).

---

## 5. RECOMMENDED SEQUENCE

Close the **splat tail first** (Lane D order: G7 machine-first → tower-variance by mechanism, bar not widened → owed G6 tower leg → arm G8): it is the cheapest path to one fully-certified subsystem, it discharges the standing R-7 escalation clock, and it unlocks the entire post-G8 adoption lane (items 4-6) plus the C11/C15 tracker reconciliation G8 owns. In parallel on the correctness side, take **C11-13** (P0) and **file + fix the point-cloud tint and the three exit-0 probes** — those two restore honesty to the weakest subsystem's green before anything is built on it. Start adoption immediately only where self-contained and additive (**CLOD, voxel empty-space skip**); land **brickmap as the C11-100 vehicle** when the C11 W7 wave opens; and add one voxel, one point-cloud, and one splat scene to the capture-and-diff baseline suite (S) so all three subsystems finally have a continuously-certified cross-backend gate instead of one-shot probe history.
