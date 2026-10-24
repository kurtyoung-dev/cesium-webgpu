# Global Procedural Clouds — Deep-Dive Audit & Remediation Blueprint (2026-10-19)

> **Dated snapshot (indexed 2026-10-22, ruling `R-2026-10-22-7`).** Written by the Argon water worker on 2026-10-19. Its findings, measurements and causal claims are the author's and were not re-verified when it was landed; the cloud landing program re-derives them. It is not a status or plan authority.

**Scope:** Exhaustive technical audit of the Cesium WebGPU procedural cloud architecture across **both** the main landing repository (`f:/Dev/GH/cesium-webgpu` at `HEAD` `1ef3cb6400`, Batch 1586) and the active Astra / Sol 6.1 worktree (`F:/Dev/GH/cesium-astra-20260926`, branched from `541b821331` with 649 modified/untracked manifest files and 483 `_lane-out/` patches through `3444-same-fetch-weather-preview.patch`).

**Objective:** Give Astra and Sol 6.1 a concrete, line-verified engineering blueprint covering:

1. Why progress stalled across both trees and why visual quality and shader compile times are still failing.
2. Every mathematical, physical, and rendering defect in **Orbit**, **Flight**, and **Ground** on `main` (`1ef3cb6400`).
3. What `F:/Dev/GH/cesium-astra-20260926` (`187` → `3444`) actually fixed, what it hid behind `OFF`-by-default flags, what it over-engineered, and what is still broken.
4. Feature-by-feature inventory of broken, dead, stubbed, or unwired cloud subsystems.
5. Why initial shader compilation is slow (272 inlined `worleyF1` loops on `main`; 6,500+ lines of WGSL + 800-line regex splicing + `25s–59s` layered compiles on `cesium-astra-20260926`) vs. how the **Water overhaul** solved the exact same problem cleanly.
6. A step-by-step **5-Phase Execution Plan** for Astra & Sol 6.1 to get global clouds looking great in Orbit, Flight, and Ground while compiling in `< 1s` asynchronously and running `< 2 ms` per frame.

---

## 1. Executive Summary — Why Progress Stalled Across Both Trees

### 1.1 Why `main` (`f:/Dev/GH/cesium-webgpu` at `1ef3cb6400`) Still Has the Unrepaired Cloud Stack

1. **Doc-vs-Code Disconnect on the Orbital Shell**:
   - `migration_doc/ASTRA_CLOUD_TECH_AUDIT_AND_ROADMAP_2026-10-06.md:50-66` claims that a closed-form analytic orbital shell (`analyticCloudShell`) and a `renderDeck` wrapper (`30–80 km` smoothstep blend) were implemented in `ProceduralClouds.wgsl`.
   - **At `main` `HEAD` (`1ef3cb6400`), zero lines of `analyticCloudShell` or `renderDeck` exist in `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl:2379-3156`.** The shader still executes volumetric `marchDeck` from `0 m` to `20,000 km`.
2. **Two Monolithic Linear Stacks Failed Gate (`0` of `43` and `0` of `37` Units Landed)**:
   - **Sept 14 Stack (`migration_doc/ASTRA_WORK_AUDIT_2026-09-16.md:68-108`)**: Stacked 43 units linearly onto `U1 (CLOUD_PREVIEW)` inside `ProceduralClouds.wgsl` (`3,364` lines) and `WebGPUProceduralCloudRenderer.ts` (`5,657` lines). `U1` collided with 21 of 26 files in active seat lanes and bumped `sunIntensity` from `10.0` to `300.0`, inflating pre-Reinhard scene luminance by `~109x` (`L_max` `1.70 → 185.15`).
   - **Sept 25 Rebased Stack (`migration_doc/ASTRA_WORK_AUDIT_2026-09-25.md:88-213`)**: Expanded `CLOUD_UNIFORM_FLOATS` `176 → 260`, failed WGSL compilation (`U33` duplicate `interleavedGradientNoise`), had `U37` stripped (`R-2026-09-26-2`), had 4 units held (`U23/U26/U29/U30`), and **triggered a Windows WDDM GPU hang (`DXGI_ERROR_DEVICE_HUNG`) on orbital cell `E4`** (`c13-n69-e4-astra-ab-20260926`) by cranking ray-march step counts instead of fixing orbital limb sampling.

### 1.2 Why `F:/Dev/GH/cesium-astra-20260926` (`187` → `3444`) Is Still Stuck at `appearance FAIL`

Instead of landing the ruled 5-batch cut (`A1..A3` from `migration_doc/ASTRA_LANDING_PLAN_2026-09-26.md`), Astra/Sol 6.1 continued accumulating **hundreds of sequential checkpoints (`187` → `3444`)** in a single un-rebased worktree (`541b821331`), growing it to **649 manifest files**, **~85 `WebGPUCloud*.ts` files**, **~75 WGSL files (`>6,500` lines)**, **424 uniform floats**, **31 `@group(0)` bindings**, and **14 competing producer/cache subsystems**.

Per Astra's own latest handoff (`F:/Dev/GH/cesium-astra-20260926/_lane-out/3444-HANDOFF.md:7`) and master plan (`F:/Dev/GH/cesium-astra-20260926/migration_doc/CLOUD_MASTER_IMPLEMENTATION_PLAN.md:29, 61`):

- **Strict checklist closure is `23 / 156` (`14.7%`)** — and `21` of those `23` are inside `P15` startup mechanics (`21/43`), with only **`2` items closed across all other 32 cloud feature families**.
- **Self-reported maturity is `~65%` technology / `~30%` finished visual experience**.
- **Every single visual check through `3444` is still `appearance FAIL`** (*"Startup imagery is coarse/flat and detailed orbit is grainy: appearance FAIL"*).
- **Full layered/seasonal shaders still take `25s–59s` to compile and time out past `60s`** (`CLOUD_MASTER_IMPLEMENTATION_PLAN.md:11-15, 35-51`).

Three self-inflicted traps in `F:/Dev/GH/cesium-astra-20260926` caused this:

1. **Trap 1 — The Best Physics & Sampling Fixes Were Gated Behind `=== true` Private Flags That Default to `OFF`**:
   - Astra wrote real shader fixes for planetary terminator/umbrae (`cloudPlanetaryLighting`), RTE light marching & self-shadowed directional silver lining (`cloudPhysicalSelfShadow`, `cloudDirectionalSilverLining`), quadratic near-camera step distribution (`cloudAdaptiveSampling`), fine-step start (`cloudFineSampling`), and transmittance-weighted temporal reprojection (`CLOUD_MARCH_EMIT_RECONSTRUCTION`)—**and left all of them `OFF` by default** in `WebGPUProceduralCloudRenderer.ts` and `WebGPUCloudAppearanceUniforms.ts` so old byte-identity fixtures wouldn't change!
