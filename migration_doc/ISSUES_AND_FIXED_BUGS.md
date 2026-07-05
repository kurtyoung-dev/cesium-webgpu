> **Canonical doc (consolidation first draft, 2026 consolidation).**
> Supersedes (folds into this register): `audits/2026-06-11_ULTRA_REVIEW.md`, `AUDIT_2026_05_02.md`, `FORK_DRIFT_ANALYSIS_2026-06-11.md`, `PLAN_2DCV_MORPH_BATCHES.md` (findings half), `SLICE_5D_PLAN_CLUSTERED_LIGHTING.md` (defect half), `PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`, `audits/2026-04-30_FORK_FEATURE_INVENTORY.md`, `audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md`, `archive/REVIEW_FIX_PROGRESS.md`, `archive/PICKING_ANALYSIS.md`, `archive/SORTING_ARCHITECTURE_ANALYSIS.md`. **Links (does NOT supersede):** `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md` (the standalone `C-R*/H-R*/M-R*` finding-ID definitions stay there) and `WEBGPU_DEBUGGING_LOG.md` (the full chronological bug log — this register summarizes, it does not replace it).
> **Review-in-progress.** First draft for the maintainer's review rounds.

---

# Issues & Fixed-Bugs Register — CesiumJS WebGPU Fork

**HEAD at consolidation:** `3b146e42a8` (Batch 455). **Last full audit sweep:** `audits/2026-06-11_ULTRA_REVIEW.md` (HEAD `f6fd367827`, Batch 220). **Newest parity snapshot folded in:** `WEBGPU_PARITY_REPORT_2026-06-30.md` (HEAD `baa3f62d43`, Batch 458) — the source of the three §3.2 parity-residual entries (FEAT-3DT2-03, panorama cull-override, GeoJsonPrimitive verification debt). **Campaign update (2026-07-03):** the 25-batch parity campaign (Batches 482–506, `03edcf1f2e..62c5bab450` = HEAD) is folded in — headline fixed-bug postmortems in §6.10, the campaign audit's four confirmed-open findings in §3.3.

> ⚠️ **CRITICAL ACCURACY NOTE FOR REVIEWERS.** The primary source audits are **stale by ~230–300 batches**. The 2026-06-11 ultra-review was taken at Batch 220; the per-feature review at Batch ~56; the cross-coupling audit at Batch ~159. **HEAD is Batch 455.** When this consolidation re-verified each headline status against the live code + `git log`, the overwhelming majority of the audits' "open CRITICAL/HIGH" findings had **already shipped** (Batches 221–360). This register reflects the **re-verified live state**, not the stale source tags. Where a status could not be confirmed against the current tree, it is marked **`status: verify`** rather than asserted. **Section 2 (open CRITICAL) is nearly empty for exactly this reason** — that is the correct, re-verified result, not an oversight.

---

## 1. How This Register Works

### 1.1 ID taxonomy

The fork's defect IDs come from several review generations. They are **not** renumbered here; the same defect often carries two IDs (an audit ID + a DEFERRED_WORK ID) — those are **chained** to one entry.

| Prefix | Origin | Meaning | Definition source (authoritative) |
|---|---|---|---|
| `A<n>.<m>` | `audits/2026-06-11_ULTRA_REVIEW.md` Axis A | WebGPU-vs-our-WebGL parity/correctness/perf finding | the ultra-review doc + `_findings.json` sidecar |
| `B<n>` (drift) | `audits/2026-06-11_ULTRA_REVIEW.md` Axis B | our-WebGL-vs-upstream fork-drift finding | the ultra-review doc + `FORK_DRIFT_ANALYSIS_2026-06-11.md` |
| `A.<n>` / `B.<n>` / `C.<n>` / `D.<n>` | `AUDIT_2026_05_02.md` | cross-coupling: BREAKING / PARTIAL / LATENT / STALE-STATUS | `AUDIT_2026_05_02.md` |
| `B-<n>` / `C-P<n>` / `H-P<n>` | `PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md` | per-feature: BLOCKER / CRITICAL-at-planetary-scale / HIGH | the per-feature review doc |
| `C-R<n>` / `H-R<n>` / `M-R<n>` | `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md` | renderer-deep: CRITICAL / HIGH / MEDIUM | **stays standalone — LINK, don't copy** (see §9) |
| `NEW-*` | `DEFERRED_WORK.md` | the live, tracked work-item ID for a finding (the durable handle) | `DEFERRED_WORK.md` |
| `DP-H<n>` | DEFERRED_WORK / design docs | "deferred-pick / high" picking-and-precision epic IDs | `DEFERRED_WORK.md`, `DP-H46_METADATA_DESIGN.md` |
| `BUG-<n>` / `Session.Bug` | `WEBGPU_DEBUGGING_LOG.md` | a fixed bug from the chronological log | `WEBGPU_DEBUGGING_LOG.md` |
| `FORK-<n>` | DEFERRED_WORK | cross-backend Sandcastle/visual-regression sweep findings | `DEFERRED_WORK.md` |

**Chaining rule:** when one defect has multiple IDs, this register prints **one entry** under its most-recognizable ID and lists the aliases. Example: the WebGPU picking break is **A6.1 ⇄ DP-H44/45/46 ⇄ NEW-PICKDEPTH-CAPABILITY-READBACK ⇄ NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION** — one root cause, one entry (§6.1).

### 1.2 Severity tiers

- **CRITICAL** — broken/wrong user-visible output on a default-reachable path, or a build break. (ultra-review CRITICAL; per-feature BLOCKER; cross-coupling BREAKING.)
- **HIGH** — silent feature drop, async hazard, device-loss gap, or a dominant per-frame perf regression vs WebGL's in-place state model.
- **MEDIUM** — incomplete in adjacent scenarios; parity drift not forced by the backend; non-dominant allocation churn.
- **LATENT / LOW** — works today, future risk (unbounded caches, orphan scaffolding, fragile keys).

### 1.3 Status vocabulary (re-verified)

- **OPEN** — confirmed still-broken against the live tree (or `status: verify` where the tree could not confirm).
- **FIXED (Batch N)** — re-verified shipped; root cause + fix recorded in §6.
- **PARTIAL** — a sub-part shipped, a named remainder is tracked open.
- **DECLINED** — deliberately not doing it (fork-drift reverts under the fix-forward lens — §7).

### 1.4 Scheduling

Open items are scheduled in `DEFERRED_WORK.md` (the live queue) and the campaign queues (`QUEUE_2026-*.md`). This register is the **defect catalog**; the queue docs are the **schedule**. Cross-reference `FEATURE_INVENTORY.md` §C (WIP) / §D (FUTURE) for the feature-level view.

---

## 2. Open CRITICAL Issues

> **Re-verified result: there are no confirmed-open CRITICAL defects on a default-reachable path as of Batch 455.** This is the correct outcome of re-verification, not an empty placeholder. The two CRITICALs the 2026-06-11 ultra-review spot-checked as "CONFIRMED REAL" — **A6.1 picking** and **A8.1 OIT composite format** — have both **shipped** (Batches 221/252 and Batch 222 respectively; see §6.1 and §6.4). The per-feature review's nine BLOCKERs (CSM placeholder, flat-gray env map, splat unsorted, voxel no data binding, billboard 1×1 atlas, RTE shadow cast, InvertClassification no draw, SSR uninitialized normals, GroundPrimitive stencil) have all shipped or been re-scoped (see §6).

**Reviewer action:** if any item below is later found still-broken, promote it here with file:line + a failure scenario. Candidates that warrant a fresh probe before being declared clean:

- **`status: verify` — Splat default color pipeline order-dependence under premultiplied over-blend (orig A2.1 / B-8).** The CPU back-to-front index sort is now **consumed** (Batch 288, `285b0ebd65`, `NEW-SPLAT-SORT-CONSUME-INDEXES`). Re-verify that the *default* (non-OIT) color pipeline draws in sorted order at all camera angles, since the original finding noted the default premultiplied-over path was order-dependent independent of the OIT variant. Probe: orbit a splat asset, diff against WebGL. (Moved to §6.4 as FIXED pending that visual re-confirm.)

---

## 3. Open HIGH Issues

Re-verification collapsed almost the entire 2026-06-11 HIGH list into §6 (Fixed). The genuinely-open HIGH/▲ items:

