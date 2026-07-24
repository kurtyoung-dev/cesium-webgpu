# Planetary Volumetric Cloud Architecture Audit — 2026-07-23

Status: **COMPLETE — LAUNCH-TIME EVIDENCE AUTHORITY; LIVE STATUS IS THE CAMPAIGN 13 QUEUE**

Audited source: committed `main` at `851ce64389` (Batch 731)

Execution queue: [QUEUE_2026-07-23_CAMPAIGN13.md](QUEUE_2026-07-23_CAMPAIGN13.md)

This document records the code-truth review requested before launching the cloud fixes. It
supersedes older completion language where that language conflicts with current source. The older
cloud research and design documents remain useful inputs, but they are not execution status.

The governing constraint is feature preservation: performance work may improve, gate on actual
demand, or replace an implementation behind an equivalent fallback, but it may not remove cloud
features, silently reduce their quality, or disable them merely to improve a benchmark.

### 2026-07-24 implementation reconciliation

This file remains the frozen 2026-07-23 launch audit. Later implementation does not erase the
findings below; the following dated notes identify the portions now superseded:

- `C13-04` already replaced the primary visible shell's spherical intersection with expanded-WGS84
  shell math. `C13-05` is now **complete for its bounded temporal lane**: temporal reprojection uses
  current/previous relative-to-eye transforms, a CPU-`f64` camera delta, expanded-WGS84
  camera-relative deck intersection, and an allocation-free coarse history reset/generation
  contract. This supersedes only the temporal raw-ECEF/equatorial-sphere and missing-coarse-reset
  findings in sections 2.1, 2.2, and 2.4.
- `C13-38` is **complete**: cloud appearance revisions no longer request an environment cube fill,
  prefilter, and spherical-harmonic projection while neither the current nor previous environment
  state used the full reflected-cloud march. Deferred revisions are still consumed on opt-in, and an
  ON-to-OFF transition still receives one teardown refresh.
- The temporal result is still a half-resolution, color-only proxy. Reconstruction attachments,
  true 1/16 current work, and wind/depth/disocclusion-aware history remain open under
  `C13-09/10/12`. Shadow, mask, environment-capture, and atmosphere-consumer RTE remain open under
  `C13-06`.

Current evidence is correctness and scheduling evidence, not a quantitative speedup claim:
`cloud-temporal-rte.spec.mjs` is 11/11 and the complete cloud spec lane is 64/64; the Node/Edge
temporal runtime gate is GREEN with 26 observed production uniform uploads, maximum camera high/low
reconstruction error `0.002723 m`, explicit resize and observed cull/re-entry resets, and clean
GPU/device/console gates. The `C13-38` source/table suite is 4/4 and its runtime
opt-out/opt-in/teardown gate is GREEN.

---

## 1. Bottom line

The cloud system has a broad feature surface, but its planetary coordinate, temporal-reconstruction,
and weather-field foundations are incomplete:

1. Cloud geometry is modeled with spherical Earth assumptions instead of Cesium's WGS84 ellipsoid.
2. The advertised high-precision path is optional, partial, and not shared by temporal history or
   cloud shadows.
3. The temporal path does not reduce current-frame raymarch work to 1/16. It raymarches every
   half-resolution texel every frame and uses the supposed update fraction only as a blend weight.
4. The jitter is ordered Bayer noise, not STBN.
5. The global equirectangular weather map can seam at the antimeridian, pinches at the poles, and
   stretches regional provider fields over the whole planet because their bounds are ignored.
6. One collection-level cloud profile and one coarse global weather field cannot represent regional
   cloud-type mixtures, vertical decks, or actual global weather structure.
7. Stable per-formation randomization does not exist. Existing variation comes mostly from globally
   repeated noise rather than deterministic cloud identity.
8. Cloud shadows, god-ray masks, quality tiers, resource lifetime, and regression probes contain
   additional correctness or performance gaps.

These are architecture problems, not a reason to remove volumetric clouds. Campaign 13 fixes the
coordinate and evidence foundations first, then reconstruction, regional weather, and appearance.

---

## 2. Confirmed findings

### 2.1 The cloud planet is a sphere, not WGS84

