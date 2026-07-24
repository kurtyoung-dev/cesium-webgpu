<!-- Landed Batch 751. Planning artifact for the Dynamic Ocean & Wind epic (candidate Campaign 14). 17-agent research, 0 refuted findings, 2026-07-24. -->

# OCEAN DYNAMICS PLANNING REPORT — Epic Proposal: "Dynamic Ocean & Wind" (candidate Campaign 14 seed)

**Date:** 2026-07-24. **Status:** PLANNING ONLY — no implementation. Maintainer green-lights phases from this document.
**Maintainer ask:** waves with cloud-like randomness that respond to weather/wind; add wind effects, jet streams, currents; everything togglable, performant. (Near-term wave-noise fix C11-172 is separate — this epic builds ON it, does not re-plan it.)
**Key verification note:** all four lanes returned zero refuted findings; anchors below spot-re-verified this session where marked.

---

## 1. What already exists — the reuse map

The epic is mostly brownfield. Raw material by subsystem, with anchors:

### 1a. FFT ocean is already wind-parameterized
- The Phillips spectrum consumes `windX/windZ` (unit dir), `windSpeed` U (m/s), `amplitude`, `smallWave`, `dirDamp`: `L = U²/g` and the `|k̂·ŵ|²` directional factor are live — `packages/engine/Source/Shaders/WebGPU/Ocean/OceanInitialSpectrum.wgsl:14-27` (InitParams), `:35-55` (`phillips()`; re-verified this session: `:19,:21,:24,:42,:44,:49`). Uploaded at `WebGPUOceanRenderer.ts:720-733`. **The epic does not need a new spectrum — it needs to feed this one.**
- Live re-parameterization machinery exists and is cheap: on `cache.paramsDirty || p._paramsDirty` the renderer re-uploads InitParams and re-dispatches only twiddle + initial-spectrum (two 256×256 dispatches, no reallocation) — `WebGPUOceanRenderer.ts:720-739, 778-795`.
- **Gap:** only `windSpeed` has a live public setter (`GlobeWaterOcean.js:85-96`, re-verified `:87-93` sets `_paramsDirty`); `windDirection`/`amplitude`/`choppiness` are enable-time-only (`GlobeWaterOcean.js:53-59`; `OceanSurfacePrimitive.js:54-62`). Adding live setters is trivial; the dirty-flag plumbing is done.
- Exposed vs hardcoded: options = patchLength 250 / patchExtent 3000 / windSpeed 12 / windDirection 0 / amplitude / choppiness / heightScale / timeSpeed / colors (`OceanSurfacePrimitive.js:42-67`). Hardcoded = N=256 single cascade v1 (`WebGPUOceanRenderer.ts:61-66`), gravity, smallWave 1.0, dirDamp 0.15, foam constants. JONSWAP+TMA explicitly deferred (`OceanInitialSpectrum.wgsl:9-11`; `DEFERRED_WORK.md:5256`). No quality-tier integration exists (zero ocean refs in `WebGPUCloudTierPresets.ts`) — an ocean tier axis is NEW work.
- World-locking + injection point are robust: A0 ENU anchor, lattice snap, integer UV offsets, rebase at 4×patchExtent (`OceanSurfacePrimitive.js:123-159`); compute chain on its own encoder submitted before scene render (`WebGPUOceanRenderer.ts:762-763`).

### 1b. Wind today: three stores plus one facade, ocean excluded
- `atmosphericConditions.weather.windSpeed/windDirection` setters fan out to scene weather wind AND cloud wind ("single wind source of truth" by fan-out, not by single read) — `AtmosphericConditions.js:1160-1181` (re-verified `:1160-1161,:1169,:1179`).
- Stores DISAGREE: weather 10 m/s `{x:0.7,y:0.3}` (`Scene.js:1158-1159`); clouds 15 m/s (`CloudVolumetrics.js:83,91-92`); FFT ocean 12 m/s at 0 rad, never fanned out to (`GlobeWaterOcean.js:26-27`, re-verified). Representations disagree too: weather `{x,y,z}` 3D, clouds `{x,y}` 2D, ocean scalar radians.
- Consumers the epic must not break: weather particles (`WebGPUSceneRendererEnvironmentalEffects.ts:63-95`), volumetric fog XZ-projected cloud-shadow drift (`WebGPUVolumetricFogRenderer.ts:966-983`), procedural clouds advection + quantized IBL-revision debounce (`WebGPUProceduralCloudRenderer.ts:541-611, 1991-1997`), C13 density-domain CPU-side advection (`WebGPUCloudDensityDomain.ts:194-246`), `WebGPUDynamicEnvironmentMapManager.ts:1408`.
- **Pre-ratified authority chain for water:** `scene.globe.water.windSpeedOverride` / `windDirectionOverride`, "null → use AtmosphericConditions" — `WATER_RENDERING_DESIGN.md:672-674` (re-verified verbatim). The architecture decision is already made; the epic implements it.

