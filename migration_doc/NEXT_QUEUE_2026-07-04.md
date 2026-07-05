# NEXT QUEUE — 2026-07-04 (post-Campaign-3, HEAD = Batch 554)

> **BANNER — READ FIRST.** This queue was assembled from a **live-code re-mine at HEAD 554**, three miners (roadmap-issues, deferred-research, leftovers-debt), deduped and status-verified item-by-item. **Campaign 3's hard lesson holds: ~half of every "open" doc row is PREMISE-STALE (docs lag code).** Before touching any queue row, re-verify the premise against LIVE CODE + `git log --all -S<symbol>` at the then-current HEAD — a doc saying "open" is NOT proof. Mark drift as LIKELY-STALE and route it to the reconcile pass, do not spend a fix batch on it.
>
> **EXCLUDED (already queued / running in the two live follow-ups):** B11/B12 projectTo2D, Q15 Vector3DTile-containment, Q24 DP-H47, and the standing BUG-POLYLINE-COLLECTION-MULTI-MATERIAL gate. Not repeated below.
>
> **Counts:** 36 OPEN (queued) · 16 LIKELY-STALE (one cheap reconcile batch) · 14 BY-DESIGN (deferred-forever tail).
>
> **Model-tier legend:** `opus` = mechanical / scoped-implement · `fable*` = diagnostic / novel-cross-system (fable-when-available, else opus). Effort: S/M/L/XL.

---

## TIER 1 — User-facing bugs (fix first)

