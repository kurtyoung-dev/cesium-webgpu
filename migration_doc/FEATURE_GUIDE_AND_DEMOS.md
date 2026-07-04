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
> `git log` at HEAD ≈ Batch 506 (`62c5bab450`, 2026-07-03, post-campaign audit),
> NOT lifted from the (up-to-300-batch-stale) source docs. Items I could not fully
> confirm are marked **(status: verify)**. §7a covers the 25-item WebGL→WebGPU
> parity campaign (Batches 482–506) added in this revision.

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
  add-only `CAPTURE_MODE` ShaderDefine bit (`1<<17`, verified in `WebGPUShaderDefines.ts`)
  that selects a single-location `FragOutput` variant (the on-screen globe emits a
  2-location MRT `{ @location(0) color, @location(1) normalRoughness }`; the capture pass
  has only a single color attachment, and an MRT mismatch is a HARD WebGPU validation
  error); a SEPARATE `_capturePipelineCache` that never bumps the on-screen pipeline
  generation; a transient shared depth target; sky preserved via `loadOp:'load'`. The
  globe writes **LINEAR** radiance into the cube (no tonemap is reached at capture time),
  so the captured face feeds the IBL prefilter + SH projection tail consistently with the
  procedural-sky fill.
- **Increments (all shipped):** Batch 446 globe slice → 447 model/3D-Tiles slice → 448
  3D Tileset verified + demo → 449 3-B ENV-TEMPORAL (temporal env-cube accumulation) →
  450 3-C ENV-CLOUDS / CLOUD-IBL-FULL (clouds folded into the reflection env map) →
  **451 3-D ENV-PARALLAX (Lagarde parallax-corrected localized reflections) — closes
  the epic.**
- **Opt-in (double flag):** `DynamicEnvironmentMapManager.enableSceneCapture = true`
  AND the context option `contextOptions.webgpu.sceneCaptureReflections` (surfaced at
  runtime as the `context.sceneCaptureReflections` getter on `WebGPUContext`). Both must
  be true for the capture pass to run. WebGPU only.
- **Parity gate (byte-identical OFF):** with the flags off, `runProceduralSkyFill` stays
  the sole face writer, the cube is byte-identical, and — because `CAPTURE_MODE` is
  add-only — `defines=0` emits the `//>>else` branch byte-for-byte equal to today, so the
  **on-screen shader-module hash is unchanged → no on-screen pipeline rebuild**. The
  off-state is probe-proven by `probe-scene-capture-off.mjs`.
- **Known V1 limitation (documented, not a bug):** capture reuses the main-camera-
  selected visible tile set, so faces pointing away from the main view get
  coarse/absent tiles. Per-face quadtree re-selection (6× `GlobeSurfaceTileProvider` with
  override frustums) is explicitly deferred as a much larger follow-up.
- **Demo:** *WebGPU Scene Capture Reflections* (legacy gallery) — probe a high-metalness
  model against captured terrain and assert the geometry appears in the reflection.
  Probes MUST read the output PNGs: the face-order **basis remap** is the top correctness
  bug (a mirrored/rotated reflection still looks plausible at a glance).
- **Architectural deep-dive:** `C2-25_SCENE_CAPTURE_DESIGN.md` is the authoritative
  reference — face-camera ENU basis remap, the single-target vs MRT variant, the on-cost
  debounce strategy (behind the flag so the OFF gate stays byte-identical), and why
  per-face-LOD re-selection is deferred. Read it before any future enhancement to this
  high-risk path (face basis + MRT variants are where the bugs live).

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

#### Cluster grid, the two compute passes, and the caps

- **Grid:** the deployed cluster grid is **16×9×24 = 3456 clusters** (matched to the
  toji Forward+ reference), with **exponential depth slicing** between near and far so
  on-screen cluster density stays uniform across the frustum.
  `WebGPUClusterBoundsRenderer.ts` (Batch 147) runs the **cluster-bounds** compute pass
  (`ClusterBounds.wgsl`): it writes a per-cluster AABB
  (`array<ClusterAABB, 3456>`, 32 B/cluster = 110 592 B) into a storage buffer.
  `WebGPUClusterAssignRenderer.ts` (Batch 148) runs the **light-to-cluster assignment**
  compute pass (`ClusterAssign.wgsl`): it tests sphere-vs-AABB per (cluster, light) and
  writes per-cluster light-index lists. Directional lights always overlap all clusters;
  point/spot lights are tested by range². Each pass has its own end-to-end probe
  (Batches 147/148).