2. **Trap 2 — 14 Competing Cache Subsystems + an 800-Line Regex WGSL Splicer + 5-Stage Popping Startup**:
   - When inlining 14 experimental cache/proxy subsystems pushed Windows DXC HLSL compile times to `67.5s–91.4s` (and `398s–551s` in combined modes, `CLOUD_DEVELOPMENT_ROADMAP_2026-10-08.md:77, 229`), Astra built an **800-line runtime substring/regex WGSL splicer** (`WebGPUCloudProgramBranches.ts:1-802`) and a **5-stage startup state machine** (`"bootstrap" → "volume" → "cached-preview" → "windless detailed" → "wind detailed"`) that pops visually and resets temporal history (`cache.temporalFirstFrame = true`) at every transition.
3. **Trap 3 — Core Coordinate & Bit-Packing Bugs Were Never Fixed**:
   - All morphology functions (`ProceduralCloudMorphology.wgsl:88-484`) and un-flowed wind (`WebGPUCloudDensityDomain.ts:81-83, 150-152`) still assume **ECEF `Y` is vertical altitude and `XZ` is horizontal**.
   - Boolean feature flags are packed into IEEE-754 `float32` uniform slots up to **bit 29 (`536,870,912`)**, overflowing the 24-bit `f32` mantissa (`16,777,216`) and silently corrupting low bits (`bit 0` curl, `bit 1` mammatus, `bit 2` adaptive steps).

---

## 2. Regime-by-Regime Root-Cause Analysis (Orbit, Flight, Ground)

### 2.1 Orbit Regime (`> 80 km` to `20,000 km`)

#### Defect O1 — Volumetric Ray-Marching Thin Shells on Grazing Limb Chords (`C13-29` / `C13-N60`)

- **On `main` (`ProceduralClouds.wgsl:2439-2492, 3014-3115`)**:
  - From orbit (`300–2,000 km`), a grazing limb ray enters `tOuter` (`+4,000 m`) and skims toward `tInner` (`+1,500 m`) over a chord length $L = t_{\text{End}} - t_{\text{Start}}$ of **350–450 km**.
  - Above `100 km`, `resolveTier` (`WebGPUCloudTierPresets.ts:285-287`) drops `"auto"` to Tier 1 (`maxSteps = 24`, or `48` with `horizonStepScale = 2.0`). Dividing a `450 km` chord into `24–48` steps gives `fineStep = 9.4–18.75 km` and `curCoarseStep = 37.5–75 km` across a shell that is only **2.5 km thick** radially.
  - With per-pixel IGN phase jitter (`sampleDistance = t + marchSamplePhase * curStep` at `ProceduralClouds.wgsl:2565`), adjacent pixels randomly hit or step completely over the cloud slab, creating salt-and-pepper stippling, `2x2` upscale clumps, and concentric Nyquist moiré rings.
- **In `cesium-astra-20260926` (`ProceduralCloudMarch.wgsl:212-239, 310-327`)**:
  - `cloudViewShellInterval` (`CloudLightingCache.wgsl:6-32`) stops clamping `tEnd` at `tInner.x` (so grazing limb rays can reach the far-side shell crossing `[tInner.y, tOuter.y]` over an `800 km` chord), while `fineStep` is clamped to `2,000 m` and `maxIter = steps * 3 = 72` (in Tier 1, `steps = 24`).
  - **Why it still fails in `cesium-astra-20260926`**: With `cloudShellSkipping` (`WebGPUProceduralCloudRenderer.ts:4819`) and `cloudAdaptiveSampling` (`WebGPUCloudAppearanceUniforms.ts:123`) **OFF by default**, 72 loop iterations at `2,000–8,000 m` per step can only march `144–288 km` before hitting `guard > maxIter` (`ProceduralCloudMarch.wgsl:314`) and terminating mid-chord inside the empty sub-cloud gap `[tInner.x, tInner.y]`!

#### Defect O2 — Wrong 3D Mipmap Metric (`curFineStep` Radial Step vs. Lateral Pixel Cone Footprint)

- **On `main` (`ProceduralClouds.wgsl:613-672, 2632`)**:
  - `cloudDensityMipLevels(footprintMeters)` is called with `curFineStep` (the **radial** step along the ray) instead of the **lateral pixel cone footprint** $2 d |\text{projScale}| / H$:
    - **At Orbital Nadir (`500 km` straight down)**: The radial chord through `[1500, 4000]` is only `2,500 m`. With `24` steps, `curFineStep = 104 m`. Because a shape voxel is `7,407 m / 128 = 57.87 m`, `log2(104 / 57.87) - 0.85 = 0.0`—so **orbital nadir samples Mip 0.0** even though 1 pixel subtends **~1,070 m laterally** (~18.5 voxels/pixel), causing severe sub-pixel aliasing sparkle.
    - **At Orbital Limb (`curFineStep = 5–18 km`)**: `cloudNoiseMipLevel` pushes `cloudShapeTex` to **Mip 5–6**, where hardware box-filtering collapses the noise variance to its constant mean (`~0.4307`). Applying `smoothstep(coverageThreshold, 1.0, base)` (`ProceduralClouds.wgsl:1493`) *after* mip averaging turns limb clouds into either a **flat uniform sheet** (`coverageThreshold < 0.43`) or **nothing** (`coverageThreshold > 0.43`).
- **In `cesium-astra-20260926` (`CloudDensityIntegration.wgsl:17-19`, `ProceduralCloudMarch.wgsl:467-469`)**:
  - **FIXED (Live by Default)**: `cloudViewPixelFootprint` computes `2.0 * max(distance, 0.0) * abs(projectionScale) / max(resolution, 1.0)`.
  - **What still needs porting/tuning**: At high mip levels (`mip >= 3.5` in orbit), `smoothstep(coverageThreshold, 1.0, base)` still needs variance-preserving contrast restoration around the mip mean (`0.4307`) so synoptic cloud edges don't flatten at high altitude.

#### Defect O3 — Inverted Zenith Cosine in Physical Aerial LUT (`QF_AERIAL_LUT`) from Orbit