### 1c. Wind visualization already shipped (C6-FLOWFIELD-WIND, Batch 645)
- `FlowFieldWindLayer.js` (backend-agnostic, opt-in default-off, documented WebGL no-op, `:25-46`) + `WebGPUFlowFieldRenderer.ts` (662 lines, ping-pong compute over RGBA8 equirect R=u/east G=v/north, instanced RTE dots, `:3-28`) + `FlowFieldAdvect.wgsl`. `FeatureRendererKey.js:258` (FLOW_FIELD: 52). Off-gate probe-verified 0.000% (`DEFERRED_WORK.md:5254`).
- Four pre-named deferred follow-ups the epic adopts as aliases: **NEW-FLOWFIELD-LIVE-EDR, NEW-FLOWFIELD-OCEAN-CURRENTS, NEW-FLOWFIELD-TRAILS, NEW-FLOWFIELD-WEBGL-PARITY** (`DEFERRED_WORK.md:5254`).
- **Gap:** the R-WIND-DATA offline preprocessor (`Tools/wind-data/fetch-gfs-wind.mjs`) was never shipped — only the 89 KB committed sample (`Apps/SampleData/wind/gfs-wind-sample.png+json`). Live browser NOMADS fetch is impossible (no CORS, verified; OpenDAP retired per SCN 25-81) — `RESEARCH_REGISTER_2026-07-06.md:87-88,91,96`.

### 1d. Weather-ingest pipeline can carry wind/current fields
- Shipped through Phase 3 offline (EDR CoverageJSON + METAR IDW + WCS; live/historical/projected time model; LRU slice cache; runtime source-swap) — `WEATHER_DATA_INGEST_ROADMAP.md:3-32, 155-161`.
- `WeatherField` is a bag of optional named Float32Arrays; the `ww?` precipitation extension (Batch 444) proves the optional-array pattern is non-breaking (`WeatherTypes.ts:37-55`). `windU?/windV?` (EDR UGRD/VGRD) ride the same path.
- **Constraint:** the 256×128 rgba8 weatherTex has ALL FOUR channels claimed by cloud semantics — wind needs a SECOND texture/source (`WEATHER_DATA_INGEST_ROADMAP.md:58-82`; `RESEARCH_REGISTER_2026-07-06.md:93` prescribes a `VelocityFieldSource` sibling in `Scene/Weather`). `WeatherProvider.ts` has zero wind fields today (grep-verified).
- Attribution plumbing for CC-BY feeds already exists: `WeatherTypes.ts:77-78`.

### 1e. Water-mask (terrain) waves: direction not representable today
- `sampleOceanWaveNormals` uses three hardcoded octave scroll velocities; direction AND speed are WGSL compile-time constants; no wind uniform reaches the terrain water shader — `GlobeTerrain.wgsl:2222-2233`; tile flags at `:333` carry no wind slot.
- Plumbing precedent per-tile exists: `oceanParams`/`nightOceanParams` packed with "0 = use shader default" sentinels — `WebGPUGlobeSurfaceTileUB.ts:578-650`. A `windParams` vec4 (dir.xy, speed, choppiness) follows identically.
- Parity constraint: the ENHANCED_OCEAN hi-word gate is STYLING-ONLY; the shared wave march feeds BOTH classic (WebGL-parity default) and enhanced branches (`WebGPUShaderDefines.ts:957-987`; `GlobeTerrain.wgsl:2311-2371`). Wind modulation in the shared march must be mirrored in `GlobeFS.glsl` (Principle 5) or neutral-at-default.
- Gate context: `flags.z = showOceanWaves` requires `showReflectiveOcean` AND a loaded `oceanNormalMap` (`WebGPUGlobeSurfaceTileUB.ts:567-572`; `GlobeTerrain.wgsl:2314`).
- **Sequencing:** C11-172 (octave LOD 3→2→1, lands with C11-158 in C11 W4) shares this exact shader region — `QUEUE_2026-07-18_CAMPAIGN11.md:498, 862-863`. The epic's wind modulation layers over the post-C11-172 shape.

