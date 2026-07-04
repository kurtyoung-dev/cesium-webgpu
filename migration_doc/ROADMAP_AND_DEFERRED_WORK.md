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
>
> **2026-07-03 addendum:** the 25-item WebGL→WebGPU parity campaign (Batches 482–506,
> `03edcf1f2e..62c5bab450`) landed after this draft's HEAD-~455 verification pass, driven from
> `WEBGPU_PARITY_REPORT_2026-07-01.md` §6. **§5.2 carries the full closure ledger** plus the
> post-campaign audit's OPEN findings (four real issues — recorded honestly as OPEN, not papered
> over); the per-section entries below carry inline `✅ (Batch 48x/50x)` corrections. §5.2 statuses
> were verified at HEAD `62c5bab450` (probe re-runs + direct source reads).

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
| **3** | 2D / Columbus View / morph collections | 🟢 **POSITIONING RESOLVED (premise re-verified 2026-07-04)** | per-frustum camera-UB foundation (Batch 261), projected-frame RTE + log-depth-consistency (Slice 2), CV coplanar fix (Slice 2b) all landed. **The "SCENE2D collections still all-zero / globe-pass issue" premise is STALE** — `probe-collections-2dcv-morph` (2026-07-04) shows all four collections render at correct map location in 2D (billboard 0.99 / point 1.01 / polyline 0.97 / label parity vs WebGL). Residual = a mode-INDEPENDENT label/billboard atlas **vertical-flip** (see `NEW-BILLBOARD-ATLAS-VFLIP`, §4 Collections), not a 2D/globe-pass defect. See `NEW-COLLECTIONS-2DCV-*` (§4 Collections) |
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
  lacks. **Root-cause isolation (2026-06-23) RULED OUT atmosphere, fog, and ground-atmosphere drape**
  (zeroing `computeEnhancedOcean`'s `oceanContribution` left the blue unchanged → not the water-color
  function; disabling fog + ground-atmosphere + sky-atmosphere left it unchanged → not atmosphere/fog).
  The true cause is **globe lighting/material water-fragment parity** — turquoise lake imagery survives
  on WebGPU where WebGL's `czm_phong` + `materialInput.waterMask` mutes it. A pre-existing, non-default
  (extreme EXAG over glacial-lake terrain), LOW-priority globe-lighting parity gap (broad blast radius),
  NOT a water-color pipeline issue. **P2.** Probe: `probe-exaggeration-3d.mjs` / `diag-exag-water-streaks-source.mjs`.
- **`NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH`** — ✅ **CLOSED (Batch 513, NEW-GLOBE-DRAPE-LIMB-CLOSEOUT,
  2026-07-03).** `probe-limb-halo-width` drape diagnostic measures WebGL=1 px vs WebGPU=1 px (delta 0)
  at the full-disc framing — the drape band itself is at parity. The REAL residual the epic was
  chasing lived in the SkyAtmosphere shell, not the drape: `skyColorForRay` clipped planet-striking
  rays at the earth surface (`rayEnd = earthIntersect.x`), (a) flooding the see-through disk interior
  with a solid daylight-blue disc whenever the globe surface didn't cover it (globe.show=false —
  latent since the original port, unmasked by the 2026-06-25 skybox-over-atmosphere draw-order fix)
  and (b) truncating WebGL's ~10 px limb extinction tail (shallow sub-limb chords marching through
  the planet). Fix: march through the planet like WebGL, with a −150 km underground sample-height
  floor in `computeScattering` so extinction is deterministic (WGSL exp() overflow is
  spec-indeterminate). Shell gate now PASSes: WebGL 14 px vs WebGPU 16 px median (±6 px tol).
- **`NEW-WEBGL-REPROJECT-BASELINE`** — WebGL imagery reprojection forked to per-fragment Mercator; needs
  a regression baseline. **P2** (drift bookkeeping).
- **Campaign closures (Batches 482–506, see §5.2):** underground color ✅ B487; globe translucency
  alpha ✅ B488 (WGSL SkyAtmosphere daylight-flooding the see-through planet disk gated on the
  previously-reserved `atmosControl.w`; terrain diff 99.8%→22.9% at landing); HDR gamma
  (sRGB→linear under an HDR canvas) ✅ B489; clipping-polygon geodetic (spherical fast-atan
  parity) ✅ B494; **polar stretch** ✅ B502 (root cause: DOUBLE vertical flip in the WGSL Web
  Mercator reprojection, `ReprojectWebMercator.wgsl`) + polish ✅ B506 (dark-navy tile-seam grid
  killed + orbital ocean glint restored; `GlobeTerrain.wgsl` rework, camera-UB +fields).
- **`NEW-GLOBE-BELOW-SURFACE-DARKENING`** — ✅ **CLOSED (epic B2/B5/B6 = Batches 510/512/513,
  2026-07-03).** Was: a tile-aligned haze wedge on WebGPU in below-surface / translucent views
  (`probe-globe-underground` 12.28%/22.85% vs 8% limit, `probe-globe-translucency` 25.49% vs 10.5%
  at clean HEAD `62c5bab450`). B2 (Batch 510) attribution exonerated every named shading term and
  root-caused the wedge to the water/reflective-ocean path; B5 (Batch 512) fixed it — water masks
  never uploaded (`wm._source` was never retained), so every water-masked tile bound the 1×1 WHITE
  placeholder and `computeEnhancedOcean` ocean-shaded whole land tiles. B6 (Batch 513) verified
  under the UN-loosened dynamic limits: underground-red **1.43%** / underground-def **4.28%**
  (limit 8), translucent-space **4.00%** / translucent-terrain **0.54%** (limit 11.9) — all PASS
  with wide margin. Historical decomposition detail retained below.
  - **B2 decomposition result (NEW-GLOBE-BELOWSURFACE-DECOMP, 2026-07-03):** per-term A/B bypass
    instrumentation landed (`bypass-*` globe-fragment debug modes, sentinels 21e9–27e9 in
    `WebGPUGlobeFragmentDebug.ts` / `GlobeTerrain.wgsl`, production-inert; probe
    `diag-globe-belowsurface-decomp.mjs`, report `output/diag-belowsurface-report.json`). The
    attribution table **exonerates every named candidate term**: underground tint, translucency
    alpha ramp, ground-atmosphere drape, B506 seam-clamp, B506 glint, and fog each move the
    residual toward WebGL by ≤ +2.5 mean |signed dRGB| when bypassed (largest: glint +2.52 on
    translucent-terrain; seam-clamp +0.1..+0.5; the big terms are parity-matched — bypassing them
    moves WebGPU **away** from WebGL by 50–190). **Two premise corrections:** (1) the sign was
    misread — the probes' signed dRGB is GL−GPU, so −5.8..−8.0 means WebGPU is **brighter**, not
    darker; (2) the dominant residual is a **tile-boundary-aligned semi-transparent haze/brightening
    wedge on WebGPU only**, pre-existing in unmodded baselines, visible in BOTH underground scenes
    and translucent-terrain (23.18% control residual; underground-def 10.35% vs 8% limit — the
    remaining FAIL; underground-red now PASSES at 6.75%). **B5 target = the per-tile haze wedge,
    root-caused to the water/reflective-ocean path:** stage discrimination shows the wedge is
    absent in `post-composite-color` (imagery composite clean) but `water-effect-trigger` renders
    the exact wedge tiles RED — i.e. `tile.flags.x` (showReflectiveOcean) is set AND the sampled
    water mask is > 0.01 across whole inland land tiles, so `computeEnhancedOcean` adds its
    bluish-gray diffuse highlight (+ glint specular — the +2.52 partial recovery seen by
    `bypass-glint`) over land imagery on WebGPU where WebGL does not. Suspects: per-tile
    waterMask upload/`waterMaskTranslationAndScale` divergence, a placeholder all-ones mask
    texture on tiles without real masks, or the flags.x gate. Side observations from the same
    session: the probe severity numbers drift run-to-run (12.28→6.75 / 22.85→10.35 / 25.49→23.14),
    and `probe-globe-polar-stretch` far/extreme currently FAIL at clean HEAD too (4.6/5.0% vs
    3.5/4.5%, space-bucket ~60-80% i.e. star-field/space residual, mid = 0.000%) — B5's off-gate
    should compare against a same-session clean-HEAD baseline rather than assume green.

### 4.2 3D Tiles

- **Voxels** — the "entire data path is a placeholder" status is **STALE** (it predates the 465–481
  parity sprint). The real single-tile data path (provider/megatexture data+shape+color parity)
  shipped in that sprint, and the 482–506 campaign added: world→shapeUv convention fix ✅ B497
  (unblocking the documented B477 cell-pick blocker), per-cell pick reland ✅ B498, **depth-1
  octree LOD traversal** (root + 8 level-1 children) ✅ B501, and **native-WGSL user
  customShaders in the ray-march** ✅ B503 (codegen chunk + FNV-1a keySalt,
  `VOXEL_USER_CUSTOM_SHADER` 1<<29). **Remaining open:** `NEW-VOXEL-OCTREE-DEEP-LEVELS` — octree
  levels deeper than depth-1 (**P2**); the PR#13517 default-shader rides that work; and the
  **pick↔octree/customShader composition gap** — `NEW-VOXEL-PICK-OCTREE-COMPOSE`, **P1 fix-now**
  (§4.5).
- **Edge data parity** (`NEW-EDGE-DISPLAY-MODE-WEBGPU` is ✅ SHIPPED Batch 316; tri-mode core done) —
  authored `silhouetteNormals` signed-byte accessor ✅ **SHIPPED (Batch 495,
  `EDGE-AUTHORED-SILHOUETTE-NORMALS` — WebGPU now consumes the authored accessor instead of
  re-deriving face normals)**. **Remaining open data path:** explicit `lineStrings` edges
  (BENTLEY/styled-gltf-lines yield zero WebGPU edges). Per-edge `materialColor` override ✅ SHIPPED
  (Batch 330). **P2.**