- **On `main` (`ProceduralClouds.wgsl:2182-2239, 2877-2919`, `WebGPUCloudTierPresets.ts:871-875`)**:
  - `shouldDefaultPhysicalAerial` auto-enables `QF_AERIAL_LUT` (`bit 4`) when `altitude > 100,000 m`.
  - In `marchDeck` (`ProceduralClouds.wgsl:2881, 2898-2899`), `midCosZenith = dot(rayDir, midUp)` uses the **downward** `rayDir` from orbit (`midCosZenith ≈ -1.0` at nadir). Passing `-1.0` into `cloudSampleTransmittance(midAltitude, midCosZenith)` (`:2234-2239`) and `cloudSampleSkyViewLut(midUp, rayDir, sunDir)` (`:2191-2206`) integrates extinction **downward into the ground** (`u = 0.0`, `vCoord < 0.5`) instead of upward from the cloud top to space (`-rayDir`, where `cosZenith = +1.0` and upper-atmosphere transmittance above `3 km` is `~0.95`).
- **In `cesium-astra-20260926` (`CloudLightSampling.wgsl:469-538`, `ProceduralCloudMarchOutput.wgsl:38-52`)**:
  - **FIXED (Live Above 100 km)**: Replaced `skyViewLut` with `cloudFiniteAirTransport`, which clips the ray segment to `[0, hitDistance]` inside the `111 km` atmosphere shell and integrates `1..8` quadrature steps of Rayleigh/Mie/Ozone extinction and in-scattering between the eye and the cloud hit.
  - **Remaining bug in `ProceduralCloudMarchOutput.wgsl:13-24`**: When `QF_AERIAL_LUT` is off (`< 100 km` in `"auto"`), heuristic aerial perspective still uses the unweighted geometric midpoint `midDist = tStart + 0.5 * (tEnd - tStart)` instead of `weightedAerialDistance / alpha`.

#### Defect O4 — Missing Planetary Terminator / Night-Side Shadow & Camera-Locked Sun Color

- **On `main` (`ProceduralClouds.wgsl:2720, 2816`, `WebGPUProceduralCloudRenderer.ts:3804-3820`)**:
  - `cloud.sunLightColor` and `cloud.aerialColor` are computed on the CPU from `dot(sunDir, normalize(camPos))` (the sun angle at the **camera**, not at the cloud sample `samplePos`), and `marchDeck` never checks `dot(localUp, sunDir)` or Earth occlusion. From orbit, **night-side clouds glow at full midday sun brightness**, and moving the camera across the terminator tints the entire planet's clouds in unison.
- **In `cesium-astra-20260926` (`CloudSolarVisibility.wgsl:1-38`, `CloudLightSampling.wgsl:740-761`, `WebGPUProceduralCloudRenderer.ts:4408`)**:
  - **IMPLEMENTED BUT GATED OFF BY DEFAULT**: `cloudSunVisibility`, `cloudSolarDiskVisibility`, `cloudSunIllumination`, and `cloudDaylight` solve this cleanly on the WGS84 ellipsoid—**but `WebGPUProceduralCloudRenderer.ts:4408` gates them behind `config.cloudPlanetaryLighting === true` (default `false`)**, so default renders still have glowing night-side clouds!

---

### 2.2 Flight Regime (`deckBottom <= h <= deckTop` and Near-Deck Cruise)

#### Defect F1 — 111 km Horizontal Step Stretching & Mip 5.0 Soup Inside the Slab

- **On `main` (`ProceduralClouds.wgsl:2441-2445, 2491, 2632`)**:
  - Inside the cloud layer (e.g., `h = 2,500 m` in `[1500, 4000]`), a horizontal ray misses `tInner` and exits `tOuter` at $t_{\text{End}} \approx 111.5\text{ km}$. Dividing `111.5 km` uniformly by `24–48` steps produces `fineStep = 2,323–4,646 m` and `curCoarseStep = 9,292–18,583 m`.
  - Passing `curFineStep = 2,323 m` into `cloudDensityMipLevels` forces `cloudDetailTex` to **Mip 5.0 (the `1x1x1` constant average)** and `cloudShapeTex` to **Mip 4.48** even 1 meter in front of the nose!
- **In `cesium-astra-20260926` (`CloudDensityIntegration.wgsl:34-61`, `ProceduralCloudMarch.wgsl:212-226, 328-335`)**:
  - The mip blur is fixed by `cloudViewPixelFootprint`, and `cloudAdaptiveMarchStepBounds` + `cloudMarchBoundary` implement quadratic near-camera step concentration—**but `cloudAdaptiveSampling` is `OFF` by default (`WebGPUCloudAppearanceUniforms.ts:122-123`)**!
  - Furthermore, when `tStart == 0.0` (camera inside the cloud layer), the entry footprint expression `2.0 * tStart * abs(cloud.inverseProjection[1].y) / max(cloud.resolution.y, 1.0)` at `ProceduralCloudMarch.wgsl:214` evaluates to `0.0`, causing an abrupt transition when crossing `deckBottom` or `deckTop`.

#### Defect F2 — Coarse-Step Start Jumps Over Near-Cockpit Clouds

- **On `main` (`ProceduralClouds.wgsl:2503, 2561-2565, 2641-2655`)**:
  - `var fine: bool = false;` (`:2503`) even when `tStart == 0.0` (camera inside the cloud slab). Iteration 0 jumps `marchSamplePhase * curCoarseStep` (up to `9.3 km` ahead); if that distant point is in clear air between puffs, `t` advances `9.3 km` (`:2653`), tunneling straight through the cloud puff surrounding the aircraft.
- **In `cesium-astra-20260926` (`ProceduralCloudMarch.wgsl:240-241`, `WebGPUCloudAppearanceUniforms.ts:124-125`)**:
  - Added `let fineSampling = cloud.fineSampling > 0.5; var fine: bool = fineSampling;`—**but gated `cloudFineSampling` to `false` by default**! Even worse, when `tStart == 0.0` (inside the slab), `fine` should **always** start `true` for the near-camera segment regardless of option flags.

#### Defect F3 — 55 km Mid-Chord Temporal Reprojection Anchor Causes Severe Flight Ghosting

- **On `main` (`CloudTemporalResolve.wgsl:185-192, 210, 353-367`)**:
  - `representativeShellDistance` places the reprojection anchor at the geometric chord midpoint `0.5 * (tStart + tEnd) ≈ 55 km`. Clouds `300 m` from the cockpit move $180\times$ faster across the screen than a point at `55 km`, causing severe ghosting (`historyWeight = 0.85`).
- **In `cesium-astra-20260926` (`ProceduralCloudMarch.wgsl:844-848`, `ProceduralClouds.wgsl:209-224`, `CloudTemporalResolve.wgsl:527-536`)**:
  - `marchDeck` accumulates `weightedAerialDistance += sampleWeight * sampleDistance;` on every step—**but `ProceduralClouds.wgsl:211-214` discards it unless `#ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION` is enabled (`OFF` by default)**, so `CloudTemporalResolve.wgsl:527-536` still falls back to `cloudAnchorDistance` (the analytic midpoint)!