- **Caps:** `CLUSTER_MAX_LIGHTS = 1024` total lights per scene and
  `CLUSTER_MAX_LIGHTS_PER_CLUSTER = 256` lights per cluster (both in
  `WebGPUClusterAssignRenderer.ts`). The scene-level `LightCollection` enforces a tighter
  `LightCollection.MAX_LIGHTS = 8` (`LightTypes.ts`); the compute kernel's 1024 cap is the
  hard upper bound the assignment buffers are sized for.
- **RTE precision:** cluster bounds are computed in **eye-space** (already small enough
  for FP32, unlike world-space), so they do not need the RTE positionHigh/Low split.
- **Off-state cost:** when clustered lighting is disabled, the per-pixel cost is a single
  uniform-branch gate — the cluster bindings are present but the shader skips the loop.

#### Bind-group integration — group 3 (effects), bindings 18..22

The 5 clustered-lighting bindings — `clusterLights` (18), `clusterAABBs` (19),
`perClusterLightCount` (20), `perClusterLightIndices` (21), `clusterParams` (22) — live
in **group 3 (the effects BGL)**, NOT a separate group 4. The `@group(4)` approach was
blocked by the confirmed Chromium-on-Windows `maxBindGroups: 4` ceiling (D3D12 + Vulkan).
`WebGPUEffectsBindGroup.js` was extended to spread the 5 new entries into the effects
BGL; `WebGPUClusteredLightingBGL.ts` provides the entry-list + bind-group helpers. The
`ClusteredLighting.wgsl` chunk declares the `@group(__CL_GROUP__) @binding(18..22)` slots
plus the `evalClusteredLights(...)` helper (Lambert + Cook-Torrance GGX with
KHR_lights_punctual smooth falloff). Because Model PBR (group 3) and primitive material
pipelines can resolve the cluster bindings under different group indices, the group index
is a literal **`__CL_GROUP__` token substituted per-pipeline** (`CLUSTERED_LIGHTING_GROUP_TOKEN`
in `WebGPUClusteredLightingBGL.ts`) at shader-build time — Model PBR uses group 3. All
**21 Lit-Mat shader sources** (= the 19 primitive `Mat*Lit` shaders + Model PBR + the
Phong primitives) get the same chunk prepend with the token resolved for their layout.
Verified end-to-end across Batches 153–158.

### Shadows

- **CSM (cascaded shadow maps):** SHIPPED end-to-end (verified `git log`). The consumer
  wiring is complete: cast commands reach the cast pass (Batch 296, `fef60c639b`,
  full RTE math in the cast pipeline), soft-shadow PCF on the receive side (Batches
  289/297), globe terrain RECEIVES the cast (Batch 298, fixed the cascade light-eye
  side), and the cascade fit is ground-clamped to sharpen the globe cast-shadow edge to
  WebGL parity (Batch 306, `86554cf227` — "CSM soft-shadows COMPLETE"). `WebGPUCSMRenderer`
  does real per-cascade fitting; the override-camera mechanism it established is the
  precedent C2-25 scene-capture generalizes to color. Authoritative source: `CSM_DESIGN.md`.
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

### Metadata-in-shader + pickMetadata (DP-H46 — epic CLOSED, a–f SHIPPED)