| # | id | eff | diff | tier | deps | files hint | probe | off-gate |
|---|----|-----|------|------|------|-----------|-------|----------|
| Q1 | **BILLBOARD-ATLAS-VFLIP** | M | scoped | opus | — | `Shaders/WebGPU/Collections/BillboardCollection.wgsl` (QUAD_UVS ~L294-300) vs `Shaders/BillboardCollectionVS.glsl:141`; check `WebGPUTexture` flipY | NEW `probe-billboard-atlas-vflip.mjs` w/ an **asymmetric** glyph image, all scene modes | must not trade label-flip for billboard-flip; verify main + SDF + pick variants both un-flipped |
| Q2 | **SUN-GLOWFACTOR-IGNORED** | S | mechanical | opus | — | WebGPU sun bake `createSunTexture` + `packSunUniforms` (hardcoded 1.0); ref `Sun.js:182-183` | `probe-sun-pixel-check` at non-default glowFactor | default glowFactor=1.0 stays byte-identical; also add `czm_gammaCorrect` to sun FS (HDR-only, no-op default) |
| ~~Q3~~ | ~~**ATMOSPHERE-LUT-BGL-INCOMPAT**~~ **PREMISE STALE (2026-07-04)** | M | scoped | opus | — | Fixed in Batch 396 (b5bdc9e59c, 2026-06-25): `dispatchAtmosphereLUT` passes explicit `baseLayouts=[AtmosphereLUT_BGL]` to `dispatchCompute` → `getOrCreatePipeline` builds an explicit `pipelineLayout` for `computeTransmittance`/`computeInscatter` (not `layout:'auto'`); the extended kernels already use `[emptyGroup0, extended]`. | `probe-atmo-lut-no-device-error.mjs` GREEN at HEAD (0 GPU errors, no atmosphere filter) | n/a — no runtime change |
| Q4 | **FLAT-MATAPPEARANCE-POLYGON-MATERIAL-SOLID** | M | diagnostic | fable* | — | WebGPU flat (height-0, non-extruded) MaterialAppearance st/texcoord generation; likely same class as C2-5 DiffuseMap white-rect / C2-9 | `probe-flat-polygon-grid-material` (Grid material on flat polygon), WebGL renders pattern | pattern (not solid) renders on flat face; extruded top-face path must stay green |
| Q5 | **PP-STAGE-RESTORE-LEAK** | M | diagnostic | fable* | — | WebGPU PP composite empty-collection path (stays on multi-stage ping-pong instead of direct IdentityBlit) | `probe-pp-library-builtins` case-4 off-gate (= MC-3, the real standing red) | default-vs-restored byte-diff → 0 (today 1,429,998 durable); default-vs-default2 already 0 |
| Q6 | **CUBEMAP-PANORAMA-HDR-DECODE** | S | scoped | opus | — | `WebGPUCubeMapPanoramaRenderer.js:140-142` (in-code TODO: sRGB→linear pow 2.2 when HDR on); ref `SkyBoxFS czm_gammaCorrect` | `probe-panorama-hdr` faint-pixel diff | HDR-gated; SDR path byte-identical |
| Q7 | **PLAIN-HDR-GAMMA-TAILS** | M | diagnostic | fable* | — | (a) exposure→WGSL tonemap uniform sync; (b) non-default operators Reinhard/ACES/Filmic/ModReinhard vs `czm_*`; (c) **per-instance entity color divergence** (orange box drawn cornflower blue, SDR+HDR) | `probe-plain-hdr-tonemap` per-operator + per-instance-color case | (c) is a distinct pre-existing defect, NOT the excluded polyline-multi-material gate; only PBR-Neutral operator currently exact |
| Q8 | **VOXEL-CELL-PICK-TAIL (C-R9)** | M | scoped | opus | — | `Scene.pickVoxel` → `voxelPrimitive._traversal.findKeyframeNode(tileIndex)`; WebGPU traversal doesn't build keyframeNode table | `probe-voxel-pick` end-to-end (currently throws after decode) | pickVoxel returns a VoxelCell (per-cell DECODE already byte-identical; construction gap is the residual) |
| ~~Q9~~ | ~~**VOXEL-PICK-OCTREE-COMPOSITION (R-8a)**~~ **PREMISE STALE (2026-07-04, C4-VOXEL-PICK-OCTREE-L3)** | M | scoped | opus | Q8 | GPU pick-march half already DONE: `fragmentPickVoxelMain` shares the color march's `octreeDescend` (B521) reaching LEVEL 3 (B552 `l3Slots`) + honors `VOXEL_USER_CUSTOM_SHADER` alpha (B509); pick command binds the SAME UBO/bind group as color → no root bias. Not reimplemented. | `probe-voxel-cell-pick.mjs` **Part D** (new, L3) GREEN: WebGPU pick descends to an L3 atlas slot inverting to the SAME level-3 spatial tile WebGL resolves, byte-equal sample (Part B=L1, Part C=user gate) | n/a runtime (probe + doc reconcile only). Residual = CPU VoxelCell construction for megatextureIndex >= 1 (distinct child-content-retention follow-up, C-R9 in DEFERRED_WORK) |
| Q10 | **CLUSTERED-ASSIGN-BOUNDS-DIRTY** | M | scoped | opus | — | Clustered-light assign ignores cluster-bounds dirty (A7.2); multi-frustum approximate bins (A7.6) | `probe-clustered-lights-resize` (resize/FOV, no camera motion) | bins recompute on bounds change; no stale bins |
| Q11 | **DECOUPLEDSCAN-FORWARD-PROGRESS-GUARD** | S | scoped | opus | — | `DecoupledLookbackScan` `storageBarrier()` spin (A2.3) | n/a (opt-in, default-off) — unit-style occupancy check | add capability/occupancy gate + iteration-cap watchdog + permanent `console.error` sentinel |
| Q12 | **BUFFER-POSITION-INTEGER-NORMALIZED** | M | scoped | opus | — | Buffer* integer/snorm/unorm `positionDatatype` + `positionNormalized:true` encode (2D/CV half shipped B467) | `probe-buffer-integer-position` | int/normalized positions decode correctly on WebGPU |
| Q13 | **CI-NODE20-ESM-TS-BARREL** | M | diagnostic | fable* | — | `Specs/test.mjs` ERR_MODULE_NOT_FOUND on 5 TS-backed barrel re-exports (.js→.ts esbuild-only inference); candidate fixes change published package surface | `node Specs/test.mjs` runs clean | fix must not alter the public `@cesium/engine` export surface (related: variant-exemption c1b0bf2a77 touched a different symbol) |