#### Defect F4 — Super-Exponential `marchStepGrowth` Bug (`NEW-GA-P0-157`)

- **On BOTH `main` (`ProceduralClouds.wgsl:2555-2558`) AND `cesium-astra-20260926` (`ProceduralCloudMarch.wgsl:321-323`)**:
  ```wgsl
  if (cloud.marchStepGrowth > 1.0) {
    curFineStep = fineStep * pow(cloud.marchStepGrowth, (t - tStart) / max(fineStep, 1.0));
  }
  ```
  Because `t` advances by `curFineStep` on each iteration, `t - tStart` already grows exponentially with step index $i$. Feeding `(t - tStart) / fineStep` into the exponent of `pow(marchStepGrowth, ...)` causes **super-exponential** step explosion ($g^{g^i}$). The exponent must be the integer step index `f32(stepIndex)` (or `interval`).

---

### 2.3 Ground Regime (`h < deckBottom`)

#### Defect G1 — Direction-Blind, Unshadowed `silverLining` Glows in Anti-Sun & Under Overcast

- **On `main` (`ProceduralClouds.wgsl:2717-2720`)**:
  ```wgsl
  let silverLining = cloud.silverLiningIntensity *
                     pow(clamp(1.0 - density * 3.0, 0.0, 1.0), 2.0);
  let scatteredLight = (msLight + silverLining) * cloud.sunIntensity;
  ```
  Neither `hgPhase(cosTheta, ...)` nor `exp(-lightOpticalDepth * absorb)` multiplies `silverLining`. Every thin cloud edge (`density -> 0`) injects `8.0` units of HDR radiance (`0.8 * 10.0`) isotropically in all directions—even looking `180°` away from the sun (`cosTheta = -1`) and under heavy storm decks (`lightOpticalDepth >> 1`), washing out underside contrast.
- **In `cesium-astra-20260926` (`CloudLightSampling.wgsl:601-618`, `WebGPUProceduralCloudRenderer.ts:4469-4470`)**:
  - **IMPLEMENTED BUT GATED OFF BY DEFAULT**: `cloudSilverLining` (`:611-618`) attenuates by `exp(-max(opticalDepth, 0.0) * effectiveAbsorption(profile))` and `cloudSilverLiningPhase` (`:601-609`) gates by forward HG ratio `ratio * sqrt(ratio)`—**but only when `config.cloudPhysicalSelfShadow === true` and `config.cloudDirectionalSilverLining === true` (`OFF` by default at `WebGPUProceduralCloudRenderer.ts:4469-4470`)**!

#### Defect G2 — Unattenuated High Ambient Floor & Unread `cloud.tierLighting`

- **On `main` (`ProceduralClouds.wgsl:2783-2795, 2816`)**:
  - `ambient` (`ambientIntensity = 1.5` × `skyAmb = (0.35, 0.34, 0.30)`) is never attenuated by `lightOpticalDepth` or vertical cloud depth, flattening dark storm bases.
- **In `cesium-astra-20260926` (`ProceduralCloudUniforms.wgsl:73`, `WebGPUProceduralCloudRenderer.ts:4275-4279`)**:
  - `cloud.tierLighting` (`powderStrength`, `isotropicFloor`, `ambientFloor`) is packed into uniform floats `172–174`, **but zero lines of WGSL ever read `cloud.tierLighting`**! `ProceduralCloudMarchLighting.wgsl:97` and `ProceduralCloudLighting.wgsl:199` still hardcode `0.5` for powder and ignore the tier floors.

---

## 3. Global & Subsystem Defects Across Both Trees

### 3.1 Hardcoded ECEF `Y`-Up in Wind Advection & All 5 Morphology Functions (BROKEN IN BOTH TREES)

In Cesium's ECEF coordinate system, $+Z$ points through the North Pole, $+X$ points to `(lat=0°, lon=0°)`, $+Y$ points to `(lat=0°, lon=90°E)`, and local vertical Up at `worldPos` is the geodetic surface normal `normalize(worldPos / (axes * axes))`.

Yet **both `main` and `F:/Dev/GH/cesium-astra-20260926`** hardcode **ECEF `Y` as vertical altitude and `XZ` as the horizontal plane**:

- **On `main` (`ProceduralClouds.wgsl`)**:
  - `cloudWindOffset` (`:1458-1461`): `vec3<f32>(cloud.windDirection.x, 0.0, cloud.windDirection.y) * (cloud.windSpeed * cloud.time)`
  - `genusFibreFactor` (`:871, 885`): `fibP = vec3<f32>(along / aspect, sp.y * 0.35, acr) * 3.0`
  - `mammatusFactor` (`:1027`): `lobeP = vec3<f32>(sp.x, sp.y * 0.25, sp.z) * ...`
  - `speciesFactor` (`:1065, 1088`): `fibP = vec3<f32>((along + hook) * 0.1, sp.y * 0.4, acr) * ...`
  - `featureFactor` (`:1127, 1140, 1198`): `streakP = vec3<f32>(acr * 4.0 * vScale, sp.y * 0.15, along * 0.5 * vScale)`
  - `specialShadeTint` (`:1249, 1257`): `sin((sp.x + sp.z) * 60.0 * scale + sp.y * 20.0)`
- **In `cesium-astra-20260926` (`ProceduralCloudMorphology.wgsl` & `WebGPUCloudDensityDomain.ts`)**:
  - `ProceduralCloudMorphology.wgsl:94-115` (`genusFibreFactor`), `:250` (`mammatusFactor`), `:286-315` (`speciesFactor`), `:354-429` (`featureFactor`), and `:484` (`specialShadeTint`) are **unchanged**—still projecting onto `sp.xz` and `sp.y`!
  - `WebGPUCloudDensityDomain.ts:81-83, 150-152` still computes default wind displacement as `windDx = windX * advectedDistance; windDz = windY * advectedDistance` in raw ECEF `(X, 0, Z)`.
- **How to Fix It**:
  - Construct the local East-North-Up (ENU) tangent frame from the local geodetic `up` vector:
    ```wgsl
    let east = normalize(select(vec3<f32>(-up.y, up.x, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(up.z) > 0.999));
    let north = cross(up, east);
    let localPos = vec3<f32>(dot(sp, east), dot(sp, up), dot(sp, north));
    ```
    Passing `localPos` into the morphology helpers makes `.xz` true local `(East, North)` and `.y` true local `Up` everywhere on the globe, and projecting wind onto `east * windDirection.x + north * windDirection.y` makes wind blow horizontally parallel to the cloud deck at every latitude and longitude.

