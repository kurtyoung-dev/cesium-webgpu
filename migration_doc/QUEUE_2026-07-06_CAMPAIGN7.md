> **CAMPAIGN-7 AUTHORITATIVE QUEUE.** This is the canonical queue doc for Campaign 7 (merged, launched 2026-07-06). Landed by batch 0 of `.claude/workflows/campaign-7-merged.js`. Body below is the reviewed plan verbatim.

# Next-Campaign Plan — 2026-07-06 (HEAD ~Batch 633)

Prepared for user review. **Not launched.** All-Opus (Fable capacity exhausted; model-tier infra retained in-engine).

Verified live against HEAD `62dccccf69` (Batch 633). Cloud-unification epic (B617-626), tile-popping (B627), moon extinction (B629), WebGPU ocean waves (B630), coast AA (B631), large-lake data-limitation finding (B632), Sandcastle2 WebGPU-start (B633) all confirmed landed. The parity surface is **nearly drained** — remaining work is enhancement / feature / debt, plus a thin tail of genuine WebGPU parity bugs.

---

## 1. Recommendation

**Run a MERGED campaign (option b), not the armed Campaign 6 verbatim (option a) and not a pure beyond-parity push (option c).**

Rationale:

- **Campaign 6 as-armed is stale in sequencing.** It was planned before the cloud-unification epic and the 2026-07-06 user-bug wave landed. The research (`CLOUD_LOD_RESEARCH_2026-07-05`) now reframes the cloud-impostor XL as an *optional differentiator* to run **after** the cheap `C6-CLOUD-STBN-TAAU` orbit wins, not as the sole orbit bridge. Running C6 verbatim would front-load an XL epic that its own research says to defer.
- **The freshest, highest-value real-user item isn't in C6 at all.** The large-lake water-mask bug (B632) was root-caused as a provider DATA limitation and left unfixed — but it is now **UNBLOCKED** via a license-clean lake dataset, and it is *doubly motivated*: it simultaneously closes the user-reported Great-Lakes-render-as-land bug AND is the exact `WaterClassificationProvider` Phase-1 seed the WATER epic design already calls for. That is the ideal campaign anchor.
- **A pure water/vegetation push (c) is too heavy.** Both are XL net-new (FFT ocean, vegetation scatter compute + deterministic CPU twin). Better to *seed* them with cheap scope-lock / skeleton slices than to bet a whole campaign on one unshipped feature rendering.

So: lead with **user-bug-followups + cheapest-visible wins**, fill the body with **mid-tier rendering enhancements + a couple genuine parity bugs + one byte-neutral debt increment**, and **scope-lock / increment-split the XL epics into the tail** (implement only if the cheap prereqs land green). Sample 1 JS→TS debt batch as filler — do NOT let the bulk arc crowd out real work.

---

## 2. Proposed Queue (OPEN only — cheapest-visible + user-bug first, epics increment-split)

