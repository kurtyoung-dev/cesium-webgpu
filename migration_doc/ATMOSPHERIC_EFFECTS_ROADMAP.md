# Atmospheric Effects Roadmap — heat / humidity / cold (driven by real weather)

**Status:** PLANNING (2026-06-26). No effect modules built yet; partial scaffolding exists.
**Goal (user):** beyond clouds, render the *atmosphere's* response to conditions — **high heat**
(shimmer/mirage, thermal haze, convective bias), **extreme humidity** (haze, reduced visibility,
fog/mist), **extreme cold** (ice fog, halos/sun-dogs, crisp deep-blue air, snow). These light up
once real weather can be ingested (temp / dewpoint / RH / visibility), so this is the natural
**follow-on to the weather-ingest MVP** ([WEATHER_DATA_INGEST_ROADMAP.md](WEATHER_DATA_INGEST_ROADMAP.md)).

---

## What already exists (the seams to build on)

- **`scene.globe.atmosphericConditions.weather.{humidity, airQuality}`** (Phase 1.4 facade,
  `AtmosphericConditions.js` ~L959). `humidity` (0=dry desert … 1=tropical) ALREADY modulates fog
  density (`Fog.js` ~L170: `density *= 1.0 + (humidity - 0.5)`); `airQuality` is the dust/haze knob.
- **`scene.enableWeather` / `weatherType` / `weatherIntensity`** (`Scene.js` ~L1078) — a weather-state
  spine already plumbed to the sky/fog/star shaders.
- **Atmosphere tint** — `globe.atmosphere{Hue,Saturation,Brightness}Shift`, rayleigh/mie, `scene.fog`.
- **V11 cloud genus** (`globe.cloudType` → `CloudTypeProfile`) — convective bias has a target.
- **WebGPU post-process chain** (`WebGPUPostProcessPipeline`) — where screen-space effects
  (shimmer, AO, bloom, TAA, aerial perspective) already plug in; new effects follow that pattern.

**The gap:** there is **no temperature/dewpoint-driven effects layer** — nothing maps "it is 40 °C /
−30 °C / 95 % RH here" to a visual. That layer is what this roadmap adds.

---

## Effects by condition

### Extreme humidity (cheapest — mostly drives existing knobs)

- **Reduced visibility / haze** — high RH → denser fog (already wired via `weather.humidity`),
  milkier + desaturated sky (atmosphere saturation/brightness shift down), reduced blue scatter.
- **Fog / mist** — small dew-point spread (T − Td) + cooling → radiation/advection fog. Start with the
  existing `scene.fog` driven by `(T−Td)`; later a ground-hugging **volumetric ground fog** (a thin
  low-altitude variant of the cloud raymarcher, or reuse `WebGPUVolumetricFogRenderer`).
- **Low stratus / mist decks** — bias `cloudType` → STRATUS + low `cloudLayerBottom` at high RH.

### High heat

