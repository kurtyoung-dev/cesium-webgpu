# Campaign 13 — Planetary Volumetric Clouds: RTE, Temporal Reconstruction, and Weather Realism

Prepared: 2026-07-23

Status: **LAUNCHED / EXECUTING (2026-07-23).**

Launch authority: explicit maintainer direction on 2026-07-23:

> "Okay confirm all of these findings are documented then lets start work on the cloud fixes and
> improvements. Create a cloud specific campaign and then lets launch it."

Anchor: committed `main` HEAD **`851ce64389` (Batch 731)**. The queue and launch truth are
`C13-00`, landed locally as **Batch 732 (`f4a934e606`)**. Runtime work begins with `C13-01` only
after the launch/document batch is committed, `git status` contains no unrelated changes, and
`npx tsc --noEmit` is green.

Publication note: the 2026-07-23 `git push origin main` attempt returned HTTP 403 because the
configured `kurtyoung-dev/cesium-webgpu` remote and active `KurtTrottr` credential do not authorize
the same repository. No remote, credential, or account was changed. The maintainer's explicit launch
directive authorizes local trunk execution; origin publication remains an external coordination
item, not a reason to bypass or weaken the local gates.

Campaign 13 supersedes **only** Campaign 11's `clouds-weather` execution cluster. It does not close
Campaign 11's unrelated open work, and it does not launch or renumber the existing Campaign 12
celestial-appearance draft.

Operating model: **ORCHESTRATOR**. One worker implements a bounded slice and returns a verified dirty
tree; an independent reviewer checks the actual diff and evidence; only the orchestrator lands it and
updates this ledger. The mechanics in
`campaign11_planning/guides/G10-charter-mechanics.md` remain the process reference.

---

## 1. Canonical ID table

This table is the campaign backbone and is authored before wave prose. IDs are add-only: never
renumber, reuse, or mint a `C13-*` identifier elsewhere without adding it here first.

| ID | Canonical task | Pri | Class | Effort | Wave | Hard dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| `C13-00` | Launch seal, audit-truth capture, and C11 cloud transfer | R0 | docs/gate | S | W0 | maintainer authority |
| `C13-01` | Repair the Node/Playwright cloud tour and capture current moving baselines | P0 | test/correctness | M | W0 | `C13-00` landed clean |
| `C13-02` | Cloud CPU/GPU observability and temporal-cost counters | P0 | tooling/perf | M | W0 | `C13-01` |
| `C13-03` | WGS84/RTE coordinate contract plus planetary RED probes | P0 | architecture/correctness | M | W1 | `C13-01` |
| `C13-04` | Automatic RTE and WGS84 shell math in the primary cloud march | P0 | correctness | L | W1 | `C13-03` |
| `C13-05` | RTE temporal reprojection, history origin, and teleport/reset contract | P0 | correctness | L | W1 | `C13-03` |
| `C13-06` | RTE cloud-shadow, mask, environment-capture, and atmosphere consumers | P0 | correctness | L | W1 | `C13-03`, `C13-04` |
| `C13-07` | Dateline/pole-safe global weather sampling stopgap | P0 | correctness | M | W1 | `C13-03` |
| `C13-08` | Honor `WeatherField.bounds`, missing-data semantics, and regional packing | P0 | correctness/data | M | W1 | `C13-01` |
| `C13-09` | Cloud reconstruction attachments: front depth, weighted depth, velocity, and moments | P0 | architecture/perf | L | W2 | `C13-04`, `C13-05` |
| `C13-10` | True 1/16-rate current-frame raymarch with full-resolution temporal reconstruction | P0 | perf/quality | L | W2 | `C13-02`, `C13-09` |
| `C13-11` | License-clean STBN generation/import and stochastic cloud jitter | P1 | quality/perf | M | W2 | provenance-approved asset path |
| `C13-12` | Disocclusion, variance clipping, reactive history, and wind-aware reprojection | P0 | correctness/quality | L | W2 | `C13-09`, `C13-10` |
| `C13-13` | Decouple lighting fidelity from spatial raymarch tier | P1 | quality/perf | M | W2 | `C13-10` |
| `C13-14` | Globe-quadtree weather tile schema, gutters, cache, atlas, and LOD | P0 | architecture/data | XL | W3 | `C13-07`, `C13-08` |
| `C13-15` | Regional and seasonal climate-prior field | P1 | weather/quality | L | W3 | `C13-14` |
| `C13-16` | Per-region cloud-type and vertical-deck mixtures | P1 | weather/quality | L | W3 | `C13-14`, `C13-15` |
| `C13-17` | Deterministic per-formation randomization | P1 | weather/quality | M | W3 | `C13-14`, `C13-16` |
| `C13-18` | Local-tangent ENU wind and spatial advection | P1 | weather/correctness | L | W3 | `C13-14` |
| `C13-19` | Temporal interpolation between weather slices | P1 | weather/quality | M | W3 | `C13-18` |
| `C13-20` | Regional-source composition, priority, and no-data fallback | P1 | weather/data | M | W3 | `C13-08`, `C13-14` |
| `C13-21` | Multi-layer morphology and energy-consistent cloud lighting | P1 | quality | L | W4 | `C13-12`, `C13-16` |
| `C13-22` | Rich Beer shadow maps and temporally stable cloud shadows | P1 | quality/perf | L | W4 | `C13-06`, `C13-12` |
| `C13-23` | Per-position optical extinction | P2 | quality | M | W4 | `C13-16`, `C13-21` |
| `C13-24` | Backend-neutral `scene.weather` / `WeatherSystem` facade | P2 | API/architecture | M | W4 | `C13-08` |
| `C13-25` | In-cloud lightning reland with upper-tail anti-grid oracle | P2 | feature/quality | M | W5 | `C13-17`, `C13-19` |
| `C13-26` | GRIB2 ingest through same-origin proxy and WASM decoder | P2 | data/feature | L | W5 | proxy, decoder, network fixture |
| `C13-27` | Live EDR network confirmation | P2 | tooling/data | S | W5 | networked browser session |
| `C13-28` | Ground snow-albedo consumer on WebGL and WebGPU | P2 | feature/parity | M | W5 | `C13-20`, terrain shader coordination |
| `C13-29` | Orbit cloud impostor/freeze-and-reproject quality tier | P3 | perf/quality | L | W6 | `C13-10`, `C13-11`, Gate C |
| `C13-30` | Precipitation coupling: rain shafts and ground wetness | P3 | feature | L | W6 | `C13-20`, `C13-25`, `C13-28` |
| `C13-31` | Contrail and pyrocumulus source infrastructure | P3 | feature | L | W6 | `C13-14`, `C13-16` |
| `C13-32` | View-local cascaded 3D density clipmap | P3 | architecture/perf | XL | W6 | `C13-10`, Gate C |
| `C13-33` | Historical weather replay demo | P3 | demo/data | M | W6 | `C13-24`, `C13-26` |
| `C13-34` | Cloud-shadow contribution to dynamic environment maps | P3 | feature/quality | S | W6 | `C13-22` |
| `C13-35` | Command-empty environment demand scheduling and cold-start cloud readiness | P0 | correctness/perf | M | W0 | `C13-01` |
| `C13-36` | Animated per-pixel IGN ray-start jitter and periodicity oracle | P0 | quality/perf | M | W2 | `C13-03` |
| `C13-37` | Planet-stable non-periodic baked density domain | P0 | quality/correctness | L | W2 | `C13-03`, `C13-36` |
| `C13-GATE-A` | Launch and evidence-truth gate | R0 | gate | S | W0 | `C13-01`, `C13-02`, `C13-35` |
| `C13-GATE-B` | Planetary correctness gate | R0 | gate | M | W1 | `C13-03..08` |
| `C13-GATE-C` | Temporal reconstruction and measured-performance gate | R0 | gate | M | W2 | `C13-09..13`, `C13-36`, `C13-37` |
| `C13-GATE-D` | Regional weather realism gate | R0 | gate | M | W3 | `C13-14..20` |
| `C13-EXIT` | Feature-preserving cloud certification | R0 | gate | L | EXIT | Gates A-D, selected W4/W5 owners |