### 1f. Toggle precedents (ranked) and adjacent campaigns
- (a) Lazy-create facade — `GlobeWaterOcean.js:42-66`, byte-identical off, probe-verified 0.0 (`DEFERRED_WORK.md:5256`); (b) scene flag + facade (`Scene.js:3115-3119` `_enableWeather`); (c) runtime QF bitmask uniforms — C13 policy, no pipeline churn (`WebGPUCloudTierPresets.ts:202-228`); (d) hi-word ShaderDefine only for pipeline-level looks — lo-word registry FULL (`WebGPUShaderDefines.ts:930-943`); (e) tier preset struct; (f) SkyBox Variant enum.
- C13 W3 (C13-14..20, all NOT STARTED — `QUEUE_2026-07-23_CAMPAIGN13.md:605-642`) owns the quadtree weather-tile schema (C13-14), ENU wind + spatial advection (C13-18), temporal interpolation (C13-19), source composition (C13-20) — `:55-61, 330-333, 488-512`. No jet-stream or ocean-current rows exist in C13 (grep negative): those are NEW epic scope, but their field infrastructure is exactly C13-14/18/19/20 — hard sequencing dependency for the vector-field level.
- Tides (Batch 748 feasibility, `TIDES_FEASIBILITY_2026-07-24.md`) rides the same FFT carrier: Design A uses OceanUniforms spare pads `_p0/_p1` (`WebGPUOceanRenderer.ts:925,929` ↔ `OceanSurface.wgsl:24,26`), shares the UNCONFIRMED ocean-lid vertical-datum probe, and shares C6-FFT-OCEAN-CLIPMAP as the scale-up prereq (`:24,:28-29,:68-72`).

---

## 2. The design

### 2a. One wind authority (two levels)

**Canonical representation contract (write first):** wind = local-tangent ENU (east, north) m/s — matching C13-18's ratified "local-tangent ENU wind" and the C13-GATE-D requirement that "ENU wind direction is geographically correct" (`QUEUE_2026-07-23_CAMPAIGN13.md:59, 556`). Each consumer derives its own encoding via adapters: clouds speed+dir2D, ocean spectrum wind vector, fog XZ projection, particles 3D, water-mask uniform vec4. This removes the current three-representation disagreement.

**Level 0 (scalar, now):** `atmosphericConditions.weather` becomes the default read authority. Extend the existing fan-out (`AtmosphericConditions.js:1160-1181`) to the ocean, gated by a new opt-in `ocean.waves.windResponse` (default false — without the gate, unification silently changes shipped ocean visuals since defaults differ 10 vs 12 m/s). Water-local overrides per the pre-ratified §5 surface (`windSpeedOverride`/`windDirectionOverride`, null → AtmosphericConditions). Concrete plumbing: add the missing live `GlobeWaterOcean.windDirection` property (plus amplitude/choppiness live setters), reusing the existing `_paramsDirty` path.

**Level 1 (vector field, later, gated on C13-14):** a `VelocityFieldSource` sibling in `Scene/Weather` (NOT the cloud weatherTex — channels claimed), riding C13-14 tile schema + C13-20 composition ("no second live mechanism", `DEFERRED_WORK.md:5254`). Interchange encoding = the proven flow-field format: equirect RGBA8, mapbox encoding R=u G=v with min/max JSON sidecar, row0=north, wrap-U, pole-safe reseed (`RESEARCH_REGISTER_2026-07-06.md:89`). Ship ONE shared sampling helper (WGSL + JS) consumed by clouds, ocean spectrum modulation, and particles.

### 2b. Wave response architecture (three tiers, cheap→rich)

**Tier 1 — water-mask wind modulation (both backends, pure-uniform):** thread a `windParams` vec4 through the tile UB (oceanParams pattern) and modulate: (a) octave scroll velocities rotated/scaled by wind vector, (b) normal-strength with wind speed, (c) anisotropic UV stretch along wind (elongated crests), (d) `computeFoam` threshold driven by the Beaufort curve (`GlobeTerrain.wgsl:2222-2233, 2239-2248, 2348-2349`). Defaults reproduce today's hardcoded constants exactly (neutral-at-default), or mirror in `GlobeFS.glsl` — Principle 5 satisfied either way. Prior art: Bruneton et al. 2010 wind-dependent slope variance; Crest's wind-slaved empirical spectra. Layers over C11-172's octave-LOD shape.

**Tier 2 — FFT wind response without popping (the hard problem, already structurally solved in-tree):** keep the CPU-uploaded Gaussian noise FIXED (`OceanInitialSpectrum.wgsl:11-12` — deterministic Box-Muller upload); h0(k)=ξ(k)·√(S(k)/2) where only the amplitude envelope depends on wind, and deep-water phase speed ω=√(gk) is wind-independent, so phases stay coherent through any parameter change. Wind response = CPU-lerp params over ~2-10 s + re-dispatch the init-spectrum pass per transition frame (one extra 256² pass per cascade). Never re-roll the noise at runtime — that is the only thing that pops. This is exactly Crest's shipped "smooth changing of wind direction everywhere in world" pattern. Rate-limit re-bakes (>0.5 m/s or >5° delta, max once per N frames) + cross-blend old→new displacement over M frames (FOG-TEMPORAL amortization precedent, `AtmosphericConditions.js:758-774`).