- **Vector3DTile (.vctr) e2e status** — `NEW-VECTOR3DTILE-VCTR-E2E` (B8, 2026-07-03) landed the first
  REAL .vctr pixel probe (`probe-vector3dtile-vctr.mjs`, fixtures `Specs/Data/Cesium3DTiles/Vector/**`;
  the "no .vctr test data" blocker in FORK_OVERVIEW §8 was STALE). Verified at msaa=1: polylines-3D
  pixel-identical (IoU 1.000), polygons-3D far-view IoU 0.904, polygons render 2D/CV on WebGPU where
  upstream WebGL renders 0 px, polyline 2D/CV silent skip-gate intact (ISSUES A.4). The probe ALSO
  exposed two real gaps (each reproduced + expected-fail-annotated in the probe; flip the frames to
  hard gates when fixed):
  - **`NEW-VECTOR3DTILE-MSAA-PIPELINE` (P1) — ✅ RESOLVED (Q2-VECTOR3DTILE-MSAA):** all three
    Vector3DTile pipeline builders (`WebGPUVector3DTilePrimitiveRenderer.buildVectorTilePipelineResources`,
    polylines / clamped-polylines equivalents) now thread `context._msaaSamples` into an `msState`
    (`sampleCount > 1 ? { count } : undefined`) baked onto the scene-pass pipelines (color + the
    two stencil variants; pick/velocity stay count-1 as they target single-sample FBs), mirroring
    `WebGPUGroundPrimitiveRenderer` L1372/L2062. Sample-count changes invalidate the cached resources
    through the existing `_scenePipelineFormatGeneration` gate (bumped on `msaaChanged` in
    `WebGPUSceneRenderer` ~L1180). `probe-vector3dtile-vctr.mjs` msaa=4 frame flipped from the
    known-gap attachment-state signature to a clean parity gate (0 device errors, IoU 0.904 vs WebGL).
  - **`NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT` (P2):** the depth-sample classifier `fsMain` only
    discards `surfaceDepth == 0.0` — no volume-containment test — so the classified footprint is the
    volume's PROJECTED screen extent, inflated `h/(h-1000)` at nadir height h vs WebGL's exact
    stencil volume∩surface (1.53x linear at 3 km, ~1.05x at 20 km). Also observed (unquantified):
    with the polygon-classifier tileset loaded the WebGPU globe surface renders near-black instead
    of the imagery color (possible interaction with the below-surface-darkening epic B2/B5/B6).
- **`NEW-MODEL3DTILECONTENT-DOUBLE-CONVERSION`** — Model3DTileContent class-converted on both fork and
  upstream; needs a double-conversion reconciliation strategy at merge time. **P2** (merge bookkeeping).
