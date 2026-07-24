<!-- Landed Batch 749. Gate artifact for C12-29. 19-agent research (4 lanes + adversarial verification), 2026-07-24. -->

All anchors verified. Composing the report now.

---

# ECLIPSE EFFECTS RESEARCH REPORT — C12-29 (NEW-ECLIPSE-OCCLUSION-EFFECTS)

Maintainer directive (2026-07-24, two screenshots): "We need eclipse level effects both in orbit and in atmosphere." Research-gated per `migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md:59`. This report is the gate artifact; slices below are ready for green-light.

---

## 1. The defect, precisely

There is no bug to fix — there is a missing subsystem. Sun occlusion in this engine is a boolean with no intensity path, and the moon is not an occluder anywhere. The two reported symptoms are one absence.

**WebGL: whole-billboard binary cull.** `Scene.updateEnvironment` builds an Earth-sphere occluder (`radius = ellipsoid.minimumRadius + minimumTerrainHeight`, `SceneUtilities.js:18-37`) only in SCENE3D and only when the globe is opaque (`Scene.js:3803-3807`), then sets `environmentState.isSunVisible = this.isVisible(cullingVolume, sunDrawCommand, occluder)` (`Scene.js:3821-3825`), which bottoms out in `Occluder.isBoundingSphereVisible` (`Core/Occluder.js:101-145`) — a pure boolean sphere-vs-horizon-cone test. The sun's bounding sphere is `SOLAR_RADIUS * (1 + glowLengthTS)` (`Sun.js:329-330`; verified this session — ≈6× solar radius ≈ 4.2e9 m at default `glowFactor=1`). The flip therefore happens while the *glow-sphere edge* grazes the limb: frame N the whole disc+glow billboard is skipped (`EnvironmentRenderer.js:43-58`; sunBloom PP gated on the same boolean at `FramebufferOrchestrator.js:163`), frame N+1 it draws at full brightness. That is the screenshot.

**WebGPU: no JS cull at all — a per-pixel hard clip instead.** `updateWebGPUSun` builds a `WebGPUDrawCommand` with **no** `boundingVolume` (`WebGPUEnvironmentRenderer.js:612-619`, verified), so `Scene.isVisible` early-returns true (`Scene.js:3618-3625`) and `isSunVisible` is always true when shown. Occlusion is purely geometric: the WGSL vertex shader clamps the quad to the far plane (`WebGPUEnvironmentRenderer.js:84-90`) and the pipeline uses `depthCompare: 'less-equal'` with writes off (`:535-539`), so sun fragments survive only where the globe wrote no depth. Result: hard silhouette clip at the limb, full brightness the instant a pixel clears it, and zero pre-glow because WebGPU sun bloom is unwired (C11-160, "gated off on WebGPU", `QUEUE_2026-07-19_CAMPAIGN12.md:397-398`). Which mechanism the maintainer's screenshots captured is UNCONFIRMED (backend not recorded) — both produce a pop, both need the same fix.

**Moon: nothing, confirmed at code level.** `eclipse` has zero hits in `packages/engine/Source`; `umbra`/`penumbra` appear only in an unrelated CSM comment (`WebGPUCSMRenderer.ts:1348-1350`). The only occluder ever constructed is the Earth sphere. No moon reference in `Sun.js`, no occlusion logic in `Moon.js`. A sun-behind-moon frame renders both bodies independently — the moon merely paints over the sun quad by depth/draw order, with zero light coupling.

**Everything an analytic fix needs already exists per frame:** Simon1994 moon position in ECEF meters (`Moon.js:121-175`, publishing `frameState.moonDirectionWC` + `moonPhaseFraction`), `uniformState.sunPositionWC`, `CesiumMath.SOLAR_RADIUS = 6.955e8` and `LUNAR_RADIUS = 1737400` (`Core/Math.js:174,183`). No external data required.

---

## 2. What eclipse-level looks like — quantitative anchors

