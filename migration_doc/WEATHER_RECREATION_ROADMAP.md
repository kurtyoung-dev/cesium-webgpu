# Weather-Recreation Roadmap

**Goal:** recreate global weather events — recognizable historical storms, forecasts,
and dynamic cloudscapes — from historical (reanalysis/forecast) **or** procedural data,
rendered on the globe.

Produced 2026-06-24 by a 7-thread design-research workflow (`weather-recreation-roadmap`)
grounded in the current code, plus main-loop architecture verification. Threads:
cloud-taxonomy↔raymarcher mapping, weather data sources + ingestion, weather-field
architecture, time-evolution/advection, beyond-clouds phenomena, performance/streaming,
CesiumJS API fit.

---

## North star

Drive the WebGPU volumetric cloud raymarcher from a **spatial, time-indexed weather field**
instead of single global scalars. The atmosphere becomes data-driven and clock-bound: a
named hurricane replays from ERA5/GFS reanalysis, clouds vary by WMO genus across the sky,
and weather advects smoothly with the timeline — all on a **backend-neutral data core** that
degrades honestly to WebGL billboard/imagery presentation.

## Current state (grounded)

- The raymarcher (`ProceduralClouds.wgsl` + `WebGPUProceduralCloudRenderer.ts`) is **WebGPU-only,
  single-deck** (one 1500–4000 m shell), reads only scalar globals: `coverage` at
  `ProceduralClouds.wgsl:129`, `density` at :141, motion on `cloud.time = performance.now()`
  (**NOT clock-bound**) at :122. No weather map, no texture input, no cloud-type field, no
  temporal keyframes.
- **The seam:** `cloudDensity()` (`:119-142`) already receives world position. The bind group is
  `texture(0)=color, texture(1)=depth, sampler(2), uniform(3)` (4 bindings); the 64-float UB uses
  ~52 → headroom. So a **weather map is a clean texture-binding extension, not a rearchitecture** —
  add `texture(4)` + sample it in `cloudDensity()` to make coverage/type/density per-position.
- `Scene/CloudType.js` is a real-but-stub enum (`CUMULUS:0`), shared with the billboard
  `CloudCollection`. `AtmosphericConditions.js buildClouds()` is a stateless get/set thunk over
  `Globe.*` scalars — no data, no time axis.
- **Strong reuse precedent:** `WebGPUVolumetricFogRenderer` (3D-texture bake + compute + quality
  bands + snapshot-freeze) is the bake template; `BrightStarCatalog`/`StarFieldMath` is the
  backend-neutral-data + per-backend-FR two-tier precedent; `FeatureRendererKey` already reserves
  `WEATHER_PARTICLES=31` / `PROCEDURAL_CLOUDS=32`; `VoxelProvider`/`Cesium3DTilesVoxelProvider` fits
  the 3D pressure-level grid; `ImageryProvider`/`DataSource` give provider+entity templates.
- **WebGPU-only reality:** `globe.showProceduralClouds` renders **nothing on WebGL** today
  (`Globe.js` copies the flags but `GlobeSurfaceTileProvider` never reads them; no GLSL volumetric
  path exists, and one is a multi-week port). The data core must be backend-neutral with an
  **explicit documented WebGL degradation**, never a silent no-op (Principle 5).

---

## Phases

### Phase 0 — Clock-bind motion + extend taxonomy (no new data) — **S, do first**
Cheap, independent, non-breaking prerequisites every later phase needs.
- Replace `performance.now()/1000` (`WebGPUProceduralCloudRenderer.ts:217`) with
  `JulianDate.secondsDifference(frameState.time, epoch)` → wind/advection **scrubs, pauses
  (`clock.shouldAnimate=false`), scales (`clock.multiplier`)**. ~5 lines, shippable standalone.
- Extend `Scene/CloudType.js` stub → the **11 WMO genera** (keep `CUMULUS=0` so
  `CloudCollection.validate()` stays valid); add genus→deck + genus→profile-id lookups.
