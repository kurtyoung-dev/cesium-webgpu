# Atmosphere + Cloud Improvement Plan — CesiumJS WebGPU Fork

_Created 2026-06-28 (LIVE planning doc). The opt-in-over-parity improvement roadmap for the WebGPU
atmosphere + cloud subsystems — sky scattering, volumetric clouds, volumetric fog + weather effects
(the shipped A–E atmospheric effects), reflections/IBL, aerial perspective. Synthesized from a 5-subsystem
code audit. Folds in the deferred cube-sky / **dynamic scene-content environment map (C2-25)** as the
headline reflections epic. Companion to [ATMOSPHERIC_EFFECTS_ROADMAP.md](ATMOSPHERIC_EFFECTS_ROADMAP.md)
(which tracks the now-shipped Phase A–E effects) — this doc is the forward-looking quality roadmap on top._

## Governing Principle (user directive — non-negotiable)

**WebGL parity is the DEFAULT. Every improvement in this plan is OPT-IN behind a flag/config that defaults OFF and is byte-neutral when off.** The parity default path must never regress — the inline `czm_computeScattering` ray-march port, the in-globe ground-atmosphere drape, the rgba8unorm procedural env cube, the constant fog ambient, and `showProceduralClouds=false` all remain the shipped baseline. Concretely, every item below must satisfy:

- A new `//>>ifdef`/uniform/preset flag whose **default value reproduces the current pixels** (coefficient 0, octave count 1, `defines=0` emits the historical `//>>else` branch per the shader-define rules).
- New GPU resources (LUT views, history cubes, half-res targets, shadow textures) bound to the existing **1×1 placeholder fallbacks** when off, so bind-group layouts don't fork the parity path.
- No new per-frame compute dispatch or UBO float growth on the off path (struct growth is ADD-ONLY and only consumed when the gate bit is set).
- Verification: the existing parity probes (`probe-model-ibl`, `probe-saved-view`, split-screen capture-and-diff) must be **unchanged** with all flags off, per Principle 8 (probe-first).

This is the corollary of Principle 7 (keep scaffolding) + Principle 9 (finish what the scaffolding implies): much of this plan is **wiring already-baked-but-dormant infrastructure to a visible consumer**, gated so the parity default is untouched.

---

## 1. Current State by Subsystem

| Subsystem | Shipped today | Parity status | Largest dormant lever |
|---|---|---|---|
| **Sky atmosphere / scattering** | Inline `czm_computeScattering` 1:1 WebGL port (16/4 adaptive march, shell + fullscreen paths); compute-baked transmittance/inscatter LUTs; full-Bruneton multiple-scatter + irradiance LUTs; aerial-perspective post-process; dual-light; procedural sky cubemap → IBL | **AT parity** (default ray-march); **LEADS** on opt-in axes | Sky inscatter LUT gated OFF (bad 2D param); MS + irradiance LUTs baked but **sampled by nothing** |
| **Volumetric procedural clouds** | Full-screen Schneider/Nubis raymarch shell, baked 3D shape+detail noise, dual-lobe HG + Frostbite multi-octave MS, beer-powder, weather-map seam (C2-16), 108-float ADD-ONLY UBO, tier-preset spine | **DEFAULT-OFF parity** (no WebGL equivalent — strictly LEADS when on) | Tier spine **inert**: half-res / temporal / jitter / curl / powder-floor declared but no render-path consumer |
| **Volumetric fog + weather effects** | Frostbite 3-pass froxel fog (density→scatter→integrate), energy-conserving single-scatter (Batch 421), HG sun+moon, sun-shadow god-rays, 1-sample cloud shadow, ground-fog band, heat shimmer, cold optics (22° halo), precip wiring | **LEADS WebGL**, default-off byte-neutral | Fog ambient is a **flat constant**; transmittance LUT + SH buffer exist but unsampled; `auto` quality inert (VPT unwired → always low) |
| **Reflections / IBL / dynamic env map** | Procedural-sky cubemap (256² rgba8) in 1 dispatch, GGX prefilter + SH-L2 (no readback), KTX2 authored maps, model IBL precedence ports WebGL exactly | **AT parity** on default path; lags SOTA (shared with WebGL) | rgba8 LDR clamps HDR sun; prefilter mip0-only (fireflies); **no scene content in reflections** (C2-25); MS-LUT unused as sky source |
| **Aerial perspective + atmosphere post** | Depth-correct 10-step analytic march (opt-in `scene.aerialPerspective`), atmosphere-derived sun/ambient lighting, god rays, HDR tonemap chain (ACES/Filmic/AutoExposure/TAA), cold optics + heat shimmer | At/ahead of WebGL on look; structurally approximate (per-pixel march, no froxel LUT) | No aerial-perspective froxel/3D LUT; binds transmittance LUT as 1×1 placeholder only |

**Cross-cutting observation:** four subsystems independently re-derive the sky integral (sky FS inline march, env-cube inline march, aerial-perspective per-pixel march, cloud ambient heuristic). The single highest-leverage architectural move is a **shared, properly-parameterized sky/transmittance/MS LUT** that all four consume — which is why the LUT items below are merged and front-loaded.

---

## 2. Prioritized, Phased Improvement Roadmap

Items are **merged across subsystems** where they share a technique or a resource. Each carries: SOTA technique · opt-in flag · parity impact · effort · files. Priorities: **P0** (foundational / unblocks others) · **P1** (high-value, depends on P0) · **P2** (polish / niche).

### Phase 1 — Foundational LUT + HDR substrate (P0)

These build the shared substrate every later item consumes. Do them first.

---

#### 1.1 — Sun-relative sky/inscatter LUT re-parameterization (`A-LUT-REPARAM`) — **P0, effort L** — ✅ SHIPPED Batch 428 (sky-view LUT) + Batch 429 (MS-LUT re-paramed onto the same sky-view domain → all-azimuth SKY-MS)