`WebGPUProceduralCloudRenderer.ts` supplies a single `6378137`-metre radius to the visible and shadow
paths (`~1591-1594`, `~2211-2223`). `ProceduralClouds.wgsl` builds spherical shells and performs
sphere intersections (`~1379-1395`, shadow path `~1951-1989`).

WGS84's polar semi-minor axis differs from its equatorial semi-major axis by about 21.4 km, which is
larger than ordinary cloud-deck thicknesses. A spherical cloud altitude is therefore not merely a
small geodesy approximation at high latitude; it can move the cloud volume by multiple decks.

Required correction: shared ellipsoid/scaled-space, geodetic-height, surface-normal, and tangent-frame
helpers must drive the primary march, temporal reconstruction, weather mapping, and Beer shadow maps.

**2026-07-24 reconciliation:** this was true at the audited Batch-731 source. `C13-04` superseded the
primary-visible-shell portion, and bounded `C13-05` superseded the temporal-shell portion. The
shadow/mask/capture consumers remain open under `C13-06`; weather and local-tangent wind remain
separate open work.

### 2.2 Cloud RTE is incomplete and default-off

`CloudVolumetrics.cloudHighPrecision` defaults to `false`
(`packages/engine/Source/Scene/CloudVolumetrics.js:147-154`). The visible shader's high/low camera
split improves shell intersection and radial altitude, but the shader explicitly retains raw ECEF
`f32` sample positions for density/noise (`ProceduralClouds.wgsl:1510-1528`).

`CloudTemporalResolve.wgsl` reconstructs a world anchor from a raw `f32` camera position and a
previous world-to-clip matrix (`~94-106`, `~138-173`). It has no encoded origin or camera-relative
history contract. The cloud-shadow path is likewise spherical/world-`f32`.

Required correction: one automatic camera-relative/RTE coordinate frame across visible density,
planet anchoring, temporal history, shadows, masks, environment capture, and atmospheric composite.
The legacy path may remain as an explicit A/B fallback, but planetary precision is not an appearance
quality option.

**2026-07-24 reconciliation:** `C13-04` made the visible-shell precision path automatic, `C13-37`
made the baked density domain planet-stable, and `C13-05` removed raw full-ECEF `f32` from temporal
reprojection. The temporal resolve now reconstructs a current-camera-relative shell anchor and
projects it with the previous relative-to-eye transform plus the CPU-`f64`-derived camera delta.
Shadow/mask/capture/atmosphere consumers remain open under `C13-06`; this bounded temporal fix does
not claim them.

### 2.3 The current temporal path is not true 1/16 TAAU

The temporal tiers render a half-width by half-height current texture, so they shade one-quarter of
full-resolution pixels. They still shade every texel in that target every frame
(`WebGPUProceduralCloudRenderer.ts:2375-2392`).

`temporalUpdateFraction` is described as the fraction of refreshed pixels in
`WebGPUCloudTierPresets.ts:30-34`, but the renderer packs it as a fresh-history blend weight
(`WebGPUProceduralCloudRenderer.ts:2437-2444`). `CloudTemporalResolve.wgsl` samples the freshly
marched texture for every output pixel and ends with `mix(history, current, blend)` (`~113-180`).
It saves no additional march work beyond half resolution and adds a resolve pass with multiple
texture reads.

The current frame jitter is a 4×4 Bayer sequence (`ProceduralClouds.wgsl:1727-1744`), not
spatiotemporal blue noise.

Required correction: quarter-width by quarter-height current work, full-resolution history,
license-clean STBN indexed by pixel and frame, and reconstruction attachments carrying at least
premultiplied radiance/transmittance, cloud front depth, weighted depth or moments, motion, and
validity. Reprojection must handle wind, disocclusion, resize, tier/config changes, weather changes,
time jumps, and camera teleports.

### 2.4 Current history cannot represent cloud motion or overlap

The current temporal pass has color only and reprojects a single mid-shell proxy. It does not know
where the visible cloud began, how broad the contributing volume was, or how the density field moved.
Its 3×3 color clamp cannot distinguish a valid moving cloud from stale history.

Campaign 13 should evaluate both front depth and transmittance-weighted mean depth plus variance or
moments. Takram documents artifacts from relying on weighted mean depth for overlapping sparse and
distant clouds, so that limitation should not be copied unmodified.

