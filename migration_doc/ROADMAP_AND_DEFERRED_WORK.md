# Roadmap & Deferred Work — CesiumJS WebGPU Fork

> **Canonical doc (consolidation first draft, 2026 consolidation).**
> **Supersedes:** `DEFERRED_WORK.md` (the P0/P1/P2 tracker backbone), `CAMPAIGN_ROADMAP_2026-06.md`,
> `WEBGPU_EXECUTION_ROADMAP.md`, `WEBGPU_MIGRATION_BACKLOG.md`, `WEBGPU_PARITY_AUDIT_2026-06.md`,
> `CLOUD_TAXONOMY_ROADMAP.md`, `WEATHER_RECREATION_ROADMAP.md`, `WEATHER_DATA_INGEST_ROADMAP.md`,
> the **unshipped tail** of `ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md`, `RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`,
> `VEGETATION_SYSTEM_DESIGN.md` (roadmap portion), `WATER_RENDERING_DESIGN.md` (roadmap portion),
> `TIER5-6_EXECUTION_PLANS.md`, and `audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md` (roadmap portion).
> **Review-in-progress.** This is a FIRST DRAFT for maintainer review rounds. The archival of the
> superseded docs + the README/CLAUDE.md index updates happen *after* review.

---

> **ACCURACY NOTE (read first).** The source docs this consolidates are up to ~300 batches stale
> (most last refreshed between Batch 56 and ~185; HEAD is ~Batch 455). **Status tags below were
> RE-VERIFIED against the live code + `git log` at HEAD ~455**, not lifted from the source docs.
> Where a source asserted "WIP"/"deferred"/"blocked" but git shows the work landed, the status is
> corrected here. Where I could not confirm a status from git alone, it is marked **(status: verify)**.
> When in doubt, prefer the git-log batch reference cited inline.

---

## 1. How This Doc Works

### 1.1 Add-only ID discipline

Every outstanding work item carries a **stable ID** that is **add-only** — once minted, an ID is never
renumbered or reused, even after the work ships (it flips to a strikethrough / "✅ SHIPPED (Batch N)"
disposition but the heading stays for `grep`-ability). The ID prefixes:

| Prefix | Meaning | Origin |
|---|---|---|
| `NEW-*` | Fork-added WebGPU work item (the bulk) | `DEFERRED_WORK.md` |
| `C-R*` | "Command-renderstate" / renderer-tail audit series (C-R1…C-R12) | early migration audits |
| `DP-H*` | Deferred-parity "hard" items (atmosphere uniforms, metadata) | parity audits |
| `FORK-*` | Fork-vs-upstream drift findings | `FORK_DRIFT_ANALYSIS` |
| `BUG-*` | Tracked rendering bugs (also logged in `WEBGPU_DEBUGGING_LOG.md`) | debugging log |
| `FEAT-GAP-* / FEAT-SURVEY-*` | Feature-survey gaps (models, post-process) | feature surveys |
| `C2-* / Vn` | Campaign-2 batch IDs / Campaign-3-v2 cloud version tags | campaign queues |

**Rule:** add new IDs at the bottom of the relevant subsystem; never reorder or remove. This mirrors
the `ShaderDefine` bitmask add-only rule (CLAUDE.md → WGSL Shader Pipeline) and keeps cross-references
in `WEBGPU_DEBUGGING_LOG.md` / `FEATURE_INVENTORY.md` / git history valid forever.

### 1.2 Priority bands

- **P0** — foundational / unblocks others, or a correctness regression. Do first.
- **P1** — high value, usually depends on a P0.
- **P2** — polish, niche, or measured-perf-gated. Schedule deliberately.

A few items carry **P3** in the legacy `WEBGPU_EXECUTION_ROADMAP` (research/future); those are folded
into P2 + §11 (research pointers) here.

### 1.3 Relation to the other canonical docs

- **D3 (bugs):** active rendering bugs live in `WEBGPU_DEBUGGING_LOG.md` (chronological). `BUG-*` IDs
  here cross-reference it. Search the log before debugging a new artifact.
- **D4 (research):** explicitly research-stage / not-yet-scheduled work is *named* here (§11) but its
  detail lives in the research docs (`RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`,
  `FUTURE_RESEARCH_2026_05_01.md`, the design docs). This doc tracks the **decision to schedule**, not
  the research itself.
- **Feature inventory:** `FEATURE_INVENTORY.md` §A (existing) / §B (shipped) / §C (WIP) / §D (future)
  is the **load-bearing impact-analysis index** (CLAUDE.md Principle 6). When an item here ships, move
  its inventory row §C→§B; when a §D item becomes scheduled, move it §D→§C.

---

## 2. Active Master Roadmap (the ONE phase plan)

> **Reconciliation note.** Three source docs each independently listed "remaining work":
> `CAMPAIGN_ROADMAP_2026-06.md` (phases 1-13 + Track V), `WEBGPU_EXECUTION_ROADMAP.md` (the log-depth
> critical path), and `WEBGPU_MIGRATION_BACKLOG.md` (Phase-7 feature survey). They are **collapsed
> into the single phase table below**, with `CAMPAIGN_ROADMAP` chosen as the **current frontier**
> (it is the most recent and tracks the highest batch numbers). The `WEBGPU_EXECUTION_ROADMAP`'s
> headline ("the log-depth epic is the dominant remaining item") is **STALE** — that epic SHIPPED at
> Batch 251 (master switch flipped ON; see §4 Globe). The backlog's Phase-7 model/3D-tile items are
> folded into §4 (Models / 3D Tiles).

Campaign 2 (the `CAMPAIGN_ROADMAP` phases) is **functionally complete through Phase 13 + Track V**.
Campaign 3 (clouds/weather/atmosphere fidelity) is the **current active campaign**; its tail is the
live frontier (§8, §9). The table records each phase's verified disposition.

