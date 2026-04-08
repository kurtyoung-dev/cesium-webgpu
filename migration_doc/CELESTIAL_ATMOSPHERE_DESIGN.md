# Celestial & Atmospheric Systems — Design Document

**Status:** Draft v2 — Session 24 followup (adds participating media + scattering occlusion)
**Scope:** Sun, Moon, atmosphere, clouds, fog, stars, volumetric fog, varying
atmospheric density, scattering occlusion (god rays), and the lighting/visibility
coupling between them
**Audience:** CesiumJS WebGPU fork maintainers

---

## 1. Goals & Non-Goals

### Goals

1. **Astronomically correct Sun + Moon** — driven by `JulianDate`, including
   moon phase / illuminated fraction.
2. **Dual-light atmospheric scattering** — both Sun and Moon contribute to
   sky color; sky doesn't go to pure black at night when the moon is up.
3. **Star visibility coupling** — stars dim and re-emerge based on
   ambient sky brightness (sun above horizon, moon brightness, cloud
   cover, terrain/observer light pollution).
4. **Atmospheric conditions model** — single source of truth for cloud
   cover, fog density, humidity, time-of-day modulation; consumed by
   every renderer that cares.
5. **Volumetric clouds** — real participating-media clouds, not just
   billboards. Optional / opt-in for performance.
6. **Volumetric fog** — real participating-media fog via a frustum-voxel
   (froxel) grid. Supports god rays, cloud shadows in the fog, terrain
   shadow volumes, and height-varying density. Replaces or supplements
   the existing distance-fog multiply.
7. **Varying atmospheric density** — the clear atmosphere itself can
   have local density modulation (ground haze pockets, inversion layers,
   pressure systems, pollution) layered on top of the base Nishita
   model. Unified with volumetric fog through the same froxel grid.
8. **Scattering occlusion (god rays / crepuscular rays)** — shadow-aware
   in-scattering: fog, clouds, and atmosphere all darken when the light
   source is occluded by terrain or cloud density. Gives you sun beams
   streaming through cloud gaps, terrain shadow shafts, and realistic
   twilight attenuation without any separate "god rays" post-process.
9. **Per-feature togglability** — every subsystem (Sun, Moon, atmosphere
   scattering, ground atmosphere, fog, volumetric fog, varying
   atmosphere density, scattering occlusion, clouds, stars, sun
   lighting, moon lighting, star modulation, volumetric clouds) is
   independently toggleable from `Scene` properties without
   recompilation. Toggles live in one place and follow a uniform pattern.
10. **Backend-agnostic Scene API** — all toggles work the same on WebGL
    and WebGPU. Renderer differences are hidden behind feature renderers.

### Non-Goals (out of scope)

- Auroras, lightning, rainbow scattering, sun-pillar atmospheric optics
- Climate / weather simulation (precipitation timing, storm tracks)
- High-precision JPL DE405/DE430 ephemerides (Simon 1994 analytical
  theory is accurate to ~1 arcmin, plenty for visualization)
- Lunar libration / topography in moon rendering
- Multi-planet rendering (Jupiter, Venus visible from Earth surface)
- Fully physically-correct multiple-scattering through the froxel grid
  (single-scattering + ambient term is sufficient for visualization;
  Wrenninge-style multi-scatter is a separate research-scale project)
- Volumetric fog self-shadowing at the froxel resolution (per-froxel
  shadow queries from every light are too expensive — we use the
  shadow map + ambient approximation)
- Water participating media (underwater god rays, caustics) — same
  framework applies conceptually, but the water volume is handled by
  the existing ocean shader path and isn't in this project's scope

---

## 2. Current State Inventory

### What already works

| System | Status | Key Files |
|---|---|---|
| Sun position | ✅ Simon 1994 orbits, ICRF→fixed transform | `Core/Simon1994PlanetaryPositions.js`, `Renderer/UniformStateComputations.js` |
| Sun rendering | ✅ Procedural disk + corona, RTE billboard | `Scene/Sun.js`, `Shaders/WebGPU/Environment/Sun.wgsl` |
| Moon position | ✅ Simon 1994 orbits, IAU 2000 orientation | `Core/Simon1994PlanetaryPositions.js`, `Core/IauOrientationAxes.js` |
| Moon rendering | ✅ Textured ellipsoid sphere, Lambertian | `Scene/Moon.js`, `Shaders/WebGPU/Environment/Moon.wgsl` |
| Atmosphere (scattering) | ⚠️ Nishita per-pixel ray march, single-sun, no LUT | `Scene/SkyAtmosphere.js`, `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` |
| Atmosphere LUT compute | ⚠️ Built but **not wired into runtime** | `Shaders/WebGPU/Compute/AtmosphereLUT.wgsl` |
| Ground atmosphere | ✅ Integrated into terrain shader | `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` |
| Fog | ✅ Distance fog blended into terrain shader | `Scene/Fog.js`, `GlobeTerrain.wgsl` |
| Skybox / stars | ⚠️ Cubemap renders but **always full brightness** | `Scene/SkyBox.js`, `Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js` |
| Cumulus clouds | ✅ Billboard collection, weather effects | `Scene/CloudCollection.js`, `Shaders/WebGPU/Collections/CloudCollection.js` |
| Volumetric clouds | ❌ Does not exist | — |
| Sun light | ✅ `SunLight` class, fed into PBR | `Scene/SunLight.js`, `LightTypes.ts` |
| Moon light | ❌ Does not exist as a `Light` instance | — |
| Star brightness modulation | ❌ Does not exist | — |
| Moon phase / illumination | ❌ Position only, no phase calculation | — |
| Multi-light scattering | ❌ Atmosphere LUT is single-sun | — |
| Dual-light terrain shading | ❌ Terrain shader uses single sun direction | — |

### The actual scope (smaller than I feared)

The big surprise from the audit: **Moon already exists.** It's a textured
sphere with Lambertian lighting from the sun direction. So this project
isn't "build a moon from scratch" — it's "extend the moon to support
phases, contribute to atmospheric scattering, and act as a light source
for terrain when the sun is below the horizon."

Same for Sun: it already exists, has procedural texture, has correct
orbital position. The gap is that `Scene.light` (the directional light
that drives PBR materials) is **not synchronized** with the sun's actual
direction. Users have to wire that up by hand.

---