| # | ID | Effort | Category | Why |
|---|----|--------|----------|-----|
| 1 | WATER-LAKE-MASK-FIX-AS-PHASE1-SEED | M | user-bug + epic-seed | Closes B632 (Great Lakes / Great Salt Lake render as flat land, both backends) by rasterizing a license-clean lake dataset (Natural Earth `ne_10m_lakes` / HydroLAKES) into the per-tile water mask. Doubly motivated: this IS the `WaterClassificationProvider` Phase-1 seed the WATER design already specifies. No shader work (consumer half already lives: GlobeWater facade + water-mask terrain path). Highest-value visible user item. |
| 2 | NEW-WEBGPU-GROUNDPRIM-TEXTURED-CLASSIFICATION-ZERO | M | parity-bug | Freshly RE-CONFIRMED OPEN at B595: textured GroundPrimitive classification (Stripe/Checkerboard/Grid/Image) renders ~0px on WebGPU while flat Color renders 7656px. A real WebGL↔WebGPU parity hole, not enhancement. Also unblocks the parked RECON-PRECISION residual. |
| 3 | NEW-PP-SILHOUETTE-ARRAY-EDGE-UNIFORMS | S | parity-bug | ✅ SHIPPED Batch 638 (`4d2743c560`) — `resolveSilhouetteEdgeUniforms` DFS-walks `_stages` to the inner edge stage's color/length. C7-PP-SILHOUETTE-ARRAY-EDGE re-visit (2026-07-10) was premise-stale; hardened the acceptance probe (signature-based edge detection) + doc reconcile only. |
| 4 | C6-TPDF-DITHER-FINAL | S | enhancement | Confirmed: Tonemapping.wgsl final composite has zero dither. Cheap TPDF/blue-noise pass kills banding on smooth sky/fog gradients. Visible, low-risk, opt-in. |
| 5 | C6-AERIAL-ELLIPSOID-SNAP | S | enhancement | Port Takram `correctGeometricError`: snap depth-reconstructed world pos onto the analytic ellipsoid before the aerial-inscatter march. Fixes coarse-tile horizon inscatter color. Confirmed absent in AerialPerspective.wgsl. |
| 6 | NS-SUN-STARS-ATMOSPHERE-EXTINCTION | M | user-bug-followup (P9) | Principle-9 follow-up to the just-shipped moon extinction (B629). Machinery exists (`computeAtmosphereExtinction.js` returns per-channel transmittance for any body); apply to Sun billboard + star field so a low sun reddens and horizon stars extinguish. Reuses shipped code. |
| 7 | C6-CLOUD-STBN-TAAU | M | enhancement | Research flags this as the prerequisite to do FIRST (before the impostor epic): STBN 1/16 cloud TAAU + variance clip, PLUS in-march perspective step-growth + `maxRayDistance` far cap in ProceduralClouds.wgsl. Confirmed both still missing. The cheap orbit-LOD win. |
| 8 | NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE | M | parity-bug (diagnostic) | WebGPU Gaussian-splat command occluded by opaque globe. 2026-07-05 verify REDIRECTED root cause off multi-frustum (reproduces single-frustum + log-depth-off); real fix = measure scene-FB depth vs splat frag_depth + add WebGL-parity boundingVolume/modelMatrix on the splat command. |
| 9 | C6-LTC-AREA-LIGHTS | M | enhancement | LTC analytic rect/disk/textured area lights into the clustered-forward loop (2 LUTs + WGSL edge integral). Confirmed no area-light type today. Net-new lighting capability. |
| 10 | C6-VELOCITY-MOTION-BLUR | M | enhancement | Velocity-buffer motion blur (one WGSL pass + tile-max/neighbor-max dilation) reusing the TAA motion-vector MRT we already emit. Cheap because inputs exist. |
| 11 | C6-FLOWFIELD-WIND | M | enhancement | GPU flow-field advection (Windy / earth.nullschool-class wind/current particles): ping-pong particle-state compute + trail accumulation, near-verbatim mapbox/webgl-wind port. Confirmed no wind-particle primitive today. High visible-payoff geospatial feature. |
| 12 | DP-H47-ATMOSPHERE-RESOLVER-INCREMENT | M | debt (byte-neutral) | Build `WebGPUAtmosphereUniforms.ts` parameterized resolver + migrate Sky + Model(DynEnvMap) CPU packing onto it. Fixes a real WebGPU-internal inconsistency (user `scene.atmosphere.*` lands in some consumers, silently defaulted in others) while staying byte-identical at defaults. **Do NOT** do the increment-1 SkyAtmosphere plumb (verified regression) or the default re-tune in the same pass. |
| 13 | NEW-LOG-DEPTH-PP-SLICEC-SSR-CONTACTSHADOWS | S | debt | Thread near/far/logActive + `csm_reverseLogDepth` fold into SSR + ContactShadows depth consumers (spare UB lanes already identified). Off-by-default (no default-scene impact) but closes the Slice-B leftover. |
| 14 | C6-SSGI-DIFFUSE | L | enhancement | Screen-space diffuse GI (dynamic indirect bounce / color-bleed) marching the existing depth+normal+color MRT with TAA reproject. Our only dynamic-indirect path (we have GTAO + static IBL only). |
| 15 | CLOUD-LOD-R5-CASCADED-CLOUD-SHADOW-MAP | M | enhancement | Cascade the single Beer-Shadow-Map into 3 cascades (reuse terrain-CSM split infra) + per-cascade step reduction. Crisp near / cheap far cloud shadows across orbit-to-ground. |
| 16 | CLOUD-LOD-R7-CLOUD-LIGHTNING | M | content | Emissive scatter term in the march + flash driver uniform, riding the weather-map/precip channel + existing multi-deck storm cells. Genuine content gap for storm demos. |
| 17 | Q34-B3-MODELPIPELINECACHE-JS-TS | L | debt (filler) | Next-largest untyped renderer (4006 LOC) → .ts, co-located .d.ts pattern, tsc-clean, runtime byte-unchanged. Sample **one** batch as filler; the bulk arc is a separate dedicated sweep, not campaign fodder. |
| 18 | VEGETATION-V1-SCOPE-LOCK | S | epic scope-lock | No-runtime-code de-risk of the VEGETATION epic: pin the V1 artifact list, resolve the GPU-cull-gate decision (Pass.CESIUM_3D_TILE vs Pass.OPAQUE), confirm reusable infra live. Cheap entry; only implement V1-CORE if campaign commits to vegetation. |
| 19 | C6-FFT-OCEAN | L | epic | GPU FFT spectral ocean (spectrum→IFFT→displacement+normal compute) feeding an opt-in ocean surface primitive. Closes the deferred WATER capability gap (no wave-simulating ocean today; B630/631 is the terrain water-MASK effect). Foundational biggest-capability tail item. |
| 20 | C6-PLANAR-REFLECT-REFRACT | M | epic (gated) | Planar reflection/refraction pass + oblique near-plane clip + water/glass material. **Gated behind #19** — SKIP if FFT ocean not landed (shares water material). |
| 21 | CLOUD-VOLUMETRIC-IMPOSTOR-LOD | XL | epic (resequenced) | Octahedral cloud impostor as a third CloudRenderMode. **Resequenced per research to run AFTER #7** as an optional orbit-quality differentiator, not the sole orbit bridge. Confirmed only BILLBOARD/VOLUMETRIC exist today. |
| 22 | C6-FSR2-UPSCALE | L | epic | FSR2 temporal super-resolution (upscale-half only, no frame-gen) reusing TAA motion+depth MRT. Biggest fill-rate lever; tail because it's a render-target-resize pipeline touching every pass. |