| ID(s) | Severity | Summary | Anchor / status |
|---|---|---|---|
| `NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH` | HIGH (parity) | Ground-atmosphere drape limb width diverges from WebGL at the horizon limb (surfaced Batch 327, `a2af8490d9`). | ✅ **RESOLVED (Batch 513, 2026-07-03).** Drape band itself measured at parity (1 px vs 1 px); the true residual was the SkyAtmosphere shell's earth-surface ray clip in `skyColorForRay` (blue disk-interior flood with globe hidden + truncated ~10 px limb extinction tail) — fixed with a WebGL-parity through-planet march + −150 km sample-height floor. `probe-limb-halo-width` gate PASS (14 px vs 16 px, ±6 tol). The below-surface darkening family closed separately — §3.3 CAMPAIGN-AUDIT-2 (Batches 510/512/513). |
| `NEW-WEBGL-REPROJECT-BASELINE` (B5) | HIGH (guard-gap) | Our WebGL imagery reprojection was forked from a 64-row grid to a 4-vertex quad + per-fragment Mercator — this **forks WebGL pixel output from upstream** with no regression baseline guard. | **OPEN.** Deliberate fork (documented in `IMAGERY_PROJECTION.md`); the missing piece is a visual-regression tolerance baseline so accidental drift on top of the intentional change is caught. `status: verify` whether a baseline has since been added. |
| `NEW-TS-CONVERT-JS-RENDERERS` | HIGH (maintainability) | 25 untyped `.js` feature renderers ≈ 35K LOC; the largest/most-complex renderers (Model, GroundPolyline, PrimitiveCommands, GroundPrimitive, ModelPipelineCache) are the least type-safe — inverse of where `noImplicitAny` is most valuable (A16.3). | **OPEN / first slice shipped** (Batch 314 TS-converted `WebGPUStarFieldRenderer`, `14f1369c73`). Long tail remains. |
| `FEAT-3DT2-03` (parity report 2026-06-30 §5.2) | HIGH (silent correctness on non-Earth bodies) | Ellipsoid-aware RTE. **Premise revised (2026-07-04, Q19):** the RTE ENCODE (`positionHigh/Low`, `encodedCameraHigh/Low`, `mvpRelativeToEye`) is ellipsoid-INDEPENDENT (camera-relative ECEF — no radii in the math, `WebGPUModelRenderer.js:367-370`), so tile POSITIONS were never off "10s of km" via RTE. The real ellipsoid-keyed gap was the CSM cascade ground-clamp solving against hardcoded WGS84 radii. | **SHIPPED / verified** (Batch 496 `PARITY-RTE-ELLIPSOID-AWARE`): `WebGPUCSMRenderer.setEllipsoid` threads `scene.ellipsoid.radii` (WGS84 default byte-identical); `probe-ellipsoid-rte.mjs` green (0.5×-scaled mock: groundFar relErr 0.000%, umbra IoU 0.886, WGS84 off-gate 0.0000%). Feature-specific Earth-radius residuals (terrain-shadow vertical-exaggeration cast pass, atmosphere effects that mirror WebGL) tracked in `DEFERRED_WORK.md` → `RTE-ELLIPSOID-AWARE-RESIDUALS`. See §3.2. |

### 3.1 Open MEDIUM/LOW carried from the 2026-06-11 ultra-review

These were catalogued in the ultra-review MEDIUM/LOW (23) bucket and **left open by deliberate decision** (the rest of the bucket shipped Batches 290–304):

| ID | Severity | Why still open |
|---|---|---|
| `NEW-DECOUPLEDSCAN-FORWARD-PROGRESS-GUARD` (A2.3) | MEDIUM | `DecoupledLookbackScan` spins on `storageBarrier()` with no iteration cap → potential livelock when grid > occupancy. Opt-in (default off). Needs a capability/occupancy gate + iteration-cap watchdog + `console.error` sentinel (the missing infinite-loop guard). |
| `NEW-RENDERBUNDLE-AGING-DECOUPLE` (A10.4) | MEDIUM | Render-bundle manager already has bounded LRU + age eviction; the open slice is only decoupling aging from the `perfManager._config.renderBundles` flag so `_evictStale` fires even when the flag is off. |
| `NEW-RESOURCEMANAGER-KEY-EVICTION` (A10.5) | LOW | `JSON.stringify` sampler/BGL cache keys, no eviction. Left open: those key spaces are naturally finite / low-growth. |
| ~~`NEW-CLUSTERED-ASSIGN-BOUNDS-DIRTY` (A7.2)~~ | MEDIUM | ✅ **RESOLVED (Q10, 2026-07-04)** — `WebGPUClusterBoundsRenderer.dispatch()` already returns whether it re-dispatched; that boolean is now threaded through `WebGPUClusteredLightingDispatcher.dispatch()` into a new `boundsChanged` arg on `WebGPUClusterAssignRenderer.dispatch()`, which OVERRIDES the light-checksum cache hit and forces the assign pass to re-run. A stationary-camera resize / FOV / near-far change (bounds change, view unchanged) now recomputes the per-cluster bins instead of leaving them stale. Opt-in feature (default OFF → path unreachable, byte-identical). Regression: `Tools/visual-regression/probe-clustered-lights-resize.mjs` (asserts cfgA≠cfgB bins on bounds change; proven to FAIL pre-fix). |
| `NEW-CLUSTER-MULTIFRUSTUM-BOUNDS` (A7.6) | MEDIUM | Cluster bounds computed for a single collapsed near/far spanning the full visible depth range (`WebGPUSceneRendererClusteredLighting.ts:208-219`) — multi-frustum scenes get **approximate** (not stale) Z-slice binning. Distinct from A7.2: this is a quality approximation, not a correctness/stale-data bug. Full fix = per-frustum-slice cluster grids with per-slice re-dispatch + per-slice consumer binding (larger architectural change). Still open; opt-in feature is off by default. |
| `NEW-MODEL-VS-MOTION-GATE` (A3.4) | MEDIUM | Model VS runs full prev-frame morph+skin+instance deformation unconditionally even when TAA off — should gate on `material.motionFlags.x > 0.5`. `status: verify`. |
| `NEW-COLLECTIONS-ERROR-SENTINELS` (A5.4) | MEDIUM | No re-entry / null-target / buffer-size guards in any collection renderer despite the CLAUDE.md mandate. |
| ~~`NEW-COLLECTION-RENDERER-BASE` (A5.3)~~ | MEDIUM | ✅ **RESOLVED (Batch 332 `f741aa890c`) — 5/5 collection renderers now on `WebGPUCollectionRendererBase`.** Billboard+Point folded Batch 302, Cloud+Polyline Batch 307, Label (the last) Batch 332 (`NEW-COLLECTION-RENDERER-BASE-LABEL`) — shared per-GPUDevice shader-module cache, pipeline-format invalidation, 2D/CV coplanar-depth flag, resident-instance manager, capture→sync→consume all live on the base. The ~3000 LOC duplication is gone. |
| `NEW-CAMERA-UPDATEVIEWMATRIX-REVERT` (B2) | LOW | Ctor `updateViewMatrix`→`updateMembers` swap. **DECLINED as a revert** (§7) but flagged to verify it isn't a functional view-matrix-seeding regression. `status: verify`. |
| `NEW-SYNC-MOVEMAP`, `NEW-CAPABILITY-GETTER-CODIFY`, `NEW-SG-SCAN-ADOPT` | LOW/process | Sync-runbook MOVE-MAP, codify the capability-getter convention, adopt upstream `sg-scan` JSDoc lint. `NEW-SG-SCAN-ADOPT` = **DEFERRED**. |

### 3.2 Parity-residuals from the 2026-06-30 parity report (newly tracked)

These three surfaced in `WEBGPU_PARITY_REPORT_2026-06-30.md` (Batch 458) — newer than every audit folded into §2 / §3.1 — and were not previously catalogued here. Each is a *partial* feature with a documented gap, not a regression.

#### FEAT-3DT2-03 — Mars/Moon tilesets render with large position errors (hardcoded WGS84 radius)

- **Severity:** HIGH (silent correctness loss on non-Earth planetary bodies).
- **Root cause (original framing — CORRECTED 2026-07-04, Q19):** the report framed this as "the RTE assembly path keys off WGS84 radius constants." Direct code read disproves that framing: the RTE ENCODE (`positionHigh/Low`, `encodedCameraHigh/Low`, `mvpRelativeToEye`) is ellipsoid-INDEPENDENT — it is camera-relative ECEF and no radii appear in the math (`WebGPUModelRenderer.js:353-388` computes the model-space camera as `inverse(model) * eyeWC` → `EncodedCartesian3.fromCartesian`, no ellipsoid term). Tile POSITIONS therefore were never displaced "10s of km" through the RTE path. The single genuinely ellipsoid-keyed WebGPU parity gap under this umbrella was the **CSM cascade ground-clamp** (`WebGPUCSMRenderer.ts`) solving its ray/ellipsoid intersection against hardcoded WGS84 radii — on a non-Earth globe the cascade splits spread to `maxShadowDistance` and frustum corners never clamped to the visible ground.
- **Status:** **SHIPPED / verified (Batch 496 `PARITY-RTE-ELLIPSOID-AWARE`).** `WebGPUCSMRenderer.setEllipsoid(radii)` (change-detected, degenerate-guarded) recomputes inverse-square radii; `WebGPUContext.executeShadowMapCastCommands` threads `scene.ellipsoid?.radii ?? scene.globe?.ellipsoid?.radii` once per cast frame (WGS84 default → byte-identical for Earth). `computeVisibleGroundFar` + `computeFrustumCornersWorldSpace` take optional trailing `invRadiiSq*` params (WGS84 defaults keep the exported API identical). Re-verified green 2026-07-04 (Q19) — see Probe.
- **Remaining (feature-specific, tracked in `DEFERRED_WORK.md` → `RTE-ELLIPSOID-AWARE-RESIDUALS`):** (1) terrain shadow-cast vertical exaggeration hardcodes `EARTH_RADIUS` in `WebGPUShadowMapRenderer.js` WGSL (only active when `verticalExaggeration !== 1.0` on a non-Earth globe → cast/color pass mismatch; S effort, add radius to `TerrainShadowGlobals` UB); (2) atmosphere / lens-flare / cloud / volumetric-fog Earth-radius constants mirror WebGL upstream (NOT a WebGL↔WebGPU parity gap); (3) no real Mars/Moon 3D-Tileset asset for an end-to-end pixel pass (`PARITY-RTE-ELLIPSOID-BLOCKER`).
- **Probe:** `probe-ellipsoid-rte.mjs` — synthesizes a 0.5×-scaled ellipsoid (no Mars/Moon asset needed) and asserts CSM `computeVisibleGroundFar` matches the `IntersectionTests.rayEllipsoid` reference on the actual scene ellipsoid + WebGL-vs-WebGPU umbra IoU on the cast shadow. Latest run (2026-07-04, :8080): scaled groundFar relErr 0.000%, last cascade split 935.1 (tightened, not 100 km), umbra IoU 0.886, WGS84 off-gate 0.0000% pixel + FP-exact splits — OVERALL PASS.

