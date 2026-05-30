# Celestial & Atmospheric Systems — Design Document

**Status:** Draft v3 — Session 24 v2 + 2026-04-08 decisions locked (B1-B23). Status table + Phase 3 sync 2026-05-13. Phase 4 SHIPPED (Batches 29 + 42); Phase 5 a-d SHIPPED (existing `WebGPUVolumetricFogRenderer` + `Compute/VolumetricFog.wgsl`); Phase 6 a + c + d + b ALL SHIPPED (Batches 43 + 44 + 45 — main raymarcher, cloud-shadow extinction in fog, quality dial, altitude-driven auto preset). Phase 5f (temporal reprojection polish) deferred as the only remaining sub-item. Orbit-rendering polish techniques added §13.
**Scope:** Sun, Moon, atmosphere, clouds, fog, stars, volumetric fog, varying
atmospheric density, scattering occlusion (god rays), and the lighting/visibility
coupling between them
**Audience:** CesiumJS WebGPU fork maintainers
**Sibling doc:** [WATER_RENDERING_DESIGN.md](WATER_RENDERING_DESIGN.md) — water
consumes the same `AtmosphericConditions`, sun/moon directions, and froxel grid
defined here.
**Decision log:** [SESSION_2026-04-08_RESEARCH_REPORT.md §8.2](SESSION_2026-04-08_RESEARCH_REPORT.md#82--b-series-celestial-atmosphere-design-23-questions)
locks all 23 B-series decisions referenced throughout this doc. When in doubt
on a value, that section is the source of truth.

> **Reading guide for v3:** §3 Toggle Architecture is now structured under the
> nested `scene.globe.atmosphericConditions.*` canonical home (introduced by
> the Phase 0 prep PR — see §12). §4 Subsystem Designs has been updated in
> place with the locked B decisions. §7 (formerly "Open Questions") and §10
> (formerly "Decision points") are now "Resolved" pointer tables. New §11
> documents the VisualPerformanceTargetService (emerged from B7). New §12
> documents the Phase 0 toggle audit prep PR.

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
| Moon rendering | ✅ Textured ellipsoid sphere, Phong + earthshine, real moon texture, phase gating | `Scene/Moon.js`, `Shaders/WebGPU/Environment/Moon.wgsl` |
| Atmosphere (scattering) | ✅ Nishita per-pixel ray march + LUT fast path + dual-light (sun+moon), geometric opacity, NONE-case per-fragment direction | `Scene/SkyAtmosphere.js`, `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` |
| Atmosphere LUT compute | ✅ Wired and active (Phase 1.3a/1.3c) | `Shaders/WebGPU/Compute/AtmosphereLUT.wgsl`, `WebGPUSkyAtmosphereRenderer.js` |
| Ground atmosphere | ✅ Integrated into terrain shader | `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` |
| Fog | ✅ Distance fog blended into terrain shader | `Scene/Fog.js`, `GlobeTerrain.wgsl` |
| Skybox / stars | ✅ Sky-brightness modulation + cloudCover star occlusion (Phase 1.3a) | `Scene/SkyBox.js`, `Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js`, `Shaders/WebGPU/CubeMapPanorama.wgsl` |
| Cumulus clouds | ✅ Billboard collection, weather effects | `Scene/CloudCollection.js`, `Shaders/WebGPU/Collections/CloudCollection.js` |
| Procedural ground clouds (ground-only, ≤4 km ceiling) | ✅ Volumetric raymarch, default off | `WebGPUProceduralCloudRenderer.ts`, `Shaders/WebGPU/Environment/ProceduralClouds.wgsl` |
| Volumetric clouds (orbit-visible) | ✅ Schneider-style HG dual-lobe + Beer-Powder volumetric raymarcher (Phase 6 main path); default off via `atmosphericConditions.clouds.enableVolumetric` (Batch 43 wiring) | `WebGPUProceduralCloudRenderer.ts`, `Shaders/WebGPU/Environment/ProceduralClouds.wgsl` |
| Sun light | ✅ `SunLight` class, fed into PBR | `Scene/SunLight.js`, `LightTypes.ts` |
| Moon light | ✅ `MoonLight` class shipped Phase 2 (1.2c v2) | `Scene/MoonLight.js` |
| Star brightness modulation | ✅ Shipped Phase 1.3a — smoothstep curve + cloudCover multiply | `WebGPUCubeMapPanoramaRenderer.js` |
| Moon phase / illumination | ✅ Computed CPU-side, plumbed via `frameState.moonPhaseFraction`, scales atmosphere moon-LUT + moon shader's lit term | `Scene/Moon.js`, `SkyAtmosphere.wgsl` |
| Multi-light scattering | ✅ Phase 1.3c — sun + moon dual LUTs, moon scaled by phase | `SkyAtmosphere.wgsl` (bindings 3-4, `dualLightControl` uniform) |
| Dual-light terrain shading | ⚠️ Sun direction now correctly `lightDirectionEC` (Batch 17/18); moon contribution on terrain not yet wired | `GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceCameraUB.ts` |
| `lightDirectionEC` parity (Globe + Model + SkyAtmosphere) | ✅ Batches 17, 18, 20 — Globe + Model packers fixed; SkyAtmosphere respects `Atmosphere.dynamicLighting` enum (NONE / SCENE_LIGHT / SUNLIGHT) | `WebGPUGlobeSurfaceCameraUB.ts`, `WebGPUModelRenderer.js`, `WebGPUSkyAtmosphereRenderer.js`, `SkyAtmosphere.wgsl` |
| Composite WGSL fabric (globe materials) | ✅ Batch 16 — top-level `components` fallback for composites without `wgsl: {}` block | `MaterialHelpers.js`, `WebGPUGlobeMaterial.ts` |
| Volumetric fog (froxel grid) | ✅ Phase 5a SHIPPED — 3D rgba16float texture pair + 3 compute passes (density inject, light scattering, integrate) + full-screen composite; default off via `atmosphericConditions.volumetricFog.enabled` | `WebGPUVolumetricFogRenderer.ts`, `Shaders/WebGPU/Compute/VolumetricFog.wgsl`, `PostProcess/VolumetricFogComposite.wgsl` |
| Scattering occlusion / god rays | ✅ Phase 5c SHIPPED — sun shadow-map sampling in `lightScattering` compute pass; ambient term for soft fill | `Compute/VolumetricFog.wgsl::sampleSunShadow` |
| Varying atmosphere density | ✅ Phase 5d SHIPPED — 3-octave value-noise FBM modulation in density-injection pass, gated by `enableVaryingDensity` | `Compute/VolumetricFog.wgsl::fbm3d` |
| Altitude-gated bloom | ✅ Batch 22 — smoothstep gate from 1.0 at sea level to `altitudeGateOrbitFloor` (default 0.15) at ≥1 Earth radius | `WebGPUBloomEffect.ts::applyAltitudeGate` |
| Altitude-gated auto-exposure | ✅ Batch 39 — blends adaptive multiplier toward neutral 1.0 at orbit (matches Frostbite/Karis conv: adaptive exposure is a camera-lens / retina effect, absent for vacuum viewpoints) | `WebGPUAutoExposure.ts::applyAltitudeGate` |
| Orbit-limb specular attenuation | ✅ Batch 23 — ocean GGX specular fades via `smoothstep(100km, 1ER, altitude)` to remove sun-side glare at orbit | `Shaders/WebGPU/Globe/GlobeTerrain.wgsl::computeEnhancedOcean` |
| Real-time satellite cloud-map imagery | ❌ Out of doc scope — user-side via custom `ImageryProvider` | — |

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
togglable**. Per **B16 locked decision**, leaf names stay flat
(`enableMoonLight`, not `moon.contributesToLighting`), but they're
**organized under nested config groups** under one canonical home:
`scene.globe.atmosphericConditions.*`. The toggle audit prep PR
(§12) introduces this nested home before any feature work begins.

### Rules

1. **One canonical home: `scene.globe.atmosphericConditions`.** Every
   new atmospheric / lighting toggle lives somewhere in this nested
   tree. The historical scattered locations
   (`scene.atmosphere`, `scene.fog`, `globe.enableLighting`,
   `globe.atmosphereHueShift`, etc.) are preserved as **delegating
   getter/setter shells** that read/write through to the canonical
   home. Existing apps continue to work unchanged. See §12 for the
   prep PR pattern.
2. **Frame state forwarding.** `Scene.updateFrameState()` copies each
   toggle onto `frameState` once per frame. Renderers read from
   `frameState`, never from `scene.globe.atmosphericConditions`
   directly. This is the same pattern already established for
   `debugShowGlobeWireframe`, `debugShowTriangulation`, etc.
3. **Cold-path discipline.** When a toggle is in its default state,
   the production hot path pays at most one local-bool comparison.
   Renderers branch on the local at the top of their per-frame update,
   not per-object/per-tile.
4. **Backend-agnostic surface.** Every toggle is documented and
   defined in `Scene.js` (or its companions) even if only the WebGPU
   renderer reads it. WebGL renderers ignore unknown frame state
   fields harmlessly.
5. **Dependency disclosure.** A toggle that depends on another
   (e.g. `enableMoonLight` is a no-op if `Scene.moon` is undefined) is
   documented in JSDoc. Renderers must handle the off-path gracefully.
6. **Renderer parity.** Existing scene-level toggles like
   `Scene.skyAtmosphere.show` and `Scene.fog.enabled` stay where they
   are AND become delegating shells over the canonical home. Per
   **B12 locked decision** for `enableSunLight = true` by default,
   the breaking-app concern raised in v2 risk #4 is moot — the
   existing `SunLight` API doesn't expose a `direction` field, so
   there are no apps to break.

### Canonical toggle structure (locked)

After the Phase 0 prep PR lands (§12), the canonical nested home is:

```text
scene.globe.atmosphericConditions = {

  // ── Lighting (sun + moon symmetry per B2/B14) ─────────────────
  lighting: {
    enableSunLight,                        // B12: default TRUE
    enableMoonLight,                       // B14: default TRUE (mirrors sun)
    enableMoonPhase,                       // B1: default TRUE
    enableEarthshine,                      // B13: default TRUE (gated by enableMoonPhase)
    enableDualLightAtmosphere,             // B12: default TRUE
    sunIntensity,
    moonIntensity,
    sunTint,                               // B3: vec3, constant at construction
    moonTint,                              // B3: vec3, constant at construction (slightly bluer)
  },

  // ── Sky atmosphere ────────────────────────────────────────────
  skyAtmosphere: {
    enabled,                               // delegates to legacy scene.skyAtmosphere.show
    useLUT,                                // default TRUE
    lightIntensity,
    rayleighCoefficient, mieCoefficient,
    rayleighScaleHeight, mieScaleHeight, mieAnisotropy,
    hueShift, saturationShift, brightnessShift,
    starModulationCurve: {                 // B4: smoothstep, independently controllable
      inflection,                          //   default 0.3
      steepness,                           //   default 4.0
    },
    enableNightSkyDimming,                 // default TRUE
    enableStarBrightnessModulation,        // default TRUE
  },

  // ── Ground atmosphere ─────────────────────────────────────────
  groundAtmosphere: {
    enabled,                               // delegates to legacy globe.showGroundAtmosphere
    perFragment,
  },

  // ── Fog (atmospheric haze, distance-based) ────────────────────
  fog: {
    enabled,                               // delegates to legacy scene.fog.enabled
    renderable,
    density, heightScalar, heightFalloff, maxHeight,
    visualDensityScalar, screenSpaceErrorFactor, minimumBrightness,
  },

  // ── Volumetric fog (froxel grid participating media) ──────────
  volumetricFog: {
    enabled,                               // B18: default FALSE
    quality,                               // B7/B17: "low" | "medium" | "high" | "auto"
    maxDistance,                           // default 50000 m
    density, falloff,
    fogAnisotropy,                         // HG g parameter, default 0.3
    fogAlbedo,                             // vec3, default (0.9, 0.92, 0.95)
    enableScatteringOcclusion,             // B20: independently toggleable, default FALSE
                                           //       (silent no-op when volumetricFog.enabled is false per B9)
  },

  // ── Varying atmosphere density ────────────────────────────────
  varyingAtmosphereDensity: {
    enabled,                               // B19: default FALSE
    noiseScale,                            // default 5000 m
    noiseStrength,                         // default 0
    // Per B21: this feature requires volumetricFog.enabled. The per-pixel
    // sky atmosphere ray-march fallback is intentionally NOT implemented
    // — when volumetricFog.enabled is false, this is a no-op + documented
    // as a known limitation.
  },

  // ── Clouds (procedural 2D + volumetric upgrade) ───────────────
  clouds: {
    proceduralCoverage,                    // existing 2D procedural cloud cover
    enableVolumetric,                      // B15: default FALSE; ships after Phase 5a-5d
    volumetricQuality,                     // "low" | "medium" | "high" | "auto"
    volumetricEnableAltitude,              // B15: 50_000 m default (volumetric kicks in below)
    volumetricDisableAltitude,             // B15: 100_000 m default (pure procedural above)
    // Per B15: volumetric path reads from the existing
    // WebGPUProceduralCloudRenderer noise field, not its own.
    // See §4.6 for the cutover model.
  },

  // ── Stars and night ───────────────────────────────────────────
  night: {
    enableNightLights,                     // delegates to legacy globe.enableNightLights
    nightIntensity,
    enableTerminatorGlow,
  },
};
```

> **All B-series defaults locked:** B7/B17 quality enum auto-selects via
> the VisualPerformanceTargetService init benchmark (§11). B8/B19
> default off. B10 fog interaction with 3D Tiles opacity is
> post-composite v1, per-fragment follow-up. B11 temporal reprojection
> deferred to Phase 5f. B22 fog composite placement: after opaque +
> OIT-resolved, before UI overlay. B23: phases 1-4 land first, then 5
> as separate feature branch.

### Legacy compatibility shells

Per **B16** and the toggle audit findings in
`SESSION_2026-04-08_RESEARCH_REPORT.md §9.5`, every existing scattered
toggle becomes a delegating getter/setter that reads/writes through
to the canonical home. Apps written before v3 keep working unchanged:

```js
// Globe.js — preserved for backward compat (illustrative)
Object.defineProperty(Globe.prototype, "atmosphereHueShift", {
  get() { return this._atmosphericConditions.skyAtmosphere.hueShift; },
  set(v) { this._atmosphericConditions.skyAtmosphere.hueShift = v; },
});
Object.defineProperty(Globe.prototype, "showGroundAtmosphere", {
  get() { return this._atmosphericConditions.groundAtmosphere.enabled; },
  set(v) { this._atmosphericConditions.groundAtmosphere.enabled = v; },
});

// Scene.js — same pattern
Object.defineProperty(Scene.prototype, "fog", {
  get() {
    // Returns a thin proxy that delegates each property to the canonical home
    return this._fogShell;
  },
});
```

This means:

1. Existing apps that set `scene.fog.density = 0.001` keep working —
   the value flows through to `scene.globe.atmosphericConditions.fog.density`.
2. The duplication between `Scene.atmosphere.*` and
   `Globe.atmosphere*` is fixed at the storage layer — both shells
   point at the same underlying object.
3. The new design has a clean nested home for new toggles that
   doesn't add to the existing scatter.
4. We don't deprecate or rename anything in this pass — that's a
   separate (much larger) effort. This change is purely additive:
   new canonical home + delegating shells.
5. Upstream sync stays clean — when upstream adds new properties to
   `Scene.atmosphere`, we add them to the canonical home and add a
   delegating shell. No conflict.

### Failure mode policy

If a toggle is on but the underlying capability isn't supported on
this device (e.g. volumetric clouds need 3D textures + compute, LUT
mode needs storage textures), the renderer logs a warning **once** and
silently degrades to the next-best variant. Same pattern as the WGF-6
primitive_index probe in Session 22. Per **B6**, a sanity profile of
the per-renderer toggle-read cost happens after Phase 1 lands.

---

## 4. Subsystem Designs

### 4.1 Sun

**Already exists.** Three things to add:

1. **`scene.globe.atmosphericConditions.lighting.enableSunLight`** — when
   true (per **B12, default TRUE**), `Scene.updateFrameState()` sets
   `scene.light.direction` from `frameState.sunDirectionWC` each frame.
   When false, behavior is today's manual mode. Single conditional in
   `updateFrameState()`. ~5 lines. **The breaking-app concern from v2
   risk #4 is moot:** the existing `SunLight` API doesn't expose a
   `direction` field, so there are no apps that could be manually
   configuring the sun direction today. Defaulting to TRUE on first
   release is safe.
2. **Sun below horizon handling** — when the sun is below the local
   horizon, the existing renderer happily draws the disk through the
   earth. The fix is a depth test against the inner sphere, already
   present in atmosphere code; just needs to be wired into Sun.wgsl
   when `enableSunLight` is on.
3. **Sun intensity coupling** — `SunLight.intensity` should fall off
   smoothly as the sun crosses the horizon (twilight). Computed from
   the angle between sun direction and local up at the camera position.
   Existing math; just needs to be exposed.

Per **B3 locked decision**, `SunLight` gains a `tint: vec3` field
(default white-ish), set at construction and held as a constant per-light
uniform — not a per-frame value. Atmosphere LUT compute consumes this
to give the sun a slightly warmer tint at sunrise/sunset (or whatever
the user configures).

### 4.2 Moon

**Already exists for position/orientation/sphere rendering.** Per **B1
locked decision**, moon geometry is already correct: the existing
[Moon.js](../packages/engine/Source/Scene/Moon.js) computes its position
via `Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame()`
in real ICRF coordinates (real ~384,400 km distance), uses
`Ellipsoid.MOON.radii` for real lunar radii, and applies
`IauOrientationAxes` for the real IAU lunar reference frame so the
correct face points at Earth. **No fix needed for the geometry** — the
work is purely on the lighting/phase/visibility side.

The moon should be visible from arbitrary camera positions (Earth
orbit, lunar orbit, deep space). The geometry already supports this;
historical defaults just haven't tested it because the typical Cesium
use case is "camera near Earth surface."

> **Future follow-up (NEW-6 in SESSION report §10):** higher-resolution
> moon texture. The current `moonSmall.jpg` is fine from
> Earth-distance views but blurry at close range. Half-session task,
> deferred. Tracked in the backlog as `NEW-6`.

#### Moon mirrors Sun symmetrically (B2 / B14)

Per **B2 / B14 locked decision**, `MoonLight` is a **marker class
mirroring `SunLight`** — NOT a `DirectionalLight` subclass. The
engine writes its direction internally each frame from ephemeris,
exactly like the existing `SunLight` magic-marker pattern. Apps
wanting manual moon direction construct a regular `DirectionalLight`
instead and bypass the moon ephemeris.

**Why mirroring is the right call:**

- The existing `SunLight` class is a marker without a `direction`
  field — the engine fills it in from `Simon1994PlanetaryPositions`
  each frame
- Mirroring this pattern for moon means **both celestial bodies share
  the same idiomatic API** rather than introducing an asymmetric
  "sun is magic, moon is explicit" split
- Apps that need manual control of either light just construct a
  `DirectionalLight` and bypass the ephemeris entirely

#### Five things to add

1. **Moon phase computation.** Given the sun direction, moon direction,
   and moon position relative to camera, compute the illuminated
   fraction in the fragment shader. The existing `Moon.wgsl` already
   does Lambertian lighting from `sunDirectionEC` — extending this to
   show only the lit face is straightforward (just don't render
   dark-side pixels, or render them as the very dim earthshine color
   per item 5 below).
2. **`MoonLight` class** — new `Scene/MoonLight.js`, mirrors
   `SunLight.js` structure exactly: marker class extending the abstract
   `Light` base, has `color` (default cool blue-white), `intensity`
   (default ~0.005 of sun, the realistic ratio is ~0.0014 but visual
   taste pushes it higher), and `tint: vec3` per **B3** (set at
   construction, constant per-light uniform).
3. **Light contribution.** When `enableMoonLight` is on (default
   TRUE per **B14 mirroring B12**), the moon light is added to
   `scene.lights`. The PBR shader path already handles multi-light
   via `LightUniforms.wgsl` — this is wiring, not new shader work.
4. **Direction synchronization.** Same pattern as sun:
   `MoonLight.direction` set internally each frame from
   `frameState.moonDirectionWC` (a new field, computed in
   `UniformStateComputations.js` exactly like `sunDirectionWC`).
5. **Earthshine** (per **B13** locked, default ON): dark side of the
   moon at new-moon phase has a faint blue glow from earthlight
   reflection. Single shader uniform, blends a constant blue tint
   into the unlit hemisphere. Gated by `enableMoonPhase`. No full
   earth-radiosity model — the blue tint is a constant.

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

**New class:** `Scene/AtmosphericConditions.js`. Per **B4 / B16 locked
decisions**, this is the **canonical home** for all atmospheric and
weather state — accessed as `scene.globe.atmosphericConditions` (per
the toggle audit prep PR in §12). The legacy scattered locations
(`Scene.atmosphere.*`, `Scene.fog.*`, `Globe.atmosphere*`, etc.) become
delegating shells over this single source of truth.

```js
class AtmosphericConditions {
  constructor(options = {}) {
    // Weather / sky state (consumed by atmosphere, sky, clouds, fog, water)
    this.cloudCover = options.cloudCover ?? 0;            // [0..1]
    this.humidity = options.humidity ?? 0.5;              // [0..1]
    this.airQuality = options.airQuality ?? 1.0;          // [0..1]
    this.windSpeed = options.windSpeed ?? 0;              // m/s
    this.windDirection = options.windDirection ?? 0;      // radians

    // Star modulation (B4: smoothstep with independently tunable curve)
    this.starModulationCurve = options.starModulationCurve ?? {
      inflection: 0.3,                                    // sky brightness at midpoint
      steepness: 4.0,                                     // smoothstep slope
    };
    this.starVisibilityThreshold = options.starVisibilityThreshold ?? 0.05;

    // The full nested config tree under
    // scene.globe.atmosphericConditions.{lighting, skyAtmosphere,
    // groundAtmosphere, fog, volumetricFog, varyingAtmosphereDensity,
    // clouds, night} is initialized here too — see §3 for the full
    // structure. This constructor block shows just the leaf weather
    // state; the nested config groups are wired up in the prep PR
    // (§12) as additional sub-objects on `this`.
  }
}
```

**Consumers:**

- Sky atmosphere shader: `humidity` → mie coefficient scale;
  `airQuality` → rayleigh coefficient scale.
- Star shader: `cloudCover`, `starVisibilityThreshold`,
  `starModulationCurve` (smoothstep with independently tunable
  inflection + steepness per **B4**).
- Volumetric cloud shader: `cloudCover` (controls density threshold).
- Fog: `humidity` → density modulation.
- **Water rendering** (sibling doc): `windSpeed`, `windDirection`,
  `cloudCover` for surface displacement and reflection brightness.
  Per **B4**, water is a first-class consumer of the same
  `AtmosphericConditions` instance.

The class grows by adding leaves to the nested structure documented
in §3. Adding a new property is one line in the constructor, one
Scene→frameState forward, one shader uniform field. The growth
pattern is well-defined.

#### Star modulation curve detail (B4)

Per **B4 locked decision**, the star modulation curve is a smoothstep
(linear is too sharp — stars pop in/out at twilight) with two
**independently tunable** parameters that live in `AtmosphericConditions`:

```wgsl
// Pseudocode for the star brightness modulation
fn computeStarBrightness(skyBrightness: f32, curve: StarModulationCurve) -> f32 {
  let t = saturate((skyBrightness - curve.inflection) * curve.steepness);
  return 1.0 - smoothstep(0.0, 1.0, t);
}
```

The curve is independently controllable by the user — bright-eyed
desert sky setups can use a sharp curve, light-polluted urban setups
can use a softer curve. Both `inflection` and `steepness` flow through
`frameState.atmosphericConditions.starModulationCurve` to the cubemap
panorama shader.

### 4.6 Volumetric Clouds

**Per B15 locked decision: PROMOTED from "deferred" to "ships
immediately after Phase 5a-5d."** Three approaches were considered;
this design uses a hybrid of approach #1 (raymarched volumetrics) for
near-altitude views AND the existing `WebGPUProceduralCloudRenderer`
for far-altitude views, with a configurable cutover.

#### Three approaches considered

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

**Locked design: hybrid raymarched (approach #1) at near altitude +
existing procedural 2D (built-in) at far altitude, with configurable
cutover.** Per **B15**, `enableVolumetricClouds` defaults to FALSE
(opt-in) but ships in this design's Phase 6 (immediately after
5a-5d) — not deferred indefinitely.

#### Why volumetric clouds got promoted

The original v2 design deferred this to "Phase 6, may not ship." The
v3 reasoning to ship it:

1. **The Phase 5 froxel grid infrastructure is already the foundation**
   that volumetric clouds build on. Once 5a-5d ship, Phase 6 is "add
   cloud density to the existing froxel density field + raymarch +
   composite," not "build a parallel system from scratch." Much smaller
   incremental cost.
2. **Volumetric clouds are visually the single biggest 'wow' feature**
   Cesium could ship in 2026. Game engines have had them since 2017;
   geospatial engines mostly haven't because the GPU budget assumed
   mobile/integrated. For modern desktop WebGPU users this constraint
   is gone.
3. **5e (cloud shadows in fog) was previously blocked on Phase 6.**
   Promoting Phase 6 unblocks 5e at the same time — both ship together.

#### Altitude-based cutover

The volumetric raymarch is expensive but only valuable when the camera
is *near or inside* the cloud layer. When the camera is far above
(e.g., looking down from orbit), the existing
`WebGPUProceduralCloudRenderer` 2D procedural cloud cover is visually
indistinguishable from volumetric and ~50× cheaper. Crossfade between
them based on camera altitude:

```text
camera altitude:        0 ──────── 50km ──── 100km ──── ∞
volumetric raymarch:    ████████████████░░░░░░          (full → fade out)
procedural 2D:                       ░░░░░░░████████████ (fade in → full)
```

Configurable thresholds (defaults shown):

```js
scene.globe.atmosphericConditions.clouds.volumetricEnableAltitude   = 50_000;  // m
scene.globe.atmosphericConditions.clouds.volumetricDisableAltitude  = 100_000; // m
scene.globe.atmosphericConditions.clouds.enableVolumetric           = false;   // B15: opt-in
scene.globe.atmosphericConditions.clouds.volumetricQuality          = "auto";  // "low"|"medium"|"high"|"auto"
```

Both layers share the **same `proceduralCoverage` value** so flipping
in/out of the volumetric range doesn't change cloud density visually
— just renders the same coverage with a different technique.

#### Critical: shared noise field

**The volumetric path reads from the existing
`WebGPUProceduralCloudRenderer` noise field**, not its own. Otherwise
cloud shapes wouldn't match across the crossfade zone — clouds would
visibly morph as you descend from orbit to cruise altitude. This is
the optimization that makes Phase 6 strictly an *addition* on top of
existing infrastructure, not a parallel system.

The procedural renderer already generates the underlying 3D worley +
perlin noise that the volumetric path needs. The volumetric path
becomes "raymarch through that existing noise field with density +
lighting + scattering occlusion from Phase 5c," rather than "build
your own cloud field from scratch."

#### Effort estimate revision

Because the noise field is already generated and the froxel grid +
scattering occlusion are already in place, the original 3-4 session
estimate **drops to 2-3 sessions**. The breakdown:

- **Phase 6a — Volumetric raymarch shader (1 session):** WGSL
  raymarch over the existing procedural noise field, samples
  altitude band, evaluates HG phase function, integrates scattered
  light per froxel. Composite into the existing froxel grid as a
  cloud-density contribution.
- **Phase 6b — Crossfade with procedural (0.5 session):**
  Altitude-based blend between volumetric raymarch and procedural 2D
  output. Hysteresis on the thresholds to prevent flicker at the
  transition altitude.
- **Phase 6c — Cloud shadows (5e folded in, 0.5 session):** The
  volumetric cloud density field casts shadows into the fog grid via
  the same per-froxel light raymarch already wired up by Phase 5c.
  Light integration multiplies the cloud extinction into the
  scattering occlusion term. **5e is no longer a separate phase** —
  it's bundled into 6c since both are active simultaneously.
- **Phase 6d — Quality dial (0.5 session):** "low" / "medium" /
  "high" / "auto" sample counts, wired into the
  VisualPerformanceTargetService (§11) so `quality: "auto"` adapts
  to frame budget.

#### What this design uses

The compute shader infrastructure (storage textures, async dispatch,
WebGPUCompute pipeline) is in place from Session 12-18 work; the
froxel grid is delivered by Phase 5a; the procedural 2D cloud noise
field is delivered by `WebGPUProceduralCloudRenderer`. Phase 6 just
ties them together.

> **Risk mitigation.** Per **B15**, default off + quality dial means
> mobile users opt out by default; desktop power users get the full
> experience. "Auto" via the new VisualPerformanceTargetService (§11)
> means even desktop users can let the engine adapt the quality
> dynamically if their target FPS isn't being met.

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

> **B18 locked: `enableVolumetricFog` defaults to FALSE.** No perf
> regression for users who don't opt in. Documented prominently in
> the release notes so users know to try it. The Phase 5a-5d work
> delivers the infrastructure; turning the toggle on is a one-line
> opt-in.
>
> **B22 locked: composite placement.** Volumetric fog runs **after
> opaque + OIT-resolved color, before UI overlay**. Transparent 3D
> Tiles get post-composite fog (an approximate result) in v1; the
> per-fragment correct path is a follow-up if visible artifacts
> warrant it (per **B10**).

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

> **B19 locked: `enableVaryingAtmosphereDensity` defaults to FALSE.**
> The 3D noise sample adds non-trivial constant cost to the density
> injection pass. Default off, opt-in toggle.
>
> **B21 locked: when `enableVolumetricFog` is FALSE, varying atmosphere
> density is also a no-op.** The per-pixel sky atmosphere ray-march
> fallback documented in v2's "failure mode" section is **NOT
> implemented**. Document the limitation: `enableVaryingAtmosphereDensity`
> requires `enableVolumetricFog` to have any visible effect. May be
> revisited in a future phase if there's demand.

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

> **B20 locked: `enableScatteringOcclusion` is independently toggleable,
> defaults to FALSE.** Originally proposed as "on when fog is on, no-op
> when fog is off." The locked version is **stronger separation of
> concerns**: the toggle is its own boolean and is set/unset
> independently of `enableVolumetricFog`.
>
> **B9 locked: silent gating when fog is off.** When `enableVolumetricFog
> = false`, scattering occlusion has no visible effect — there's no
> participating media for the shadow-occluded light to scatter through.
> The toggle is set but does nothing. **Document this dependency in
> JSDoc**, do NOT log a warning. Per **B21**, no per-pixel sky
> atmosphere ray-march fallback is implemented for the standalone case.

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

- `enableScatteringOcclusion = false` **(default per B20)**: Pass 2
  skips all shadow map queries, uses `shadowFactor = 1.0`. Saves
  ~40% of Pass 2 cost (~0.5 ms at medium resolution).
- `enableScatteringOcclusion = true`: full shadow queries, god rays
  visible. Independent toggle — does NOT auto-enable when fog is
  enabled. User opts in explicitly.
- Dependency: requires `enableVolumetricFog = true` to have any
  visual effect; the flag is a **silent no-op** when the froxel grid
  isn't running (per **B9** — no log warning, JSDoc-only documentation
  of the dependency). Per **B21**, no per-pixel sky-atmosphere ray-march
  fallback exists.

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