> **Status (verified `git log` at HEAD ≈ Batch 463):** the DP-H46 epic is **complete** —
> display AND pick SHIPPED, each opt-in / parity-default.
> **DP-H46a** (GPU upload + binding scaffolding, property-attribute path, Batch 454) +
> **DP-H46b** (per-model WGSL metadata codegen — property-attribute `struct Metadata` +
> `initializeMetadata`, Batch 455) + **DP-H46c** (property-TEXTURE read in the WGSL model
> shader, Batch 457 `df1e271533`) + **DP-H46d** (property-TABLE read, closing display-side
> parity, Batch 458 `baa3f62d43`) + **DP-H46e** (`scene.pickMetadata` WebGPU producer —
> color + regular-pick byte-identical, Batch 460 `061f6914f0`) + **DP-H46f** (Sandcastle
> demo + consolidated verification probe + doc reconcile, Batch 463) have all landed.
> The post-epic follow-ups have since **SHIPPED** in the Batch 482–506 parity
> campaign: multi-component attribute transport (B492), UINT16/32 texture packing
> (B493), and property tables for TEXTURE/IMPLICIT feature-ID sources including
> the upstream `getMetadataProperty` / cesium #12225 parity (B500) — see §7a
> (Metadata) for probes.

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
- **Demo:** *WebGPU Structural Metadata Pick* (`packages/sandcastle/gallery/webgpu-structural-metadata-pick/`)
  — loads `SimplePropertyTexture` (an `EXT_structural_metadata` property-texture class) on the WebGPU
  backend; click the textured plane → `scene.pickMetadata` decodes the per-texel `buildingComponents`
  scalars into the readout panel. **Verified:** `Tools/visual-regression/probe-dp46f-metadata-demo.mjs`
  (asset serves + WebGPU render + pick decode, screenshot read); byte-exact WebGL↔WebGPU parity by
  `probe-dp46e-pick-metadata.mjs` (insulation 11/11 exact, temperatures in-range).

---

## 7a. WebGL→WebGPU Parity Campaign (Batches 482–506)

The 25-item parity campaign (git `03edcf1f2e..62c5bab450`, landed 2026-07-01/03)
closed a wide band of "works on WebGL, missing/wrong on WebGPU" gaps. These are
**parity features, not opt-in fidelity**: each makes an existing upstream API work
identically on the WebGPU backend, and each landed with an acceptance probe
(`Tools/visual-regression/probe-*.mjs`) plus a byte-identical off-gate. The
campaign added 4 tail `ShaderDefine` bits (`1<<26`…`1<<29`; bits ≥24 are
disambiguated via the module-cache `keySalt`) and 23 new probes (441 total).
The post-campaign audit confirmed 4 open issues — recorded honestly below, not
papered over.

### Models (glTF)

- **`model.splitDirection`** (B483) — the imagery-layer split plane now applies to
  glTF models on WebGPU: a `MODEL_SPLIT_ENABLED` define hoists a split-side discard
  above every early-out in `ModelPBRComplete.wgsl`, mirrored into the
  pick/velocity/classification entries so split models pick correctly too.
  **Probe:** `probe-model-splitter` (maskDiff 0.57%, off-gate 0.25%).
- **`model.color` / `model.colorBlendMode` / `colorBlendAmount`** (B484) — model
  tinting with all three blend modes (`HIGHLIGHT`/`REPLACE`/`MIX`) behind a
  `MODEL_HAS_COLOR` define; untinted models stay byte-identical.
  **Probe:** `probe-model-color` (all 3 blend modes + untinted default).
- **Model silhouette** (B485) — `model.silhouetteColor`/`silhouetteSize` via the
  same stencil two-pass scheme WebGL uses (mask pass + inflated rim pass,
  `MODEL_SILHOUETTE` define + `ModelSilhouetteStage.wgsl`); `silhouetteSize = 0`
  is the byte-identical off-gate. **Probe:** `probe-model-silhouette`.
- **2D / Columbus View scene modes** (B499) — models render in `SCENE2D`/CV:
  the ECEF boundingSphere was being culled against the projected-frame culling
  volume (fixed at all 7 command-emission sites) and `_computedModelMatrix2D` is
  now consumed; MORPHING follows WebGL's `mode !== SCENE3D` condition.
  **Probe:** `probe-model-scene-modes` — 3D (13.59) and CV (18.41) PASS;
  **OPEN issue:** SCENE2D per-pixel shading tint (WebGPU olive vs WebGL blue-gray,
  interiorDiff 34.27) — a 2D light-direction / IBL-orientation gap, geometry and
  coverage are correct.