---

## 2. Confirmed current-state findings

These findings are the launch premise. Every implementation brief must re-grep the named symbols and
reproduce its premise at execution HEAD before changing code.

### 2.1 Temporal reconstruction is not yet TAAU

- The current raymarch target is one-half width and one-half height. It shades every texel in that
  target every frame: **one-quarter of full-resolution pixels**, not one-sixteenth.
- `temporalUpdateFraction` is documented like a pixel-refresh fraction, but the renderer packs it as
  the history blend weight and `CloudTemporalResolve.wgsl` samples fresh current color for every
  output texel. Renaming/migration belongs with `C13-10`; until then, evidence must call it a blend
  weight rather than a work-reduction control.
- The current jitter is a repeating 4×4 Bayer sequence, not spatiotemporal blue noise.
- The history/reconstruction surface carries color only. It has no cloud front depth, weighted depth,
  velocity, variance/moments, or explicit reactive/disocclusion data.
- `CloudUpscale.wgsl` uses scene depth for a small bilateral upscale, but it does not have cloud depth
  with which to distinguish overlapping or newly revealed cloud volumes.

Primary local anchors:

- `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts`
- `packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Environment/CloudUpscale.wgsl`

### 2.2 Planet-scale precision is inconsistent

- The primary march has an opt-in camera high/low path, but `CloudVolumetrics.cloudHighPrecision`
  defaults false. Planetary precision is correctness infrastructure and must not depend on an
  appearance-quality toggle.
- The temporal resolver reconstructs a world anchor from a raw `vec3<f32>` camera position and a
  previous view-projection matrix. It does not share the march's high/low origin, so enabling the
  primary high-precision path does not make cloud history RTE-correct.
- Noise/weather sampling retains raw world-space positions in parts of the march. High/low shell
  intersection alone cannot prevent swimming or precision loss if the density coordinate later
  returns to full ECEF `f32`.
- Cloud shadows, environment capture, cloud masks, and atmosphere composition need one verified
  coordinate contract. Fixing only the visible march would leave history and consumers unstable.
- The current shell assumptions must be checked against Cesium's WGS84 ellipsoid rather than treating
  the whole planet as a convenient sphere in one subsystem and an ellipsoid in another.

The required end state is one camera-relative/RTE cloud frame, with stable planet anchoring, shared by
the visible march, temporal reprojection, weather sampling, shadow passes, mask/composite passes, and
atmospheric consumers.

### 2.3 Equirectangular weather sampling cannot satisfy the globe contract

- `worldToWeatherUV` converts the sample direction to longitude/latitude. U repeats and V clamps.
- The procedural weather-map producer is not periodic at the first/last longitude columns. A repeating
  sampler does not make non-periodic source data seam-free, so the dateline can show a discontinuity.
- At the poles, all longitudes geometrically collapse while the texture row still contains distinct
  values. This creates pinching and orientation artifacts.
- `WeatherTexPacker` assumes a global texture and does not honor regional `WeatherField.bounds`.
  Regional source data can therefore be stretched across the whole globe instead of being placed in
  its real geographic extent.
- Fine cloud motion applies global Cartesian offsets rather than local east/north tangent wind.
  Direction and radial contamination vary around the globe.