**Merges:** Sky "Sun-relative inscatter LUT + re-enable fast-path" + Reflections "Multi-scatter sky source" + Aerial "froxel LUT" share the *same* re-parameterized table.

- **Technique:** Replace the current Y-up synthetic-frame 2D inscatter table with a Hillaire-2020 **sky-view LUT** parameterization — `(cosViewZenith × cosSunZenith × altitude)` plus a view–sun azimuth term (2D-array or 3D texture). This is the root blocker (`NEW-ATMOSPHERE-LUT-SUN-RELATIVE`): the current table can't represent sky color off the sun meridian, which is *why* `ENABLE_SKY_INSCATTER_LUT=false` and *why* aerial perspective must re-march per-pixel.
- **Opt-in flag:** `skyAtmosphere.useScatteringLut` (default `false`).
- **Parity impact:** Default-off keeps `ENABLE_SKY_INSCATTER_LUT=false`; the inline `czm_computeScattering` port is byte-unchanged. The re-baked LUT replaces the existing one only on the bake path (already gated by sun-delta threshold) — and is currently sampled only by fog drape, which gets *more correct* but stays behind its own flags.
- **Files:** `Shaders/WebGPU/Compute/AtmosphereLUT.wgsl`, `Renderer/WebGPU/WebGPUAtmosphereLUT.ts`, `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl`, `Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js`.

#### 1.2 — HDR env cube (`IBL-HDR`) — **P0, effort S** *(quick win)* — ✅ SHIPPED Batch 426

- **Technique:** Promote the dynamic env cube + `ProceduralSkyCubemap` storage texture from `rgba8unorm` → `rgba16float` so the HDR sun disc + bright sky survive into the GGX prefilter (Karis split-sum wants HDR radiance). Prefilter + SH already run rgba16float — only the *source* is LDR.
- **Opt-in flag:** `contextOptions.webgpu.hdrEnvironmentMap` (default `false`).
- **Parity impact:** Default-false keeps rgba8unorm + identical SkyUniforms pack → `probe-model-ibl` byte-unchanged. Flag true swaps only the texture format + storage-texture access decl.
- **Files:** `Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts`, `Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl`.

#### 1.3 — Roughness-correct prefilter mip-source + LOD bias (`IBL-PREFILTER-HQ`) — **P0, effort M** — ✅ SHIPPED Batch 426

- **Technique:** Karis/UE4 prefilter: pre-generate a mip chain on the source env cube and, in `RadiancePrefilter.wgsl`, sample the source at a LOD derived from the GGX pdf vs texel solid angle (`saSample/saTexel`) instead of always mip0 (line 104). Kills bright-sun firefly aliasing at high roughness.
- **Opt-in flag:** `contextOptions.webgpu.iblPrefilterQuality` (`'parity' | 'high'`, default `'parity'`).
- **Parity impact:** `'parity'` leaves line 104 (`textureSampleLevel … 0.0`) + the 512-sample loop exactly as shipped → identical bytes. `'high'` adds the source-mip compute pass + LOD path.
- **Files:** `Shaders/WebGPU/Compute/RadiancePrefilter.wgsl`, `Renderer/WebGPU/WebGPUIBLPipeline.ts`.

---

### Phase 2 — Wire the dormant multi-scatter consumers (P1)

These finish the Bruneton/Hillaire consumers that are *baked-but-unwired today* (Principle 9). They depend on **1.1** delivering a sun-relative table.

---

#### 2.1 — Multiple-scattering term in the visible sky (`SKY-MS`) — **P1, effort M** — ✅ SHIPPED Batch 427 (consumer wired) + Batch 429 (all-azimuth directional MS via the sky-view-domain MS LUT) — COMPLETE

- **Technique:** Hillaire 2020 / Bruneton 2008 MS: bind the already-running `multipleScatterView` LUT as a sampled input on `group(1)` of `SkyAtmosphere.wgsl` and **add** the MS term to the single-scatter result (raises horizon + shadowed-limb radiance that single-scatter leaves too dark). The compute pass already runs every sun-move — only the sampler binding + add are missing.
- **Opt-in flag:** `skyAtmosphere.multipleScattering` (default `false`).
- **Parity impact:** Default-off binds the existing 1×1 placeholder + skips the add → byte-identical sky. Zero new per-frame cost when off (bake already runs).
- **Files:** `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl`, `Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js`, `Renderer/WebGPU/WebGPUAtmosphereLUT.ts`.

#### 2.2 — Multi-scatter sky as the env-map + aerial-perspective source (`ENV-AERIAL-MS`) — **P1, effort M** — ✅ SHIPPED (Batch 430)

**SHIPPED (Batch 430):** `contextOptions.webgpu.envMapMultiScatter` (default `false`) routes BOTH the env-cube procedural sky fill (`ProceduralSkyCubemap.wgsl`, sky color from `sampleSkyViewLut` + MS add for sky-facing texels, gated to non-NONE dynamic lighting) AND the aerial-perspective in-scatter (`AerialPerspective.wgsl`, `params1.z` flag) to the sun-relative sky-view + MS LUTs — the same tables the visible SkyAtmosphere samples (same UV/basis helpers copied from `SkyAtmosphere.wgsl`). Off path = the inline single-scatter ports verbatim; the LUT views bind to a 1×1 placeholder when off (descriptor-stable) so the off output is **byte-identical to main** (verified: env-cube radiance checksum + aerial canvas checksum both unchanged with a pinned sun). Flag-on: env reflections warm toward the sun (per-face R/B rises ~0.66→0.76 … 0.86→0.98) and the aerial haze matches the visible sky color. `WebGPUDynamicEnvironmentMapManager.ts` fetches the LUT views via `context.performanceManager.ensureAtmosphereLUTResources`; `WebGPUPostProcessStageCollection.ts` pushes them to `AerialPerspectiveEffect`. Probe: `Tools/visual-regression/probe-env-aerial-ms.mjs`.