| Phase | Theme | Status @ HEAD ~455 | Gate / note |
|---|---|---|---|
| **1** | Point/Label partial-write, Cloud gate, TAA velocity, compute-instance BV+velocity, bloom parity, globe bind-group cache, CI smoke | ✅ DONE (Batches 232–242) | all gates green |
| **2** | **The log-depth epic** — `NEW-DERIVEDCOMMAND-VARIANT-FACTORY` + `NEW-COLLECTIONS-LOG-DEPTH` + `NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION` | ✅ SHIPPED — **master switch ON Batch 251**; geometry/opaque producer sweep Batches 264–267 | far-camera + pickPosition + collections-regression + globe probes green. **Supersedes the entire `WEBGPU_EXECUTION_ROADMAP` "spine."** Residuals: pointcloud/splat producers + off-by-default consumers (§4) |
| **3** | 2D / Columbus View / morph collections | 🟡 **PARTIAL — active** | per-frustum camera-UB foundation (Batch 261), projected-frame RTE + log-depth-consistency (Slice 2), CV coplanar fix (Slice 2b) all landed; **SCENE2D collections still blocked** by a globe-pass issue. See `NEW-COLLECTIONS-2DCV-*` (§4 Collections) |
| **4** | Large Dynamic Objects — flat-buffer + WASM (regime 2) | ✅ CORE SHIPPED (Batches 270–273) | win = position-encode HOIST (not WASM SIMD); WASM kernel still doesn't load in-bundle (`NEW-WASM-BRIDGE-BUNDLE-LOAD`, §6) |
| **5** | Orbital / compute-instance productionization | ✅ DONE (Batches 277–283) | df64 J2 15 m/30 d, SGP4 55 m/1440 min, 1,000,000-instance probe; WebGL2 CPU-kernel fallback |
| **6** | Picking parity completion | ✅ CORE SHIPPED (Batches 284–286) | sampleHeight/clampToHeight, pick-metadata readback, compute-instance pickPosition. **Open:** arbitrary-ray `pickFromRay` position; live voxel-coordinate + metadata-over-tileset (§4 Picking) |
| **7** | Shading & material parity (Model PBR, CSM) | ✅ CORE SHIPPED (Batches 287–298, 326, 355–358) | IBL split-sum, direct-BRDF parity, CSM cast+globe-receive fixed. **Open:** `NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU` (blocked by `NEW-WEBGPU-KTX2-TRANSCODER-FORMATS`), CSM Slice-3 splits/VSM (§4 Shadows) |
| **8** | Performance sweep (globe UBO/bundle, cache hygiene) | ✅ CORE SHIPPED (Batches 292–293) | dynamic-offset UBO, bind-group-cache eviction, pointcloud-LOD off-by-one. **Open:** FORK-41 dormant-compute activation (resolved as C2-21, see below), clustered-lighting bounds items (§6) |
| **9** | Upstream alignment (fix-forward drift) | ✅ small pulls SHIPPED (Batch 299); **the big merge landed** v1.142 (`d06742a2ac`) | remaining drift items in §5; `NEW-SG-SCAN-ADOPT` deferred |
| **10** | Entity-scale integrations (bulk fast-path) | ✅ POINTS + BILLBOARD/LABEL SHIPPED (Batches 300, 333); EntityCluster GPU bin/count (301, 308) | **Open:** `NEW-ENTITY-BULK-CZML-HINT`, `NEW-ENTITY-GPU-KEYFRAME-KERNEL`, full GPU EntityCluster merge, orbit paths/trails (§4 Collections) |
| **11** | Maintainability & architecture debt | 🟡 PARTIAL — ongoing | `NEW-COLLECTION-RENDERER-BASE` ✅ COMPLETE (Batch 332, 5/5); `NEW-CAPABILITY-GETTER-CODIFY` ✅ (Batch 303). **Open:** `NEW-TS-CONVERT-JS-RENDERERS` (bulk JS renderers), SceneRenderer decomposition, `NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE` (§4 Build) |
| **12** | Bug-bash & long tail | ✅ tractable set SHIPPED (Batch 304) | **Open:** `DP-H47` (czm_atmosphere auto-uniform suite), `NEW-CAMERA-UPDATEVIEWMATRIX-REVERT` (merge-time) (§4 Build, §12) |
| **13** | GATED: ECS-in-WASM-on-worker | ❌ **NO-GO, CLOSED (Batch 305)** | gate spike proved regimes 2+3 cover the workload; all `NEW-ECS-*` + `NEW-COOP-COEP-SAB-ENABLE` closed as not-needed |
| **Track V** | Celestial & Atmosphere Visual Fidelity (Takram-inspired) | ✅ FOUNDATION SHIPPED (Batches 306–313) | full-Bruneton LUTs, aerial-perspective post-process, atmosphere-derived lighting, bright-star catalog. **Continued by Campaign 3** (§8, §9) |
| **Campaign 3** | Clouds + weather + atmosphere/reflection quality | 🟡 **ACTIVE FRONTIER** | tiered clouds V0-V16 ✅, weather P0-P3 ✅, atmosphere improvement-plan P0-P4 ✅, C2-25 reflections epic ✅. **Open tail = §8 (clouds/weather forward) + §9 (atmosphere/reflection)** |

### 2.1 Campaign-2 Tier-5/6 batch items (from `TIER5-6_EXECUTION_PLANS.md`)

| ID | Item | Status @ HEAD ~455 |
|---|---|---|
| **C2-21** | `FORK-41` Hi-Z occlusion consume-flip | ✅ RESOLVED — depth-source bug fixed; command-drop now DEFAULT ON, verified (root cause was a MAX-pyramid footprint-coverage bug, not the Y-flip suspicion) |
| **C2-22** | Error-pipeline fallback (magenta on pipeline-validation failure) | ✅ RESOLVED — core Batch 388, color-pass extended Batch 418; pick/velocity/classification fallbacks remain a deferred follow-up |
| **C2-23** | `DP-H18` depthFailAppearance | ✅ SHIPPED — color slice Batch 390, MATERIAL twin Batch 419 |
| **C2-24** | Collections far-surface depth | ✅ CLOSED (already shipped Batches 249-251) |
| **C2-25** | Dynamic scene-content environment map (`NEW-DYNAMIC-ENVMAP-FULL-SCENE`) | ✅ EPIC CLOSED — capture 446-448, temporal 449, clouds-in-IBL 450, parallax 451 (§9). **Residual:** `ENV-CAPTURE-PER-FACE-LOD` (§9) |

---

## 3. Critical Path

The single critical-path spine that the `WEBGPU_EXECUTION_ROADMAP` was built around — **renderer-wide
log depth** — is **DONE** (Batch 251 flip; producer sweep 264-267). That doc's entire §1-§5 framing
("the dominant work item is the log-depth epic", "3-4 weeks of slices") is **superseded** and should
be archived, not followed.

**Current critical path** (what actually gates the most downstream work today):

1. **`NEW-WEBGPU-KTX2-TRANSCODER-FORMATS`** (S–M, §4 Models) — registering WebGPU transcode target
   formats during `WebGPUContext` init. **Unblocks** `NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU` (authored env
   maps) and **any** WebGPU KTX2 consumer. Small, high-leverage, no dependencies. **Do first.**
2. **`DP-H46c` pickMetadata producer** (L, §4 Picking) — the consumer half + the per-model WGSL
   structural-metadata codegen prereq (DP-H46a/b) **shipped** at Batches 454/455; DP-H46c is the
   remaining producer. Gated on a local `EXT_structural_metadata` test asset (network-free probe).
3. **AERIAL-FROXEL (2.3)** (L, §9) — the **only unshipped item** in the atmosphere/cloud improvement
   plan. Feeds `CLOUD-AERIAL-LUT` quality. The keystone `A-LUT-REPARAM` it depends on already shipped
   (Batch 428).
4. **Weather Phase 4** (GRIB2/NetCDF behind WASM, §8) — the high-fidelity data tier; gated on a
   same-origin proxy + WASM decode, the only remaining weather-ingest phase.
5. **Collections SCENE2D** (`NEW-COLLECTIONS-2DCV-*`, §4 Collections) — the last big visual-parity hole
   (CV now renders; SCENE2D billboard/point/label still blocked by a globe-pass issue).

Items 1-5 are mutually independent and can run in parallel.

---

## 4. Deferred Work Inventory by Subsystem

> Only **genuinely-open** items are listed. Resolved IDs keep their headings in `DEFERRED_WORK.md`
> for grep but are omitted here. Each open item: **ID** — one-line description — priority — note.

### 4.1 Globe & Imagery

The renderer-wide log-depth epic is **complete** (Batch 251 flip + producer sweep). Residual open items:

- **`NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT`** — the standalone `WebGPUPointCloudRenderer`
  (PNTS/EDL) + `WebGPUGaussianSplatRenderer` still write hyperbolic z (mis-sort vs log geometry only at
  FAR range). **P2.** _Note: splat half SHIPPED Batch 288; point-cloud producer SHIPPED Batch 377 — but
  see the blocker below._