- **Heat shimmer / mirage** — a screen-space **refraction distortion** post-process near the hot
  ground (UV warp by an animated noise whose amplitude ↑ with surface temp + ↓ with altitude/distance).
  New `WebGPUHeatShimmerEffect` in the post-process chain (mirror an existing effect's structure).
- **Thermal haze** — elevated low-atmosphere turbidity / slight brown tint (atmosphere + fog tint).
- **Convective bias** — high temp / CAPE → bias `cloudType` toward CUMULUS → CONGESTUS → CUMULONIMBUS
  (ties into V11 + the weather-map G channel once ingest populates it).

### Extreme cold

- **Ice fog / diamond dust** — a cold variant of the fog/mist with a faint sparkle (sub-freezing T +
  high RH). Reuse the fog path with an "ice" tint + optional glint.
- **Atmospheric optics** — **22° halo, sun dogs, light pillars** from ice crystals: a sky-shader /
  sun-overlay effect gated on sub-freezing T + cirrus presence. Distinct, recognizable, and high-wow.
- **Crisp clear air** — cold dry air → high visibility, deep saturated blue (raise rayleigh purity,
  drop turbidity/haze).
- **Snow** — precip type (weather-map A / WMO `ww`) → a particle system + optional ground accumulation
  (bigger scope; later phase).
- **Nacreous / polar-stratospheric clouds** — exotic high-latitude winter; a stretch.

---

## Architecture

A backend-agnostic **`AtmosphericEffects`** layer (Scene-level, Principle 2) that maps the ingested
scalar field (T, Td/RH, visibility, wind, precip type) → two kinds of output:

1. **Existing knobs** (no new renderer): fog density/color, atmosphere hue/sat/brightness, `cloudType`
   bias, `cloudLayerBottom`. Cheapest, ship first.
2. **New WebGPU effect renderers** (FeatureRenderer pattern, plug into the post-process chain):
   `WebGPUHeatShimmerEffect` (screen-space refraction), an **ice-optics** overlay (halo/sun-dogs),
   and a **ground-fog volumetric** (or extend `WebGPUVolumetricFogRenderer`).

Config on the existing `atmosphericConditions` facade (e.g. `…atmosphericConditions.thermal.shimmer`,
`…optics.halo`), each `undefined` → no effect (invisible until set), so it's opt-in and byte-neutral by
default. WebGL gets the knob-driven subset; the screen-space effects are WebGPU-first (with graceful
no-op on WebGL, like the procedural clouds).

---

## Phased plan

> **STATUS:** Phase A **SHIPPED** (Batch 415). The **unified conditions→effects hierarchy + auto master**
> **SHIPPED** (Batch 417a) — `atmosphericConditions.effects.{shimmer,groundFog,optics,precipitation}` nested
> with a master `effects.auto` that derives every effect from the weather (`computeAtmosphericEffects`);
> off by default (byte-neutral). Phase B **SHIPPED** (Batch 417b). Phase C **SHIPPED** (Batch 420 wiring +
> 421 scatter rework). Phase D **SHIPPED** (Batch 422 — 22° halo + sun-dogs). Phase E **WIRING SHIPPED**
> (Batch 423 — `effects.precipitation` → the existing WebGPU weather-particle renderer; data-driven WMO
> weather-code selection from ingest is deferred). **Phase F — aurora + space weather (solar /
> geomagnetic storms) — ADDED 2026-07-26 by maintainer ask; PLANNED, not started** (see Phase F below
> and `EPIC-AURORA-SPACE-WEATHER` in `DEFERRED_WORK.md`). Phases A–E are shipped; **F is the only
> unbuilt phase in this roadmap.**
>
> **Forward-looking quality roadmap:** the opt-in (parity-default) improvement plan for the sky / cloud /
> fog / reflections subsystems — including the deferred cube-sky / dynamic scene-content env map (C2-25) —
> lives in [ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md](ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md). This roadmap (A–E)
> is shipped; that doc is what to build next, each item behind a flag so WebGL parity stays the default.

- **Phase A — Conditions→knobs mapper (no new renderer). [SHIPPED Batch 415]** An `AtmosphericEffects` module
  mapping `{T, Td, RH, visibility}` → fog density/tint + atmosphere sat/brightness + `cloudType`/
  `cloudLayerBottom` bias. Drives the *existing* WebGL+WebGPU knobs. Cheapest, highest ratio of
  realism-per-effort.
- **Phase B — Heat shimmer (WebGPU screen-space). [SHIPPED Batch 417b]** `WebGPUHeatShimmerEffect` — a
  single-pass screen-space animated value-noise UV-warp, band-concentrated to the lower frame (hot ground),
  gated on `scene.heatShimmerEnabled` (the 417a auto-master sets it from temperature 25→45 °C; manual
  override works), intensity from `scene.heatShimmerIntensity`. Mirrors the GodRay post-process pattern
  (effect class + WGSL + pipeline/stage-collection wiring); inserted pre-TAA/pre-tonemap; time fed as
  `performance.now()` epoch-elapsed seconds (f32-safe); `requestRender` each frame while enabled. Probe-
  verified (Principle 8): `probe-heat-shimmer.mjs` — lower-frame warp 79% vs sky 0%, animated 14.7%/350 ms,
  off-stable 0%; lower-frame crop reads as a gentle wavy heat-haze at default intensity.
- **Phase C — Ground-fog volumetric. [SHIPPED Batch 420 + 421]** Extended `WebGPUVolumetricFogRenderer` with
  a near-surface density band (`intensity·peakDensity·exp(-altitude/bandHeight)`) gated on
  `effects.groundFog` (417a auto-master derives it from the dew-point spread); own-activation path (runs even
  with the fog master off). Landing it ran the froxel renderer's compute+composite for the FIRST time,
  surfacing + fixing a chain of latent bugs (Batch 420: WGSL reserved words `enable`/`out`, composite depth
  sample-type + log-depth decode, a degenerate fullscreen-triangle composite vertex shader) AND the real
  dynamic-range blocker (Batch 421: Henyey-Greenstein forward-peak overflowing f16 → whiteout; fixed via
  HG clamping + an energy-conserving single-scatter integration `inscatter = source·(1-exp(-σ·d))`).
  Probe-verified (Principle 8): `probe-ground-fog.mjs` — graded valley mist (terrain visible through the
  haze, not a whiteout), ground-concentrated, intensity 0.3/0.6/1.0 monotonic, 0 device errors, default off
  byte-neutral. This rework unblocked WebGPU volumetric fog generally, not just ground fog.
- **Phase D — Cold optics (halo / sun-dogs). [SHIPPED Batch 422]** `WebGPUColdOpticsEffect` — a single-pass
  screen-space sky overlay (mirrors the heat-shimmer/godRay pattern) drawing the **22° halo** (gaussian ring,
  warm-red inner → blue-white outer) + **sun-dogs/parhelia** (brighter spots at ±22° on the parhelic circle).
  Reconstructs the per-pixel world view ray (FP32-safe, AerialPerspective method) + reads
  `uniformState.sunDirectionWC`; angle `θ = acos(ray·sun)`; sky-only via the depth gate; faded out when the
  sun is below the horizon; additive in HDR pre-tonemap. Gated on `scene.coldOpticsEnabled`/`Intensity` —
  the 417a auto-master pushes them from `effects.optics` (sub-freezing T). Default OFF, byte-neutral.
  Probe-verified (Principle 8): `probe-cold-optics.mjs` — a complete circular ring centred on the sun (read
  the PNG: textbook 22° halo + the two sun-dogs, sky-only, terrain not overdrawn), 5/8 sectors lit, ring
  brighter than interior, OFF-stable, 0 device errors. **Light pillars SHIPPED Batch 442** (COLD-OPTICS-HQ, improvement-plan 4.10): plate-crystal vertical pillars through the sun + sun-dogs, behind `effects.optics.advanced` (default off), alongside 22°+46° spectrally-dispersed halos + upper-tangent arc.
- **Phase E — Precip + snow. [WIRING SHIPPED Batch 423]** Connected the unified `effects.precipitation`
  leaf (and the `atmosphericConditions.weather` facade) to the existing `WebGPUWeatherRenderer` particle
  system (rain/snow/fog/hail already shipped). Three pieces: (1) the env-effects dispatch now builds the
  renderer's `CesiumWeatherConfig` from the flat `scene.weather*` fields (the SAME fields the facade writes)
  instead of passing `scene` raw — pre-Batch-423 it read `scene.enabled`/`.type` which don't exist, so the
  renderer's `enabled` gate always returned early and NO particles ever rendered; (2) the render half now
  resumes the default canvas pass (env effects run after post-process, Batch 127, which ends the active
  pass) and the weather render pipeline declares a single canvas-format alpha target instead of the 2-target
  scene-FB MRT layout (the phantom rgba16float slot-1 made the pipeline incompatible with the 1-attachment
  canvas pass → "attachment state not compatible", the latent reason the render never drew); (3) the 417a
  auto-master pushes `effects.precipitation.{enabled,type,intensity}` to the flat scene fields. New
  `PrecipitationType` enum (`0=none,1=rain,2=snow,3=fog,4=hail`) + `precipitationTypeToString` in
  `AtmosphericEffects.ts` is the single home for the index→string mapping. Default OFF / byte-neutral.
  Probe-verified (Principle 8): `probe-precip-wiring.mjs` — drives precip through BOTH the auto hierarchy and
  the direct facade; snow renders strongly (4272-px union footprint), rain renders subtly (≈1000 px) but
  clearly beats the 0-px auto-off control; rain ≠ snow; 0 device errors. **Deferred:** data-driven WMO
  weather-code → precip-type selection from the weather-ingest cube, and optional ground accumulation.

- **Phase F — Aurora + space weather (solar / geomagnetic storms). [PLANNED 2026-07-26, not started]**
  Maintainer ask (2026-07-26): render the **northern (and southern) lights**, and be able to **trigger
  solar and magnetic storms**; investigate whether open space-weather data exists comparable to the
  atmospheric-weather ingest. Tracked in `DEFERRED_WORK.md` as **`EPIC-AURORA-SPACE-WEATHER`**.

  **Supersedes the existing scattered aurora backlog entries** — `FEATURE_INVENTORY.md:1133/1135`,
  `WEBGPU_MIGRATION_BACKLOG.md:708/722`, `CELESTIAL_ATMOSPHERE_DESIGN.md:65`, and the archived
  2026-03-31 audit rows — all of which scope it as *"procedural shader on the sky dome, 2–3 days"*.
  **That architecture is wrong for this fork** and the estimate follows from it: on a globe the camera
  can orbit, the aurora is a **volumetric emission shell at 100–400 km altitude** that must stand
  *above the limb* when viewed from space and *overhead* when viewed from the ground. A sky-dome
  texture cannot do both. Do not re-scope from those entries; they are pre-globe-orbit assumptions.

  **Why this is Phase F and not a bolt-on:** the physics is genuinely a *space*-weather layer, not an
  atmospheric one. It is driven by geomagnetic activity, not by T/Td/RH, so it needs its own data
  spine — but it lands in the same `effects.*` hierarchy and the same auto-master pattern that Phases
  A–E established, so the seam already exists.

  **Rendering (what the effect actually is).** Auroral emission is line emission from atmospheric
  species excited by precipitating particles, so the colours are fixed and non-negotiable if it is to
  look right: **557.7 nm green** (atomic oxygen, ~100–150 km — the dominant band), **630.0 nm red**
  (atomic oxygen, >200 km — the high, diffuse crown that appears in strong storms), and **427.8 nm
  blue/violet** (ionised molecular nitrogen, lower edge). Curtains and rays follow **geomagnetic field
  lines**, which is why they appear as vertical structure — a plain vertical extrusion reads as
  plausible from the ground and obviously wrong from orbit. The oval is centred on the **geomagnetic**
  pole, ~11° off the geographic one, so a geographic-latitude oval will sit visibly in the wrong place.
  A **tilted-dipole** approximation is cheap and adequate for oval placement and curtain direction;
  full IGRF is not needed for a visual.

  Architecturally this is a sibling of the existing volumetric raymarchers, not of the screen-space
  post-process effects: emissive, additive, unlit, depth-tested against the globe, and **gated on
  night** — reuse the same solar-elevation edge the star field already derives (`computeStarDayFade` /
  the `SkyBrightness` sun term), since aurora and starlight share the "is it actually dark here"
  question. Expect the same measurement trap the eclipse star-reveal work hit: **a faint additive
  signal over a large band is invisible to a band-mean statistic** — gate on point/structure metrics
  or on an isolated-component difference, never on a mean.

  **Storms (the trigger the maintainer asked for).** Geomagnetic activity has one dominant visual
  consequence and it is the *equatorward expansion of the oval*: quiet conditions put the oval near
  ~67° magnetic latitude, and a severe storm drags it toward ~50°, which is what makes aurora visible
  from mid-latitudes. So "trigger a storm" is principally **one scalar (Kp, or Dst) driving oval
  latitude + intensity + the red-crown fraction**, plus optional flourishes (substorm onset brightening
  and poleward surge, ray/curtain turbulence). Design it as a **storm-state scalar with a manual
  override and an optional data-driven source**, mirroring `effects.auto` — the same shape as every
  other effect in this roadmap.

  **Open data — and this looks unusually clean.** The atmospheric-weather ingest already established
  the pattern (NOAA NWS EDR → normalized scalars); the space-weather equivalent is **NOAA SWPC**, and
  because it is a **US federal government product it is public domain**, which is the same licensing
  basis that made the weather ingest and the EGM2008 geoid bundle-safe. Candidates to verify:
  - **Planetary K-index (Kp)** — the storm scalar, near-real-time JSON.
  - **OVATION Prime auroral-power / probability grid** — SWPC publishes a lat/lon aurora forecast grid.
    This is close to a drop-in for the oval: a grid the renderer samples, exactly like `weatherTex`.
  - **Solar wind** (DSCOVR / ACE plasma + magnetometer) — speed, density, and **Bz**, the component
    that actually controls coupling; a southward Bz is the real "storm is starting" signal.
  - **GOES X-ray flux** — solar flare class (C/M/X), for the *solar* half of the ask.
  - **Dst index** (Kyoto WDC) — **licence must be checked before use**; Kyoto is not a US federal
    product and does not inherit public-domain status. Kp from SWPC is the safe default.

  Same house rules as the weather ingest: nothing bundled whose terms are not stated in `LICENSE.md`'s
  Bundled Engine Assets section, and the renderer consumes **normalized scalars** so any backend
  (live SWPC, a baked historical event, or a purely synthetic storm) can drive it. A synthetic/manual
  driver should ship first — the effect must be demonstrable and testable without a network call.

  **Sequencing note:** this is genuinely independent of the T/Td/RH ingest, so it does not queue behind
  weather Phases 1–2. Its real prerequisite is a **night-side gate that is already trustworthy**, which
  the C12 celestial work has now established.

## Dependencies + sequencing

- Sits **after weather-ingest Phase 1-2** (the T/Td/RH/visibility grid). Phase A can start NOW against
  the existing `weather.humidity` scalar and graduate to the ingested field.
- Reuses V11 (`cloudType` bias), the post-process chain (shimmer/optics), and the fog/atmosphere knobs.

## Caveats

- Screen-space shimmer + optics are **WebGPU-first** (the post-process chain is the WebGPU pipeline);
  WebGL gets the knob-driven subset. Keep the new renderers gated + no-op on WebGL (like the clouds).
- Halos/sun-dogs are an **optical approximation** (billboarded ring + parhelia at 22°), not a full
  crystal simulation — calibrate against reference photos (Principle 8: READ the probe PNG).
- Don't over-couple to one data source: the mapper consumes normalized scalars, so any weather backend
  (EDR/WCS/METAR) feeds it.

## Pointers

- Seams: `Scene/AtmosphericConditions.js` (the `weather` + future `thermal`/`optics` facades),
  `Scene/Fog.js` (humidity→density), `Scene/Scene.js` (`enableWeather`/`weatherType`),
  `Renderer/WebGPU/WebGPUPostProcessPipeline.ts` (effect chain), `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`,
  V11 `Scene/CloudTypeProfile.js`.
- Companions: [WEATHER_DATA_INGEST_ROADMAP.md](WEATHER_DATA_INGEST_ROADMAP.md) (the data that drives this),
  [WEATHER_RECREATION_ROADMAP.md](WEATHER_RECREATION_ROADMAP.md) (cloud side).