## 3. Toggle Architecture

This is the user's hardest requirement: **everything individually
togglable**. Here's the rule set, then the explicit toggle list.

### Rules

1. **One source of truth: `Scene` properties.** Every toggle is a
   public boolean (or small enum) on `Scene`, defaulting to the same
   value as today's behavior so toggling nothing produces zero
   regression.
2. **Frame state forwarding.** `Scene.updateFrameState()` copies each
   toggle onto `frameState` once per frame. Renderers read from
   `frameState`, never from `Scene` directly. This is the same pattern
   already established for `debugShowGlobeWireframe`,
   `debugShowTriangulation`, etc.
3. **Cold-path discipline.** When a toggle is in its default state,
   the production hot path pays at most one local-bool comparison.
   Renderers branch on the local at the top of their per-frame update,
   not per-object/per-tile.
4. **Backend-agnostic surface.** Every toggle is documented and
   defined in `Scene.js` even if only the WebGPU renderer reads it.
   WebGL renderers ignore unknown frame state fields harmlessly.
5. **Dependency disclosure.** A toggle that depends on another
   (e.g. `enableMoonLight` is a no-op if `enableMoon` is off) is
   documented in JSDoc. Renderers must handle the off-path gracefully.
6. **Renderer parity.** Existing scene-level toggles like
   `Scene.skyAtmosphere.show` and `Scene.fog.enabled` stay where they
   are — those are the canonical "primary" toggles. The new flags
   live alongside them and refine behavior, never replace it.

### Toggle inventory

**Existing toggles (don't move, don't break):**

| Toggle | Type | Default | Effect |
|---|---|---|---|
| `Scene.sun.show` | bool | true | Render the sun disk |
| `Scene.moon.show` | bool | true | Render the moon |
| `Scene.skyAtmosphere.show` | bool | true | Render sky atmosphere shell |
| `Scene.skyBox.show` | bool | true | Render the cubemap (stars) |
| `Scene.fog.enabled` | bool | true | Apply distance fog to terrain |
| `Scene.globe.enableLighting` | bool | false | Lambertian terrain lighting |
| `Scene.globe.showGroundAtmosphere` | bool | true | Horizon haze |

**New scene-level toggles (this design):**

| Toggle | Type | Default | Effect |
|---|---|---|---|
| `Scene.enableSunLight` | bool | true | Sync `scene.light` to actual sun direction (today: manual) |
| `Scene.enableMoonLight` | bool | true | Add moonlight as a secondary light source for PBR + terrain |
| `Scene.enableMoonPhase` | bool | true | Compute and render the lit fraction of the moon (illuminated face only) |
| `Scene.enableDualLightAtmosphere` | bool | true | Add moon contribution to atmosphere scattering |
| `Scene.enableStarBrightnessModulation` | bool | true | Dim stars based on sky brightness |
| `Scene.enableVolumetricClouds` | bool | false | Replace billboard cumulus with raymarched volumetrics (perf cost) |
| `Scene.enableAtmosphericConditions` | bool | true | Apply the `AtmosphericConditions` model (cloud cover / humidity / haze) |
| `Scene.enableNightSkyDimming` | bool | true | Skybox brightness fades up at dusk and down at dawn |
| `Scene.atmosphere.useLUT` | bool | true | Sample precomputed LUT instead of per-pixel ray march |
| `Scene.enableVolumetricFog` | bool | false | Froxel-grid participating media fog (supersedes `Scene.fog` when on) |
| `Scene.enableVaryingAtmosphereDensity` | bool | false | Layer local density modulation on top of the base Nishita atmosphere |
| `Scene.enableScatteringOcclusion` | bool | true | Shadow-aware in-scattering (god rays, cloud shadows in fog, terrain shadow shafts) |
| `Scene.volumetricFog.froxelResolution` | enum | "medium" | "low"(80×45×64) / "medium"(160×90×128) / "high"(240×135×192) |
| `Scene.volumetricFog.maxDistance` | f32 | 50000 | Meters — view-ray distance past which the froxel grid stops integrating |

Defaults are chosen so the *combined* effect of all new toggles in
default state matches today's visual behavior wherever the underlying
feature already exists, and is "off" wherever it doesn't (volumetric
clouds, moon-light contribution, dual-light atmosphere).

**Tunable scene properties (not boolean toggles, but related):**

| Property | Type | Default | Effect |
|---|---|---|---|
| `Scene.atmosphericConditions.cloudCover` | f32 [0..1] | 0 | Global cloud-cover fraction |
| `Scene.atmosphericConditions.humidity` | f32 [0..1] | 0.5 | Affects haze near the horizon |
| `Scene.atmosphericConditions.airQuality` | f32 [0..1] | 1 | Affects mie scattering coefficient |
| `Scene.atmosphericConditions.starVisibilityThreshold` | f32 | 0.05 | Sky brightness above which stars vanish |
| `Scene.atmosphericConditions.fogDensityMultiplier` | f32 | 1.0 | Scales the base volumetric fog density field |
| `Scene.atmosphericConditions.fogHeightFalloff` | f32 | 0.001 | Exponential falloff per meter of altitude (ground-fog steepness) |
| `Scene.atmosphericConditions.fogAnisotropy` | f32 [-1..1] | 0.3 | Henyey-Greenstein g parameter; +0.8 = strong forward scatter (sun halos in mist), 0 = isotropic |
| `Scene.atmosphericConditions.fogAlbedo` | vec3 | (0.9, 0.92, 0.95) | Fog particle base color (tinted slightly blue for haze, white for cumulus mist, gray for pollution) |
| `Scene.atmosphericConditions.atmosphereDensityNoiseScale` | f32 | 5000 | Meters — spatial scale of the 3D noise field used to modulate base atmosphere density |
| `Scene.atmosphericConditions.atmosphereDensityNoiseStrength` | f32 [0..1] | 0 | How much the noise field varies the base Nishita density (0 = uniform, 1 = wild) |

### Failure mode policy

If a toggle is on but the underlying capability isn't supported on
this device (e.g. volumetric clouds need 3D textures + compute, LUT
mode needs storage textures), the renderer logs a warning **once** and
silently degrades to the next-best variant. Same pattern as the WGF-6
primitive_index probe in Session 22.

---

## 4. Subsystem Designs

### 4.1 Sun