> **B23 locked: Phases 1-4 land first as one feature branch; Phase 5
> ships as a separate feature branch; Phase 6 ships immediately after
> 5a-5d.** Phases 1-4 deliver standalone value (celestial ephemeris +
> multi-light sky) without touching the participating media system.
> Both review cycles are shorter than one giant PR.
>
> Phase 0 (toggle audit prep PR — see §12) is the prerequisite for
> Phase 1. The prep PR is shared with the water rendering design and
> establishes the canonical nested home `scene.globe.atmosphericConditions`
> + delegating shells for legacy paths.
>
> **Implementation status (2026-05-13 update — supersedes the
> 2026-04-09 line):**
>
> - **Phase 0 ✅** (Phase 0 prep PR landed 2026-04-09)
> - **Phase 1 ✅** (toggle scaffolding, 2026-04-09)
> - **Phase 2 ✅** (Sun + Moon sync, 2026-04-09 — three rounds 1.2a/1.2b/1.2c v2)
> - **Phase 3 ✅** (Phase 1.3a star modulation + 1.3c dual-light atmosphere LUT
>   with moon-phase scaling — shipped post-2026-04-09 across multiple
>   batches; confirmed live in `SkyAtmosphere.wgsl` `dualLightControl`
>   uniform + bindings 3-4 moon LUTs, `CubeMapPanorama.wgsl` star
>   modulation smoothstep)
> - **Phase 4 ✅ SHIPPED** — `cloudCover` → star occlusion (Batch 1.3a);
>   `humidity` → fog density + mie coefficient scale (Batch 29);
>   `airQuality` → rayleigh coefficient scale (Batch 29);
>   `windDirection`/`windSpeed` → scaffolded on `SkyAtmosphere.wgsl`
>   uniform (Batch 42) ahead of any Phase 5/6 consumer that needs
>   advection. Phase 4 entry in DEFERRED_WORK marked FIXED 2026-05-13.
> - **Phase 5 ✅ a-d SHIPPED** — `WebGPUVolumetricFogRenderer` +
>   `Compute/VolumetricFog.wgsl` ship the full froxel grid (5a), height
>   fog density (5b), HG sun + moon scattering with sun-shadow-map god
>   rays (5c), and 3-octave value-noise varying density (5d). Wired into
>   `WebGPUSceneRendererEnvironmentalEffects` and gated on
>   `atmosphericConditions.volumetricFog.enabled` (default FALSE per
>   B18). **Phase 5f** temporal reprojection polish deferred.
> - **Phase 6 ✅ ALL SUB-ITEMS SHIPPED** —
>   **6a:** `WebGPUProceduralCloudRenderer` raymarcher (HG dual-lobe +
>   Beer-Powder + 3D FBM + light-march). Surfaced via
>   `atmosphericConditions.clouds.enableVolumetric` in Batch 43.
>   **6c (Batch 44):** Cloud shadows in volumetric fog — cheap
>   single-sample extinction along sun direction at cloud-layer
>   mid-altitude multiplies into the Phase 5c sun-shadow term.
>   **6d (Batch 45):** `atmosphericConditions.clouds.volumetricQuality`
>   preset enum (`"low" | "medium" | "high" | "auto"`) → renderer
>   `(maxSteps, lightSteps)`. Legacy numeric `globe.cloudQuality`
>   stays as power-user escape hatch.
>   **6b (Batch 45):** Altitude-driven `"auto"` mode reads the existing
>   `volumetricEnableAltitude` / `volumetricDisableAltitude` thresholds
>   (50/100 km defaults) and picks preset per-frame — subsumes the
>   original "separate 2D fast-path shader" design because the low
>   preset's per-frame cost is comparable.
>
> See §14 for orbit-rendering quick wins added 2026-05-13.