**Tier 3 — sea-state realism (consumes the existing C6-FFT-OCEAN follow-up chain, not new research):** JONSWAP + TMA + Horvath-2015 spreading, γ=3.3, finite-depth dispersion, Phillips demoted to debug preset; TWO spectrum layers per cascade — wind-sea (slaved to lagged live wind, exponential smoothing τ≈minutes; fetch parameter gives physical wind→sea-state) + swell (persists independently, narrow spreading). The two-layer split IS the temporal smoothing model: seas don't flatten instantly when wind drops; direction changes rotate the wind-sea while old swell keeps arriving. 3×256² cascades L={250,17,5} m, rgba16float (~25 MB @ 4 cascades) (`RESEARCH_REGISTER_2026-07-06.md:130-147`; `DEFERRED_WORK.md:5256`).

### 2c. Cloud-like spatial randomness = low-frequency sea-state mask, NOT per-region FFT
Industry-standard (Crest wave-splines/wind zones, Atlas local injection, GodotOceanWaves dynamic cascades): sample a sea-state texture or FBM per-vertex/pixel and modulate (a) displacement amplitude, (b) normal-strength/roughness (gust darkening — "cat's paw" patches), (c) Jacobian foam threshold/intensity. One sea-state channel, slowly advected along wind, gives gust patchiness / storm regions / calm cells at ZERO extra FFT cost, and drives BOTH the FFT patch (`OceanSurface.wgsl`) and the water-mask waves from the same source — the direct analog of the cloud weatherTex the maintainer's "randomness like our volumetric clouds" ask implies. For drastic regional calm↔storm: cross-fade two complete spectrum states (dual h0, blend outputs) — 2× compute during transitions only. Current-modulated roughness (wind-against-current rips) = one more multiplier on the same mask when currents data exists.