**Merges:** Reflections "Multi-scatter sky source" + Sky/Aerial reuse. Once **2.1** validates the MS add visually, route the *same* LUT into the env-cube fill and the aerial march so reflected/hazed sky matches the visible sky.

- **Technique:** Replace `ProceduralSkyCubemap.wgsl`'s inline 16-step single-scatter march and `AerialPerspective.wgsl`'s analytic extinction with a lookup into the re-parameterized transmittance + MS LUTs from 1.1/2.1.
- **Opt-in flag:** `contextOptions.webgpu.envMapMultiScatter` (default `false`); aerial side reuses the same gate.
- **Parity impact:** Default-false keeps the WebGL-parity inline ports in both shaders. True binds the LUT views (already computed for the visible sky → marginal cost).
- **Files:** `Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl`, `Shaders/WebGPU/PostProcess/AerialPerspective.wgsl`, `Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts`, `Renderer/WebGPU/WebGPUAtmosphereLUT.ts`.

#### 2.3 — Aerial-perspective froxel 3D LUT (`AERIAL-FROXEL`) — **P1, effort L**

- **Technique:** Hillaire 2020 aerial-perspective volume: a low-res 3D froxel LUT (e.g. 32×32×32) of accumulated transmittance + inscatter along the view frustum computed once per frame; `AerialPerspective.wgsl` does one trilinear fetch instead of the 10-step per-pixel march. Decouples cost from screen resolution; temporally stable. Shares the froxel infrastructure pattern with the fog renderer.
- **Opt-in flag:** `scene.aerialPerspectiveFroxel` (default `false`; itself nested under the already-opt-in `scene.aerialPerspective`).
- **Parity impact:** Both flags default off → no aerial perspective at all in the parity default (as today). Froxel path replaces the analytic march only when explicitly enabled.
- **Files:** `Shaders/WebGPU/PostProcess/AerialPerspective.wgsl`, `Renderer/WebGPU/WebGPUAerialPerspectiveEffect.ts`, `Shaders/WebGPU/Compute/AtmosphereLUT.wgsl`.

#### 2.4 — Sky-LUT / IBL-driven fog ambient (`FOG-IBL-AMBIENT`) — **P1 (P0 within fog), effort M** — ✅ SHIPPED Batch 431

- **Technique:** Replace `ambientTerm = u.occlusion.y` (flat constant) in `VolumetricFog.wgsl` `lightScattering` with a sample of the re-parameterized transmittance LUT at `(froxel altitude, view-up)` blended with an SH-L2 eval of the existing `_webgpuSHBuffer` — Hillaire sky-view + ambient-probe. Altitude- and time-of-day-correct fog ambient.
- **Opt-in flag:** `atmosphericConditions.volumetricFog.iblAmbient` (default `false`).
- **Parity impact:** Default-off keeps the `occlusion.y` branch byte-for-byte (gate behind an occlusion-slot flag; LUT/SH bound to 1×1 fallbacks when off). No new UBO floats when the bit is 0.
- **Files:** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`, `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`, `Renderer/WebGPU/WebGPUVolumetricFogResources.ts`.

---

### Phase 3 — Cloud performance spine + cloud↔atmosphere coupling (P0/P1)

The cloud tier spine is the single biggest perf+quality lever still unbuilt (full-res 96-step cinematic march every frame). Activating it is **P0 within clouds**. Coupling clouds to the (now-correct) atmosphere LUTs is P1.

---

#### 3.1 — Half-resolution render target + spatial upsample (`CLOUD-HALFRES`, activate V9) — **P0, effort M** — ✅ SHIPPED Batch 432 (CloudUpscale.wgsl joint-bilateral upsample; low/medium/auto-far → 0.5×, cinematic/escape-hatch byte-identical full-res)

- **Technique:** Render the cloud march into a 0.5× (`renderResScale`) offscreen RGBA16F target with Bayer/blue-noise 4×4 pixel jitter (Wronski), then depth-aware bilateral upsample to canvas. Reuses the allocated `QF_HALF_RES` bit + preset `renderResScale`.
- **Opt-in flag:** low/medium/auto-far tiers resolve `renderResScale<1` + set `QF_HALF_RES`; cinematic + the `cloudQuality` escape hatch keep `renderResScale=1.0`.
- **Parity impact:** Byte-neutral default — T3/escape-hatch keep full-res `draw(3)→canvas` unchanged; only opt-in tiers allocate the half-res target.
- **Files:** `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `Renderer/WebGPU/WebGPUCloudTierPresets.ts`.

#### 3.2 — Temporal reprojection / accumulation for clouds (`CLOUD-TEMPORAL`, activate V10) — **P0, effort L** — ✅ SHIPPED Batch 433 (CloudTemporalResolve.wgsl reproject+3×3 neighborhood-clamp; T1/T2 temporal, T3/escape-hatch byte-identical; no-ghost verified moving-camera)

**Pairs with 3.1.** Shares the temporal pattern with **3.5** (fog temporal) and **3.7** (env-cube temporal).