#### C-R1-PRIMITIVE-DERIVED-PANORAMA-CULLMODE — EquirectangularPanorama viewed from inside shows back-faces

- **Severity:** MEDIUM (visual correctness in a niche use case).
- **Root cause:** `WebGPUPrimitiveCommands.js` bakes `cullMode` from `appearance.closed` alone and ignores `renderState.cull.enabled:false`. A panorama viewed from *inside* should set `renderState.cull = {enabled:false}` to render the interior surface; instead the material pipeline hard-derives the cull mode from the Appearance flag, so back-faces show (or the interior vanishes).
- **Status:** ✅ **RESOLVED (Batch 317 `2ee9421571`, `NEW-PANORAMA-CULL-OVERRIDE-WEBGPU`).** Re-verified in live code: `WebGPUPrimitiveCommands.js` derives `cullExplicitlyDisabled = appearance?.renderState?.cull?.enabled === false` and forces cull `none` when set, at both cull-derivation sites (`defaultCullMode = appearance?.closed && !cullExplicitlyDisabled ? "back" : "none"`), so an inside-viewed panorama renders its interior without regressing default back-face culling. Probe `probe-panorama-cull-override.mjs` added the same batch. The earlier "OPEN — not threaded into the pipeline-variant selector" note was stale.
- **Fix (landed):** threaded `renderState.cull.enabled:false` through to the pipeline cull derivation so render state overrides the appearance-derived default. Alias: `WGF-1 / C-R1-PRIMITIVE-DERIVED`.
- **Probe:** `probe-panorama-cull-override.mjs`; Sandcastle `Panorama` example (camera inside the sphere).

#### GeoJsonPrimitive — visual-parity probe missing (verification debt, not a feature gap)