### 2d. Foam/whitecaps — the most legible weather cue (hard physical anchors)
- Onset ~3.7 m/s; coverage W = 3.84×10⁻⁶·U10^3.41 (Monahan & O'Muircheartaigh 1980) as the target foam-pixel fraction (U=5→~0.09%, 10→~1%, 15→~4%, 20→~10%).
- NWS Beaufort verbatim: Force 3 "Crests begin to break. Foam of glassy appearance"; Force 5 "many white horses"; Force 8 "foam is blown in well-marked streaks along the direction of the wind" → wind-aligned foam streak stretching at Force 7-8+.
- Wind-history hysteresis (Callaghan 2008): decaying seas keep foam longer — the standard accumulate-linearly/decay-exponentially foam buffer gives this for free; drive foam from the SAME lagged wind as the wind-sea layer.
- Hooks exist on both paths: FFT Jacobian foam (`DEFERRED_WORK.md:5256`) and water-mask `computeFoam` (`GlobeTerrain.wgsl:2239-2242`).

### 2e. Wind / jet streams / currents — field + visualization
- **Procedural fallback is the DEFAULT:** bake a curl-noise global wind texture with analytic zonal banding (trade easterlies, mid-lat westerlies, ~2 jet cores/hemisphere with seasonal offset) via a small compute pass into the SAME equirect format the flow field samples — zero data, deterministic (probe-friendly); real data becomes a drop-in same-format upgrade. Precedents in-tree: curl noise (`ProceduralClouds.wgsl:465`), compute bake (`CloudNoiseBake.wgsl`), procedural weather map (`WebGPUProceduralCloudRenderer.ts:1101`).
- **Jet streams = derived product, no new dataset:** same NOMADS grib-filter pipeline at `lev_250_mb` (UGRD/VGRD confirmed available). Model as layer 1 of a multi-layer field (layer 0 = 10 m surface wind for ocean/cloud coupling), rendered as a second altitude-banded flow-field particle population or isotach ribbons. Zero repo hits for "jet stream" — greenfield, but as flow-field preset instances, not a new renderer.
- **Currents:** same `WeatherSource`/flow-field interface; no in-tree source exists. Default = offline-decimated committed RTOFS-derived sample (US-gov PD, committable) or procedural gyres; OSCAR/Copernicus are user-supplied upgrade paths, never bundled (§4). Rivers' pre-designed per-tile flow vocabulary (`WATER_RENDERING_DESIGN.md:145-146, 208-209, 288-289, 859-865`) is the in-culture starting point for near-shore flow; global currents use the coarser equirect field.
- **Visualization:** the shipped GPU ping-pong advection already exceeds cambecc/earth and both Cesium wind-layer priors; the visible delta vs nullschool/windy is TRAILS (fade-accumulation target = NEW-FLOWFIELD-TRAILS) + speed-colored streamlines. Temporal interpolation = two velocity textures + mix factor in the advect Params UBO (unused slots exist, `FlowFieldAdvect.wgsl:26-37`) riding the WeatherTimeMode contract. Keep global advection on the lon/lat flow-field design, NOT the camera-box weather-particle frame (`WeatherParticles.wgsl:13-26`).
- **Offline preprocessor (`Tools/wind-data/`) is a first-class work item** — the only path to fresh GFS/RTOFS (no CORS on NOMADS) and the decimation path for heavy currents files.
- **Live data = LAST milestone:** NWS-MDL EDR CoverageJSON via existing `EdrWeatherSource` machinery (prototype endpoint, weak SLA — `WEATHER_DATA_INGEST_ROADMAP.md:87-93, 167`). UNCONFIRMED whether it serves UGRD/VGRD and at which levels — verify at NEW-FLOWFIELD-LIVE-EDR intake.

---

## 3. Toggle + perf integration

### 3a. Toggle matrix (every piece default-OFF, independently togglable, zero-cost-off)

| Toggle | Status | Mechanism | Off-cost |
|---|---|---|---|
| `weather.wind` (authority) | exists (extend) | pure JS state; gating lives per-consumer | zero by construction |
| `globe.water.ocean.enabled` | EXISTS | lazy create/destroy, probe-verified 0.0 (`GlobeWaterOcean.js:9-14,42-66`) | byte-identical |
| `ocean.waves.windResponse` | NEW | JS-only coupling flag; off = manual params, no listener | zero |
| Water-mask wind modulation | NEW | runtime tile-UB uniform, exact 0-contribution/neutral defaults when off; BOTH backends | ~zero (few ALU) |
| Sea-state mask | NEW | runtime uniform + optional small texture; lazy-alloc | zero when off |
| `FlowFieldWindLayer.show` (wind particles) | EXISTS | early-return before FR loader (`FlowFieldWindLayer.js:264-280`), 0.000% verified | byte-identical |
| `currents.enabled` | NEW | flow-field source lane (alias NEW-FLOWFIELD-OCEAN-CURRENTS) + runtime ocean advection uniform (0 when off) | zero |
| `jetStreams.enabled` | NEW | altitude-banded flow-field instances behind one flag; runtime-only | zero |
| Precipitation wind response | EXISTS | demand-gated `_enableWeather` (`WebGPUSceneRendererEnvironmentDemand.ts:58`) | existing |

**Define-bit policy:** the epic is designed to need ZERO new ShaderDefine bits. Registry is exhausted (bits 0-30 full; C11-149 define-width is the hard prereq for ANY new bit — `QUEUE_2026-07-18_CAMPAIGN11.md:383, 748-780`); the ratified escape is the C11-163 runtime-UBO-enable pattern (`:424, 1009`). Ocean-side terms ride OceanUniforms spare pads `_p0/_p1` or add-only UBO growth (C13 standing rule 7, `QUEUE_2026-07-23_CAMPAIGN13.md:298`). A hi-word define is justified only for a structurally different shader variant (e.g. vector-field-sampling spectrum), and only AFTER C11-149.

**Reusable off-gate contract (write into every seed row):** default OFF; off = zero textures, zero dispatches, lazy FR loader never invoked, byte-identical frame at the 0.0/0.000% probe bar; disable frees all GPU resources; WebGPU-only pieces documented WebGL no-op (Principle 2/10); runtime uniform flags, no new define bits; add-only UBO layouts in exact cache keys.

### 3b. Perf budget (all toggles ON): ≤2.0 ms GPU combined — proposed for ratification
Frame context: current WebGPU characterization ~12.18-12.53 ms/frame (`QUEUE_2026-07-23_CAMPAIGN13.md:699, 737`), ~4 ms headroom to 60 fps. Itemized:
- Wind-authority CPU propagation ≤0.05 ms (dirty-flag only, no hot-path allocation — C13 rule 8, `:300`)
- FFT ocean per-frame chain (time-spectrum + IFFT + merge, per cascade) ≤1.0 ms — external envelopes say 256² is well under 1 ms on this machine class (60 fps on a GTX 1050 Ti full chain), but the fork's actual number is UNCONFIRMED: **first perf task = gpuPassCost baseline**
- Flow-field particles ≤0.5 ms at default 65,536 (1 MB ×2 state); jet-stream instances share linearly under a documented cap
- Water-mask wind modulation ~0 incremental; currents/field texture uploads on-change only (WeatherProvider version-bump contract, `WeatherProvider.ts:16-17,80`)
- Cloud wind advection is budgeted by C13-12/13/18 — NOT double-budgeted here (`QUEUE C13:179`)

**On-change vs per-frame:** h0 re-bake only on rate-limited wind deltas (the split already exists in code — `WebGPUOceanRenderer.ts:367,720,778,793-794`); per-frame = existing time-evolve/IFFT/merge + a few uniform writes; transitions add one 256² pass per cascade per frame plus (calm↔storm only) temporary 2× during dual-spectrum cross-fade.

**Measurement story (reuse as-is):** `run-performance-campaign.mjs --workload moving-camera-altitude-track-3d --renderer both --repetitions 2`, counterbalanced, clean vs instrumented lanes separate (`DEBUGGING_GUIDE.md:1107-1146`); GPU attribution via `CesiumDebug.gpuPassCost(true)` (`:223,260-261,981`); per-toggle ON/OFF A/B + off-gate byte-identical probes in the probe-fft-ocean/probe-flowfield-wind form; honest-claims reporting (`QUEUE C13:308-310`). Idle-soak FPS invalid under request-render mode (CLAUDE.md).

**Demand gating:** ocean + flow-field emit ordinary geometry commands (ocean at Pass.OPAQUE, `DEFERRED_WORK.md:5260`) so `numFrustums>0` covers scheduling — no demand-module change expected. **OPEN (Phase W0 probe):** whether the animated FFT ocean keeps frames alive under requestRenderMode or freezes when idle — UNCONFIRMED; if it freezes it needs the C13-35 keep-alive treatment (`WebGPUSceneRendererEnvironmentDemand.ts:43-80`; `WebGPUContext.ts:1751-1757`) when enabled.

### 3c. Both-backends story (honest)
- FFT ocean WebGPU-only is RATIFIED additive (`GlobeWaterOcean.js:13-14`; WebGL2 fallback tracked as NEW-FFT-OCEAN-WEBGL2-FALLBACK, dli/waves MIT proves feasibility — `DEFERRED_WORK.md:5256`). The C11 maintainer-ratified governing principle distinguishes additive WebGPU (fine) from parity items.
- MUST be both backends (Principle 5): wind-authority state (backend-agnostic Scene JS — automatic); water-mask wind modulation (shared GlobeFS.glsl/GlobeTerrain.wgsl region — same region as C11-172/158).
- Flow-field WebGL parity stays optional-tracked (NEW-FLOWFIELD-WEBGL-PARITY); the layer is a documented WebGL no-op today, so the debt is already acknowledged.

---

## 4. Licence table (verbatim from primary sources; project culture: CC BY-NC and paid = DISQUALIFIED for bundling; streaming terms noted separately)

| Source | Verbatim licence evidence | Verdict |
|---|---|---|
| NOAA GFS wind / RTOFS currents (NWS) | "The information on National Weather Service (NWS) Web pages are in the public domain, unless specifically noted otherwise, and may be used without charge for any lawful purpose so long as you do not: 1) claim it is your own..., 2) use it in a manner that implies an endorsement or affiliation with NOAA/NWS, or 3) modify its content and then present it as official government material." (weather.gov/disclaimer, fetched 2026-07-24) | **BUNDLE-OK** (US-gov PD; the shipped wind sample is already this) |
| ECMWF open-data real-time forecasts | CC-BY-4.0; "the data may be redistributed and used commercially, subject to appropriate attribution" (ecmwf.int/en/forecasts/datasets/open-data) | **BUNDLE-OK with attribution** (`WeatherField.attribution` exists) |
| ERA5 (CDS) | Bespoke Copernicus licence replaced by CC-BY-4.0 effective 2025-07-02 (forum.ecmwf.int/t/13464) | **BUNDLE-OK with attribution**; STREAM note: registration required, ~5-day latency |
| Copernicus Marine (currents) | "This Licence is granted free of charge"; redistribution allowed with credit "Generated using E.U. Copernicus Marine Service Information"; personal non-transferable logins mandatory | **STREAM-ONLY / user-supplied** (registration-gated; never bundled) |
| OSCAR v2 (PO.DAAC) | No explicit licence statement on dataset page (points to PO.DAAC citation policy); Earthdata Login REQUIRED; FINAL record ends 2022-08-05, NRT variant UNCONFIRMED | **STREAM-ONLY / user-supplied**; verify NRT at W4 intake |
| MERRA-2 (NASA) | NASA policy: "full and open sharing of Earth science data... There will be no period of exclusive access"; per-dataset wording UNCONFIRMED; Earthdata Login | **Deprioritize** — documented user-supplied option only (worse than ERA5 for every mode) |
| Crest (wave-harmonic) | "MIT License / Copyright (c) 2019 Wave Harmonic and contributors / Permission is hereby granted, free of charge, to any person obtaining a copy" (LICENSE, fetched) | **BUNDLE-OK** (code portable with attribution) |
| GodotOceanWaves | "MIT License / Copyright (c) 2024 Ethan Truong" (LICENSE, fetched) | **BUNDLE-OK** (TMA+Horvath GLSL portable) |
| gpuocean (SINTEF) | GNU GPL v3.0-or-later | **DISQUALIFIED** for code bundling (copyleft); techniques/domain reference only |
| cambecc/earth | MIT, "Copyright (c) 2014 Cameron Beccarino" (GitHub licence API) | **BUNDLE-OK** (technique reference; our GPU path already exceeds it) |
| RaymanNg/3D-Wind-Field | MIT (c) 2019 (GitHub licence API; already credited in FlowFieldAdvect.wgsl header) | **BUNDLE-OK** |
| hongfaqiu/cesium-wind-layer | MIT (c) 2024 Hongfa Qiu | **BUNDLE-OK** |
| mapbox/webgl-wind | ISC (prior in-repo verification, RESEARCH_REGISTER:84) | **BUNDLE-OK** |
| windy.com | Proprietary | **DISQUALIFIED** — technique reference only |
| Horizon Forbidden West (SIGGRAPH 2022 Advances PDF) | Published talk; no code | Reference-only; wrong model for open-ocean wind response (baked shoreline flipbooks) |
| Sea of Thieves (SIGGRAPH 2018) | Talk paywalled; implementation details conflict across secondary sources | **UNCONFIRMED — do not cite specifics in the design** |
| Already verified in-repo (no re-verification needed) | gasgiant/FFT-Ocean, Popov72/OceanDemo, WebTide, dli/waves all MIT; EncinoWaves Apache-2.0; Tessendorf notes = published math, derive-don't-copy (`RESEARCH_REGISTER_2026-07-06.md:147`; `DEFERRED_WORK.md:5256`) | BUNDLE-OK per prior verification |

---

## 5. Epic structure proposal

**Campaign placement: NEW EPIC — candidate Campaign 14 "Dynamic Ocean & Wind".** Not a C13 insert (C13 is ratified clouds-only) and not a C11 row (paused). Same conclusion the tides doc reached for the same code region (`TIDES_FEASIBILITY_2026-07-24.md:62-71`). **File the seed in DEFERRED_WORK now; launch after C13-GATE-D** (`QUEUE C13:85,642`) so the weather-tile wind schema Level 1 consumes is settled, not guessed.

**Hard prereqs:** (1) **C11-172** wave-octave LOD (S, C11 W4 with C11-158) — build on, don't re-plan; (2) **C6-FFT-OCEAN-CLIPMAP** — the "waves everywhere" gate (today's patch is 3 km, low-altitude only, `DEFERRED_WORK.md:5256` follow-up 3); (3) **C13-14** — prereq for W5/Level-1 vector wind ONLY (Level 0 has no C13 dependency); (4) **C11-149** — NOT a prereq under the zero-new-define-bits design; becomes one only if a structural shader variant is ratified.
**Coordination (not prereqs):** C11-158 owns the water-default parity decision — this epic must not flip water defaults; tides Design A shares the OceanSurfacePrimitive anchor/uniform carrier and the datum probe — land anchor/datum plumbing once for both (`TIDES doc:28,72`).