- **Technique:** Reproject the previous cloud frame via `previousViewProjection` (already in `CameraUniforms` tail per DP-H41), update only `temporalUpdateFraction` (1/8..1/16) of pixels per frame (Schneider/Bauer checkerboard), neighborhood-clamp history to reject ghosting, blend with the jittered half-res march. ~4× cost cut.
- **Opt-in flag:** preset `temporalEnabled` + `QF_TEMPORAL` (T1/T2 set; T3/escape-hatch false).
- **Parity impact:** Byte-neutral default — no history buffer allocated, single-pass march byte-identical. First-frame writes identity history (TAA/CSM convention).
- **Files:** `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `Renderer/WebGPU/WebGPUCloudTierPresets.ts`.

#### 3.3 — Aerial-perspective LUT coupling for clouds (`CLOUD-AERIAL-LUT`) — **P1, effort M** — ✅ SHIPPED Batch 434 (globe.cloudAerialMode 'physical'; samples the shipped sky-view + transmittance LUTs directly since the 2.3 froxel is deferred)

- **Technique:** Sample the aerial-perspective froxel LUT (from **2.3**) at the cloud march midpoint to fog distant clouds with the *physical* inscatter+transmittance, replacing the hardcoded 60km LDR lerp toward a packed tint.
- **Opt-in flag:** `globe.cloudAerialMode` (`'heuristic'` default = today's path; opt-in `'physical'`); a `qualityFlags` bit gates the LUT sample.
- **Parity impact:** Byte-neutral default — the existing `aerialStrength/aerialColor` midpoint lerp runs verbatim; LUT binding dead unless set.
- **Files:** `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`.

#### 3.4 — Sky/atmosphere-coupled cloud ambient (`CLOUD-AMBIENT-LUT`) — **P1, effort M** — ✅ SHIPPED Batch 434 (globe.cloudAmbientSource 'sky-lut'; MS sky LUT up/down at cloud altitude, chroma-only so no blowout)

- **Technique:** Drive `skyAmbientColor`/`groundAmbientColor` from the MS sky LUT sampled at cloud altitude (up/down hemispheres) instead of the constant blue/grey lerp, so cloud ambient tracks true time-of-day sky radiance. Reuses the LUT binding from 3.3.
- **Opt-in flag:** `globe.cloudAmbientSource` (`'constant'` default; opt-in `'sky-lut'`).
- **Parity impact:** Byte-neutral default — JS packer writes existing ambient floats, WGSL lerp unchanged, LUT sample gated off.
- **Files:** `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`.

#### 3.5 — Temporal reprojection + blue-noise jitter for froxel fog (`FOG-TEMPORAL`) — **P1, effort L** — ✅ SHIPPED Batch 435 (3D froxel-volume reproject + 3×3×3 clamp + IGN jitter; no-ghost verified; converges to 0-drift ground truth)

**Shares the temporal pattern with 3.2.**

- **Technique:** Hillaire/Frostbite froxel temporal accumulation: jitter slice depth + screen offset by blue-noise, reproject last frame's integrated 3D volume via `previousViewProjection`, exponential blend (α≈0.05). Removes the Batch-421 grazing-ray march cap.
- **Opt-in flag:** `atmosphericConditions.volumetricFog.temporal` (default `false`).
- **Parity impact:** Default-off skips reprojection + history blend (history texture only allocated when set); integrate pass byte-identical.
- **Files:** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`, `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`, `Renderer/WebGPU/WebGPUVolumetricFogResources.ts`.

#### 3.6 — Cone-sampled cloud light march (`CLOUD-CONE-LIGHT`) — **P2, effort M** — ✅ SHIPPED Batch 436 (6-tap cone + cheap far-tap oracle; T1/T2; ~44% light-march cost drop at equal quality; byte-identical-by-construction off)

- **Technique:** Replace the straight N-step `lightMarch` (re-evaluates full `cloudDensity` incl. weather + 3D fetches per step) with the Schneider 6-tap cone-sampled light march (jittered toward-sun samples + one long far tap), reusing the cheap `cloudBaseDensity` oracle for far taps. ~½ light-march cost at equal quality.
- **Opt-in flag:** new preset `lightConeSampling` (T1/T2 set; T3/escape-hatch straight march), gated by a `qualityFlags` bit.
- **Parity impact:** Byte-neutral default — cinematic + power-user keep the straight march.
- **Files:** `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `Renderer/WebGPU/WebGPUCloudTierPresets.ts`.

---

### Phase 4 — Shadows, multi-deck, morphology, weather coupling (P2)

---

#### 4.1 — Volumetric cloud shadows onto scene + aerial perspective (`CLOUD-SHADOWS`) — **P1, effort L** — ✅ SHIPPED Batch 437 (512² r16float sun-view beer shadow map → terrain + aerial + fog; env-map term deferred as NEW-CLOUD-SHADOW-ENVMAP)

**Merges:** cloud-subsystem "cast shadows", fog "cloud-shadow hi-fi", reflections "screen-space cloud shadows". One coarse cloud-transmittance map serves all three consumers.

- **Technique:** Render the cloud layer's optical depth from the sun's view into a low-res orthographic "beer shadow map" (Schneider), then sample it in (a) `GlobeTerrain.wgsl` to darken lit ground, (b) `AerialPerspective.wgsl` inscatter, (c) `VolumetricFog.wgsl` (replacing the 1-sample local-fbm `sampleCloudShadow`), (d) the env-map ground term. Replaces the loosely-correlated local-hash approximations everywhere with the actually-rendered cloud field.
- **Opt-in flag:** `globe.cloudCastShadows` (default `false`); fog hi-fi sub-flag `volumetricFog.cloudShadowHiFi` reads the same texture.
- **Parity impact:** Default-off → no shadow texture rendered; all consumers read a 1×1 white (no-shadow) fallback → byte-unchanged.
- **Files:** `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`, `Shaders/WebGPU/PostProcess/AerialPerspective.wgsl`, `Shaders/WebGPU/Compute/VolumetricFog.wgsl`, `Renderer/WebGPU/WebGPUVolumetricFogResources.ts`.

#### 4.2 — Cloud-aware dynamic IBL / SH feedback (`CLOUD-IBL`) — **P2, effort L** — ✅ SHIPPED Batch 441 (globe.cloudContributesIBL; coarse coverage-driven env-cube darkening → SH; full per-face march deferred as CLOUD-IBL-FULL)

**Merges:** Sky "cloud-aware dynamic IBL", cloud "contributes IBL", fog "dynamic sky probe", reflections "clouds folded into env map". All four are the same coupling: fold rendered sky+cloud radiance into the SH-L2 / IBL path so overcast scenes get flat, dim ambient.

- **Technique:** Composite the procedural cloud raymarch over the env-sky faces (or project the composited sky+cloud FB) into `_webgpuSHBuffer` via the existing `ProjectRadianceToSH` pass before prefilter, so lit glTF/tiles + fog ambient respond to cloud cover. Builds on Batch 354 SH/IBL.
- **Opt-in flag:** `scene.cloudAwareIBL` / `globe.cloudContributesIBL` (default `false`).
- **Parity impact:** Default-off keeps `ProceduralSkyCubemap` emitting clear-sky analytic atmosphere → IBL byte-unchanged; cloud injection gated.
- **Files:** `Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl`, `Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts`, `Shaders/WebGPU/Compute/ProjectRadianceToSH.wgsl`, `Renderer/WebGPU/WebGPUModelRenderer.ts`.

#### 4.3 — Multiple-scattering in the fog integrate pass (`FOG-MS`) — **P2, effort M** — ✅ SHIPPED Batch 440 (volumetricFog.multiScatter; N-octave Beer-sum gain clamped [1,2], double-gated identity off)

- **Technique:** Wrenninge/Hillaire energy-conserving MS octaves on top of the Batch-421 single-scatter term, mirroring the cloud renderer's shipped `multiScatterLight`. Dense valley mist reads as a lit volume, no second march.
- **Opt-in flag:** `atmosphericConditions.volumetricFog.multiScatter` (default `false`; `msOctaves` slot default 1).
- **Parity impact:** Octave count 1 reproduces single-scatter exactly; loop only runs when `msOctaves>1`.
- **Files:** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`, `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`.