- **Severity:** MEDIUM (feature works in common cases; verification gap only).
- **Description:** `GeoJsonPrimitive` shipped on both backends (Batches 315–318), riding the Buffer* family (BufferPoint/Polyline/Polygon collections). No automated Playwright regression probe pixel-verifies that MultiPolygon triangle-winding, interior-ring (hole) rendering, and hole/MultiPolygon triangle-count match WebGL output. Manual testing shows visual correctness; the automated gate is missing. `debugShowBoundingVolume` is also a no-op on this path.
- **Status:** OPEN (test-infrastructure gap, not a code gap). The parity report lists this row in three subsystems (§5.2 / §5.4 / §5.7) — consolidate under Collections or cross-reference; it is also flagged as a doc-drift `§A` inventory entry.
- **Fix scope:** create `probe-geojson-holes.mjs` (Playwright pixel-diff a complex MultiPolygon + interior rings against the WebGL baseline). **Priority P2, effort S.** Can bundle with other geometry verification probes (cf. the edge degenerate-triangle PR#13421 repro, similar verification-only debt).

### 3.3 OPEN findings from the 2026-07-03 campaign audit (Batches 482–506, HEAD `62c5bab450`)

The 25-batch parity campaign passed its structural audit (20/24 probes green, ShaderDefine hygiene clean — add-only, 4 new tail bits 1<<26..1<<29, keySalt correctly used for all 6 bits ≥24; all three user-reported bugs verifiably fixed, see §6.10). The audit nevertheless confirmed **four real open issues** by direct code reads plus clean-HEAD probe re-runs. They are recorded here as OPEN — not papered over.

#### CAMPAIGN-AUDIT-1 — Voxel per-cell pick / octree LOD composition — ✅ depth-1 RESOLVED (Batch 509)

- **Severity:** HIGH — **the depth-1 composition + user-shader gap is FIXED (Batch 509 `1d5dde33cb`, `NEW-VOXEL-PICK-OCTREE-COMPOSE`).** The audit below predated B509.
- **Fix:** `fragmentPickVoxelMain` now descends into the level-1 child octant on refined frames (`u.atlasInfo.y >= 1`): childCoord/childSlots0/1 lookup, tileUv rescale, atlas z-offset by tileSlot, root fallback for unloaded children, and `megatextureId = packVoxelIntToVec2(tileSlot)`. A `//>>ifdef VOXEL_USER_CUSTOM_SHADER` pick branch matches the color march, closing the ungated-`voxelMaterial.alpha` composition gap too.
- **Original evidence (pre-B509, now stale):** the pick march normalized z into slot 0 / sampled the root slab and hardcoded `megatextureId 0`, so a refined-frame pick returned a root-cell index for a leaf the user saw.
- **Residual (queued as Q9):** the pick march composes only to depth-1; reaching the color march's LEVEL-3 traversal (B552) + fully sharing one traversal routine is the remaining slice — tracked in `NEXT_QUEUE_2026-07-04.md` Q9, not open here.

#### CAMPAIGN-AUDIT-2 — Below-surface / translucency darkening — ✅ RESOLVED 2026-07-03 (Batches 510/512/513)

> **Resolution:** B2 decomposition (Batch 510) exonerated every named shading term and root-caused
> the residual to a tile-aligned ocean-haze wedge from the water/reflective-ocean path; Batch 512
> fixed the actual bug (water masks never uploaded — every water-masked tile bound the 1×1 WHITE
> placeholder, so `computeEnhancedOcean` ocean-shaded whole land tiles); Batch 513 verified both
> probes PASS under the UN-loosened dynamic limits (underground 1.43%/4.28% vs limit 8;
> translucency 4.00%/0.54% vs limit 11.9). The originally-suspected "WebGPU uniformly darker"
> framing was a sign misread (probes report GL−GPU). Original report retained below.

- **Severity:** HIGH (parity). WebGPU renders uniformly darker on underground/translucent views: `probe-globe-underground` underground-def **22.85%** (signed dRGB −7.4/−7.5/−8.0), underground-red **12.28%** (limit 8); `probe-globe-translucency` translucent-terrain **25.49%** (limit 10.5, dRGB −5.9/−5.8/−6.7). Reproduced 3× including a re-run at clean HEAD `62c5bab450`.
- **Mechanism (verified):** both probes use dynamic limits keyed to the standing default-view residual (`max(8, base+2)` / `max(10, base+8)`); the campaign's default-view polish (B502/504/505/506) dropped that shared baseline ~15%→2.5%, tightening the limits onto a below-surface residual that already measured **22.9% at B488's own landing**. A standing atmosphere/lighting parity gap — possibly nudged ~+2.6pp worse by B506's GlobeFS/GlobeTerrain shading changes — not a fresh catastrophic regression. This **is** the limb-ring/atmosphere-brightness gap (§3 `NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH` family), now with numbers.
- **Action:** fold into the atmosphere-brightness investigation with these measured numbers; verify B506's seam/glint shading deltas apply symmetrically on the translucency/underground paths. **Do NOT loosen the probe limits.**

#### CAMPAIGN-AUDIT-3 — Model SCENE2D per-pixel shading tint — ✅ RESOLVED (Batch 530)

- **Severity:** MEDIUM — **RESOLVED (Batch 530 `ae2f4630c5`, `NEW-MODEL-IBL-AMBIENT-RELAND`).** The audit correctly localized this to model lighting/IBL orientation (not the globe shader); B530 fixed exactly that.
- **Fix:** re-landed the WebGL-parity radiance-cube `(-x,-y,z)` lookup flip in `ProjectRadianceToSH.wgsl` (matches `ComputeIrradianceFS.glsl:94-95`) + a faithful `czm_computeScattering` port in `ProceduralSkyCubemap.wgsl`, correcting the SH-L2 ambient orientation that produced the olive/khaki 2D tint. `probe-model-scene-modes` 2D interiorDiff **34.42 → 11.85** (GATE PASS); 3D/CV unaffected. B499's culling/matrix fix holds.

#### CAMPAIGN-AUDIT-4 — PP library builtins + user WGSL stages ran PRE-tonemap vs WebGL's POST-tonemap — ✅ RESOLVED (Batch 511)

- **Severity:** MEDIUM (HDR-only impact) — **RESOLVED (Batch 511 `afa8b97473`, `NEW-PP-LIBRARY-TONEMAP-ORDER`).** User-supplied WGSL + library builtin PP stages moved from pre-TAA to **after** the tonemap single-pass in `WebGPUPostProcessPipeline.execute()`, matching WebGL's `tonemap → _stages → fxaa` order (placement is the only correct fix since `hdrMode` compensation cannot reach user-supplied WGSL). The two inaccurate "matches WebGL's insertion point" comments + the stale header docstring were corrected in the same batch.
- **Prerequisite parity fixes surfaced by the probe (also landed B511):** (1) the WebGPU tonemap gate never engaged under plain `scene.highDynamicRange` — `configureWebGPUPostProcessPipeline` now applies WebGL's `tonemapping.enabled = useHdr` rule; (2) the WGSL PBR-Neutral operator (f32+f16) was a soft-clamp approximation — replaced with the exact Khronos `czm_pbrNeutralTonemapping` port. **Off-gate:** with no user/library stages and HDR off, pipeline order + output byte-identical.
- **Residual:** scene-side plain-HDR gamma/tonemap tails tracked separately as `NEW-PLAIN-HDR-SCENE-GAMMA-EPIC` (queue Q7) — distinct from this stage-order fix.

**Dismissed / probe-hygiene notes from the same audit:** `probe-colorgrading-wired` gate F fails only against its stored pre-B506 default-view baseline PNG (functional gates A–E pass) — B506 intentionally changed default-view pixels (glint restore + seam fix); refresh the stored baseline, not a color-grading bug. `probe-voxel-cell-pick` run-1 failure was a WebGL-side async-pick timeout (pick bytes byte-equal both runs) — dismissed as flake. `probe-collections-regression` and `probe-pick-basic` default `PROBE_BASE` to `:8134` — set `PROBE_BASE=http://localhost:8080` in future sweeps.

---

## 4. Open MEDIUM / LATENT (cross-coupling + dead-code hazards)

From `AUDIT_2026_05_02.md` §C (LATENT) — the entries that remain open after re-verification (most of §C.1–C.12 shipped Batches 132–159):

- **C.2 · `gpuCullCommands()` / HiZ / GPUSortKeys / PointCloudSort orphan dispatchers — consume-or-delete decision pending.** `WebGPUSceneRenderer.ts` defines `gpuCullCommands()` with no live caller; the cullers allocate eagerly. Tracked as `NEW-GPU-CULLER-CONSUME-OR-DELETE` + `NEW-HIZ-SORT-CONSUME-OR-DELETE`. **Architecture decision, not a bug — but see §4.1: do not delete without the dead-code audit.** Note: FORK-41 (Hi-Z occlusion) was separately *resolved* — command-drop is now DEFAULT ON (C2-21, 2026-06-24) after a depth-source bug fix; the orphan-dispatcher decision is the residual.
- **`NEW-GPU-SORT-PIPELINE-PHASE-3`** — GPU sort-keys are produced but never consumed by `RenderScheduler` (sorted-indices readback integration). Open.
- **`NEW-DYNAMIC-ENVMAP-FULL-SCENE`** — ✅ **EPIC CLOSED (C2-25, Batches 446–451).** True scene render-to-cubemap shipped: globe capture (Batch 446), model/3D-Tiles capture (447), tileset capture verified (448), temporal accumulation (449), clouds-in-IBL (450), Lagarde parallax-corrected localized reflections (451, closes the epic). Opt-in, parity-default byte-identical. **ONE residual deferred:** `ENV-CAPTURE-PER-FACE-LOD` (side-face outward terrain needs per-face quadtree re-selection) — scoped in `ROADMAP_AND_DEFERRED_WORK.md` §9 + `DEFERRED_WORK.md` L2496. The earlier "real scene capture is the open remainder" framing is stale.

### 4.1 Dead-code-audit hazards (do NOT remove without cross-referencing)

These are CLAUDE.md Principle 7 landmines — code that **looks** dead but is scaffolding for partially-implemented features. Removing them forces re-architecture when the follow-up lands. Catalogued so a future audit doesn't repeat the C-R8 near-miss:

- **`WebGPUTranslucentTileClassification` `_classificationColorTexture` / `composite()` / `_runTranslucentTileClassificationComposite`** — the accumulation target is never written and the composite is a visual no-op, but the file docstring (lines 11–19) lists them as Batch-47 deliverables for unfinished multi-frustum accumulation. **The originating near-miss for the entire Principle-7 rule.** Leave in place.
- **`WebGPUDerivedCommand`** — flagged orphaned by A11.1 (flags never read, dispatcher zero callers). **Re-verified: NO LONGER DEAD.** Batch 248 (`35400b123f`) made it the real centralized pipeline-variant factory (`NEW-DERIVEDCOMMAND-VARIANT-FACTORY`); Batch 239 (`af7828fc22`) re-documented it. The A11.1 "delete it" recommendation is **superseded** — do not act on it.
- **`WebGPUGroundAtmosphereRenderer`** — flagged dead by A4.1. **Re-verified: DELETED** (Batch 239, `af7828fc22`) — the live ground-atmosphere shading runs from camera-UB fields in `GlobeTerrain.wgsl`. Finding closed by deletion, not by wiring.
- **Orphan `Model*Stage.wgsl` files** (`ModelColorStage`, `ModelSilhouetteStage`, `ModelSplitterStage`, `ModelAtmosphereStage`, `ModelCPUStylingStage`, `ModelPointCloudStylingStage`) — still on disk, imported by nothing in the WGSL model pipeline (M-R13 / C-R4 false-coverage concern). These map to **unshipped** model features (silhouette, atmosphere-on-model, splitter) — scaffolding, not dead. Leave until the feature lands or the file is consciously retired.
- **Orphan `Classification/*.wgsl` and `Advanced/*.wgsl` static files** — the live classifier/advanced WGSL is generated **inline** in the `.js`/`.ts` renderers; the static files are not imported (noted in B.9). Leave (grep-discoverable scaffolding).

---

## 5. Cross-Coupling / Breaking (2026-05-02 still-open)

The cross-coupling audit found ~110 gaps across 5 clusters (15 BREAKING, 35 PARTIAL, 24 LATENT, 8 STALE-STATUS). **Almost all BREAKING + PARTIAL items shipped Batches 130–185.** What remains open after re-verification:

| ID | Severity | Summary | Status |
|---|---|---|---|
| **A.4 (residual)** ⇄ `NEW-CLASSIFIER-2D-CV-MORPH` | PARTIAL | `Vector3DTile*` classifiers (Primitive/Polylines/ClampedPolylines) lack full 2D/CV/Morph support — silently skip in non-3D modes. **Note: the skip-gate is *better* than upstream WebGL** (which renders wandering volumes), so lifting it without CPU/shader projection of the RTC-relative positions would be a regression. GroundPrimitive 2D/CV/Morph **is** done (Batches 150/156/164). | OPEN, deferred behind demand. |
| **A.4 (GroundPrimitive morph leaf)** ⇄ `MORPH-EXAG-SKIRTS` | PARTIAL | GroundPrimitive MORPHING animation transient (~1s disappearance during the morph); SCENE2D + COLUMBUS_VIEW work post-Batch 156. Exaggeration in CV/morph turns terrain skirts into walls (Batch 216 revert) — needs WebGL-faithful skirt handling in the planar leg. | OPEN (`MORPH-EXAG-SKIRTS`, P1/L). |
| **B.11** ⇄ `NEW-CSM-VOLUMETRIC-CASTERS` | DEFER | CSM cast list omits Voxels + GaussianSplat (volumetric — need deep-shadow-map techniques, not `_shadowCastLayout`). Billboard/Label/Point/Polyline are explicit non-goals (screen-space, don't cast in any engine; WebGL doesn't either). | OPEN by design. |
| **B.8 follow-up** ⇄ `NEW-MODEL-NODE-TRANSFORMS-PREV` | PARTIAL | TAA velocity for **animated articulated** nodes uses the model-level `cache.prevModelMatrix`; per-node prev-matrix tracking missing. Static articulations work. | OPEN. |
| **B.10 follow-up** ⇄ `NEW-ADVANCED-MOTION-VECTORS` (classifier portion) | PARTIAL | Vector3DTile + Ground classifiers rely on TAA's camera-only velocity fallback (correct for static content; per-feature animation rare in production tilesets). All collections + advanced primitives (Cloud/PointCloud/Splat/Voxel) **did** ship motion vectors (Batches 143–173). | OPEN, low-priority. |
| **A.7 / A.13 follow-ups** ⇄ `NEW-MODEL-WGSL-CUSTOM-SHADER`, `NEW-POSTPROCESS-USER-WGSL` | PARTIAL | `CustomShader` and user `PostProcessStage` emit a `oneTimeWarning` (no longer silent — Batch 133, and the warning was un-stripped for production Batch 290) but the full WGSL acceptance surface is deferred (needs a WGSL chunk-injection mechanism / per-stage WGSL pipeline factory; real general fix = a Naga transpiler). | OPEN. |
| **D.3 / D.5 / D.6 / D.8** | STALE-STATUS | Doc-hygiene only: `: any` count refresh (D.3), VolumetricFog SCAFFOLDED tag sub-phases (D.5), `WorkerSceneHost`/`OffscreenContextSupport` tag consistency (D.6), `WebGPUVideoTextureManager` → ORPHANED (D.8, C.6 already done Batch 159). No code. | OPEN doc-debt. |

---

## 6. Major Bugs Already Fixed — by subsystem

Each entry: **finding ID(s) · batch # · root cause · fix · verification.** Re-verified against `git log` where feasible.

### 6.1 Picking (the DP-H44/45/46 ⇄ A6.x ⇄ NEW-PICK* epic)

> **One root cause, many IDs.** Chain: **A6.1 ⇄ DP-H44/45/46 ⇄ NEW-PICKDEPTH-CAPABILITY-READBACK ⇄ NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION ⇄ NEW-PICK-RAY-ASYNC ⇄ NEW-PICK-METADATA-READBACK ⇄ FORK-34.** The 2026-06-11 review marked this **CRITICAL/OPEN** at Batch 220. **Re-verified: FULLY RESOLVED by Batch 252+**, but it was a **3-layer fix the review under-scoped as "one getter."**

- **Root cause (A6.1):** `PickDepth.update()` branched on `if (defined(context.readPixels))`. `WebGPUContext.readPixels` is a *defined* abstract method returning `null`, so `defined()` was always `true` → the WebGL framebuffer path ran, `_asyncDepthTexture` was never set, `getDepth()` returned `undefined`, and `pickPosition`/`sampleHeight`/`clampToHeight` were broken on WebGPU. Feature-detection-by-existence instead of by-capability — the review's single highest-leverage root cause.
- **Fix, layer 1 — capability getter (Batch 221, `0b42893424`):** added `GraphicsContext.supportsSynchronousReadback` (WebGL `true` / WebGPU `false`); switched the two `defined(context.readPixels)` backend-proxy checks (`PickDepth`, `InstancingPipelineStage`) to it. Also fixed the `InstancingPipelineStage` typed-array drop for WebGPU instanced models.
- **Fix, layer 2 — async architecture (Batches 207, 257–259):** `scene.pickAsync` / async ray-pick path (`NEW-PICK-RAY-ASYNC`); `pickPosition` over opaque Models returns the model not the globe behind it (DP-H45, Batch 257); sampleHeight/clampToHeight stop failing silently (Batch 258) then work via main-scene-depth reuse (Batch 284).
- **Fix, layer 3 — depth-value reconstruction (Batch 252, `f1b4d43f77`):** `NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION` — `pickPosition` returns real positions on WebGPU (log-depth reconstruction). DP-H44 globe terrain picking (opt-in `globe.pickable`) shipped Batch 360 (`c9b5554add`).
- **Metadata (DP-H46):** re-scoped as a **deferred epic, not a single batch** (`c0556c4c8d`); GPU upload + binding scaffolding Batch 454; per-model WGSL metadata codegen Batch 455 (opt-in, parity default).
- **Verification:** `probe-pickposition-webgpu.mjs`, `probe-pickmodel-instanced.mjs` (0/42 → 42/42 GPU-anchored hits), `Tools/upstream-regression-check.mjs`.
- **Caveat:** `drillPick` full async (`NEW-DRILLPICK-ASYNC`) and per-`EXT_mesh_features` feature pick (`C-R9-MODEL-FEATURE-PICK`) remain narrower tracked gaps. Per-cell voxel pick (`C-R9-VOXEL-CELL-PICK`) — formerly out of scope — **shipped Batch 498** (`ed276acc5b`, reland on the fixed shapeUv convention), but does not yet compose with octree LOD refinement or user customShaders (§3.3 CAMPAIGN-AUDIT-1, OPEN).

### 6.2 Shadows / CSM / point lights

- **B-1 (per-feature, RTE shadow cast) / B-2 (CSM placeholder) ⇄ C-R10 / H-R2 / H-R12.** Root cause: `computeCascadeVPs` returned an identity-with-scale placeholder and the cast shader multiplied a world-space VP by an eye-relative vec3. Fix: real per-cascade fit in `WebGPUCSMRenderer.ts` (frustum-corner extraction, bounding-sphere fit, light-space lookAt, ortho, texel-snap). `status: verify` the cast-RTE half is fully closed at HEAD (CSM cast-no-dispatch was a separate later finding).
- **A7.1 ⇄ NEW-CSM-SOFT-SHADOW-PCF (Batch 289, code; Batch 297 retest).** Root cause: CSM receive used a single `textureSampleCompareLevel` tap and ignored `shadowSoftShadows`, while the single-map path in the same file branched to a 3×3 PCF kernel — soft shadows were a silent no-op for cascades. Fix: PCF branch in `sampleOneCascade` gated on `shadowSoftShadows`. Verified on the primitive self-shadow edge (Batch 297); globe-receiver closeout was gated on `NEW-CSM-GLOBE-RECEIVE-PROJECTION-MISS` (✅ shipped) and `NEW-CSM-CAST-NO-DISPATCH-VIEWER` (cast side ✅).
- **C-R10 ⇄ B.12 point-light cube shadows (Batches 53, 161–167).** Model receive path (Batch 53): 18-binding effects BGL with a `texture_depth_cube` at binding 17, `samplePointShadow()` deriving perspective-Z from the dominant cube-face axis. Extended to all 23 primitive lit shaders via the shared `csm_samplePointShadow.wgsl` chunk (Batches 161/165/166/167). Globe-terrain point-light receive (`C-R10-GLOBE-POINT-LIGHT`) still on the 2D path — tracked open.
- **`NEW-SHADOWMAP-COMMENT-RESTORE` (Batch 299).** Restored ~25 stripped WHY-comments to `ShadowMapComputations.js` from merge-base. Comment-only.

### 6.3 Model PBR / IBL / clustered lighting

- **A.9 / B-3 (env map) ⇄ A.12 DynamicEnvironmentMapManager (Batches 130/131/134).** Root cause: the env cubemap was a flat mid-gray `(128,128,128)` stub; IBL convolved against gray → useless irradiance, every model lit by constant ambient. Fix: procedural-sky compute pass writes the 6 faces from atmospheric scattering params; IBL prefilter produces irradiance + radiance maps consumed at model BGL bindings 33–35. Real scene-content capture tracked separately (`NEW-DYNAMIC-ENVMAP-FULL-SCENE`, see §4 / C2-25).
- **A3.1 ⇄ NEW-MODEL-IBL-BRDF-LUT (Batch 287, `b00e26cfcb`).** Root cause: specular IBL used analytic Fresnel; the split-sum BRDF LUT was generated every device-init but **never consumed** by the model path (bound only in `DeferredLighting.wgsl`). Fix: bound the LUT into the model material bind group, replaced the analytic term with `radiance*(F*lut.x + lut.y)` + multiscatter. Re-verified shipped (probe-isolated 56%→1.3% parity per MEMORY).
- **A3.2 ⇄ NEW-MODEL-IBL-REFERENCE-FRAME (Batch 287).** Root cause: IBL cubemaps sampled in raw eye space (no `model_iblReferenceFrameMatrix`) → reflections swam as the camera orbited. Fix: world-fixed reflection reference frame.
- **A3.3 ⇄ NEW-MODEL-DIRECT-BRDF-PARITY (Batch 355, `8ab504e618`).** Root cause: direct-light geometry term used Schlick-GGX `k=(r+1)²/8` and `f90=1.0` vs WebGL's height-correlated Smith-joint + `f90=clamp(reflectance·25)`. Fix: ported `smithVisibilityGGX` + the `f90` clamp into the WGSL.
- **Model-PBR-IBL at-rest parity (Batches 345/346, `a2fd4ee124`/`d1c4bfaa9f`):** atmosphere-derived env-map sky, ambient-floor, 3DTile-guard, neutral-model at-rest parity (`NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY`).
- **Clustered lighting (Slice 5d, Batches 142–158) — SHIPPED end-to-end.** `KHR_lights_punctual` loader (B.3) + `Scene.lights` `LightCollection` + cluster-bounds compute (Batch 147) + cluster-assign compute (Batch 148) + Model-PBR consumer (Batch 153, folded into group-3 effects BGL because the platform `maxBindGroups:4` ceiling blocked the planned `@group(4)`) + all 19 primitive Mat*Lit shaders + Phong primitives (Batches 154–157) + Sandcastle demo (Batch 158). **A latent `perturbNormal` NaN bug** (normal-mapped prims without TANGENT → degenerate normal silently zeroed ALL lighting) was found + fixed here — guard with `!(len>1e-4)` not `len<1e-4`. Open follow-ups: `NEW-CLUSTERED-ASSIGN-BOUNDS-DIRTY`, `NEW-CLUSTER-MULTIFRUSTUM-BOUNDS` (§3.1).
- **C-P1 model destroy-callback leak (Batch 1):** `_featureRenderer` handle now cleared on destroy — tile eviction releases per-model GPU resources.

### 6.4 Tiles / point-cloud / splat / OIT

- **A8.1 ⇄ NEW-OIT-COMPOSITE-FORMAT (Batch 222, `8af2e90d2c`) — CRITICAL.** Root cause: `_createCompositePipeline` hardcoded `format:"rgba8unorm"` ("Will be overridden at draw time" — it never was) and `executeComposite` ignored its `targetFormat` param; against the `bgra8unorm`/`rgba16float` scene color the MRT-OIT composite failed WebGPU's format-match validation every frame it ran (latent: fallback-only path). Fix: per-target-format composite pipeline cached on `_sceneColorFormat`, rebuilt on HDR toggle. **Re-verified in live code** (`WebGPUOIT.ts:99-106,221-249,278-319` now thread `targetFormat`).
- **A2.1 / B-8 ⇄ NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288, `285b0ebd65`).** Root cause: WebGPU drew `instanceCount: cache.splatCount` in storage order, never reading `primitive._indexes`; the JS `update()` early-returned before the sort state machine. Premultiplied over-blend is order-dependent → wrong tinting/haloing that changed with camera angle. Fix: consume `_indexes` as a per-instance attribute + write log depth. **`status: verify`** the default color path is order-correct at all angles (§2).
- **A2.2 ⇄ NEW-POINTCLOUDLOD-SLOT255-OFFBYONE (Batch 293, `3986f7a89b`).** Root cause: `sharedVisible[255u] = globalOffset` ("safe because localCount < 256") but at LOD-0 all 256 threads can be visible → the real index at slot 255 was overwritten; one wrong/duplicate point + one dropped per fully-visible LOD-0 workgroup. Fix: dedicated `wgOffset` workgroup var.
- **C-P12 / DP-C6 KHR_mesh_quantization (Batch 11):** `ensureFloat32` now dequantizes (honors `quantizedVolumeOffset/StepSize`) instead of verbatim int→f32 upcast.
- **A.1 GlobeTranslucency derived-command drop (`ebdc3548c3`); A.2 InvertClassification stencil (Batch 141); A.3 ClassificationType.BOTH dual-pass (Batches 145/146); A.8 model.classificationType drape (Batch 142)** — all shipped (cross-coupling BREAKING cluster).
- **EllipsoidPrimitive invisible (Batch 269) + translucent double-blend (Batch 276)** — fixed.