- NEW `Scene/CloudTypeProfile.js` — per-genus table `{deck, heightGradientShape
  (SLAB|BILLOWY|TOWERING_ANVIL), baseDensity, extinction, phaseG (~0.9 ice / ~0.75 water),
  erosionStyle (FIBROUS|PUFFY)}`.
- **Re-land 379a (Perlin-Worley) as the minimal change the revert flagged:** keep the value-noise
  base, swap **only the erosion** to Worley (a shared `CloudNoise.wgsl`) — the gentler path; finish
  379c's remaining multi-octave multi-scatter in `beerPowder`.
- **Demo:** in `probe-cloud-tour`, scrub `viewer.clock` → clouds drift forward/back and freeze when
  paused (today they ignore the clock); Worley-eroded clouds are billowier without the
  over-densification that killed the first 379a attempt.

### Phase 1 — The weather-map seam (C2-16 / 379b) — **M, KEYSTONE**
The ONE shared texture-sampling seam every later phase writes to. Replace global coverage/density
with a per-position sample from a 2D lat-lon RGBA weather map, filled **procedurally (FBM)** so it
ships with zero data pipeline.
- `ProceduralClouds.wgsl`: add `@binding(4) weatherTex` (declare `texture_2d_array<f32>`, depth=1,
  so multi-deck is non-breaking later) + `@binding(5) weatherSampler`; add `worldToWeatherUV()`
  (geodetic lon/lat — Mercator idiom at `GlobeTerrain.wgsl:666`); in `cloudDensity()` sample
  **R=coverage** (→ replaces `:129`), **G=cloud-type-y** (→ remaps the height gradient `:131-134`),
  **B=cloud-base/deck**, **A=density-bias**; keep the (Worley-eroded) FBM as high-freq detail on top;
  gate behind `weatherMapEnabled` so `=0` reproduces today byte-for-byte.
- `WebGPUProceduralCloudRenderer.ts`: BGL entries 4+5, grow `CLOUD_UNIFORM_FLOATS` 64→80
  (weatherTexBounds/frameBlend/enabled/strength), lazy `createTexture` (RGBA8Unorm, default
  1440×720 = ERA5/GFS 0.25°), **version-gated** upload (not per-frame), 1×1 white fallback.
- NEW `Scene/WeatherField.js` — backend-**neutral** data class (CPU buffer W×H×layers×4, version
  counter, setCell/setFromGrid/setFromImage) — single source of truth both backends read; mirrors
  `BrightStarCatalog`/`StarFieldMath`; MUST NOT import `Renderer/WebGPU/` or branch on `isWebGPU`.
- NEW `CloudWeatherMap.wgsl` (or JS FBM generator) — procedural producer so 379b ships data-agnostic.
- `AtmosphericConditions.js`: `clouds.weatherField` leaf + keep `coverage`/`density` as global
  **multipliers** on per-cell values (existing demos keep working).
- **Demo:** one procedural map paints distinct regions — cumulus band here, clear gap there, stratus
  sheet elsewhere — confirmed in `probe-cloud-taxonomy.mjs`; the type channel reshapes the gradient
  (flat stratus vs rounded cumulus).

### Phase 2 — Multi-deck structure + per-type phase — **M-L**
Break the single-deck constraint so cirrus (6–12 km ice), altocumulus (mid), cumulus (low) coexist —
the load-bearing change that makes the 11-genus taxonomy renderable.
- Generalize `executeProceduralClouds` to take a deck descriptor `{layerBottom, layerTop, profileSet}`,
  invoke once per active deck (LOW 0–2 / MID 2–7 / HIGH 5–13 km) via **Path A: three passes**,
  compositing back-to-front (reuses the existing transmittance-over-sceneColor composite); keep the
  current call as the LOW deck so nothing regresses by default.
- Profile-driven height-gradient SHAPE per deck/type; thread `profile.phaseG` into `cloudPhase`
  (replace the hardcoded 0.8/-0.3) and gate `beerPowder` powder per type (ice g≈0.9 + near-zero
  powder; water keeps the powder/silver-lining). Upload the profile table as a uniform array / tiny
  11-row data texture; **lower WMO genus → continuous (deck, type-y, coverage, extinction, phaseG)
  at upload time** so WGSL only sees (deck shell, sampled RGBA, profile table).
