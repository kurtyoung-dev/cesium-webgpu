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
> geomagnetic storms) — RESEARCH-VERIFIED 2026-08-02; Campaign 15 `C15-00` complete; implementation
> not started** (see Phase F below, [`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md),
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

- **Phase F — Aurora + space weather (solar / geomagnetic storms).
  [RESEARCH-VERIFIED 2026-08-02; CAMPAIGN 15 PLANNED; IMPLEMENTATION NOT STARTED]**
  Maintainer ask (2026-07-26): render the **northern and southern lights**, permit manual solar and
  magnetic storms, and investigate live space-weather data. `C15-00` completed the research and
  authored the execution authority:
  [`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md). Campaign 15 is not launched;
  runtime rows `C15-01..08` remain pending. The earlier Campaign-14 label was a documentation collision:
  **Campaign 14 remains Dynamic Ocean & Wind under its ratified O5 hold.**
  **SUPERSEDED by R1 (2026-08-06) — annotated 2026-08-07 by the docs-reconciliation pass:**
  the O5 hold is no longer "C11 + C12 + C13 all done". R1 binds O5's undefined word "done"
  to a **pragmatic bar — C12 complete + C13 Gate B green** — and Campaign 14 does NOT wait
  for C11-137 certification, C13 Gates A/C/D, or the unstarted bodies of either campaign
  (ruling text in [`DEFERRED_WORK.md`](DEFERRED_WORK.md), §"2026-08-06 - MAINTAINER RULINGS").
  **`C13-GATE-B` CLOSED green at Batch 866 (`58af0d1819`), so the remaining C14 gate is C12
  completion ONLY.** The Campaign-14/15 identity statement above is unaffected.

  **Supersedes the scattered sky-dome backlog.** `FEATURE_INVENTORY.md:1133/1135`,
  `WEBGPU_MIGRATION_BACKLOG.md:708/722`, `CELESTIAL_ATMOSPHERE_DESIGN.md:65`, and the archived
  2026-03-31 rows assume a procedural sky-dome shader. That cannot be overhead from the ground and
  above the limb from orbit. The verified architecture is an ellipsoid-relative, camera-relative/RTE,
  analytic **layered emission volume over 80–600 km**, with independent altitude profiles for the
  427.8 nm lower-edge nitrogen emission, dominant 557.7 nm green oxygen layer, and diffuse 630.0 nm
  red upper layer. NOAA describes typical aurora as 80–500 km and NASA places green near
  100–200/250 km and red above 200 km; the 600 km cap is a bounded analytic envelope, not a claim that
  typical aurora fills it. Sources: [NOAA Aurora](https://www.spaceweather.gov/phenomena/aurora) and
  [NASA Auroras](https://science.nasa.gov/sun/auroras/).

  **Geomagnetic frame and night gate.** The baseline is WMM2025's centered dipole: **9.21°** from the
  rotation axis, with the north geomagnetic pole at **80.79°N geocentric (80.85°N geodetic),
  72.76°W** at epoch 2025.0 ([NCEI WMM](https://www.ncei.noaa.gov/products/world-magnetic-model),
  [pole reference](https://www.ncei.noaa.gov/products/wandering-geomagnetic-poles)). This is not the
  magnetic dip pole. The synthetic oval must be non-circular, noon/midnight asymmetric, and
  activity-dependent; a geographic ring is wrong. Darkness is evaluated at each shell sample or its
  ellipsoid footprint. The camera-local star fade cannot classify a globe-spanning volume across a
  terminator, though its shared sky-brightness thresholds can inform the local transfer curve.

  **Drivers and non-double-count rule.** A normalized, provenance-carrying manual/synthetic driver
  ships before network ingest. Valid live OVATION owns the spatial extent and intensity. The
  operational OVATION product already consumes L1 solar-wind/IMF data and may fall back to Kp, so an
  active grid is never multiplied again by Kp or Bz. The official product documents a 30–90 minute
  forecast and a no-lead Kp fallback; the mutable snapshot is
  [`ovation_aurora_latest.json`](https://services.swpc.noaa.gov/json/ovation_aurora_latest.json).
  Planetary Kp uses the post-March-2026 object schema `{time_tag, Kp, a_running, station_count}` at
  [`noaa-planetary-k-index.json`](https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json).

  **Current feed lifecycle.** The legacy `/products/solar-wind/{mag,plasma}-*.json` family was
  scheduled for removal on 2026-04-30. Use only the replacement one-minute
  [`rtsw_mag_1m.json`](https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json) and
  [`rtsw_wind_1m.json`](https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json), preserving each
  row's source, active, and quality state and the renamed proton fields. Old 3-/7-day consumers must
  retain the one-day stream themselves. The authoritative migration and schema mapping is
  [NWS SCN 26-21](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf).
  GOES one-minute X-ray flux is a separate **solar-flare state**, with source discovery through
  [`instrument-sources.json`](https://services.swpc.noaa.gov/json/goes/instrument-sources.json); a
  flare does not directly expand the geomagnetic oval.

  **Rights boundary.** Do not infer blanket NOAA/JHU snapshot rights merely from a public endpoint.
  Nothing is bundled until its exact source, transformations, attribution, and product-specific terms
  are recorded in `LICENSE.md`. Kyoto WDC explicitly disallows commercial applications of its
  geomagnetic indices ([usage rules](https://wdc.kugi.kyoto-u.ac.jp/wdc/Sec3.html)), so Campaign 15
  has no built-in Kyoto Dst provider and no bundled Dst snapshot; only a caller-owned numeric override
  is in scope.

  **Rendering and measurement.** WebGL and WebGPU consume the same density/emission kernel. Default
  OFF means zero passes, allocations, jobs, animation, requests, uploads, and bind-group churn. The
  enabled volume is depth-tested and visibility-demanded without removing line layers, hemispheres,
  RTE, or existing effects for speed. A faint structured additive signal is invisible to a band mean;
  certification uses point/structure or isolated-component differences plus moving-camera altitude
  routes. Full task order and gates are in the Campaign-15 queue.

## Dependencies + sequencing

- Phases A–E sit after weather-ingest Phase 1–2 (the T/Td/RH/visibility grid). **Phase F is the
  exception:** its geomagnetic/space-weather spine is independent, and its manual driver requires no
  network or atmospheric-weather field.
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