**Phase 0 — Toggle audit prep PR (1-2 sessions, shared with water doc) — ✅ COMPLETED 2026-04-09:**

- ✅ Introduce `scene.globe.atmosphericConditions` canonical nested object → `AtmosphericConditions.js` facade with 12 leaves
- ✅ Delegating getter/setter shells for every existing scattered path (`Scene.atmosphere.*`, `Scene.fog.*`, `Globe.atmosphere*`, `Globe.showGroundAtmosphere`, etc.) per the toggle audit findings — 97 properties across 11 surfaces inventoried and shelled
- ✅ Pure refactor — no behavior change. Existing apps work unchanged. `npx tsc --noEmit` clean throughout.
- ✅ Lands BEFORE both this design's Phase 1 AND the water design's Phase 1
- (Tests are deferred to a follow-up — Phase 0.x sub-phases were validated via typecheck + smoke parser tests)
- **Bonus delivered alongside Phase 0:** `VisualPerformanceTargetService` (Phase 0.4), 3D Tiles invalidation feed Phase 1 (Phase 0.5), NEW-5 spec verification (Phase 0.6), `SnapshotModeService` skeleton + spike memo (Phase 0.7). See `WEBGPU_MIGRATION_STATUS.md` § "Recent Progress" for the full inventory.