**Phases (effort classes; each row carries the §3a off-gate contract):**
- **W0 — Contracts + Baselines (S-M):** ENU wind representation contract (see decision (a)); gpuPassCost baselines for FFT ocean + flow-field; ocean requestRenderMode frame-demand probe; ocean-lid datum probe shared with tides. Probe-first per Principle 8.
- **W1 — Wind Authority Level 0 (M):** facade fan-out to ocean behind `ocean.waves.windResponse`; missing live `GlobeWaterOcean.windDirection` (+amplitude/choppiness) setters; spectrum re-bake rate-limit + cross-blend; §5-surface overrides; off-gate probes. Both-backend by construction (Scene JS).
- **W2 — Water-mask wind modulation (M, BOTH backends):** tile-UB `windParams` (oceanParams pattern, "0 = default" sentinels); scroll-velocity rotation, strength scaling, anisotropic stretch, Beaufort foam threshold; layers over C11-172; GLSL mirror or neutral-at-default per §1e; coordinates with paused C11-158.
- **W3 — Coverage + Sea State (XL, multi-batch):** C6-FFT-OCEAN-CLIPMAP (+ WATERMASK-SEAM) — the waves-everywhere gate; JONSWAP/TMA/Horvath two-layer spectrum (wind-sea slaved to lagged wind + persistent swell); sea-state mask (spatial randomness + gust patchiness); Jacobian foam with accumulate/decay + wind-aligned streaks; ocean quality-tier axis (NEW).
- **W4 — Currents + Jet Streams + Field Tooling (L):** `Tools/wind-data` offline preprocessor (GFS 10 m + 250 hPa jets layer + RTOFS decimation); procedural curl-noise/jet-band/gyre baked fields as DEFAULT source; flow-field lanes absorbing NEW-FLOWFIELD-OCEAN-CURRENTS / -TRAILS with IDs retained as aliases (C13 §5 transfer-map precedent, `QUEUE C13:314`); jet streams as altitude-banded flow-field presets; currents-advection uniform on ocean shading.
- **W5 — Vector Wind Field Level 1 (L, gated on C13-14):** `VelocityFieldSource` in Scene/Weather + wind tile channel; temporal frame interpolation; ONE shared WGSL/JS sampling helper consumed by clouds, ocean, particles; NEW-FLOWFIELD-LIVE-EDR last (verify UGRD/VGRD availability at intake); NEW-FLOWFIELD-WEBGL-PARITY remains optional-tracked tail.