**2026-07-24 reconciliation:** `C13-05` made that proxy planet-correct and chose the nearest visible
configured WGS84 deck interval, then added coarse resets for initial/missing transforms, frame gaps,
teleports over 50 km, scene/projection changes, morphs, temporal reactivation, deck-bound changes,
multi-deck topology changes, and temporal-resource resize. The perspective inverse current RTE
transform is composed from the existing inverse projection and translation-free inverse view rather
than a general VP inverse; orthographic/morph frames preserve the current cloud march but remain
current-only until reconstruction carries their required per-pixel ray origin. The expensive 3×3
clamp neighborhood is sampled only after reprojection passes shell/behind-camera/offscreen
validation. It deliberately does not claim physical per-pixel depth or moving density-field
validity. The color-only, wind, overlap, variance, and disocclusion findings remain open under
`C13-09/10/12`.

### 2.5 Weather wrapping, poles, and regional bounds are incorrect

`worldToWeatherUV` converts a world position to spherical longitude/latitude
(`ProceduralClouds.wgsl:444-456`). The weather sampler repeats U and clamps V
(`WebGPUProceduralCloudRenderer.ts:1051-1058`), but the procedural FBM producer is not periodic
across its first and last columns (`~690-749`). Repeating the sampler therefore blends unrelated
values at ±180°. At a pole, all longitudes collapse to the same point while the pole texture row can
still vary by U, producing pinching or a radial wedge.

`WeatherTexPacker.ts:47-51` explicitly assumes every field spans the global texture. The renderer
packs fixed global bounds (`WebGPUProceduralCloudRenderer.ts:1739-1743`) instead of the provider's
`WeatherField.bounds`. A regional EDR/WCS field can therefore be stretched over the entire planet.

Required correction has two stages:

1. A bounded stopgap for existing global maps: periodic edges, pole-consistent texels, actual bounds,
   no-data semantics, and continuity probes.
2. The durable architecture: Cesium globe-quadtree weather pages or a justified cube-sphere
   equivalent, with overlap gutters, page LOD, cache ownership, regional composition, and stable
   lookup at tile boundaries.

Globe terrain remains on Cesium's quadtree; this work does not route it through the general scene
octree.

### 2.6 Wind is not planet-local

Fine density motion applies a fixed ECEF X/Z displacement (`ProceduralClouds.wgsl:829-833`). That is
not east/north wind. Its tangent and radial components change with location, so equivalent weather
can move differently or morph vertically around the planet.

Required correction: convert weather wind layers into a local ENU tangent basis at the sample
location and interpolate/advection between forecast time slices. Hourly inputs must not hard-swap.

### 2.7 Regional weather realism and cloud-type mixtures are missing

The current coarse RGBA weather map mainly carries coverage, a continuous low/high shape bias, base
shift, and density scale. It does not select a full per-cell genus/profile. The renderer uploads one
global `CloudTypeProfile` (`WebGPUProceduralCloudRenderer.ts:1864-1885`); multi-deck mode reuses that
profile/field across fixed shells. Important profile axes such as phase, erosion, deck, and
extinction are not independently data-driven per region/layer.

The target hierarchy is:

1. slow climate/region prior: latitude, season, land/sea, orography, tropical/maritime/continental/
   arid/polar regimes;
2. actual synoptic field: cloud fraction by level, humidity/cloud water/ice, pressure, vertical
   motion, precipitation, and wind;
3. region- and state-dependent cloud-type/deck mixture;
4. mesoscale formation field;
5. fine three-dimensional microstructure;
6. temporally interpolated and advected evolution.

The existing procedural/offline path remains a required fallback when live data is unavailable.

### 2.8 Same-region and same-type cloud randomization is missing

Current hashes and periodic noise vary density, but there is no stable formation identity or public
seed contract. Per-frame randomization would be worse because it would boil and invalidate temporal
history.

Required correction: derive a deterministic seed from globe page/cell, forecast cycle or weather
epoch, cloud layer/type, and a user seed. Use it to draw physically bounded distributions for
coverage threshold, base/top, density, puff scale/orientation, erosion, anvil strength, phase
response, extinction, and local wind. Interpolate macro-cell parameters across borders so formations
remain continuous. Tests must prove repeatability across camera routes and fresh contexts.