## TIER 2 — Scoped ports / features

| # | id | eff | diff | tier | deps | files hint | probe | off-gate |
|---|----|-----|------|------|------|-----------|-------|----------|
| Q14 | **ATMO-DERIVED-LIGHTING-LUT-CONSUMPTION** | S | scoped | opus | **Q3** | `AtmosphereDerivedLighting.js` — swap analytic CPU sun/sky terms for Bruneton TRANSMITTANCE/IRRADIANCE LUT reads (body swap behind same signature) | `probe-atmo-derived-lighting` MS-aware vs analytic | GATED on Q3 (LUT must dispatch clean first); public module shape unchanged |
| Q15 | **ATMO-AERIAL-PERSPECTIVE-NEARFIELD-TUNE** | S | scoped | opus | — | aerial effect `setIntensity`/`setInscatterScale` exist but no per-frame scene-side sync; make `scene.aerialPerspectiveConfig.{intensity,inscatterScale}` runtime-mutable | NEW WebGL-vs-WebGPU ground-haze numeric parity probe | near-field haze not over-heavy at high sun; depth-fade already correct |
| Q16 | **WASM-BRIDGE-BUNDLE-LOAD** | M | scoped | opus | — | WASM RTE-encode SIMD kernel not loading in bundle → JS fround twin runs; bridge load path | perf micro-probe (SIMD vs JS) | SIMD kernel actually loads; JS fallback still correct (flat-buffer hoist win B273 stands regardless) |
| Q17 | **GPU-SORT-PIPELINE-PHASE-3** | M | scoped | opus | — | Sort-keys produced + `_lastSortedIndices` readback runs but RenderScheduler consumes nothing; need compactedToOriginal map + skipped list + `_applySortedOrder` | `probe-gpu-sort-consume` (order matches CPU comparator) | permutation indexes original command array (not compacted SOA); Principle-9 scaffolding gets its consumer |
| Q18 | **GPU-CULLER-CONSUME-OR-DELETE** | M | scoped | opus | — | `gpuCullCommands()`/HiZ/GPUSortKeys/PointCloudSort orphan dispatchers allocate eagerly, no live caller (Principle-7 landmine) | n/a — architecture decision + doc | either wire a consumer or delete + reclaim allocation; document the call |
| Q19 | **TAKRAM-8-GEOMETRY-LENS-GLARE** | M | scoped | opus | — | `WebGPUEnvironmentRenderer.js` (no dedicated Sun/Moon renderer) — add caustic/refraction glow around disc | `probe-sun-lens-glare` | cosmetic fill-in; disc/limb/glow core already shipped B378 |
| Q20 | **TAKRAM-9-CLOUD-AWARE-GODRAY** | M | scoped | opus | — | `WebGPUGodRayEffect.ts` — sample cloud TRANSMITTANCE (not just depth) | `probe-cloud-godray` | needs cloud transmittance exposed to PP god-ray pass; base god-rays/light-pillars shipped |
| Q21 | **TAKRAM-10-MULTIBODY-ATMOSPHERE** | L | scoped | opus | — | Parameterize LUT pipeline for Mars/airless (`CelestialBodyAtmosphere` param set); LUT already parameterized | `probe-mars-atmosphere` (needs asset) | demand-gated (non-Earth bodies) — schedule only on real demand |
| Q22 | **CELESTIAL-HIRES-MOON-TEXTURE** | S | mechanical | opus | — | replace `moonSmall.jpg`; altitude-based alpha-blend between resolutions | `probe-env-moon` at lunar-orbit range | asset sourcing + blend; no code risk |

## TIER 3 — Verification / doc-debt (breathers between heavy batches)