**Illuminance curve (the non-negotiable shape).** ~100,000 lux full sun → still ~1,000 lux at 99% obscuration → ~5 lux at totality; 2+ orders of magnitude collapse in the final ~1 minute (AAS, https://eclipse.aas.org/eclipse-basics/totality-darkness; Optica sky-brightness survey, https://opg.optica.org/ao/abstract.cfm?uri=ao-10-6-1207). Perceptually: no visible change until ~75% obscured, overcast-day at 99%, then a plunge. Totality is **civil twilight, not night** — a full-moon night is ~10× darker (<0.5 lux). Sky light behaves as simply attenuated sunlight to ≥99.8%; during totality the sky is lit by multiple scattering from *outside* the umbra. Consequences for the renderer: dim by *obscuration* (visible flux fraction), nonlinearly via the light curve, floored at a twilight ambient — never smoothstep-floored, never black, never 8-bit-quantized.

**Limb darkening doubles the stakes near totality.** A uniform-disc geometric model over-predicts remaining broadband flux by roughly 2× near second/third contact (measured 2017 spectro-irradiance: actual/geometric = 22% at 306 nm, 67% at 1020 nm; ACP 19:4703, https://acp.copernicus.org/articles/19/4703/2019/). Use the C12-15 coefficients (`a0=0.3, a1=0.93, a2=−0.23`, `QUEUE_2026-07-19_CAMPAIGN12.md:92`), not Waldmeier-era parameterizations (up to 37% wrong).

**Corona (corrected photometry).** Limb surface brightness ~4e-6 of disc centre, falling as the Baumbach (1937) fit `I(R) = (2.565 R^-17 + 1.425 R^-7 + 0.0532 R^-2.5) × 10^-6` of disc-centre brightness — exponents **−17/−7/−2.5** (not −3). Integrated corona ≈ 1e-6 of the Sun (≈ full-Moon brightness); the disc is 10^5–10^6× brighter, so corona emergence at effectively 100% obscuration is physically correct near-binary behavior. K-corona dominates inside ~1.5–2 R_sun; F-corona takes over ~3–4 R_sun out. Visible extent: white streamers a few solar radii.

**Umbra from orbit.** Ground footprint 100–160 km wide (path widths up to ~270 km; 2017 track ~115 km), penumbra >6,400 km, racing at 2,520–7,600 km/h (2024-04-08 measured; Space.com/EclipseWise). True outline is an irregular polygon (lunar-limb valleys; 49 mattered in 2017). NASA SVS publishes umbra polygon shapefiles at 1 s/10 s cadence for 2017/2023/2024 (https://svs.gsfc.nasa.gov/5073) — US-government public domain, usable as deterministic probe ground truth.

**Orbital sunrise (what replaces the pop).** From LEO the lit limb is a ~1°-wide stacked color band (orange troposphere → pink/white stratosphere → blue → black); the disc event lasts seconds at 28,000 km/h, but the limb glow develops over **minutes** before disc contact (derived from ~3.9°/min sun-depression rate; marked UNCONFIRMED-derived — no published stopwatch figure found). Refraction: 34 arcmin at sea-level grazing (more than the sun's own 32′ diameter; sun visible 2–3 min past geometric set, disc flattened ~16-20% differentially) but decaying ~exp(−z/8 km) — at the z≈12 km where light actually penetrates, ~8′ residual. Verdict: the *extinction ramp*, not refraction, is what kills the pop; refraction is polish.

**Prior art.** Best-in-class: Schneegans et al., CGF 2022 (occluder-independent precomputed eclipse shadow map) and CGF 2025 (Bruneton extension with refraction; renders both Earth-limb sunset and moon eclipse in one framework) — both MIT-licensed, shipped in CosmoScout VR v1.6.0/v1.10.0 (https://onlinelibrary.wiley.com/doi/10.1111/cgf.70017; 2025 PDF contents beyond abstract UNCONFIRMED this session, >10 MB fetch limit). Cheap credible fallback: Stellarium's eclipse factor — with its documented pitfall (issue #3720: darkening by eclipse *magnitude* made annular eclipses too dark; darken by **obscuration** only). Upstream CesiumJS has nothing native (community hand-built cones from the same Simon1994 ephemeris — proof our data suffices). Aerospace standard for the light model: dual-cone umbra/penumbra visible-fraction (continuous through transitions — MathWorks Eclipse Shadow Model docs).

**Canonical acceptance instants (all CONFIRMED real events):**
- **A (in-atmosphere, low sun):** 2026-08-12 — Iceland (umbra 17:43:28–17:50:07 UT, Reykjavik ~59 s) and northern Spain (sun only ~10° → 3° high at totality) — one instant exercises eclipse darkening + low-sun atmosphere + limb effects simultaneously.
- **B (in-atmosphere, high sun):** 2027-08-02 — Luxor, 6m23s totality, max ~13:05 local, sun 82° up.
- **C (from-orbit, richest validation):** 2024-04-08 — NASA SVS umbra shapefiles + GOES/DSCOVR imagery + published speed profile at exact timestamps.

---

## 3. The architecture — one `EclipseState`, one scalar, many multiplies

### 3.1 Core: `Scene/EclipseState.js`

New pure module beside `SkyBrightness.js` (same Node-spec-testable pattern), called once per frame from `Scene.updateFrameState` **before** `uniformState.update(frameState)` at `Scene.js:5752`, publishing:

```
frameState.eclipseState = {
  sunVisibleFraction,      // [0,1], limb-darkened flux fraction, camera-anchored
  earthOcclusionFraction,  // component from Earth limb
  moonObscuration,         // component from moon disc
  moonPositionWC,          // ECEF, for the S5 per-fragment umbra term
}
```

It computes sun+moon world positions itself via `Simon1994PlanetaryPositions` + `Transforms.computeIcrfToFixedMatrix` (pattern at `Moon.js:113-126`) because (a) `setSunAndMoonDirections` discards the world-fixed moon position (`UniformStateComputations.js:182-189`) and (b) `Moon.update` only runs when `moon.show` is true (`Moon.js:104-106`) — an eclipse must work with the moon primitive hidden. Identity (1.0) outside eclipse geometry; identity forced in 2D/CV, translucent-globe, and hidden-globe modes to reproduce the existing cull guards (`Scene.js:3803-3807`, `GlobeTranslucencyState.js:369`, `SceneUtilities.js:19-26`).

### 3.2 The math (one integrand, both occluders)

- **Moon vs sun:** classic circle-circle lens overlap on angular radii (`asin(R/d)`), with clamped `acos` arguments and non-negative sqrt product (floating-point drifts out of domain near tangency/totality). Annular case (`d ≤ Rs−Ro`): obscuration `(Ro/Rs)²` by area — higher with limb darkening since the hidden centre is brightest. Gate scalar: magnitude `M = (Rs+Ro−d)/(2Rs)`; `M ≥ 1` = total.
- **Earth limb:** the half-plane (`d→∞`) limit of the same formula — circular-segment visible fraction at signed limb altitude — softened by a tangent-optical-depth extinction ramp `exp(−tau0·exp(−(z−z0)/H))` over grazing altitudes z ≈ 0–60 km (tangent air mass ≈38× vertical at the horizon; Chapman geometry). From a 400 km orbit that annulus subtends ~1.5° ≈ 3 sun diameters — a multi-second fade, not a frame.
- **Limb darkening:** 1-D radial chord-coverage quadrature, `blockedFlux = ∫ I(r)·c(r)·2πr dr` with `I(mu) = a0 + a1·mu + a2·mu²` (C12-15 coefficients) and `c(r)` the annulus-coverage acos term. 32–64-point Gauss, ~200 f64 flops, once per frame on CPU. Mandel & Agol 2002 closed forms exist but quadrature is the right renderer tradeoff. Implement once; C12-15 (bake) and C12-29 share the constants source.
- **Precision:** all CPU math in f64 (JS numbers), results shipped as runtime uniform floats. The f64 requirement is driven by the shadow-axis solve being a difference of 1.5e11-m quantities (f32 → ~9 km error, same order as the umbra), **not** by umbra size — the umbra is ~1e-2 of Earth radius (up to ~135 km half-width), not 1e-5.

### 3.3 Injection points (all verified file:line; no new ShaderDefine bits — exit-gate item 5 compliant, all runtime uniforms)

| # | Channel | Site(s) | Backends |
|---|---|---|---|
| 1 | Sun billboard **alpha** fade | WebGL: new scalar in `Sun._uniformMap` (`Sun.js:80-98`), exactly the C7-SUN-STARS-EXTINCTION template (`Sun.js:136-173` → `SunFS.glsl:6,17`). WebGPU: unused pad `_p2` (`WebGPUEnvironmentRenderer.js:70`, `uniformData[31]`) — zero-cost slot | both |
| 2 | Scene direct light | `UniformState.js:879-900` (`lightColorHdr = color × intensity`), gated on the existing `light instanceof SunLight` branch (`:857-866`); reaches `czm_lightColorHdr` and `csm_lightColorHdr` (`WebGPUAutoUniforms.js:442-444`) in one multiply | both |
| 3 | Atmosphere intensity | `UniformState.js:938` (`_atmosphereLightIntensity` → GLSL `computeAtmosphereColor.glsl:41,84`) **plus** the WGSL sky shell's own reads at `WebGPUSkyAtmosphereRenderer.js:545,899` (→ `SkyAtmosphere.wgsl:593`) and the WebGL SkyAtmosphere uniform twin | both, 3 sites |
| 4 | skyBrightness sun term | `SkyBrightness.js:101-105` via `Scene.js:5767-5772` | shared scalar |
| 5 | Clouds (C13-owned) | `WebGPUProceduralCloudRenderer.ts:1866` (`sunIntensity = atmosphereLightIntensity ?? 10.0`) | WebGPU |
| 6 | IBL / env map (C13-owned) | `WebGPUDynamicEnvironmentMapManager.ts:1234,1677`; WebGL twin `DynamicEnvironmentMapManager.js:803,1107` | both |
| 7 | Sun PP bloom | today gated on the same boolean (`FramebufferOrchestrator.js:163`); alpha fade propagates automatically until C12-18 moves halo to the PP chain, at which point the factor must multiply the PP bloom **input** | WebGL now, WebGPU post-C11-160 |
| 8 | Globe surface umbra (S5) | per-fragment term in `GlobeFS.glsl` + `GlobeTerrain.wgsl` from `moonPositionWC`/`sunPositionWC` uniforms (Principle 5: both simultaneously) | both |

**Alpha, not RGB, for channel 1:** WebGL blends `ALPHA_BLEND` (`Sun.js:312-314`) where rgb-dimming produces a black-disc artifact; WebGPU currently blends additive src-alpha/one (`WebGPUEnvironmentRenderer.js:519-532`) and C11-115's ratified direction flips it to ALPHA_BLEND. An alpha-only multiply fades correctly under **both** blend modes — the design is invariant to the C11-115 flip.

**Double-darkening hazard:** the channel-2 scene-light factor is camera-anchored; the channel-8 globe term is fragment-anchored. The globe pass must apply the per-fragment factor *instead of* (or normalized by) the global one, or the umbra darkens twice.

### 3.4 Correction to the "free wins" claim

"Stars appear at totality for free" is **wrong at defaults**. The only consumer of `frameState.skyBrightness` is the cubemap-panorama star modulation (`WebGPUCubeMapPanoramaRenderer.js:525,555-558`), gated on `enableStarBrightnessModulation === true` — which defaults **false** since C11-176 (`AtmosphericConditions.js:363-388`, verified this session, with the measured rationale in the comment block). So the skyBrightness multiply in S1 is byte-inert at defaults — which is a *feature* for landing safety — and it does not resurrect the removed elevation dim (that was a permanent elevation-keyed dim; this is a transient occlusion-keyed flux loss, identity in all non-eclipse frames, so it does not violate the C12 exit-gate multiplier-class audit at `QUEUE_2026-07-19_CAMPAIGN12.md:136`). A *default-visible* star reveal at totality needs its own both-backend consumer (exit-gate item 2: GLSL consumer or default-off) and its own ratification — it lives in S6.

**A real possible free win to probe first (Principle 7):** `Sun.js:136-163`'s extinction integrator runs whenever skyAtmosphere is visible, and its "exactly ONE from orbit" claim (`Sun.js:139-142`) holds only when the ray misses the shell — at limb-grazing geometry from orbit the ray *does* traverse the atmosphere, so the existing integrator may already produce the orbital-sunset reddening ramp, currently unobservable because the cull removes the sun first. S4 starts with a probe of this before writing any new limb-glow code.

---

## 4. Ranked slice plan for C12-29

Each slice re-runs Scenes A/B/C (below) as regression gates. Probes: `probe-saved-view.mjs` template + C13-01 deterministic-harness rules (offline, pinned `JulianDate` per manual render, raw-canvas capture, console/device-loss gates, per-probe watchdogs — `QUEUE_2026-07-23_CAMPAIGN13.md:635,645-666`), Edge only.

**Probe scenes (built in S1, hardened per slice):**
- **Scene C — orbital sunrise sweep:** LEO camera, clock stepped across a sunrise. Metrics: per-step sun-region luminance delta bound (kills the pop *by construction*, e.g. <10%/step at fixed step), monotone glow ramp, WebGL-vs-WebGPU curve parity.
- **Scene A — in-atmosphere centreline:** clock pinned at a real totality instant (2024-04-08 ~19:09 UT Torreón region for deterministic data; 2026-08-12 Iceland and 2027-08-02 Luxor as the maintainer-facing showcases), ground camera facing the sun, stepped ±90 min. Metrics: illuminance-vs-obscuration curve shape (monotone, steepening, ~3 orders of magnitude), totality assertions, backend parity band.
- **Scene B — orbital umbra:** camera in orbit over the 2024-04-08 path at the pinned instant. Metrics: dark-spot presence + centroid lat/lon vs NASA SVS shapefiles (public domain — exact citation recorded per licensing culture). Stays RED until S5.

| Slice | Effort | Deps | Content | Acceptance | What it visibly buys |
|---|---|---|---|---|---|
| **S1 — EclipseState + sun fade** | S | none; lands **before** C12-15/17/18 and C11-160 | `EclipseState.js` (geometric area-fraction first; limb-darkened upgrade when C12-15's constants land), replace the boolean cull with fraction-gated fade (hard kill only at fraction≈0 with hysteresis; keep frustum test), alpha uniform on both backends (template `Sun.js:136-173`; WebGPU `_p2` pad), skyBrightness sun-term multiply (inert at defaults), Scenes A/B/C built | Scene C green: no luminance step exceeds bound on either backend; node-spec unit tests on the overlap math (tangency, totality, annular, clamp guards) | **Kills the pop.** Sun fades over the limb in orbit; moon transits dim the sun disc |
| **S2 — scene-light + atmosphere dimming** | S | S1 | `lightColorHdr` multiply (SunLight-gated), `_atmosphereLightIntensity` + both sky-shell sites; twilight ambient floor at totality (~5 lux target, never black) | Scene A green: curve shape vs AAS/Optica anchors within band; non-eclipse frames byte-identical (factor=1.0) | The world actually darkens during an eclipse, in atmosphere and for orbital cameras inside the shadow |
| **S3 — clouds + IBL** | M | S1; **C13-routed** | `sunIntensity` multiply (`WebGPUProceduralCloudRenderer.ts:1866`), IBL sites, **quantized eclipseFactor (~1/64 grid) added to the IBL refill debounce** beside the coverage epsilon (`WebGPUDynamicEnvironmentMapManager.ts:658-695`), verify C13-38's suppression predicate doesn't swallow eclipse refreshes (`QUEUE_2026-07-23_CAMPAIGN13.md:636`) | Eclipse-IBL probe lane: reflected/cloud brightness tracks the factor within N frames; refill count across a full eclipse bounded (~tens) | Clouds and reflections stop glowing through totality |
| **S4 — orbital-sunrise limb glow** | M | S1 | FIRST: probe the existing extinction integrator at limb-grazing rays from orbit (`Sun.js:136-163`) — it may already be the reddening ramp; then the tangent-optical-depth extinction ramp on the Earth-limb fraction; refraction lift/flattening **deferred** (polish) | Scene C upgraded: minutes-scale monotone glow development, reddening at grazing, parity band | The maintainer's orbital sunrise: growing limb glow, reddened dimming disc, multi-second fade |
| **S5 — umbra/penumbra on the globe** | M | S1; co-exists with S2 (double-darkening normalization) | Per-fragment obscuration in `GlobeFS.glsl` + `GlobeTerrain.wgsl` (2 acos + sqrt + 64-entry light-curve LUT baked per frame from the CPU quadrature), `moonPositionWC` as RTE high/low uniforms, CPU projected-ellipse gate + camera-in-umbra test; uniform-branch, no define bits | **Scene B goes green** vs NASA SVS 2024 shapefiles (centroid error bound, size band, motion across steps) | The from-orbit money shot: a dark spot racing across the day side at the documented speed |
| **S6 — totality phenomena** | L | S1-S5 | Corona pass gated on `occluder==moon && M≥1`, ramping over the last ~0.5% obscuration, Baumbach falloff (−17/−7/−2.5), few-R_sun extent (start from the `Environment/Sun.wgsl:103-104` prototype — scaffolding per Principle 7); 360° horizon twilight band gated on camera-inside-umbra with intensity from distance-to-umbra-edge; default-path star reveal (own ratification + both-backend consumer). **Out of scope: Baily's beads, diamond ring, shadow bands** (beads need a lunar limb-elevation profile — NASA LRO data is public domain if ever pursued) | Scene A totality frames: corona present only at M≥1, horizon warm band all azimuths, no corona leakage during partial phases | Totality looks like the photographs: corona, twilight ring, (optionally) stars |

**Sequencing vs in-flight work:**
- S1 multiplies final output alpha, independent of bake internals → lands cleanly **before** C12-15/16/17, and *should* land before C12-18/C11-160 so its continuity probe exists as the regression gate protecting that PP refactor. When C12-18 lands, the factor additionally multiplies the PP bloom input (else the screen-space halo survives totality).
- Under C12-19 HDR, the factor applies **pre-AutoExposure** or AE re-brightens the eclipse (the queue's own Batch-364-class warning).
- C11-115 (ALPHA_BLEND, RESOLVED-as-decision) is pre-neutralized by the alpha-multiply design. Do not re-open.
- S3 touches files owned by Campaign 13 (C13-01 IN PROGRESS, C13-39/C13-06 pending; working tree dirty with exactly those files) — per the C12 queue's own coordination rule (`QUEUE_2026-07-19_CAMPAIGN12.md:136`), file it as a C13 rider or sequence after C13-39. S1/S2/S4/S5 touch no C13-owned file.
- No prior eclipse work exists to conflict with (repo-wide grep: 3 incidental doc mentions). `FEATURE_INVENTORY.md` gains the eclipse entry (§D → §C at S1 start) per Principle 9.

---

## 5. Honesty section

**Approximation vs physical:**
- The camera-anchored `sunVisibleFraction` multiply on scene light is first-order: physically, light transport is linear in source power, so the multiply itself is exact — the approximation is *spatial* (one factor for the whole scene). From orbit outside the shadow cone the factor is 1.0 and the day side is correctly unchanged; the spatially-correct surface shadow is S5's per-fragment term. What no per-pixel scaling can represent: the umbral sky lit by multiple scattering from outside the umbra (nonlocal; Bruneton LUTs assume one un-occluded sun). We tune a twilight ambient floor to the measured ~5 lux instead. The published exact-ish fix is Schneegans CGF 2025's precomputed eclipse-shadow Bruneton extension (MIT, CosmoScout) — noted as a possible future L-item, not proposed now.
- Limb darkening via C12-15's quadratic law is a parameterization (Pierce/Slaughter-class fits are ±2.5-4%); good enough that the remaining error is invisible next to the 2× uniform-disc error it removes.
- The extinction ramp constants (tau=1 near z≈10-15 km, ramp span 0-60 km, ~8′ residual refraction at z≈12 km) are derived from standard scale-height physics, not measured curves — the cited sources anchor sea-level values (34′, 2-3 min post-set visibility). The probe metrics bind on continuity and monotonicity, not on these constants.
- Refraction (apparent lift + disc flattening) is deliberately deferred: it is second-order to killing the pop.
- The pre-glow "minutes" timeline is UNCONFIRMED-derived (no published stopwatch figure); qualitative glow-before-disc is confirmed by astronaut photography.

**Perf cost:** negligible CPU — cone math ~50 f64 flops + one 32-64-point quadrature ~200 flops + optional 64-entry LUT bake ~4K flops per frame, against already-computed ephemerides (`Scene.js:5754-5772`). GPU: one uniform multiply per chokepoint; the S5 per-fragment term (2 acos + sqrt + LUT sample) runs only behind a CPU penumbra-intersects-view gate on a uniform branch (uniform control flow, no divergence). No new ShaderDefine bits anywhere (registry exhausted; exit-gate item 5).

**The one real cost/risk item — C13 IBL debounce vs eclipse timescales:** every IBL refresh trigger is keyed to sun *direction* or cloud state, never illumination intensity — `SUN_REFRESH_EPSILON_SQ` ≈ 0.29° of arc ≈ 70 s of sun motion (`WebGPUDynamicEnvironmentMapManager.ts:658-663`), coverage epsilon 1/256, plus Batch-743's quantized revision grids (`WebGPUProceduralCloudRenderer.ts:486-508`). An eclipse collapses illumination ~2 orders of magnitude in 2-4 real minutes (seconds at probe clock multipliers) while the sun barely crosses one epsilon step — without S3's quantized eclipse input, the IBL cube stays stale-bright through totality. The quantization grid (~1/64) bounds re-bakes to ~tens per eclipse. The temporal EMA (`ENV_TEMPORAL_ALPHA = 0.15`, ~6-frame e-fold) is already fast enough. This is also why S3 must be coordinated with C13, not landed around it.

**Risk to existing looks:** S1 is visually inert except during actual occlusion geometry (identity 1.0 otherwise; existing cull guards reproduced for 2D/CV/translucent-globe). S2 changes default pixels *only during eclipse instants* — flagged for ratification below rather than assumed.

---

## 6. Maintainer decisions (only genuine ones)

1. **S2 default-on ratification.** Eclipse dimming of scene light/atmosphere is a default-pixel change during eclipse instants (identity in all other frames). Under the governing principle it is additive realism, not a parity risk — but it alters what a user sees at a real eclipse datetime today. Ship default-on with an `AtmosphericConditions.lighting` toggle (`enableEclipse`), or default-off? **Recommendation: default-on + toggle.**
2. **AutoExposure at totality** (interacts with C11-161/C12-19): real cameras re-meter and wash out the darkness; human impression keeps the plunge. Preserve the darkness (AE-exempt or AE-clamped during eclipse), or let AE compensate? Must be an explicit decision — the wrong default silently erases the whole effect. **Recommendation: preserve; revisit under C12-19's AE lanes.**
3. **Default-path star reveal at totality (S6):** needs a new default-on consumer of skyBrightness on both backends — exactly the multiplier class the C12 exit gate audits. Ratify as its own both-backend feature, or leave stars opt-in via `enableStarBrightnessModulation`?
4. **S3 routing:** C13 rider now, or sequenced after C13-39? (Files are actively owned and dirty; the debounce gap is real either way.)
5. **Sequencing pin:** confirm S1 lands *before* C12-18/C11-160 so the continuity probe becomes the regression gate for the sun-PP refactor (this reorders C12-29 ahead of parts of W4 despite its later number).
6. **Ambition ceiling:** analytic dual-cone (this plan) now, with Schneegans CGF 2025-style precomputed eclipse-shadow Bruneton extension (MIT/CosmoScout reference) recorded as a possible future L-item — or commit to the precomputed path from the start? **Recommendation: analytic now; it reaches the acceptance bar (both 2026/2027 instants + 2024 shapefile match) at a fraction of the cost.**


### §6a Maintainer rulings (2026-07-24, all six answered — recorded at Batch 758)

1. **E1 RATIFIED: default-on.** "This is the actual simulation that needs to be there." Ship S2 default-on with the `enableEclipse` toggle.
2. **E2 RATIFIED with scope add:** human-eye impression (preserved darkness) is the DEFAULT; camera-autoexposure compensation becomes a **togglable alternative mode** (new small item: an eclipse-AE mode switch, to be designed with C12-19's AE lanes — the AE-exemption is the default state, the switch opts INTO camera behavior).
3. **E3 RATIFIED with redirection:** no light-pollution modeling; S6's star reveal works through the EXISTING star-brightness-at-night machinery — and the maintainer additionally rules that machinery should **default ON at a countryside-like level** (today `enableStarBrightnessModulation` defaults `false`, `AtmosphericConditions.js:404`). Scope: flip the default + pick a countryside strength, as a both-backend default-path change routed through the C12 exit-gate audit (it becomes part of the audited multiplier set, not an exception to it).
4. **E4 RATIFIED:** the orchestrator takes over ALL Sol in-flight work completely (see the global Sol ruling: Option B — the orchestrator owns Campaign 13 outright). S3 lands as a C13 rider under single ownership, sequenced after C13-39.
5. **E5 RATIFIED:** the S1-before-C12-18/C11-160 sequencing pin is confirmed.
6. **E6 RATIFIED:** analytic dual-cone now; the precomputed Bruneton-extension path stays a recorded future L-item.

---

Key repo anchors verified this session: `Scene.js:3803-3830`, `Sun.js:312-337` (BV radius = `SOLAR_RADIUS*(1+glowLengthTS)`), `WebGPUEnvironmentRenderer.js:612-619` (BV-less sun command), `AtmosphericConditions.js:363-395` (`enableStarBrightnessModulation` default false — the "stars free" claim from Lane 3 is corrected above), `QUEUE_2026-07-19_CAMPAIGN12.md:59` (C12-29 row) and exit-gate items 2/5. Lane 4's sun-BV formula (`1+2*glowLengthTS`) was wrong; magnitude (≈4.2e9 m) was right. Lane 3's corona-falloff citation is superseded by the REFUTED correction (Baumbach −17/−7/−2.5).