**Phase 1 — Toggle scaffolding (1 session) — ✅ COMPLETED 2026-04-09:**

- ✅ Add all locked B-series toggles (§3) to the canonical home with the locked defaults (mostly off; sun + moon lighting on per B12/B14) — defaults verified in `AtmosphericConditions.js` `buildLighting()`, `buildVolumetricFog()`, `buildVaryingAtmosphereDensity()`, `buildClouds()`, `buildSkyAtmosphere()`
- ✅ Wire `Scene.updateFrameState()` to forward atmosphericConditions onto `frameState` — single-line forward in the standalone render function next to the existing `frameState.atmosphere = scene.atmosphere`
- ✅ Added 5 new fields to `FrameState`: `atmosphericConditions`, `skyBrightness`, `sunDirectionWC`, `moonDirectionWC`, `moonPhaseFraction`
- ✅ Renderers now have a stable read surface for B-series toggles via `frameState.atmosphericConditions.*`

**Phase 2 — Sun + Moon synchronization (1-2 sessions) — ✅ COMPLETED 2026-04-09:**

This was the largest sub-phase by far. It actually landed in three rounds (1.2a, 1.2b, 1.2c v2) because the moon parity audit revealed the WebGPU moon was significantly behind WebGL beyond what the original brief covered. Final state:

- ✅ **`MoonLight` marker class** (`packages/engine/Source/Scene/MoonLight.js`) mirroring `SunLight` per B2/B14 — opt-in via `scene.light = new MoonLight()`. Default color `(0.85, 0.88, 1.0, 1.0)` cool tint, default intensity `0.05`.
- ✅ **`frameState.moonDirectionWC` populated** in `Moon.update(frameState)` (the canonical place per Option A — not a separate `UniformStateComputations.js` helper) using the existing `Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame` call already in Moon.js
- ✅ **Moon phase fraction** computed CPU-side from sun/moon directions: `0.5 * (1 - cos(angle(moonDir, sunDir)))`. Gated on `atmosphericConditions.lighting.enableMoonPhase`; falls back to `1.0` (full moon) when the toggle is off or no globe is attached.
- ✅ **Full WebGL parity moon shader port** — `Moon.wgsl` was rewritten to match `EllipsoidPrimitive.js` + `EllipsoidVS.glsl` + `EllipsoidFS.glsl` exactly:
  - **Bounding-cube rasterization** (8 verts, 36 indices, vec3 cube position) — replaces the original UV-sphere mesh approach. Cube screen footprint scales with the moon's actual on-screen size; matches WebGL's `BoxGeometry.fromDimensions({2,2,2})` exactly.
  - **Analytic ray-ellipsoid intersection** in moon model space
  - **Geodetic surface normal** via `position * oneOverRadiiSq` gradient — accounts for moon ellipsoid oblateness
  - **Back-face inside pass** matching `EllipsoidFS.glsl`'s `outsideFaceColor`/`insideFaceColor` mix
  - **CsmMaterial-style filling** — texture sample → `m.diffuse`; Phong runs through it (matches `Material.fromType(Material.ImageType)`)
  - **Phong lighting** (Lambert diffuse + specular) matching `czm_private_phong` exactly
  - **`onlySunLighting` toggle** honored — picks `sunDirMC` vs `sceneLightDirMC`
  - **Canonical spherical UV unwrap** via inlined `csm_ellipsoidTextureCoordinates`
  - **Exact log depth write** via VS-output clip-space `w`
- ✅ **Lit hemisphere with earthshine** per B1/B13 — gated on `atmosphericConditions.lighting.enableEarthshine`. Soft blue-grey ambient `vec3(0.4, 0.5, 0.7) * 0.08 * (1.0 - rawNdotL)` on the unlit side.
- ✅ **Phase gating** via `smoothstep(0.0, 0.3, phaseFraction)` on the lit term — new moon (phase ~0) fades the lit hemisphere toward black; quarter onward reaches full intensity.
- ✅ **Real moon texture loading** via `Resource.fetchImage()` + `WebGPUImageUpload.uploadImageToTexture()` — fixes the longstanding "gray placeholder" regression where every WebGPU user saw a 4×4 gray sphere.
- ✅ **RTE 64-bit precision in the VS** — improvement beyond WebGL parity; per project rule.
- ✅ **Render bundle pre-encoding** via `WebGPURenderBundleManager.getOrCreate()` — moon is the first real consumer of the bundle manager. Pipeline + bind group + draw sequence cached and replayed via `passEncoder.executeBundles([bundle])` from a new fast path in `WebGPUDrawCommand.execute()`. Bundle invalidates on bind group change (texture upgrade).
- ✅ **Snapshot mode freezable registration** — moon is the first real consumer of `SnapshotModeService`. Per-frame uniform writes become a no-op when frozen; bundle replays the captured state.
- ✅ **Behind-camera early-out** before any GPU work
- ⏸ **`lightTint: vec3` field on SunLight and MoonLight per B3** — deferred. The current Phase 1.2 work uses light color directly without a separate tint multiplier; B3 can land in a small follow-up if a real consumer needs it.
- ⏸ **Sun horizon falloff for `SunLight.intensity`** — deferred. Belongs more naturally in Phase 3 (atmosphere multi-light) where the LUT is the right place to tune sun intensity by altitude.
- ⏸ **Ephemeris tests against known dates** — Jasmine specs deferred to a follow-up (Phase 1.2 was validated via `npx tsc --noEmit` only).

**Phase 3 — Atmosphere multi-light + LUT activation (2-3 sessions) — ✅ COMPLETED post-2026-04-09 across multiple batches (1.3a + 1.3c):**

- ✅ `AtmosphereLUT.wgsl` compute shader wired; `useLut` activates when
  compute is available + camera within 2× shell thickness of outer
  radius. Fallback inline 16-step (now 64-step) ray-march for orbit
  cameras where LUT V-coord clamps.
- ✅ `enableDualLightAtmosphere`:
  - Per-frame compute pass builds two LUT pairs (sun + moon) when
    `atmosphericConditions.lighting.enableDualLightAtmosphere` is on
    (default ON per B14)
  - Runtime fragment shader samples both at
    `SkyAtmosphere.wgsl::dualLightControl.x > 0.5`
  - Moon contribution = `sampleScatteringLut(moonInscatterLut, ...) ×
    moonPhaseFraction × dualLightControl.z` (intensity multiplier)
- ✅ CPU-side sky brightness estimator → `frameState.skyBrightness`
  consumed by the cubemap panorama shader as `params.w`.
- ✅ Star modulation:
  `WebGPUCubeMapPanoramaRenderer.js` packs `starModulation` vec4
  (inflection, steepness, enableFlag, cloudCover) at offset 208;
  `CubeMapPanorama.wgsl::105-129` applies
  `1 - smoothstep(0, 1, t)` with `t = clamp((brightness -
  inflection) × steepness, 0, 1)` then multiplies by `(1 -
  cloudCover)`.
- ✅ `enableStarBrightnessModulation` toggle wired via
  `atmosphericConditions.starModulation.enableSkyBrightness` (default
  ON per B4).
- ⏸ Sanity tests on LUT compute output — visual regression captured
  in cross-backend sweep instead of dedicated Jasmine specs.
- ⏸ NONE-case dynamic atmosphere lighting (Batch 20) — completes the
  `czm_getDynamicAtmosphereLightDirection` parity with WebGL.

**Phase 4 — Atmospheric conditions integration (1 session) — ✅ COMPLETED 2026-05-13 (Session 65 Batch 29):**

- ✅ `AtmosphericConditions.humidity` → fog density AND atmosphere
  scattering coefficients. Fog density: `density *= 1.0 + (humidity
  - 0.5)` in `Fog.js::update` — humid air produces denser fog;
  default humidity 0.5 is bit-identical to pre-Batch-29 baseline.
  Atmosphere mie coefficient: scaled by `0.5 + humidity` in BOTH
  the LUT compute dispatch AND the inline `computeScattering`
  uniform pack (`WebGPUSkyAtmosphereRenderer.js::writeUniformBuffer`).
- ✅ `AtmosphericConditions.cloudCover` → star occlusion factor in
  the modulation calculation (`CubeMapPanorama.wgsl::starModulation.w`,
  multiplies final star color by `(1 - cloudCover)`)
- ✅ `AtmosphericConditions.airQuality` → rayleigh coefficient scale
  in BOTH paths. `rayleighScale = 1 / airQuality` so airQuality 1.0
  is identity; lower values (smog / pollution) make sky redder
  (more Rayleigh extinction), higher values (clean mountain air)
  make sky bluer.
- ⏸ `AtmosphericConditions.windSpeed`, `windDirection` — values
  exposed via `frameState.atmosphericConditions.weather.windSpeed/
  windDirection`. No current shader consumer; pre-emptively
  available for Phase 5 (volumetric fog advection) and the sibling
  water-rendering design (wave displacement modulation). No JS or
  WGSL change in this batch because there's no consumer to wire to.
- All consumers gated implicitly by their typeof checks (`typeof
  weather.humidity === "number"`) so unset `AtmosphericConditions`
  values fall through to pre-Phase-4 defaults.
- Tests: parameter sweep visual checks deferred to Phase 5+
  Sandcastle integration testing.

**Remaining work — ✅ DONE (Batch 29, 2026-05-13).** The plumbing
described below shipped with Phase 4 itself (see the ✅ items above):
`humidity`/`airQuality`/`windSpeed`/`windDirection` are now forwarded
from `frameState.atmosphericConditions` to the LUT compute + runtime
ray-march + fog density paths. The only intentionally-unconsumed
leaves are `windSpeed`/`windDirection`, held for Phase 5/6 (volumetric
fog advection) and the water-rendering sibling design. Historical
to-do list preserved below for traceability:

- ~~`AtmosphereLUT.wgsl` compute shader — multiply rayleigh coefficient
  by `airQuality` and mie coefficient by `humidity * 0.5 + 1.0`
  before the precomputed integration.~~ Done — `airQuality`→rayleigh,
  `humidity`→mie scaling in the LUT dispatch.
- ~~`SkyAtmosphere.wgsl` runtime ray-march fallback — same multipliers
  on the analytic Rayleigh/Mie terms so LUT and fallback agree.~~ Done
  in the inline `computeScattering` uniform pack.
- ~~`Fog.js` density modulation — `density *= (1.0 + humidity × 0.5)`
  so humid air produces denser distance fog.~~ Done — shipped as
  `density *= 1.0 + (humidity - 0.5)` in `Fog.js::update`.
- ~~Wind: exposes `vec2` uniforms on `SkyAtmosphere.wgsl` (consumed by
  future Phase 5/6 work for cloud advection + volumetric fog motion)
  and `frameState.atmosphericConditions.weather.wind*` for the
  water-rendering sibling design.~~ Wind values are exposed on
  `frameState.atmosphericConditions.weather.wind*`; no shader consumer
  yet (pre-emptive for Phase 5/6).

**Phases 1-4 land as one feature branch** per **B23**. Phase 5
follows as a separate feature branch.

---

**Phase 5 — Participating media + scattering occlusion (3-4 sessions):**

The heaviest rendering work in the project. Implements the unified
volumetric fog + varying atmosphere density + scattering occlusion
system (§4.8-4.10).

- **5a — Froxel grid infrastructure (1 session):** Allocate the
  3D textures (two rgba16float at configurable resolution), wire
  screen-UV + log-depth parameterization, add `enableVolumetricFog`
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
- **5f — Temporal reprojection / blue-noise jitter polish (per B11,
  optional):** If low-resolution froxel grids shimmer during camera
  motion, add temporal blue-noise jitter to density sampling. Full
  TAA-style history-buffer reprojection is a future enhancement.
  **Renamed from 5e** because cloud shadows are now folded into Phase 6c.

Tests: visual regression against baseline screenshots, GPU timing
sanity checks against the cost estimates above, toggle-independence
tests for each sub-phase flag.