| # | id | eff | diff | tier | deps | files hint | probe | off-gate |
|---|----|-----|------|------|------|-----------|-------|----------|
| Q23 | **FARZOOM-INTERIOR-BLOBS** | M | diagnostic | fable* | — | far-zoom residual bucket (b) = 32.2% of mismatch; interior "GPU brighter" blobs over high-lat snowy terrain; suspect ground-atmosphere intensity and/or mip/LOD-bias | `probe-globe-farzoom` w/ `showGroundAtmosphere` toggle + re-bucket | root-cause bucket (b) (buckets a/c noise-floor, d = atmosphere epic); the only far-zoom lever with real payoff |
| Q24 | **GEOJSONPRIMITIVE-PROBE-DEBT** | S | scoped | opus | — | GeoJsonPrimitive MultiPolygon winding / interior-ring holes; `debugShowBoundingVolume` is a no-op on this path | NEW `probe-geojson-holes.mjs` | pixel parity on holes; also wire debugShowBoundingVolume |
| Q25 | **R-4-MVT-WEBGPU-PARITY-PROBE** | S | diagnostic | fable* | — | inherited `MVTDataProvider`→`buildVectorGltfFromMVT`→`VectorGltf3DTileContent`; `decodeMVT.js` is SYNCHRONOUS (off-thread WASM angle separate) | NEW MVT datasource pixel-diff both backends | parity confirmed; note synchronous-decode profile item separately |
| Q26 | **R-7-RENDERBUNDLE-EXPANSION** | M | scoped | opus | — | run `WebGPUCpuPassProfiler.ts` on 5 named scenes → 1-2 site shortlist (R-7a 3DTiles opaque, R-7b OIT, R-7e Vector3DTiles, R-7f buffer prims) | profiler pass (<1ms skip, >5ms strong candidate) | data-collection first; globe site nuance (B292 dropped inline bundle for dynamic-offset UBO) |
| Q27 | **R-2a-CROSS-SOURCE-ATTRIBUTE-UNIFICATION** | S | scoped | opus | — | audit: GPU-side cross-source attribute joins (vector nationCode × imagery landcover ID in a shader pass) | n/a — scoping audit (~1 session) | produce a plan-state design note |
| Q28 | **R-2b-UNIFIED-FEATURE-ID-TEXTURE** | M | scoped | opus | — | source-agnostic per-fragment feature-ID texture for PP; builds on Batch-133 `WebGPUSceneRendererPickPass` (distinct from per-model glTF feature IDs) | `probe-feature-id-texture` | cross-source ID resolvable in a PP pass |
| Q29 | **MODEL3DTILECONTENT-DOUBLE-CONVERSION** | S | doc-debt | opus | — | `Model3DTileContent` class-converted on both fork + upstream — merge-time reconcile strategy | n/a — merge bookkeeping only | note in merge-hotspot doc; no code change at HEAD |

## TIER 4 — Epics (increment-split; land the cheap slice first)