### 3.2 IEEE-754 `float32` 24-Bit Flag Overflow in `cesium-astra-20260926` (`I02/I03`)

- **Where**: `F:/Dev/GH/cesium-astra-20260926/packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, `WebGPUCloudAppearanceUniforms.ts:98-118`, `ProceduralCloudWeatherSampling.wgsl:166-205`
- **The Bug**:
  - `packUniforms` packs boolean feature bits into `Float32Array` slots (`qualityFlags` at `u[87]` up to **bit 29 = `536,870,912`**, `extraFlags` at `u[150]` up to bit 22, `representationFlags` at `u[152]` up to bit 23, and `regionalFormations` up to 17 bit-shifted float terms).
  - Because an IEEE-754 `float32` has only a **24-bit significand (`16,777,216` max exact integer)**, any flag combination with bit $\ge 24$ set alongside low bits (`bit 0` curl noise, `bit 1` mammatus, `bit 2` adaptive steps) **silently rounds in `Float32Array` on the CPU**, flipping low bits ON or OFF before the GPU ever receives the buffer!
- **How to Fix It**:
  - Either store bitflags in `Uint32Array` views over the uniform ArrayBuffer (`bitcast<u32>(...)` or `u32` struct fields in `CloudUniforms`) or keep every float-encoded bitmask strictly `< (1 << 24)` (`bits 0..22` max per slot).

### 3.3 Duplicate Full-Screen Volumetric Ray-March for God-Rays (`fragmentCloudMaskMain`)

- **Where**:
  - `main`: `ProceduralClouds.wgsl:3160-3249`, `WebGPUProceduralCloudRenderer.ts:5205-5276`
  - `cesium-astra-20260926`: `ProceduralClouds.wgsl:250-267`, `WebGPUProceduralCloudRenderer.ts:6832-6866`
- **The Bug**:
  - In **both** trees, enabling cloud-aware god-rays runs `fragmentCloudMaskMain` as a separate full-screen render pass that re-executes the entire volumetric `marchDeck` from scratch just to write `clamp(1.0 - alpha, 0.0, 1.0)` into an `r8unorm` texture—nearly doubling cloud GPU cost!
- **How to Fix It**:
  - Derive the `r8unorm` transmittance mask directly from the already-rendered cloud alpha (`1.0 - cloudAlpha`) in a trivial 1-tap fullscreen blit (or write it as a second color attachment during upscaling/compositing), reducing the god-ray mask cost from `~3 ms` to `< 0.05 ms`.

### 3.4 Cloud Shadows (`WebGPUCloudShadowFrame.ts` & `GlobeTerrain.wgsl`)

- **Where**: `WebGPUCloudShadowFrame.ts:292`, `GlobeTerrain.wgsl:2396-2403` (`main`) / `GlobeTerrain.wgsl` (`cesium-astra-20260926`)
- **The Bugs**:
  1. `WebGPUCloudShadowFrame.ts:292` scales the shadow camera eye distance by `sunUpDot = Math.max(dot(sunDir, up), 0.08)`, pulling the orthographic near plane inside the cloud deck at sunrise/sunset.
  2. `GlobeTerrain.wgsl:2396-2403` only checks `uv.xy` in `[0, 1]` and never checks `shadowClip.z` or whether the terrain vertex is *below* `deckBottom`, projecting low-cloud shadows **upward onto `5,000 m` mountain peaks** above the clouds.
  3. Neither `ModelPBRComplete.wgsl` nor `OceanSurface.wgsl` samples the cloud shadow map.

### 3.5 Unwired Public Options & Teardown Leaks on `main`

1. **`volumetricEnableAltitude` / `volumetricDisableAltitude` Unwired (`WebGPUCloudTierPresets.ts:831-840`)**:
   - Reads `config.atmosphericConditions?.clouds?.volumetricEnableAltitude`, but `config` is `CloudCollection._resolveVolumetricConfig()`, which has no `.atmosphericConditions` wrapper—so custom altitude bands are ignored and hardcoded `50 km / 100 km` always win.
2. **Single-Deck `CloudType` Height Bounds Ignored (`WebGPUProceduralCloudRenderer.ts:3491-3492` on `main`)**:
   - Setting `cloudType = CloudType.CIRRUS` applies the cirrus profile shape and fibre parameters, but ignores `CloudDeck.bounds[profile.deck]` (`[5000, 13000]`), leaving cirrus clouds at `[1500, 4000]`.
3. **`"ultra"` Preset Falls Through to `"auto"` (`CloudVolumetrics.js:181`, `WebGPUCloudTierPresets.ts:279-289`)**:
   - In both `main` and `cesium-astra-20260926`, `"ultra"` is an unimplemented alias for `"auto"`, which drops to Tier 1 above `100 km`.
4. **3D Noise & Weather Texture VRAM Leak on `main` (`WebGPUProceduralCloudRenderer.ts:5495-5656`)**:
   - `destroyProceduralCloudResources` on `main` never calls `destroyCloudNoiseResources(cache.noise)` and never destroys `cache.weatherTexture`, `cache.weatherFallbackView`, or `cache.noiseFallbackTexture` (~17 MB leaked per teardown). (Fixed in `cesium-astra-20260926` at `WebGPUProceduralCloudRenderer.ts:7186-7206`.)

---

## 4. Why Shader Compile Is Slow — And How the Water Overhaul Solved It

### 4.1 Why `main` Stalls on Initial Compile

1. **272 Inlined 27-Iteration `worleyF1` Loops in One Module**:
   - On `main`, `ProceduralClouds.wgsl` (`3,364` lines) inlines `marchDeck` **8 times** (`4x` in `fragmentMain` + `4x` in `fragmentCloudMaskMain`).
   - Inside each `marchDeck`, all runtime branches (`legacyCloudDensity`, `lightMarch`, `lightMarchCone`, `genusFibreFactor`, `mammatusFactor`, `speciesFactor`, `featureFactor`, `curlNoise3`) are inlined simultaneously, generating **34 copies of the 27-cell `worleyF1` loop per `marchDeck` × 8 = 272 nested 27-iteration loops** in one shader module.
2. **3× Duplicate `device.createShaderModule` Calls & 14 Blocking `createRenderPipeline` / `createComputePipeline` Calls**:
   - `WebGPUProceduralCloudRenderer.ts` calls `device.createShaderModule(preprocess(PROCEDURAL_CLOUDS_SOURCE, 0, 0))` 3 separate times (`:2590, 2978, 3152`) and blocks the main thread on **10 synchronous `createRenderPipeline` calls** + **4 synchronous `createComputePipeline` calls** in `WebGPUCloudNoiseResources.ts`.

### 4.2 Why `cesium-astra-20260926` Still Takes `25s–59s` on Full/Layered Shaders

In `cesium-astra-20260926`, Dawn trace diagnostics (`3305`, `CLOUD_DEVELOPMENT_ROADMAP_2026-10-08.md:77`) proved that **94.5% of the `67.5s` compile time (`63.839s`) is spent inside Windows DXC HLSL optimization** when compiling the giant composed WGSL call graph (`19,658` lines of DXIL).

Instead of keeping the shader small and using standard `//>>ifdef` defines, Astra/Sol 6.1:

1. Expanded the WGSL codebase to **~75 files (`>6,500` lines)** with 14 producer/cache subsystems.
2. Built an **800-line regex/substring WGSL splicer** (`WebGPUCloudProgramBranches.ts:1-802`) and a **45-property pipeline key** (`CloudMarchSpecializationKey` in `WebGPUCloudShaderSpecialization.ts:44-142`) that triggers new runtime shader compilations whenever camera altitude bands, wind, or weather states change.
3. Hid the `25s–59s` full/layered compile behind a **5-stage visual state machine** (`"bootstrap" → "volume" → "cached-preview" → "windless detailed" → "wind detailed"`) that renders flat 4-step value noise on startup and visually pops every few seconds as pipelines finish.

### 4.3 How the Water Overhaul Solved the Exact Same Problem Cleanly

Compare `cesium-astra-20260926`'s 85-file cloud sprawl with the recent **Water overhaul** (`WebGPUGlobeSurfacePipelines.ts`, `WebGPUOceanRenderer.ts`, `GlobeWater.js`, `OceanSurface.wgsl`):

| Architectural Pillar | Water Overhaul (`main`) | `cesium-astra-20260926` Clouds | Target Cloud Architecture |
| :--- | :--- | :--- | :--- |
| **Camera Regimes** | **6 continuous altitude/depth regimes** blended via `smoothstep` in a single shader; ocean IFFT compute **auto-sleeps above `15 km`** (`0 ms` in orbit). | 14 manual default-`OFF` cache subsystems; volumetric ray-march runs at `20,000 km` and hits `maxIter = 72` on limb rays. | **3 continuous altitude regimes** (`Ground`, `Flight`, `Orbit`) with a closed-form + 4-tap hybrid orbital fast path above `80 km` (`30–80 km` smoothstep cross-fade). |
| **Shader Size & Specialization** | Compact WGSL (~1,200 lines) specialized via standard compile-time `ShaderDefineHi` tier bits (`WATER_TIER_LOW/MEDIUM/HIGH`). | `>6,500` lines across ~75 WGSL files + 800-line fragile substring splicer (`WebGPUCloudProgramBranches.ts`) + 45-field runtime key. | Compact modular WGSL (~1,200 lines total), 1 joint `marchDeck` call, analytical `worleyF1` gated behind compile-time `//>>ifdef`, **zero** regex string splicing. |
| **Async Pipeline Compilation** | Non-blocking `createRenderPipelineAsync` + `_fallbackPipelineCache` + **600 ms Hermite smoothstep cross-fade** (`0` dropped frames, `0` temporal resets). | 5-stage visual state machine (`bootstrap → volume → cached → detailed`) that resets temporal history and pops at each stage. | Fast `< 800 ms` primary shader compiled via `createRenderPipelineAsync` with fallback retention and smooth transmittance-preserving cross-fade. |
| **Uniforms & Bindings** | Compact uniform struct + standard bind group. | **424 floats (`1,696` bytes)**, **31 `@group(0)` bindings**, `f32` bit-packing overflow at bit 24. | Clean `< 220`-float uniform struct with `u32` bitmasks (`< 24` bits) and `<= 14` bindings. |

---

## 5. What to Harvest vs. What to Drop from `F:/Dev/GH/cesium-astra-20260926`

### 5.1 The 10 High-Value Gems in `cesium-astra-20260926` to Keep / Port to `main` (and Enable by Default!)

1. **WGS84 Oblate Ellipsoid Shell Geometry & Sqrt-Free RTE Height Fraction** (`ProceduralCloudGeometry.wgsl:48-133`):
   - `cloudShellAxes(h) = (a+h, a+h, b+h)`, `rayEllipsoidIntersectRTE`, and `ellipsoidShellHeightFractionRTE`. Eliminates `main`'s `21 km` polar spherical-shell altitude error and grazing `f32` precision loss in ~85 lines of clean WGSL.
2. **Grazing Limb Re-Entry Interval & Empty-Core Skip** (`CloudLightingCache.wgsl:6-32`, `ProceduralCloudColumnSampling.wgsl:4-15`, `ProceduralCloudOccupancy.wgsl:58-62`):
   - `cloudViewShellInterval` clips `tEnd` only against the solid planet (`cloudShellAxes(0.0)`), and `cloudOccupiedShellIntervals` + `cloudNextOccupiedDistance` jump directly across the empty sub-cloud air gap `[tInner.x, tInner.y]` on limb rays (**must be ON by default** so limb rays never waste steps in empty air below `deckBottom`!).
3. **Lateral Pixel-Cone Footprint Mip Metric** (`CloudDensityIntegration.wgsl:17-19`, `ProceduralCloudMarch.wgsl:467-469`):
   - `cloudViewPixelFootprint = 2.0 * max(distance, 0.0) * abs(projectionScale) / max(resolution, 1.0)`. Fixes both orbital nadir mip-0 sparkle and in-cloud flight mip-5 blur.
4. **Descending-Safe Finite Air Transport & PBR Neutral Tonemap** (`CloudLightSampling.wgsl:469-557`, `ProceduralCloudLighting.wgsl:177-228`, `ProceduralCloudMarchOutput.wgsl:38-52`):
   - `cloudFiniteAirTransport` and `cloudAirColumnMeters` replace the broken downward `skyViewLut` lookup from orbit and integrate only the `[0, hitDistance]` segment inside the `111 km` atmosphere shell using `weightedAerialDistance / alpha`.
5. **WGS84 Planetary Terminator, Solar Disk Penumbra & Local Sun Transmittance** (`CloudSolarVisibility.wgsl:1-38`, `CloudLightSampling.wgsl:740-761`):
   - `cloudSunVisibility`, `cloudSolarDiskVisibility`, `cloudSunIllumination`, and `cloudDaylight`—**must be turned ON by default** (`cloudPlanetaryLighting = true` by default) so night-side orbital clouds are dark and sunset colors follow the terminator!