---

**Phase 6 — Volumetric clouds (PROMOTED per B15, 2-3 sessions):**

Originally deferred in v2; promoted in v3 because the Phase 5 froxel
infrastructure makes Phase 6 a strict additive layer rather than a
parallel system. **Ships immediately after 5a-5d** (or after 5d if
5f is skipped). Default off. See §4.6 for full design.

- **6a — Volumetric raymarch shader (1 session):** WGSL raymarch over
  the existing `WebGPUProceduralCloudRenderer` noise field. Samples
  altitude band, evaluates HG phase function, integrates scattered
  light per froxel. Composite into the existing froxel grid as a
  cloud-density contribution. Single shader variant, gated behind
  `enableVolumetric = false` default.
- **6b — Crossfade with procedural (0.5 session):** Altitude-based
  blend between volumetric raymarch (≤50 km altitude) and procedural
  2D output (≥100 km altitude). Hysteresis on the thresholds to
  prevent flicker at the transition altitude.
- **6c — Cloud shadow contribution (0.5 session — was Phase 5e):**
  The volumetric cloud density field casts shadows into the fog grid
  via the same per-froxel light raymarch wired up by Phase 5c.
  Multiplies cloud extinction into the scattering occlusion term.
  Falls back to `extinction = 0` when volumetric clouds are off.
- **6d — Quality dial (0.5 session):** "low" / "medium" / "high" /
  "auto" sample counts. "auto" wired into the
  VisualPerformanceTargetService (§11) so the engine adapts the
  sample count if frame budget is exceeded.

**Why Phase 6 is no longer deferred:**

1. The Phase 5a froxel grid IS the foundation Phase 6 builds on
2. Volumetric clouds are visually the single biggest "wow" feature
3. 5e (cloud shadows in fog) was previously blocked on Phase 6 —
   promoting Phase 6 unblocks 5e at the same time (now bundled as 6c)
4. Sharing the noise field with `WebGPUProceduralCloudRenderer`
   reduces the Phase 6 effort from 3-4 sessions to 2-3 sessions

Mobile users opt out by default; desktop power users get the full
experience. "Auto" mode adapts dynamically.

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
4. **`scene.light` synchronization breaking existing apps.** ~~Some
   apps manually configure `scene.light.direction`. The
   `enableSunLight` toggle defaulting to `true` could break them.~~
   **RESOLVED on 2026-04-08 (B12):** the existing `SunLight` API
   doesn't expose a `direction` field — the sun's direction is
   computed by the engine from `frameState.uniformState.sunDirectionWC`,
   which is always tracked from simulation time and not user-controllable.
   **There are no apps that could be manually configuring sun direction
   today**, so defaulting `enableSunLight = true` for the first release
   is safe. Risk closed.
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

### Open questions — RESOLVED on 2026-04-08

All eleven open questions from v2 have been answered. The canonical
answers live in `SESSION_2026-04-08_RESEARCH_REPORT.md §8.2`. Quick
pointer table:

| OQ | Resolution | Reference |
|---|---|---|
| OQ1 — Earthshine on the dark side of the moon | **Yes**, gated by `enableMoonPhase`, constant blue tint, no full earth-radiosity model. See §4.2. | B1 / B13 |
| OQ2 — `MoonLight` as `DirectionalLight` subclass or own type | **Marker class mirroring `SunLight`** — NOT a `DirectionalLight` subclass. Engine writes its direction internally each frame from ephemeris. Apps wanting manual moon direction use a regular `DirectionalLight`. See §4.2. | B2 / B14 |
| OQ3 — Wavelength dependence (`lightTint` per light) | **Yes**, `tint: vec3` per light, constant at construction time, not a per-frame uniform. Stored in `SunLight` and `MoonLight`. | B3 |
| OQ4 — Star modulation curve location | **Smoothstep** with inflection + steepness as tunables, lives in `AtmosphericConditions.starModulationCurve` (independently controllable). See §4.5. | B4 |
| OQ5 — `skyAtmosphere.show = false` + dual-light enabled | **No-op + document the dependency** in JSDoc. | B5 |
| OQ6 — Per-renderer cost of toggle reads | **Profile sanity check after Phase 1** lands. Not a blocking decision. | B6 |
| OQ7 — Default froxel resolution | **Auto-select via init benchmark** (see VisualPerformanceTargetService in §11), fall back to "low" if probe is inconclusive. | B7 / B17 |
| OQ8 — Varying atmosphere density default | **Off by default.** 3D noise sample adds non-trivial cost. | B8 / B19 |
| OQ9 — Scattering occlusion without volumetric fog | **Silently no-op** when fog is off. Document the dependency in JSDoc. NO log warning. | B9 |
| OQ10 — Fog interaction with 3D Tiles opacity | **Post-composite for v1**, per-fragment in follow-up if visible artifacts. | B10 |
| OQ11 — Temporal reprojection — Phase 5b or defer? | **Defer to Phase 5f polish step** after 5a-5d land. Blue-noise jitter alone may be enough. | B11 |

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

Updated for v3 — adds Phase 0 prep PR, promotes Phase 6 from deferred,
folds 5e into 6c, renames 5e slot to 5f for the optional temporal
reprojection polish.

| Phase | Sessions | Risk | Branch |
|---|---|---|---|
| **0 — Toggle audit prep PR** | 1-2 | Low | Standalone (shared with water doc) |
| 1 — Toggle scaffolding | 1 | Low | Branch A (1-4) |
| 2 — Sun + Moon sync + phases | 1-2 | Low-Medium | Branch A |
| 3 — Atmosphere multi-light + LUT | 2-3 | Medium-High | Branch A |
| 4 — Atmospheric conditions | 1 | Low | Branch A |
| 5a — Froxel grid infrastructure | 1 | Low | Branch B (5) |
| 5b — Density injection + height fog | 1 | Medium | Branch B |
| 5c — Scattering occlusion + ambient | 1 | Medium-High | Branch B |
| 5d — Varying atmosphere density | 0.5 | Low | Branch B |
| 5f — Temporal reprojection polish (B11, optional) | 0.5 | Low | Branch B |
| **6a — Volumetric raymarch shader (PROMOTED)** | 1 | Medium | Branch C (6) |
| **6b — Crossfade with procedural** | 0.5 | Low | Branch C |
| **6c — Cloud shadow contribution (was 5e)** | 0.5 | Medium | Branch C |
| **6d — Quality dial (auto via §11)** | 0.5 | Low | Branch C |

**Total v3:** **9.5-12.5 focused sessions** + 1-2 prep PR sessions.

Risk distribution:

- **Phase 3 (atmosphere multi-light + LUT activation)** — high-value
  visual payoff, deserves extra care
- **Phase 5c (scattering occlusion)** — the "wow" moment of the whole
  project; god rays, crepuscular beams, terrain shadow shafts
- **Phase 6a (volumetric raymarch)** — promoted from deferred per
  B15, but mitigated because it builds on Phase 5a's froxel grid AND
  shares the noise field with `WebGPUProceduralCloudRenderer`

Phases 0, 1, 2, 4, 5a, 5b, 5d, 5f, 6b, 6c, 6d are largely mechanical
wiring against infrastructure that either already exists or is being
delivered in an earlier phase.

Phase 5c remains the project's natural early-stop milestone if the
budget shrinks: the result is a visually dramatic upgrade even
without 5d (subtle), 5f (polish), or Phase 6 (volumetric clouds).
Stopping after 5c still ships god rays and crepuscular rays.

---

## 10. Decision points — RESOLVED on 2026-04-08

All twelve decision points from v2 have been answered. The canonical
answers live in `SESSION_2026-04-08_RESEARCH_REPORT.md §8.2`. Quick
pointer table:

| DP | Resolution | Reference |
|---|---|---|
| DP1 — Default for `enableSunLight` | **`true`** (auto-sync). The breaking-app concern from v2 risk #4 is moot — `SunLight` doesn't expose `direction`, so there are no apps that could be manually configuring it. See §4.1. | B12 |
| DP2 — Earthshine on/off | **On**, gated by `enableMoonPhase`, constant blue tint. See §4.2. | B1 / B13 |
| DP3 — `MoonLight` subclass or standalone | **Marker class mirroring `SunLight`** (NOT a `DirectionalLight` subclass). See §4.2. | B2 / B14 |
| DP4 — Phase 6 (volumetric clouds) timing | **Promoted from "deferred" to "ships immediately after 5a-5d"**, default off, cutover at 50-100 km altitude. Volumetric path reads from existing `WebGPUProceduralCloudRenderer` noise field. Effort drops from 3-4 sessions to 2-3 sessions. See §4.6 and §6 Phase 6. | B15 |
| DP5 — Naming style | **Stay flat** (`enableMoonLight`), but organized under nested config groups (`scene.globe.atmosphericConditions.lighting.enableMoonLight`). | B16 |
| DP6 — Default froxel resolution | **Auto-select via init benchmark** (VisualPerformanceTargetService init probe per §11), fall back to "low" if probe inconclusive. | B7 / B17 |
| DP7 — Default for `enableVolumetricFog` | **Off by default.** Documented prominently in release notes. | B18 |
| DP8 — Default for `enableVaryingAtmosphereDensity` | **Off by default.** | B8 / B19 |
| DP9 — Default for `enableScatteringOcclusion` | **Off by default, independently toggleable** (NOT auto-enabled when fog is on, contrary to v2 vote). Silent no-op when fog is off. See §4.10. | B9 / B20 |
| DP10 — Varying atmosphere density without froxel grid | **Skip** — per-pixel sky atmosphere ray-march fallback is intentionally NOT implemented. Document the limitation. | B21 |
| DP11 — Fog composite placement | **After opaque + OIT-resolved, before UI overlay.** Transparent 3D Tiles get post-composite (approximate) in v1; per-fragment correct path in follow-up if visible artifacts. | B10 / B22 |
| DP12 — Phase 5 blocking | **Land 1-4 first, then 5 as separate feature branch.** Both review cycles shorter than one giant PR. Phase 6 ships immediately after 5a-5d. See §6. | B23 |