- **Demo:** one frame with wispy fibrous cirrus high + dappled altocumulus mid + rounded cumulus low —
  three genera at three altitudes, impossible in today's single shell.
- (Perf follow-up: migrate the hot path to **Path B** — one widened 0–13 km shell + empty-space
  skipping — later.)

### Phase 3 — WeatherSystem API + provider architecture + WebGL degradation — **L**
Stand up the public-API skeleton so data sources are interchangeable behind one contract, dispatched
via **FR-presence (never `isWebGPU`)**, with an honest WebGL fallback. Built before real ingestion so
the contract is fixed first.
- NEW `Scene/WeatherSystem.js` — stateful owner as `scene.weather` (NOT crammed into the stateless
  `AtmosphericConditions` facade); owns a provider collection, a time cursor, the interpolated
  `WeatherField`, `update(frameState,time)`; dispatches via `context.getFeatureRenderer(PROCEDURAL_CLOUDS)`,
  treats null FR as "fall back."
- NEW `Scene/WeatherDataProvider.js` — abstract interface mirroring `ImageryProvider` (rectangle,
  times/`TimeIntervalCollection`, async ready, `requestWeatherGrid`).
- NEW `ProceduralWeatherDataProvider.js` — synthesizes the field from noise+presets, so procedural
  and historical share ONE consumer contract (proves the seam end-to-end, zero data infra).
- **WebGL degradation ladder (gate on FR presence):** default = render the field as a semi-transparent
  equirect cloud-cover **imagery layer** (zero new shader, both backends); opt-in = drive the
  both-backend **billboard CloudCollection** from the grid (coverage→puff density, type→`CloudType`).
  Document in `FEATURE_INVENTORY §C` that volumetric = WebGPU-only, billboard/overlay = WebGL
  degradation — the FIELD is shared, RENDERING parity is N/A by design.
- **Demo:** `scene.weather = new WeatherSystem({ dataSource: new ProceduralWeatherDataProvider(...) })`
  drives volumetric clouds on WebGPU AND the same field renders as a flat overlay on WebGL — split-screen
  shows the same pattern at different fidelity, no `isWebGPU` branch in Scene code.

### Phase 4 — Real historical data: ERA5/GFS pipeline + headline replay demo — **L**
Recreate a recognizable real event.
- `tools/weather-pipeline/` (Python `xarray`+`cfgrib`/`eccodes` or `wgrib2`): decode **ERA5** (CDS,
  free/attribution; TCC→coverage, CLWC+CIWC→density, LCC/MCC/HCC→type, U/V→wind) or **GFS** (NOMADS/AWS
  public-domain, `.idx` byte-range fetch) → regrid equirect → normalize each variable to a fixed
  physical range → emit tiled equirect textures (KTX2/PNG, reuse the C2-1 transcoder) + a per-timestep
  JSON manifest (bounds, variable→channel map, valid-time ISO8601, next/prev URLs). **Lock the
  coordinate/units contract up front.**
- NEW `Era5WeatherDataProvider.js` / `GfsWeatherDataProvider.js` (decode is SERVER-side).
- NEW `Scene/WeatherEventDataSource.js` — storm-track/front ENTITIES (reuses
  EntityCollection+clock+`update(time)` → picking/labels/timeline free).
- **Sandcastle demo "Historical Weather Replay"** — pre-baked manifest for one named storm, `scene.clock`
  tied to `availableTimes`, real coverage driving the volumetric clouds, storm track on the timeline.
- **Demo:** hit play → a named storm's real cloud field sweeps the globe matching the actual satellite
  imagery for that date; scrubbing the clock moves through reanalysis hours. **The north-star deliverable.**

