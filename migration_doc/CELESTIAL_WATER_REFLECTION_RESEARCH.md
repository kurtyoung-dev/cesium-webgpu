# Celestial Water Reflection — Research Dossier (unified sun-by-day + moon/stars-by-night)

**Campaign-11 ID:** `C11-163` (`C11-CELESTIAL-WATER-REFLECTION`) — Tier-4 / gated epic, L–XL, multi-batch.
**Status:** RESEARCH / EPIC. Scheduled into Campaign 11 as an opt-in, Tier-4/gated feature (QUEUE
`QUEUE_2026-07-18_CAMPAIGN11.md` §1.23 / §7.0). Its 4 sub-decisions (§5.0) are DEFERRED to when the epic
is scheduled.
**Author:** research synthesizer (read-only), copied into `migration_doc/` + expanded for the unified
day/night framing on 2026-07-18. Original synthesis HEAD = `main`, Batch 710. (Source dossier:
`scratchpad/celestial-ocean/CELESTIAL_OCEAN_REFLECTION_RESEARCH.md`.)
**Scope:** a UNIFIED celestial reflection on water (and clouds): the **sun by day** (a physically-based
glint upgrade of the existing sun specular) and the **moon + stars by night** (moonglade specular +
mirror-reflected star field), **cloud-occluded** via the EXISTING O(1) cloud beer-shadow-map (NO
per-fragment raymarch), with a **cloud-top specular fallback**. WebGPU globe-ocean fragment shader.

## Charter posture (Campaign-11 binding constraints)

- **Opt-in, default-OFF, byte-identical when off** (CLAUDE.md Performance + §5/§6 parity rules;
  QUEUE §2 ★ governing principle — never remove an additive capability, only gate it).
- **Runtime UBO enable-float, NOT a new `ShaderDefine` bit.** The feature is driven by a `celestialReflect`
  enable float in the ocean/camera UBO (cost hidden behind the night gate), so it **does NOT depend on
  `C11-149` define-width** and keeps the shipped shader **byte-identical when the flag is 0**. (The
  ShaderDefine registry is EXHAUSTED — bits 0–30 used, bit 31 reserved — so avoiding a define bit is a
  hard design requirement here, not a preference.)
- **Cheap path does NOT touch depth ⇒ NOT reversed-Z-coupled.** A pure specular-highlight moonglade/glint
  modifies color only. Only a true planar/projective reflection (`C6-PLANAR-REFLECT-REFRACT`, `C11-131`)
  needs a reflected-camera pre-pass and would interact with the reversed-Z reconciliation — that is a
  SEPARATE epic and explicitly out of scope here.