---

## 11. VisualPerformanceTargetService

Per **B7 / B17 locked decisions**, the original "auto-select froxel
resolution" toggle expanded into a new dedicated service that watches
frame time and dynamically degrades/upgrades quality features to
hit a target FPS. This service is **opt-in, off by default**, and
shipped in **Sprint 4** (after Phase 5 lands and there are enough
quality knobs to make adaptive control valuable).

### Concept

```js
// Off by default — users opt in
scene.adaptiveQuality.enable({
  targetFPS: 30,                            // or 60, 120, custom
  // optional: feature priority list — first to degrade when budget is blown
  degradePriority: [
    "ssr",                                   // future: screen-space reflections
    "taa",                                   // future: temporal anti-aliasing
    "volumetricCloudQuality",                // §4.6
    "shadowMapResolution",                   // future: shadow cascade size
    "froxelResolution",                      // §4.8
    "atmosphereLutResolution",
  ],
});
```

### How it interacts with other Cesium systems

The service must NOT misinterpret idle frames as "we're below target,
degrade quality." It explicitly accounts for:

1. **`scene.requestRenderMode = true`** — when explicit-render-mode is
   active and `Scene._renderRequested === false`, the scene is
   intentionally idle (no draw work this frame). The service skips
   sampling on these frames.
2. **Snapshot rendering mode** (NEW-3 in SESSION report §10) — when
   the snapshot is locked, GPU work is replaying a recorded command
   buffer at near-zero CPU cost. Frame time will be artificially low.
   The service skips sampling when `Scene._snapshotLocked === true`,
   and ignores the one-frame spike when the snapshot is briefly
   unlocked for invalidation/animation.

### Hysteresis

Critical for preventing flicker (features visibly toggling on/off
mid-render):

- **Degrade fast:** after **3 consecutive over-budget frames**, drop
  the highest-priority feature one quality level
- **Upgrade slow:** after **60 consecutive under-budget frames** with
  significant headroom, restore the lowest-priority degraded feature
  one quality level
- **Cooldown:** after any change, require N frames before another
  change can fire (prevents oscillation around the budget)

### Quality dial integration

Every feature with a `quality: "auto"` setting feeds into this
service. Initial features (after Phase 5 + 6 ship):

- `volumetricFog.quality` — froxel grid resolution (low / medium / high)
- `clouds.volumetricQuality` — cloud raymarch sample count
- `atmosphereLut.quality` — LUT resolution

Future features that will plug in as they ship:

- TAA sample count
- SSR step count
- Shadow map cascade size
- Bloom downsample chain depth
- Indirect light probe count

### Effort and slot

- **Slot:** Sprint 4 (after Phase 5 of this design lands and after
  the Tier-A visual quality features in
  `SESSION_2026-04-08_RESEARCH_REPORT.md §7 Sprint 2` ship)
- **Effort:** ~2-3 weeks
- **Backlog ID:** NEW-2 in
  `SESSION_2026-04-08_RESEARCH_REPORT.md §10`
- **Default:** Off — `scene.adaptiveQuality.enabled === false`

### Why it's not in this design's Phase 1

The service has more knobs to turn AFTER the visual quality features
land. Building the framework before there are features for it to
adapt would mean shipping an empty service for a year. The right
order is:

1. Ship the celestial design's Phases 1-5 + Phase 6 (this doc)
2. Ship the cross-cutting Sprint 1 + Sprint 2 visual quality
   activations (`SESSION_2026-04-08_RESEARCH_REPORT.md §7`)
3. THEN ship VisualPerformanceTargetService that adapts all of them

---

## 12. Phase 0 — Toggle Audit Prep PR

Per the toggle audit findings in
`SESSION_2026-04-08_RESEARCH_REPORT.md §9.5`, the current Cesium
toggle landscape is scattered across at least 5 owners with
overlapping/duplicated state. The worst offender is the
`Scene.atmosphere.*` ↔ `Globe.atmosphere*` duplication — same values
in two homes with no enforcement that they match.

This design would make that worse if it added 14+ new toggles
without first establishing a canonical home. **Phase 0 fixes the
foundation before Phase 1 begins.**

### Goals

1. Introduce `scene.globe.atmosphericConditions` as the canonical
   nested home for ALL atmospheric / lighting / fog / cloud / star
   state (see §3 for the full structure).
2. Convert every existing scattered property into a delegating
   getter/setter that reads/writes through to the canonical home.
3. **Zero behavior change** for existing apps. Pure refactor.
4. Lands BEFORE this design's Phase 1. Also serves as the foundation
   for the water rendering design's Phase 1 (see
   `WATER_RENDERING_DESIGN.md §6 Phase 0`).

### Scope

**Properties migrated to delegating shells:**

- `Scene.atmosphere.*` (10 properties) →
  `scene.globe.atmosphericConditions.skyAtmosphere.*`
- `Scene.fog.*` (9 properties) →
  `scene.globe.atmosphericConditions.fog.*`
- `Globe.enableLighting`, `Globe.dynamicAtmosphereLighting`,
  `Globe.dynamicAtmosphereLightingFromSun`,
  `Globe.showGroundAtmosphere`, `Globe.enableNightLights`,
  `Globe.showProceduralClouds` → respective canonical homes
- `Globe.atmosphereLightIntensity`, `Globe.atmosphereRayleighCoefficient`,
  `Globe.atmosphereMieCoefficient`, `Globe.atmosphereRayleighScaleHeight`,
  `Globe.atmosphereMieScaleHeight`, `Globe.atmosphereMieAnisotropy`,
  `Globe.atmosphereHueShift`, `Globe.atmosphereSaturationShift`,
  `Globe.atmosphereBrightnessShift` →
  `scene.globe.atmosphericConditions.skyAtmosphere.*`
  (these are the **duplicate** `Scene.atmosphere.*` values currently
  living in two places — Phase 0 fixes the duplication)
- `Scene.skyAtmosphere`, `Scene.skyBox`, `Scene.sun`, `Scene.moon`
  remain as existence-based on/off (set to undefined to disable),
  but their member properties also gain delegating shells where
  applicable

**Test coverage:**

- Assertion test for every legacy property: setting it via the legacy
  path produces the same observable value as setting it via the
  canonical path
- Behavior regression test: a Scene constructed with no toggles
  changed produces a `frameState` byte-for-byte identical to the
  pre-prep-PR baseline (where comparable)
- Existing Sandcastle examples that use legacy paths
  (e.g. `viewer.scene.fog.density = 0.001`) continue to render
  identically

### Effort and slot

- **Slot:** Pre-Phase-1 of both this design AND the water rendering
  design. Ship as a standalone PR before any feature work.
- **Effort:** 1-2 sessions
- **Backlog ID:** NEW-1 in
  `SESSION_2026-04-08_RESEARCH_REPORT.md §10`
- **Risk:** Low — pure refactor, no behavior change

### Why it's a separate PR

1. **Smaller diffs.** This design's Phase 1 PR doesn't need to also
   include 200 lines of delegating getters/setters that aren't related
   to the celestial/atmospheric work.
2. **Independent value.** The prep PR fixes pre-existing technical
   debt (the `Scene.atmosphere` ↔ `Globe.atmosphere*` duplication)
   even if the celestial work is delayed.
3. **Foundation for water too.** The water rendering design's
   `scene.water.*` namespace is established by the same prep PR,
   so both designs benefit from one focused refactor instead of
   each duplicating the work.
4. **Easier upstream sync.** When upstream adds new properties to
   `Scene.atmosphere`, the canonical-home pattern is already in
   place — we just add the new property to the canonical home and a
   delegating shell. No conflict.

---

## 13. Cross-references