**Already exists.** Three things to add:

1. **`Scene.enableSunLight`** — when true, `Scene.updateFrameState()`
   sets `scene.light.direction` from `frameState.sunDirectionWC` each
   frame. When false, behavior is today's manual mode. Single conditional
   in `updateFrameState()`. ~5 lines.
2. **Sun below horizon handling** — when the sun is below the local
   horizon, the existing renderer happily draws the disk through the
   earth. The fix is a depth test against the inner sphere, already
   present in atmosphere code; just needs to be wired into Sun.wgsl
   when `enableSunLight` is on.
3. **Sun intensity coupling** — `SunLight.intensity` should fall off
   smoothly as the sun crosses the horizon (twilight). Computed from
   the angle between sun direction and local up at the camera position.
   Existing math; just needs to be exposed.

### 4.2 Moon

**Already exists for position/orientation/sphere rendering.** Five
things to add:

1. **Moon phase computation.** Given the sun direction, moon direction,
   and moon position relative to camera, compute the illuminated
   fraction in the fragment shader. The existing `Moon.wgsl` already
   does Lambertian lighting from `sunDirectionEC` — extending this to
   show only the lit face is straightforward (just don't render dark-side
   pixels, or render them as the very dim earthshine color).
2. **`MoonLight` class.** New `Scene/MoonLight.js`, mirrors `SunLight.js`
   structure: extends the abstract `Light` base, has `color` (default
   cool blue-white), `intensity` (default ~0.005 of sun, the realistic
   ratio is ~0.0014 but visual taste pushes it higher).
3. **Light contribution.** When `enableMoonLight` is on, the moon
   light is added to `scene.lights`. The PBR shader path already
   handles multi-light via `LightUniforms.wgsl` — this is wiring, not
   new shader work.
4. **Direction synchronization.** Same pattern as sun: `MoonLight.direction`
   set from `frameState.moonDirectionWC` (a new field, computed in
   `UniformStateComputations.js` exactly like `sunDirectionWC`).
5. **Earthshine.** Optional cosmetic. Dark side of the moon at new-moon
   phase has a faint blue glow from earthlight reflection. Single
   shader uniform, blends a tint into the unlit hemisphere.

### 4.3 Atmosphere — multi-light scattering

This is the **hardest piece** of the project and where most of the
implementation effort lives.

**Current state:** `SkyAtmosphere.wgsl` per-pixel ray-marches the
Nishita scattering integral with a single sun direction. The
`AtmosphereLUT.wgsl` compute shader exists, builds 256×64 transmittance
+ 256×128 inscatter tables for a fixed sun direction, but is **not
sampled by the runtime fragment shader.** The runtime shader integrates
from scratch every frame.

**Two paths to multi-light:**

#### Option A: Bake LUT per light per frame

When the sun direction changes, recompute the LUT. When the moon is
above the horizon and `enableDualLightAtmosphere` is on, compute a
*second* LUT with the moon as the light source, scaled by the moon's
scattering intensity. Runtime fragment samples both LUTs and sums.

- **Cost:** 2× LUT compute per frame. With 256×64 + 256×128 = 49,152
  output texels at ~16 sample steps each, this is ~786K shader
  invocations per LUT — should run in well under 1ms on modern GPUs.
- **Pro:** Reuses existing compute shader almost unchanged.
- **Con:** Two LUTs to manage, two storage texture pairs, runtime
  shader gains a second sample path.

#### Option B: Generalize the LUT to N-light

Reformulate the LUT to be light-direction-independent and accumulate
per-light contributions in the runtime shader. This is closer to how
modern engines (Frostbite, Unreal) handle it: the LUT stores
direction-of-view × altitude × cosine-of-light-angle, and you sample
once per light at runtime.

- **Cost:** Larger LUT (extra dimension), bigger compute job once at
  startup. Runtime cost stays linear in light count.
- **Pro:** Scales to N lights cleanly. Future-proof for additional
  light sources (artificial city lighting, lightning flashes, etc.).
- **Con:** Significant compute shader rewrite. Larger memory footprint.

**Recommendation: Option A for initial implementation.** It's the
faster path to working dual-light scattering with the existing
compute infrastructure. We can migrate to Option B in a follow-up
session if needed for performance or for >2 lights.

**Runtime shader changes:**

```wgsl
// SkyAtmosphere.wgsl pseudocode after this work:
let sunInscatter = sampleInscatterLUT(sunLut, viewDir, altitude, sunCosTheta);
var totalColor = sunInscatter * u.sunIntensity;

if (u.enableMoonLight > 0.5 && u.moonAboveHorizon > 0.5) {
  let moonInscatter = sampleInscatterLUT(moonLut, viewDir, altitude, moonCosTheta);
  totalColor += moonInscatter * u.moonIntensity * u.moonPhaseFraction;
}
```

The `u.moonPhaseFraction` term is critical: scatter contribution scales
with the *illuminated fraction* of the moon, not just whether it's
above the horizon. New moon contributes nothing.

**Sky brightness output.** This work also requires the atmosphere
shader to *export* an estimate of the sky brightness at the camera
position so star modulation can read it. Cleanest approach: write the
sky brightness into a 1×1 storage texture each frame, sampled by the
star shader. Or compute it on the CPU side in `UniformStateComputations`
from sun + moon angles + atmosphere parameters and pass it as a
uniform — much cheaper, slightly less accurate.

**Recommendation: CPU-side sky-brightness estimate.** Good enough for
star modulation; avoids the GPU readback round trip.

### 4.4 Stars / Skybox

**Three changes:**

1. **Brightness modulation.** Add a `starBrightness: f32` uniform to
   the cubemap panorama shader (slot it next to the existing `params.z`
   debug-face field). When `enableStarBrightnessModulation` is on,
   `Scene.updateFrameState()` computes a brightness factor from sky
   brightness and writes it. Fragment shader multiplies sampled
   cubemap color by the factor. When the sky is bright (day, full
   moon overhead, heavy cloud cover), the factor approaches zero and
   stars vanish.
2. **Atmosphere occlusion.** Currently the atmosphere shell renders
   *over* the cubemap, hiding stars when the sky is opaque. This
   already works but is ad hoc. The brightness modulation makes it
   explicit and tunable.
3. **Cloud occlusion.** When `enableAtmosphericConditions` and cloud
   cover > some threshold, stars dim further. Single multiply.