6. **RTE `lightMarchPhysical` & Optical-Depth-Attenuated Directional `silverLining`** (`CloudLightSampling.wgsl:277-409, 601-618`):
   - `lightMarchPhysical`, `cloudSilverLining`, and `cloudSilverLiningPhase`—**must be turned ON by default** (`cloudPhysicalSelfShadow = true` and `cloudDirectionalSilverLining = true` by default) so cloud bases from the ground have deep self-shadowing and forward-peaked solar silver linings!
7. **Joint Single-Loop Multi-Deck March + Per-Deck Profiles & Peer Shadowing** (`ProceduralCloudMarch.wgsl:20, 578-790`, `CloudMaterialProfiles.wgsl:47-65`, `CloudLightSampling.wgsl:71-133`):
   - Calls `marchDeck` **once** per pixel (instead of 4× on `main`), stepping `LOW`/`MID`/`HIGH` jointly with per-deck `layerProfileLow/Mid/High`, independent weather layers (`cloudWeatherPlane`), and cross-deck peer shadowing (`cloudPeerDeckOpticalDepth`).
8. **Quadratic/Exponential Near-Camera Step Distribution & Fine-Step Start** (`CloudDensityIntegration.wgsl:34-61, 104-110`, `ProceduralCloudMarch.wgsl:225, 240-241`):
   - `cloudAdaptiveMarchStepBounds`, `cloudMarchBoundary`, and `fine = true`—**must be turned ON by default** (`cloudAdaptiveSampling = true`, `cloudFineSampling = true`) with a non-zero near-field footprint floor when `tStart == 0.0` (inside the cloud slab).
9. **Planet-Stable SO(3) Decorrelated 3D Noise Domains + 4-Channel Baked Noise** (`CloudDensityDomain.wgsl:13-141`, `CloudNoiseBake.wgsl:234-245`, `WebGPUCloudDensityDomain.ts`):
   - CPU `f64` origin phases + affine ray step `shapeRayPhasePerMeter * sampleDistance`, prebaked `detailTex.a` 3-octave Worley FBM (`detailFbmEnabled = true` by default), and `shapeTex.gba` utilization.
10. **Anti-Shimmer `4x4` Tent Filter, Default `representativeDist` Reprojection, `r32float` Resolved Depth (`3311`), and Camera-Getter Drift Fix (`3357`)**:
    - Emit `representativeDist = weightedAerialDistance / alpha` into the alpha/depth reprojection channel by default, keep the `4x4` spatial tent filter + YCoCg neighborhood clamp in `CloudTemporalResolve.wgsl`, keep `r32float` resolved depth when `float32-filterable` is supported (fixing orbital log-depth rings), and keep the camera heading/pitch/roll scratch-vector fix (`3357`, reducing stationary lighting refreshes from `1,031` to `3`).

### 5.2 What Astra & Sol 6.1 Should Retire / Leave Out of `main`

To stop the `25s–59s` DXC compile stalls and 649-file maintenance paralysis, **do NOT carry forward**:

1. **The 800-Line Regex/Substring WGSL Splicer** (`WebGPUCloudProgramBranches.ts`, `WebGPUCloudShaderSpecialization.ts`, `WebGPUCloudProducerPrograms.ts`, `WebGPUCloudPipelineVariants.ts`). Use standard `ShaderDefine` / `ShaderDefineHi` preprocessor flags (`//>>ifdef`) and normal WGSL functions instead.
2. **The 14 Redundant Default-Off Cache & Proxy Subsystems**:
   - Drop the 6-mode near/far 3D `CloudDensityVolume` (`WebGPUCloudDensityVolume.ts`), the 3-bank 3D `CloudLightingCache` (`WebGPUCloudLightingCache.ts`), the 3D `CloudDeepShadow` (`WebGPUCloudDeepShadow.ts`), the 30-layer cube-array `CloudColumnHierarchy` (`WebGPUCloudColumnHierarchy.ts`), the 31-layer `CloudWeatherMaterialCache` (`WebGPUCloudWeatherMaterialCache.ts`), the 3D `CloudOccupancy` compute flood (`WebGPUCloudOccupancy.ts`), the stencil `CloudCachedMarch` (`WebGPUCloudCachedMarch.ts`), and the 3-MRT `CloudLayerTemporalResolve.wgsl` (`578` lines).
   - None of these are enabled by default in `3444`, all of them failed visual acceptance in Astra's own logs, and their 31 bindings + 424 uniform floats + inlined shader branches are the exact reason DXC takes `25s–91s` to compile!
3. **The 5-Stage Popping Startup Machine** (`WebGPUCloudStartup.ts`, `WebGPUCloudBootstrap.ts`, `WebGPUCloudStartupVolume.ts`):
   - Once the redundant cache branches and 272 `worleyF1` loops are removed, the real volumetric cloud shader compiles in **`< 800 ms`** via `createRenderPipelineAsync`—eliminating any need for stationary 4-step value-noise bootstrap shaders that pop and reset temporal history.

---

## 6. Step-by-Step 5-Phase Remediation Plan for Astra & Sol 6.1

### Phase 1 — Clean Shader Decomposition, `< 1s` Async Compilation & Core Lifecycle Fixes

1. **Eliminate the 272 Inlined `worleyF1` Loops Without Regex Splicing**:
   - Use the single-call joint `marchDeck` structure (`1` call in `fragmentMain`, not `4`), gate legacy analytical `worleyF1` noise behind a compile-time `//>>ifdef CLOUD_ANALYTICAL_NOISE_FALLBACK` (off whenever 3D baked noise textures are bound), and keep morphology (`mammatus`, `species`, `feature`, `curlNoise3`) out of `lightMarchPhysical` (shadow rays only need macro base density).
2. **Remove `fragmentCloudMaskMain` Full-Screen Re-March**:
   - Replace the second full-screen volumetric march in `fragmentCloudMaskMain` with a 1-tap fullscreen pass that reads `1.0 - cloudAlpha` from the resolved cloud texture (or outputs transmittance as an MRT attachment).
3. **Wire `createRenderPipelineAsync` + `WebGPUShaderModuleCache` + Fallback Cache**:
   - Deduplicate `device.createShaderModule` calls through `WebGPUShaderModuleCache` and convert all synchronous `createRenderPipeline` / `createComputePipeline` calls to `Async` with fallback retention (matching `WebGPUGlobeSurfacePipelines.ts`).
4. **Land the 3 Proven Lifecycle Fixes**:
   - Port the `r32float` resolved-depth selection when `float32-filterable` is supported (`3311`), the stationary camera-getter scratch drift fix (`3357`), and the 3D noise / weather texture teardown cleanup in `destroyProceduralCloudResources`.