### Phase 5 — Temporal interpolation + advection — **M-L**
Smooth playback between sparse (hourly) data.
- `WeatherField` holds a 2nd (next-timestep) buffer + `blendT`; JS brackets `frameState.time`, prefetches
  B+1, evicts behind (reuse `JulianDate`/`TimeIntervalCollection`/`SampledProperty`).
- `ProceduralClouds.wgsl`: bind keyframe A/B + lerp uniform, `mix()` in `cloudDensity()`; advect the
  weather-map UV by per-cell U/V wind (replaces the single global vector) so cells drift between updates.
- Optional wind-warped (optical-flow) interp if linear cross-fade ghosts during fast motion. Decouple
  rates: texture at DATA cadence, advect/render every frame.
- **Demo:** high `clock.multiplier` → the storm glides and rotates smoothly instead of snapping per
  reanalysis frame; clouds advect with the wind field.

### Phase 6 — Performance hardening + 3D density field — **L-to-XL (own campaign)**
Affordable globally + true vertical structure (cumulonimbus towers, anvils, overhangs).
- **Two-tier model:** small global 2D weather map (Tier 1, ~8–33 MB, always resident) + a **view-local
  3D density bake** (Tier 2, camera-anchored cascaded grid, clipmap/toroidal, snap-to-cell re-bake).
  **Never a uniform fine global 3D grid** (~0.4–0.5 GB — infeasible).
- Compute pre-bake (NEW `WeatherFieldBake.wgsl`, modeled on `WebGPUVolumetricFogRenderer`): materialize
  the 3D density once per bake-cadence; `cloudDensity()`/`lightMarch()` become a single trilinear
  `textureSampleLevel` instead of ~240 FBM evals/pixel/frame — the highest-leverage cost collapse.
- 3D density from ERA5/GFS CLWC+CIWC per pressure level (adopt `VoxelProvider` ELLIPSOID keyframe machinery).
- Temporal reprojection (half-res/checkerboard + history + `previousViewProjection` (DP-H41) + advection
  vector, reject on disocclusion).
- Extend `resolveCloudQuality` with bake-resolution + cadence dials; wire `auto` to
  `VisualPerformanceTargetService`; snapshot-freezable; `getStatistics()`; per-tier memory budgets
  (~150–250 MB medium) + size/null sentinels.
- **Demo:** fly from orbit (whole-Earth cloud field, dramatic limb) down inside a towering cumulonimbus
  with anvil + overhang — same storm both scales, holding frame budget via the bake + reprojection.

---

## ▶ Immediate next step

**Build the weather-map seam (C2-16 / 379b)** — the single 2D lat-lon RGBA texture sampled in
`cloudDensity()` that replaces the global coverage scalar at `ProceduralClouds.wgsl:129`. It's already
queued (M/med) and is **the keystone every other phase writes to** — historical data, temporal keyframes,
the provider API, multi-deck taxonomy, and the perf bake all just change *who fills the texture*; the
shader/renderer/BGL seam is built **once**. Ship it FIRST with a procedural FBM-filled map
(`CloudWeatherMap.wgsl`) so it lands with **zero data-pipeline dependency**. Pair it with the **~5-line
clock-bind fix** (`frameState.time` at `WebGPUProceduralCloudRenderer.ts:217`) — independent,
non-breaking, makes the existing demo scrub correctly. Gate behind `weatherMapEnabled` (=0 reproduces
today byte-for-byte). **Verify per-PNG** in a dedicated session — the 379a revert is the precedent that
these subtle cloud upgrades need visual confirmation, not a clean diff ratio.

## Key risks

1. **WebGPU-only by construction** — no WebGL volumetric twin (a multi-week GLSL RTE-raymarch port nobody
   has started). Risk = a *silent* WebGL gap. Mitigation: backend-neutral `WeatherField` + Phase 3's
   explicit degradation ladder; document the asymmetry (FEATURE_INVENTORY §C, Principle 5).
2. **Per-PNG verification is the real bottleneck**, not code volume. The 379a revert proves these are
   subtle judgment upgrades a clean diff can pass while the eye fails. Budget a dedicated Principle-8
   session per cloud-fidelity phase; don't rush at tail-of-context.