### 2.9 Shadows and duplicate cloud marches need redesign

The current Beer shadow map stores a narrow optical-depth representation, lacks temporal shadow
history, and needs RTE-stable coverage/cascades. Cascade mode adds its cascades to the always-rendered
single map instead of replacing or reusing it (`WebGPUProceduralCloudRenderer.ts:2259-2361`), so the
feature can perform four shadow marches.

The god-ray mask path re-enters `marchDeck` at full resolution and computes lighting/radiance to
return transmittance (`ProceduralClouds.wgsl:1861-1933`,
`WebGPUProceduralCloudRenderer.ts:2549-2574`). The primary cloud output should publish reusable
transmittance rather than remarching the cloud.

Required correction: richer all-layer Beer shadow data, stable/tile-snapped RTC matrices, PCF,
temporal filtering, explicit cadence, and reuse of far-cascade/transmittance products by
aerial/fog/god-ray consumers.

### 2.10 Quality configuration is not one truthful source of truth

`CloudVolumetrics` documents `ultra`, while the tier resolvers recognize only low/medium/high and
treat unknown values as altitude-auto. The documented ambient name `sky` does not match the
renderer value `sky-lut`. The tier table contains fields that are ignored or duplicated by a second
resolver; powder and related terms are also hardcoded elsewhere.

Far/low tiers reduce not only spatial sampling but important lighting terms, making orbit clouds
cheap but visually flat. Required correction: one resolver and packed-value contract, explicit
supported names, round-trip unit tests, and separate budgets for geometric sampling, lighting,
shadows, and temporal quality.

### 2.11 Cloud hot-path and lifecycle work remains

Pipelines are created synchronously on first use in several lazy cloud paths; bind groups are rebuilt
per frame where attachment-generation keys could retain them. Cloud teardown omits some owned
weather/noise textures and samplers (`WebGPUProceduralCloudRenderer.ts:2629-2704`).

Required correction: async prewarm after exact formats/topology are known, generation-keyed bind
group retention, complete owned-resource destruction, and post-submit retirement. These changes must
follow the renderer's context/device ownership rules and must not destroy resources before queued
commands submit.

**2026-07-24 reconciliation:** `C13-05` prebuilds and reuses the two temporal parity bind groups
until temporal resources are reallocated, and `C13-38` closes the unrelated cloud-IBL opt-out
revision leak. Those bounded fixes do not close async prewarm, general generation-keyed resource
retention, complete destruction, or post-submit retirement (`C13-40`), and no whole-route speedup is
claimed from them.

### 2.12 Existing cloud regression evidence is not certifying

`probe-cloud-tour.mjs:137-140` checks removed cloud properties on `Globe` before writing the managed
collection. Those guards are false after cloud unification, so intended coverage/density/layer
presets are silently skipped. Many other cloud probes copied the same pattern.

The tour is static, uses a bright/low-saturation pixel count that conflates clouds with terrain/sky,
and its images predate the current cloud architecture. `probe-cloud-temporal.mjs` saves
static/moving/settled PNGs but calculates no ghosting, convergence, or reference metric. Static
queue-drain timing is useful as max-throughput evidence but is not moving-camera FPS.

The first Campaign-13 slice must repair unified API setup and establish Node/Playwright moving
evidence across ground, horizon, inside, above, orbit, dateline, poles, time/wind motion, and
regional fields. Volumetric clouds are WebGPU-only; WebGL is the billboard/API preservation lane,
not a fake volumetric parity comparison.

**2026-07-24 reconciliation:** the historical static-tour criticism remains valid, but Campaign 13
now has a separate certifying temporal-state/RTE lane. `probe-cloud-temporal-rte.mjs` instruments the
production `CloudTemporalResolve UB`, records 26 uploads over bounded motion, teleports,
antimeridian/poles/orbit, tier re-entry, deck/topology changes, resize, and an observed cull/re-entry,
and exits GREEN with `0.002723 m` maximum high/low camera reconstruction error and clean
GPU/device/console gates. It is explicitly not an image-quality, ghosting, FPS, CPU, or GPU-timestamp
metric. `probe-cloud-ibl-optout-revision.mjs` separately certifies the `C13-38` scheduling
state-machine without presenting it as performance timing.

