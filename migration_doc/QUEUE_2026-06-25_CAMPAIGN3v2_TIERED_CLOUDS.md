# Campaign 3 v2 — Tiered Volumetric Clouds (3D-texture core)

**Execution-ready packed plan.** Produced 2026-06-25 by the `campaign3v2-cloud-replan`
workflow (run `wf_825ad58f-3e8`): 5 architects designed each workstream grounded in
the live code, a lead synthesized + dependency-ordered them, and an adversarial
principal engineer reviewed. Supersedes the cloud batches (W6–W14) of
[QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md](QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md);
see [CLOUD_RENDERING_STRATEGY.md](CLOUD_RENDERING_STRATEGY.md) for the why + research.

> **Status:** plan ratified by the workflow; NOT yet executed. W1–W5 (Batches
> 391–395) are the frozen regression baseline. Execute top-to-bottom, one atomic
> probe-verified commit per batch.

---

I now have complete ground truth on the master byte-table and the full W6-W14/P1-P11 numbering. I have everything needed to produce the merged, dependency-ordered master plan. Here it is.

---

# Campaign 3 v2 — Tiered Volumetric Clouds (3D-texture core)

**Master execution plan — merged from 5 workstream designs, dependency-ordered, byte-locked, probe-disciplined.**
Lead rendering architect synthesis. A future session runs this batch-by-batch, top to bottom.

---

## 0. Ground truth (verified against the live code, 2026-06-25)

| Fact | Source of truth |
|---|---|
| `CLOUD_UNIFORM_FLOATS = 96` (struct ends at `aerialColor`@92-94 + `_padD`@95) | `WebGPUProceduralCloudRenderer.ts:30`; `ProceduralClouds.wgsl:19-72` |
| **W1–W5 are SHIPPED and frozen.** They are the regression baseline, not work items. | dual-lobe phase / ambient / TOD sun / aerial / adaptive march all live in `ProceduralClouds.wgsl` |
| Live density: `fbmNoise` (5-octave value noise) + `worleyF1` (27-tap) in `cloudDensity`; `cloudBaseDensity` is the W5 skip oracle (fbm only, **no Worley**, conservative `base ≥ full`) | `ProceduralClouds.wgsl` `cloudDensity`/`cloudBaseDensity` |
| Reserved lanes available **in place** (zero-filled today): **74, 75** (`_pad4b`/`_pad4c`), **76-79** (`_padA` vec4) | `ProceduralClouds.wgsl:61-63`; packer zero-fill `WebGPUProceduralCloudRenderer.ts:479-484` |
| **Master byte-table assignment (SOLE OWNER, PACKED queue):** 74→`curlAmplitude` (W9), 75→`curlFrequency` (W9), 76→`frameCounter` (W8). Final target `CLOUD_UNIFORM_FLOATS = 108`. | `QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md:54-55, 67` |
| Bake template (3D storage texture + compute + once-at-init): `texture_storage_3d<…,write>` + `textureStore` + `getOrCreateSync` compute pipeline + lazy `_ensureResources` + `QUALITY_RESOLUTIONS` band table | `WebGPUVolumetricFogRenderer.ts`, `WebGPUVolumetricFogResources.ts` |
| History ping-pong template: `WebGPUParityManager` slot + `_skipNextBlend` + `resize`/`resetHistory`; IGN formula in `WebGPUTAAEffect.ignJitter` | `WebGPUTAAEffect.ts`, `WebGPUParityManager.ts` |
| Probe harness: `webgpu-error-gate.mjs`, sun-control via `v.useDefaultRenderLoop=false; s.render(jd)`, A/B via git-stash-WGSL + `TAG=`, GPU-sync via `queue.onSubmittedWorkDone()` | `Tools/visual-regression/probe-cloud-perf.mjs` |
| `resolveCloudQuality` returns ONLY `{maxSteps, lightSteps}` today | `WebGPUProceduralCloudRenderer.ts:299-325` |
| Default is already cheap: `globe.showProceduralClouds = false`; `cloudVolumetricQuality = "auto"` | `Globe.js`, `WebGPUProceduralCloudRenderer.ts` doc header |

---

## 1. The five contradictions, resolved up front (binding decisions)

These are the conflicts across the workstreams. The lead's rulings here are load-bearing for every batch below.