| # | id | eff | diff | tier | deps | split plan / blocker | off-gate |
|---|----|-----|------|------|------|----------------------|----------|
| Q30 | **LOG-DEPTH-POSTPROCESS-FRUSTUM-WIRING** | L | novel | fable* | driver frustum threading | **Slice A**: thread live per-frame frustum near/far + `logActive` flag into each PP effect UB. **Slice B**: log-reverse depth in AO/DoF/SSR/contact-shadows/god-rays + HiZ projected-z + model classification. Q18 (B548) shipped only GroundPolyline consumer; effects bake placeholder 0.1/10000 | none of these break the default scene; land slice-gated |
| Q31 | **MODEL-WGSL-CUSTOM-SHADER-RESIDUAL** | L | scoped | opus | — | **Slice A**: CustomShaderMode MODIFY-vs-REPLACE (needs pre-lighting injection restructure; B473 injects post-lighting). **Slice B**: extra material fields. **Slice C**: custom varyings/attributes — BLOCKED by TAA using `@location 9-10` (varying-budget conflict) | core + translucencyMode already shipped (B473/Q25 B554) |
| Q32 | **ATMOSPHERE-UNIFICATION-FULL (Q24-inc2+)** | L | novel | fable* | — | wire all 4 sky-integral consumers (sky FS inline march, env-cube inline march, aerial per-pixel march, cloud ambient heuristic) onto ONE shared sky/transmittance/MS LUT. A-LUT-REPARAM (shared table) + AERIAL-FROXEL bake (B553 Q23) already shipped → remaining = wiring. **Distinct from excluded Q24 DP-H47** | consumers read shared LUT; per-consumer re-derivation removed |
| Q33 | **CLOUD-EXOTIC-FORMS-E1-E3** | L | scoped | opus | — | **E2 mammatus** (downward underside density modulation) is the cheap feasible increment — land first. Then lenticular/K-H/asperitas/virga/noctilucent/contrails on the baked-density-field arch | 11 WMO genera already shipped (B385/408/452) |
| Q34 | **TS-CONVERT-JS-RENDERERS** | XL | mechanical | opus | — | ~25 untyped .js WebGPU renderers (~35K LOC); split per-renderer, largest first: WebGPUModelRenderer.js (3802) / GroundPolyline / PrimitiveCommands / GroundPrimitive / ModelPipelineCache. Only StarField converted (B314) | `tsc --noEmit` clean per-renderer; runtime unchanged |
| Q35 | **WEBGPUCONTEXT-DECOMP-DEBT** | L | scoped | opus | — | `WebGPUContext.ts` (~4.3K LOC) + `WebGPUSceneRenderer.ts` exceed 1000-line guideline; extract focused modules (<1000 LOC each). Overlaps Q34 (JS→TS) but distinct concern | behavior-preserving; existing probes stay green |
| Q36 | **WEATHER-PHASE-4-GRIB2** | XL | novel | fable* | **same-origin proxy + WASM GRIB2 (unbuilt)** | needs NODD-S3 (HRRR/GFS/NBM) proxy (S3 CORS), GRIB2 parse in Worker/WASM, Lambert-Conformal→equirect reproject. Soft-blocked until proxy exists in dev env | hard-blocked; build the proxy first or defer |

---

## RECONCILE PASS (LIKELY-STALE) — one cheap doc-only batch clears most; do NOT spend a fix batch each

These are doc rows contradicted by live code / a landed batch. Action = **reconcile the doc**, not fix code. Re-verify each against HEAD before editing.

