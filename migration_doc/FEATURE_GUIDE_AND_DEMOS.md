# Feature Guide & Demo Index — CesiumJS WebGPU Fork

> **Canonical doc (consolidation first draft, 2026 consolidation).**
> Supersedes (folds the user-facing "how do I turn this on / which demo shows it"
> half of): `CLOUD_RENDERING_STRATEGY.md`, `CAMPAIGN3_PROGRESS.md`,
> `ATMOSPHERIC_EFFECTS_ROADMAP.md`, `ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md`,
> `WEATHER_DATA_INGEST_ROADMAP.md`, `WEATHER_RECREATION_ROADMAP.md`,
> `C2-25_SCENE_CAPTURE_DESIGN.md`, `CELESTIAL_ATMOSPHERE_DESIGN.md`,
> `SLICE_5D_PLAN_CLUSTERED_LIGHTING.md`, `LARGE_DYNAMIC_OBJECTS_DESIGN.md`,
> `DP-H46_METADATA_DESIGN.md`, `TAA_DESIGN.md`, `CSM_DESIGN.md`,
> `WATER_RENDERING_DESIGN.md`. **Review-in-progress.**
>
> Companion to `FORK_OVERVIEW` (the *what & why*). This doc is the *how*:
> mechanism, public API/dial, opt-in flag, parity-default behaviour, and the
> Sandcastle demo that exercises each feature.
>
> **Accuracy note:** statuses below were re-verified against the live code and
> `git log` at HEAD ≈ Batch 455 (2026-06-30), NOT lifted from the (up-to-300-batch-
> stale) source docs. Items I could not fully confirm are marked **(status: verify)**.

---

## 1. How To Read This

Every feature entry follows the same shape:

| Field | Meaning |
|---|---|
| **Mechanism** | How it works under the hood (renderer, pass, shader, buffer). |
| **Dial / API** | The public property or method you set. Almost all live on `scene`, `scene.globe`, or the `scene.globe.atmosphericConditions` facade. |
| **Opt-in?** | Whether it is OFF by default. The fork's governing rule (CLAUDE.md Principle 1 + 5) is **WebGL parity is the default**; new fidelity is opt-in. |
| **Parity-default** | What the render looks like when the flag is OFF — for nearly every fork feature this is "byte-identical to the pre-feature render." |
| **Demo** | The Sandcastle demo that shows it (see §11 for the full index). |
| **Backend** | Most new fidelity features are **WebGPU-only** with a documented WebGL degradation (graceful no-op). Renderer-agnostic features (clustered lighting, KHR extensions) work on both. |

**The "parity-default opt-in" contract.** The overwhelming majority of fork
features default OFF and are byte-identical to upstream when off. They are turned
on by a flag and then dialed with secondary knobs. When reading any entry, the
default state is "looks like upstream WebGL" unless stated otherwise.

---

## 2. Renderer Selection & Build Variants

### Picking a backend

Renderer selection is per-`Viewer`/`Scene` via `contextOptions.renderer`. Source of
truth: `packages/engine/Source/Renderer/RendererType.ts`.

```js
const viewer = new Cesium.Viewer("cesiumContainer", {
  contextOptions: { renderer: "webgpu" }, // "webgl" | "webgpu" | "auto"
});
```

- Values map to `RendererType.WEBGL | WEBGPU | AUTO`.
- `AUTO` resolves through `setGlobalDefaultRenderer()`; the global default in the
  default (dual) build is **WebGPU** (`RendererType.ts:97` — `_globalDefaultRenderer = RendererType.WEBGPU`),
  falling back to WebGL when WebGPU is unavailable (feature detection).
- The variant entry barrels (`Source/Cesium.js`, `Source/CesiumWebGLOnly.js`,
  `Source/CesiumWebGPUOnly.js`) each call `setGlobalDefaultRenderer()` at module
  init to set the right default for that bundle.

### The `usePostProcess` requirement (WebGPU)

**Critical runtime invariant:** the WebGPU renderer REQUIRES the post-process
pipeline to blit the scene framebuffer to the canvas, so `usePostProcess` must
always be true for WebGPU (unlike WebGL, which can render directly to the canvas).
Probe/test URLs always run WebGPU with post-process on. This is why every WebGPU
effect (TAA, SSR, god-rays, bloom, DoF, AO) plugs into the same post-process chain.

### Build variants (tree-shaking)

Three bundles reduce download size when only one backend is needed (full detail in
CLAUDE.md → Build Variants):

| Variant | Build cmd | Output | Size (min IIFE) |
|---|---|---|---|
| dual (WebGPU-first, default) | `npx gulp buildCesiumDual` | `Build/Cesium` | 7.1 MB |
| WebGPU-only | `npx gulp buildCesiumWebGPUOnly` | `Build/CesiumWebGPU` | 6.4 MB (−10%) |
| WebGL-only | `npx gulp buildCesiumWebGLOnly` | `Build/CesiumWebGL` | 5.6 MB (−21%) |

Smoke test after touching the variant plumbing: `node Tools/variant-smoke-test.mjs`.

---

## 3. Sky / Atmosphere / Celestial

