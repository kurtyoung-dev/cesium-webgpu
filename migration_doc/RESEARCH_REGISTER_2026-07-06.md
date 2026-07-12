# Research Register — Campaign 7 (2026-07-06)

**Purpose:** Single consolidated index of the 10 read-only research lanes that ran concurrently during Campaign 7 (queue: [`QUEUE_2026-07-06_CAMPAIGN7.md`](QUEUE_2026-07-06_CAMPAIGN7.md)). Each lane produced a full standalone report (scratchpad `RESEARCH_*.md`, path in each section); this register distills the **license verdict, key findings, recommendation, and the rows each lane informs** so future campaigns don't have to re-open the scratchpad to scope the work. Where a lane's implementation has since shipped or been formally deferred, the "Informs" line points at the live `DEFERRED_WORK.md` / `FEATURE_INVENTORY.md` entry that superseded the research.

**Provenance note:** these are license-and-technique due-diligence lanes — every "CLEAR/BLOCKED" verdict below was verified against the authoritative `LICENSE` file (GitHub API / raw fetch) at research time and, for the reproduced verdicts, re-verified during the 2026-07-10/11 verify passes recorded in each report. **No runtime code was written by this register task** — it is a doc-only Campaign-7 close-out.

**Lane roster (10):**

| Lane | Topic | License verdict | Status of the consumer work |
|---|---|---|---|
| R-STBN | Spatiotemporal blue noise for cloud jitter + TPDF dither | NVIDIA STBN **BLOCKED** (non-commercial); EA FastNoise **CLEAR** (BSD-3) | C6-CLOUD-STBN-TAAU LOD-half SHIPPED; STBN-texture half **DEFERRED on offline asset** |
| R-LTC | LTC area-light LUT provenance + WGSL integration | **CLEAR** (BSD-3-style + citation) | C6-LTC-AREA-LIGHTS v1 **SHIPPED**; 5 follow-ups open |
| R-WIND-DATA | Live global wind/current data for flow-field particles | **CLEAR** (NOAA public domain; mapbox ISC) | C6-FLOWFIELD-WIND **SHIPPED** (bundled GFS sample); live/ocean deferred |
| R-SSGI | SSGI algorithm selection on existing MRT+TAA | **CLEAR** (three.js / SSRT3 MIT) | C6-SSGI-DIFFUSE **SHIPPED**; quality + WebGL-twin deferred |
| R-FFT-OCEAN | FFT spectral ocean spectrum/cascade/FFT refs | **CLEAR** (gasgiant/WebTide/Popov72 MIT); iamyoukou/codeagent **BLOCKED** (no license) | C6-FFT-OCEAN v1 **SHIPPED**; 7 follow-ups open |
| R-FSR2 | FSR2 WGSL port scope + license | **CLEAR** (AMD MIT, v2.2.2) | C6-FSR2-UPSCALE **DEFERRED** (6–10 day / 4-phase epic) |
| R-VEGETATION | GPU vegetation scatter SOTA + CC0 starter assets | **CLEAR** (Quaternius/PolyHaven/Kenney CC0) | NEW-VEGETATION-SYSTEM V1 (FUTURE, design complete) |
| R-IMPOSTOR | Octahedral impostor for VOLUMETRIC clouds | **CLEAR** clean-room (mapping math in-repo Apache-2.0); ImpostorBaker/Amplify/NVIDIA-STBN **BLOCKED** | C7-CLOUD-IMPOSTOR-LOD (FUTURE, 2-phase design) |
| R-LAKE-SRTMSWBD | SRTMSWBD V003 raster → lake water-mask v2 | **CLEAR** (NASA EOSDIS CC0/public-domain) | lake-mask v2 (v1 C7-LAKE-WATER-MASK SHIPPED; v2 tracked) |
| R-MARS-ATMO | Multi-body atmosphere parameterization (Mars first) | **CLEAR** (Bruneton BSD-3 / Hillaire MIT / Takram stack; params are unprotectable facts) | FUT-MULTI-BODY-ATMOSPHERE (FUTURE, no code) |