---

## 6. Maintainer decisions (genuine ones only)

1. **Wind representation contract home:** land the ENU contract as a rider on C13-18 (clouds + this epic agree from day one; C13-18 is NOT STARTED so no rework) vs a standalone doc both consume. **Recommend: C13-18 rider** — re-homing cloud wind twice violates one-concern-per-landing.
2. **Jet streams scope:** visualization-only (flow-field layers) vs also physically modulating high cloud-deck advection — the latter crosses into C13-18/19 ownership and needs C13 sign-off. **Recommend: visualization-only in this epic; cloud coupling deferred to C13.**
3. **Currents data source for W4:** RTOFS (PD, but wgrib2js lat-decode gap + 40-156 MB files needing offline decimation) vs procedural gyres default with OSCAR/Copernicus as login-gated user-supplied paths. **Recommend: procedural gyres default + RTOFS-derived committed sample; never bundle OSCAR/Copernicus.**
4. **Ratify the ≤2.0 ms all-on GPU budget** and its split (§3b), pending the W0 gpuPassCost baseline.
5. **Campaign 14 launch timing:** after C13-GATE-D as recommended, vs earlier launch of the C13-independent phases (W0-W2 have no C13 dependency) if ocean priority rises.
6. **Ocean quality-tier axis:** confirm adding cascade-count/N/patch-extent tiers (new axis, W3) vs keeping single-quality v1 through the epic.