---

## 3. Takram comparison: use the architecture, not the screenshots

Takram's published cloud package provides the closest open geospatial comparison:

- [cloud package and documented limits](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds)
- [CloudsPass target sizing and temporal orchestration](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/CloudsPass.ts)
- [current cloud raymarch shader](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/shaders/clouds.frag)
- [current temporal resolve shader](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/shaders/cloudsResolve.frag)
- [quality presets](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/qualityPresets.ts)

The useful reference architecture is quarter width and quarter height current work (1/16 texels),
full-resolution resolve/history, STBN sampling, cloud depth/velocity output, vectorized independent
layers, Beer shadow maps, and separate quality presets. Takram also documents temporal ghosting,
disocclusion smearing, and weighted-mean-depth overlap artifacts; Campaign 13 must test and improve
those areas rather than cargo-cult them.

The attractive published implementation above is the GLSL/WebGL cloud package. Takram's repository
currently lists WebGPU clouds as work in progress:
[WebGPU status](https://github.com/takram-design-engineering/three-geospatial#status-of-webgpu-support).
It is a design reference, not evidence that its current code can be transplanted into this renderer.

---

## 4. Correct implementation order

1. Repair the probes and capture current moving evidence.
2. Define the shared WGS84/RTE coordinate contract and author RED planetary probes.
3. Apply that contract to the primary march, temporal history, shadows, masks, capture, and
   atmospheric consumers.
4. Honor regional bounds and make the current global map seam/pole safe.
5. Add reconstruction attachments, true 1/16 current work, STBN, and motion/disocclusion handling.
6. Build globe-quadtree weather pages and regional source composition.
7. Add climate priors, per-region type/deck mixtures, deterministic formation seeds, ENU wind, and
   time interpolation.
8. Improve layer lighting, Beer shadows, and physical defaults.
9. Remove duplicate cloud marches and harden pipelines, bind groups, and resource lifetime.
10. Re-land content features such as lightning and GRIB2 only on top of the corrected substrate.

Orbit impostors and a view-local density clipmap remain optional later tiers. They are not the first
response while the cheaper temporal path is incomplete.

---

## 5. Documentation reconciliation

- `C11-126` / CLOUD-U4 is **complete**, not blocked.
- `C11-125` / C6-CLOUD-STBN-TAAU is **partial**: march step growth and far cap shipped; STBN and true
  1/16 reconstruction did not.
- Campaign 11's cloud/weather IDs transfer to Campaign 13 with their original names retained as
  aliases. They are not double-scheduled.
- Older statements that the current temporal path updates only 1/8–1/16 of pixels are superseded by
  this audit.
- Older static cloud-tour green claims are non-certifying until Campaign 13 repairs the probe and
  records a current manifest.
- As of 2026-07-24, `C13-05` is complete only for temporal WGS84/RTE reprojection and coarse history
  compatibility/reset. `C13-09/10/12` remain the authority for real reconstruction attachments,
  true 1/16 work, and attachment/wind-aware rejection; `C13-06` remains the authority for
  shadow/mask/capture/atmosphere RTE.
- As of 2026-07-24, `C13-38` is complete for revision relevance gating. It suppresses irrelevant
  work while preserving opt-in consumption and teardown; it does not reduce reflected-cloud quality
  or establish a measured speedup.

---

## 6. Acceptance principles

- No feature-removal performance wins.
- Default/off fallbacks remain testable and byte-identical where promised.
- WGS84/RTE correctness is tested at the equator, dateline, both poles, horizon, inside/above deck,
  and orbit, including motion and teleports.
- Temporal quality is compared against a fresh-context full-resolution reference and includes
  disocclusion, wind-only, camera-only, and combined motion.
- Weather tests cover global, regional, overlapping, missing-data, offline fallback, and time
  interpolation.
- Randomization is deterministic across fresh runs, spatially continuous, region/type constrained,
  and not regenerated per frame.
- Performance uses the Node/Edge moving camera route plus GPU timestamps and a separately labeled
  max-throughput lane. Idle-soak/request-render FPS is not evidence.
- WebGL billboard clouds and backend-neutral cloud/weather APIs remain green throughout.