- **`NEW-WEBGPU-TIMEDYNAMIC-POINTCLOUD-CONTENT-LOAD-ZERO`** (M, Batch 377) — `TimeDynamicPointCloud`
  loads ZERO content on WebGPU (`boundingSphere` never ready, `totalMemoryUsageInBytes===0` after 500
  frames) while WebGL loads at frame 1. Gates visual verification of the C2-7 log-depth producer (no
  points render to sort). **P1.** Next: trace `_loadFrame` → pnts parse → instance upload on WebGPU.
- **`NEW-LOG-DEPTH-REMAINING-CONSUMERS`** — off-by-default depth readers (AO/DoF/SSR/contact-shadows/
  god-rays) + GroundPolyline `windowToEyeCoordinates` precision must reverse log depth when enabled.
  **P2** (none break the default scene).
- **`NEW-WEBGPU-EXAG-WATER-STREAKS`** (Batch 362) — under high vertical exaggeration over mountainous
  terrain with glacial lakes (Himalayas, EXAG=10), WebGPU renders thin BRIGHT-BLUE water streaks WebGL
  lacks. Pre-existing ocean/water-tint parity gap, amplified by exaggeration. **P2.** Probe:
  `probe-exaggeration-3d.mjs`.
- **`NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH`** (S–M, Batch 327) — the WGSL ground-atmosphere drape's
  limb-width/falloff differs from WebGL's `GlobeFS.glsl` + `AtmosphereCommon.glsl` ground-atmo path
  (the SkyAtmosphere shell itself is at parity). Cosmetic limb-width at full-disc framing. **P2.**
- **`NEW-WEBGL-REPROJECT-BASELINE`** — WebGL imagery reprojection forked to per-fragment Mercator; needs
  a regression baseline. **P2** (drift bookkeeping).

### 4.2 3D Tiles

- **Voxels** — the entire WebGPU voxel **data path** is a placeholder (`WebGPUVoxelRenderer.ts` is a
  hardcoded RGB-density ray-marcher on a 4×4×4 gradient; `VoxelPrimitive.update` short-circuits). This
  blocks (a) the PR#13517 default-shader, (b) `C-R9-VOXEL-CELL-PICK`, (c) live voxel-coordinate pick
  parity. **P2/XL** — needs the real-voxel-data port as its own epic (provider/megatexture/octree +
  WGSL CustomShader transpilation). Do **not** build inert scaffolding (untestable, Principle 8).
- **Edge data parity** (`NEW-EDGE-DISPLAY-MODE-WEBGPU` is ✅ SHIPPED Batch 316; tri-mode core done) —
  **remaining open data paths:** explicit `lineStrings` edges (BENTLEY/styled-gltf-lines yield zero
  WebGPU edges), authored `silhouetteNormals` signed-byte accessor (WebGPU re-derives face normals →
  silhouette classification can diverge). Per-edge `materialColor` override ✅ SHIPPED (Batch 330). **P2.**
- **`NEW-MODEL3DTILECONTENT-DOUBLE-CONVERSION`** — Model3DTileContent class-converted on both fork and
  upstream; needs a double-conversion reconciliation strategy at merge time. **P2** (merge bookkeeping).
- **EquirectangularPanorama cull-override** (from `WEBGPU_PARITY_AUDIT`) — the material pipeline bakes
  `cullMode` from `appearance.closed` only, ignoring `renderState.cull.enabled:false`; a panorama viewed
  from inside shows back-faces or vanishes. Untracked (C-R1-PRIMITIVE-DERIVED excludes pipeline-cull).
  **P2** — needs a new ID + `WebGPUPrimitiveCommands.js` fix. **(status: verify — re-confirm against HEAD.)**

> **Note on the v1.141-1.143 parity-audit P1s:** the BufferPrimitive family `color.alpha` translucency,
> `blendOption` pass selection, and world-space `boundingVolume`/`debugShowBoundingVolume` were **all
> SHIPPED** (Batches 315-318); `GeoJsonPrimitive` probe + Sandcastle SHIPPED (Batch 318). The
> `WEBGPU_PARITY_AUDIT_2026-06.md` P1 table is therefore **closed**. Remaining parity-audit residuals
> are the BufferPolygon-family 2D/CV reprojection + `positionNormalized`/integer datatypes (P2, below).

- **BufferPolygon-family 2D/CV + integer/normalized positions** — buffer renderers encode RTE ECEF only
  (no 2D/CV reprojected attribute buffer; no integer/snorm/unorm path). A non-DOUBLE `positionDatatype`
  or `positionNormalized:true` collection is silently mis-encoded. **P2** — needs its own ID.

### 4.3 glTF Models + KHR Extensions

KHR extensions are **wired** on WebGPU (clearcoat/sheen/anisotropy/iridescence/transmission/volume/
texture-transform all ship real BRDF blocks — the old "silently dropped on WebGPU" claim is STALE).
Clustered Forward+ lighting + punctual lights also ship. Open:

- **`NEW-WEBGPU-KTX2-TRANSCODER-FORMATS`** (S–M, Batch 369) — **CRITICAL-PATH** (see §3). `loadKTX2`
  throws `"supportedTargetFormats is required"` for ANY KTX2 on a `WebGPUContext` (even uncompressed
  RGBA-half-float). Fix: register WebGPU `GPUFeatureName`→`KTX2Transcoder` target formats during
  `WebGPUContext` init. **P1.** Probe: `diag-ktx2-ibl-shape.mjs` + `probe-model-ktx2-ibl.mjs`.
- **`NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU`** (M, Batch 287) — authored KTX2 specular env maps don't load on
  WebGPU (procedural fallback used). **Blocked by** the transcoder-formats item above. **P1.**
- **`NEW-MODEL-WGSL-CUSTOM-SHADER`** — WGSL `CustomShader` API parallel to GLSL
  `CustomShaderPipelineStage` (WebGPU is a one-time-warning no-op). **Hard blockers** (verified): bind-
  group 1 is full (0-36), `maxBindGroups=4` maxed; numeric module cache key can't hold per-Model WGSL
  text; varying exhaustion (TAA uses @location 9-10). **P2** — ship a minimal fragment-only slice first.
- **`MORPH-MODEL-PROJECT2D`** — glTF Model accurate-2D (`projectTo2D:true`) has no WGSL equivalent. **P2.**
- **`NEW-MATAPPEARANCE-DIFFUSE-PARITY`** is ✅ SHIPPED (Batch 356); surfaced separately:
  **`NEW-WEBGPU-GRID-MATERIAL-PATTERN-MISSING`** — grid lines don't render on WebGPU (a pattern bug, not
  lighting). **P2.**
- **`KHR_BINDING_MANIFEST` follow-up** — per-extension granular pipeline split (the coarse
  `MODEL_HAS_KHR_TEXTURES` family gate ships; finer per-extension variants are the documented follow-up).
  **P2** (Phase-8 shader strategy).

### 4.4 Collections

- **`NEW-COLLECTIONS-2DCV-PROJECTED-FRAME-RTE` / `NEW-COLLECTIONS-2DCV-COPLANAR-DEPTH` /
  `MORPH-COLLECTIONS-AUDIT`** — **the last big visual-parity hole** (Phase 3). CV now renders elevated
  + coplanar billboard/point/label (Slices 2/2b, 2026-06-13); **SCENE2D collections still all-zero**,
  root-caused to a globe-pass issue. **P1.** Reproducer: `probe-collections-2dcv-morph.mjs`. Slice 3
  (morph `position2D`/`position3D` × `czm_morphTime` blend) also pending.