Star *content* (which cubemap images we ship) is a separate question
the design doesn't address — the existing CesiumJS default starfield
cubemap is fine.

### 4.5 Atmospheric Conditions

**New class:** `Scene/AtmosphericConditions.js`. Mirrors the structure
of `Fog.js` — a small property bag with documented defaults. Read by
multiple renderers via `frameState.atmosphericConditions`.

```js
class AtmosphericConditions {
  constructor(options = {}) {
    this.cloudCover = options.cloudCover ?? 0;       // [0..1]
    this.humidity = options.humidity ?? 0.5;          // [0..1]
    this.airQuality = options.airQuality ?? 1.0;      // [0..1]
    this.starVisibilityThreshold = options.starVisibilityThreshold ?? 0.05;
  }
}
```

**Consumers:**

- Sky atmosphere shader: humidity → mie coefficient scale; airQuality →
  rayleigh coefficient scale.
- Star shader: cloudCover, starVisibilityThreshold.
- Volumetric cloud shader: cloudCover (controls density threshold).
- Fog: humidity → density modulation.

The class is intentionally small. Adding a 5th property is one line in
the constructor, one Scene→frameState forward, one shader uniform field.
The growth pattern is well-defined.

### 4.6 Volumetric Clouds

**Largest unknown.** Three viable approaches:

1. **Schneider/Häggström raymarched clouds** (Horizon Zero Dawn,
   Frostbite, Far Cry 5). 3D worley + perlin density texture, sampled
   by a screen-space raymarch with cone tracing for shadows. Highest
   quality, highest cost. Requires a 3D texture + a curl noise texture
   + ~64-step raymarch in the cloud layer.
2. **Volumetric impostors.** Render volumetric clouds offline into
   billboard atlases, blit them into the scene at runtime. Very fast,
   but loses the "fly through a cloud" effect.
3. **2D screen-space clouds.** Sample a 2D cloud texture projected
   from the cloud layer altitude. Cheap, but visually flat.

**Recommendation: Schneider raymarch as a future implementation,
gated behind `enableVolumetricClouds = false` default.** The default
stays on the existing billboard cumulus collection, which is fine for
GIS visualization. Volumetric raymarched clouds are a quality upgrade
opt-in for users who want it and have the GPU budget.

The compute shader infrastructure (storage textures, async dispatch,
WebGPUCompute pipeline) is in place from Session 12-18 work, so the
volumetric cloud kernel can plug in cleanly when implemented.

This subsystem is **deferred to Phase 4** and is not a blocker for
the rest of the work.

### 4.7 Fog (distance fog)

**Already complete.** No changes needed beyond accepting the new
`AtmosphericConditions.humidity` field as a density multiplier in
`Fog.js`. Two lines. This is the legacy distance-based fog that lives
in the terrain fragment shader and acts as a cheap fallback when the
new volumetric fog system (§4.8) is off.

### 4.8 Volumetric Fog

**The biggest single piece of new rendering work in this project**,
tied with Phase 3 atmosphere multi-light. Delivered as a froxel-grid
(frustum-voxel) participating media renderer modeled on Frostbite's
GDC 2015 talk and reused since by Unreal, Unity HDRP, id Tech 7, and
the Horizon engines.

#### What a froxel grid is

A 3D texture parameterized by (screen X, screen Y, depth) where depth
is non-linearly distributed (log depth slicing) so near-camera voxels
are small and fine-grained while far-camera voxels are large and
coarse. Three typical resolutions:

- **Low**: 80 × 45 × 64 = 230K froxels
- **Medium**: 160 × 90 × 128 = 1.8M froxels
- **High**: 240 × 135 × 192 = 6.2M froxels

Each froxel stores one scattered-light value and one transmittance
value, both RGB. The memory budget at "medium" is ~58 MB with two
rgba16float textures (scattered + transmittance) — fits comfortably
on any desktop WebGPU device; "low" is the default for mobile.

#### Three-pass pipeline

Every frame, when `enableVolumetricFog` is true, we run three compute
passes before the scene composite:

**Pass 1 — Density injection.** For each froxel, a compute kernel
computes:
- Base density from `AtmosphericConditions.fogDensityMultiplier ×
  exp(-altitude × fogHeightFalloff)` (height fog)
- 3D noise modulation (optional) for turbulent volume variation
- Cloud shadow contribution (Pass 4 below writes this in a second
  dispatch when clouds are volumetric)
- Single scalar density → stored temporarily in R, with phase function
  anisotropy baked into G

**Pass 2 — Light scattering.** For each froxel, evaluate incoming
light from every active directional light (sun + moon), attenuate by
shadow-map sampling (§4.10), multiply by density × phase function
× fog albedo. Sum into the scattered-light output. Three light
contributions max per froxel: sun, moon, ambient.

**Pass 3 — Ray marching integration.** A compute kernel walks each
screen-XY slice along the depth axis and accumulates scattered light
and transmittance per-froxel. This step is the alpha-over composite
in 3D: the final scattered value at depth N includes all scatter
from froxels 0..N-1 weighted by their transmittance. Result is a
single `rgba16float` 3D texture ready for compositing.

**Final composite.** The scene color pass samples the 3D integrated
result via screen-UV + linearized depth → RGB scatter + transmittance.
`finalColor = sceneColor × transmittance + scatteredLight`. Single
texture sample per pixel; the expensive work is amortized in the
compute passes.

#### Integration with existing systems

- **Supersedes `Scene.fog`** when `enableVolumetricFog` is on. The
  existing distance-fog multiply in `GlobeTerrain.wgsl` is skipped
  (already gated by `Scene.fog.enabled`). Volumetric fog's integrated
  transmittance replaces the distance-fog blend.
- **Respects `Scene.skyAtmosphere`**. The sky color shader sees
  volumetric fog via the same composite pass — if the sky atmosphere
  is on, Nishita scattering kicks in past the volumetric far plane
  and the two blend at the transition boundary (the far-end depth
  slice).
- **Feeds into the atmosphere LUT inputs**. When varying atmosphere
  density (§4.9) is on, the froxel grid also carries atmosphere
  density modulation — the two systems share one data structure.

#### Cost estimate

At "medium" resolution (1.8M froxels) with sun + moon + ambient:

- Density injection: ~0.8 ms on RTX 3060
- Light scattering with shadow queries: ~1.4 ms
- Ray marching integration: ~0.5 ms
- **Total: ~2.7 ms/frame**

At "low" (230K froxels): ~0.5 ms total. At "high" (6.2M): ~9 ms.
Mobile devices default to "low"; desktop defaults to "medium"; "high"
is a user opt-in for high-end systems.

#### Toggle behavior

- `enableVolumetricFog = false` (default): zero cost, legacy fog path
- `enableVolumetricFog = true`: compute passes run every frame
- `froxelResolution` controls quality/perf tradeoff
- `maxDistance` clamps the grid far plane — past this, the existing
  Nishita atmosphere takes over smoothly

### 4.9 Varying Atmosphere Density

**Physical motivation.** The existing Nishita scattering model assumes
a radially-symmetric atmosphere with exponential-decay density (scale
heights for Rayleigh and Mie independently). That's fine for pure
sky-color rendering at global scale, but it can't represent:

- **Ground haze pockets** (valley fog, urban pollution domes)
- **Inversion layers** (density inverts with altitude in cold-air
  basins, trapping pollution)
- **Pressure systems** (high/low pressure regions have slightly
  different density profiles)
- **Dust storms, smoke plumes** (localized Mie coefficient spikes)
- **Stratosphere/troposphere layering** (density isn't strictly
  exponential above ~11 km)

#### Design: density modulation field

Rather than rewrite the Nishita model, we **modulate** its density
inputs per-position via a small 3D noise field + a small handful of
"pressure system" positions. The modulation layers on top of the
base model multiplicatively:

```
localRayleighDensity = baseNishitaRayleigh(altitude)
                     × (1 + noiseStrength × fbm3d(pos / noiseScale))
                     × pressureFieldMultiplier(pos)
localMieDensity = baseNishitaMie(altitude)
                × (1 + noiseStrength × fbm3d(pos / noiseScale))
                × airQualityFromConditions
```

#### Integration via the froxel grid

Here's where volumetric fog and varying atmosphere density unify:
**both write into the same froxel density field**. The density
injection pass writes:

- Fog density → scatter+absorption in the fog-particle regime
- Atmosphere Rayleigh density modulation → wavelength-dependent
  scatter coefficient
- Atmosphere Mie density modulation → forward-scatter + absorption

The light scattering pass then evaluates a combined phase function
(Rayleigh + Mie + fog HG) using the blended coefficients. This means:

1. One set of compute passes handles all participating media
2. God rays work identically for fog, haze, and atmospheric density
   variation
3. `enableVolumetricFog = false` + `enableVaryingAtmosphereDensity =
   true` is a valid combination — the atmosphere density modulation
   runs alone, fog contribution is zero
4. `enableVolumetricFog = true` + `enableVaryingAtmosphereDensity =
   false` is also valid — uniform atmosphere density, variable fog

#### Cost

Roughly +0.3 ms to the density injection pass at medium froxel
resolution (one extra fbm3d sample per froxel + two coefficient
multiplies). Negligible next to the base volumetric fog cost.

#### Failure mode

When running without the froxel grid (`enableVolumetricFog = false`),
varying atmosphere density still works — it modulates the existing
`SkyAtmosphere.wgsl` per-pixel ray march by sampling the same 3D
noise field at each ray step. Slightly more expensive per-pixel but
avoids maintaining a separate code path.

### 4.10 Scattering Occlusion (god rays / crepuscular rays)

**Physical motivation.** When a sunbeam passes through a gap in the
clouds, the air it crosses is brightly in-scattered while the
shadowed air on either side is dimmer. Your eye interprets the
contrast as visible shafts of light. Same effect at ground level
with terrain ridges casting shadow volumes through ground fog.

The existing Nishita scattering shader **ignores occlusion
entirely** — it assumes the whole atmosphere is fully lit along
every view ray. That's visually fine when the sky is clear and
there are no clouds. It's wrong the moment you add volumetric fog,
clouds, or terrain that casts shadows into the participating media.

#### Design: shadow-aware in-scattering

For each froxel during Pass 2 (light scattering), instead of blindly
multiplying incoming light × density × phase, we query the sun's
shadow map:

```wgsl
let froxelWorldPos = froxelToWorld(froxelId);
let sunShadowFactor = sampleSunShadowMap(froxelWorldPos);
let moonShadowFactor = sampleMoonShadowMap(froxelWorldPos);
let sunContribution = sunShadowFactor * sunIntensity * phase(sunCosTheta) * density;
let moonContribution = moonShadowFactor * moonIntensity * phase(moonCosTheta) * density;
scatteredLight += fogAlbedo * (sunContribution + moonContribution + ambient);
```

Froxels in terrain shadow see `sunShadowFactor ≈ 0` and contribute
no scatter. Froxels in direct sunlight get full contribution.
Froxels at the boundary get partial contribution from the shadow
map's PCF filter. **This is god rays, for free, as a side effect of
integrating volumetric fog with a shadow map query.**

#### Cloud shadow contribution

When volumetric clouds are on (Phase 5), the cloud density field
itself casts shadows into the fog grid. A separate light-direction
ray march from each froxel toward the sun samples the cloud density
texture and accumulates extinction:

```wgsl
let cloudExtinction = rayMarchCloudDensityToLight(
  froxelWorldPos, sunDirection, 8 /* steps */
);
sunContribution *= exp(-cloudExtinction);
```

Cost: one extra raymarch per froxel per light, clamped to a small
number of steps (4-8). Can be skipped when clouds are off.

#### Terrain shadow volumes

The existing sun shadow map (already used for PBR terrain shadows)
is the exact data structure we need. No new shadow rendering pass —
we sample the same map the terrain renderer uses. The only wrinkle
is that the shadow map is sized for the main view frustum; volumetric
fog extends further. For fog beyond the shadow map's far plane we
fall back to `sunShadowFactor = 1.0` (assume lit), which is a
reasonable approximation for far fog.

#### Togglability and cost

- `enableScatteringOcclusion = false`: Pass 2 skips all shadow map
  queries, uses `shadowFactor = 1.0`. Saves ~40% of Pass 2 cost
  (~0.5 ms at medium resolution).
- `enableScatteringOcclusion = true` (default when volumetric fog
  is on): full shadow queries, god rays visible.