- **glTF POINTS primitive mode** (B491) — mode-0 primitives draw with point-list
  topology instead of being dropped. **Probe:** `probe-gltf-points-mode`
  (centroidDist 1.1px).
- **Point-sprite square parity** (B490) — point-cloud sprites render as squares
  matching WebGL's `gl_PointSize` rasterization, including size/attenuation
  behavior. **Probe:** `probe-point-sprite-shape`.

### Post-process

- **`scene.colorGradingEnabled` runtime flag** (B482) — the color-grading stage is
  now driven by the scene-level flag at runtime (optional `scene.colorGradingConfig`),
  read each frame by `WebGPUPostProcessStageCollection`. **Probe:**
  `probe-colorgrading-wired` — functional gates A–E pass; its stored default-view
  baseline PNG is stale after B506's intentional glint/seam pixel change (refresh
  pending, not a color-grading bug).
- **7 `PostProcessStageLibrary` builtins** (B486) — `blackAndWhite`, `brightness`,
  `nightVision`, `silhouette`, `edgeDetection`, `lensFlare`, `depthView` all run on
  WebGPU through the post-process chain. **Probe:** `probe-pp-library-builtins`
  (all 7, off-gate byte-identical). **OPEN issue:** library + user WGSL stages run
  pre-tonemap on WebGPU vs post-tonemap on WebGL — SDR output matches (9.85%),
  but HDR canvases need an hdrMode compensation like ColorGrading/FXAA got in B479.

### Globe

- **`globe.undergroundColor`** (B487) — below-surface camera views composite the
  underground color (+ `undergroundColorAlphaByDistance`) like WebGL, back-face
  gated. **Probe:** `probe-globe-underground`.
- **`globe.translucency`** (B488) — front/back-face alpha terrain translucency
  (see-through planet); the WGSL SkyAtmosphere daylight flood over the disk is
  gated on the previously-reserved `atmosControl.w` (`GLOBE_TRANSLUCENT` port).
  **Probe:** `probe-globe-translucency`. **OPEN issue (shared with underground):**
  a standing below-surface/limb darkening gap — WebGPU renders uniformly darker
  (dRGB −6..−8; underground-def 22.85%, translucent-terrain 25.49%) — exposed, not
  caused, by the campaign's default-view polish tightening the probes' dynamic
  baselines from ~15% to ~2.5%; folded into the atmosphere-brightness follow-up.
- **Polar stretch fix + seam/glint polish** (B502/B506) — the high-latitude imagery
  stretch was a double vertical flip in the WGSL Web Mercator reprojection
  (`ReprojectWebMercator.wgsl`); B506 then killed the dark-navy tile-seam grid
  (seam UV handling) and restored the orbital ocean sun-glint in `GlobeTerrain.wgsl`.
  **Probe:** `probe-globe-polar-stretch` (extended by B506 — worst tile 2.91% vs
  3.5 limit, seam px 8/45). Note: B506 intentionally changed default-view pixels.

### Metadata (`EXT_structural_metadata`) — the DP-H46 post-epic follow-ups, now SHIPPED

- **Multi-component properties** (B492) — vec2/3/4 property-attribute transport
  into the WGSL `Metadata` struct. **Probe:** `probe-metadata-multicomponent`.