- **`NEW-COLLECTIONS-DIRTY-GATE`** — Billboard/Label rebuild + full-upload the entire instance buffer
  every frame. **ATTEMPTED + REVERTED (Batch 226)** — the dirty re-arm is entangled with the WebGL
  vertex-build reset sequence (a correct gate must replicate `_dirty` + `_createVertexArray` +
  `_billboardsToUpdateIndex` and stop the readiness loop re-pushing settled billboards). **P2** (perf).
- **`NEW-COLLECTION-RENDERER-BASE`** is ✅ COMPLETE (Batch 332, 5/5 renderers migrated).
- **`NEW-ENTITY-BULK-CZML-HINT`** (M) — surface the bulk fast-path at CZML/GeoJSON **ingest** time
  (skip the intermediate per-entity `PointGraphics`/`ConstantProperty` allocation). **P2.**
- **`NEW-ENTITY-GPU-KEYFRAME-KERNEL`** — `SampledPositionProperty`/Clock → GPU keyframe-interpolation
  kernel (the second ComputeInstance kernel family; the time-dynamic follow-up). **P2.**
- **`NEW-ENTITYCLUSTER-GPU-MERGE`** — the fully-GPU parallel cluster merge (union-find over the grid, no
  readback); GPU bin/count + parity-corrected CPU merge ship (Batches 301, 308). **P2.**
- **`NEW-ORBITAL-INVENTORY-TRACK`** (S) — add `NEW-ORBITAL-GPU-RESIDENT` to DEFERRED_WORK +
  FEATURE_INVENTORY (regime currently untracked). **P2** (bookkeeping).

### 4.5 Picking

- **`DP-H46c` pickMetadata producer** (L) — **CRITICAL-PATH** (§3). Consumer half + WGSL structural-
  metadata codegen prereq (DP-H46a/b) shipped (Batches 454/455). `DerivedCommand.createPickMetadata
  DerivedCommand` still short-circuits WebGPU; per-pick specialization must be data-driven (WGSL has no
  string-replace defines). **Asset gap:** needs a local `EXT_structural_metadata` test asset. **P1.**
- **`C-R9-VOXEL-CELL-PICK`** — blocked behind the real-voxel-data port (§4 3D Tiles); cell-pick is a
  1-2-session rider on it. **P2/blocked.**
- **arbitrary-ray `pickFromRay` position** — returns the hit object but no position (`oneTimeWarning`,
  no throw). Needs an offscreen GlobeDepth pack + per-view readback. **P2** (deferred until a consumer
  needs it).
- **`NEW-WEBGPU-POINT-COLLECTION-PICK`** is ✅ SHIPPED/VERIFIED-WORKING (Batch 323).
- **`MORPH-PICK`** (unverified) — pick during a morph is exercised by the transitioner itself; if the
  pick pass camera-UB doesn't carry the live `mode`/`morphTime`, `pickPosition` returns wrong coords →
  wrong final 2D camera. **P2 / (status: verify).**

### 4.6 Shadows / Lighting

CSM cast + globe-receive are **fixed** (Batches 296-298); soft-shadow PCF ships (289/297);
cascade-ground-fit ships (306). Open:

- **CSM Slice 3 — altitude-adaptive splits** — at orbital altitude λ=0.7 wastes 3/4 cascades on empty
  near-space; collapse/refit above ~500 km. **P2** (no log-depth dep). **(status: verify — not found in git.)**
- **CSM Slice 3 — moon dual-light** — single-sun CSM end-to-end; effects BGL is saturated (no room for a
  2nd CSM params UBO). Recommend night-only light-direction switch (Option C). **P2.**
- **VSM (variance shadow maps)** — `CSM_DESIGN.md` Slice; not started. **P2.**
- **`C-R10-CAST-LINEAR-DEPTH`** — point-light cube cast writes hardware perspective-Z; the "optimization"
  to linear `axisDist/farPlane` was triaged "NOT actionable-worthwhile" (writing `frag_depth` disables
  early-Z, likely net-negative). **P2 — recommend leave deferred.**

### 4.7 Post-process & Effects

- **`NEW-GPU-SORT-PIPELINE-PHASE-3`** — `_lastSortedIndices` readback runs but is consumed nowhere; the
  permutation indexes the *compacted* SOA, not the original command array. Fill a `compactedToOriginal`
  map + `skipped` list + `_applySortedOrder` (Principle 9 — finish the scaffolding). **P2.**
- **`NEW-VR-USER-POSTPROCESSSTAGE-WGSL-MISSING`** — user-added post-process stages without a WGSL
  fragment shader (6 gallery demos) are silently dropped; the real fix is the Naga GLSL→WGSL transpiler
  (vendored, works for clean Vulkan GLSL but not the Cesium-GLSL dialect — `sampler2D`, undecorated
  varyings, `czm_*` auto-uniforms). **P2 — hand-port demos opportunistically; full auto-transpile is
  research.**
- **`NEW-DYNAMIC-ENVMAP-FULL-SCENE` (C2-25)** is ✅ EPIC CLOSED (capture/temporal/clouds/parallax,
  Batches 446-451). **Residual:** `ENV-CAPTURE-PER-FACE-LOD` (side-face outward terrain needs per-face
  quadtree re-selection) + `NEW-CLOUD-SHADOW-ENVMAP` (env-map ground cloud-shadow term). **P2** (§9).
- **`NEW-WEBGPU-SKYBOX-HDR-FAINT-STAR-PARITY`** (Batch, 2026-06-22) — the baked starfield is dimmer than
  WebGL under HDR. **P2.**

### 4.8 Build / Infra / Architecture

- **`NEW-TS-CONVERT-JS-RENDERERS`** — first slice (StarField) shipped (Batch 314); the **bulk JS
  renderers** remain (Model 3802 LOC, GroundPolyline/GroundPrimitive, PrimitiveCommands,
  ModelPipelineCache, collection/Vector3DTile/Environment/Shadow/SkyAtmosphere renderers). **P2.**
- **`NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE`** (Batch 303) — `ViewportQuad.js:144` (and any future
  Material-driven primitive) still branches on `isWebGPU` to pick WGSL vs GLSL shader source. Give
  `Material` a per-backend `getShaderSource(context)`/`getUniformMap(context)` so the divergence lives
  inside the abstraction. The last sanctioned `isWebGPU` branch. **P2** (~1 session).
- **SceneRenderer / WebGPUContext decomposition** — both re-grew past 1000 LOC after the Batch-127-144
  extraction (`WebGPUContext.ts` ~5166, `WebGPUSceneRenderer.ts` ~4016). 5 new seams (culler-pool,
  HDR-canvas, high-density-cull, deferred/GBuffer/velocity dispatch, debug-overlays). **CRITICAL
  sequencing note (now moot):** the original plan deferred the dispatch seams behind the log-depth
  epic — that epic is done, so all seams are now unblocked. **P2** (`WEBGPU_CONTEXT_DECOMPOSITION_PLAN`).