| id | why stale (landed batch) | doc(s) to fix |
|----|--------------------------|---------------|
| DP-H46c-PICKMETADATA-PRODUCER | DP-H46 epic CLOSED B463 (8c10431cbc); producer shipped B460; `getPickMetadataPipeline` live in WebGPUModelRenderer.js. Letter mismatch (c/e) | ROADMAP §3 crit-path #2 + §4.5 |
| NEW-VOXEL-PICK-OCTREE-COMPOSE | depth-1 pick shipped B509 (1d5dde33cb) — descends level-1 octant + VOXEL_USER_CUSTOM_SHADER pick branch. Doc still says "P1 FIX NOW". (Residual L3-parity → queued as Q9) | ISSUES §3.3 CAMPAIGN-AUDIT-1, ROADMAP §4.5/§5.2 |
| C-R1-PRIMITIVE-DERIVED-PANORAMA-CULLMODE | RESOLVED B317 (2ee9421571); live `WebGPUPrimitiveCommands.js:2606-2609`. Intra-register contradiction (ISSUES §3.2 vs ROADMAP §4.2/§5) | ISSUES §3.2 |
| NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT | both producers shipped, Q17 B547 (b6de9e4012) reconciled CONSUMERS but not PRODUCERS bullet | ROADMAP §4.1 first bullet |
| NEW-ENV-MOON-CRESCENT-PROBE | m1 cites B517 (cedb99efa3) landing the crescent acceptance pass; m2 says still open. **Verify B517 first** — if present, close; else this is the one genuine probe-extension (S/mechanical) | ROADMAP §4.7 / §5.2 |
| NEW-PP-LIBRARY-TONEMAP-ORDER | RESOLVED B511 (afa8b97473) post-tonemap ordering. ISSUES §3.3 stale vs ROADMAP §4.7/§5.2 | ISSUES §3.3 CAMPAIGN-AUDIT-4 |
| NEW-COLLECTION-RENDERER-BASE | COMPLETE B332 (5/5 renderers). ISSUES §3.1 A5.3 row not reconciled | ISSUES §3.1 |
| FEAT-3DT2-03 | SHIPPED B496 (0fbd476dd3) + Q19 reconcile B549 (a2ced9da3d). Move out of open-HIGH table | ISSUES §3 open-HIGH |
| WGF-3-F16-POSTPROCESS | f16 PP variants shipped B478 (66f2807273). Residual = device-verify (→ BY-DESIGN) | §6.3 recommendation |
| BUFFERPOLYGON-2DCV-REPROJECTION | shipped B467 (0fad5f5834); §5 gap table stale vs §4.2 | §5 post-merge gap table |
| **NEW-MODEL-SCENE2D-SHADING** | **RESOLVED B530 (ae2f4630c5, NEW-MODEL-IBL-AMBIENT-RELAND)** — probe GATE PASS (2D 34.42→11.85). m1 missed B530. Still listed OPEN in ROADMAP §4.3, §5 table, FORK_OVERVIEW §8 | ROADMAP §4.3 + §5, FORK_OVERVIEW §8 |
| NEW-WEBGPU-SKYBOX-HDR-FAINT-STAR-PARITY | partial fix landed B364. Re-run `probe-stars-hdr-verify` to confirm residual survives before rescheduling | DEFERRED_WORK L4706 |
| ATMO-PARITY-LIMB-RING-BELOWSURFACE | translucency half now GREEN 3.65% (Q7 determinism kit, B537) — that half is stale. Limb-ring may persist → **re-measure at clean HEAD with determinism kit** to separate real residual from drift | RESEARCH §3 |
| NEW-DYNAMIC-ENVMAP-FULL-SCENE | C2-25 epic closed B446-451. ENV-CAPTURE-PER-FACE-LOD may be a genuine remainder — **premise-reconcile to scope the true remainder** before treating as OPEN | ISSUES §4, ROADMAP §4.7/§9.1 |
| MC-5-FORK-OVERVIEW-SEC8-STALE | bulk §8 predates Campaign 3: voxel L3 (Q22 B552), below-surface (B510/512/513), PP-order (B511), Vector3DTile MSAA (Q2 B533), model SCENE2D (B530) all landed | FORK_OVERVIEW §8 (whole section) |
| MC-8-CR9-MODEL-FEATURE-PICK-CONFLICT | documented both RESOLVED (B209) and as standing residual (DEBUGGING_GUIDE L505). Re-verify b3dm per-feature pick returns Cesium3DTileFeature; reconcile the contradiction | DEFERRED_WORK L2975/2977, DEBUGGING_GUIDE L505 |

---

## DEFERRED-FOREVER (do NOT queue) — gating reason attached