**Consolidation note:** the three mined framings of the lake fix (`LARGE-LAKE-WATER-MASK`, `NS-LARGE-LAKE-WATER-MASK`, `WATER-LAKE-MASK-FIX-AS-PHASE1-SEED`) are ONE work item, queued once as #1. `WATER-PHASE-1-FOUNDATION-SMOKE` coalesces into #1 (the lake rasterizer IS the provider's first concrete implementation — land as one arc, not a bare skeleton).

---

## 3. Campaign Shape

**~20-22 batches, all-Opus, verify-first, trunk-only.** Per-batch contract (proven in Campaigns 3-5): premise-verify against live code + git log → implement in isolated worktree → build → acceptance probe (Playwright, Edge, WebGL-vs-WebGPU pixel diff) → off-byte-identical gate for opt-in features → adversarial parity/quality audit → auto-fix → land as `kurtyoung-dev`. Honest-partial handling; dependency-skip (#20 skips if #19 red).

- **Tier 1 — user-bug + cheapest visible (batches 1-6):** #1-6. Anchor on the lake-mask fix; ship the S dither/ellipsoid-snap wins and the P9 sun/star extinction follow-up. Fast, high-visibility, low-risk. Front-loads real-user value.
- **Tier 2 — mid enhancements + genuine parity bugs + byte-neutral debt (batches 7-13):** #7-13. The cloud STBN-TAAU orbit win (research says do before impostor), two real WebGPU parity bugs (textured-classification-zero, splat-depth), three net-new rendering features (LTC, motion blur, flow-field), the DP-H47 byte-identical resolver, and the log-depth PP slice-C leftover.
- **Tier 3 — larger enhancements + cloud content + 1 debt filler (batches 14-17):** #14-17. SSGI (L), cascaded cloud shadows, cloud lightning, one JS→TS conversion batch.
- **Tier 4 — epic scope-locks + XL tail, gated (batches 18-22):** #18-22. Cheap vegetation scope-lock FIRST (no runtime code), then FFT ocean → planar reflect (gated), then the resequenced cloud impostor + FSR2. These are the "implement only if prereqs land green" tail — any that go honest-partial get surfaced as next-campaign seeds rather than force-landed.

**Model tier:** all-Opus. Fable exhausted; the model-tier infra stays in-engine for future capacity.

---

## 4. staleToReconcile (verify-then-fix-the-doc, NOT queue)

These are premise-stale doc rows — the work shipped or the framing is overtaken. Reconcile the doc entries; do not schedule as work. **(Reconciled in batch 0, 2026-07-09 — see per-row disposition.)**

| ID | Disposition | Evidence |
|----|-------------|----------|
| BUG-POLYLINE-COLLECTION-MULTI-MATERIAL | STALE — fixed B595 (`fffb73892b`), probe GREEN | DEFERRED_WORK L5155 still lists OPEN (dated pre-fix). Close the row. |
| NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT | STALE — shipped Q15R (2026-07-04), probe IoU 1.000/0.932 | ROADMAP_AND_DEFERRED_WORK L307 still carries `(P2)` open. Repoint to SHIPPED. |
| NEW-EFFECTS-LIGHTSHAFTS-LENSGLARE | STALE — lens-glare at parity B580, god-rays shipped B581 | ROADMAP_AND_DEFERRED_WORK L1321-1322 still `Partial`. Close. |
| C6-HIGHER-ORDER-SCATTER-LUT | STALE/reframe — MultipleScattering LUT already ships in AtmosphereLUT.wgsl (Hillaire f_ms model, B429; **verified this session**) | No canonical doc row exists (campaign-queue ID only). Real remaining increment is *diagnostic*: verify shadowed/night TERRAIN consumers actually sample the existing MS-LUT; wire if not. Reframe as diagnostic, don't build a new LUT. |
| C6-SUBGROUP-COMPUTE-FINISH | STALE — FrustumCull `mainSubgroups` + PointCloudLOD `computeMainSubgroups` already wired; slot-255 debt gone | No canonical doc row exists (campaign-queue ID only). Only residual: PointCloudSort/DecoupledLookbackScan lack a subgroup bucket-scan variant (narrow leftover). `WebGPUSubgroupUtils.ts` may be unused but goal is met. Downgrade to the narrow leftover. |
| NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION | STALE/parked — log-reverse already wired (B251); goal MOOT until textured classification renders | DEFERRED_WORK L1486. Strictly downstream of queue #2 (C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO). Keep parked behind #2; reconcile only after #2 lands. |
| NEW-VECTOR3DTILE-STENCIL-2DCV-COVERAGE | BY-DESIGN — NOT a parity gap (upstream WebGL renders 0px in 2D/CV) | DEFERRED_WORK L5165 already documents "NOT a WebGL↔WebGPU parity gap"; tagged BY-DESIGN. |

## 5. deferredForever / hold (explicitly punted this campaign)

| ID | Reason |
|----|--------|
| NEW-VECTOR3DTILE-STENCIL-2DCV-COVERAGE | BY-DESIGN — NOT a parity gap (upstream WebGL renders 0px in 2D/CV). Fix only if a 2D/CV classifier consumer ever needs it. |
| NEW-GLOBE-FARZOOM-DRAPE-BRIGHTNESS-TUNE | Sub-perceptual (0.033% of crop), high regression risk, documented intentional structural GLSL-per-vertex vs WGSL-per-fragment divergence. Low payoff. |
| Q34-ARC-BULK-REMAINDER | 25 untyped renderers / ~34.1K LOC. Pure mechanical hygiene — run as its own dedicated sweep, NOT as bug/epic campaign filler (sample only 1 batch, #17). |
| VEGETATION-V1-CORE | XL net-new (scatter compute pass + deterministic CPU twin). Stays behind the parity tail; only after #18 scope-lock and only if the campaign commits to vegetation. |
| NEW-MULTIBODY-ATMOSPHERE | L epic (Mars/airless-body atmosphere parameterization). Genuine future feature; no shipped code. Defer to a dedicated celestial-bodies arc. |
| NS-R2A-CROSS-SOURCE-ATTR-JOIN | M novel — needs a per-frame driver + source-tag channel + imagery per-texel ID channel (none plumbed). Defer until the R-2 feature-ID substrate has a consumer demand. |
| CLOUD-LOD-R9-PLANET-SCALE-CLOUD-TILING | XL — hierarchical quadtree cloud tiling; largest cloud gap. Defer (it's the substrate an orbit impostor would eventually render from; not needed until impostor lands). |
| CLOUD-LOD-R8-PRECIPITATION-COUPLING | L content — rain shafts + ground wetness. Genuine gap but schedule after R5/R7 land; hold for a follow-on cloud-content arc. |
| Q31-CUSTOMSHADER-SLICE-C-VARYINGS | (Added 2026-07-06 prior-campaign sweep) PARKED — blocked on the interstage `@location` budget (TAA occupies locations 8-9) AND the exhausted `ShaderDefine` bitmask; prerequisite = a varying-budget scheme. DEFERRED_WORK ~L1293. |
| C4-ATMO-DERIVED-LIGHTING-LUT | (Added 2026-07-06 sweep) PARKED — original body-swap impossible (Bruneton LUTs are GPU-only, no CPU readback); re-scoped M GPU-side task held until C7-DPH47-ATMOSPHERE-RESOLVER lands and clarifies the seam. DEFERRED_WORK ~L151. |
| C4-CELESTIAL-HIRES-MOON | (Added 2026-07-06 sweep) WONT-DO-AS-SCOPED — conflicts with the byte-identical/parity charter + asset-license blocker. DEFERRED_WORK ~L5167. |

---

## 6. Counts

- OPEN rows across all miners: **33** (incl. 3 duplicate framings of the lake fix → 1 work item; ~31 distinct).
- LIKELY-STALE + BY-DESIGN to reconcile: **7**.
- Queue length: **22** (OPEN only; XL tail gated).