#### 4.4 — Activate dual-light moon scattering on the inline march (`SKY-MOON`) — **P2, effort M** — ✅ SHIPPED Batch 438 (skyAtmosphere.dualLightInline; +Scene.js Moon.update-before-sky ordering fix)

- **Technique:** Move the sun+moon dual-light combine out of the gated `useLut` branch into `computeScattering` (second analytic march or scaled moon-transmittance term), so moon glow works on the parity ray-march path. Reuses the already-baked moon LUT.
- **Opt-in flag:** new `skyAtmosphere.dualLightInline` (default `false`).
- **Parity impact:** Default-false → inline march stays single-light (WebGL parity); moon term only sums when opted in.
- **Files:** `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl`, `Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js`, `Scene/AtmosphericConditions.js`.

#### 4.5 — Ozone Chappuis absorption layer (`SKY-OZONE`) — **P2, effort M** — ✅ SHIPPED Batch 438 (skyAtmosphere.ozone; tent-profile extinction in LUT+inline+aerial; coeff 0 = identity)

- **Technique:** Add the Bruneton/Hillaire ozone tent-profile absorption (~25–30km) to the transmittance + inscatter integrands. The Chappuis band is what gives real twilight its deep blue/violet zenith — Rayleigh+Mie-only skies are too cyan at dusk.
- **Opt-in flag:** `skyAtmosphere.ozone` (default `false`; coefficient 0 = identity).
- **Parity impact:** Coefficient 0 → `exp(-0)` identity in LUT bake + inline march → numerically identical.
- **Files:** `Shaders/WebGPU/Compute/AtmosphereLUT.wgsl`, `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl`, `Shaders/WebGPU/PostProcess/AerialPerspective.wgsl`, `Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js`.

#### 4.6 — Improved energy-conserving Mie phase (`MIE-PHASE`, Jendersie–d'Eon 2023) — **P2, effort M** — ✅ SHIPPED Batch 438 (skyAtmosphere.improvedMiePhase; HG+Draine blend; flag≤0.5 = HG identity)

- **Technique:** Replace single-g HG Mie in sky/aerial/cloud with the Jendersie & d'Eon 2023 droplet phase (or Draine approximation) for a physically-grounded forward peak + backscatter — better sun-halo and glory.
- **Opt-in flag:** `skyAtmosphere.improvedMiePhase` (default `false`).
- **Parity impact:** `//>>ifdef` default 0 emits the historical HG branch → byte-identical.
- **Files:** `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl`, `Shaders/WebGPU/Compute/AtmosphereLUT.wgsl`, `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`.

#### 4.7 — Curl-noise edge distortion (`CLOUD-CURL`, activate slots 75/77) — **P2, effort M** — ✅ SHIPPED Batch 439 (globe.cloudCurlAmplitude; analytic curl warp on detail erosion; amplitude 0 = identity; W5 oracle invariant preserved)