### §6a Maintainer rulings (2026-07-24, all six answered — recorded at Batch 758)

1. **O1 RATIFIED:** ENU wind contract lands as the C13-18 rider (now single-owner: the orchestrator owns C13 per the global Sol ruling).
2. **O2 OVERRULED (scope expansion):** jet streams are NOT visualization-only — a **rough low-LOD physical field must also feed other systems, clouds first** (coarse jet-stream advection input to the cloud decks). Cross-campaign coordination is moot under single C13 ownership; the W4 row gains the coarse-coupling deliverable, with the fidelity bar explicitly "rough/low-LOD".
3. **O3 RATIFIED:** procedural gyres default + committed RTOFS-derived sample; never bundle OSCAR/Copernicus.
4. **O4 RATIFIED:** ≤2.0 ms all-on budget provisionally, pending the W0 baseline; the maintainer notes this lane is lower priority and can proceed asynchronously.
5. **O5 RULED (stricter than the recommendation):** **Campaign 14 launches only after Campaigns 11, 12, AND 13 are done** — not merely after C13-GATE-D. W0-W2's C13-independence does not accelerate the launch.
6. **O6 RATIFIED with door open:** single-quality v1; the tier axis may be added later if performance demands — design W3 so the axis can be introduced without rework (no hardcoded single-quality assumptions in the uniform/config surface).

---
**UNCONFIRMED register (carried into phase intakes):** fork FFT-ocean actual GPU ms (W0 baseline); FFT-ocean requestRenderMode keep-alive behavior (W0 probe); Cesium-World-Terrain ocean-lid datum — **CONFIRMED GEOID (Batch 759, probe-ocean-datum: RMS 3.7 m vs EGM2008; FFT patch +101.6 m above the baked sea at high-undulation coasts; exaggeration displaces the lid)**; NWS-MDL EDR UGRD/VGRD parameter/level availability (W5 intake); OSCAR NRT variant existence + terms (W4 intake); MERRA-2 per-dataset licence wording (deprioritized).

*Session note for the orchestrator: the claude.ai Google Drive MCP connector remains unauthorized (needs authorization via claude.ai connector settings); nothing in this task required it.*