- **UINT16/UINT32 property textures** (B493) — WGSL multi-byte decode; the fix was
  dual-backend (WebGL's UINT32 metadata pick was also wrong upstream-side).
  **Probe:** `probe-metadata-uint16` (all 4 stripes).
- **Property tables for TEXTURE + IMPLICIT feature-ID sources** (B500) — property
  tables resolve for texture- and implicit-sourced feature IDs, including parity
  with the upstream `getMetadataProperty` limit (cesium #12225).
  **Probe:** `probe-metadata-table-texture`.

### Voxels

- **Octree LOD traversal** (B501) — depth-1 LOD: the ray-march traverses root + 8
  level-1 child octants (child-octant selection + child-slab megatexture sampling).
  Deeper levels are a follow-up. **Probe:** `probe-voxel-octree` (9 slots, 8/8
  discriminators).
- **Per-cell pick (reland)** (B498) — `scene.pick` returns the exact voxel cell,
  relanded on the corrected world→shapeUv convention from B497 (the documented
  B477 blocker). **Probe:** `probe-voxel-cell-pick` (7/7 pick bytes byte-equal
  WebGL↔WebGPU). **OPEN issue:** the pick march does not yet compose with B501
  octree LOD (samples the root slab, hardcoded megatextureId 0 → wrong pick while
  refinement is active — the top follow-up work item) nor with B503 user
  customShaders (pick gates on default-shader density, not user alpha).
- **User native-WGSL customShaders** (B503) — user `CustomShader` WGSL runs inside
  the WebGPU voxel ray-march via a codegen chunk (`WebGPUVoxelCustomShaderCodegen.ts`),
  keyed by an FNV-1a `keySalt` under the `VOXEL_USER_CUSTOM_SHADER` define.
  **Probe:** `probe-voxel-user-customshader` (IoU 0.987, ramp spread 174).

### Environment

- **Skybox star-map orientation + cloud occlusion** (B504) — the skybox cube map
  was mirrored on WebGPU; fixed with cube-map flipY parity (patternCorr 1.000
  aligned vs 0.122 mirrored), plus a **default-off** option for procedural clouds
  to occlude the skybox. **Probe:** `probe-env-skybox-stars`.
- **Moon placement** (B505) — the moon rendered as an off-screen sliver; fixed with
  model-space RTE so it renders as a full disc at the correct position.
  **Probe:** `probe-env-moon` (litRatio 1.000, centerDist 0.0px; crescent-phase
  assertion is a noted follow-up).

### Shadows / clipping (no user dial, parity fixes)

- **CSM ellipsoid-aware cascade fit** (B496) — cascade ground-fit uses the scene
  ellipsoid instead of hardcoded WGS84 radii.
- **Geodetic clipping-polygon parity** (B494, `probe-globe-clippoly-geodetic`) and
  **authored silhouette-normal edges** (B495) round out the campaign's
  no-new-API fixes.

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

## 9a. Vegetation System (design-stage — no code shipped yet)

> **Status:** design / survey, **no code shipped**. Single source of truth:
> `VEGETATION_SYSTEM_DESIGN.md` (consolidates 8 research strands, 2026-06-05). Each slice
> is independently shippable and Playwright-probe-verifiable (CLAUDE.md Principle 8). This
> entry exists so the epic is tracked here too — link the V1–V5 demo probes once they land.

- **Feasibility verdict:** ultra-performant planetary vegetation (trees, grass,
  rocks/sparse-arid) on the globe + draped on 3D Tiles is **FEASIBLE**, WebGPU-first with
  a degraded-but-correct WebGL2 fallback. The fork already ships ~80% of the hard
  infrastructure (GPU compute culling, indirect draw, point-cloud LOD, render bundles,
  bitonic sort, RTE precision, I3DM/PNTS instancing, the full PBR shader pair, stochastic
  alpha-test dither). The missing piece is *vegetation-specific glue*.
- **5-slice roadmap (§8 of the design doc):**
  - **V1 — scatter foundation:** `VegetationScatterCollection` + compute placement
    (WebGPU) / CPU placement (WebGL2). Poisson/blue-noise scatter on globe terrain +
    draped on 3D Tiles, RTE-encoded instance buffer, behind a
    `FeatureRendererKey.VEGETATION_SCATTER`.
  - **V2 — mesh-LOD chain:** the 4-stage chain + GPU-driven LOD selection (the fork has
    tile-LOD and point-LOD but **no per-Model mesh-LOD chain** today — `Model.js` has only
    `distanceDisplayCondition`, a binary cull). Reuses `WebGPUGPUCuller` +
    `WebGPUIndirectDrawManager`; CPU per-instance LOD on WebGL2.
  - **V3 — impostor bake/sample:** the missing octahedral-impostor pipeline (`FEAT-GAP-07`);
    offline/lazy bake to atlas, fragment-shader octahedral sampling (portable, no compute).
  - **V4 — PBR shaders:** a `VegetationPBR` WGSL+GLSL pair (two-sided leaf translucency,
    wind vertex animation, alpha-to-coverage, canopy AO, impostor sampling) extending
    `ModelPBRComplete.wgsl` with new `ShaderDefine` bits.
  - **V5 — grass/rocks:** GPU-instanced grass + density-imposter + terrain detail-albedo
    (a separate path from trees), plus rocks/sparse-arid as a third tuning profile.
- **Three data models:** (1) authored / streamed 3D Tiles **I3DM** + `EXT_structural_metadata`
  (the zero-new-loader path, recommended for real datasets); (2) procedural **scatter**
  (V1); (3) far-field **terrain detail-albedo fallback** (no instances at all — vegetation
  baked into terrain albedo / flat green tint, sharing the globe mesh, near-zero cost).
- **4-stage LOD per asset class:** trees go mesh → octahedral impostor → clump-proxy →
  detail-albedo; grass goes blades → density-imposter → detail-albedo. Cross-fade via the
  already-shipped stochastic dither (`csm_stochasticDither.wgsl`, TAA-converging).
- **Dual-backend story:** WebGPU-first (compute scatter + GPU-driven LOD selection);
  WebGL2 gets a correct fallback (CPU scatter/cull + tile-granular, not per-instance, LOD)
  — WebGL2 has no compute and no GPU-driven indirect-arg generation, the recurring deficit.
- **Performance target:** vegetation ≤ ~12–25% of a 16.7 ms frame at planetary scale.

---

## 10. Snapshot Mode & Headless

> **Resolved (verified against live code at HEAD):** "snapshot" is overloaded across
> three unrelated things. There IS a public `scene.snapshotMode` API — but it is a
> **render-performance** service, NOT a screenshot/headless-capture API. The three
> distinct meanings:

- **`scene.snapshotMode` — a real public API, but a performance "FAST/inspection mode."**
  It returns the `SnapshotModeService` (`packages/engine/Source/Services/SnapshotModeService.js`,
  wired in `Scene.js` at `this._snapshotMode = new SnapshotModeService()`, exposed via the
  `get snapshotMode()` accessor). When enabled (`scene.snapshotMode.enabled = true`, OFF by
  default) and frozen, it tells registered "freezables" (notably `WebGPURenderBundleManager`)
  to treat their cache as frozen so static scenes reuse cached render bundles instead of
  re-encoding draw commands (~30–60% of per-frame CPU). It composes with — and is
  complementary to — `Scene.requestRenderMode` (skip idle frames) and
  `VisualPerformanceTargetService` (quality auto-tuning). It auto-thaws on
  `scene._snapshotVersion` bumps and significant camera motion. **Phase-0.7 status:** the
  registration skeleton is wired; per-subsystem freeze/thaw logic lands in Phase 1+. It is
  backend-neutral (WebGL has no bundles to freeze, so its freezables are typically no-ops).
  This is **not** a "take a snapshot image" API.
- **`AtmosphericConditions.clone()`** returns a JSON-serializable snapshot of facade
  state (currently scattering-only; full structured snapshot is a TODO Phase 2).
- **Scene-capture "snapshot"** in C2-25 refers to the per-face camera snapshot/restore
  invariant inside `runSceneCapture` (try/finally around the 6-face loop), NOT a
  user-facing screenshot API.

There is **no user-facing standalone screenshot / "capture this frame to PNG" API**
beyond the canvas itself. For automated capture, the project standard is the **Playwright
probe harness** (`Tools/visual-regression/`, Edge/Chromium) — see CLAUDE.md Principle 8
and §12.

- **Headless / worker:** `OPTION_B_SCENE_IN_WORKER.md` (scene-in-worker via
  OffscreenCanvas) is **research-stage / DOM-blocked**, not shipped. The headless
  `TaskProcessor` worker path is used for compute kernels (Regime 4 spike), not for
  scene rendering.

---

## 11. Sandcastle Demo Index

> Two galleries hold fork WebGPU demos:
> - **Legacy gallery** — `Apps/Sandcastle/gallery/WebGPU *.html` (28 files). This is
>   the complete set where fork WebGPU demos historically live.
> - **New gallery** — `packages/sandcastle/gallery/<kebab>/` (folder with `index.html`
>   + `main.js` + `sandcastle.yaml` + thumbnail), served by Sandcastle2. 27 `webgpu-*`
>   folders (26 ported + the fork-original `webgpu-structural-metadata-pick`) + 2
>   atmosphere demos live here.
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

The 27 `webgpu-*` folders: 26 mirror the legacy demos above (same
titles/descriptions), **minus** `WebGPU Scene Capture Reflections` (legacy-only at
HEAD), **plus** the new-gallery-only `webgpu-structural-metadata-pick` (DP-H46f,
Batch 463 — no legacy counterpart). Plus two atmosphere demos that live only in
the new gallery:

| Folder | Shows / verifies |
|---|---|
| `atmospheric-conditions` | Tune the `AtmosphericConditions` weather inputs — humidity (mie + fog density), airQuality (rayleigh), cloudCover (star occlusion), wind state (§3). |
| `volumetric-effects` | Stack WebGPU volumetric fog + volumetric clouds + cloud shadows cast into the fog — all off by default, compose into one atmospheric system (§4/§8). |
| `webgpu-model-appearance` | New-gallery-only (no legacy counterpart). Drive `model.color`/`colorBlendMode`/`colorBlendAmount` (Batch 484), `silhouetteColor`/`silhouetteSize` (Batch 485), and `splitDirection` + `scene.splitPosition` (Batch 483) interactively on the WebGPU backend via toolbar menus + sliders. Verified: `Tools/visual-regression/probe-model-appearance-demo.mjs` (signature-pixel gates per feature + byte-identical off-state). |
| `webgpu-post-process-library` | New-gallery-only (no legacy counterpart, Batch 524). Cycle the seven `PostProcessStageLibrary` builtins natively on WebGPU (§ Post-process). Verified: `Tools/visual-regression/probe-pp-library-demo.mjs`. |

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
`webgpu-weather-particles`. Plus the fork-original `webgpu-structural-metadata-pick`
(DP-H46f — WebGPU `EXT_structural_metadata` property-texture read + `scene.pickMetadata`).

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
  build a probe under `Tools/visual-regression/probe-*.mjs` (441 probes at HEAD;
  23 added by the Batch 482–506 campaign), capture WebGL vs WebGPU, pixel-diff,
  READ the PNGs. Use Edge/Chromium (Playwright's bundled Firefox has no WebGPU).
  Run the suite with `node Tools/visual-regression/capture-and-diff.mjs`.
  Port gotcha: `probe-collections-regression` and `probe-pick-basic` default
  `PROBE_BASE` to `:8134` — set `PROBE_BASE=http://localhost:8080` for the
  standard dev server.

---

### Appendix — status terms

- **Opt-in / parity-default** — OFF by default; byte-identical to the pre-feature
  render when off (the fork's governing contract).
- **(status: verify)** — could not be fully confirmed against live code at HEAD;
  maintainer should check during review. The CSM consumer-wiring (§6) and
  snapshot-mode (§10) flags have since been **RESOLVED** against live code (CSM is
  SHIPPED end-to-end through Batch 306; `scene.snapshotMode` exists but is a
  performance service, not a capture API). The one remaining unverified item is the
  **live-weather network hop (§4)** — wired but unconfirmed against a real server because
  the dev sandbox has no outbound network.
- **OPEN (post-campaign audit, 2026-07-03)** — 4 confirmed issues recorded inline in
  §7a: voxel per-cell pick vs octree-LOD/user-customShader composition, the
  below-surface/limb darkening gap (underground + translucency probes), the model
  SCENE2D shading tint, and the pre- vs post-tonemap placement of PP library/user
  stages (HDR-only today).
- Batch numbers cite `git log` commit headers (HEAD ≈ Batch 506, `62c5bab450`,
  2026-07-03).