- **Technique:** Curl-noise domain warp on the detail erosion (Schneider/Nubis wispy edges + turbulent advection), driving the reserved `curlAmplitude@75`/`curlFrequency@77` + preset field. Bake a curl vector field into spare detail-texture channels.
- **Opt-in flag:** `globe.cloudCurlAmplitude` (default undefined → packs 0.0) + tier `curlAmplitude` (0 for T0/T1).
- **Parity impact:** Amplitude 0 → no-op warp → current edge morphology exactly.
- **Files:** `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `Shaders/WebGPU/Compute/CloudNoiseBake.wgsl`, `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`.

#### 4.8 — Perlin-Worley base-shape bake (`CLOUD-PW-NOISE`, finish V4) — **P2, effort M** — ✅ SHIPPED Batch 439 (globe.cloudNoiseMorphology 'perlin-worley'; separate bakeShapePW texture; default 'value' bake byte-identical)

- **Technique:** Re-bake shape texture R as a true Perlin-Worley remap (Schneider: remap Perlin by Worley low-band) for connected billowy cores + cauliflower edges, instead of value-noise FBM. Add as a *second* bake variant chosen by flag so the current bake is preserved.
- **Opt-in flag:** preset `noiseMorphology` (`'value'` default; `'perlin-worley'` opt-in).
- **Parity impact:** Default keeps the existing valueFBM bake output; PW variant is a separate baked texture.
- **Files:** `Shaders/WebGPU/Compute/CloudNoiseBake.wgsl`, `Renderer/WebGPU/WebGPUCloudNoiseResources.ts`.

#### 4.9 — Multi-deck cloud march (`CLOUD-MULTIDECK`, Phase 2) — **P2, effort L** — ✅ SHIPPED Batch 443 (globe.cloudMultiDeck; up to 3 LOW/MID/HIGH decks, camera-band-sorted front-to-back premult composite; single shell byte-identical off)

- **Technique:** March one shell per active `CloudDeck` (LOW/MID/HIGH bounds already in `CloudTypeProfile`), composite front-to-back, driven by the weather map's deck channel (B).
- **Opt-in flag:** `globe.cloudMultiDeck` (default `false` → single shell as today).
- **Parity impact:** Default marches exactly one shell with today's bounds; extra decks purely additive.
- **Files:** `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, `Scene/CloudTypeProfile.js`.

#### 4.10 — Physically-parameterized cold optics (`COLD-OPTICS-HQ`) — **P2, effort M** — ✅ SHIPPED Batch 442 (effects.optics.advanced; 22°+46° dispersed halos + upper-tangent arc + LIGHT PILLARS; closes the deferred light-pillars item)

- **Technique:** Extend `ColdOptics.wgsl` from the hand-tuned 22° gaussian to ice-crystal-habit minimum-deviation angles for 22° + 46° halos with spectral dispersion (red inner/blue outer), upper-tangent arc + light pillars from plate-crystal orientation, gated on cirrus presence + sub-freezing temp.
- **Opt-in flag:** `atmosphericConditions.effects.optics.advanced` (default `false`).
- **Parity impact:** Default-off runs the current single 22° gaussian ring + sun-dogs unchanged.
- **Files:** `Shaders/WebGPU/PostProcess/ColdOptics.wgsl`, `Renderer/WebGPU/WebGPUColdOpticsEffect.ts`, `Scene/AtmosphericEffects.ts`.

#### 4.11 — Data-driven precipitation (WMO ww → type/intensity) + ground accumulation (`PRECIP-DATA`) — ✅ SHIPPED Batch 444 (double-gated dataDriven+provider; `precipFromWmoCode` Table-4677 map, `updateSnowAccumulation` ramp/melt scalar, `densityScaleFromVisibility` 1.0→2.5×; ground snow-albedo shader consumer deferred)

- **Technique:** Map the weather-ingest cube's WMO `ww` code to `PrecipitationType` + intensity (deferred Batch 423), add optional snow ground accumulation, couple particle density to the fog/visibility field.
- **Opt-in flag:** `atmosphericConditions.effects.precipitation.dataDriven` (default `false`).
- **Parity impact:** Default-off keeps manual/auto-master precip selection; data-driven only when an ingest provider is attached + flag set.
- **Files:** `Scene/AtmosphericEffects.ts`, `Renderer/WebGPU/WebGPUWeatherRenderer.ts`.

#### 4.12 — Full RTE camera-relative cloud march (`CLOUD-RTE`, close NEW-WEBGPU-CLOUD-RTE) — ✅ SHIPPED Batch 445 (opt-in `globe.cloudHighPrecision`; `CLOUD_QF_HIGH_PRECISION`=1<<12, cloud UB 120→128 floats packing `encodedCameraHigh/Low`, camera-relative shell intersection + radial-distance helpers; default-off = verbatim Haines f32 form, off/on probe diff 0px)

- **Technique:** Pack `encodedCameraHigh/Low` (EncodedCartesian3); do shell intersection + sample positions in camera-relative coords (sphere center = −cameraPos), removing the residual near-radial f32 cancellation.
- **Opt-in flag:** `qualityFlags` bit `cloudHighPrecision` (default off; ~1m wobble currently unobserved).
- **Parity impact:** Haines closest-point form stays default; DP-emulated path gated off.
- **Files:** `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`.

#### 4.13 — Wire the `auto` fog-quality VPT benchmark (`FOG-AUTO-VPT`) — ✅ SHIPPED Batch 445 (built the missing init benchmark: `VisualPerformanceTargetService.resolveInitialQualityTier(device)` one-shot device-limits classifier; fog `_resolveQuality('auto')` consults it only when `visualPerformanceTarget.enabled`; default VPT-disabled → `auto`→`low` verbatim. Continuous frame-budget auto-tuner stays Phase-1+ deferred)