- **Parity stance is a maintainer sub-decision** (§5.0 #2): the volumetric-cloud + FFT-ocean paths are
  WebGPU-only (no WebGL twin).

> All `file:symbol` anchors below were verified against HEAD (Batch 710) at synthesis time unless flagged
> `(NEW)` / `(GAP)`. Anchors marked `(verified)` were spot-checked directly; the rest are carried from the
> four upstream explorations (ocean / celestial / clouds / technique) and are internally consistent with
> the spot-checks. **Re-grep every `file:symbol` before acting — the tree keeps moving.**

---

## 0. The unified feature (day + night)

At **any time of day** over open water the fork renders ONE consistent celestial-reflection model that
swaps the light source across the terminator:

- **Day (sun above local horizon):** a physically-based **sun glint** — the existing analytic sun
  specular upgraded to the SAME Cook-Torrance GGX lobe used at night (slice **S0**), so day and night
  share one microfacet model instead of the current Blinn-Phong `pow(·,10)` day glint + a separate night
  path. This is the front-of-line slice: it unifies and improves the day look with no new light source.
- **Night (sun below local horizon):**
  1. **Moonglade** — the reflected lunar disc, elongated toward the viewer by wave slope (Cook-Torrance
     GGX of the moon disc off wave-perturbed water, phase- and altitude-modulated).
  2. **Star reflection** — faint mirror reflections of the star field about the wave normal, jittered by
     waves so they twinkle and break across crests (`reflect()` of the view ray into a **samplable** star
     source).
  3. **Night-side terminator gate** — the night terms appear only where the **sun is below the local
     horizon**, fading softly across the terminator (no hard seam), and the moonglade additionally fades
     as the moon sets and toward new-moon phase.
- **Both day and night:**
  4. **Cloud occlusion** — where a cloud lies between the water point and the light (sun or moon), the
     glint is dimmed by the cloud's Beer-Lambert transmittance via the EXISTING beer-shadow-map.
  5. **Cloud-top specular fallback** — the energy a cloud steals from the water glint instead lands as a
     faint specular on the **cloud top**, weighted by `(1 − T_cloud)` so energy is conserved.

**Target surface — decide which ocean (§5.0 #1):** there are TWO distinct ocean subsystems at HEAD.

- **(A) DEFAULT shipping path — globe water-mask "enhanced ocean".** `computeEnhancedOcean`
  `GlobeTerrain.wgsl:2284` (verified), called from the water block `GlobeTerrain.wgsl:~3843–3909`,
  default-on via `Globe.js:382 enableEnhancedOcean=true`. The real, always-rendered ocean the user sees.
  **Recommended primary target** — visible without any opt-in geometry. *(Note the Campaign-11 ratified
  `C11-158` will flip `enableEnhancedOcean` to an opt-in `ENHANCED_OCEAN`-gated toggle; the celestial
  feature attaches to whichever ocean path is active and remains reachable behind its own runtime flag.)*
- **(B) OPT-IN FFT ocean patch.** `OceanSurface.wgsl` fragment `:145–176` (verified:
  `reflectDir = reflect(-viewDir, worldNormal)` `:154`, analytic `skyColor` mix `:156`, Fresnel blend
  `:158`), default-OFF (`scene.globe.water.ocean.enabled=false`). Cleanest **host** for a first prototype
  (already reconstructs `worldNormal + viewDir + Fresnel + reflect`, has a free UBO slot), but not what
  most users see.

**Recommendation:** prototype the shader math in **(B) OceanSurface.wgsl**, then port the finished lobe
into **(A) GlobeTerrain.wgsl computeEnhancedOcean** for the shipping experience.

---

## 2. The technique (per piece, with shader math)

Frame convention: `N` = wave-perturbed surface normal (eye space in GlobeTerrain, world in OceanSurface);
`V` = surface→eye = `normalize(-positionEC)`; `L` = surface→light (sun by day, moon by night); `sunDir` =
surface→sun; `n_geo` = geodetic ellipsoid up (NOT the wave normal). Water `F0 = 0.02` (n≈1.33). Cloud
droplet `F0 ≈ 0.04`.

### 2.0 S0 — Day-sun-glint audit/unify (front-of-line)

**Goal:** replace the existing day sun glint at `GlobeTerrain.wgsl:2441`
(`let toReflectedLight = reflect(-sunDirEC, waterNormal); pow(dot(...),10)` — a broad, mis-normalized
Blinn-Phong lobe) with the SAME Cook-Torrance GGX microfacet lobe used for the moon (§2.1), driven by the
sun as the light source. This makes day and night ONE model:

```
H        = normalize(sunDirEC + V);
a        = roughness * roughness;                       // roughness from wave-slope RMS (Toksvig/LEAN)
D        = distributionGGX(N, H, roughness);            // inlined GlobeTerrain.wgsl:2176
F        = 0.02 + 0.98 * pow(1.0 - max(dot(V,H),0.0), 5.0);  // Schlick, F0=0.02; fresnelSchlick :2171
G        = geometrySmith(N, V, sunDirEC, roughness);    // Smith height-correlated
specBRDF = (D * F * G) / max(4.0 * NdotV * NdotL, 1e-4);
Lo_sun   = specBRDF * NdotL * E_sun * sunTint;
```

- Reuse the SAME disc-solid-angle floor (§2.1) with the SUN angular radius (≈0.26°, same as the moon by
  coincidence) so the daytime lobe does not collapse to a spike on calm water.
- **Byte-identical-off requirement still holds:** S0 is only active when the celestial flag is on; when
  off, the historical Blinn-Phong `//>>else`-equivalent path (kept as the runtime `if(flag==0)` branch)
  reproduces today's glint exactly. This preserves the default look while making the enhanced look one
  unified model. **S0 lands FIRST** so the day path validates the shared lobe before the night terms add
  a second light.

### 2.1 Moonglade — microfacet (GGX) specular of the moon disc

Use **Cook-Torrance**, not Blinn-Phong `pow(·,10)`/`pow(·,200)` — Blinn-Phong is too broad and
mis-normalized for a crisp lunar streak.

```
H        = normalize(L_moon + V);
a        = roughness * roughness;                       // roughness from wave-slope RMS
D        = csm_distributionGGX(N, H, roughness);        // a2 / (π·((N·H)²(a²−1)+1)²)
F        = 0.02 + 0.98 * pow(1.0 - max(dot(V,H),0.0), 5.0);  // Schlick, scalar F0=0.02
G        = csm_geometrySmith(N, V, L_moon, roughness);  // Smith height-correlated
specBRDF = (D * F * G) / max(4.0 * NdotV * NdotL, 1e-4);
Lo_moon  = specBRDF * NdotL * E_moon * moonTint;        // = (D*F*G)/(4*NdotV)·E_moon·tint
```

- `E_moon ≈ moonPhaseFraction · fullMoonScalar`. Full moon ≈ 1e-6 of noon sun; expose `fullMoonScalar` as
  a uniform dial (start ~0.25–1.0 lux-equivalent, tuned to the HDR pipeline).
- `moonTint ≈ vec3(0.95, 0.93, 0.85)` (warm grey). Multiply the transmitted part by `(1 − F)·waterColor`
  so deep-water color reads through the glint edges.
- **Moon-disc solid angle floor.** A point light makes the lobe collapse to a spike as `roughness→0`.
  Moon angular radius α≈0.26° → Ω = π·sin²α ≈ 6.4e-5 sr. Give the lobe a finite floor via Karis area-light
  roughness widening `a' = clamp(a + Ω_scale, a, 1)`, OR clamp the NDF peak `D_area = D · min(1, Ω/(4π·a²))`.
- **Path width / elongation.** Streak width = wave-normal slope RMS. Reuse the fork's distance-faded wave
  normals (`sampleOceanWaveNormals` `GlobeTerrain.wgsl:2222` + `waveIntensityFade`). Toward-viewer
  elongation emerges from perspective foreshortening of the slope PDF; isotropic GGX + existing per-fragment
  wave jitter elongates naturally. Derive roughness from mip-filtered wave-normal variance (Toksvig/LEAN)
  so distant water self-roughens → wider dim path, near water → tight sparkle (doubles as the anti-aliasing
  fix, §2.6).

### 2.2 Star reflection — mirror-reflect the view ray, sample the star field

```
R        = reflect(-V, N);                 // incident = eye→surface, reflect about wave N
R_world  = eyeToWorld3x3 * R;              // rotate eye→world/fixed frame
starColor = sampleStarField(R_world);      // sample a STAR CUBEMAP in R_world
Lo_star  = starColor * F * waterDarkening * nightGate;
```

`F` = same Schlick as §2.1 (grazing → brighter → stars concentrate near the horizon on the reflection,
matching reality). `waterDarkening ≈ nightOceanParams.w`. Keep faint; the additive result reads as
shimmering points broken by waves. **The star source is the hard gap** — `StarField.wgsl` draws instanced
view-facing point sprites pinned to the far plane, NOT a samplable cubemap; `ProceduralSkyCubemap.wgsl`
bakes atmosphere ONLY. `sampleStarField()` has no existing texture. Options in §4 (S3) / sub-decision §5.0 #3.

### 2.3 Night-side terminator gate

```
sunAlt    = dot(n_geo, sunDir);                          // n_geo = geodetic up, NOT wave N
nightGate = 1.0 - smoothstep(-tBand, +tBand, sunAlt);    // 1 on night, soft; tBand≈sin(3°)≈0.05
moonAlt   = dot(n_geo, moonDir);
moonUpGate = smoothstep(0.0, sin(radians(5.0)), moonAlt);
moonglade *= moonUpGate * moonPhaseFraction;             // new-moon→~0, full→1
starRefl  *= nightGate;
moonglade *= nightGate;
// the S0 day glint is the COMPLEMENT: dayGate = 1 - nightGate, applied to Lo_sun so the two blend across
// the terminator with no double-count and no hard seam.
```

**Gate on the geodetic normal, not the wave normal**, or wave tilt near the terminator flickers the gate.
`computeDayNightFade(normalEC, sunDirEC)` (`GlobeTerrain.wgsl:2130`, verified region) and `nightBlend`
(`:3461–3462`) are the existing ingredients; note the packaged `nightBlend` is forced to 0 when
`camera.enableLighting=false` (the default), so the gate must be recomputed from the raw
`dot(n_geo, sunDir)` which is always available (`camera.sunDirectionEC` `GlobeTerrain.wgsl:59`).

### 2.4 Cloud occlusion — reuse the beer-shadow-map (do NOT raymarch per-fragment)

The cloud subsystem already bakes a **beer shadow map**: producer `cloudShadowMain`
(`ProceduralClouds.wgsl:1950`, marches `cloudDensity` along `-sunDir` from
`cloudShadow.sunDirAndSteps.xyz` — verified `:261 sunDirAndSteps`, `:1963 sunDir`, `:1982 steps`),
consumer `sampleCloudGroundShadow(worldPos)` (`GlobeTerrain.wgsl:2080`, verified full body) — an O(1)
Beer-Lambert lookup:

```
transmittance = max(exp(-opticalDepth * absorption), 0.35);   // GlobeTerrain.wgsl:2119
return mix(1.0, transmittance, clamp(strength, 0.0, 1.0));     // :2120
glint *= T_cloud;   // sun glint by day, moonglade + starRefl by night
```

- **Cheap first cut (recommended — §5.0 #4 = S5a):** the EXISTING map is baked from the **sun** view. For
  the STAR term, clouds are effectively directly overhead → the vertical cloud-column transmittance from
  the existing map is a good approximation; reuse `sampleCloudGroundShadow` as-is. For the day SUN glint
  it is exact. For the night MOON term the sun-view map is geometrically wrong but visually acceptable as
  a first cut (both are "cloud overhead" columns near the camera).
- **Accurate path (S5b):** bake a SECOND beer-shadow-map from the **moon** view. `buildSunViewOrthoVP`
  (`WebGPUProceduralCloudRenderer.ts:1235`) already takes an arbitrary direction; feed it `moonDirWC`.
  `cloudShadowMain`'s ONLY sun coupling is `cloudShadow.sunDirAndSteps`/`sunViewInvVP` — feed moon values
  and it bakes a moon-occlusion map with zero shader-logic change. Add a `cloudShadowMoonVP` camera
  uniform + a moon-shadow sampler on the ocean side; write an ocean analog of `sampleCloudGroundShadow`.
- **Footprint caveat:** even the sun map is a LOCAL camera-centered ortho map (±60 km single / cascades
  ±6.67/20/60 km, `WebGPUProceduralCloudRenderer.ts:~430–462`). A cloned moon map inherits the same local
  footprint → transmittance=1 ("no occlusion") for far reflections outside the footprint. Acceptable for
  near-camera ocean.

### 2.5 Cloud-top specular fallback — energy lands on the cloud

Inside the cloud raymarch lighting block (`ProceduralClouds.wgsl:~1561–1642`; `cloudColor` top/base mix
`:1578`, `scatteredLight` `:1575`), where the cloud density gradient gives a normal `N_cloud`:

```
H_c  = normalize(L + V);
D_c  = csm_distributionGGX(N_cloud, H_c, roughnessCloud);   // softer, roughnessCloud≈0.35–0.5
F_c  = 0.04 + 0.96 * pow(1.0 - max(dot(V,H_c),0.0), 5.0);   // cloud droplet F0≈0.04
Lo_cloudTop = D_c * F_c * E_light * NdotL_c * cloudAlbedoTint;
Lo_cloudTop *= (1.0 - T_cloud_at_this_column);              // appears where the water glint was killed
```

`N_cloud` from a finite-difference of `cloudDensity` (already computed in the raymarch for lighting). A
second faint directional term next to the existing sun-lit `scatteredLight`; works for both the day sun
and the night moon light source.

### 2.6 Accuracy pitfalls (carry into implementation)

- **DO NOT double-count the light.** The ocean glint IS the reflected sun/moon disc. If you ALSO bake the
  disc into the star/sky cubemap sampled via `reflect()`, you count it twice. Choose ONE — analytic GGX
  lobe (recommended, crisp+cheap) XOR disc-in-reflected-environment. The existing sun glint already
  reflects the sun analytically; mirror that pattern.
- **Gate on geodetic up**, not wave normal (§2.3).
- **Fresnel F0 = 0.02** for water (dielectric); 0.04 for cloud droplets. A metallic F0 overbrightens the
  whole stack.
- **Specular aliasing / temporal shimmer.** Per-frame wave-normal jitter makes the glint sparkle alias
  badly (fireflies). MUST be resolved by TAA (`PostProcess/TAA.wgsl` exists; `previousViewProjection`
  already in the camera UBs) and/or roughness prefiltering (Toksvig/LEAN). Blue-noise/STBN the star
  `reflect()` jitter and the beer-map dither to avoid banding (`csm_stochasticDither.wgsl` exists).

---

## 3. What EXISTS vs what is NEW (inventory)

| Ingredient | State | Anchor |
|---|---|---|
| Wave-perturbed surface normal | EXISTS | `sampleOceanWaveNormals` `GlobeTerrain.wgsl:2222`; `eastNorthUpToEyeCoordinates` `:2200` |
| View direction, positions | EXISTS | `viewDir` in `computeEnhancedOcean` (~`:2295`); `OceanSurface.wgsl:148` |
| Sun direction (eye) | EXISTS | `camera.sunDirectionEC` `GlobeTerrain.wgsl:59` |
| Existing analytic SUN glint (to upgrade in S0) | EXISTS (Blinn-Phong) | `reflect(-sunDirEC, waterNormal)` + `pow(·,10)` `GlobeTerrain.wgsl:2441` |
| Sun direction (world) in FFT ocean | EXISTS | `OceanUniforms.sunDirection` `OceanSurface.wgsl:33`, packed `WebGPUOceanRenderer.ts:947` (verified `od[20]=sun.x`) |
| Cook-Torrance kit (D/F/G) | EXISTS | `csm_distributionGGX.wgsl`, `csm_fresnelSchlick.wgsl`, `csm_geometrySmith.wgsl`; inlined `GlobeTerrain.wgsl:2171/2176` |
| Reflected-ray builtin `reflect()` | EXISTS | `GlobeTerrain.wgsl:2441`; `OceanSurface.wgsl:154` (verified) |
| Day/night fade helper | EXISTS | `computeDayNightFade` `GlobeTerrain.wgsl:2130`; `nightBlend` `:3461` |
| Water mask + coast AA | EXISTS | `GlobeTerrain.wgsl:~3843–3879` |
| Cloud beer-shadow-map producer | EXISTS (sun-only) | `cloudShadowMain` `ProceduralClouds.wgsl:1950` |
| Cloud-shadow O(1) sampler | EXISTS (sun-only) | `sampleCloudGroundShadow` `GlobeTerrain.wgsl:2080` (verified body) |
| Direction-generic ortho VP builder | EXISTS | `buildSunViewOrthoVP` `WebGPUProceduralCloudRenderer.ts:1235` |
| Cloud raymarch + density field | EXISTS | `cloudDensity` `:829`, `marchDeck` `:1365`, lighting `:1561–1642` |
| Moon dir/phase/extinction (CPU) | EXISTS on frameState | `frameState.moonDirectionWC` `FrameState.js:389`, `moonPhaseFraction :397`, `moonAtmosphereExtinction :326` |
| Moon dir already a GPU uniform elsewhere | EXISTS (other UBs) | `SkyAtmosphere.wgsl:183 moonDirectionWC`; `Moon.wgsl:99 moonDirWC`; `UniformState _moonDirectionEC :205` |
| Extinction integrator (shared) | EXISTS | `computeAtmosphereExtinctionCached` `computeAtmosphereExtinction.js:221` |
| Free UBO slot (FFT ocean) | EXISTS | `OCEAN_UNIFORM_FLOATS=40`, last write `od[35]` → `od[36..39]` = one free vec4 |
| Runtime enable-float (NO define bit) | **NEW (design requirement)** | a `celestialReflect` float in the ocean/camera UBO — sidesteps the EXHAUSTED ShaderDefine registry; no `C11-149` dep |
| **Moon dir/intensity in ocean/globe UBO** | **NEW (GAP)** | globe camera UBO has only `sunDirectionEC`; `OceanUniforms` only `sunDirection` |
| **Analytic GGX moon lobe on water** | **NEW** | only Blinn-Phong sun glint today, unconditional, not night-gated |
| **Samplable STAR cubemap** | **NEW (biggest gap)** | `StarField.wgsl` = un-samplable point sprites; `ProceduralSkyCubemap.wgsl` = atmosphere only |
| **Moon-view cloud beer-shadow-map** | **NEW** | existing map is sun-view only (`cloudShadow.sunDirAndSteps`) |
| **Cloud-top light specular term** | **NEW** | cloud lighting is sun-only (beer-powder/HG) |
| **Celestial reflection in OceanSurface.wgsl** | **NEW** | only sun specular + analytic sky `skyColor` today |

---

## 4. How to build it in this fork (touch-points)

### Uniform plumbing (enable-float + moon)

- **Enable-float:** add a `celestialReflect` float to the ocean/camera UBO (globe: `WebGPUGlobeSurfaceCameraUB`;
  FFT: `OceanUniforms` free `od[36..39]` vec4). The shader gates ALL new work behind `if
  (celestialReflect > 0.0)` so the flag-off path is byte-identical. **No `ShaderDefine`, no `//>>ifdef`,
  no `C11-149` dependency.**
- **CPU read seam:** `OceanSurfacePrimitive.update` already reads `uniformState.sunDirectionWC` into
  `_sunDirection` (`OceanSurfacePrimitive.js:170–179`) — mirror it: read `frameState.moonDirectionWC` →
  `_moonDirection`, `frameState.moonPhaseFraction` → `_moonPhase`, optionally
  `frameState.moonAtmosphereExtinction` → `_moonExtinction`.
- **Pack (FFT ocean):** `WebGPUOceanRenderer.ts:919–965` — write `od[36]=moon.x; od[37]=moon.y;
  od[38]=moon.z; od[39]=moonIntensity` into the free vec4 (no buffer resize; last write `od[35]`, buffer
  sized `OCEAN_UNIFORM_FLOATS*4` at `:557`). If moon extinction is also needed, grow `OCEAN_UNIFORM_FLOATS`
  (40→44) and extend the WGSL struct.
- **Pack (globe ocean, path A):** add `moonDirectionEC` (+ `moonPhaseFraction`, `moonIntensity`) to the
  globe camera UBO (`WebGPUGlobeSurfaceCameraUB`) and thread into `computeEnhancedOcean`. The value exists
  for SkyAtmosphere (`WebGPUSkyAtmosphereRenderer.js`) / Moon / VolumetricFog — reuse rather than
  recompute. NOTE: no `moonDirectionWC` on `UniformState` and no `csm_moonDirectionWC` auto-uniform (only
  `_moonDirectionEC` `UniformState.js:205` / `csm_moonDirectionEC` `WebGPUAutoUniforms.js:413`); read
  `frameState.moonDirectionWC` directly or add the getter.

### S0 day glint + moonglade lobe

- **Path A insertion point:** `GlobeTerrain.wgsl:2441` — replace the existing sun glint
  `let toReflectedLight = reflect(-sunDirEC, waterNormal); pow(dot(...),10)` with the shared GGX lobe
  (S0 §2.0 for the sun, §2.1 for the moon), using inlined `distributionGGX` (`:2176`) + `fresnelSchlick`
  (`:2171`), the sun weighted by `dayGate` and the moon by `nightGate·moonUpGate·moonPhaseFraction`.
- **Path B insertion point:** `OceanSurface.wgsl:160–164` (sun Blinn-Phong) / after `:158`
  (Fresnel/reflect already computed).

### Star reflection

- `reflect()` is builtin. Eye→world 3×3 available via `camera.modifiedModelView`. **Star source = the gap**
  (pick in §5.0 #3):
  - **(a) accurate:** new compute pass bakes the bright-star catalog into a small star cubemap (reuse the
    `ProceduralSkyCubemap.wgsl` storage-texture pattern), sampled via `reflect()`.
  - **(b) cheap:** procedural hash-noise star field in the reflected direction (no catalog fidelity, but
    shimmering points, zero new texture).
  - **(c) reuse:** sample the existing atmosphere IBL cube (`iblSpecularTex` in
    `ModelPBRComplete.wgsl:565`) — skyglow reflection, no discrete stars.
  - **(d) reuse the SkyBox star cubemap:** `WebGPUCubeMapPanoramaRenderer.js` owns a real
    `texture_cube<f32>` (Tycho, `createTexture` cube `:744`, sampled `:111`) but PRIVATE to that renderer's
    cache. Exposing `cubeMapView` + a BGL entry into the ocean bind group is medium plumbing but avoids
    baking a new texture. **Best accuracy/effort tradeoff if the panorama is enabled.**

### Cloud occlusion

- **Cheap:** call `sampleCloudGroundShadow(worldPos)` (`GlobeTerrain.wgsl:2080`) directly for path A. For
  path B (FFT ocean), replicate the function + bind `cloudShadowMap` into the ocean bind group.
- **Accurate (S5b):** clone the shadow producer with the moon direction — `buildSunViewOrthoVP(moonDirWC, …)`
  → new `cloudShadowMoonVP` uniform + `cloudShadowMoonMap` sampler → ocean-side `sampleCloudMoonShadow`.

### Cloud-top fallback

- `ProceduralClouds.wgsl:~1561–1642` — add the §2.5 GGX term on the finite-difference cloud normal,
  weighted by `(1 − T_cloud)`. Needs the light dir in `CloudUniforms` (`:19` has only
  `sunDirection`/`sunIntensity` — NEW moon field, packed by `WebGPUProceduralCloudRenderer.ts`).

### Reuse ledger (nothing new required beyond the enable-float + star source)

Fresnel/GGX/Smith chunks; wave normals + tangent→eye; `computeDayNightFade` / `computeTerminatorGlow`;
`sampleCloudGroundShadow`; `buildSunViewOrthoVP` (direction-generic); `computeAtmosphereExtinctionCached`;
TAA + `previousViewProjection` for shimmer; `csm_stochasticDither` for banding; CPU moon ephemeris on
`frameState`.

---

## 5. Sub-pieces (ordered slice list)

Each slice is independently landable, opt-in, default-OFF (runtime enable-float), byte-identical when off.

- **S0 — Day-sun-glint audit/unify (FRONT-OF-LINE).** Upgrade the existing `GlobeTerrain.wgsl:2441`
  Blinn-Phong sun glint to the shared Cook-Torrance GGX lobe (§2.0), gated by the enable-float and blended
  by `dayGate`. Validates the shared microfacet model on the day path before any night light is added.
  **Effort: M.** *Probe/oracle:* WebGPU-only capture at a fixed daytime specular-sun angle over ocean;
  assert the glint is present and, with the enable-float 0, byte-identical to today's Blinn-Phong glint.

- **S1 — Celestial-uniform plumbing.** Add the enable-float + moon dir/phase/intensity to the target ocean
  UBO (FFT: free `od[36..39]`; globe: camera UBO field). Read at the CPU update seam from
  `frameState.moonDirectionWC`/`moonPhaseFraction`. **Effort: S (Fable-capable).** *Probe/oracle:* dump the
  packed UBO floats via a Node/Playwright console read; assert `moonDir` matches `frameState.moonDirectionWC`
  for a fixed clock; assert byte-identical UBO when the enable-float is off.

- **S2 — Moonglade GGX specular.** Cook-Torrance moon lobe (§2.1) with disc-solid-angle floor, beside the
  S0 sun lobe. **Effort: M.** *Probe/oracle:* `probe-moonglade.mjs` — night camera over ocean with a
  scripted moon azimuth; assert a bright specular streak toward the moon and NONE at `moonPhaseFraction≈0`
  or when disabled; read the PNG for a streak, not a disc.

- **S3 — Star reflection.** Pick the star source (§5.0 #3; recommend (d) SkyBox cubemap or (b) procedural
  for a first cut). `reflect()` + Fresnel-weighted sample. **Effort: M–L** (L if baking a new catalog
  cubemap). *Probe/oracle:* capture stars-on + calm vs choppy wave intensity; assert faint reflected points
  near the horizon that break up as wave intensity rises.

- **S4 — Night-side terminator gate.** Geodetic-up `nightGate` + `moonUpGate` + phase multiply (§2.3),
  wrapping S2/S3 and the complementary `dayGate` on S0. **Effort: S.** *Probe/oracle:* sweep the sun from
  above to below the local horizon; assert moonglade/stars ~0 in daylight, the S0 sun glint ~0 at deep
  night, smooth monotonic ramp across the terminator, no hard seam.

- **S5 — Cloud occlusion.** S5a (cheap): multiply glint by `sampleCloudGroundShadow` (sun-view map reuse).
  S5b (accurate, follow-up): moon-view beer-shadow-map clone (§5.0 #4). **Effort: S (S5a) / M–L (S5b).**
  *Probe/oracle:* place a cloud between camera and light; assert the glint dims under the cloud footprint
  and is unaffected outside it.

- **S6 — Cloud-top specular fallback.** Faint GGX on cloud tops weighted by `(1 − T_cloud)` (§2.5), needs
  the light dir in `CloudUniforms`. **Effort: M.** *Probe/oracle:* occluded-light scene; assert a faint
  highlight on the cloud top exactly where the water glint was killed (energy handoff).

**Suggested landing order:** S0 → S1 → S2 → S4 → S5a → S3 → S6, with S5b and the catalog cubemap as
deferrable accuracy follow-ups. (S0 first so the shared lobe is proven on the day path; S4 before S3 so the
night gate exists before adding the star term; S5a before S3 so occlusion is wired when stars land.) A
minimum shippable vertical is S0+S1+S2+S4+S5a (day-glint upgrade + moonglade + gate + cheap occlusion).

### 5.0 The 4 deferred sub-decisions (resolve when the epic is scheduled)

Recorded in QUEUE `QUEUE_2026-07-18_CAMPAIGN11.md` §7.0 as deferred maintainer sub-decisions:

1. **Target ocean:** (A) globe water-mask enhanced ocean (default shipping path) vs (B) opt-in FFT
   `OceanSurface.wgsl` (cleaner prototype host). Recommend prototype in (B) → port to (A).
2. **Parity stance:** (i) WebGPU-only enhancement in `FEATURE_INVENTORY §B` (no GLSL twin — consistent
   with `ProceduralClouds` precedent) vs (ii) a reduced moonglade-only GLSL twin for the enhanced ocean.
   Recommend (i) — cloud occlusion has no WebGL path to reach parity with.
3. **Star source:** S3 (a) catalog cubemap / (b) procedural hash / (c) IBL cube / (d) SkyBox Tycho cubemap
   exposure. Recommend (d) or (b) for a first cut.
4. **Cloud-occlusion fidelity:** S5a cheap (reuse the sun-view map) vs S5b accurate (bake a moon-view map).
   Recommend S5a first, S5b as a follow-up.

---

## 6. Dependencies & Hazards

- **WebGPU-only, no WebGL twin** (§5.0 #2). The volumetric cloud subsystem + FFT ocean are WebGPU-only.
- **NO new define bit (design requirement).** The ShaderDefine registry is EXHAUSTED (bits 0–30 used; bit
  31 reserved for `noDepthTest` folding — `WebGPUCollectionRendererBase.ts:204`, `WebGPULabelRenderer.js:886`;
  bit-30 overflows `computeKey` `WebGPUModelPipelineCache.ts:2626`). Use the **runtime enable-float**, which
  also keeps the shipped shader byte-identical when 0. **This feature has NO `C11-149` define-width
  dependency** (unlike the `C11-158` enhanced-ocean toggle, which DOES need a define).
- **Enhanced-ocean Q2 coupling.** The globe ocean carries vestigial "PBR" dials
  (`oceanDeepColor`/`oceanFresnelPower`/`oceanReflectivity`/`oceanDarkening`,
  `fresnelSchlick`/`distributionGGX`/`computeSubsurfaceScattering` DEFINED-BUT-UNUSED after the Batch 58
  additive rewrite). The new lobes SHOULD reuse `distributionGGX`/`fresnelSchlick` (already present) and
  MAY repurpose a vestigial UBO slot for intensity — but do NOT resurrect the whole vestigial PBR model;
  keep the additive shipping model intact (Principle 7 dead-code rule — that scaffolding stays).
- **Depth / reversed-Z.** A pure specular-highlight glint does NOT touch depth (color only) — **the cheap
  path is NOT reversed-Z-coupled.** Only a true planar/projective reflection (`C6-PLANAR-REFLECT-REFRACT`,
  `C11-131`, `DEFERRED_WORK.md:5227`) needs a reflected-camera pre-pass and would interact with reversed-Z
  + oblique-clip. This dossier deliberately scopes to the CHEAP specular path; planar reflection is a
  separate epic.
- **Temporal shimmer.** Mandatory TAA + roughness prefiltering (Toksvig/LEAN) + blue-noise/STBN jitter
  (§2.6) or the glint fireflies and the star term bands. `PostProcess/TAA.wgsl` + `csm_stochasticDither.wgsl`
  exist.
- **Cloud-shadow footprint.** Both the reused sun map and any cloned moon map are LOCAL (±60 km) — far
  ocean reflections read `T_cloud=1` (no occlusion). Acceptable; document it.
- **Shared cloudShadowMap consumers.** `AerialPerspective.wgsl`, `VolumetricFog.wgsl`, and terrain all read
  the single `cloudShadowMap`. If S5b adds a moon-view map, keep it a SEPARATE binding (§6 scope-the-impact).
- **Double-counting the light** (§2.6) — pick analytic lobe XOR reflected-environment disc.
- **Charter:** opt-in default-OFF, byte-identical when off; do not default-enable or degrade the existing
  sun glint / enhanced ocean to add this. (S0 replaces the day glint's MATH but preserves its default look
  behind the enable-float.)

---

## 7. Effort

**Overall: L–XL, multi-batch** (Campaign-11 `C11-163`, Tier-4/gated). S1/S4/S5a are Small (Fable-capable);
S0/S2/S6 Medium; S3 Medium–Large (Large if baking a new star cubemap); S5b Medium–Large. A minimum
shippable vertical (S0+S1+S2+S4+S5a — day-glint upgrade + moonglade + gate + cheap cloud occlusion, no
stars) is ~3–4 batches. Full feature (all slices + moon-view map + catalog cubemap) is ~7–10 batches.
Recommend landing the day-glint + moonglade vertical first, then stars and the accurate occlusion as
follow-ups.

---

## Appendix — key verified anchors (HEAD, Batch 710)

- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `computeEnhancedOcean` `:2284`
  (verified); `sampleCloudGroundShadow` `:2080` + body `:2081–2121` (verified); `cloudShadowProjectUV`
  `:2071` (verified); sun glint `reflect(-sunDirEC,waterNormal)` `:2441` (S0 target); inlined
  `fresnelSchlick :2171` / `distributionGGX :2176`; `sampleOceanWaveNormals :2222`; `computeDayNightFade
  :2130`; `camera.sunDirectionEC :59`.
- `packages/engine/Source/Shaders/WebGPU/Ocean/OceanSurface.wgsl` — `reflectDir=reflect(-viewDir,worldNormal)
  :154`, `skyUp :155`, `skyColor mix :156`, Fresnel blend `:158` (all verified); `OceanUniforms.sunDirection
  :33`.
- `packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts` — `OCEAN_UNIFORM_FLOATS=40 :66`, buffer
  size `:557`, sun pack `od[20]=sun.x :947`, last write `od[35] :964` (verified → `od[36..39]` free).
- `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` —
  `CloudShadowUniforms.sunDirAndSteps :261`, `cloudShadowMain` sun march `:1963/:1982` (verified);
  `cloudDensity :829`; `marchDeck :1365`; lighting block `~:1561–1642`; `CloudUniforms :19`.
- `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` — `buildSunViewOrthoVP :1235`;
  shadow cache/dispatch `~:158–185/:2202–2360`.
- BRDF chunks present (verified glob): `csm_distributionGGX.wgsl`, `csm_fresnelSchlick.wgsl`,
  `csm_geometrySmith.wgsl`, `csm_getSpecular.wgsl`, `csm_stochasticDither.wgsl`,
  `csm_eastNorthUpToEyeCoordinates.wgsl`.
- ShaderDefine exhaustion (verified): bit 31 folding `WebGPUCollectionRendererBase.ts:204` /
  `WebGPULabelRenderer.js:886` / `WebGPUPointPrimitiveRenderer.js:1039`; bit-30 overflow note
  `WebGPUModelPipelineCache.ts:2626`; `WebGPUShaderDefines.ts:831`.
- CPU moon ephemeris: `FrameState.js:389 moonDirectionWC / :397 moonPhaseFraction / :326
  moonAtmosphereExtinction`; `Moon.js:171/175/205`.
- Deferred/related: `DEFERRED_WORK.md:5227 C6-PLANAR-REFLECT-REFRACT` (`C11-131`); `:5223 C6-FFT-OCEAN`
  (reflection-seam follow-up #6).