### 6.5 Post-process & effects

- **A8.2 ⇄ NEW-TONEMAPPER-STRING-MAP (Batch 223, `bbb196f66c`).** Root cause: `mapTonemapType` read `collection._tonemapping?.type ?? collection._tonemappingType` — neither exists; the real selector is the string `_tonemapper`. `type` was always `undefined` → always `PBR_NEUTRAL`; setting `Tonemapper.ACES` was a silent no-op. Fix: read the `tonemapper` string, map REINHARD/MODIFIED_REINHARD/FILMIC/ACES/PBR_NEUTRAL → TonemapMode.
- **A8.3 ⇄ NEW-POSTPROCESS-HDR-INTERMEDIATES (Batch 225, `296675b782`).** Root cause: built-in Bloom/AO/DoF/GodRay passed `canvasFormat` (SDR) instead of `_intermediateFormat` (rgba16float in HDR), clamping HDR >1.0 highlights before tonemap — defeating bloom. (The user-stage path was fixed earlier; built-ins were left behind.) Fix: pass `_intermediateFormat` to all four.
- **A8.4 ⇄ NEW-BLOOM-UNIFORM-PARITY (✅).** Bloom mis-mapped WebGL `brightness`/`contrast` onto a luminance threshold (and inverted the default — WebGL `brightness` defaults to −0.3 as an HSB add). Fixed.
- **A8.5 ⇄ NEW-POSTPROCESS-USER-WARN-PROD (Batch 290, `c23d97e4cc`).** User GLSL stages without `wgslFragmentShader` were silently dropped; the only signal was a `oneTimeWarning` wrapped in a debug pragma → stripped from production. Fix: moved the warning out of the debug pragma (it's a real functionality loss, not a per-frame diagnostic). Full WGSL acceptance still deferred (§5).
- **A9.4 ⇄ NEW-TAA-PIPELINE-ORDER-RECONCILE (Batch 290).** TAA runs pre-tonemap on linear/HDR — reconciled as **deliberate**: the resolve shader's reversible `tonemapWeight = c/(1+luma)` clamp/blend is only well-defined on linear/HDR input; post-tonemap would Inf/NaN on highlights. Decision recorded in `WebGPUPostProcessPipeline.ts` + `TAA.wgsl` headers; clamp constants need no retune. (B.16 was a separate audit-misread — TAA always ran pre-tonemap; only an inline comment was wrong.)
- **A.10 sun-through-Earth horizon test (`a837a9ad79`); A.11 GodRayEffect orphan registration (Batch 133); B.13 AO algorithm selector; B.14 AutoExposure in SDR; B.15 SSR depth-derived normals; B.17 VolumetricFog HDR composite (`2cc50a7e57`)** — all shipped.
- **B-4 SSR uninitialized normal texture (per-feature BLOCKER)** ⇄ B.15 — depth-derivative normal reconstruction; real normal G-buffer gated on FEAT-GAP-01 (Phase-8a foundation).

### 6.6 Globe surface & primitives

- **A1.1/A14.1 ⇄ NEW-GLOBE-BINDGROUP-CACHE (Batch 241, `4eb3beccf0`).** Root cause: globe surface renderer allocated 3–4 GPUBindGroups per tile per pass per frame (~600–800 objects/sec at 200 tiles) — texture *views* were cached, the bind groups were not. Fix: per-tile bind-group cache → steady-state creations 68/frame → 0. `NEW-GLOBE-DYNAMIC-OFFSET-UBO` (group-0 dynamic-offset BGL) also shipped.
- **A10.1 ⇄ NEW-GLOBE-RENDERBUNDLE-CACHE (✅).** Globe pass built and discarded a render bundle every frame; now routed through `renderBundleManager.getOrCreate()`.
- **A4.1 ⇄ NEW-GROUNDATMOSPHERE-RENDERER-DEAD (Batch 239) — closed by deletion** (§4.1).
- **C-P2 globe SCENE3D RTE defeat (Batch 4):** split `center3D` into High/Low; SCENE3D branch reassembled with sub-meter precision. **C-P3 SkyAtmosphere `posH+posL` RTE violation (Batch 2); C-P6/C-P7 clipping + VolumetricFog RTE (Batches 12/26); H-P7 hardcoded Earth radius (Batch 6, partial)** — all RTE-discipline fixes shipped.
- **C-R5 imagery layer cap 4→16 (Batch 58).**

### 6.7 Collections

- **A14.2 ⇄ NEW-COLLECTIONS-DIRTY-GATE (Batch 226, `b4a9e58fd9`/`7e24700f8a`).** Root cause: Billboard/Label rebuilt and re-uploaded the entire instance buffer every frame (`Float32Array(length*44)`, full upload, no dirty gate) — the Point renderer already had the `needsRebuild` gate; Billboard/Label didn't (the cross-renderer-base drift, A5.3). Fix: consume dirty state each frame (billboard + label glyph). Cloud rebuild gate followed (Batch 233).
- **C-P5 four-of-six collection renderers mis-encode model-space camera (Batch 12):** transform `camera.positionWC` through `inverse(modelMatrix)` before `EncodedCartesian3.fromCartesian` so RTE subtraction stays accurate at ECEF scale.
- **C-P9 ⇄ DistanceDisplayCondition / NearFarScalar family absent (✅ A.14, Batches 136–140):** `csm_nearFarScalar` WGSL port now consumed across 11 collection shaders (scaleByDistance / pixelOffsetScaleByDistance / translucencyByDistance / DDC / DISABLE_DEPTH_DISTANCE).
- **B-6 billboard/label 1×1 white atlas placeholder (Batch 3):** resolve the atlas GPU view per frame; rebuild on `atlas.guid` rotation.
- **MORPH-POLYLINE-COLLECTION-2D (Phase 3 Slice 4, 2026-06-13):** PolylineCollection 2D/CV/Morph via CPU-blend `_actualPosition` (`SceneTransforms.computeActualEllipsoidPosition`) + full-frustum log-depth + `noDepthTest` morph variant. Antimeridian split + mid-morph velocity deferred. **WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER** (Batch-2 audit finding: billboards/points/labels rendered nothing in *all* modes, pre-existing ≥Batch 214) — `status: verify` resolved (collections render today per MEMORY).

### 6.8 Compute / perf infra / build

- **A16.1 ⇄ NEW-WEBGL-ONLY-CLUSTER-EXPORT-GATING (Batch 224, `27ff9f6def`).** Root cause: `createIndexJs`/`createCesiumJs` emitted 4 WebGPU cluster re-exports + LightTypes constants unconditionally; these files weren't in `WEBGPU_COMPAT_EXEMPTIONS`, so a fresh `gulp buildCesiumWebGLOnly` regenerated a barrel with `No matching export for WebGPUClusterBoundsRenderer` (ESM named-export link error). The committed `CesiumWebGLOnly.js` was stale so it hadn't triggered. Fix: moved the cluster exports into `index-wgsl.js` (mirroring the preprocessor split); regenerated the tracked barrel (Batch 224 follow-up `2aa99b8edf`). `NEW-VARIANT-CI` (variant build + smoke test in CI) shipped Batch 242.
- **A11.1 WebGPUDerivedCommand orphan** — superseded; now the real variant factory (Batch 248, §4.1).
- **A10.2 ⇄ NEW-BINDGROUPCACHE-EVICTION (Batch 293):** `WebGPUBindGroupCache` had no eviction (the only unbounded cache); now bounded.
- **C-R7 central pipeline cache adoption; C-R11 per-frame bind-group churn (Batches 31/32):** post-process effect bind groups routed through `WebGPUBindGroupCache` (840 createBindGroup/sec → 0 steady-state). Residual `C-R11-EFFECTS-BGL-COLLECTION-CACHE` (per-tile clipping-plane BGs) tracked.
- **B.18/B.19/B.20/C.1/C.3 (compute-cache dedup, 7 WASM arena slots, render-bundle invalidation, DevicePool, cache-registry registration)** — all shipped Batches 132–135.

### 6.9 Async lifecycle / device-loss / early bugs

- **H-P5 mapAsync destroyed-state hazards (Batch 26):** remaining unguarded `mapAsync` paths (`createPixelReadbackPBO`, `readPixelsToPBO`, `WebGPUGPUCuller.readResults`) wrapped in try/catch with clean fallbacks.
- **C-P17 IBL texture leak per env-map version change (Batch 14); C-P18 imagery upload before decode (Batch 14); C-P14 EDL silent no-op warning (Batch 13); H-P13 static sun fallback (Batch 2); H-P15 SkyAtmosphere LUT orbital saturation (Batch 2)** — shipped.
- **Foundational (WEBGPU_DEBUGGING_LOG Sessions 1–28):** BUG-12 all-black canvas (render-target misdirection / clear-color override), BUG-13 install export name, BUG-14 ESM chunk loading, bind-group 5→4 limit, writeBuffer 4-byte alignment, pipeline stride mismatch, "size is zero" buffer guards, WebMercatorT UV stretching, LOD unlock (tile.renderable gated on vertexArray), moon 4×4 placeholder → Phong parity (Session 27). These are the substrate the renderer was bootstrapped on — see the log for the full chronological list.

### 6.10 2026-07 parity-campaign headline fixes (Batches 482–506) + Hi-Z OBB NaN

The campaign's five headline defect fixes, each with root cause + fix + probe evidence. The full 25-batch ledger is `git log 03edcf1f2e..62c5bab450` (every commit message carries probe evidence + off-gate lines); the rest of the campaign's fixes (B488 translucency daylight-flood gate, B493 dual-backend UINT32 metadata pick, B496 CSM scene-ellipsoid cascade fit, B497→B498 voxel shapeUv convention + cell-pick reland, B499 2D/CV model culling/matrix) are logged in `WEBGPU_DEBUGGING_LOG.md`.

- **GLOBE-POLAR-STRETCH ⇄ B502 (`3599642e00`).** Root cause: `ReprojectWebMercator.wgsl` carried a **double vertical flip** (`v_geo = 1 - texCoord.y` AND `srcV = 1 - mercatorFraction`), justified by the false Batch-67 "flipY is metadata-only" theory. The two flips cancel only for equator-symmetric tiles; asymmetric tiles (e.g. Bing level-1 rows) came out latitude-mirrored through the Mercator nonlinearity — the equatorward polar stretch. (The suspected vertex-attribute/FS-flag decoupling was ruled out by live tile-state instrumentation + a NaturalEarthII geographic control.) Fix: remove both flips, making the WGSL FS line-for-line identical to the GLSL FS; WebGL untouched, no new option — the corrected path *is* the parity path. **Probe:** `probe-globe-polar-stretch.mjs` (far saved view): mismatch **32.15% → 5.46%**, artifact gone, PNGs read.
- **GLOBE-POLAR-STRETCH-POLISH ⇄ B506 (`62c5bab450`).** Two residuals on top of B502. (1) **Dark-navy tile-seam grid** = rasterizer UV overshoot failing the `texCoordsRect` step-mask — WebGPU-only seam lines, 62% of the mid-zoom residual; fixed by a fragment-entry UV clamp in `GlobeTerrain.wgsl` matching `GlobeFS.glsl:396`. (2) **Suppressed orbital ocean glint** — the gated GGX variant killed the Pacific glint (63% of the far residual); fixed by a 1:1 `czm_getSpecular` Phong port (unconditional, analytic sphere normal via `modifiedModelView * normalize(v_positionMC)`, exact `waveFade(70k, 1e6)` falloff) + `u_zoomedOutOceanSpecularIntensity` bridged through `camera.lighting.w` (`WebGPUGlobeSurfaceCameraUB.ts`) + imagery sampler `maxAnisotropy` 16 (`WebGPUGlobeSurfaceLayouts.ts`). **Probe:** extended `probe-globe-polar-stretch.mjs` with residual bucket decomposition + a dark-navy seam-fingerprint gate: **mid 0.00%, far 2.25%** (ceilings 0.27/3.5/4.5, all pass). **Known side effect:** intentionally changed default-view pixels — `probe-colorgrading-wired`'s stored baseline PNG is now stale (§3.3 dismissed notes).
- **ENV-MOON-SLIVER ⇄ B505 (`b26301efee`).** Root cause: `Moon.wgsl`'s VS fed a **world-space** RTE offset (`(moonH + posMC - camH) + (moonL - camL)`) to `mvpRTE`, whose linear part is `viewRot × moonIauRot` — the center-minus-camera offset was wrongly rotated by the moon's IAU orientation, displacing the disc so only a white sliver clipped into frame. Fix (parity, no new toggles): pack the RTE high/low split of the camera position in body **model** coordinates (double-precision `Matrix4.inverseTransformation`, `WebGPUEllipsoidRenderer.ts`); `rte = (posMC - camH) - camL` — algebraically identical to WebGL's `czm_modelViewProjection × (radii × position)`. Also `specularStrength` 0.3 → 0.0 to match WebGL's ImageType default (removes a phantom center highlight). **Probe:** `probe-env-moon.mjs` — **litRatio 0.090 → 1.000, centerDist 0.0 px**. Caveat: only the full-disc case is asserted; a crescent-phase assertion is a tracked follow-up.
- **ENV-SKYBOX-STARMAP ⇄ B504 (`af006e9634`).** Two coexisting longstanding bugs (both predate the campaign). (1) **flipY parity:** WebGL uploads cube faces with `UNPACK_FLIP_Y_WEBGL = true` (`loadCubeMap.js`) but WebGPU `copyExternalImageToTexture` did not flip — every face sampled vertically mirrored, showing a *different sky region* than WebGL for the same camera. (2) **Dimming:** the Phase-1.4 cloud-cover star occlusion multiplied the cube map by `(1 - cloudCover)` unconditionally, and `globe.cloudCoverage` defaults to 0.5 — every default scene halved the skybox, dropping the milky-way texture below visibility while the catalog StarField kept drawing ("sparse dots remain"). Fix: cube-map upload flipY parity + gate the packed cloudCover on `scene.enableWeather === true` (default false; occlusion still works opted-in). **Probe:** `probe-env-skybox-stars.mjs` pattern-correlation gate — **aligned 1.000 vs mirrored 0.122**.
- **PARITY-HIZ-TILE-BOUNDING ⇄ B472 (`4219f2b483`)** — pre-campaign (parity sprint 465–481), recorded here because it postdates this register's Batch-455 consolidation. Root cause: `SOABoundingSphereLayout.populate()` read `.radius` off every DrawCommand boundingVolume; `OrientedBoundingBox` (carried by 3D-tile DrawCommands, including region-bounded tilesets) has no `.radius`, so the radius SOA filled with **NaN** and the Hi-Z occlusion test produced garbage visibility (silent mis-cull / never-cull). Fix: `boundingVolumeCenter()`/`boundingVolumeRadius()` helpers resolving center/radius across BoundingSphere, OBB (tight enclosing-sphere half-diagonal `|u+v+w|`, matching `BoundingSphere.fromOrientedBoundingBox`), and `Tile*BoundingVolume` wrappers; degenerate/unknown volumes are skipped (conservative-visible fallback) instead of poisoning the SOA. **Probe:** `probe-hiz-tile-occlusion.mjs` — no NaN in the radius buffer, radii match `fromOrientedBoundingBox`, occluded tiles cull cleanly. Off-gate: BoundingSphere-bounded commands byte-identical.

---

## 7. Fork-Drift Regressions & Sync Decisions

**Decision lens (project owner, 2026-06-11):** *fix forward, improve the product; merge-cost minimization is NOT a goal.* This **rejects** the ultra-review's headline Axis-B `NEW-FORK-MODERNIZATION-REVERT` recommendation. The ES6/TS modernization is product direction and stays.

### 7.1 Fork-introduced regressions — fixed forward (NEW-FORK-MODERNIZATION-REGRESSIONS, Batch 237)

The codemod-scale ES6 mega-commit (`39f5341e64`, 657 files / ~98K lines) shipped real behavioral regressions. Verify-then-fix outcome:

- **`Resource.parseUrl`** — re-verified: `Resource.contains` never existed (the label conflated findings); the real Resource regression was `parseUrl` (Session 35, already fixed). **A third still-live `parseUrl` divergence surfaced**: the no-scheme/no-base branch dropped protocol-relative authority (`"//host/"` → `"/"`, failing `ArcGisMapServerImageryProviderSpec`) and re-rooted bare-relative URLs. Fixed forward (upstream urijs semantics); `gulp test --includeName Resource` 397/397.
- **`TimeIntervalCollection.contains`** — already fixed (`17441c3af9`), upstream-identical. No change.
- **`Animation.js` childNodes text-node bug** — already patched, byte-identical to upstream. No change.
- All locked by `Tools/upstream-regression-check.mjs` (18 checks).

### 7.2 Upstream value pulled IN (on merit, not merge-hygiene)

- **B4 ⇄ NEW-UPSTREAM-IMAGERYLAYERS-EMPTY-GUARD (Batch 237):** empty `imageryLayers` array wrongly triggered `ImageryPipelineStage` (`hasImageryLayers` must also check `.length > 0`). **Affects WebGL too.** Ported.
- **pickModel #13433 ⇄ NEW-UPSTREAM-PICKMODEL-13433 (Batch 238):** matrix-mult fix for non-worldspace instance transforms + `octDecode` arg order. Found + fixed the pre-existing `NEW-WEBGPU-INSTANCED-VA-DIVISORS` (instanced models crashed the WebGPU render loop).
- **Ground-prim `showsUpdated` #13366; degenerate-triangle edge guard #13421; panorama lighting #13369** — all ported (`NEW-UPSTREAM-*` ✅). Edge display-mode + material-color override on WebGPU also shipped.
- **`NEW-CAMERA-JSDOC-RESTORE` (✅):** restored ~80% public-API JSDoc/`@example` lost on `Camera.js`/`ScreenSpaceCameraController.js`.

### 7.3 Declined (deliberate, recorded so a future owner sees the call)

- **`NEW-FORK-MODERNIZATION-REVERT`** (~15 cosmetic ES6 conversions) — DECLINED. Modernization is product direction.
- **`NEW-CAMERA-UPDATEVIEWMATRIX-REVERT`** — DECLINED as a revert; `status: verify` it isn't a functional view-matrix-seeding regression.

### 7.4 Latent merge hotspots (no defect today — sync-planning only)

`Context.js` (content conflict) + `PickId.js` (add/add) are the only *active* conflicts. Guaranteed on next upstream touch: Scene.js, Model.js, Model3DTileContent.js (double-conversion), Globe.js, Cesium3DTileset.js, VoxelEllipsoidShape.js (frozen behind an upstream rewrite), the 5 collection files, the B5 companion extractions, ShadowMapComputations.js. **Sync breaking-changes flagged:** Node 22 minimum + `BufferPrimitiveCollection` readonly props (#13448). Not bugs — tracked for the eventual merge.

---

## 8. 2D / CV / Morph Parity Findings

From `PLAN_2DCV_MORPH_BATCHES.md` + cross-coupling A.4. Status re-verified:

| Item ID | Sev | Status |
|---|---|---|
| MORPH-MIX-JITTER, MORPH-WEBMERCATOR-INSTANCEOF | P2/P2 | ✅ FIXED (Batch 217). WGSL builtin `mix()` didn't return exact endpoints at t=0/1 on some GPUs → settled-globe shimmer (manual lerp now); `projection.constructor.name === "WebMercatorProjection"` broke under esbuild `minifyIdentifiers` in release → `instanceof` now. |
| MORPH-POLYLINE-COLLECTION-2D | P1 | ✅ FIXED (Phase 3 Slice 4, §6.7). |
| WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER | P0/P1 | Batch-2 audit found billboards/points/labels rendered nothing in **all** modes (pre-existing ≥Batch 214) — "structurally correct code-read didn't match runtime," the classic trap. `status: verify` resolved (collections render at HEAD). |
| CLASSIFIER-2D-CV ⇄ NEW-CLASSIFIER-2D-CV-MORPH | P1 | OPEN (§5). Vector3DTile classifiers gated in 2D/CV; the gate is *better* than upstream WebGL. |
| MORPH-EXAG-SKIRTS | P1 | OPEN. Exaggeration in CV/morph turns skirts into walls (Batch 216 revert). |
| MORPH-MODEL-PROJECT2D | P2 | OPEN. glTF `projectTo2D:true` has no WGSL `position2D`/USE_2D path. Opt-in; default at parity. |
| MORPH-TAA-PREVVP | P2 | OPEN. `previousViewProjection` not guarded across the perspective↔ortho mode-flip frame → TAA smear. |
| MORPH-REVIEW-GAPS (PICK / COMPLETION-POP / CAMERA-FRUSTUM / MULTIVIEW) | verify | OPEN — probe-driven verification pass. |
| MORPH-PREVMODE-TYPO | P3 | Disputed (`SceneTransitioner.js:1083` `_previousModeMode`). Document-only / human call — do NOT blind-rename. |

---

## 9. Finding-ID Index (pointers to the standalone definition sources)

This register **chains and summarizes**. The authoritative per-ID definitions live in the documents below — when a reviewer needs the full original finding text, file:line anchors, or the reviewer's reasoning, go to the source:

| ID family | Authoritative definition source | Notes |
|---|---|---|
| `C-R1..C-R14`, `H-R1..H-R14`, `M-R*` | **`PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`** | **Stays standalone — this register links, never copies.** Each C-R/H-R entry there carries its own FIXED/DEFERRED/PARTIAL annotation + FOLLOW-UP sub-IDs (e.g. `C-R1-CLASSIFICATION`, `C-R8-EDGE-INLINE`, `C-R9-MODEL-FEATURE-PICK`). |
| `B-*`, `C-P*`, `H-P*` | `PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md` | Per-finding status banner says read the per-finding annotations, not the 2026-04-16 summary counts. |
| `A<n>.<m>` (Axis A), Axis-B drift | `audits/2026-06-11_ULTRA_REVIEW.md` + `_findings.json` | 195/235 confirmed-real; the 2 CRITICALs orchestrator-spot-checked. |
| `A.<n>/B.<n>/C.<n>/D.<n>` (cross-coupling) | `AUDIT_2026_05_02.md` | Keep that doc as the 2026-05-02 snapshot; future audits diff against it. |
| `NEW-*`, `DP-H*`, `FORK-*` | **`DEFERRED_WORK.md`** (the live tracker) | The durable handle for every open item; the 2026-06-11 section (49 IDs) carries the per-ID ✅/⏳/DEFERRED status this register's §6 re-verified. |
| `BUG-<n>` / `Session.Bug` | **`WEBGPU_DEBUGGING_LOG.md`** | The full chronological fixed-bug log (~13K lines, Sessions 1–67+). §6 summarizes the load-bearing ones; the log has the rest. Search it before debugging a new artifact. |
| Picking deep-dive | `archive/PICKING_ANALYSIS.md` | WebGL pick-method inventory, WebGPU gap analysis, industry comparison, drill-pick-to-Earth-center. Largely superseded by §6.1's shipped fixes. |
| Sorting/Z-ordering | `archive/SORTING_ARCHITECTURE_ANALYSIS.md` | 5-layer sort taxonomy + "Cadillac" proposal. The translucent-sort gap (C-R3) and splat sort (A2.1) trace here. |
| Fix-progress ledger | `archive/REVIEW_FIX_PROGRESS.md` | The running batch-by-batch ledger behind the per-feature/renderer-deep fixes. |
| Feature completeness | `audits/2026-04-30_FORK_FEATURE_INVENTORY.md`, `FEATURE_INVENTORY.md` §C/§D | Feature-level WIP/FUTURE view; the inventory's own "doc inaccuracies discovered during verification" section is worth reading first. |
| Maintainability | `audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md` | Readability / failure-modes / embeddability / CLAUDE.md-compliance survey; A16.3 TS-coverage finding (§3) originates adjacent here. |

---

### Reviewer to-do for the next round

1. **Re-probe the four `status: verify` items** (splat default-path order, model VS motion gate, camera ctor view-matrix seed, WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER) and either close or promote to §2/§3.
2. **Confirm `NEW-DYNAMIC-ENVMAP-FULL-SCENE` vs C2-25 scene-capture (Batches 448–452)** — likely now closed; reconcile.
3. **Decide the C.2 orphan-dispatcher fate** (consume-or-delete) under the Principle-7 dead-code rule.
4. **Reconcile the doc-hygiene STALE-STATUS items (D.3/D.5/D.6/D.8)** against `FEATURE_INVENTORY.md` during its own consolidation pass.

5. *(Items 5–10 are from the 2026-07-03 campaign audit, Batches 482–506 — see §3.3 for the full entries.)* **Fix CAMPAIGN-AUDIT-1 (voxel pick vs octree LOD) as the next immediate work item** — level-1 child-octant traversal + child-tile megatextureId in the pick march, plus a `VOXEL_USER_CUSTOM_SHADER` alpha branch (`WebGPUVoxelRenderer.ts:664–716` vs `:416–433`, `:697` vs `:473–478`). Ensure the live tracker carries a first-class entry.
6. **Fold CAMPAIGN-AUDIT-2's measured numbers into the atmosphere-brightness/limb investigation** (underground-def 22.85%, underground-red 12.28%, translucent-terrain 25.49%, dRGB −5.8..−8.0); verify B506's seam/glint shading deltas apply symmetrically on the translucency/underground paths. **Do not loosen the probe limits.**
7. **Investigate CAMPAIGN-AUDIT-3** — model light direction / IBL orientation under `SceneMode.SCENE2D` (interiorDiff 34.27; globe-shader attribution already dismissed with PNG evidence).
8. **Resolve CAMPAIGN-AUDIT-4** — `hdrMode` compensation or post-tonemap placement for the PP library builtins + user WGSL stages; correct the inaccurate "matches WebGL insertion point" comments (`WebGPUPostProcessPipeline.ts:1403/:1421`) and the stale header stage-order docstring (~`:39–42`).
9. ✅ DONE 2026-07-03 (`NEW-COLORGRADING-BASELINE-REFRESH`): **Refresh the stored `probe-colorgrading-wired` baseline PNG** (stale after B506's intentional default-view pixel change — its only failing gate; baseline regenerated post-B506, gates A–F PASS at Batch 518 HEAD), and set `PROBE_BASE=http://localhost:8080` when running `probe-collections-regression` / `probe-pick-basic` (they default to `:8134`).
10. **Add a crescent-phase assertion to `probe-env-moon.mjs`** (B505 only asserts the full-disc case).