| id | gate | note |
|----|------|------|
| NEW-VOXEL-OCTREE-DEEP-LEVELS (= VOXEL-OCTREE-ARBITRARY-DEPTH / MC-10) | device + demand | L3 shipped Q22 B552 (flat-slot); L4=4096 slots impractical for flat scheme — needs upstream `u_octreeInternalNodeTexture` node-table port; dynamic LRU pool stays L2-only |
| NEW-CSM-VOLUMETRIC-CASTERS | demand | Voxels + GaussianSplat CSM cast needs deep-shadow-map; WebGL doesn't cast these either. Billboard/Label/Point/Polyline explicit non-goals |
| WATER-PHASES-1-9 (water half of BYDESIGN-WATER-VEGETATION-XL) | Phase-1 validation gate | design-complete (C1-C14 locked 2026-04-08); Phase-3 depth now unblocked by shipped log-depth epic; no WaterClassificationProvider/Gerstner/FFT yet |
| VEGETATION-V1-V5 (veg half of BYDESIGN-WATER-VEGETATION-XL) | v1 core must ship + profile | design/survey only; ~80% infra reusable (GPU cull/indirect/PNTS-I3DM/RTE) |
| NEW-CLASSIFIER-2D-CV-MORPH | demand + intentional skip-gate | skip-gate is BETTER than upstream WebGL (which renders wandering volumes); lifting without RTC-relative projection would regress. (+ .vctr fixture verification-debt) |
| MC-9-STARFIELD-TUNE | cosmetic / low-value | ~+55 meanDelta on ~102 residual px; acceptable-as-is |
| MC-11-VOXEL-CUSTOMSHADER-RESIDUALS | user demand | SAMPLER_2D color-map uniforms → warn+gray; only metadata[0] exposed; no fsInput.voxel.* block — "as demand surfaces" |
| MC-12-RTE-ELLIPSOID-NONEARTH | asset (no Mars/Moon asset) | core SHIPPED (probe-ellipsoid-rte 0.000%); residual hardcoded EARTH_RADIUS in shadow-CAST WGSL mirrors WebGL (not a backend gap) |
| NEW-PP-F16-DEVICE-VERIFY (= MC-13 / BYDESIGN-F16-POSTPROCESS-VARIANTS) | shader-f16 hardware | opt-in variants shipped B478, default-off byte-neutral; needs RTX-class GPU to pixel-verify; post-100% priority |
| PARITY-CUSTOM-SHADER-TRANSPILE | low ROI | native-WGSL path (B473/Q25) covers the parity case; GLSL→WGSL naga is the heavy lift, GLSL on WebGPU warns non-fatally |
| BYDESIGN-SHADOW-ALTERNATIVES (VSM/ESM/linear-depth/tile-per-cascade-WSM/CSM-globe-res) | post-parity profiling | 5-tap PCF is production-ready + parity-neutral; cascade RECEIVE bug already fixed B298 |
| BYDESIGN-SCENE-IN-WORKER (Option B) | scaling motivation + multi-week branch | spike landed; structural blockers (structured-clone entity descriptors, ScreenSpaceEventHandler DOM binding, GPU ownership). ECS-worker spike was NO-GO (B305) |
| BYDESIGN-WATCH-BUCKET (NTC / WebNN / MIL-STD-2525 / subgroups) | browser feature-gate or demand | no code (no loadNTC.js / WebNN wiring / milsymbol dep); gpuweb#4195 subgroup_matrix "Needs Decision" mid-2026; R-5 single-buffer pick = do-not-pursue |
| WGSL-PREPROCESSOR-V2 | trigger not fired | capacity premise overtaken (30 bits live, keySalt escape-hatch in prod); defer until a single unmaintainable boolean source condition appears — cheap to build then (pure function) |

---

### Assembly notes
- **Dedupes applied:** BILLBOARD-ATLAS-VFLIP (m1#12 + m2 + MC-1) → Q1; PP-STAGE-RESTORE-LEAK (m2 + MC-2) + MC-3 probe → Q5; PLAIN-HDR tails (m1 + m2) → Q7; voxel deep-levels (m1 + m2 + MC-10) → one BY-DESIGN row; f16 PP (WGF-3 stale + m2 BY-DESIGN + MC-13) → reconcile + one BY-DESIGN row; water/vegetation XL (m1 + m2) → two BY-DESIGN rows.
- **Status flips vs miner input:** NEW-MODEL-SCENE2D-SHADING moved OPEN→LIKELY-STALE (leftovers miner caught B530 fix that roadmap miner missed). NEW-DYNAMIC-ENVMAP-FULL-SCENE → reconcile (needs premise-verify to find true remainder). NEW-ENV-MOON-CRESCENT-PROBE → reconcile (verify B517 landed).
- **Dep chain:** Q14 gated on Q3 (LUT must dispatch clean). Q9 gated on Q8 (shared traversal). Q30 slice-B gated on slice-A (frustum threading).