### D-1 — What is "Tier 0"? (WS2 vs WS1)
**RULING (WS2 wins, WS1 corrected):** Tier 0 = **the cloud pass does not run** (= today's default-off WebGL-parity path). It is NOT "the live-noise march at low steps." The live-noise march is retained as the **`noiseSource = LIVE` density branch** (Tier 1-low and the self-healing fallback). This is structural default-preservation: the default path never reaches the tier resolver, never bakes, never allocates a 3D texture.

### D-2 — The `noiseSource`/`qualityFlags` ↔ float-74 collision (WS1 + WS2 vs master table) — **THE central byte-lock decision**
WS1 wants `noiseSource`@74; WS2 wants `qualityFlags`@74; the master table owns 74→`curlAmplitude`(W9), 75→`curlFrequency`(W9), 76→`frameCounter`(W8).
**RULING — one ratified allocation for the whole campaign (replaces every workstream's ad-hoc grab):**

| Float | Field | Batch that claims it | Was |
|---|---|---|---|
| 74 | `qualityFlags` (bitfield: noiseSource, halfRes, temporal, jitter, octaves, profile-on) | **V1** | `_pad4b` |
| 75 | `curlAmplitude` | **V8** (curl) | `_pad4c` |
| 76 | `frameCounter` | **V6** (temporal/jitter) | `_padA.x` |
| 77 | `curlFrequency` | **V8** (curl) | `_padA.y` |
| 78 | `lightSampleScale` | **V5** (lighting tiers) | `_padA.z` |
| 79 | `_padA.w` reserve | — | `_padA.w` |

**`noiseSource` is NOT its own float — it is bit 0 of `qualityFlags`@74.** This frees lane 75 for `curlAmplitude` exactly as the master table intended, so W9's curl lanes survive byte-compatibly. `curlFrequency` moves 75→77 (still in the reserved `_padA` region, no struct growth). **`CLOUD_UNIFORM_FLOATS` stays 96 through the entire reconstruction+lighting arc.** The struct grows only when the morphology/shape arc appends genuinely new vec4 slots (V11/V12 → 100/104/108, matching the master table's 108 target).

This ruling **must be ratified into the PACKED master table before V1 lands** (update lines 54-55, 67). It is the single cross-arc byte-lock change. Flag it to the cloud-internals architect at V1.

### D-3 — Does the 3D-texture core gate the lighting/morphology work? (WS4 vs WS1/WS5)
**RULING (WS4's correction is accepted, with one carve-out):** The energy-conserving in-scatter, multi-scatter octaves, powder, remap/coverage/erosion, and per-genus height-gradient **do NOT depend on the texture core** — they operate on `lightMarch` optical depth and `cloudDensity`'s scalar output, which work on live noise today. **However**, the prompt's explicit sequencing directive is "3D-noise-texture core lands FIRST." We honor the prompt's ordering as the *primary spine* because (a) the texture core is the highest-leverage change (quality **and** perf), (b) it is the highest-regression-risk batch (keystone), and (c) sequencing it first means every later batch's A/B baseline already includes the baked core, so a lighting regression can't hide behind a noise-representation shift. **Only curl-advection (V8) has a real partial dependency** — it ships a live-path version but earns its full keep on the baked detail texture (surfaced per Principle 9).

### D-4 — One density branch or two? (preserving W5)
**RULING:** `cloudDensity` and `cloudBaseDensity` both branch on `noiseSource` (qualityFlags bit 0). The BAKED branch of `cloudBaseDensity` samples **only the shape R channel** (no detail erosion), preserving W5's conservative `base ≥ full` invariant exactly as the live oracle does. The live `fbmNoise`/`worleyF1` path is **kept as the `else` branch** (Principle 7 — it is the fallback, never removed).

### D-5 — Tier resolver: one struct, owned by one file
**RULING:** A single `WebGPUCloudTierPresets.ts` owns the `CloudTierPreset` struct and the enum→preset table (merging WS2's `CloudQualityPreset`, WS3's `CloudTierPreset`, WS4's `CloudTierPreset`, WS5's `CloudTierPreset` into ONE). `resolveCloudQuality` keeps its `{maxSteps,lightSteps}` signature for back-compat and gains a sibling `resolveCloudPreset` returning the full struct. The public dial stays `globe.cloudVolumetricQuality` (`low|medium|high|auto`) — **no new public API**; `low→T1, medium→T2, high→T3`, default-off→T0.

**Unified tier table (the single source of truth for all batches):**

| Field | T0 Baseline | T1 Vol-Low | T2 Vol-High | T3 Cinematic |
|---|---|---|---|---|
| **pass runs?** | **NO (default)** | yes | yes | yes |
| primarySteps | — | 32 | 96 | 128 |
| lightSteps | — | 4 | 8 | 16 |
| noiseSource | — | BAKED (low band) | BAKED (full) | BAKED (full) |
| renderResScale | — | 0.5 | 0.5 | 1.0 |
| temporalEnabled | — | true (1/16) | true (1/8 denoised) | false |
| jitterEnabled | — | true | true | true |
| lightSampleScale | — | 0.5 | 0.5 | 1.0 |
| multiScatterOctaves | — | 2 | 3 | 3 |
| powderStrength / isotropicFloor / ambientFloor | — | 0 / 0 / 0 | 0.4 / 0.02 / 0.05 | 0.7 / 0.04 / 0.08 |
| curlAmplitude | — | 0 | on | on |
| farRepresentation | — | impostor | impostor | volumetric-limb |

Power-user escape hatch (`cloudQuality !== 64`): forces `noiseSource=LIVE`, `renderResScale=1`, `temporalEnabled=false`, custom `primarySteps`, derived `lightSteps`, neutral lighting dials. Hand-tuned counts bypass the reconstruction stack — preserves today's power-user behavior exactly.

---

## 2. Old-batch reconciliation (survive / change / drop)

| Old batch | Verdict | New batch | Notes |
|---|---|---|---|
| W1–W5 | **FROZEN baseline** | — | Regression target. Every probe re-asserts their metrics. |
| (none — new) | **NEW** | **V0** | P1 atmosphere-LUT fix pulled to front (so probes assert zero device errors). |
| (none — new) | **NEW** | **V1** | Tier-preset struct + `qualityFlags` lane. Inert spine. |
| (none — new) | **NEW** | **V2** | 3D-noise bake (inert, bound, `noiseSource=0`). |
| (none — new) | **NEW** | **V3** | Switch density core to baked textures (keystone). |
| W6 | **SURVIVE, tier-gated** | **V9** | Half-res + log-space bilateral upscale; gated by `renderResScale`. |
| W7 | **SURVIVE, tier-gated** | **V10** | Temporal reproject; gated by `temporalEnabled`. |
| W8 | **SURVIVE, fold into V6** | **V6** | IGN jitter; `frameCounter@76`. Sequenced *before* temporal (V10 accumulates V6's decorrelated samples). |
| W9 | **CHANGE** | **V8** | No longer standalone live-Worley advect; becomes curl-offset-before-detail-fetch. Live path now, full payoff on baked detail. |
| W10 | **SURVIVE, change source** | **V12** | Per-genus height-gradient feeds the baked-shape remap. |
| W11 | **SURVIVE, defer to T2+** | **V13** | Multi-deck; keep `texture_2d_array` foresight. |
| W12 | **SURVIVE** | **V14** | Cloud shadows reuse baked density (single source of truth). |
| W13 | **SURVIVE** | **V15** | God-rays from FS transmittance (unchanged by core). |
| W14 | **SURVIVE** | **V16** | Precipitation CPU gate (independent). |
| P1 | **SURVIVE, pull EARLIEST** | **V0** | See above. |
| P2–P11 | **SURVIVE as parity tail** | **V17–V26** | Independent of clouds; run after the cloud arc. |
| (research-forced) | **NEW** | **V4, V5, V7, V11** | density-morphology remap (V4), lighting upgrade (V5), powder/floor (V7), per-genus profile (V11/V12). |

**Net-new work the research forces that the old queue lacked:** V2 (bake), V1 (tier struct), V4 (remap pipeline), V5+V7 (energy-conserving in-scatter + MS octaves + powder), log-space upscale (folded into V9), far-field impostor (V11′ in V17 region — surfaced as deferred).

---

## 3. The master batch-ordered sequence

**Ordering law (per the prompt):**
`V0 (clean probes)` → `V1+V2 (tier scaffold + 3D-noise core — everything gates on them)` → `V3 (baked density core, keystone)` → `V4 (morphology remap)` → `V5+V6+V7 (lighting + jitter)` → `V8 (curl)` → `V9+V10 (reconstruction: half-res/upscale, temporal)` → `V11+V12+V13 (shape: profiles/decks)` → `V14+V15+V16 (scene integration)` → `V17 (far-field/impostor)` → `V18+ (P parity tail)`.

Per-batch discipline (applies to **every** batch): one atomic commit; `npx gulp build` (edit `.wgsl`/`.ts` only — the `.js` shader companion regenerates, never edit it); WebGPU-only Playwright probe on **Edge** at `:8080`; **READ the output PNG**; perf/preservation batches A/B vs the prior build (git-stash WGSL/TS + `TAG=`, mean-abs luma + `queue.onSubmittedWorkDone()`-synced frame time); quality batches measure the intended delta. After V0, error gates assert **zero** device errors (no Atmosphere-LUT filter).

---

### V0 — Fix the SkyAtmosphere-LUT device error (was P1; pulled to front)
- **Goal:** Eliminate the `"SkyAtmosphere LUT dispatch"` invalid-command-buffer error so every later cloud probe asserts **zero** device errors instead of filtering.
- **Files:** `WebGPUAtmosphereLUT.ts` (`dispatchAtmosphereExtendedLUT`), `WebGPUPerformanceManager.ts` (`dispatchCompute` — add `bindGroupLayouts?` pass-through); drop the `/Atmosphere ?LUT|SkyAtmosphere/` filters in existing probes; NEW `Tools/visual-regression/probe-atmo-lut-no-device-error.mjs`.
- **Changes (JS-only, no WGSL regen):** thread explicit `[emptyGroup0BGL, lut.extendedBindGroupLayout]` into `getOrCreatePipeline` for `computeMultipleScattering`/`computeIrradiance` so `layout:"auto"` stops deriving the smaller subset layout (binding 4 vs 5 mismatch). Cache the empty group-0 BGL on `lut`.
- **Tier-gate:** N/A (fixes an existing error; no default change).
- **Probe:** arm error gate with **no** atmosphere filter; step the clock so the sun moves (forces extended dispatch); render ~10 frames. PASS: `gate.errors.length === 0`. READ `atmo-lut-sky.png` — sky still blue with limb glow.
- **W1-W5 risk:** none.

---

### V1 — Tier-preset struct + `qualityFlags` lane (inert spine; zero pixel change)
- **Goal:** Land the single `CloudTierPreset` struct + resolver and the `qualityFlags`@74 uniform lane. Every preset field that no landed feature consumes resolves to today's behavior → byte-identical at every tier. This is the spine all later batches hang on.
- **Files:** NEW `packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts` (the `CloudTierPreset` interface + `CLOUD_TIER_PRESETS` table from §1 D-5 + `resolveCloudPreset`); EDIT `WebGPUProceduralCloudRenderer.ts` (call resolver; pack `qualityFlags`); EDIT `ProceduralClouds.wgsl` (rename `_pad4b`@74 → `qualityFlags`, declare the bit consts — read by no shader path yet); EDIT `Globe.js` (JSDoc only); NEW `Tools/visual-regression/probe-cloud-tier-resolver.mjs`; **EDIT `QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md` master byte-table (ratify D-2 — the one cross-arc byte-lock change).**
- **Changes:** `resolveCloudPreset` subsumes the current `resolveCloudQuality` logic (escape hatch + `low/medium/high` + `auto` altitude bands). For V1, the resolved `(maxSteps,lightSteps)` stays the OLD table (`low→24/3, medium→48/4, high→96/8`) for image-identity — the new 32/96/128 counts land per-feature in later batches behind their own A/B. Pack `qualityFlags`@74 bits: `bit0=noiseSource, bit1=halfRes, bit2=temporal, bit3=jitter, bits4-6=octaves, bit7=profileOn`. Every bit resolves to today's behavior this batch (octaves=3 already matches the hardcoded `i<3` loop; the rest are read by no shader yet → inert).
- **Tier-gate:** This batch *is* the gate. Default-off → resolver never reached. Enabled `auto` → same `(maxSteps,lightSteps)` as before; `qualityFlags` read by no landed path → byte-identical.
- **Probe:** `probe-cloud-tier-resolver.mjs` — assert `resolveCloudPreset` returns `low→(24,3)`, `medium→(48,4)`, `high→(96,8)`, escape-hatch (`cloudQuality=100`)→`primarySteps=100`; then capture one `auto` cloud frame and A/B vs the pre-batch build: **mean-abs luma mismatch must be 0.00%** (pure refactor).
- **W1-W5 risk: HIGH** (every cloud renders through the dial). Guard: the 0.00% identity A/B + the escape-hatch test.

---

### V2 — Bake the 3D Perlin-Worley noise textures; bind them inert (`noiseSource=0`)
- **Goal:** Bake the low-freq shape texture (128³ RGBA8: Perlin-Worley billow in R, Worley fBm at increasing freq in GBA) and the high-freq detail texture (32³ RGBA8: 3-channel Worley) **once at init** into tileable `texture_storage_3d<rgba8unorm,write>`. Bind into the cloud BGL but keep `noiseSource=0` so `cloudDensity` still uses live noise → byte-identical. Pure infrastructure, A/B-provable.
- **Files:** NEW `packages/engine/Source/Shaders/WebGPU/Compute/CloudNoiseBake.wgsl` (`@workgroup_size(4,4,4)`, entry points `bakeShape`/`bakeDetail`, periodic Perlin-Worley + Worley-fBm, domain `mod res` so trilinear wraps); NEW `packages/engine/Source/Renderer/WebGPU/WebGPUCloudNoiseResources.ts` (model on `WebGPUVolumetricFogResources.ts` — allocate both 3D textures with `STORAGE_BINDING|TEXTURE_BINDING`, build compute pipelines via `context.webgpuComputePipelineCache.getOrCreateSync`, dispatch once, band res off `preset.noiseSource`: low=64³/16³, full=128³/32³; one `linear`+`repeat` 3D sampler; return `{shapeTex,shapeView,detailTex,detailView,sampler3d,baked}`); EDIT `WebGPUProceduralCloudRenderer.ts` (`CloudCache` gains `noise`/`noiseSampler`/`noiseBaked`; extend BGL with bindings **6** (`texture` 3d shape), **7** (`texture` 3d detail), **8** (`sampler`); 1×1×1 white 3D fallback view bound until the real bake runs — mirror `ensureWeatherView` fallback; `ensureNoiseBaked` helper, **not yet dispatched** — `noiseSource` forced 0); EDIT `ProceduralClouds.wgsl` (declare bindings 6/7/8; a guarded-out `_unused` reference so the bindings validate without sampling); NEW `Tools/visual-regression/probe-cloud-noisebake.mjs`; EDIT `FEATURE_INVENTORY.md`, `CLOUD_RENDERING_STRATEGY.md` (adopt the 3D-texture-core decision).
- **Module docstring (CLAUDE.md Principle 7):** "What's shipped: bake + bind. No-op until V3 samples it. The shape/detail textures + composite-into-density are V3 deliverables." — so the scaffolding isn't mistaken for dead code.
- **Tier-gate:** bake fires only for `noiseSource != LIVE` (T1+); Tier 0 never allocates. Sampling not wired → zero visual change at every tier.
- **Probe:** `probe-cloud-noisebake.mjs` — A/B vs pre-V2 build: **≤0/255 mean-abs luma mismatch** (proves inert) AND zero device errors (proves the new BGL bindings + bake dispatch are clean). Assert `cache.noiseBaked === true` via a debug accessor; optionally dump a 2D slice of `shapeTex` via a debug FS to READ that the Perlin-Worley billows are present (not flat). READ both PNGs — visually identical.
- **W1-W5 risk: LOW** (additive bindings; live march still runs). Guard: identity A/B.

---

### V3 — Switch the density core to baked textures (KEYSTONE — highest leverage AND highest risk)
- **Goal:** Replace the live `fbmNoise`/`worleyF1` evals in `cloudDensity` and the `cloudBaseDensity` oracle with `textureSampleLevel` of the shape (R = Nubis remap of billow by GBA Worley fBm) + detail textures, while preserving W1 tone-map, W2 ambient, W3 sun color, W4 aerial, W5 skip semantics. Faster **and** better. Dispatch the bake lazily now.
- **Files:** EDIT `ProceduralClouds.wgsl` (the BAKED branches); EDIT `WebGPUProceduralCloudRenderer.ts` (flip `ensureNoiseBaked` gate on when `noiseSource>0.5`; `resolveCloudPreset` now packs `noiseSource` bit; on bake failure force `noiseSource=0` → self-healing LIVE fallback); NEW `Tools/visual-regression/probe-cloud-noisecore.mjs`; EDIT `FEATURE_INVENTORY.md`.
- **Changes (WGSL):**
  - `cloudDensity` BAKED branch: `let shape = textureSampleLevel(shapeTex, noiseSampler, fract(samplePos*shapeScale), 0.0); let wfbm = shape.g*0.625 + shape.b*0.25 + shape.a*0.125; var density = remap(shape.r, wfbm-1.0, 1.0, 0.0, 1.0);` then the **existing** coverage `smoothstep(1-effectiveCoverage,1,density)` + height gradient; detail erosion via the 32³ detail texture (`density = remap(density, detail.r*0.6*(1-hf), 1.0, 0.0, 1.0)` — **mean-preserving, subtractive-only**: cannot ADD density, so it cannot reproduce the W5-era over-densification). LIVE path kept verbatim as the `else`.
  - `cloudBaseDensity` (W5 oracle) BAKED branch: sample **only shape.r** (no detail) → conservative `base ≥ full` holds, smooth — exactly the W5 contract (D-4).
  - `lightMarch` keeps calling `cloudDensity` (now cheap).
- **Tier-gate:** `noiseSource` from preset → low band binds 64³/16³, full binds 128³/32³. Tier 0 unaffected. Escape hatch → LIVE.
- **Probe (the most rigorous in the campaign):** `probe-cloud-noisecore.mjs`, exact `probe-cloud-perf.mjs` scene (LON -95, LAT 39, ALT 800, coverage 0.35, density 0.7, quality 128, black sky, sun off, `render(jd)`). Capture **baked** vs **live-noise prior build** (git-stash `ProceduralClouds.wgsl`, rebuild, capture). PASS: mean-abs luma ≤ ~6% (representation change shifts texture — quality-bounded preservation, NOT byte-identical), cloud-cell count ±10%, **AND GPU-synced frame time strictly faster**. **Re-assert each W1-W5 metric** against its original threshold: W1 silver-lining rim ratio, W2 shadow p10 lift, W3 R/B warm ratio, W4 aerial recede, W5 no-truncation skip. READ both PNGs — billowy cauliflower (not lumpy value-noise grid), no banding, no thinned tops, no over-densify.
- **W1-W5 risk: HIGHEST.** This is the keystone. Guard: the full W1-W5 metric re-run, not a single luma diff.

---

### V4 — Density morphology: remap/coverage/erosion pipeline (mean-preserving)
- **Goal:** Upgrade `cloudDensity` shaping to the Nubis remap pipeline so detail carving is **mean-preserving** (fixes high-coverage saturation/lumpiness). Coverage via `remap`; erosion via `remap(density, erosionLo, 1, 0, 1)` so bulk mass is preserved.
- **Files:** EDIT `ProceduralClouds.wgsl` (add `remap` helper if not added in V3; rewrite shaping in **both** `cloudDensity` AND `cloudBaseDensity` — oracle keeps coverage remap only, no erosion, so `base ≥ full` holds); EDIT `WebGPUProceduralCloudRenderer.ts` (pack `erosionStrength` — reuse reserve **float 79**, no growth); NEW `Tools/visual-regression/probe-cloud-remap.mjs`; EDIT `CLOUD_RENDERING_STRATEGY.md`.
- **Neutral note:** `erosionStrength` packed at the old `0.18` magnitude reproduces carving but mean-preserving → A/B shows *more* bulk density at high coverage (the intended fix), silhouette unchanged at low coverage.
- **Tier-gate:** `erosionStrength` enters the preset table (low=0.10 fibrous, high=0.18 puffy). Default off.
- **Probe:** `probe-cloud-remap.mjs` — A/B at coverage 0.4 (silhouette ≤2% unchanged) and 0.85 (mean cloud luma *rises*, deck reads solid not lumpy-with-holes). READ before/after at both coverages.
- **W1-W5 risk: MEDIUM** (touches the W5-coupled shaping region). Guard: oracle keeps `base ≥ full` (coverage-only remap); A/B at low coverage proves silhouette preserved.

---

### V5 — Energy-conserving analytic in-scatter + multi-scatter octaves (geometric decay)
- **Goal:** Replace per-step Beer accumulation with the analytic integral `S_int=(S − S·exp(−σ_e·ds))/σ_e` (removes step-count banding, near-free — the foundation low-step tiers need), and upgrade `multiScatterLight` from the current `atten*=0.5` form to proper Frostbite geometric decay `(a^i, b^i, c^i)` with phase folded per-octave, reusing the single light march.
- **Files:** EDIT `ProceduralClouds.wgsl` (accumulation block + `multiScatterLight`); EDIT `WebGPUProceduralCloudRenderer.ts` (pack `msScatterDecay`/`msExtinctionDecay`/`msPhaseDecay` + `lightSampleScale`@78 — reuse reserve, no growth); NEW `Tools/visual-regression/probe-cloud-lighting.mjs`; EDIT `CLOUD_RENDERING_STRATEGY.md`.
- **Changes:** `let sigmaE = max(density*absorptionCoeff,1e-6); let segT = exp(-sigmaE*fineStep); let S = cloudColor*sunLightColor*scatteredLight + ambient; weightedColor += transmittance * ((S - S*segT)/sigmaE) * sigmaE; transmittance *= segT;` (algebraically identical to the current `(1-segT)·T·S` at flat S → neutral byte-identical, but exposes the true integral form). `multiScatterLight` reads octave count from `qualityFlags` bits 4-6; `lightMarch` scales `steps` by `lightSampleScale`.
- **Tier-gate:** octaves T1=2 / T2,T3=3; `lightSampleScale` T1,T2=0.5 / T3=1.0. The analytic integration applies to ALL tiers (image-preserving at full octaves).
- **Probe:** `probe-cloud-lighting.mjs` — (a) high steps: A/B ≤2% at T3 (integration ≈ old sum when dense, MS=3 matches old `i<3`); (b) low steps (`cloudQuality=32`): banding metric (adjacent-pixel luma steps inside the cloud body) drops ≥40% vs pre-V5; deep-interior median luma rises (more MS), edge rim unchanged ±3%. READ before/after — concentric banding dissolves; interiors soft grey not black.
- **W1-W5 risk: MEDIUM** (rewrites the accumulation W1 tone-maps). Guard: re-assert W1 silver-lining + W2 shadow-lift; tone-map tail untouched.

---

### V6 — IGN ray-start jitter + dither (was W8; `frameCounter@76`; before temporal)
- **Goal:** Offset each pixel's march start `t` by an animated per-pixel IGN sequence so the low-step march stops banding and successive frames sample decorrelated sub-positions (the non-redundant samples V10 accumulates). Sequenced **before** temporal so jitter is standalone-correct first.
- **Files:** EDIT `ProceduralClouds.wgsl` (add `ign(p,frame)` — the `WebGPUTAAEffect.ignJitter` Jimenez formula with animated `frame%64` offset; jitter the W5 coarse pointer `t = tStart + jitter*coarseStep`; optional `±1/255` density dither); EDIT `WebGPUProceduralCloudRenderer.ts` (rename `_padA.x`@76 → `frameCounter`; `CloudCache.frameCounter`; replace the `data[76]=0` write with `(cache.frameCounter = (cache.frameCounter+1)>>>0)`); NEW `Tools/visual-regression/probe-cloud-banding.mjs`; EDIT `FEATURE_INVENTORY.md`.
- **Uniform:** the ONE `CloudUniforms` write change this batch — `frameCounter@76`, in-place rename (vec4 footprint preserved, stays 96).
- **Tier-gate:** `jitterEnabled` from preset. Cinematic T3 can disable temporal jitter for deterministic full-res frames; jitter ≤ 1 coarse step (else sparkle). Default off.
- **Probe:** `probe-cloud-banding.mjs` — `cloudQuality=24`, static camera, single frame. Adjacent-pixel jumps >12/255 in smooth regions drop ≥50% vs pre-batch no-jitter. READ before/after — concentric contour bands dissolve into smooth/noisy gradient.
- **W1-W5 risk: LOW** (only jitters the W5 march start). Guard: single-static-frame banding metric; accepts added high-freq noise (V10 resolves it).

---

### V7 — Sun-side powder + isotropic floor + ambient floor (energy completeness)
- **Goal:** `cosTheta`-gated powder (sun-facing only), an isotropic scattering floor (interiors never reach 0), and an ambient energy floor folded through V5's integral (no double-count).
- **Files:** EDIT `ProceduralClouds.wgsl` (powder gating at the `multiScatterLight` call; `max(lum, isotropicFloor)`; ambient floor in S); EDIT `WebGPUProceduralCloudRenderer.ts` (**struct grows 96→100** — append vec4 @96-99: `powderStrength`@96, `isotropicFloor`@97, `ambientFloor`@98, `_padE`@99; bump `CLOUD_UNIFORM_FLOATS`); NEW `Tools/visual-regression/probe-cloud-powder.mjs`; EDIT `CLOUD_RENDERING_STRATEGY.md`.
- **Changes:** `let powderK = cloud.powderStrength * clamp(cosTheta*0.5+0.5, 0, 1);` (`cosTheta = dot(rayDir,sunDir)` exists). With `powderStrength=0` → `powderK=0` → `mix(beer, beer*powder, 0) = beer` → neutral byte-identical. floors=0 neutral.
- **Tier-gate:** all three packed per-tier (T1=0/0/0 → neutral = V5 state; T2/T3 progressively enable). Default off.
- **Probe:** `probe-cloud-powder.mjs` — toward-sun vs away-sun: powder darkens toward-sun nub interiors; isotropic floor keeps global min cloud luma >0 (no pure-black inside silhouette). A/B neutral pass (all floors 0) ≤2% vs pre-V7. READ toward/away PNGs.
- **W1-W5 risk: MEDIUM** (struct growth 96→100; powder inside V5's `multiScatterLight`). Guard: vec4 append is clean (96÷4); neutral A/B; field-by-field byte-offset verify.

---

### V8 — Curl-noise advection (was W9; live-path now, full payoff on baked detail)
- **Goal:** Offset the erosion sample position by a divergence-free curl-noise field (height-decreasing strength) so edges turn turbulent/wispy. On the baked detail texture this *hides trilinear artifacts* (lets the 32³ stay small).
- **Files:** EDIT `ProceduralClouds.wgsl` (add `curlNoise(p)` from central differences of `valueNoise` — 3 taps; apply in `cloudDensity` only, NOT the oracle, so `base ≥ full` holds); EDIT `WebGPUProceduralCloudRenderer.ts` (pack `curlAmplitude`@75, `curlFrequency`@77 — the D-2 reconciled lanes, no growth); NEW `Tools/visual-regression/probe-cloud-curl.mjs`; EDIT `FEATURE_INVENTORY.md`.
- **Changes:** `let curl = curlNoise(noiseUVW*cloud.curlFrequency)*cloud.curlAmplitude*(1-heightFraction); let detail = textureSampleLevel(detailTex, noiseSampler, fract((noiseUVW+curl)*detailScale), 0.0);` `curlAmplitude=0` → neutral.
- **Principle 9 surfacing:** on the live `worleyF1` path curl gives a modest edge win (worleyF1 is C0-continuous, no seams to hide); the *full* payoff is on the baked detail texture (V3) — already landed by this point in the sequence, so V8 earns its keep immediately. Strategy doc records `curlAmplitude` re-tuning when needed.
- **Tier-gate:** `curlAmplitude` T1=0 (skip 3 taps) / T2,T3=on. Default off.
- **Probe:** `probe-cloud-curl.mjs` — close camera on a dense edge: high-frequency energy along the cloud/sky silhouette rises ≥20% vs pre-V8; **interior mean luma drift ≤3%** (edges perturbed, not bulk). READ before/after — feathered edges, not melted.
- **W1-W5 risk: LOW** (edge-only). Guard: the ≤3% interior bulk-drift clamp.

---

### V9 — Half-res cloud target + log-space joint-bilateral upscale (was W6; tier-gated)
- **Goal:** Raymarch into a half-res `rgba16float` MRT (premultiplied scatter + transmittance + cloud-front depth), then a full-res joint-bilateral upscale weighted by scene-depth similarity, **blending transmittance in log/optical-depth space** (kills the edge dark-fringe). ~4× ray budget. Gated by `renderResScale`.
- **Files:** EDIT `ProceduralClouds.wgsl` (FS returns MRT struct `{@location(0) scatter (premult rgb + cloudAlpha), @location(1) frontDepth}` under a `RENDER_TO_HALF` path; keep the W1 tone-map + W4 haze **byte-identical** — only the final composite moves out; full-res composite kept for T3); NEW `packages/engine/Source/Shaders/WebGPU/Environment/CloudUpscale.wgsl` (4-tap joint-bilateral, depth-similarity weight, log-space transmittance blend); EDIT `WebGPUProceduralCloudRenderer.ts` (`CloudCache` gains half-res scatter/depth textures + `upscalePipeline`/`upscaleBGL`/`UpscaleUniforms`; resize guard mirroring `WebGPUTAAEffect._allocateHistoryTextures`; change march pipeline `fragment.targets` to the two MRT formats; render into a half-res pass then full-res upscale into `outputView`); NEW `Tools/visual-regression/probe-cloud-halfres.mjs`; EDIT `FEATURE_INVENTORY.md`, `CAMPAIGN3_PROGRESS.md`.
- **Recommended single-path simplification (WS3):** always go offscreen+upscale; `renderResScale=1` (T3) just means the "half" target is full-size and the bilateral degenerates to a copy — one code path, T3 pays one extra full-res blit.
- **Tier-gate:** `renderResScale==0.5` (T1/T2) → half-res; `==1.0` (T3) → full-res passthrough. Default off.
- **Probe:** `probe-cloud-halfres.mjs` — A/B half-res+bilateral vs full-res reference: whole-frame mean mismatch ≤3%; **edge test** — max single-step luma gradient at a cloud/sky boundary ≥80% of reference (no halo), no >2px intermediate-luma ring (proves log-space depth-bilateral, not blur). READ — crisp rim against sky and terrain horizon, no checkerboard, no dark fringe.
- **W1-W5 risk: MEDIUM** (FS return + composite stage). Guard: T3 full-res path = untouched W1-W5 composite, used as the reference; premultiplied + log-space blend prevent the dark-fringe regression.

---

### V10 — Temporal reprojection + accumulation (was W7; tier-gated)
- **Goal:** Reproject the prior half-res buffer by `previousViewProjection`, accumulate this frame's V6-jittered samples, reject disocclusion/ghosting via neighborhood AABB clip → the half-res low-step march converges to full quality over ~16 frames. Lets T1/T2 halve primary steps near-free.
- **Files:** EDIT `WebGPUProceduralCloudRenderer.ts` (half-res history ping-pong via `WebGPUParityManager` slot `"cloud-history"`, mirror `WebGPUTAAEffect`; `ReprojectUniforms` UBO `currentVP/previousVP/inverseVP/historyValid/blendWeight/resolution`; `historyValid=0` first frame / after resize via `_skipNextBlend`); NEW `packages/engine/Source/Shaders/WebGPU/Environment/CloudReproject.wgsl` (reconstruct world pos from `cloudHalfDepth`+`inverseVP` — **the sign/flip trap**; project via `previousVP`→prevUV; off-screen reject; 3×3 AABB neighborhood clip; `mix(historyClamped, current, blendWeight)`, forced 1.0 on disocclusion; tighter clip when `denoise` T2+); NEW `Tools/visual-regression/probe-cloud-temporal.mjs`; EDIT `FEATURE_INVENTORY.md`, `CAMPAIGN3_PROGRESS.md`.
- **Pipeline order:** raymarch→half (V9) → reproject (history r/w) → upscale (V9, now reads the reprojected buffer).
- **Tier-gate:** `temporalEnabled` from preset — T1 (1/16 loose clip), T2 (1/8 tight/denoised), T3 false (no reproject; upscale reads raw march). Default off.
- **Probe:** `probe-cloud-temporal.mjs` — (A) static, N=16: frame-16 mean mismatch ≤2% vs full-res non-temporal reference; **assert convergence happens** (frame16 mismatch < frame1). (B) panning: max temporal luma lag at a high-contrast edge ≤12/255 two frames after it passes (no ghost). Unit sanity: for a static camera `prevUV ≈ current UV`. READ static-N16 (= reference) + pan (no smear).
- **W1-W5 risk: MEDIUM** (history; a reconstruction error reads as "no-op"). Guard: the convergence assertion (frame16<frame1), not just zero errors; the documented sign/flip trap.

---

### V11 — Per-genus vertical density profiles on the baked core (was W10)
- **Goal:** Stratus-flat / cumulus-billowy / cumulonimbus-tower (anvil) from `CloudTypeProfile` via a height-gradient lookup feeding the baked-shape remap.
- **Files:** EDIT `ProceduralClouds.wgsl` (`heightGradientForShape(hf,shape,anvilBias)` SLAB/BILLOWY/TOWER + `remap(hf,0.7,1,1,1-anvilBias)` anvil; apply in **both** `cloudDensity` and `cloudBaseDensity`; multiply `absorptionCoeff` by `profileExtinction`); EDIT `WebGPUProceduralCloudRenderer.ts` (import `CloudTypeProfile`; **struct grows 100→104** — append vec4 @100-103: `profileShape`@100, `anvilBias`@101, `profileExtinction`@102, `profileBaseDensity`@103); NEW `Tools/visual-regression/probe-cloud-types.mjs`; EDIT `FEATURE_INVENTORY.md`.
- **Neutral:** `profileShape=BILLOWY` reproduces the exact current gradient → A/B ≤2%.
- **Tier-gate:** profiles active T1+ (qualityFlags bit 7); single active genus (`globe.cloudType`, default CUMULUS). Default off.
- **Probe:** `probe-cloud-types.mjs` — SLAB/BILLOWY/TOWER, identical camera: vertical extents ordered tower>billow>slab (≥25%), tower shows top-flare, billow matches pre-V11 A/B ≤2%. READ all three.
- **W1-W5 risk: LOW-MEDIUM** (struct growth 100→104; vec3-align). Guard: field-by-field byte-offset verify; A/B at BILLOWY == pre-V11 single gradient.

---

### V12 — Multi-deck cirrus/stratus + ice/water phase (was W11; T2+)
- **Goal:** Up to 3 altitude decks from the `texture_2d_array` weather map; cirrus = ice (sharper `phaseG1`, lower extinction, blue-shift tint).
- **Files:** EDIT `ProceduralClouds.wgsl` (per-deck march loop, ice params); EDIT `WebGPUProceduralCloudRenderer.ts` (fill weather array depth 3; **struct grows 104→112** — `deckCount`@104, `_padF`@105-107 pad, `deckBottoms`@108-110 (vec3, 4-float-aligned), `deckTops`@... — **verify vec3 lands on float÷4** field-by-field before build, land at exactly **CLOUD_UNIFORM_FLOATS=112** per the master table); NEW `Tools/visual-regression/probe-cloud-multideck.mjs`; EDIT `FEATURE_INVENTORY.md`.
- **Tier-gate:** `deckCount` from preset/coverage — T1 single deck, T2/T3 multi. Default off.
- **Probe:** `probe-cloud-multideck.mjs` — ≥2 distinct vertical bands with a clear-sky gap; upper band cooler (`meanB/meanR` higher) + wispier. A/B `deckCount=1` == V11. READ multideck PNG.
- **W1-W5 risk: MEDIUM** (the vec3-alignment trap — `deckBottoms` must start float÷4 → 108, not 105). Guard: field-by-field byte-offset verification before build.

---

### V13 — Cloud shadows on the ground/terrain (was W12)
- **Goal:** Cloud-shadow compute producer reuses the **baked density** (single source of truth, no inline live-noise copy) → 256×128 lon/lat shadow R-tex; `GlobeTerrain.wgsl` `sampleCloudShadow` darkens lit fragments.
- **Files:** NEW `CloudShadowMap.wgsl` (compute, samples baked shape density); EDIT `GlobeTerrain.wgsl` (`sampleCloudShadow`); EDIT terrain `EffectsUniforms` (480→512, add `cloudShadowControl`+`cloudShadowBounds`, bindings 23/24); EDIT `Globe.js` (new `cloudShadowsOnGround`, default false); NEW `probe-cloud-groundshadow.mjs`.
- **Tier-gate:** `globe.cloudShadowsOnGround` (default false) — independent of fidelity tier but only meaningful when clouds on.
- **Probe:** ground luma ON ≥6% lower + stddev ≥1.3× (patchy not global). READ.
- **W1-W5 risk: none** (terrain-side).

---

### V14 — God-rays / crepuscular from cloud transmittance (was W13)
- **Goal:** Cloud FS emits MRT `@location(1)` transmittance; `GodRayGenerate.wgsl` multiplies sky contribution by it.
- **Files:** EDIT `ProceduralClouds.wgsl` (transmittance MRT output — reuses V9's MRT plumbing); EDIT `GodRayGenerate.wgsl`; EDIT `GodRayUniforms` (12→16 floats); NEW `probe-cloud-godrays.mjs`.
- **Tier-gate:** gated by existing god-ray post-process enable. Default off.
- **Probe:** shafts localize to cloud gaps (gap/cloud contrast ON ≥1.25× OFF). READ. Verify the cloud-FS V-flip matches the god-ray sample UV.
- **W1-W5 risk: LOW.**

---

### V15 — Precipitation gated by coverage/type (was W14)
- **Goal:** CPU `getWeatherSampleAt(context,lon,lat)` gates `WebGPUWeatherRenderer` by weather-map coverage; rain/snow from altitude + `cold`.
- **Files:** EDIT `WebGPUWeatherRenderer` + CPU weather sampler; no new GPU buffer; NEW `probe-cloud-precip.mjs`.
- **Tier-gate:** CPU weather gate, independent of fidelity tier.
- **Probe:** rain under a cloudy cell (≥5% streak pixels), none under clear (≤0.5%). READ.
- **W1-W5 risk: none** (CPU-side, existing particle infra).

---

### V16 — Far-field: transmittance early-out + distance-adaptive step growth
- **Goal:** Confirm the `transmittance<0.01` early-out breaks both coarse and fine loops; grow `fineStep`/`coarseStep` with distance so far clouds cost fewer taps (near silhouette stays dense). Image-preserving perf.
- **Files:** EDIT `ProceduralClouds.wgsl` (distance-adaptive growth `*= 1+clamp((t-tStart)/farRef,0,growMax)`, `farRef≈40000`, `growMax≈2.0`; keep `maxIter` sentinel); EDIT/extend `probe-cloud-perf.mjs` (A/B); EDIT `FEATURE_INVENTORY.md`.
- **Tier-gate:** governed by existing `maxSteps` budget; growth is a WGSL const ratio (all tiers benefit). Default off.
- **Probe:** A/B mean-abs luma ≤2%, cloud-cell count ±6%, frame-time faster. READ — silhouette/internal shading unchanged, no thinned far tops.
- **W1-W5 risk: LOW** (near field where W1-W5 live is unchanged). Guard: near-band ≤2% A/B; clamp growth to start beyond `tStart + N*fineStep` so cloud edges stay full-cadence.

---

### V17 — Baked-impostor far field (research's Ultra-only far representation)
- **Goal:** Defer the far field to a baked 2D impostor (T1/T2 `farRepresentation:"impostor"`) beyond a distance threshold; T3 keeps the low-step volumetric limb march.
- **Files:** NEW `CloudImpostorBake.wgsl`; EDIT `ProceduralClouds.wgsl` (far-field branch by `farRepresentation` flag — reuse a reserved lane); EDIT `WebGPUProceduralCloudRenderer.ts` (impostor bake + bind); NEW `probe-cloud-farfield.mjs`; EDIT `DEFERRED_WORK.md` (entry `NEW-WEBGPU-CLOUD-IMPOSTOR-FARFIELD`).
- **Principle 9 split:** if `CloudImpostorBake.wgsl` doesn't fit one atomic commit, land **V16 alone first** (already done above) and **V17 (impostor bake) is the next concrete item** — never an inline far-field hack at the call site.
- **Tier-gate:** `farRepresentation` from preset. Default off.
- **Probe:** `probe-cloud-farfield.mjs` — near-field ≤3% in the near band; far-band GPU-synced frame time at an orbit camera strictly faster; no hard seam between near volumetric and far impostor. READ orbit + ground PNGs.
- **W1-W5 risk: LOW** (near field unchanged). Guard: near-band ≤3% A/B.

---

### V18 — Tier dial closeout + docs (`cloudVolumetricQuality` vocabulary + deferral tracking)
- **Goal:** Finalize the public mapping, document the tier model, track the deferred denoised-temporal + impostor as next work.
- **Files:** EDIT `Globe.js` (JSDoc on `cloudVolumetricQuality`: `low→T1, medium→T2, high→T3, auto`; `medium/high` use precomputed 3D noise + reconstruction; `cloudQuality` override forces live; **no default change**); EDIT `CLOUD_RENDERING_STRATEGY.md` (fill "Decisions pending" → decided); EDIT `FEATURE_INVENTORY.md` (move shipped tier features §C→§B); EDIT `DEFERRED_WORK.md` (entries for denoised-temporal T2 spatial-denoise follow-up + impostor far-field if not landed in V17); NEW `Tools/visual-regression/probe-cloud-tier-sweep.mjs`.
- **Tier-gate:** docs + closeout; zero shader/packer change.
- **Probe:** `probe-cloud-tier-sweep.mjs` — sweep `low/medium/high/auto` (one frame each): zero device errors at every tier; monotonic GPU frame-time `T1<T2<T3`; each PNG non-degenerate (no black/blank/NaN). Capture `showProceduralClouds=false` → assert byte-identical to a clouds-disabled reference (**Tier 0 = default preserved, end-to-end regression lock**). READ all five PNGs.
- **W1-W5 risk: none** (docs). This is the campaign-level regression lock.

---

### V19–V28 — Parity tail (P2–P11, unchanged, after the cloud arc)
Each independent of the cloud core; one atomic commit + probe each. Run after V18.

| Batch | Was | Scope |
|---|---|---|
| V19 | P2 | depthFail material twin (`createWebGPUMaterialCommands` + `MATERIAL_DEPTHFAIL` ifdef) |
| V20 | P3 | Hi-Z moving-camera A/B (verification-first; guard band only if shimmer>budget) |
| V21 | P4 | ground-atmosphere drape limb-width parity |
| V22 | P5 | high-exaggeration bright-blue water-streak parity |
| V23 | P6 | collections 2D/CV morph fix (billboards/points/labels) |
| V24 | P7 | WeatherSystem API skeleton (backend-neutral WeatherField/Provider + `weatherVersion`) |
| V25 | P8 | glTF accurate-2D `projectTo2D` WGSL (position2D + u_modelView2D + USE_2D) |
| V26 | P9 | `WGSLShaderPreprocessor.ts` `@private`→`@internal` TS-debt |
| V27 | P10 | `FEATURE_RENDERER_ONBOARDING.md` refresh |
| V28 | P11 | weather-visual baselines + FEATURE_INVENTORY/roadmap/DEFERRED reconciliation |

**W1-W5 risk: none** (non-cloud subsystems).

---

## 4. Final `CloudUniforms` byte-layout (ratified — the single allocation for the campaign)

| Floats | Field | Batch | Note |
|---|---|---|---|
| 0–73 | (existing through `ambientIntensity`@73) | W1-W2 | unchanged |
| 74 | `qualityFlags` (bitfield) | **V1** | was `_pad4b`; bit0=noiseSource, bit1=halfRes, bit2=temporal, bit3=jitter, bits4-6=octaves, bit7=profileOn |
| 75 | `curlAmplitude` | **V8** | was `_pad4c` (master-table W9 lane preserved) |
| 76 | `frameCounter` | **V6** | was `_padA.x` (master-table W8 lane) |
| 77 | `curlFrequency` | **V8** | was `_padA.y` (moved from naive 75 per D-2) |
| 78 | `lightSampleScale` | **V5** | was `_padA.z` |
| 79 | `erosionStrength` / `_padA.w` | **V4** | reserve lane |
| 80–95 | (W2/W3/W4 ambient/sun/aerial blocks) | W2-W4 | unchanged; vec3s at 80/84/88/92 ✓ |
| 96–99 | `powderStrength`, `isotropicFloor`, `ambientFloor`, `_padE` | **V7** | new vec4 (96÷4 ✓) → `CLOUD_UNIFORM_FLOATS=100` |
| 100–103 | `profileShape`, `anvilBias`, `profileExtinction`, `profileBaseDensity` | **V11** | new vec4 → `=104` |
| 104–111 | `deckCount`@104 + pad, `deckBottoms` (vec3, 108÷4 ✓), `deckTops`/`cirrusTint` | **V12** | → `=112` (matches master table) |

**Byte-lock invariant:** the reconstruction+lighting arc (V1–V10) stays at **96 floats** (all fields reuse reserved lanes 74-79). Growth happens only at V7 (→100), V11 (→104), V12 (→112) via clean vec4 appends — every new field is a scalar or 4-float-aligned vec3, zero 16-byte-alignment hazards, pre-existing vec3 blocks (80/84/88/92) unmoved. Each batch claiming a lane in 74-111 also replaces the matching write in the renderer's trailing zero-fill loop.

---

## 5. W1-W5 regression-risk map (the guard for each batch)

| Batch | Risk | Probe guard |
|---|---|---|
| V1 tier struct | HIGH (every cloud renders through the dial) | 0.00% identity A/B + escape-hatch test |
| V2 noise bake | LOW (additive bindings) | ≤0/255 identity A/B; live march still runs |
| **V3 baked density core** | **HIGHEST (keystone)** | quality-bounded A/B (≤6%) vs live-noise build + **full re-run of each W1-W5 acceptance metric** + frame time faster |
| V4 morphology remap | MEDIUM (W5-coupled shaping) | oracle keeps `base≥full`; low-coverage silhouette A/B ≤2% |
| V5 lighting upgrade | MEDIUM (rewrites accumulation W1 tone-maps) | re-assert W1 silver-lining + W2 shadow-lift; tone-map tail untouched |
| V6 jitter | LOW (jitters W5 start only) | single-static-frame banding metric |
| V7 powder/floor | MEDIUM (struct 96→100; powder in V5 loop) | neutral A/B ≤2%; vec4 append clean; byte-offset verify |
| V8 curl | LOW (edge-only) | ≤3% interior bulk-drift clamp |
| V9 half-res upscale | MEDIUM (FS return + composite) | T3 full-res = untouched W1-W5 composite as reference; log-space blend prevents dark-fringe |
| V10 temporal | MEDIUM (history; errors read as "no-op") | convergence assertion (frame16<frame1) + pan ghost test |
| V11/V12 profiles/decks | MEDIUM (struct growth 100→104→112; vec3-align) | field-by-field byte-offset verify; A/B at neutral profile/deckCount=1 |
| V13–V28 | none | non-cloud / additive subsystems |

**V3 is the keystone and the highest-regression-risk batch** — also the research's "highest leverage" (quality + perf). Its probe is the most rigorous in the campaign: a full re-run of W1-W5's individual acceptance metrics against a stashed live-noise build, not a single luma diff.

---

## 6. Branch transparency + cross-cutting notes (for the running session)

- **Pre-flight (every session start):** run `git branch -a`; if anything besides `main` exists, surface it before starting a batch. Create a timestamped safety ref before the keystone (`safety-pre-V3-baked-core-<date>`); commit to deleting it after V3 lands green on main.
- **Default preservation is structural, not incidental:** baked textures are never allocated and the bake never dispatches unless a BAKED tier is *actually rendered*. A default viewer (clouds off, or `auto`→low-at-orbit) is byte-for-byte today's code. V2's probe proves this with a 0-mismatch A/B.
- **Storage format:** `rgba8unorm` write-only storage is core WebGPU (no optional feature). On unexpected device rejection, the bake-failure path forces `noiseSource=LIVE` — graceful, no black clouds.
- **Tiling/seams:** both bakes are periodic; the 3D sampler uses `repeat`; `fract(...*TILE_SCALE)` wraps; curl-before-detail (V8) hides residual trilinear artifacts so 128³/32³ stay small.
- **The one cross-arc ratification (do at V1):** update the PACKED master byte-table (lines 54-55, 67) to the §4 allocation — `qualityFlags@74`, `curlAmplitude@75`, `frameCounter@76`, `curlFrequency@77`, `lightSampleScale@78`. Flag to the cloud-internals architect (owner of the byte layout).
- **Surfaced as immediate next work (Principle 9):** (a) **denoised temporal for T2** needs a spatial-denoise pass V10 does not build — flag as a T2-quality follow-up after V10, not folded in silently; (b) **impostor far-field bake** (V17) may not fit one atomic commit with the early-out — if so, land V16 alone and make V17 the next concrete item.

**Files this campaign creates:** `WebGPUCloudTierPresets.ts`, `CloudNoiseBake.wgsl`, `WebGPUCloudNoiseResources.ts`, `CloudUpscale.wgsl`, `CloudReproject.wgsl`, `CloudShadowMap.wgsl`, `CloudImpostorBake.wgsl`, and probes `probe-atmo-lut-no-device-error / -tier-resolver / -noisebake / -noisecore / -remap / -lighting / -banding / -powder / -curl / -halfres / -temporal / -types / -multideck / -groundshadow / -godrays / -precip / -farfield / -tier-sweep.mjs`.
**Files it edits:** `ProceduralClouds.wgsl`, `WebGPUProceduralCloudRenderer.ts`, `Globe.js`, `GlobeTerrain.wgsl`, `GodRayGenerate.wgsl`, `WebGPUAtmosphereLUT.ts`, `WebGPUPerformanceManager.ts`, `WebGPUWeatherRenderer`, and docs (`CLOUD_RENDERING_STRATEGY.md`, `FEATURE_INVENTORY.md`, `DEFERRED_WORK.md`, `CAMPAIGN3_PROGRESS.md`, `QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md`).

---

# Adversarial Review (principal-engineer pass)

I have everything I need. The escape-hatch `raw !== 64` is the critical default-preservation hinge, and the default `cloudQuality` default is 64 (so the escape hatch is NOT triggered by default — `auto` band logic runs). Branch state is clean (only `main` + read-only upstream refs). Now I'll write the adversarial review.

---

# Adversarial Review — Campaign 3 v2 Tiered Volumetric Clouds

**Verdict up front: GO-WITH-FIXES.** The plan is unusually disciplined — the byte-lock table is correct, the default-off structural argument holds, and every template it leans on (`WebGPUVolumetricFogResources`, `WebGPUParityManager`, `ignJitter`) actually exists in the tree. But it hand-waves three integrations that are genuinely hard *in this specific code*, ships at least one factually-wrong root cause (V0), and has two batches whose stated "0.00% identity" probe cannot pass as written. None are fatal; all have concrete fixes.

I verified every ground-truth claim in §0 against the live code. They check out: `CLOUD_UNIFORM_FLOATS = 96`, `_pad4b@74 / _pad4c@75 / _padA@76-79`, the W5 oracle's `base ≥ full` invariant, the resolver's `{maxSteps,lightSteps}` signature, and the `frameCounter` zero-fill at `data[481]`. The plan's author understands the alignment trap (the WGSL even carries a comment at lines 57-58 warning that a vec3 at 72-75 would jump to 76). That credibility is why the remaining problems are worth taking seriously.

---

## (1) Does the DEFAULT stay WebGL-parity cheap / fully opt-in?

**Mostly yes, with one unverified-claim gap.**

Confirmed structurally: default is `globe.showProceduralClouds = false` → the pass never runs, never reaches the resolver, never bakes, never allocates a 3D texture. That's real default preservation, not incidental.

**Problem 1a — the "auto resolving to low-at-orbit = byte-identical today" claim is false for the enabled-but-auto case.** §6 says "a default viewer (clouds off, or `auto`→low-at-orbit) is byte-for-byte today's code." Clouds-off is byte-identical. But the moment clouds are *on* with `auto`, the V1 resolver runs, and the plan promises V1 keeps the OLD `(24,3)/(48,4)/(96,8)` table for image-identity. That holds for V1 — but every later batch that flips a `qualityFlags` bit per-tier (V3 `noiseSource`, V6 `jitter`, V9 `halfRes`) changes the enabled-auto image. The plan's own §5 risk map acknowledges this per-batch, but §6's blanket "byte-for-byte" sentence overstates it for the enabled path. **Fix:** restrict the §6 default-preservation claim to `showProceduralClouds=false` (and the `cloudQuality !== 64` escape hatch, which forces LIVE). Drop "auto→low-at-orbit" from the byte-identity claim — that path *does* change once V3 lands.

**Problem 1b — the escape hatch is the real opt-out, and it's load-bearing but undertested.** I verified `raw !== 64` is the hinge: default `cloudQuality` is 64, so the escape hatch does NOT fire by default and `auto` band logic runs. Power users who set any other number get LIVE noise, full-res, no temporal. The whole "power-user behavior preserved exactly" guarantee rests on this one branch surviving every batch. **Fix:** add an explicit escape-hatch regression assertion to V18's tier-sweep probe (set `cloudQuality=100`, assert `noiseSource=LIVE`, `renderResScale=1`, `temporalEnabled=false`), not just V1's resolver unit test — because V3/V9/V10 are where it's most likely to silently regress.

---

## (2) Does ANY batch regress shipped W1–W5?

**Three real regression vectors, all flagged by the plan but two under-guarded.**

**Problem 2a — V5's "algebraically identical" accumulation claim is subtly wrong against the *actual* loop.** The live loop (lines 497-513) is:
```
sampleTransmittance = exp(-density * fineStep * absorptionCoeff)
sampleWeight = (1 - sampleTransmittance) * transmittance
weightedColor += (cloudColor * sunLightColor * scatteredLight + ambient) * sampleWeight
```
The plan's V5 replacement uses `sigmaE = max(density*absorptionCoeff, 1e-6)` and `(S - S*segT)/sigmaE * sigmaE`. The `* sigmaE` cancels the `/sigmaE`, leaving `(S - S*segT) = S*(1 - segT)` — which equals the old `sampleWeight * S` **only if `S` already folds `transmittance` in**, but the plan writes `weightedColor += transmittance * ((S - S*segT)/sigmaE) * sigmaE`, i.e. `transmittance * S * (1-segT)`. That **is** algebraically identical to the old form. So the math is fine — *but* the `max(…, 1e-6)` clamp changes behavior in near-zero-density samples that the old code skipped entirely via `if (density > 0.001)`. The old loop never accumulates below 0.001 density; the new analytic form, if it drops that guard, will accumulate a `1e-6`-floored contribution everywhere. **Fix:** keep the `if (density > 0.001)` guard around the analytic block. State this explicitly in V5 — "the `1e-6` floor is only for the division, not a license to remove the density gate." Re-assert W1 silver-lining AND a *new* check: total accumulated alpha over an empty column stays 0.

**Problem 2b — V4 + V3 both touch the W5-coupled shaping, and the oracle invariant is fragile under the baked branch.** The live oracle (lines 243-261) is `fbm → coverage smoothstep → height gradient`, and `base ≥ full` holds *because erosion only subtracts* (line 228). V3's baked oracle samples "shape.r only," V4 adds a `remap` coverage. The invariant `base ≥ full` is NOT automatically preserved across a representation change: if the baked `shape.r` (a Perlin-Worley billow) and the baked detail erosion don't share the exact same coverage-remap pivot, the oracle can read *lower* than full density in some voxel and the coarse march will skip real cloud → truncated tops (the exact W5-era bug). The plan asserts the invariant holds but never says *how it's verified*. A luma diff won't catch an intermittent skip. **Fix:** V3's probe must add a dedicated oracle-conservatism check — sample both `cloudBaseDensity` and `cloudDensity` at a grid of march positions via a debug FS mode and assert `base ≥ full - epsilon` at every sample, not just "no visible truncation." This is the W5 contract; it deserves a direct numeric assertion, not a visual one.

**Problem 2c — V9 moves the composite out of the shader, and the composite is currently *in* the shader consuming `sceneColor`.** This is the biggest under-stated regression risk and I'll detail it under (7).

---

## (3) Is CloudUniforms byte-locking respected on EVERY uniform change?

**Yes — the table is correct, and this is the plan's strongest section.** I verified the proposed §4 layout against the live struct:

- 74-79 reuse exists and is zero-filled (`data[479-484]`) — claiming them needs the matching zero-fill-write replacement, which §4's closing note correctly requires.
- vec3 blocks at 80/84/88/92 are confirmed and stay unmoved.
- V7's append @96-99 is a clean vec4 (96÷4=24 ✓).
- V12's `deckBottoms` vec3 must start at 108 (108÷4=27 ✓), and the plan explicitly flags "verify vec3 lands on float÷4 field-by-field before build."

**Problem 3a — the D-2 ratification is a cross-arc edit to a doc the cloud-internals architect owns, and it must land in the SAME commit as V1 or the table drifts.** The plan says "ratify into the PACKED master table before V1 lands." If V1 ships the WGSL rename (`_pad4b → qualityFlags@74`) but the doc edit slips to a follow-up, the master table still says `74→curlAmplitude`, and V8 (curl) will be planned against a stale table → `curlAmplitude` packed at 74, colliding with `qualityFlags`. **Fix:** make the `QUEUE_…PACKED.md` edit a hard line-item *inside* V1's atomic commit, not a "flag it to the architect" side note. The plan lists it in V1's Files but softens it to "flag to the architect" in §6 — pick one: it's a commit deliverable.

**Problem 3b — `qualityFlags` as a bitfield packed into an f32 is fine, but the octave count in bits 4-6 (V5) caps at 7 and the plan hardcodes "octaves=3 already matches `i<3`."** Confirmed the live `multiScatterLight` uses a fixed loop. Packing octaves into 3 bits is sound, but unpacking a float bitfield in WGSL requires `bitcast<u32>` / integer ops on a value that arrives as `f32`. If the packer writes `qualityFlags` as a float whose integer value is the bitfield, `bitcast<u32>(74.0)` gives the IEEE bits, not 74. **Fix:** the WGSL must read `u32(cloud.qualityFlags)` (value conversion) not `bitcast`, and the packer must write the bitfield as a float-valued integer (`data[74] = flags`). State the conversion direction explicitly in V1 — this is a classic off-by-a-bitcast that produces garbage flags and would corrupt every tier silently.

---

## (4) Is each batch verifiable with a Playwright probe, and is the stated probe sufficient?

**Mostly yes — the probe discipline is genuinely good (A/B via git-stash WGSL, `queue.onSubmittedWorkDone()` sync, READ the PNG). Two probes are insufficient as stated.**

**Problem 4a — V0's probe verifies the wrong thing and the root cause is misdiagnosed.** I read `dispatchAtmosphereExtendedLUT`: it already binds all 6 entries (bindings 0-5) into `extendedBindGroup` against an explicit `extendedBindGroupLayout`. The dispatch passes that bind group at `index: 1`. The pipeline, though, is created via `getOrCreatePipeline(cacheKey, source, entryPoint)` with **no `bindGroupLayouts` arg → `layout: "auto"`** (confirmed at ComputeEngine line 412-417). The plan's stated cause — "binding 4 vs 5 mismatch, auto derives the smaller subset layout" — is **half right but imprecise**: the two entry points share one WGSL source but `computeMultipleScattering` only *uses* bindings 0-4 and `computeIrradiance` uses 0-3,5. Under `layout:"auto"`, each pipeline derives a layout containing only the bindings *that entry point statically references*. The supplied `extendedBindGroup` was built against the full 6-binding `extendedBindGroupLayout`, so it's a **bind-group-vs-pipeline-layout incompatibility**, not a "binding 4 vs 5" count mismatch. The fix the plan proposes (thread explicit `[emptyGroup0BGL, extendedBindGroupLayout]`) is correct and the API supports it (line 400 `bindGroupLayouts?`). But the probe as stated ("step the clock, render 10 frames, assert zero errors") won't prove the fix is *robust* — `layout:"auto"` errors are non-deterministic across drivers and can pass on Edge while failing elsewhere. **Fix:** correct the root-cause text to "auto-layout vs full-bind-group incompatibility," and have the probe assert the pipeline was created with an *explicit* layout (expose a debug flag), not merely that no error surfaced this run.

**Problem 4b — V10's convergence probe ("frame16 < frame1") is necessary but not sufficient to catch the reproject sign/flip trap.** The plan itself flags "the sign/flip trap" for reconstructing world pos from depth via `inverseVP`. A reprojection that's flipped in V *still converges* on a static camera (prevUV ≈ current UV when the camera doesn't move), so frame16<frame1 passes even with a broken flip. The bug only shows under motion. **Fix:** V10's probe (B) panning case must be the *gating* assertion, and it must check directional correctness — reproject a known feature one frame, assert it lands within 1px of its motion-predicted position, not just "no ghost within 12/255." A V-flip lands it on the wrong side, which the loose ghost threshold can miss.

**Problem 4c — several probes assert "A/B ≤ 2%" with no statement of what metric or what region.** "Mean-abs luma" over the *whole frame* is dominated by sky/terrain that the cloud change doesn't touch, so a 2% whole-frame budget can hide a 40% cloud-pixel regression. The plan does say "cloud-cell count ±10%" in places, but inconsistently. **Fix:** every cloud-region A/B must mask to cloud pixels (alpha > threshold) before computing the diff. State this once in §3's per-batch discipline so it applies uniformly.

---

## (5) Memory / perf budget of the 3D textures + half-res + history

**Largely fine, one real device-limit risk and one VRAM accounting gap.**

Numbers: 128³ RGBA8 = 8.4 MB; 32³ RGBA8 = 131 KB; low band 64³ = 1 MB. Trivial. Half-res `rgba16float` at 1920×1080÷4 ≈ 4 MB ×2 (scatter+depth) ≈ 8 MB. History ping-pong doubles the half-res ≈ 8 MB more. **Total cloud VRAM ≈ 25 MB.** No VRAM risk on any modern GPU.

**Problem 5a — `maxTextureDimension3D` default is 2048 (confirmed at `WebGPUContextLimitsInit.ts:100`), so 128³ is safe, but the bake dispatch `@workgroup_size(4,4,4)` over 128³ = 32³ = 32,768 workgroups per dimension... no, 128/4 = 32 per dim, well under `maxComputeWorkgroupsPerDimension` (65535).** Fine. But the plan never checks `maxStorageTexturesPerShaderStage` for the *bake* (writes 1-2 storage 3D textures) — default is 4, so fine — nor `maxSampledTexturesPerShaderStage` for the *march* pipeline, which after V2 binds: colorTex, depthTex, weatherTex, shapeTex, detailTex = 5 sampled textures + 3 samplers. Default `maxSampledTexturesPerShaderStage` is 16, default `maxSamplersPerShaderStage` is 16. Safe — but V12 multi-deck and V13 cloud-shadow add more, and nobody is counting. **Fix:** add a one-line binding-count budget to V2 and re-check at V12/V13. It's currently uncounted, which is how you ship a pipeline that validates on your dev GPU and fails on a min-spec device.

**Problem 5b — the half-res `rgba16float` MRT requires `rgba16float` to be a renderable *and* blendable format, and renderable is guaranteed but the upscale's log-space blend may need float blending.** WebGPU guarantees `rgba16float` as a render target, but the half-res *march* writes premultiplied scatter — fine, no blend needed in the march. The *upscale* does the blend in-shader (manual, not fixed-function), so no `float32-blendable` feature is needed. OK on inspection — but the plan should *state* it's doing manual blend in the upscale shader (not relying on a blend state) so a future session doesn't add a blend descriptor that needs an optional feature. **Fix:** note "upscale blends manually in-shader; no blendable-float feature dependency."

---

## (6) Is the batch ORDER dependency-correct — can each land as ONE atomic green build?

**Order is mostly correct, with one genuine ordering bug and one atomicity risk.**

The spine (V0 → V1+V2 → V3 → …) is sound. V6-before-V10 (jitter before temporal) is correct — temporal accumulates decorrelated samples. V8 live-then-baked is correctly sequenced after V3.

**Problem 6a — V9 (half-res + MRT + upscale) is sequenced BEFORE V10 (temporal), but V9 introduces the offscreen render target and composite-extraction that is the single hardest integration, and it's gated by `renderResScale`. If V9 lands and any tier has `renderResScale=0.5`, the composite path changes for that tier in one commit.** The plan claims T3 (`renderResScale=1`) is the "untouched W1-W5 composite reference." But V9 *rewrites the FS to return an MRT struct under a `RENDER_TO_HALF` path* and keeps the full-res composite "for T3." That means the FS now has two code paths in one shader, and the T3 path must be byte-identical to today. Maintaining two composite paths in one atomic commit, both green, is the hardest single batch in the campaign and it's described in one paragraph. **This is not an ordering bug per se, but V9 should be split:** land the offscreen-target plumbing + T3-passthrough (proving byte-identity) as V9a, then the half-res + bilateral upscale as V9b. The plan's own Principle-9 instinct (split V16/V17) should apply here too.

**Problem 6b — V7 grows the struct 96→100 and is sequenced AFTER V3/V4/V5/V6 which all reuse lanes 74-79.** That's correct ordering (growth last). But V7, V11, V12 each bump `CLOUD_UNIFORM_FLOATS` and each requires the packer's trailing zero-fill loop to shrink in lockstep. If V7 bumps to 100 but leaves a stale `data[96]=0…data[99]=0` zero-fill *after* the new field writes, the new fields get clobbered. **Fix:** each growth batch must *remove* the corresponding zero-fill writes, not just add field writes. The plan says this in §4's closing line generically — make it an explicit checklist item in V7/V11/V12 ("delete zero-fill writes for the claimed lanes").

---

## (7) Where does the plan hand-wave a HARD integration?

**Three, in order of severity:**

**Problem 7a (SEVERE) — render-target plumbing for V9. The cloud pass today is an in-place read-modify-write composite into the main frame `outputView` with `loadOp:"load"`,** reading scene color from binding-0 `colorTex` and compositing in-shader via `mix(sceneColor.rgb, hazed, cloudAlpha)` (lines 544, 561-564). It records into `context._currentCommandEncoder` so the composite-over-post-process ordering survives (the Batch 127 fix comment at line 546). V9 must:
   1. Allocate a half-res offscreen MRT (no scene color in it).
   2. Change the FS half-res path to output **premultiplied scatter + transmittance**, NOT a composite — meaning the W1 tone-map and W4 aerial still run but the final `mix(sceneColor,…)` must move to the upscale pass, which now needs its own copy of scene color and depth.
   3. Preserve the `_currentCommandEncoder` recording so ordering survives — but now across *two* passes (march into half-res, upscale into outputView).

   The plan's "keep the W1 tone-map + W4 haze byte-identical — only the final composite moves out" massively understates this: the aerial-perspective `mix(toneMapped, aerialColor, aerial)` is LDR-space and fine to keep in the march, but the scene composite `mix(sceneColor, hazed, cloudAlpha)` *cannot* stay — and the upscale must re-fetch scene color/depth at full-res to composite, which the current pass gets for free from binding-0. **Fix:** V9a must explicitly re-plumb scene-color/depth into the upscale pass's bind group, and the half-res FS must emit premultiplied `(hazed*cloudAlpha, cloudAlpha)` so the upscale composite is `sceneColor*(1-a) + premultScatter`. Call this out as the load-bearing change, not "the composite moves out."

**Problem 7b (SEVERE) — motion vectors / `previousViewProjection` for V10 are NOT wired into the cloud renderer.** I grepped: `previousViewProjection` appears in TAA but NOT in `WebGPUProceduralCloudRenderer.ts` or `ProceduralClouds.wgsl`. The plan's V10 says "reproject by `previousViewProjection`" and references the `CameraUniforms` tail convention from CLAUDE.md — but the cloud `CloudUniforms` struct has NO `previousViewProjection` field, and adding one is a **struct growth** that the §4 byte-table does not account for (a mat4 is 16 floats → would blow past the 112 target). The reproject UBO (`ReprojectUniforms`) is a *separate* buffer per the plan, which is the right call — but the plan never says where `currentVP/previousVP/inverseVP` come from. They must be sourced from `UniformState`, and the cloud renderer doesn't currently read `UniformState` for VP matrices. **Fix:** V10 must explicitly wire `UniformState.viewProjection` / `.previousViewProjection` into the new `ReprojectUniforms` buffer (separate from `CloudUniforms`, so no struct growth) — and surface that the cloud renderer has no prior access to these and needs the plumbing added. This is missing-functionality per Principle 9, not a free template reuse.

**Problem 7c (MODERATE) — the W5 skip oracle on baked textures (V3).** Covered in 2b: the oracle's `base ≥ full` invariant is a *numeric* contract that a representation change can violate intermittently, and the plan verifies it only visually. The hand-wave is "sample only shape.r → conservative." That's true *only if* the detail erosion in `cloudDensity` is strictly subtractive in the baked branch too — which requires the `remap(density, detail.r*…, 1, 0, 1)` to never raise density above the shape.r-only oracle. The plan asserts "mean-preserving, subtractive-only: cannot ADD density," but `remap` is NOT inherently subtractive — `remap(d, lo, 1, 0, 1) = (d-lo)/(1-lo)` *raises* values above `lo`. So the V3/V4 detail remap can absolutely produce `full > base` for mid-range densities. **This is a real correctness bug in the plan's stated math, not just under-testing.** **Fix:** either (a) keep erosion as literal subtraction (`density -= detail*k`) in the baked branch to preserve the invariant, matching the live path exactly, or (b) make the oracle sample the *same* remap with the detail term floored to its max erosion, so `base` stays an upper bound. The plan can't have both "mean-preserving remap" and "base ≥ full" without reconciling them — pick subtraction for the oracle's conservatism.

---

## Verdict: GO-WITH-FIXES

The architecture is sound, the byte-lock is correct, default-off is genuinely preserved, and the probe discipline is better than most shipped plans. It does not need a redesign. It needs the following before V1 lands.

### Top 3 must-fix items

1. **Fix the V3 oracle math (Problem 7c / 2b).** The plan's "mean-preserving remap is subtractive-only" is false — `remap(d, lo, 1, 0, 1)` raises mid-range densities, breaking W5's `base ≥ full`. Use literal subtraction for the baked erosion (matching the live path), and add a direct numeric oracle-conservatism assertion (`base ≥ full - ε` at a grid of sample positions) to V3's probe. This is the keystone batch and the one place the plan ships wrong math.

2. **Re-plumb V9 as the hard render-target change it actually is, and split it (Problem 7a / 6a).** The cloud pass is an in-place `loadOp:"load"` composite consuming scene color in-shader. The half-res redirect must (a) emit premultiplied scatter, (b) move the scene composite into the upscale pass with re-fetched full-res scene color/depth, (c) preserve `_currentCommandEncoder` ordering across two passes. Land V9a (offscreen plumbing + T3 byte-identical passthrough) separately from V9b (half-res + bilateral). One paragraph is not enough for this batch.

3. **Wire V10's VP matrices explicitly — they don't exist in the cloud renderer today (Problem 7b).** `previousViewProjection` is wired into TAA only, not clouds. V10 must source `currentVP/previousVP/inverseVP` from `UniformState` into the separate `ReprojectUniforms` buffer (correctly NOT growing `CloudUniforms`), and the panning probe — not the static convergence probe — must be the gating assertion for the sign/flip trap, checking directional correctness to 1px.

### Secondary fixes (do before the relevant batch)
- **V0:** correct the root cause to "auto-layout vs full-bind-group incompatibility" (not "binding 4 vs 5 count"); the proposed fix is right, the diagnosis text is imprecise.
- **V1:** make the `QUEUE_…PACKED.md` D-2 ratification a deliverable *inside* V1's commit, not a side-flag; specify `u32(cloud.qualityFlags)` value-conversion (not `bitcast`) for the bitfield unpack.
- **V5:** keep the `if (density > 0.001)` gate around the analytic-integral block; the `1e-6` floor is for the division only.
- **V7/V11/V12:** explicit checklist to *delete* the matching zero-fill writes when claiming lanes, or new fields get clobbered.
- **All cloud A/B probes:** mask to cloud pixels (alpha > threshold) before diffing; a whole-frame 2% budget hides a 40% cloud-region regression.
- **§6:** restrict the "byte-for-byte today's code" claim to `showProceduralClouds=false` + escape hatch; drop "auto→low" from the byte-identity guarantee.

Branch state is clean (`main` only, plus read-only upstream refs) — no pre-existing branches to reconcile before starting. The plan's call for a `safety-pre-V3-baked-core` ref is appropriate given V3 is the keystone.