All sky/atmosphere/celestial state is exposed through the **`scene.globe.atmosphericConditions`**
facade (`packages/engine/Source/Scene/AtmosphericConditions.js`). The facade is a
thin set of getters/setters over the legacy `scene.atmosphere`, `scene.fog`,
`scene.skyAtmosphere`, and `Globe` fields — it does NOT migrate data; legacy
properties remain the source of truth. New Phase-1+ state with no legacy backing
lives directly on the facade leaf objects.

### `atmosphericConditions.*` toggle tree (verified against live source)

```
scene.globe.atmosphericConditions
├── scattering          → rayleighCoefficient, mieCoefficient,
│                          rayleighScaleHeight, mieScaleHeight, mieAnisotropy
│                          (setters fan out to scene.atmosphere + skyAtmosphere + globe)
├── lighting            → enableSunLight(t), enableMoonLight(t), enableMoonPhase(t),
│                          enableEarthshine(f), enableDualLightAtmosphere(t),
│                          moonIntensity(0.05), lambertDiffuseMultiplier,
│                          vertexShadowDarkness, dynamicAtmosphereLighting,
│                          dynamicAtmosphereLightingFromSun
├── skyAtmosphere       → show, perFragment, lightIntensity, hueShift,
│                          saturationShift, brightnessShift,
│                          starModulationCurve{inflection:0.5, steepness:1.0},
│                          enableStarBrightnessModulation(t), enableNightSkyDimming(t)
├── groundAtmosphere    → enabled, perFragment(f), lightIntensity, hue/sat/brightnessShift,
│                          lightingFadeIn/Out, nightFadeIn/Out
├── atmosphere          → lightIntensity, hue/sat/brightnessShift, dynamicLighting
├── fog                 → enabled, renderable, density, heightScalar, heightFalloff,
│                          maxHeight, visualDensityScalar, screenSpaceErrorFactor,
│                          minimumBrightness
├── volumetricFog       → (see §8) enabled(f), quality, maxDistance, density, falloff,
│                          fogAnisotropy, fogAlbedo, ambientStrength, iblAmbient(f),
│                          temporal(f), multiScatter(f), msOctaves(1)
├── varyingAtmosphereDensity → enabled(f), noiseScale, noiseStrength
├── clouds              → (see §4) full cloud dial set
├── weather             → humidity(0.5), airQuality(1.0), temperature(15°C),
│                          dewpoint(5°C), cloudCover, enabled, type, intensity,
│                          windSpeed, windDirection  (wind fans out to globe cloud wind)
├── night               → enableNightLights, nightIntensity
└── effects             → (see §8 — conditions→effects) auto(f) master +
                           shimmer{enabled,intensity:0.6},
                           groundFog{enabled,intensity},
                           optics{enabled,halo,sunDogs,pillar},
                           precipitation{enabled,type,intensity,dataDriven,snowAccumulation,snowCover}
```
(`(t)` = default true, `(f)` = default false.)

### Headline sky features (re-verified)

- **Sun-relative sky-view LUT + multiple-scattering sky** (improvement-plan 1.1 / 2.1,
  Batches 427–429). Reparametrizes the sky LUT onto the sun-relative sky-view domain
  and adds multiple-scattering in the visible sky. Opt-in, parity default.
- **Dual-light atmosphere** (`lighting.enableDualLightAtmosphere`, default ON but
  visually identical by day / at new moon because the moon term is gated to zero
  below the horizon and scaled by phase fraction). The sky shader samples a SECOND
  inscatter LUT for the moon. **Demo:** *WebGPU Dual-Light Atmosphere*.
- **Sky physics extras** (improvement-plan 4.4/4.5/4.6, Batch 438): SKY-OZONE,
  MIE-PHASE, SKY-MOON. Opt-in, parity default.
- **Fullscreen view-independent sky** — toggles between the ellipsoid-shell sky
  (WebGL-parity default) and a fullscreen-pass sky that reconstructs the per-pixel
  view ray. WebGPU only. **Demo:** *WebGPU Fullscreen Sky*.
- **Star brightness modulation / night-sky dimming** (`skyAtmosphere.starModulationCurve`,
  `enableStarBrightnessModulation`, `enableNightSkyDimming`).
- **Procedural sky cubemap** (`ProceduralSkyCubemap.wgsl`, Batches 346 + 430) — a
  1:1 port of the visible-sky atmosphere into the dynamic environment map; shares the
  sun-relative sky-view / MS LUTs. Feeds IBL (see §5).

---

## 4. Clouds & Weather

### Volumetric procedural clouds

- **Mechanism:** a Schneider/Nubis-style volumetric raymarcher
  (`WebGPUProceduralCloudRenderer.ts` + `Shaders/WebGPU/Environment/ProceduralClouds.wgsl`):
  a spherical cloud shell marched per-pixel, HG dual-lobe phase + Beer–Powder
  lighting + energy-conserving multi-scatter octaves, a 2D lat/lon weather map for
  spatial coverage, and (since the tiered-cloud rearchitecture) **baked 3D
  Perlin-Worley / Worley noise textures** (`CloudNoiseBake.wgsl` +
  `WebGPUCloudNoiseResources.ts`) with the live `fbmNoise` else-branch as the
  cheap-tier fallback. The legacy name "procedural" is historical — it has been
  volumetric since it landed.