- **Technique:** Connect `VisualPerformanceTargetService`'s init benchmark to `_resolveQuality` so `auto` upgrades low→medium→high on capable hardware (and downgrades under frame-budget pressure) instead of the hard `auto`→low.
- **Opt-in flag:** `volumetricFog.quality='auto'` (already opt-in; benchmark gated behind VPT availability).
- **Parity impact:** `auto` already → low today; behavior changes only when fog enabled AND quality auto AND VPT present.
- **Files:** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`.

---

## 3. Dynamic Scene-Content Environment Map (C2-25) — Reflections/IBL Epic

This is the headline reflections epic and is sequenced **late** because it depends on the HDR substrate (1.2), the HQ prefilter (1.3), and benefits from temporal amortization (3.x pattern). Default = **WebGL parity**: the procedural-sky fill remains the sole env-cube source; no scene is captured, no dynamic env map, infinitely-distant cube only.

#### 3-A — Dynamic scene-content env map, 6 ENU faces (`ENV-SCENE-CAPTURE`, C2-25) — 🟡 V1 SHIPPED Batch 446 (GLOBE slice; opt-in `contextOptions.webgpu.sceneCaptureReflections` + `DynamicEnvironmentMapManager.enableSceneCapture`, default off, byte-identical-off audited GO; 6 ENU face cameras via `uniformState.updateCamera` → globe rendered into `faceViews` over the compute sky (loadOp=load) → existing mip→prefilter→SH→model tail; new `CAPTURE_MODE`=1<<17 single-target globe pipeline variant + `WebGPUDynamicEnvironmentMapCapture.ts`. Nadir hemisphere captures textured terrain with verified-correct E/W (Big Sur ground-truth). **Remaining:** side-face outward terrain needs per-face quadtree re-selection (`ENV-CAPTURE-PER-FACE-LOD`, next batch); 3D Tiles (447) + glTF (448) geometry capture. See `C2-25_SCENE_CAPTURE_DESIGN.md`.)

- **Technique:** True render-to-cubemap reflections: drive `WebGPUSkyAtmosphereRenderer` / space / sun (+ globe + 3D Tiles + glTF) through **6 per-face ENU view matrices** into the 6 `faceViews` the cache *already allocates*, generate mips, then run `generateIBLMaps` + `ProjectRadianceToSH` on the captured cube. Change-threshold trigger on camera-translation (>N km) / sun-delta / every-K-frames using the existing `framesSinceUpdate` counter. (~250 LOC budgeted in DEFERRED_WORK.)
- **Opt-in flag:** `DynamicEnvironmentMapManager.enableSceneCapture` / `contextOptions.webgpu.sceneCaptureReflections` (default `false`).
- **Parity impact:** Default-false leaves procedural-sky fill as the sole source (current parity). `faceViews` + STORAGE|RENDER_ATTACHMENT cube already exist; enabling adds render passes only when set. WebGL lacks this → additive-only.
- **Files:** `Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts`, `Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js`, `Scene/DynamicEnvironmentMapManager.js`, `Renderer/WebGPU/WebGPUIBLPipeline.ts`.

#### 3-B — Temporal env-cube accumulation / reprojection (`ENV-TEMPORAL`) — **P2, effort M**

- **Technique:** History cube + per-face Hammersley-rotated jitter + exponential blend, invalidate on large sun/camera deltas. Lets scene-capture + clouds-in-IBL run within budget. Shares the temporal accumulation pattern with **3.2** (clouds) and **3.5** (fog).
- **Opt-in flag:** `contextOptions.webgpu.envMapTemporalAccumulation` (default `false`).
- **Parity impact:** Default-false = current single-frame debounced refresh. Pure history buffer + blend.
- **Files:** `Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts`, `Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl`.

#### 3-C — Clouds folded into the reflection env map (`ENV-CLOUDS`) — **P2, effort L**

- **Technique:** Composite the procedural cloud raymarch over the env-sky faces before prefilter (low-res per face, amortized via 3-B), so overcast skies produce diffuse low-contrast IBL. **This is the same coupling as 4.2** — implement once, expose via both the IBL feedback flag and the env-map flag.
- **Opt-in flag:** `contextOptions.webgpu.cloudsInReflections` (default `false`).
- **Parity impact:** Default-false → env-sky faces cloud-free.
- **Files:** `Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl`, `Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts`, `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`.

#### 3-D — Parallax-corrected localized reflections (`ENV-PARALLAX`) — **P2, effort M**

- **Technique:** Lagarde box/sphere reflection proxy: intersect the reflection ray with a per-manager bounding proxy and re-project the cube fetch, so near geometry/interiors reflect plausibly instead of an infinitely-distant cube.
- **Opt-in flag:** `DynamicEnvironmentMapManager.reflectionProxy` (default undefined/off).
- **Parity impact:** Default undefined → raw reflection vector (parity); parallax correction behind a uniform flag default 0.
- **Files:** `Shaders/WebGPU/Model/ModelPBRComplete.wgsl`, `Renderer/WebGPU/WebGPUModelRenderer.js`, `Scene/DynamicEnvironmentMapManager.js`.

**C2-25 sequencing:** `IBL-HDR (1.2)` + `IBL-PREFILTER-HQ (1.3)` → `ENV-AERIAL-MS (2.2)` makes the *procedural* env sky multi-scatter-correct → then `ENV-SCENE-CAPTURE (3-A)` captures real geometry → `ENV-TEMPORAL (3-B)` makes capture affordable → `ENV-CLOUDS (3-C)` + `ENV-PARALLAX (3-D)` are independent polish on top.

---

## 4. Sequencing + Dependencies

```
PHASE 1 (foundation, P0)
  A-LUT-REPARAM (1.1) ──────────────┐ unblocks all multi-scatter consumers
  IBL-HDR (1.2) ────────┐           │
  IBL-PREFILTER-HQ (1.3)┘ unblocks env-map quality
                        │           │
PHASE 2 (wire MS consumers, P1)     │
  SKY-MS (2.1) ◄────────────────────┤ (needs sun-relative LUT)
  ENV-AERIAL-MS (2.2) ◄── 2.1 + 1.2/1.3
  AERIAL-FROXEL (2.3) ◄── 1.1
  FOG-IBL-AMBIENT (2.4) ◄── 1.1 (+ existing SH buffer)
                        │