`C13-07` is a bounded stopgap for current global maps. `C13-14` is the durable architecture:
Cesium-globe-quadtree weather tiles or an equivalent seam-safe globe parameterization, with overlap
gutters, bounds, no-data semantics, LOD, and stable cache ownership. The general scene octree is not
the owner for globe weather.

### 2.4 Regional variety and same-type variety are both missing

The current packed weather channels provide useful scalar controls, but the system still has one
collection-level genus/profile and a globally repeated procedural morphology. It lacks:

1. A slow climate/region prior: latitude, season, land/sea, orography, and broad tropical, maritime,
   continental, desert, and polar regimes.
2. A synoptic field: coverage/cloud fraction by level, humidity, pressure/vertical motion,
   precipitation, and wind.
3. A per-region mixture of cloud types and vertical decks rather than one global genus.
4. Mesoscale formation identity and variation.
5. Fine 3D microstructure.
6. Continuous interpolation and advection between weather times.

Formation variety must be deterministic. Seed from stable globe tile/cell identity, weather epoch,
layer/type, and an explicit user seed. Randomize physically bounded distributions—coverage
threshold, base/top altitude, density, erosion, anvil strength, phase response, and local wind—not
per-frame white noise. The same camera, time, data, and seed must reproduce the same formations.

### 2.5 Tier selection currently trades away too much appearance

The lowest/far tier reduces geometric samples but also zeros or strongly reduces powder, ambient, and
isotropic lighting terms. That makes the orbit view cheap by making it unusually flat. Spatial
sampling, lighting fidelity, shadow fidelity, and history quality need separate budgets. `C13-13`
must preserve coherent atmosphere and scattering while reducing spatial work.

### 2.6 Existing cloud regression evidence is not a trustworthy current oracle

`Tools/visual-regression/probe-cloud-tour.mjs` still checks removed Globe cloud properties before
writing the unified `globe.defaultCloudCollection.volumetric` configuration. After cloud unification,
those conditions can be false, so the intended presets are not reliably applied. Several cloud images
also predate later cloud fixes, and still images cannot certify temporal stability.

`C13-01` repairs the probe before any visual fix. It must exercise motion, altitude transitions,
teleports, time/wind changes, the antimeridian, both poles, multiple regions, multiple cloud types,
and repeated formations of the same type.

### 2.7 Takram is a reference, not a code transplant

Takram's published cloud path demonstrates the architecture to compare against:

- current-frame raymarch at one-quarter width and one-quarter height;
- full-resolution temporal history;
- stochastic sampling;
- cloud depth/velocity output;
- vectorized cloud layers;
- richer Beer shadow-map data and temporal filtering.

Their own documentation also records temporal ghosting/smearing and depth-overlap limitations. Do not
copy the transmittance-weighted-mean-depth limitation without evaluating front depth plus moments, and
do not imply their attractive published cloud package is already a production WebGPU implementation.
The current repository describes WebGPU clouds as work in progress.

Primary references:

- [three-geospatial repository](https://github.com/takram-design-engineering/three-geospatial)
- [cloud package documentation](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds)
- [CloudsPass source](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/CloudsPass.ts)
- [cloud raymarch shader](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/shaders/clouds.frag)
- [temporal resolve shader](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/shaders/cloudsResolve.frag)
- [shadow shader](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/shaders/shadow.frag)

### 2.8 Command-empty frames currently suppress demanded clouds

The initial `cloudQuality=128` zero-cloud artifact was not evidence that the live-noise shader fails
at 128 steps. The probe configured the collection correctly, but its cold upward-looking view drained
to zero frustum command lists before the lazy procedural renderer executed. The WebGPU scene renderer
returned before resource setup and the post-frustum/environment chain, leaving `_cloudCache`
uninitialized, uniforms zero, no cloud pass, and a meaningless sub-millisecond timing.

This is both an evidence bug and a renderer scheduling bug:

- a loaded feature-renderer handle is not proof its `execute` ran;
- a fixed rAF count does not guarantee the environment chain ran;
- no geometry/frustum commands does not mean a demanded screen-space cloud/fog/weather frame has no
  work.

`C13-35` owns the scheduling correction and the exact readiness gate. The 128-step path remains under
`C13-13` for lighting/spatial-budget separation, but the old blank screenshot is reclassified as
invalid evidence rather than a raymarch defect.

### 2.9 The severe static lattice precedes temporal history

The repeated rows/spokes are visible in full-resolution, temporal-off captures and are much stronger
with baked noise than live noise. The baked 3D texture repeats on all axes, uses harmonically related
frequencies, and is sampled in the ECEF domain. Its approximate visible periods are `7.4 km` for the
base shape and `0.667 km` for detail; perspective projects that Cartesian lattice into converging
rows.

The planned per-pixel animated interleaved-gradient-noise ray-start offset also never shipped:
`QF_JITTER` and the tier's `jitterEnabled` exist but are not consumed, while the current Bayer value
is one frame-global UV offset. Temporal history preserves and can amplify this structured input, but
is not its original cause. `C13-36` restores the license-free ray-start jitter contract; `C13-37`
owns the durable non-periodic density domain.

---

## 3. Functionality-preservation contract

Performance work must improve an existing feature rather than remove, bypass, default-disable, or
visually weaken it. The following current capabilities are explicit regression gates:

- WebGL `CloudCollection` billboard rendering and all upstream cloud APIs.
- The unified `CloudCollection.renderMode` ownership model, with `BILLBOARD` and `VOLUMETRIC`
  remaining selectable.
- `globe.defaultCloudCollection`, `CloudVolumetrics`, `CloudType`, and
  `AtmosphericConditions.clouds` facade behavior.
- Adaptive coarse-to-fine marching, march-step growth, far cap, early termination, and existing
  quality selection.
- Existing lighting, time-of-day coloration, ambient/ground bounce, powder, aerial perspective, IBL,
  god rays, cloud shadows, and atmosphere/fog consumers.
- Existing multi-deck, cloud-type profile, weather-channel, species, exotic, and special-cloud
  controls.
- EDR, WCS CoverageJSON, METAR, and synthetic weather sources, their async time model, and offline
  fixtures.
- Environment-map cloud capture and every current default-off feature switch.
- Multi-context and device-loss behavior. Cloud/weather GPU resources are per context/device, never
  module-global mutable renderer state.

Cloud-march features may remain WebGPU-only where WebGL has no volumetric architecture. Features
placed on a backend-neutral Scene, Weather, or globe-surface API must preserve WebGL behavior and
receive a WebGL implementation or an explicit documented degradation contract. `C13-28` is a
both-backend terrain feature.

No new public flag is a substitute for correct internal RTE. Existing flags remain backward
compatible, but planet-scale precision should become automatic once Gate B verifies it.

---

## 4. Standing implementation rules

1. **Probe first.** Reproduce the exact defect before changing engine code. A visual change requires
   Node/Playwright screenshots, quantitative evidence, and human inspection of the PNGs.
2. **No Python tooling.** Browser automation and benchmark orchestration use the existing Node/Edge
   toolchain.
3. **Motion is mandatory.** Request-render idle soak is not an FPS or temporal-stability test.
4. **One concern per landing.** Do not combine RTE, weather tiling, and appearance tuning into an
   unreviewable shader rewrite.
5. **RTE is end-to-end.** Camera subtraction occurs before `f32` reconstruction. Never add encoded
   high/low ECEF values before subtracting the encoded camera.
6. **Stable coordinates.** Density/noise coordinates are planet-anchored yet locally precise.
   Camera-relative rendering must not make the weather swim.
7. **Add-only layouts.** Existing `CloudUniforms`, quality flags, and shader define identities are not
   reordered. New topology participates in exact cache keys.
8. **No hot-path conversion.** Weather decoding, regional composition, tile upload, pipeline
   creation, and representation conversion are asynchronous/prepared before the draw hot path.
9. **Resource lifetime follows submit.** Replaced weather/history/shadow resources retire only after
   their last submitted use and remain context/device owned.
10. **Determinism.** Randomization derives from stable identities and explicit seeds. It does not
    call a changing random source per frame.
11. **License provenance.** Do not vendor NVIDIA STBN assets or any unprovenanced noise texture.
    `C13-11` stays blocked until a license-clean generation/import path and notices are recorded.
12. **Honest performance claims.** Report GPU time, CPU time, resolution, quality tier, adapter,
    route, scene content, and feature state. A correct change that misses a performance target is an
    honest result, not permission to degrade output.

---

## 5. Transfer map from Campaign 11

This is an ownership transfer, not duplicated scheduling. Campaign 11 retains its historical IDs and
evidence; Campaign 13 owns the remaining cloud execution.

| Campaign 11 source | Campaign 13 owner | Intake disposition |
| --- | --- | --- |
| `C11-124` — lightning reland | `C13-25` | transferred, broadened by the new formation/time architecture |
| `C11-125` — STBN/TAAU | `C13-09..12` | **PARTIAL at transfer**: march growth/far cap shipped; true 1/16 reconstruction and STBN remain |
| `C11-126` — remove Globe cloud flag / unification | `C13-00` only | **COMPLETE before C13** in B621/B622; doc truth only, never reimplement |
| `C11-127` — GRIB2 | `C13-26` | transferred, blocked on proxy/decoder/fixture prerequisites |
| `C11-128` — live EDR confirmation | `C13-27` | transferred, environment-blocked |
| `C11-129` — `WeatherSystem` / `scene.weather` | `C13-24` | transferred |
| `C11-130` — snow albedo | `C13-28` | transferred; both-backend globe-surface contract |
| `C11-SEED-10` — cloud impostor LOD | `C13-29` | transferred as a gated quality/battery tier |
| `C11-SEED-11` — precipitation coupling | `C13-30` | transferred |
| `C11-SEED-12` — planet-scale cloud tiling | `C13-14` | promoted to P0 architecture; largest regional-weather gap |
| `C11-SEED-13` — exotic remainder | `C13-31` | transferred |
| `C11-SEED-14` — Tier-2 3D bake | `C13-32` | transferred as post-Gate-C architecture option |
| `C11-SEED-15` — interpolation/advection | `C13-18`, `C13-19` | split into spatial and temporal owners |
| `C11-SEED-16` — historical replay | `C13-33` | transferred, still GRIB2-gated |
| `C11-SEED-17` — position-dependent extinction | `C13-23` | transferred |
| `C11-SEED-18` — env-map cloud shadow | `C13-34` | transferred |

The durable legacy input remains
`campaign11_planning/guides/G12-clouds-weather.md`. Its historical status labels are not the live C13
ledger.

---

## 6. Execution waves

### W0 — Truthful oracle and measurement

#### `C13-00` — launch seal and documentation truth

Record this queue, the corrected C11 transfer state, the audit findings, and the active-campaign
registration. Do not claim a cloud runtime change. This row is complete when the launch batch lands
clean and the queue is the single source for cloud execution.

#### `C13-01` — repair and expand the cloud tour

Fix the unified-API setup in `probe-cloud-tour.mjs`, then create reproducible moving sequences for:

- low-altitude ground/horizon;
- inside a cloud deck;
- above the deck;
- orbital altitude and altitude transitions;
- dateline crossings in both directions;
- north- and south-pole approaches;
- at least four distinct climate/region fixtures;
- at least three cloud types, including multiple same-type formations;
- wind/time advancement, camera teleport, and history reset.

Record source/build hash, adapter, canvas resolution, tier, current/history target dimensions, CPU
frame distribution, available GPU timestamps, temporal-delta/ghost metrics, and screenshots. Do not
compare volumetric output to WebGL billboards as if they were visual-parity twins; use WebGL to guard
shared scene/globe functionality.

#### `C13-02` — cloud observability

Expose, without per-frame allocation:

- raymarch target dimensions and pixels dispatched;
- current/history resolve pixels;
- primary/light-march sample counts or bounded proxy counters;
- history accept/reject/reset counts;
- weather texture/tile cache hits, misses, uploads, and live bytes;
- cloud shadow pass count and dimensions;
- CPU stage timing and GPU timestamp timing when supported.

Keep clean and API-instrumented lanes separate. Instrumentation must be removable/disableable without
changing the render result.

#### `C13-35` — command-empty environment demand scheduling

An empty geometry/frustum command list is not proof that the frame has no work. Preserve the
zero-work return only when no post-frustum/environment consumer is demanded. Managed or user-owned
volumetric clouds, fog, weather, SSR, outlines, and contact shadows must still reach the canvas and
environment chain while looking into an otherwise command-empty sky.

Cloud probes must await the exported lazy feature-renderer key and then prove at least one actual
execute plus initialized uniforms/targets. A fixed rAF warm-up count, configuration round trip, or
loaded renderer handle is not execution evidence.

### W1 — Planetary correctness before appearance tuning

`C13-03` defines the shared cloud coordinate contract and authors RED probes. `C13-04` applies it to
the visible march; `C13-05` applies it to temporal history; `C13-06` applies it to shadow/mask/capture
and atmosphere consumers.

The contract must specify:

- WGS84 ellipsoid shell intersection and height;
- camera high/low or a camera-relative local frame;
- stable tile/cell origins for density and weather coordinates;
- previous-frame origin and previous camera transform;
- scene-mode and teleport/history invalidation;
- local tangent basis used for wind;
- packing precision and the exact point at which `f64` CPU values become `f32` GPU-relative values.

`C13-07` may first make the existing global equirectangular producer periodic and pole-safe as a
bounded correctness patch. It must not be presented as the final regional architecture.

`C13-08` stops stretching regional fields globally. The packer and provider contract must carry
bounds, coordinate reference, resolution, missing/no-data, revision/time, and source priority.

### W2 — Real temporal reconstruction and measured performance

`C13-09` creates an exact topology for current cloud output. At minimum evaluate:

- premultiplied color/transmittance;
- nearest/front cloud depth;
- transmittance-weighted depth;
- motion/velocity;
- first/second moments or a compact variance representation.

Do not rely on only one mean depth for separated overlapping volumes.

`C13-10` makes one current-frame phase cover one-sixteenth of full-resolution pixels and reconstructs
the full-resolution output from history. It must prove the actual current target/dispatch size; a
smaller blend weight is not a work reduction.

`C13-11` replaces ordered Bayer sampling only after a provenance-clean STBN resource exists. The old
path remains the loading/fallback route. This task may proceed in parallel with attachment design but
does not block RTE or bounds correctness.

`C13-12` owns motion-aware rejection, variance clipping, reactive history, wind advection in
reprojection, disocclusion, camera cuts, origin changes, tier/resolution changes, and weather-source
changes.

`C13-13` preserves scattering/atmosphere fidelity at lower spatial tiers. Sample count, lighting
octaves, shadow quality, reconstruction quality, and output resolution become explicit independent
budgets rather than one "low means flat" preset.

`C13-36` restores the existing but unwired `jitterEnabled`/`QF_JITTER` contract with a deterministic,
license-free animated interleaved-gradient-noise offset at each pixel's ray start. It remains
separate from the 16-phase reconstruction/update mask and must preserve the adaptive march's
conservative base-density oracle.

`C13-37` removes the axis-aligned periodic lattice from the baked density domain. Increasing texture
resolution is not sufficient because it retains the normalized repeat period. Use planet-stable
regional/local coordinates, seeded rotations, incommensurate scales, and footprint-aware sampling;
apply identical macro shaping to full density and the empty-space oracle. The full-resolution,
temporal-off baked-vs-live periodicity probe is the acceptance authority before temporal history can
hide or amplify the result.

### W3 — Globe-native weather and regional formation variety

`C13-14` is the central weather architecture. Prefer Cesium globe-quadtree ownership with:

- geographic tile keys and level;
- overlap gutters and seam-safe filtering;
- asynchronous source decode/composition/upload;
- explicit logical weather-field ownership versus physical per-device texture realization;
- bounded CPU/GPU caches and post-submit retirement;
- parent fallback and child refinement;
- a stable tile/cell seed domain;
- no draw-time format conversion or network work.

`C13-15` adds a coarse, slowly varying prior. Offline fallback must work without live weather.
Climatology informs probability distributions; it must not pretend to be current observed weather.

`C13-16` converts region and synoptic signals into mixtures of cloud types/decks. Avoid one global
collection genus determining the entire planet.

`C13-17` adds deterministic formation identity and physically bounded parameter variation. Tests must
prove both variety and repeatability.

`C13-18` moves weather in local tangent ENU space. `C13-19` interpolates sparse time slices so hourly
data changes do not pop. `C13-20` defines composition when global, regional, live, cached, and
procedural sources overlap or contain holes.

### W4 — Quality after the architecture is stable

`C13-21` generalizes cloud layers and lighting without returning to one giant global noise field.
Target a small vectorized layer set with per-layer altitude, thickness, density, morphology, phase,
weather mixture, and wind.

`C13-22` evaluates richer Beer shadow-map data, stable cascades/coverage, PCF, and temporal filtering.
The current terrain, aerial, fog, and environment consumers must remain intact.

`C13-23` consumes local weather/density for optical extinction rather than applying only one
collection-level scalar.

`C13-24` exposes one backend-neutral weather owner and facade. Scene code must not import
`Renderer/WebGPU` or branch on `context.isWebGPU`.

### W5 — Transferred bounded features

Open these after their substrate exists:

- `C13-25`: lightning with per-cell phase jitter, a smooth decay envelope, and P95/P99 anti-grid
  analysis. The old median-only gate is forbidden.
- `C13-26`: GRIB2. Keep network/proxy and decoder prerequisites explicit; a mocked fixture is not a
  live-network certification.
- `C13-27`: live EDR validation in a networked browser session.
- `C13-28`: accumulated snow modifies terrain albedo/roughness on both backends, with default-off
  identity and regional placement.

### W6 — Gated architecture/content tail

`C13-29..34` are not automatically activated by launching C13. Each needs its predecessor gate and a
fresh maintainer/orchestrator scope decision. Retaining them here prevents loss; it does not make
them prerequisites for the core planetary/temporal/weather repair.

---

## 7. Gates and acceptance

| Gate | Required evidence | Gate fails when |
| --- | --- | --- |
| `C13-GATE-A` — launch/evidence truth | Clean launch hash; repaired Node/Playwright tour; moving captures at all named viewpoints; exact build/adapter/resolution/tier; clean vs instrumented lanes; counters prove present target sizes and work | A preset is not actually applied, the scene pauses, still images substitute for motion, build identity is ambiguous, or instrumentation changes output |
| `C13-GATE-B` — planetary correctness | WGS84/RTE probes green from ground through orbit; camera motion and teleports do not cause precision swimming; temporal/shadow/mask/capture share the coordinate contract; dateline and poles have no visible seam/pinch; regional bounds place fixtures correctly | Any path returns to raw full-ECEF `f32`, only the primary march is fixed, a regional field is globally stretched, or the seam merely moves |
| `C13-GATE-C` — temporal/performance | Counters prove true 1/16 current work; full-resolution history; depth/velocity/moment topology; disocclusion/cuts/resizes reset safely; moving GPU/CPU evidence beats the half-resolution baseline at comparable quality; no new ghost trails or sparkle | `temporalUpdateFraction` is still only a blend tweak, quality is weakened to win timing, a route segment regresses materially, history smears across cuts, or the performance claim lacks GPU evidence where available |
| `C13-GATE-D` — regional realism | At least four regions show intentionally different distributions; same-region/same-type formations vary; fixed seed is reproducible; changed seed varies; ENU wind direction is geographically correct; time slices interpolate; tile seams/gutters remain invisible | "Variety" is one global noise retune, randomness changes per frame, climatology is presented as live truth, source overlap is undefined, or movement changes direction around the globe incorrectly |
| `C13-EXIT` — certification | Gates A-D green; selected W4/W5 owners complete or explicitly deferred; WebGL billboards and shared globe/Scene APIs green; all existing cloud feature toggles preserved; TypeScript/build/lint/unit tests green; moving golden tour and performance report committed; zero unowned device/validation errors | A feature was removed/default-disabled, WebGL/shared APIs regress, a skip is treated as a pass, cloud history or resource lifetime is unbounded, or a visual/perf claim is not reproducible |

Performance promotion requires a named-stage improvement of at least 5% or more than three times the
measured noise, with no material route-segment regression. Larger architecture work may still be a
valid correctness landing when it truthfully misses that performance banner.

---

## 8. Required verification matrix

Every relevant slice selects from this matrix and names its exact subset in the brief.

| Dimension | Required cases |
| --- | --- |
| Backend | WebGPU volumetric; WebGPU billboard; WebGL billboard; shared Scene/globe API behavior |
| Altitude | ground/horizon; inside; above; regional/continental; orbit |
| Geography | antimeridian east/west crossing; north pole; south pole; equatorial maritime; tropical land; mid-latitude continental; arid; polar |
| Motion | slow pan; fast flight; altitude transition; orbit; teleport; resize; quality-tier change |
| Time/weather | static; advancing time; wind; source revision; missing data; overlapping global/regional sources |
| Cloud content | clear; sparse; overcast; low deck; high ice deck; deep convection; multiple formations of one type; multiple types |
| Consumers | terrain shadow; aerial perspective; volumetric fog; god rays; environment capture; post-process/TAA; picking/depth remains unaffected |
| Lifecycle | enable/disable; source swap; context destroy; device loss; two simultaneous contexts; cache pressure/eviction |
| Performance | clean moving lane; API-instrumented lane; GPU timestamps where available; release/minified confirmation before headline |

Visual acceptance includes temporal sequences, not only final frames. At minimum measure history
error after camera cuts, disocclusion trails, luminance flicker, dateline/pole discontinuity, regional
distribution, same-type variation, and deterministic replay.

---

## 9. Live execution ledger

Status vocabulary: **IN PROGRESS · COMPLETE · PARTIAL / PAUSED · BLOCKED · DEFERRED · CONDITIONAL NOT
TRIGGERED · NOT STARTED**.

A landed slice updates its row in the same commit with premise, files, probe names, before/after
evidence, functionality-preservation result, and rollback boundary. Missing ledger evidence is a
landing defect.

| ID(s) | Status | Evidence / next action |
| --- | --- | --- |
| `C13-00` | **COMPLETE — Batch 732 (`f4a934e606`)** | Explicit 2026-07-23 maintainer launch authority; C11 transfer map and confirmed findings recorded here; TypeScript, Markdown lint, and Prettier passed. Local `main` contains the launch commit. Publication remains externally blocked because `origin` returned HTTP 403 for the configured account; this does not block the explicitly authorized local-trunk campaign. |
| `C13-01` | **IN PROGRESS — Batch 733 plus Batch 734 readiness follow-up (2026-07-23)** | Batch 733 repaired unified API/config truth, deterministic offline/fixed-time capture, raw-frame metrics, backend-aware workload selection, and the moving WebGPU route. Batch 734 requires an actual procedural execute plus initialized cache/pipeline instead of trusting a loaded lazy handle or fixed warm-up count; the procedural tour now uses same-camera OFF/ON contribution for colored pole/dusk fixtures. The stale `cloudQuality=128` blank claim is superseded: it realizes 128/8 full-resolution work with 7,584 cloud cells. The pre-fix north-pole shell defect remains C13-03/04 evidence. Climate/region/type/same-type fixtures, wind/time and temporal-reset sequences, complete per-sequence provenance/metrics, and GPU timing remain. |
| `C13-02` | NOT STARTED | Begins after the repaired tour establishes the measurement surface. |
| `C13-03` | NOT STARTED | Author the WGS84/RTE contract and dynamic RED planetary probe before the primary-shell landing. Batch 733's fixed north-pole view is pre-fix RED. |
| `C13-04` | NOT STARTED | Primary visible-march RTE/WGS84 owner; it does not own raw-ECEF density, temporal, standalone shadow, capture, or weather correctness. |
| `C13-05` | NOT STARTED | Temporal origin/reprojection RTE owner. |
| `C13-06` | NOT STARTED | Shadow/mask/capture/atmosphere RTE owner. |
| `C13-07` | NOT STARTED | Bounded global-map seam/pole correction; does not replace `C13-14`. |
| `C13-08` | NOT STARTED | Bounds/no-data/regional packer contract. |
| `C13-09` | NOT STARTED | Reconstruction attachment topology. |
| `C13-10` | NOT STARTED | True 1/16 current work and full-resolution history. |
| `C13-11` | **BLOCKED** | Needs a provenance-approved, license-clean STBN generation/import plan and notices. NVIDIA STBN assets are prohibited. Does not block W1. |
| `C13-12` | NOT STARTED | Opens after reconstruction topology and current-work layout. |
| `C13-13` | NOT STARTED | Lighting/spatial-tier separation still follows reconstruction topology. The old 128-step blank was command-empty scheduling/readiness, not a raymarch-tier failure; fresh visible evidence is clean but has no comparable adaptive/fixed companion and therefore proves no speedup. |
| `C13-14` | NOT STARTED | Promoted C11 planet-scale tiling seed; core W3 architecture. |
| `C13-15` | NOT STARTED | Climate prior; distinguish climatology from current observations. |
| `C13-16` | NOT STARTED | Regional type/deck mixtures. |
| `C13-17` | NOT STARTED | Stable formation seeds and parameter distributions. |
| `C13-18` | NOT STARTED | Local ENU spatial advection. |
| `C13-19` | NOT STARTED | Weather time-slice interpolation. |
| `C13-20` | NOT STARTED | Source overlap and missing-data composition. |
| `C13-21` | NOT STARTED | Opens after temporal and regional substrate. |
| `C13-22` | NOT STARTED | Opens after RTE consumers and temporal substrate. |
| `C13-23` | NOT STARTED | Transferred extinction fill-in. |
| `C13-24` | NOT STARTED | Transferred backend-neutral facade. |
| `C13-25` | NOT STARTED | Transferred lightning reland; upper-tail oracle mandatory. |
| `C13-26` | **BLOCKED** | Requires a same-origin proxy, GRIB2 WASM decoder, and deterministic fixture before live validation. |
| `C13-27` | **BLOCKED** | Requires a networked Edge session; offline/mock success is not live EDR certification. |
| `C13-28` | NOT STARTED | Transferred snow-albedo consumer; both backends. |
| `C13-29` | DEFERRED | Gated tail; reconsider after Gate C proves the cheaper temporal path. |
| `C13-30` | DEFERRED | Gated tail after regional precipitation and terrain consumers. |
| `C13-31` | DEFERRED | Needs source-infrastructure design. |
| `C13-32` | DEFERRED | XL architecture option; activate only after measured Gate-C attribution. |
| `C13-33` | CONDITIONAL NOT TRIGGERED | Blocked by `C13-26`; mock demo does not satisfy the real-data headline. |
| `C13-34` | DEFERRED | Opens after rich/stable cloud shadows. |
| `C13-35` | **COMPLETE — Batch 734** | A non-consuming per-frame cloud-demand signal and shared environment-demand predicate keep a zero-frustum frame alive only when an effect needs it. The black-sky acceptance records eight managed and eight real user-owned frames with `numFrustums=0`, exact request/demand observation, and all resource/post/environment/cloud/canvas stages reached; the managed default is off during the user-owned phase. Eight disabled control frames retain zero frustums and skip all expensive stages. Each active output has 7,584 cloud cells, disabled is exactly black, and all 42 checks plus the WebGPU error gate pass. |
| `C13-36` | NOT STARTED | Diagnosis/design only: `jitterEnabled`/`QF_JITTER` exist but are not wired into the renderer or raymarch. Implement a license-free per-pixel IGN sample phase and a periodicity oracle without changing adaptive-march interval/control invariants. |
| `C13-37` | NOT STARTED | The repeat-sampled baked textures, harmonic scales, and raw-ECEF density domain remain unchanged. Planet-stable regional/local coordinates and the temporal-off baked-vs-live periodicity gate are still required. |
| `C13-GATE-A` | NOT STARTED | Follows `C13-01/02`. |
| `C13-GATE-B` | NOT STARTED | Follows `C13-03..08`. |
| `C13-GATE-C` | NOT STARTED | Follows `C13-09..13`; STBN may remain an explicit blocker if its provenance is unresolved. |
| `C13-GATE-D` | NOT STARTED | Follows `C13-14..20`. |
| `C13-EXIT` | NOT STARTED | Dead last. |

### C13-01 Slice A launch evidence

This is an oracle/tooling slice only; it changes no engine renderer or cloud appearance.

- The shared harness writes `globe.defaultCloudCollection.volumetric`, rejects unknown fields, forces
  live rendering, and records exact configuration/render-mode/backend truth. The tour and temporal
  probes boot `offline=true`, pass their authored `JulianDate` into every manual render, capture the
  raw Cesium canvas, and arm the shared console/uncaptured-error/device-loss gate.
- A 2026-07-23 Edge/WebGPU route run on NVIDIA Pascal completed the canonical eight-segment,
  18,000,000 m to 302 m flight in 20.007 s with 1,118 measured frames and no page, external-network,
  or device errors. CPU `Scene.render` was p50 `2.90 ms`, p95 `6.00 ms`, p99 `8.60 ms`; diagnostic
  display pacing was `55.88 FPS` with a `46.77` 1%-low. This single run is characterization, not a
  promotion claim and not a cloud-on/off delta.
- The same route proves renderer realization in addition to API round-trip: the `1280x720` canvas
  owned a `640x360` raymarch target, a `640x360` temporal-history target, two live history textures,
  and ready raymarch, temporal-resolve, and upscale pipelines. Exact per-frame pass/sample counters
  remain `C13-02`.
- The repaired static tour produced `199,937` cloudish pixels at the east antimeridian and preserved
  billboard output on WebGPU/WebGL (`36,113`/`36,504` cloudish pixels), with clean error gates. The
  north-pole fixture produced `0` cloudish pixels and a uniform-blue raw canvas. Its visibility gate
  is intentionally RED.
- The medium temporal sequence applied its exact tier/time and captured static, moving, and settled
  frames without device errors. Visual inspection confirms severe ordered/repeating spatial structure;
  this is baseline defect evidence only because numeric ghost/flicker/history metrics are not yet
  implemented.
- The repaired adaptive-march maximum-throughput probe requires an explicit pair ID, distinct runtime
  bundles, matching adapter/browser/resolution/configuration, clean error truth, and visible clouds.
  Batch 733's `cloudQuality=128` escape-hatch run was RED with `0` cloud pixels and its
  sub-millisecond queue-drain timing was invalid. C13-35 later proved that this was a skipped
  command-empty environment frame, not a 128-step shader failure.
- Functionality preservation: WebGL volumetrics remain unsupported by design, while WebGL billboard
  and shared collection/API coverage remain active. Unsupported implicit workloads are recorded as
  skips; an explicitly requested incompatible workload fails. No feature was removed or disabled to
  obtain these measurements.
- Rollback boundary: Batch 733 Slice A is confined to Node/Playwright tools, workload metadata/tests,
  and documentation. The first runtime correction is isolated in C13-35/Batch 734 below.

### C13-35 Batch 734 scheduling/readiness evidence

- `WebGPUSceneRenderer` now keeps a command-empty frame alive only when a shared, side-effect-free
  environmental-demand predicate reports managed/user volumetric clouds, SSR, NPR outlines, contact
  shadows, weather, volumetric fog, or ground fog. With no frustums and no demand, the existing
  zero-work return remains.
- The predicate consumes no cloud request. The eventual environmental renderer remains the sole
  request consumer, and the same predicate governs the scene-color snapshot-copy decision.
- The black-sky Node/Edge acceptance holds `numFrustums=0` for all three eight-frame phases. Managed
  clouds active: resource setup, post-processing, environmental effects, procedural clouds, and
  canvas writes each execute `8/8`; the exact `128` primary/`8` light-step full-resolution path
  produces `7,584` cloud cells. A real user-owned VOLUMETRIC collection with the managed default off
  publishes and exposes demand `8/8`, reaches the same stages `8/8`, and also produces `7,584` cloud
  cells. All clouds disabled: those stages execute `0/8`, the image is exactly black, and the
  true-empty fast path is preserved.
- Managed/disabled images differ at `49,980` pixels (`6.3553%`); the user-owned phase has the same
  contribution. All 42 acceptance checks pass and the WebGPU error/device-loss gate is clean. The
  separate maximum-throughput characterization is green at `12.1847 ms/frame`; it is not a speedup
  claim because its fixed companion is stale and noncomparable.
- Functionality preservation: no effect or renderer was disabled to obtain the active result;
  WebGL billboard parity remains `36,113`/`36,504` evidence pixels. The procedural-tour pole/dusk
  gate now measures same-camera OFF/ON contribution instead of assuming all valid clouds are bright
  and neutral.
- Rollback boundary: the engine change is limited to non-consuming demand observation and the
  zero-frustum early-return/snapshot gates. Readiness/probe changes are independently removable and
  do not alter production configuration or rendering.

---

## 10. Source pointers

### Current implementation

- `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudNoiseResources.ts`
- `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Environment/CloudUpscale.wgsl`
- `packages/engine/Source/Scene/CloudVolumetrics.js`
- `packages/engine/Source/Scene/CloudCollection.js`
- `packages/engine/Source/Scene/Weather/WeatherProvider.ts`
- `packages/engine/Source/Scene/Weather/WeatherTexPacker.ts`
- `Tools/visual-regression/probe-cloud-tour.mjs`

### Durable project context

- `FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`
- `QUEUE_2026-07-18_CAMPAIGN11.md`
- `campaign11_planning/guides/G12-clouds-weather.md`
- `CLOUD_LOD_RESEARCH_2026-07-05.md`
- `CLOUD_UNIFICATION_DESIGN.md`
- `ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md`
- `WEATHER_DATA_INGEST_ROADMAP.md`
- `WEATHER_RECREATION_ROADMAP.md`
- `DEFERRED_WORK.md`
- `FEATURE_INVENTORY.md`
- `DEBUGGING_GUIDE.md`

Line numbers in older reports are hints. Re-grep symbols at the start of every brief.