- **Master toggle:** `globe.showProceduralClouds = true` (alias:
  `atmosphericConditions.clouds.enableProcedural` / `.enableVolumetric`). WebGPU only;
  no-op on WebGL (which keeps billboard `CloudCollection`). Default OFF.
- **Quality dial:** `globe.cloudVolumetricQuality` ∈ `"low" | "medium" | "high" | "auto"`
  (= `(maxSteps, lightSteps)` of `(24,3)/(48,4)/(96,8)/altitude-picked`). Raw escape
  hatch: `globe.cloudQuality` (a `maxSteps` int 32–128; a non-64 value overrides the
  preset verbatim).
- **Appearance dials** (each `undefined` → renderer default, set to override live, no
  rebuild; all proxied on `atmosphericConditions.clouds.*`):
  `cloudCoverage`, `cloudDensity`, `cloudLayerBottom/Top`, `cloudWindSpeed/Direction`,
  `cloudAerialStrength`, `cloudSilverLiningIntensity`, `cloudPhaseForwardG/BackG/Blend`,
  `cloudAmbientIntensity`, `cloudErosionStrength`, `cloudCurlAmplitude/Frequency`,
  `cloudNoiseMorphology` (`"value"` default / `"perlin-worley"`), `cloudPuffSize`,
  `cloudExposure`, `cloudMsDecayScatter/Extinction/Phase`, `cloudType` (a `CloudType`
  genus index → per-genus vertical density profile), `cloudWeatherChannelStrength`.
- **Opt-in fidelity flags** (parity-default OFF, each byte-identical when off):
  - `globe.cloudCastShadows` — beer shadow map → darkens ground / attenuates aerial /
    shades volumetric fog (improvement-plan 4.1, Batch 437).
  - `globe.cloudMultiDeck` — marches ONE shell per active deck (LOW cumulus / MID
    altocumulus / HIGH cirrus, bounds from `CloudTypeProfile`) composited front-to-back
    (improvement-plan 4.9, Batch 443).
  - `globe.cloudContributesIBL` — overcast cloud cover folds into the dynamic env-map
    IBL / SH ambient so models/tiles get flatter overcast light (improvement-plan 4.2,
    Batch 441/450).
- **Spatial weather map (the "C2-16 seam"):** `globe.cloudWeatherMap = true` samples a
  256×128 `rgba8unorm` lat/lon weather texture per world position so coverage varies
  spatially. R=coverage, G=genus, B=cloud-base, A=density-bias. Until real data is
  wired, the map is filled procedurally (FBM); the WGSL G/B/A reads are gated by
  `cloudWeatherChannelStrength` (neutral cell G=0.5/B=0/A=0.5 is byte-identical).

### CloudUniforms model — LIVE float count = **128**

