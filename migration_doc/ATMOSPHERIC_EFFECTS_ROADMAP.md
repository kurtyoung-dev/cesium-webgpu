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
> 421 scatter rework). Phases D–E remain (D/E plug into the 417a hierarchy as their backend).

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
- **Phase D — Cold optics (halo / sun-dogs / pillars).** Ice-crystal sky overlay gated on sub-freezing T
  + cirrus. The high-wow "this looks like a real cold sky" effect. (~4-6 days.)
- **Phase E — Precip + snow.** Precip-type → rain/snow particles + optional ground accumulation. Larger;
  schedule after the optics. (~1-2 weeks.)

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