5. **Fix `f32` Flag Bit-Packing (`I02/I03`)**:
   - Keep all bitflags in `u32` uniform fields (or strictly `< (1 << 24)` per slot) so high bits never round away low bits in `Float32Array`.

### Phase 2 — Global Coordinate Frame (ENU), WGS84 Geometry & Default-On Physical Lighting

1. **Port WGS84 Oblate Ellipsoid Shell Geometry (`ProceduralCloudGeometry.wgsl:48-133`)**:
   - Replace spherical `planetRadius + h` with `cloudShellAxes(h)`, `rayEllipsoidIntersectRTE`, and `ellipsoidShellHeightFractionRTE`.
2. **Fix ECEF `Y`-Up in Wind & All 5 Morphology Functions**:
   - Compute the local orthonormal East-North-Up basis `(east, north, up)` at the sample/camera position:
     - Project wind displacement onto `east * windDir.x + north * windDir.y`.
     - Transform `sp` into `localPos = vec3<f32>(dot(sp, east), dot(sp, up), dot(sp, north))` before evaluating `genusFibreFactor`, `mammatusFactor`, `speciesFactor`, `featureFactor`, and `specialShadeTint`.
3. **Turn ON Planetary Terminator, Local Sun Color, RTE `lightMarchPhysical`, and Directional Shadowed `silverLining` by Default**:
   - Enable `cloudSunVisibility`, `cloudSolarDiskVisibility`, `cloudSunIllumination`, `cloudDaylight`, `lightMarchPhysical`, `cloudSilverLining` (`exp(-opticalDepth * absorb)`), and `cloudSilverLiningPhase` (forward HG lobe) **by default in all tiers**.
4. **Wire `cloud.tierLighting` & Depth-Attenuated Ambient**:
   - Read `cloud.tierLighting` (`powderStrength`, `isotropicFloor`, `ambientFloor`) in the lighting evaluation and attenuate ambient sky bounce by `(0.25 + 0.75 * heightFrac) * exp(-lightOpticalDepth * 0.15)` so storm bases from the ground have rich contrast.

### Phase 3 — Flight Regime Overhaul (In-Cloud & Near-Deck Cruise)

1. **Enable Near-Camera Quadratic Step Distribution (`cloudMarchBoundary`) & Fine-Step Start by Default**:
   - Turn on `cloudAdaptiveMarchStepBounds` and `cloudMarchBoundary` by default, fix the `marchStepGrowth` exponent (`ProceduralCloudMarch.wgsl:322`) to use step index `interval` instead of `(t - tStart) / fineStep`, and enforce a minimum near-field footprint floor (`max(tStart, 150.0)`) when `tStart == 0.0` so crossing into a cloud deck never collapses step bounds to `0`.
   - Force `fine = true` whenever `tStart == 0.0` (camera inside the cloud slab) or `t - tStart < 10,000.0` so the ray never takes a `4x` coarse jump over near-cockpit clouds.
2. **Pass Transmittance-Weighted `representativeDist` to `CloudTemporalResolve.wgsl` by Default**:
   - Always emit `representativeDist = weightedAerialDistance / max(alpha, 1e-5)` (either via `@location(1)` or packed depth/alpha) and consume it in `CloudTemporalResolve.wgsl` alongside the `4x4` tent filter and `3x3` YCoCg neighborhood variance clamp (`mean ± γ·σ`), eliminating the `55 km` midpoint parallax ghosting in Flight mode.

### Phase 4 — Orbit Regime Overhaul (`> 30 km` Cross-Fade to `> 80 km` Hybrid Orbital Fast Path)

1. **Enable Grazing Limb Empty-Core Skipping by Default**:
   - Turn on `cloudViewShellInterval` + `cloudOccupiedShellIntervals` (`[tOuter.x, tInner.x]` and `[tInner.y, tOuter.y]`) by default so grazing limb rays jump immediately across the empty sub-cloud interior `[tInner.x, tInner.y]` in `1` step instead of exhausting `maxIter = 72` in empty air.
2. **Hybrid Orbital Shell (`30–80 km` Smoothstep Cross-Fade, `> 80 km` 4-Step / Analytic Shell)**:
   - Above `80 km`, use a dedicated 4-step stratified quadrature across each occupied shell interval (or closed-form median ellipsoid tap with optical depth scaled by clamped $\sec\theta = 1 / \max(|\hat{d}\cdot\hat{n}|, 0.15)$) using the **exact same 3D baked noise + weather field** (not a separate synthetic noise field), with variance-preserving mip contrast restoration around the shape mean (`0.4307`) and `cloudFiniteAirTransport` using `weightedAerialDistance / alpha`.
   - Cross-fade smoothly between full volumetric `marchDeck` (`<= 30 km`) and the orbital fast path (`>= 80 km`) using premultiplied linear radiance and transmittance.

### Phase 5 — Multi-Deck Weather, 4-Channel 3D Noise, Cloud Shadows & Public API Wiring

1. **Use All 4 Channels of `128³` `cloudShapeTex` and `32³` `cloudDetailTex` by Default**:
   - Enable `detailFbmEnabled` (`detailTex.a` prebaked 3-octave Worley FBM) and `shapeTex.gba` base erosion by default.
2. **Wire Single-Deck `CloudDeck.bounds` & Joint Multi-Deck Weather Layers**:
   - In single-deck mode, apply `CloudDeck.bounds[profile.deck]` when `cloudType` is set (so `CloudType.CIRRUS` renders at `[5000, 13000]` instead of `[1500, 4000]`).
   - In multi-deck mode, use the joint single-loop `marchDeck` with independent per-deck `layerProfileLow/Mid/High` and weather layers.
3. **Fix `volumetricEnableAltitude`, `"ultra"` Preset, Half-Res Bayer Depth Alignment, and Terrain Shadow Elevation Guard**:
   - Fix `resolveAltitudeBand` (`WebGPUCloudTierPresets.ts:831-840`) to read `config.volumetricEnableAltitude` / `config.volumetricDisableAltitude` directly.
   - Define a real Tier 4 `"ultra"` preset in `WebGPUCloudTierPresets.ts`.
   - Align half-res depth UV sampling between `ProceduralClouds.wgsl`, `CloudTemporalResolve.wgsl`, and `CloudUpscale.wgsl`.
   - Fix low-sun shadow eye distance in `WebGPUCloudShadowFrame.ts:292` and add the cloud-base elevation guard (`worldHeight < cloudDeckBottom`) in `GlobeTerrain.wgsl:2396-2403`.