> **Verified by reading the live WGSL struct**
> (`Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, `struct CloudUniforms`,
> last field `_padH` at float index **127** → 128 floats total). Do **not** trust the
> stale 80/92/96/100/108/112 figures scattered across the source docs — the struct
> grew add-only across the campaign (started at 80).

Selected layout landmarks (all add-only; the JS packer in
`WebGPUProceduralCloudRenderer.ts` and the WGSL struct move byte-identically):

| Float(s) | Field | Added |
|---|---|---|
| 64–71 | weatherMapEnabled, weatherStrength, phaseG2, phaseBlend, weatherTexBounds | Weather Phase 1 |
| 72–79 | phaseG1, ambientIntensity, **qualityFlags@74** (tier bitfield), curlAmplitude@75, frameCounter, curlFrequency, lightSampleScale, erosionStrength | W1 / V1 tier lane / 4.7 curl |
| 80–95 | skyAmbientColor, groundAmbientColor, sunLightColor, aerialStrength, aerialColor | W2/W3/W4 |
| 96–104 | puffSize, exposure, msDecayA/B/C, profileShape, profileDensityScale, profileExtinction, anvilBias | Batch 407/408/452 (per-genus) |
| 105–107 | nearPlane, farPlane, weatherChannelStrength | depth occlusion / Weather Phase 3 |
| 108–111 | aerialLutMode, ambientLutMode, atmosphereThickness | Batch 434 atmosphere-LUT coupling |
| 112–119 | multiDeck + deckBounds Low/Mid/High | Batch 443 multi-deck |
| 120–127 | encodedCameraHigh/Low (CLOUD-RTE high-precision march) | Batch 445 |

### Cloud quality tiers (the "match-WebGL-default, opt-in-better" model)

The tiered-cloud rearchitecture (Campaign 3 v2, V0–V16, shipped under the
improvement-plan naming, batches 437–452) landed the baked-3D-noise keystone, the
`qualityFlags@74` tier lane, half-res (CLOUD-HALFRES, Batch 432), temporal reprojection
(CLOUD-TEMPORAL, Batch 433), IGN jitter, curl, MS-octave geometric decay, per-genus
profiles + `profileExtinction` (452), multi-deck (443), cloud shadows (437), god-rays,
and precip (444). **Status (verified 2026-06-30, Batch 453 reconcile):** V0–V16 are
FUNCTIONALLY COMPLETE; **only V17 (baked-impostor far-field) remains, deferred as
speculative Ultra-only research.**

### Real-weather ingest (data → the weather map)

- **API:** `globe.weatherProvider = <WeatherProvider>`. A `WeatherProvider`
  (backend-agnostic, `packages/engine/Source/Scene/Weather/`) fetches a cloud-cover
  field from an open data source and bakes it into the weather-map texture,
  auto-enabling the data-driven path once data arrives. WebGPU only.
- **Sources shipped (verified `git log`):**
  - `EdrWeatherSource` — OGC API-EDR `cube` → CoverageJSON (NOAA/NWS-MDL GFS, `TCDC`).
    The recommended default (no-auth, public-domain, native-JSON, no GRIB2 decode).
  - `MetarWeatherSource` (Batch 425) — parses station cloud groups (FEW/SCT/BKN/OVC +
    ceiling + CB/TCU genus), IDW-rasterizes to a full RGBA field (the one source that
    exercises the whole G/B/A path).
  - `WcsCoveragesWeatherSource` (Batch 425) — MSC GeoMet OGC API-Coverages →
    CoverageJSON (R coverage; binary GeoTIFF/NetCDF decode deferred).
  - `SyntheticWeatherSource` — deterministic time-varying field for offline tests.
- **Time model** (Batch 416): `WeatherTimeMode` (`live`/`historical`/`projected`) +
  `setTimeMode/setTime/setForecastOffsetHours/setQuantizeHours/tick(now)`, LRU
  slice cache, runtime source-swap.
- **Status (verified):** Phases P0/P1 (EDR→texture, R-only), P2 (time), P3 (full
  RGBA + the 3 real sources) SHIPPED; verified end-to-end OFFLINE via mock-EDR/-METAR/-WCS
  fixtures. **The one residual is the live network hop** (real endpoint + CORS + the
  guessed collection id `automated_gfs`) — the dev sandbox has no outbound network, so
  the live feed is wired but unconfirmed against a real server. **P4 (binary
  GRIB2/NetCDF behind WASM, requires a proxy)** is the deferred high-fidelity tier.
- **Demos:** *WebGPU Live Weather (EDR)* (live GFS via the dev server's `/proxy`),
  *WebGPU Weather Inspector* (all cloud + atmosphere dials + METAR/WMO presets).

### METAR/WMO presets

The Weather Inspector demo applies industry-standard presets keyed to METAR oktas +
WMO cloud genera (SKC / FEW Cu / SCT Cu / BKN Sc / OVC St / Ns rain / Cb storm / Ci).

---

## 5. Reflections & IBL

### Dynamic environment map + IBL chain

The reflective IBL chain is source-agnostic and fully wired:
`runProceduralSkyFill → runSceneCapture → runIBLPrefilter (generateIBLMaps) →
runSphericalHarmonicProjection (ProjectRadianceToSH)`, publishing
`_webgpuIBLDiffuseView / _webgpuIBLSpecularView / _webgpuSHBuffer` consumed by
`WebGPUModelRenderer` at bindings 33/34/35/36 (`WebGPUDynamicEnvironmentMapManager.ts`).
The SH-L2 specular IBL path (`ProjectRadianceToSH.wgsl`, Batch 354) projects the
radiance cube → 9 SH-L2 coefficients.

### C2-25 — Dynamic Scene-Content Capture (the epic — CLOSED)

> **Status (verified `git log`): the C2-25 epic is CLOSED at Batch 451.** The sky env
> map shipped earlier (346 + 430); C2-25 added **geometry** reflections.

- **What it does:** opaque globe terrain AND nearby 3D Tiles / glTF models render into
  a model's dynamic environment cube, so they appear in its reflective PBR surface —
  not just the sky.
- **Mechanism:** a per-face override-camera capture pass (generalizes the CSM
  override-camera mechanism to color) into the 6 `cache.faceViews`, behind a mandatory
  add-only `CAPTURE_MODE` ShaderDefine bit (`1<<4`) that selects a single-location
  `FragOutput` variant; a SEPARATE `_capturePipelineCache` that never bumps the
  on-screen pipeline generation; a transient shared depth target; sky preserved via
  `loadOp:'load'`.
- **Increments (all shipped):** Batch 446 globe slice → 447 model/3D-Tiles slice → 448
  3D Tileset verified + demo → 449 3-B ENV-TEMPORAL (temporal env-cube accumulation) →
  450 3-C ENV-CLOUDS / CLOUD-IBL-FULL (clouds folded into the reflection env map) →
  **451 3-D ENV-PARALLAX (Lagarde parallax-corrected localized reflections) — closes
  the epic.**
- **Opt-in:** `DynamicEnvironmentMapManager.enableSceneCapture = true` +
  `contextOptions.webgpu.sceneCaptureReflections`. WebGPU only. Default OFF is
  byte-identical (probe-proven `probe-scene-capture-off.mjs`).
- **Known V1 limitation (documented, not a bug):** capture reuses the main-camera-
  selected visible tile set, so faces pointing away from the main view get
  coarse/absent tiles. Per-face quadtree re-selection is explicitly deferred.
- **Demo:** *WebGPU Scene Capture Reflections* (legacy gallery).

---

## 6. Lighting & Shadows

### Forward+ clustered lighting (renderer-agnostic feature, WebGPU consumer)

> **Status (verified — Slice 5d):** SHIPPED end-to-end (Batch 153) and consumed by
> Model PBR + all 19 primitive `Mat*Lit` shaders + the legacy Phong primitives
> (Batches 154–158).

- **Mechanism:** two compute passes — cluster bounds (`ClusterBounds.wgsl`,
  16×9×24 = 3456 clusters, exponential depth slicing) + light-to-cluster assignment
  (`ClusterAssign.wgsl`, sphere-AABB) — write per-cluster light index lists into
  storage buffers, consumed by the fragment shaders via the `ClusteredLighting.wgsl`
  chunk (`evalClusteredLights` = Lambert + Cook-Torrance GGX with KHR_lights_punctual
  smooth falloff). The 5 cluster bindings fold into the existing **group 3 (effects)**
  BGL at bindings 18..22 (the `@group(4)` approach was blocked by the platform
  `maxBindGroups: 4` ceiling).
- **API:** `scene.clusteredLightingEnabled = true`; populate `scene.lights` with
  `new Cesium.PointLight(...) / SpotLight / DirectionalLight` (cap
  `LightCollection.MAX_LIGHTS = 8` scene-level; cluster assign caps at 1024 total).
  glTF `KHR_lights_punctual` lights are loaded and merged automatically
  (`model.lightsFromGltf`).
- **Demo:** *WebGPU Clustered Lighting* (6 orbiting colored point lights on glTF models
  + a lit ground plane). Also *WebGPU Custom Scene Light Color* (custom `czm_lightColor`
  → globe Lambert).

### Shadows

- **CSM (cascaded shadow maps):** cast pass + math shipped (CSM_DESIGN.md). Used by the
  override-camera capture precedent. **(status: verify — confirm consumer wiring depth
  against CSM_DESIGN before quoting "complete".)**
- **Point-light cube shadows:** SHIPPED (Batch 165). Toggle 5-tap PCF softness.
  **Demo:** *WebGPU Point Light Shadows*.

---

## 7. Models & Materials

### KHR extensions + PBR

- glTF model PBR runs through `ModelPBRComplete.wgsl`. `KHR_lights_punctual` loaded
  (see §6). `KHR_materials_specular` SH IBL path shipped (Batch 354).
- The KHR matrix / pipeline-stage parity is broad; cross-reference
  `FEATURE_INVENTORY.md §3` for the per-extension SHIPPED/WIP grid (do not quote a
  single status here — the per-extension state is what matters).

### Metadata-in-shader + pickMetadata (DP-H46 — IN PROGRESS)

> **Status (verified `git log`): the DP-H46 epic is the ACTIVE work at HEAD.** DP-H46a
> (GPU upload + binding scaffolding, Batch 454) and DP-H46b (per-model WGSL metadata
> codegen — property-attribute struct + `initializeMetadata`, Batch 455) have SHIPPED,
> both opt-in / parity-default. DP-H46c (property textures), DP-H46d (property tables),
> DP-H46e (`scene.pickMetadata` producer), and DP-H46f (parity probe + demo) remain.

- **Goal:** port the `EXT_structural_metadata` / `EXT_mesh_features` metadata-in-shader
  pipeline from GLSL to WGSL so the WebGPU model shader can read metadata properties,
  then wire `scene.pickMetadata` on WebGPU.
- **Mechanism:** a per-model `MetadataWGSLPipelineStage` emits `struct Metadata` +
  `fn initializeMetadata(...)` WGSL, prepended at the single injection point in
  `WebGPUModelPipelineCache`, gated by an add-only `MODEL_HAS_METADATA` ShaderDefine
  bit (stub struct + no-op when unset → non-metadata models byte-identical).
- **Parity guard:** codegen runs ONLY when the model has structural metadata AND the
  primitive maps to ≥1 property-attribute/-texture/-table; otherwise the prepend is an
  empty string and the bit is not set → byte-identical module + cache key.
- **No demo yet** (lands in DP-H46f).

---

## 8. Effects & Post-Process

All WebGPU post-process effects live in the post-process chain (`WebGPUPostProcessPipeline`)
and require `usePostProcess` (see §2). Effect renderers (verified present in
`Renderer/WebGPU/`): `WebGPUTAAEffect`, `WebGPUSSREffect`, `WebGPUGodRayEffect`,
`WebGPUBloomEffect`, `WebGPUDepthOfFieldEffect`, `WebGPUAmbientOcclusionEffect`,
`WebGPUAutoExposure`.

| Effect | Mechanism / dial | Demo |
|---|---|---|
| **TAA** | Temporal anti-aliasing; reads `camera.previousViewProjection`; G-buffer normal-divergence disocclusion rejection (Batch 126). `TAA.wgsl`. | *WebGPU Temporal Anti-Aliasing* |
| **SSR** | Screen-space reflections; tunable max distance / thickness / ray-march steps / stride / strength; reads G-buffer normals when deferred lighting is on. `ScreenSpaceReflections.wgsl`. | *WebGPU Screen Space Reflections* |
| **God rays** | Volumetric light-shaft post-process; density/decay/weight/exposure/sample-count. `GodRayGenerate/Composite.wgsl`. Cloud transmittance can feed it (improvement-plan). | *WebGPU God Rays* |
| **Bloom** | HDR bloom composite. `BloomComposite.wgsl`. | *Bloom* (upstream gallery) |
| **DoF** | Depth-of-field; upstream stage wired through the WebGPU pipeline (Batch 98). `DepthOfField.wgsl`. | *WebGPU Depth of Field* |
| **Ambient occlusion (SSAO)** | `AmbientOcclusionGenerate/Modulate.wgsl`; reads G-buffer normals when deferred lighting is on. | *Ambient Occlusion* (upstream gallery) |
| **AutoExposure / Tonemap / ColorGrading** | 5 tonemapping operators in the post chain. | (within other demos) |

### Volumetric fog (froxel grid)

- **Mechanism:** a froxel-grid participating-media renderer
  (`WebGPUVolumetricFogRenderer`) — compute integrate + composite.
- **Dial:** `atmosphericConditions.volumetricFog.*` — `enabled` (default OFF),
  `quality`, `maxDistance`, `density`, `falloff`, `fogAnisotropy` (HG g), `fogAlbedo`,
  `ambientStrength`, plus opt-in `iblAmbient` (sky-LUT/SH-driven ambient, Batch 431),
  `temporal` (reproject + blue-noise jitter, Batch 435), `multiScatter`/`msOctaves`
  (Frostbite octaves, Batch 440). All opt-in, parity-default.
- **Demo:** *Volumetric Effects* (fog + clouds + cloud shadows stacked).

### Conditions → effects (weather-driven screen-space)

`atmosphericConditions.effects` nests `shimmer / groundFog / optics / precipitation`
with a master `effects.auto` flag. When `auto` is true, `applyAtmosphericConditions()`
derives each effect's enabled+intensity from the weather (temperature / dew-point
spread / precip). All OFF + `auto` false by default (byte-neutral). Status (verified
ATMOSPHERIC_EFFECTS_ROADMAP + `git log`):

- **Heat shimmer** — screen-space animated UV-warp (`WebGPUHeatShimmerEffect`,
  Batch 417b). Gated on `scene.heatShimmerEnabled`/`Intensity`.
- **Ground fog** — near-surface density band on the froxel renderer (Batches 420/421).
- **Cold optics** — 22° halo + sun-dogs (`WebGPUColdOpticsEffect`, Batch 422); LIGHT
  PILLARS + 22°/46° dispersed halos + upper-tangent arc behind `effects.optics.advanced`
  (Batch 442).
- **Precipitation** — rain/snow/fog/hail particles wired to the existing
  `WebGPUWeatherRenderer` (Batch 423); `PrecipitationType` enum; opt-in `dataDriven`
  (WMO `ww` → precip type, Batch 444) + `snowAccumulation`. **Demo:** *WebGPU Weather
  Particles*.

---

## 9. Large Dynamic Objects & Performance Dials

The "large dynamic objects" work picks a data path per **update regime** (LARGE_DYNAMIC_OBJECTS_DESIGN.md).

- **Regime 1 — sparse dynamic:** resident CPU instance array + per-instance partial
  `writeBuffer` (`WebGPUResidentInstanceBuffer`). Billboard/Point/Label wired
  (Batch 232). Foundation: `_consumeDirtyState` dirty-consume discipline across
  collections.
- **Regime 2 — dense arbitrary:** flat SoA `Buffer*` collections + WASM RTE-encode
  kernel (`batch_rte_encode`, `WasmRTEBridge`), threshold-gated (≥2000). Wired into
  WebGPU + WebGL Buffer* repack (Batch 272/273). The measured win is an encode-strategy
  hoist, not WASM SIMD. **Demo:** *WebGPU Vector Tile Buffer Rendering* (50K points
  single-draw), *WebGPU GeoJsonPrimitive* (GeoJSON → BufferPoint/Polyline/Polygon).
- **Regime 3 — dense derivable (orbital):** the headline WebGPU-first feature. A
  feature-agnostic **compute-instance system** (`Scene/ComputeInstanceCollection.js` +
  `WebGPUComputeInstanceRenderer.ts`): the catalog uploads once, a user-supplied WGSL
  kernel `csm_computeInstance(index, time)` propagates positions each frame into a
  storage buffer, and an instanced draw vertex-pulls by `instance_index` — positions
  never leave the GPU. The engine owns bindings/bounds-check/RTE split; all orbital
  domain knowledge (element layout, SGP4) is demo content.
  **Demos:** *WebGPU Orbital Catalog* (user WGSL kernel), *WebGPU SGP4 Satellites* (df64
  SGP4 kernel — TLEs in, GPU-resident positions out), *WebGPU Keyframe Catalog* (GPU
  analogue of `SampledPositionProperty`).
- **Regime 4 — ECS-in-WASM-on-worker:** **conditional / likely-not-needed**; gated
  behind a go/no-go spike (SAB needs COOP/COEP, currently unset). Do not treat its
  scaffolding as dead code (Principle 7).

Performance / async dials worth knowing:
- **Deferred lighting:** `scene.deferredLighting = true` enables the G-buffer producer
  (Phase 8a); SSAO + SSR then read surface normals from the G-buffer instead of
  reconstructing from depth → sharper silhouettes. **Demo:** *WebGPU Deferred Lighting*.
- **Async resource monitor:** pipeline cooks, image decodes, p50/p95/p99 latency,
  warm-on-suspicion. **Demo:** *WebGPU Async Resource Monitor*.
- **Entity bulk static-lane fast-path** vs legacy per-frame visualizers. **Demo:**
  *WebGPU Bulk vs Legacy Visualizers*.
- High-density culling / HiZ / sort-keys: `CesiumDebug.highDensityCull()` (see §12).

---

## 10. Snapshot Mode & Headless

> **(status: verify)** There is **no dedicated standalone "snapshot mode" public API**
> surfaced in the docs reviewed. The relevant facts confirmed in code:

- **`AtmosphericConditions.clone()`** returns a JSON-serializable snapshot of facade
  state (currently scattering-only; full structured snapshot is a TODO Phase 2).
- **Scene-capture "snapshot"** in C2-25 refers to the per-face camera snapshot/restore
  invariant inside `runSceneCapture` (try/finally around the 6-face loop), NOT a
  user-facing screenshot API.
- **Headless / worker:** `OPTION_B_SCENE_IN_WORKER.md` (scene-in-worker via
  OffscreenCanvas) is **research-stage / DOM-blocked**, not shipped. The headless
  `TaskProcessor` worker path is used for compute kernels (Regime 4 spike), not for
  scene rendering.
- For automated capture, the project standard is the **Playwright probe harness**
  (`Tools/visual-regression/`, Edge/Chromium) — see CLAUDE.md Principle 8 and §12.

If a maintainer-known snapshot/headless API exists beyond the above, fill it in during
review — this section is the least-confirmed.

---

## 11. Sandcastle Demo Index

> Two galleries hold fork WebGPU demos:
> - **Legacy gallery** — `Apps/Sandcastle/gallery/WebGPU *.html` (28 files). This is
>   the complete set where fork WebGPU demos historically live.
> - **New gallery** — `packages/sandcastle/gallery/<kebab>/` (folder with `index.html`
>   + `main.js` + `sandcastle.yaml` + thumbnail), served by Sandcastle2. 26 `webgpu-*`
>   folders + 2 atmosphere demos are ported here.
>
> Enumerated from the repo (not invented). `webgpu-scene-capture-reflections` exists
> only in the legacy gallery so far; the rest are in both.

### 11a. Legacy gallery (`Apps/Sandcastle/gallery/WebGPU *.html`) — 28 demos

| Demo | Shows / verifies |
|---|---|
| WebGPU Async Resource Monitor | Live `AsyncResourceMonitor` — pipeline cooks, image decodes, p50/p95/p99 latency, peak inflight, warm-on-suspicion. |
| WebGPU Bulk vs Legacy Visualizers | Entity bulk static-lane fast-path vs legacy per-frame visualizers across count / static-dynamic / data-source lifetime / object type. |
| WebGPU Clustered Lighting | Forward+ clustered lighting — many scene point lights on glTF models + lit primitives, per-pixel, beyond the single sun (§6). |
| WebGPU Custom Scene Light Color | Custom `czm_lightColor` propagates to the globe Lambert path; tint the globe with a custom directional light. |
| WebGPU Deferred Lighting | `scene.deferredLighting` G-buffer producer; SSAO + SSR read G-buffer normals for sharper silhouettes (§9). |
| WebGPU Depth of Field | Upstream DoF stage wired through the WebGPU post-process pipeline (§8). |
| WebGPU Dual-Light Atmosphere | Sky shader samples a 2nd inscatter LUT for the moon, scaled by phase fraction (§3). |
| WebGPU Edge Feature ID | Per-feature edge gating; highlight one feature, verify edges still render across all. |
| WebGPU Edge Visibility | `EXT_mesh_primitive_edge_visibility` glTF; toggle edge color + line width (inline edge stage). |
| WebGPU Fullscreen Sky | View-independent fullscreen sky vs ellipsoid-shell sky; sweep time of day (§3). |
| WebGPU GeoJsonPrimitive | GeoJSON loader → storage-buffer BufferPoint/Polyline/Polygon; mixed FeatureCollection (§9). |
| WebGPU God Rays | Volumetric light-shaft post-process; density/decay/weight/exposure/samples (§8). |
| WebGPU Keyframe Catalog | GPU-resident keyframe catalog — (time,position) samples interpolated each frame on GPU; GPU analogue of `SampledPositionProperty` (§9). |
| WebGPU Live Weather (EDR) | Real GFS total-cloud-cover via OGC API-EDR (CoverageJSON) baked into the cloud weather-map texture; dev-server `/proxy` for CORS (§4). |
| WebGPU Many Imagery Layers | Eight imagery layers stacked; per-layer hue/gamma/alpha verification. |
| WebGPU Model Pick | Pick glTF Models at primitive granularity. |
| WebGPU Orbital Catalog | GPU-resident orbital catalog — thousands of objects propagated each frame by a user WGSL kernel; positions never leave the GPU (§9). |
| WebGPU Point Light Shadows | Point-light cube-shadow casting + receiving; toggle 5-tap PCF softness (§6). |
| WebGPU Scene Capture Reflections | C2-25 dynamic scene-capture — globe terrain + nearby 3D Tiles / glTF render into a model's reflective env cube (§5). |
| WebGPU Screen Space Reflections | SSR; tunable max distance / thickness / ray-march steps / stride / strength (§8). |
| WebGPU SGP4 Satellites | Real near-earth satellites propagated on GPU by a df64 SGP4 compute kernel — TLEs in, GPU-resident positions out (§9). |
| WebGPU Temporal Anti-Aliasing | Toggle TAA — smooth vs aliased static rendering (§8). |
| WebGPU Translucent Classification | Translucent 3D Tile classification; toggle MSAA on/off. |
| WebGPU Vector Tile Buffer Rendering | 50K points through `WebGPUBufferPointRenderer` in a single-draw GPU dispatch (§9). |
| WebGPU Voxel Pick | Pick a `VoxelPrimitive`; verify `scene.pick` returns the volume. |
| WebGPU Weather Inspector | Drive all cloud + atmosphere dials live + METAR/WMO presets (SKC/FEW/SCT/BKN/OVC/Ns/Cb/Ci) (§4). |
| WebGPU Weather Particles | GPU-computed rain/snow/fog/hail with tunable intensity + wind (§8). |

### 11b. New gallery (`packages/sandcastle/gallery/<kebab>/`) — fork demos

The 26 `webgpu-*` folders mirror the legacy demos above (same titles/descriptions),
**minus** `WebGPU Scene Capture Reflections` (legacy-only at HEAD). Plus two
atmosphere demos that live only in the new gallery:

| Folder | Shows / verifies |
|---|---|
| `atmospheric-conditions` | Tune the `AtmosphericConditions` weather inputs — humidity (mie + fog density), airQuality (rayleigh), cloudCover (star occlusion), wind state (§3). |
| `volumetric-effects` | Stack WebGPU volumetric fog + volumetric clouds + cloud shadows cast into the fog — all off by default, compose into one atmospheric system (§4/§8). |

The 26 ported `webgpu-*` folders: `webgpu-async-resource-monitor`,
`webgpu-bulk-vs-legacy-visualizers`, `webgpu-clustered-lighting`,
`webgpu-custom-scene-light-color`, `webgpu-deferred-lighting`, `webgpu-depth-of-field`,
`webgpu-dual-light-atmosphere`, `webgpu-edge-feature-id`, `webgpu-edge-visibility`,
`webgpu-fullscreen-sky`, `webgpu-geojsonprimitive`, `webgpu-god-rays`,
`webgpu-keyframe-catalog`, `webgpu-live-weather-edr`, `webgpu-many-imagery-layers`,
`webgpu-model-pick`, `webgpu-orbital-catalog`, `webgpu-point-light-shadows`,
`webgpu-screen-space-reflections`, `webgpu-sgp4-satellites`,
`webgpu-temporal-anti-aliasing`, `webgpu-translucent-classification`,
`webgpu-vector-tile-buffer-rendering`, `webgpu-voxel-pick`, `webgpu-weather-inspector`,
`webgpu-weather-particles`.

> **Keeping the index current:** new demos go in `packages/sandcastle/gallery/<kebab>/`
> (folder form) and are rebuilt with `npm run build-sandcastle`. The legacy
> `Apps/Sandcastle/gallery/*.html` form is where fork WebGPU demos historically landed
> but is no longer served by the node dev server. When you add a demo, add a row here.

---

## 12. Debug Console Quick-Start

Full procedures + the probe inventory live in
**[DEBUGGING_GUIDE.md](DEBUGGING_GUIDE.md)** — start there. Quick pointers:

- The WebGPU CesiumViewer page exposes `window.viewer`; the split-screen comparison
  page exposes `window.webglViewer` / `window.webgpuViewer`.
- `CesiumDebug.help()` lists all commands. Highlights:
  `CesiumDebug.snapshot()` / `logDebugSnapshot()`, `showDepth()`, `showWireframe()`,
  `showFrustums()`, `pipelineStatus()`, `postProcess()` (post-process state table),
  `gpuPassCost()` / `cpuPassCost()`, `highDensityCull()`, `globeBindGroups()`,
  `globeFragmentDebug(name)`, `tileDebugOverlay()`, `logImageryProbe()`.
- **Visual verification is mandatory for rendering fixes** (CLAUDE.md Principle 8):
  build a probe under `Tools/visual-regression/probe-*.mjs`, capture WebGL vs WebGPU,
  pixel-diff, READ the PNGs. Use Edge/Chromium (Playwright's bundled Firefox has no
  WebGPU). Run the suite with `node Tools/visual-regression/capture-and-diff.mjs`.

---

### Appendix — status terms

- **Opt-in / parity-default** — OFF by default; byte-identical to the pre-feature
  render when off (the fork's governing contract).
- **(status: verify)** — I could not fully confirm this against live code at HEAD;
  maintainer should check during review. Used sparingly (CSM consumer wiring depth §6;
  snapshot/headless API §10; live-weather network hop §4).
- Batch numbers cite `git log` commit headers (HEAD ≈ Batch 455, 2026-06-30).