- **`NEW-CI-SWIFTSHADER-WEBGPU-DEVICE-LOST`** (M, Batch 259) — the SwiftShader Vulkan WebGPU adapter on
  GitHub-hosted ubuntu runners drops the instance mid-frame; hosted WebGPU smoke reverted to local-Edge-
  required. Re-enable when a runner Chromium/SwiftShader survives a full frame, or move to a self-hosted
  GPU runner. **P2** (runner-capability gap, not a fork bug).
- **`NEW-CI-NODE20-ESM-TS-BARREL`** (M) — `node Specs/test.mjs` fails `ERR_MODULE_NOT_FOUND` for the 5
  TypeScript-backed barrel re-exports (`.js`→`.ts` inference only esbuild resolves). Needs a deliberate
  session (candidate fixes all change the published package surface). **P2.**
- **`NEW-SG-SCAN-ADOPT`** — upstream's `sg-scan` JSDoc/type lint; adoption needs `@ast-grep/cli` + 7
  rule files tuned to upstream's class conventions (several would flag our intentionally-diverged files).
  **P2 — revisit alongside the next upstream merge.**
- **ES6 modernization remaining** — `var`/`indexOf` done in production source; remaining = ES6 prototype-
  class conversion (~52 files). Do NOT bulk-sweep (a prior bulk sweep shipped HIGH-severity BUGs). **P2.**
- **`NEW-CAMERA-UPDATEVIEWMATRIX-REVERT` / `NEW-FORK-MODERNIZATION-REVERT`** — merge-conflict-surface
  reverts; matter only at upstream-merge time. **P2 (merge-time).** (`NEW-FORK-MODERNIZATION-REVERT` is
  ⛔ DECLINED per owner 2026-06-11.)

---

## 5. Post-merge & Parity Gaps (from `WEBGPU_PARITY_AUDIT_2026-06`)

The v1.141-1.143 (and the subsequent v1.142) upstream merge **landed** (`d06742a2ac`, 2026-06-19; see
the memory handoff). The parity audit's **P1 buffer-primitive set is fully closed** (Batches 315-318).
The **remaining parity gaps** (all P2 / doc-drift), de-duplicated against §4:

| Gap | Status | Where |
|---|---|---|
| BufferPolygon-family 2D/CV reprojection | open, needs its own ID | §4 3D Tiles |
| `positionNormalized` + integer position datatypes | open, needs its own ID | §4 3D Tiles |
| EquirectangularPanorama cull-override | open, untracked | §4 3D Tiles (status: verify) |
| Edge `lineStrings` + authored `silhouetteNormals` data paths | open | §4 3D Tiles |
| Voxel default-shader (PR#13517) | blocked behind the voxel-data port | §4 3D Tiles |
| `GeoJsonPrimitive` inventory entry (§A) | doc-drift | reconcile in `FEATURE_INVENTORY.md` |
| Degenerate-triangle edge probe (PR#13421 repro) | open (can't confirm clean) | §4 3D Tiles |

**Remaining drift items** (from `CAMPAIGN_ROADMAP` Phase 9): PickId rebase assessment,
`NEW-MODEL3DTILECONTENT-DOUBLE-CONVERSION`, `NEW-SG-SCAN-ADOPT`, `NEW-WEBGL-REPROJECT-BASELINE`,
`NEW-SYNC-MOVEMAP` (runbook). Adopt `EXT_structural_metadata` vector tiles + OffscreenCanvas imagery at
the next merge.

---

## 6. Performance Roadmap

### 6.1 Dormant compute consumers

The fork ships several **GPU-compute substrates wired as threshold-gated consumers**:

- **gpuCuller** ✅ wired (Batch 209), **HiZ + sort-keys** ✅ wired (Batches 210/211), **GPU bitonic
  sort** ✅ shipped (Batch 228; Phase-3 RenderScheduler consumer = open `NEW-GPU-SORT-PIPELINE-PHASE-3`).
- **FORK-41 HiZ occlusion command-drop** ✅ now DEFAULT ON (C2-21) — the "5-20× on dense 3D Tiles left on
  the floor" is **reclaimed**.
- **`WebGPUComputeEngine`** ✅ wired into `WebGPUContext` (Batch 367, `NEW-WEBGPU-COMPUTE-ENGINE-WIRING`)
  — this had been the dormant-dispatch blocker for the atmosphere LUTs; now live.

**Open perf items** (`CAMPAIGN_ROADMAP` Phase 8 continuation): `NEW-RENDERBUNDLE-AGING-DECOUPLE`
(aging-from-frame-tick decouple; LRU + age eviction already exist), `NEW-RESOURCEMANAGER-KEY-EVICTION`
(low growth risk), `NEW-CLUSTERED-ASSIGN-BOUNDS-DIRTY`, `NEW-CLUSTER-MULTIFRUSTUM-BOUNDS`,
`NEW-MODEL-VS-MOTION-GATE`, `NEW-DECOUPLEDSCAN-FORWARD-PROGRESS-GUARD`. **All P2**, gate each on a
measured `CesiumDebug.gpuPassCost()`/`cpuPassCost()` before/after number.

### 6.2 WASM

- **`NEW-WASM-BRIDGE-BUNDLE-LOAD`** — the WASM RTE-encode kernel **does not load in the bundle**; the
  byte-identical JS fround twin runs instead, so the SIMD win is **dormant**. The flat-buffer strategy
  win (position-encode hoist) stands regardless (Batch 273 benchmark). **P2** (infra) — until it lands,
  WASM SIMD is unrealized. `NEW-WASM-WIDE-INSTANCE-KERNEL` deferred (only worth it if the color-pack loop
  becomes the bottleneck).

### 6.3 WGF-1..5 (post-process f16 / perf variants)

From `WEBGPU_EXECUTION_ROADMAP` §2: **WGF-3 f16 variants** (ColorGrading/FXAA/bloom-HDR) — **P2,
recommend defer** (low win, half-day each). WGF-1/2/4/5 were perf-shaping placeholders; fold into §6.1
as measured. **(status: verify — WGF tags are stale execution-roadmap shorthand; re-scope if revived.)**

### 6.4 Phase-8b TileStoreGPU (the big perf epic — summary in §7)

GPU-resident SoA tile storage / MegaBuffer / Resident Drawer / WGSL styling compiler — **genuinely
unbuilt**, 6-7 wk, two dependency layers deep. **P2/research** — RFC + spike first. Full architecture in
`PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` (do not duplicate here).

---

## 7. Phase 8 — GPU-Resident Tiles (summary)

> Full architecture stays in **`PHASE_8_GPU_RESIDENT_TILES_DESIGN.md`** + `PHASE_8_SHADER_STRATEGY.md`.
> Only the roadmap disposition is here.

**Central insight:** the destination is a GPU-resident octree of tiles where per-frame CPU cost is
O(camera-delta), not O(visible-tiles) — Unreal-Nanite / Unity-GPU-Resident-Drawer adapted for planetary
scale.

- **Phase 8a foundation — ✅ largely SHIPPED.** The shader-variant strategy landed: glTF pipelines are
  keyed on a wide variant space (not the old 3-bit key); KHR BRDFs ride real per-extension shader blocks
  (the "KHR silently dropped on WebGPU" + "3-bit key / 6 variants" premises are **STALE**). Normal
  G-buffer producer + MRT slot-1 ship (off by default; payoff probe = open `Phase-8a normal-G-buffer
  validation`, P2). `ShaderDefine` registry is at 16 allocated bits (0-15, `LOG_DEPTH`=1<<15); 8 bits
  remain (16-23).
- **Phase 8b GPU-resident stack — genuinely UNBUILT.** No `TileStoreGPU`, MegaBuffer mesh atlas,
  Resident Drawer, sharedSourceBuffer fanout, or WGSL styling compiler exists. **P2/research, 6-7 wk.**
  Gate behind an RFC + a 3-day WGSL-styling-grammar spike before committing. The CPU traversal redesign
  (emit `visibleTileID` buffers) + WBOIT×indirect-draw composition are unproven sub-blockers.

---

## 8. Cloud / Weather Forward Plan (Campaign 3)

> Reconciles `WEATHER_RECREATION_ROADMAP.md` (cloud-side phases), `WEATHER_DATA_INGEST_ROADMAP.md`
> (data phases), `CLOUD_TAXONOMY_ROADMAP.md` (E1-E3 exotic clouds), and the Campaign-3-v2 tiered-cloud
> tracker. **Much of these source docs is STALE** — the work raced far ahead of them.

### 8.1 What shipped (verified against git)

- **Tiered clouds V0-V16** ✅ functionally COMPLETE (Batch 453 reconcile). V0 (LUT auto-layout fix) →
  V1 (quality-tier preset scaffold) → V2/V3 (baked 3D Perlin-Worley + flip density core to baked
  textures, KEYSTONE) → V4 (mean-preserving erosion + `erosionStrength`) → V5 (Frostbite multi-scatter
  octaves) → V11 (per-genus vertical density profiles). Batches 396-408.
- **Weather recreation Phase 0-1** ✅ (Batches 384-387): clock-bind motion, 11 WMO genera +
  `CloudTypeProfile.js`, Worley erosion + multi-scatter, **the weather-map seam C2-16 (the keystone)**.
- **Weather data ingest Phase 0-3** ✅: MVP EDR→weatherTex R-only (Batch 410), P2 time model
  live/historical/projected (Batch 416), P3-core first G/B/A WGSL reads + mock-EDR harness (Batch 424),
  P3-sources `MetarWeatherSource` + `WcsCoveragesWeatherSource` (Batch 425). **Phase 3 is COMPLETE
  offline** (mock fixtures cover everything except the live network hop).
- **Weather config + Weather Inspector demo** (Batches 403-405); standards-keyed METAR/WMO presets.
- **Atmospheric effects A-E** wired, including `effects.precipitation`→WebGPU weather particles
  (Batch 423).

### 8.2 Open cloud/weather tail (the frontier)

- **Weather Phase 4 — direct GRIB2/NetCDF behind WASM** — **CRITICAL-PATH item** (§3). The high-fidelity
  NODD-S3 (HRRR/GFS/NBM) tier: `Grib2FileWeatherSource` decoding in a Worker/WASM. **Requires a
  same-origin proxy** (S3 NODD has no CORS) + Lambert-Conformal→equirect reprojection in the packer.
  **P2, ~1-2 wk.**
- **Live EDR network confirm** — `EdrWeatherSource` is wired but the LIVE call + CORS + the guessed
  collection id (`automated_gfs`) need confirming in a networked browser (the dev sandbox has no
  outbound network). **P1 (blocked on environment).**
- **`profileExtinction` (slot 103)** — activated Batch 452, but Principle-9 follow-up: G biases shape/
  density; full **per-position optical extinction** is the remaining fill-in. **P2.**
- **WeatherSystem / WeatherDataProvider public API** (`WEATHER_RECREATION_ROADMAP` Phase 3) — the
  `scene.weather` stateful owner + abstract provider interface + explicit WebGL degradation ladder
  (equirect imagery overlay / billboard CloudCollection). The data core is backend-neutral; volumetric
  = WebGPU-only by design. **P2** — formalize the public contract. **(status: verify — partial source
  classes exist; the public `scene.weather` facade may not be wired.)**
- **Cloud perf — two-tier 3D bake** (`WEATHER_RECREATION_ROADMAP` Phase 6) — small global 2D weather map
  (Tier 1, resident) + view-local 3D density bake (Tier 2, camera-anchored cascaded clipmap). NEVER a
  uniform fine global 3D grid (~0.5 GB, infeasible). Modeled on `WebGPUVolumetricFogRenderer`. **P2, own
  campaign.**
- **Temporal interpolation + advection** (`WEATHER_RECREATION_ROADMAP` Phase 5) — A/B keyframe lerp +
  per-cell U/V wind advection between sparse data frames. **P2.** _Note: cloud-render temporal
  reprojection (V10/3.2) already shipped (Batch 433); this is the DATA-keyframe lerp._
- **Historical-replay headline demo** (`WEATHER_RECREATION_ROADMAP` Phase 4) — pre-baked named-storm
  ERA5/GFS manifest, `scene.clock`-tied, the north-star deliverable. Gated on the Phase-4 pipeline.
  **P2.**

### 8.3 Cloud-taxonomy E1-E3 (exotic clouds, post-core)

From `CLOUD_TAXONOMY_ROADMAP.md` — the 11 WMO genera + profiles cover ~95% of skies; the long tail is a
tiered, post-core roadmap. **None scheduled into the queue yet.**

- **Tier E1 — species/varieties (density shaping, mostly "free" on V11/V12):** lenticularis, fibratus/
  uncinus, undulatus/radiatus, castellanus/floccus. **P2.**
- **Tier E2 — iconic supplementary features (targeted displacements):** **mammatus** (downward-bulging
  underside density), asperitas, Kelvin-Helmholtz (fluctus), arcus, virga. Each a bounded per-genus-gated
  shader mode + probe. **P2.** _(Mammatus is feasible and explicitly planned here.)_
- **Tier E3 — special clouds (new decks/sources):** noctilucent + nacreous (high iridescent shell),
  contrails (line sources), pyrocumulus (event-driven). Need new infrastructure. **P2.**

**Recommendation:** prioritize the ~8 visually-iconic forms (anvil ✅ V11, mammatus, lenticular,
Kelvin-Helmholtz, asperitas, virga, noctilucent, contrails) over every species×variety permutation.

---

## 9. Atmosphere / Reflection Quality Roadmap

> From `ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md` (the opt-in-over-parity quality roadmap) +
> `RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md` (the Takram inspiration track). **Governing principle
> (non-negotiable): WebGL parity is the DEFAULT; every item is OPT-IN behind a flag that defaults OFF
> and is byte-neutral when off.**

### 9.1 Improvement-plan status (verified against git — nearly all SHIPPED)

The plan's Phases 1-4 are **almost entirely shipped** (Batches 426-451). The table records the
disposition; **only the unshipped items are open work.**

| Phase | Item | Status |
|---|---|---|
| 1.1 | `A-LUT-REPARAM` sun-relative sky-view LUT (KEYSTONE) | ✅ Batch 428 (+429 MS re-param) |
| 1.2 | `IBL-HDR` rgba16float env cube | ✅ Batch 426 |
| 1.3 | `IBL-PREFILTER-HQ` roughness-correct prefilter | ✅ Batch 426 |
| 2.1 | `SKY-MS` multiple-scattering in visible sky | ✅ Batch 427 (+429) |
| 2.2 | `ENV-AERIAL-MS` MS sky as env-map + aerial source | ✅ Batch 430 |
| **2.3** | **`AERIAL-FROXEL` aerial-perspective froxel 3D LUT** | ❌ **OPEN — the only unshipped improvement-plan item** |
| 2.4 | `FOG-IBL-AMBIENT` sky-LUT/SH fog ambient | ✅ Batch 431 |
| 3.1 | `CLOUD-HALFRES` half-res march + bilateral upsample | ✅ Batch 432 |
| 3.2 | `CLOUD-TEMPORAL` reprojection/accumulation | ✅ Batch 433 |
| 3.3 | `CLOUD-AERIAL-LUT` aerial coupling | ✅ Batch 434 (samples shipped LUTs since 2.3 deferred) |
| 3.4 | `CLOUD-AMBIENT-LUT` sky-coupled cloud ambient | ✅ Batch 434 |
| 3.5 | `FOG-TEMPORAL` froxel temporal reproject | ✅ Batch 435 |
| 3.6 | `CLOUD-CONE-LIGHT` 6-tap cone light march | ✅ Batch 436 |
| 4.1 | `CLOUD-SHADOWS` beer shadow map → terrain/aerial/fog | ✅ Batch 437 |
| 4.2 | `CLOUD-IBL` cloud-aware dynamic IBL/SH | ✅ Batch 441 |
| 4.3 | `FOG-MS` fog multiple-scattering octaves | ✅ Batch 440 |
| 4.4 | `SKY-MOON` dual-light moon scattering inline | ✅ Batch 438 |
| 4.5 | `SKY-OZONE` Chappuis absorption layer | ✅ Batch 438 |
| 4.6 | `MIE-PHASE` Jendersie-d'Eon improved Mie | ✅ Batch 438 |
| 4.7 | `CLOUD-CURL` curl-noise edge distortion | ✅ Batch 439 |
| 4.8 | `CLOUD-PW-NOISE` Perlin-Worley base-shape bake | ✅ Batch 439 |
| 4.9 | `CLOUD-MULTIDECK` per-deck shell march | ✅ Batch 443 |
| 4.10 | `COLD-OPTICS-HQ` dispersed halos + light pillars | ✅ Batch 442 |
| 4.11 | `PRECIP-DATA` WMO ww → precip type/intensity + snow | ✅ Batch 444 |
| 4.12 | `CLOUD-RTE` full RTE camera-relative cloud march | ✅ Batch 445 |
| 4.13 | `FOG-AUTO-VPT` wire `auto` fog-quality benchmark | ✅ Batch 445 |
| 3-A | `ENV-SCENE-CAPTURE` dynamic scene-content env map (C2-25) | ✅ Batches 446-448 (globe/tiles/glTF) |
| 3-B | `ENV-TEMPORAL` temporal env-cube accumulation | ✅ Batch 449 |
| 3-C | `ENV-CLOUDS` clouds folded into reflection env map | ✅ Batch 450 (closes CLOUD-IBL-FULL) |
| 3-D | `ENV-PARALLAX` Lagarde parallax-corrected reflections | ✅ Batch 451 (**closes the C2-25 epic**) |

### 9.2 Open atmosphere/reflection items

- **`AERIAL-FROXEL` (2.3)** — **CRITICAL-PATH** (§3). A low-res 3D froxel LUT (e.g. 32³) of accumulated
  transmittance + inscatter computed once per frame; `AerialPerspective.wgsl` does one trilinear fetch
  instead of the 10-step per-pixel march. Decouples cost from screen resolution; `CLOUD-AERIAL-LUT`
  (3.3, shipped) currently samples the sky-view + transmittance LUTs directly *because* this froxel is
  deferred — wiring it would let 3.3 sample the same froxel volume instead of re-deriving. Opt-in
  `scene.aerialPerspectiveFroxel` (nested under `scene.aerialPerspective`). **P1, effort L.**
- **`ENV-CAPTURE-PER-FACE-LOD`** — C2-25 side-face outward terrain needs per-face quadtree re-selection
  (the nadir hemisphere captures textured terrain correctly; side faces need their own LOD pass). **P2.**
- **`NEW-CLOUD-SHADOW-ENVMAP`** — the env-map ground cloud-shadow term (deferred from 4.1 CLOUD-SHADOWS,
  which shipped terrain/aerial/fog consumers). **P2.**
- **PRECIP-DATA ground snow-albedo shader consumer** — the `updateSnowAccumulation` scalar ships
  (Batch 444); the ground snow-albedo shader consumer is the deferred fill-in. **P2.**
- **Cross-cutting architectural observation (carry forward):** four subsystems independently re-derive
  the sky integral (sky FS inline march, env-cube inline march, aerial per-pixel march, cloud ambient
  heuristic). `A-LUT-REPARAM` (shipped) provides the shared table; **`AERIAL-FROXEL` is the last
  consumer that still re-marches.** Wiring it completes the "one shared sky/transmittance/MS LUT all
  four consume" goal.

### 9.3 Takram track residual (`RESEARCH_TAKRAM_GEOSPATIAL_VISUALS`)

Items 1-7 of the Takram research track shipped (Track V + Campaign 3). **Open:**

- **`NEW-SUN-MOON-FIDELITY`** (item 8) — physical sun disc + limb darkening + atmosphere-coupled glow +
  geometry lens-glare; moon phase-correct PBR regolith + earthshine. **P2.**
- **`NEW-EFFECTS-LIGHTSHAFTS-LENSGLARE`** (item 9) — crepuscular rays (extend `WebGPUGodRayEffect` to
  atmosphere/cloud-aware) + geometry lens glare. **P2.** _Partial: god-rays exist._
- **`NEW-MULTIBODY-ATMOSPHERE`** (item 10) — Mars (thin CO₂/dust Rayleigh/Mie/ozone + ground albedo) +
  airless-body parameter sets on the same LUT pipeline; a `CelestialBodyAtmosphere` config. **P2.**
- **`NEW-STARS-BRIGHT-CATALOG-WEBGL-FALLBACK`** — WebGL keeps cubemap-only stars; the bright-star catalog
  is WebGPU-only. **P2** (deferred).

---

## 10. Water / Vegetation Build Plans

Both are **design-complete, code-minimal** — locked designs awaiting scheduling. Full designs stay in
their docs; only the roadmap disposition is here.

### 10.1 Water (`WATER_RENDERING_DESIGN.md`, v2, C1-C14 decisions locked)

**Status:** Phase 0 + 0.3 DONE — the `GlobeWater.js` canonical-home facade (`scene.globe.water`)
delegating to the legacy `showWaterEffect`/`oceanNormalMapUrl`/enhanced-ocean fields. **Phases 1-9
UNBUILT** — no `WaterClassificationProvider`, Gerstner surface shader, bathymetry, foam, caustics, river
pipeline, or `WaterRegion` collection exists.

- **Phases 0-2 (Gerstner + imagery-tint, depth-independent)** — buildable in parallel now. **P2.**
- **Phase 1 classification** — can use an OSM-vector WaterRegion API. **P2.**
- **Phase 3 bathymetry** — samples scene depth = the renderer-wide depth contract. **Now UNBLOCKED** (the
  log-depth epic it was gated on shipped at Batch 251). **P2.**
- **`NEW-WEBGPU-EXAG-WATER-STREAKS`** (§4 Globe) is the nearest live water-parity bug. **P2.**

### 10.2 Vegetation (`VEGETATION_SYSTEM_DESIGN.md`, design/survey, no code)

**Verdict:** ultra-performant planetary vegetation is FEASIBLE (the fork ships ~80% of the hard
infrastructure — GPU culling, indirect draw, point-cloud LOD, render bundles, bitonic sort, RTE, I3DM/
PNTS instancing, PBR shader pair, stochastic alpha-dither). Missing = vegetation-specific glue. 5 slices,
each independently shippable + probe-verifiable:

- **V1** — `VegetationScatterCollection` + compute placement (WebGPU) / CPU placement (WebGL2),
  `FeatureRendererKey.VEGETATION_SCATTER`. **P2.**
- **V2** — 4-stage mesh-LOD chain + GPU-driven LOD selection (the fork has tile-LOD + point-LOD but **no
  mesh-LOD chain** for Models). **P2.**
- **V3** — octahedral impostor bake + sample (`FEAT-GAP-07`). **P2.**
- **V4** — `VegetationPBR` shader pair (WGSL + GLSL): two-sided leaf translucency, wind, alpha-to-
  coverage, canopy AO, impostor sampling — new `ShaderDefine` bits. **P2.**
- **V5** — GPU-instanced grass + density-impostor + terrain detail-albedo; rocks/sparse-arid profile.
  **P2.**

Inventory anchors: `FEAT-GAP-07` (impostors), `FEAT-SURVEY-43` (grass/foliage material + vegetation
instancing), `BACKLOG-§9` (subsurface scattering).

---

## 11. Deferred Research Pointers (→ D4)

Explicitly research-stage / not-yet-scheduled. **Named here for the scheduling decision; detail lives in
the research docs.** All **P2/research**.

| ID | Item | Doc |
|---|---|---|
| **R-3** | WebNN imagery super-res (Chrome/Edge-only behind flags) | `FUTURE_RESEARCH_2026_05_01.md` — recommend defer until a 2nd browser ships WebNN |
| **R-4** | Off-thread MVT vector tiles (no MVT code exists; the `.vctr` JS-worker tessellator is the reuse) | `FUTURE_RESEARCH_2026_05_01.md` — JS-decode v1, Rust/WASM is the speculative accelerator; build log-depth-gated from day one |
| **R-5** | Single-buffer GPU pick | `FUTURE_RESEARCH_2026_05_01.md` — analyzed, recommend confirm-and-park (the pick FBO is full-viewport, no memory saving) |
| **WORKER-1** | Scene in worker | `OPTION_B_SCENE_IN_WORKER.md` — Phase-1 blocker is image loading (`Resource.js` `new Image()`); recommend defer or Phase-1-only |
| **Phase-8b** | TileStoreGPU / GPU-resident tiles | `PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` (§7) — RFC + spike first |
| **FEAT-GAP-06** | Bent-normal AO (terrain-only; must live in `GlobeTerrain.wgsl`, not post-process) | feature survey — gate behind FEAT-GAP-01 producer hardening |
| **Large-dynamic Phase 4/13** | ECS-in-WASM-on-worker | ❌ **CLOSED NO-GO (Batch 305)** — re-open criteria in `DEFERRED_WORK.md` Phase 4/13 |

`RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md` is mostly **realized** (Track V + Campaign 3); its residual
items are tracked as scheduled work in §9.3, not research.

---

## 12. Known Minor Bugs

Cross-referenced with `WEBGPU_DEBUGGING_LOG.md` (the chronological bug log — search it before debugging
a new artifact). The **active minor bugs** not already covered above:

- **`DP-H47`** (czm_atmosphere auto-uniform suite) — every WebGPU atmosphere renderer hand-rolls its
  `frameState.atmosphericConditions` pull; there's no shared `csm_atmosphere*` auto-uniform block.
  Confirmed real (Batch 304 re-triage); scoped as a multi-renderer uniform-architecture change, NOT a
  bug-bash partial. **P2.**
- **`NEW-WEBGPU-GRID-MATERIAL-PATTERN-MISSING`** — grid-material lines don't render on WebGPU (pattern
  bug, surfaced by the Batch-356 MaterialAppearance parity work). **P2.**
- **`NEW-WEBGPU-SKYBOX-HDR-FAINT-STAR-PARITY`** — baked starfield dimmer than WebGL under HDR. **P2.**
- **`MORPH-COMPLETION-POP` / `MORPH-CAMERA-FRUSTUM` / `MORPH-MULTIVIEW` / `MORPH-PREVMODE-TYPO`** — a
  cluster of **unverified** scene-mode-morph findings (one-frame completion pop, animated-FOV frustum/
  HiZ caching, split-screen frame-lock, a disputed `_previousModeMode` typo). **All P2 / (status:
  verify)** — each needs a probe run before action. `MORPH-PREVMODE-TYPO` is **disputed** (do NOT blind-
  rename; the 3D→CV tween may rely on the unconditional clobber).
- **`NEW-CONTEXT-PICKID-MERGE-PRESTAGE` / `NEW-VOXELELLIPSOIDSHAPE-UPSTREAM-COLLISION`** — frozen behind
  upstream rewrites; matter at merge time. **P2 (merge-time).**

---

## Appendix — Reconciliation summary (for reviewers)

**What this draft changed vs the source docs:**

1. **Collapsed the roadmap triplication.** `CAMPAIGN_ROADMAP` (chosen frontier) + `EXECUTION_ROADMAP`
   (the log-depth spine) + `MIGRATION_BACKLOG` (Phase-7 survey) → **one phase table** (§2) + **one
   critical path** (§3). The `EXECUTION_ROADMAP`'s entire log-depth-epic framing is marked **superseded**
   — that epic shipped at Batch 251.
2. **Re-verified every headline status against git.** Most "WIP"/"deferred" claims in the sources are
   **stale-shipped**: log-depth flip (251), buffer-primitive parity (315-318), EdgeDisplayMode (316),
   CSM cast/receive (296-298), the entire atmosphere/cloud improvement plan P0-P4 except AERIAL-FROXEL
   (426-451), C2-25 reflections epic (446-451), tiered clouds V0-V16 (396-453), weather P0-P3 (384-425),
   DP-H46a/b (454-455), compute-engine wiring (367), C2-21/22/23/24 (388-419).
3. **Surfaced the genuinely-open items exhaustively** (§4-§12): `NEW-WEBGPU-KTX2-TRANSCODER-FORMATS`,
   `DP-H46c`, `AERIAL-FROXEL` (2.3), `ENV-CAPTURE-PER-FACE-LOD`, weather Phase 4, collections SCENE2D,
   voxel data path, `DP-H47`, the morph cluster, vegetation V1-V5, water Phases 1-9.

**Items I marked "(status: verify)" — could not confirm from git/code read alone:**

- EquirectangularPanorama cull-override (§4 3D Tiles) — re-confirm against HEAD `WebGPUPrimitiveCommands.js`.
- CSM Slice-3 altitude-adaptive splits (§4 Shadows) — no git match found; may be unstarted or named
  differently.
- WGF-1..5 perf variants (§6.3) — stale execution-roadmap shorthand; re-scope if revived.
- WeatherSystem/`scene.weather` public facade (§8.2) — partial source classes exist; the public facade
  wiring is unconfirmed.
- The morph cluster (§12) — all explicitly carried as "unverified" in the source; each needs a probe.

**Source docs whose content is now FULLY realized (candidates for archive after review):**
`ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md` (only AERIAL-FROXEL open), `WEBGPU_EXECUTION_ROADMAP.md` (spine
shipped), `WEBGPU_PARITY_AUDIT_2026-06.md` (P1 set closed), the Track-V portion of `CAMPAIGN_ROADMAP`.