- Dependency: requires `enableVolumetricFog = true` to have any
  visual effect; the flag is a no-op when the froxel grid isn't
  running. Documented in JSDoc.

#### Ambient term

Pure direct-light scattering with occlusion gives you hard-edged,
over-dark shadow volumes. Reality has an ambient term from
sky-dome light (clouds lit from above that scatter into shadows
below). We approximate this with a per-froxel ambient fetch from
the atmosphere inscatter LUT sampled at `(altitude, up direction)`:

```wgsl
let ambient = sampleAtmosphereInscatterLUT(froxelAltitude, upDir);
scatteredLight += fogAlbedo * density * ambient * 0.1;  /* small factor */
```

This single line turns harsh shadow volumes into soft, believable
crepuscular rays. The LUT is the same one built by Phase 3's
atmosphere multi-light work — another shared data structure.

---

## 5. Cross-cutting: Light Contribution Model

The current model has one canonical light: `scene.light` (a `SunLight`
that the user manually configures). Models, terrain, and atmosphere
all read from it independently.

After this work the model has:

- **`scene.lights`** — the canonical multi-light collection (already
  exists in `LightTypes.ts`).
- **`scene.sunLight`** — convenience accessor for the sun light entry,
  auto-synced to actual sun direction when `enableSunLight` is on.
- **`scene.moonLight`** — convenience accessor for the moon light
  entry, auto-synced when `enableMoonLight` is on.
- **`frameState.sunDirectionWC`, `frameState.moonDirectionWC`** —
  computed once per frame in `UniformStateComputations.js`.
- **`frameState.sunIntensity`, `frameState.moonIntensity`** — scalar
  intensities accounting for above/below horizon and moon phase.
- **`frameState.skyBrightness`** — scalar [0..1] computed from
  sun/moon contributions plus atmospheric conditions, used for star
  modulation.

Renderers that currently read `frameState.sunDirectionWC` continue to
work unchanged. Renderers that opt into multi-light read from
`scene.lights`.

---

## 6. Implementation Phases

**Phase 1 — Toggle scaffolding (1 session):**
- Add all 9 new boolean toggles to `Scene.js` with defaults
- Add `AtmosphericConditions` class with the 4 tunable properties
- Wire `Scene.updateFrameState()` to forward all 9 toggles + the
  conditions object onto `frameState`
- No renderer changes; the toggles do nothing yet but are documented
  and reachable
- Tests: confirm defaults preserve current behavior

**Phase 2 — Sun + Moon synchronization (1-2 sessions):**
- `Scene.enableSunLight` wires sun direction → `scene.light.direction`
- New `MoonLight` class
- `frameState.moonDirectionWC` populated in `UniformStateComputations.js`
  using existing `Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame`
- `Scene.enableMoonLight` adds moon light to `scene.lights`
- Moon phase fraction computed CPU-side from sun/moon directions
- `Moon.wgsl` extended to render lit hemisphere only (or full sphere
  with earthshine on dark side, gated by `enableMoonPhase`)
- Sun horizon falloff for `SunLight.intensity`
- Tests: ephemeris tests against known dates (full moon 2025-03-14, etc.)

**Phase 3 — Atmosphere multi-light + LUT activation (2-3 sessions):**
- Wire `AtmosphereLUT.wgsl` compute shader into the atmosphere render
  path; activate `Scene.atmosphere.useLUT = true` by default
- Add `Scene.enableDualLightAtmosphere`:
  - Per-frame compute pass builds two LUT pairs (sun, moon)
  - Runtime fragment shader samples both
  - Moon contribution scaled by phase fraction
- CPU-side sky brightness estimator → `frameState.skyBrightness`
- Star modulation: cubemap shader reads `frameState.skyBrightness` via
  a new uniform field, multiplies sampled color by it
- `Scene.enableStarBrightnessModulation` and
  `Scene.enableNightSkyDimming` toggles
- Tests: visual regression on a fixed sun/moon date pair; sanity tests
  on the LUT compute output (transmittance monotonically decreases
  with altitude, etc.)

**Phase 4 — Atmospheric conditions integration (1 session):**
- `AtmosphericConditions.humidity` → fog density and atmosphere
  scattering coefficients
- `AtmosphericConditions.cloudCover` → star occlusion factor in
  the modulation calculation
- `AtmosphericConditions.airQuality` → rayleigh / mie coefficient
  scale in the LUT compute shader
- All consumers gated by `Scene.enableAtmosphericConditions`
- Tests: parameter sweep visual checks

**Phase 5 — Participating media + scattering occlusion (3-4 sessions):**
The heaviest rendering work in the project. Implements the unified
volumetric fog + varying atmosphere density + scattering occlusion
system (§4.8-4.10).

- **5a — Froxel grid infrastructure (1 session):** Allocate the
  3D textures (two rgba16float at configurable resolution), wire
  screen-UV + log-depth parameterization, add `Scene.enableVolumetricFog`
  toggle and resolution enum. Empty density injection pass. Final
  composite pass samples the grid and multiplies into scene color
  with a transmittance = 1.0 default → no visual change yet, just
  infrastructure.
- **5b — Density injection + height fog (1 session):** Density
  injection compute pass computes base fog density from altitude +
  the `AtmosphericConditions` fog parameters. Light scattering pass
  evaluates sun + moon (from Phase 2 work) with the HG phase
  function. No occlusion yet — every froxel treats light as fully
  lit. Visual result: volumetric height fog with no god rays.