PHASE 3 (cloud spine + coupling, P0/P1)
  CLOUD-HALFRES (3.1) ──┐
  CLOUD-TEMPORAL (3.2) ◄┘ (pairs with half-res)   ── shared temporal pattern ──┐
  CLOUD-AERIAL-LUT (3.3) ◄── 2.3                                                │
  CLOUD-AMBIENT-LUT (3.4) ◄── 2.1/2.2                                           │
  FOG-TEMPORAL (3.5) ◄────────────────────────────── shared temporal pattern ──┤
  CLOUD-CONE-LIGHT (3.6)  (independent perf)                                    │
                        │                                                       │
PHASE 4 (polish, P1/P2)                                                         │
  CLOUD-SHADOWS (4.1) ── one beer-shadow map → terrain + aerial + fog + env     │
  CLOUD-IBL (4.2) ═══ same coupling as ENV-CLOUDS (3-C)                         │
  FOG-MS (4.3), SKY-MOON (4.4), SKY-OZONE (4.5), MIE-PHASE (4.6)                │
  CLOUD-CURL (4.7), CLOUD-PW-NOISE (4.8), CLOUD-MULTIDECK (4.9)                 │
  COLD-OPTICS-HQ (4.10), PRECIP-DATA (4.11), CLOUD-RTE (4.12), FOG-AUTO-VPT(4.13)
                        │                                                       │
C2-25 REFLECTIONS EPIC ◄── 1.2/1.3/2.2                                          │
  ENV-SCENE-CAPTURE (3-A) → ENV-TEMPORAL (3-B) ◄──── shared temporal pattern ───┘
                          → ENV-CLOUDS (3-C ≡ 4.2) → ENV-PARALLAX (3-D)
```

**Key unlock chains:**

- **`A-LUT-REPARAM` (1.1) is the keystone.** It unblocks `SKY-MS`, `ENV-AERIAL-MS`, `AERIAL-FROXEL`, `FOG-IBL-AMBIENT`, `CLOUD-AMBIENT-LUT` — five items that all need a sun-relative, off-meridian-correct table. Do it first.
- **One temporal-reprojection pattern serves four passes** (clouds 3.2, fog 3.5, env-cube 3-B, and the latent sky/cloud TAA coupling). Build the `previousViewProjection` reproject + neighborhood-clamp helper once; reuse the WGSL.
- **One beer-shadow-map (`CLOUD-SHADOWS` 4.1) serves four consumers** (terrain, aerial perspective, fog, env-map ground term) — supersedes three separate cloud-shadow approximations currently scattered across the audits.
- **One cloud-radiance→SH injection (`CLOUD-IBL` 4.2 ≡ `ENV-CLOUDS` 3-C)** serves model IBL, fog ambient, and the reflection cube — implement the compositing once.
- **`AERIAL-FROXEL` (2.3) feeds `CLOUD-AERIAL-LUT` (3.3)** — the cloud aerial coupling should sample the same froxel volume rather than re-derive.

---

## 5. Quick Wins vs Epics

### Quick wins (S/M effort, high leverage, low blast radius — do early)

| Item | Effort | Why it's a quick win |
|---|---|---|
| **IBL-HDR (1.2)** | S | Texture-format swap; unblocks all HDR-dependent reflection quality |
| **FOG-AUTO-VPT (4.13)** | S | Wire an existing benchmark to an existing resolver; one file |
| **SKY-MS (2.1)** | M | Compute pass *already runs every frame* — only a sampler binding + an add; finishes dead scaffolding (Principle 9) |
| **IBL-PREFILTER-HQ (1.3)** | M | Localized to one shader + one pipeline; kills visible firefly aliasing |
| **FOG-IBL-AMBIENT (2.4)** | M | Reuses the existing `_webgpuSHBuffer`; replaces one flat constant |
| **CLOUD-CONE-LIGHT (3.6)** | M | Self-contained inner-loop swap; ~½ the dominant light-march cost |

### Epics (L effort or multi-file / cross-subsystem — schedule deliberately)

| Item | Effort | Scope |
|---|---|---|
| **A-LUT-REPARAM (1.1)** | L | Re-parameterizes the core LUT; touches bake + 3 consumers; the keystone dependency |
| **CLOUD-HALFRES (3.1) + CLOUD-TEMPORAL (3.2)** | M+L | Activates the entire dormant tier spine; new offscreen target + ping-pong history; biggest cloud perf win |
| **AERIAL-FROXEL (2.3)** | L | New 3D froxel LUT compute pass + bind plumbing |
| **CLOUD-SHADOWS (4.1)** | L | New sun-view shadow pass + 4 consumer shaders |
| **CLOUD-IBL (4.2) / ENV-CLOUDS (3-C)** | L | Cloud radiance → SH/IBL injection across model + fog + env |
| **ENV-SCENE-CAPTURE (3-A, C2-25)** | L | 6-face scene re-render + change-threshold + prefilter/republish (~250 LOC) |
| **CLOUD-MULTIDECK (4.9)**, **PRECIP-DATA (4.11)** | L | Multi-shell march / weather-ingest coupling |

**Recommended first sprint:** `IBL-HDR` → `IBL-PREFILTER-HQ` → `SKY-MS` (three quick wins that finish dead scaffolding and establish the HDR/MS substrate), then start the `A-LUT-REPARAM` epic in parallel since everything in Phase 2 waits on it.

**Files of record to update as items land (per CLAUDE.md):** move each entry from `FEATURE_INVENTORY.md` §C/§D → §B on ship; close `NEW-ATMOSPHERE-LUT-SUN-RELATIVE`, `NEW-WEBGPU-CLOUD-RTE`, `NEW-GROUND-VIEW-ENV-DIVERGENCES`, and `C2-25` in `DEFERRED_WORK.md`; keep `IMAGERY_PROJECTION.md` untouched (no projection-chain files here) and log any sky/cloud fix in `WEBGPU_DEBUGGING_LOG.md`.