- [SESSION_2026-04-08_RESEARCH_REPORT.md §8.2](SESSION_2026-04-08_RESEARCH_REPORT.md#82--b-series-celestial-atmosphere-design-23-questions)
  — locked B1-B23 decisions referenced throughout this doc
- [SESSION_2026-04-08_RESEARCH_REPORT.md §9.5](SESSION_2026-04-08_RESEARCH_REPORT.md#95--toggle-audit-findings-current-state-of-sceneglobefogatmosphere-toggles)
  — toggle audit findings (the Phase 0 prep PR)
- [SESSION_2026-04-08_RESEARCH_REPORT.md §10](SESSION_2026-04-08_RESEARCH_REPORT.md#10-new-backlog-items-from-this-session)
  — new backlog items (NEW-1 toggle audit, NEW-2
  VisualPerformanceTargetService, NEW-3 snapshot mode, NEW-6 higher-res
  moon texture)
- [WATER_RENDERING_DESIGN.md](WATER_RENDERING_DESIGN.md) — sibling
  design that consumes the same `AtmosphericConditions` instance and
  shares the Phase 0 toggle audit prep PR
- [packages/engine/Source/Scene/Moon.js](../packages/engine/Source/Scene/Moon.js)
  — existing moon ephemeris implementation (B1 verification)
- [packages/engine/Source/Scene/SunLight.js](../packages/engine/Source/Scene/SunLight.js)
  — existing marker class pattern that `MoonLight` mirrors (B2 / B14)
- [packages/engine/Source/Core/Simon1994PlanetaryPositions.js](../packages/engine/Source/Core/Simon1994PlanetaryPositions.js)
  — sun + moon ephemeris source

---

*End of design draft v3. All 23 B-series decisions are locked — see
§7 (open questions resolved) and §10 (decision points resolved) for
the resolution tables. Phase 0 (toggle audit prep PR — §12) is the
next implementation step, shared with the water rendering design.
Phases 1-4 land as one feature branch, Phase 5 as a separate feature
branch, Phase 6 (volumetric clouds, **promoted from deferred**) ships
immediately after 5a-5d. The VisualPerformanceTargetService (§11)
is a new feature emerging from B7, scheduled for Sprint 4 after the
visual quality features land.*

---

## 14. Orbit-rendering polish (added 2026-05-13)

Added after a user-reported audit comparing real orbital photography
(ISS imagery, Earthrise from the Moon) to our WebGPU render. The
following techniques are NOT yet in any phase plan but are concrete
improvements with cited industry references. They slot in alongside
the existing phase work without disrupting it.

### 14.1 Altitude-gated bloom (immediate, 1-2 hours)

**Problem:** real orbital photos show essentially no bloom on the
Earth disk. WebGPU's bloom pipeline defaults (`threshold: 0.8`,
`intensity: 0.5`) accumulate visible halo around the disk at GEO
altitudes because the atmosphere limb + ocean specular both peak
near 1.0 post-tonemap. Bloom is appropriate for ground-level scenes
(headlight glare, neon, etc.) but the same effect from orbit reads
as fake.

**Industry reference:** Frostbite GDC 2016 / Karis 2013 — bloom is a
camera lens effect; absent in vacuum-of-space cameras. AAA engines
typically gate bloom intensity by either lens-aperture state or a
"scene scale" parameter that corresponds to camera-to-subject distance.

**Implementation:**

- Read `cameraHeight` (already in `frameState.camera.positionCartographic.height`)
  in `WebGPUBloomEffect.ts` uniform packer.
- Apply altitude curve: `intensity *= smoothstep(EARTH_RADIUS,
  GROUND_FLOOR, cameraHeight)` where `GROUND_FLOOR = 10_000.0` m
  and `EARTH_RADIUS = 6_378_137.0` m. Bloom fades from 1.0 at sea
  level to 0.0 above 1 Earth radius altitude.
- Optional: per-stage gate (don't gate Bloom for low-altitude scenes
  with explicit `scene.bloomIntensityOverride`).

**Files:** `WebGPUBloomEffect.ts` uniform pack site.

**Effort:** 30-60 min. Default off until verified on Hello World +
3D Tiles Photogrammetry (where bloom IS appropriate at low altitude).

### 14.2 Ocean specular attenuation at orbit limb (immediate, 1-2 hours)

**Problem:** `GlobeTerrain.wgsl::computeEnhancedOcean` adds a
forward-scatter specular term `pow(VdotL, 4.0) × 0.15` that's
appropriate at ground level (sun glint on water) but at orbit
altitude the limb-grazing rays produce a too-bright sun-side glare
patch (visible in the Bathymetry probe at low altitude → orbit
transition).

**Industry reference:** Bruneton & Neyret 2008 ocean shading paper —
ocean specular intensity must scale with the BRDF-relevant grazing
angle. At orbit altitude the camera-to-water vector is near-vertical
to the surface normal (high NdotV), which reduces the visible
specular highlight per the Fresnel reflection coefficient. Our shader
ignores this attenuation.

**Implementation:**

- Compute `cameraDistanceToSurface` from `frameState.camera
  .positionCartographic.height`.
- Attenuate the `scatter` term in `computeEnhancedOcean()` by
  `1.0 - smoothstep(MIN_ATTENUATION_ALT, MAX_ATTENUATION_ALT,
  cameraHeight)` where `MIN_ATTENUATION_ALT = 100_000.0` m and
  `MAX_ATTENUATION_ALT = 1_000_000.0` m.
- Same idea for the Schlick-Fresnel water reflection if the magnitude
  proves to read too bright at orbit.

**Files:** `Shaders/WebGPU/Globe/GlobeTerrain.wgsl::computeEnhancedOcean`.

**Effort:** 30-60 min. Test on Hello World at varying altitudes;
should remove ~40-60% of the bright "sun glare patch" visible in the
lower-right of orbital views.

### 14.3 Dusk-terminator verification probe (immediate, 1 hour)

**Problem:** Hello World defaults to the current system clock, so the
visible disk may be predominantly lit on most days. There's no
canonical "verify night side dark" probe in the visual regression
sweep.

**Implementation:**

- New `Tools/visual-regression/probe-dusk-terminator.mjs` that:
  - Sets `viewer.clock.currentTime = JulianDate.fromIso8601(
    "2026-03-20T18:00:00Z")` (vernal equinox)
  - Positions camera at 12 Mm altitude over `(0°N, 90°E)` so the
    terminator crosses the viewport
  - Captures both WebGL + WebGPU; per-channel pixel diff on a
    sample point on the unlit hemisphere
  - Asserts the unlit-side ratio is `> 0.95` darker than the lit-side
- Save to `Tools/visual-regression/output/dusk-*.png` for repeated
  reference.

**Files:** New probe script under `Tools/visual-regression/`.

**Effort:** 30-60 min. Validates Batches 17/18 sun-direction work +
the `nightAmbient = 0.025` floor.

### 14.4 Phase 4 completion — ✅ DONE (Batch 29, 2026-05-13)

Per §6 above — wire `humidity`, `airQuality`, `windSpeed` /
`windDirection` consumers. Specified in §4.5. Shipped: `humidity` →
fog density + mie scaling, `airQuality` → rayleigh scaling in both
the LUT and runtime paths. `windSpeed`/`windDirection` are exposed on
`frameState` but have no shader consumer yet (held for Phase 5/6).

### 14.5 Phase 6 — Volumetric clouds (THE answer to "no clouds from orbit")

The original §4.6 design covers this. Highlighted here because it's
the direct answer to the user-reported "no clouds visible from
orbit" gap. Per-locked B15 decision, ships immediately after Phase
5a-5d. Hybrid raymarched (≤50 km) + procedural 2D (≥100 km) with
configurable crossover. **Default OFF** for performance; users opt
in via `scene.atmosphericConditions.clouds.enableVolumetric = true`.

**Cross-references for orbit views specifically:**

- The 2D procedural fallback above 100 km handles GEO views with a
  pre-computed cloud-density texture sampled with a parallax-aware
  projection — perceptually equivalent to the cloud-cover band
  visible in Apollo / ISS photography without paying the raymarch
  cost.
- Volumetric raymarch handles fly-through transitions when the
  camera descends from orbit through the cloud layer.
- Cloud shadows fold into Phase 6c (volumetric cloud density modulates
  the scattering occlusion term in the Phase 5c froxel grid).

**Estimated total effort:** 3-5 sessions (Phase 5a froxel grid 1
session + Phase 6 a/b/c/d 2-3 sessions).

### 14.6 Real-time satellite cloud imagery (out of design scope, user opt-in)

NOAA GOES / NASA MODIS real-time cloud composites are typically
integrated as a **custom `ImageryProvider`** (raster tile layer)
overlaid on the globe imagery layer stack. This isn't part of the
celestial/atmosphere design because it's a user-content concern, not
a renderer feature. Documented here as the canonical answer to
"can I overlay real-time clouds on the globe?":

- Build a `CloudImageryProvider` that fetches GOES / MODIS tiles
  from a public-facing service (NOAA / NASA Worldview).
- Add it as an extra `imagery.addImageryProvider()` layer with
  semi-transparent alpha.
- The existing 16-layer imagery composite handles the blend
  correctly.

No engine work needed. User-side code only.

### 14.7 Camera-aperture / exposure simulation (future / optional)

**Problem:** real-world cameras adjust aperture + ISO based on scene
brightness. Our render uses fixed exposure which means orbit views
of the bright Earth disk + dark space produce a wide dynamic range
that bloom papers over.

**Industry reference:** Reinhard et al. 2002 auto-exposure / Hejl &
Burgess-Dawson 2010 filmic tonemap. Most AAA engines pair tonemap
with auto-exposure based on log-luminance histogram.

**Implementation sketch:** `WebGPUAutoExposureCompute.ts` (existing
infrastructure for HDR scenes) could feed the bloom + tonemap
pipeline with a per-frame target luminance. Already present for HDR
path; activating it for the SDR orbit path would tighten the
dynamic range and reduce the perceived "bloom too strong" without
needing the altitude gate.

**Effort:** 1 session — verify `WebGPUAutoExposureCompute.ts` runs
in the orbit-view code path; gate by camera-altitude curve like §14.1.

### 14.8 IBL ambient for unlit hemisphere (future / optional)

**Problem:** the night side currently gets a flat `nightAmbient =
0.025` floor (2.5% white). Real night-side photos show a subtle
non-uniform ambient — earthshine reflected off the moon, urban light
pollution diffused by haze, faint atmospheric airglow.

**Industry reference:** Karis 2013 split-sum IBL. We already have
`WebGPUImageBasedLighting.ts` shipping diffuse irradiance via SH L2
for glTF model lighting. Extending the globe FS to consume the same
IBL irradiance probe would produce a physically-grounded ambient
floor that varies with viewing direction.

**Implementation sketch:**

- Add `globeAmbientIBL` uniform to globe surface bind group (3rd-band
  SH coefficients, same struct shape as Model PBR consumer).
- Sample the SH probe at `normalEC` for the unlit-hemisphere ambient
  instead of the flat `0.025` floor.
- Gate behind `atmosphericConditions.lighting.enableGroundIBLAmbient`
  (default off until visual review).

**Effort:** 1-2 sessions — straightforward extension of existing IBL
infrastructure.

---

*§14 added 2026-05-13. Items 14.1-14.3 are the user's "Immediate"
bucket. Item 14.4 is the user's "Medium" bucket and matches Phase 4
of §6. Items 14.5 is the user's "Large" bucket and matches Phase 6
of §6. Items 14.6-14.8 are out-of-scope or future-research grade.*