No lane produced a null/failed result — all 10 scratchpad reports are complete. (R-MARS-ATMO was omitted from the orchestrator's injected result payload but its report exists and was consolidated here directly from the doc.)

---

## R-STBN — Spatiotemporal blue noise (cloud TAAU jitter + final-composite TPDF dither)

**Report:** `scratchpad/RESEARCH_R-STBN_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` → **C6-CLOUD-STBN-TAAU** (LOD half SHIPPED Batch 634; STBN-texture jitter/TAAU half DEFERRED on offline asset generation) and **C6-TPDF-DITHER-FINAL**.

### License verdict
- **NVIDIA STBN SDK** (`github.com/NVIDIA-RTX/STBN`) — **BLOCKED.** Verbatim "Non-Commercial Use License" §3.3 restricts use to "research or evaluation purposes only" and §3.1 forces same-license redistribution — incompatible with this Apache-2.0 fork (and MIT). The shipped textures AND the generator are poisoned; blog/Shadertoy mirrors of those PNGs are equally poisoned.
- **EA SEED FastNoise** (`github.com/electronicarts/fastnoise`) — **CLEAR.** BSD-3-Clause (verbatim in report). Requires notice retention in `LICENSE.md`'s Third-Party appendix.
- **Christoph Peters blue noise** (momentsingraphics.de) — CC0, but 2D-only (no temporal slices) → not usable for STBN.

### Key findings
- EA FastNoise is not just license-clean but technically superior: it implements FAST (Donnelly/Wolfe/Bütepage/Valdés, i3D 2024, DOI 10.1145/3651283), which optimizes noise against the exact downstream filter pair — including the **exponential temporal EMA** matching our cloud `temporalUpdateFraction = 1/8`. Ships a Windows `FastNoise.exe` + 198 MB pregenerated BSD-3 textures.
- **Recommended asset:** one `rgba8unorm` `texture_2d_array`, 128×128 × 64 slices (4.0 MiB GPU, no mips); R = scalar STBN (march-start offset), G/B = vector2 STBN (sub-pixel jitter), A = scalar STBN #2 (cone jitter/TPDF). Ship as a single 1024×1024 RGBA PNG atlas (8×8 grid, ~3–4 MB), lazy-loaded only when the flag is on.
- **Biggest visual win** = the currently-missing per-pixel **march-start dither** (`t = tStart + n.r*fineStep`). `ProceduralClouds.wgsl` today uses a 4×4 ordered BAYER4 LUT for half-res sub-pixel jitter, hash33 cone jitter, and NO march-start dither. `CloudTemporalResolve.wgsl` needs zero changes (its 3×3 neighborhood clamp improves with STBN input).
- WGSL: `textureLoad(stbnTex, vec2<i32>(pix % 128u), i32(frame % 64u), 0)` (no sampler). Extend the JS frameCounter wrap `&15 → &63` (legacy Bayer `&15u` of 0..63 cycles identically → byte-identical when off). Gate on reserved `QF_JITTER` bit 3, keeping the Bayer branch verbatim as the else/loading fallback (self-healing, same convention as the temporal-history fallback).
- **TPDF dither** (C6-TPDF-DITHER-FINAL): use pure `pcg2d` hash math (NOT the STBN texture) → `(u1-u2)` triangular in (−1,1) scaled by 1/255, applied in output-referred space in whichever pass writes the `bgra8unorm` canvas. Zero deps, no bind-group fork. Mirror the ~10 lines in the WebGL GLSL tonemap for parity (Principle 5).
- **ImageBitmap pitfall:** decode with `colorSpaceConversion:'none'`, `premultiplyAlpha:'none'`, `rgba8unorm` (never `-srgb`), FastNoise "uniform" distribution (PNG) not "gauss" (.hdr).
- Current cloud stack is temporal-accumulation + bilateral upscale, **not true TAAU** — STBN jitter is the prerequisite for a full-res-history TAAU rewrite (track that separately per Principle 9).

### Recommendation
Reject NVIDIA assets. Generate our own STBN with EA FastNoise (fixed seeds, exponential-EMA filter params matching `temporalUpdateFraction=1/8`), pack R/GB/A into one 128×128×64 `rgba8unorm` array shipped as a 1024×1024 PNG atlas, add the EA copyright to `LICENSE.md`. Wire behind `QF_JITTER` (default off, byte-identical), keep Bayer as the fallback. Keep the composite TPDF dither as pure `pcg2d` hash math in both WGSL and GLSL.

### Sources
NVIDIA STBN SDK license; EA SEED FastNoise (BSD-3) + noise.zip; FAST i3D 2024 (DOI 10.1145/3651283); Christoph Peters / momentsingraphics.de (CC0). Fork files: `ProceduralClouds.wgsl`, `CloudTemporalResolve.wgsl`, `CloudUpscale.wgsl`, `WebGPUProceduralCloudRenderer.ts`, `PostProcess/Tonemapping.wgsl`, `LICENSE.md`.

---

## R-LTC — Linearly-transformed cosines (area-light LUT) provenance + WGSL integration

**Report:** `scratchpad/RESEARCH_R-LTC_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` → **C6-LTC-AREA-LIGHTS** (v1 SHIPPED 2026-07-10) + its 5 open follow-ups (primitive Lit call sites, line lights, textured emitters, area-light clustering, WebGL2 port).

### License verdict
**CLEAR** — `github.com/selfshadow/ltc_code` LICENSE is a BSD-3-Clause-shaped permissive license, © 2017 Heitz/Dupuy/Hill/Neubelt; the no-endorsement clause is replaced by a paper-citation request (so GitHub reports Other/NOASSERTION). Redistribution + modification permitted. Obligations: verbatim notice in `LICENSE.md` + cite SIGGRAPH 2016 paper in adapted source. Covers both reference code AND the fitted LUT data (`fit/results/*`). Do NOT use the paper-page/Google-Drive demo download (license-unstated) — repo only.

### Key findings
- LUTs are two 64×64 RGBA tables (N=64), shipped as `ltc_1.dds`/`ltc_2.dds` = 32,896 B each = 128 B header + 64·64·8 B of `R16G16B16A16_FLOAT`, plus fp32 copies in `ltc.js`. Packing: tex1 = 4 free terms of `inverse(M)/M[1][1]`; tex2 = (GGX magnitude, avg Schlick Fresnel, unused, horizon-clipped-sphere solid angle). UV = `vec2(perceptualRoughness, sqrt(1-NdotV)) * 63/64 + 0.5/64`.
- Use **`rgba16float`** for WebGPU (core, filterable); `rgba32float` needs the optional `float32-filterable` feature and isn't worth it (reference DDS is already fp16). Recommend **ONE `texture_2d_array` 64×64×2** (layer0=ltc_1, layer1=ltc_2) → +1 sampled-texture binding. Must use `textureSampleLevel` (not `textureSample`) inside the per-light loop or WGSL uniformity validation fails.
- Reference repo covers rect (edge-integral + 16-case horizon clip + clipless approx), disk (SolveCubic ellipse + sphere table `t2.w`), and line lights. **Textured emitters are NOT in the repo** (only in the license-unstated demo) → clean-room or defer.
- **v1 scope:** rect + disk, one/two-sided, untextured.
- **Fork integration (verified):** don't widen the 80 B `ClusteredLight` struct or touch `ClusterAssign.wgsl`. Add a parallel 96 B-stride `LTCAreaLight` storage buffer (MAX 8, no clustering v1), carry `areaLightCount` in the documented-unused `ClusteredParams.activeLightCount.y`, append group-3 effects bindings 23 (LUT array texture) / 24 (sampler) / 25 (areaLights) next to existing 18..22, extend the `ClusteredLighting.wgsl` chunk (rides `__CL_GROUP__` into Model PBR + 21 Mat*Lit consumers), add `LightType.RECT_AREA=3` / `DISK_AREA=4` + classes to `Scene/LightTypes.ts` with legacy `pack()` skipping them. Default path byte-identical with zero area lights.
- **Energy conservation:** the LTC integral already contains cos, solid angle, and 1/π — no extra NdotL and NO 1/d² attenuation (intensity = emitter radiance; range is cull-only). Specular combine = `ltc * (F0*t2.x + (1-F0)*t2.y)`; diffuse uses identity `Minv`. Both LTC and our punctual GGX are single-scatter → parity preserved.
- **Pitfalls:** `textureSampleLevel`-only in loops; half-texel LUT bias; `Minv` column order; clipless path's second (z,len) fetch into `t2.w`; `maxBindGroups=4` on Chromium-Windows (extend group 3, never add group 4); audit `maxSampledTexturesPerShaderStage=16` in the worst Model PBR pipeline before landing.

### Recommendation
GO — implement rect + disk area lights v1 as a parallel area-light list beside the clustered punctual path (base64-embedded fp16 64×64×2 `rgba16float` LUT array texture, group-3 bindings 23–25, count in `ClusteredParams.activeLightCount.y`, WGSL helpers in `ClusteredLighting.wgsl`), default byte-identical. Ship verbatim notice in `LICENSE.md` + paper citation. Defer line lights, area-light clustering, textured emitters (clean-room), WebGL port. **(This shipped as C6-LTC-AREA-LIGHTS v1 on 2026-07-10.)**

### Sources
`github.com/selfshadow/ltc_code` (code + LUTs); Heitz et al. SIGGRAPH 2016 "Real-Time Polygonal-Light Shading with Linearly Transformed Cosines". Fork files: `chunks/structs/ClusteredLighting.wgsl`, `WebGPUClusteredLightingBGL.ts`, `WebGPUClusteredLightingDispatcher.ts`, `WebGPUSceneRendererClusteredLighting.ts`, `WebGPUEffectsBindGroup.js`, `Scene/LightTypes.ts`.

---

## R-WIND-DATA — License-clean live global wind/current data (flow-field particle layer)

**Report:** `scratchpad/RESEARCH_R-WIND-DATA_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` → **C6-FLOWFIELD-WIND** (SHIPPED 2026-07-10, bundled GFS sample) + follow-ups `NEW-FLOWFIELD-LIVE-EDR`, `NEW-FLOWFIELD-OCEAN-CURRENTS`, `NEW-FLOWFIELD-TRAILS`, `NEW-FLOWFIELD-WEBGL-PARITY`.

### License verdict
**CLEAN.** NOAA GFS + RTOFS via NOMADS = US-Government **public domain** (weather.gov/disclaimer, verbatim: "information on National Weather Service Web pages are in the public domain… may be used without charge for any lawful purpose"). mapbox/webgl-wind = ISC. cambecc/earth, RaymanNg/3D-Wind-Field, hypatia-earth/zero, wgrib2js, pngjs = MIT (verified). OSCAR v2 = openly shared without restriction (EOSDIS) but download needs a free Earthdata Login. The bundled sample is public-domain data processed by our own script with attribution embedded — clean to commit.

### Key findings
- **CRITICAL:** NOMADS OpenDAP/GrADS subsetting was **RETIRED 2026-02-23** (SCN 25-81, live-confirmed the `/dods` endpoint returns a retirement page). Supported paths are the grib-filter CGI + raw HTTPS. Grib-filter live-tested working (global 10 m UGRD+VGRD: 1.92 MB at 0.25°, 158 KB at 1.0°).
- NOMADS sends **no CORS header** (verified) → browser fetch impossible → the answer is an offline `Tools/wind-data` preprocessor + committed static PNG sample.
- mapbox/webgl-wind (ISC) encoding fully reverse-engineered: RGBA PNG with R = 255·(u−uMin)/(uMax−uMin), G = same for v, row 0 = north, + JSON sidecar `{source,date,width,height,uMin,uMax,vMin,vMax}`.
- **Empirically validated** pure-JS decode: `wgrib2js` (MIT, npm) parsed real GFS grib output; cross-checked 1.0° vs 0.25° at 65,160 shared coords, max delta 0.009 m/s → correct complex-packing decode, no ecCodes/Java needed.
- **Sample already generated + validated:** `scratchpad/windtest/gfs-wind-sample.png` (89 KB, 360×181, live 2026-07-09 00z GFS analysis, visibly shows trade winds/jets/a cyclone) + JSON sidecar + ~50-line `make-sample.mjs`. (This shipped as `Apps/SampleData/wind/gfs-wind-sample.png`.)
- **Ocean currents = stretch tier:** RTOFS is public-domain + anonymous but heavy (155.8 MB global NetCDF / 40.5 MB regional GRIB2 per step); `wgrib2js` garbles its latitudes (grid-template gap). OSCAR v2 is unrestricted but needs Earthdata Login → not anonymously fetchable.
- **Roadmap alignment:** cloud `weatherTex` channels (R/G/B/A all claimed by cloud semantics) are the WRONG texture for wind — add a `VelocityFieldSource` sibling in `Scene/Weather/` reusing `WeatherProvider`'s time model, `WeatherField.attribution`, same-origin-proxy stance, and `CoverageJsonParser`. Future LIVE path = the already-tracked NWS-MDL EDR CoverageJSON endpoint.

### Recommendation
Bundle the generated GFS sample (mapbox-format, 89 KB, public-domain w/ embedded attribution) under `Apps/SampleData/wind/`; ship a dev-time `Tools/wind-data/fetch-gfs-wind.mjs` (grib-filter → `wgrib2js` → PNG+sidecar) instead of any live browser fetch. Implement the layer as a backend-agnostic `FlowFieldLayer` + `FeatureRendererKey.FLOW_FIELD` with a `PngVelocitySource`. Defer LIVE ingest to the EDR CoverageJSON path and ocean currents as named Principle-9 follow-ups. Pitfalls: antimeridian wrap (repeat in U), row-0=north / VGRD sign, u/cos(lat) pole correction, 181-not-180 rows, 8-bit quantization is fine.

### Sources
weather.gov/disclaimer; NOMADS grib-filter; mapbox/webgl-wind (ISC); cambecc/earth (MIT); RaymanNg/3D-Wind-Field (MIT); wgrib2js (MIT); OSCAR v2 (EOSDIS, DOI 10.5067/OSCAR-25F20). Artifacts: `scratchpad/windtest/*`.

---

## R-SSGI — SSGI algorithm selection (existing depth+normal+color MRT + TAA history)

**Report:** `scratchpad/RESEARCH_R-SSGI_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` → **C6-SSGI-DIFFUSE** (SHIPPED, WebGPU-only) + DEFERRED-1 (grazing-angle banding quality) + DEFERRED-2 (`C6-SSGI-DIFFUSE-GLSL` WebGL twin, FEATURE_INVENTORY §D.7).

### License verdict
**CLEAR** — three.js MIT (© 2010-2026 three.js authors, covers `SSGINode.js`), 0beqz/realism-effects MIT (© 2023 0beqz), cdrinmatane/SSRT3 MIT (© 2024 CDRIN); all verified verbatim. Attribution + MIT notice required in ported file headers, citing Therrien et al. 2023. **BLOCKED:** UE5 Lumen (EULA), three-rc (author refuses to license), Pascal Gilcher RTGI (proprietary), LYGIA (Prosperity).

### Key findings
- **RECOMMENDED: SSILVB** — horizon-slice visibility-bitmask SSGI (Therrien/Levesque/Gilet 2023, arXiv:2301.11376), the exact algorithm three.js `SSGINode` ships. Structural superset of our shipped `GTAOGenerate.wgsl` (~70% WGSL reuse: same slice/step scan, `pixelToEye`, `logDepthReverse`, random rotation). Delta = replace the two horizon cosines with a 32-bit sector bitfield (`countOneBits` is core WGSL) + accumulate scene-color radiance per newly-occluded sector, weighted by receiver AND emitter cosines with a luminance-7.0 firefly clamp. One pass yields BOTH improved AO (thin-surface fix) and diffuse GI — it **replaces** GTAO output, doesn't stack.
- **Rejected:** stochastic short-range SSRT-GI (1 spp needs a dedicated GI temporal-accumulation + Poisson/à-trous denoiser; our TAA's 3×3 clamp would clamp away raw stochastic GI; requestRenderMode freezes leave frozen grain). Screen-space probes / radiance cascades (3–5× lift, no permissive reference, weakest at short-range contact bleed). Kept as "watch" (tech-mine #4).
- **Denoising temporal-first is nearly free:** SSGI occupies the existing AO slot (pipeline stage 1) so the existing TAA (stage 4, linear HDR, RTE-safe) integrates the 6-angle × 4-offset Activision temporal rotation. Low-frequency GI survives TAA's AABB clamp (stochastic noise would not). Add ONE 5-tap separable bilateral blur at half-res; escalate to 2-iteration à-trous only on probe evidence. Do NOT build a dedicated GI history buffer.
- **Resolution:** generate at half-res into `rgba16float` (GI.rgb + AO.a), joint-bilateral (depth+normal) upsample fused into the composite. Composite: `sceneColor*ao + gi*giIntensity` (no albedo buffer — lit-color proxy, documented limitation).
- **Planet-scale pitfalls w/ mitigations:** reuse `readDepth`/`logDepthReverse` verbatim; screen-space-proportional radius with `maxWorldRadius` cap ~500 m + altitude fade (orbit → no-op); sky-leak guard (`-z >= far*0.99` neither occludes nor emits); linear thickness `max(1m, 0.005*viewZ)`; all math eye-space (no RTE hazard); f32-only generate.
- **Starting params:** sliceCount 2, stepCount 8, sectorCount 32, expFactor 2.0, radiusPixels ~32 @half-res, thickness 1 m + K=0.005, giIntensity start 1.0 (sweep 1–10 on probe), aoIntensity 1.0, luminanceClamp 7.0, default DISABLED. Budget ~0.6–1.2 ms @1080p half-res.

### Recommendation
Implement SSILVB visibility-bitmask SSGI as an extension of the GTAO pass (`AOAlgorithm 'ssgi'`), half-res `rgba16float` GI+AO with joint-bilateral upsample, denoised by existing TAA + one bilateral blur, default-off, WebGPU-only initially. New `SSGIGenerate.wgsl` / `BilateralBlur1D.wgsl` / `SSGIComposite.wgsl`. **(Shipped as C6-SSGI-DIFFUSE.)**

### Sources
three.js `SSGINode.js` (MIT); cdrinmatane/SSRT3 (MIT); 0beqz/realism-effects (MIT); Therrien/Levesque/Gilet 2023 arXiv:2301.11376. Fork files: `GTAOGenerate.wgsl`, `GBufferNormalsFromDepth.wgsl`, `WebGPUAmbientOcclusionEffect`, `TAA.wgsl`.

---

## R-FFT-OCEAN — FFT spectral ocean (spectrum / cascades / WGSL FFT refs / RTE tiling / reflect-refract contract)

**Report:** `scratchpad/RESEARCH_R-FFT-OCEAN_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` → **C6-FFT-OCEAN** (v1 SHIPPED 2026-07-11) + 7 follow-ups (JONSWAP-TMA, cascades, clipmap, spectral normals, water-mask seam, `C6-PLANAR-REFLECT-REFRACT` #20, WebGL2 fallback).

### License verdict
**CLEAN** — multiple independently re-verified MIT sources: WebTide (© 2024 Paleologue), gasgiant/FFT-Ocean (© 2020 Pensionerov), Popov72/OceanDemo, 2Retr0/GodotOceanWaves (© 2024 Truong, incl. its OTFFT MIT attribution), dli/waves (© 2014 Li), jbouny/fft-ocean, GarrettGunnell/Water. EncinoWaves = Apache-2.0 (usable; prefer derive-from-paper to avoid NOTICE obligations). **BLOCKED:** iamyoukou/fftWater and codeagent/webgl-ocean have **no license file** (all rights reserved — reference-reading only, no code porting). Papers (Tessendorf, Horvath 2015) are derive-from-math.

### Key findings
- **Spectrum:** JONSWAP + TMA (Kitaigorodskii) depth attenuation + Horvath-2015 directional spreading (Longuet-Higgins `cos^2s(θ/2)` + swell parameter ξ + spreadBlend). γ=3.3, finite-depth dispersion `ω=√(gk·tanh(kD))`. Phillips kept only as debug preset. Two spectrum layers per cascade (wind sea + swell).
- **Cascades:** 3 × 256×256 (optional 4th ~1024–2048 m swell cascade, default off), hard-partitioned in k-space using gasgiant's L={250,17,5} m with cutoffs so no wavelength lives in two cascades; avoid integer L ratios. Outputs `rgba16float` (WebGPU core can't FILTER float32 without the optional feature — real pitfall); FFT intermediates `rg32float` via `textureLoad`. ~25 MB at 4 cascades.
- **FFT algorithm:** v1 = radix-2 Cooley-Tukey with precomputed twiddle+index texture + ping-pong (WebTide WGSL / gasgiant HLSL). Phase-2 = Stockham shared-memory one-workgroup-per-row (2Retr0/OTFFT) — fits WebGPU defaults at N=256 (256 invocations, 4 KB shared; the Godot kernel's `workgroup_size 1024` exceeds default `maxComputeInvocationsPerWorkgroup=256`). **No push constants** in WebGPU → dynamic-offset UBO. Hermitian 2-for-1 packing halves FFT count; `(-1)^(x+y)` sign/permutation fix mandatory; quantize ω to `2π/T` for an exactly periodic wrap-safe clock. **Validate FFT sign conventions against a tiny CPU DFT** — WebTide self-admits an uncertain minus sign.
- **Foam/normals:** all derivatives spectral (`ik` multiply), never finite-difference; chop-corrected normal; Jacobian `J=(1+λDxx)(1+λDzz)−λ²Dxz²`, inject foam where `J<μ` (~0.5) into a `read_write` turbulence texture with frame-rate-independent exponential decay; LEADR slope-variance→roughness on mips.
- **Ellipsoid tiling:** camera-anchored local-ENU planar clipmap rings, RTE/RTC positioned (positionHigh/Low + `mvpRelativeToEye`, Batch-350 RTC pattern), world-anchored UVs, anchor snapped to L0 multiples on rebase, curvature drop `−d²/2R` on far rings (3.1 km at 200 km — mandatory), `CameraUniforms` ends with `previousViewProjection` (DP-H41). Spherical/lat-lon, triplanar, projected-grid all rejected. Seam with B630: fade FFT detail over the same 70 km→1e6 m band `GlobeTerrain.wgsl` uses.
- **Planar-reflect contract (#20):** ocean exposes `getReflectionPlane()`; reflection camera mirrored with Lengyel oblique near-plane clip; half-res `rgba16float` target rendered only when camera < ~70 km; ocean FS samples projectively with normal-perturbed UV, Fresnel F0=0.02; refraction v1 = SSR scene-color copy + Beer-Lambert. Build the FS with a `reflectionSource` seam from day one (IBL/sky fallback until #20 lands).

### Recommendation
Port the gasgiant/Popov72 (MIT) JONSWAP+TMA+Horvath cascade chain into a 3-cascade (optional 4th) 256×256 compute pipeline: radix-2 twiddle-texture IFFT v1 with a Stockham upgrade path, Jacobian-fold foam with temporal decay, camera-anchored RTE ENU clipmap surface, cross-faded to the B630 water-mask effect over its 70km–1e6m band, exposed as opt-in default-off `scene.globe.water.ocean` with the reflection-plane seam pre-built. Never port from iamyoukou/fftWater or codeagent/webgl-ocean. **(Shipped as C6-FFT-OCEAN v1 on 2026-07-11 — single 256×256 Phillips cascade + flat RTE ENU patch; the 7 follow-ups above carry the cascade/clipmap/JONSWAP/spectral-normal/reflect increments.)**

### Sources
WebTide, gasgiant/FFT-Ocean, Popov72/OceanDemo, 2Retr0/GodotOceanWaves, dli/waves (all MIT); EncinoWaves (Apache-2.0); Tessendorf SIGGRAPH notes; Horvath 2015. Fork files: `GlobeTerrain.wgsl` (B630 ocean bindings), `csm_getWaterNoise.wgsl`, `FeatureRendererKey.js`, `WebGPUComputeEngine.ts`, `WATER_RENDERING_DESIGN.md`, `GlobeWater.js`.

---

## R-FSR2 — FSR2 WGSL port scope + license (C6-FSR2-UPSCALE)

**Report:** `scratchpad/RESEARCH_R-FSR2_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` → **C6-FSR2-UPSCALE (NEW-FSR2-UPSCALE)** — premise verified REAL, DEFERRED as a 6–10 day / 4-phase epic (full decomposition + phasing recorded in the DEFERRED entry). Supersedes `FEAT-SURVEY-48` (STP upscaler, FEATURE_INVENTORY §D) on landing.

### License verdict
**MIT** — verbatim from `raw.githubusercontent.com/GPUOpen-Effects/FidelityFX-FSR2/master/LICENSE.txt` ("FidelityFX Super Resolution 2.2, © 2022-2023 AMD" + stock MIT). Porting shader source to WGSL permitted; retain the AMD copyright+permission notice in every derived file + add a third-party manifest entry. Port from **standalone repo tag v2.2.2** (GLSL shader set), NOT the FidelityFX SDK. FSR4 is NOT open source.

### Key findings
- Upscale-only needs **5 mandatory compute passes** — Luminance Pyramid (SPD), Reconstruct-Previous-Depth&Dilate, Depth Clip, Create Locks, Reproject&Accumulate — plus optional RCAS (ship it, cheap). FSR2 has zero frame-gen code (that's FSR3). ~95–100 MB added VRAM at 1440p Quality (display-res `rgba16f` history ×2 dominates).
- **No public WebGPU/WGSL FSR2 port exists** — we'd be first. Best reference: JuanDiegoMontoya/FidelityFX-FSR2-OpenGL (retains AMD MIT). **Biggest WGSL blocker:** ReconstructPreviousDepth uses `InterlockedMax/Min` on an `r32uint` UAV *texture* — WGSL has **no texture atomics** → rewrite as `var<storage> array<atomic<u32>>` scatter buffer with manual indexing (build as a reusable helper). Use LDS fallbacks (not subgroups) and FP32 (`FFX_HALF=0`) first.
- **TAA interaction:** mutually exclusive at runtime (FSR2 IS a temporal resolve; also disable FXAA). High reuse: Scene.js jitter hook (`applyProjectionJitter` absolute-write ~5515-5568), exported `halton()` (TAA itself switched to IGN in Batch 195 — FSR2 requires Halton(2,3), phaseCount=ceil(8·n²): 18/23/32 for 1.5×/1.7×/2.0×), `rg16float` velocity MRT + `_runVelocityPass`, DP-H41 `previousViewProjection`, TAA's pre-tonemap linear-HDR slot.
- **Two fork-specific input gaps → one new prep pass (`FSR2Prep.wgsl`):** (a) velocity MRT covers opaque MODELS only — globe/terrain/primitives need camera-motion MV synthesis from depth + previous VP_RTE (math proven in `TAA.wgsl`); (b) Cesium log depth breaks FSR2's Akeley depth-clip constants → linearize into a dedicated `r32f` FSR2 depth. Same pass merges the reactive mask.
- **Reactive mask v1:** one shared render-res `r8unorm` target written by OIT composite (`clamp(1-revealage,0,0.9)`) and cloud composite (`1-transmittance`). T&C mask deferred.
- **Render-target-resize plumbing is ~half the effort:** today ONE resolution derives from `context.drawingBufferWidth`. The internal-res(R)/display-res(D) split must re-point ~17 subsystems including **PickFramebuffer + pick-coordinate scaling** (silent-breakage risk) — see the DEFERRED entry for the full file/line checklist. Choke point: `ensureResources` (add `renderResolutionScale` as a 4th recreate trigger).
- **Phasing gives a clean off-byte-identical gate:** (1) R/D split with FSR2 off ⇒ R==D byte-identical; (2) prep pass; (3) FP32 passes + RCAS + probes; (4) masks/presets/f16. WGSL-only (Principle-5 compute exemption; WebGL warns + no-ops).

### Recommendation
GO on feasibility (license clean, one known atomic-texture→storage-buffer rewrite, one prep pass) but **land as a dedicated multi-batch epic**, not a single task: sequence plumbing-first (R/D split, byte-identical with feature off) then port the 5+1 passes FP32-first from v2.2.2 GLSL with AMD MIT headers retained. Keep mutually exclusive with TAA/FXAA, reuse the existing jitter/velocity/previousViewProjection plumbing, ship Quality/Balanced/Performance presets opt-in default-off, defer T&C mask + autogen + Ultra-Perf + subgroup-SPD.

### Sources
FidelityFX-FSR2 v2.2.2 (MIT); JuanDiegoMontoya/FidelityFX-FSR2-OpenGL (MIT). Fork files (projected): `WebGPUFSR2Effect.ts`, `WebGPUFSR2Resources.ts`, `Shaders/WebGPU/PostProcess/FSR2/*.wgsl`, `Scene/Scene.js` jitter hook, `WebGPUSceneRendererEnsureResources.ts`, `WebGPUPickFramebuffer.ts`.

---

## R-VEGETATION — GPU vegetation scatter SOTA + CC0 starter assets + V1 cutline

**Report:** `scratchpad/RESEARCH_R-VEGETATION_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` → **NEW-VEGETATION-SYSTEM** (FUTURE, design complete; canonical design in `VEGETATION_SYSTEM_DESIGN.md`) + queue #18 V1 scope-lock.

### License verdict
**ALL CLEAR — CC0** (public-domain-equivalent), verified verbatim: **Quaternius** ("All models are under the CC0 License" / commercial OK / no attribution — ships glTF natively, **PRIMARY pick**), **Poly Haven** ("licensed as CC0, which is effectively Public Domain" — but its tree MODELS are 150K–17M-poly photoscans; use only its CC0 textures), **Kenney** ("public domain licensed (CC0)", only the logo reserved). No copyleft, no attribution obligation — safe to vendor and redistribute. (wojtekpil Godot Octahedral Impostors is MIT if impostor code is later ported.)

### Key findings
- **PRIMARY ASSET = Quaternius Stylized Nature MegaKit** (116 CC0 glTF assets). Starter set: 1 grass clump + 3 trees (conifer/broadleaf/birch-or-dead) + optional bush. Kenney Nature Kit = low-poly backup; Poly Haven = photoreal textures upgrade later.
- **Technique survey:** Ghost of Tsushima = 1 compute-thread-per-blade, jittered grid (NOT Poisson), 15/7-vertex cubic-Bezier blades, scrolling-Perlin wind, Voronoi clumping. Horizon Zero Dawn = GPU per-frame placement via dither/blue-noise density thresholding + seeded-hash determinism. Octahedral impostors = hemi-octahedral ~12×12 frames in a 2048² atlas. Wind V1 = Crysis GPU-Gems main-bend (height²-scaled xy sway, per-instance hash phase).
- **Fork reuse (huge):** the shipped `WebGPUComputeInstanceRenderer` (Batch 231) is the exact substrate — GPU-resident instances via a user-WGSL kernel that writes RTE high/low position per instance, with built-in frustum-cull binding, TAA velocity, GPU picking. Plus `WebGPUGPUCuller` (frustum→indirect), `WebGPUIndirectDrawManager`, `WebGPUHiZOcclusionDispatcher` (defer to V5), `csm_stochasticDither.wgsl`. V1's genuinely-new code = scatter compute kernel + region/tile lifecycle + wind VS + far-LOD cross-quad.
- **V1 scope cutline:** IN = one-region deterministic jittered-grid scatter (density-texture + slope/altitude reject + PCG hash), CPU twin for WebGL2 + determinism oracle, draws routed through **Pass.OPAQUE** (inherits the existing GPU-cull gate — the LOD-C routing decision), Crysis main-bend wind, dither distance fade, 3 CC0 trees + grass cards, Playwright probe with GPU-vs-CPU bit-equality. OUT/deferred = mesh-LOD (V2), octahedral impostors (V3), Bezier-blade grass + Hi-Z occlusion (V5), biome/landcover datasets + GeoJSON overrides + tile-lifecycle scatter (V2+). Cap V1 at 65536 instances. Opt-in default-OFF.
- **Pitfalls:** alpha-test discard disables early-Z (keep grass cards in a separate pipeline); scattered instances must register in the CSM cast list or trees float shadowless; atomic-compaction order is non-deterministic → key featureIds off cellId not buffer index, sort by featureId in the bit-equality probe. RTE high part computed on CPU (region origin), only f32 offset on GPU.

### Recommendation
Ship V1 as a Pass.OPAQUE-routed deterministic single-region GPU instance scatter of CC0 Quaternius glTF trees/grass, built as a specialization of `WebGPUComputeInstanceRenderer` (reusing `WebGPUGPUCuller` + `WebGPUIndirectDrawManager` + stochastic dither), with Crysis main-bend wind + a cross-quad far LOD. Defer per-blade grass, octahedral impostors, Hi-Z occlusion, biome ingestion (name each in DEFERRED_WORK). Vendor a CC0 starter set under `Apps/SampleData/models/vegetation/` with a verbatim-license `LICENSES.md`. MANDATORY: RTE high/low in the scatter kernel, opt-in default-OFF, verify via GPU-vs-CPU-twin instance-buffer bit-equality.

### Sources
Quaternius / Poly Haven / Kenney CC0 pages; Ghost of Tsushima + HZD GDC talks; wojtekpil Godot Octahedral Impostors (MIT). Fork files: `WebGPUComputeInstanceRenderer` (Batch 231), `WebGPUGPUCuller`, `WebGPUIndirectDrawManager`, `csm_stochasticDither.wgsl`, `VEGETATION_SYSTEM_DESIGN.md`.

---

## R-IMPOSTOR — Octahedral impostor SOTA for VOLUMETRIC clouds (C7-CLOUD-IMPOSTOR-LOD)

**Report:** `scratchpad/RESEARCH_R-IMPOSTOR_2026-07-06.md`
**Informs:** cloud impostor increments — `CLOUD_UNIFICATION_DESIGN.md` / `DEFERRED_WORK.md` cloud LOD entries (distinct from the shipped `NEW-CLOUD-IMPOSTOR-FS-PARITY` billboard work). No code shipped; 2-phase design recorded.

### License verdict
**CLEAR to implement clean-room.** Octahedral mapping math is standard/uncopyrightable and **already ships in-repo under upstream Cesium Apache-2.0** (`Core/AttributeCompression.js` octEncode/octDecode, `Builtin/Functions/octDecode.glsl`, `chunks/functions/csm_octDecode.js`) → zero new license surface. Portable code refs (verbatim-verified): Godot-Octahedral-Impostors = MIT (wojtekpil/iFire), SkyWorks (Mark Harris) = permissive UNC notice. Technique-only (no copy): Ryan Brucks blog, GPU Gems 3 ch.21, Harris/Wang papers, Unity/O3DE 6-way lighting docs. **BLOCKED:** ictusbrucks/ImpostorBaker (no license), GavinKG/ImposterGenerator (license:null), Amplify Impostors (paid EULA), **NVIDIA SpatiotemporalBlueNoiseSDK (non-commercial — contradicts the "public-domain STBN sets exist" note; self-generate masks)**.

### Key findings
- **Technique:** octahedral/hemi-octahedral atlas parameterization + runtime **3-nearest-frame barycentric blend** (octahedral grid guarantees exactly 3 neighbors) + per-frame parallax from a stored depth map.
- **CRITICAL blend subtlety** (Brucks): you CANNOT reuse one frame's UV to sample its 2 neighbors — each of the 3 nearest frames' UV must be recomputed by re-projecting the sample point into THAT frame's capture basis. **Premultiplied alpha is MANDATORY** for a semi-transparent cloud shell (straight alpha triple-darkens edges — trees dodge this because they're opaque). Octahedral impostors break at close range → FAR/ORBIT-ONLY tier with a firm switch-out distance + cross-fade.
- **HARD PART A — capturing a RAYMARCHED VOLUME into the atlas:** re-run the existing `ProceduralClouds.wgsl` march in capture mode at LOW tier into atlas cells; amortize via lazy LRU bake (≤1 cell/frame, double-buffered). Bake DEPTH = transmittance-weighted mean ray distance `t̄` (first extinction moment) as the volumetric stand-in — drives parallax, reprojection, terrain compositing.
- **HARD PART B — LIGHTING dependence:** baked radiance is sun-locked. Two strategies: (1) re-capture on a Harris-2001 error predicate (translation-angle >~0.15°, resolution deficit, sun-delta) — DEGENERATES under Cesium `clock.multiplier` time-lapse (sun moves 4°/s at 1000×); (2) **bake a 6-axis lighting basis** (Unity/UE "six-way lighting": ±X/±Y/±Z directional response into 2 RGB textures, reweight by live sun dir at composite) → sun motion and time-of-day become INVARIANT, only weather/wind deltas invalidate. 6-axis costs ~2–3× bake + 2× atlas memory but is the right choice for the atlas tier. Add a runtime `phaseHG(dot(V,L))` factor to recover silver-lining directionality.
- **Cloud-specific prior art:** nobody ships an OCTAHEDRAL impostor for clouds (novel). Ancestors: Harris & Lastra 2001 / SkyWorks (dynamic per-cloud impostors regenerated on translation-error angle), MSFS2004 Niniane Wang (distant clouds into octagon impostor rings, 15%/2% regen thresholds). **Guerrilla Nubis / @takram/three-clouds deliberately use NO impostor** — they amortize INSIDE the march (coarse far steps + 1/16 temporal reprojection). Takram's negative result is decisive: **orbit is viable without impostors** → the impostor is a QUALITY/BATTERY/STABILITY win, not the only orbit bridge.
- **Memory budget:** 8×8=64-view full-octahedron atlas (~13° spacing) at 256²/cell; 6-axis basis in two `rgba8unorm` layers → ~8.4 MB atlas. Needs 1-texel gutters + clamp-inward + octa-seam mirror-wrap.
- **Fork integration (post cloud-unification):** entry `executeProceduralClouds()` (`WebGPUProceduralCloudRenderer.ts:1402`), driven by `CloudCollection.renderMode===VOLUMETRIC` + the `resolveCloudQuality` altitude tier resolver. New floats append to `CloudUniforms` at 148+ (add-only; Batch 641 marchStepGrowth/maxRayDistance are SHIPPED); new `qualityFlags` bit `CLOUD_QF_IMPOSTOR`; new add-only `ShaderDefine`. Default `cloudImpostorMode='off'` → byte-identical.

### Recommendation
Do the cheap in-march LOD wins FIRST (geometric step-growth + far ray cap already SHIPPED via Batch 641; true STBN + 1/16 amortization still owed). Then build the impostor WebGPU-only under the unified `CloudCollection.renderMode` toggle in TWO phases: **Phase 1** = single dynamic "freeze & reproject" impostor (reuse the half-res `rgba16float` premultiplied target + V10 shell-aware temporal reprojection; re-march only when a Harris-style staleness predicate trips) → ~60× march-cost cut at orbit with ~90% existing infra. **Phase 2** (optional quality tier) = 8×8 full-octahedron atlas over planet-centric camera direction, lazily LRU-baked, 3-nearest-frame blend + per-frame-recomputed UVs + `t̄` depth parallax + premultiplied composite + **6-axis lighting basis** so sun motion never invalidates. 3D-scene-mode-only, default-off/byte-identical, never display unbaked cells. **Pitfall:** frame SELECTION must be per-camera (planet-centric dir), never per-pixel (per-pixel triangle seams crawl across a planet-filling disc).

### Sources
Cesium `AttributeCompression.js`/`octDecode.glsl`/`csm_octDecode.js` (Apache-2.0); Godot-Octahedral-Impostors (MIT); SkyWorks/Harris (permissive UNC); Brucks shaderbits; GPU Gems 3 ch.21; Harris & Lastra 2001; Wang MSFS2004; Guerrilla Nubis; @takram/three-clouds. Fork files: `WebGPUProceduralCloudRenderer.ts` (:418, :1035, :1402), `ProceduralClouds.wgsl`, `CloudTemporalResolve.wgsl`, `CLOUD_UNIFICATION_DESIGN.md`.

---

## R-LAKE-SRTMSWBD — SRTMSWBD V003 raster pipeline for lake water-mask v2

**Report:** `scratchpad/RESEARCH_R-LAKE-SRTMSWBD_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` → lake-mask v2 upgrade of **C7-LAKE-WATER-MASK** (v1 Natural-Earth 1:10m SHIPPED 2026-07-10; the ~30 m SRTMSWBD raster is the tracked v2). FEATURE_INVENTORY §B.1 WaterClassificationProvider seam.

### License verdict
**PUBLIC DOMAIN / CC0** — safe to download, preprocess, and BUNDLE the derived asset in this MIT/Apache repo. Re-verified verbatim vs the NASA EOSDIS Data Use Policy: "Unless the content is marked with a use restriction or license, data provided from a NASA-led mission are licensed as Creative Commons Zero (CC0)." CMR collection C2763268445-LPCLOUD carries no restrictive UseConstraints. Include the DOI credit (10.5067/MEaSUREs/SRTM/SRTMSWBD.003) in the tool header (like the Natural Earth credit). Earthdata Login gates the download TRANSACTION, not the data license.

### Key findings
- **Format:** one file per 1×1° cell, 3601×3601 uint8, 1 arc-second (~30 m) plate-carrée geographic, headerless, exactly 12,967,201 bytes, north-first row-major, edge rows/cols shared with neighbors — byte-for-byte the same sampling space the runtime rasterizer already uses → **ZERO reprojection needed**.
- **Byte semantics:** 0 = land, 255 = water — byte-identical to the Cesium quantized-mesh water-mask convention, **no remap**. NASA never wrote the polarity in the User Guide (an LLM summary of that PDF fabricated an INVERTED quote — do not trust summarized fetches). Corroborated by JPL ISCE2, the CMR variable record, and NASADEM swb. **MANDATORY first-tile build assertion:** probe mid-Lake-Michigan (255) vs inland Illinois (0) on N42W087, abort if inverted.
- **Sizes (CMR-measured):** full dataset 12,229 granules / 371.2 MB zipped / ~158.6 GB raw. Great Lakes bbox: 189 granules / 13.2 MB zipped, streamed one 12.4 MiB tile at a time. Zips compress ~1000× (near-uniform runs). All-ocean cells have NO granule — absence is normal.
- **Auth:** free NASA Earthdata Login required for the BYTES (unauthenticated GET → 302 to urs.earthdata.nasa.gov), NOT for CMR discovery. Preferred: EDL Bearer token (60-day) against data.lpdaac.earthdatacloud.nasa.gov. Dataset is static (epoch Feb 2000, V003 final) — download once, cache forever, support `--input` for pre-downloaded zips. Old e4ftl01/dds.cr.usgs.gov URLs are dead (404) — use LPCLOUD + CMR only.
- **Two pipeline designs.** **v2a (RECOMMENDED):** raster → marching-squares contours at 0.5 iso → Douglas-Peucker simplify (~2 arcsec) → merge across seams → split oversized shorelines into ≤1° spans → pack into the **EXISTING LWM1 container**. Runtime change = NONE; pure data swap (~1–2 MB asset). Classify lake-vs-ocean/river by clipping contours to NE-10m-lake inclusion regions dilated ~0.02° (reuses the bundled `ne10mLakes.bin`, deterministic, removes ocean+rivers). **v2b (ESCALATION):** geographic-quadtree 256×256 mask pyramid ("LWM2", levels 0-11) with 2-bit ALL_LAND/ALL_WATER/ABSENT nodes + 1-bit-packed MIXED leaves, HTTP-gzipped, ~3–6 MB over the wire for Great Lakes — optional fetched asset, not bundled.
- **LWM1 sharing:** YES for v2a (LWM1 is source-agnostic; SWBD polygons pack into the byte-identical container consumed by the same `LakeWaterClassificationProvider`), subject to bbox-quant < 30 m + split high-vertex shorelines. v2b needs a new LWM2 container but plugs into the same `WaterClassificationProvider` sync interface.
- **Biggest pitfall:** SRTMSWBD coverage STOPS at 60N / 56S — Great Bear, most of Great Slave, Ladoga/Onega are absent → the v2 provider MUST keep the Natural-Earth v1 polygons as the fallback layer and compose (SWBD wins where present). Other pitfalls: ocean/river indistinguishable in raster (mitigated by inclusion-region clip); tile-edge duplicate row/col (drop-or-merge on mosaic); Feb-2000 vintage overstates variable lakes; Caspian excluded (same as v1).

### Recommendation
Land lake-mask v2 as **v2a**: raster → marching-squares contours → Douglas-Peucker → inclusion-region clip (lake-vs-ocean) → pack into the existing LWM1 container as a pure ~1–2 MB data swap (zero runtime change), keeping the Natural-Earth v1 polygons as the >60N/<56S fallback layer (compose, SWBD wins where present). Ship the dev-time downloader/preprocessor with the mid-Lake-Michigan polarity assertion + DOI credit. Escalate to v2b (LWM2 quadtree pyramid, optional fetched asset) only if v2a's polygon count proves too coarse for target lakes.

### Sources
NASA EOSDIS Data Use Policy; CMR collection C2763268445-LPCLOUD; DOI 10.5067/MEaSUREs/SRTM/SRTMSWBD.003; JPL ISCE2; NASADEM swb. Fork files: `Scene/WaterClassificationProvider.ts`, `Tools/build-lake-water-mask.mjs`, `Assets/WaterMask/ne10mLakes.bin`, `GlobeSurfaceTile.js` (createWaterMaskTextureIfNeeded).

---

## R-MARS-ATMO — Multi-body atmosphere parameterization (Mars first)

**Report:** `scratchpad/RESEARCH_R-MARS-ATMO_2026-07-06.md`
**Informs:** `DEFERRED_WORK.md` / FEATURE_INVENTORY §D → **FUT-MULTI-BODY-ATMOSPHERE** (subsystem 8; no code shipped — future celestial-bodies arc). Couplings: `SkyAtmosphere`, `Atmosphere`/fog, ModelAtmosphereStage, moon-extinction (Batch 629), cloud Earth-METAR presets.

### License verdict
**CLEAN.** The real prior art (Bruneton 2017 reimplementation = BSD-3, Hillaire/UnrealEngineSkyAtmosphere = MIT © 2020 Epic, Takram three-geospatial = MIT + BSD-3 + Apache-2.0 stack, OpenSpace/Costa = MIT, CosmoScout/Schneegans = MIT) is all permissive and compatible with our Apache-2.0 fork. **Crucially: the parameter VALUES (radii, coefficients, scale heights) are unprotectable facts** — copying the numbers from Bruneton's `demo.cc` or any paper carries no license obligation; only literal code/shader text does. Our LUT chain was written in-house against the papers, so nothing is owed today. CosmoScout follows FSFE REUSE with per-file SPDX tags — check the tag before lifting any of their Mars data CSVs.

### Key findings
- Our fork's atmosphere pipeline is **already ~80% parameterized for arbitrary bodies** at the WGSL LUT level (`AtmosphereParams` carries innerRadius, outerRadius, both scale heights, RGB Rayleigh/Mie/ozone coefficients, mieAnisotropy, intensity; no Earth radii hardcoded in the LUT bake).
- **The actual work list — hardcoded Earth constants that block multi-body:** (1) `ATMOSPHERE_THICKNESS = 111e3` hardcoded **twice** (`AtmosphereCommon.glsl:10` + `WebGPUSkyAtmosphereRenderer.js:102`) — parity-critical two-site change; (2) `outerEllipsoidScale = 1.025` (`SkyAtmosphere.js:133`) → derive from `1 + thickness/maxRadius`; (3) ozone tent profile center=25000/halfWidth=15000 (`AtmosphereLUT.wgsl:168-169`) → params; (4) **no `groundAlbedo`** anywhere in the WGSL kernels (MS-gather + irradiance ignore ground bounce); (5) **no Mie extinction≠scattering split** (SSA); (6) `Fog.js` Earth-tuned; (7) `mieAnisotropy` scalar (Mars blue sun-aureole needs per-λ / vec3 g).
- **Mars has two parameterizations:** (a) **Collienne 2013 stylized** — inverted-spectral-order Rayleigh `(19.918, 13.57, 5.75)e-6` (RGB), drop-in zero-shader-change, known artifacts (blue glow smears along whole horizon, no forward aureole); (b) **physically-grounded** — tiny true CO₂ Rayleigh (~2% of Earth, `(1.2, 2.9, 7.1)e-7`) + dust-as-Mie with per-channel SSA (~0.94 blue-absorbing) and per-channel phase anisotropy (Costa 2021 / Tomasko 1999 / Ockert-Bell 1997). Option (b) needs the struct extensions. Mars facts: radius 3396.2 km, surface pressure 6.36 mb, solar irradiance 586.2 W/m² (43.1% of Earth), H≈11.1 km, 100 km render shell, groundAlbedo ~0.25 red-weighted.
- **Airless/Moon must be a GATE, not zeroed coefficients** — zeroed β still pays the full march to produce black, and scale-height→0 is numerically toxic. Cesium's existing API (`skyAtmosphere=undefined`, `showGroundAtmosphere=false`, `fog.enabled=false`) already expresses it; a `hasAtmosphere` flag formalizes it. **Note:** the moon LUT slots in `AtmosphereLUTResources` are moonlight-scattering-IN-Earth's-atmosphere (dual-light night sky), NOT a moon atmosphere — keep that naming distinction loud.
- **Per-body LUT re-bake is nearly free** — we already re-dispatch the full LUT chain on sun-direction/ozone-flag changes; a body switch is the same dispatch with a different params UBO (<1 ms discrete GPU). v1 = single mutable slot + `lastProfileHash` re-bake key; v2 = per-body keyed LRU slots (~1.4–1.7 MB/body, cap 2-3). WebGL parity flows through existing uniforms once `ATMOSPHERE_THICKNESS` becomes `u_atmosphereThickness`.
- **Takram three-geospatial does NOT do multi-body** (its README says "effectively limited to Earth's atmosphere") — it's a parameterization existence proof, not per-body prior art. The real multi-body prior art is Costa 2021 (OpenSpace) and Schneegans 2024 (CosmoScout, Mie-theory tabulation).
- **Units pitfall (load-bearing):** Bruneton-family papers/code work in km → every coefficient from that lineage is km⁻¹ (×10⁻³) vs our m⁻¹ (×10⁻⁶). Costa's published table has confirmed errata (molecule coefficients off by ~1000×). Sanity-check any imported triple against mean-free-path intuition.

### Recommendation
Track as FUT-MULTI-BODY-ATMOSPHERE (subsystem 8). Land the two cheap de-risking sub-items first (independently landable, Earth-default byte-identical): parameterize the double-site `111e3` → `u_atmosphereThickness`/profile value, and the ozone tent center/halfWidth → params. Then add `BodyAtmosphereProfile` value object with frozen presets (`EARTH` == today byte-identical, `MARS_STYLIZED` Tier-A zero-shader-change, `MARS` Tier-B, `NONE` airless gate); Tier-B needs the Mie-extinction split + vec3 g + groundAlbedo bounce term (the one place new shader math lands). Both backends (Principle 5) — GLSL math, no LUT needed for WebGL. Verify via `probe-mars-atmo.mjs` split-screen (Earth vs Mars, low-sun saved view) as the WebGL-vs-WebGPU parity gate. **Do not ship `multipleScattering:true` as a Mars default** (Collienne inverted-order + physical MS = red-amplified horizon).

### Sources
Bruneton 2017 reimplementation `demo.cc` (BSD-3); Hillaire 2020 EGSR + UnrealEngineSkyAtmosphere (MIT); Collienne et al. 2013; Meyran DLR thesis (elib.dlr.de/203154, primary extraction); Costa et al. 2021 IEEE TVCG / OpenSpace (MIT); Schneegans et al. 2024 CGF 43 / CosmoScout (MIT); Tomasko et al. 1999 JGR; Sneep & Ubachs 2005 JQSRT; Ehlers/Chakrabarty/Moosmüller 2014. Fork files: `Scene/{SkyAtmosphere,Atmosphere}.js`, `AtmosphereCommon.glsl`, `Compute/AtmosphereLUT.wgsl`, `WebGPU/{WebGPUAtmosphereLUT.ts, WebGPUSkyAtmosphereRenderer.js}`.

---

## Cross-link summary (rows each lane informs)

| Lane | Live tracking entry | State |
|---|---|---|
| R-STBN | `DEFERRED_WORK.md` C6-CLOUD-STBN-TAAU + C6-TPDF-DITHER-FINAL | LOD half shipped; STBN-texture half deferred on offline EA FastNoise asset |
| R-LTC | `DEFERRED_WORK.md` C6-LTC-AREA-LIGHTS (+5 follow-ups) | v1 shipped 2026-07-10 |
| R-WIND-DATA | `DEFERRED_WORK.md` C6-FLOWFIELD-WIND (+4 follow-ups) | shipped 2026-07-10 |
| R-SSGI | `DEFERRED_WORK.md` C6-SSGI-DIFFUSE (+ quality/WebGL follow-ups) | shipped |
| R-FFT-OCEAN | `DEFERRED_WORK.md` C6-FFT-OCEAN (+7 follow-ups incl. C6-PLANAR-REFLECT-REFRACT) | v1 shipped 2026-07-11 |
| R-FSR2 | `DEFERRED_WORK.md` C6-FSR2-UPSCALE (NEW-FSR2-UPSCALE) | deferred multi-batch epic |
| R-VEGETATION | `DEFERRED_WORK.md` NEW-VEGETATION-SYSTEM / `VEGETATION_SYSTEM_DESIGN.md` | FUTURE, design complete |
| R-IMPOSTOR | `CLOUD_UNIFICATION_DESIGN.md` / cloud LOD DEFERRED entries | FUTURE, 2-phase design |
| R-LAKE-SRTMSWBD | `DEFERRED_WORK.md` C7-LAKE-WATER-MASK v2 note | v1 shipped; v2 tracked |
| R-MARS-ATMO | `DEFERRED_WORK.md` FUT-MULTI-BODY-ATMOSPHERE / FEATURE_INVENTORY §D | FUTURE, no code |