3. **Server-side GRIB2/NetCDF decode** is a hard non-engine prerequisite (Python `eccodes`/`cfgrib`) —
   the browser can't decode GRIB2. Mitigation: `ProceduralWeatherDataProvider` proves the whole rendering
   contract with zero data infra, so real ingestion can lag without blocking the visual pipeline.
4. **Global 3D memory blows up** (~0.4–0.5 GB for a uniform fine global grid). Mitigation: the two-tier
   split (small global 2D + view-local 3D bake) is mandatory.
5. **Coordinate/units contract drift** silently shifts storms by degrees (worse than a crash — looks
   plausible). Mitigation: lock the contract in a design doc before any real-data demo.
6. **Multi-deck is structural, not polish** — cirrus + stratus can't coexist in one shell. Mitigation:
   declare the weather texture `texture_2d_array` (depth=1) from Phase 1 so adding decks is non-breaking.

## Open decisions (need ratification)

1. **Cloud-type channel encoding:** continuous "convective-intensity" scalar (filterable, bilinear-safe)
   at the shader layer + discrete WMO genus only as the JS/data authoring unit. *(Recommended.)*
2. **WebGL degradation default:** flat equirect cloud-imagery overlay (zero new shader) as default +
   type-aware billboard from grid as opt-in. *(Recommended.)*
3. **First real demo:** HISTORICAL replay (ERA5, one named past storm, pre-baked, self-validates vs
   satellite — recommended for v1) vs LIVE forecast (GFS). Global (ERA5/GFS) vs regional (HRRR 3 km).
   **Which storm/event?**
4. **v1 fidelity:** 2D coverage-map (cheap, reuses the Phase-1 seam — recommended) vs full 3D CLWC/CIWC
   density (needs VoxelProvider, heavier — Phase 6).
5. **API back-compat:** keep `clouds.coverage`/`density` as global multipliers on the per-cell map
   (recommended) vs full replace when present.
6. **Multi-deck count for slice 1:** 3 (low/mid/high) vs 2 (low+high, prove structure first); Path A
   (three passes) first, migrate to Path B later. *(Recommended: 2→3, Path A→B.)*
7. **Texture format:** RGBA8Unorm (4 MB @0.25°, normalized top — recommended) vs RGBA16Float (absolute
   cloud-top meters).
8. **Field storage owner:** `scene.weather` (canonical, recommended) vs on `Globe`. Time slaves 1:1 to
   `scene.clock` (recommended for replay) vs independent weather playhead.
9. **Ice-cloud quality bar:** wispy forward-scatter approximation (g≈0.9) for cirrus v1 vs
   physically-flavored ice optics (halos/parhelia — a much larger separate effort).
10. **Default-on vs opt-in:** clouds + fog both default FALSE (B15/B18). Confirm the weather field stays
    opt-in behind a new toggle so unsubscribed users pay zero cost. *(Recommended: opt-in.)*

---

## Summary

The six threads converge on one truth: **the weather-map texture seam (C2-16/379b) is the keystone** —
`cloudDensity()` already receives world position, so replacing the global coverage scalar (`:129`) with a
per-position RGBA fetch is the one seam historical data, temporal interpolation, the provider API, the
multi-deck taxonomy, and the perf bake all reuse without rebuilding. Phase 0 (clock-bind + 11 genera +
re-land Worley) → Phase 1 (procedural weather-map seam, zero data pipeline) → Phase 2 (multi-deck +
ice/water phase) → Phase 3 (WeatherSystem/Provider API + honest WebGL degradation) → Phase 4 (ERA5/GFS
pipeline + named-storm replay) → Phase 5 (temporal lerp + advection) → Phase 6 (two-tier 3D bake +
reprojection). Strong reuse throughout (VolumetricFogRenderer = bake template, StarFieldMath =
neutral-core precedent, VoxelProvider = 3D grid, ImageryProvider/DataSource = provider/entity templates)
means almost no net-new engine architecture. Immediate next step: the weather-map seam + the ~5-line
clock-bind fix.