- **EquirectangularPanorama cull-override** (from `WEBGPU_PARITY_AUDIT`) — ✅ **RESOLVED (Batch 317,
  `2ee9421571`).** Verified at HEAD: `WebGPUPrimitiveCommands.js` now reads `cullExplicitlyDisabled =
  appearance?.renderState?.cull?.enabled === false` and forces `cullMode: "none"` regardless of
  `appearance.closed` when cull is explicitly disabled (so a closed-sphere panorama viewed from inside
  keeps its inner faces visible, matching WebGL's `combine(existing, rs, true)` precedence; the issue
  references upstream #13369). The earlier "(status: verify)" flag is cleared — the parity report's
  2026-06-30 "partial" row predates the fix; **code is the source of truth, this is closed.**

> **Note on the v1.141-1.143 parity-audit P1s:** the BufferPrimitive family `color.alpha` translucency,
> `blendOption` pass selection, and world-space `boundingVolume`/`debugShowBoundingVolume` were **all
> SHIPPED** (Batches 315-318); `GeoJsonPrimitive` probe + Sandcastle SHIPPED (Batch 318). The
> `WEBGPU_PARITY_AUDIT_2026-06.md` P1 table is therefore **closed**. Remaining parity-audit residuals
> are the BufferPolygon-family 2D/CV reprojection + `positionNormalized`/integer datatypes (P2, below).

- **BufferPolygon-family 2D/CV + integer/normalized positions** — the 2D/CV reprojection half shipped
  in the 465–481 parity sprint (Buffer\* 2D/CV; re-verified by `probe-buffer-2dcv-parity`, PASS at
  HEAD `62c5bab450`). **`NEW-BUFFERPOLYLINE-2D-EXTRUSION`** ✅ shipped 2026-07-03 — the 2D
  absence was a frustum-culling bug (ECEF command BV vs reprojected positions), fixed by
  scene-mode-aware command BVs; the probe now asserts 2D polyline presence + width. The
  integer/snorm/unorm `positionDatatype` / `positionNormalized:true` path also remains open
  (silently mis-encoded). **P2.**

### 4.3 glTF Models + KHR Extensions

KHR extensions are **wired** on WebGPU (clearcoat/sheen/anisotropy/iridescence/transmission/volume/
texture-transform all ship real BRDF blocks — the old "silently dropped on WebGPU" claim is STALE).
Clustered Forward+ lighting + punctual lights also ship. Open:

- **`NEW-WEBGPU-KTX2-TRANSCODER-FORMATS`** ✅ **RESOLVED (Batch 370, C2-1, ae21c21603).**
  `WebGPUContext._updateFeatureFlags()` now calls `loadKTX2.setKTX2SupportedFormats(...)` after device
  creation, deriving the transcode targets from the device's `texture-compression-{bc,etc2,astc}`
  features (mirrors WebGL `Context.js` init). `loadKTX2` no longer throws `"supportedTargetFormats is
  required"` on a `WebGPUContext`. Q1 (Campaign 3) re-verified the premise as already-closed and added
  the standing regression guard `probe-ktx2-transcoder-formats.mjs` (GATE PASS 2026-07-04).
- **`NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU`** (M, Batch 287) — authored KTX2 specular env maps don't load on
  WebGPU (procedural fallback used). **Blocked by** the transcoder-formats item above. **P1.**
- **`NEW-MODEL-WGSL-CUSTOM-SHADER`** — WGSL `CustomShader` API parallel to GLSL
  `CustomShaderPipelineStage` (WebGPU is a one-time-warning no-op). **Hard blockers** (verified): bind-
  group 1 is full (0-36), `maxBindGroups=4` maxed; numeric module cache key can't hold per-Model WGSL
  text; varying exhaustion (TAA uses @location 9-10). **P2** — ship a minimal fragment-only slice first.
- **`WGF-1-EXPAND` — clipping planes on primitives + models** (M) — globe terrain supports hardware
  `@builtin(clip_distances)`, but **primitives and models do NOT**. All renderers declare clip-distance
  uniforms + struct fields, yet the WGSL never writes `@builtin(clip_distances)` (primitive shaders =
  **stub**; `WebGPUModelRenderer.js` wires no clip-distance variant = **missing**). Affects all ~23
  primitive lit shaders (`Mat*Lit`), `Material`-derived primitives, the Ellipsoid primitive, all Model
  PBR variants, and the advanced classifiers. **Proof:** a `ClippingPlaneCollection` on a Primitive/Model
  silently fails on WebGPU. Bundles with `NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE` (§4.8) to avoid Material
  hardcoding per backend; distinct from the WGF-1 base feature (§4.8 Phase 5). **P1, effort M.**
- **`MORPH-MODEL-PROJECT2D`** — glTF Model accurate-2D (`projectTo2D:true`) has no WGSL equivalent (a
  morphable + 2D-projected model keeps its 3D bounding volume instead of morphing into a 2D-clipped ortho
  box). Part of the Collections 2DCV morph picture (§4.4) but applies to Models too. **P2.**
  _(Batch 499 shipped the base model 2D/CV render path itself — this accurate-2D residual remains a
  B499 deferred item, along with the SCENE2D IDL-crossing duplicate command + per-primitive 2D BVs.)_
- **`NEW-MATAPPEARANCE-DIFFUSE-PARITY`** is ✅ SHIPPED (Batch 356); surfaced separately:
  **`NEW-WEBGPU-GRID-MATERIAL-PATTERN-MISSING`** — **SYMPTOM NOT REPRODUCED (2026-06-23).** Reading the
  Batch-356 probe PNGs, the grid LINES render correctly on grazing faces matching WebGL; the original
  "lines don't render" note is stale. The real latent nuance (LOW priority, unverifiable at a single
  fixed view): both WGSL grid shaders use UV-space `step(uv, lineThickness)` width vs WebGL's
  derivative-based constant-PIXEL width. A multi-zoom grid probe would be needed to expose and fix it; as
  it stands no fix is required. **P2** (if pursued, low-priority tuning only).
- **`NEW-WEBGPU-KHR-MATERIALS-UNLIT-BLACK`** (surfaced Batch 359, during DP-H37 fix validation) — glTF
  models with `KHR_materials_unlit` render as pure black on WebGPU while WebGL renders them correctly.
  Root cause not yet identified; appears related to the VEC3 `COLOR_0` widening fix but may be
  independent. **P2.**
- **`KHR_BINDING_MANIFEST` follow-up** — per-extension granular pipeline split (the coarse
  `MODEL_HAS_KHR_TEXTURES` family gate ships; finer per-extension variants are the documented follow-up).
  **P2** (Phase-8 shader strategy).
- **Campaign closures (Batches 482–506, see §5.2):** model splitter plane ✅ B483
  (`MODEL_SPLIT_ENABLED` 1<<26); per-model `color`/`colorBlendMode` ✅ B484 (`MODEL_HAS_COLOR`
  1<<27, all 3 blend modes probed); model silhouette ✅ B485 (stencil two-pass parity,
  `MODEL_SILHOUETTE` 1<<28); glTF mode-0 POINTS topology ✅ B491; point-cloud square sprites +
  size/attenuation ✅ B490; **model 2D/CV scene-mode rendering** ✅ B499 (models were invisible in
  2D/CV — ECEF boundingSphere culled against the projected-frame culling volume at all 7 emission
  sites + missing `_computedModelMatrix2D` consumption; MORPHING follows WebGL's
  `mode !== SCENE3D` condition).
- **`NEW-MODEL-SCENE2D-SHADING`** (post-campaign audit 2026-07-03) — **P2 — OPEN.** Model
  per-pixel shading diverges in SCENE2D only: WebGPU renders the probe model olive/khaki vs
  WebGL's blue-gray tint (`probe-model-scene-modes` 2D interiorDiff 34.27 vs 3D 13.59 / CV 18.41
  both PASS; reproduced 3× at clean HEAD). Geometry/coverage/centroid all pass — B499's fix
  holds. **Suspect 2D light direction / IBL orientation under `SceneMode.SCENE2D`**; verified via
  the output PNGs to be model lighting, **NOT globe-related** (black backdrop in both captures —
  the sweep's B502/B506 globe-shader attribution is dismissed with evidence).

### 4.4 Collections

- **`NEW-COLLECTIONS-2DCV-PROJECTED-FRAME-RTE` / `NEW-COLLECTIONS-2DCV-COPLANAR-DEPTH` /
  `MORPH-COLLECTIONS-AUDIT`** — ✅ **POSITIONING VERIFIED AT PARITY (2026-07-04, premise re-verified,
  no code).** CV renders elevated + coplanar billboard/point/label (Slices 2/2b, 2026-06-13). **The
  "SCENE2D collections still all-zero / globe-pass" narrowing is STALE** — `probe-collections-2dcv-morph`
  (2026-07-04, PROBE_BASE :8080) shows all four collections render at the correct map location in SCENE2D:
  billboard GL=131/GPU=130 (0.99), point GL=284/GPU=288 (1.01), polyline GL=1838/GPU=1790 (0.97), label
  present at parity. Output PNGs read: `coll2dcv-2d-{webgl,webgpu}.png` — cyan polyline, yellow point,
  magenta billboard, lime "TEST" label all present in WebGPU 2D at WebGL locations. The PROJECTED-FRAME-RTE
  + COPLANAR-DEPTH sub-items (which are about *positioning*) are therefore effectively closed by the
  Slice 1–4 chain. **The only residual this diagnostic surfaced is `NEW-BILLBOARD-ATLAS-VFLIP` (below), a
  mode-INDEPENDENT texture-orientation defect, NOT a 2D/globe-pass defect.** Slice 3 (morph
  `position2D`/`position3D` × `czm_morphTime` blend) also still pending. **P2** (down from P1 — no longer
  a black/all-zero hole).
- **`NEW-BILLBOARD-ATLAS-VFLIP`** — WebGPU renders billboard/label atlas content **vertically flipped**
  vs WebGL, in **ALL scene modes (3D, 2D, CV)** — not 2D-specific. Only visible on asymmetric content:
  the `probe-collections-2dcv-morph` "TEST" label reads upright on WebGL and upside-down/mirrored on
  WebGPU in every mode; the symmetric magenta test billboard can't reveal it. Root cause: a mismatch
  between the shared `TextureAtlas` GPU-texture upload orientation and the billboard UV mapping. WebGL's
  `BillboardCollectionVS.glsl:141` maps the screen-up corner (`direction.y=1`) to atlas **V-max**;
  `BillboardCollection.wgsl` `QUAD_UVS` (lines 289–296) maps the screen-up corner to **V=0.0**. Fix must
  reconcile one against the other and re-verify across the main / SDF (`BillboardCollectionSDF.wgsl`) /
  pick (`BillboardCollectionPick.wgsl`) variants, all three scene modes, AND an **asymmetric** billboard
  image (not just the label). Reproducer: `probe-collections-2dcv-morph.mjs` (label glyph); PNGs
  `coll2dcv-{3d,2d,cv}-webgpu.png`. **P1** (visible parity defect on every label in every mode).
- **`C-R8-SCENE2D-JITTER`** ✅ **VERIFIED STALE/RESOLVED (2026-06-23, no code).** Collections render at
  WebGL parity in 2D AND Columbus View (billboard 2D 0.99 / CV 0.99; point/polyline/label all render
  correctly). Resolved by the documented Slice 1-4 chain (Batch 261 per-frustum camera-UB resolver →
  Batch 263 projected-frame RTE per-slice repack → Batch 263 coplanar depth → Batches 268/269 globe-pass
  2D BV → Batch 275 size parity). **Do NOT list this as open** in any roadmap. _(The SCENE2D
  `NEW-COLLECTIONS-2DCV-*` block above tracks the distinct billboard/point/label all-zero issue, which is
  separate from this resolved jitter finding.)_
- **`NEW-WEBGL-CV-POINT-ZERO`** (anomaly, not a WebGPU defect) — WebGL renders **0 yellow points** in
  Columbus View while rendering 284 in 2D and 316 in 3D; WebGPU renders 231 consistently across all
  modes (the more-correct side — points should appear identically in every view mode). This is a WebGL
  rendering bug, not a fork parity gap. Verified by re-running `probe-collections-2dcv-morph` at Batch
  364 (CV point GL=0 GPU=231). **P2** (WebGL fix only, no WebGPU work).
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

**2D / Columbus-View / morph batch canvas** (`PLAN_2DCV_MORPH_BATCHES.md`, 2026-06-07 workflow). The
epic was scoped into 3 batches + a 7-item backlog. Batch 1 (globe morph endpoint stability + Web
Mercator `instanceof` detection) shipped Batch 217 and **unblocks Batch 3** (the manual-lerp blend is
reused by the polyline morph port). Batch 3 (PolylineCollection 2D/CV/morph port) shipped at Phase 3
Slice 4 (2026-06-13). **Batch 2 produced the CRITICAL FINDING** that promoted collections to a
high-visibility parity hole: billboard/point/label rendered **nothing on WebGPU in all modes** (a
structurally-correct code-read that didn't match runtime — the classic trap), tracked as the
`NEW-COLLECTIONS-2DCV-*` cluster above. The 7 backlog items still pending scoping: exaggeration-skirts
(✅ shipped Batch 362), classifier 2D/CV, morph review gaps, ground-primitive 2D precision, model
`projectTo2D` (`MORPH-MODEL-PROJECT2D`, §4.3), `MORPH-TAA-PREVVP` (mid-morph polyline velocity), and the
disputed `_previousMode` typo (`MORPH-PREVMODE-TYPO`, §12 — do NOT blind-rename). **P1** (the cluster is
the last big visual-parity hole; SCENE2D collections still blocked).

### 4.5 Picking

- **`DP-H46c` pickMetadata producer** (L) — **CRITICAL-PATH** (§3). Consumer half + WGSL structural-
  metadata codegen prereq (DP-H46a/b) shipped (Batches 454/455). `DerivedCommand.createPickMetadata
  DerivedCommand` still short-circuits WebGPU; per-pick specialization must be data-driven (WGSL has no
  string-replace defines). **Asset gap:** needs a local `EXT_structural_metadata` test asset. **P1.**
- **`C-R9-VOXEL-CELL-PICK`** — ✅ **SHIPPED (Batch 498)** — the per-cell (i, j, k) pick RELAND on the
  corrected world→shapeUv convention (B497 fixed the documented B477 blocker). Verified by
  `probe-voxel-cell-pick`: 7/7 per-cell pick bytes byte-equal vs WebGL at HEAD `62c5bab450` (a
  run-1 failure was a WebGL-side async-pick timeout flake, dismissed). The old "blocked by the
  voxel data path" framing is superseded. **Open successor:** `NEW-VOXEL-PICK-OCTREE-COMPOSE`
  below.
- **`NEW-VOXEL-PICK-OCTREE-COMPOSE`** (post-campaign audit 2026-07-03) — **P1 — FIX NOW (the top
  work item).** The B498 cell-pick march does not compose with B501 octree LOD or B503 user
  customShaders:
  - `fragmentPickVoxelMain` (`WebGPUVoxelRenderer.ts` ~664–716) never performs the level-1
    child-octant traversal the color march does (~416–433) — it normalizes z into slot 0 (the
    ROOT slab) and hardcodes `megatextureId = packVoxelIntToVec2(0.0)`. Whenever the frame
    refines to level 1, pick returns a root-cell index for a leaf the user sees — **confirmed
    wrong pick under refinement** (in-code-acknowledged follow-up at the pick march). Fix = the
    child traversal + the child-tile megatextureId in the pick march.
  - Composition with `VOXEL_USER_CUSTOM_SHADER` (B503): the pick march selects the winning sample
    with the default-shader gate `s.a > densityThreshold` (~:697) while the user-shader color
    march accumulates `voxelMaterial.alpha` **ungated** for every sample (~:473–478) — a user
    shader that remaps opacity makes the WebGPU pick disagree with both the displayed surface and
    WebGL. The pick march needs a `VOXEL_USER_CUSTOM_SHADER` branch; ride it with the octree-pick
    fix above (one work item).
- **arbitrary-ray `pickFromRay` position** — returns the hit object but no position (`oneTimeWarning`,
  no throw). Needs an offscreen GlobeDepth pack + per-view readback. **P2** (deferred until a consumer
  needs it).
- **`NEW-WEBGPU-POINT-COLLECTION-PICK`** is ✅ SHIPPED/VERIFIED-WORKING (Batch 323).
- **`MORPH-PICK`** (unverified) — pick during a morph is exercised by the transitioner itself; if the
  pick pass camera-UB doesn't carry the live `mode`/`morphTime`, `pickPosition` returns wrong coords →
  wrong final 2D camera. **P2 / (status: verify).**

### 4.6 Shadows / Lighting

CSM cast + globe-receive are **fixed** (Batches 296-298); soft-shadow PCF ships (289/297);
cascade-ground-fit ships (306) and is now **ellipsoid-aware** ✅ Batch 496
(`PARITY-RTE-ELLIPSOID-AWARE` — the ground-fit uses the scene ellipsoid, not hardcoded WGS84
radii; see §5.2). Open:

- **`NEW-CSM-GLOBE-RECEIVE-PROJECTION-MISS`** — ✅ **RESOLVED (Batch 298, `509168f10b`).** (Round-2 doc
  review correction: round-1 lifted a "still BLOCKED" framing from `CSM_DESIGN.md` that predated the fix
  by one batch.) The globe-terrain receiver was missing ground cast shadows — the 3×3 PCF box kernel
  (matching WebGL `czm_shadowVisibility`, Batch 289) verified on primitive self-shadow edges (Batch 297,
  `probe-csm-soft-shadow.mjs` 0.000%→6.551%), but the WebGPU globe ground stayed uniformly bright while
  WebGL showed the cast shadow. **Root cause:** `WebGPUCSMRenderer._computeCascadeVPMatrix` placed the
  cascade light-eye at `center − lightDir*2r` (the ANTI-sun side), so the shadow mirrored about the
  cascade center and a ground point's projected UV read the cleared (lit) depth — self-shadowing
  primitives tolerated the mirror (caster+receiver share a texel), cross-object globe receive did not.
  **Fix:** `eye = center + lightDir*2r` (sun-side). **Verified:** `probe-csm-globe-receive-trace.mjs`
  313/961 ground points now correctly occluded (was ~0); `probe-csm-soft-shadow.mjs` renders the cast
  shadow; 5/6 sub-checks PASS, 0 device errors. **Residual:** `NEW-CSM-CASCADE-GROUND-FIT` (cascade
  edge-sharpness, Batch 306). See `CSM_DESIGN.md` (Soft-shadow PCF / verification status).
- **CSM Slice 3 — altitude-adaptive splits** — at orbital altitude λ=0.7 wastes 3/4 cascades on empty
  near-space; collapse/refit above ~500 km. **P2** (no log-depth dep). **(status: verify — defined in
  `CSM_DESIGN.md` as a planned Slice 3 item [Space/orbital-camera column: "above ~500 km collapse to one
  planet-scale cascade covering the visible spherical cap"], but no git batch matches "altitude-adaptive
  splits" — treat as UNVERIFIED/UNSTARTED, not OPEN, until formally opened against the design's Slice 3.)**
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
  WebGL under HDR. **P2.** _Note: root-caused (Batch 364) to always-on auto-exposure crushing the
  near-black HDR night sky to pure black; fixed by honoring `collection._autoExposureEnabled`. Residual
  = `NEW-WEBGPU-STARFIELD-TUNE` catalog-sprite brightness (assessed LOW-VALUE / acceptable-as-is — the
  sprites were intentionally tuned subtler in Batch 352; a blind re-tune risks regressing near-parity)._
- **Campaign closures (Batches 482–506, see §5.2):** `scene.colorGradingEnabled` runtime caller
  ✅ B482; the 7 `PostProcessStageLibrary` builtins (blackAndWhite / brightness / nightVision /
  silhouette / edgeDetection / lensFlare / depthView WGSL twins) ✅ B486; skybox star-map cube-map
  flipY parity (patternCorr 1.000 aligned vs 0.122 mirrored) + default-off cloud occlusion ✅ B504;
  moon full-disc via model-space RTE ✅ B505 (was an off-screen sliver; probe asserts litRatio
  1.000 / centerDist 0.0 px).
- **`NEW-PP-LIBRARY-TONEMAP-ORDER`** (post-campaign audit 2026-07-03) — **✅ RESOLVED (batch of
  2026-07-03).** Chose the **post-tonemap placement** path (hdrMode compensation can't reach
  user-supplied WGSL): user WGSL + library builtin stages moved from pre-TAA to AFTER the tonemap
  single-pass in `WebGPUPostProcessPipeline.execute()` (tonemap now executes directly, then
  user → library → ColorGrading/custom/FXAA ping-pong), matching WebGL's
  `tonemap → _stages → fxaa` order. Landed two prerequisite parity fixes discovered en route:
  (1) the WebGPU tonemap gate NEVER engaged under plain `scene.highDynamicRange` — WebGL's
  `tonemapping.enabled = useHdr` assignment (PostProcessStageCollection.js:575) sits after the
  feature-renderer early-return, so `configureWebGPUPostProcessPipeline` now applies the same
  rule from the scene flag (mirrored onto `_tonemapping.enabled` + the cache); (2) the WGSL
  PBR-Neutral operator in `Tonemapping.wgsl`/`Tonemapping_f16.wgsl` was a per-channel soft-clamp
  approximation (1.0 → ~0.9535, sRGB 249) — replaced with the exact Khronos reference port
  matching `czm_pbrNeutralTonemapping` (1.0 → ~0.869, sRGB 239; ModelPBRComplete/GlobeTerrain/
  SkyAtmosphere already carried the exact port). Stale header docstring + the two wrong
  "matches WebGL's insertion point" comments corrected. Probe: `probe-pp-library-builtins`
  HDR phase (startup-HDR page, white-point scene) — tonemap pass ordered before LibraryPP pass,
  disc medians base 238.7/239, BlackAndWhite 204/204, whole-frame mean 0.03-0.05; SDR gates
  byte-identical off-gate + per-stage means unchanged vs pre-fix run. Scene-side plain-HDR gaps
  discovered while isolating the gate are tracked in `NEW-PLAIN-HDR-SCENE-GAMMA-EPIC` below.
- **`NEW-PLAIN-HDR-SCENE-GAMMA-EPIC`** (found 2026-07-03 while probing the tonemap-order fix) —
  **P2 — OPEN.** Under plain `scene.highDynamicRange = true` (SDR canvas — now with a working
  tonemap on both backends), WebGPU scene shaders don't mirror WebGL's `#ifdef HDR` gamma
  handling, family of four:
  (a) **Globe**: WGSL sRGB→linear decode (`hdrControl.x`, WebGPUGlobeSurfaceCameraUB.ts ~:943)
  is gated on `hdrCanvasOutput && useHDR`, but WebGL's `#ifdef HDR` engages on `useHdr` alone →
  globe renders double-bright under plain HDR (observed: ground base-color delta in
  probe-pp-library-builtins diagnostics).
  (b) **Points/billboards**: `PointPrimitiveCollectionFS` `czm_gammaCorrect` linearizes colors
  under HDR; the WGSL point renderer never does (0.3 gray point → WebGL ~18/255 vs WebGPU
  ~147/255 displayed).
  (c) **Models**: `ModelPBRComplete.wgsl` `tonemapAndGamma` applies tonemap+gamma
  unconditionally (its own comment: "when HDR plumbing lands, gate both on the HDR flag") →
  models double-tonemap under plain HDR now that the PP tonemap engages.
  (d) **Mid-session `highDynamicRange` toggle** invalidates cached scene pipelines (attachment
  format mismatch: "Primitive pipeline (cull=back)" vs rgba16float "Scene Framebuffer Render
  Pass", ~128 validation errors/frame observed); startup-HDR works — scene pipeline caches need
  FB-format keying or a recreate hook on `_hdrDirty`.
  Minor tails: `scene.postProcessStages.exposure` isn't synced to the WebGPU tonemap uniform
  (default 1.0 path fine); the non-default WGSL operators (Reinhard/ACES/Filmic/
  ModifiedReinhard) haven't been parity-audited against their `czm_*` references (PBR Neutral
  now exact). Also pre-existing, seen in the same probe scene: WebGPU renders both entity boxes
  with ONE color (per-instance color divergence — orange box drawn cornflower blue) in SDR and
  HDR alike.
- **`NEW-PP-F16-DEVICE-VERIFY`** — **P2.** The B478 opt-in f16 post-process variants still need an
  on-device pixel-verify on a `shader-f16`-capable (RTX-class) GPU.
- **`NEW-ENV-MOON-CRESCENT-PROBE`** — **P2** (probe extension). `probe-env-moon` asserts only the
  full-disc case (B505); add a crescent-phase assertion.
- **Probe housekeeping — `probe-colorgrading-wired` stored baseline refresh** — **✅ RESOLVED
  2026-07-03 (`NEW-COLORGRADING-BASELINE-REFRESH`).** The stored baseline was regenerated post-B506
  and verified at Batch 518 HEAD: gates A–F all PASS (F byte-identical). **Still OPEN: the
  `probe-hdr-pp-math` gate F half below.** Original condition: gate F failed only against the
  stored pre-B506 default-view baseline PNG (functional gates A–E passed); B506 intentionally
  changed default-view pixels (glint restore + seam fix) — this was **not** a
  color-grading bug. **Same condition confirmed for `probe-hdr-pp-math` gate F** (2026-07-03,
  NEW-PP-LIBRARY-TONEMAP-ORDER regression sweep): SDR frames diff 5.8% at meanAbs 0.15 vs its
  stored pre-B506 `baseline-sdr-*.bin` (globe/atmosphere LSB shifts + a baseline-only speck);
  gates A–E all pass. Refresh both baselines together once the in-flight globe pixel changes
  settle.

#### TAA design rationale + open slice (carry-forward from `TAA_DESIGN.md`)

TAA Slice 1 (camera jitter + history blend) shipped at Batch 34; Slice 2a (sky reprojection + teleport
invalidation) followed in the same session. The architectural decisions are load-bearing for any future
motion-vector work:

- **Architecture: Option C (depth reprojection) chosen over Option A (MRT) / Option B (separate
  motion-vector pass).** The v1 plan was MRT motion vectors emitted as a second color attachment from
  every primary shader (globe/primitive/model/billboard/polyline) — high coverage, but every shader +
  framebuffer format needs changing. The Slice-1 audit chose **Option C**: motion vectors reconstructed
  in the TAA shader from `{currentMvpRTE, previousMvpRTE, cameraDelta}` with the already-bound depth
  texture — **zero new render targets, zero changes to the main-scene render path.** This gives correct
  motion for the entire static scene (terrain, static buildings, ground primitives) and treats
  skinned/morphed/instanced geometry as static (a narrow Slice-2b refinement, not a global MRT refactor).
  This decision unblocked Slice 1 shipping at Batch 34 alone.
- **RTE-corrected motion-vector math (planetary scale).** At Earth radius (6.37M m, ~0.76 m FP32 ULP)
  the textbook `worldPos = inverse(currVP)·ndc; prevNdc = prevVP·worldPos` loses precision at the
  world-space reconstruction step — multi-pixel motion error during orbital fly-to, exactly when TAA
  matters most. Shipped fix: reproject in **eye-relative space** with a `cameraDelta = currWC − prevWC`
  computed in FP64 on the CPU (the 6.37M-magnitude camera positions cancel cleanly before down-cast to
  FP32 for the GPU). Formula: `eyePosCurr = inverse(currentVpRte)·ndc; eyePosPrev = eyePosCurr +
  cameraDelta; ndcPrev = previousVpRte·eyePosPrev`. `UniformState` snapshots
  `previousViewProjectionRelativeToEye` + `previousCameraPosition` at the top of `update()` before
  `updateCamera` runs. Precision drops from ~1 m FP32 error to sub-micrometer (Node script confirms
  `VP_RTE·eyePos ≡ VP_world·worldPos` bit-exact at the camera position).
- **`TAA-SLICE-2B` per-model MRT motion vectors** (open) — depth reprojection treats skinned/morphed/
  instanced geometry as static, causing ghosting across frames. Slice 2b adds a second MRT color
  attachment to model pipelines emitting per-pixel velocity `(currentClip − previousClip)` with matching
  prev-frame joint/morph/instance UBOs, and teaches the TAA shader to prefer MRT samples when available.
  Touches every model pipeline + the model UBO layout + the TAA shader. Meaningful infrastructure;
  deferred beyond Slice 2a. **P2.** (Also see `MORPH-TAA-PREVVP` / `MORPH-MODEL-VS-MOTION-GATE` for the
  morph-side motion couplings.)

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
- **ES6 / TypeScript modernization remaining** (`ES6_MODERNIZATION_STATUS.md`, re-verified at HEAD) — the
  codebase is bifurcated: the **WebGPU renderer is ~87% TS** (171 `.ts` files, full ES2022); **Core /
  Scene / DataSources are ~0% TS** (~950 ES6-class JS files where every remaining legacy idiom lives).
  Prototype-as-class is essentially eliminated (**zero `X.prototype =` reassignments**; the 4
  `Object.create(...)` chains in `Scene/TilePathResolver.js` are legitimate abstract bases). Remaining
  pre-ES6 surface: ~99–107 `Object.defineProperties` getter/setter blocks (heaviest in
  `DataSources/*Graphics.js` + `Entity.js`), ~4,530 `this._private` assignments (only **1** `#private`
  field exists tree-wide — converting is a breaking change, **do NOT**), ~319 `.prototype.method =`
  attachments on internal helper structs (~54 files), scattered `.apply()`/`.bind()` (~29 files), ~193
  `=== undefined` coexisting with `defined()`, ~101 `hasOwnProperty` (zero `Object.hasOwn`). There is
  **no remaining `var` in actual JavaScript** — all grep hits are WGSL `var<…>` inside shader-string
  template literals (not modernizable). Highest-value **on-touch** targets: `Scene.js`,
  `Cesium3DTileset.js`, the DataSources `*Graphics` classes. Conversions are **opportunistic on-touch
  only** (CLAUDE.md Principle: never modernize a file you're not otherwise touching); do NOT bulk-sweep
  (a prior bulk sweep shipped HIGH-severity BUGs). **P2.**
- **`NEW-CAMERA-UPDATEVIEWMATRIX-REVERT` / `NEW-FORK-MODERNIZATION-REVERT`** — merge-conflict-surface
  reverts; matter only at upstream-merge time. **P2 (merge-time).** (`NEW-FORK-MODERNIZATION-REVERT` is
  ⛔ DECLINED per owner 2026-06-11.)

#### Dynamic Objects & Update Regimes (`LARGE_DYNAMIC_OBJECTS_DESIGN.md`)

The owner-directed architecture (2026-06-11): there is **no single "large dynamic objects" system** —
pick the update regime by **cardinality + derivability**, and fill the same per-instance buffer four
different ways. Every regime ends at the same render primitive (an instanced point/billboard draw over a
per-instance buffer); they differ only in *how the buffer gets filled*, which is what makes them
composable rather than competing. The `_consumeDirtyState` side-effect discipline (Phase 0) is a
prerequisite for all four. Phases 1–3 core SHIPPED (Batches 270–283); Phase 4 spike CLOSED NO-GO
(Batch 305).

| Regime | Update profile | Fill strategy | Phase / status |
|---|---|---|---|
| **1 — Static / sparse** | up to ~50k, ~tens changed/frame | resident CPU instance array + per-instance partial `writeBuffer`, O(changed) | **Phase 1 — ✅ SHIPPED** |
| **2 — Dense / arbitrary** | 10k–100k, bulk re-set/frame, not derivable | flat SoA `Buffer*` collections + WASM RTE-encode kernel, threshold-gated; both backends WASM-on-main-thread | **Phase 2 — ✅ SHIPPED** |
| **3 — Dense / derivable (orbital)** | 10k–1M, all move/frame, closed-form of element set + time | GPU compute propagator → storage buffer, positions never leave GPU; instanced draw vertex-pulls by `instance_index`; WebGL2 = SGP4-on-worker WASM fallback | **Phase 3 — ✅ SHIPPED** ⭐ |
| **4 — Hundreds-of-thousands, arbitrary** | 100k+, too heavy for main-thread encode | ECS-in-WASM-on-worker → packed buffer → upload | **Phase 4 — ❌ NO-GO (Batch 305)** |

Open residuals on the shipped regimes:

- **`NEW-WASM-BRIDGE-BUNDLE-LOAD`** (§6.2) — the WASM RTE-encode kernel still doesn't load in-bundle; the
  JS `fround` twin runs instead, so the SIMD win is dormant (the flat-buffer position-encode-hoist win
  stands regardless). **P2.**
- **`NEW-ENTITY-GPU-KEYFRAME-KERNEL`** (§4.4) — the time-dynamic regime-3 second kernel family
  (`SampledPositionProperty`/Clock → GPU keyframe interpolation). **P2.**
- **`NEW-ORBITAL-GPU-RESIDENT` / `NEW-ORBITAL-INVENTORY-TRACK`** — the regime-3 GPU-resident path is
  currently untracked in `DEFERRED_WORK` + `FEATURE_INVENTORY`; add the bookkeeping rows. **P2.**
- **Phase 4 re-open criteria** — explicit user demand for >189k arbitrary dynamic objects @30 fps AND
  proof that regime 3 (GPU-compute) doesn't fit the use case. The Batch-305 gate spike measured the
  main-thread flat-buffer encode ceiling at ~89k @60 fps / ~187k @30 fps on WebGPU (~77k / ~154k on
  WebGL) with arbitrary per-frame updates — which covers the "tens of thousands of arbitrary updates"
  target on both backends with no worker. All `NEW-ECS-*` IDs + `NEW-COOP-COEP-SAB-ENABLE` are CLOSED as
  not-needed (see §11). **P2/closed.**

#### Phase 5 — Modern WebGPU feature adoption (WGF-1…5)

Capability detection landed 2026-04-09 (`scene.getDebugSnapshot().renderer.capabilities` exposes
`hasShaderF16` / `hasDualSourceBlending` / `hasClipDistances` / `hasIndirectFirstInstance` / …); the
per-feature consumers are **deferred**. Full design in `PHASE_5_MODERN_WEBGPU_DESIGN.md`. Recommended
order — the low-risk first three, then the workload-gated pair:

- **`WGF-4` uniform-buffer standard layout** — drop the hand-rolled std140 padding for the WebGPU
  standard layout. Mechanical, immediate win. **~3–5 days total. P2 (do first).**
- **`WGF-1` clip-distances** — replace stencil-based clipping with hardware `@builtin(clip_distances)`
  (10–15% fragment perf win). Globe terrain already uses it; primitives + models do not (see
  `WGF-1-EXPAND` in §4.3). **1–2 days. P2.**
- **`WGF-3` shader-f16 for post-process** — opt-in f16 ALU in ColorGrading/FXAA/bloom-HDR (20–40% ALU
  saving). **2–3 days. P2** (overlaps §6.3's WGF-3 note).
- **`WGF-2` dual-source-blending OIT** — 30–50% OIT cost reduction; currently MRT-fallback-only. **Defer**
  pending a real translucent workload. **2–3 days. P2.**
- **`WGF-5` indirect-first-instance + multi-draw-indirect** — scene-dependent, massively parallel.
  **Defer** pending a real batched workload. **3–4 days. P2.**

---

## 5. Post-merge & Parity Gaps (from `WEBGPU_PARITY_AUDIT_2026-06`)

The v1.141-1.143 (and the subsequent v1.142) upstream merge **landed** (`d06742a2ac`, 2026-06-19; see
the memory handoff). The parity audit's **P1 buffer-primitive set is fully closed** (Batches 315-318).
The **remaining parity gaps** (all P2 / doc-drift), de-duplicated against §4:

| Gap | Status | Where |
|---|---|---|
| BufferPolygon-family 2D/CV reprojection | open, needs its own ID | §4 3D Tiles |
| `positionNormalized` + integer position datatypes | open, needs its own ID | §4 3D Tiles |
| EquirectangularPanorama cull-override | ✅ RESOLVED (Batch 317) | §4 3D Tiles |
| Edge `lineStrings` + authored `silhouetteNormals` data paths | open | §4 3D Tiles |
| Voxel default-shader (PR#13517) | blocked behind the voxel-data port | §4 3D Tiles |
| `GeoJsonPrimitive` inventory entry (§A) | doc-drift | reconcile in `FEATURE_INVENTORY.md` |
| Degenerate-triangle edge probe (PR#13421 repro) | open (can't confirm clean) | §4 3D Tiles |

**Remaining drift items** (from `CAMPAIGN_ROADMAP` Phase 9): PickId rebase assessment,
`NEW-MODEL3DTILECONTENT-DOUBLE-CONVERSION`, `NEW-SG-SCAN-ADOPT`, `NEW-WEBGL-REPROJECT-BASELINE`,
`NEW-SYNC-MOVEMAP` (runbook). Adopt `EXT_structural_metadata` vector tiles + OffscreenCanvas imagery at
the next merge.

### 5.1 Cross-reference against `WEBGPU_PARITY_REPORT_2026-06-30.md` §5 (35 not-`full` gaps)

The 2026-06-30 parity report enumerates **35 not-`full` items** (23 partial + 4 stub + 8 missing) across
7 subsystems. Each is routed into this doc (or an explicitly by-design deferral) so none falls through
archival:

| Report §5 subsystem | Items | Where covered here |
|---|---|---|
| 5.1 Globe & Imagery (3 partial, 1 stub, 3 missing) | panorama cull-override (✅ RESOLVED B317, above), clip-distances expansion + clipping-planes-on-primitives stub (→ `WGF-1-EXPAND`, §4.3 + §4.8), GlobeWater facade (§10.1, by-design), point/cube-light shadow (functionally resolved B108/B190 — reconcile inventory), water-classification/WebNN super-res (by-design, §11) | §4.1, §4.3, §4.8, §10.1, §11 |
| 5.2 3D Tiles (6 partial, 1 stub, 1 missing) | voxels stub (§4.2), ClassificationPrimitive `CLASS-GPRIM-WEBGPU`, EXT_structural_metadata DP-H46b/FEAT-3DT2-02, edge `silhouetteNormals`, GeoJsonPrimitive probe debt, Buffer\* 2D/CV, Hi-Z tile bounds (§6.1), per-tile CSM cull (§4.6), FEAT-3DT2-03 ellipsoid-aware RTE, BufferPrimitive integer/normalized (§4.2) | §4.2, §4.6, §6.1 |
| 5.3 glTF (2 partial) | CustomShader WGSL (`NEW-MODEL-WGSL-CUSTOM-SHADER`, §4.3), model metadata pick DP-H46 producer (§3, §4.5) | §4.3, §4.5 |
| 5.4 Geometry & Collections (6 partial) | Polyline/GroundPolyline 2D/CV, Buffer{Point,Polyline,Polygon} 2D/CV + polygon outline, GeoJsonPrimitive | §4.2, §4.4 |
| 5.5 Picking/Shadows/Lighting (3 partial, 1 stub, 4 missing) | voxel cell-pick `C-R9` (§4.5), metadata pick DP-H46 (§3/§4.5), CSM altitude-splits + moon dual-light (§4.6), PCSS/VSM/linear-depth-cast/WSM (§4.6, mostly by-design) | §4.5, §4.6 |
| 5.6 Post-process (2 partial, 1 stub) | user-WGSL-stage transpile (`NEW-VR-USER-POSTPROCESSSTAGE-WGSL-MISSING`), GPU-sort phase-3 (`NEW-GPU-SORT-PIPELINE-PHASE-3`), normal-G-buffer validation (§7) | §4.7, §7 |
| 5.7 Entity (1 partial) | GeoJsonPrimitive pixel-verification debt | §4.2 / `ISSUES_AND_FIXED_BUGS.md` |

**Note on the report's labels:** the report uses `DP-H46e` for the pickMetadata producer where this doc
uses `DP-H46c` (§3, §4.5) — same producer, divergent letter; the doc's `DP-H46c` is canonical here. The
report's "EquirectangularPanorama partial" + "GlobeWater partial" rows are **stale against HEAD** (panorama
fixed B317; GlobeWater facade is intentionally Phase-0.3-scoped, §10.1) — code is the source of truth.

**2026-07-03 update:** several §5.1 rows are overtaken by the Batch 482–506 campaign (§5.2): the
voxels-stub row (the real data path shipped in the 465–481 sprint; octree depth-1 + cell-pick +
user customShader shipped 482–506, §4.2), the edge `silhouetteNormals` row (✅ B495), the voxel
cell-pick `C-R9` row (✅ B498 — superseded by the open `NEW-VOXEL-PICK-OCTREE-COMPOSE` composition
gap, §4.5), and the Buffer\* 2D/CV rows (sprint 465–481; residual
`NEW-BUFFERPOLYLINE-2D-EXTRUSION` ✅ closed 2026-07-03 — mode-aware command BVs, §4.2).

### 5.2 Batch 482–506 parity-campaign closure ledger + post-campaign audit (2026-07-03)

The 25-item WebGL→WebGPU parity campaign (driven from `WEBGPU_PARITY_REPORT_2026-07-01.md` §6)
landed as **Batches 482–506** (`03edcf1f2e..62c5bab450`, 25 commits, 98 files, +16,875/−1,089;
commit messages carry per-item probe evidence + off-gates). All 25 items are **CLOSED**:

| Batch | Item | Subsystem | Note |
|---|---|---|---|
| 482 | `WIRE-COLORGRADING-CALLER` | Post-process | `scene.colorGradingEnabled` runtime flag |
| 483 | `WIRE-MODEL-SPLITTER` | glTF Models | `MODEL_SPLIT_ENABLED` 1<<26 |
| 484 | `WIRE-MODEL-COLOR` | glTF Models | `MODEL_HAS_COLOR` 1<<27; 3 blend modes |
| 485 | `WIRE-MODEL-SILHOUETTE` | glTF Models | stencil two-pass parity, `MODEL_SILHOUETTE` 1<<28 |
| 486 | `WIRE-PP-LIBRARY-BUILTINS` | Post-process | 7 library builtins (→ `NEW-PP-LIBRARY-TONEMAP-ORDER` residual, §4.7) |
| 487 | `GLOBE-UNDERGROUND-COLOR` | Globe & Imagery | (→ `NEW-GLOBE-BELOW-SURFACE-DARKENING` residual, §4.1) |
| 488 | `GLOBE-TRANSLUCENCY-ALPHA` | Globe & Imagery | atmosControl.w gate; landed at 22.9% diff (residual §4.1) |
| 489 | `GLOBE-HDR-GAMMA` | Globe & Imagery | sRGB→linear under HDR canvas |
| 490 | `POINT-SPRITE-SHAPE` | glTF Models | point-cloud square sprites + size/attenuation |
| 491 | `GLTF-POINTS-MODE` | glTF Models | mode-0 point-list topology |
| 492 | `METADATA-MULTICOMPONENT` | Metadata | vec4 property-attribute transport |
| 493 | `METADATA-UINT16-32` | Metadata | WGSL decode + **dual-backend** WebGL UINT32 pick fix |
| 494 | `GLOBE-CLIPPOLY-GEODETIC` | Globe & Imagery | spherical fast-atan parity |
| 495 | `EDGE-AUTHORED-SILHOUETTE-NORMALS` | 3D Tiles | authored signed-byte accessor consumed |
| 496 | `PARITY-RTE-ELLIPSOID-AWARE` | Shadows/CSM | cascade ground-fit uses scene ellipsoid |
| 497 | `VOXEL-SHAPEUV-CONVENTION` | Voxels | world→shapeUv fix (the B477 blocker) |
| 498 | `VOXEL-CELL-PICK-RELAND` | Voxels | closes `C-R9` (→ `NEW-VOXEL-PICK-OCTREE-COMPOSE`, §4.5) |
| 499 | `MODEL-SCENE-MODES` | glTF Models | 2D/CV render (→ `NEW-MODEL-SCENE2D-SHADING` residual, §4.3) |
| 500 | `METADATA-TABLE-SOURCES` | Metadata | property tables for TEXTURE + IMPLICIT feature-ID sources |
| 501 | `PARITY-VOXEL-OCTREE-LOD` | Voxels | depth-1: root + 8 L1 children (deeper levels open, §4.2) |
| 502 | `GLOBE-POLAR-STRETCH` | Globe & Imagery | double vertical flip in `ReprojectWebMercator.wgsl` |
| 503 | `VOXEL-USER-CUSTOMSHADER` | Voxels | native-WGSL user shaders, `VOXEL_USER_CUSTOM_SHADER` 1<<29 |
| 504 | `ENV-SKYBOX-STARMAP` | Environment | cube-map flipY parity + default-off cloud occlusion |
| 505 | `ENV-MOON-SLIVER` | Environment | model-space RTE full disc |
| 506 | `GLOBE-POLAR-STRETCH-POLISH` | Globe & Imagery | seam grid + ocean glint (stales the colorgrading baseline, §4.7) |

**Registry hygiene (verified at HEAD):** the campaign added exactly 4 add-only `ShaderDefine` tail
bits (1<<26..1<<29) → **30 live bits** (1<<0..1<<29, contiguous), of which **6 bits ≥24** live
outside the 24-bit numeric cache window and are disambiguated via keySalt
(`${numericKey}#${keySalt}` in `WebGPUShaderModuleCache.getOrCreate`). `ShaderSourceId` stands at
**39 registrations** (1..39, 0 reserved) — zero new this campaign. 23 new `probe-*.mjs` (441
total in `Tools/visual-regression`).

**Post-campaign audit outcome (2026-07-03, HEAD `62c5bab450`): ISSUES-FOUND.** Probe sweep:
20 PASS, 3 real FAIL, 1 stale-baseline FAIL (`probe-colorgrading-wired` gate F), 1 dismissed
WebGL-side flake (`probe-voxel-cell-pick` run 1). All three user-reported bugs (polar stretch,
skybox, moon) are verifiably fixed. The **four confirmed OPEN issues** — recorded honestly, not
papered over — prioritized:

| Priority | ID | One-liner | Where |
|---|---|---|---|
| **P1 — FIX NOW** | `NEW-VOXEL-PICK-OCTREE-COMPOSE` | pick march lacks L1 octree traversal + hardcodes megatextureId 0 (wrong pick under refinement); same fix carries the user-customShader alpha-gate composition gap | §4.5 |
| **P1** | `NEW-GLOBE-BELOW-SURFACE-DARKENING` | ✅ RESOLVED 2026-07-03 (Batches 510/512/513): water masks never uploaded → ocean-shading over land tiles; probes now 1.43/4.28% (limit 8) + 4.00/0.54% (limit 11.9) under un-loosened limits (see §4.1 entry) | §4.1 |
| **P2** | `NEW-MODEL-SCENE2D-SHADING` | 2D model olive vs blue-gray (interiorDiff 34.27); suspect SCENE2D light-direction/IBL orientation, NOT globe-related | §4.3 |
| **P2** | `NEW-PP-LIBRARY-TONEMAP-ORDER` | ✅ RESOLVED 2026-07-03 — post-tonemap placement + plain-HDR tonemap gate + exact Khronos PBR-Neutral WGSL port (see §4.7 entry; scene-side residue → `NEW-PLAIN-HDR-SCENE-GAMMA-EPIC`) | §4.7 |

**Small open tail from the same audit:** `NEW-ENV-MOON-CRESCENT-PROBE` (crescent-phase probe
extension, §4.7), `NEW-PP-F16-DEVICE-VERIFY` (on-device shader-f16 pixel-verify, RTX-class,
§4.7), `NEW-VOXEL-OCTREE-DEEP-LEVELS` (octree levels beyond depth-1, §4.2),
`NEW-BUFFERPOLYLINE-2D-EXTRUSION` (✅ closed 2026-07-03, §4.2), and the `probe-colorgrading-wired` stored
baseline refresh (✅ closed 2026-07-03, §4.7; the `probe-hdr-pp-math` baseline refresh remains open). Sweep hygiene note: `probe-collections-regression` + `probe-pick-basic`
default `PROBE_BASE` to `:8134` — set `PROBE_BASE=http://localhost:8080` when re-running.

---

## 6. Performance Roadmap

### 6.1 Dormant compute consumers

The fork ships several **GPU-compute substrates wired as threshold-gated consumers**:

- **gpuCuller** ✅ wired (Batch 209), **HiZ + sort-keys** ✅ wired (Batches 210/211), **GPU bitonic
  sort** ✅ shipped (Batch 228; Phase-3 RenderScheduler consumer = open `NEW-GPU-SORT-PIPELINE-PHASE-3`).
- **FORK-41 HiZ occlusion command-drop** ✅ now DEFAULT ON (C2-21) — the "5-20× on dense 3D Tiles left on
  the floor" is **reclaimed**.
- **`WebGPUComputeEngine`** ✅ wired into `WebGPUContext` (Batch 367, `NEW-WEBGPU-COMPUTE-ENGINE-WIRING`)
  — this had been the dormant-dispatch blocker for the atmosphere LUTs; now live (verified at HEAD: the
  `WebGPUContext.computeEngine` getter lazily instantiates `WebGPUComputeEngine`).
- **Atmosphere multi-scatter + irradiance LUTs** — infrastructure ✅ SHIPPED (Batch 306,
  `AtmosphereLUT.wgsl` + `WebGPUAtmosphereLUT.ts`): the extended `computeMultipleScattering` +
  `computeIrradiance` entry points + group-1 bind groups are wired. Now that the compute engine is live
  (Batch 367) **and** the `NEW-WEBGPU-ATMOSPHERE-LUT-BGL-INCOMPAT` device error is fixed (Batch 396,
  below), the runtime LUT dispatch runs without device errors. (Batch 311 AerialPerspective still uses
  analytic marching rather than LUT reads — folding that path onto the now-running LUTs is a follow-up.)
- **`NEW-WEBGPU-ATMOSPHERE-LUT-BGL-INCOMPAT`** — ✅ **RESOLVED (Batch 396, `b5bdc9e59c`).** (Round-2 doc
  review correction: round-1 lifted the "still blocked / not root-caused" framing from
  `CAMPAIGN3_PROGRESS.md`, which predated the fix.) The `SkyAtmosphere` LUT dispatch raised an
  invalid-command-buffer **device error** on every sun-LUT recompute. **Root cause:** the atmosphere-LUT
  compute pipelines were built `layout:"auto"`, which derives a pipeline-owned bind-group layout and
  rejected the explicit `AtmosphereLUT_BGL` ("was not created by the pipeline"). **Fix:** thread optional
  `bindGroupLayouts` through `computeEngine.getOrCreatePipeline` (base dispatch `[lut.bindGroupLayout]`,
  extended `[emptyGroup0BGL, extendedBindGroupLayout]`). **Verified:** new
  `probe-atmo-lut-no-device-error.mjs` asserts 0 GPU errors (was filtered `/Atmosphere ?LUT|SkyAtmosphere/`
  pre-fix); the Bruneton full-LUT compute passes (Batch 306 infrastructure) now run.

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

### 6.5 Webgpu-only bundle strip — B25 scoping spike (`NEW-WEBGPUONLY-BUNDLE-SPIKE`, 2026-07-03)

**Question scoped:** is the multi-campaign refactor to break Scene's static import of the WebGL
`Renderer/Context.js` (so webgpu-only bundles can strip the WebGL backend) worth doing?
**Measured answer: NO — the size premise is stale.** Doc-only spike; no production code changed.
All numbers measured at HEAD `8c544b7a2c`, minified.

**(a) Import-graph inventory**

- Runtime static importers of `Context.js` are only **3 files**: `Scene.js:30` (fallback
  `new Context(canvas, …)` at :182), `ContextFactory.ts:27` (`_createWebGLContext`), and
  `SharedContext.js:4` (composition, not subclass). The other `Context.js` references in Scene
  (`BufferPrimitiveCollection`, `GlobeSurfaceShaderSet`, `QuadtreeTileProvider`, `DrawCommand`) are
  JSDoc `/** @import */` type comments — erased, no bundle cost.
- The Scene layer statically imports **~39 distinct `Renderer/*` modules from ~500 sites**
  (RenderState ×40, Pass ×38, ShaderSource ×33, DrawCommand ×31, Texture ×28, ShaderProgram ×23 …).
  Most are **backend-shared under WebGPU** (UniformState, AutomaticUniforms, RenderState, DrawCommand,
  ShaderBuilder/ShaderSource feed the compat/translation layer) and can never be stripped.
- Metafile attribution of the webgpu-only ESM bundle (8.09 MB): WGSL strings **2.13 MB**, Scene
  1.90 MB, Renderer/WebGPU 1.40 MB, Core 0.65 MB, and the **entire non-WebGPU `Source/Renderer/`
  directory = 177.4 KB (2.2%) across 55 modules** (top: Context.js 16.2 KB, UniformState 14.3 KB,
  AutomaticUniforms 10.8 KB, RenderState 8.3 KB, Texture 7.1 KB, ShaderProgram 6.4 KB). GLSL strings
  contribute 0 bytes — the existing stub aliasing works.
- Current variant sizes for context: dual 9.90 MB / webgpu-only 9.25 MB (−6.5%) / webgl-only
  6.14 MB (−38%). The asymmetry is **dominated by the WebGPU side simply being bigger**
  (WGSL 2.13 MB + WebGPU renderer 1.40 MB vs GLSL 0.65 MB + WebGL renderer 0.18 MB) — NOT by the
  Scene→Context static import, which the older docs blamed.

**(b) Measured prototype size deltas** (scratch esbuild config mirroring `bundleCesiumJs`,
IIFE + minify, internally consistent; prototype plugin stubs modules via `emptyModule.js`):

| Configuration | IIFE bytes | Δ vs base |
| --- | --- | --- |
| base (webgpu-only plugin as shipped) | 8,327,335 | — |
| seam-1: stub `Renderer/Context.js` only (the factory boundary) | 8,309,017 | **−18.3 KB (−0.22%)** |
| ceiling: stub 11 clearly-WebGL-only leaves¹ | 8,281,671 | **−45.7 KB (−0.55%)** |
| absolute upper bound (all 55 modules, incl. non-strippable shared ones) | — | −177 KB (−1.9%) |

¹ Context, SharedContext, WebGLStarFieldRenderer, demodernizeShader, ShaderProgram, ShaderCache,
createUniform, createUniformArray, ComputeEngine, Sync, freezeRenderState. All three prototype
bundles module-load cleanly in Node (no module-scope access reaches the stubs).

**Runtime blockers found** (prerequisites if leaf-stripping is ever pursued):

1. `scripts/stubs/emptyModule.js` is default-export-only — `Scene/ComputeInstanceCollection.js`
   imports **named** exports from `WebGLComputeInstanceRenderer.js`, which is a hard esbuild error.
   Needs a named-export-aware stub mechanism.
2. The `emptyModule` Proxy get-trap returns a throwing callable for `Symbol.hasInstance`, so
   `options.contextOptions instanceof SharedContext` (`Scene.js:177`) would **throw at Scene
   construction even on the pure-WebGPU path**. The trap must whitelist `Symbol.hasInstance`
   (return `undefined` so `OrdinaryHasInstance` falls through to `false`).

**Bigger lever found:** bundled WGSL strings retain their comments even in minified bundles
(16,631 `// ` occurrences in the minified IIFE). Comment + blank-line stripping across the 305
`.wgsl` files = **330 KB (15.2% of 2.18 MB raw)** — ~7× the strip ceiling at near-zero
architectural risk. CAUTION: any stripper MUST preserve the `//>>` directive families
(`//>>ifdef`/`//>>else`/`//>>endif` for `WebGPUShaderPreprocessor`, `//>>includeStart`/`//>>includeEnd`
for pragma stripping).

**(c) Increment plan (batch-sized, next campaign)**

1. `NEW-WGSL-STRING-COMMENT-STRIP` (P2, S/M) — strip comments/blank lines from WGSL string modules
   in minified/variant builds (`wgslToJavaScript` minify path), preserving `//>>` directives.
   Expected ~−330 KB on every variant including dual. Off-gate: unminified build byte-identical;
   preprocessor spec suite green.
2. `NEW-EMPTYMODULE-STUB-HARDENING` (P3, S) — `Symbol.hasInstance` whitelist + named-export stub
   mechanism (runtime blockers 1+2 above). Zero effect on shipped bundles; prerequisite for 3.
3. `NEW-WEBGPUONLY-RENDERER-LEAF-STRIP` (P3, S, after 2) — add the 11-leaf WebGL-only list to
   `bundleVariantPlugin` for webgpu-only (−46 KB); extend `Tools/variant-smoke-test.mjs` to
   boot-check webgpu-only and assert the stub error surfaces on a forced-WebGL request.
   Optional hygiene — not size-driven.
4. **EXPLICITLY DROPPED:** the original epic — dynamic-import seam for `Context.js` in
   ContextFactory/Scene + reworking the ~500 Scene→Renderer import sites. IIFE inlines dynamic
   imports (only plugin stubbing shrinks the IIFE), ESM-splitting builds keep `Context.js` in the
   main chunk via Scene's static import regardless, and the whole prize is ≤177 KB (<2%). Fails
   cost/benefit at every increment size.

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

- **Tiered clouds V0-V16** ✅ functionally COMPLETE (2026-06-30 reconcile, `CAMPAIGN3_PROGRESS.md`). V0
  (LUT auto-layout fix) → V1 (quality-tier preset scaffold, `qualityFlags@74` lane) → V2/V3 (baked 3D
  Perlin-Worley + flip density core to baked textures, KEYSTONE, Batches 396-408) → V4 (mean-preserving
  erosion + `erosionStrength`) → V5 (Frostbite multi-scatter octaves, `msDecayA/B/C` geometric decay) →
  half-res march (`CLOUD-HALFRES`, Batch 432) → temporal reprojection (`CLOUD-TEMPORAL`, Batch 433) →
  IGN jitter → curl (Batch 439) → per-genus vertical profiles + `profileExtinction` (V11, Batch 452) →
  multi-deck (Batch 443) → cloud shadows (Batch 437) → god-rays → precip (Batch 444). The tiered-cloud
  features all shipped under the **improvement-plan naming** (atmosphere/cloud arc, Batches 437-452), NOT
  the V0-V18 numbering, which is why the v2 tracker drifted. **`CloudUniforms` is 128 floats** (grew
  add-only: 64→80→96→128, verified `CLOUD_UNIFORM_FLOATS` in `WebGPUProceduralCloudRenderer.ts`). Public
  dial: `globe.cloudVolumetricQuality` ∈ `'low'|'medium'|'high'|'auto'` + escape hatch
  `globe.cloudQuality` (raw `maxSteps` int, default 64). **Only V17 (baked-impostor far-field) remains —
  deferred as speculative Ultra-only research.** Campaign 3 v2 is CLOSED; next major work = the DP-H46
  metadata epic.
- **Weather recreation Phase 0-1** ✅ (Batches 384-387): clock-bind motion, 11 WMO genera +
  `CloudTypeProfile.js`, Worley erosion + multi-scatter, **the weather-map seam C2-16 (the keystone)**.
- **Weather data ingest Phase 0-3** ✅: MVP EDR→weatherTex R-only (Batch 410), P2 time model
  live/historical/projected (Batch 416), P3-core first G/B/A WGSL reads + mock-EDR harness (Batch 424),
  P3-sources `MetarWeatherSource` + `WcsCoveragesWeatherSource` (Batch 425). **Phase 3 is COMPLETE
  offline** (mock fixtures cover everything except the live network hop).
- **Weather config + Weather Inspector demo** (Batches 403-405); standards-keyed METAR/WMO presets.
- **Atmospheric effects A-E** wired, including `effects.precipitation`→WebGPU weather particles
  (Batch 423).
- **Cloud parity trilogy** ✅ (B363 shape + B365 grain + B366 size = WebGL parity):
  - **`NEW-WEBGPU-CLOUD-WORLEY-TEXTURE-PARITY`** ✅ SHIPPED (Batch 365) — volumetric clouds were using
    inline worley-FBM (grain-less vs WebGL's baked texture); fixed with a pre-computed 512-point worley
    cell atlas (3-channel, NEAREST-sampled) so the baked texture matches WebGL's grain exactly.
  - **`NEW-WEBGPU-CLOUD-SIZE-PARITY`** ✅ SHIPPED (Batch 366) — the cloud quad VB spans `quadPos[-1,1]`
    but the VS scaled the FULL quadPos, making clouds ~2× too wide. A single `*0.5` on the quad offset in
    `vertexMain`+velocity fixed it (filled-px 4.3×→1.08×, area 2.41×→0.99×). A vertex-buffer geometry
    bug, **not** a shader-math root cause.

### 8.2 Open cloud/weather tail (the frontier)

- **Weather Phase 4 — direct GRIB2/NetCDF behind WASM** — **CRITICAL-PATH item** (§3). The high-fidelity
  NODD-S3 (HRRR/GFS/NBM) tier requires: (a) a **same-origin proxy** to work around the S3 NODD CORS
  restriction, (b) GRIB2 file parsing in a Worker/WASM (`Grib2FileWeatherSource`), (c) Lambert-Conformal→
  equirect reprojection in the packer before upload to the weather texture. **Soft dependency on the
  proxy:** it is not built, so the data sources cannot be tested until a proxy is available. **P2,
  ~1-2 wk.**
- **Live EDR network confirm** — `EdrWeatherSource` is wired but the LIVE call + CORS + the guessed
  collection id (`automated_gfs`) need confirming in a networked browser (the dev sandbox has no
  outbound network). **P1 (blocked on environment).**
- **`profileExtinction` (slot 103)** — activated Batch 452, but Principle-9 follow-up: G biases shape/
  density; full **per-position optical extinction** is the remaining fill-in. **P2.**
- **WeatherSystem / WeatherDataProvider public API** (`WEATHER_RECREATION_ROADMAP` Phase 3) —
  **PARTIALLY WIRED (re-verified at HEAD).** The backend-neutral data core exists: `packages/engine/Source/
  Scene/Weather/` ships `WeatherProvider.ts`, `WeatherSource.ts`, `EdrWeatherSource.ts`,
  `MetarWeatherSource.ts`, `WcsCoveragesWeatherSource.ts`, `CoverageJsonParser.ts` (abstract provider +
  concrete EDR/METAR/WCS sources), and **`globe.weatherProvider` IS wired and functional** (set via
  `globe.weatherProvider = <WeatherProvider>`). What is **NOT** present is a top-level **`scene.weather`
  facade** consolidating clouds/weather/atmospheric-conditions under one stateful owner — today the
  weather-access point is `globe.atmosphericConditions` + `globe.weatherProvider`, and `Scene.js` exposes
  no `scene.weather` property. Still to do: the explicit WebGL degradation ladder (equirect imagery
  overlay / billboard CloudCollection — volumetric is WebGPU-only by design) and the consolidated public
  contract. **P2** — formalize the `scene.weather` facade + dispatcher; the data sources + `weatherProvider`
  dial already work.
- **Cloud perf — Tier-2 3D bake (view-local cascaded clipmap)** (`WEATHER_RECREATION_ROADMAP` Phase 6) —
  the production path for volumetric clouds: a **small resident global 2D weather map** (Tier 1) feeding
  a **view-local camera-anchored 3D density bake** (Tier 2, a cascaded clipmap like volumetric fog)
  updated per frame as the camera moves. This avoids the infeasible uniform fine global 3D grid
  (~0.5 GB). The main volumetric raymarcher today is **Tier 1 only** — it samples the 2D map directly
  per ray; Tier 2 is explicitly deferred to a separate **post-core campaign** and modeled on
  `WebGPUVolumetricFogRenderer`. **P2, own campaign.**
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

### 9.4 Atmosphere / celestial design rationale (carry-forward from `CELESTIAL_ATMOSPHERE_DESIGN.md`)

These decisions underpin the shipped atmosphere/cloud/fog stack and are load-bearing for any future
multi-light, multi-body, or quality-tier work. Detail lives in `CELESTIAL_ATMOSPHERE_DESIGN.md`
(decisions B1–B23 locked 2026-04-08).

- **Canonical home — `scene.globe.atmosphericConditions.*`.** The original v2 design proposed toggles
  scattered across `scene.atmosphere.*`, `globe.atmosphere*`, and `scene.fog.*`. The Phase 0 prep PR
  (shared with the water design) introduced the nested canonical home `scene.globe.atmosphericConditions.*`
  consolidating all atmospheric state (lighting, skyAtmosphere, groundAtmosphere, fog, volumetricFog,
  varyingAtmosphereDensity, clouds, night, weather, effects). Every legacy scattered location
  (`scene.atmosphere`, `scene.fog`, `globe.enableLighting`, …) becomes a delegating getter/setter shell
  over the canonical home, so existing apps keep working unchanged; new toggles go under the canonical
  nested tree (§3 of the design doc lists the full structure).
- **Multi-light atmosphere — Option A (two LUTs per frame) chosen over Option B (light-direction-
  independent LUT).** To add moon scattering to the Nishita atmosphere, two paths were surveyed.
  **Option A** (shipped): recompute the inscatter LUT when the sun moves, then compute a second LUT with
  the moon as light when it is above horizon, scaled by moon intensity × phase fraction; the runtime
  shader samples both LUTs and sums (`SkyAtmosphere.wgsl` dual-LUT path, Batch 438 `SKY-MOON`). Cost: 2×
  LUT compute (~786K shader invocations per LUT, <1 ms on a modern GPU). **Option B** (deferred): a
  single light-direction-independent LUT (larger table, bigger startup compute, scales to N lights) — a
  migration target if N-light or perf demands it. Both documented in design §4.3.
- **Volumetric fog froxel resolution bands** (B7/B17). Three tunable grids: **Low** 80×45×64 (230K
  froxels, ~0.5 ms), **Medium** 160×90×128 (1.8M froxels, ~2.7 ms on RTX 3060), **High** 240×135×192
  (6.2M froxels, ~9 ms). Each froxel stores scattered-light + transmittance (rgba16float; ~58 MB at
  Medium). Mobile defaults to Low, desktop to Medium, High is opt-in for high-end; the dial
  `atmosphericConditions.volumetricFog.quality` ∈ `'low'|'medium'|'high'|'auto'` ('auto' adapts via the
  VisualPerformanceTargetService, §11). Three-pass pipeline (density injection → light scattering →
  ray-march integration) in `WebGPUVolumetricFogRenderer.ts`; **default OFF per B18** (opt-in, byte-zero
  when disabled).
- **Atmospheric effects auto-master (`atmosphericConditions.effects.auto`).** An effects layer maps
  `{temperature, dewpoint, RH, visibility}` → fog density/tint, atmosphere saturation/brightness, and
  cloudType/cloudLayerBottom bias. The auto-master toggle (**default OFF per B9**) derives every effect's
  enabled+intensity from the weather when on; each effect (`shimmer`, `groundFog`, `optics`,
  `precipitation`) is independently toggleable, and when `auto` is true `applyAtmosphericConditions()`
  overwrites them from the weather scalar field. Per the B9 silent-gating rule, scattering-occlusion +
  varying-atmosphere-density have no visible effect when `volumetricFog` is disabled (no participating
  media to scatter through). The shipped effects land under the improvement-plan naming — heat shimmer,
  ground-fog volumetric, cold optics (22° halo + sun-dogs + light pillars, `COLD-OPTICS-HQ` Batch 442),
  precipitation wiring (`PRECIP-DATA` Batch 444) — all OFF + `auto` false by default (byte-neutral).
  _(Note: the standalone `ATMOSPHERIC_EFFECTS_ROADMAP.md` is a later 2026-06-26 planning doc whose
  "no effect modules built yet" front matter predates the improvement-plan effect batches recorded in
  §9.1; trust §9.1's shipped batches over that doc's status line.)_

---

## 10. Water / Vegetation Build Plans

Both are **design-complete, code-minimal** — locked designs awaiting scheduling. Full designs stay in
their docs; only the roadmap disposition is here.

### 10.1 Water (`WATER_RENDERING_DESIGN.md`, v2, C1-C14 decisions locked)

**Status:** Phase 0 + 0.3 DONE — the `GlobeWater.js` canonical-home facade (`scene.globe.water`)
delegating to the legacy `showWaterEffect`/`oceanNormalMapUrl`/enhanced-ocean fields. **Phases 1-9
UNBUILT** — no `WaterClassificationProvider`, Gerstner surface shader, bathymetry, foam, caustics, river
pipeline, or `WaterRegion` collection exists.

**Canonical-home refinement (Phase 0.3) — `scene.globe.water`, NOT `scene.water`.** The original
2026-04-08 design planned `scene.water.*` as the namespace; Phase 0.3 refined this to **`scene.globe.water.*`**
for three reasons: (1) every existing water property already lives on `Globe` (`showWaterEffect`,
`oceanNormalMapUrl`, `enableEnhancedOcean`, the ocean tunables); (2) water is rendered as part of terrain
via the water mask, so it conceptually belongs to the globe; (3) it pairs symmetrically with
`scene.globe.atmosphericConditions`. The facade is live (`Globe.get water()` → `this._water`, a
`GlobeWater` instance wired by `Scene` after construction). Every planned toggle in
`WATER_RENDERING_DESIGN.md` §5 is accessed through the **`scene.globe.water.*`** home; backward-compat
shells preserve the legacy `showWaterEffect`/`oceanNormalMapUrl`/`waterEffectsEnabled` leaves as
delegating getters/setters over the canonical home. _(Verified: `GlobeWater.js` exists; `Globe.js`
`get water()` returns `this._water`. The design doc's `Globe.js:560` line cite is stale — the getter is
near `Globe.js:826` at HEAD — but the facade itself is live.)_

**Phases 1–9 build sequence** (`WATER_RENDERING_DESIGN.md` §6) — each phase is 0.5–2 sessions; total v1
effort est. ~8.5 + 1–2 prep sessions. Design decisions C1–C14 are locked (2026-04-08 research report):

- **Phase 1 — classification provider:** `WaterClassificationProvider` skeleton, RGBA mask texture,
  `WaterRegion` API (can use an OSM-vector source). **P2.**
- **Phases 0-2 — Gerstner surface v1 (depth-independent):** Gerstner shader + type LUT + imagery-tinted
  base color + Fresnel reflection. Buildable in parallel now. **P2.**
- **Phase 3 — bathymetry & depth:** water datum mesh, depth-buffer sampling, Beer-Lambert attenuation,
  refraction. Samples scene depth = the renderer-wide depth contract; **now UNBLOCKED** (the log-depth
  epic it was gated on shipped at Batch 251). **P2.**
- **Phase 4 — foam & caustics. Phase 5 — rivers** (flow pipeline, OSM/HydroRIVERS classification).
  **Phase 6 — underwater & god rays** (optional froxel integration). **Phase 7 — spatial control** via
  `WaterRegion`. **Phases 8–9 — FFT ocean, ML-segmented water, quantized-mesh Option B version bump**
  (6–12 months after Option A production experience). **All P2.**

**Quantized-mesh water extension — Option A (ships now) vs Option B (Phase 9+)** (`WATER_RENDERING_DESIGN.md`
§9; decision C11 chose Option A per the research report §8.3):

- **Option A (additive, opt-in):** extension ID `0x05` appends RGBA texel buffers (waterType +
  flowVector) AFTER the existing 1-bit water mask, skipped by old clients via the length prefix. Optional
  payload: `texelCount` (1 uniform or 256×256 per-texel), `waterType[texelCount]` (enum 0–8),
  `flowVectorX/Y` (int16, optional). **Zero coordination required with existing producers** — they emit
  ID `0x02` (water mask only) and the system falls back to the legacy path. Rationale: additive + opt-in
  lets us iterate on the wire format with real-world data first.
- **Option B (deferred to Phase 9+):** a formal quantized-mesh format version bump promoting water fields
  to first-class status, adding higher-precision flow + per-texel depth/turbidity. Sequenced AFTER
  ecosystem coordination (cesium-native, Cesium for Unreal, third-party tilers). **P2.**

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

- **`DP-H47`** (czm_atmosphere auto-uniform suite) — the root cause is architectural: every WebGPU
  atmosphere renderer (`SkyAtmosphere`, Clouds, GlobeGroundAtmosphere, ModelAtmosphere — **four
  renderers**) hand-rolls its own `frameState.atmosphericConditions` pull into local UBO/shader
  variables; there is **no shared `csm_atmosphere*` auto-uniform suite**, so a custom `scene.atmosphere`
  parameter set once applies in one renderer and is silently defaulted in the others. The fix is a
  unified atmosphere-uniform architecture spanning all four (a multi-renderer uniform-layout change, NOT
  a bug-bash partial). Confirmed real (Batch 304 re-triage). **P2.**
- **`NEW-WEBGPU-GRID-MATERIAL-PATTERN-MISSING`** — **symptom not reproduced (2026-06-23):** the grid
  LINES render correctly on grazing faces matching WebGL (Batch-356 probe PNGs read). Residual latent
  nuance only: UV-space `step` line-width vs WebGL's derivative-based constant-pixel width (needs a
  multi-zoom probe to expose). No fix required. **P2** (see §4.3). _(was: "grid lines don't render on
  WebGPU" — that note is stale.)_
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

- ~~EquirectangularPanorama cull-override (§4 3D Tiles)~~ — **RESOLVED on re-check: fixed at Batch 317**
  (`WebGPUPrimitiveCommands.js` honors `renderState.cull.enabled:false`). No longer a verify item.
- CSM Slice-3 altitude-adaptive splits (§4 Shadows) — **defined in `CSM_DESIGN.md` as a planned Slice 3
  item, but no git batch matches "altitude-adaptive splits"** → UNVERIFIED/UNSTARTED, not OPEN.
- WGF-1..5 perf variants (§6.3) — stale execution-roadmap shorthand; re-scope if revived.
- WeatherSystem/`scene.weather` public facade (§8.2) — partial source classes exist; the public facade
  wiring is unconfirmed.
- The morph cluster (§12) — all explicitly carried as "unverified" in the source; each needs a probe.

**Source docs whose content is now FULLY realized (candidates for archive after review):**
`ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md` (only AERIAL-FROXEL open), `WEBGPU_EXECUTION_ROADMAP.md` (spine
shipped), `WEBGPU_PARITY_AUDIT_2026-06.md` (P1 set closed), the Track-V portion of `CAMPAIGN_ROADMAP`.