- **5c — Scattering occlusion (1 session):** Hook the existing sun
  shadow map into the light scattering pass. Add moon shadow map
  (cheap, very low resolution — moonlight is dim enough that
  shadow precision doesn't matter much). Add the ambient term
  from the Phase 3 atmosphere inscatter LUT. Visual result:
  terrain shadow shafts, crepuscular rays at dawn/dusk, soft
  ambient fill. This is the "wow" moment of the whole project.
- **5d — Varying atmosphere density (0.5 session):** Add the 3D
  noise modulation to the density injection pass. Add the
  `AtmosphericConditions` atmosphere-density tunables. Since the
  unified density field is already in place, this is ~100 lines
  of shader code plus the CPU tunables.
- **5e — Cloud shadow contribution (0.5 session, optional):**
  When volumetric clouds (Phase 6) are active, the light scattering
  pass does a small 8-step raymarch through the cloud density
  texture toward each light to compute cloud extinction. Falls
  back to `extinction = 0` when clouds are off.

Tests: visual regression against baseline screenshots, GPU timing
sanity checks against the cost estimates above, toggle-independence
tests for each sub-phase flag.

**Phase 6 (deferred) — Volumetric clouds:**
- Schneider/Häggström raymarch implementation
- 3D worley + perlin density texture generation (one-time compute)
- Cloud layer raymarch fragment shader
- `Scene.enableVolumetricClouds` toggle (default false)
- Falls back to existing `CloudCollection` when off
- Integrates with Phase 5c scattering occlusion to produce cloud
  shadows inside the volumetric fog

Phases 1-5 are the core deliverable (~8-11 sessions). Phase 6 is a
quality opt-in that can ship later.

---

## 7. Risks & Open Questions

### Risks

1. **LUT compute shader correctness.** The existing `AtmosphereLUT.wgsl`
   was built but never wired. Activating it might surface latent bugs
   (wrong parameterization, off-by-one in sample indexing, etc.). Plan
   to verify against the per-pixel ray-march output as ground truth.
2. **Per-frame LUT recompute cost.** Two LUT bakes per frame (sun + moon)
   is in the worst case ~1ms on integrated GPUs. If this turns out to
   be expensive, fall back to async compute or compute every Nth frame
   with double-buffered LUTs.
3. **Moon position accuracy at high zoom.** Simon 1994 is ~1 arcmin
   accurate. Visually fine at any reasonable zoom; only matters if
   someone tries to do precise lunar occultation visualization.
4. **`scene.light` synchronization breaking existing apps.** Some
   apps manually configure `scene.light.direction`. The
   `enableSunLight` toggle defaulting to `true` could break them.
   **Mitigation:** Default to `false` for the first release, document
   the migration, default to `true` in a follow-up release.
5. **Volumetric cloud GPU budget.** Schneider raymarch is expensive.
   Devices below ~mid-tier desktop won't sustain 60fps with it on.
   Default-off mitigates.
6. **Froxel grid memory pressure.** At "medium" resolution the two
   rgba16float 3D textures cost ~58 MB VRAM. At "high" ~200 MB.
   Mobile devices with <1 GB total GPU memory might fail to allocate
   "high" — the feature silently falls back to "medium" if "high"
   allocation fails, and to "low" if "medium" fails. Log the selected
   tier on initialization so users can diagnose surprises.
7. **Shadow map far-plane mismatch.** The sun shadow map used by the
   terrain renderer is sized for the *view* frustum, but volumetric
   fog extends further (configurable via `maxDistance`, default 50 km).
   Froxels beyond the shadow map assume "lit" — correct for clear
   horizons, wrong for fog in deep mountain valleys at long range.
   Acceptable approximation; document in release notes.
8. **Temporal stability of the froxel grid.** Without temporal
   reprojection, low-resolution froxel grids produce visible
   shimmering as the camera moves (density field aliasing). Mitigation:
   Add temporal blue-noise jitter to the density sampling in Phase
   5b. Full TAA-style reprojection (history buffer blend) is a
   future enhancement if jitter alone isn't enough.
9. **Interaction between volumetric fog composite and transparency.**
   The composite applies `sceneColor × transmittance + scattered` as
   a single pass. This is correct for opaque geometry but incorrect
   for translucent surfaces drawn after — their color was produced
   assuming the *previous* fog state. For the initial implementation
   we apply fog only to opaque + OIT-resolved color; fully transparent
   overlays (UI, debug draw) skip it. Document the limitation.
10. **God-ray banding from shadow map PCF.** When shadow map samples
    are coarse the scattered-light output shows visible banding along
    depth slices. Mitigation: jitter the shadow sample UV by the
    per-froxel blue noise, same jitter used for density temporal
    stability. Costs nothing extra if the jitter is already computed.

### Open questions

1. **Earthshine on the dark side of the moon — yes or no?** It's a
   real visible effect at new-moon phase, but it adds shader complexity
   and a configuration parameter. Vote: yes, gated by `enableMoonPhase`,
   constant blue tint, no need for full earth-radiosity model.
2. **Should `MoonLight` be a `DirectionalLight` or its own type?** It
   behaves like a directional light (parallel rays at planetary scale),
   so a subclass of `DirectionalLight` is the cleanest fit.
3. **Wavelength dependence of atmospheric coefficients.** Currently
   `atmosphereLightIntensity` is a scalar. Real moonlight is bluer
   than sunlight. Should we expose `lightTint: vec3` per light?
   Vote: yes, but constant per-light at construction time, not a
   per-frame uniform.
4. **Star modulation curve.** Linear `1 - skyBrightness` is too sharp;
   stars pop in/out at twilight. Probably want a smoothstep, with the
   inflection point and the steepness as tunables. Add to
   `AtmosphericConditions` or a separate `starModulationCurve` field?
5. **What happens to `Scene.skyAtmosphere.show = false` + dual-light
   enabled?** Atmosphere off means no scattering, so dual-light has
   nothing to do. The toggle should be a no-op in that case. Document
   the dependency.
6. **Per-renderer cost of toggle reads.** With 14+ new toggles flowing
   through frameState, each render path now reads more state. Each
   read is one property lookup — JIT-friendly, ~free — but worth a
   sanity profile after Phase 1.
7. **Default froxel resolution on desktop.** "Low" is safe for every
   device but undersells quality on desktop. "Medium" is the sweet
   spot but costs ~3 ms on mid-range GPUs. Proposal: auto-select based
   on `navigator.gpu.wgslLanguageFeatures` or a one-time benchmark of
   empty compute dispatches at init. Fall back to "low" if the probe
   is inconclusive.
8. **Should varying atmosphere density ship enabled by default?**
   With `atmosphereDensityNoiseStrength = 0` it's visually identical
   to the Nishita baseline, so defaulting the toggle on costs nothing
   visually. But the 3D noise sample adds a non-trivial constant cost
   to the density injection pass. Vote: default off, opt in via the
   toggle for users who want the effect.
9. **Scattering occlusion without volumetric fog — valid?** The
   `enableScatteringOcclusion` flag depends on `enableVolumetricFog`
   to have any visible effect. Users might be confused when flipping
   the occlusion flag does nothing. Options: (a) silently no-op,
   (b) log a warning once, (c) enable the sky atmosphere's per-pixel
   ray march to sample shadow maps even without the froxel grid.
   Option (c) is the most "correct" but adds cost to a code path
   that doesn't otherwise need it. Vote: (b) — one-shot warning.
10. **Fog interaction with 3D Tiles opacity.** 3D Tiles models can
    have per-feature alpha, which the volumetric fog composite
    applies *after* rasterization. For features drawn through thick
    fog with low alpha, the fog may over-darken them. The correct
    fix is per-fragment transmittance application, which requires
    sampling the 3D fog grid inside the 3D Tiles fragment shader
    rather than doing a post-composite. Tradeoff: correctness vs
    touching every material shader. Vote: post-composite for initial
    release, per-fragment in a follow-up if artifacts are visible.
11. **Temporal reprojection — include in Phase 5b or defer?**
    Without it, low-resolution froxel grids shimmer during camera
    motion. With it, we need a history buffer and reprojection
    vectors. Vote: defer to a Phase 5f polish step after 5a-5d land.
    Blue-noise jitter alone may be enough.

---

## 8. Testing Strategy

1. **Ephemeris tests.** Existing `Simon1994PlanetaryPositionsSpec.js`
   covers position correctness. Add tests for moon phase fraction
   against known new/full moon dates.
2. **Visual regression.** Capture screenshots at fixed JulianDate for
   sun-up, sun-down, full moon, new moon, twilight. Diff after each
   phase against baseline.
3. **Toggle independence.** Unit test that asserts each toggle, set
   in isolation, produces a measurable change in `frameState` and
   leaves all other fields untouched.
4. **Default-state regression.** A test that constructs a Scene with
   no toggles set and confirms `frameState` matches the pre-design
   baseline byte-for-byte (where possible).
5. **LUT compute correctness.** Compare LUT-mode atmosphere output
   to per-pixel ray-march output at a fixed sun direction; differences
   should be below ~5% for reasonable sample counts.
6. **Integration test for Phase 2.** With sun above horizon and
   `enableSunLight = true`, confirm `scene.lights.sunLight.direction`
   matches `frameState.sunDirectionWC`. Same for moon.

---

## 9. Estimated Effort

| Phase | Sessions | Risk |
|---|---|---|
| 1 — Toggle scaffolding | 1 | Low |
| 2 — Sun + Moon sync + phases | 1-2 | Low-Medium |
| 3 — Atmosphere multi-light + LUT | 2-3 | Medium-High |
| 4 — Atmospheric conditions | 1 | Low |
| 5a — Froxel grid infrastructure | 1 | Low |
| 5b — Density injection + height fog | 1 | Medium |
| 5c — Scattering occlusion + ambient | 1 | Medium-High |
| 5d — Varying atmosphere density | 0.5 | Low |
| 5e — Cloud shadow contribution | 0.5 | Medium (gated on Phase 6) |
| 6 — Volumetric clouds (deferred) | 3-4 | High |

**Phases 1-5: 8-11 focused sessions.** Phase 6 deferred.

The risk is now distributed across two high-value pieces:
Phase 3 (atmosphere multi-light + LUT activation) and Phase 5c
(scattering occlusion). Both are the high-quality visual payoffs
and both benefit from extra care. Phases 1, 2, 4, 5a, 5b, 5d are
largely mechanical wiring against infrastructure that already
exists (toggle forwarding, shader module augmentation, additional
compute kernels on the existing compute pipeline infrastructure).

Phase 5c is where god rays, crepuscular beams, and terrain shadow
shafts actually appear on screen. If the project budget ever has
to stop short, stopping after 5c is a natural milestone: the result
is a visually dramatic upgrade even without 5d (which is subtle)
or 5e (which depends on Phase 6).

---

## 10. Decision points before starting

These need confirmation before Phase 1 kicks off:

1. **Default for `enableSunLight`** — `true` (auto-sync) or `false`
   (preserve manual mode)? See risk #4.
2. **Earthshine on/off?** See open question #1.
3. **`MoonLight` as `DirectionalLight` subclass or standalone?**
   See open question #2.
4. **Phase 6 timing** — start volumetric clouds after Phase 5, or
   freeze the design and defer indefinitely?
5. **Naming** — `enableMoonLight` vs `moon.contributesToLighting`?
   The flat property style matches existing `enableLighting`,
   `showGroundAtmosphere`. Vote: stay flat.
6. **Default froxel resolution.** Low (safe, dull) or Medium (good,
   ~3ms on mid desktop)? Auto-select based on init probe? See open
   question #7.
7. **Default for `enableVolumetricFog`.** Off is the safest — no
   perf regression, users opt in. On is the more ambitious
   default — "modern renderer" expectation. Vote: off by default,
   documented prominently in the release notes so users know to
   try it.
8. **Default for `enableVaryingAtmosphereDensity`.** See open
   question #8. Vote: off.
9. **Default for `enableScatteringOcclusion`.** On when volumetric
   fog is on (god rays are the main visual payoff); no-op when
   volumetric fog is off. See open question #9.
10. **Varying atmosphere density without the froxel grid** — should
    the per-pixel ray march sample the same 3D noise field when
    `enableVolumetricFog = false`? Cheaper to skip and document the
    limitation. Vote: skip; varying density requires the froxel grid.
11. **Fog composite placement in the pipeline.** Before or after
    3D Tiles transparent pass? See open question #10. Vote: after
    opaque + OIT-resolved, before UI overlay. Transparent 3D Tiles
    get post-composite fog (approximate) in v1; per-fragment fog
    in a follow-up if needed.
12. **Phase 5 blocking vs non-blocking for other work.** Phases 1-4
    deliver standalone value (celestial ephemeris + multi-light sky)
    without touching the participating media system. Phase 5 can
    ship independently after 1-4 are in main. Vote: land 1-4 first,
    then 5 as a separate feature branch. Both review cycles are
    shorter than one giant PR.

---

*End of design draft v2. Review before Phase 1 implementation begins.
v2 adds: participating media (volumetric fog), varying atmosphere
density, and scattering occlusion (god rays / crepuscular rays).
These three features are unified through a single froxel grid that
also feeds into atmosphere density modulation, giving a coherent
participating media + light transport system for ~3-4 sessions of
implementation.*
